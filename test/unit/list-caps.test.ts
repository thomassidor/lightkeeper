import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateCircadianPlan, validateSchedulePlan } from '../../lib/validation/plans';
import {
  MAX_ENTRIES, MAX_INCOMING_ENTRIES, sanitiseEntries,
} from '../../lib/schedules/schedule-types';
import {
  DEFAULT_POINTS, MAX_INCOMING_POINTS, MAX_POINTS, sanitiseCurve,
} from '../../lib/circadian/circadian-types';

/**
 * Every list the app accepts is bounded twice over, and these are the places
 * one of the two bounds was missing.
 *
 * `requireArray`'s docblock (lib/validation/guards.ts) is the policy: a list
 * becomes a loop over device writes or generated Flows, so a corrupted or
 * scripted one (platform §14) must report itself rather than take the app down.
 * The app's OWN limits — twelve windows, eight points — are a second, tighter
 * bound, and a stored plan can exceed one of those without being corrupt. So
 * those are re-applied by TRUNCATING: a device is never quarantined over a
 * window or a lamp it cannot keep.
 */

const window = (index: number) => ({
  id: `s${index}`,
  onAt: (index * 60) % 1440,
  end: { kind: 'duration', minutes: 30 },
});

const storedSchedule = (count: number) => ({
  schemaVersion: 1,
  enabled: true,
  target: { kind: 'devices', deviceIds: ['l1'] },
  days: null,
  entries: Array.from({ length: count }, (_, i) => window(i)),
  managedFlows: [],
});

describe('a stored schedule is held to twelve windows when it loads', () => {
  test('thirteen well-formed windows load as the first twelve, not as a quarantine', () => {
    const plan = validateSchedulePlan(storedSchedule(MAX_ENTRIES + 1));
    assert.equal(plan.entries.length, MAX_ENTRIES);
    assert.deepEqual(plan.entries.map(entry => entry.id),
      Array.from({ length: MAX_ENTRIES }, (_, i) => `s${i}`), 'in stored order');
  });

  test('twelve load untouched', () => {
    assert.equal(validateSchedulePlan(storedSchedule(MAX_ENTRIES)).entries.length, MAX_ENTRIES);
  });

  test('a malformed window past the twelfth is still a malformed plan', () => {
    // Truncating after validation, not instead of it: what is stored is either
    // a plan or it is not, whatever the app then chooses to run of it.
    const stored = storedSchedule(MAX_ENTRIES + 1);
    (stored.entries[MAX_ENTRIES] as Record<string, unknown>).onAt = 'not a time';
    assert.throws(() => validateSchedulePlan(stored), /entries\[12\]\.onAt/);
  });

  test('the corruption cap still quarantines a list nobody could have meant', () => {
    assert.throws(() => validateSchedulePlan(storedSchedule(33)), /more than 32 entries/);
  });
});

describe('the lamps a pre-stage test proved are capped like every other list', () => {
  test('an oversized list is truncated, never thrown', () => {
    const plan = validateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1'] },
      points: DEFAULT_POINTS,
      adjustBrightness: false,
      transition: 'balanced',
      preStage: true,
      preStageLights: Array.from({ length: 100_000 }, (_, i) => `l${i}`),
    });
    assert.equal(plan.preStageLights?.length, 256);
    assert.equal(plan.preStageLights?.[0], 'l0');
  });
});

describe('an incoming list is read one row at a time only up to a bound', () => {
  test('sanitiseEntries names a few rows over the cap one by one, as before', () => {
    const { entries, dropped } = sanitiseEntries(Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => window(i)));
    assert.equal(entries.length, MAX_ENTRIES);
    assert.equal(dropped.length, 3);
  });

  test('sanitiseEntries collapses everything past the bound into one row', () => {
    const { entries, dropped } = sanitiseEntries(Array.from({ length: 100_000 }, () => 'junk'));
    assert.deepEqual(entries, []);
    assert.equal(dropped.length, MAX_INCOMING_ENTRIES + 1, 'one per row read, plus one for the rest');
    assert.deepEqual(dropped.at(-1), {
      index: MAX_INCOMING_ENTRIES,
      reason: `${100_000 - MAX_INCOMING_ENTRIES} more row(s) past the first ${MAX_INCOMING_ENTRIES} were not read`,
    });
  });

  test('twelve good rows after a run of junk inside the bound are all still kept', () => {
    const junk = Array.from({ length: MAX_INCOMING_ENTRIES - MAX_ENTRIES }, () => null);
    const good = Array.from({ length: MAX_ENTRIES }, (_, i) => window(i));
    assert.equal(sanitiseEntries([...junk, ...good]).entries.length, MAX_ENTRIES);
  });

  test('sanitiseCurve collapses everything past the bound into one row', () => {
    const result = sanitiseCurve(Array.from({ length: 100_000 }, () => 'junk'));
    assert.deepEqual(result.points, []);
    assert.equal(result.dropped.length, MAX_INCOMING_POINTS + 1);
    assert.match(result.dropped.at(-1)!.reason, /more row\(s\) past the first 32 were not read/);
    assert.equal(MAX_INCOMING_POINTS, MAX_POINTS * 4);
  });
});
