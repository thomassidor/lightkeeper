import type { CatalogDevice } from '../device-catalog';
import type { HomeyApiService } from '../homey-api-service';
import { fireAndForget } from '../support/async';
import { messageOf } from '../support/homey-errors';

/**
 * Press a button on the remote, and we find it.
 *
 * **What this can and cannot hear, stated once.** A remote whose events arrive
 * as CAPABILITY changes can be heard directly: subscribe to the capability and
 * the press arrives. A remote that only speaks through its app's Flow trigger
 * cards cannot (platform §4) — hearing one would mean building a temporary Flow
 * per event and tearing it down again, which is a Flow write, which needs the
 * user's key, on a screen reached before the key is asked for.
 *
 * So this is an ACCELERANT and never the only path. Both screens that use it
 * keep the list one tap away throughout, and the countdown ends in "heard
 * nothing yet" rather than in a failure — because a silent battery remote and a
 * card-only remote are indistinguishable from here, and neither is a fault.
 *
 * It is bounded by construction: one listener at a time, a hard stop after
 * `WINDOW_MS`, and every subscription released on stop however stop is reached.
 * Without that, abandoning the screen would leave a subscription on every remote
 * in the house for as long as the app ran.
 */

/** Thirty seconds: long enough to walk to the remote, short enough to give up. */
export const WINDOW_MS = 30_000;

/**
 * The capabilities a press arrives on.
 *
 * Not every capability a remote has — a battery level is not a press. These are
 * the ones the four reference remotes actually fire (platform §7), and anything
 * outside the list would turn a low-battery report into a button press.
 */
const PRESS_CAPABILITIES = ['button', 'alarm_generic', 'dim', 'onoff', 'speaker_playing'];

export interface HeardPress {
  deviceId: string;
  name: string;
  /**
   * The event key, in the same shape the catalogue uses.
   *
   * So the buttons screen can match it to a row without a second lookup, and so
   * a gesture that cannot be heard here is visibly the same gesture that would
   * never have fired either — which makes this a diagnostic as much as a
   * convenience.
   */
  key: string;
}

type Unsubscribe = () => void | Promise<void>;

export interface PressListenerDeps {
  api: HomeyApiService;
  log: (...args: unknown[]) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class PressListener {
  private offs: Unsubscribe[] = [];
  private timer: unknown = null;
  private listening = false;

  constructor(private readonly deps: PressListenerDeps) {}

  /**
   * Listen across every candidate remote until one of them speaks.
   *
   * `onHeard` fires at most once: the first press wins and everything is torn
   * down immediately. A second press arriving in the same millisecond would
   * otherwise pick a different remote than the one the screen has already
   * navigated to.
   */
  async start(candidates: CatalogDevice[], onHeard: (press: HeardPress) => void): Promise<void> {
    await this.stop();
    this.listening = true;

    const api = await this.deps.api.read().catch(() => null);
    if (!api) {
      this.listening = false;
      return;
    }

    for (const candidate of candidates) {
      if (!this.listening) break;
      await this.watch(api, candidate, onHeard);
    }

    // A `stop()` that landed while the loop above was awaiting has already
    // drained `offs` and cleared the timer; arming a new one here would put a
    // live window on a listener that is not listening.
    if (!this.listening) return;

    const schedule = this.deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = schedule(() => {
      fireAndForget(this.stop(), this.deps.log, 'Stopping the press listener');
    }, WINDOW_MS);
  }

  private async watch(
    api: any,
    candidate: CatalogDevice,
    onHeard: (press: HeardPress) => void,
  ): Promise<void> {
    const capabilities = candidate.capabilities.filter(capability =>
      PRESS_CAPABILITIES.some(prefix => capability === prefix || capability.startsWith(`${prefix}.`)));
    if (capabilities.length === 0) return;

    let device: any;
    try {
      device = await api.devices.getDevice({ id: candidate.id });
    } catch (error) {
      // A remote that cannot be read is one this cannot hear, which is the same
      // outcome as a card-only remote and needs no different handling.
      this.deps.log(`Could not listen to ${candidate.name}:`, messageOf(error));
      return;
    }

    /**
     * Re-checked AFTER the await, which is the only place it can be.
     *
     * `stop()` swaps `this.offs` for a fresh array and drains the old one. A
     * stop landing during the `getDevice` above therefore drained an array this
     * call no longer holds, and the instances created below went into the NEW
     * one with nothing scheduled to drain it — live capability subscriptions on
     * a household's remotes, after the screen that wanted them had closed. The
     * class header promises "every subscription released on stop however stop
     * is reached"; the loop's own `if (!this.listening) break` guards the next
     * candidate, not the one already in flight.
     */
    if (!this.listening) return;

    for (const capability of capabilities) {
      try {
        const instance = device.makeCapabilityInstance(capability, (value: unknown) => {
          if (!this.listening) return;
          // The FIRST press wins, and everything stops before the callback runs
          // — so a screen that navigates on it cannot be navigated again.
          fireAndForget(this.stop(), this.deps.log, 'Stopping the press listener');
          onHeard({
            deviceId: candidate.id,
            name: candidate.name,
            key: `${capability}|${describe(value)}`,
          });
        });
        this.offs.push(this.deps.api.track(() => instance.destroy()));
      } catch (error) {
        this.deps.log(`Could not listen to ${candidate.name}.${capability}:`, messageOf(error));
      }
    }
  }

  /** Idempotent, and safe from inside a callback it is tearing down. */
  async stop(): Promise<void> {
    this.listening = false;
    if (this.timer !== null) {
      const cancel = this.deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as never));
      cancel(this.timer);
      this.timer = null;
    }

    const offs = this.offs;
    this.offs = [];
    for (const off of offs) {
      try {
        await off();
      } catch (error) {
        // A subscription that will not release is not a reason to leave the
        // others attached.
        this.deps.log('Releasing a press subscription failed:', messageOf(error));
      }
    }
  }
}

/**
 * What the value means, as the second half of an event key.
 *
 * A boolean press is `true`/`false`; a dial reports a number. Anything else is
 * stringified rather than refused, because the key only has to be STABLE — the
 * buttons screen matches it against the catalogue, and a key nothing matches
 * simply highlights no row.
 */
function describe(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return 'null';
  return String(value);
}
