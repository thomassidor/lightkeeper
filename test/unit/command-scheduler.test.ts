import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CommandScheduler } from '../../lib/outputs/command-scheduler';
import type { Capability, WriteValue } from '../../lib/outputs/intent-planner';
import { FakeTimers } from '../support/fake-timers';

/**
 * `WriteValue`, not `boolean | number`: `light_mode` is a string, and widening it
 * here rather than casting at each call site is what keeps a colour write
 * recordable by the same harness as every other write.
 */
interface Recorded { deviceId: string; capability: Capability; value: WriteValue }

function harness(overrides: Partial<{ failOn: string }> = {}) {
  // `advanceAsync`, because the scheduler arms a device's next slot after
  // awaiting the previous write — so the clock has to let continuations run
  // between timers. The private clock this replaced fired due timers in
  // insertion order and never fired one armed during the same advance.
  const clock = new FakeTimers();
  const written: Recorded[] = [];
  const errors: Array<{ deviceId: string; capability: Capability }> = [];

  const scheduler = new CommandScheduler({
    minWriteIntervalMs: 200,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    onError: (deviceId, capability) => errors.push({ deviceId, capability }),
  }, async (deviceId, capability, value) => {
    if (overrides.failOn === deviceId) throw new Error('device unreachable');
    written.push({ deviceId, capability, value });
  });

  return { clock, written, errors, scheduler };
}

describe('command scheduler', () => {
  test('light_mode goes out before BOTH the things it governs', async () => {
    /**
     * The ordering the planner's mode writes depend on.
     *
     * A lamp ignores a hue while in temperature mode, and a temperature while in
     * colour mode — silently, either way. `planColor` and `planTemperature` each
     * emit the mode first, but a queue that reorders them puts the mode after
     * the value it was meant to enable, and the lamp discards the value.
     *
     * `light_mode` sat AFTER `light_temperature` in that order until a Colour
     * Curve Light with a coloured point was run on real hardware: the lamp took the
     * colour, went into colour mode, and then held its old temperature against
     * every later write.
     */
    const { clock, written, scheduler } = harness();

    // Submitted deliberately in the WRONG order, since that is what the queue
    // exists to fix.
    scheduler.submit([
      { deviceId: 'a', capability: 'light_temperature', value: 0.2 },
      { deviceId: 'a', capability: 'light_hue', value: 0.5 },
      { deviceId: 'a', capability: 'light_mode', value: 'temperature' },
      { deviceId: 'a', capability: 'onoff', value: true },
    ]);
    await clock.advanceAsync(400);

    const order = written.map(w => w.capability);
    const at = (capability: Capability) => order.indexOf(capability);

    assert.ok(at('onoff') < at('light_mode'), 'a lamp is switched on first');
    assert.ok(at('light_mode') < at('light_temperature'),
      `light_mode must precede light_temperature, got ${order.join(' -> ')}`);
    assert.ok(at('light_mode') < at('light_hue'),
      `light_mode must precede light_hue, got ${order.join(' -> ')}`);
  });

  test('coalesces a burst, acting immediately then once more at the end', async () => {
    const { clock, written, scheduler } = harness();

    for (const value of [0.1, 0.2, 0.3, 0.4, 0.5]) {
      scheduler.submit([{ deviceId: 'a', capability: 'dim', value }]);
    }
    await clock.advanceAsync(400);

    // Leading edge fires at once so the light responds; the rest coalesce into
    // a single trailing write carrying the final value.
    assert.ok(written.length <= 2, `five rapid events became ${written.length} writes`);
    assert.equal(written.at(-1)!.value, 0.5, 'the burst must end at the latest value');
  });

  test('an isolated action is written with no added delay', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([{ deviceId: 'a', capability: 'onoff', value: true }]);
    await clock.advanceAsync(0);

    assert.equal(written.length, 1,
      'a single press must not wait out the burst window');
  });

  test('ends at the correct final value after a long burst', async () => {
    const { clock, written, scheduler } = harness();

    // Simulate a fast dial: events keep arriving while writes are happening.
    for (let i = 1; i <= 20; i++) {
      scheduler.submit([{ deviceId: 'a', capability: 'dim', value: i / 20 }]);
      await clock.advanceAsync(30);
    }
    await clock.advanceAsync(500);

    assert.equal(written.at(-1)!.value, 1, 'the final state must be correct');
    assert.ok(written.length < 20, 'writes must be fewer than events');
  });

  test('rate-limits writes to one target', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.1 }]);
    await clock.advanceAsync(0);
    assert.equal(written.length, 1, 'the first write is immediate');

    // Immediately after a write, the next must wait out minWriteIntervalMs.
    scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.2 }]);
    await clock.advanceAsync(100);
    assert.equal(written.length, 1, 'must not write again inside the rate cap');

    await clock.advanceAsync(150);
    assert.equal(written.length, 2);
  });

  test('serialises writes per target but keeps targets independent', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.5 },
      { deviceId: 'b', capability: 'dim', value: 0.6 },
      { deviceId: 'c', capability: 'dim', value: 0.7 },
    ]);
    await clock.advanceAsync(150);

    assert.deepEqual(written.map(w => w.deviceId).sort(), ['a', 'b', 'c']);
  });

  test('one failing target does not block the others', async () => {
    const { clock, written, errors, scheduler } = harness({ failOn: 'b' });

    scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.5 },
      { deviceId: 'b', capability: 'dim', value: 0.5 },
      { deviceId: 'c', capability: 'dim', value: 0.5 },
    ]);
    await clock.advanceAsync(150);

    assert.deepEqual(written.map(w => w.deviceId).sort(), ['a', 'c']);
    assert.deepEqual(errors.map(e => e.deviceId), ['b']);
  });

  test('switches on before dimming, and off last', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.4 },
      { deviceId: 'a', capability: 'onoff', value: true },
    ]);
    await clock.advanceAsync(150);

    assert.deepEqual(written.map(w => w.capability), ['onoff', 'dim'],
      'dimming an unlit lamp then switching on can flash at the old level');
  });

  test('turning off is written after any level change', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([
      { deviceId: 'a', capability: 'onoff', value: false },
      { deviceId: 'a', capability: 'dim', value: 0.2 },
    ]);
    await clock.advanceAsync(150);

    assert.equal(written.at(-1)!.capability, 'onoff');
    assert.equal(written.at(-1)!.value, false);
  });

  test('drain writes everything outstanding immediately', async () => {
    const { written, scheduler } = harness();

    scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.9 }]);
    await scheduler.drain();

    assert.equal(written.length, 1);
  });

  test('stop clears queues and stops accepting work', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.stop();
    scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.6 }]);
    await clock.advanceAsync(500);

    assert.deepEqual(written, [], 'a stopped scheduler accepts nothing');
  });

  test('bounds the number of queued devices', async () => {
    const clock = new FakeTimers();
    const written: Recorded[] = [];
    const scheduler = new CommandScheduler({
      minWriteIntervalMs: 10,
      maxQueuedDevices: 2,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    }, async (deviceId, capability, value) => { written.push({ deviceId, capability, value }); });

    scheduler.submit(Array.from({ length: 10 }, (_, i) => ({
      deviceId: `d${i}`, capability: 'dim', value: 0.5,
    })));
    await clock.advanceAsync(50);

    assert.equal(written.length, 2, 'excess targets are dropped rather than queued unbounded');
  });

  /**
   * The flags ride to the executor, and a coalesced write hands over its own.
   *
   * `preStage` decides whether a failure counts against a lamp's health
   * (`LightTargetAdapter.noteWriteHealth`), so a flag lost in the queue is a
   * healthy lamp reported as broken — or, the other way round, a dead one
   * reported as fine. Neither is visible anywhere but here.
   */
  test('the write flags survive the queue, and the newer write owns them', async () => {
    const clock = new FakeTimers();
    const seen: Array<{ capability: Capability; preStage?: boolean }> = [];
    const scheduler = new CommandScheduler({
      minWriteIntervalMs: 10,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    }, async (_deviceId, capability, _value, options) => {
      seen.push({ capability, preStage: options?.preStage });
    });

    scheduler.submit([
      { deviceId: 'd1', capability: 'light_temperature', value: 0.5, preStage: true },
      { deviceId: 'd1', capability: 'light_hue', value: 0.2, preStage: true },
      // Supersedes the hue above before either is flushed: the value that goes
      // out is this one, so the flags that go with it are this one's.
      { deviceId: 'd1', capability: 'light_hue', value: 0.4 },
    ]);
    await clock.advanceAsync(100);

    assert.deepEqual(seen, [
      { capability: 'light_temperature', preStage: true },
      { capability: 'light_hue', preStage: false },
    ]);
  });
});

