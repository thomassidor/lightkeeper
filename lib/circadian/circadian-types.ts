import { MINUTES_PER_DAY, formatMinutes, parseMinutes } from '../time/wall-clock';
import { sanitiseUnitInterval } from '../validation/unit-interval';
import { isPaletteColor } from './palette';
import type { TargetSpec } from '../outputs/light-intent';

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
 * and solar maths the SDK does not provide (CLAUDE.md §9) — lands later as a new
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
   * room cold white at bedtime (CLAUDE.md §6).
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
   * Write the day's warmth to lights that are OFF, so a light is already correct
   * before anyone touches it.
   *
   * Opt-in, and proven per installation rather than assumed: a capability write
   * to an off lamp turns it on through some integrations (measured for `dim` on
   * Hue, CLAUDE.md §6), and lights coming on by themselves at night is a far
   * worse failure than a half-second of the wrong white. The runtime disables
   * this by itself if it ever observes a light coming on from a pre-stage write.
   */
  preStage: boolean;
}

/**
 * The curve a new device starts with: warm at dawn, cool through the working
 * day, warming through the evening, warmest overnight. The 23:00 → 06:00 segment
 * is the one that wraps midnight, and it is why interpolation is cyclic.
 */
export const DEFAULT_POINTS: readonly CircadianPoint[] = [
  { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.90 },
  { id: 'p2', anchor: { kind: 'clock', at: 9 * 60 }, warmth: 0.35 },
  { id: 'p3', anchor: { kind: 'clock', at: 17 * 60 }, warmth: 0.45 },
  { id: 'p4', anchor: { kind: 'clock', at: 20 * 60 }, warmth: 0.80 },
  { id: 'p5', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1.00 },
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

    points.push({
      id,
      anchor,
      warmth,
      // A brightness of 0 would be "on, at nothing" — treated as unset here, as
      // it is in a schedule entry.
      ...(brightness !== null && brightness > 0 ? { brightness } : {}),
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
    // Declared in the type, not yet resolvable: without a latitude and longitude
    // there is no sunrise to anchor to, and guessing one is worse than refusing.
    return 'sunrise and sunset anchors are not supported yet';
  }

  const at = parseMinutes(source.at);
  return at === null ? 'the time is not a time of day' : { kind: 'clock', at };
}

/**
 * See lib/validation/unit-interval.ts.
 *
 * This file's policy differs from the schedule's on one point, and both are
 * right: a warmth or brightness of 0 is meaningful here — 0 is the coolest end
 * of the temperature axis (CLAUDE.md §6) — whereas a schedule reads a brightness
 * of 0 as unset rather than "on, at nothing".
 */
const sanitiseUnit = sanitiseUnitInterval;
