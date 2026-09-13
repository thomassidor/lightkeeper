import { MINUTES_PER_DAY, formatMinutes, parseMinutes } from '../time/wall-clock';
import { MINIMUM_BRIGHTNESS } from '../outputs/light-intent';
import { sanitiseUnitInterval } from '../validation/unit-interval';
import { isPaletteColor } from './palette';
import type { TargetSpec } from '../outputs/light-intent';
import type { CircadianZones } from './simple-curve';

/**
 * What a circadian light is, as persisted in its virtual device's store.
 *
 * A curve, not a timetable. A schedule has boundaries — it does something AT a
 * time — which is why lib/schedules/ compiles Flows and lives with day filters
 * and midnight-crossing windows. A circadian light has a value that is true at
 * every minute of the day, so there is nothing to fire and nothing to miss: the
 * runtime reads its position off the curve whenever it needs it.
 *
 * **There is deliberately no `managedFlows` here.** This device type generates
 * no Flows at all, which is why it needs no API key and has no `needs_credential`
 * state. That absence is the feature. See lib/circadian/circadian-runtime.ts.
 *
 * Times are wall-clock MINUTE COUNTS, 0–1439, for the same reason schedules use
 * them (lib/schedules/schedule-types.ts): the question is always "what is the
 * value at the local time it is now", never "when is the next 07:00 in
 * Europe/Copenhagen", and that keeps DST out of the arithmetic entirely.
 */

// Re-exported because the curve module and the pairing screen both import
// these from here. See lib/time/wall-clock for the minute-count contract.
export { MINUTES_PER_DAY, formatMinutes, parseMinutes };

/** Two points are the fewest that describe a cycle; eight is more than a day needs. */
export const MIN_POINTS = 2;
export const MAX_POINTS = 8;

/**
 * Where an anchor sits in the day.
 *
 * Only `clock` is accepted today. `sun` is declared from the start so that
 * anchoring to real sunrise and sunset — which needs `homey:manager:geolocation`
 * and solar maths the SDK does not provide (platform §9) — lands later as a new
 * variant rather than as a reshape of every stored plan. sanitiseCurve() rejects
 * it until then, and resolveAnchor() throws on it, so it can never half-work.
 */
export type CircadianAnchor =
  | { kind: 'clock'; at: number }
  | { kind: 'sun'; event: 'sunrise' | 'sunset'; offset: number };

export interface CircadianPoint {
  id: string;
  anchor: CircadianAnchor;
  /**
   * Normalised colour temperature 0–1, where 1 is the WARMEST end. Not a
   * convention we chose — homey-lib's own capability definition says a higher
   * value is warmer, and assuming otherwise once shipped a schedule that lit a
   * room cold white at bedtime (platform §6).
   */
  warmth: number;
  /**
   * Perceptual brightness 0–1, converted with toDevice() at write time so "40%"
   * means 40% of PERCEIVED brightness — the same axis the dimming gestures and
   * the schedule screen use. Present on every point or on none: see
   * `adjustBrightness`.
   */
  brightness?: number;
  /**
   * A palette colour id, INSTEAD of this point's colour temperature.
   *
   * Absent on most points, and absent is the normal case: a curve of colour
   * temperatures is what this device type is for. A colour is the exception —
   * "amber at nine, and let the rest of the day be white".
   *
   * `warmth` stays REQUIRED even on a coloured point, and that is not
   * redundancy. It is what a lamp with no colour capability is written to
   * instead, and what the neighbouring temperature segments interpolate towards.
   * Removing it would mean a curve whose shape depends on which of the
   * household's lamps can do colour.
   *
   * The id is validated against `PALETTE` on the way in: a colour this version
   * does not know drops the point rather than being written as some default,
   * because a point at the wrong colour is worse than a point that is visibly
   * missing.
   */
  color?: string;
}

