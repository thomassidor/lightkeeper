import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { FlowBridgeManager } from '../bridge/flow-bridge-manager';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { ScheduleRuntime, type ScheduleRuntimeDeps } from './schedule-runtime';
import { discoverTimeCard, type TimeCardDiscovery } from './time-card-discovery';
import type { SchedulePlan } from './schedule-types';
import { fireAndForget } from '../support/async';
import type { WriteRecord } from '../outputs/light-target-adapter';

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
  bridge: FlowBridgeManager;
  /** The Homey's IANA timezone. */
  timezone: () => string | undefined;
  log: (...args: unknown[]) => void;
}

export class ScheduleRuntimeManager {
  private readonly runtimes = new Map<string, ScheduleRuntime>();
  private catalogChangeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * One enumeration of ~1700 trigger cards per app run, shared by every
   * schedule. Memoised as the in-flight PROMISE, so two schedules starting at
   * boot do not each pay for it.
   */
  private timeCardLookup: Promise<TimeCardDiscovery> | null = null;

  constructor(private readonly deps: ScheduleManagerDeps) {}

  async timeCard(): Promise<TimeCardDiscovery> {
    if (!this.timeCardLookup) {
      this.timeCardLookup = (async () => {
        const client = await this.deps.api.read();
        const triggers = Object.values(await client.flow.getFlowCardTriggers());
        const discovery = discoverTimeCard(triggers);
        this.deps.log(discovery.card
          ? `Time trigger card: ${discovery.card.id} (argument "${discovery.card.argument}")`
          : 'No usable time trigger card found on this Homey');
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
    onPlanChange: (plan: SchedulePlan) => void = () => { },
    displayName: () => string = () => 'schedule',
  ): Promise<ScheduleRuntime> {
    await this.unregister(controllerId);

    const runtime = new ScheduleRuntime(controllerId, plan, {
      ...this.baseDeps(),
      displayName,
      onStateChange,
      onPlanChange,
    });

    this.runtimes.set(controllerId, runtime);
    await runtime.start();
    return runtime;
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
      onPlanChange: () => { /* ephemeral: nothing to persist */ },
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
      log: this.deps.log,
    };
  }

  async unregister(controllerId: string): Promise<void> {
    const runtime = this.runtimes.get(controllerId);
    if (!runtime) return;
    await runtime.stop();
    this.runtimes.delete(controllerId);
  }

  get(controllerId: string): ScheduleRuntime | undefined {
    return this.runtimes.get(controllerId);
  }

  all(): ScheduleRuntime[] {
    return [...this.runtimes.values()];
  }

  /** Route a boundary event. Says WHY it refused, so a silent Flow is diagnosable. */
  dispatchWithReason(controllerId: string, eventKey: string): { accepted: boolean; reason?: string } {
    const runtime = this.runtimes.get(controllerId);
    if (!runtime) {
      return {
        accepted: false,
        reason: `no running schedule "${controllerId}" (running: ${[...this.runtimes.keys()].join(', ') || 'none'})`,
      };
    }
    return runtime.handleEvent(eventKey);
  }

  /** As with controllers, this must NOT restart the runtimes. */
  async onCatalogChange(): Promise<void> {
    if (this.catalogChangeTimer !== null) return;

    this.catalogChangeTimer = setTimeout(() => {
      this.catalogChangeTimer = null;
      fireAndForget((async () => {
        for (const runtime of this.runtimes.values()) {
          try {
            await runtime.refreshTargets();
          } catch (error) {
            this.deps.log('Failed to re-resolve schedule targets:', (error as Error)?.message);
          }
        }
      })(), this.deps.log, 'Catalogue-change target refresh');
    }, 500);
  }

  /**
   * A key was entered or invalidated. A schedule with no key keeps its Flows and
   * keeps firing — only their maintenance stops — so this re-reconciles and then
   * re-asks for the state rather than assuming either answer.
   */
  async onCredentialChange(): Promise<void> {
    const valid = this.deps.api.credentials.getStatus().valid;
    for (const runtime of this.runtimes.values()) {
      try {
        if (valid) await runtime.reconcileFlows();
        await runtime.assessHealth();
      } catch (error) {
        this.deps.log('Schedule reconcile after a credential change failed:', (error as Error)?.message);
      }
    }
  }

  async destroyAll(): Promise<void> {
    if (this.catalogChangeTimer !== null) {
      clearTimeout(this.catalogChangeTimer);
      this.catalogChangeTimer = null;
    }
    for (const runtime of this.runtimes.values()) {
      await runtime.stop();
    }
    this.runtimes.clear();
  }
}
