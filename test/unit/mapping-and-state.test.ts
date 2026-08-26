import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MappingEngine, availableFunctions } from '../../lib/mapping/mapping-engine';
import { intentForFunction } from '../../lib/runtime/controller-runtime';
import { DEFAULT_BEHAVIOR, type MappingRule } from '../../lib/mapping/mapping-types';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { migrateProfile } from '../../lib/profiles/migrations';
import {
  CURRENT_SCHEMA_VERSION, conflictingRule, dedupeByInputKey,
  type ControllerProfile,
} from '../../lib/profiles/controller-profile';
import type { InputEvent } from '../../lib/inputs/input-event';

const rule = (over: Partial<MappingRule>): MappingRule => ({
  id: 'r1', function: 'toggle', inputKey: 'k1', target: null, ...over,
});

const event = (over: Partial<InputEvent> = {}): InputEvent => ({
  controlId: 'c', action: 'press', ...over,
});

describe('mapping engine', () => {
  test('resolves a mapped input to its intent', () => {
    const engine = new MappingEngine([rule({})], DEFAULT_BEHAVIOR);
    const resolved = engine.resolve({ inputKey: 'k1', event: event() });

    assert.deepEqual(resolved?.intent, { type: 'toggle' });
  });

  test('unmapped input resolves to null rather than a guess', () => {
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

  test('warmer RAISES the normalised temperature, colder lowers it', () => {
    // Higher is warmer on Homey's axis — homey-lib's own capability hint says so,
    // and this test used to assert the opposite, which is why "Warmest" lit a
    // room cold white on the first live run. See CLAUDE.md §6.
    const engine = new MappingEngine([
      rule({ id: 'w', function: 'warmer', inputKey: 'w' }),
      rule({ id: 'c', function: 'colder', inputKey: 'c' }),
    ], DEFAULT_BEHAVIOR);

    assert.ok((engine.resolve({ inputKey: 'w', event: event() })!.intent as { delta: number }).delta > 0);
    assert.ok((engine.resolve({ inputKey: 'c', event: event() })!.intent as { delta: number }).delta < 0);
  });

  test('the Test control agrees with the engine about which way is warmer', () => {
    // Two entry points produce temperature intents: the engine, for a mapped
    // gesture, and intentForFunction, for the Test button and the schedule path.
    // Them disagreeing is the exact shape of the bug that shipped, so they are
    // now checked against each other rather than separately.
    const engine = new MappingEngine([rule({ id: 'w', function: 'warmer', inputKey: 'w' })], DEFAULT_BEHAVIOR);
    const mapped = engine.resolve({ inputKey: 'w', event: event() })!.intent as { delta: number };
    const direct = intentForFunction('warmer', DEFAULT_BEHAVIOR) as { delta: number };

    assert.ok(mapped.delta > 0, 'warmer must raise the normalised temperature');
    assert.equal(Math.sign(direct.delta), Math.sign(mapped.delta));
    assert.equal(
      Math.sign((intentForFunction('colder', DEFAULT_BEHAVIOR) as { delta: number }).delta), -1,
    );
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
});

describe('available functions', () => {
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

describe('target state cache', () => {
  test('duplicate echoes are not treated as external changes', () => {
    const now = 1000;
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

describe('migrations', () => {
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

/**
 * One rule per gesture.
 *
 * The mapping screen is keyed on (light group, function), so nothing there
 * stopped a gesture being assigned twice — and resolve() above takes the FIRST
 * match, so the second assignment silently did nothing. A row that looks
 * configured and has no effect is the failure this app exists to prevent, so
 * duplicates are collapsed on the way in and the displaced rule is reported.
 */
describe('one rule per gesture', () => {
  test('a duplicated gesture collapses to the first assignment', () => {
    const { rules, displaced } = dedupeByInputKey([
      rule({ id: 'a', function: 'toggle', inputKey: 'k1' }),
      rule({ id: 'b', function: 'on', inputKey: 'k1' }),
    ]);

    assert.equal(rules.length, 1);
    assert.equal(rules[0].id, 'a', 'first wins, matching the engine');
    assert.equal(displaced.length, 1);
    assert.equal(displaced[0].id, 'b');
  });

  test('the same gesture aimed at two different lights is still one rule', () => {
    // Legitimate-looking and still broken: only the first target would ever move.
    const { rules, displaced } = dedupeByInputKey([
      rule({ id: 'a', inputKey: 'k1', target: { kind: 'devices', deviceIds: ['light-1'] } }),
      rule({ id: 'b', inputKey: 'k1', target: { kind: 'devices', deviceIds: ['light-2'] } }),
    ]);

    assert.deepEqual(rules.map(r => r.id), ['a']);
    assert.deepEqual(displaced.map(r => r.id), ['b']);
  });

  test('distinct gestures are all kept, in order', () => {
    const { rules, displaced } = dedupeByInputKey([
      rule({ id: 'a', inputKey: 'k1' }),
      rule({ id: 'b', inputKey: 'k2' }),
      rule({ id: 'c', inputKey: 'k3' }),
    ]);

    assert.deepEqual(rules.map(r => r.id), ['a', 'b', 'c']);
    assert.deepEqual(displaced, []);
  });

  test('unassigned rows never collide with each other', () => {
    const { rules, displaced } = dedupeByInputKey([
      rule({ id: 'a', inputKey: null }),
      rule({ id: 'b', inputKey: null }),
    ]);

    assert.equal(rules.length, 2, 'two empty dropdowns are not a conflict');
    assert.deepEqual(displaced, []);
  });

  test('every surviving rule resolves — no silent dead assignment', () => {
    const { rules } = dedupeByInputKey([
      rule({ id: 'a', function: 'toggle', inputKey: 'k1' }),
      rule({ id: 'b', function: 'on', inputKey: 'k1' }),
    ]);
    const engine = new MappingEngine(rules, DEFAULT_BEHAVIOR);

    for (const surviving of rules) {
      const resolved = engine.resolve({ inputKey: surviving.inputKey!, event: event() });
      assert.equal(resolved?.rule.id, surviving.id, 'a kept rule that cannot fire is the bug');
    }
  });

  test('conflictingRule names what an assignment would displace', () => {
    const profile = {
      mappings: [
        rule({ id: 'a', function: 'toggle', inputKey: 'k1' }),
        rule({ id: 'b', function: 'on', inputKey: 'k2' }),
      ],
    } as ControllerProfile;

    assert.equal(conflictingRule(profile, 'k1', 'b')?.id, 'a');
    assert.equal(conflictingRule(profile, 'k1', 'a'), undefined, 'a rule cannot conflict with itself');
    assert.equal(conflictingRule(profile, 'k3', 'a'), undefined);
  });
});
