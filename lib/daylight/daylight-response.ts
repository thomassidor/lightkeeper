import { mix, shape } from '../support/interpolate';
import type { DaylightResponse, SunPeak } from './daylight-types';

/**
 * How much daylight there is, and what brightness that asks for.
 *
 * Pure, no Homey imports, no clock and no subscriptions — it is handed an
 * elevation and a lux reading and returns numbers. Everything that has to talk
 * to a Homey to GET those two is in lib/daylight/daylight-evaluator.ts.
 *
 * Two stages, kept apart because they fail differently. `resolveLevel` answers
 * "how bright is it outside", 0 to 1, and can answer "I do not know"
 * (`source: 'none'`). `brightnessFor` turns a level into a brightness and cannot
 * fail at all.
 */

/** What a set of sensors currently reads, in lux. */
export interface DaylightReading {
  /** The mean over the usable sensors. */
  lux: number;
  /** Which sensors that mean is over — the unusable ones are absent. */
  deviceIds: string[];
}

/**
 * Where a level came from, and it is reported rather than inferred because it is
 * what the settings page shows a person trying to work out why a room is dim.
 */
export type DaylightSource = 'sensors' | 'sky' | 'none';

/**
 * The elevation at and below which the sky has stopped helping, and the one at
 * and above which it is doing all the work.
 *
 * −6° is civil twilight: the sun is down, the sky still has colour in it, and a
 * room needs its lights on. 25° is a middling summer noon in northern Europe,
 * chosen so that the top of the ramp is reached on ordinary days rather than
 * only at the solstice — a ramp whose bright end nobody's sky reaches is a ramp
 * with one end.
 *
 * **The DEFAULTS the two stored ends start at**, no longer constants the ramp
 * reads directly. That day arrived: `DaylightResponse.darkElevation` and
 * `brightElevation` are per device, because one pair of angles cannot be right
 * for a north-facing room and a south-facing one (platform §16).
 */
export const DARK_ELEVATION = -6;
export const BRIGHT_ELEVATION = 25;

/**
 * Lux → level, interpolated on LOG10 lux.
 *
 * Logarithmic because illuminance is perceived that way and because the range is
 * enormous: a lit room is 100 lx, an overcast day outside is 1000, direct sun is
 * 100 000. On a linear ramp from 5 to 500 the entire indoor half of the interval
 * — every value a person can tell apart — is squeezed into the bottom tenth, so
 * the lamps would sit at one end until a window did something dramatic.
 *
 * Shaped by the response's own transition (lib/support/interpolate.ts), on the
 * log-lux fraction: below `darkLux` and above `brightLux` it stays flat whatever
 * the shape.
 */
export function levelFromLux(response: DaylightResponse, lux: number): number {
  // log10 of a non-positive number is -Infinity or NaN. A sensor reporting 0 in a
  // dark room is not an error, it is the answer.
  if (!Number.isFinite(lux) || lux <= 0) return 0;

  const from = Math.log10(response.darkLux);
  const to = Math.log10(response.brightLux);
  // sanitiseResponse guarantees brightLux > darkLux, so the span is never zero.
  // Guarded anyway: this function is also reachable from a validator's own test
  // fixtures, and a NaN level would reach a lamp as no write at all.
  if (!(to > from)) return 0;

  return shape(response.transition, (Math.log10(lux) - from) / (to - from));
}

/**
 * How much of the daylight a room with this orientation actually receives.
 *
 * The elevation ramp answers "how much daylight is there at all". This answers
 * "how much of it comes in HERE", which is the question no other field can
 * reach: `dark` and `bright` are indexed on the level, and the level is
 * symmetric about solar noon, so nothing else can distinguish 08:00 from 16:00.
 *
 * A vertical window receives the direct beam in proportion to how square-on the
 * sun is to it — `cos(sunAzimuth − windowAzimuth)`, zero once the sun is behind
 * the wall. But a north-facing room is not dark at noon, because most of what
 * reaches it is diffuse skylight, which arrives from everywhere and does not
 * care which way the glass points. So the factor is a floor plus a directional
 * share, never zero:
 *
 *     DIFFUSE_SHARE + (1 − DIFFUSE_SHARE) × max(0, cos(Δazimuth))
 *
 * Two properties this is chosen to have, both of which matter more than its
 * precision:
 *
 *  - it is **at most 1**, so this can only ever make a room read DIMMER than
 *    the sky alone suggested — never brighter. The previous model implicitly
 *    treated every room as optimally oriented, so every correction is downward
 *    and no existing device gets a brighter reading than it used to;
 *  - `'flat'` — "hardly any direct sun" — returns the diffuse share FLAT, with
 *    no directional term at all. That is the honest reading of the answer: a
 *    room with no direct beam still brightens and darkens with the day, just
 *    less, so its curve stays shallow rather than going away.
 *
 * It is a model of a room, fitted to nothing, and it will be wrong in detail. It
 * is here because being wrong about WHEN by six hours is worse than being wrong
 * about how much by a third — and the user can already correct the second with
 * the `bright` slider.
 */
const DIFFUSE_SHARE = 0.35;

