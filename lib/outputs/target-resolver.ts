import type { DeviceCatalog, CatalogDevice } from '../device-catalog';
import type { TargetSpec } from './light-intent';
import type { TargetCapabilities, TargetStateCache } from './target-state-cache';

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
        if (device) devices.push(device);
        else missing.push(id);
      }
    } else {
      const inZone = await this.catalog.devicesInZone(spec.zoneId, spec.includeSubzones);
      // A zone contains everything; only controllable lights are targets.
      devices.push(...inZone.filter(d => d.capabilities.includes('onoff')));
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
        // Read, never assumed: capability options are not uniform (CLAUDE.md §6
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
      cache.initialise(device.id, {
        onoff: device.capabilitiesObj.onoff?.value as boolean | undefined,
        dim: device.capabilitiesObj.dim?.value as number | undefined,
        light_temperature: device.capabilitiesObj.light_temperature?.value as number | undefined,
        light_hue: device.capabilitiesObj.light_hue?.value as number | undefined,
        light_saturation: device.capabilitiesObj.light_saturation?.value as number | undefined,
      });
    }
  }
}
