import Homey from 'homey';

import { migrateCircadianPlan } from '../../lib/circadian/circadian-migrations';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { ControllerState, StateDetail } from '../../lib/profiles/controller-profile';

/**
 * One virtual device per circadian light.
 *
 * The device owns: plan loading and migration, lifecycle registration, the pause
 * switch, status text and deletion cleanup.
 *
 * Three things differ from the schedule device, all for the same underlying
 * reason — this device type generates no Flows:
 *
 *  - **Nothing to clean up on delete.** `onDeleted` unregisters the runtime and
 *    stops there. There are no managed Flows to remove and no orphans to leave.
 *  - **No `onRenamed`.** A schedule's name is the name of its Flow folder, so a
 *    rename has to reach the bridge. This device's name appears in diagnostics
 *    and nowhere else.
 *  - **It can never be `needs_credential`.** No API key is involved in anything
 *    it does, which is why pairing never asks for one.
 *
 * What it copies from the schedule device deliberately: **paused is not
 * unavailable**. The tile carries the switch that un-pauses it, and an
 * unavailable device cannot be switched.
 */
module.exports = class CircadianDevice extends Homey.Device {

  private get app(): any {
    return this.homey.app;
  }

  private get circadianId(): string {
    return this.getData().id;
  }

  override async onInit() {
    this.registerCapabilityListener('onoff', async (value: boolean) => this.setEnabled(value));

    const plan = this.loadPlan();
    if (!plan) {
      await this.setUnavailable(this.homey.__('state.noCurve'));
      return;
    }

    // The tile reflects the stored plan, not the other way round: a restart must
    // not silently un-pause something someone paused.
    await this.setCapabilityValue('onoff', plan.enabled).catch(() => { /* first init */ });

    // A paused device reports 'disabled', which is the runtime's initial state
    // too — so no state CHANGE fires and onRuntimeState never runs. Without this,
    // a device paused while it was unavailable kept that message and could not be
    // resumed from its own tile.
    if (!plan.enabled) await this.setAvailable();

    await this.register(plan);
  }

  /** A plan we cannot migrate must not silently become defaults. */
  private loadPlan(): CircadianPlan | null {
    const raw = this.getStoreValue('circadian');
    if (!raw) return null;

    try {
      const { plan, migrated, fromVersion } = migrateCircadianPlan(raw);
      if (migrated) {
        this.log(`Migrated circadian plan from schema ${fromVersion}`);
        void this.setStoreValue('circadian', plan);
      }
      return plan;
    } catch (error) {
      this.error('Could not migrate circadian plan:', (error as Error)?.message);
      return null;
    }
  }

  private async register(plan: CircadianPlan): Promise<void> {
    await this.app.circadian.register(
      this.circadianId,
      plan,
      (state: ControllerState, detail?: StateDetail) => void this.onRuntimeState(state, detail),
      // Pre-staging can turn itself off after watching a lamp come on from a
      // colour write. That verdict is the one thing here worth persisting.
      (updated: CircadianPlan) => void this.setStoreValue('circadian', updated),
      () => this.getName(),
    );
  }

  /** Called by the pair/repair session when the user saves. */
  async applyPlan(plan: CircadianPlan): Promise<void> {
    const previous: CircadianPlan | null = this.getStoreValue('circadian') ?? null;
    const merged: CircadianPlan = {
      ...plan,
      // Keep the pause state across an edit: someone who paused this and then
      // adjusted the curve did not ask for it to start running again.
      enabled: previous ? previous.enabled : plan.enabled,
    };

    await this.setStoreValue('circadian', merged);
    await this.setCapabilityValue('onoff', merged.enabled).catch(() => { /* not yet initialised */ });
    await this.register(merged);
    await this.setAvailable();
  }

  /** The pause switch on the tile, and anything the user's own Flows do to it. */
  private async setEnabled(enabled: boolean): Promise<void> {
    const plan: CircadianPlan | null = this.getStoreValue('circadian') ?? null;
    if (!plan) return;

    const updated = { ...plan, enabled };
    await this.setStoreValue('circadian', updated);

    const runtime = this.app.circadian.get(this.circadianId);
    if (runtime) {
      // Restarts the runtime, which on resume applies the curve straight away —
      // so un-pausing at dusk corrects the room rather than waiting a minute.
      await runtime.updatePlan(updated);
    } else {
      await this.register(updated);
    }

    this.log(enabled ? 'Circadian resumed' : 'Circadian paused');
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
    // Persist whatever the runtime has decided about its own plan — pre-staging,
    // in practice.
    const runtime = this.app.circadian.get(this.circadianId);
    if (runtime) await this.setStoreValue('circadian', runtime.currentPlan);

    switch (state) {
      case 'ready':
        await this.setAvailable();
        break;
      case 'partial':
        // Still working — reaching most of its lights must not look broken.
        await this.setAvailable();
        this.log(`Partial: ${this.describe(detail, 'state.someTargets')}`);
        break;
      case 'disabled':
        // Paused, not broken. See the class comment.
        await this.setAvailable();
        break;
      case 'needs_credential':
        // Unreachable by construction; handled so the switch is exhaustive and
        // a future change cannot fall through it silently.
        await this.setUnavailable(this.describe(detail, 'state.needsCredential'));
        break;
      case 'needs_repair':
        await this.setUnavailable(this.describe(detail, 'state.needsRepair'));
        break;
    }
  }

  /** No Flows were ever created, so there is nothing to sweep up. */
  override async onDeleted() {
    await this.app.circadian?.unregister(this.circadianId);
    this.log('Circadian light deleted');
  }

  override async onUninit() {
    await this.app.circadian?.unregister(this.circadianId);
  }

};
