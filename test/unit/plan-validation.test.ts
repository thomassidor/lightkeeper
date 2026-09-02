import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateControllerProfile, validateSchedulePlan, validateCircadianPlan,
  validManagedFlowRefs,
} from '../../lib/validation/plans';
import { runMigrationChain } from '../../lib/support/migrations';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { DEFAULT_POINTS } from '../../lib/circadian/circadian-types';

/**
 * Persisted data is not trusted data.
 *
 * A plan is JSON in a device store. A downgrade, a partial write, a hand-edit or
 * a bug in a version that has since been replaced can leave one in any shape at
 * all — and the code downstream reads `plan.entries.map(...)` and
 * `switch (target.kind)` without asking. The old migration chains ended in a
 * cast, which is a chain ending in a hope.
 *
 * The two properties worth stating out loud:
 *
 *  - every rejection NAMES the field, because the message ends up in a log line
 *    beside a device that has gone unavailable;
 *  - nothing throws uncontrolled. A validator that itself crashes on malformed
 *    input has moved the failure, not fixed it.
 */

const validProfile = () => ({
  schemaVersion: 2,
  enabled: true,
  source: { deviceId: 'remote-1', eventSurfaceFingerprint: 'fp' },
  target: { kind: 'devices', deviceIds: ['l1', 'l2'] },
  mappings: [{ id: 'r1', function: 'toggle', inputKey: 'n2_on|press', target: null }],
  behavior: { ...DEFAULT_BEHAVIOR },
  managedFlows: [],
});

const validSchedule = () => ({
  schemaVersion: 1,
  enabled: true,
  target: { kind: 'zone', zoneId: 'z1', includeSubzones: true },
  entries: [{
    id: 's1', onAt: 1320, days: [1, 2, 3, 4, 5], end: { kind: 'duration', minutes: 90 },
    brightness: 0.4, temperature: 0.9,
  }],
  managedFlows: [{
    flowId: 'f1', bindingKey: 'sched:s1:on', variantKey: 'at:22:00',
    fingerprint: 'fp', managedVersion: 1, createdAt: 0,
  }],
});

const validCircadian = () => ({
  schemaVersion: 1,
  enabled: true,
  target: { kind: 'devices', deviceIds: ['l1'] },
  points: DEFAULT_POINTS.map(p => ({ ...p })),
  adjustBrightness: false,
  preStage: false,
});

describe('the happy path passes unchanged', () => {
  test('a controller profile', () => {
    assert.deepEqual(validateControllerProfile(validProfile()), validProfile());
  });

  test('a schedule plan', () => {
    assert.deepEqual(validateSchedulePlan(validSchedule()), validSchedule());
  });

  test('a circadian plan, including the default curve', () => {
    assert.deepEqual(validateCircadianPlan(validCircadian()), validCircadian());
  });

  test('an optional field that is absent stays absent', () => {
    const plan = validateSchedulePlan({
      ...validSchedule(),
      entries: [{ id: 's1', onAt: 0, days: null, end: { kind: 'time', at: 60 } }],
    });
    assert.equal('brightness' in plan.entries[0], false);
    assert.equal('temperature' in plan.entries[0], false);
    assert.equal(plan.entries[0].days, null);
  });
});

