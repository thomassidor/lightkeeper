import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_POINTS, MIN_POINTS, sanitiseCurve,
} from '../../lib/circadian/circadian-types';
import {
  migrateCircadianPlan, CURRENT_CIRCADIAN_SCHEMA_VERSION,
} from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_SIMPLE_PLAN, SIMPLE_SHAPE, expandSimplePlan, foldBackSimplePlan, sanitiseSimplePlan,
} from '../../lib/circadian/simple-curve';
import { valueAt } from '../../lib/circadian/circadian-curve';

/**
 * Everything the curve screen sends arrives from a webview and is therefore
 * untrusted, exactly like a generated Flow's arguments. The rule is the same one
 * sanitiseEntries() follows: DROP an invalid row and say why, never repair it
 * into something the user did not ask for — a half-filled row must not become a
 * point that holds a room at 0% warmth all evening.
 */

const clock = (at: number, warmth: number, extra: Record<string, unknown> = {}) =>
  ({ id: `p${at}`, anchor: { kind: 'clock', at }, warmth, ...extra });

describe('sanitiseCurve', () => {
  test('accepts a well-formed curve and sorts it into day order', () => {
    const result = sanitiseCurve([clock(1080, 1), clock(360, 0.2)]);
    assert.deepEqual(result.points.map(p => p.warmth), [0.2, 1]);
    assert.deepEqual(result.dropped, []);
  });

  test("accepts the screen's 'HH:MM' shorthand as an anchor", () => {
    // The whole UI is built on a time string; making it know about the anchor
    // union would be coupling for its own sake.
    const result = sanitiseCurve([{ at: '06:30', warmth: 0.9 }, { at: '21:00', warmth: 1 }]);
    assert.deepEqual(result.points.map(p => p.anchor), [
      { kind: 'clock', at: 390 },
      { kind: 'clock', at: 1260 },
    ]);
  });

  test('drops a point with no usable time, and names it', () => {
    const result = sanitiseCurve([clock(360, 0.2), { at: 'half seven', warmth: 1 }, clock(1080, 1)]);
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.dropped, [{ index: 1, reason: 'the time is not a time of day' }]);
  });

  test('drops a point with no warmth rather than choosing one', () => {
    const result = sanitiseCurve([
      clock(360, 0.2), { anchor: { kind: 'clock', at: 780 } }, clock(1080, 1),
    ]);
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.dropped, [
      { index: 1, reason: 'the warmth is not a number between 0 and 1' },
    ]);
  });

  test('refuses a sun anchor until sunrise and sunset can be resolved', () => {
    // Declared in the type so it lands as a variant later; refused here so it
    // can never half-work in the meantime.
    const result = sanitiseCurve([
      { anchor: { kind: 'sun', event: 'sunset', offset: 0 }, warmth: 1 },
      clock(360, 0.2),
      clock(1080, 1),
    ]);
    assert.equal(result.points.length, 2);
    assert.match(result.dropped[0].reason, /not supported yet/);
  });

  test('drops a second point at the same minute', () => {
    // Two anchors on one minute is a zero-length segment: a division by zero
    // dressed up as a user preference.
    const result = sanitiseCurve([clock(360, 0.2), { at: '06:00', warmth: 0.9 }, clock(1080, 1)]);
    assert.equal(result.points.length, 2);
    assert.match(result.dropped[0].reason, /already at 06:00/);
  });

  test('caps the curve and says what it refused', () => {
    const many = Array.from({ length: MAX_POINTS + 3 }, (_, i) => clock(i * 60, i / 20));
    const result = sanitiseCurve(many);
    assert.equal(result.points.length, MAX_POINTS);
    assert.equal(result.dropped.length, 3);
    assert.match(result.dropped[0].reason, /over the limit/);
  });

  test('a curve of one point is dropped entirely', () => {
    // Kept, it would read as configured on every screen and hold the lights at
    // one colour for ever.
    const result = sanitiseCurve([clock(360, 0.2)]);
    assert.deepEqual(result.points, []);
    assert.match(result.dropped[0].reason, new RegExp(`at least ${MIN_POINTS}`));
  });

  test('nothing in, nothing out — and no complaint about a curve nobody wrote', () => {
    assert.deepEqual(sanitiseCurve([]), { points: [], adjustBrightness: false, dropped: [] });
    assert.deepEqual(sanitiseCurve(null).points, []);
  });

  test('warmth is clamped rather than dropped', () => {
    const result = sanitiseCurve([clock(360, 4), clock(1080, -1)]);
    assert.deepEqual(result.points.map(p => p.warmth), [1, 0]);
  });

  test('brightness of zero is treated as unset, not as darkness', () => {
    const result = sanitiseCurve([clock(360, 0.2, { brightness: 0 }), clock(1080, 1)]);
    assert.equal(result.points[0].brightness, undefined);
  });

  test('adjustBrightness survives only when every point carries a brightness', () => {
    const partial = sanitiseCurve(
      [clock(360, 0.2, { brightness: 0.4 }), clock(1080, 1)], true,
    );
    assert.equal(partial.adjustBrightness, false, 'a half-dimmed curve would have to be invented');

    const full = sanitiseCurve(
      [clock(360, 0.2, { brightness: 0.4 }), clock(1080, 1, { brightness: 0.9 })], true,
    );
    assert.equal(full.adjustBrightness, true);
  });

  test('duplicate ids are dropped, so a point cannot shadow another', () => {
    const result = sanitiseCurve([
      { id: 'same', at: '06:00', warmth: 0.2 },
      { id: 'same', at: '18:00', warmth: 1 },
    ]);
    assert.equal(result.points.length, 0, 'one survivor is below the minimum, so the curve goes');
    assert.match(result.dropped[0].reason, /duplicate point id/);
  });
});

