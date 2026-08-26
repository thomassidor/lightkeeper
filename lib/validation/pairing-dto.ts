import { validateTarget } from './plans';
import { requireArray, requireOneOf, requireRecord, requireString, fail } from './guards';
import type { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import type { LightFunction } from '../mapping/mapping-types';
import { FUNCTION_CAPABILITY } from '../mapping/mapping-types';

/**
 * What a pairing view is allowed to have sent.
 *
 * The pairing channel is the same class of boundary as a generated Flow's
 * arguments: it arrives from a webview, and "the view sent it" is not on its own
 * permission to persist it. `sanitiseEntries` and `sanitiseCurve` already treat
 * their own payloads that way; the TARGET did not, and it is the one payload every
 * screen sends and every device acts on.
 *
 * The target checks below are deliberately about MEMBERSHIP as well as shape.
 * A device id that is well-formed and names something that is not a light, or is
 * not on this Homey at all, produces a device that resolves to nothing and
 * reports "none of this controller's lights are available" — a configuration that
 * looks saved and can never work.
 */

const MAX_RULES = 64;

/** A target's shape, before anything is asked of the catalogue. */
export function validateTargetDto(raw: unknown): TargetSpec {
  return validateTarget(raw, 'target');
}

/**
 * A target's shape AND its membership: every device exists, is a light
 * candidate, and appears once.
 *
 * `onoff` is the requirement rather than `dim` or `light_temperature`, matching
 * `DeviceCatalog.lightCandidates()`: a lamp that cannot dim is still a lamp a
 * schedule can switch on, and the planner already skips what a target cannot do.
 */
export async function validateTargetAgainstCatalog(
  raw: unknown,
  catalog: DeviceCatalog,
): Promise<TargetSpec> {
  const target = validateTargetDto(raw);

  if (target.kind === 'zone') {
    const zones = await catalog.allZones();
    if (!zones.some(zone => zone.id === target.zoneId)) {
      fail('target.zoneId', 'is not a zone on this Homey');
    }
    return target;
  }

  if (target.deviceIds.length === 0) fail('target.deviceIds', 'is empty');

  const deduped = [...new Set(target.deviceIds)];
  if (deduped.length !== target.deviceIds.length) {
    // Duplicates are not merely untidy: every write is planned per target, so a
    // light named twice is written to twice and counted twice in every summary.
    fail('target.deviceIds', 'names the same light more than once');
  }

  const candidates = new Set((await catalog.lightCandidates()).map(d => d.id));
  const unknown = deduped.filter(id => !candidates.has(id));
  if (unknown.length > 0) {
    fail('target.deviceIds', `names ${unknown.length} device(s) that are not lights on this Homey`);
  }

  return { kind: 'devices', deviceIds: deduped };
}

export interface MappingRuleDto {
  id: string;
  function: LightFunction;
  inputKey: string | null;
  /** '__all__' inherits the controller's own targets; anything else is a device id. */
  groupKey: string;
}

/**
 * The mapping screen's rows.
 *
 * `groupKey` is checked against the lights ALREADY CHOSEN, not against the whole
 * Homey: a rule aimed at a light the controller does not target is a rule the
 * user cannot have meant, and it would resolve to a light they never selected on
 * the previous screen.
 */
export function validateMappingRules(
  raw: unknown,
  selected: ReadonlySet<string>,
  offered: readonly LightFunction[],
): MappingRuleDto[] {
  const rules = requireArray(raw, 'rules', MAX_RULES);

  return rules.map((entry, i) => {
    const path = `rules[${i}]`;
    const rule = requireRecord(entry, path);
    const groupKey = requireString(rule.groupKey, `${path}.groupKey`);

    if (groupKey !== '__all__' && !selected.has(groupKey)) {
      fail(`${path}.groupKey`, 'names a light this controller does not target');
    }

    const func = requireOneOf(rule.function, `${path}.function`, offered);
    // Offered is derived from what the chosen lights actually support, so this
    // also rejects "make it warmer" on a set of lamps with no colour axis —
    // which would otherwise save as a row that can never move anything.
    if (!(func in FUNCTION_CAPABILITY)) fail(`${path}.function`, 'is not a light function');

    return {
      id: requireString(rule.id, `${path}.id`),
      function: func,
      inputKey: rule.inputKey === null || rule.inputKey === undefined
        ? null
        : requireString(rule.inputKey, `${path}.inputKey`),
      groupKey,
    };
  });
}
