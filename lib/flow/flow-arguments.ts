import type { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import { LEAVE_ALONE } from './set-lights';

/**
 * What the `set_lights` card's three autocomplete arguments answer with.
 *
 * Separate from `set-lights.ts` because it is a different kind of decision:
 * that file is what the card DOES, this is what it offers to choose from. Both
 * are here rather than in `app.ts` for the same reason as ever — `app.ts`
 * extends `Homey.App` and cannot be imported by a test (platform §13).
 *
 * No prose lives here. A Homey autocomplete row carries a name and a
 * description, and `lib/` has no `homey.__`, so every word that is not a
 * device's own name is passed in by the shell that can translate it. The same
 * rule the pairing pickers follow.
 */

export interface Choice {
  /** What the card stores. Opaque to Homey, parsed back by this file. */
  id: string;
  name: string;
  description?: string;
}

/** Zones and devices share one argument, so the id has to say which it is. */
const ZONE = 'zone:';
const DEVICES = 'devices:';

export function targetChoiceId(spec: TargetSpec): string {
  return spec.kind === 'zone' ? `${ZONE}${spec.zoneId}` : `${DEVICES}${spec.deviceIds.join(',')}`;
}

/**
 * The lights a stored choice means, or nothing.
 *
 * Returns `null` rather than guessing on anything it does not recognise: the
 * argument is user-editable like every other Flow argument, and a spec invented
 * from a malformed id is a write to lights nobody chose. Fail closed.
 */
export function parseTargetChoice(id: unknown): TargetSpec | null {
  if (typeof id !== 'string' || id.length === 0) return null;

  if (id.startsWith(ZONE)) {
    const zoneId = id.slice(ZONE.length);
    // Subzones included, matching what "select all in this room" stores at
    // pairing: a lamp added to a sub-room later is one the user expects covered.
    return zoneId.length > 0 ? { kind: 'zone', zoneId, includeSubzones: true } : null;
  }

  if (id.startsWith(DEVICES)) {
    const deviceIds = id.slice(DEVICES.length).split(',').filter(part => part.length > 0);
    return deviceIds.length > 0 ? { kind: 'devices', deviceIds } : null;
  }

  return null;
}

/** Case-insensitive contains, over both the name and the description. */
export function matching(choices: readonly Choice[], query: unknown): Choice[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) return [...choices];
  return choices.filter(choice =>
    choice.name.toLowerCase().includes(needle)
    || (choice.description ?? '').toLowerCase().includes(needle));
}

/**
 * Every room, then every light.
 *
 * Rooms first because a room is what most of this card's Flows want — "the
 * lights in the hall", not a list of three bulbs — and because a room keeps
 * working when a lamp is added to it, which a device list does not. That is the
 * same argument the pairing screen's "select all" makes for storing a zone.
 */
export async function lightChoices(
  catalog: DeviceCatalog,
  labels: { room: string },
): Promise<Choice[]> {
  const [lights, zones] = await Promise.all([catalog.lightCandidates(), catalog.allZones()]);

  // Only rooms with a light in them: a room that offers nothing is a row that
  // writes nothing, and a house has many more zones than lit ones.
  const lit = new Set(lights.map(light => light.zone));

  const rooms: Choice[] = zones
    .filter(zone => lit.has(zone.id))
    .map(zone => ({ id: targetChoiceId({ kind: 'zone', zoneId: zone.id, includeSubzones: true }),
      name: zone.name, description: labels.room }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const bulbs: Choice[] = lights
    .map(light => ({ id: targetChoiceId({ kind: 'devices', deviceIds: [light.id] }),
      name: light.name, description: light.zoneName }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...rooms, ...bulbs];
}

/**
 * The Lightkeeper devices that can answer one of the two source arguments,
 * with "leave it alone" at the top.
 *
 * At the top rather than the bottom because it is the answer for half the Flows
 * this card will be used in — a motion Flow that wants the colour right and the
 * brightness left to a schedule is one source, not two.
 */
export function sourceChoices(
  sources: readonly { id: string; name: string }[],
  labels: { leaveAlone: string; leaveAloneHint: string },
): Choice[] {
  return [
    { id: LEAVE_ALONE, name: labels.leaveAlone, description: labels.leaveAloneHint },
    ...[...sources]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(source => ({ id: source.id, name: source.name })),
  ];
}
