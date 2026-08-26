import {
  MINUTES_PER_DAY,
  type CircadianAnchor,
  type CircadianPoint,
} from './circadian-types';

/**
 * The curve itself: where the day's warmth is at any given minute.
 *
 * Pure, with no Homey imports, for the same reason lib/schedules/schedule-window.ts
 * is: this is the whole feature's correctness in about eighty lines, and keeping it
 * free of I/O is what makes every minute of a day cheap to assert.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 *  - **Interpolation is CYCLIC.** The segment from the last point of the day to
 *    the first wraps through midnight, so a curve whose points stop at 23:00 is
 *    still defined at 02:00 — it is on its way to the 06:00 point. Treating the
 *    day as a line rather than a circle leaves every night either undefined or
 *    pinned flat at the last value, which is precisely the half of the day this
 *    feature exists for. Same family of bug as a schedule window belonging to the
 *    day it STARTED on (CLAUDE.md §9).
 *  - **Interpolation is EASED, not linear.** A raised cosine has zero gradient at
 *    each anchor, so segments meet without a kink. Linear interpolation is
 *    perfectly accurate and still wrong here: the output is the colour of a room,
 *    and a change of gradient at 20:00 sharp is visible as a "step" that people
 *    read as the app twitching.
 */

/**
 * What the sun was doing today. Empty until anchoring to real sunrise and sunset
 * ships — it is threaded through from the start so that the day it does, the
 * change is confined to resolveAnchor() and its caller.
 */
export interface AnchorContext {
  sunriseMinute?: number;
  sunsetMinute?: number;
}

export interface CurveValue {
  /** 0–1, where 1 is the WARMEST end (CLAUDE.md §6). */
  warmth: number;
  /** Perceptual 0–1. Only present when both bracketing points carry one. */
  brightness?: number;
}

/** Minutes since local midnight, 0–1439. */
export function resolveAnchor(anchor: CircadianAnchor, context: AnchorContext = {}): number {
  if (anchor.kind === 'clock') return wrap(anchor.at);

  const base = anchor.event === 'sunrise' ? context.sunriseMinute : context.sunsetMinute;
  if (base === undefined) {
    // Throwing beats defaulting. A sun anchor that quietly resolved to midnight
    // would produce a curve that is wrong in a way nothing on screen could show,
    // and sanitiseCurve() refuses these on the way in precisely so this is
    // unreachable rather than merely unlikely.
    throw new Error(`No ${anchor.event} time is available to anchor to`);
  }
  return wrap(base + anchor.offset);
}

interface ResolvedPoint {
  minute: number;
  warmth: number;
  brightness?: number;
}

/** Points as minutes, in day order. Exported for the diagnostics and the tests. */
export function resolvePoints(
  points: readonly CircadianPoint[],
  context: AnchorContext = {},
): Array<{ id: string; minute: number; warmth: number; brightness?: number }> {
  return points
    .map(point => ({
      id: point.id,
      minute: resolveAnchor(point.anchor, context),
      warmth: point.warmth,
      ...(point.brightness !== undefined ? { brightness: point.brightness } : {}),
    }))
    .sort((a, b) => a.minute - b.minute);
}

/** What the curve holds at this minute of the local day. */
export function valueAt(
  points: readonly CircadianPoint[],
  minutesOfDay: number,
  context: AnchorContext = {},
): CurveValue {
  const resolved = resolvePoints(points, context);
  if (resolved.length === 0) throw new Error('A circadian curve needs at least one point');

  const first = resolved[0];
  if (resolved.length === 1) {
    return { warmth: first.warmth, ...(first.brightness !== undefined ? { brightness: first.brightness } : {}) };
  }

  const now = wrap(minutesOfDay);
  const { from, to, fraction } = bracket(resolved, now);
  const eased = ease(fraction);

  return {
    warmth: mix(from.warmth, to.warmth, eased),
    // All-or-nothing across the whole curve is the sanitiser's job; this is the
    // safety net for a plan written before that rule, and for the ephemeral
    // runtime the pairing screen drives with half-filled input.
    ...(from.brightness !== undefined && to.brightness !== undefined
      ? { brightness: mix(from.brightness, to.brightness, eased) }
      : {}),
  };
}

/** The next point due after this minute, and how far off it is. For diagnostics. */
export function nextPointAfter(
  points: readonly CircadianPoint[],
  minutesOfDay: number,
  context: AnchorContext = {},
): { id: string; minute: number; inMinutes: number } | null {
  const resolved = resolvePoints(points, context);
  if (resolved.length === 0) return null;

  const now = wrap(minutesOfDay);
  const next = resolved.find(point => point.minute > now) ?? resolved[0];
  return {
    id: next.id,
    minute: next.minute,
    // Wrapped, so "the next point is 06:00" at 23:30 reads as 390 minutes rather
    // than a negative number.
    inMinutes: ((next.minute - now + MINUTES_PER_DAY) % MINUTES_PER_DAY) || MINUTES_PER_DAY,
  };
}

/**
 * The pair of points this minute falls between, wrapping through midnight, plus
 * how far along that segment it is.
 */
function bracket(
  resolved: ResolvedPoint[],
  now: number,
): { from: ResolvedPoint; to: ResolvedPoint; fraction: number } {
  const last = resolved[resolved.length - 1];
  const first = resolved[0];

  // Before the first point of the day, or after the last: both are the segment
  // that spans midnight.
  let from = last;
  let to = first;

  for (let index = 0; index < resolved.length - 1; index += 1) {
    const candidate = resolved[index];
    const following = resolved[index + 1];
    if (now >= candidate.minute && now < following.minute) {
      from = candidate;
      to = following;
      break;
    }
  }

  // Measured the long way round, so the midnight-spanning segment is a positive
  // span rather than a negative one.
  const span = ((to.minute - from.minute + MINUTES_PER_DAY) % MINUTES_PER_DAY) || MINUTES_PER_DAY;
  const elapsed = (now - from.minute + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return { from, to, fraction: Math.min(1, elapsed / span) };
}

/** Raised cosine: 0 → 0, 1 → 1, flat at both ends. */
function ease(fraction: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * fraction);
}

function mix(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}

function wrap(minutes: number): number {
  const rounded = Math.round(minutes);
  return ((rounded % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
