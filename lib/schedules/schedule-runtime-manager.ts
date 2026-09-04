import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { DaylightEvaluator } from '../daylight/daylight-evaluator';
import { FlowCardCatalogue } from '../flow-card-catalogue';
import type { FlowBridgeManager } from '../bridge/flow-bridge-manager';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { ScheduleRuntime, type ScheduleRuntimeDeps } from './schedule-runtime';
import { discoverTimeCard, type TimeCardDiscovery } from './time-card-discovery';
import type { SchedulePlan } from './schedule-types';
import { RuntimeRegistry } from '../runtime/runtime-registry';
import type { WriteRecord } from '../outputs/light-target-adapter';
import { messageOf } from '../support/homey-errors';

/**
 * Registry of live schedule runtimes — the schedule half of what
 * ControllerRuntimeManager is for remotes.
 *
 * Kept as its own manager rather than widened into that one: its dispatch
 * semantics are different (a boundary key, no magnitude, a day check), it needs
 * neither source discovery nor the mapping catalogue, and the shared behaviour
 * amounts to a Map and a 500 ms coalescing timer. The two do have to agree on one
 * thing, and it is enforced in api.ts rather than here: the orphan sweep's "live
 * controller" set must be the UNION of both registries, or the first sweep after
 * this feature shipped would delete every schedule's Flows.
 */

export interface ScheduleManagerDeps {
  /** @see WriteRecord — one app-wide log of every write by ANY runtime. */
  onWriteResult?: (entry: WriteRecord) => void;
  api: HomeyApiService;
  catalog: DeviceCatalog;
  bridge: FlowBridgeManager;
  /**
   * Shared with source discovery, which asks the same question of the same
   * ~11.6 MB of cards (platform §15). Optional so the ephemeral rigs and the
   * tests can still build a manager from an api alone.
   */
  cards?: FlowCardCatalogue;
  /** The Homey's IANA timezone. */
  timezone: () => string | undefined;
  /**
   * Sun position and sensor readings, for a window whose brightness follows the
   * daylight. Optional so the ephemeral rigs and the tests can build a manager
   * without one.
   */
  daylight?: DaylightEvaluator;
  log: (...args: unknown[]) => void;
}

export class ScheduleRuntimeManager {
  /** See RuntimeRegistry: the Map, its ordering rules and the coalescer. */
  private readonly registry: RuntimeRegistry<ScheduleRuntime>;
  /**
   * One enumeration of ~1700 trigger cards per app run, shared by every
   * schedule. Memoised as the in-flight PROMISE, so two schedules starting at
   * boot do not each pay for it.
   */
  private timeCardLookup: Promise<TimeCardDiscovery> | null = null;

  private readonly cards: FlowCardCatalogue;

  constructor(private readonly deps: ScheduleManagerDeps) {
    this.registry = new RuntimeRegistry({ log: deps.log, label: 'schedule' });
    this.cards = deps.cards ?? new FlowCardCatalogue(deps.api);
  }

  /**
   * The answer IF something has already paid for it. NEVER provokes the lookup.
   *
   * Diagnostics used to call `timeCard()` directly, which made opening the
   * settings page — or any bug report — cost a full ~11.6 MB trigger catalogue
   * read on a Homey that had no schedule and no use for the answer. That read
   * raises the process's floor permanently (platform §15), so a report about
   * the app changed the thing it was reporting on.
   *
   * Nothing is lost. A running schedule has already resolved this during
   * `start()`, so whenever the answer is interesting it is also already here;
   * when it is null, no schedule has needed it, which is itself the honest
   * thing to report.
   */
  peekTimeCard(): TimeCardDiscovery | null {
    return this.timeCardResult;
  }

  /** Set once the lookup resolves, so `peekTimeCard()` can answer for free. */
  private timeCardResult: TimeCardDiscovery | null = null;

