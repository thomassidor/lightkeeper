import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LightTargetAdapter } from '../../lib/outputs/light-target-adapter';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import type { HomeyApiService, Unsubscribe } from '../../lib/homey-api-service';
import { settle } from '../support/deferred';
import { FakeTimers } from '../support/fake-timers';

/**
 * The one place this app writes to a light nobody asked it to write to.
 *
 * `impliesOn` skips the separate `onoff` write because a `dim` write turns an
 * off Hue lamp on — measured (platform §6). Not every integration behaves that
 * way, so 1.5 s later the adapter checks whether the lamp really did come up
 * and sends `onoff` if it did not.
 *
 * The window is the problem. A second and a half is long enough for a person
 * to reach a wall switch, and the check had no way of knowing they had: press
 * a dimmer, decide against it, switch the lamp off, and the app switched it
 * back on. From the user's side that is unrecoverable except by doing it again
 * and hoping, which is the exact opposite of what this feature is for.
 */

function harness() {
  const clock = new FakeTimers(1_755_500_000_000);
  const cache = new TargetStateCache(clock.now);
  cache.setCapabilities('light-1', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });

  const writes: Array<{ capability: string; value: unknown }> = [];
  const logs: string[] = [];
  let listener: ((value: unknown) => void) | null = null;

  const device = {
    async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
      writes.push({ capability: capabilityId, value });
    },
    makeCapabilityInstance(capability: string, fn: (value: unknown) => void) {
      if (capability === 'onoff') listener = fn;
      return { destroy: () => { /* nothing to release */ } };
    },
  };

  const api = {
    async read() { return { devices: { getDevice: async () => device } }; },
    track: (unsubscribe: Unsubscribe) => unsubscribe,
  } as unknown as HomeyApiService;

  const adapter = new LightTargetAdapter(api, cache, (...args) => logs.push(args.join(' ')), clock);

  return {
    adapter, cache, writes, logs,
    /** Somebody, or something, changes the lamp's power. */
    reportOnOff: (value: boolean) => {
      clock.advance(1);
      listener?.(value);
    },
    /**
     * Let the 1.5 s probe fire, on the injected clock.
     *
     * This used to wait REAL time — 1.6 s per test, 13 s of the suite — under a
     * note that a fake clock "does not drop in". It does, given the two things
     * that note named: the cache and the adapter share ONE clock (the stand-down
     * compares a timestamp the cache recorded against one the adapter did), and
     * the clock moves between the write and the person's action, because that
     * comparison is strict and a frozen clock puts both in the same instant.
     * `reportOnOff` is where the second happens. With both, every case below
     * takes the path it names — the stand-down cases assert the log line that
     * only the stand-down writes, so none of them can pass by the probe simply
     * never firing.
     */
    async runProbe() {
      await clock.advanceAsync(1_600);
      await settle(4);
    },
  };
}

describe('the implied-on probe never overrides the user', () => {

  test('a lamp switched off inside the window is left off', async () => {
    // Written first, and it failed on the pre-phase code: the probe wrote
    // onoff:true over a lamp the user had just switched off.
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    assert.deepEqual(h.writes.map(w => w.capability), ['dim']);

    // The user reaches the wall switch.
    await h.adapter.subscribe('light-1', ['onoff']);
    h.reportOnOff(false);

    await h.runProbe();

    assert.deepEqual(
      h.writes.map(w => w.capability), ['dim'],
      'no corrective onoff — the lamp being dark is now the user’s decision',
    );
    assert.ok(h.logs.some(line => line.includes('leaving it alone')));
  });

  test('a lamp power-cycled inside the window is left alone', async () => {
    // Off and on again: desiredOn ends up true, so a desired-state guard
    // alone would miss it. What actually leaves it alone is that the lamp is
    // ON when the probe fires — see the note at the end.
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    await h.adapter.subscribe('light-1', ['onoff']);
    h.reportOnOff(false);
    h.reportOnOff(true);
    // The lamp is on, so the probe's own "did it come up" check would pass —
    // but it came up because a person switched it, not because of our write.

    await h.runProbe();

    assert.deepEqual(h.writes.map(w => w.capability), ['dim']);
    // NOTE: this case does not reach the timestamp at all. The lamp ends ON,
    // and the probe's `actualOn === true` early return fires before the
    // stand-down is consulted, so it would pass with the stand-down deleted.
    // Found when the rig moved to a fake clock and a 'leaving it alone'
    // assertion here failed; the case that DOES prove the timestamp is the
    // switched-off one above.
  });

  test('a lamp that genuinely stayed dark IS corrected', async () => {
    // The feature still has to work, or an integration that does not light up
    // from a dim write leaves the user pressing a dead button.
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    await h.runProbe();

    assert.deepEqual(
      h.writes.map(w => w.capability), ['dim', 'onoff'],
      'nothing was heard from the lamp, so the write is sent explicitly',
    );
    assert.equal(h.writes.at(-1)!.value, true);
  });

  test('a lamp that came up on its own is not written to twice', async () => {
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    await h.adapter.subscribe('light-1', ['onoff']);
    // The echo of our own dim write turning the lamp on, as Hue does.
    h.reportOnOff(true);

    await h.runProbe();

    assert.deepEqual(h.writes.map(w => w.capability), ['dim']);
  });

  test('the correction goes through the runtime’s scheduler when one is wired', async () => {
    // So it inherits ordering, the rate cap, outcomes, and the
    // noteEcho/commitDesired pairing — a direct write had none of those, and
    // its echo came back looking like somebody else had switched the lamp on.
    const h = harness();
    cacheOn(h.cache, false);

    const throughScheduler: string[] = [];
    h.adapter.setImpliedOnFallback(async deviceId => { throughScheduler.push(deviceId); });

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    await h.runProbe();

    assert.deepEqual(throughScheduler, ['light-1']);
    assert.deepEqual(
      h.writes.map(w => w.capability), ['dim'],
      'and not around it, straight at the device',
    );
  });

  test('a probe is cancelled when the light stops being a target', async () => {
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    // The user edits the plan and this light is no longer in it.
    h.adapter.cancelPending('light-1');

    await h.runProbe();

    assert.deepEqual(
      h.writes.map(w => w.capability), ['dim'],
      'a light that left the plan may not be switched on a second later by a timer nobody could reach',
    );
  });

  test('a newer write replaces the older write’s probe rather than stacking one', async () => {
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.4, { impliesOn: true });
    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });

    await h.runProbe();

    const corrections = h.writes.filter(w => w.capability === 'onoff');
    assert.equal(corrections.length, 1, 'one correction, not one per write in the burst');
  });

  test('teardown cancels everything outstanding', async () => {
    const h = harness();
    cacheOn(h.cache, false);

    await h.adapter.write('light-1', 'dim', 0.6, { impliesOn: true });
    await h.adapter.unsubscribeAll();

    await h.runProbe();

    assert.deepEqual(
      h.writes.map(w => w.capability), ['dim'],
      'nothing may outlive the runtime that started it',
    );
  });
});

/** Seed the lamp's power state without going through a write. */
function cacheOn(cache: TargetStateCache, on: boolean): void {
  cache.initialise('light-1', { onoff: on, dim: 0.3 });
}
