import { KeyedMutex } from '../support/keyed-mutex';
import { fireAndForget } from '../support/async';
import { validManagedFlowRefs } from '../validation/plans';
import type { ControllerState, StateDetail, ManagedFlowReference } from '../profiles/controller-profile';
import { messageOf } from '../support/homey-errors';
import { ALL_VALUE_CAPABILITIES, isTranslatable } from '../runtime/published-values';
import type { PublishedValue, PublishedValues } from '../runtime/published-values';

/**
 * Everything a Lightkeeper virtual device does that is not the SDK.
 *
 * The five device types are genuinely different products — a controller listens
 * to a remote, a schedule fires at a time, a circadian light and a Colour Curve Light
 * follow a curve, a Room-sensing Light follows the room — but their DEVICE layer was
 * a copy of one file per type: load-and-migrate,
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
 * neither — it generates no Flows (platform §12), so a rename has nothing to
 * reach — and an optional call is a no-op rather than a special case here.
 *
 * `TRuntimePlan` is the shape the RUNTIME takes, which is not always the shape
 * the device STORES. It used to be `any`, and that one `any` shipped a real bug:
 * a circadian light stores two ends of a day while its runtime takes a list of
 * points, and `setEnabled` handed the stored plan straight to `updatePlan` —
 * so tapping the pause switch threw inside `subscribeAll()`, left the runtime
 * stopped but registered, and made `diagnostics()` throw for every curve-driven
 * device, which took the settings page and the bug-report export down with it.
 * Naming the type is what makes that a compile error: `DeviceOwner` must supply
 * a `planForRuntime` that converts, and the two plan shapes are mutually
 * incompatible, so the default identity cannot satisfy the constraint.
 */
export interface DeviceRuntime<TRuntimePlan = unknown> {
  readonly currentState: ControllerState;
  readonly currentDetail: StateDetail | undefined;
  destroy(): Promise<void>;
  reconcileFlows?(): Promise<void>;
  updatePlan?(plan: TRuntimePlan): Promise<void>;
  /**
   * Start receiving what this runtime wants the lights to be, for the capability
   * rows and the Flow tags behind them (platform §18).
   *
   * A SETTER rather than a sixth argument to `register()`, and optional rather
   * than required, and both halves are what keep this change small: the four
   * managers' `register(id, plan, onStateChange, onPlanChange, displayName, kind?)`
   * signatures are untouched, and so is the registry adapter in
   * `drivers/circadian/device.ts` that wraps one of them. A controller does not
   * implement it at all — a remote has no desired state to publish, only the
   * last thing somebody pressed.
   *
   * Synchronous by contract, exactly like `onStateChange`: it is called from
   * inside a tick that cannot await the device layer.
   */
  watchValues?(onValues: (values: PublishedValues) => void): void;
}

