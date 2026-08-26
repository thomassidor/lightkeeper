import { LightkeeperDevice, type DeviceRegistry, type PlanMigration } from '../../lib/devices/lightkeeper-device';
import { migrateProfile } from '../../lib/profiles/migrations';
import { carryForwardFlows } from '../../lib/profiles/controller-profile';
import type { ControllerProfile, ManagedFlowReference } from '../../lib/profiles/controller-profile';
import type { ControllerRuntime } from '../../lib/runtime/controller-runtime';

/**
 * One virtual device per configuration, and the lifecycle boundary for the
 * relationship: source reference, targets, mappings, managed flow references,
 * runtime status and diagnostics.
 *
 * Everything this shares with the other two device types — load-and-migrate,
 * transactional apply, translated state text, teardown — lives in
 * `LightkeeperDevice`. What is left below is what makes a controller a
 * controller: `disabled` means unavailable (nothing on the tile does anything,
 * unlike the two switchable types), and a change of SOURCE has to take the old
 * remote's Flows with it.
 */
module.exports = class ControllerDevice extends LightkeeperDevice<ControllerProfile, ControllerRuntime> {

  readonly storeKey = 'profile';
  readonly missingKey = 'state.noConfiguration';

  migrate(raw: unknown): PlanMigration<ControllerProfile> {
    // The controller's migration module predates the shared shape and calls its
    // payload `profile`. Renaming it would touch the whole migration suite for
    // nothing, so the adaptation is here.
    const { profile, migrated, fromVersion } = migrateProfile(raw);
    return { plan: profile, migrated, fromVersion };
  }

  registry(): DeviceRegistry<ControllerProfile, ControllerRuntime> {
    return this.app.controllers;
  }

  override planOf(runtime: ControllerRuntime): ControllerProfile {
    return runtime.currentProfile;
  }

  override flowRefs(plan: ControllerProfile): ManagedFlowReference[] {
    return plan.managedFlows ?? [];
  }

  /**
   * Carry forward the flows we already own, so reconciliation reuses them
   * instead of orphaning a set and creating duplicates — but only while the
   * source device is the same one. See carryForwardFlows().
   */
  override async prepareApply(
    previous: ControllerProfile | null,
    incoming: ControllerProfile,
  ): Promise<ControllerProfile> {
    const { profile: merged, obsolete } = carryForwardFlows(previous, incoming);

    // The source moved, so these flows trigger on a device that is gone. Delete
    // them BEFORE registering, or reconciliation recreates their replacements
    // alongside them and the user is left with two sets.
    if (obsolete.length > 0) {
      const removed = await this.app.bridge.removeAll(obsolete);
      this.log(`Source changed: removed ${removed} of ${obsolete.length} flow(s) from the old remote`);
    }

    return merged;
  }

  /** The name the pairing session has always called. */
  async applyProfile(profile: ControllerProfile): Promise<void> {
    return this.applyPlan(profile);
  }

};
