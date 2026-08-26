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

  const api = {
    async read() {
      return { devices: { getDevice: async () => device } };
    },
    track(unsubscribe: Unsubscribe): Unsubscribe {
      tracked.add(unsubscribe);
      return async () => {
        tracked.delete(unsubscribe);
        await unsubscribe();
      };
    },
  } as unknown as HomeyApiService;

  const cache = new TargetStateCache();
  cache.setCapabilities('light-1', { onoff: true, dim: { min: 0, max: 1 } });

  const adapter = new LightTargetAdapter(api, cache, () => { /* quiet */ });

  return { adapter, cache, instances, tracked, live: () => instances.filter(i => !i.destroyed) };
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