/** The slice of an app-level manager this layer touches. */
export interface DeviceRegistry<TPlan, TRuntime extends DeviceRuntime<any>> {
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
export interface DeviceOwner<
  TPlan,
  TRuntime extends DeviceRuntime<TRuntimePlan>,
  TRuntimePlan = TPlan,
> {
  // ---- the SDK half -------------------------------------------------------
  getData(): any;
  getName(): string;
  getStoreValue(key: string): any;
  setStoreValue(key: string, value: unknown): Promise<unknown>;
  setAvailable(): Promise<void>;
  setUnavailable(message?: string): Promise<void>;
  setCapabilityValue(capabilityId: string, value: unknown): Promise<void>;
  hasCapability(capabilityId: string): boolean;
  addCapability(capabilityId: string): Promise<void>;
  removeCapability(capabilityId: string): Promise<void>;
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** `homey.__`, which `lib/` cannot reach on its own. */
  translate(key: string, tokens?: Record<string, string | number>): string;
  /** The app's flow bridge, for the delete path that runs with no runtime. */
  removeFlows(refs: ManagedFlowReference[]): Promise<number>;
  /**
   * Drop this device's flow journal. Called on delete, after the Flows are gone.
   *
   * A no-op for the three device types that own no Flows, which is why it sits
   * beside `removeFlows` rather than behind a check: neither ever wrote one.
   */
  forgetFlowJournal(): void;

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
  /**
   * The value capabilities this device type carries, as declared in its
   * `driver.compose.json`.
   *
   * Declared twice on purpose, and the second copy is the load-bearing one: a
   * driver's `capabilities` array reaches a device Homey pairs AFTER the change
   * and no other (platform §18), so every already-paired device needs
   * `addCapability` at init. This list is what `reconcileCapabilities` adds
   * from — and what it removes against, so a capability withdrawn from a
   * manifest also leaves the tiles it is already on.
   */
  readonly valueCapabilities: readonly string[];

  migrate(raw: unknown): PlanMigration<TPlan>;
  registry(): DeviceRegistry<TPlan, TRuntime>;
  /**
   * The runtime's own current view of its plan, for persistence.
   *
   * `base` is the plan this persist is FOR — the one `apply()` just registered,
   * or whatever the store currently holds on a state change. A device type whose
   * runtime holds the whole plan ignores it and returns `runtime.currentPlan`;
   * one that folds a couple of runtime-owned fields back onto a stored shape
   * must fold them onto THIS, not onto the store.
   *
   * It exists because reading the store here was wrong on exactly the path that
   * matters: `apply()` persists AFTER registering, deliberately, so at that
   * moment the store still holds the pre-edit plan. A circadian light's repair
   * therefore took effect on the lights and was then written back as the plan
   * the user had just replaced — success on screen, old curve after a restart.
   */
  planOf(runtime: TRuntime, base: TPlan | null): TPlan;
  /**
   * The stored plan, as the RUNTIME wants it.
   *
   * Identity for every device type whose store and runtime agree on a shape.
   * A circadian light is the one that does not: it stores two ends of the day
   * and its runtime takes the points they expand into, and that expansion used
   * to exist only on the register path — see DeviceRuntime for what that cost.
   */
  planForRuntime(plan: TPlan): TRuntimePlan;
  /** Whether a plan is running or paused. Only used with a pause switch. */
  planEnabled(plan: TPlan): boolean;
  /** A copy of the plan with the pause switch moved. */
  withEnabled(plan: TPlan, enabled: boolean): TPlan;
  /**
   * Whatever the STORE says this device's Flow references are, unvalidated.
   *
   * Unvalidated on purpose, and read from the raw store rather than from a
   * plan: the delete path that uses it runs precisely when no plan could be
   * loaded, which includes the case where validation rejected one. The
   * lifecycle filters the result through the shape check before any delete.
   *
   * Circadian returns nothing: it creates no Flows (platform §12).
   */
  rawFlowRefs(): unknown;
  /**
   * Turn what the pairing session saved into what should actually be registered,
   * and do anything that has to happen BEFORE the register.
   *
   * Two device types only carry state forward from the plan already stored (a
   * pause someone set, references to Flows already owned). The controller also
   * RELEASES the Flows of a source device it no longer listens to — and deletes
   * them only in `afterApply`, once the new plan has committed. Nothing
   * irreversible belongs here: this runs before the register, and everything
   * after it can still roll back.
   */
  prepareApply(previous: TPlan | null, incoming: TPlan): Promise<TPlan>;
  /**
   * Anything that may only happen once an apply has COMMITTED — the runtime
   * started and the plan persisted — and must not happen if it rolls back.
   *
   * The controller is the one user: deleting the old remote's Flows used to sit
   * in `prepareApply`, BEFORE the register, so an apply that then failed rolled
   * back to a profile whose `managedFlows` named Flows that had just been
   * deleted. Optional, because the four other device types have nothing
   * irreversible to do; and it can never fail the apply — the new plan is
   * running and stored by the time this is called, so a failure here is logged
   * and the transaction stands.
   */
  afterApply?(previous: TPlan | null, committed: TPlan): Promise<void>;
}

/**
 * Serialised work: user-facing operations on one key, verdicts on another, and
 * published values on a third.
 *
 * Values get their OWN key rather than sharing the verdict one, because they
 * arrive far more often and a capability write that is slow to answer must not
 * be able to delay the sentence on a device's tile — availability is the thing
 * a user is waiting to see change.
 */
const OPS = 'ops';
const STATE = 'state';
const VALUES = 'values';

/**
 * Which locale key a failed load deserves. Module-level and pure, so it is
 * testable without a device host.
 */
function quarantineKeyFor(error: unknown): string | null {
  const name = (error as Error | undefined)?.name;
  const kind = (error as { kind?: unknown } | undefined)?.kind;

  // Intact configuration, wrong app version. Nothing to redo.
  if (name === 'MigrationError' && kind === 'newer') return 'state.configurationFromNewerVersion';
  // A shape no chain can make sense of, or one that failed its validator.
  if (name === 'ValidationError') return 'state.invalidConfiguration';
  if (name === 'MigrationError') return 'state.invalidConfiguration';
  // Anything else: the owner's own "not configured" is the honest fallback.
  return null;
}

export class DeviceLifecycle<
  TPlan,
  TRuntime extends DeviceRuntime<TRuntimePlan>,
  TRuntimePlan = TPlan,
> {
  private readonly operations = new KeyedMutex();
  /** Every verdict gets a number; only the newest may be applied. */
  private stateSeq = 0;
  private appliedSeq = 0;
  private planGeneration = 0;
  private applying = false;

  constructor(private readonly owner: DeviceOwner<TPlan, TRuntime, TRuntimePlan>) {}

  get deviceId(): string {
    return this.owner.getData().id;
  }

  storedPlan(): TPlan | null {
    return (this.owner.getStoreValue(this.owner.storeKey) as TPlan | undefined) ?? null;
  }

  // ---------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    await this.reconcileCapabilities();

    const plan = await this.loadPlan();
    if (!plan) {
      await this.owner.setUnavailable(this.owner.translate(this.quarantineKey));
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
    if (!raw) {
      this.quarantineOverride = null;
      return null;
    }

    try {
      const { plan, migrated, fromVersion } = this.owner.migrate(raw);
      if (migrated) {
        this.owner.log(`Migrated ${this.owner.storeKey} from schema ${fromVersion}`);
        await this.owner.setStoreValue(this.owner.storeKey, plan);
      }
      this.quarantineOverride = null;
      return plan;
    } catch (error) {
      /**
       * Quarantine, not repair-in-place.
       *
       * A plan we cannot migrate OR cannot validate must not silently become
       * defaults — that would replace the user's configuration with one they
       * never chose, and the difference is invisible from every screen. The
       * device goes unavailable and the STORE IS LEFT ALONE, so a fix in a later
       * version can still read whatever is there.
       *
       * The THREE failures get different text because they need different
       * actions: a store written by a later version of the app means "update
       * Lightkeeper" and nothing else — the configuration is intact and a
       * downgrade is the whole problem; a plan whose shape is wrong means "set
       * this device up again"; and anything else falls back to the owner's own
       * "not configured".
       *
       * The middle case used to swallow the first. `MigrationError` was a
       * plain `Error`, so `name === 'ValidationError'` was false and it fell
       * to the fallback — and somebody who had simply installed an older build
       * was told to set their device up again, which would have destroyed the
       * configuration that was fine. The comment already promised otherwise.
       */
      this.quarantineOverride = quarantineKeyFor(error);
      this.owner.error(
        `Could not load ${this.owner.storeKey}:`, messageOf(error),
      );
      return null;
    }
  }

  /**
   * Which locale key describes why there is no usable plan.
   *
   * Set by `loadPlan`, read by `init` and by the rollback that finds nothing to
   * restore. A field rather than a return value because both readers are
   * elsewhere and the alternative is threading it through four signatures — and
   * null-until-set rather than pre-filled, because a first save that fails never
   * calls `loadPlan` at all and must still say "not configured".
   */
  private quarantineOverride: string | null = null;

  private get quarantineKey(): string {
    return this.quarantineOverride ?? this.owner.missingKey;
  }

  private async registerPlan(plan: TPlan): Promise<TRuntime> {
    const generation = ++this.planGeneration;
    const runtime = await this.owner.registry().register(
      this.deviceId,
      plan,
      (state: ControllerState, detail?: StateDetail) => {
        if (generation === this.planGeneration) this.onRuntimeState(state, detail);
      },
      async (updated: TPlan) => {
        // During apply the runtime owns its candidate; only the final commit
        // publishes it. Old runtimes can finish reconciliation after replacement.
        if (!this.applying) await this.persistPlan(updated, generation);
      },
      () => this.owner.getName(),
    );

    // Generation-guarded exactly like the state callback above, and for the same
    // reason: a replaced runtime can still be mid-tick, and a value it publishes
    // afterwards describes a plan this device no longer has.
    runtime.watchValues?.((values: PublishedValues) => {
      if (generation === this.planGeneration) this.onRuntimeValues(values);
    });

    return runtime;
  }

  /**
   * Called by the pair/repair session when the user saves.
   *
   * Transactional: the candidate plan reaches the store only once the runtime is
   * running, and a failure puts the previous plan and its runtime back.
   */
  /**
   * The plan about to be registered, put through the SAME validator the load
   * path ends in — or refused before anything runs or is stored.
   *
   * The only validator in the device layer used to be the one `migrate()` runs
   * at load, so an application accepted whatever a caller handed it. The
   * pairing screens gate their own input, but `api.ts`'s routes did not: a body
   * with `fromDaylight: true` on a device whose plan carries no `daylight`
   * response was accepted, the runtime started (falling back to the stored
   * brightness), and then at the NEXT APP RESTART `validateSchedulePlan`
   * refused the same plan and the device went unavailable saying "set this
   * device up again". A save that looks like it worked and breaks the device
   * days later, at a moment with no connection to the action that caused it.
   *
   * `migrate()` rather than a new `validate` member on `DeviceOwner`, because a
   * current-version plan runs zero migration steps and drops straight into that
   * chain's validator — so every device type is covered by the validator it
   * already declares, and there is no second place for the two to disagree.
   *
   * It throws, and that is right: `apply()`'s catch is a full rollback, so a
   * refused plan leaves the previous one running rather than half-installed.
   */
  private validated(plan: TPlan): TPlan {
    return this.owner.migrate(plan).plan;
  }

  async apply(incoming: TPlan): Promise<void> {
    return this.operations.run(OPS, async () => {
      this.applying = true;
      this.planGeneration += 1;
      // Let an already-dispatched store write finish before taking the rollback
      // snapshot. Queued writes from the old generation are discarded.
      await this.operations.run('store', async () => {});
      const previous = this.storedPlan();

      let runtime: TRuntime;
      let merged: TPlan;
      try {
        merged = this.validated(await this.owner.prepareApply(previous, incoming));
        runtime = await this.registerPlan(merged);
        // The candidate is committed only once start has completed. This write
        // is part of the transaction too: a failed save must not keep running.
        await this.persistPlan(this.owner.planOf(runtime, merged));
      } catch (error) {
        // Startup or the final commit failed. Stop the candidate and restore
        // the old store before rebuilding its runtime.
        this.owner.error('Applying the new configuration failed:', messageOf(error));
        try { await this.rollback(previous, error); }
        finally { this.applying = false; }
        throw error;
      }
      this.applying = false;

      // Past the point of no return, so nothing here may throw into the
      // caller: the pair screen would report a failed save for a plan that is
      // running and stored.
      if (this.owner.afterApply) {
        try {
          await this.owner.afterApply(previous, merged);
        } catch (error) {
          this.owner.error('Finishing the new configuration failed:', messageOf(error));
        }
      }

      if (this.owner.withPauseSwitch) {
        await this.owner.setCapabilityValue('onoff', this.owner.planEnabled(merged))
          .catch(() => { /* not yet initialised */ });
      }

      // The runtime's own verdict is the final word, not an unconditional
      // setAvailable(): a controller whose remote has vanished must not read as
      // ready merely because the save succeeded.
      await this.publishState(runtime.currentState, runtime.currentDetail, false);
    });
  }

  /** Restore the plan that was running before a failed apply. */
  private async rollback(previous: TPlan | null, cause: unknown): Promise<void> {
    this.planGeneration += 1;
    try {
      // Remove the candidate before touching storage: even failed recovery must
      // leave no candidate dispatchable or controlling lights.
      await this.owner.registry().unregister(this.deviceId);
      await this.operations.run('store', async () => {
        await this.owner.setStoreValue(this.owner.storeKey, previous);
      });
      if (previous) {
        const runtime = await this.registerPlan(previous);
        await this.persistPlan(this.owner.planOf(runtime, previous));
        await this.publishState(runtime.currentState, runtime.currentDetail, false);
        return;
      }
      // Nothing was configured before, so there is nothing to put back.
      await this.owner.setUnavailable(this.owner.translate(this.quarantineKey));
    } catch (error) {
      this.planGeneration += 1;
      try { await this.owner.registry().unregister(this.deviceId); }
      catch (stopError) { this.owner.error('Stopping the failed recovery:', messageOf(stopError)); }
      // Both the new plan and the old one failed to start. Say so with the
      // ORIGINAL failure: that is the one the user's change caused.
      this.owner.error('Could not restore the previous configuration:', messageOf(error));
      await this.owner.setUnavailable(
        messageOrNull(cause) ?? this.owner.translate('state.needsRepair'),
      );
    }
  }

  /** Managed plan changes must survive a restart, or their Flows leak. */
  private async persistPlan(plan: TPlan, generation = this.planGeneration): Promise<void> {
    await this.operations.run('store', async () => {
      if (generation !== this.planGeneration) return;
      await this.owner.setStoreValue(this.owner.storeKey, plan);
    });
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
        //
        // THROUGH planForRuntime, never the stored plan directly. The register
        // path below converts (a circadian light's registry() expands its two
        // ends into points); this path did not, so it handed the runtime a plan
        // with no `points` at all. See DeviceRuntime for what that cost.
        await runtime.updatePlan(this.owner.planForRuntime(updated));
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
      /**
       * The runtime never started, but its Flows may still exist.
       *
       * The references come from the raw store, NOT from a validated plan —
       * because a plan that failed validation is exactly the case where the
       * runtime never started, and its Flows still need removing. So they are
       * filtered through the shape check rather than trusted: a reference that
       * fails it names a flow id nothing in this app wrote, and handing that to
       * a delete is deleting a user's Flow on the strength of corrupted data.
       */
      const refs = validManagedFlowRefs(this.owner.rawFlowRefs());
      if (refs.length > 0) await this.owner.removeFlows(refs);
    }
    // After the Flows, and on BOTH branches — the journal outlives the device
    // either way, and it is keyed on a device id that will never come back.
    this.owner.forgetFlowJournal();
    this.owner.log('Deleted and its Flows cleaned up');
  }

