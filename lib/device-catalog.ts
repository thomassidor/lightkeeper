import type { HomeyApiService } from './homey-api-service';

/** Devices, zones, owning apps and drivers, and target capabilities. */

export interface CatalogDevice {
  id: string;
  name: string;
  class: string;
  virtualClass: string | null;
  zone: string;
  zoneName: string;
  /** e.g. homey:app:com.ikea.tradfri:remote_control_n2 */
  driverId: string | null;
  /** e.g. homey:app:com.ikea.tradfri */
  ownerUri: string | null;
  ownerName: string;
  available: boolean;
  capabilities: string[];
  capabilitiesObj: Record<string, CatalogCapability>;
}

export interface CatalogCapability {
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  units?: string | null;
}

export interface CatalogZone {
  id: string;
  name: string;
  parent: string | null;
}

const LIGHT_CAPABILITIES = ['onoff', 'dim', 'light_temperature'] as const;

export class DeviceCatalog {
  private devices: Map<string, CatalogDevice> | null = null;
  private zones: Map<string, CatalogZone> | null = null;
  private appNames = new Map<string, string>();
  /**
   * The refresh in flight, shared by every caller that arrives while it runs.
   *
   * A cold cache and a burst of questions — which is exactly what a boot with
   * three devices is — used to fetch every device and zone on the Homey once per
   * question. Nothing was wrong with the result; it was N round trips for one
   * answer, and the pairing screen asks several in a row.
   */
  private refreshing: Promise<void> | null = null;

  constructor(private readonly api: HomeyApiService) {}

  /** Zone and device changes invalidate the cache (zone re-resolution). */
  async watch(onChange: () => void): Promise<void> {
    const client = await this.api.read();
    const invalidate = () => {
      this.devices = null;
      this.zones = null;
      // App names too: an integration installed or updated after boot would
      // otherwise show as its raw `homey:app:<id>` URI for the rest of the app's
      // life, because loadAppNames() returns early on a non-empty map.
      this.appNames = new Map();
      onChange();
    };

    for (const [manager, events] of [
      [client.devices, ['device.create', 'device.delete', 'device.update']],
      [client.zones, ['zone.create', 'zone.delete', 'zone.update']],
    ] as const) {
      for (const event of events) {
        if (typeof manager?.on !== 'function') continue;
        manager.on(event, invalidate);
        this.api.track(() => {
          if (typeof manager.off === 'function') manager.off(event, invalidate);
        });
      }
    }
  }

  async allDevices(): Promise<CatalogDevice[]> {
    if (!this.devices) await this.refresh();
    return [...this.devices!.values()];
  }

  async device(deviceId: string): Promise<CatalogDevice | undefined> {
    if (!this.devices) await this.refresh();
    return this.devices!.get(deviceId);
  }

  async allZones(): Promise<CatalogZone[]> {
    if (!this.zones) await this.refresh();
    return [...this.zones!.values()];
  }

  /** Devices in a zone, optionally including every descendant zone. */
  async devicesInZone(zoneId: string, includeSubzones: boolean): Promise<CatalogDevice[]> {
    const [devices, zones] = await Promise.all([this.allDevices(), this.allZones()]);
    const wanted = new Set<string>([zoneId]);

    if (includeSubzones) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const zone of zones) {
          if (zone.parent && wanted.has(zone.parent) && !wanted.has(zone.id)) {
            wanted.add(zone.id);
            grew = true;
          }
        }
      }
    }

    return devices.filter(d => wanted.has(d.zone));
  }

  /** Anything that can be driven as a light — never hard-filtered on class alone. */
  async lightCandidates(): Promise<CatalogDevice[]> {
    const devices = await this.allDevices();
    return devices.filter(d => d.capabilities.includes('onoff'));
  }

  /** How many of these targets support each light capability. */
  async capabilitySummary(deviceIds: string[]): Promise<{ onoff: number; dim: number; light_temperature: number; total: number }> {
    const devices = await Promise.all(deviceIds.map(id => this.device(id)));
    const present = devices.filter((d): d is CatalogDevice => d !== undefined);

    const summary = { onoff: 0, dim: 0, light_temperature: 0, total: present.length };
    for (const device of present) {
      for (const capability of LIGHT_CAPABILITIES) {
        if (device.capabilities.includes(capability)) summary[capability] += 1;
      }
    }
    return summary;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const attempt = this.refreshNow().finally(() => {
      // Only retract our own attempt: a later caller may already have replaced
      // it. Cleared on failure as well as success, or one transient failure
      // caches its own rejection forever.
      if (this.refreshing === attempt) this.refreshing = null;
    });
    this.refreshing = attempt;
    return attempt;
  }

  private async refreshNow(): Promise<void> {
    let client: any;
    let rawDevices: any;
    let rawZones: any;
    try {
      client = await this.api.read();
      [rawDevices, rawZones] = await Promise.all([
        client.devices.getDevices(),
        client.zones.getZones(),
      ]);
    } catch (error) {
      // A socket that has gone away answers every later read identically. Say so
      // and let the next call rebuild the client rather than failing forever.
      this.api.reportReadFailure(error);
      throw error;
    }

    this.zones = new Map(Object.values(rawZones).map((z: any) => [z.id, {
      id: z.id, name: z.name, parent: z.parent ?? null,
    }]));

    await this.loadAppNames(client);

    this.devices = new Map(Object.values(rawDevices).map((d: any) => {
      const ownerUri: string | null = d.ownerUri ?? null;
      return [d.id, {
        id: d.id,
        name: d.name,
        class: d.class,
        virtualClass: d.virtualClass ?? null,
        zone: d.zone,
        zoneName: this.zones!.get(d.zone)?.name ?? '',
        // Device.driverUri and Device.zoneName are deprecated in homey-api 3.19
        // and log a warning on every access — resolve both ourselves instead.
        driverId: d.driverId ?? null,
        ownerUri,
        ownerName: this.appNameFor(ownerUri),
        available: d.available !== false,
        capabilities: d.capabilities ?? [],
        capabilitiesObj: normaliseCapabilities(d.capabilitiesObj),
      }];
    }));
  }

  /** Always show the owning integration, by name rather than URI. */
  private async loadAppNames(client: any): Promise<void> {
    if (this.appNames.size > 0) return;
    try {
      const apps = await client.apps.getApps();
      for (const app of Object.values(apps) as any[]) {
        if (app?.id) this.appNames.set(`homey:app:${app.id}`, app.name ?? app.id);
      }
    } catch {
      // Names are cosmetic; the URI fallback is still informative.
    }
  }

  private appNameFor(ownerUri: string | null): string {
    if (!ownerUri) return 'Homey';
    return this.appNames.get(ownerUri) ?? ownerUri.replace(/^homey:app:/, '');
  }
}

function normaliseCapabilities(raw: unknown): Record<string, CatalogCapability> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CatalogCapability> = {};
  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    out[id] = {
      value: value?.value,
      min: value?.min,
      max: value?.max,
      step: value?.step,
      decimals: value?.decimals,
      units: value?.units ?? null,
    };
  }
  return out;
}
