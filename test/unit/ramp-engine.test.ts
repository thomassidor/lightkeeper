import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RampEngine, canRamp, HARD_STOP_MS, TICK_MS, type RampStopReason,
} from '../../lib/outputs/ramp-engine';
import type { LightIntent } from '../../lib/outputs/light-intent';

class FakeClock {
  private seq = 0;
  private intervals = new Map<number, { fn: () => void; every: number; next: number }>();
  now = 0;

  setInterval = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.intervals.set(id, { fn, every: ms, next: this.now + ms });
    return id;
  };

  clearInterval = (handle: unknown): void => { this.intervals.delete(handle as number); };
  nowFn = (): number => this.now;

  advance(ms: number): void {
    const target = this.now + ms;
    // Step tick by tick so the engine's own hard-stop check runs each time.
    while (true) {
      const due = [...this.intervals.entries()]
        .filter(([, timer]) => timer.next <= target)
        .sort((a, b) => a[1].next - b[1].next)[0];
      if (!due) break;

      const [id, timer] = due;
      this.now = timer.next;
      timer.next += timer.every;
      timer.fn();
      if (!this.intervals.has(id)) continue;
    }
    this.now = target;
  }
}

function harness(ratePerSecond = 0.6) {
  const clock = new FakeClock();
  const ticks: LightIntent[] = [];
  const stops: Array<{ controlId: string; reason: RampStopReason }> = [];

  const engine = new RampEngine(
    intent => ticks.push(intent),
    (controlId, reason) => stops.push({ controlId, reason }),
    {
      ratePerSecond,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      now: clock.nowFn,
    },
  );

  return { clock, ticks, stops, engine };
}

describe('ramp engine (§7.7, AC-12)', () => {
  test('ticks at 100 ms while held', () => {
    const { clock, ticks, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(1000);

    assert.equal(ticks.length, 10, 'one tick per 100 ms');
  });

  test('ramps at 60% of the perceptual range per second by default', () => {
    const { clock, ticks, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(1000);

    const total = ticks.reduce((sum, t) => sum + (t as { delta: number }).delta, 0);
    assert.ok(Math.abs(total - 0.6) < 1e-9, `expected ~0.6 over one second, got ${total}`);
  });

  test('a downward ramp emits negative deltas', () => {
    const { clock, ticks, engine } = harness();
    engine.start('down', 'brightness', -1);
    clock.advance(300);

    assert.ok(ticks.every(t => (t as { delta: number }).delta < 0));
  });

  test('normal stop on release', () => {
    const { clock, ticks, stops, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(500);
    engine.stop('up', 'released');
    const afterRelease = ticks.length;
    clock.advance(2000);

    assert.equal(ticks.length, afterRelease, 'no ticks after release');
    assert.deepEqual(stops, [{ controlId: 'up', reason: 'released' }]);
  });

  test('MISSING RELEASE still terminates at the 10 second hard stop', () => {
    const { clock, ticks, stops, engine } = harness();
    engine.start('up', 'brightness', 1);

    // The release never arrives — routine on Zigbee.
    clock.advance(60_000);

    assert.deepEqual(stops, [{ controlId: 'up', reason: 'hard_stop' }]);
    assert.equal(engine.activeCount, 0);
    assert.ok(ticks.length <= HARD_STOP_MS / TICK_MS,
      'must not emit a single tick beyond the hard stop');
  });

  test('the hard stop is not configurable', () => {
    // Constructing with any options must not change it.
    const { clock, stops, engine } = harness(5);
    engine.start('up', 'brightness', 1);
    clock.advance(HARD_STOP_MS - TICK_MS);
    assert.equal(stops.length, 0, 'still ramping just before the limit');

    clock.advance(TICK_MS * 2);
    assert.deepEqual(stops.map(s => s.reason), ['hard_stop']);
  });

  test('any other input from the same controller stops the ramp', () => {
    const { clock, stops, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(300);

    engine.stopAllExcept('down', 'other_input');

    assert.deepEqual(stops, [{ controlId: 'up', reason: 'other_input' }]);
    assert.equal(engine.activeCount, 0);
  });

  test('target unavailability stops the ramp', () => {
    const { clock, stops, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(200);
    engine.stopAll('target_unavailable');

    assert.deepEqual(stops.map(s => s.reason), ['target_unavailable']);
  });

  test('cancellation on uninit leaves nothing running', () => {
    const { clock, ticks, engine } = harness();
    engine.start('up', 'brightness', 1);
    engine.start('warm', 'temperature', -1);
    clock.advance(200);

    const stopped = engine.stopAll('shutdown');
    const before = ticks.length;
    clock.advance(5000);

    assert.equal(stopped, 2);
    assert.equal(engine.activeCount, 0);
    assert.equal(ticks.length, before, 'a light must never be left mid-ramp across a restart');
  });

  test('restarting a ramping control replaces it rather than stacking', () => {
    const { clock, ticks, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(300);
    engine.start('up', 'brightness', 1);
    const before = ticks.length;
    clock.advance(1000);

    assert.equal(engine.activeCount, 1);
    assert.equal(ticks.length - before, 10, 'exactly one ramp running, not two');
  });

  test('the hard stop clock restarts with the ramp', () => {
    const { clock, stops, engine } = harness();
    engine.start('up', 'brightness', 1);
    clock.advance(9000);
    engine.start('up', 'brightness', 1);
    clock.advance(9000);

    assert.equal(stops.length, 0, 'a re-held control gets a fresh 10 seconds');
    clock.advance(2000);
    assert.deepEqual(stops.map(s => s.reason), ['hard_stop']);
  });

  test('temperature ramps emit temperature intents', () => {
    const { clock, ticks, engine } = harness();
    engine.start('warm', 'temperature', -1);
    clock.advance(200);

    assert.ok(ticks.every(t => t.type === 'temperature_delta'));
  });
});

describe('when a hold may ramp at all (§5.5)', () => {
  const catalogue = [
    { controlId: 'up', action: 'press' },
    { controlId: 'up', action: 'long_press' },
    { controlId: 'up', action: 'release' },
    { controlId: 'left', action: 'press' },
    { controlId: 'left', action: 'long_press' },
    { controlId: 'dial', action: 'rotate_start' },
    { controlId: 'dial', action: 'rotate_stop' },
  ];

  test('a hold WITH a release may ramp', () => {
    assert.equal(canRamp('up', catalogue), true);
  });

  test('a hold WITHOUT a release may not — offer stepping instead', () => {
    assert.equal(canRamp('left', catalogue), false,
      'no reliable stop signal means no continuous ramp');
  });

  test('a rotation with a stop signal may ramp', () => {
    assert.equal(canRamp('dial', catalogue), true);
  });

  test('a control with no hold at all may not ramp', () => {
    assert.equal(canRamp('nonexistent', catalogue), false);
  });
});
