import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseMagnitude, NOTCHES_PER_TURN } from '../../lib/runtime/controller-runtime-manager';
import { magnitudePerTurnOf, normalizeCards } from '../../lib/inputs/event-normalizer';
import { TAP_DIAL_CARDS, TAP_DIAL_DEVICE_ID } from '../fixtures/reference-devices';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { MappingEngine } from '../../lib/mapping/mapping-engine';
import type { InputEvent } from '../../lib/inputs/input-event';

describe('dial magnitude scaling (§5.4)', () => {
  test('reads units-per-turn from the token title', () => {
    assert.equal(magnitudePerTurnOf({ title: 'Steps (1000/turn)' }), 1000);
    assert.equal(magnitudePerTurnOf({ title: { en: 'Steps (1000/turn)' } }), 1000);
    assert.equal(magnitudePerTurnOf({ title: 'Steps (360 per turn)' }), 360);
  });

  test('leaves plain counts alone', () => {
    assert.equal(magnitudePerTurnOf({ title: 'Number of clicks' }), undefined);
    assert.equal(magnitudePerTurnOf(undefined), undefined);
    assert.equal(normaliseMagnitude(3, undefined), 3, 'a detent count is already in step units');
  });

  test('a full turn is worth a full sweep, not 1000 steps', () => {
    assert.equal(normaliseMagnitude(1000, 1000), NOTCHES_PER_TURN);
  });

  test('the real observed value produces a sane delta, not a slam to full', () => {
    // 151 steps is what the Hue Tap Dial reported for a small nudge.
    const notches = normaliseMagnitude(151, 1000)!;
    const delta = DEFAULT_BEHAVIOR.brightnessStep * notches;

    assert.ok(delta > 0.1 && delta < 0.25,
      `a nudge should move brightness a little, got ${delta}`);
  });

  test('unscaled, the same value would be nonsense', () => {
    const delta = DEFAULT_BEHAVIOR.brightnessStep * 151;
    assert.ok(delta > 1, 'confirms why scaling is required: 15.1 is far beyond full range');
  });

  test('sign is discarded — direction comes from the binding, not the value', () => {
    assert.equal(normaliseMagnitude(-500, 1000), NOTCHES_PER_TURN / 2);
  });
});

describe('Tap Dial end to end', () => {
  const { inputs } = normalizeCards(TAP_DIAL_CARDS, { sourceDeviceId: TAP_DIAL_DEVICE_ID });
  const right = inputs.find(i => i.label === 'Dial — Turn right')!;

  test('the dial entry carries the per-turn scale', () => {
    assert.equal(right.magnitudePerTurn, 1000);
  });

  test('a nudge brightens by a sensible amount', () => {
    const engine = new MappingEngine(
      [{ id: 'r', function: 'brightness_up', inputKey: right.key, target: null }],
      DEFAULT_BEHAVIOR,
    );
    const event: InputEvent = {
      sourceDeviceId: TAP_DIAL_DEVICE_ID,
      controlId: right.controlId,
      controlLabel: right.label,
      action: right.action,
      magnitude: normaliseMagnitude(151, right.magnitudePerTurn),
      provenance: 'flow_token',
      timestamp: 0,
    };

    const intent = engine.resolve({ inputKey: right.key, event })!.intent as { delta: number };
    assert.ok(intent.delta > 0.1 && intent.delta < 0.25, `got ${intent.delta}`);
  });
});
