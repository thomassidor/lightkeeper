import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { CircadianRuntime, type CircadianRuntimeDeps } from './circadian-runtime';
import type { CircadianPlan } from './circadian-types';
import { fireAndForget } from '../support/async';
import { RuntimeRegistry } from '../runtime/runtime-registry';
import type { WriteRecord } from '../outputs/light-target-adapter';

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
  /**
   * One app-wide log of every write attempted by ANY runtime.
   *
   * Optional so the pairing screen's ephemeral rigs (which have no app) still
   * work unchanged. Its consumer is the settings page: "did anything reach a
   * light" is a question about the whole Homey, and answering it from the
   * FIRST controller's log — which is what api.ts did — made it permanently
   * empty for a household that runs only schedules, and permanently
   * misleading for one that runs both.
   */
  onWriteResult?: (entry: WriteRecord) => void;
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
  /** See RuntimeRegistry: the Map, its ordering rules and the coalescer. */
  private readonly registry: RuntimeRegistry<CircadianRuntime>;
  private ticker: unknown = null;

  constructor(private readonly deps: CircadianManagerDeps) {
    this.registry = new RuntimeRegistry({ log: deps.log, label: 'circadian' });
  }

  async register(
    controllerId: string,
    plan: CircadianPlan,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    onPlanChange: (plan: CircadianPlan) => Promise<void> = async () => { },
    displayName: () => string = () => 'circadian',
    kind: 'circadian' | 'curve' = 'curve',
  ): Promise<CircadianRuntime> {
    const runtime = await this.registry.register(controllerId, async () => {
      const built = new CircadianRuntime(controllerId, plan, {
        ...this.baseDeps(),
        displayName,
        onStateChange,
        onPlanChange,
        kind,
      });
      await built.start();
      return built;
    });
    // After the insert, not before: the ticker's guard is "is anything
    // registered", and starting it around a register that then threw left a
    // timer running over an empty map.
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
      onPlanChange: async () => { /* ephemeral: nothing to persist */ },
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
      ...(this.deps.onWriteResult ? { onWriteResult: this.deps.onWriteResult } : {}),
      timezone: this.deps.timezone,
      log: this.deps.log,
    };
  }

  /** One timer for every circadian device, started with the first of them. */
  private startTicking(): void {
    if (this.ticker !== null || this.registry.size === 0) return;
    const start = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.ticker = start(() => fireAndForget(this.tickAll(), this.deps.log, 'Circadian tick'), TICK_MS);
  }

  private stopTicking(): void {
    if (this.ticker === null) return;
    const stop = this.deps.clearInterval ?? (handle => clearInterval(handle as NodeJS.Timeout));
    stop(this.ticker);
    this.ticker = null;
  }

  /** Public so tests advance the day without waiting on wall time. */
  async tickAll(): Promise<void> {
    for (const runtime of this.registry.all()) {
      try {
        await runtime.tick();
      } catch (error) {
        // One device's failure must never stop the others' day.
        this.deps.log('Circadian tick failed:', (error as Error)?.message);
      }
    }
  }

  async unregister(controllerId: string): Promise<void> {
    await this.registry.unregister(controllerId);
    // One timer for every circadian device on the Homey, so the last one out
    // turns it off.
    if (this.registry.size === 0) this.stopTicking();
  }

  get(controllerId: string): CircadianRuntime | undefined {
    return this.registry.get(controllerId);
  }

  all(): CircadianRuntime[] {
    return this.registry.all();
  }

  /** As with the other registries, this must NOT restart the runtimes. */
  async onCatalogChange(): Promise<void> {
    this.registry.onCatalogChange();
  }

  async destroyAll(): Promise<void> {
    this.stopTicking();
    return this.registry.destroyAll();
  }
}
