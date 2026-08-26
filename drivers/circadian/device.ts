import { LightkeeperDevice, type DeviceRegistry, type PlanMigration } from '../../lib/devices/lightkeeper-device';
import { migrateCircadianPlan } from '../../lib/circadian/circadian-migrations';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { CircadianRuntime } from '../../lib/circadian/circadian-runtime';

/**
 * One virtual device per circadian light.
 *
 * Everything it shares with the other two device types lives in
 * `LightkeeperDevice`. Three things differ, all for the same underlying reason —
 * this device type generates no Flows (CLAUDE.md §12):
 *
 *  - **Nothing to clean up on delete.** `flowRefs()` stays at the base's empty
 *    default, so the delete path unregisters the runtime and stops there. There
 *    are no managed Flows to remove and no orphans to leave.
 *  - **A rename reaches nothing.** A schedule's name is the name of its Flow
 *    folder, so a rename has to reconcile. This device's runtime exposes no
 *    `reconcileFlows`, which is what makes the base's `onRenamed` a no-op here.
 *  - **It can never be `needs_credential`.** No API key is involved in anything
 *    it does, which is why pairing never asks for one. The base still maps the
 *    state, so a future change cannot fall through it silently.
 *
 * What it copies from the schedule device deliberately: **paused is not
 * unavailable**. The tile carries the switch that un-pauses it, and an
 * unavailable device cannot be switched.
 */
module.exports = class CircadianDevice extends LightkeeperDevice<CircadianPlan, CircadianRuntime> {

  readonly storeKey = 'circadian';
  readonly missingKey = 'state.noCurve';
  override readonly availableWhenDisabled = true;
  override readonly withPauseSwitch = true;

  migrate(raw: unknown): PlanMigration<CircadianPlan> {
    return migrateCircadianPlan(raw);
  }

  registry(): DeviceRegistry<CircadianPlan, CircadianRuntime> {
    return this.app.circadian;
  }

  /**
   * Pre-staging can turn itself off after watching a lamp come on from a colour
   * write. That verdict is the one thing here worth persisting.
   */
  override planOf(runtime: CircadianRuntime): CircadianPlan {
    return runtime.currentPlan;
  }

  override planEnabled(plan: CircadianPlan): boolean {
    return plan.enabled;
  }

  override withEnabled(plan: CircadianPlan, enabled: boolean): CircadianPlan {
    return { ...plan, enabled };
  }

  override async prepareApply(
    previous: CircadianPlan | null,
    incoming: CircadianPlan,
  ): Promise<CircadianPlan> {
    return {
      ...incoming,
      // Keep the pause state across an edit: someone who paused this and then
      // adjusted the curve did not ask for it to start running again.
      enabled: previous ? previous.enabled : incoming.enabled,
    };
  }

};
