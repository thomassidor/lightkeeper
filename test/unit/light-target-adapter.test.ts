import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LightTargetAdapter } from '../../lib/outputs/light-target-adapter';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import type { HomeyApiService, Unsubscribe } from '../../lib/homey-api-service';
import { FakeTimers } from '../support/fake-timers';
import { deferred, settle } from '../support/deferred';
import { WriteCancelled } from '../../lib/outputs/write-cancelled';

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


/**
 * The failure ring is 50 entries and is the only place a NEW failure can be
 * seen. Measured on the reference Homey, 17 September 2026: both curve-driven
 * devices that had any failures at all were at 50 of 50 retained, and every
 * single entry was a lamp declining a colour while it was off — so anything
 * genuinely new was evicted within minutes of arriving.
 *
 * That one failure has somewhere better to live: `preStageDeclined` on the
 * target, with the integration's own sentence, plus one log line on the tick
 * that crosses the threshold. The write itself stays in `recentWrites` with its
 * error, so nothing is hidden.
 */
describe('a refused pre-stage write does not spend the failure ring', () => {
  function refusing() {
    const cache = new TargetStateCache();
    const api = { read: async () => ({ devices: { getDevice: async () => ({
      setCapabilityValue: async () => { throw new Error('device (light) abc is "soft off"'); },
    }) } }) } as unknown as HomeyApiService;
    const logged: string[] = [];
    return { logged, adapter: new LightTargetAdapter(api, cache, (...a) => logged.push(a.join(' '))) };
  }

  test('an ordinary failure is still logged and kept', async () => {
    const h = refusing();
    await assert.rejects(h.adapter.write('lamp', 'light_temperature', 0.5));
    assert.equal(h.adapter.failures().length, 1);
    assert.equal(h.logged.length, 1);
  });

  test('a pre-stage refusal is kept out of both', async () => {
    const h = refusing();
    await assert.rejects(h.adapter.write('lamp', 'light_temperature', 0.5, { preStage: true }));
    assert.equal(h.adapter.failures().length, 0, 'the ring stays free for something new');
    assert.equal(h.logged.length, 0, 'and the log is not written once a minute all night');
  });

  test('but the write itself is still on the record, error and all', async () => {
    const h = refusing();
    await assert.rejects(h.adapter.write('lamp', 'light_temperature', 0.5, { preStage: true }));
    const written = h.adapter.writes()[0]!;
    assert.equal(written.ok, false);
    assert.equal(written.preStage, true);
    assert.match(written.error ?? '', /soft off/);
  });
});


describe('late work after adapter teardown', () => {
  test('an in-flight completion cannot repopulate cache or arm an implied-on probe', async () => {
    const gate = deferred();
    const timers = new FakeTimers();
    const cache = new TargetStateCache();
    const api = { read: async () => ({ devices: { getDevice: async () => ({
      setCapabilityValue: async () => gate.promise,
    }) } }) } as unknown as HomeyApiService;
    const adapter = new LightTargetAdapter(api, cache, () => {}, timers);
    const writing = adapter.write('lamp', 'dim', 0.5, { impliesOn: true });
    const cancelled = assert.rejects(writing, WriteCancelled);
    await settle(12);
    await adapter.unsubscribeAll(); cache.clear();
    adapter.resume();
    gate.resolve(); await cancelled;
    assert.equal(cache.currentDim('lamp'), undefined);
    assert.equal(timers.pending, 0);
    assert.equal(adapter.writes().length, 0);
    assert.equal(adapter.failures().length, 0);
  });

  test('an acquisition completing after teardown installs no listener', async () => {
    const gate = deferred();
    let created = 0;
    const cache = new TargetStateCache();
    cache.setCapabilities('lamp', { onoff: true });
    const api = { read: async () => ({ devices: { getDevice: async () => {
      await gate.promise;
      return { makeCapabilityInstance: () => { created += 1; return { destroy() {} }; } };
    } } }), track: (off: () => void) => off } as unknown as HomeyApiService;
    const adapter = new LightTargetAdapter(api, cache, () => {});
    const subscribing = adapter.subscribe('lamp', ['onoff']); await settle(12);
    await adapter.unsubscribeAll(); adapter.resume();
    gate.resolve(); await subscribing;
    assert.equal(created, 0);
  });
});

describe('suspend() disarms the implied-on check', () => {
  /**
   * A dim that is meant to switch a lamp on arms a 1.5 s check that can send
   * `onoff: true` — the one timer in the adapter that writes to a lamp by
   * itself. Every runtime's `stop()` calls `suspend()` FIRST, before its first
   * await, precisely so that check cannot outlive it. The probe re-checks
   * liveness when it fires, so a write count alone would pass with the timer
   * still armed; what has to hold is that nothing is left armed at all.
   */
  test('a check armed by a completed impliesOn write is cancelled, not merely ignored', async () => {
    const timers = new FakeTimers();
    const cache = new TargetStateCache();
    const sent: string[] = [];
    const api = { read: async () => ({ devices: { getDevice: async () => ({
      setCapabilityValue: async ({ capabilityId }: { capabilityId: string }) => { sent.push(capabilityId); },
    }) } }) } as unknown as HomeyApiService;
    const adapter = new LightTargetAdapter(api, cache, () => {}, timers);
    let corrected = 0;
    adapter.setImpliedOnFallback(async () => { corrected += 1; });

    await adapter.write('lamp', 'dim', 0.5, { impliesOn: true });
    assert.equal(timers.pending, 1, 'the implied-on check is armed');

    adapter.suspend();

    assert.equal(timers.pending, 0);
    timers.advance(2000); await settle(4);
    assert.equal(corrected, 0);
    assert.deepEqual(sent, ['dim']);
  });
});

