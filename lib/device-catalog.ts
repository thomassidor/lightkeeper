import type { HomeyApiService } from './homey-api-service';
import type { RawDevice, RawZone } from './homey-api-types';

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

  /**
   * Bumped by every invalidation, so a refresh can tell whether the world moved
   * under it. Same guard shape `CredentialService.superseded()` already uses.
   */
  private generation = 0;

  constructor(private readonly api: HomeyApiService) {}

  /** Zone and device changes invalidate the cache (zone re-resolution). */
  async watch(onChange: () => void): Promise<void> {
    const client = await this.api.read();
    const invalidate = () => {
      this.generation += 1;
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

  private async refreshNow(attempt = 0): Promise<void> {
    /**
     * The generation this pass belongs to.
     *
     * `refreshNow` awaits twice after the reads — `loadAppNames()` is a real
     * round trip every time, because `read()` never connects the `apps` manager
     * so `getApps()` is never cached, and `invalidate()` clears `appNames`
     * before every refresh it triggers. A device or zone event landing in that
     * window nulled `this.zones`, and the device loop then dereferenced
     * `this.zones!` and threw a TypeError: one refresh pass lost, and an opaque
     * line in the log or a spurious error on a pairing screen.
     *
     * Fixed by building into locals and publishing them together at the end, so
     * there is nothing half-assigned to trip over — and by discarding the result
     * if a newer invalidation has arrived, because publishing it would install a
     * view of the Homey that is already known to be stale.
     */
    const generation = this.generation;
    let client: any;
    let rawDevices: any;
    let rawZones: any;
    try {
      client = await this.api.read();
      /**
       * These two deliberately do NOT pass `NO_CACHE`, which is the other half
       * of platform §15's rule — a `getAll` site either opts out or says what it
       * is retaining and why. This is the why.
       *
       * They were changed to opt out, on the principle that a `getAll` retaining
       * every device on the Homey is what §15 warns about, and because that
       * snapshot is what `LightTargetAdapter.refresh()` was being served a stale
       * value from. Then it was MEASURED on hardware, 2 September 2026: a fresh
       * install with no devices went from 28.7 MB PSS to 33.9 MB. §15 explains
       * it — with `$updateCache: false` nothing is cached, so every invalidation
       * re-parses every device, and V8 never returns the pages a parse grew
       * into, so each one raises the floor permanently. Opting out traded 5 MB
       * of floor for retention that costs less than the parsing does.
       *
       * The staleness is fixed where it actually mattered instead:
       * `refresh()` passes `$cache: false` so it reads the lamp rather than the
       * snapshot, which is one single-device `get` per target at startup. Note
       * the asymmetry §15 records — `$cache: false` is the CORRECTNESS half and
       * `$updateCache: false` the memory half, and a reader that needs a live
       * value only needs the first.
       */
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

    // The seam: `homey-api` is untyped JS, so `any` stops HERE. RawZone says
    // which fields we expect, and nothing past this line reads an unknown one.
    const zones = new Map((Object.values(rawZones) as RawZone[]).map(z => [String(z.id), {
      id: String(z.id),
      name: String(z.name ?? ''),
      parent: typeof z.parent === 'string' ? z.parent : null,
    }]));

    await this.loadAppNames(client);

    const devices = new Map((Object.values(rawDevices) as RawDevice[]).map(d => {
      const ownerUri = typeof d.ownerUri === 'string' ? d.ownerUri : null;
      const zone = String(d.zone ?? '');
      return [String(d.id), {
        id: String(d.id),
        name: String(d.name ?? ''),
        class: String(d.class ?? ''),
        virtualClass: typeof d.virtualClass === 'string' ? d.virtualClass : null,
        zone,
        zoneName: zones.get(zone)?.name ?? '',
        // Device.driverUri and Device.zoneName are deprecated in homey-api 3.19
        // and log a warning on every access — resolve both ourselves instead.
        driverId: typeof d.driverId === 'string' ? d.driverId : null,
        ownerUri,
        ownerName: this.appNameFor(ownerUri),
        available: d.available !== false,
        capabilities: Array.isArray(d.capabilities) ? d.capabilities.map(String) : [],
        capabilitiesObj: normaliseCapabilities(d.capabilitiesObj),
      }];
    }));

    // Published TOGETHER, so no reader can ever see one without the other —
    // which is the whole of the fix.
    this.zones = zones;
    this.devices = devices;

    /**
     * Superseded while we were reading, so read again.
     *
     * Publishing first and retrying second, deliberately in that order: the
     * callers do `if (!this.devices) await this.refresh(); return this.devices!`
     * so a pass that returned without publishing would hand them the null
     * dereference this method exists to stop. A stale-but-complete view is
     * always better than none.
     *
     * Bounded, because the alternative is spinning through a storm of
     * `device.update` events. Two extra attempts is enough for a burst; past
     * that the view is at most one generation behind and the next question
     * after the storm settles refetches anyway.
     */
    if (this.generation !== generation && attempt < 2) {
      await this.refreshNow(attempt + 1);
    }
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
