import { ease, mix } from '../support/interpolate';
import type { DaylightResponse } from './daylight-types';

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
 * **Constants, derived on every evaluation rather than stored**, for the same
 * reason SIMPLE_SHAPE is (lib/circadian/simple-curve.ts): an installed device
 * picks up an improved shape, and the day these become editable this feature is
 * itself with two more fields.
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
 * Eased with the shared raised cosine, so the response settles into both ends
 * instead of arriving at them still moving.
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

  return ease(clamp01((Math.log10(lux) - from) / (to - from)));
}

/** Sun elevation → level, on the two constants above. */
export function levelFromElevation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return ease(clamp01((degrees - DARK_ELEVATION) / (BRIGHT_ELEVATION - DARK_ELEVATION)));
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
  inputs: { elevation: number | null; reading: DaylightReading | null },
): ResolvedLevel {
  if (inputs.reading !== null && inputs.reading.deviceIds.length > 0) {
    return { level: levelFromLux(response, inputs.reading.lux), source: 'sensors' };
  }
  if (inputs.elevation !== null && Number.isFinite(inputs.elevation)) {
    return { level: levelFromElevation(inputs.elevation), source: 'sky' };
  }
  return { level: 0, source: 'none' };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
