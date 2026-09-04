import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { DaylightRuntime, type DaylightRuntimeDeps } from './daylight-runtime';
import type { DaylightPlan } from './daylight-types';
import type { DaylightEvaluator } from './daylight-evaluator';
import type { LuminanceSource } from './luminance-source';
import { fireAndForget } from '../support/async';
import { RuntimeRegistry } from '../runtime/runtime-registry';
import type { WriteRecord } from '../outputs/light-target-adapter';
import { messageOf } from '../support/homey-errors';

/**
 * Registry of live Daylight runtimes — the fifth of these, and the third that
 * owns a clock rather than delegating to the Flow engine.
 *
 * **Its own manager rather than a widening of `CircadianRuntimeManager`**, and
 * the case for that is worth stating because the two look alike. That manager
 * serves two device types with ONE runtime class because they genuinely are one
 * engine — a circadian light is a curve with four derived points. A Daylight
 * light is not a curve at all: it has no times in it, and what it reads is a
 * sensor and the sky. Sharing the manager would mean a registry holding two
 * unrelated runtime types and a `kind` that no longer told a reader which class
 * they had.
 *
 * The cost is a second `homey.setInterval` at 60 s, which is nothing, and the
 * benefit is that "one timer for every device of this kind on the Homey" stays
 * literally true of both.
 *
 * **There is no credential leg**, for the same reason as the curve types:
 * nothing here writes Flows, so no `onCredentialChange`, no `needs_credential`,
 * and no reason for app.ts to notify it when a key comes or goes (platform §12).
 */

export interface DaylightManagerDeps {
  /** @see WriteRecord — one app-wide log of every write by ANY runtime. */
  onWriteResult?: (entry: WriteRecord) => void;
  api: HomeyApiService;
  catalog: DeviceCatalog;
  /** Sun position and sensor readings. Shared with the schedule and curve managers. */
  daylight: DaylightEvaluator;
  luminance: LuminanceSource;
  /** `homey.setInterval` in the app; a stub in the tests, which drive tickAll(). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log: (...args: unknown[]) => void;
}

/**
 * Once a minute, the same as the curve tick and for a different reason.
 *
 * A curve ticks at 60 s because that is finer than its own resolution can use. A
 * response ticks at 60 s because that is the rate its two dampers are sized
 * against: `MAX_STEP_PER_TICK` is a step per tick, so the pair of them describe
 * a fade of about a minute and a half across the whole brightness axis. Change
 * this and the slew rate changes with it.
 *
 * The tick is cheap either way — it reads the cache and a cached sensor value,
 * not the Homey.
 */
export const TICK_MS = 60_000;

/** Distinguishes concurrent preview runtimes. See `ephemeral()`. */
let previewSeq = 0;

export class DaylightRuntimeManager {
  /** See RuntimeRegistry: the Map, its ordering rules and the coalescer. */
  private readonly registry: RuntimeRegistry<DaylightRuntime>;
  private ticker: unknown = null;

  constructor(private readonly deps: DaylightManagerDeps) {
    this.registry = new RuntimeRegistry({ log: deps.log, label: 'daylight' });
  }

  async register(
    controllerId: string,
    plan: DaylightPlan,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    _onPlanChange: (plan: DaylightPlan) => Promise<void> = async () => { },
    displayName: () => string = () => 'daylight',
  ): Promise<DaylightRuntime> {
    /**
     * `onPlanChange` is accepted and deliberately unused, so that the shape
     * matches `DeviceRegistry` and the device layer needs no adapter.
     *
     * A circadian light really does write its own plan back — pre-staging
     * disables itself and persists that. A Daylight light has no verdict of that
     * kind to record: it never pre-stages, so there is nothing it can learn
     * about the household that it would be wrong to forget on a restart.
     */
    const runtime = await this.registry.register(controllerId, async () => {
      const built = new DaylightRuntime(controllerId, plan, {
        ...this.baseDeps(),
        displayName,
        onStateChange,
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
   * A runtime that is never registered — it exists so the daylight screen can
   * drive real lights before anything is saved. Callers must stop it.
   */
  async ephemeral(plan: DaylightPlan): Promise<DaylightRuntime> {
    /**
     * A unique id rather than a fixed `__test__`, because the id is this
     * runtime's claim on the shared, ref-counted sensor service. Two people on
     * two phones previewing at once under one id would release each other's
     * sensors on the first `stop()`, and the second screen would quietly start
     * showing the sky instead of the room.
     */
    const runtime = new DaylightRuntime(`__preview-${previewSeq += 1}__`, plan, {
      ...this.baseDeps(),
      displayName: () => 'test',
      onStateChange: () => { /* a test rig has no health state */ },
    });
    // Deliberately idle: the screen decides when to touch someone's lights, not
    // the act of opening it.
    await runtime.startIdle();
    return runtime;
  }

  private baseDeps(): Omit<DaylightRuntimeDeps, 'onStateChange' | 'displayName'> {
    return {
      api: this.deps.api,
      catalog: this.deps.catalog,
      daylight: this.deps.daylight,
      luminance: this.deps.luminance,
      ...(this.deps.onWriteResult ? { onWriteResult: this.deps.onWriteResult } : {}),
      log: this.deps.log,
    };
  }

  /** One timer for every Daylight light, started with the first of them. */
  private startTicking(): void {
    if (this.ticker !== null || this.registry.size === 0) return;
    const start = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.ticker = start(() => fireAndForget(this.tickAll(), this.deps.log, 'Daylight tick'), TICK_MS);
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
        // One device's failure must never stop the others'.
        this.deps.log('Daylight tick failed:', messageOf(error));
      }
    }
  }

  async unregister(controllerId: string): Promise<void> {
    await this.registry.unregister(controllerId);
    // One timer for every Daylight light on the Homey, so the last one out
    // turns it off.
    if (this.registry.size === 0) this.stopTicking();
  }

  get(controllerId: string): DaylightRuntime | undefined {
    return this.registry.get(controllerId);
  }

  all(): DaylightRuntime[] {
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
