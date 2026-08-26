/**
 * One shape for injected time.
 *
 * CommandScheduler, RampEngine, SupersedeGate and the circadian runtime each
 * grew their own `setTimeout`/`now` injection options, with different names and
 * different handle types, so a test helper written for one did not fit the
 * next. This is that shape, once.
 *
 * Handles are `unknown` on purpose: Node returns a Timeout object, the Homey
 * SDK's disposal-safe aliases return something else again, and nothing here
 * needs to look inside one.
 */
export interface Timers {
  // `this: void` throughout: these are routinely destructured or passed on as
  // bare functions (`timers.setTimeout` handed to a class that still takes the
  // old piecemeal options), so none of them may depend on its receiver.
  setTimeout(this: void, fn: () => void, ms: number): unknown;
  clearTimeout(this: void, handle: unknown): void;
  setInterval(this: void, fn: () => void, ms: number): unknown;
  clearInterval(this: void, handle: unknown): void;
  now(this: void): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

/**
 * Fill in whatever a caller did not override. Tests routinely stub one member
 * — a fake `now` with real timers is a normal combination — so a partial is
 * the expected input, not a degenerate case.
 */
export function withDefaults(partial?: Partial<Timers>): Timers {
  if (!partial) return realTimers;
  return {
    setTimeout: partial.setTimeout ?? realTimers.setTimeout,
    clearTimeout: partial.clearTimeout ?? realTimers.clearTimeout,
    setInterval: partial.setInterval ?? realTimers.setInterval,
    clearInterval: partial.clearInterval ?? realTimers.clearInterval,
    now: partial.now ?? realTimers.now,
  };
}
