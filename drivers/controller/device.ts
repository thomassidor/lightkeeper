import { LightkeeperDevice, type DeviceRegistry, type PlanMigration } from '../../lib/devices/lightkeeper-device';
import { migrateProfile } from '../../lib/profiles/migrations';
import { carryForwardFlows } from '../../lib/profiles/controller-profile';
import type { ControllerProfile } from '../../lib/profiles/controller-profile';
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

  /**
   * Straight through. The controller's chain used to call its payload `profile`
   * and this method existed only to rename it — a shim justified in a comment
   * as sparing "the whole migration suite", which turned out to be one
   * destructure here and a handful of lines in two test files.
   */
  migrate(raw: unknown): PlanMigration<ControllerProfile> {
    return migrateProfile(raw);
  }

  registry(): DeviceRegistry<ControllerProfile, ControllerRuntime> {
    return this.app.controllers;
  }

  override planOf(runtime: ControllerRuntime): ControllerProfile {
    return runtime.currentProfile;
  }

  /**
   * Read from the raw store, not from a validated profile: this feeds the delete
   * path that runs when no profile could be loaded at all, and a profile that
   * failed validation is exactly that case. The lifecycle shape-checks them.
   */
  override rawFlowRefs(): unknown {
    return (this.getStoreValue(this.storeKey) as { managedFlows?: unknown } | undefined)?.managedFlows;
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

};
