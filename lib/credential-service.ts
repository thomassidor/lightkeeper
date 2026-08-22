/**
 * Owns the Personal API Key that flow writes require.
 *
 * Exists because of a platform constraint: an app's OWN token is refused with
 * 403 Missing Scopes on every flow write, while a user-minted Personal API Key
 * succeeds, including from inside the app process. See CLAUDE.md.
 *
 * The key is never logged, never returned over the app API,
 * and never included in diagnostics or profile exports.
 */

export type CredentialFailure =
  /** The string is not a key at all — placeholder or truncated paste. */
  | 'malformed'
  /** Valid key string whose server-side session is gone. Re-mint. */
  | 'session_expired'
  /** Valid session without permission to write flows. Re-mint with Flow scope. */
  | 'insufficient_scope'
  /** Homey unreachable, or something we have not classified. */
  | 'unknown';

export interface CredentialStatus {
  present: boolean;
  valid: boolean;
  failure?: CredentialFailure;
  /** Safe to display: never the key itself. */
  hint?: string;
  lastCheckedAt?: number;
}

const SETTINGS_KEY = 'flowWriteApiKey';

/**
 * A Homey API Key is `<userId>:<sessionId>:<secret>` — the middle segment is
 * the session, which is why a key can die while the string is unchanged.
 */
