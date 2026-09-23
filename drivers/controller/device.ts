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
 * Everything this shares with the other four device types — load-and-migrate,
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
   *
   * A changed source's Flows are RELEASED here and deleted in `afterApply`,
   * never deleted here. This used to delete them before registering, on the
   * argument that reconciliation would otherwise recreate their replacements
   * beside them — which was true, and which the release now answers instead:
   * a released Flow is not in the new profile and not in the bridge's journal,
   * so the new runtime's first pass neither reuses it nor mistakes it for an
   * edit of its own. What deleting-first cost was the rollback. An apply that
   * failed after the delete restored the previous profile with `managedFlows`
   * naming Flows that no longer existed, so "the save failed, nothing changed"
   * was untrue: the old remote had silently lost every Flow it had.
   */
  override async prepareApply(
    previous: ControllerProfile | null,
    incoming: ControllerProfile,
  ): Promise<ControllerProfile> {
    const { profile: merged, obsolete } = carryForwardFlows(previous, incoming);
    if (obsolete.length > 0) {
      this.app.bridge.releaseReferences(this.deviceId, obsolete.map(ref => ref.flowId));
    }
    return merged;
  }

  /**
   * The old remote's Flows, deleted now that the new profile is running and
   * stored.
   *
   * Recomputed from the two profiles rather than carried over from
   * `prepareApply`, so there is no state held on the device between the two
   * calls — the pair of plans IS the answer. A delete that does not stick is
   * handed to the bridge's cleanup list rather than forgotten: deletes are
   * idempotent, so the next reconcile retries every one of them safely.
   */
  override async afterApply(previous: ControllerProfile | null, committed: ControllerProfile): Promise<void> {
    const { obsolete } = carryForwardFlows(previous, committed);
    if (obsolete.length === 0) return;

    const removed = await this.app.bridge.removeAll(obsolete);
    this.log(`Source changed: removed ${removed} of ${obsolete.length} flow(s) from the old remote`);
    if (removed < obsolete.length) {
      this.app.bridge.deferCleanup(this.deviceId, obsolete.map(ref => ref.flowId));
    }
  }

};
