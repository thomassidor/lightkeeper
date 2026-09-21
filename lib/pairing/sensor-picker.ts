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
  const [devices, zones] = await Promise.all([catalog.allDevices(), catalog.allZones()]);
  const selected = new Set(selectedIds);

  /**
   * EVERY room, not only the rooms that have a sensor.
   *
   * A room with none is the interesting row: the question this screen asks is
   * "where should the reading come from", and the answer "the kitchen has one
   * and this room does not" is only visible if the rooms with none are on the
   * list saying so. Listing only the rooms that have one showed two cards and
   * left a house of eleven rooms looking like a house of two.
   */
  const byZone = new Map<string, { zoneId: string; zoneName: string; sensors: PickerSensor[] }>();
  for (const zone of zones as Array<{ id: string; name: string }>) {
    byZone.set(zone.id, { zoneId: zone.id, zoneName: zone.name, sensors: [] });
  }

  for (const device of devices) {
    if (!device.capabilities.includes(LUMINANCE_CAPABILITY)) continue;

    const key = device.zone ?? 'unknown';
    if (!byZone.has(key)) {
      // A zone the zone list did not carry, which is the roomless bucket. The
      // VIEW names it, for the reason target-picker.ts gives: a label built in
      // `lib/` could never be translated.
      byZone.set(key, { zoneId: key, zoneName: '', sensors: [] });
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
      // Rooms alphabetically, and the roomless bucket last whatever the view
      // ends up calling it: it is not a room, so it does not sort among them.
      .sort((a, b) => (a.zoneName === '' ? 1 : b.zoneName === '' ? -1
        : a.zoneName.localeCompare(b.zoneName)))
      .map(room => ({
        /**
         * The room's own id, and the screen needs it rather than wanting it:
         * one room is open at a time and the open one is remembered by id. It
         * used to be absent, so every room compared `undefined === undefined`
         * and the picker opened all of them at once.
         *
         * Never the NAME — two zones may share one, and a room called after the
         * roomless bucket's label would then open it.
         */
        zoneId: room.zoneId,
        zoneName: room.zoneName,
        unzoned: room.zoneName === '',
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
