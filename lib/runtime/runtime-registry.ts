import { fireAndForget } from '../support/async';
import { withDefaults, type Timers } from '../support/timers';

/**
 * The Map, the coalescing timer and the teardown that all three runtime
 * managers had a copy of.
 *
 * Deliberately NOT a base class for the managers: what makes each of them its
 * own file is its domain glue — the controller's `dispatchWithReason` and
 * magnitude scaling, the schedule's memoised time-card lookup and credential
 * fan-out, the circadian ticker — and those have nothing in common. What they
 * DID have in common was four things, copied three times:
 *
 *  - a `Map<string, TRuntime>`, with the ordering rules that make it safe:
 *    start before inserting (a runtime whose `start()` threw is half-built and
 *    must not be dispatchable), remove before stopping (dispatch reads the map,
 *    and a runtime tearing down must not be handed another event);
 *  - a 500 ms trailing timer coalescing a burst of catalogue changes into one
 *    pass, which must NOT restart the runtimes — our own virtual devices are
 *    devices too, so persisting a profile emits `device.update` and lands back
 *    here; a restart per event stopped the scheduler between submit and flush
 *    and no light ever changed;
 *  - the same cancel-then-stop teardown;
 *  - the same `get`/`all`.
 *
 * Three copies meant every ordering fix had to be made three times, and the
 * start-before-insert rule had in fact drifted: the circadian manager also
 * started its ticker between the insert and the start.
 */

export interface RegisteredRuntime {
  stop(): Promise<void>;
  refreshTargets(): Promise<void>;
}

export interface RuntimeRegistryOptions {
  log: (...args: unknown[]) => void;
  /** What a coalesced catalogue change is about, for the log line. */
  label: string;
  timers?: Partial<Timers>;
}

/**
 * How long a burst of device or zone events is gathered before one refresh pass.
 *
 * Long enough that saving a profile — which emits `device.update` for our own
 * virtual device — does not cost a pass per light; short enough that a light
 * re-paired while the user watches is picked up before they give up on it.
 */
const CATALOG_COALESCE_MS = 500;

export class RuntimeRegistry<TRuntime extends RegisteredRuntime> {
  private readonly runtimes = new Map<string, TRuntime>();
  /** Held so shutdown can cancel a coalescing pass that has not fired yet. */
  private catalogChangeTimer: unknown = null;
  private readonly timers: Timers;

  constructor(private readonly options: RuntimeRegistryOptions) {
    this.timers = withDefaults(options.timers);
  }

  get size(): number {
    return this.runtimes.size;
  }

  get ids(): string[] {
    return [...this.runtimes.keys()];
  }

  get(id: string): TRuntime | undefined {
    return this.runtimes.get(id);
  }

  all(): TRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * Replace whatever was registered under `id` with the result of `build`.
   *
   * `build` must construct AND start. The runtime is inserted only once it
   * resolves, so a failed start never becomes dispatchable — and the caller's
   * rejection is passed straight through, because the device layer's rollback
   * depends on hearing about it.
   */
  async register(id: string, build: () => Promise<TRuntime>): Promise<TRuntime> {
    await this.unregister(id);
    const runtime = await build();
    this.runtimes.set(id, runtime);
    return runtime;
  }

  async unregister(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    // Remove BEFORE awaiting stop(): dispatch reads this map, and a runtime that
    // is tearing down must not be handed another event on the way out.
    this.runtimes.delete(id);
    await runtime.stop();
  }

  /**
   * Devices or zones changed — targets may need re-resolving.
   *
   * Coalesced, and it must NOT restart the runtimes. See the class comment for
   * the loop that caused.
   */
  onCatalogChange(): void {
    if (this.catalogChangeTimer !== null) return;

    this.catalogChangeTimer = this.timers.setTimeout(() => {
      this.catalogChangeTimer = null;
      fireAndForget(this.refreshAll(), this.options.log, `${this.options.label} target refresh`);
    }, CATALOG_COALESCE_MS);
  }

  private async refreshAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      try {
        await runtime.refreshTargets();
      } catch (error) {
        // One device's failure must not stop the others being re-resolved.
        this.options.log(
          `Failed to re-resolve ${this.options.label} targets:`, (error as Error)?.message,
        );
      }
    }
  }

  /**
   * Stop everything. Cancels a pending refresh first — it would otherwise
   * re-resolve targets against runtimes that are being torn down.
   *
   * `allSettled`, not a sequential loop: one runtime whose `stop()` rejects used
   * to abandon every runtime behind it in the map, leaving their subscriptions
   * and timers alive for the rest of the process's life. On shutdown that is the
   * whole point of the call.
   */
  async destroyAll(): Promise<void> {
    if (this.catalogChangeTimer !== null) {
      this.timers.clearTimeout(this.catalogChangeTimer);
      this.catalogChangeTimer = null;
    }

    const stopping = [...this.runtimes.values()].map(runtime => runtime.stop());
    this.runtimes.clear();

    for (const outcome of await Promise.allSettled(stopping)) {
      if (outcome.status === 'rejected') {
        this.options.log(
          `Stopping a ${this.options.label} runtime failed:`,
          (outcome.reason as Error)?.message ?? outcome.reason,
        );
      }
    }
  }
}
