import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { planIntent } from '../../lib/outputs/intent-planner';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import {
  diffTargets, resolveSnapshot, releaseTarget,
} from '../../lib/outputs/target-snapshot';
import { TargetResolver } from '../../lib/outputs/target-resolver';
import type { DeviceCatalog } from '../../lib/device-catalog';

/**
 * Three promises about what the app will NOT do to somebody's lights.
 *
 * Each was written down and each was broken by code that ran on hardware:
 *
 *   the app never overrides an explicit user action    — verifyCameOn switched
 *                                                        a lamp back on 1.5 s
 *                                                        after the user had
 *                                                        switched it off
 *   a temperature change never turns a light on        — planTemperatureDelta
 *                                                        wrote colour to off
 *                                                        lamps, and on an
 *                                                        integration where
 *                                                        that lights them,
 *                                                        "warmer" lit the room
 *   a failed write is not remembered as a value        — the cache committed
 *                                                        desired state before
 *                                                        dispatch, so the next
 *                                                        relative step planned
 *                                                        from a level nothing
 *                                                        had ever shown
 */

function light(id: string, capabilities = ['onoff', 'dim', 'light_temperature'], over: Record<string, any> = {}) {
  const capabilitiesObj: Record<string, any> = {};
  if (capabilities.includes('onoff')) capabilitiesObj.onoff = { value: false };
  if (capabilities.includes('dim')) capabilitiesObj.dim = { min: 0, max: 1, decimals: 2, value: 0.5 };
  if (capabilities.includes('light_temperature')) {
    capabilitiesObj.light_temperature = { min: 0, max: 1, decimals: 2, value: 0.5 };
  }
  return {
    id, name: id, zoneId: 'z', zoneName: 'Kitchen',
    capabilities, capabilitiesObj, available: true, ...over,
  };
}

function primedCache(devices: ReturnType<typeof light>[]) {
  const cache = new TargetStateCache();
  const resolver = new TargetResolver({
    device: async (id: string) => devices.find(d => d.id === id),
    devicesInZone: async () => devices,
  } as unknown as DeviceCatalog);
  resolver.primeCache(devices as any, cache);
  return { cache, resolver };
}

describe('a temperature change never turns a light on', () => {

  test('an off target is skipped, with a reason', () => {
    const { cache } = primedCache([light('a'), light('b')]);
    cache.initialise('a', { onoff: false, light_temperature: 0.5 });
    cache.initialise('b', { onoff: true, light_temperature: 0.5 });

    const plan = planIntent(
      { type: 'temperature_delta', delta: 0.1 },
      ['a', 'b'],
      cache,
      DEFAULT_BEHAVIOR,
    );

    assert.deepEqual(
      plan.writes.map(w => w.deviceId), ['b'],
      'only the lamp that is already on',
    );
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0]!.deviceId, 'a');
    assert.match(plan.skipped[0]!.reason, /temperature never turns a light on/);
  });

  test('a lamp of unknown power state is still written to', () => {
    // `undefined` is "we have not heard yet", not "off". Refusing to write
    // there would make the first temperature press against a lamp we have not
    // heard from do nothing at all.
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, light_temperature: { min: 0, max: 1, decimals: 2 } });

    const plan = planIntent(
      { type: 'temperature_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.equal(plan.writes.length, 1);
  });

  test('an ABSOLUTE temperature is unaffected', () => {
    // Setting a scene's colour is a different intent from nudging one, and
    // this policy is deliberately only about the nudge.
    const { cache } = primedCache([light('a')]);
    cache.initialise('a', { onoff: false, light_temperature: 0.5 });

    const plan = planIntent(
      { type: 'temperature_absolute', value: 0.9 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.equal(plan.writes.length, 1, 'a schedule setting a colour still sets it');
  });
});

describe('a failed write is never remembered as a value', () => {

  test('the desired level is only adopted once the write has landed', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    const seq = cache.noteEcho('a', 'dim', 0.9);
    assert.equal(cache.currentDim('a'), 0.5, 'in flight is not landed');

    cache.commitDesired('a', 'dim', 0.9, seq);
    assert.equal(cache.currentDim('a'), 0.9);
  });

  test('a failed write leaves the previous value standing, so the next step plans from it', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    // The write is dispatched and rejects: nothing is committed.
    cache.noteEcho('a', 'dim', 0.9);

    const plan = planIntent(
      { type: 'brightness_delta', delta: 0.1 }, ['a'], cache, DEFAULT_BEHAVIOR,
    );

    assert.ok(
      (plan.writes[0]!.value as number) < 0.9,
      'the next relative step plans from 0.5, not from a level the lamp never reached',
    );
  });

  test('a write that lost a race does not walk the desired value backwards', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('a', { onoff: true, dim: 0.1 });

    // A slow write, then a fast one dispatched behind it.
    const slow = cache.noteEcho('a', 'dim', 0.4);
    const fast = cache.noteEcho('a', 'dim', 0.8);

    // The fast one lands first...
    cache.commitDesired('a', 'dim', 0.8, fast);
    assert.equal(cache.currentDim('a'), 0.8);

    // ...and the slow one, arriving after, must not undo it.
    cache.commitDesired('a', 'dim', 0.4, slow);
    assert.equal(cache.currentDim('a'), 0.8, 'the newer value stands');
  });

  test('a commit with no sequence at all still applies', () => {
    // planBrightnessDelta's off-branch adopts a level with no write behind it.
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('a', { onoff: false, dim: 0.5 });

    cache.commitDesired('a', 'dim', 0.3);
    assert.equal(cache.currentDim('a'), 0.3);
  });

  test('an echo of the OLD value after a failed write is not read as external', () => {
    let now = 1_000;
    const cache = new TargetStateCache(() => now);
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('a', { onoff: true, dim: 0.5 });

    cache.noteEcho('a', 'dim', 0.9);
    // The write failed, so the lamp reports the value it still has.
    now += 100;
    const external = cache.applyExternalChange('a', 'dim', 0.5);

    assert.equal(
      external, false,
      'the lamp confirming the value we already believed is not somebody changing it',
    );
    assert.equal(cache.currentDim('a'), 0.5);
  });
});

