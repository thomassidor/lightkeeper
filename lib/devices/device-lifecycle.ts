import { KeyedMutex } from '../support/keyed-mutex';
import { fireAndForget } from '../support/async';
import type { ControllerState, StateDetail, ManagedFlowReference } from '../profiles/controller-profile';

/**
 * Everything a Lightkeeper virtual device does that is not the SDK.
 *
 * The three device types are genuinely different products — a controller
 * listens to a remote, a schedule fires at a time, a circadian light follows a
 * curve — but their DEVICE layer was three copies of one file: load-and-migrate,
 * register, translate a state detail, persist, tear down. The copies had already
 * drifted (the controller persisted its profile before registering, the other
 * two after; only two of the three carried the paused-while-unavailable fix),
 * and every ordering fix had to be made three times or silently was not.
 *
 * It is a plain class rather than a base class because of one hard constraint:
 * `require('homey')` only resolves on a Homey. A `LightkeeperDevice extends
 * Homey.Device` cannot be imported by a test at all, so nothing about the
 * ordering below could be proved anywhere except on hardware. What is here takes
 * its host as an argument, and `test/unit/device-transactions.test.ts` gives it
 * a Map and four counters.
 *
 * The two things it exists to get right, both of which needed one owner:
 *
 *  - **Transactions.** An apply persists the candidate plan only once
 *    `register()` has resolved, and restores the previous plan if it did not, so
 *    a failed start never leaves the store describing a runtime that is not
 *    running. A failed registration is not dispatchable either — see the
 *    managers, which insert into their maps only after `start()` resolves.
 *  - **Ordering.** Every apply, pause and rename runs through one per-device
 *    FIFO, and every availability verdict through a second one carrying a
 *    sequence number. That is what stops a runtime's state callback — which is
 *    synchronous by contract, so it cannot be awaited — from landing after the
 *    apply that superseded it and flipping an unavailable device to available.
 */

/** What a migration module hands back. All three have this shape. */
export interface PlanMigration<TPlan> {
  plan: TPlan;
  migrated: boolean;
  fromVersion: number;
}

/**
 * The slice of a runtime this layer touches.
 *
 * `reconcileFlows` and `updatePlan` are optional because a circadian runtime has
 * neither — it generates no Flows (CLAUDE.md §12), so a rename has nothing to
 * reach — and an optional call is a no-op rather than a special case here.
 */
export interface DeviceRuntime {
  readonly currentState: ControllerState;
  readonly currentDetail: StateDetail | undefined;
  destroy(): Promise<void>;
  reconcileFlows?(): Promise<void>;
  updatePlan?(plan: any): Promise<void>;
}

/** The slice of an app-level manager this layer touches. */
export interface DeviceRegistry<TPlan, TRuntime extends DeviceRuntime> {
  register(
    id: string,
    plan: TPlan,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    onPlanChange: (plan: TPlan) => Promise<void>,
    displayName: () => string,
  ): Promise<TRuntime>;
  unregister(id: string): Promise<void>;
  get(id: string): TRuntime | undefined;
}

/**
 * The device this lifecycle belongs to: the SDK members it uses, plus what makes
 * one device type different from the next.
 *
 * `Homey.Device` already satisfies the SDK half structurally, which is why
 * `LightkeeperDevice` passes `this` and adds nothing but the two translations
 * (`homey.__`, `app.bridge`) that the SDK spells differently.
 */
export interface DeviceOwner<TPlan, TRuntime extends DeviceRuntime> {
  // ---- the SDK half -------------------------------------------------------
  getData(): any;
  getName(): string;
  getStoreValue(key: string): any;
  setStoreValue(key: string, value: unknown): Promise<unknown>;
  setAvailable(): Promise<void>;
  setUnavailable(message?: string): Promise<void>;
  setCapabilityValue(capabilityId: string, value: unknown): Promise<void>;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** `homey.__`, which `lib/` cannot reach on its own. */
  translate(key: string, tokens?: Record<string, string | number>): string;
  /** The app's flow bridge, for the delete path that runs with no runtime. */
  removeFlows(refs: ManagedFlowReference[]): Promise<number>;

