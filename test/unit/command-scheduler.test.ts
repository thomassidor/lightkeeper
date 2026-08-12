import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CommandScheduler } from '../../lib/outputs/command-scheduler';
import type { Capability } from '../../lib/outputs/intent-planner';

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

interface Recorded { deviceId: string; capability: Capability; value: boolean | number }

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
      deviceId: `d${i}`, capability: 'dim' as Capability, value: 0.5,
    })));
    await clock.advance(50);

    assert.equal(written.length, 2, 'excess targets are dropped rather than queued unbounded');
  });
});
