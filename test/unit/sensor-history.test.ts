import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKET_MINUTES, COLUMNS, ROWS, SILENT_MS,
  bucketWeek, luminanceLogId, readSensorWeek, roundNicely,
  type HistorySample,
} from '../../lib/daylight/sensor-history';
import { MIN_LUX } from '../../lib/daylight/daylight-types';

/**
 * The week grid is EVIDENCE shown to somebody deciding two lux numbers, so a
 * bucketing bug is not a cosmetic one: a grid that puts a Danish night across
 * two rows, or reads a gap as darkness, argues for thresholds the room will
 * never meet, and the device then holds one brightness for ever while looking
 * configured.
 *
 * Everything below fixes a value independently of the implementation — a day
 * built to a known shape, a clock change whose only correct answer is "still
 * seven rows", a cupboard sensor that must be refused, and the `Number(null)`
 * trap that this codebase has now met on three separate seams.
 */

const TZ = 'Europe/Copenhagen';
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Midday on a Wednesday, well clear of any clock change. */
const NOW = Date.parse('2026-02-11T12:00:00+01:00');

/**
 * A week of a room with an obvious night and an obvious day.
 *
 * Built from explicit local timestamps rather than from offsets off `NOW`, so
 * the shape the assertions rely on is visible in the source: 5 lx from 18:00 to
 * 08:00, 200 lx in between. The whole week is inside CET, so `+01:00` is exact.
 *
 * Sampled every half hour, which also puts several readings in each two-hour
 * bucket and so makes the bucket MEAN observable rather than incidental.
 */
function plausibleWeek(): HistorySample[] {
  const samples: HistorySample[] = [];
  for (let day = 5; day <= 11; day++) {
    for (let slot = 0; slot < 48; slot++) {
      const hour = slot / 2;
      const hh = String(Math.floor(hour)).padStart(2, '0');
      const mm = slot % 2 === 0 ? '00' : '30';
      const t = Date.parse(`2026-02-${String(day).padStart(2, '0')}T${hh}:${mm}:00+01:00`);
      if (t > NOW) continue;
      samples.push({ t, v: hour >= 8 && hour < 18 ? 200 : 5 });
    }
  }
  return samples;
}

/** Every half hour across the seven days before `endMs`, all the same reading. */
function evenSamples(endMs: number, lux = 40): HistorySample[] {
  const samples: HistorySample[] = [];
  for (let back = 0; back < ROWS * 48; back++) {
    samples.push({ t: endMs - back * 30 * 60_000, v: lux });
  }
  return samples;
}