describe('every rejection names the field', () => {
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['a target of an unknown kind', () => ({ ...validProfile(), target: { kind: 'everything' } }),
      /ControllerProfile\.target\.kind is not one of devices, zone/],
    ['a device id that is not a string', () => ({
      ...validProfile(), target: { kind: 'devices', deviceIds: ['a', 7] },
    }), /ControllerProfile\.target\.deviceIds\[1\]/],
    ['a mapping to a function that does not exist', () => ({
      ...validProfile(),
      mappings: [{ id: 'r1', function: 'disco', inputKey: null, target: null }],
    }), /ControllerProfile\.mappings\[0\]\.function/],
    ['a behavior step that is not a number', () => ({
      ...validProfile(), behavior: { ...DEFAULT_BEHAVIOR, brightnessStep: 'lots' },
    }), /ControllerProfile\.behavior\.brightnessStep/],
    ['a NaN, which is a number and is not finite', () => ({
      ...validProfile(), behavior: { ...DEFAULT_BEHAVIOR, minimumBrightness: Number.NaN },
    }), /ControllerProfile\.behavior\.minimumBrightness is not a finite number/],
    ['a binding of an unknown kind', () => ({
      ...validProfile(),
      catalogue: [{
        key: 'k', controlId: 'c', label: 'l', action: 'press', carriesMagnitude: false,
        binding: { kind: 'telepathy' },
      }],
    }), /ControllerProfile\.catalogue\[0\]\.binding\.kind/],
    ['a binding with no fixedArgs', () => ({
      ...validProfile(),
      catalogue: [{
        key: 'k', controlId: 'c', label: 'l', action: 'press', carriesMagnitude: false,
        binding: { kind: 'flow_fixed', cardId: 'c', cardOwnerUri: 'u' },
      }],
    }), /ControllerProfile\.catalogue\[0\]\.binding\.fixedArgs/],
    ['a schedule minute outside the day', () => ({
      ...validSchedule(),
      entries: [{ id: 's1', onAt: 1440, days: null, end: { kind: 'duration', minutes: 10 } }],
    }), /SchedulePlan\.entries\[0\]\.onAt is above 1439/],
    ['a weekday that is not a weekday', () => ({
      ...validSchedule(),
      entries: [{ id: 's1', onAt: 0, days: [0], end: { kind: 'duration', minutes: 10 } }],
    }), /SchedulePlan\.entries\[0\]\.days\[0\] is below 1/],
    ['a zero-length duration', () => ({
      ...validSchedule(),
      entries: [{ id: 's1', onAt: 0, days: null, end: { kind: 'duration', minutes: 0 } }],
    }), /SchedulePlan\.entries\[0\]\.end\.minutes is below 1/],
    ['a warmth above the axis', () => ({
      ...validCircadian(),
      points: [{ id: 'p1', anchor: { kind: 'clock', at: 0 }, warmth: 1.5 }],
    }), /CircadianPlan\.points\[0\]\.warmth is above 1/],
    ['a sun anchor, which this version cannot resolve', () => ({
      ...validCircadian(),
      points: [{ id: 'p1', anchor: { kind: 'sun', event: 'sunrise', offset: 0 }, warmth: 0.5 }],
    }), /CircadianPlan\.points\[0\]\.anchor\.kind is "sun"/],
    // Two points, because the curve now has a lower bound too — one point is
    // not a curve, and this case is about the brightness rule.
    ['brightness following a curve that has none', () => ({
      ...validCircadian(),
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 0 }, warmth: 0.5 },
        { id: 'p2', anchor: { kind: 'clock', at: 720 }, warmth: 0.2 },
      ],
      adjustBrightness: true,
    }), /CircadianPlan\.adjustBrightness is set while a point carries no brightness/],
    ['a curve of one point, which reports ready and writes nothing', () => ({
      ...validCircadian(),
      points: [{ id: 'p1', anchor: { kind: 'clock', at: 0 }, warmth: 0.5 }],
      adjustBrightness: false,
    }), /CircadianPlan\.points has fewer than 2 points/],
    ['a curve with two points sharing an id, so one can never be found', () => ({
      ...validCircadian(),
      points: [
        { id: 'same', anchor: { kind: 'clock', at: 0 }, warmth: 0.5 },
        { id: 'same', anchor: { kind: 'clock', at: 720 }, warmth: 0.2 },
      ],
      adjustBrightness: false,
    }), /CircadianPlan\.points contains more than one entry with id "same"/],
    ['a schedule id the event-key format cannot survive', () => ({
      ...validSchedule(),
      entries: [{ ...validSchedule().entries[0], id: 'evening:lights' }],
    }), /SchedulePlan\.entries\[0\]\.id is not a usable schedule id/],
    ['a schedule whose off-time equals its on-time, so it can never end', () => ({
      ...validSchedule(),
      entries: [{ ...validSchedule().entries[0], onAt: 1320, end: { kind: 'time', at: 1320 } }],
    }), /SchedulePlan\.entries\[0\]\.end\.at is the same as the on-time/],
    ['two schedule entries sharing an id, so one can never fire', () => ({
      ...validSchedule(),
      entries: [
        { ...validSchedule().entries[0], id: 'both' },
        { ...validSchedule().entries[0], id: 'both', onAt: 300, end: { kind: 'duration', minutes: 30 } },
      ],
    }), /SchedulePlan\.entries contains more than one entry with id "both"/],
  ];

  for (const [name, build, expected] of cases) {
    test(name, () => {
      const validate = expected.source.startsWith('ControllerProfile')
        ? validateControllerProfile
        : expected.source.startsWith('SchedulePlan') ? validateSchedulePlan : validateCircadianPlan;
      assert.throws(() => validate(build()), expected);
    });
  }
});

describe('fuzzed input rejects rather than crashing', () => {
  /** Every shape a device store can plausibly be left holding. */
  const NASTY: unknown[] = [
    null, undefined, 0, 1, -1, Number.NaN, Number.POSITIVE_INFINITY,
    '', 'plan', true, false, [], [1, 2, 3], {},
    { schemaVersion: null }, { schemaVersion: '1' }, { schemaVersion: 1.5 },
    { schemaVersion: -1 }, { schemaVersion: 1, target: null },
    { schemaVersion: 1, target: [] }, { schemaVersion: 1, entries: {} },
    { schemaVersion: 1, entries: null }, { schemaVersion: 1, points: 'lots' },
    { schemaVersion: 1, enabled: 'yes' },
    // A list far above any cap. Iterating it inside a device's onInit is what
    // the cap exists to prevent.
    { schemaVersion: 1, enabled: true, target: { kind: 'devices', deviceIds: [] }, entries: new Array(100_000).fill({}) },
  ];

  for (const [name, validate] of [
    ['controller', validateControllerProfile],
    ['schedule', validateSchedulePlan],
    ['circadian', validateCircadianPlan],
  ] as const) {
    test(`${name}: every nasty value throws a ValidationError with a message`, () => {
      for (const value of NASTY) {
        let thrown: unknown;
        try {
          validate(value as any);
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown instanceof Error, `${JSON.stringify(value)} did not throw`);
        assert.ok(String(thrown.message).length > 0);
        // Never a TypeError from reading a property off undefined: that is the
        // failure moving rather than being handled.
        assert.notEqual(thrown.name, 'TypeError', `${JSON.stringify(value)}: ${thrown.message}`);
      }
    });
  }

  test('a bounded list is refused by its cap, with the cap named', () => {
    assert.throws(
      () => validateSchedulePlan({
        ...validSchedule(), entries: new Array(1000).fill(validSchedule().entries[0]),
      }),
      /SchedulePlan\.entries has more than 32 entries/,
    );
  });
});

