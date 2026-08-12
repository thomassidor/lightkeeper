import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MappingEngine, availableFunctions } from '../../lib/mapping/mapping-engine';
import { DEFAULT_BEHAVIOR, type MappingRule } from '../../lib/mapping/mapping-types';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { migrateProfile } from '../../lib/profiles/migrations';
import { CURRENT_SCHEMA_VERSION } from '../../lib/profiles/controller-profile';
import type { InputEvent } from '../../lib/inputs/input-event';

const rule = (over: Partial<MappingRule>): MappingRule => ({
  id: 'r1', function: 'toggle', inputKey: 'k1', target: null, ...over,
});

const event = (over: Partial<InputEvent> = {}): InputEvent => ({
  sourceDeviceId: 'src', controlId: 'c', controlLabel: 'C',
  action: 'press', provenance: 'flow_fixed', timestamp: 0, ...over,
});

describe('mapping engine', () => {
  test('resolves a mapped input to its intent', () => {
    const engine = new MappingEngine([rule({})], DEFAULT_BEHAVIOR);
    const resolved = engine.resolve({ inputKey: 'k1', event: event() });

    assert.deepEqual(resolved?.intent, { type: 'toggle' });
  });

  test('unmapped input resolves to null rather than a guess (§12)', () => {
    const engine = new MappingEngine([rule({})], DEFAULT_BEHAVIOR);
    assert.equal(engine.resolve({ inputKey: 'unknown', event: event() }), null);
  });

  test('an unassigned rule matches nothing', () => {
    const engine = new MappingEngine([rule({ inputKey: null })], DEFAULT_BEHAVIOR);
    assert.equal(engine.resolve({ inputKey: 'k1', event: event() }), null);
  });

  test('brightness up and down are signed opposites', () => {
    const engine = new MappingEngine([
      rule({ id: 'up', function: 'brightness_up', inputKey: 'u' }),
      rule({ id: 'dn', function: 'brightness_down', inputKey: 'd' }),
    ], DEFAULT_BEHAVIOR);

    const up = engine.resolve({ inputKey: 'u', event: event() })!.intent;
    const down = engine.resolve({ inputKey: 'd', event: event() })!.intent;

    assert.deepEqual(up, { type: 'brightness_delta', delta: 0.1 });
    assert.deepEqual(down, { type: 'brightness_delta', delta: -0.1 });
  });

  test('warmer lowers the normalised temperature, colder raises it', () => {
    const engine = new MappingEngine([
      rule({ id: 'w', function: 'warmer', inputKey: 'w' }),
      rule({ id: 'c', function: 'colder', inputKey: 'c' }),
    ], DEFAULT_BEHAVIOR);

    assert.ok((engine.resolve({ inputKey: 'w', event: event() })!.intent as { delta: number }).delta < 0);
    assert.ok((engine.resolve({ inputKey: 'c', event: event() })!.intent as { delta: number }).delta > 0);
  });

  test('magnitude scales the step but is never a user-facing choice', () => {
    const engine = new MappingEngine(
      [rule({ function: 'brightness_up', inputKey: 'k1' })], DEFAULT_BEHAVIOR,
    );
    const three = engine.resolve({ inputKey: 'k1', event: event({ magnitude: 3 }) })!.intent;

    assert.deepEqual(three, { type: 'brightness_delta', delta: 0.30000000000000004 });
  });

  test('a zero magnitude still moves one notch rather than doing nothing', () => {
    const engine = new MappingEngine(
      [rule({ function: 'brightness_up', inputKey: 'k1' })], DEFAULT_BEHAVIOR,
    );
    const zero = engine.resolve({ inputKey: 'k1', event: event({ magnitude: 0 }) })!.intent;

    assert.deepEqual(zero, { type: 'brightness_delta', delta: 0.1 });
  });

  test('per-row step and sensitivity override the defaults', () => {
    const engine = new MappingEngine([
      rule({ function: 'brightness_up', inputKey: 'k1', options: { step: 0.2, sensitivity: 0.5 } }),
    ], DEFAULT_BEHAVIOR);

    assert.deepEqual(engine.resolve({ inputKey: 'k1', event: event() })!.intent,
      { type: 'brightness_delta', delta: 0.1 });
  });
});

describe('available functions (§8.3, AC-03)', () => {
  test('offers only what the targets support', () => {
    assert.deepEqual(availableFunctions({ onoff: 3, dim: 0, light_temperature: 0 }),
      ['toggle', 'on', 'off']);
    assert.deepEqual(availableFunctions({ onoff: 3, dim: 3, light_temperature: 2 }),
      ['toggle', 'on', 'off', 'brightness_up', 'brightness_down', 'warmer', 'colder']);
  });

  test('partial support still offers the function — hiding makes the app look broken', () => {
    const functions = availableFunctions({ onoff: 3, dim: 3, light_temperature: 1 });
    assert.ok(functions.includes('warmer'), 'one of three supporting is enough to offer the row');
  });
});

describe('target state cache (§7.5)', () => {
  test('duplicate echoes are not treated as external changes', () => {
    let now = 1000;
    const cache = new TargetStateCache(() => now);
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    cache.noteWrite('a', 'dim', 0.42);
    const first = cache.applyExternalChange('a', 'dim', 0.42);
    const second = cache.applyExternalChange('a', 'dim', 0.42);

    assert.equal(first, false, 'the echo of our own write is not external');
    assert.equal(second, false, 'the duplicate echo observed on real hardware is not external');
  });

  test('a genuine external change updates desired state', () => {
    let now = 1000;
    const cache = new TargetStateCache(() => now);
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    now += 5000;
    const external = cache.applyExternalChange('a', 'dim', 0.9);

    assert.equal(external, true);
    assert.equal(cache.currentDim('a'), 0.9);
  });

  test('never read-modify-writes: desired wins over stale actual', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    cache.noteWrite('a', 'dim', 0.8);
    assert.equal(cache.currentDim('a'), 0.8, 'the in-flight desired value must be used');
  });

  test('tracks capability support per target', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1 } });

    assert.equal(cache.supports('a', 'dim'), true);
    assert.equal(cache.supports('a', 'light_temperature'), false);
    assert.equal(cache.supports('unknown', 'onoff'), false);
  });
});

describe('migrations (§9.1)', () => {
  test('a pre-versioning profile migrates without data loss', () => {
    const legacy = {
      enabled: true,
      source: { deviceId: 'src', eventSurfaceFingerprint: 'fp' },
      target: { kind: 'devices', deviceIds: ['a', 'b'] },
      mappings: [{ id: 'r1', function: 'toggle', inputKey: 'k1', target: null }],
    };

    const { profile, migrated, fromVersion } = migrateProfile(legacy);

    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(profile.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(profile.mappings, legacy.mappings, 'mappings must survive intact');
    assert.deepEqual(profile.target, legacy.target, 'targets must survive intact');
    assert.equal(profile.behavior.supersedeMs, 250, 'defaults are filled in');
  });

  test('a current profile is left alone', () => {
    const current = { schemaVersion: CURRENT_SCHEMA_VERSION, mappings: [] };
    const { migrated } = migrateProfile(current);

    assert.equal(migrated, false);
  });

  test('a future profile is refused rather than corrupted', () => {
    assert.throws(
      () => migrateProfile({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
      /newer than this app understands/,
    );
  });
});
