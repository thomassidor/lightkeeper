import type { DeviceCatalog, CatalogDevice } from '../device-catalog';
import type { TargetSpec } from './light-intent';
import type { TargetCapabilities, TargetStateCache } from './target-state-cache';
import { liveValuesOf } from './target-state-cache';

/**
 * Resolves device lists and zones into a concrete target set plus
 * the capability matrix.
 *
 * Zones re-resolve on device create, delete and zone update, so lights added
 * to a zone are picked up without reconfiguration.
 */

export interface ResolvedTargets {
  devices: CatalogDevice[];
  missing: string[];
  summary: { onoff: number; dim: number; light_temperature: number; total: number };
}

export class TargetResolver {
  constructor(private readonly catalog: DeviceCatalog) {}

  async resolve(spec: TargetSpec): Promise<ResolvedTargets> {
    const devices: CatalogDevice[] = [];
    const missing: string[] = [];

    if (spec.kind === 'devices') {
      for (const id of spec.deviceIds) {
        const device = await this.catalog.device(id);
        /**
         * An explicit list is honoured as given — a class-`socket` plug with a
         * lamp in it is a target, because silently doing nothing when somebody
         * picked it is the worse answer.
         *
         * Our OWN devices are the one exception, and they are not the same kind
         * of thing. A Lightkeeper device declares `class: "service"` with an
         * `onoff` capability (the pause switch on its own tile), so it used to
         * pass the picker's filter; writing to one pauses or unpauses it, and a
         * curve pointed at its sibling fights it every minute. There is no
         * reading under which that is what the user meant, so it is dropped
         * here too rather than only at the doors that offer it — a plan saved
         * before the picker was fixed would otherwise go on running.
         */
        if (device && this.catalog.isOwnDevice(device)) continue;
        if (device) devices.push(device);
        else missing.push(id);
      }
    } else {
      // A zone contains everything; only controllable lights are targets, and
      // never our own devices — DeviceCatalog.lightsInZone() owns both rules.
      devices.push(...await this.catalog.lightsInZone(spec.zoneId, spec.includeSubzones));
    }

    const summary = { onoff: 0, dim: 0, light_temperature: 0, total: devices.length };
    for (const device of devices) {
      for (const capability of ['onoff', 'dim', 'light_temperature'] as const) {
        if (device.capabilities.includes(capability)) summary[capability] += 1;
      }
    }

    return { devices, missing, summary };
  }

  /**
   * Load each target's own capability options into the cache. It matters
   * that min, max and step must not be assumed identical across targets.
   */
  primeCache(devices: CatalogDevice[], cache: TargetStateCache): void {
    for (const device of devices) {
      const capabilities: TargetCapabilities = { onoff: device.capabilities.includes('onoff') };

      for (const capability of ['dim', 'light_temperature', 'light_hue', 'light_saturation'] as const) {
        if (!device.capabilities.includes(capability)) continue;
        const options = device.capabilitiesObj[capability];
        // Read, never assumed: capability options are not uniform (platform §6
        // — `onoff` has none at all, `dim` carries units and decimals,
        // `light_temperature` carries decimals and no units).
        capabilities[capability] = {
          min: options?.min ?? 0,
          max: options?.max ?? 1,
          step: options?.step,
          decimals: options?.decimals,
        };
      }

      /**
       * `light_mode` is a boolean rather than a range.
       *
       * It is an enum ('color' | 'temperature'), so there is nothing to clamp
       * against — only whether the lamp HAS a temperature mode to be switched out
       * of. A colour-only lamp has hue and saturation and no mode, and must still
       * be given a colour.
       */
      if (device.capabilities.includes('light_mode')) capabilities.light_mode = true;

      cache.setCapabilities(device.id, capabilities);
      cache.initialise(device.id, liveValuesOf(device));
    }
  }
}
