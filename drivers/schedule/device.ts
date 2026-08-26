import { LightkeeperDevice, type DeviceRegistry, type PlanMigration } from '../../lib/devices/lightkeeper-device';
import { migrateSchedulePlan } from '../../lib/schedules/schedule-migrations';
import type { SchedulePlan } from '../../lib/schedules/schedule-types';
import type { ScheduleRuntime } from '../../lib/schedules/schedule-runtime';

/**
 * One virtual device per light schedule.
 *
 * Everything it shares with the other two device types lives in
 * `LightkeeperDevice`. Two things differ from a controller, both deliberate:
 *
 *  - **Paused is not unavailable.** The controller marks a disabled controller
 *    unavailable, which is fine because nothing on its tile does anything. A
 *    paused schedule's tile carries the switch that un-pauses it, and an
 *    unavailable device cannot be switched — so 'disabled' keeps the device
 *    available here and lives in the capability value instead.
 *  - **Managed Flows are always carried forward.** The controller has to drop
 *    them when its source device changes (carryForwardFlows), because a flow's
 *    trigger embeds that device's id. A schedule's trigger is a time, and the
 *    only device id it references is this one, which cannot change.
 */
module.exports = class ScheduleDevice extends LightkeeperDevice<SchedulePlan, ScheduleRuntime> {

  readonly storeKey = 'schedule';
  readonly missingKey = 'state.noSchedule';
  override readonly availableWhenDisabled = true;
  override readonly withPauseSwitch = true;

  migrate(raw: unknown): PlanMigration<SchedulePlan> {
    return migrateSchedulePlan(raw);
  }

  registry(): DeviceRegistry<SchedulePlan, ScheduleRuntime> {
    return this.app.schedules;
  }

  override planOf(runtime: ScheduleRuntime): SchedulePlan {
    return runtime.currentPlan;
  }

  override planEnabled(plan: SchedulePlan): boolean {
    return plan.enabled;
  }

  override withEnabled(plan: SchedulePlan, enabled: boolean): SchedulePlan {
    return { ...plan, enabled };
  }

  /** See the controller's: raw, because the plan may have failed validation. */
  override rawFlowRefs(): unknown {
    return (this.getStoreValue(this.storeKey) as { managedFlows?: unknown } | undefined)?.managedFlows;
  }

  override async prepareApply(
    previous: SchedulePlan | null,
    incoming: SchedulePlan,
  ): Promise<SchedulePlan> {
    return {
      ...incoming,
      // Keep the pause state across an edit: someone who paused a schedule and
      // then adjusted a time did not ask for it to start running again.
      enabled: previous ? previous.enabled : incoming.enabled,
      managedFlows: previous?.managedFlows ?? [],
    };
  }

};
