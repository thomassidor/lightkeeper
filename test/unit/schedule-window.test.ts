import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeEntries, activeWindowStartDay, boundaryClockMatches, boundaryDayMatches, crossesMidnight,
  dayMatches, isActive, offMinuteOf, windowLengthMinutes,
} from '../../lib/schedules/schedule-window';
import { describeClock, fromJsDay, localNow, previousWeekday } from '../../lib/time/local-clock';
import {
  formatMinutes, parseMinutes, sanitiseEntries, MAX_ENTRIES,
  type IsoWeekday, type ScheduleEntry,
} from '../../lib/schedules/schedule-types';

/**
 * Window arithmetic is where a light schedule is either right or wrong, and it
 * is the one part no amount of hardware testing reaches quickly: a
 * midnight-crossing schedule on a Friday takes a week to observe twice.
 *
 * The load-bearing rule under test: a window belongs to the day it STARTED on.
 * "On at 23:30 for two hours, Fridays" switches off at 01:30 on a Saturday, and
 * that off event is Friday's. Matching it against the day it arrives on would
 * silently drop every midnight-crossing schedule.
 */

function entry(over: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    id: 's1',
    onAt: 22 * 60,
    end: { kind: 'duration', minutes: 90 },
    ...over,
  };
}

describe('schedule times', () => {
  test('formats and parses minutes since midnight', () => {
    assert.equal(formatMinutes(0), '00:00');
    assert.equal(formatMinutes(22 * 60 + 5), '22:05');
    assert.equal(formatMinutes(1439), '23:59');
    // Wraps rather than throwing: an off-time past midnight is computed by
    // addition, and 24:30 has to read as 00:30.
    assert.equal(formatMinutes(1470), '00:30');

    assert.equal(parseMinutes('07:30'), 450);
    assert.equal(parseMinutes('7:30'), 450);
    assert.equal(parseMinutes(450), 450);
    assert.equal(parseMinutes('24:00'), null);
    assert.equal(parseMinutes('12:60'), null);
    assert.equal(parseMinutes('half seven'), null);
    assert.equal(parseMinutes(undefined), null);
  });
});

describe('schedule windows', () => {
  test('a duration becomes a computed off-time', () => {
    assert.equal(offMinuteOf(entry({ onAt: 22 * 60, end: { kind: 'duration', minutes: 90 } })), 23 * 60 + 30);
    // Past midnight it wraps: 23:00 + 90 min is 00:30.
    assert.equal(offMinuteOf(entry({ onAt: 23 * 60, end: { kind: 'duration', minutes: 90 } })), 30);
    assert.equal(windowLengthMinutes(entry({ end: { kind: 'duration', minutes: 90 } })), 90);
  });

  test('an off-time earlier than the on-time means the next day', () => {
    const e = entry({ onAt: 23 * 60, end: { kind: 'time', at: 60 } });
    assert.equal(offMinuteOf(e), 60);
    assert.equal(windowLengthMinutes(e), 120);
    assert.equal(crossesMidnight(e), true);
  });

  test('a window inside one day does not cross midnight', () => {
    const e = entry({ onAt: 7 * 60, end: { kind: 'time', at: 9 * 60 } });
    assert.equal(windowLengthMinutes(e), 120);
    assert.equal(crossesMidnight(e), false);
  });

  test('a window ending exactly at midnight counts as crossing', () => {
    // 23:00 + 60 = 00:00, so the off event arrives on the following day and has
    // to be matched against the previous day's day-set.
    const e = entry({ onAt: 23 * 60, end: { kind: 'duration', minutes: 60 } });
    assert.equal(offMinuteOf(e), 0);
    assert.equal(crossesMidnight(e), true);
  });

  test('a null day set means every day', () => {
    // The set belongs to the SCHEDULE now rather than to each window, so this
    // takes the set directly — there is no entry to read it off.
    for (let day = 1; day <= 7; day += 1) {
      assert.equal(dayMatches(null, day as 1), true);
    }
    assert.equal(dayMatches([1, 2, 3, 4, 5], 6), false);
    assert.equal(dayMatches([1, 2, 3, 4, 5], 5), true);
  });
});

