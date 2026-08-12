import { CredentialService, sanitizedWriteError } from './credential-service';

// homey-api ships JS with JSDoc rather than type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');

/**
 * Owns BOTH API clients and every subscription made through them.
 *
 * These cannot be one client — see CLAUDE.md for the evidence:
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
      // Managers connect individually; a top-level connect does not cover them,
      // and Flow.isBroken refuses to run without flow + flowtoken connected.
      for (const name of ['devices', 'zones', 'flow', 'flowtoken']) {
        const manager = api[name];
        if (manager && typeof manager.connect === 'function') {
          try {
            await manager.connect();
          } catch (error) {
            // A manager that will not connect is degraded, not fatal — say so
            // and carry on with the ones that did.
            this.homey?.app?.error?.(
              `Could not connect manager "${name}":`, (error as Error)?.message,
            );
          }
        }
      }
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
   */
  async withWriteClient<T>(operation: (api: any) => Promise<T>): Promise<T> {
    const api = await this.write();
    try {
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

  /** Inside an app this is http://127.0.0.1:80 — no LAN discovery needed. */
  async localAddress(): Promise<string> {
    return this.homey.api.getLocalUrl();
  }

  static async createWriteClient(address: string, token: string): Promise<any> {
    const api = await HomeyAPI.createLocalAPI({ address, token });
    for (const name of ['flow', 'flowtoken']) {
      if (api[name] && typeof api[name].connect === 'function') {
        try {
          await api[name].connect();
        } catch { /* reads still work; the write path reports its own failures */ }
      }
    }
    return api;
  }
}
