import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TRANSITION, TRANSITIONS, isTransition, mix, sanitiseTransition, shape,
} from '../../lib/support/interpolate';

/**
 * The one family of shapes every engine interpolates with — the "Transition"
 * choice. The numbers asserted here are the ones the pairing screens draw and
 * the migrations lean on, so each is stated rather than implied.
 */

describe('shape', () => {
  test('every transition starts at 0, ends at 1, and passes through the middle', () => {
    // The logistic is NORMALISED: a bare one never reaches either end, and a
    // curve that stopped short of its own point would never write the value the
    // person chose there.
    for (const transition of TRANSITIONS) {
      assert.equal(shape(transition, 0), 0, transition);
      assert.ok(Math.abs(shape(transition, 1) - 1) < 1e-12, transition);
      assert.ok(Math.abs(shape(transition, 0.5) - 0.5) < 1e-12, transition);
    }
  });

  test('every transition is monotonic', () => {
    for (const transition of TRANSITIONS) {
      let previous = -1;
      for (let i = 0; i <= 1000; i++) {
        const value = shape(transition, i / 1000);
        assert.ok(value >= previous, `${transition} fell at ${i / 1000}`);
        previous = value;
      }
    }
  });

  test('outside 0..1 it clamps rather than extrapolating', () => {
    for (const transition of TRANSITIONS) {
      assert.equal(shape(transition, -0.5), 0, transition);
      assert.ok(Math.abs(shape(transition, 1.5) - 1) < 1e-12, transition);
    }
  });

  test('Gradual is linear, and Quick is steeper than Balanced in the middle', () => {
    assert.equal(shape('gradual', 0.3), 0.3);
    // The same quarter-way point, three answers in order.
    assert.ok(shape('quick', 0.25) < shape('balanced', 0.25));
    assert.ok(shape('balanced', 0.25) < shape('gradual', 0.25));
  });

  test('Balanced is within 0.016 of the raised cosine it replaced', () => {
    // The argument every migration to Balanced rests on: an existing curve or
    // Room-sensing Light keeps its shape to within less than the curve's own
    // colour deadband (0.03), so it does not visibly change.
    let worst = 0;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      worst = Math.max(worst, Math.abs(shape('balanced', t) - (0.5 - 0.5 * Math.cos(Math.PI * t))));
    }
    assert.ok(worst < 0.016, `worst gap ${worst}`);
  });
});

describe('the stored value', () => {
  test('only the three names are transitions', () => {
    for (const transition of TRANSITIONS) assert.equal(isTransition(transition), true);
    for (const junk of ['Balanced', 'eased', '', null, undefined, 1]) {
      assert.equal(isTransition(junk), false, JSON.stringify(junk));
    }
  });

  test('a screen sending junk gets the default, and it is reported', () => {
    const corrected: string[] = [];
    assert.equal(sanitiseTransition('instant', corrected), DEFAULT_TRANSITION);
    assert.deepEqual(corrected, ['transition']);
  });

  test('a screen that never mentions it gets the default, and nothing is reported', () => {
    const corrected: string[] = [];
    assert.equal(sanitiseTransition(undefined, corrected), 'balanced');
    assert.deepEqual(corrected, []);
  });
});

test('mix is a bare linear blend', () => {
  assert.equal(mix(2, 4, 0.5), 3);
  assert.equal(mix(2, 4, 0), 2);
});
