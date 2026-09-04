import { LightkeeperDevice, type DeviceRegistry, type PlanMigration } from '../../lib/devices/lightkeeper-device';
import { migrateDaylightPlan } from '../../lib/daylight/daylight-migrations';
import type { DaylightPlan } from '../../lib/daylight/daylight-types';
import type { DaylightRuntime } from '../../lib/daylight/daylight-runtime';

/**
 * One virtual device per Daylight light.
 *
 * **It stores a response and reads a sensor.** No times in it at all, which is
 * what separates it from the two curve-driven types: they ask what the day looks
 * like, this asks what the room looks like. What it shares with them is the whole
 * of the rest — no Flows, no API key, and it never switches a light on or off
 * (platform §12).
 *
 * Everything shared with the other device types lives in `LightkeeperDevice`.
 * What is here is a `registry()` with no adapter in it, because the shapes agree
 * — the runtime takes exactly the plan this device stores, so no `planForRuntime`
 * and no `foldBackSimplePlan` equivalent. That makes this the shortest of the
 * five device files, and the difference is worth noticing rather than smoothing
 * over: a circadian light needs its adapter because it stores two ends and runs
 * a curve.
 *
 * Three consequences of generating no Flows, all inherited:
 *
 *  - **Nothing to clean up on delete.** `rawFlowRefs()` stays at the base's empty
 *    default, so the delete path unregisters the runtime and stops there.
 *  - **A rename reaches nothing.** The runtime exposes no `reconcileFlows`, which
 *    is what makes the base's `onRenamed` a no-op here.
 *  - **It can never be `needs_credential`.** No API key is involved in anything
 *    it does, which is why pairing never asks for one.
 *
 * And one thing copied from the schedule device deliberately: **paused is not
 * unavailable**. The tile carries the switch that un-pauses it, and an
 * unavailable device cannot be switched.
 */
module.exports = class DaylightDevice extends LightkeeperDevice<DaylightPlan, DaylightRuntime> {

  readonly storeKey = 'daylight';
  readonly missingKey = 'state.noDaylight';
  override readonly availableWhenDisabled = true;
  override readonly withPauseSwitch = true;

  migrate(raw: unknown): PlanMigration<DaylightPlan> {
    return migrateDaylightPlan(raw);
  }

  registry(): DeviceRegistry<DaylightPlan, DaylightRuntime> {
    return this.app.daylights;
  }

  /**
   * The runtime's plan is the stored plan, so this reads it straight back.
   *
   * There is deliberately nothing to fold in. A circadian light has to, because
   * pre-staging turns ITSELF off and that verdict must survive a restart; this
   * device type never pre-stages, so it learns nothing about the household that
   * it would be wrong to forget.
   */
  override planOf(runtime: DaylightRuntime): DaylightPlan {
    return runtime.currentPlan;
  }

  override planEnabled(plan: DaylightPlan): boolean {
    return plan.enabled;
  }

  override withEnabled(plan: DaylightPlan, enabled: boolean): DaylightPlan {
    return { ...plan, enabled };
  }

  override async prepareApply(
    previous: DaylightPlan | null,
    incoming: DaylightPlan,
  ): Promise<DaylightPlan> {
    return {
      ...incoming,
      // Keep the pause state across an edit: someone who paused this and then
      // adjusted the response did not ask for it to start running again.
      enabled: previous ? previous.enabled : incoming.enabled,
    };
  }

};