describe('boundary day matching', () => {
  const WEEKDAYS: IsoWeekday[] = [1, 2, 3, 4, 5];
  const crossing = entry({ onAt: 23 * 60 + 30, end: { kind: 'duration', minutes: 120 } });

  test('an on event is matched against today', () => {
    assert.equal(boundaryDayMatches(crossing, WEEKDAYS, 'on', 5), true);
    assert.equal(boundaryDayMatches(crossing, WEEKDAYS, 'on', 6), false);
  });

  test('the off event of a midnight-crossing window belongs to the previous day', () => {
    // Friday 23:30 → Saturday 01:30. The Saturday off event is Friday's.
    assert.equal(boundaryDayMatches(crossing, WEEKDAYS, 'off', 6), true);
    // Sunday's off event would belong to Saturday, which is not selected.
    assert.equal(boundaryDayMatches(crossing, WEEKDAYS, 'off', 7), false);
    // Monday's own off event belongs to Sunday, likewise not selected.
    assert.equal(boundaryDayMatches(crossing, WEEKDAYS, 'off', 1), false);
  });

  test('the off event of a same-day window is matched against today', () => {
    const weekend: IsoWeekday[] = [6, 7];
    const morning = entry({ onAt: 7 * 60, end: { kind: 'duration', minutes: 60 } });
    assert.equal(boundaryDayMatches(morning, weekend, 'off', 6), true);
    assert.equal(boundaryDayMatches(morning, weekend, 'off', 5), false);
  });
});

describe('catch-up window detection', () => {
  const evening = entry({ onAt: 22 * 60, end: { kind: 'duration', minutes: 120 } });

  test('inside the window, the start day is today', () => {
    assert.equal(activeWindowStartDay(evening, null, { minutesOfDay: 23 * 60, isoWeekday: 3 }), 3);
  });

  test('the on boundary is inclusive and the off boundary is not', () => {
    assert.equal(isActive(evening, null, { minutesOfDay: 22 * 60, isoWeekday: 3 }), true);
    assert.equal(isActive(evening, null, { minutesOfDay: 24 * 60 - 1, isoWeekday: 3 }), true);
    // 00:00 is the off minute itself: the window is over.
    assert.equal(isActive(evening, null, { minutesOfDay: 0, isoWeekday: 4 }), false);
  });

  test('before the on time is not inside a same-day window', () => {
    assert.equal(
      activeWindowStartDay(evening, null, { minutesOfDay: 21 * 60 + 59, isoWeekday: 3 }), null,
    );
    const morning = entry({ onAt: 7 * 60, end: { kind: 'duration', minutes: 60 } });
    assert.equal(activeWindowStartDay(morning, null, { minutesOfDay: 3 * 60, isoWeekday: 3 }), null);
  });

  test('past midnight, the start day is yesterday', () => {
    const late = entry({ onAt: 23 * 60, end: { kind: 'duration', minutes: 180 } });
    assert.equal(activeWindowStartDay(late, null, { minutesOfDay: 60, isoWeekday: 4 }), 3);
  });

  test('a day-restricted schedule is only active on its own days', () => {
    const saturdays: IsoWeekday[] = [6];
    const late = entry({ onAt: 23 * 60, end: { kind: 'duration', minutes: 180 } });
    // Sunday 01:00 belongs to Saturday's window: active.
    assert.equal(activeWindowStartDay(late, saturdays, { minutesOfDay: 60, isoWeekday: 7 }), 6);
    // Monday 01:00 belongs to Sunday: not selected.
    assert.equal(activeWindowStartDay(late, saturdays, { minutesOfDay: 60, isoWeekday: 1 }), null);
  });
});

describe('the local clock', () => {
  // A fixed instant: 2026-08-18T20:15:00Z, a Tuesday.
  const instant = Date.UTC(2026, 7, 18, 20, 15);

  test('reads minutes and weekday in a named zone', () => {
    // Copenhagen is UTC+2 in August: 22:15 the same Tuesday.
    assert.deepEqual(localNow('Europe/Copenhagen', instant), { minutesOfDay: 22 * 60 + 15, isoWeekday: 2 });
  });

  test('a zone can put the same instant on a different day', () => {
    // Auckland is UTC+12 in August: 08:15 on the Wednesday.
    assert.deepEqual(localNow('Pacific/Auckland', instant), { minutesOfDay: 8 * 60 + 15, isoWeekday: 3 });
    // Los Angeles is UTC-7: 13:15, still the Tuesday.
    assert.deepEqual(localNow('America/Los_Angeles', instant), { minutesOfDay: 13 * 60 + 15, isoWeekday: 2 });
  });

  test('midnight is 0 rather than 1440', () => {
    // Some ICU builds render midnight as hour 24 under hour12: false.
    const midnight = Date.UTC(2026, 7, 18, 22, 0);
    assert.equal(localNow('Europe/Copenhagen', midnight).minutesOfDay, 0);
  });

  test('an unusable zone falls back to process-local time rather than throwing', () => {
    const fallback = localNow('Nowhere/Not_A_Zone', instant);
    const local = new Date(instant);
    assert.deepEqual(fallback, {
      minutesOfDay: local.getHours() * 60 + local.getMinutes(),
      isoWeekday: fromJsDay(local.getDay()),
    });
    assert.deepEqual(localNow(undefined, instant), fallback);
  });

  test('ISO weekdays wrap the way the window maths expects', () => {
    assert.equal(fromJsDay(0), 7);
    assert.equal(fromJsDay(1), 1);
    assert.equal(previousWeekday(1), 7);
    assert.equal(previousWeekday(7), 6);
    assert.equal(describeClock({ minutesOfDay: 90, isoWeekday: 7 }), 'Sun 01:30');
  });
});

