import { previousWeekday, type LocalClock } from './local-time';
import {
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
export function activeWindowStartDay(entry: ScheduleEntry, now: LocalClock): IsoWeekday | null {
  const elapsed = (now.minutesOfDay - entry.onAt + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (elapsed >= windowLengthMinutes(entry)) return null;

  // Before the on-minute in today's clock means the window began yesterday.
  const startDay = now.minutesOfDay >= entry.onAt ? now.isoWeekday : previousWeekday(now.isoWeekday);
  return dayMatches(entry, startDay) ? startDay : null;
}

export function isActive(entry: ScheduleEntry, now: LocalClock): boolean {
  return activeWindowStartDay(entry, now) !== null;
}
