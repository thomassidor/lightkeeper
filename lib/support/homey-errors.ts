/**
 * Reading a status out of an error that has crossed two boundaries.
 *
 * What `homey-api` throws is an `APIError` carrying a numeric `statusCode`
 * taken straight off the HTTP response (`lib/APIError.js`), with the server's
 * own text as the message — `404 Not Found: FlowCardAction with ID <x>` being
 * the one CLAUDE.md §3 records. So a status field really does exist and is the
 * first thing to read.
 *
 * The message match is not a fallback for tidiness. Between the client and us
 * sits `sanitizedWriteError()`, which rebuilds the error to keep the API key
 * out of it (I2). It carries `statusCode` forward deliberately — but an error
 * from anywhere else in the stack, or from a future client, may arrive with
 * only its text intact. Both routes are read, and both are tested.
 */

interface StatusCarrying {
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

/** The numeric HTTP status an error carries, if it carries one at all. */
export function statusOf(error: unknown): number | null {
  const err = error as StatusCarrying | undefined | null;
  if (!err) return null;
  for (const candidate of [err.statusCode, err.status, err.code]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    // `code` is a string on some paths ('404'), and Node's own errors put
    // things like 'ENOTFOUND' there — which must NOT read as a status.
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
  }
  return null;
}

/**
 * "The thing you asked about is not there."
 *
 * Used to make deletes idempotent: a Flow the user already removed by hand is
 * not a failed delete, it is a delete whose desired end state already holds.
 * The distinction matters because the caller counts failures and degrades on
 * them — a sweep that reports 12 failures because the user tidied up first
 * sends somebody looking for a broken API key.
 *
 * Deliberately NARROW. 401, 403 and every connectivity error stay failures:
 * those mean "we could not tell", and treating "we could not tell" as "it is
 * gone" is how a stale reference gets dropped while the Flow it names goes on
 * firing.
 */
export function isNotFound(error: unknown): boolean {
  if (statusOf(error) === 404) return true;

  const message = String((error as StatusCarrying | undefined)?.message ?? '');
  if (!message) return false;

  // `404 Not Found: <what>` is the shape the platform uses. The bare-word
  // match is anchored to avoid catching, say, "Not Found" inside a flow name
  // echoed back in some other error.
  return /(^|\D)404(\D|$)/.test(message) || /^not[ _-]?found\b/i.test(message.trim());
}
