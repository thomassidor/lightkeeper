import { LightkeeperDevice, type DeviceRegistry, type PlanMigration } from '../../lib/devices/lightkeeper-device';
import { migrateCircadianPlan } from '../../lib/circadian/circadian-migrations';
import { expandSimplePlan, foldBackSimplePlan, type SimpleCircadianPlan } from '../../lib/circadian/simple-curve';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { CircadianRuntime } from '../../lib/circadian/circadian-runtime';
import type { CircadianRuntimeManager } from '../../lib/circadian/circadian-runtime-manager';
import type { ControllerState, StateDetail } from '../../lib/profiles/controller-profile';

/**
 * One virtual device per circadian light.
 *
 * **It stores two ends of the day and runs a curve.** The shape between them is a
 * constant in `lib/circadian/simple-curve.ts`, derived on every register rather
 * than stored — so an installed device picks up an improved shape, and what is
 * persisted is only the two answers the user gave. Its sibling device type,
 * `drivers/curve/`, is the same engine with the curve itself exposed.
 *
 * Everything shared with the other device types lives in `LightkeeperDevice`.
 * What is here is the expansion above, plus three differences from a schedule,
 * all for the same underlying reason — this device type generates no Flows
 * (platform §12):
 *
 *  - **Nothing to clean up on delete.** `rawFlowRefs()` stays at the base's empty
 *    default, so the delete path unregisters the runtime and stops there.
 *  - **A rename reaches nothing.** A schedule's name is the name of its Flow
 *    folder. This device's runtime exposes no `reconcileFlows`, which is what
 *    makes the base's `onRenamed` a no-op here.
 *  - **It can never be `needs_credential`.** No API key is involved in anything
 *    it does, which is why pairing never asks for one. The base still maps the
 *    state, so a future change cannot fall through it silently.
 *
 * What it copies from the schedule device deliberately: **paused is not
 * unavailable**. The tile carries the switch that un-pauses it, and an
 * unavailable device cannot be switched.
 *
 * The THIRD type argument is what this device type is: it stores a
 * `SimpleCircadianPlan` and its runtime takes a `CircadianPlan`. Naming the
 * second shape is what makes `planForRuntime` mandatory here rather than
 * optional — the two are mutually incompatible, so the base's identity default
 * cannot satisfy the constraint. Before it was named, `setEnabled` handed the
 * stored plan straight to `updatePlan` and the pause switch threw.
 */
module.exports = class CircadianDevice
  extends LightkeeperDevice<SimpleCircadianPlan, CircadianRuntime, CircadianPlan> {

  readonly storeKey = 'circadian';
  readonly missingKey = 'state.noCurve';
  override readonly availableWhenDisabled = true;
  override readonly withPauseSwitch = true;

  migrate(raw: unknown): PlanMigration<SimpleCircadianPlan> {
    return migrateCircadianPlan(raw);
  }

  /**
   * The expansion, on EVERY path into the runtime rather than only on register.
   *
   * `registry()` below has always converted; `DeviceLifecycle.setEnabled` did
   * not, and handed the stored two-ended plan to a runtime that reads
   * `plan.points`. Both paths go through this now.
   */
  override planForRuntime(plan: SimpleCircadianPlan): CircadianPlan {
    return expandSimplePlan(plan);
  }

  /**
   * The registry takes POINTS; this device stores two ends.
   *
   * The adapter is here rather than in the manager because the expansion is this
   * device type's business: one registry serves both circadian and curve lights,
   * which is what keeps §12's "ONE `setInterval` for every circadian device on
   * the Homey" true across two device types rather than two timers.
   */
  registry(): DeviceRegistry<SimpleCircadianPlan, CircadianRuntime> {
    // Typed as the manager rather than as the narrower DeviceRegistry, because
    // its `register` takes one more argument than the base's contract does — the
    // device kind — and that argument is the point of the adapter.
    const registry = this.app.curves as CircadianRuntimeManager;
    return {
      register: (
        id: string,
        plan: SimpleCircadianPlan,
        onStateChange: (state: ControllerState, detail?: StateDetail) => void,
        onPlanChange: (plan: SimpleCircadianPlan) => Promise<void>,
        displayName: () => string,
      ) => registry.register(
        id,
        expandSimplePlan(plan),
        onStateChange,
        // What comes back is the EXPANDED plan, and only two of its fields can
        // have changed at runtime — see planOf.
        async expanded => onPlanChange(foldBackSimplePlan(plan, expanded)),
        displayName,
        // So diagnostics and the settings page can tell a circadian light from a
        // curve one; they share the registry.
        'circadian',
      ),
      unregister: (id: string) => registry.unregister(id),
      get: (id: string) => registry.get(id),
    };
  }

  /**
   * The runtime's view of its plan, folded back into what this device stores.
   *
   * Only two fields can move while a runtime is running: `preStage`, which turns
   * ITSELF off after observing a lamp come on from a colour write (§12), and
   * `enabled`. Everything else in the expanded plan is derived, so reading it back
   * would be reading back a constant.
   */
  override planOf(runtime: CircadianRuntime, base: SimpleCircadianPlan | null): SimpleCircadianPlan {
    /**
     * Folded onto `base`, NOT onto the store.
     *
     * `apply()` persists after registering, deliberately, so on a repair the
     * store still holds the plan the user has just replaced. Reading it here
     * meant a repair took effect on the lights and was then written back as the
     * old plan: success on screen, the old ends in the screen next time it was
     * opened, and the old curve after the next restart. `base` is the plan this
     * persist is actually for.
     */
    const onto = base ?? (this.getStoreValue(this.storeKey) as SimpleCircadianPlan | undefined);
    if (!onto) throw new Error('This circadian light has no stored plan');
    return foldBackSimplePlan(onto, runtime.currentPlan);
  }

  override planEnabled(plan: SimpleCircadianPlan): boolean {
    return plan.enabled;
  }

  override withEnabled(plan: SimpleCircadianPlan, enabled: boolean): SimpleCircadianPlan {
    return { ...plan, enabled };
  }

  override async prepareApply(
    previous: SimpleCircadianPlan | null,
    incoming: SimpleCircadianPlan,
  ): Promise<SimpleCircadianPlan> {
    return {
      ...incoming,
      // Keep the pause state across an edit: someone who paused this and then
      // adjusted the ends did not ask for it to start running again.
      enabled: previous ? previous.enabled : incoming.enabled,
    };
  }

};
