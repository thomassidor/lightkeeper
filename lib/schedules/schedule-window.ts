import { previousWeekday, type LocalClock } from '../time/local-clock';
import {
  ALL_WEEKDAYS,
  MINUTES_PER_DAY,
  type IsoWeekday,
  type ScheduleBoundary,
  type ScheduleEntry,
} from './schedule-types';

/**
 * Window arithmetic: pure, integer, minute-based, and the only place that knows
 * a schedule can run past midnight.
 *
 * The one non-obvious rule, and the reason this file has tests of its own: a
 * window belongs to the day it STARTED on. "On at 23:30 for two hours, Fridays"
 * switches off at 01:30 on a Saturday, and that off event is Friday's. Matching
 * the off event against the day it arrives on would silently drop every
 * midnight-crossing schedule.
 */

/** The wall-clock minute the lights go off. */
export function offMinuteOf(entry: ScheduleEntry): number {
  if (entry.end.kind === 'time') return entry.end.at;
  return (entry.onAt + entry.end.minutes) % MINUTES_PER_DAY;
}

/** How long the lights stay on. Always 1–1439; a sanitised entry cannot be 0. */
export function windowLengthMinutes(entry: ScheduleEntry): number {
  if (entry.end.kind === 'duration') return entry.end.minutes;
  const length = (entry.end.at - entry.onAt + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return length === 0 ? MINUTES_PER_DAY : length;
}

export function crossesMidnight(entry: ScheduleEntry): boolean {
  return entry.onAt + windowLengthMinutes(entry) >= MINUTES_PER_DAY;
}

export function dayMatches(entry: ScheduleEntry, day: IsoWeekday): boolean {
  return entry.days === null || entry.days.includes(day);
}

/**
 * Does an arriving boundary event belong to a day this schedule runs?
 *
 * The generated Flows fire every day — the day filter is not in the Flow, it is
 * checked here, because a Flow rewritten on every day-of-week edit is a Flow the
 * user's own edits get lost in, and because the day-condition cards on a given
 * firmware are not something we can enumerate ahead of time.
 */
export function boundaryDayMatches(
  entry: ScheduleEntry,
  boundary: ScheduleBoundary,
  today: IsoWeekday,
): boolean {
  if (boundary === 'on') return dayMatches(entry, today);
  return dayMatches(entry, crossesMidnight(entry) ? previousWeekday(today) : today);
}

/**
 * The day a window currently in progress started on, or null if `now` is not
 * inside one.
 *
 * Used for catch-up after a restart: the on-event fired while the app was down,
 * so no Flow will fire again until tomorrow, and the lights would stay dark all
 * evening. The start boundary is inclusive and the off boundary exclusive, so a
 * schedule is never "active" at the instant it ends.
 */
export function activeWindow(
  entry: ScheduleEntry,
  now: LocalClock,
): { startDay: IsoWeekday; elapsed: number } | null {
  const elapsed = (now.minutesOfDay - entry.onAt + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (elapsed >= windowLengthMinutes(entry)) return null;

  // Before the on-minute in today's clock means the window began yesterday.
  const startDay = now.minutesOfDay >= entry.onAt ? now.isoWeekday : previousWeekday(now.isoWeekday);
  return dayMatches(entry, startDay) ? { startDay, elapsed } : null;
}

export function activeWindowStartDay(entry: ScheduleEntry, now: LocalClock): IsoWeekday | null {
  return activeWindow(entry, now)?.startDay ?? null;
}

export function isActive(entry: ScheduleEntry, now: LocalClock): boolean {
  return activeWindow(entry, now) !== null;
}

/**
 * The entries whose window contains `now`, latest-started first.
 *
 * "Latest-started" is the smallest `elapsed`, and it is the ordering that makes
 * overlap deterministic. Applying every active entry in array order — which is
 * what catch-up did — meant a restart inside two overlapping windows landed on
 * whichever happened to be stored second, so the same restart at the same minute
 * gave a different room depending on the order the user had added the rows in.
 */
export function activeEntries(
  entries: readonly ScheduleEntry[],
  now: LocalClock,
): Array<{ entry: ScheduleEntry; startDay: IsoWeekday; elapsed: number }> {
  return entries
    .map(entry => {
      const window = activeWindow(entry, now);
      return window ? { entry, ...window } : null;
    })
    .filter((found): found is { entry: ScheduleEntry; startDay: IsoWeekday; elapsed: number } => found !== null)
    .sort((a, b) => a.elapsed - b.elapsed);
}

/**
 * Computed per call rather than as a module constant.
 *
 * `schedule-types.ts` imports `entriesOverlap` from here for its sanitiser, and
 * this file imports `MINUTES_PER_DAY` from there — so a top-level
 * `7 * MINUTES_PER_DAY` is evaluated mid-cycle and reads the binding before it is
 * initialised. Inside a function it is read at call time, by which point both
 * modules exist. (Two integers per comparison; the arithmetic is not the cost.)
 */
function minutesPerWeek(): number {
  return 7 * MINUTES_PER_DAY;
}

/**
 * Do two entries ever have their lights on at the same time?
 *
 * The question is genuinely a WEEKLY one, not a daily one, which is why this
 * exists rather than a comparison of two `[onAt, offAt)` pairs: "Friday 23:30 for
 * two hours" and "Saturday 00:30 for one hour" never share a start day and
 * overlap completely. So each entry is laid out as one arc per start day on a
 * 10 080-minute circle, and any pair of arcs that intersects is an overlap.
 *
 * Why it matters at all: two windows over the same lights fight. The one that
 * ends first switches them off while the other still believes them on, and
 * nothing on any screen admits to it. `sanitiseEntries` refuses to save such a
 * pair; `ScheduleRuntime.apply` handles the ones already saved by earlier
 * versions.
 */
export function entriesOverlap(a: ScheduleEntry, b: ScheduleEntry): boolean {
  const lengthA = windowLengthMinutes(a);
  const lengthB = windowLengthMinutes(b);

  for (const dayA of a.days ?? ALL_WEEKDAYS) {
    const startA = (dayA - 1) * MINUTES_PER_DAY + a.onAt;
    for (const dayB of b.days ?? ALL_WEEKDAYS) {
      const startB = (dayB - 1) * MINUTES_PER_DAY + b.onAt;
      if (arcsIntersect(startA, lengthA, startB, lengthB)) return true;
    }
  }
  return false;
}

/**
 * Two half-open arcs on a circle of MINUTES_PER_WEEK.
 *
 * Either B starts inside A, or A starts inside B. Both distances are measured
 * forward, so the wrap around Sunday midnight needs no special case — and a
 * sanitised window is at most 1439 minutes, far shorter than the circle, so
 * neither arc can swallow the other whole.
 */
function arcsIntersect(startA: number, lengthA: number, startB: number, lengthB: number): boolean {
  const week = minutesPerWeek();
  const forward = ((startB - startA) % week + week) % week;
  if (forward < lengthA) return true;
  return ((week - forward) % week) < lengthB;
}
