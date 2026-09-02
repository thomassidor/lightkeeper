import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeRegistry, type RegisteredRuntime } from '../../lib/runtime/runtime-registry';
import { FakeTimers } from '../support/fake-timers';
import { deferred, settle } from '../support/deferred';

/**
 * The Map, the coalescing timer and the teardown that all three runtime managers
 * used to have a copy of — and that no test imported at all.
 *
 * It was extracted precisely because three copies meant every ordering fix had
 * to be made three times, and the class comment records that one of them had
 * already drifted. Every rule below is documented there with the bug it
 * prevents, and none of them was pinned:
 *
 *  - start BEFORE inserting, so a runtime whose `start()` threw never becomes
 *    dispatchable;
 *  - remove BEFORE stopping, so a runtime tearing down is not handed another
 *    event on its way out;
 *  - coalesce a burst of catalogue changes into one pass, which must NOT restart
 *    the runtimes — our own virtual devices are devices too, so persisting a
 *    profile emits `device.update` and lands back here;
 *  - `allSettled` on teardown, so one runtime whose `stop()` rejects does not
 *    abandon every runtime behind it in the map.
 *
 * Its `timers` seam existed for exactly this file and was used by nobody.
 */

interface FakeRuntime extends RegisteredRuntime {
  id: string;
  stopped: number;
  refreshed: number;
}

function runtime(id: string, over: Partial<{
  failStop: Error;
  failRefresh: Error;
}> = {}): FakeRuntime {
  const self: FakeRuntime = {
    id,
    stopped: 0,
    refreshed: 0,
    stop: async () => {
      self.stopped += 1;
      if (over.failStop) throw over.failStop;
    },
    refreshTargets: async () => {
      self.refreshed += 1;
      if (over.failRefresh) throw over.failRefresh;
    },
  };
  return self;
}

function harness() {
  const logs: string[] = [];
  const timers = new FakeTimers();
  const registry = new RuntimeRegistry<FakeRuntime>({
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    label: 'test',
    timers,
  });
  return { registry, timers, logs };
}

describe('what is in the map is what is running', () => {
  test('a runtime is inserted only once its build resolves', async () => {
    const { registry } = harness();
    const gate = deferred();
    let built = false;

    const pending = registry.register('d1', async () => {
      await gate.promise;
      built = true;
      return runtime('d1');
    });

    await settle();
    assert.equal(built, false);
    assert.equal(registry.get('d1'), undefined, 'not dispatchable while it is still starting');

    gate.resolve();
    await pending;
    assert.equal(registry.get('d1')?.id, 'd1');
  });

  /**
   * A runtime whose `start()` threw is half-built — no scheduler, possibly no
   * subscriptions — and a bridge event arriving in that window would be
   * dispatched into it (platform §13).
   */
  test('a build that throws leaves nothing registered, and the rejection reaches the caller', async () => {
    const { registry } = harness();

    await assert.rejects(
      () => registry.register('d1', async () => { throw new Error('start failed'); }),
      /start failed/,
    );
    assert.equal(registry.get('d1'), undefined);
    assert.equal(registry.size, 0);
  });

  test('a failed re-register still removes and stops the runtime it replaces', async () => {
    const { registry } = harness();
    const first = runtime('d1');
    await registry.register('d1', async () => first);

    await assert.rejects(
      () => registry.register('d1', async () => { throw new Error('nope'); }),
    );

    assert.equal(first.stopped, 1, 'the old one was stopped');
    assert.equal(registry.get('d1'), undefined, 'and nothing is dispatchable');
  });

  test('re-registering replaces, and stops the one it replaced', async () => {
    const { registry } = harness();
    const first = runtime('d1');
    const second = runtime('d1');

    await registry.register('d1', async () => first);
    await registry.register('d1', async () => second);

    assert.equal(first.stopped, 1);
    assert.equal(second.stopped, 0);
    assert.equal(registry.get('d1'), second);
    assert.equal(registry.size, 1, 'one id, one runtime');
  });

  test('unregister removes BEFORE it stops', async () => {
    const { registry } = harness();
    const gate = deferred();
    const held: FakeRuntime = {
      id: 'd1', stopped: 0, refreshed: 0,
      stop: async () => { held.stopped += 1; await gate.promise; },
      refreshTargets: async () => { held.refreshed += 1; },
    };
    await registry.register('d1', async () => held);

    const pending = registry.unregister('d1');
    await settle();

    // Dispatch reads this map; a runtime tearing down must not be handed
    // another event on its way out.
    assert.equal(registry.get('d1'), undefined, 'gone from the map while stop() is still running');
    gate.resolve();
    await pending;
  });

  test('unregistering something that was never there is a no-op', async () => {
    const { registry } = harness();
    await registry.unregister('nobody');
    assert.equal(registry.size, 0);
  });

  test('ids and all() report what is registered', async () => {
    const { registry } = harness();
    await registry.register('a', async () => runtime('a'));
    await registry.register('b', async () => runtime('b'));

    assert.deepEqual(registry.ids.sort(), ['a', 'b']);
    assert.deepEqual(registry.all().map(r => r.id).sort(), ['a', 'b']);
  });
});

