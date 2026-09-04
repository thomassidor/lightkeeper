import type { CatalogDevice, DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';

/**
 * "Are this thing's lights still there?" — the one health question both device
 * types ask.
 *
 * It lived inside HealthMonitor as a private method taking a whole
 * ControllerProfile, even though it only ever read `profile.target`. A light
 * schedule has targets and no source device, no event surface and no mappings,
 * so reaching HealthMonitor.assess() for this answer would have meant inventing
 * a fake source to get past its first three checks. Pulled out here instead:
 * the input is a TargetSpec, which is all it was ever about.
 *
 * HealthMonitor now calls this rather than keeping its own copy — it kept one
 * for a while, which is exactly the drift this file was extracted to prevent.
 */

export interface TargetCount {
  total: number;
  available: number;
  /**
   * Of the available ones, how many have stopped taking writes.
   *
   * Counted separately from `available` because the two have different causes
   * and different sentences: a light Homey reports as unavailable has gone
   * away, and a light that is `available` while refusing every write is
   * powered off at the wall or off the mesh. Measured on hardware — see
   * `LightTargetAdapter.unwritableTargets()` for the run.
   */
  unwritable: number;
}

/**
 * The ids the adapter says are failing every write. Empty when nobody asked —
 * a pairing rig has no adapter, and neither does any of the tests that only
 * care about availability.
 */
export type UnwritableTargets = ReadonlySet<string>;

const NONE: UnwritableTargets = new Set<string>();

async function countTargets(
  catalog: DeviceCatalog,
  target: TargetSpec,
  unwritable: UnwritableTargets,
): Promise<TargetCount> {
  const count = (devices: CatalogDevice[], total: number): TargetCount => {
    const reachable = devices.filter(d => d.available);
    return {
      total,
      available: reachable.length,
      unwritable: reachable.filter(d => unwritable.has(d.id)).length,
    };
  };

  if (target.kind === 'devices') {
    const devices = await Promise.all(target.deviceIds.map(id => catalog.device(id)));
    const present = devices.filter((d): d is CatalogDevice => d !== undefined);
    return count(present, target.deviceIds.length);
  }

  const lights = await catalog.lightsInZone(target.zoneId, target.includeSubzones);
  return count(lights, lights.length);
}

/**
 * The verdict, in the shape the device layer can translate. `partial` is
 * deliberately not a failure: a controller or schedule that reaches most of its
 * lights must not look broken (see ControllerDevice.onRuntimeState).
 */
export async function assessTargets(
  catalog: DeviceCatalog,
  target: TargetSpec,
  unwritable: UnwritableTargets = NONE,
): Promise<{ state: ControllerState; detail?: StateDetail; count: TargetCount }> {
  const count = await countTargets(catalog, target, unwritable);

  if (count.available === 0) {
    return {
      state: 'needs_repair',
      // `text` is the English fallback, for logs and diagnostics only.
      detail: { key: 'state.noTargets', text: 'None of its lights are available.' },
      count,
    };
  }

  /**
   * Every light Homey still reports as available is refusing to be driven.
   *
   * Ranked above the availability shortfall below on purpose: if two of five
   * lights went missing and the other three stopped answering, "3 lights are
   * not responding" is the sentence that gets somebody to the wall switch,
   * and "2 of 5 lights unavailable" is the one that sends them looking for a
   * light that is sitting right there.
   */
  if (count.unwritable > 0 && count.unwritable === count.available) {
    return {
      state: 'needs_repair',
      detail: {
        key: 'state.noTargetsResponding',
        tokens: { count: count.unwritable },
        text: `${count.unwritable} light(s) are not responding to Lightkeeper.`,
      },
      count,
    };
  }

  if (count.unwritable > 0) {
    return {
      state: 'partial',
      detail: {
        key: 'state.someTargetsNotResponding',
        tokens: { count: count.unwritable, total: count.total },
        text: `${count.unwritable} of ${count.total} lights are not responding.`,
      },
      count,
    };
  }

  if (count.available < count.total) {
    const missing = count.total - count.available;
    return {
      state: 'partial',
      detail: {
        key: 'state.someTargets',
        tokens: { count: missing, total: count.total },
        text: `${missing} of ${count.total} lights unavailable.`,
      },
      count,
    };
  }

  return { state: 'ready', count };
}