  // ---- what differs between device types ----------------------------------
  /** The device-store key this type's plan is filed under. */
  readonly storeKey: string;
  /** Locale key for "you have not configured me yet". */
  readonly missingKey: string;
  /**
   * Whether `disabled` keeps the device available.
   *
   * True for the two switchable types: a paused schedule's tile carries the
   * switch that un-pauses it, and an unavailable device cannot be switched. A
   * controller has nothing on its tile, so `disabled` reads as unavailable there.
   */
  readonly availableWhenDisabled: boolean;
  /** Whether the tile carries an onoff pause switch. */
  readonly withPauseSwitch: boolean;

  migrate(raw: unknown): PlanMigration<TPlan>;
  registry(): DeviceRegistry<TPlan, TRuntime>;
  /** The runtime's own current view of its plan, for persistence. */
  planOf(runtime: TRuntime): TPlan;
  /** Whether a plan is running or paused. Only used with a pause switch. */
  planEnabled(plan: TPlan): boolean;
  /** A copy of the plan with the pause switch moved. */
  withEnabled(plan: TPlan, enabled: boolean): TPlan;
  /**
   * References to Flows this plan owns, for the delete path that runs when the
   * runtime never started. Circadian returns none: it creates no Flows.
   */
  flowRefs(plan: TPlan): ManagedFlowReference[];
  /**
   * Turn what the pairing session saved into what should actually be registered,
   * and do anything that has to happen BEFORE the register.
   *
   * Two device types only carry state forward from the plan already stored (a
   * pause someone set, references to Flows already owned). The controller also
   * deletes the Flows of a source device it no longer listens to, and the
   * ordering there is load-bearing — its own override says why.
   */
  prepareApply(previous: TPlan | null, incoming: TPlan): Promise<TPlan>;
}

/** Serialised work: user-facing operations on one key, verdicts on the other. */
const OPS = 'ops';
const STATE = 'state';

export class DeviceLifecycle<TPlan, TRuntime extends DeviceRuntime> {
  private readonly operations = new KeyedMutex();
  /** Every verdict gets a number; only the newest may be applied. */
  private stateSeq = 0;
  private appliedSeq = 0;

  constructor(private readonly owner: DeviceOwner<TPlan, TRuntime>) {}

  get deviceId(): string {
    return this.owner.getData().id;
  }

  storedPlan(): TPlan | null {
    return (this.owner.getStoreValue(this.owner.storeKey) as TPlan | undefined) ?? null;
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    const plan = await this.loadPlan();
    if (!plan) {
      await this.owner.setUnavailable(this.owner.translate(this.owner.missingKey));
      return;
    }

    if (this.owner.withPauseSwitch) {
      // The tile reflects the stored plan, not the other way round: a restart
      // must not silently un-pause something someone paused.
      await this.owner.setCapabilityValue('onoff', this.owner.planEnabled(plan))
        .catch(() => { /* first init */ });

      // A paused device reports 'disabled', which is the runtime's INITIAL state
      // too — so no state CHANGE fires and no verdict ever arrives. Without
      // this, a device paused while it was unavailable (a dead key, say) kept
      // that message and could not be resumed from its own tile.
      if (!this.owner.planEnabled(plan)) await this.owner.setAvailable();
    }

    await this.registerPlan(plan);
  }

  /**
   * Load and migrate. A plan we cannot migrate must not silently become
   * defaults — the device goes unavailable and says so instead.
   *
   * The migrated value's write is AWAITED. Fire-and-forget meant a migration
   * that failed to persist was silently re-run on every start, and nothing
   * anywhere noticed that the stored shape had never actually moved.
   */
  async loadPlan(): Promise<TPlan | null> {
    const raw = this.owner.getStoreValue(this.owner.storeKey);
    if (!raw) return null;

    try {
      const { plan, migrated, fromVersion } = this.owner.migrate(raw);
      if (migrated) {
        this.owner.log(`Migrated ${this.owner.storeKey} from schema ${fromVersion}`);
        await this.owner.setStoreValue(this.owner.storeKey, plan);
      }
      return plan;
    } catch (error) {
      this.owner.error(`Could not migrate ${this.owner.storeKey}:`, (error as Error)?.message);
      return null;
    }
  }

