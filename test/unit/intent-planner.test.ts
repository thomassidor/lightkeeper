import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planIntent } from '../../lib/outputs/intent-planner';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { toPerceptual, toDevice, applyPerceptualDelta } from '../../lib/outputs/light-intent';

const DIM = { min: 0, max: 1, decimals: 2 };
const TEMP = { min: 0, max: 1, decimals: 2 };

function cacheWith(targets: Array<{
  id: string; on?: boolean; dim?: number; temp?: number;
  supportsDim?: boolean; supportsTemp?: boolean;
}>) {
  const cache = new TargetStateCache();
  for (const t of targets) {
    cache.setCapabilities(t.id, {
      onoff: true,
      ...(t.supportsDim === false ? {} : { dim: DIM }),
      ...(t.supportsTemp === false ? {} : { light_temperature: TEMP }),
    });
    cache.initialise(t.id, { onoff: t.on, dim: t.dim, light_temperature: t.temp });
  }
  return cache;
}

const dimWrites = (
  writes: { deviceId: string; capability: string; value: unknown }[],
): Record<string, number> => Object.fromEntries(
  writes.filter(w => w.capability === 'dim').map(w => [w.deviceId, Number(w.value)]),
);

describe('group toggle', () => {
  test('any on → all off', () => {
    const cache = cacheWith([
      { id: 'a', on: true }, { id: 'b', on: false }, { id: 'c', on: false },
    ]);
    const { writes } = planIntent({ type: 'toggle' }, ['a', 'b', 'c'], cache, DEFAULT_BEHAVIOR);

    assert.equal(writes.length, 3);
    assert.ok(writes.every(w => w.capability === 'onoff' && w.value === false));
  });

  test('none on → all on', () => {
    const cache = cacheWith([{ id: 'a', on: false }, { id: 'b', on: false }]);
    const { writes } = planIntent({ type: 'toggle' }, ['a', 'b'], cache, DEFAULT_BEHAVIOR);

    assert.ok(writes.every(w => w.value === true));
  });

  test('is a group action, not independent inversion', () => {
    const cache = cacheWith([{ id: 'a', on: true }, { id: 'b', on: false }]);
    const { writes } = planIntent({ type: 'toggle' }, ['a', 'b'], cache, DEFAULT_BEHAVIOR);

    // Independent inversion would give a=false, b=true. The spec wants both off.
    assert.deepEqual(writes.map(w => w.value), [false, false]);
  });
});

