/**
 * Two serialisation primitives, deliberately different.
 *
 * KeyedMutex is a plain per-key FIFO: every caller's work runs, in order.
 * That is what a read-then-create needs — "find the root folder, and create it
 * if it isn't there" is only safe if two callers cannot both read "absent".
 *
 * SingleFlight is NOT a promise cache. When reconciliation is asked to run
 * while it is already running, sharing the in-flight promise would return a
 * result computed against the OLD desired state — the caller asked precisely
 * because the state just changed. So a request arriving mid-run schedules
 * exactly one trailing re-run, however many arrive: the last run always sees
 * the latest state, and N overlapping requests cost at most two passes.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Chain off the settled state of the previous holder, never its rejection:
    // one caller's failure must not cancel the queue behind it.
    const result = previous.then(fn, fn);
    // The tail is the swallowed form, so an unawaited failure here is not an
    // unhandled rejection on top of the one the caller already sees.
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      // Only the current tail may clear the entry; a later caller has already
      // replaced it and is still queued.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get activeKeys(): number {
    return this.tails.size;
  }
}

interface Flight {
  running: Promise<unknown>;
  /** A request arrived mid-run; run once more when this one finishes. */
  rerunRequested: boolean;
  /** Resolvers waiting for a run that STARTS after they asked. */
  waiting: Array<{ resolve: (value: any) => void; reject: (error: unknown) => void }>;
}

export class SingleFlight {
  private readonly flights = new Map<string, Flight>();

  /**
   * Run `fn` for `key`, coalescing overlapping requests into one trailing
   * re-run. The returned promise settles with the result of a run that began
   * at or after the moment of the call — never with a result computed before
   * the caller asked.
   */
  coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const flight = this.flights.get(key);
    if (!flight) {
      return this.start(key, fn);
    }
    flight.rerunRequested = true;
    return new Promise<T>((resolve, reject) => {
      flight.waiting.push({ resolve, reject });
    });
  }

  private start<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const flight: Flight = { running: Promise.resolve(), rerunRequested: false, waiting: [] };
    this.flights.set(key, flight);

    const run = (async (): Promise<T> => {
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        // The waiters asked for a run that starts after they did, so a failure
        // of THIS run is not theirs — but only if another run is coming.
        const waiting = flight.waiting.splice(0, flight.waiting.length);
        const rerun = flight.rerunRequested;
        this.flights.delete(key);
        if (rerun && waiting.length > 0) {
          this.startTrailing(key, fn, waiting);
        } else {
          for (const waiter of waiting) waiter.reject(error);
        }
        throw error;
      }
      const waiting = flight.waiting.splice(0, flight.waiting.length);
      const rerun = flight.rerunRequested;
      this.flights.delete(key);
      if (rerun) {
        this.startTrailing(key, fn, waiting);
      }
      return result;
    })();

    flight.running = run.then(() => undefined, () => undefined);
    return run;
  }

  private startTrailing<T>(
    key: string,
    fn: () => Promise<T>,
    waiting: Array<{ resolve: (value: any) => void; reject: (error: unknown) => void }>,
  ): void {
    const trailing = this.start(key, fn);
    trailing.then(
      value => { for (const waiter of waiting) waiter.resolve(value); },
      error => { for (const waiter of waiting) waiter.reject(error); },
    );
  }

  get inFlight(): number {
    return this.flights.size;
  }
}
