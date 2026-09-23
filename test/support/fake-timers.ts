import type { Timers } from '../../lib/support/timers';

interface Scheduled {
  id: number;
  fn: () => void;
  dueAt: number;
  everyMs: number | null;
  cancelled: boolean;
}

/**
 * A manual-advance Timers implementation.
 *
 * Deliberately compatible with the piecemeal injection the existing classes
 * already accept (`setTimeout`/`clearTimeout`/`now` as separate options), so a
 * test can pass `timers.setTimeout` to a class that has not been migrated to
 * the Timers interface yet.
 *
 * Three suites used to carry a private clock each instead, and all three got
 * time wrong in ways that could only ever make a test pass: two fired due
 * timers in INSERTION order rather than due order, and never fired a timer
 * that a firing timer had armed within the same advance; the third ignored
 * `clearTimeout` altogether, so a cancelled check still ran. This one fires in
 * due order (ties by arming order), sees timers armed during an advance, and
 * honours cancellation — so a test that depended on any of those three errors
 * fails here rather than passing by accident.
 */
export class FakeTimers implements Timers {
  private current: number;
  private nextId = 1;
  private readonly scheduled = new Map<number, Scheduled>();

  constructor(startAt = 0) {
    this.current = startAt;
  }

  // An arrow, like the rest: `Timers` says `this: void`, and `now` is the
  // member most often handed on bare (`now: timers.now`).
  now = (): number => this.current;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.scheduled.set(id, { id, fn, dueAt: this.current + Math.max(0, ms), everyMs: null, cancelled: false });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    const entry = this.scheduled.get(handle as number);
    if (entry) entry.cancelled = true;
    this.scheduled.delete(handle as number);
  };

  setInterval = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    const every = Math.max(1, ms);
    this.scheduled.set(id, { id, fn, dueAt: this.current + every, everyMs: every, cancelled: false });
    return id;
  };

  clearInterval = (handle: unknown): void => {
    this.clearTimeout(handle);
  };

  /** Move the clock forward, firing everything that comes due, in due order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.scheduled.values()]
        .filter(entry => !entry.cancelled && entry.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.current = next.dueAt;
      if (next.everyMs === null) {
        this.scheduled.delete(next.id);
      } else {
        next.dueAt = this.current + next.everyMs;
      }
      next.fn();
    }
    this.current = target;
  }

  /**
   * `advance()` for code that re-arms from a CONTINUATION rather than from the
   * callback itself.
   *
   * A scheduler that awaits a write and then arms its next slot does so a few
   * microtasks after the timer fired, which a synchronous `advance()` has
   * already walked past. This fires one timer at a time and lets promises
   * settle after each, so whatever those continuations arm is due-checked in
   * the same advance, at the right point on the clock.
   */
  async advanceAsync(ms: number): Promise<void> {
    const target = this.current + ms;
    await settleMicrotasks();
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.current = next.dueAt;
      if (next.everyMs === null) this.scheduled.delete(next.id);
      else next.dueAt = this.current + next.everyMs;
      next.fn();
      await settleMicrotasks();
    }
    this.current = target;
  }

  /**
   * Fire every timer pending NOW, in due order, without moving the clock.
   *
   * For a suite that controls the wall clock separately (`setNow`) and asks
   * "run whatever post-write checks are outstanding" as its own step. Cancelled
   * timers do not fire; intervals fire once and stay armed; timers armed by
   * these callbacks wait for the next call, because "what was pending" is the
   * question being asked.
   */
  runPending(): void {
    const pending = [...this.scheduled.values()]
      .filter(entry => !entry.cancelled)
      .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    for (const entry of pending) {
      if (entry.cancelled || !this.scheduled.has(entry.id)) continue;
      if (entry.everyMs === null) this.scheduled.delete(entry.id);
      else entry.dueAt = this.current + entry.everyMs;
      entry.fn();
    }
  }

  private nextDue(target: number): Scheduled | undefined {
    return [...this.scheduled.values()]
      .filter(entry => !entry.cancelled && entry.dueAt <= target)
      .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
  }

  /** Jump the clock without firing anything — for "how long ago was that". */
  setNow(at: number): void {
    this.current = at;
  }

  get pending(): number {
    return [...this.scheduled.values()].filter(entry => !entry.cancelled).length;
  }
}

/** Let queued promise continuations run — a few turns, because they chain. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