describe('a burst of catalogue changes costs one pass', () => {
  test('N events inside the window produce exactly one refresh', async () => {
    const { registry, timers } = harness();
    const only = runtime('d1');
    await registry.register('d1', async () => only);

    for (let i = 0; i < 20; i += 1) registry.onCatalogChange();
    assert.equal(only.refreshed, 0, 'nothing happens on the leading edge');

    timers.advance(500);
    await settle(2);
    assert.equal(only.refreshed, 1, 'twenty events, one pass');
  });

  /**
   * Coalescing, not debouncing-forever: a second burst after the first has
   * fired gets its own pass, or a light re-paired a minute later is never
   * picked up.
   */
  test('a later burst gets its own pass', async () => {
    const { registry, timers } = harness();
    const only = runtime('d1');
    await registry.register('d1', async () => only);

    registry.onCatalogChange();
    timers.advance(500);
    await settle(2);

    registry.onCatalogChange();
    timers.advance(500);
    await settle(2);

    assert.equal(only.refreshed, 2);
  });

  /**
   * It must NOT restart the runtimes. Our own virtual devices are devices too,
   * so persisting a profile emits `device.update` and lands back here — and a
   * restart per event stopped the scheduler between submit and flush, so no
   * light ever changed.
   */
  test('a refresh re-resolves targets and never stops anything', async () => {
    const { registry, timers } = harness();
    const only = runtime('d1');
    await registry.register('d1', async () => only);

    registry.onCatalogChange();
    timers.advance(500);
    await settle(2);

    assert.equal(only.refreshed, 1);
    assert.equal(only.stopped, 0, 'a catalogue change is not a restart');
  });

  test('one runtime failing to refresh does not stop the others', async () => {
    const { registry, timers, logs } = harness();
    const bad = runtime('bad', { failRefresh: new Error('zone gone') });
    const good = runtime('good');
    await registry.register('bad', async () => bad);
    await registry.register('good', async () => good);

    registry.onCatalogChange();
    timers.advance(500);
    await settle(3);

    assert.equal(bad.refreshed, 1);
    assert.equal(good.refreshed, 1, "one device's failure must not stop the others");
    assert.ok(logs.some(line => line.includes('zone gone')));
  });
});

describe('teardown', () => {
  test('a pending refresh is cancelled, or it re-resolves against a torn-down runtime', async () => {
    const { registry, timers } = harness();
    const only = runtime('d1');
    await registry.register('d1', async () => only);

    registry.onCatalogChange();
    await registry.destroyAll();
    timers.advance(500);
    await settle(2);

    assert.equal(only.refreshed, 0, 'the pass never ran');
    assert.equal(only.stopped, 1);
  });

  /**
   * `allSettled`, not a sequential loop. One runtime whose `stop()` rejects used
   * to abandon every runtime behind it in the map, leaving their subscriptions
   * and timers alive for the rest of the process's life — which on shutdown is
   * the whole point of the call.
   */
  test('one runtime failing to stop does not abandon the rest', async () => {
    const { registry, logs } = harness();
    const bad = runtime('bad', { failStop: new Error('socket gone') });
    const a = runtime('a');
    const b = runtime('b');
    await registry.register('bad', async () => bad);
    await registry.register('a', async () => a);
    await registry.register('b', async () => b);

    await registry.destroyAll();

    assert.equal(a.stopped, 1);
    assert.equal(b.stopped, 1);
    assert.equal(registry.size, 0, 'the map is empty whatever happened');
    assert.ok(logs.some(line => line.includes('socket gone')));
  });

  test('destroyAll on an empty registry is a no-op', async () => {
    const { registry } = harness();
    await registry.destroyAll();
    assert.equal(registry.size, 0);
  });

  test('a catalogue change after teardown still works, because the registry is reusable', async () => {
    const { registry, timers } = harness();
    await registry.destroyAll();

    const fresh = runtime('d1');
    await registry.register('d1', async () => fresh);
    registry.onCatalogChange();
    timers.advance(500);
    await settle(2);

    assert.equal(fresh.refreshed, 1);
  });
});