export interface CircadianPlan {
  schemaVersion: number;
  /** The device's onoff capability: false = paused, nothing is written. */
  enabled: boolean;
  target: TargetSpec;
  points: CircadianPoint[];
  /**
   * Follow the curve's brightness as well as its warmth. Off by default, and
   * only ever true when EVERY point carries a brightness — a curve that is half
   * dimmed would have to invent the missing segments, and inventing a brightness
   * for someone's living room is the one thing this feature must not do.
   */
  adjustBrightness: boolean;
  /**
   * The three zones a CIRCADIAN light stores, when this plan came from one.
   *
   * Absent on a Curve light, which owns its points outright. Present on a
   * circadian light, where it is the SOURCE and `points` above is a snapshot
   * taken from it: the runtime re-derives the points from these zones on every
   * tick against the day's real sunrise, because a boundary anchored to the sun
   * moves by four minutes a day around an equinox and a snapshot taken at
   * registration would be a season out by spring.
   *
   * Both are on the plan so that everything downstream — the pure curve engine,
   * the validator, the diagnostics, the preview — goes on reading an ordinary
   * point list and needs to know nothing about zones.
   */
  zones?: CircadianZones;
  /**
   * Write the day's warmth to lights that are OFF, so a light is already correct
   * before anyone touches it.
   *
   * Opt-in, and proven per installation rather than assumed: a capability write
   * to an off lamp turns it on through some integrations (measured for `dim` on
   * Hue, platform §6), and lights coming on by themselves at night is a far
   * worse failure than a half-second of the wrong white. The runtime disables
   * this by itself if it ever observes a light coming on from a pre-stage write.
   */
  preStage: boolean;
}

/**
 * The curve a new device starts with — five points, and deliberately not all
 * whites.
 *
 * The first thing somebody sees on a Curve light has to show what the device
 * DOES, and a default of five colour temperatures is indistinguishable from a
 * circadian light with more steps. Amber into cool white into neutral, a coral
 * evening and a violet night says "this one does colour" without a sentence
 * saying so.
 *
 * The 22:30 → 06:30 segment is the one that wraps midnight, and it is why
 * interpolation is cyclic. `warmth` is on every point alongside its colour,
 * because it is what a lamp with no colour capability gets instead.
 */
export const DEFAULT_POINTS: readonly CircadianPoint[] = [
  { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 + 30 }, warmth: 0.90, color: 'amber' },
  { id: 'p2', anchor: { kind: 'clock', at: 9 * 60 }, warmth: 0.20, color: 'coolwhite' },
  { id: 'p3', anchor: { kind: 'clock', at: 14 * 60 }, warmth: 0.40, color: 'neutral' },
  { id: 'p4', anchor: { kind: 'clock', at: 19 * 60 }, warmth: 0.75, color: 'coral' },
  { id: 'p5', anchor: { kind: 'clock', at: 22 * 60 + 30 }, warmth: 1.00, color: 'violet' },
] as const;

export interface SanitisedCurve {
  points: CircadianPoint[];
  adjustBrightness: boolean;
  dropped: Array<{ index: number; reason: string }>;
}

/**
 * Everything the curve screen can send is untrusted — it arrives from a webview
 * over the pairing channel — so an invalid row is DROPPED and named, never
 * repaired into a point the user did not ask for. Same policy, and the same
 * shape of return, as sanitiseEntries() in lib/schedules/schedule-types.ts.
 *
 * `adjustBrightness` is an INPUT and an OUTPUT: the caller asks for it, and this
 * returns whether the surviving points can actually support it.
 */