/**
 * The two days a year the wall clock is not a clock.
 *
 * Every comparison in schedule-window.ts is in wall-clock minutes, and nothing
 * converts a wall time to an instant. lib/time/local-clock.ts refuses that
 * conversion on purpose: it is the code DST breaks (a local time that does not
 * exist, or exists twice), and the Flow engine owns firing anyway. These tests
 * pin only what holds whichever way time is counted on the reference Homey's
 * own zone: the skipped hour is never read, the repeated hour is read twice on
 * the same day, a boundary fired at its own wall minute is accepted, and every
 * window is matched to the day it started on.
 *
 * Deliberately NOT asserted, because they are consequences of the wall-clock
 * design rather than guarantees, and a decision to change either should not be
 * fought by a test:
 *  - the REPEATED hour: a window that already ended in real time reads as
 *    active again. On 2026-10-25, a window from 01:30 for 60 min is switched off
 *    at 02:30 CEST (00:30Z), and at 02:15 CET (01:15Z), 45 real minutes later,
 *    `activeEntries` returns it again and an `on` is accepted. A restart inside
 *    that hour would catch the room up and switch it back on.
 *  - the SKIPPED hour: a window is as long as the wall says (01:00 for three
 *    hours lasts two real hours on 2026-03-29), and one lying wholly inside
 *    02:00-02:59 never runs that night and is not caught up.
 */
describe('a daylight-saving day, in Europe/Copenhagen', () => {
  const zone = 'Europe/Copenhagen';
  const at = (month: number, day: number, h: number, m: number) => localNow(zone, Date.UTC(2026, month, day, h, m));
  /** Sunday 29 March 2026: 02:00 CET jumps to 03:00 CEST at 01:00 UTC. */
  const spring = (h: number, m: number) => at(2, 29, h, m);
  /** Sunday 25 October 2026: 03:00 CEST falls back to 02:00 CET at 01:00 UTC. */
  const autumn = (h: number, m: number) => at(9, 25, h, m);

  test('in spring the hour from 02:00 is never read, and the day stays Sunday', () => {
    assert.deepEqual(spring(0, 59), { minutesOfDay: 1 * 60 + 59, isoWeekday: 7 });
    assert.deepEqual(spring(1, 0), { minutesOfDay: 3 * 60, isoWeekday: 7 });
  });

  test('in autumn the hour from 02:00 is read twice, on the same Sunday', () => {
    assert.deepEqual(autumn(0, 30), { minutesOfDay: 2 * 60 + 30, isoWeekday: 7 }, '02:30 CEST');
    assert.deepEqual(autumn(1, 30), { minutesOfDay: 2 * 60 + 30, isoWeekday: 7 }, '02:30 CET');
    assert.deepEqual(autumn(2, 0), { minutesOfDay: 3 * 60, isoWeekday: 7 });
  });

  test('a restart after the spring jump catches up a window it is inside', () => {
    // On at 01:00 CET for three hours; 03:30 CEST is 90 real minutes in.
    const night = entry({ onAt: 60, end: { kind: 'duration', minutes: 180 } });
    const found = activeEntries([night], null, spring(1, 30));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.startDay, 7);
  });

  test('a window running across the spring jump is accepted at both ends', () => {
    // The Flow engine fires each boundary at its own wall minute, so that is
    // the minute that must be accepted.
    const across = entry({ onAt: 1 * 60 + 30, end: { kind: 'duration', minutes: 120 } });
    assert.equal(boundaryClockMatches(across, null, 'on', spring(0, 30)), true, 'on at 01:30 CET');
    assert.equal(isActive(across, null, spring(1, 15)), true, '03:15 CEST, still inside');
    assert.equal(boundaryClockMatches(across, null, 'off', spring(1, 30)), true, 'off at 03:30 CEST');
  });

  test('a window running across the autumn fall-back is accepted at both ends', () => {
    const across = entry({ onAt: 1 * 60 + 30, end: { kind: 'duration', minutes: 120 } });
    assert.equal(boundaryClockMatches(across, null, 'on', at(9, 24, 23, 30)), true, 'on at 01:30 CEST');
    assert.equal(isActive(across, null, autumn(0, 30)), true, 'the first 02:30');
    assert.equal(isActive(across, null, autumn(1, 15)), true, 'the second 02:15');
    assert.equal(boundaryClockMatches(across, null, 'off', autumn(2, 30)), true, 'off at 03:30 CET');
  });

  test('a midnight-crossing window over the fall-back still belongs to the day it started', () => {
    // Saturday 23:00 for four hours, ending on the fall-back Sunday.
    const late = entry({ onAt: 23 * 60, end: { kind: 'duration', minutes: 240 } });
    const saturdays: IsoWeekday[] = [6];
    assert.equal(activeWindowStartDay(late, saturdays, autumn(0, 30)), 6, '02:30 CEST belongs to Saturday');
    assert.equal(boundaryDayMatches(late, saturdays, 'off', autumn(2, 0).isoWeekday), true);
    assert.equal(boundaryDayMatches(late, saturdays, 'on', autumn(2, 0).isoWeekday), false);
  });
});

