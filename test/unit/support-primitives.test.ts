import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fireAndForget } from '../../lib/support/async';
import { BoundedLog } from '../../lib/support/bounded-log';
import { withDefaults, realTimers } from '../../lib/support/timers';
import { KeyedMutex, SingleFlight } from '../../lib/support/keyed-mutex';
import { deferred, settle } from '../support/deferred';
import { FakeTimers } from '../support/fake-timers';
import { failNth } from '../support/failing-nth';

describe('fireAndForget', () => {
  test('logs a rejection with its label', async () => {
    const lines: string[] = [];
    fireAndForget(Promise.reject(new Error('boom')), (...args) => lines.push(args.join(' ')), 'catalogue refresh');
    await settle(2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /catalogue refresh failed: boom/);
  });

  test('a resolving promise logs nothing', async () => {
    const lines: string[] = [];
    fireAndForget(Promise.resolve('fine'), (...args) => lines.push(args.join(' ')), 'label');
    await settle(2);
    assert.deepEqual(lines, []);
  });

  test('a non-Error rejection still logs', async () => {
    const lines: string[] = [];
    fireAndForget(Promise.reject('a string'), (...args) => lines.push(args.join(' ')), 'label');
    await settle(2);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /a string/);
  });
});

describe('BoundedLog', () => {
  test('entries are newest first', () => {
    const log = new BoundedLog<number>(10);
    log.add(1);
    log.add(2);
    log.add(3);
    assert.deepEqual([...log.entries()], [3, 2, 1]);
  });

  test('the cap drops the oldest', () => {
    const log = new BoundedLog<number>(3);
    for (let i = 1; i <= 5; i += 1) log.add(i);
    assert.deepEqual([...log.entries()], [5, 4, 3]);
    assert.equal(log.size, 3);
  });

  test('clear empties it', () => {
    const log = new BoundedLog<string>(3);
    log.add('a');
    log.clear();
    assert.deepEqual([...log.entries()], []);
  });
});

describe('Timers', () => {
  test('withDefaults fills only what is missing', () => {
    const now = () => 42;
    const timers = withDefaults({ now });
    assert.equal(timers.now(), 42);
    assert.equal(timers.setTimeout, realTimers.setTimeout);
  });

  test('withDefaults() with nothing is the real thing', () => {
    assert.equal(withDefaults(), realTimers);
  });

  test('the fake fires timeouts in due order', () => {
    const timers = new FakeTimers(1_000);
    const fired: string[] = [];
    timers.setTimeout(() => fired.push('late'), 100);
    timers.setTimeout(() => fired.push('early'), 10);
    timers.advance(50);
    assert.deepEqual(fired, ['early']);
    timers.advance(100);
    assert.deepEqual(fired, ['early', 'late']);
    assert.equal(timers.now(), 1_150);
  });

  test('a cleared timeout does not fire', () => {
    const timers = new FakeTimers();
    let fired = false;
    const handle = timers.setTimeout(() => { fired = true; }, 10);
    timers.clearTimeout(handle);
    timers.advance(100);
    assert.equal(fired, false);
    assert.equal(timers.pending, 0);
  });

  test('an interval repeats until cleared', () => {
    const timers = new FakeTimers();
    let ticks = 0;
    const handle = timers.setInterval(() => { ticks += 1; }, 60);
    timers.advance(200);
    assert.equal(ticks, 3);
    timers.clearInterval(handle);
    timers.advance(600);
    assert.equal(ticks, 3);
  });
});