describe('forged managed-Flow references never reach a delete', () => {
  const good = {
    flowId: 'f1', bindingKey: 'k', variantKey: '', fingerprint: 'fp',
    managedVersion: 1, createdAt: 0,
  };

  test('only a complete, well-typed reference survives the filter', () => {
    const refs = validManagedFlowRefs([
      good,
      { flowId: 'victim' },
      { ...good, flowId: '' },
      { ...good, managedVersion: '1' },
      { ...good, createdAt: 'yesterday' },
      { ...good, bindingKey: 42 },
      'flow-id-as-a-string',
      null,
      [],
    ]);
    assert.deepEqual(refs, [good]);
  });

  test('anything that is not a list yields nothing to delete', () => {
    for (const value of [null, undefined, 'f1', 7, {}, { 0: good }]) {
      assert.deepEqual(validManagedFlowRefs(value), []);
    }
  });

  test('the filter never throws, because a delete path that throws leaks', () => {
    // Throwing here would skip the cleanup entirely and leave every OTHER
    // reference's Flow behind — worse than deleting fewer things.
    assert.doesNotThrow(() => validManagedFlowRefs([undefined, Number.NaN, () => 1]));
  });
});

describe('the shared migration runner', () => {
  const chain = <T>(current: number, table: any, validate: (v: unknown) => T) => ({
    label: 'Widget', current, table, validate,
  });
  const identity = (value: unknown) => value as Record<string, unknown>;

  test('an absent version is 0, and the 0 step runs', () => {
    const result = runMigrationChain({}, chain(1, {
      0: (v: any) => ({ ...v, schemaVersion: 1, filled: true }),
    }, identity));
    assert.equal(result.fromVersion, 0);
    assert.equal(result.migrated, true);
    assert.deepEqual(result.steps, [0]);
    assert.equal((result.value as any).filled, true);
  });

  test('a PRESENT non-integer version is malformed, not 0', () => {
    // Reading '1' as 0 would replay every historical step over a shape that has
    // already been through them.
    for (const version of ['1', 1.5, Number.NaN, -1, true, {}]) {
      assert.throws(
        () => runMigrationChain({ schemaVersion: version }, chain(1, {}, identity)),
        /Widget schema version is malformed/,
        JSON.stringify(version),
      );
    }
  });

  test('a newer version is refused rather than downgraded', () => {
    assert.throws(
      () => runMigrationChain({ schemaVersion: 9 }, chain(1, {}, identity)),
      /Widget schema version 9 is newer than this app understands/,
    );
  });

  test('a missing step is named', () => {
    assert.throws(
      () => runMigrationChain({ schemaVersion: 0 }, chain(2, {
        0: (v: any) => ({ ...v, schemaVersion: 1 }),
      }, identity)),
      /No widget migration registered from version 1/,
    );
  });

  test('a step that does not advance is refused', () => {
    assert.throws(
      () => runMigrationChain({ schemaVersion: 0 }, chain(1, {
        0: (v: any) => ({ ...v, schemaVersion: 0 }),
      }, identity)),
      /did not advance the version/,
    );
  });

  test('a table that advances in a cycle terminates', () => {
    // Guarded separately from the non-advancing check: 1 → 2 → 1 advances every
    // step and would spin forever inside a device's onInit.
    assert.throws(
      () => runMigrationChain({ schemaVersion: 0 }, chain(99, {
        0: (v: any) => ({ ...v, schemaVersion: 1 }),
        1: (v: any) => ({ ...v, schemaVersion: 2 }),
        2: (v: any) => ({ ...v, schemaVersion: 1 }),
      }, identity)),
      /did not advance the version|did not terminate/,
    );
  });

  test('the validator is the last word, and its failure is the chain failure', () => {
    assert.throws(
      () => runMigrationChain({ schemaVersion: 1 }, chain(1, {}, () => {
        throw new Error('not a widget');
      })),
      /not a widget/,
    );
  });

  test('a non-object, including an array, is refused', () => {
    for (const value of [null, undefined, 7, 'plan', [], [{}]]) {
      assert.throws(
        () => runMigrationChain(value, chain(1, {}, identity)),
        /not an object/,
        JSON.stringify(value),
      );
    }
  });
});
