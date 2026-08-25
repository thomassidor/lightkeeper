import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_POINTS, MIN_POINTS, sanitiseCurve,
} from '../../lib/circadian/circadian-types';
import { migrateCircadianPlan } from '../../lib/circadian/circadian-migrations';

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
    assert.match(result.dropped[0]!.reason, /not supported yet/);
  });

  test('drops a second point at the same minute', () => {
    // Two anchors on one minute is a zero-length segment: a division by zero
    // dressed up as a user preference.
    const result = sanitiseCurve([clock(360, 0.2), { at: '06:00', warmth: 0.9 }, clock(1080, 1)]);
    assert.equal(result.points.length, 2);
    assert.match(result.dropped[0]!.reason, /already at 06:00/);
  });

  test('caps the curve and says what it refused', () => {
    const many = Array.from({ length: MAX_POINTS + 3 }, (_, i) => clock(i * 60, i / 20));
    const result = sanitiseCurve(many);
    assert.equal(result.points.length, MAX_POINTS);
    assert.equal(result.dropped.length, 3);
    assert.match(result.dropped[0]!.reason, /over the limit/);
  });

  test('a curve of one point is dropped entirely', () => {
    // Kept, it would read as configured on every screen and hold the lights at
    // one colour for ever.
    const result = sanitiseCurve([clock(360, 0.2)]);
    assert.deepEqual(result.points, []);
    assert.match(result.dropped[0]!.reason, new RegExp(`at least ${MIN_POINTS}`));
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
    assert.equal(result.points[0]!.brightness, undefined);
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
    assert.match(result.dropped[0]!.reason, /duplicate point id/);
  });
});

describe('circadian migrations', () => {
  test('a plan with no schemaVersion is brought forward with safe defaults', () => {
    const { plan, migrated, fromVersion } = migrateCircadianPlan({
      target: { kind: 'devices', deviceIds: ['l1'] },
    });
    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.enabled, true);
    assert.deepEqual(plan.points, []);
    assert.equal(plan.adjustBrightness, false);
    // Opt-in, so an absent value is a no.
    assert.equal(plan.preStage, false);
  });

  test('pre-staging is never enabled by a migration', () => {
    assert.equal(migrateCircadianPlan({ preStage: 'yes' }).plan.preStage, false);
    assert.equal(migrateCircadianPlan({ preStage: true }).plan.preStage, true);
  });

  test('a current plan is left alone', () => {
    const { migrated } = migrateCircadianPlan({ schemaVersion: 1, points: [] });
    assert.equal(migrated, false);
  });

  test('a plan from a newer build is refused rather than guessed at', () => {
    assert.throws(() => migrateCircadianPlan({ schemaVersion: 99 }), /newer than this app understands/);
  });

  test('something that is not a plan at all is refused', () => {
    assert.throws(() => migrateCircadianPlan(null), /not an object/);
  });
});
