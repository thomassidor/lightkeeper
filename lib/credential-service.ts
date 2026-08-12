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
 * instead — the Danish strings exist in locales/da.json and were unreachable
 * for as long as the hint was the only thing the UI had.
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
    return this.succeed();
  }

  clearCredential(): void {
    this.options.settings.unset(SETTINGS_KEY);
    this.client = null;
    this.status = { present: false, valid: false };
    this.options.onStatusChange?.(this.getStatus());
  }

  /** The write client, built on demand. Throws with an actionable message. */
  async getWriteClient(): Promise<unknown> {
    if (this.client) return this.client;

    const token = this.token;
    if (!token) {
      const error = new Error('No API key stored — Light Link cannot create its Flows without one.');
      (error as { credentialFailure?: CredentialFailure }).credentialFailure = 'malformed';
      throw error;
    }

    this.client = await this.options.createWriteClient(await this.options.getLocalAddress(), token);
    return this.client;
  }

  /**
   * Report a failure seen during a real write. Drops the cached client so the
   * next attempt rebuilds it — a session can come back after a re-mint.
   */
  reportFailure(error: unknown): CredentialFailure {
    const failure = classifyCredentialError(error);
    if (failure !== 'unknown') {
      this.client = null;
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
