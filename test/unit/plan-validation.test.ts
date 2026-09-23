import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateControllerProfile, validateSchedulePlan, validateCircadianPlan,
  validateDaylightPlan, validManagedFlowRefs,
} from '../../lib/validation/plans';
import { runMigrationChain } from '../../lib/support/migrations';
import { DEFAULT_BEHAVIOR, FUNCTION_PRESET } from '../../lib/mapping/mapping-types';
import { availableFunctions } from '../../lib/mapping/mapping-engine';
import { DEFAULT_POINTS } from '../../lib/circadian/circadian-types';
import { DEFAULT_RESPONSE } from '../../lib/daylight/daylight-types';

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
  schemaVersion: 1,
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
  days: null,
  entries: [{
    id: 's1', onAt: 1320, end: { kind: 'duration', minutes: 90 },
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

const validDaylight = () => ({
  schemaVersion: 1,
  enabled: true,
  target: { kind: 'devices', deviceIds: ['l1'] },
  response: { ...DEFAULT_RESPONSE, sensor: 'sensor-a' },
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

  test('a daylight plan, including the default response', () => {
    assert.deepEqual(validateDaylightPlan(validDaylight()), validDaylight());
  });

  test('a schedule may name the days it runs on', () => {
    const weekdays = { ...validSchedule(), days: [1, 2, 3, 4, 5] };
    assert.deepEqual(validateSchedulePlan(weekdays), weekdays);
  });

  test('a daylight response may have its two ends either way round', () => {
    // Direction is the user's choice, not a mode, so the validator must not have
    // an opinion about which end is larger.
    const following = {
      ...validDaylight(),
      response: { ...DEFAULT_RESPONSE, dark: 0.25, bright: 0.9 },
    };
    assert.deepEqual(validateDaylightPlan(following), following);
  });

  test('an optional field that is absent stays absent', () => {
    const plan = validateSchedulePlan({
      ...validSchedule(),
      entries: [{ id: 's1', onAt: 0, end: { kind: 'time', at: 60 } }],
    });
    assert.equal('brightness' in plan.entries[0], false);
    assert.equal('temperature' in plan.entries[0], false);
    // Days belong to the schedule now, and an absent set is every day.
    assert.equal(plan.days, null);
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
      entries: [{ id: 's1', onAt: 1440, end: { kind: 'duration', minutes: 10 } }],
    }), /SchedulePlan\.entries\[0\]\.onAt is above 1439/],
    ['a weekday that is not a weekday', () => ({
      ...validSchedule(),
      days: [0],
    }), /SchedulePlan\.days\[0\] is below 1/],
    ['a day set that could never fire', () => ({
      ...validSchedule(),
      days: [],
    }), /SchedulePlan\.days is an empty list, so the schedule could never fire/],
    ['a zero-length duration', () => ({
      ...validSchedule(),
      entries: [{ id: 's1', onAt: 0, end: { kind: 'duration', minutes: 0 } }],
    }), /SchedulePlan\.entries\[0\]\.end\.minutes is below 1/],
    ['a warmth above the axis', () => ({
      ...validCircadian(),
      points: [{ id: 'p1', anchor: { kind: 'clock', at: 0 }, warmth: 1.5 }],
    }), /CircadianPlan\.points\[0\]\.warmth is above 1/],
    /**
     * A sun-anchored POINT, refused by kind — which is what the two cases this
     * replaces were really about.
     *
     * They asserted on `.event` and `.offset`, which meant the validator was
     * accepting the variant and only policing its fields. Nothing threads an
     * `AnchorContext` into the curve runtime, so a stored plan carrying one
     * threw out of `resolveAnchor()` on every tick. `sanitiseCurve` is the
     * pairing screen's gate; this is the STORE's, and a store can be written out
     * of band — so it fails here, quarantining the device with a reason, rather
     * than letting it run and do nothing.
     */
    ['a sun-anchored point, which no context can resolve', () => ({
      ...validCircadian(),
      points: DEFAULT_POINTS.map((point, i) => (i === 0
        ? { ...point, anchor: { kind: 'sun', event: 'sunrise', offset: 0 } }
        : point)),
    }), /CircadianPlan\.points\[0\]\.anchor\.kind is not one of clock/],
    ['a sun anchor that is not even well-formed, refused by kind first', () => ({
      ...validCircadian(),
      points: DEFAULT_POINTS.map((point, i) => (i === 0
        ? { ...point, anchor: { kind: 'sun', event: 'moonrise', offset: 5000 } }
        : point)),
    }), /CircadianPlan\.points\[0\]\.anchor\.kind is not one of clock/],
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
    ['a daylight response with no span, so the level would be a NaN', () => ({
      ...validDaylight(),
      response: { ...DEFAULT_RESPONSE, darkLux: 100, brightLux: 100 },
    }), /DaylightPlan\.response\.brightLux is not above darkLux/],
    ['a daylight response with an inverted span', () => ({
      ...validDaylight(),
      response: { ...DEFAULT_RESPONSE, darkLux: 900, brightLux: 20 },
    }), /DaylightPlan\.response\.brightLux is not above darkLux/],
    ['a daylight response missing an end, which is asked for a number every tick', () => ({
      ...validDaylight(),
      response: { ...DEFAULT_RESPONSE, bright: undefined },
    }), /DaylightPlan\.response\.bright is not a finite number/],
    ['a daylight response with a lux value no sensor could report', () => ({
      ...validDaylight(),
      response: { ...DEFAULT_RESPONSE, brightLux: 5_000_000 },
    }), /DaylightPlan\.response\.brightLux is above 100000/],
  ];

  for (const [name, build, expected] of cases) {
    test(name, () => {
      const validate = expected.source.startsWith('ControllerProfile')
        ? validateControllerProfile
        : expected.source.startsWith('SchedulePlan') ? validateSchedulePlan
          : expected.source.startsWith('DaylightPlan') ? validateDaylightPlan
            : validateCircadianPlan;
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
    ['daylight', validateDaylightPlan],
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
    // So what it RETURNS is the assertion: the junk dropped, and a good
    // reference among it still kept — a filter that "did not throw" by
    // returning [] for any hostile list would fail the second.
    assert.deepEqual(validManagedFlowRefs([undefined, Number.NaN, () => 1]), []);
    assert.deepEqual(
      validManagedFlowRefs([undefined, good, Number.NaN, () => 1, Symbol('x')]),
      [good],
    );
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
    assert.equal((result.plan as any).filled, true);
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

/**
 * Pre-staging is a CHOICE on the review screen, and then a per-lamp test.
 *
 * "How Lightkeeper controls your lights" defaults to "Change lights after they
 * turn on", so a new device starts with `preStage` off — the second reversal of
 * that default, argued at DEFAULT_SIMPLE_PLAN. The store's own gate is
 * unchanged and still the thing to protect: `preStage === true`, so an absent
 * key is not consent. And `true` alone pre-stages nothing any more; only the
 * lamps in `preStageLights` are written to while off.
 */
describe('pre-staging is chosen, then proven lamp by lamp', () => {
  test('a new device starts with it off, and with brightness on', async () => {
    const { DEFAULT_SIMPLE_PLAN } = await import('../../lib/circadian/simple-curve');
    assert.equal(DEFAULT_SIMPLE_PLAN.preStage, false);
    assert.equal(DEFAULT_SIMPLE_PLAN.adjustBrightness, true);
  });

  test('the lamps a test proved are kept, de-duplicated, and junk is dropped', () => {
    const plan = validateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1', 'l2'] },
      points: DEFAULT_POINTS,
      adjustBrightness: false,
      preStage: true,
      preStageLights: ['l1', 'l1', '', 7, null, 'l2'],
    });
    assert.deepEqual(plan.preStageLights, ['l1', 'l2']);
  });

  test('a plan with no list round-trips without growing one', () => {
    const plan = validateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1'] },
      points: DEFAULT_POINTS,
      adjustBrightness: false,
      preStage: true,
    });
    assert.equal('preStageLights' in plan, false, 'absent in, absent out');
  });

  test('a device chosen but never tested pre-stages no lamp', async () => {
    const { preStagesLamp } = await import('../../lib/circadian/circadian-types');
    // Every device paired before this change with `preStage: true` looks like
    // this, and that is the agreed reading: option 2, untested.
    assert.equal(preStagesLamp({ preStage: true }, 'l1'), false);
    assert.equal(preStagesLamp({ preStage: true, preStageLights: [] }, 'l1'), false);
    assert.equal(preStagesLamp({ preStage: true, preStageLights: ['l1'] }, 'l1'), true);
    assert.equal(preStagesLamp({ preStage: true, preStageLights: ['l1'] }, 'l2'), false);
    // The list alone is not consent either: leaving "before" keeps it for later.
    assert.equal(preStagesLamp({ preStage: false, preStageLights: ['l1'] }, 'l1'), false);
  });

  test('a stored plan that never had the key stays off', () => {
    const plan = validateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1'] },
      points: DEFAULT_POINTS,
      adjustBrightness: false,
      // No `preStage`: written by a version that had no such thing.
    });
    assert.equal(plan.preStage, false, 'an absent key is not consent');
  });

  test('a stored plan that says false stays false', () => {
    const plan = validateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1'] },
      points: DEFAULT_POINTS,
      adjustBrightness: false,
      preStage: false,
    });
    assert.equal(plan.preStage, false);
  });

  test('a stored plan that says true is honoured', () => {
    const plan = validateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1'] },
      points: DEFAULT_POINTS,
      adjustBrightness: false,
      preStage: true,
    });
    assert.equal(plan.preStage, true);
  });

  test('anything other than a real true is a no', () => {
    for (const value of ['true', 1, {}, [], 'yes']) {
      const plan = validateCircadianPlan({
        schemaVersion: 1,
        enabled: true,
        target: { kind: 'devices', deviceIds: ['l1'] },
        points: DEFAULT_POINTS,
        adjustBrightness: false,
        preStage: value,
      });
      assert.equal(plan.preStage, false, `${JSON.stringify(value)} is not consent either`);
    }
  });
});


