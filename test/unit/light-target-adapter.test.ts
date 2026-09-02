import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LightTargetAdapter } from '../../lib/outputs/light-target-adapter';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import type { HomeyApiService, Unsubscribe } from '../../lib/homey-api-service';

/**
 * Subscriptions are the adapter's most leak-prone resource: refreshTargets()
 * re-subscribes every target on every catalog change, and our own profile
 * writes emit device.update, which lands back in onCatalogChange. An earlier
 * version only ever ADDED instances, so a handful of zone edits left several
 * live listeners per capability per light — growing memory, and one real
 * external change arriving as N.
 */

interface FakeInstance {
  capability: string;
  destroyed: number;
  fire: (value: unknown) => void;
}

function harness() {
  const instances: FakeInstance[] = [];
  const tracked = new Set<Unsubscribe>();

  const device = {
    makeCapabilityInstance(capability: string, listener: (value: unknown) => void) {
      const instance: FakeInstance = {
        capability,
        destroyed: 0,
        fire: listener,
      };
      instances.push(instance);
      return { destroy: () => { instance.destroyed += 1; } };
    },
  };

  /** Every `getDevice` call's options, so a test can assert the cache opt-out. */
  const getDeviceCalls: any[] = [];

  const api = {
    async read() {
      return {
        devices: {
          getDevice: async (options: any) => {
            getDeviceCalls.push(options);
            /**
             * A stand-in for `homey-api`'s per-manager cache (platform §15):
             * unless the caller opts out, it answers from the snapshot rather
             * than from the live device. That is what made `refresh()` prime a
             * lamp's power state from whenever the catalogue was last read.
             */
            if (options?.$cache === false) return device;
            return cached ?? device;
          },
        },
      };
    },
    track(unsubscribe: Unsubscribe): Unsubscribe {
      tracked.add(unsubscribe);
      return async () => {
        tracked.delete(unsubscribe);
        await unsubscribe();
      };
    },
  } as unknown as HomeyApiService;

  /** Set to make an un-opted-out read answer with something stale. */
  let cached: any = null;

  const cache = new TargetStateCache();
  cache.setCapabilities('light-1', { onoff: true, dim: { min: 0, max: 1 } });

  const adapter = new LightTargetAdapter(api, cache, () => { /* quiet */ });

  return {
    adapter, cache, instances, tracked, device, getDeviceCalls,
    stale: (value: any) => { cached = value; },
    live: () => instances.filter(i => !i.destroyed),
  };
}

describe('capability subscriptions', () => {
  test('subscribes once per supported capability', async () => {
    const h = harness();
    await h.adapter.subscribe('light-1', ['onoff', 'dim', 'light_temperature']);

    assert.deepEqual(h.instances.map(i => i.capability), ['onoff', 'dim']);
    assert.equal(h.live().length, 2, 'light_temperature is unsupported and skipped');
  });

  test('re-subscribing REPLACES rather than stacks', async () => {
    const h = harness();

    await h.adapter.subscribe('light-1', ['onoff', 'dim']);
    await h.adapter.subscribe('light-1', ['onoff', 'dim']);
    await h.adapter.subscribe('light-1', ['onoff', 'dim']);

    assert.equal(h.instances.length, 6, 'three passes each create two instances');
    assert.equal(h.live().length, 2, 'but only the newest pass stays live');
    assert.equal(h.tracked.size, 2, 'and the service holds exactly one teardown each');
  });

  test('one external change stays one cache update after re-subscribing', async () => {
    const h = harness();
    await h.adapter.subscribe('light-1', ['dim']);
    await h.adapter.subscribe('light-1', ['dim']);

    // Fire every instance ever created. Only the live one should be wired up;
    // the stale one was destroyed, which in the real SDK detaches its listener.
    const liveDim = h.live().find(i => i.capability === 'dim');
    assert.ok(liveDim);
    liveDim.fire(0.42);

    assert.equal(h.cache.state('light-1').actualDim, 0.42);
    assert.equal(h.live().length, 1);
  });

  test('unsubscribeAll releases every target', async () => {
    const h = harness();
    h.cache.setCapabilities('light-2', { onoff: true });

    await h.adapter.subscribe('light-1', ['onoff', 'dim']);
    await h.adapter.subscribe('light-2', ['onoff']);
    assert.equal(h.live().length, 3);

    await h.adapter.unsubscribeAll();

    assert.equal(h.live().length, 0);
    assert.equal(h.tracked.size, 0, 'nothing is left for the service to tear down');
  });

  test('unsubscribeAll is safe to call twice', async () => {
    const h = harness();
    await h.adapter.subscribe('light-1', ['onoff']);

    await h.adapter.unsubscribeAll();
    await h.adapter.unsubscribeAll();

    assert.equal(h.instances[0].destroyed, 1, 'destroy must not run a second time');
  });

  test('a capability that refuses to subscribe does not lose the others', async () => {
    let calls = 0;
    const api = {
      async read() {
        return {
          devices: {
            getDevice: async () => ({
              makeCapabilityInstance(capability: string) {
                calls += 1;
                if (capability === 'onoff') throw new Error('not subscribable');
                return { destroy: () => { /* noop */ } };
              },
            }),
          },
        };
      },
      track: (u: Unsubscribe) => u,
    } as unknown as HomeyApiService;

    const cache = new TargetStateCache();
    cache.setCapabilities('light-1', { onoff: true, dim: { min: 0, max: 1 } });
    const adapter = new LightTargetAdapter(api, cache, () => { /* quiet */ });

    await adapter.subscribe('light-1', ['onoff', 'dim']);

    assert.equal(calls, 2, 'dim is still attempted after onoff throws');
  });
});

/**
 * `refresh()` has to read the LAMP, not a snapshot of it.
 *
 * `DeviceCatalog` reads `getDevices()`, and a `getAll` writes every item it
 * returns into `homey-api`'s per-manager cache for the life of the client
 * (platform §15) — so `refresh()`'s `getDevice` was served from that snapshot
 * and primed `actualOn` with whatever the lamp was doing when the catalogue was
 * last read.
 *
 * Found on hardware: switch the lights on, pair a circadian light, and it reads
 * them as off and writes nothing until somebody next toggles one.
 */
describe('refresh reads live values, not a cached snapshot', () => {
  test('it opts out of the cache', async () => {
    const h = harness();
    await h.adapter.refresh('light-1');

    assert.equal(h.getDeviceCalls.length, 1);
    assert.equal(h.getDeviceCalls[0].$cache, false,
      'without $cache: false this is served from the snapshot getDevices() populated');
  });

  test('a stale snapshot does not decide whether a lamp is on', async () => {
    const h = harness();
    // The live device is on; the snapshot says off, as it would after the
    // catalogue was read before somebody reached for the switch.
    (h.device as any).capabilitiesObj = { onoff: { value: true } };
    h.stale({ capabilitiesObj: { onoff: { value: false } } });

    await h.adapter.refresh('light-1');

    assert.equal(h.cache.state('light-1').actualOn, true,
      'the runtime would otherwise skip a lit lamp and write nothing to it');
  });

  test('it carries the id as well as the opt-out', async () => {
    const h = harness();
    await h.adapter.refresh('light-1');
    assert.equal(h.getDeviceCalls[0].id, 'light-1');
  });
});
