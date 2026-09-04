import { sanitiseUnitInterval } from '../validation/unit-interval';
import { MINIMUM_BRIGHTNESS } from '../outputs/light-intent';
import type { TargetSpec } from '../outputs/light-intent';

/**
 * What a daylight response is, as persisted — in FOUR different stores.
 *
 * This one shape is a Daylight light's whole plan AND the optional `daylight`
 * field on a schedule, a circadian light and a Curve light. That is the reason
 * it lives in its own file with its own sanitiser: four stores mean four
 * migration chains, and the one thing that must not happen is four slightly
 * different ideas of what a response is.
 *
 * **The two ends are direction-agnostic, and that is the design.** `dark` is the
 * brightness when it is dark outside and `bright` the brightness when it is
 * bright; which of the two is larger is the user's business, not ours. Set
 * `dark` high and `bright` low and the lamps take over as the daylight goes —
 * the compensating case, and the common one. Set them the other way and the room
 * follows the day, bright at noon and low in the evening. Two sliders and no
 * mode switch, which is the same trick the circadian light plays with warmest
 * and coolest.
 *
 * **There is deliberately no `managedFlows` here, and no credential.** Like the
 * two curve-driven types, a Daylight light writes no Flows (platform §12).
 */

/**
 * The capability a light sensor reports on, in ONE place.
 *
 * The only luminance capability homey-lib defines (platform §16), and named here
 * rather than in either of its two consumers — the live subscription and the
 * pairing list — because a picker that offered devices with one capability while
 * the runtime subscribed to another would produce a device that pairs perfectly
 * and never reads anything.
 */
export const LUMINANCE_CAPABILITY = 'measure_luminance';

/** Eight sensors is more than a room has; the cap is there so a corrupt store cannot loop. */
export const MAX_SENSORS = 8;
/** Lux is a physical quantity with no upper bound in homey-lib (platform §16), so we pick one. */
export const MIN_LUX = 0.1;
export const MAX_LUX = 100_000;

/**
 * When this room gets the most sun, as somebody who lives in it would say.
 *
 * The ONE thing the two brightness ends cannot express. `dark` and `bright` are
 * indexed on how bright it is OUTSIDE, and with no sensor that comes from the
 * sun's elevation — which is symmetric about solar noon. So 08:00 and 16:00 are
 * indistinguishable, and a west-facing room that is bright at 17:00 is
 * currently inexpressible. How MUCH sun a room gets is already expressible: a
 * dim room sets a higher `bright`, so its lamps stay up even when the sun is
 * high. Phase is what is missing, so phase is what is asked.
 *
 * Asked as an OBSERVATION rather than as a compass bearing, deliberately.
 * Somebody who lives in a room knows when the sun comes in; a bearing makes
 * them infer it from orientation, and then this code infers it back. It also
 * absorbs what a bearing cannot: a window facing east with a neighbour's wall
 * across it gets its light in the afternoon, and "afternoon" is then the true
 * answer even though the compass says east.
 *
 * `'none'` is the default and means "do not model this at all" — the elevation
 * ramp alone, exactly as before this existed. It is what an installed device
 * migrates to and what anybody who skips the question gets.
 */
export type SunPeak = 'none' | 'morning' | 'midday' | 'afternoon';

/** Every value the screen may offer, in the order it offers them. */
export const SUN_PEAKS: readonly SunPeak[] = ['none', 'morning', 'midday', 'afternoon'];

export function isSunPeak(value: unknown): value is SunPeak {
  return typeof value === 'string' && (SUN_PEAKS as readonly string[]).includes(value);
}

export interface DaylightResponse {
  /**
   * `measure_luminance` devices, by id. Empty means the sun alone, which is a
   * complete answer — most households own no lux sensor at all.
   */
  sensors: string[];
  /** At and below this many lux it counts as fully dark outside. */
  darkLux: number;
  /** At and above this many lux, fully bright. Must be above `darkLux`. */
  brightLux: number;
  /** Perceptual brightness 0–1 when it is fully dark outside. */
  dark: number;
  /** Perceptual brightness 0–1 when it is fully bright outside. */
  bright: number;
  /**
   * When this room gets the most sun. See `SunPeak`.
   *
   * Only consulted when there is no sensor: a sensor measures this room and
   * needs no model of it.
   */
  sunPeak: SunPeak;
}

export interface DaylightPlan {
  schemaVersion: number;
  /** The device's onoff capability: false = paused, nothing is written. */
  enabled: boolean;
  target: TargetSpec;
  response: DaylightResponse;
}

/**
 * What a new device starts with: lamps up when the daylight goes.
 *
 * 5 lx is a room that needs its lights on; 500 lx is a room lit well enough by a
 * window that lamps add nothing you would notice. Both are the defaults most
 * likely to be right rather than measured facts — `node scripts/probe-lights.mjs
 * inventory --all` is how they get checked against real sensors.
 */
export const DEFAULT_RESPONSE: DaylightResponse = {
  sensors: [],
  darkLux: 5,
  brightLux: 500,
  dark: 0.9,
  bright: 0.25,
  // Model nothing until asked: an installed device and a skipped question both
  // land here, and both behave exactly as they did before this field existed.
  sunPeak: 'none',
};

