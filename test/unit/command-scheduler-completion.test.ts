import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CommandScheduler, type WriteOutcome } from '../../lib/outputs/command-scheduler';
import type { Capability } from '../../lib/outputs/intent-planner';
import { deferred, settle } from '../support/deferred';
import { FakeTimers } from '../support/fake-timers';

/**
 * "A write happened" has to mean "a write completed".
 *
 * Everything downstream of this class used to treat submit() as if it were the
 * write: the cache committed a desired value before dispatch, the circadian
 * runtime recorded `lastWritten` on submission, and drain() resolved while a
 * flush it did not start was still in flight. Each of those is a different
 * symptom of one missing fact — whether the light actually moved.
 */

interface Recorded { deviceId: string; capability: Capability; value: boolean | number }

function harness(options: {
  minWriteIntervalMs?: number;
  maxQueuedDevices?: number;
  /** Hold every write to this device open until the returned gate resolves. */
  hold?: string;
  failOn?: string;
} = {}) {
  const timers = new FakeTimers(1_000);
  const written: Recorded[] = [];
  const errors: Array<{ deviceId: string; capability: Capability; message: string }> = [];
  const gate = deferred();

  const scheduler = new CommandScheduler({
    minWriteIntervalMs: options.minWriteIntervalMs ?? 200,
    ...(options.maxQueuedDevices !== undefined ? { maxQueuedDevices: options.maxQueuedDevices } : {}),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: timers.now.bind(timers),
    onError: (deviceId, capability, error) =>
      errors.push({ deviceId, capability, message: String((error as Error)?.message) }),
  }, async (deviceId, capability, value) => {
    if (options.hold === deviceId) await gate.promise;
    if (options.failOn === deviceId) throw new Error('device unreachable');
    written.push({ deviceId, capability, value });
  });

  return { timers, written, errors, scheduler, gate };
}

const by = (outcomes: WriteOutcome[], capability: Capability) =>
  outcomes.find(outcome => outcome.capability === capability)!;

describe('the completion contract', () => {

  test('a plain success reports what was written and how long it took', async () => {
    const h = harness();

    const { completion } = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.4 }]);
    const outcomes = await completion;

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.status, 'succeeded');
    assert.equal((outcomes[0] as any).value, 0.4);
    assert.equal(typeof (outcomes[0] as any).ms, 'number');
  });

  test('a batchId is issued per submit', async () => {
    const h = harness();
    const first = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.4 }]);
    const second = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.5 }]);

    assert.notEqual(first.batchId, second.batchId);

    // The first goes out on the leading edge; the second waits out the rate
    // window, so the clock has to move for it to settle.
    await first.completion;
    h.timers.advance(300);
    await second.completion;
  });

  test('an empty submit settles immediately', async () => {
    const h = harness();
    assert.deepEqual(await h.scheduler.submit([]).completion, []);
  });

  test('a superseded value reports `coalesced`, not success', async () => {
    // The distinction the circadian runtime turns on: coalesced means a newer
    // value owns this capability, so there is nothing to retry — while failed
    // means the light did not move and the next tick should try again.
    const h = harness({ hold: 'a' });

    const first = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.4 }]);
    await settle();
    // Arrives while the first write is in flight, so it lands in `pending`.
    const second = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.9 }]);
    const third = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 1 }]);

    h.gate.resolve();
    await first.completion;
    const secondOutcomes = await second.completion;

    assert.equal(secondOutcomes[0]!.status, 'coalesced');
    h.timers.advance(500);
    await third.completion;
  });

  test('a failed write reports the sanitised message, never the error object', async () => {
    const h = harness({ failOn: 'a' });

    const outcomes = await h.scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.4 },
    ]).completion;

    assert.equal(outcomes[0]!.status, 'failed');
    assert.equal((outcomes[0] as any).error, 'device unreachable');
    assert.equal(typeof (outcomes[0] as any).error, 'string', 'a string, so nothing can carry a key');
  });

  test('one failure does not stop the rest of the batch', async () => {
    const h = harness();
    let calls = 0;
    const scheduler = new CommandScheduler(
      { minWriteIntervalMs: 0 },
      async (_deviceId, capability) => {
        calls += 1;
        if (capability === 'dim') throw new Error('dim refused');
      },
    );

    const outcomes = await scheduler.submit([
      { deviceId: 'a', capability: 'onoff', value: true },
      { deviceId: 'a', capability: 'dim', value: 0.4 },
      { deviceId: 'a', capability: 'light_temperature', value: 0.8 },
    ]).completion;

    assert.equal(calls, 3, 'all three were attempted');
    assert.equal(by(outcomes, 'onoff').status, 'succeeded');
    assert.equal(by(outcomes, 'dim').status, 'failed');
    assert.equal(by(outcomes, 'light_temperature').status, 'succeeded');
    void h;
  });

  test('stop() settles everything outstanding as cancelled', async () => {
    // Not merely tidiness: a runtime awaiting a completion at teardown would
    // otherwise hang the app's onUninit forever.
    const h = harness({ hold: 'a' });

    const first = h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.4 }]);
    await settle();
    const queued = h.scheduler.submit([{ deviceId: 'a', capability: 'light_temperature', value: 0.8 }]);

    h.scheduler.stop();
    h.gate.resolve();

    const outcomes = await queued.completion;
    assert.equal(outcomes[0]!.status, 'cancelled');
    assert.equal((outcomes[0] as any).reason, 'scheduler stopped');
    await first.completion;
  });

  test('a submit after stop() is cancelled rather than silently dropped', async () => {
    const h = harness();
    h.scheduler.stop();

    const outcomes = await h.scheduler.submit([
      { deviceId: 'a', capability: 'dim', value: 0.4 },
    ]).completion;

    assert.equal(outcomes[0]!.status, 'cancelled');
  });
});