describe('the week grid', () => {
  test('is seven local days of twelve two-hour buckets', () => {
    assert.equal(COLUMNS, 12);
    assert.equal(ROWS, 7);
    assert.equal(BUCKET_MINUTES, 120);

    const week = bucketWeek(plausibleWeek(), TZ, NOW);
    assert.equal(week.cells.length, ROWS);
    for (const row of week.cells) assert.equal(row.length, COLUMNS);
    assert.equal(week.days.length, ROWS);
  });

  test('the last row is today and the first is six days earlier', () => {
    const week = bucketWeek([], TZ, NOW);
    // 2026-02-11 is a Wednesday: ISO 3. Six days earlier is a Thursday, ISO 4.
    assert.equal(week.days[ROWS - 1], 3);
    assert.equal(week.days[0], 4);
  });

  test('a bucket with no sample is null, never zero', () => {
    // One reading, at 03:00 local today. Every other bucket must be absent —
    // drawn hatched — because a gap that read as 0 lx would be pitch dark, and
    // would drag the dark threshold down with it.
    const at = Date.parse('2026-02-11T03:00:00+01:00');
    const week = bucketWeek([{ t: at, v: 12 }], TZ, NOW);

    assert.equal(week.covered, 1);
    assert.equal(week.cells[ROWS - 1]![1], 12);
    assert.equal(week.cells[ROWS - 1]![0], null);
    assert.equal(week.cells[0]![5], null);
  });

  test('a bucket holding several readings is their mean', () => {
    const base = Date.parse('2026-02-11T08:10:00+01:00');
    const week = bucketWeek([
      { t: base, v: 100 },
      { t: base + 30 * 60_000, v: 200 },
      { t: base + 60 * 60_000, v: 300 },
    ], TZ, NOW);
    // 08:00–10:00 is bucket 4.
    assert.equal(week.cells[ROWS - 1]![4], 200);
  });

  test('samples older than the window are dropped rather than folded into row 0', () => {
    const week = bucketWeek([
      { t: NOW - 30 * DAY, v: 900 },
      { t: NOW - 2 * HOUR, v: 40 },
    ], TZ, NOW);
    assert.equal(week.covered, 1);
    assert.equal(week.high, 40);
  });

  test('a clock change still leaves exactly seven rows', () => {
    // Europe/Copenhagen springs forward on 2026-03-29. A week ending after it
    // contains one 23-hour day, and flooring the day arithmetic would shift
    // every row before the change by one and lose a day off the end.
    const after = Date.parse('2026-03-31T12:00:00+02:00');
    const week = bucketWeek(evenSamples(after), TZ, after);

    assert.equal(week.days.length, ROWS);
    // 2026-03-31 is a Tuesday, ISO 2; six days earlier is a Wednesday, ISO 3.
    assert.equal(week.days[ROWS - 1], 2);
    assert.equal(week.days[0], 3);
    // Every row got readings — none were rounded into a neighbour and lost.
    for (const row of week.cells) {
      assert.ok(row.some(cell => cell !== null), 'every day of the week has readings');
    }
  });

  /**
   * The label on a row names the day whose samples land in it.
   *
   * The existing clock-change test above runs at MIDDAY, where the hour the
   * spring-forward removes cannot push an instant across a midnight — which is
   * why it passed while this was broken. Near midnight it can, and did: the row
   * labels were walked back a rigid 24 hours while `rowFor` files samples by
   * local midnight, so the grid read "… Thu Fri Sat Mon" with Sunday missing
   * and every earlier row naming the wrong day.
   *
   * Asserted against `rowFor`'s own answer rather than against a remembered
   * list, because the two agreeing is the property — a label is only right if it
   * names the day whose readings are under it.
   */
  test('after a clock change, each row is labelled with the day it holds', () => {
    // Monday 00:30 local, the morning after Copenhagen springs forward
    // (2026-03-29). Twenty-four hours earlier is Saturday 23:30, not Sunday.
    const now = Date.parse('2026-03-30T00:30:00+02:00');

    // One sample at local midday on each of the seven days. 24-29 March are
    // still CET; 30 March is CEST, the shift having happened on the 29th.
    const samples: HistorySample[] = [
      { t: Date.parse('2026-03-24T12:00:00+01:00'), v: 100 },
      { t: Date.parse('2026-03-25T12:00:00+01:00'), v: 100 },
      { t: Date.parse('2026-03-26T12:00:00+01:00'), v: 100 },
      { t: Date.parse('2026-03-27T12:00:00+01:00'), v: 100 },
      { t: Date.parse('2026-03-28T12:00:00+01:00'), v: 100 },
      { t: Date.parse('2026-03-29T12:00:00+02:00'), v: 100 },
      { t: Date.parse('2026-03-30T12:00:00+02:00'), v: 100 },
    ];

    const week = bucketWeek(samples, TZ, now);

    // Tue 24th through Mon 30th, in ISO weekdays. Sunday the 29th is the one
    // the rigid 24-hour walk skipped, and everything before it shifted by a day.
    assert.deepEqual([...week.days], [2, 3, 4, 5, 6, 7, 1]);

    // And every row actually holds the readings its label claims.
    for (let row = 0; row < ROWS; row++) {
      assert.ok(
        week.cells[row]!.some(cell => cell !== null),
        `row ${row} (labelled ${week.days[row]}) holds the day's readings`,
      );
    }
  });

  test('buckets on local hours, not UTC', () => {
    // 00:30 local in Copenhagen in winter is 23:30 the previous day in UTC.
    // Bucketed in UTC this lands in the last column of the day before; bucketed
    // locally it is the first column of the right day.
    const at = Date.parse('2026-02-11T00:30:00+01:00');
    const week = bucketWeek([{ t: at, v: 3 }], TZ, NOW);
    assert.equal(week.cells[ROWS - 1]![0], 3);
    assert.equal(week.cells[ROWS - 2]![COLUMNS - 1], null);
  });
});