  private async registerPlan(plan: TPlan): Promise<TRuntime> {
    return this.owner.registry().register(
      this.deviceId,
      plan,
      (state: ControllerState, detail?: StateDetail) => this.onRuntimeState(state, detail),
      async (updated: TPlan) => this.persistPlan(updated),
      () => this.owner.getName(),
    );
  }

  /**
   * Called by the pair/repair session when the user saves.
   *
   * Transactional: the candidate plan reaches the store only once the runtime is
   * running, and a failure puts the previous plan and its runtime back.
   */
  async apply(incoming: TPlan): Promise<void> {
    return this.operations.run(OPS, async () => {
      const previous = this.storedPlan();
      const merged = await this.owner.prepareApply(previous, incoming);

      let runtime: TRuntime;
      try {
        runtime = await this.registerPlan(merged);
      } catch (error) {
        // The new plan never started. Put the old one back — store first, so a
        // restart during the recovery below finds the configuration that is
        // actually running rather than the one that failed.
        this.owner.error('Applying the new configuration failed:', (error as Error)?.message);
        await this.rollback(previous, error);
        throw error;
      }

      // Persist AFTER the register: what the runtime has learned (managed Flow
      // references, in practice) is already folded into its own plan, and
      // writing `merged` here would drop it.
      await this.persistPlan(this.owner.planOf(runtime));

      if (this.owner.withPauseSwitch) {
        await this.owner.setCapabilityValue('onoff', this.owner.planEnabled(merged))
          .catch(() => { /* not yet initialised */ });
      }

      // The runtime's own verdict is the final word, not an unconditional
      // setAvailable(): a controller whose remote has vanished must not read as
      // ready merely because the save succeeded.
      await this.publishState(runtime.currentState, runtime.currentDetail);
    });
  }

  /** Restore the plan that was running before a failed apply. */
  private async rollback(previous: TPlan | null, cause: unknown): Promise<void> {
    try {
      if (previous) {
        await this.owner.setStoreValue(this.owner.storeKey, previous);
        const runtime = await this.registerPlan(previous);
        await this.publishState(runtime.currentState, runtime.currentDetail);
        return;
      }
      // Nothing was configured before, so there is nothing to put back.
      await this.owner.registry().unregister(this.deviceId);
      await this.owner.setUnavailable(this.owner.translate(this.owner.missingKey));
    } catch (error) {
      // Both the new plan and the old one failed to start. Say so with the
      // ORIGINAL failure: that is the one the user's change caused.
      this.owner.error('Could not restore the previous configuration:', (error as Error)?.message);
      await this.owner.setUnavailable(
        messageOf(cause) ?? this.owner.translate('state.needsRepair'),
      );
    }
  }

  /** Managed plan changes must survive a restart, or their Flows leak. */
  private async persistPlan(plan: TPlan): Promise<void> {
    await this.owner.setStoreValue(this.owner.storeKey, plan);
  }

  /** The pause switch on the tile, and anything the user's own Flows do to it. */
  async setEnabled(enabled: boolean): Promise<void> {
    return this.operations.run(OPS, async () => {
      const plan = this.storedPlan();
      if (!plan) return;

      const updated = this.owner.withEnabled(plan, enabled);
      await this.owner.setStoreValue(this.owner.storeKey, updated);

      const runtime = this.owner.registry().get(this.deviceId);
      if (runtime?.updatePlan) {
        // Restarts the runtime, which re-reconciles and — on resume — catches up
        // whatever is already in progress, so un-pausing at 22:30 lights the
        // room rather than waiting for tomorrow.
        await runtime.updatePlan(updated);
      } else {
        await this.registerPlan(updated);
      }

      this.owner.log(enabled ? 'Resumed' : 'Paused');
    });
  }

  /**
   * A device's name is the name of its Flow folder, so following a rename means
   * reconciling. Cheap: every Flow is reused, and only the folder is rewritten.
   * A runtime with no Flows exposes no `reconcileFlows`, so this is a no-op for
   * a circadian light — which has no folder to rename.
   */
  async renamed(): Promise<void> {
    return this.operations.run(OPS, async () => {
      await this.owner.registry().get(this.deviceId)?.reconcileFlows?.();
    });
  }