  async timeCard(): Promise<TimeCardDiscovery> {
    if (!this.timeCardLookup) {
      this.timeCardLookup = (async () => {
        const triggers = await this.cards.triggerCards();
        const discovery = discoverTimeCard(triggers);
        this.deps.log(discovery.card
          ? `Time trigger card: ${discovery.card.id} (argument "${discovery.card.argument}")`
          : 'No usable time trigger card found on this Homey');
        this.timeCardResult = discovery;
        return discovery;
      })().catch(error => {
        // Do not cache a failure: a card lookup that failed because the Homey was
        // busy must be retryable without a restart.
        this.timeCardLookup = null;
        throw error;
      });
    }
    return this.timeCardLookup;
  }

  async register(
    controllerId: string,
    plan: SchedulePlan,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    onPlanChange: (plan: SchedulePlan) => Promise<void> = async () => { },
    displayName: () => string = () => 'schedule',
  ): Promise<ScheduleRuntime> {
    return this.registry.register(controllerId, async () => {
      const runtime = new ScheduleRuntime(controllerId, plan, {
        ...this.baseDeps(),
        displayName,
        onStateChange,
        onPlanChange,
      });
      await runtime.start();
      return runtime;
    });
  }

  /**
   * A runtime that is never registered and generates no flows — it exists only so
   * the Test control on the schedule screen can drive real lights before save.
   * Callers must stop it.
   */
  async ephemeral(plan: SchedulePlan): Promise<ScheduleRuntime> {
    const runtime = new ScheduleRuntime('__test__', plan, {
      ...this.baseDeps(),
      displayName: () => 'test',
      onStateChange: () => { /* a test rig has no health state */ },
      onPlanChange: async () => { /* ephemeral: nothing to persist */ },
    });
    await runtime.startWithoutFlows();
    return runtime;
  }

  private baseDeps(): Omit<ScheduleRuntimeDeps, 'onStateChange' | 'onPlanChange' | 'displayName'> {
    return {
      api: this.deps.api,
      catalog: this.deps.catalog,
      bridge: this.deps.bridge,
      timeCard: () => this.timeCard(),
      ...(this.deps.onWriteResult ? { onWriteResult: this.deps.onWriteResult } : {}),
      timezone: this.deps.timezone,
      ...(this.deps.daylight ? { daylight: this.deps.daylight } : {}),
      log: this.deps.log,
    };
  }

  async unregister(controllerId: string): Promise<void> {
    return this.registry.unregister(controllerId);
  }

  get(controllerId: string): ScheduleRuntime | undefined {
    return this.registry.get(controllerId);
  }

  all(): ScheduleRuntime[] {
    return this.registry.all();
  }

  /** Route a boundary event. Says WHY it refused, so a silent Flow is diagnosable. */
  dispatchWithReason(controllerId: string, eventKey: string): { accepted: boolean; reason?: string } {
    const runtime = this.registry.get(controllerId);
    if (!runtime) {
      return {
        accepted: false,
        reason: `no running schedule "${controllerId}" (running: ${this.registry.ids.join(', ') || 'none'})`,
      };
    }
    return runtime.handleEvent(eventKey);
  }

  /** As with controllers, this must NOT restart the runtimes. */
  async onCatalogChange(): Promise<void> {
    this.registry.onCatalogChange();
  }

  /**
   * A key was entered or invalidated. A schedule with no key keeps its Flows and
   * keeps firing — only their maintenance stops — so this re-reconciles and then
   * re-asks for the state rather than assuming either answer.
   */
  async onCredentialChange(): Promise<void> {
    const valid = this.deps.api.credentials.getStatus().valid;
    for (const runtime of this.registry.all()) {
      try {
        if (valid) await runtime.reconcileFlows();
        await runtime.assessHealth();
      } catch (error) {
        this.deps.log('Schedule reconcile after a credential change failed:', messageOf(error));
      }
    }
  }

  async destroyAll(): Promise<void> {
    return this.registry.destroyAll();
  }
}