describe('a target that leaves the plan is fully released', () => {

  test('releaseTarget drops the subscription, the probe and the cached state', async () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true, dim: { min: 0, max: 1 } });
    cache.initialise('a', { onoff: true, dim: 0.4 });

    const unsubscribed: string[] = [];
    const cancelled: string[] = [];

    await releaseTarget('a', {
      unsubscribe: async id => { unsubscribed.push(id); },
      cancelPending: id => { cancelled.push(id); },
      cache,
    });

    assert.deepEqual(unsubscribed, ['a'], 'no more capability events');
    assert.deepEqual(cancelled, ['a'], 'no probe can still fire against it');
    assert.equal(cache.currentDim('a'), undefined, 'and nothing is remembered');
    assert.equal(cache.supports('a', 'dim'), false);
  });

  test('forget() leaves other devices alone', () => {
    const cache = new TargetStateCache();
    cache.setCapabilities('a', { onoff: true });
    cache.setCapabilities('ab', { onoff: true });
    cache.initialise('a', { onoff: true });
    cache.initialise('ab', { onoff: true });

    cache.forget('a');

    assert.equal(cache.supports('a', 'onoff'), false);
    assert.equal(
      cache.supports('ab', 'onoff'), true,
      'a prefix match would have taken "ab" with it — the echo keys are "<id>:<capability>"',
    );
  });
});

describe('the target fingerprint sees what an id list cannot', () => {

  async function snapshotOf(devices: ReturnType<typeof light>[]) {
    const resolver = new TargetResolver({
      device: async (id: string) => devices.find(d => d.id === id),
      devicesInZone: async () => devices,
    } as unknown as DeviceCatalog);
    return resolveSnapshot(resolver, { kind: 'devices', deviceIds: devices.map(d => d.id) });
  }

  test('an unchanged set has an unchanged fingerprint', async () => {
    const a = await snapshotOf([light('a'), light('b')]);
    const b = await snapshotOf([light('a'), light('b')]);
    assert.equal(a.fingerprint, b.fingerprint);
  });

  test('the same ids in a different ORDER are the same set', async () => {
    const a = await snapshotOf([light('a'), light('b')]);
    const b = await snapshotOf([light('b'), light('a')]);
    assert.equal(a.fingerprint, b.fingerprint, 'a reordered zone listing is not a change');
  });

  test('a re-pair that changes the dim range IS a change', async () => {
    // The one the id list cannot see, and the one that costs the most: the
    // clamps stay calibrated to the old range, so "full brightness" stops
    // meaning full brightness for as long as the app runs.
    const before = await snapshotOf([light('a')]);
    const rescaled = light('a');
    rescaled.capabilitiesObj.dim = { min: 0, max: 254, decimals: 0, value: 100 };
    const after = await snapshotOf([rescaled]);

    assert.deepEqual(before.ids, after.ids, 'the id list says nothing happened');
    assert.notEqual(before.fingerprint, after.fingerprint, 'the fingerprint disagrees');
  });

  test('a light going unavailable IS a change', async () => {
    const before = await snapshotOf([light('a')]);
    const after = await snapshotOf([light('a', undefined, { available: false })]);

    assert.deepEqual(before.ids, after.ids);
    assert.notEqual(before.fingerprint, after.fingerprint);
  });

  test('losing light_temperature through a firmware update IS a change', async () => {
    const before = await snapshotOf([light('a')]);
    const after = await snapshotOf([light('a', ['onoff', 'dim'])]);

    assert.deepEqual(before.ids, after.ids);
    assert.notEqual(before.fingerprint, after.fingerprint);
  });

  test('a RENAME is not a change', async () => {
    // Re-priming the cache costs live state, and a renamed light is the same
    // light doing the same thing.
    const before = await snapshotOf([light('a')]);
    const after = await snapshotOf([light('a', undefined, { name: 'Reading lamp' })]);

    assert.equal(before.fingerprint, after.fingerprint);
  });

  test('a target the user picked that has since been deleted is a change', async () => {
    const resolver = new TargetResolver({
      device: async () => undefined,
      devicesInZone: async () => [],
    } as unknown as DeviceCatalog);

    const gone = await resolveSnapshot(resolver, { kind: 'devices', deviceIds: ['a'] });
    const present = await snapshotOf([light('a')]);

    assert.deepEqual(gone.missing, ['a']);
    assert.notEqual(gone.fingerprint, present.fingerprint);
  });

  test('the diff names what has to be released', async () => {
    const before = await snapshotOf([light('a'), light('b')]);
    const after = await snapshotOf([light('b'), light('c')]);

    const diff = diffTargets(before, after);
    assert.deepEqual(diff.removed, ['a']);
    assert.deepEqual(diff.addedOrChanged.sort(), ['b', 'c']);
  });

  test('the first diff of a fresh runtime removes nothing', async () => {
    const first = await snapshotOf([light('a')]);
    assert.deepEqual(diffTargets(null, first).removed, []);
  });
});
