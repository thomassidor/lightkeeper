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

/** The caller's `translate`, plural-aware: `names.lightCount` is a plural group. */
export type NameTranslate = (key: string, tokens?: Record<string, string | number>) => string;

/** What a name is built from, so the caller does not have to fetch it twice. */
export interface NameParts {
  /** Used when there is no target at all, or no light in it. */
  fallback: string;
  /** Joined to the room or lamp by `names.suffixed`: "Reading lamp <suffix>". */
  suffix: string;
  /**
   * Every other word, and the WORD ORDER: "Kitchen schedule" is "Planning
   * cuisine" in French, so the join is a locale template (`names.suffixed`),
   * never a `${place} ${suffix}` here.
   */
  translate: NameTranslate;
}

/**
 * "Kitchen schedule", "Reading lamp curve", "3 lights circadian".
 *
 * Shared by the schedule, circadian and Curve drivers.
 */
/**
 * A name, TRIMMED, or the fallback if there is nothing left of it.
 *
 * Homey does not stop a user naming a lamp `" "` or leaving a zone name empty,
 * and an empty one produced `" schedule"` — a device whose tile appears to have
 * no name at all, in a list where every other one does. The fallbacks below
 * exist for exactly this and were simply never reached: `??` catches `null` and
 * `undefined`, and an empty string is neither.
 *
 * Module-level because both derivations below need it, and they had the same
 * gap in the same three places each.
 */
function named(value: string | undefined, fallback: string): string {
  return (value ?? '').trim() || fallback;
}

export async function deriveSuffixedName(
  catalog: DeviceCatalog,
  target: TargetSpec | undefined,
  parts: NameParts,
): Promise<string> {
  if (!target) return parts.fallback;
  const { translate, suffix } = parts;
  const zoneFallback = translate('names.zone');
  const suffixed = (place: string) => translate('names.suffixed', { place, suffix });

  if (target.kind === 'zone') {
    const zones = await catalog.allZones();
    const zone = zones.find(candidate => candidate.id === target.zoneId);
    return suffixed(named(zone?.name, zoneFallback));
  }

  const lights = await targetLights(catalog, target);
  if (lights.length === 0) return parts.fallback;
  if (lights.length === 1) return suffixed(named(lights[0]!.name, zoneFallback));

  // Where every light shares a room, the room reads better than a list.
  const zoneNames = new Set(lights.map(light => (light.zoneName ?? '').trim()).filter(Boolean));
  if (zoneNames.size === 1) return suffixed([...zoneNames][0]!);

  return suffixed(translate('names.lightCount', { count: lights.length }));
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
  translate: NameTranslate,
): Promise<string> {
  if (!target) return source;
  const zoneFallback = translate('names.zone');
  const to = (lights: string) => translate('names.controller', { source, lights });

  if (target.kind === 'zone') {
    const zones = await catalog.allZones();
    const zone = zones.find(candidate => candidate.id === target.zoneId);
    return to(named(zone?.name, zoneFallback));
  }

  const lights = await targetLights(catalog, target);
  if (lights.length === 0) return source;
  if (lights.length === 1) return to(named(lights[0]!.name, zoneFallback));

  const zoneNames = new Set(lights.map(light => (light.zoneName ?? '').trim()).filter(Boolean));
  if (zoneNames.size === 1) return to([...zoneNames][0]!);

  // Two is short enough to name both, and "2 lights" would be strictly less
  // informative than the two names it replaces.
  if (lights.length === 2) {
    return to(translate('names.pair', {
      first: named(lights[0]!.name, zoneFallback),
      second: named(lights[1]!.name, zoneFallback),
    }));
  }
  return to(translate('names.lightCount', { count: lights.length }));
}
