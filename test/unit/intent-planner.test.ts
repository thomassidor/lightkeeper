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
    assert.match(skipped[0].reason, /does not support dim/);
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
    assert.equal(writes[0].impliesOn, true, 'the dim write must be marked as carrying the on');
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
    const value = dimWrites(writes).a;

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

describe('a relative step always moves the lamp', () => {
  /**
   * The perceptual curve is steepest at the bottom, and quantisation happens in
   * DEVICE values: at dim 0.00 a ramp's 0.06 perceptual tick is 0.06^2.2 ≈ 0.002
   * in device terms, which `quantise(…, 2)` rounds back to 0.00. So every tick
   * of a ten-second hold recomputed from 0.00 and wrote 0.00 again — a
   * brightness ramp could not lift a lamp off the floor at all.
   *
   * Reachable through the app's own defaults, which is what makes it worth
   * fixing: `decreaseWhileOff: 'update_desired_only'` walks the desired level
   * down to 0.00 with no `minimumBrightness` floor, because there is no write
   * for a floor to apply to.
   */
  test('brightening from the floor writes something the lamp can show', () => {
    const cache = cacheWith([{ id: 'l1', on: true, dim: 0 }]);
    const plan = planIntent({ type: 'brightness_delta', delta: 0.06 }, ['l1'], cache, DEFAULT_BEHAVIOR);

    assert.equal(dimWrites(plan.writes).l1, 0.01, 'one representable step, not zero');
  });

  test('and it keeps climbing rather than sticking', () => {
    const cache = cacheWith([{ id: 'l1', on: true, dim: 0 }]);
    let level = 0;
    for (let tick = 0; tick < 4; tick += 1) {
      const plan = planIntent({ type: 'brightness_delta', delta: 0.06 }, ['l1'], cache, DEFAULT_BEHAVIOR);
      const next = dimWrites(plan.writes).l1!;
      assert.ok(next > level, `tick ${tick}: ${next} did not move past ${level}`);
      level = next;
      cache.commitDesired('l1', 'dim', next);
    }
  });

  test('dimming from the top moves too', () => {
    const cache = cacheWith([{ id: 'l1', on: true, dim: 1 }]);
    const plan = planIntent({ type: 'brightness_delta', delta: -0.001 }, ['l1'], cache, DEFAULT_BEHAVIOR);

    assert.ok(dimWrites(plan.writes).l1! < 1);
  });

  test('a step at the end of the range still does nothing, which is correct', () => {
    const cache = cacheWith([{ id: 'l1', on: true, dim: 1 }]);
    const plan = planIntent({ type: 'brightness_delta', delta: 0.5 }, ['l1'], cache, DEFAULT_BEHAVIOR);

    assert.equal(dimWrites(plan.writes).l1, 1, 'clampToRange has the last word');
  });

  test('an ordinary mid-range step is unchanged by the guarantee', () => {
    const cache = cacheWith([{ id: 'l1', on: true, dim: 0.5 }]);
    const plan = planIntent({ type: 'brightness_delta', delta: 0.1 }, ['l1'], cache, DEFAULT_BEHAVIOR);

    // Whatever the curve says, not one step past it.
    const expected = Math.round(applyPerceptualDelta(0.5, 0.1) * 100) / 100;
    assert.equal(dimWrites(plan.writes).l1, expected);
  });
});

describe('a temperature write switches the lamp into temperature mode first', () => {
  /**
   * Found on hardware, and invisible until one device wrote both.
   *
   * A lamp in COLOUR mode ignores a temperature exactly as a lamp in
   * temperature mode ignores a hue — silently, reporting the write as accepted
   * and keeping its old value. Only `planColor` set `light_mode`, so a Curve
   * light with a coloured point put a lamp into colour mode and then had every
   * later temperature-only point thrown away by the lamp. The observed symptom:
   * a lamp written 0.43 sat at 0.87 and would not take a temperature from
   * anything, this app or otherwise, until its mode changed back.
   */
  const colourCapable = (id: string, on = true) => {
    const cache = new TargetStateCache();
    cache.setCapabilities(id, {
      onoff: true,
      dim: DIM,
      light_temperature: TEMP,
      light_mode: true,
      light_hue: { min: 0, max: 1, decimals: 2 },
      light_saturation: { min: 0, max: 1, decimals: 2 },
    });
    cache.initialise(id, { onoff: on, light_temperature: 0.5 });
    return cache;
  };

  test('an absolute temperature sets light_mode before the temperature', () => {
    const cache = colourCapable('a');
    const { writes } = planIntent(
      { type: 'temperature_absolute', value: 0.2 }, ['a'], cache, DEFAULT_BEHAVIOR);

    const order = writes.map(w => w.capability);
    assert.deepEqual(order, ['light_mode', 'light_temperature'],
      'the mode has to be set first, or the lamp discards the temperature');
    assert.equal(writes[0]!.value, 'temperature');
    assert.equal(writes[1]!.value, 0.2);
  });

  test('a relative temperature does the same', () => {
    // "Warmer" on a remote reaches the same lamp through a different path.
    const cache = colourCapable('a');
    const { writes } = planIntent(
      { type: 'temperature_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR);

    assert.deepEqual(writes.map(w => w.capability), ['light_mode', 'light_temperature']);
    assert.equal(writes[0]!.value, 'temperature');
  });

  test('a lamp without light_mode is not sent one', () => {
    // It has one mode, cannot be in the wrong one, and would be handed a
    // capability it does not have.
    const cache = cacheWith([{ id: 'a', on: true, temp: 0.5 }]);
    const { writes } = planIntent(
      { type: 'temperature_absolute', value: 0.2 }, ['a'], cache, DEFAULT_BEHAVIOR);

    assert.deepEqual(writes.map(w => w.capability), ['light_temperature']);
  });

  test('and a colour still sets colour mode, unchanged', () => {
    // The half that always worked. Asserted here so a future edit cannot fix
    // one direction by breaking the other.
    const cache = colourCapable('a');
    const { writes } = planIntent(
      { type: 'color_absolute', hue: 0.11, saturation: 0.75 }, ['a'], cache, DEFAULT_BEHAVIOR);

    assert.deepEqual(writes.map(w => w.capability),
      ['light_mode', 'light_hue', 'light_saturation']);
    assert.equal(writes[0]!.value, 'color');
  });

  test('every lamp in a group gets its own mode write', () => {
    const cache = colourCapable('a');
    cache.setCapabilities('b', {
      onoff: true, light_temperature: TEMP, light_mode: true,
    });
    cache.initialise('b', { onoff: true, light_temperature: 0.5 });

    const { writes } = planIntent(
      { type: 'temperature_absolute', value: 0.2 }, ['a', 'b'], cache, DEFAULT_BEHAVIOR);

    for (const id of ['a', 'b']) {
      const mine = writes.filter(w => w.deviceId === id);
      assert.deepEqual(mine.map(w => w.capability), ['light_mode', 'light_temperature'],
        `${id} was not switched into temperature mode`);
    }
  });
});