/**
 * PERF-5. A curve or daylight runtime used to `refresh()` every lamp and then
 * `subscribe()` every lamp, two fresh `getDevice` reads per lamp for one set of
 * values, and it subscribed one lamp at a time. `subscribeMany` makes one read
 * per lamp do both, several lamps at a time.
 */
describe('subscribing to many lamps at once', () => {
  function many(ids: string[], options: { gate?: Promise<void>; failing?: string } = {}) {
    const reads: Array<{ id: string; options: any }> = [];
    let inFlight = 0;
    let peak = 0;
    const listeners = new Map<string, number>();
    const api = {
      async read() {
        return {
          devices: {
            getDevice: async (args: any) => {
              reads.push({ id: args.id, options: args });
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              try {
                if (options.gate) await options.gate;
                if (args.id === options.failing) throw new Error('could not reach device');
                return {
                  capabilitiesObj: {
                    onoff: { value: true }, dim: { value: 0.3 }, light_temperature: { value: 0.6 },
                    light_hue: { value: 0.1 }, light_saturation: { value: 0.9 }, light_mode: { value: 'color' },
                  },
                  makeCapabilityInstance(capability: string) {
                    listeners.set(`${args.id}:${capability}`, (listeners.get(`${args.id}:${capability}`) ?? 0) + 1);
                    return { destroy: () => { /* not under test */ } };
                  },
                };
              } finally {
                inFlight -= 1;
              }
            },
          },
        };
      },
      track: (off: Unsubscribe) => off,
    } as unknown as HomeyApiService;
    const cache = new TargetStateCache();
    for (const id of ids) {
      cache.setCapabilities(id, {
        onoff: true, dim: { min: 0, max: 1 }, light_temperature: { min: 0, max: 1 },
        light_hue: { min: 0, max: 1 }, light_saturation: { min: 0, max: 1 }, light_mode: true,
      });
    }
    const adapter = new LightTargetAdapter(api, cache, () => { /* quiet */ });
    return { adapter, cache, reads, listeners, peak: () => peak };
  }

  test('with prime, ONE live read per lamp seeds all six values and makes the subscription', async () => {
    const ids = ['a', 'b', 'c'];
    const h = many(ids);

    await h.adapter.subscribeMany(ids, ['onoff', 'dim', 'light_hue'], undefined, { prime: true });

    assert.deepEqual(h.reads.map(r => r.id).sort(), ids, 'one read per lamp, not two');
    assert.ok(h.reads.every(r => r.options.$cache === false), 'and a LIVE one (platform §15)');
    for (const id of ids) {
      assert.deepEqual(h.cache.reportedValues(id), {
        onoff: true, dim: 0.3, light_temperature: 0.6, light_hue: 0.1, light_saturation: 0.9,
      }, 'hue and saturation too: a seed that blanked them read the next echo as a person');
      assert.equal(h.listeners.get(`${id}:light_hue`), 1);
    }
  });

  test('without prime the cache is left alone, as a re-subscribe must leave it', async () => {
    const h = many(['a']);
    h.cache.initialise('a', { onoff: false, dim: 0.8 });

    await h.adapter.subscribeMany(['a'], ['onoff', 'dim']);

    assert.equal(h.reads.length, 1);
    assert.equal(h.cache.reportedValues('a').dim, 0.8);
    assert.equal(h.cache.reportedValues('a').onoff, false);
  });

  test('at most eight at a time, and every lamp is reached', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `lamp-${i}`);
    const gate = deferred<void>();
    const h = many(ids, { gate: gate.promise });

    const subscribing = h.adapter.subscribeMany(ids, ['onoff'], undefined, { prime: true });
    await settle(4);
    assert.equal(h.peak(), LightTargetAdapter.SUBSCRIBE_CONCURRENCY, 'not one after another, and not twenty at once');
    gate.resolve();
    await subscribing;

    assert.equal(h.reads.length, 20);
    assert.equal(h.peak(), LightTargetAdapter.SUBSCRIBE_CONCURRENCY);
  });

  test('a lamp that cannot be read fails the call, but only after every other lamp is subscribed', async () => {
    const ids = ['a', 'dead', 'b', 'c'];
    const h = many(ids, { failing: 'dead' });

    await assert.rejects(h.adapter.subscribeMany(ids, ['onoff'], undefined, { prime: true }), /could not reach/);

    for (const id of ['a', 'b', 'c']) assert.equal(h.listeners.get(`${id}:onoff`), 1, `${id} still subscribed`);
    assert.ok(h.adapter.failures().some(f => f.deviceId === 'dead' && f.capability === 'onoff'),
      'the failed read is recorded as refresh() recorded it');
  });
});