describe('drain waits for writes it did not start', () => {

  test('drain() resolves only after an in-flight flush completes', async () => {
    const h = harness({ hold: 'a' });

    h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.4 }]);
    await settle();
    assert.deepEqual(h.written, [], 'the write is held open');

    let drained = false;
    const draining = h.scheduler.drain().then(() => { drained = true; });
    await settle(3);

    assert.equal(drained, false, 'drain must not resolve over a flush still in flight');

    h.gate.resolve();
    await draining;
    assert.equal(drained, true);
    assert.equal(h.written.length, 1, 'and the write had landed by then');
  });

  test('a write submitted MID-FLUSH is inside the same drain', async () => {
    // The guaranteed final write, now provably inside drain(). This is what
    // the Test control on the pairing screen depends on.
    const h = harness({ hold: 'a', minWriteIntervalMs: 0 });

    h.scheduler.submit([{ deviceId: 'a', capability: 'onoff', value: true }]);
    await settle();
    h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.7 }]);

    const draining = h.scheduler.drain();
    h.gate.resolve();
    await draining;

    assert.deepEqual(
      h.written.map(w => w.capability), ['onoff', 'dim'],
      'both, not just the one that was already in flight',
    );
  });

  test('drain() with a pending timer flushes it now rather than waiting it out', async () => {
    const h = harness({ minWriteIntervalMs: 5_000 });

    await h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.1 }]).completion;
    h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.2 }]);

    await h.scheduler.drain();

    assert.equal(h.written.length, 2, 'the rate window is not a reason to lose a write at teardown');
    assert.equal(h.written.at(-1)!.value, 0.2);
  });

  test('drain() on an idle scheduler is a no-op', async () => {
    const h = harness();
    await h.scheduler.drain();
    assert.deepEqual(h.written, []);
  });

  test('stop() during a blocked flush prevents the post-flush reschedule', async () => {
    const h = harness({ hold: 'a', minWriteIntervalMs: 0 });

    h.scheduler.submit([{ deviceId: 'a', capability: 'onoff', value: true }]);
    await settle();
    h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.7 }]);

    h.scheduler.stop();
    h.gate.resolve();
    await settle(4);
    h.timers.advance(1_000);
    await settle(4);

    assert.deepEqual(
      h.written.map(w => w.capability), ['onoff'],
      'nothing may outlive a stop — the dim was cancelled, not rescheduled',
    );
  });
});

describe('capacity is honest', () => {

  test('a hundred devices cycled through an idle scheduler are all written', async () => {
    // The cap bounds CONCURRENT devices. It used to bound how many the app had
    // ever written to: a household with more lights than the cap filled the
    // map once and every later write was dropped in silence.
    const h = harness({ maxQueuedDevices: 8, minWriteIntervalMs: 0 });

    for (let i = 0; i < 100; i += 1) {
      const outcomes = await h.scheduler.submit([
        { deviceId: `light-${i}`, capability: 'onoff', value: true },
      ]).completion;
      assert.equal(outcomes[0]!.status, 'succeeded', `light-${i} was dropped`);
    }

    assert.equal(h.written.length, 100);
    assert.deepEqual(h.errors, []);
  });

  test('a genuine flood past the cap is reported, not swallowed', async () => {
    const h = harness({ maxQueuedDevices: 3, hold: 'light-0', minWriteIntervalMs: 5_000 });

    // The first three occupy the queues; the fourth has nowhere to go, and
    // nothing is reclaimable because all three are inside their rate window.
    const first = h.scheduler.submit([
      { deviceId: 'light-0', capability: 'onoff', value: true },
      { deviceId: 'light-1', capability: 'onoff', value: true },
      { deviceId: 'light-2', capability: 'onoff', value: true },
    ]);
    await settle();

    const overflow = h.scheduler.submit([{ deviceId: 'light-3', capability: 'onoff', value: true }]);
    const outcomes = await overflow.completion;

    assert.equal(outcomes[0]!.status, 'dropped_capacity');
    assert.deepEqual(
      h.errors.map(e => e.message), ['scheduler at capacity'],
      'the caller is told once, rather than watching a light not respond',
    );

    h.gate.resolve();
    await first.completion;
  });

  test('an idle queue past its rate window is reclaimed to make room', async () => {
    const h = harness({ maxQueuedDevices: 2, minWriteIntervalMs: 200 });

    await h.scheduler.submit([{ deviceId: 'a', capability: 'onoff', value: true }]).completion;
    await h.scheduler.submit([{ deviceId: 'b', capability: 'onoff', value: true }]).completion;
    assert.equal(h.scheduler.trackedDevices, 2);

    // Both are idle, but still inside their rate window — evicting either
    // would lose the timestamp that IS the rate limit.
    h.timers.advance(300);

    const outcomes = await h.scheduler.submit([
      { deviceId: 'c', capability: 'onoff', value: true },
    ]).completion;

    assert.equal(outcomes[0]!.status, 'succeeded');
  });

  test('reclaiming never costs the rate limit', async () => {
    // The bug this guards: evicting an idle queue drops `lastWriteAt`, so the
    // next write to that device goes out immediately and the rate cap is gone.
    const h = harness({ maxQueuedDevices: 1, minWriteIntervalMs: 200 });

    await h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.1 }]).completion;
    assert.equal(h.written.length, 1);

    // Well inside the rate window.
    h.timers.advance(50);
    h.scheduler.submit([{ deviceId: 'a', capability: 'dim', value: 0.2 }]);
    await settle(3);

    assert.equal(h.written.length, 1, 'the second write must wait out the cap');

    h.timers.advance(200);
    await settle(3);
    assert.equal(h.written.length, 2);
  });
});
