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
 */
export class FakeTimers implements Timers {
  private current: number;
  private nextId = 1;
  private readonly scheduled = new Map<number, Scheduled>();

  constructor(startAt = 0) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

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

  /** Jump the clock without firing anything — for "how long ago was that". */
  setNow(at: number): void {
    this.current = at;
  }

  get pending(): number {
    return [...this.scheduled.values()].filter(entry => !entry.cancelled).length;
  }
}