/**
 * The allow-list a stored rule's `function` is checked against, held to the
 * union it is supposed to mirror.
 *
 * `LIGHT_FUNCTIONS` in `lib/validation/plans.ts` is hand-written on purpose —
 * its own docblock argues why — and that is exactly how `color_set` came to be
 * missing from it. It reached `LightFunction`, `FUNCTION_CAPABILITY`,
 * `FUNCTION_PRESET` and `availableFunctions()`, so the buttons screen offered
 * "Set colour" on any lamp with `light_hue` and `validateMappingRules` accepted
 * it; only this validator did not know it. A Light Remote with a colour button
 * therefore paired cleanly, wrote its store, and came up unavailable on the very
 * next `onInit` saying its configuration could not be read — with the button
 * that caused it named nowhere.
 *
 * Not a derivation, which would defeat the point of the list: an assertion that
 * the hand-written one is complete.
 */
describe('the stored-plan allow-list covers every function the app offers', () => {
  const rule = (fn: string, preset?: unknown) => ({
    ...validProfile(),
    mappings: [{
      id: 'r1', function: fn, inputKey: 'n2_on|press', target: null,
      ...(preset !== undefined ? { preset } : {}),
    }],
  });

  /**
   * A valid value of each kind, so the loop below tests the allow-list rather
   * than the preset rules. Every `PresetKind` must appear: an unhandled kind
   * yields `undefined`, and the rule is then refused for having no preset —
   * which fails this test for the wrong reason and hides whether the function
   * is on the list at all.
   */
  const presetFor = (kind: string) => ({
    colour: { color: 'amber' },
    brightness: { brightness: 0.5 },
    lightkeeper: { colourSource: 'lk-curve-1', brightnessSource: 'none', pressAgainOff: true },
    none: undefined,
  } as Record<string, unknown>)[kind];

  for (const [fn, kind] of Object.entries(FUNCTION_PRESET)) {
    test(`a stored "${fn}" rule is readable`, () => {
      const profile = validateControllerProfile(rule(fn, presetFor(kind)));
      assert.equal(profile.mappings[0]!.function, fn);
    });
  }

  test('every function the buttons screen can offer survives a round trip', () => {
    const offered = availableFunctions({ onoff: 2, dim: 2, light_temperature: 2, light_hue: 2 });
    assert.ok(offered.includes('color_set'), 'the screen still offers a colour');
    for (const fn of offered) {
      assert.doesNotThrow(
        () => validateControllerProfile(rule(fn, presetFor(FUNCTION_PRESET[fn]))),
        `"${fn}" can be chosen but not stored`,
      );
    }
  });

  test('a function the app does not know is still refused', () => {
    assert.throws(
      () => validateControllerProfile(rule('set_the_house_on_fire')),
      /mappings\[0\].function/,
    );
  });
});