/**
 * Which way the window faces, from when the room gets its sun.
 *
 * Northern hemisphere: morning is east, afternoon west, and the middle of the
 * day is SOUTH. South of the equator the last one is north — the sun crosses the
 * northern sky — which is why this takes a latitude instead of hardcoding 180.
 * Morning and afternoon do not flip: the sun still rises in the east everywhere.
 */
export function windowAzimuthFor(peak: SunPeak, latitude: number): number | null {
  switch (peak) {
    case 'morning': return 90;
    case 'afternoon': return 270;
    case 'midday': return latitude >= 0 ? 180 : 0;
    // 'flat' has no window direction — that is what makes it flat.
    default: return null;
  }
}

export function orientationFactor(
  peak: SunPeak,
  latitude: number,
  sunAzimuth: number,
): number {
  const window = windowAzimuthFor(peak, latitude);
  // No direction to point at: a room that gets hardly any direct sun takes the
  // diffuse share and nothing else, which is a shallow curve rather than a flat
  // one. An unusable azimuth is the other case, and there the honest answer is
  // to apply no correction at all rather than to invent a shallow one.
  if (!Number.isFinite(sunAzimuth)) return 1;
  if (window === null) return DIFFUSE_SHARE;

  const delta = radians(((sunAzimuth - window + 540) % 360) - 180);
  return DIFFUSE_SHARE + (1 - DIFFUSE_SHARE) * Math.max(0, Math.cos(delta));
}

function radians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Sun elevation → level, on the response's own two ends.
 *
 * The ends used to be the module constants below, on the grounds that an
 * installed device should pick up an improved shape. They are stored per device
 * now, for the same reason `brightLux = 500` could not be one number for every
 * room (platform §16): a north-facing room and a west-facing one do not share a
 * sun, and the screen can pre-fill both from today's own sun path. The constants
 * survive as the DEFAULTS those fields start at.
 */
export function levelFromElevation(response: DaylightResponse, degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const span = response.brightElevation - response.darkElevation;
  // sanitiseResponse and the validator both guarantee a span; guarded anyway,
  // because a NaN level reaches a lamp as no write at all.
  if (!(span > 0)) return 0;
  return shape(response.transition, (degrees - response.darkElevation) / span);
}

/**
 * Level → perceptual brightness, between the response's two ends.
 *
 * Direction-agnostic on purpose — see the docblock on DaylightResponse. Which
 * end is larger is the user's choice, and this function does not know or care
 * which of the two cases it is serving.
 */
export function brightnessFor(response: DaylightResponse, level: number): number {
  const fraction = clamp01(level);
  /**
   * The ends are returned VERBATIM rather than interpolated to.
   *
   * `mix(1, 0.1, 1)` is 0.09999999999999998 — one ULP below the end the user
   * set, and below MINIMUM_BRIGHTNESS with it. Nothing breaks downstream
   * (`litDim` is the net under exactly this), but two things that should be
   * exactly true stop being: the level-1 brightness equals the `bright` slider,
   * and a response never returns a brightness outside its own two ends. The
   * palette's `mixColors` returns its endpoints verbatim for the same reason.
   */
  if (fraction <= 0) return response.dark;
  if (fraction >= 1) return response.bright;
  return mix(response.dark, response.bright, fraction);
}

export interface ResolvedLevel {
  level: number;
  source: DaylightSource;
}

/**
 * The one decision this module makes: which input to believe.
 *
 * **A usable sensor reading wins; the sky is the fallback.** Each is a complete
 * answer on its own, which is what lets this feature work in the many households
 * that own no lux sensor at all — and a sensor, when there is one, is measuring
 * the actual room rather than inferring it from where the sun is, so it knows
 * about curtains, orientation and weather that no almanac does.
 *
 * They are deliberately NOT blended. Averaging a measurement with an inference
 * produces a number that is neither, moves when either moves, and cannot be
 * explained on a settings page.
 *
 * `source: 'none'` — no usable sensor and no location — is the verdict that
 * makes a device report `needs_repair` and makes every consumer fall back to the
 * brightness a person set by hand. It is the reason the fixed value is kept
 * beside the flag rather than replaced by it.
 */
export function resolveLevel(
  response: DaylightResponse,
  inputs: {
    elevation: number | null;
    reading: DaylightReading | null;
    /**
     * The sun's bearing and the observer's latitude, for the orientation model.
     *
     * Optional together: without them the sky path is the bare elevation ramp,
     * which is what it was before `sunPeak` existed. A caller that has an
     * elevation has both, so absence means an older caller or a test that does
     * not care — never a silently degraded live path.
     */
    azimuth?: number | undefined;
    latitude?: number | undefined;
  },
): ResolvedLevel {
  // A SENSOR measures this room. It needs no model of the room, and applying one
  // would be modelling something already measured.
  if (inputs.reading !== null && inputs.reading.deviceIds.length > 0) {
    return { level: levelFromLux(response, inputs.reading.lux), source: 'sensors' };
  }
  if (inputs.elevation !== null && Number.isFinite(inputs.elevation)) {
    const sky = levelFromElevation(response, inputs.elevation);
    const oriented = inputs.azimuth !== undefined && inputs.latitude !== undefined
      ? sky * orientationFactor(response.sunPeak, inputs.latitude, inputs.azimuth)
      : sky;
    return { level: clamp01(oriented), source: 'sky' };
  }
  return { level: 0, source: 'none' };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
