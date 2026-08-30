import { targetLights } from './target-picker';
import type { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';

/**
 * The default name a newly paired device gets.
 *
 * There is no name field on any last screen: Homey lets a user rename a device
 * afterwards, and that is the natural place for it — so the name has to be good
 * enough that most people never do. "Reading lamp circadian" is; "Circadian
 * light 2" is not.
 *
 * Lifted out of the four drivers, which held four copies of the same twelve
 * lines with one word different. They are not identical — the controller names
 * itself after the remote AND the lights, the other three after the lights alone
 * — so this is two functions rather than one with a flag.
 *
 * `lib/` cannot translate (see the rule in CLAUDE.md), so every word that
 * reaches a user is passed IN. That is also why these are not one function: the
 * caller supplies the vocabulary, and the shapes differ.
 */

/** What a name is built from, so the caller does not have to fetch it twice. */
export interface NameParts {
  /** Used when there is no target at all, or no light in it. */
  fallback: string;
  /** Appended after the room or lamp: "Reading lamp <suffix>". */
  suffix: string;
  /** Stands in for a zone whose name cannot be read. */
  zoneFallback: string;
}

/**
 * "Kitchen schedule", "Reading lamp curve", "3 lights circadian".
 *
 * Shared by the schedule, circadian and Curve drivers.
 */
export async function deriveSuffixedName(
  catalog: DeviceCatalog,
  target: TargetSpec | undefined,
  parts: NameParts,
): Promise<string> {
  if (!target) return parts.fallback;

  if (target.kind === 'zone') {
    const zones = await catalog.allZones();
    const zone = zones.find(candidate => candidate.id === target.zoneId);
    return `${zone?.name ?? parts.zoneFallback} ${parts.suffix}`;
  }

  const lights = await targetLights(catalog, target);
  if (lights.length === 0) return parts.fallback;
  if (lights.length === 1) return `${lights[0]!.name} ${parts.suffix}`;

  // Where every light shares a room, the room reads better than a list.
  const zoneNames = new Set(lights.map(light => light.zoneName).filter(Boolean));
  if (zoneNames.size === 1) return `${[...zoneNames][0]} ${parts.suffix}`;

  return `${lights.length} lights ${parts.suffix}`;
}

/**
 * "Hall remote → Kitchen", "Hall remote → Ceiling + Reading lamp".
 *
 * The controller's own shape: a controller is a relationship between one remote
 * and some lights, and a name that mentioned only one half of it would be the
 * less useful half.
 */
export async function deriveControllerName(
  catalog: DeviceCatalog,
  target: TargetSpec | undefined,
  source: string,
  zoneFallback = 'zone',
): Promise<string> {
  if (!target) return source;

  if (target.kind === 'zone') {
    const zones = await catalog.allZones();
    const zone = zones.find(candidate => candidate.id === target.zoneId);
    return `${source} → ${zone?.name ?? zoneFallback}`;
  }

  const lights = await targetLights(catalog, target);
  if (lights.length === 0) return source;
  if (lights.length === 1) return `${source} → ${lights[0]!.name}`;

  const zoneNames = new Set(lights.map(light => light.zoneName).filter(Boolean));
  if (zoneNames.size === 1) return `${source} → ${[...zoneNames][0]}`;

  // Two is short enough to name both, and "2 lights" would be strictly less
  // informative than the two names it replaces.
  if (lights.length === 2) return `${source} → ${lights[0]!.name} + ${lights[1]!.name}`;
  return `${source} → ${lights.length} lights`;
}
