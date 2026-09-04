import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CommandScheduler } from '../../lib/outputs/command-scheduler';
import type { Capability, WriteValue } from '../../lib/outputs/intent-planner';

class FakeClock {
  private seq = 0;
  private timers = new Map<number, { fn: () => void; at: number }>();
  now = 0;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  clearTimeout = (handle: unknown): void => { this.timers.delete(handle as number); };
  nowFn = (): number => this.now;

  /** Advance time and let any resulting microtasks settle. */
  async advance(ms: number): Promise<void> {
    this.now += ms;
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.fn();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

/**
 * `WriteValue`, not `boolean | number`: `light_mode` is a string, and widening it
 * here rather than casting at each call site is what keeps a colour write
 * recordable by the same harness as every other write.
 */
interface Recorded { deviceId: string; capability: Capability; value: WriteValue }

function harness(overrides: Partial<{ failOn: string }> = {}) {
  const clock = new FakeClock();
  const written: Recorded[] = [];
  const errors: Array<{ deviceId: string; capability: Capability }> = [];

  const scheduler = new CommandScheduler({
    minWriteIntervalMs: 200,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.nowFn,
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
     * `light_mode` sat AFTER `light_temperature` in that order until a Curve
     * light with a coloured point was run on real hardware: the lamp took the
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
    await clock.advance(400);

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
    await clock.advance(400);

    // Leading edge fires at once so the light responds; the rest coalesce into
    // a single trailing write carrying the final value.
    assert.ok(written.length <= 2, `five rapid events became ${written.length} writes`);
    assert.equal(written.at(-1)!.value, 0.5, 'the burst must end at the latest value');
  });

  test('an isolated action is written with no added delay', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([{ deviceId: 'a', capability: 'onoff', value: true }]);
    await clock.advance(0);

    assert.equal(written.length, 1,
      'a single press must not wait out the burst window');
  });

  test('ends at the correct final value after a long burst', async () => {
    const { clock, written, scheduler } = harness();

    // Simulate a fast dial: events keep arriving while writes are happening.
    for (let i = 1; i <= 20; i++) {
      scheduler.submit([{ deviceId: 'a', capability: 'dim', value: i / 20 }]);
      await clock.advance(30);
    }
    await clock.advance(500);

    assert.equal(written.at(-1)!.value, 1, 'the final state must be correct');
    assert.ok(written.length < 20, 'writes must be fewer than events');
  });

  test('rate-limits writes to one target', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.1 }]);
    await clock.advance(0);
    assert.equal(written.length, 1, 'the first write is immediate');

    // Immediately after a write, the next must wait out minWriteIntervalMs.
    scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.2 }]);
    await clock.advance(100);
    assert.equal(written.length, 1, 'must not write again inside the rate cap');

    await clock.advance(150);
    assert.equal(written.length, 2);
  });

  test('serialises writes per target but keeps targets independent', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.5 },
      { deviceId: 'b', capability: 'dim', value: 0.6 },
      { deviceId: 'c', capability: 'dim', value: 0.7 },
    ]);
    await clock.advance(150);

    assert.deepEqual(written.map(w => w.deviceId).sort(), ['a', 'b', 'c']);
  });

  test('one failing target does not block the others', async () => {
    const { clock, written, errors, scheduler } = harness({ failOn: 'b' });

    scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.5 },
      { deviceId: 'b', capability: 'dim', value: 0.5 },
      { deviceId: 'c', capability: 'dim', value: 0.5 },
    ]);
    await clock.advance(150);

    assert.deepEqual(written.map(w => w.deviceId).sort(), ['a', 'c']);
    assert.deepEqual(errors.map(e => e.deviceId), ['b']);
  });

  test('switches on before dimming, and off last', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.4 },
      { deviceId: 'a', capability: 'onoff', value: true },
    ]);
    await clock.advance(150);

    assert.deepEqual(written.map(w => w.capability), ['onoff', 'dim'],
      'dimming an unlit lamp then switching on can flash at the old level');
  });

  test('turning off is written after any level change', async () => {
    const { clock, written, scheduler } = harness();

    scheduler.submit([
      { deviceId: 'a', capability: 'onoff', value: false },
      { deviceId: 'a', capability: 'dim', value: 0.2 },
    ]);
    await clock.advance(150);

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
    await clock.advance(500);

    assert.deepEqual(written, [], 'a stopped scheduler accepts nothing');
  });

  test('bounds the number of queued devices', async () => {
    const clock = new FakeClock();
    const written: Recorded[] = [];
    const scheduler = new CommandScheduler({
      minWriteIntervalMs: 10,
      maxQueuedDevices: 2,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.nowFn,
    }, async (deviceId, capability, value) => { written.push({ deviceId, capability, value }); });

    scheduler.submit(Array.from({ length: 10 }, (_, i) => ({
      deviceId: `d${i}`, capability: 'dim', value: 0.5,
    })));
    await clock.advance(50);

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
    const clock = new FakeClock();
    const seen: Array<{ capability: Capability; preStage?: boolean }> = [];
    const scheduler = new CommandScheduler({
      minWriteIntervalMs: 10,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.nowFn,
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
    await clock.advance(100);

    assert.deepEqual(seen, [
      { capability: 'light_temperature', preStage: true },
      { capability: 'light_hue', preStage: false },
    ]);
  });
});