/**
 * The circadian light's own chain, which at version 2 STOPPED storing points.
 *
 * A circadian light is now two ends of the day with the shape supplied; the
 * point-based editor is its own device type (`drivers/curve/`), with its own store
 * and its own chain. So every test here is about the reshape, and the point-based
 * chain is tested through `migrateCurvePlan`.
 */
describe('circadian migrations', () => {
  const TARGET = { kind: 'devices', deviceIds: ['l1'] };

  test('a plan with no schemaVersion is brought forward with safe defaults', () => {
    const { plan, migrated, fromVersion } = migrateCircadianPlan({ target: TARGET });

    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(plan.schemaVersion, CURRENT_CIRCADIAN_SCHEMA_VERSION);
    assert.equal(plan.enabled, true);
    // No points survived, so the ends fall back to the defaults rather than being
    // derived from nothing.
    assert.deepEqual(plan.warmest, DEFAULT_SIMPLE_PLAN.warmest);
    assert.deepEqual(plan.coolest, DEFAULT_SIMPLE_PLAN.coolest);
    assert.equal(plan.adjustBrightness, false);
    // Opt-in, so an absent value is a no.
    assert.equal(plan.preStage, false);
  });

  test('pre-staging is never enabled by a migration', () => {
    const withPreStage = (preStage: unknown) =>
      migrateCircadianPlan({ target: TARGET, preStage }).plan.preStage;

    assert.equal(withPreStage('yes'), false);
    assert.equal(withPreStage(true), true);
  });

  test('1 to 2 keeps the warmest and coolest points and drops the rest', () => {
    // The two values the user actually chose, and the two the new shape holds.
    // Whatever they set between them is lost, and the changelog says so.
    const { plan, migrated } = migrateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: TARGET,
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.9, brightness: 0.5 },
        { id: 'p2', anchor: { kind: 'clock', at: 12 * 60 }, warmth: 0.2, brightness: 0.9 },
        { id: 'p3', anchor: { kind: 'clock', at: 18 * 60 }, warmth: 0.6, brightness: 0.7 },
        { id: 'p4', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1, brightness: 0.4 },
      ],
      adjustBrightness: true,
      preStage: true,
    });

    assert.equal(migrated, true);
    assert.deepEqual(plan.warmest, { temperature: 1, brightness: 0.4 });
    assert.deepEqual(plan.coolest, { temperature: 0.2, brightness: 0.9 });
    assert.equal(plan.adjustBrightness, true);
    // The one verdict this device type persists about ITSELF rather than about
    // the curve, so it survives the reshape.
    assert.equal(plan.preStage, true);
  });

  test('and drops brightness-following when the derived ends have none', () => {
    const { plan } = migrateCircadianPlan({
      schemaVersion: 1,
      enabled: true,
      target: TARGET,
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.2 },
        { id: 'p2', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1 },
      ],
      adjustBrightness: true,
      preStage: false,
    });
    assert.equal(plan.adjustBrightness, false);
  });

  test('an unusable point list migrates to the defaults, not to a crash', () => {
    // A version-1 plan was never validated — the chain ended in a cast until
    // Phase 6 — so `points` may be anything at all.
    for (const points of [null, 'lots', [{}], [{ warmth: 'warm' }], []]) {
      const { plan } = migrateCircadianPlan({
        schemaVersion: 1, enabled: true, target: TARGET, points, adjustBrightness: false,
      });
      assert.deepEqual(plan.warmest, DEFAULT_SIMPLE_PLAN.warmest, JSON.stringify(points));
    }
  });

  test('a current plan is left alone', () => {
    const { migrated } = migrateCircadianPlan({
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: TARGET,
      warmest: { temperature: 1, brightness: 0.6 },
      coolest: { temperature: 0.15, brightness: 0.9 },
      adjustBrightness: false,
      preStage: false,
    });
    assert.equal(migrated, false);
  });

  test('a plan from a newer build is refused rather than guessed at', () => {
    assert.throws(() => migrateCircadianPlan({ schemaVersion: 99 }), /newer than this app understands/);
  });

  test('the two ends expand into the shape, and the night is flat', () => {
    const plan = {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: TARGET as any,
      warmest: { temperature: 1, brightness: 0.5 },
      coolest: { temperature: 0.1, brightness: 0.9 },
      adjustBrightness: true,
      preStage: false,
    };
    const expanded = expandSimplePlan(plan);

    assert.equal(expanded.points.length, 4);
    // 21:00 round to 06:00 is warmest at both ends, which is what makes the whole
    // night flat without a special case. Two points would have it cooling all
    // night on its way to midday.
    assert.equal(valueAt(expanded.points, 0).warmth, 1);
    assert.equal(valueAt(expanded.points, 3 * 60).warmth, 1);
    assert.equal(valueAt(expanded.points, 23 * 60).warmth, 1);
    // And flat through the middle of the day, for the same reason.
    assert.equal(valueAt(expanded.points, 13 * 60).warmth, 0.1);
    // Between the two it is neither, and strictly between them.
    const morning = valueAt(expanded.points, 8 * 60).warmth;
    assert.ok(morning > 0.1 && morning < 1, `${morning}`);
  });

  test('brightness is all-or-nothing across the expansion', () => {
    const base = {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: TARGET as any,
      preStage: false,
    };
    const withOne = expandSimplePlan({
      ...base,
      warmest: { temperature: 1, brightness: 0.5 },
      coolest: { temperature: 0.1 },
      adjustBrightness: true,
    });
    assert.equal(withOne.adjustBrightness, false);
    assert.ok(withOne.points.every(point => point.brightness === undefined));

    const withBoth = expandSimplePlan({
      ...base,
      warmest: { temperature: 1, brightness: 0.5 },
      coolest: { temperature: 0.1, brightness: 0.9 },
      adjustBrightness: true,
    });
    assert.equal(withBoth.adjustBrightness, true);
    assert.ok(withBoth.points.every(point => point.brightness !== undefined));
  });

  /**
   * The inverse of the expansion, and the reason it moved here from
   * `drivers/circadian/device.ts`: that file extends `Homey.Device`, so it cannot
   * be imported by a test at all (platform §13) — and a bug in exactly this
   * fold-back shipped because of it. It read the plan out of the device store
   * rather than taking the plan the fold was for, and `DeviceLifecycle.apply()`
   * persists AFTER registering, so on a repair the store still held the plan the
   * user had just replaced.
   */
  test('the fold-back keeps the plan it is given and takes only the two runtime fields', () => {
    const stored = {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: TARGET as any,
      warmest: { temperature: 1 },
      coolest: { temperature: 0.1 },
      adjustBrightness: false,
      preStage: true,
    };

    // What a runtime can change while running: it paused, and pre-staging turned
    // itself off after a lamp came on from a colour write (platform §12).
    const folded = foldBackSimplePlan(stored, { enabled: false, preStage: false });

    assert.equal(folded.enabled, false);
    assert.equal(folded.preStage, false);
    // And nothing else moved — the ends are the user's answers, and the shape
    // between them is a constant that is never read back.
    assert.deepEqual(folded.warmest, stored.warmest);
    assert.deepEqual(folded.coolest, stored.coolest);
    assert.equal(folded.adjustBrightness, false);
    assert.equal(folded.schemaVersion, stored.schemaVersion);
  });

  test('the fold-back folds onto the plan given, not onto some earlier one', () => {
    const base = {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: TARGET as any,
      adjustBrightness: false,
      preStage: false,
    };
    const edited = { ...base, warmest: { temperature: 0.9 }, coolest: { temperature: 0.2 } };

    // The runtime is still running the plan it was registered with; the fold is
    // for the EDITED one. This is the repair that used to be written back as the
    // plan it replaced.
    const folded = foldBackSimplePlan(edited, expandSimplePlan(edited));

    assert.equal(folded.warmest.temperature, 0.9);
    assert.equal(folded.coolest.temperature, 0.2);
  });

  test('expansion and fold-back round-trip the two answers the user gave', () => {
    const plan = {
      schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
      enabled: true,
      target: TARGET as any,
      warmest: { temperature: 0.95, brightness: 0.4 },
      coolest: { temperature: 0.15, brightness: 0.85 },
      adjustBrightness: true,
      preStage: false,
    };

    assert.deepEqual(foldBackSimplePlan(plan, expandSimplePlan(plan)), plan);
  });

  test('the shape is derived, never stored', () => {
    // So an installed device picks up an improved shape. What is persisted is
    // only the two answers the user gave.
    assert.equal(SIMPLE_SHAPE.length, 4);
    assert.deepEqual(
      SIMPLE_SHAPE.map(point => point.end),
      ['warmest', 'coolest', 'coolest', 'warmest'],
    );
  });

  test('a screen sending nonsense falls back per FIELD, and says which', () => {
    // Falling back rather than dropping, unlike the curve's sanitiser: two ends
    // are not a list, and a device with one end has no curve at all.
    const result = sanitiseSimplePlan({
      warmest: { temperature: 'very' },
      coolest: { temperature: 0.2, brightness: 0.8 },
      adjustBrightness: true,
    });
    assert.deepEqual(result.warmest, DEFAULT_SIMPLE_PLAN.warmest);
    assert.deepEqual(result.coolest, { temperature: 0.2, brightness: 0.8 });
    assert.deepEqual(result.corrected, ['warmest temperature']);

    const empty = sanitiseSimplePlan(null);
    assert.deepEqual(empty.warmest, DEFAULT_SIMPLE_PLAN.warmest);
    assert.deepEqual(empty.coolest, DEFAULT_SIMPLE_PLAN.coolest);
    assert.equal(empty.adjustBrightness, false);
  });

  test('something that is not a plan at all is refused', () => {
    assert.throws(() => migrateCircadianPlan(null), /not an object/);
  });

  test('a plan that survived migration but is not a plan is refused too', () => {
    // The chain used to end in a cast, so a plan missing its target reached the
    // runtime and failed at the first resolve — with nothing saying why.
    assert.throws(
      () => migrateCircadianPlan({
        schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
        enabled: true,
        warmest: { temperature: 1 },
        coolest: { temperature: 0 },
        adjustBrightness: false,
      }),
      /SimpleCircadianPlan\.target is not an object/,
    );
    assert.throws(
      () => migrateCircadianPlan({ schemaVersion: '1' }),
      /schema version is malformed/,
    );
  });
});
