import type { CatalogDevice, DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';

/**
 * "Are this thing's lights still there?" — the one health question both device
 * types ask.
 *
 * It used to live inside HealthMonitor as a private method taking a whole
 * ControllerProfile, even though it only ever read `profile.target`. A light
 * schedule has targets and no source device, no event surface and no mappings,
 * so reaching HealthMonitor.assess() for this answer would have meant inventing
 * a fake source to get past its first three checks. Pulled out here instead:
 * the input is a TargetSpec, which is all it was ever about.
 */

export interface TargetCount {
  total: number;
  available: number;
}

export async function countTargets(catalog: DeviceCatalog, target: TargetSpec): Promise<TargetCount> {
  if (target.kind === 'devices') {
    const devices = await Promise.all(target.deviceIds.map(id => catalog.device(id)));
    const present = devices.filter((d): d is CatalogDevice => d !== undefined);
    return {
      total: target.deviceIds.length,
      available: present.filter(d => d.available).length,
    };
  }

  const inZone = await catalog.devicesInZone(target.zoneId, target.includeSubzones);
  const lights = inZone.filter(d => d.capabilities.includes('onoff'));
  return { total: lights.length, available: lights.filter(d => d.available).length };
}

/**
 * The verdict, in the shape the device layer can translate. `partial` is
 * deliberately not a failure: a controller or schedule that reaches most of its
 * lights must not look broken (see ControllerDevice.onRuntimeState).
 */
export async function assessTargets(
  catalog: DeviceCatalog,
  target: TargetSpec,
): Promise<{ state: ControllerState; detail?: StateDetail; count: TargetCount }> {
  const count = await countTargets(catalog, target);

  if (count.available === 0) {
    return { state: 'needs_repair', detail: { key: 'state.noTargets' }, count };
  }

  if (count.available < count.total) {
    return {
      state: 'partial',
      detail: {
        key: 'state.someTargets',
        tokens: { count: count.total - count.available, total: count.total },
      },
      count,
    };
  }

  return { state: 'ready', count };
}