/**
 * A flush that finds nothing to write must not wedge the device's queue.
 *
 * `runFlush` used to clear `queue.activeFlush` in its own `finally`. An async
 * function runs synchronously up to its first `await`, so a pass that RETURNED
 * before reaching one — an empty `pending` — cleared the field, and `flush` then
 * assigned a resolved promise back into it. `schedule()` early-returns while
 * `activeFlush` is non-null, so that device was never written to again for the
 * life of the app: not an error, not a failed write, silence.
 *
 * Latent rather than live — every caller happens to guarantee a non-empty
 * `pending` — so it is reached here through the private method, which is the
 * only way to ask the question at all. That is the point of pinning it: the next
 * caller does not have to know.
 */
describe('a queue survives a flush with nothing in it', () => {
  test('an empty flush leaves the device writable', async () => {
    const h = harness();

    // Build the queue and let its first burst land.
    h.scheduler.submit([{ deviceId: 'l1', capability: 'onoff', value: true }]);
    await h.clock.advanceAsync(1);
    assert.equal(h.written.length, 1);

    // A flush with nothing pending — the path that used to strand the slot.
    await (h.scheduler as unknown as { flush(id: string): Promise<void> }).flush('l1');

    h.scheduler.submit([{ deviceId: 'l1', capability: 'dim', value: 0.4 }]);
    await h.clock.advanceAsync(500);

    assert.deepEqual(
      h.written.map(w => w.capability), ['onoff', 'dim'],
      'the second write never arrived, so the queue was stranded by the empty flush',
    );
  });

  test('and so does a second empty flush straight after it', async () => {
    const h = harness();
    h.scheduler.submit([{ deviceId: 'l1', capability: 'onoff', value: true }]);
    await h.clock.advanceAsync(1);

    const flush = (h.scheduler as unknown as { flush(id: string): Promise<void> }).flush.bind(h.scheduler);
    await flush('l1');
    await flush('l1');

    h.scheduler.submit([{ deviceId: 'l1', capability: 'dim', value: 0.4 }]);
    await h.clock.advanceAsync(500);

    assert.equal(h.written.length, 2);
  });
});
