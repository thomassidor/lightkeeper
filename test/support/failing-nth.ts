/**
 * Pass calls through, reject the Nth (1-based).
 *
 * The fault matrix in Phases 1-3 is almost entirely "the third of five writes
 * fails" — mid-sequence, not first, because first-call failures are the case
 * every implementation already handles.
 */
export function failNth<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  n: number,
  error: Error,
): ((...args: A) => Promise<R>) & { calls: number } {
  let calls = 0;
  const wrapped = async (...args: A): Promise<R> => {
    calls += 1;
    wrapped.calls = calls;
    if (calls === n) throw error;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}

/** Reject every call after the Nth (inclusive) — for "the key died mid-pass". */
export function failFrom<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  n: number,
  error: Error,
): ((...args: A) => Promise<R>) & { calls: number } {
  let calls = 0;
  const wrapped = async (...args: A): Promise<R> => {
    calls += 1;
    wrapped.calls = calls;
    if (calls >= n) throw error;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}