export function sanitiseCurve(raw: unknown, adjustBrightness = false): SanitisedCurve {
  const points: CircadianPoint[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];
  const list = Array.isArray(raw) ? raw : [];

  list.forEach((candidate, index) => {
    const drop = (reason: string) => dropped.push({ index, reason });

    if (!candidate || typeof candidate !== 'object') return drop('not an object');
    if (points.length >= MAX_POINTS) return drop(`over the limit of ${MAX_POINTS} points`);

    const source = candidate as Record<string, unknown>;

    const anchor = sanitiseAnchor(source.anchor ?? source.at);
    if (typeof anchor === 'string') return drop(anchor);

    // Two points at the same minute leave the curve with a zero-length segment,
    // which is a division by zero dressed up as a user preference.
    const minute = anchor.kind === 'clock' ? anchor.at : null;
    if (minute !== null && points.some(p => p.anchor.kind === 'clock' && p.anchor.at === minute)) {
      return drop(`another point is already at ${formatMinutes(minute)}`);
    }

    const warmth = sanitiseUnit(source.warmth);
    if (warmth === null) return drop('the warmth is not a number between 0 and 1');

    const id = typeof source.id === 'string' && source.id.trim() !== ''
      ? source.id.trim()
      : `p${index}`;
    if (points.some(p => p.id === id)) return drop(`duplicate point id "${id}"`);

    const brightness = sanitiseUnit(source.brightness);

    /**
     * A colour, or nothing. Never a fallback.
     *
     * An unknown id drops the POINT rather than the colour: a curve that
     * silently reverted one point to white at 21:00 would look like it was
     * working, and finding out why means noticing a colour that is subtly not
     * the one you chose. A missing point is visible on the screen and in the
     * chart.
     */
    let color: string | undefined;
    if (source.color !== undefined && source.color !== null && source.color !== '') {
      if (!isPaletteColor(source.color)) return drop('that colour is not one this version offers');
      color = String(source.color);
    }

    const lit = brightness !== null && brightness > 0;

    points.push({
      id,
      anchor,
      warmth,
      // A brightness of 0 would be "on, at nothing" — treated as unset here, as
      // it is in a schedule entry. A positive one is floored: 5% quantises to
      // `dim` 0.00 at the lamp, and a plan that stored 5% would show 5% on every
      // screen while the lamp went dark. `litDim` is the net under this at write
      // time; this stops the plan itself carrying a value nothing can show.
      ...(lit ? { brightness: Math.max(MINIMUM_BRIGHTNESS, brightness!) } : {}),
      ...(color !== undefined ? { color } : {}),
    });
  });

  points.sort((a, b) => resolvedMinute(a) - resolvedMinute(b));

  // Fewer than two points is not a curve. Dropping the lot rather than keeping
  // one is deliberate: a single point would read as "this works" on every screen
  // and hold the lights at one colour for ever.
  if (points.length > 0 && points.length < MIN_POINTS) {
    dropped.push({ index: -1, reason: `a curve needs at least ${MIN_POINTS} points` });
    points.length = 0;
  }

  return {
    points,
    // All-or-nothing, checked here rather than trusted from the screen.
    adjustBrightness: adjustBrightness && points.length > 0
      && points.every(p => p.brightness !== undefined),
    dropped,
  };
}

/** Sorting needs a number, and only clock anchors can supply one today. */
function resolvedMinute(point: CircadianPoint): number {
  return point.anchor.kind === 'clock' ? point.anchor.at : 0;
}

/** Returns the anchor, or a reason string explaining why there is not one. */
function sanitiseAnchor(raw: unknown): CircadianAnchor | string {
  // A bare time is accepted so the screen can send `{ at: '07:00' }` — the
  // shorthand the whole UI is built on — without knowing about the union.
  if (typeof raw === 'string' || typeof raw === 'number') {
    const at = parseMinutes(raw);
    return at === null ? 'the time is not a time of day' : { kind: 'clock', at };
  }

  if (!raw || typeof raw !== 'object') return 'the time is missing';
  const source = raw as Record<string, unknown>;

  if (source.kind === 'sun') {
    // Resolvable since the circadian light's boundaries started following the
    // sun: `sunTimes` in lib/daylight/solar-elevation.ts supplies the minute and
    // the runtime threads it in as an `AnchorContext`. A day with no sunrise at
    // all — a polar one, or a Homey that has never been told where it is — falls
    // back to fixed hours rather than refusing, which is decided in
    // `resolveBoundaries`, not here.
    if (source.event !== 'sunrise' && source.event !== 'sunset') {
      return 'a sun anchor must be sunrise or sunset';
    }
    const offset = typeof source.offset === 'number' && Number.isFinite(source.offset)
      ? source.offset
      : null;
    if (offset === null) return 'the offset from the sun is not a number of minutes';
    if (Math.abs(offset) > MINUTES_PER_DAY) return 'the offset from the sun is more than a day';
    return { kind: 'sun', event: source.event, offset };
  }

  const at = parseMinutes(source.at);
  return at === null ? 'the time is not a time of day' : { kind: 'clock', at };
}

/**
 * See lib/validation/unit-interval.ts.
 *
 * This file's policy differs from the schedule's on one point, and both are
 * right: a warmth or brightness of 0 is meaningful here — 0 is the coolest end
 * of the temperature axis (platform §6) — whereas a schedule reads a brightness
 * of 0 as unset rather than "on, at nothing".
 */
const sanitiseUnit = sanitiseUnitInterval;