describe('relative group brightness', () => {
  test('preserves inter-light differences', () => {
    // The spec's own worked example: 70/50/30 plus a step stays ordered and spaced.
    const cache = cacheWith([
      { id: 'ceiling', on: true, dim: 0.7 },
      { id: 'pendants', on: true, dim: 0.5 },
      { id: 'wall', on: true, dim: 0.3 },
    ]);
    const { writes } = planIntent(
      { type: 'brightness_delta', delta: 0.05 },
      ['ceiling', 'pendants', 'wall'], cache, DEFAULT_BEHAVIOR,
    );
    const result = dimWrites(writes);

    assert.ok(result.ceiling > 0.7);
    assert.ok(result.pendants > 0.5);
    assert.ok(result.wall > 0.3);
    assert.ok(result.ceiling > result.pendants && result.pendants > result.wall,
      'ordering must be preserved');
  });

  test('applies the delta on the perceptual axis, not linearly', () => {
    const cache = cacheWith([{ id: 'a', on: true, dim: 0.25 }]);
    const { writes } = planIntent(
      { type: 'brightness_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );
    const expected = Number(applyPerceptualDelta(0.25, 0.1).toFixed(2));

    assert.equal(dimWrites(writes).a, expected);
    assert.notEqual(dimWrites(writes).a, 0.35, 'must not be a linear +0.1');
  });

  test('synchronised mode collapses targets to one level — advanced only', () => {
    const cache = cacheWith([
      { id: 'a', on: true, dim: 0.8 }, { id: 'b', on: true, dim: 0.2 },
    ]);
    const { writes } = planIntent(
      { type: 'brightness_delta', delta: 0.05 }, ['a', 'b'], cache,
      { ...DEFAULT_BEHAVIOR, groupBrightnessMode: 'synchronised' },
    );
    const result = dimWrites(writes);

    assert.equal(result.a, result.b, 'synchronised mode sets one absolute value');
  });

  test('relative is the default, so composition survives', () => {
    assert.equal(DEFAULT_BEHAVIOR.groupBrightnessMode, 'relative');
  });
});

describe('partial capability', () => {
  test('executes on the compatible subset and discloses the rest', () => {
    const cache = cacheWith([
      { id: 'a', on: true, dim: 0.5 },
      { id: 'b', on: true, supportsDim: false },
    ]);
    const { writes, skipped } = planIntent(
      { type: 'brightness_delta', delta: 0.1 }, ['a', 'b'], cache, DEFAULT_BEHAVIOR,
    );

    assert.deepEqual(writes.map(w => w.deviceId), ['a']);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.reason, /does not support dim/);
  });

  test('a wholly unsupported intent yields no writes rather than an error', () => {
    const cache = cacheWith([{ id: 'a', on: true, supportsTemp: false }]);
    const { writes, skipped } = planIntent(
      { type: 'temperature_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.equal(writes.length, 0);
    assert.equal(skipped.length, 1);
  });
});

describe('while-off policy', () => {
  test('increase while off turns on and applies, in ONE write (the default)', () => {
    const cache = cacheWith([{ id: 'a', on: false, dim: 0.3 }]);
    const { writes } = planIntent(
      { type: 'brightness_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    // A dim write turns a Hue lamp on by itself (measured), so a separate
    // onoff write would just add ~270 ms before the light responds. The
    // adapter verifies afterwards and only writes onoff if the lamp stayed off.
    assert.deepEqual(writes.map(w => w.capability), ['dim']);
    assert.equal(writes[0]!.impliesOn, true, 'the dim write must be marked as carrying the on');
  });

  test('decrease while off updates desired level without turning on', () => {
    const cache = cacheWith([{ id: 'a', on: false, dim: 0.5 }]);
    const { writes, skipped } = planIntent(
      { type: 'brightness_delta', delta: -0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.equal(writes.length, 0, 'must not write, or the light would come on');
    assert.equal(skipped.length, 1);
    assert.ok(cache.currentDim('a')! < 0.5, 'desired level should still have moved');
  });

  test('temperature never implicitly turns a light on', () => {
    const cache = cacheWith([{ id: 'a', on: false, temp: 0.5 }]);
    const { writes } = planIntent(
      { type: 'temperature_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.equal(writes.some(w => w.capability === 'onoff'), false);
  });

  test('falling below minimum turns off rather than clamping, when configured', () => {
    const cache = cacheWith([{ id: 'a', on: true, dim: 0.02 }]);
    const { writes } = planIntent(
      { type: 'brightness_delta', delta: -0.5 }, ['a'], cache,
      { ...DEFAULT_BEHAVIOR, offBelowMinimum: true, minimumBrightness: 0.05 },
    );

    assert.deepEqual(writes, [{ deviceId: 'a', capability: 'onoff', value: false }]);
  });
});

describe('clamping to each device\'s own range', () => {
  test('respects a target\'s own dim range rather than assuming 0–1', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0.1, max: 0.9, decimals: 2 } });
    cache.initialise('a', { onoff: true, dim: 0.85 });

    const { writes } = planIntent(
      { type: 'brightness_delta', delta: 0.9 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.equal(dimWrites(writes).a, 0.9);
  });

  test('quantises to the capability decimals so slow dials still move', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    const { writes } = planIntent(
      { type: 'brightness_delta', delta: 0.031 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );
    const value = dimWrites(writes).a as number;

    assert.equal(value, Number(value.toFixed(2)));
  });
});

describe('perceptual curve', () => {
  test('round-trips', () => {
    for (const v of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      assert.ok(Math.abs(toDevice(toPerceptual(v)) - v) < 1e-9);
    }
  });

  test('a fixed perceptual step moves the low end less in device terms', () => {
    const lowStep = applyPerceptualDelta(0.05, 0.1) - 0.05;
    const highStep = applyPerceptualDelta(0.8, 0.1) - 0.8;

    assert.ok(lowStep < highStep,
      'linear stepping feels violent at the bottom; the curve must compress it');
  });

  test('clamps at both ends', () => {
    assert.equal(applyPerceptualDelta(1, 0.5), 1);
    assert.equal(applyPerceptualDelta(0, -0.5), 0);
  });
});
