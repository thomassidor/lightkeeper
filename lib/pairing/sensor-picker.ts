import type { DeviceCatalog } from '../device-catalog';
import { LUMINANCE_CAPABILITY } from '../daylight/daylight-types';

/**
 * The "choose light sensors" list, shared by every screen that carries the
 * daylight card.
 *
 * A sibling of target-picker.ts and shaped like it on purpose — grouped by room,
 * `selected` per row, the current selection echoed back — because the two lists
 * sit on the same screens and a user should not have to learn two idioms. It is
 * also lifted out of the drivers for the same reason that one was: four drivers
 * answer this, and four copies of it is four chances for them to disagree.
 *
 * What it does NOT share is any part of the light path. A `measure_luminance`
 * device is read-only and carries no `min`/`max` (platform §16), so it must
 * never reach `TargetResolver`, `TargetStateCache` or the `Capability` union —
 * those describe what this app WRITES. Nothing here touches them.
 */

export interface PickerSensor {
  id: string;
  name: string;
  zoneName: string;
  available: boolean;
  /** The device's current reading, in lux, or null if it has never reported one. */
  lux: number | null;
  selected: boolean;
}

/**
 * Every device on the Homey that can report a luminance, grouped by room.
 *
 * Deliberately NOT filtered by class. A lux reading most often comes from a
 * motion sensor, sometimes from a weather station, occasionally from a wall
 * switch nobody would think of as a sensor — and `capabilities.includes` is the
 * whole of the question. This is the same judgement `lightCandidates()` makes in
 * the other direction: offer it, and let the user decide.
 *
 * The current reading is included because it is what makes the screen usable at
 * all: "the hall sensor says 340 lx" is how somebody chooses a lux range, and
 * without it the two numbers on that card are a guess.
 */
export async function listSensorsPayload(
  catalog: DeviceCatalog,
  selectedIds: readonly string[],
): Promise<Record<string, unknown>> {
  const devices = await catalog.allDevices();
  const selected = new Set(selectedIds);

  const byZone = new Map<string, { zoneName: string; sensors: PickerSensor[] }>();
  for (const device of devices) {
    if (!device.capabilities.includes(LUMINANCE_CAPABILITY)) continue;

    const key = device.zone ?? 'unknown';
    if (!byZone.has(key)) {
      byZone.set(key, { zoneName: device.zoneName || 'Unassigned', sensors: [] });
    }
    byZone.get(key)!.sensors.push({
      id: device.id,
      name: device.name,
      zoneName: device.zoneName,
      available: device.available,
      lux: readingOf(device.capabilitiesObj[LUMINANCE_CAPABILITY]?.value),
      selected: selected.has(device.id),
    });
  }

  return {
    rooms: [...byZone.values()]
      .sort((a, b) => a.zoneName.localeCompare(b.zoneName))
      .map(room => ({
        zoneName: room.zoneName,
        sensors: [...room.sensors].sort((a, b) => a.name.localeCompare(b.name)),
      })),
    /**
     * Echoed back so the card can say so when a plan names a sensor that is no
     * longer on the Homey. Dropping it silently would let a user save a plan
     * whose sensor list had quietly shrunk, and wonder later why the room does
     * not follow the room.
     */
    selected: [...selected],
  };
}

/**
 * Not a bare `Number()`: `Number(null)` is 0, and 0 lux is pitch dark rather
 * than "no reading". The same guard the live subscription applies, for the same
 * reason — a sensor with a flat battery must read as unknown on this screen, not
 * as a dark room.
 */
function readingOf(value: unknown): number | null {
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
  } else if (typeof value !== 'number') {
    return null;
  }
  const lux = Number(value);
  return Number.isFinite(lux) && lux >= 0 ? lux : null;
}
