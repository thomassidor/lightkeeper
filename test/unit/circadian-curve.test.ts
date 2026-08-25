import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextPointAfter, resolveAnchor, resolvePoints, valueAt,
} from '../../lib/circadian/circadian-curve';
import { DEFAULT_POINTS, type CircadianPoint } from '../../lib/circadian/circadian-types';

/**
 * The curve is the whole feature's correctness, and its two load-bearing
 * properties are both invisible in a spot check:
 *
 *  - it is CYCLIC, so the hours between the last point of the day and the first
 *    are a segment like any other rather than a gap;
 *  - it is CONTINUOUS, so nothing the user can configure produces a visible step
 *    in the colour of a room.
 *
 * Both are asserted over a whole day rather than at chosen minutes, because a
 * chosen minute is exactly where a wrapping bug hides.
 */

function at(minute: number, warmth: number, brightness?: number): CircadianPoint {
  return {
    id: `p${minute}`,
    anchor: { kind: 'clock', at: minute },
    warmth,
    ...(brightness !== undefined ? { brightness } : {}),
  };
}

/** Evening-warm, day-cool: two points, one of which spans midnight. */
const SIMPLE = [at(6 * 60, 0.2), at(18 * 60, 1)];

describe('resolveAnchor', () => {
  test('a clock anchor is its own minute', () => {
    assert.equal(resolveAnchor({ kind: 'clock', at: 7 * 60 + 30 }), 450);
  });

  test('a clock anchor outside the day wraps rather than throwing', () => {
    assert.equal(resolveAnchor({ kind: 'clock', at: 1500 }), 60);
    assert.equal(resolveAnchor({ kind: 'clock', at: -60 }), 1380);
  });

  test('a sun anchor with no sun time throws rather than defaulting', () => {
    // Defaulting would put the anchor at midnight and produce a curve that is
    // wrong in a way no screen could show. sanitiseCurve() refuses these on the
    // way in, so this is the second lock on the same door.
    assert.throws(
      () => resolveAnchor({ kind: 'sun', event: 'sunrise', offset: 0 }),
      /No sunrise time is available/,
    );
  });

  test('a sun anchor resolves against the context once there is one', () => {
    assert.equal(
      resolveAnchor({ kind: 'sun', event: 'sunset', offset: -30 }, { sunsetMinute: 21 * 60 }),
      20 * 60 + 30,
    );
  });
});

describe('valueAt', () => {
  test('a point returns its own value exactly', () => {
    assert.equal(valueAt(SIMPLE, 6 * 60).warmth, 0.2);
    assert.equal(valueAt(SIMPLE, 18 * 60).warmth, 1);
  });

  test('midway through a segment is midway between its ends', () => {
    // The easing is symmetric, so the midpoint is the one interior value that
    // is the same as it would be under linear interpolation.
    assert.equal(Math.round(valueAt(SIMPLE, 12 * 60).warmth * 1000) / 1000, 0.6);
  });

  test('the segment that wraps midnight is interpolated, not flat', () => {
    // 18:00 (1.0) → 06:00 (0.2) crosses midnight. If the day is treated as a
    // line rather than a circle, every one of these reads 1.0 or 0.2.
    const evening = valueAt(SIMPLE, 21 * 60).warmth;
    const midnight = valueAt(SIMPLE, 0).warmth;
    const early = valueAt(SIMPLE, 3 * 60).warmth;

    assert.ok(evening < 1 && evening > midnight, `21:00 is ${evening}`);
    assert.ok(midnight < evening && midnight > early, `00:00 is ${midnight}`);
    assert.ok(early > 0.2, `03:00 is ${early}`);
  });

  test('every minute of the day is defined, in range, and continuous', () => {
    let previous = valueAt(DEFAULT_POINTS, 0).warmth;
    for (let minute = 1; minute < 1440; minute += 1) {
      const warmth = valueAt(DEFAULT_POINTS, minute).warmth;
      assert.ok(Number.isFinite(warmth), `${minute} is not a number`);
      assert.ok(warmth >= 0 && warmth <= 1, `${minute} is ${warmth}`);
      // A minute of the default curve never moves more than a hundredth — which
      // is also why the runtime's write gate is worth having.
      assert.ok(Math.abs(warmth - previous) < 0.01, `a step of ${warmth - previous} at ${minute}`);
      previous = warmth;
    }
    // And it closes: midnight seen from either side is the same colour.
    assert.ok(Math.abs(valueAt(DEFAULT_POINTS, 1439).warmth - valueAt(DEFAULT_POINTS, 0).warmth) < 0.01);
  });

  test('the default curve is warm at night and cool in the middle of the day', () => {
    // The product claim, asserted rather than assumed. HIGHER IS WARMER
    // (CLAUDE.md §6), and getting this backwards once lit a room cold white at
    // bedtime.
    assert.ok(valueAt(DEFAULT_POINTS, 23 * 60).warmth > 0.9);
    assert.ok(valueAt(DEFAULT_POINTS, 3 * 60).warmth > 0.85);
    assert.ok(valueAt(DEFAULT_POINTS, 12 * 60).warmth < 0.45);
  });

  test('unsorted points are ordered before anything is read off them', () => {
    const shuffled = [at(18 * 60, 1), at(6 * 60, 0.2)];
    assert.deepEqual(valueAt(shuffled, 12 * 60), valueAt(SIMPLE, 12 * 60));
  });

  test('a single point holds one colour all day', () => {
    // Not reachable through the sanitiser, which refuses fewer than two — this
    // is the runtime's safety net rather than a supported configuration.
    const single = [at(9 * 60, 0.42)];
    assert.equal(valueAt(single, 0).warmth, 0.42);
    assert.equal(valueAt(single, 23 * 60).warmth, 0.42);
  });

  test('no points at all throws rather than answering', () => {
    assert.throws(() => valueAt([], 0), /at least one point/);
  });

  test('brightness comes back only when both ends of the segment carry one', () => {
    const mixed = [at(6 * 60, 0.2, 0.4), at(18 * 60, 1)];
    assert.equal(valueAt(mixed, 12 * 60).brightness, undefined);

    const both = [at(6 * 60, 0.2, 0.4), at(18 * 60, 1, 0.8)];
    assert.equal(Math.round(valueAt(both, 12 * 60).brightness! * 1000) / 1000, 0.6);
  });
});

describe('nextPointAfter', () => {
  test('names the next point of the day', () => {
    const next = nextPointAfter(DEFAULT_POINTS, 10 * 60);
    assert.equal(next?.minute, 17 * 60);
    assert.equal(next?.inMinutes, 7 * 60);
  });

  test('wraps to tomorrow once the last point has passed', () => {
    // 23:30 with a last point at 23:00: the next one is 06:00, which is 390
    // minutes away and never a negative number.
    const next = nextPointAfter(DEFAULT_POINTS, 23 * 60 + 30);
    assert.equal(next?.minute, 6 * 60);
    assert.equal(next?.inMinutes, 390);
  });

  test('an empty curve has no next point', () => {
    assert.equal(nextPointAfter([], 0), null);
  });
});

describe('resolvePoints', () => {
  test('returns minutes in day order, keeping ids', () => {
    assert.deepEqual(
      resolvePoints([at(18 * 60, 1), at(6 * 60, 0.2)]).map(p => [p.id, p.minute]),
      [['p360', 360], ['p1080', 1080]],
    );
  });
});
