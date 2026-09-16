import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PressListener, WINDOW_MS } from '../../lib/pairing/press-listener';
import type { CatalogDevice } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * Press-to-learn holds a live subscription on every remote in the house, which
 * is the whole reason it needs tests.
 *
 * Two properties matter more than whether it hears anything. It must STOP — on
 * the first press, on the timeout, and on the screen being abandoned — because a
 * listener that leaks leaves a subscription on somebody's battery-powered remote
 * for as long as the app runs. And it must be honest about what it cannot hear:
 * a card-only remote (platform §4) is silent here, which is why every screen
 * that offers this keeps the list one tap away.
 */

interface FakeInstance { destroyed: boolean }

function harness(
  devices: Array<Partial<CatalogDevice>> = [],
  options: { holdDevice?: string } = {},
) {
  const instances: FakeInstance[] = [];
  const subscribed: string[] = [];
  const logs: string[] = [];
  let fire: ((value: unknown) => void) | null = null;
  const timers: Array<() => void> = [];

  // A `getDevice` that does not resolve until the test says so, which is the
  // only way to land a `stop()` inside `watch()`'s own await.
  let release: (() => void) | null = null;
  const held = new Promise<void>(resolve => { release = resolve; });

  const api = {
    read: async () => ({
      devices: {
        getDevice: async ({ id }: { id: string }) => {
          if (id === 'broken') throw new Error('gone');
          if (id === options.holdDevice) await held;
          return {
            makeCapabilityInstance: (capability: string, listener: (value: unknown) => void) => {
              subscribed.push(`${id}.${capability}`);
              fire = listener;
              const instance: FakeInstance = { destroyed: false };
              instances.push(instance);
              return { destroy: () => { instance.destroyed = true; } };
            },
          };
        },
      },
    }),
    // `track` is how every subscription in this app is released; the real one
    // hands back an unsubscribe the service keeps.
    track: (off: () => void) => off,
  } as unknown as HomeyApiService;

  const listener = new PressListener({
    api,
    log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => undefined,
  });

  const candidates = devices.map((device, index) => ({
    id: `r${index}`,
    name: `Remote ${index}`,
    capabilities: [],
    ...device,
  })) as CatalogDevice[];

  return {
    listener,
    candidates,
    instances,
    subscribed,
    logs,
    press: (value: unknown) => fire?.(value),
    expire: () => timers.forEach(fn => fn()),
    armed: () => timers.length,
    release: () => release?.(),
  };
}

describe('PressListener', () => {
  test('subscribes only to capabilities a press can arrive on', async () => {
    // A battery level is not a button. Subscribing to everything would turn a
    // low-battery report into a press and pick the wrong remote.
    const h = harness([
      { id: 'r0', capabilities: ['button', 'measure_battery', 'alarm_generic'] },
    ]);
    const heard: unknown[] = [];
    await h.listener.start(h.candidates, press => heard.push(press));

    assert.deepEqual(h.subscribed, ['r0.button', 'r0.alarm_generic']);
    await h.listener.stop();
  });

  test('a remote with nothing readable is skipped, not an error', async () => {
    // This is the card-only case (platform §4) and the flat-battery case, and
    // they are indistinguishable from here. Neither is a fault, which is why
    // the list stays one tap away on every screen that offers this.
    const h = harness([{ id: 'r0', capabilities: ['measure_battery'] }]);
    await h.listener.start(h.candidates, () => undefined);

    assert.deepEqual(h.subscribed, []);
    assert.deepEqual(h.logs, []);
    await h.listener.stop();
  });

  test('the FIRST press wins, and everything is released with it', async () => {
    // A second press arriving in the same moment would otherwise pick a
    // different remote than the one the screen has already navigated to.
    const h = harness([{ id: 'r0', name: 'Hall remote', capabilities: ['button'] }]);
    const heard: Array<{ deviceId: string; name: string; key: string }> = [];

    await h.listener.start(h.candidates, press => heard.push(press));
    h.press(true);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(heard, [{ deviceId: 'r0', name: 'Hall remote', key: 'button|true' }]);

    h.press(true);
    assert.equal(heard.length, 1, 'a second press after the first is ignored');
    assert.ok(h.instances.every(instance => instance.destroyed), 'every subscription released');
  });

  test('it gives up on its own, and lets go when it does', async () => {
    // Thirty seconds: long enough to walk to the remote, short enough that an
    // abandoned screen does not hold subscriptions for ever.
    assert.equal(WINDOW_MS, 30_000);

    const h = harness([{ id: 'r0', capabilities: ['button'] }]);
    await h.listener.start(h.candidates, () => undefined);
    assert.ok(h.instances.some(instance => !instance.destroyed));

    h.expire();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.instances.every(instance => instance.destroyed), 'the timeout releases everything');
  });

  test('stopping twice is a no-op, and stopping without starting is too', async () => {
    // `stop()` is reached from the timeout, from the first press, and from the
    // screen closing — sometimes two of those at once.
    const h = harness([{ id: 'r0', capabilities: ['button'] }]);
    await h.listener.stop();

    await h.listener.start(h.candidates, () => undefined);
    await h.listener.stop();
    await h.listener.stop();

    assert.ok(h.instances.every(instance => instance.destroyed));
  });

  test('a device that cannot be read leaves the others listening', async () => {
    const h = harness([
      { id: 'broken', capabilities: ['button'] },
      { id: 'r1', name: 'Bedside', capabilities: ['button'] },
    ]);
    await h.listener.start(h.candidates, () => undefined);

    assert.deepEqual(h.subscribed, ['r1.button']);
    assert.ok(h.logs.some(line => line.includes('Could not listen')));
    await h.listener.stop();
  });

  /**
   * A `stop()` landing inside `watch()`'s own await must still release
   * everything.
   *
   * `stop()` swaps `this.offs` for a fresh array and drains the old one. The
   * candidate whose `getDevice` was in flight then created its instances and
   * pushed them into the NEW array, with nothing scheduled to drain it — live
   * subscriptions on a household's remotes after the screen had closed. The
   * loop's `if (!this.listening) break` guards the next candidate, not the one
   * already running. And the window timer was armed afterwards regardless, on a
   * listener that had stopped.
   *
   * Bounded rather than permanent — the stray timer drains it within WINDOW_MS,
   * and `start()` stops first — but the class header promises "every
   * subscription released on stop however stop is reached", and this is the one
   * path where that was not true.
   */
  test('a stop inside a subscription in flight leaves nothing behind', async () => {
    const h = harness([{ id: 'r0', capabilities: ['button'] }], { holdDevice: 'r0' });

    const started = h.listener.start(h.candidates, () => undefined);
    // Let start() reach the held getDevice before stopping.
    await new Promise(resolve => setImmediate(resolve));

    await h.listener.stop();
    h.release();
    await started;

    assert.deepEqual(
      h.instances.filter(instance => !instance.destroyed), [],
      'a subscription outlived the stop that was supposed to release it',
    );
    assert.equal(h.armed(), 0, 'a window was armed on a listener that had stopped');
  });

  test('the key names the capability and the value, so a row can match it', async () => {
    const h = harness([{ id: 'r0', capabilities: ['dim'] }]);
    const heard: Array<{ key: string }> = [];
    await h.listener.start(h.candidates, press => heard.push(press));

    h.press(0.4);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(heard[0]!.key, 'dim|0.4');
  });
});
