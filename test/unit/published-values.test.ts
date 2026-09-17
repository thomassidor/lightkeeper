import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ValueBoard,
  VALUE_CAPABILITIES,
  ALL_VALUE_CAPABILITIES,
  PUBLISHED_DECIMALS,
  isTranslatable,
  type PublishedValues,
} from '../../lib/runtime/published-values';

/**
 * The gate between an engine that recomputes every minute and a capability a
 * user reads.
 *
 * Worth its own file because the cost of getting it wrong is invisible in
 * development and obvious in a house: the curve moves about 0.003 a minute, so
 * an ungated board writes sixty indistinguishable points an hour into somebody's
 * Insights, wakes the device layer sixty times to do it, and fires a Flow
 * trigger every one of those times. The gate is the capability's own declared
 * resolution, which is the same argument the curve's own write gate rests on
 * (platform §12) — below it, nothing anywhere can tell the two values apart.
 */

function recorder() {
  const seen: PublishedValues[] = [];
  return { seen, take: (values: PublishedValues) => { seen.push(values); } };
}

describe('the value board', () => {
  test('a move smaller than the capability can hold is not published', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);

    board.set({ [VALUE_CAPABILITIES.temperature]: 0.780 });
    board.set({ [VALUE_CAPABILITIES.temperature]: 0.7823 });
    board.set({ [VALUE_CAPABILITIES.temperature]: 0.7771 });

    assert.equal(log.seen.length, 1);
    assert.deepEqual(log.seen[0], { [VALUE_CAPABILITIES.temperature]: 0.78 });
  });

  test('and one the capability can hold is', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);

    board.set({ [VALUE_CAPABILITIES.temperature]: 0.78 });
    board.set({ [VALUE_CAPABILITIES.temperature]: 0.79 });

    assert.equal(log.seen.length, 2);
    assert.deepEqual(log.seen[1], { [VALUE_CAPABILITIES.temperature]: 0.79 });
  });

  test('only the fields that moved are published', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);

    board.set({
      [VALUE_CAPABILITIES.brightness]: 0.26,
      [VALUE_CAPABILITIES.temperature]: 0.78,
    });
    board.set({
      [VALUE_CAPABILITIES.brightness]: 0.26,
      [VALUE_CAPABILITIES.temperature]: 0.84,
    });

    assert.deepEqual(log.seen[1], { [VALUE_CAPABILITIES.temperature]: 0.84 });
  });

  test('watching replays what is already known', () => {
    const board = new ValueBoard();
    // A schedule publishes its running window from start(), which is before the
    // device layer has been handed the runtime back to watch it.
    board.set({ [VALUE_CAPABILITIES.brightness]: 0.26 });

    const log = recorder();
    board.watch(log.take);

    assert.deepEqual(log.seen, [{ [VALUE_CAPABILITIES.brightness]: 0.26 }]);
  });

  test('watching an empty board replays nothing', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);
    assert.deepEqual(log.seen, []);
  });

  /**
   * `Number(null)` is 0 and 0 is a real reading on every axis here — pitch dark,
   * the coolest white — so a value that is not a number must not arrive as one.
   * The same trap `lib/daylight/` guards on the way in.
   */
  test('a value that is not a number becomes absent, never zero', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);

    board.set({ [VALUE_CAPABILITIES.daylight]: Number.NaN });
    assert.deepEqual(log.seen[0], { [VALUE_CAPABILITIES.daylight]: null });

    board.set({ [VALUE_CAPABILITIES.daylight]: Number.POSITIVE_INFINITY });
    assert.equal(log.seen.length, 1);
  });

  test('absent and zero are different values', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);

    board.set({ [VALUE_CAPABILITIES.daylight]: 0 });
    board.set({ [VALUE_CAPABILITIES.daylight]: null });

    assert.equal(log.seen.length, 2);
    assert.deepEqual(log.seen[1], { [VALUE_CAPABILITIES.daylight]: null });
  });

  /**
   * The curve builds a fresh `{ keys: [...] }` on every tick, so identity would
   * report a change sixty times an hour for a colour that has not moved — which
   * is the exact noise this class exists to stop.
   */
  test('a colour rebuilt identically is not a change', () => {
    const board = new ValueBoard();
    const log = recorder();
    board.watch(log.take);

    board.set({ [VALUE_CAPABILITIES.colour]: { keys: ['palette.amber'] } });
    board.set({ [VALUE_CAPABILITIES.colour]: { keys: ['palette.amber'] } });
    assert.equal(log.seen.length, 1);

    board.set({ [VALUE_CAPABILITIES.colour]: { keys: ['palette.amber', 'palette.rose'] } });
    assert.equal(log.seen.length, 2);

    board.set({ [VALUE_CAPABILITIES.colour]: null });
    assert.equal(log.seen.length, 3);
  });

  test('current is everything published, not just the last change', () => {
    const board = new ValueBoard();
    board.set({ [VALUE_CAPABILITIES.brightness]: 0.26, [VALUE_CAPABILITIES.temperature]: 0.78 });
    board.set({ [VALUE_CAPABILITIES.temperature]: 0.84 });

    assert.deepEqual(board.current, {
      [VALUE_CAPABILITIES.brightness]: 0.26,
      [VALUE_CAPABILITIES.temperature]: 0.84,
    });
  });

  test('a board nobody watches still remembers, and does not throw', () => {
    const board = new ValueBoard();
    board.set({ [VALUE_CAPABILITIES.brightness]: 0.26 });
    assert.deepEqual(board.current, { [VALUE_CAPABILITIES.brightness]: 0.26 });
  });
});

describe('what the board publishes into', () => {
  test('the gate rounds to what the capabilities declare', () => {
    // If a capability ever declares a different `decimals`, this constant and
    // that manifest have to move together — the gate is only honest while the
    // number it rounds to is the number Homey stores.
    assert.equal(PUBLISHED_DECIMALS, 2);
  });

  test('every named capability is in the list the device layer sweeps', () => {
    assert.deepEqual(
      [...ALL_VALUE_CAPABILITIES].sort(),
      Object.values(VALUE_CAPABILITIES).slice().sort(),
    );
  });

  test('isTranslatable tells a key list from every other value', () => {
    assert.equal(isTranslatable({ keys: ['palette.amber'] }), true);
    assert.equal(isTranslatable({ keys: [] }), true);
    assert.equal(isTranslatable('palette.amber'), false);
    assert.equal(isTranslatable(null), false);
    assert.equal(isTranslatable(0.26), false);
    assert.equal(isTranslatable(true), false);
  });
});
