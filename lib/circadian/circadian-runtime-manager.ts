import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { CircadianRuntime, type CircadianRuntimeDeps } from './circadian-runtime';
import type { CircadianPlan } from './circadian-types';
import { fireAndForget } from '../support/async';

/**
 * Registry of live circadian runtimes — what ControllerRuntimeManager is for
 * remotes and ScheduleRuntimeManager is for schedules.
 *
 * Two things make it its own manager rather than a widening of either:
 *
 *  - **It owns the clock.** One `setInterval` for every circadian device on the
 *    Homey, not one per device. SDK v3 has no cron manager (CLAUDE.md §9), and
 *    `homey.setInterval` is its disposal-safe alias — which is the right tool
 *    HERE, where a schedule's is the Flow engine, because a curve has no
 *    boundaries: a missed tick is corrected by the next one, and a restart just
 *    resumes. Compiling Flows to express a smooth curve would put this device
 *    type back behind an API key for nothing.
 *  - **There is no credential leg.** Nothing here writes Flows, so no
 *    `onCredentialChange`, no `needs_credential`, and no reason for app.ts to
 *    notify it when a key comes or goes.
 */

export interface CircadianManagerDeps {
  api: HomeyApiService;
  catalog: DeviceCatalog;
  /** The Homey's IANA timezone. */
  timezone: () => string | undefined;
  /** `homey.setInterval` in the app; a stub in the tests, which drive tickAll(). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log: (...args: unknown[]) => void;
}

/**
 * Once a minute. The tick is cheap — it reads the cache, not the Homey — and the
 * write rate is set by the curve's own resolution rather than by this number:
 * across the steepest default segment a light is written to about every third
 * tick. Finer would not show; coarser would step visibly at dusk.
 */
export const TICK_MS = 60_000;

export class CircadianRuntimeManager {
  private readonly runtimes = new Map<string, CircadianRuntime>();
  private catalogChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: unknown = null;

  constructor(private readonly deps: CircadianManagerDeps) {}

  async register(
    controllerId: string,
    plan: CircadianPlan,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    onPlanChange: (plan: CircadianPlan) => void = () => { },
    displayName: () => string = () => 'circadian',
  ): Promise<CircadianRuntime> {
    await this.unregister(controllerId);

    const runtime = new CircadianRuntime(controllerId, plan, {
      ...this.baseDeps(),
      displayName,
      onStateChange,
      onPlanChange,
    });

    this.runtimes.set(controllerId, runtime);
    await runtime.start();
    this.startTicking();
    return runtime;
  }

  /**
   * A runtime that is never registered — it exists so the curve screen can drive
   * real lights before anything is saved. Callers must stop it.
   */
  async ephemeral(plan: CircadianPlan): Promise<CircadianRuntime> {
    const runtime = new CircadianRuntime('__test__', plan, {
      ...this.baseDeps(),
      displayName: () => 'test',
      onStateChange: () => { /* a test rig has no health state */ },
      onPlanChange: () => { /* ephemeral: nothing to persist */ },
    });
    // Deliberately idle: the screen decides when to touch someone's lights, not
    // the act of opening it.
    await runtime.startIdle();
    return runtime;
  }

  private baseDeps(): Omit<CircadianRuntimeDeps, 'onStateChange' | 'onPlanChange' | 'displayName'> {
    return {
      api: this.deps.api,
      catalog: this.deps.catalog,
      timezone: this.deps.timezone,
      log: this.deps.log,
    };
  }

  /** One timer for every circadian device, started with the first of them. */
  private startTicking(): void {
    if (this.ticker !== null || this.runtimes.size === 0) return;
    const start = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.ticker = start(() => void this.tickAll(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.ticker === null) return;
    const stop = this.deps.clearInterval ?? (handle => clearInterval(handle as NodeJS.Timeout));
    stop(this.ticker);
    this.ticker = null;
  }

  /** Public so tests advance the day without waiting on wall time. */
  async tickAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      try {
        await runtime.tick();
      } catch (error) {
        // One device's failure must never stop the others' day.
        this.deps.log('Circadian tick failed:', (error as Error)?.message);
      }
    }
  }

  async unregister(controllerId: string): Promise<void> {
    const runtime = this.runtimes.get(controllerId);
    if (!runtime) return;
    await runtime.stop();
    this.runtimes.delete(controllerId);
    if (this.runtimes.size === 0) this.stopTicking();
  }

  get(controllerId: string): CircadianRuntime | undefined {
    return this.runtimes.get(controllerId);
  }

  all(): CircadianRuntime[] {
    return [...this.runtimes.values()];
  }

  /** As with the other registries, this must NOT restart the runtimes. */
  async onCatalogChange(): Promise<void> {
    if (this.catalogChangeTimer !== null) return;

    this.catalogChangeTimer = setTimeout(() => {
      this.catalogChangeTimer = null;
      fireAndForget((async () => {
        for (const runtime of this.runtimes.values()) {
          try {
            await runtime.refreshTargets();
          } catch (error) {
            this.deps.log('Failed to re-resolve circadian targets:', (error as Error)?.message);
          }
        }
      })(), this.deps.log, 'Catalogue-change target refresh');
    }, 500);
  }

  async destroyAll(): Promise<void> {
    if (this.catalogChangeTimer !== null) {
      clearTimeout(this.catalogChangeTimer);
      this.catalogChangeTimer = null;
    }
    this.stopTicking();
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
    this.runtimes.clear();
  }
}
