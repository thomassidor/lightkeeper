import { CredentialService, sanitizedWriteError } from './credential-service';
import { isTransportFailure, messageOf } from './support/homey-errors';

// homey-api ships JS with JSDoc rather than type declarations.

/**
 * The DEEP path, deliberately, and not `require('homey-api')`.
 *
 * The package index eagerly requires 218 modules — the whole Athom Cloud tree,
 * every one of whose classes loads its OpenAPI specification as a static class
 * field, so the JSON is parsed at import time whether or not anything calls it.
 * This path loads five, and `createAppAPI` / `createLocalAPI` require the local
 * V3 client themselves on first use. Measured at 0.5 MB of heap and 0.7 MB of
 * RSS, which is small next to the caches platform §15 is about, but free.
 *
 * Do not "tidy" this back to the package root.
 */
 
const HomeyAPI = require('homey-api/lib/HomeyAPI/HomeyAPI');

/**
 * Connect the named managers, one at a time, never failing the whole client.
 *
 * Managers connect individually; a top-level `connect()` does not cover them,
 * and `Flow.isBroken` refuses to run without `flow` + `flowtoken` connected.
 *
 * `onError` is a PARAMETER rather than a fixed policy because the two callers
 * genuinely disagree and both are right: the read client logs a degraded
 * manager, because the app will keep running on the ones that did connect and
 * somebody has to be able to see which did not; the write client swallows it,
 * because a write failure is reported by the write itself with a classified
 * credential verdict, and a second line about a manager would send the reader
 * to the wrong place.
 */
async function connectManagers(
  api: any,
  names: string[],
  onError?: (name: string, error: unknown) => void,
): Promise<void> {
  for (const name of names) {
    const manager = api[name];
    if (!manager || typeof manager.connect !== 'function') continue;
    try {
      await manager.connect();
    } catch (error) {
      onError?.(name, error);
    }
  }
}

/**
 * Owns BOTH API clients and every subscription made through them.
 *
 * These cannot be one client — see platform §1 for the evidence:
 *
 *   read client  — createAppAPI, the app's own token. Devices, zones,
 *                  capability subscriptions, setCapabilityValue, flow READS.
 *   write client — createLocalAPI with the user's Personal API Key.
 *                  Flow writes only; the app token is refused for these.
 *
 * The split bounds the blast radius: when the key dies, controllers keep
 * driving lights and only reconciliation degrades.
 */

export type Unsubscribe = () => Promise<void> | void;

export class HomeyApiService {
  private readApi: any = null;
  private connecting: Promise<any> | null = null;
  private readonly subscriptions = new Set<Unsubscribe>();

  constructor(
    private readonly homey: any,
    readonly credentials: CredentialService,
  ) {}

  /** The app-token client. Everything except flow writes. */
  async read(): Promise<any> {
    if (this.readApi) return this.readApi;
    if (this.connecting) return this.connecting;

    // `connecting` MUST be cleared on failure as well as success. Clearing it
    // only on the happy path leaves a rejected promise cached forever: one
    // transient failure at boot — a Homey still starting up — then poisons
    // every later read() with the same rejection, and nothing recovers short of
    // restarting the app. Every read path in the app funnels through here.
    const attempt = (async () => {
      const api = await this.createAppApi();
      // A manager that will not connect is degraded, not fatal — say so and
      // carry on with the ones that did.
      await connectManagers(api, ['devices', 'zones', 'flow', 'flowtoken'], (name, error) => {
        this.homey?.app?.error?.(`Could not connect manager "${name}":`, messageOf(error));
      });
      this.readApi = api;
      return api;
    })().finally(() => {
      // Only retract our own attempt: a later call may already have replaced it.
      if (this.connecting === attempt) this.connecting = null;
    });

    this.connecting = attempt;
    return attempt;
  }

  /**
   * The one call into `homey-api` for the read client. Separated so tests can
   * override it — the module is a CommonJS require with no injection point, and
   * the retry behaviour above is worth proving.
   */
  protected async createAppApi(): Promise<any> {
    return HomeyAPI.createAppAPI({ homey: this.homey });
  }

  /**
   * A read failed in a way that says the CLIENT is gone, not the request.
   *
   * The read client is cached for the app's lifetime, which is right for a
   * socket that stays up and wrong for one that does not: after a Homey restart
   * or a dropped websocket every later read failed identically, forever, and
   * nothing rebuilt it short of restarting the app. Dropping the cache is safe
   * because `read()` de-duplicates the rebuild.
   *
   * Deliberately narrow. A 4xx is the Homey answering — the client is fine and
   * the request was not — and invalidating on those would tear the socket down
   * and rebuild it on every not-found.
   */
  reportReadFailure(error: unknown): boolean {
    if (!isTransportFailure(error)) return false;
    if (!this.readApi && !this.connecting) return false;
    this.readApi = null;
    this.connecting = null;
    this.homey?.app?.log?.('Dropped the read client after a transport failure; it will be rebuilt');
    return true;
  }

  /** The API-key client. Flow writes only. Throws if no key is stored. */
  async write(): Promise<any> {
    return this.credentials.getWriteClient() as Promise<any>;
  }

  /**
   * Run a flow write, classifying credential failures so the health monitor
   * can distinguish "needs a new key" from "needs remapping".
   *
   * The failure is re-thrown SANITISED, never passed through. This is the only
   * place in the app where an error object has been anywhere near the API key,
   * and callers do log and display these messages: the bridge manager logs a
   * failed delete, and ControllerRuntime puts an unclassified message straight
   * into the device's unavailable text. An upstream error that quotes the request
   * back would carry the token into both. Do not "simplify" this to `throw error`.
   *
   * ACQUISITION is inside the boundary too. It used to sit above the `try`, so a
   * handshake that failed — the one place the token is actually handed to
   * `homey-api`, and therefore the likeliest error to quote it back — escaped
   * both the redaction and the classification, reaching the device's unavailable
   * text raw and leaving the credential status untouched.
   */
  async withWriteClient<T>(operation: (api: any) => Promise<T>): Promise<T> {
    try {
      const api = await this.write();
      const result = await operation(api);
      this.credentials.reportSuccess();
      return result;
    } catch (error) {
      this.credentials.reportFailure(error);
      throw sanitizedWriteError(error);
    }
  }

  /** Register a teardown so nothing leaks on stop or delete. */
  track(unsubscribe: Unsubscribe): Unsubscribe {
    this.subscriptions.add(unsubscribe);
    return async () => {
      this.subscriptions.delete(unsubscribe);
      await unsubscribe();
    };
  }

  async destroy(): Promise<void> {
    for (const unsubscribe of [...this.subscriptions]) {
      try {
        await unsubscribe();
      } catch { /* teardown is best effort */ }
    }
    this.subscriptions.clear();
    this.readApi = null;
    this.connecting = null;
  }

  static async createWriteClient(address: string, token: string): Promise<any> {
    const api = await HomeyAPI.createLocalAPI({ address, token });
    // No handler: reads still work, and the write path reports its own failures.
    await connectManagers(api, ['flow', 'flowtoken']);
    return api;
  }
}
