/**
 * Everything the hardware pass has changed and not yet put back, in one place.
 *
 * The pass changes a household's Homey on purpose — it pulls the app's API key,
 * switches lamps off and on, retimes a schedule, hands a lamp a value by hand —
 * and every one of those used to be put back by the code that made it, on that
 * code's own success path. Which is exactly the path a Ctrl-C, a thrown
 * `homey-api` error or a timed-out socket does not take. `credential` was the
 * sharpest case: the key was deleted and restored with nothing between them but
 * straight-line code, so any throw in between left every controller and schedule
 * on the Homey — the household's own included — without a key, with only a
 * report line that never printed to say so.
 *
 * So each change registers its own undo HERE, the moment before it is made, and
 * releases it once it has been put back. Two things then run whatever is still
 * registered:
 *
 * - `main()`, after every command, whatever that command did — a command that
 *   threw has had its own `finally` blocks run and anything left over is run
 *   here, once;
 * - an interrupt (SIGINT, SIGTERM), which runs the whole stack, newest first,
 *   and then exits non-zero.
 *
 * Each entry runs AT MOST ONCE, however it is reached, because a restore that
 * runs twice is its own kind of change — a lamp switched back off twice is fine,
 * a schedule restored over a newer edit is not.
 *
 * Pure and dependency-free, so `test/unit/verify-hardware-logic.test.ts` can run
 * it against a fake process rather than a Homey.
 */

/**
 * @typedef {{ release: () => void, run: () => Promise<{ ran: boolean, ok?: boolean, error?: unknown }>, readonly pending: boolean }} UndoHandle
 * @typedef {{ label: string, ok: boolean, error?: unknown }} UndoOutcome
 */

export function createUndoStack() {
  /** @type {Array<{ id: number, label: string, run: () => Promise<unknown> }>} */
  const pending = [];
  let next = 1;

  /** @param {number} id */
  const take = (id) => {
    const index = pending.findIndex(entry => entry.id === id);
    if (index === -1) return null;
    return pending.splice(index, 1)[0] ?? null;
  };

  return {
    /** How many undos are still registered. */
    get size() { return pending.length; },

    /** What they are, newest last — for a message, never for logic. */
    labels() { return pending.map(entry => entry.label); },

    /**
     * Register an undo. Call it BEFORE the change it undoes: a change that
     * half-lands and then throws must still be undone.
     *
     * @param {string} label what it puts back, in words a report can print
     * @param {() => Promise<unknown>} run
     * @returns {UndoHandle}
     */
    push(label, run) {
      const id = next;
      next += 1;
      pending.push({ id, label, run });
      return {
        /** The change was put back by its own code — nothing left to do. */
        release() { take(id); },
        /** Put it back now, if nothing else has. */
        async run() {
          const entry = take(id);
          if (!entry) return { ran: false };
          try {
            await entry.run();
            return { ran: true, ok: true };
          } catch (error) {
            return { ran: true, ok: false, error };
          }
        },
        get pending() { return pending.some(entry => entry.id === id); },
      };
    },

    /**
     * Run everything still registered, newest first, each once. A failing undo
     * never stops the others — each is somebody's lamp or somebody's key.
     *
     * @returns {Promise<UndoOutcome[]>}
     */
    async runAll() {
      /** @type {UndoOutcome[]} */
      const outcomes = [];
      for (let entry = pending.pop(); entry; entry = pending.pop()) {
        try {
          await entry.run();
          outcomes.push({ label: entry.label, ok: true });
        } catch (error) {
          outcomes.push({ label: entry.label, ok: false, error });
        }
      }
      return outcomes;
    },
  };
}

/** The exit code a shell expects after each signal: 128 + the signal number. */
export const SIGNAL_EXIT_CODES = /** @type {const} */ ({ SIGINT: 130, SIGTERM: 143 });

/**
 * Run the undo stack once on an interrupt, then exit non-zero.
 *
 * The first signal starts the undo and says so; a SECOND signal while it is
 * running exits at once, because a person pressing Ctrl-C twice has decided the
 * undo is not worth waiting for, and a script that ignores them is worse than
 * one that leaves a lamp on. The undo is also bounded by `timeoutMs`, for the
 * same reason `connect()` bounds every socket: a Homey that has stopped
 * answering must not turn Ctrl-C into a hang.
 *
 * `proc` is injectable so the behaviour can be tested without a real signal.
 * The command that was running is NOT awaited — it cannot be cancelled from
 * here, and waiting for it is waiting for the thing that was interrupted. What
 * stops it doing more is `onInterrupt`, which the script uses to make its own
 * polling loop give up; the residual race is one in-flight request.
 *
 * @param {ReturnType<typeof createUndoStack>} stack
 * @param {{
 *   proc?: { once: (event: string, fn: () => void) => unknown, removeListener: (event: string, fn: () => void) => unknown, exit: (code: number) => void },
 *   log?: (message: string) => void,
 *   onInterrupt?: () => void,
 *   beforeExit?: (outcomes: UndoOutcome[]) => Promise<void> | void,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {() => void} uninstall
 */
export function installInterruptHandlers(stack, options = {}) {
  const proc = options.proc ?? process;
  const log = options.log ?? ((message) => console.error(message));
  const timeoutMs = options.timeoutMs ?? 90_000;
  let running = false;
  /**
   * The bound on the undo, shared so the forced exit can cancel it. Left armed,
   * it is the one thing still holding the event loop after a second Ctrl-C —
   * harmless on a real run, where `exit()` ends the process, and a 90-second
   * stall in any caller whose `exit` does not (the unit test's fake process).
   * @type {NodeJS.Timeout | undefined}
   */
  let timer;

  /** @type {Record<string, () => void>} */
  const handlers = {};

  for (const signal of /** @type {Array<keyof typeof SIGNAL_EXIT_CODES>} */ (['SIGINT', 'SIGTERM'])) {
    const code = SIGNAL_EXIT_CODES[signal];
    const handler = () => {
      if (running) {
        log(`\n${signal} again — exiting without finishing the undo.`
          + ' Anything listed above as not yet put back is yours to set by hand.');
        if (timer) clearTimeout(timer);
        proc.exit(code);
        return;
      }
      running = true;
      // Listen for the second one: `once` has just consumed this.
      proc.once(signal, handler);
      options.onInterrupt?.();

      const labels = stack.labels();
      log(`\n${signal}: stopping. Putting back ${labels.length} thing(s) this pass changed`
        + (labels.length ? `: ${[...labels].reverse().join('; ')}` : '')
        + ' — press Ctrl-C again to skip that.');

      const bounded = Promise.race([
        stack.runAll(),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);

      bounded.then(async (outcomes) => {
        if (timer) clearTimeout(timer);
        const done = /** @type {UndoOutcome[] | null} */ (outcomes);
        if (done === null) {
          log(`The undo did not finish within ${Math.round(timeoutMs / 1000)}s. Still not put back: `
            + `${stack.labels().join('; ') || 'nothing'}.`);
        } else {
          for (const outcome of done) {
            log(`  ${outcome.ok ? 'put back' : 'could NOT put back'}: ${outcome.label}`);
          }
        }
        try {
          await options.beforeExit?.(done ?? []);
        } finally {
          proc.exit(code);
        }
      });
    };
    handlers[signal] = handler;
    proc.once(signal, handler);
  }

  return () => {
    for (const [signal, handler] of Object.entries(handlers)) proc.removeListener(signal, handler);
  };
}
