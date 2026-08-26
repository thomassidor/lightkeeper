import type { BindableInput } from '../bridge/flow-bridge-manager';
import { crossesMidnight, offMinuteOf } from './schedule-window';
import { timeArgumentValue, type TimeCardRef } from './time-card-discovery';
import {
  formatMinutes,
  type IsoWeekday,
  type ScheduleBoundary,
  type ScheduleEntry,
} from './schedule-types';

/**
 * A schedule entry becomes two generated Flows: one at each end of its window.
 *
 * Both are `flow_fixed` bindings — a card with fixed arguments — which is the
 * shape the flow compiler already had, so a schedule reaches the same
 * idempotency, attribution, user-edit detection and orphan sweeping as a remote
 * does, with no second lifecycle to maintain.
 *
 * The variant key carries the TIME. It has to: reuse is keyed on (controller,
 * binding key, variant key) plus fingerprint and a reused Flow's trigger is
 * never rewritten, so with a constant variant key a schedule moved from 22:00 to
 * 23:00 would keep firing at 22:00 while every screen in the app said 23:00.
 */

export const EVENT_PREFIX = 'sched';

export function eventKeyFor(entryId: string, boundary: ScheduleBoundary): string {
  return `${EVENT_PREFIX}:${entryId}:${boundary}`;
}

/** Strict on purpose: bridge arguments are user-editable and untrusted. */
export function parseEventKey(eventKey: string): { entryId: string; boundary: ScheduleBoundary } | null {
  const parts = eventKey.split(':');
  if (parts.length !== 3) return null;
  const [prefix, entryId, boundary] = parts;
  if (prefix !== EVENT_PREFIX) return null;
  if (!entryId) return null;
  if (boundary !== 'on' && boundary !== 'off') return null;
  return { entryId, boundary };
}

const WEEKDAY_LABELS: Record<IsoWeekday, string> = {
  1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
};

/**
 * English, and deliberately so: this is part of a generated Flow's NAME, which
 * lives in the user's Flow list rather than in any of our screens. Translation
 * belongs to the device layer, which has `homey.__`; lib/ does not, and a Flow
 * title has nowhere to carry a locale key.
 */
export function daysLabel(days: IsoWeekday[] | null): string {
  if (days === null || days.length === 7) return 'every day';
  if (days.length === 5 && [1, 2, 3, 4, 5].every(d => days.includes(d as IsoWeekday))) return 'Mon–Fri';
  if (days.length === 2 && days.includes(6) && days.includes(7)) return 'weekends';
  return days.map(day => WEEKDAY_LABELS[day]).join(', ');
}

export function boundaryLabel(entry: ScheduleEntry, boundary: ScheduleBoundary): string {
  const minute = boundary === 'on' ? entry.onAt : offMinuteOf(entry);
  const verb = boundary === 'on' ? 'On' : 'Off';

  /**
   * The off Flow of a midnight-crossing window fires on the NEXT day.
   *
   * "Off at 01:30, Fri" is a Flow that does not fire on a Friday: the window
   * starts on Friday and ends in the small hours of Saturday, and the day-set is
   * the STARTING day throughout the app (see boundaryDayMatches). A user reading
   * their Flow list has no way to know that, so the label says which day the
   * window began on instead of implying the Flow runs on it.
   *
   * Safe to change: names are never compared in edit detection (a Flow the user
   * renamed is reused in place), and a reused Flow is never renamed — only newly
   * created or replaced Flows carry the new wording.
   */
  if (boundary === 'off' && crossesMidnight(entry)) {
    return `Off at ${formatMinutes(minute)} (starts ${daysLabel(entry.days)})`;
  }

  return `${verb} at ${formatMinutes(minute)}, ${daysLabel(entry.days)}`;
}

/** The two flows one schedule needs, in the shape FlowBridgeManager.sync() takes. */
export function bindingsFor(entry: ScheduleEntry, card: TimeCardRef): BindableInput[] {
  return (['on', 'off'] as ScheduleBoundary[]).map(boundary => {
    const minute = boundary === 'on' ? entry.onAt : offMinuteOf(entry);
    return {
      key: eventKeyFor(entry.id, boundary),
      label: boundaryLabel(entry, boundary),
      variantKey: `at:${formatMinutes(minute)}`,
      binding: {
        kind: 'flow_fixed' as const,
        cardId: card.id,
        cardOwnerUri: card.uri,
        args: { [card.argument]: timeArgumentValue(minute) },
      },
    };
  });
}

export function bindingsForPlan(entries: ScheduleEntry[], card: TimeCardRef): BindableInput[] {
  return entries.flatMap(entry => bindingsFor(entry, card));
}
