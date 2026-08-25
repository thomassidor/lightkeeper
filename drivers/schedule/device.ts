import Homey from 'homey';

import { migrateSchedulePlan } from '../../lib/schedules/schedule-migrations';
import type { SchedulePlan } from '../../lib/schedules/schedule-types';
import type { ControllerState, StateDetail } from '../../lib/profiles/controller-profile';

/**
 * One virtual device per light schedule.
 *
 * The device owns: plan loading and migration, lifecycle registration, the
 * pause switch, status text and deletion cleanup.
 *
 * Two things differ from the controller device, both deliberate:
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
module.exports = class ScheduleDevice extends Homey.Device {

  private get app(): any {
    return this.homey.app;
  }

  private get scheduleId(): string {
    return this.getData().id;
  }

  override async onInit() {
    this.registerCapabilityListener('onoff', async (value: boolean) => this.setEnabled(value));

    const plan = this.loadPlan();
    if (!plan) {
      await this.setUnavailable(this.homey.__('state.noSchedule'));
      return;
    }

    // The tile reflects the stored plan, not the other way round: a restart must
    // not silently un-pause a schedule someone paused.
    await this.setCapabilityValue('onoff', plan.enabled).catch(() => { /* first init */ });

    // A paused schedule reports 'disabled', which is the runtime's initial state
    // too — so no state CHANGE fires and onRuntimeState never runs. Without this,
    // a schedule paused while it was unavailable (a dead key, say) kept that
    // message and could not be resumed from its own tile.
    if (!plan.enabled) await this.setAvailable();

    await this.register(plan);
  }

  /** A plan we cannot migrate must not silently become defaults. */
  private loadPlan(): SchedulePlan | null {
    const raw = this.getStoreValue('schedule');
    if (!raw) return null;

    try {
      const { plan, migrated, fromVersion } = migrateSchedulePlan(raw);
      if (migrated) {
        this.log(`Migrated schedule from schema ${fromVersion}`);
        void this.setStoreValue('schedule', plan);
      }
      return plan;
    } catch (error) {
      this.error('Could not migrate schedule:', (error as Error)?.message);
      return null;
    }
  }

  private async register(plan: SchedulePlan): Promise<void> {
    await this.app.schedules.register(
      this.scheduleId,
      plan,
      (state: ControllerState, detail?: StateDetail) => void this.onRuntimeState(state, detail),
      (updated: SchedulePlan) => void this.setStoreValue('schedule', updated),
      () => this.getName(),
    );
  }

  /** Called by the pair/repair session when the user saves. */
  async applyPlan(plan: SchedulePlan): Promise<void> {
    const previous: SchedulePlan | null = this.getStoreValue('schedule') ?? null;
    const merged: SchedulePlan = {
      ...plan,
      // Keep the pause state across an edit: someone who paused a schedule and
      // then adjusted a time did not ask for it to start running again.
      enabled: previous ? previous.enabled : plan.enabled,
      managedFlows: previous?.managedFlows ?? [],
    };

    await this.setStoreValue('schedule', merged);
    await this.setCapabilityValue('onoff', merged.enabled).catch(() => { /* not yet initialised */ });
    await this.register(merged);
    await this.setAvailable();
  }

  /** The pause switch on the tile, and anything the user's own Flows do to it. */
  private async setEnabled(enabled: boolean): Promise<void> {
    const plan: SchedulePlan | null = this.getStoreValue('schedule') ?? null;
    if (!plan) return;

    const updated = { ...plan, enabled };
    await this.setStoreValue('schedule', updated);

    const runtime = this.app.schedules.get(this.scheduleId);
    if (runtime) {
      // Restarts the runtime, which re-reconciles and — on resume — catches up a
      // window that is already in progress, so un-pausing at 22:30 lights the
      // room rather than waiting for tomorrow.
      await runtime.updatePlan(updated);
    } else {
      await this.register(updated);
    }

    this.log(enabled ? 'Schedule resumed' : 'Schedule paused');
  }

  /**
   * lib/ has no access to `homey.__`, so a runtime hands up a locale key plus
   * tokens. Only strings we did not author — an API error, say — arrive as
   * `text`, and those are shown verbatim because there is nothing to translate.
   */
  private describe(detail: StateDetail | undefined, fallbackKey: string): string {
    if (detail?.key) return this.homey.__(detail.key, detail.tokens ?? {});
    if (detail?.text) return detail.text;
    return this.homey.__(fallbackKey);
  }

  private async onRuntimeState(state: ControllerState, detail?: StateDetail): Promise<void> {
    // Persist whatever reconciliation learned about our managed flows.
    const runtime = this.app.schedules.get(this.scheduleId);
    if (runtime) await this.setStoreValue('schedule', runtime.currentPlan);

    switch (state) {
      case 'ready':
        await this.setAvailable();
        break;
      case 'partial':
        // Still working — a schedule reaching most of its lights must not look
        // broken.
        await this.setAvailable();
        this.log(`Partial: ${this.describe(detail, 'state.someTargets')}`);
        break;
      case 'disabled':
        // Paused, not broken. See the class comment: marking it unavailable would
        // hide the switch that turns it back on.
        await this.setAvailable();
        break;
      case 'needs_credential':
        await this.setUnavailable(this.describe(detail, 'state.needsCredential'));
        break;
      case 'needs_repair':
        await this.setUnavailable(this.describe(detail, 'state.needsRepair'));
        break;
    }
  }

  /**
   * A schedule's name is the name of its Flow folder. A paused schedule does
   * not reconcile, and picks the new name up when it is resumed.
   */
  override async onRenamed() {
    await this.app.schedules.get(this.scheduleId)?.reconcileFlows();
  }

  /** Deleting a schedule removes only the Flows provably managed by it. */
  override async onDeleted() {
    const runtime = this.app.schedules.get(this.scheduleId);
    if (runtime) {
      await runtime.destroy();
      await this.app.schedules.unregister(this.scheduleId);
    } else {
      // The runtime never started, but its flows may still exist.
      const plan: SchedulePlan | null = this.getStoreValue('schedule') ?? null;
      if (plan?.managedFlows?.length) {
        await this.app.bridge.removeAll(plan.managedFlows);
      }
    }
    this.log('Schedule deleted and its Flows cleaned up');
  }

  override async onUninit() {
    await this.app.schedules?.unregister(this.scheduleId);
  }

};
