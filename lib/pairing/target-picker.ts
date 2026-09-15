import { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';

/**
 * The "choose lights" screen's data, shared by every device type.
 *
 * The remote controller, the light schedule and the circadian light pick their
 * lights from the same view file, so they had better answer it with the same
 * payload — this was lifted verbatim out of the controller driver rather than
 * reimplemented, and all three now call it.
 */

/** Only the capabilities this app acts on; the rest are noise on that screen. */
const OFFERED_CAPABILITIES = ['onoff', 'dim', 'light_temperature'] as const;

export interface PickerLight {
  id: string;
  name: string;
  zoneName: string;
  capabilities: string[];
}

/**
 * Actual lights first, then everything else that merely has `onoff`.
 *
 * The `onoff` rule is right and stays — a plug with a lamp in it is somebody's
 * light. What it costs is a picker that offers, on the reference Homey, 54
 * "lights" including a dishwasher, a NAS, a tablet and an air purifier. Sorting
 * rather than filtering keeps every one of them reachable and stops them sitting
 * between two bulbs; the view labels the second group so the order is legible
 * rather than mysterious.
 *
 * Alphabetical within each group, as before, so a room of ordinary bulbs looks
 * exactly as it did.
 */
function sortLights<T extends { name: string; isLight: boolean }>(lights: T[]): T[] {
  return [...lights].sort((a, b) => {
    if (a.isLight !== b.isLight) return a.isLight ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function listTargetsPayload(
  catalog: DeviceCatalog,
  current: TargetSpec | undefined,
): Promise<Record<string, unknown>> {
  const [lights, zones] = await Promise.all([catalog.lightCandidates(), catalog.allZones()]);
  const selected = current?.kind === 'devices' ? new Set(current.deviceIds) : new Set<string>();

  // Grouped by room: a house with 39 lights is unusable as a flat grid.
  const byZone = new Map<string, { zoneId: string; zoneName: string; lights: unknown[] }>();
  /* A light Homey has put in no zone still has to appear, and the word for that
     is the VIEW's: `lib/` has no `homey.__`, so a label invented here could
     never be translated. It used to read 'Unassigned', hardcoded, which is the
     shape of bug the translation rule exists to catch. */
  for (const device of lights as any[]) {
    const key = device.zone ?? 'unknown';
    if (!byZone.has(key)) {
      byZone.set(key, { zoneId: key, zoneName: device.zoneName ?? '', lights: [] });
    }
    byZone.get(key)!.lights.push({
      id: device.id,
      name: device.name,
      zoneName: device.zoneName,
      available: device.available,
      // Offered, and not pretended to be a bulb. See sortLights().
      isLight: DeviceCatalog.isLightClass(device),
      capabilities: device.capabilities.filter((c: string) =>
        (OFFERED_CAPABILITIES as readonly string[]).includes(c)),
      selected: selected.has(device.id),
    });
  }

  return {
    rooms: [...byZone.values()]
      // Rooms alphabetically, and the roomless bucket last whatever it is
      // called: it is not a room, so it does not belong among them.
      .sort((a, b) => (a.zoneName === '' ? 1 : b.zoneName === '' ? -1
        : a.zoneName.localeCompare(b.zoneName)))
      .map(room => ({
        /**
         * The room's own zone id, so "Select all" can store a ZONE target.
         *
         * Ticking every light in one room stores `{ kind: 'zone' }` rather than
         * the device ids, which is what makes a lamp added to that room later
         * get picked up on its own. Unticking one converts it back to a device
         * list — the review screen states which of the two the device ended up
         * with, because the difference is invisible otherwise.
         */
        zoneId: room.zoneId,
        zoneName: room.zoneName,
        /** The view names this room itself, and greys it. See above. */
        unzoned: room.zoneName === '',
        lights: sortLights(room.lights as any[]),
      })),
    zones: zones.map((zone: any) => ({ id: zone.id, name: zone.name })),
    /** Every candidate, for the search box's own "Search 54 lights" placeholder. */
    total: (lights as any[]).length,
    current: current ?? null,
  };
}

/** The device ids a spec resolves to. A zone contributes only its lights. */
export async function targetDeviceIds(catalog: DeviceCatalog, spec: TargetSpec): Promise<string[]> {
  if (spec.kind === 'devices') return spec.deviceIds;

  const inZone = await catalog.lightsInZone(spec.zoneId, spec.includeSubzones);
  return inZone.map(d => d.id);
}

/** The chosen lights, named, for per-rule and per-schedule display. */
export async function targetLights(catalog: DeviceCatalog, spec: TargetSpec): Promise<PickerLight[]> {
  const ids = await targetDeviceIds(catalog, spec);
  const lights = await Promise.all(ids.map(id => catalog.device(id)));
  return lights.filter(Boolean).map((device: any) => ({
    id: device.id,
    name: device.name,
    zoneName: device.zoneName,
    capabilities: device.capabilities.filter((c: string) =>
      (OFFERED_CAPABILITIES as readonly string[]).includes(c)),
  }));
}

/**
 * How many lights, and what they can do between them. Drives the partial-support
 * disclosure: a group where two of five lights dim still offers dimming, and says
 * so, rather than hiding the control or pretending everything supports it.
 */
export interface CapabilitySupport {
  onoff: number;
  dim: number;
  light_temperature: number;
  /** How many of them can take a colour, which is what offers the colour job. */
  light_hue: number;
  total: number;
}

export async function resolveSummary(
  catalog: DeviceCatalog,
  spec: TargetSpec,
): Promise<{ count: number; support: CapabilitySupport }> {
  const ids = await targetDeviceIds(catalog, spec);
  const support = await catalog.capabilitySummary(ids);
  return { count: ids.length, support };
}