describe('what a week is worth', () => {
  test('a night and a day is usable, and suggests a span around both', () => {
    const week = bucketWeek(plausibleWeek(), TZ, NOW);
    assert.equal(week.verdict.kind, 'usable');
    assert.ok(week.suggestion, 'a usable week pre-fills both thresholds');

    const { darkLux, brightLux } = week.suggestion!;
    // The dark end sits above the measured night so an ordinary evening counts
    // as dark; the bright end sits at the middle of the day.
    assert.ok(darkLux > 5, `dark ${darkLux} is above the 5 lx night`);
    assert.ok(darkLux < 50, `dark ${darkLux} is still a dark room`);
    assert.ok(brightLux > darkLux, 'a zero-width span would be thrown away by the sanitiser');
    assert.ok(brightLux >= 100, `bright ${brightLux} reflects a 200 lx day`);
  });

  test('a cupboard sensor is refused: faithful, and says nothing', () => {
    // 1 to 4 lx, only when the door opens. It clears neither the absolute floor
    // nor the two stops of range.
    const samples: HistorySample[] = [];
    for (let i = 0; i < 200; i++) {
      samples.push({ t: NOW - i * 30 * 60_000, v: 1 + (i % 4) });
    }
    const week = bucketWeek(samples, TZ, NOW);
    assert.equal(week.verdict.kind, 'flat');
    assert.equal(week.suggestion, null, 'nothing to recommend from a week with no day in it');
  });

  test('a sensor that stopped is named as stopped, not as flat', () => {
    // Reported normally, then nothing since. Both verdicts would be true of the
    // data; only one of them is useful, and it is the one with a date in it.
    const stoppedAt = NOW - 3 * DAY;
    const samples = plausibleWeek().filter(s => s.t <= stoppedAt);
    const week = bucketWeek(samples, TZ, NOW);

    assert.equal(week.verdict.kind, 'stopped');
    assert.equal((week.verdict as { lastAt: number }).lastAt, Math.max(...samples.map(s => s.t)));
    assert.equal(week.suggestion, null);
  });

  test('half a day of silence is the threshold, not an hour', () => {
    // A still room legitimately goes quiet for hours, so a sensor last heard
    // from this morning is working, not broken (platform §16).
    const quiet = bucketWeek(
      plausibleWeek().filter(s => s.t <= NOW - SILENT_MS + HOUR), TZ, NOW,
    );
    assert.notEqual(quiet.verdict.kind, 'stopped');

    const stopped = bucketWeek(
      plausibleWeek().filter(s => s.t <= NOW - SILENT_MS - HOUR), TZ, NOW,
    );
    assert.equal(stopped.verdict.kind, 'stopped');
  });

  test('an empty week is nothing, and recommends nothing', () => {
    const week = bucketWeek([], TZ, NOW);
    assert.equal(week.verdict.kind, 'nothing');
    assert.equal(week.suggestion, null);
    assert.equal(week.lastAt, null);
    assert.equal(week.covered, 0);
  });
});

describe('rounding a threshold', () => {
  test('snaps to the ladder a person would have picked', () => {
    assert.equal(roundNicely(7.43), 5);
    assert.equal(roundNicely(8.4), 10);
    assert.equal(roundNicely(163), 200);
    assert.equal(roundNicely(118), 100);
    assert.equal(roundNicely(1.4), 1);
  });

  test('never returns something a lux field would refuse', () => {
    for (const junk of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(roundNicely(junk), MIN_LUX, `${junk} floors to MIN_LUX`);
    }
  });
});

describe('reading a log', () => {
  test('addresses the luminance capability of that device', () => {
    assert.equal(luminanceLogId('abc-123'), 'homey:device:abc-123:measure_luminance');
  });

  test('a null value is dropped, not coerced to pitch dark', async () => {
    // `Number(null)` is 0, and 0 lux is the darkest reading there is. Homey
    // encodes a gap in a log as a null value, so coercing would manufacture a
    // night that never happened — the same trap `asLux` and `usableLocation`
    // each guard on their own seam.
    const api = {
      insights: {
        getLogEntries: async () => ({
          values: [
            { t: NOW - HOUR, v: 40 },
            { t: NOW - 2 * HOUR, v: null },
            { t: NOW - 3 * HOUR, v: 'nonsense' },
            { t: 'not a date', v: 12 },
            { t: NOW - 4 * HOUR, v: 60 },
          ],
        }),
      },
    };

    const samples = await readSensorWeek(api, 'sensor-1');
    assert.deepEqual(samples, [
      { t: NOW - HOUR, v: 40 },
      { t: NOW - 4 * HOUR, v: 60 },
    ]);
  });

  test('accepts an ISO timestamp as readily as a number', async () => {
    const iso = '2026-02-11T09:00:00.000Z';
    const api = { insights: { getLogEntries: async () => ({ values: [{ t: iso, v: 7 }] }) } };
    assert.deepEqual(await readSensorWeek(api, 'sensor-1'), [{ t: Date.parse(iso), v: 7 }]);
  });

  test('a refused or absent log is null, never a throw', async () => {
    // The app's own token has read scope across the API (platform §1), but that
    // is inference rather than measurement for Insights specifically — so the
    // screen has to survive being told no.
    const refused = { insights: { getLogEntries: async () => { throw new Error('Missing Scopes'); } } };
    assert.equal(await readSensorWeek(refused, 'sensor-1'), null);

    // A manager that never connected leaves no `insights` on the client at all.
    assert.equal(await readSensorWeek({}, 'sensor-1'), null);
    assert.equal(await readSensorWeek(null, 'sensor-1'), null);

    // A log that exists but answers with no values.
    const empty = { insights: { getLogEntries: async () => ({}) } };
    assert.equal(await readSensorWeek(empty, 'sensor-1'), null);
  });
});
