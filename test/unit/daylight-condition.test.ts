import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isDarkEnough, levelOf } from '../../lib/flow/darkness-condition';
import { VALUE_CAPABILITIES, type PublishedValues } from '../../lib/runtime/published-values';

/**
 * "It is dark enough" — the condition card on a Room-sensing Light.
 *
 * The one thing worth a file of its own is the answer it gives when it does not
 * know. A Room-sensing Light with no usable sensor and no location for the sun
 * publishes no level at all, deliberately: 0 is a real reading on that axis and
 * means pitch dark, so a flat sensor battery must not read as night. This card
 * is almost always guarding "switch these lights on", and the two ways to be
 * wrong are a room that stays dark and a room that lights itself in daylight,
 * repeatedly, with nothing on screen explaining why. False is the same answer
 * the device itself gives in that state.
 */

const values = (level: unknown): PublishedValues =>
  ({ [VALUE_CAPABILITIES.daylight]: level } as PublishedValues);

describe('reading the level', () => {
  test('a published number is the level', () => {
    assert.equal(levelOf(values(0.42)), 0.42);
    assert.equal(levelOf(values(0)), 0);
  });

  test('anything else is no reading at all', () => {
    assert.equal(levelOf(values(null)), null);
    assert.equal(levelOf({} as PublishedValues), null);
    assert.equal(levelOf(values('0.4')), null);
    assert.equal(levelOf(values(Number.NaN)), null);
  });
});

describe('the condition', () => {
  test('true while the daylight is at or below the threshold', () => {
    assert.equal(isDarkEnough(values(0.10), 0.25), true);
    assert.equal(isDarkEnough(values(0.25), 0.25), true);
    assert.equal(isDarkEnough(values(0.26), 0.25), false);
  });

  test('both ends of the slider mean what they say', () => {
    // 0% asks for pitch dark; 100% is true whenever it can read anything.
    assert.equal(isDarkEnough(values(0), 0), true);
    assert.equal(isDarkEnough(values(0.01), 0), false);
    assert.equal(isDarkEnough(values(1), 1), true);
  });

  test('false when the device cannot tell how light it is', () => {
    assert.equal(isDarkEnough(values(null), 0.25), false);
    // And at a threshold of 100%, where every real reading would pass.
    assert.equal(isDarkEnough(values(null), 1), false);
  });

  test('false on a threshold that is not a number', () => {
    for (const junk of [undefined, null, 'dark', Number.NaN, {}]) {
      assert.equal(isDarkEnough(values(0), junk), false, `${JSON.stringify(junk)}`);
    }
  });
});
