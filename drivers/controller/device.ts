import Homey from 'homey';

import { migrateProfile } from '../../lib/profiles/migrations';
import { carryForwardFlows } from '../../lib/profiles/controller-profile';
import type {
  ControllerProfile, ControllerState, StateDetail,
} from '../../lib/profiles/controller-profile';

/**
 * One virtual device per configuration, and the lifecycle boundary for
 * the relationship: source reference, targets, mappings, managed flow
 * references, runtime status and diagnostics.
 *
 * The Device owns: profile loading, lifecycle registration,
 * status and deletion cleanup.
 */
module.exports = class ControllerDevice extends Homey.Device {

  private get app(): any {
    return this.homey.app;
  }

  private get controllerId(): string {
    return this.getData().id;
  }

  override async onInit() {
    const profile = this.loadProfile();
    if (!profile) {
      await this.setUnavailable(this.homey.__('state.noConfiguration'));
      return;
    }

    await this.app.controllers.register(
      this.controllerId,
      profile,
      (state: ControllerState, detail?: StateDetail) => void this.onRuntimeState(state, detail),
      (updated: ControllerProfile) => void this.persistProfile(updated),
      () => this.getName(),
    );
  }

  /**
   * Every profile carries schemaVersion and migrates deterministically
   * at startup. A profile we cannot migrate must not silently become defaults.
   */
  private loadProfile(): ControllerProfile | null {
    const raw = this.getStoreValue('profile');
    if (!raw) return null;

    try {
      const { profile, migrated, fromVersion } = migrateProfile(raw);
      if (migrated) {
        this.log(`Migrated profile from schema ${fromVersion}`);
        void this.setStoreValue('profile', profile);
      }
      return profile;
    } catch (error) {
      this.error('Could not migrate profile:', (error as Error)?.message);
      return null;
    }
  }

  /** Called by the pair/repair session when the user saves. */
  async applyProfile(profile: ControllerProfile): Promise<void> {
    // Carry forward the flows we already own, so reconciliation reuses them
    // instead of orphaning a set and creating duplicates — but only while the
    // source device is the same one. See carryForwardFlows().
    const previous: ControllerProfile | null = this.getStoreValue('profile') ?? null;
    const { profile: merged, obsolete } = carryForwardFlows(previous, profile);

    await this.setStoreValue('profile', merged);

    // The source moved, so these flows trigger on a device that is gone. Delete
    // them BEFORE registering, or reconciliation recreates their replacements
    // alongside them and the user is left with two sets.
    if (obsolete.length > 0) {
      const removed = await this.app.bridge.removeAll(obsolete);
      this.log(`Source changed: removed ${removed} of ${obsolete.length} flow(s) from the old remote`);
    }

    await this.app.controllers.register(
      this.controllerId,
      merged,
      (state: ControllerState, detail?: StateDetail) => void this.onRuntimeState(state, detail),
      (updated: ControllerProfile) => void this.persistProfile(updated),
      () => this.getName(),
    );
    await this.setAvailable();
  }

  /**
   * A device's name is the name of its Flow folder, so following a rename means
   * reconciling. Cheap: every flow is reused, and only the folder is rewritten.
   */
  override async onRenamed() {
    await this.app.controllers.get(this.controllerId)?.reconcileFlows();
  }

  /** Managed flow references must survive a restart, or they leak. */
  private async persistProfile(profile: ControllerProfile): Promise<void> {
    await this.setStoreValue('profile', profile);
  }

  /**
   * Resolve a runtime's state reason into text for this Homey's language.
   *
   * lib/ has no access to `homey.__`, so it hands up a locale key plus tokens.
   * Only strings we did not author — an API error, say — arrive as `text`, and
   * those are shown verbatim because there is nothing to translate.
   */
  private describe(detail: StateDetail | undefined, fallbackKey: string): string {
    if (detail?.key) return this.homey.__(detail.key, detail.tokens ?? {});
    if (detail?.text) return detail.text;
    return this.homey.__(fallbackKey);
  }

  private async onRuntimeState(state: ControllerState, detail?: StateDetail): Promise<void> {
    // Persist whatever reconciliation learned about our managed flows.
    const runtime = this.app.controllers.get(this.controllerId);
    if (runtime) await this.setStoreValue('profile', runtime.currentProfile);

    switch (state) {
      case 'ready':
        await this.setAvailable();
        break;
      case 'partial':
        // Still working — a partial controller must not look broken.
        await this.setAvailable();
        this.log(`Partial: ${this.describe(detail, 'state.someTargets')}`);
        break;
      case 'needs_credential':
        await this.setUnavailable(this.describe(detail, 'state.needsCredential'));
        break;
      case 'needs_repair':
        await this.setUnavailable(this.describe(detail, 'state.needsRepair'));
        break;
      case 'disabled':
        await this.setUnavailable(this.homey.__('state.disabled'));
        break;
    }
  }

  /**
   * Deleting the controller removes only flows provably managed
   * by it, plus its runtime subscriptions.
   */
  override async onDeleted() {
    const runtime = this.app.controllers.get(this.controllerId);
    if (runtime) {
      await runtime.destroy();
      await this.app.controllers.unregister(this.controllerId);
    } else {
      // The runtime never started, but its flows may still exist.
      const profile: ControllerProfile | null = this.getStoreValue('profile') ?? null;
      if (profile?.managedFlows?.length) {
        await this.app.bridge.removeAll(profile.managedFlows);
      }
    }
    this.log('Controller deleted and its Flows cleaned up');
  }

  override async onUninit() {
    await this.app.controllers?.unregister(this.controllerId);
  }

};