  /**
   * Deleting the device removes only the Flows provably managed by it, plus its
   * runtime's subscriptions.
   */
  async deleted(): Promise<void> {
    const registry = this.owner.registry();
    const runtime = registry.get(this.deviceId);
    if (runtime) {
      await runtime.destroy();
      await registry.unregister(this.deviceId);
    } else {
      // The runtime never started, but its Flows may still exist.
      const plan = this.storedPlan();
      const refs = plan ? this.owner.flowRefs(plan) : [];
      if (refs.length > 0) await this.owner.removeFlows(refs);
    }
    this.owner.log('Deleted and its Flows cleaned up');
  }

  async uninit(): Promise<void> {
    await this.owner.registry()?.unregister(this.deviceId);
  }

  // ------------------------------------------------------------------- states

  /**
   * Resolve a runtime's state reason into text for this Homey's language.
   *
   * lib/ has no access to `homey.__`, so it hands up a locale key plus tokens.
   * Only strings we did not author — an API error, say — arrive as `text`, and
   * those are shown verbatim because there is nothing to translate.
   */
  describe(detail: StateDetail | undefined, fallbackKey: string): string {
    if (detail?.key) return this.owner.translate(detail.key, detail.tokens ?? {});
    if (detail?.text) return detail.text;
    return this.owner.translate(fallbackKey);
  }

  /** Whether a state keeps the device available. */
  availabilityFor(state: ControllerState): boolean {
    switch (state) {
      case 'ready':
        return true;
      case 'partial':
        // Still working — a device reaching most of its lights must not look
        // broken.
        return true;
      case 'disabled':
        return this.owner.availableWhenDisabled;
      default:
        return false;
    }
  }

  /**
   * A runtime changed state. The runtimes call this synchronously from their own
   * state machines, so it cannot be awaited — it is queued instead, and carries
   * a sequence number so a verdict that lands after a newer one is dropped
   * rather than overwriting it.
   */
  onRuntimeState(state: ControllerState, detail?: StateDetail): void {
    fireAndForget(
      this.publishState(state, detail),
      (...args: unknown[]) => this.owner.error(...args),
      'Applying a runtime state',
    );
  }

  private async publishState(state: ControllerState, detail?: StateDetail): Promise<void> {
    const seq = ++this.stateSeq;
    return this.operations.run(STATE, async () => {
      // Persist whatever the runtime has learned about its own plan. Read from
      // the runtime rather than from a closure: by the time this runs it is the
      // live answer, and a stale one would clobber newer references.
      const runtime = this.owner.registry().get(this.deviceId);
      if (runtime) {
        try {
          await this.persistPlan(this.owner.planOf(runtime));
        } catch (error) {
          // A plan we could not persist is a plan whose Flow references will not
          // survive a restart. Repair is the honest state, and it must not be
          // reported as a clean save.
          this.owner.error('Could not persist the plan:', (error as Error)?.message);
          this.appliedSeq = seq;
          await this.owner.setUnavailable(this.owner.translate('state.persistFailed'));
          return;
        }
      }

      // A verdict older than one already applied is stale — the classic case is
      // a register's callback landing after the apply that superseded it.
      if (seq < this.appliedSeq) return;
      this.appliedSeq = seq;

      if (this.availabilityFor(state)) {
        await this.owner.setAvailable();
        if (state === 'partial') {
          this.owner.log(`Partial: ${this.describe(detail, 'state.someTargets')}`);
        }
        return;
      }
      await this.owner.setUnavailable(this.describe(detail, fallbackKeyFor(state)));
    });
  }
}

function fallbackKeyFor(state: ControllerState): string {
  switch (state) {
    case 'needs_credential': return 'state.needsCredential';
    case 'needs_repair': return 'state.needsRepair';
    case 'disabled': return 'state.disabled';
    default: return 'state.needsRepair';
  }
}

function messageOf(error: unknown): string | null {
  const message = String((error as Error | undefined)?.message ?? '');
  return message.length > 0 ? message : null;
}