const KEY_SHAPE = /^[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{20,}$/i;

export function looksLikeApiKey(token: string): boolean {
  return KEY_SHAPE.test(token.trim());
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
 */
export function redactKeyMaterial(text: string): string {
  return text.replace(KEY_MATERIAL, '<redacted>');
}

/**
 * Replace an error thrown by a flow WRITE with one that provably carries no key
 * material, keeping the classification callers act on.
 *
 * A classified credential failure becomes its own actionable sentence. Anything
 * unclassified keeps its original message, redacted: a genuine platform error —
 * `404 Not Found: FlowCardAction with ID <x>` is the one that costs hours — must
 * stay readable, and replacing it with "could not reach Homey" would send the
 * next person looking in the wrong place entirely.
 */
export function sanitizedWriteError(error: unknown): Error {
  const failure = classifyCredentialError(error);
  const original = String((error as { message?: string } | undefined)?.message ?? '');

  const sanitized = new Error(
    failure === 'unknown'
      ? redactKeyMaterial(original) || 'The flow write failed.'
      : describeFailure(failure),
  ) as Error & { credentialFailure: CredentialFailure; statusCode?: number };

  sanitized.credentialFailure = failure;
  const status = (error as { statusCode?: number } | undefined)?.statusCode;
  if (typeof status === 'number') sanitized.statusCode = status;

  return sanitized;
}

/**
 * Classify an error from a flow write. The three failures look alike and mean
 * completely different things; conflating them sends users to the wrong fix.
 */
export function classifyCredentialError(error: unknown): CredentialFailure {
  const err = error as { message?: string; statusCode?: number } | undefined;
  const message = String(err?.message ?? '');
  const status = err?.statusCode;

  if (/Missing Session ID/i.test(message)) return 'malformed';
  if (/Session Not Found/i.test(message)) return 'session_expired';
  if (/Missing Scopes/i.test(message)) return 'insufficient_scope';
  if (status === 401) return 'session_expired';
  if (status === 403) return 'insufficient_scope';
  return 'unknown';
}

/**
 * The locale key for a failure, so the UI can translate it.
 *
 * `describeFailure()` below returns English and is for logs, diagnostics and
 * as a last-resort fallback. Anything shown to a user should go through this
 * instead. The distinction outlives the app being English-only: the hint is a
 * sentence built in `lib/`, so it can never be translated, and for as long as
 * it was the only thing the UI had, every one of these failures reached the
 * user untranslatable.
 */
export function credentialFailureKey(failure?: CredentialFailure): string {
  switch (failure) {
    case 'malformed': return 'credential.malformed';
    case 'session_expired': return 'credential.expired';
    case 'insufficient_scope': return 'credential.noScope';
    case 'unknown': return 'credential.unreachable';
    default: return 'state.needsCredential';
  }
}

export function describeFailure(failure: CredentialFailure): string {
  switch (failure) {
    case 'malformed':
      return 'That does not look like a complete API key. Copy the whole key shown when you create it.';
    case 'session_expired':
      return 'The API key is no longer valid. Create a new one in the Homey Web App and enter it here.';
    case 'insufficient_scope':
      return 'The API key does not have permission to manage Flows. Create a new one with Flow permissions.';
    case 'unknown':
      return 'Could not reach Homey to check the API key. Try again in a moment.';
  }
}

export interface CredentialServiceOptions {
  settings: { get(key: string): unknown; set(key: string, value: unknown): void; unset(key: string): void };
  /** Injected so tests need no Homey. */
  createWriteClient: (address: string, token: string) => Promise<unknown>;
  getLocalAddress: () => Promise<string>;
  log: (...args: unknown[]) => void;
  onStatusChange?: (status: CredentialStatus) => void;
}

export class CredentialService {
  private client: unknown = null;
  /** The handshake in flight, so concurrent callers cannot start a second one. */
  private connecting: Promise<unknown> | null = null;
  private status: CredentialStatus = { present: false, valid: false };

  constructor(private readonly options: CredentialServiceOptions) {
    this.status.present = Boolean(this.token);
  }

  private get token(): string | null {
    const raw = this.options.settings.get(SETTINGS_KEY);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }

  getStatus(): CredentialStatus {
    return { ...this.status };
  }

  /**
   * Re-check a stored key after a restart.
   *
   * Without this, a working key reports valid:false on every app start, because
   * `valid` was only ever set by setCredential() in the same session — so the
   * pairing flow asked for a key the user had already given.
   *
   * Validation performs a real write, for the same reason setCredential does:
   * a read succeeds on credentials that cannot write.
   */
  async revalidate(validate: (client: unknown) => Promise<void>): Promise<CredentialStatus> {
    if (!this.token) {
      this.status = { present: false, valid: false };
      return this.getStatus();
    }

    try {
      const client = await this.getWriteClient();
      await validate(client);
      return this.succeed();
    } catch (error) {
      const failure = classifyCredentialError(error);
      this.options.log(`Stored API key is not usable: ${failure}`);
      this.client = null;
      return this.fail(failure);
    }
  }

  hasCredential(): boolean {
    return this.token !== null;
  }

  /**
   * Store a key after proving it can WRITE. Validating with a read is not
   * enough: reads succeed on credentials that cannot write, so a read-based
   * check gives false confidence.
   */
  async setCredential(rawToken: string, validate: (client: unknown) => Promise<void>): Promise<CredentialStatus> {
    const token = rawToken.trim();

    if (!looksLikeApiKey(token)) {
      return this.fail('malformed');
    }

    let client: unknown;
    try {
      client = await this.options.createWriteClient(await this.options.getLocalAddress(), token);
      await validate(client);
    } catch (error) {
      // Deliberately not logging the error object — it can echo the token back.
      const failure = classifyCredentialError(error);
      this.options.log(`API key rejected: ${failure}`);
      return this.fail(failure);
    }

    this.options.settings.set(SETTINGS_KEY, token);
    this.client = client;
    // Any handshake still in flight belongs to the previous key.
    this.connecting = null;
    return this.succeed();
  }

  clearCredential(): void {
    this.options.settings.unset(SETTINGS_KEY);
    this.client = null;
    this.connecting = null;
    this.status = { present: false, valid: false };
    this.options.onStatusChange?.(this.getStatus());
  }

  /**
   * The write client, built on demand. Throws with an actionable message.
   *
   * Concurrent callers MUST share one handshake. A key appears to hold a single
   * live session (CLAUDE.md §2): a second `createLocalAPI` claims or replaces it,
   * invalidating the first holder. At boot the app's own revalidation races every
   * controller's first reconcile, so an unguarded build here is two handshakes on
   * the same key — which presents as a key that "randomly" stops working minutes
   * after it was accepted.
   */
  async getWriteClient(): Promise<unknown> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const token = this.token;
    if (!token) {
      const error = new Error('No API key stored — Lightkeeper cannot create its Flows without one.');
      (error as { credentialFailure?: CredentialFailure }).credentialFailure = 'malformed';
      throw error;
    }

    // Cleared on failure as well as success: caching a rejected promise would
    // poison every later write until the app restarts.
    const attempt = (async () => {
      const client = await this.options.createWriteClient(await this.options.getLocalAddress(), token);
      // A key cleared or replaced while this handshake was in flight must not be
      // resurrected by it.
      if (this.token !== token) throw new Error('The API key changed while connecting.');
      this.client = client;
      return client;
    })().finally(() => {
      // Only retract our own attempt: a later call may already have replaced it.
      if (this.connecting === attempt) this.connecting = null;
    });

    this.connecting = attempt;
    return attempt;
  }

  /**
   * Report a failure seen during a real write. Drops the cached client so the
   * next attempt rebuilds it — a session can come back after a re-mint.
   */
  reportFailure(error: unknown): CredentialFailure {
    const failure = classifyCredentialError(error);
    if (failure !== 'unknown') {
      this.client = null;
      this.connecting = null;
      this.status = {
        present: this.token !== null,
        valid: false,
        failure,
        hint: describeFailure(failure),
        lastCheckedAt: Date.now(),
      };
      this.options.onStatusChange?.(this.getStatus());
    }
    return failure;
  }

  reportSuccess(): void {
    if (this.status.valid) return;
    this.succeed();
  }

  private succeed(): CredentialStatus {
    this.status = { present: true, valid: true, lastCheckedAt: Date.now() };
    this.options.onStatusChange?.(this.getStatus());
    return this.getStatus();
  }

  private fail(failure: CredentialFailure): CredentialStatus {
    this.status = {
      present: this.token !== null,
      valid: false,
      failure,
      hint: describeFailure(failure),
      lastCheckedAt: Date.now(),
    };
    this.options.onStatusChange?.(this.getStatus());
    return this.getStatus();
  }
}
