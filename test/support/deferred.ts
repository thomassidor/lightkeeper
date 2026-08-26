/**
 * A promise whose settlement the test controls.
 *
 * The whole of Phases 1-3 turns on "what happens while an await is still
 * pending" — an overlapping reconcile, a stop() during a flush, a second
 * handshake against an in-flight one. That window only exists if the test can
 * hold it open.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask and timer-0 callback run. */
export async function settle(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