export interface SanitisedResponse {
  response: DaylightResponse;
  /** What was changed on the way in, named. Reported, never silently applied. */
  corrected: string[];
}

/**
 * Everything the daylight card can send is untrusted — it arrives from a webview
 * over the pairing channel.
 *
 * This one CORRECTS per field rather than dropping, which is the opposite of
 * sanitiseCurve() and matches sanitiseSimplePlan() instead. The difference is
 * what a bad field costs: a malformed curve point is a point the user asked for
 * and cannot have, so dropping it and saying so is honest, whereas a malformed
 * `brightLux` has one obvious right answer and refusing the whole response would
 * throw away four good fields with it.
 */
export function sanitiseResponse(raw: unknown): SanitisedResponse {
  const corrected: string[] = [];
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};

  const sensors: string[] = [];
  const list = Array.isArray(source.sensors) ? source.sensors : [];
  if (!Array.isArray(source.sensors) && source.sensors !== undefined) corrected.push('sensors');
  for (const candidate of list) {
    if (sensors.length >= MAX_SENSORS) {
      corrected.push('sensors');
      break;
    }
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      corrected.push('sensors');
      continue;
    }
    const id = candidate.trim();
    // A sensor named twice would be counted twice in the mean, which is a
    // weighting nobody asked for.
    if (sensors.includes(id)) {
      corrected.push('sensors');
      continue;
    }
    sensors.push(id);
  }

  let darkLux = sanitiseLux(source.darkLux);
  let brightLux = sanitiseLux(source.brightLux);
  if (darkLux === null) {
    darkLux = DEFAULT_RESPONSE.darkLux;
    corrected.push('darkLux');
  }
  if (brightLux === null) {
    brightLux = DEFAULT_RESPONSE.brightLux;
    corrected.push('brightLux');
  }
  // A zero-width span is a division by zero dressed up as a user preference —
  // the same failure two curve points at one minute would be.
  if (brightLux <= darkLux) {
    darkLux = DEFAULT_RESPONSE.darkLux;
    brightLux = DEFAULT_RESPONSE.brightLux;
    corrected.push('brightLux');
  }

  const dark = sanitiseEnd(source.dark, DEFAULT_RESPONSE.dark, 'dark', corrected);
  const bright = sanitiseEnd(source.bright, DEFAULT_RESPONSE.bright, 'bright', corrected);

  // Anything that is not one of the four is 'none' rather than a rejection: a
  // screen cannot send a fifth, so a fifth means a hand-edited store, and
   // modelling nothing is the safe reading of it.
  let sunPeak: SunPeak = DEFAULT_RESPONSE.sunPeak;
  if (source.sunPeak !== undefined) {
    if (isSunPeak(source.sunPeak)) sunPeak = source.sunPeak;
    else corrected.push('sunPeak');
  }

  return { response: { sensors, darkLux, brightLux, dark, bright, sunPeak }, corrected };
}

/**
 * One end of the response, floored at MINIMUM_BRIGHTNESS.
 *
 * The floor is applied HERE rather than through `withFlooredBrightness`, and the
 * policy is deliberately different from every other stored brightness in the
 * app: there is no such thing as an unset end. A curve point or a schedule window
 * reads a brightness of 0 as "leave brightness alone", because it has an
 * alternative — do nothing. An end of a daylight response has none; it is asked
 * for a number every tick, and 0 would mean writing darkness on a positive
 * request, which is the one thing the brightness axis promises never to do.
 */
function sanitiseEnd(
  raw: unknown,
  fallback: number,
  field: string,
  corrected: string[],
): number {
  const value = sanitiseUnitInterval(raw);
  if (value === null) {
    corrected.push(field);
    return fallback;
  }
  if (value < MINIMUM_BRIGHTNESS) {
    corrected.push(field);
    return MINIMUM_BRIGHTNESS;
  }
  return value;
}

function sanitiseLux(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(MAX_LUX, Math.max(MIN_LUX, value));
}

export interface Location {
  latitude: number;
  longitude: number;
}

/**
 * A latitude and longitude worth doing arithmetic with, or nothing.
 *
 * `0, 0` is refused. It is a real place — the Gulf of Guinea — and it is also
 * what an unset field reads as, and the second is overwhelmingly more likely on
 * a Homey in somebody's house. Getting that wrong means computing a confident
 * sun elevation for a point in the ocean and dimming a room in Denmark by it,
 * which is worse than reporting that we do not know where we are: `source:
 * 'none'` falls back to the brightness the user set by hand.
 */
export function usableLocation(raw: unknown): Location | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  // Not a bare `Number()`: `Number(null)` and `Number('')` are both 0, so a
  // latitude that was never set would read as the equator rather than as absent
  // — and only ONE of the two axes has to survive that for the 0,0 refusal below
  // to be dodged, which would put a Danish living room off the coast of Ghana.
  const latitude = asDegrees(source.latitude);
  const longitude = asDegrees(source.longitude);
  if (latitude === null || longitude === null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

function asDegrees(value: unknown): number | null {
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
  } else if (typeof value !== 'number') {
    return null;
  }
  const degrees = Number(value);
  return Number.isFinite(degrees) ? degrees : null;
}