describe('KeyedMutex', () => {
  test('runs one key in FIFO order under interleaving', async () => {
    const mutex = new KeyedMutex();
    const gateA = deferred();
    const order: string[] = [];

    const first = mutex.run('k', async () => {
      order.push('a:start');
      await gateA.promise;
      order.push('a:end');
    });
    const second = mutex.run('k', async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await settle();
    assert.deepEqual(order, ['a:start'], 'second must not start while the first holds the key');
    gateA.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  test('different keys do not block each other', async () => {
    const mutex = new KeyedMutex();
    const gate = deferred();
    const order: string[] = [];
    const held = mutex.run('one', async () => { order.push('one:start'); await gate.promise; });
    await mutex.run('two', async () => { order.push('two'); });
    assert.deepEqual(order, ['one:start', 'two']);
    gate.resolve();
    await held;
  });

  test('a failure does not cancel the queue behind it', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run('k', async () => { throw new Error('nope'); });
    const after = mutex.run('k', async () => 'ran anyway');
    await assert.rejects(failing, /nope/);
    assert.equal(await after, 'ran anyway');
  });

  test('the key is released once drained', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', async () => undefined);
    await settle(2);
    assert.equal(mutex.activeKeys, 0);
  });
});

describe('SingleFlight', () => {
  test('N overlapping requests cost at most one trailing re-run', async () => {
    const flight = new SingleFlight();
    const gate = deferred();
    let runs = 0;
    const work = async () => {
      runs += 1;
      if (runs === 1) await gate.promise;
      return runs;
    };

    const first = flight.coalesce('c', work);
    await settle();
    assert.equal(runs, 1);

    const overlapping = [flight.coalesce('c', work), flight.coalesce('c', work), flight.coalesce('c', work)];
    await settle();
    assert.equal(runs, 1, 'nothing runs while the first is in flight');

    gate.resolve();
    assert.equal(await first, 1);
    const results = await Promise.all(overlapping);
    assert.equal(runs, 2, 'three overlapping requests produced exactly one re-run');
    assert.deepEqual(results, [2, 2, 2], 'every waiter sees the fresh run, not the stale one');
  });

  test('a waiter never receives the in-flight (stale) result', async () => {
    const flight = new SingleFlight();
    const gate = deferred();
    let state = 'old';
    const work = async () => {
      const captured = state;
      if (captured === 'old') await gate.promise;
      return captured;
    };

    const first = flight.coalesce('c', work);
    await settle();
    state = 'new';
    const waiter = flight.coalesce('c', work);
    gate.resolve();
    assert.equal(await first, 'old');
    assert.equal(await waiter, 'new', 'the re-run read the state that arrived after the request');
  });

  test('sequential calls each run', async () => {
    const flight = new SingleFlight();
    let runs = 0;
    await flight.coalesce('c', async () => { runs += 1; });
    await flight.coalesce('c', async () => { runs += 1; });
    assert.equal(runs, 2);
    assert.equal(flight.inFlight, 0);
  });

  test('a failing run rejects its own caller but the trailing re-run still happens', async () => {
    const flight = new SingleFlight();
    const gate = deferred();
    let runs = 0;
    const work = async () => {
      runs += 1;
      if (runs === 1) {
        await gate.promise;
        throw new Error('first pass died');
      }
      return runs;
    };

    const first = flight.coalesce('c', work);
    await settle();
    const waiter = flight.coalesce('c', work);
    gate.resolve();
    await assert.rejects(first, /first pass died/);
    assert.equal(await waiter, 2, 'the re-run ran despite the first failing');
  });

  test('a failing run with no waiters rejects and clears', async () => {
    const flight = new SingleFlight();
    await assert.rejects(flight.coalesce('c', async () => { throw new Error('x'); }), /x/);
    assert.equal(flight.inFlight, 0);
  });

  test('different keys run concurrently', async () => {
    const flight = new SingleFlight();
    const gate = deferred();
    const order: string[] = [];
    const held = flight.coalesce('a', async () => { order.push('a'); await gate.promise; });
    await flight.coalesce('b', async () => { order.push('b'); });
    assert.deepEqual(order, ['a', 'b']);
    gate.resolve();
    await held;
  });
});

describe('failNth', () => {
  test('rejects only the nth call', async () => {
    const wrapped = failNth(async (x: number) => x * 2, 2, new Error('second'));
    assert.equal(await wrapped(1), 2);
    await assert.rejects(wrapped(2), /second/);
    assert.equal(await wrapped(3), 6);
    assert.equal(wrapped.calls, 3);
  });
});
