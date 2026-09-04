/**
 * Reading a status out of an error that has crossed two boundaries.
 *
 * What `homey-api` throws is an `APIError` carrying a numeric `statusCode`
 * taken straight off the HTTP response (`lib/APIError.js`), with the server's
 * own text as the message — `404 Not Found: FlowCardAction with ID <x>` being
 * the one platform §3 records. So a status field really does exist and is the
 * first thing to read.
 *
 * The message match is not a fallback for tidiness. Between the client and us
 * sits `sanitizedWriteError()`, which rebuilds the error to keep the API key
 * out of it (CLAUDE.md's key-hygiene property). It carries `statusCode`
 * forward deliberately — but an error
 * from anywhere else in the stack, or from a future client, may arrive with
 * only its text intact. Both routes are read, and both are tested.
 *
 * **Both predicates have exactly ONE caller, by design.** `isNotFound` is used
 * only by `flow-bridge-manager.ts` and `isTransportFailure` only by
 * `homey-api-service.ts` — `light-target-adapter.ts` mentions the latter in a
 * comment explaining why it is the wrong instrument there. The narrowness in
 * each direction is the whole content of this module, and it is tested on its
 * own; one call site is not evidence it should be inlined into that call site.
 *
 * `messageOf` and `redactedMessage` below are the opposite case: 47 call sites
 * that each used to hand-roll the coercion.
 */

interface StatusCarrying {
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

/** The numeric HTTP status an error carries, if it carries one at all. */
function statusOf(error: unknown): number | null {
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

/**
 * "We could not reach the Homey", as distinct from "the Homey said no".
 *
 * The sibling of `isNotFound()` and the mirror of its caution: that one is
 * narrow because treating "we could not tell" as "it is gone" drops a reference
 * to a live Flow. This one is narrow because the opposite mistake — reading a
 * 404 or a 403 as a dead socket — throws away a working client and rebuilds it
 * on every application error the Homey reports.
 *
 * So: any HTTP status at all means the transport worked, whatever the status
 * says. Only a total absence of one, plus a message or a Node error code that
 * names a connection problem, counts.
 */
export function isTransportFailure(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (statusOf(error) !== null) return false;

  const err = error as StatusCarrying & { code?: unknown };
  const code = typeof err.code === 'string' ? err.code : '';
  // Node's own connection failures. ENOTFOUND and EAI_AGAIN are DNS, which
  // cannot happen against 127.0.0.1 but costs nothing to cover.
  if (/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)$/.test(code)) {
    return true;
  }

  const message = String(err.message ?? '');
  if (!message) return false;
  return /socket hang up|connection (?:reset|refused|closed|lost)|not connected|disconnected|network|timed? ?out|ECONN|EPIPE|ETIMEDOUT/i
    .test(message);
}

/**
 * Anything key-shaped, anywhere in a string. Whole keys first so a full key
 * collapses to one `<redacted>` rather than three.
 *
 * 20+ CONTIGUOUS hex characters cannot be a Homey id: those are UUIDs, whose
 * longest unbroken hex run is the 12-character final group. So the secret
 * segment can be matched on its own without eating device or flow ids out of
 * the very log lines that make a failure diagnosable.
 */
const KEY_MATERIAL = /[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{20,}|[0-9a-f]{20,}/gi;

/**
 * Scrub key material from text that is about to be logged or shown.
 *
 * Belt and braces behind `sanitizedWriteError()`. An upstream error can quote
 * the offending request back, token and all, and "the key is never logged" has
 * to hold for strings we did not author.
 *
 * It lives here rather than in `credential-service.ts` — which re-exports it,
 * so every existing importer is unaffected — because `redactedMessage()` below
 * needs it and `support/` must not come to depend on a service module.
 */
export function redactKeyMaterial(text: string): string {
  return text.replace(KEY_MATERIAL, '<redacted>');
}

/**
 * An error's message, as a string, whatever was actually thrown.
 *
 * A `catch` binds `unknown`, and a rejected promise can carry anything — a
 * string, `undefined`, a plain object. This was hand-rolled as
 * `(error as Error)?.message ?? '<fallback>'` at 48 sites across 27 files, with
 * the fallback wording differing between them for no reason anybody chose.
 *
 * NOT interchangeable with `redactedMessage()` below. Use this for an error
 * that has never been near the API key; use that one for anything on a write
 * path.
 */
export function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | undefined | null)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return String(error ?? 'unknown error');
}

/**
 * The same, scrubbed — for anything that has been near the API key.
 *
 * The pairing is deliberate and the choice between them is a real one: a write
 * error can echo the token back in its own message, so a log line on that path
 * must go through here. CLAUDE.md's key-hygiene property is what this holds up,
 * and `test/unit/diagnostics-redaction.test.ts` asserts it against serialised
 * output.
 */
export function redactedMessage(error: unknown): string {
  return redactKeyMaterial(messageOf(error));
}
