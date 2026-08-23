import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SupersedeGate, contestedControls } from '../../lib/mapping/supersede-gate';
import type { InputAction, InputEvent } from '../../lib/inputs/input-event';

/** Controllable clock so the 250 ms window is exercised without waiting. */
class FakeClock {
  private seq = 0;
  private timers = new Map<number, { fn: () => void; at: number }>();
  private now = 0;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }
}

const event = (controlId: string, action: InputAction): InputEvent => ({
  sourceDeviceId: 'src',
  controlId,
  controlLabel: controlId,
  action,
  provenance: 'flow_fixed',
  timestamp: 0,
});

function harness(contested: string[]) {
  const clock = new FakeClock();
  const dispatched: InputEvent[] = [];
  const gate = new SupersedeGate({
    supersedeMs: 250,
    contestedControlIds: new Set(contested),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }, e => dispatched.push(e));
  return { clock, dispatched, gate };
}

describe('supersede gate', () => {
  test('press alone executes after the window', () => {
    const { clock, dispatched, gate } = harness(['up']);
    gate.submit(event('up', 'press'));

    // Length, not deepEqual against []: a deep-equal against an empty literal
    // narrows `dispatched` to never[] and the next assertion stops compiling.
    assert.equal(dispatched.length, 0, 'must not fire immediately on a contested control');
    clock.advance(250);
    assert.deepEqual(dispatched.map(e => e.action), ['press']);
  });

  test('hold alone executes immediately', () => {
    const { dispatched, gate } = harness(['up']);
    gate.submit(event('up', 'long_press'));
    assert.deepEqual(dispatched.map(e => e.action), ['long_press']);
  });

  test('press then hold INSIDE the window cancels the press — the STYRBAR fix', () => {
    const { clock, dispatched, gate } = harness(['up']);
    gate.submit(event('up', 'press'));
    clock.advance(100);
    gate.submit(event('up', 'long_press'));
    clock.advance(500);

    assert.deepEqual(dispatched.map(e => e.action), ['long_press'],
      'holding to dim must not also toggle the light');
  });

  test('press then hold OUTSIDE the window fires both', () => {
    const { clock, dispatched, gate } = harness(['up']);
    gate.submit(event('up', 'press'));
    clock.advance(300);
    gate.submit(event('up', 'long_press'));

    assert.deepEqual(dispatched.map(e => e.action), ['press', 'long_press']);
  });

  test('zero added latency when a control has only one mapping', () => {
    const { dispatched, gate } = harness([]);
    const held = gate.submit(event('right', 'press'));

    assert.equal(held, false);
    assert.deepEqual(dispatched.map(e => e.action), ['press'],
      'uncontested controls must dispatch synchronously');
  });

  test('a hold on one control does not cancel a press on another', () => {
    const { clock, dispatched, gate } = harness(['up', 'down']);
    gate.submit(event('up', 'press'));
    gate.submit(event('down', 'long_press'));
    clock.advance(250);

    assert.deepEqual(dispatched.map(e => `${e.controlId}:${e.action}`),
      ['down:long_press', 'up:press']);
  });

  test('cancelAll drops everything in flight', () => {
    const { clock, dispatched, gate } = harness(['up']);
    gate.submit(event('up', 'press'));
    gate.cancelAll();
    clock.advance(500);

    assert.deepEqual(dispatched, []);
    assert.equal(gate.pendingCount, 0);
  });

  test('a repeated press replaces the pending one rather than queuing two', () => {
    const { clock, dispatched, gate } = harness(['up']);
    gate.submit(event('up', 'press'));
    clock.advance(100);
    gate.submit(event('up', 'press'));
    clock.advance(250);

    assert.equal(dispatched.length, 1);
  });
});

describe('contestedControls', () => {
  test('identifies only controls carrying both a discrete and a hold mapping', () => {
    const contested = contestedControls([
      { controlId: 'up', action: 'press' },
      { controlId: 'up', action: 'long_press' },
      { controlId: 'down', action: 'press' },
      { controlId: 'left', action: 'long_press' },
    ]);
    assert.deepEqual([...contested], ['up']);
  });

  test('is empty when no control carries both — the common case', () => {
    const contested = contestedControls([
      { controlId: 'on', action: 'press' },
      { controlId: 'off', action: 'press' },
    ]);
    assert.equal(contested.size, 0);
  });
});