describe('sanitising what a screen sends', () => {
  test('accepts a well-formed entry, and ignores a day set sent on one', () => {
    const { entries, dropped } = sanitiseEntries([
      { id: 'a', onAt: '22:00', end: { kind: 'duration', minutes: 90 } },
    ]);
    assert.equal(dropped.length, 0);
    assert.equal(entries[0].onAt, 1320);
    // Days belong to the SCHEDULE now. A row that still carries a set is a stale
    // screen or a scripted pair session (platform §14), and the field is simply
    // not read — dropping the whole row over it would throw away a good window.
    assert.equal('days' in entries[0], false);
  });

  test('drops rather than repairs an entry it cannot read', () => {
    const { entries, dropped } = sanitiseEntries([
      { id: 'a', onAt: 'nonsense', end: { kind: 'duration', minutes: 30 } },
      { id: 'b', onAt: '07:00', end: { kind: 'duration', minutes: 0 } },
      { id: 'c', onAt: '07:00', end: { kind: 'time', at: '07:00' } },
      { id: 'e', onAt: '07:00' },
      'not an object',
    ]);

    assert.equal(entries.length, 0);
    assert.deepEqual(dropped.map(d => d.index), [0, 1, 2, 3, 4]);
    assert.match(dropped[1].reason, /shorter than a minute/);
    assert.match(dropped[2].reason, /same as the on-time/);
  });

  test('refuses a duplicate id, because it would collide in the flow keys', () => {
    const { entries, dropped } = sanitiseEntries([
      { id: 'same', onAt: '07:00', end: { kind: 'duration', minutes: 30 } },
      { id: 'same', onAt: '08:00', end: { kind: 'duration', minutes: 30 } },
    ]);
    assert.equal(entries.length, 1);
    assert.match(dropped[0].reason, /duplicate/);
  });

  test('caps the set, so the Flow list stays readable', () => {
    // Staggered an hour apart: the CAP is what has to drop these, not the
    // overlap rule, and fifteen rows at the same 07:00 would all overlap.
    const many = Array.from({ length: MAX_ENTRIES + 3 }, (_, index) => ({
      id: `s${index}`,
      onAt: `${String(index).padStart(2, '0')}:00`,
      end: { kind: 'duration', minutes: 30 },
    }));
    const { entries, dropped } = sanitiseEntries(many);
    assert.equal(entries.length, MAX_ENTRIES);
    assert.equal(dropped.length, 3);
    assert.match(dropped[0].reason, /over the limit/);
  });

  test('a brightness of zero is unset, not "on at nothing"', () => {
    const { entries } = sanitiseEntries([
      { id: 'a', onAt: '07:00', end: { kind: 'duration', minutes: 30 }, brightness: 0, temperature: 0 },
    ]);
    assert.equal(entries[0].brightness, undefined);
    // Temperature 0 is meaningful: it is the coolest end of the axis, not absence.
    assert.equal(entries[0].temperature, 0);
  });

  test('clamps a level that is out of range instead of writing it', () => {
    const { entries } = sanitiseEntries([
      { id: 'a', onAt: '07:00', end: { kind: 'duration', minutes: 30 }, brightness: 4, temperature: -2 },
    ]);
    assert.equal(entries[0].brightness, 1);
    assert.equal(entries[0].temperature, 0);
  });
});