  async uninit(): Promise<void> {
    await this.owner.registry().unregister(this.deviceId);
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
    if (this.applying) return;
    fireAndForget(
      this.publishState(state, detail),
      (...args: unknown[]) => this.owner.error(...args),
      'Applying a runtime state',
    );
  }

  private async publishState(state: ControllerState, detail?: StateDetail, persist = true): Promise<void> {
    const generation = this.planGeneration;
    const seq = ++this.stateSeq;
    return this.operations.run(STATE, async () => {
      if (generation !== this.planGeneration) return;
      // Persist whatever the runtime has learned about its own plan. Read from
      // the runtime rather than from a closure: by the time this runs it is the
      // live answer, and a stale one would clobber newer references.
      const runtime = this.owner.registry().get(this.deviceId);
      if (runtime && persist) {
        try {
          // The store is the base here: nothing newer has been written, and a
          // device type that folds runtime-owned fields back wants them on
          // whatever is currently persisted.
          await this.persistPlan(this.owner.planOf(runtime, this.storedPlan()), generation);
        } catch (error) {
          // A plan we could not persist is a plan whose Flow references will not
          // survive a restart. Repair is the honest state, and it must not be
          // reported as a clean save.
          //
          // Subject to the SAME staleness rule as every other verdict below.
          // It used to report unavailable and set `appliedSeq = seq`
          // unconditionally, which broke the guard in both directions: a stale
          // verdict took the device unavailable on a state that had already been
          // superseded, and `appliedSeq` moved BACKWARDS, after which verdicts
          // newer than the stale one stopped being rejected.
          this.owner.error('Could not persist the plan:', messageOf(error));
          if (seq < this.appliedSeq || generation !== this.planGeneration) return;
          this.appliedSeq = seq;
          await this.owner.setUnavailable(this.owner.translate('state.persistFailed'));
          return;
        }
      }

      // A verdict older than one already applied is stale — the classic case is
      // a register's callback landing after the apply that superseded it.
      if (seq < this.appliedSeq || generation !== this.planGeneration) return;
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

  // ------------------------------------------------------------------- values

  /**
   * Make the device's capability rows match what this device type declares.
   *
   * Homey applies a driver's `capabilities` array when it PAIRS a device and
   * never again, so a capability added in a release reaches nobody who already
   * owns the device unless it is added here (platform §18). The removal half is
   * the same promise in reverse: a capability withdrawn from a manifest has to
   * leave the tiles it is already on, or it sits there forever holding the last
   * value anything ever wrote to it.
   *
   * Every call is in its own try/catch and NONE of them can fail init. A device
   * whose tile is missing a row is a cosmetic problem; a device that refused to
   * start because of one would stop driving the lights, which is its whole job.
   */
  private async reconcileCapabilities(): Promise<void> {
    const wanted = new Set(this.owner.valueCapabilities);

    for (const capabilityId of wanted) {
      if (this.owner.hasCapability(capabilityId)) continue;
      try {
        await this.owner.addCapability(capabilityId);
        this.owner.log(`Added the ${capabilityId} capability`);
      } catch (error) {
        this.owner.error(`Could not add the ${capabilityId} capability:`, messageOf(error));
      }
    }

    for (const capabilityId of ALL_VALUE_CAPABILITIES) {
      if (wanted.has(capabilityId) || !this.owner.hasCapability(capabilityId)) continue;
      try {
        await this.owner.removeCapability(capabilityId);
        this.owner.log(`Removed the ${capabilityId} capability`);
      } catch (error) {
        this.owner.error(`Could not remove the ${capabilityId} capability:`, messageOf(error));
      }
    }
  }

  /**
   * A runtime published what it wants the lights to be.
   *
   * Called synchronously from inside a tick, like `onRuntimeState`, so it is
   * queued rather than awaited — on its own mutex key, so a capability write
   * that is slow to answer cannot hold up an availability verdict.
   *
   * No sequence number, unlike a verdict: `ValueBoard` only calls this when a
   * value actually moved, and one FIFO key means the writes land in the order
   * the moves happened. The staleness a verdict guards against — an old
   * runtime's callback overtaking a newer one — is answered by the generation
   * check at the `watchValues` call site instead.
   */
  onRuntimeValues(values: PublishedValues): void {
    fireAndForget(
      this.publishValues(values),
      (...args: unknown[]) => this.owner.error(...args),
      'Publishing runtime values',
    );
  }

  private async publishValues(values: PublishedValues): Promise<void> {
    const generation = this.planGeneration;
    return this.operations.run(VALUES, async () => {
      if (generation !== this.planGeneration) return;
      for (const [capabilityId, value] of Object.entries(values)) {
        // A device type that does not declare a capability is not a bug worth
        // logging: one runtime serves two device types, and the Colour Curve
        // Light is the only one of them with a colour to publish.
        if (!this.owner.hasCapability(capabilityId)) continue;
        try {
          await this.owner.setCapabilityValue(capabilityId, this.resolveValue(value));
        } catch (error) {
          this.owner.error(`Could not publish ${capabilityId}:`, messageOf(error));
        }
      }
    });
  }

  /**
   * Turn what `lib/` could produce into what a user reads.
   *
   * Only the colour needs it, and only because `lib/` has no `homey.__`: the
   * curve hands up one `palette.<id>` key on a flat coloured stretch and two
   * while it blends between them, and the blend is rendered through a locale key
   * of its own so the arrow is not a string hardcoded where nobody could
   * translate it.
   */
  private resolveValue(value: PublishedValue): unknown {
    if (!isTranslatable(value)) return value;
    const [from, to] = value.keys;
    if (!from) return null;
    if (!to || to === from) return this.owner.translate(from);
    return this.owner.translate('curve.colourBlend', {
      from: this.owner.translate(from),
      to: this.owner.translate(to),
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

/**
 * An error's message only if it has a real one — `null` otherwise.
 *
 * Deliberately NOT `messageOf()` from `support/homey-errors.ts`, which always
 * returns a string. The difference is load-bearing at exactly one call site:
 * the unavailable text a user reads on the device tile falls back to a
 * TRANSLATED sentence when the error carries nothing worth showing, and a
 * helper that answered "unknown error" or "[object Object]" instead would put
 * that in front of them. `null` is what lets `??` reach the locale key.
 *
 * Log lines want the other one, and use it.
 */
function messageOrNull(error: unknown): string | null {
  const message = String((error as Error | undefined)?.message ?? '');
  return message.length > 0 ? message : null;
}
