import { readMappingPreset, validateTarget } from './plans';
import {
  requireArray, requireOneOf, requireRecord, requireString, fail,
} from './guards';
import type { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import type { LightFunction } from '../mapping/mapping-types';
import {
  FUNCTION_CAPABILITY, FUNCTION_PRESET, type MappingPreset, type PresetKind,
} from '../mapping/mapping-types';
import { LUMINANCE_CAPABILITY } from '../daylight/daylight-types';

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
/**
 * The most lights one rule may name.
 *
 * The same ceiling the target picker itself works under — a controller cannot
 * point at more lights than this, so a rule cannot aim at more either — and it
 * is here for the same reason MAX_RULES is: the payload arrives from a webview,
 * and "the view sent it" is not permission to allocate against it.
 */
const MAX_RULE_LIGHTS = 64;

/**
 * What a row is missing, as the half-sentence the screen prints after "has no".
 *
 * A record keyed on `PresetKind` rather than a ternary, because the ternary it
 * replaced said "brightness" for everything that was not a colour — which was
 * true while there were two kinds and became a lie the moment there was a
 * third. A `lightkeeper_on` row with neither source chosen reported that it had
 * "no brightness to set", which is not something that row has ever been about.
 */
const MISSING_VALUE: Record<PresetKind, string> = {
  none: 'value to set',
  brightness: 'brightness to set',
  colour: 'colour to set',
  lightkeeper: 'Lightkeeper device to take a colour or a brightness from',
};

/** A target's shape, before anything is asked of the catalogue. */
function validateTargetDto(raw: unknown): TargetSpec {
  return validateTarget(raw, 'target');
}

/**
 * Nothing ticked yet, as opposed to something wrong.
 *
 * The light picker pushes the WHOLE selection on every tap, including the empty
 * one the screen opens with, so a caller needs to tell "the user has not chosen
 * yet" from "the user chose something impossible" before asking the catalogue
 * anything. `validateTargetAgainstCatalog` below rightly refuses an empty list —
 * a SAVED target of no lights is a device that can never do anything — and that
 * refusal used to reach the screen as `target.deviceIds is empty`, printed
 * across the top of step 1 before the user had touched it.
 *
 * Shape-only on purpose, and deliberately narrow: an empty `deviceIds` is the
 * only thing it recognises. Anything else — a missing `kind`, a zone, a list of
 * junk — falls through to the full check and is refused there.
 */
export function isEmptyDeviceSelection(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const candidate = raw as { kind?: unknown; deviceIds?: unknown };
  return candidate.kind === 'devices'
    && Array.isArray(candidate.deviceIds)
    && candidate.deviceIds.length === 0;
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

/**
 * The sensor ids a daylight response names, checked for MEMBERSHIP — the twin
 * `validateTargetAgainstCatalog` above has always had and this file's own
 * header says is the point.
 *
 * Shape alone was all that was checked, and a pairing screen is not the only
 * thing that reaches these handlers: a pair session IS a Web API surface and
 * can be scripted (platform §14), and a stale card left open across a device
 * deletion sends ids that no longer exist. Neither is malicious and neither
 * throws — the failure is quiet, which is the problem. A lamp id accepted as a
 * sensor is subscribed to, never reports `measure_luminance`, and the device
 * runs on the sky for ever while the settings page lists a sensor that will
 * never have a reading.
 *
 * A sensor that is merely UNAVAILABLE passes: a flat battery is a thing the
 * diagnostics should show, not a reason to refuse the configuration. What is
 * refused is a device that is not on this Homey, or one that cannot report
 * light at all.
 *
 * The empty list is valid and means "use the sun" — that is the whole point of
 * `source: 'sky'`, so it is not a failure.
 *
 * DEDUPLICATION is deliberately NOT here. `sanitiseResponse()` already drops a
 * repeated sensor and reports `sensors` as corrected, which is the better place
 * for it — a duplicate is a screen bug rather than a claim about this Homey, so
 * it can be fixed instead of failing the whole save, and a second copy here
 * would only be a second place for the two to disagree. It does matter: the lux
 * service is ref-counted per owner, so a sensor named twice would be retained
 * twice and released once.
 *
 * `daylightResponse.sensor` rather than `daylight.sensors` or `response.sensor`
 * as the field path, and the reason is worth keeping: `locales.test.ts` reads
 * any `'<group>.<rest>'` literal in source as a referenced locale key, and BOTH
 * `daylight` and `response` are top-level groups in `en.json`. The first
 * collision was dodged by picking `response`; the pairing rewrite then made
 * `response` a group too, which is exactly the kind of drift the note exists to
 * survive. `daylightResponse` is not a group and reads as the field it names.
 */
export async function validateSensorsAgainstCatalog(
  sensorIds: readonly string[],
  catalog: DeviceCatalog,
): Promise<string[]> {
  if (sensorIds.length === 0) return [];

  const devices = await catalog.allDevices();
  const usable = new Set(
    devices
      .filter(device => device.capabilities.includes(LUMINANCE_CAPABILITY))
      .map(device => device.id),
  );

  const unknown = sensorIds.filter(id => !usable.has(id));
  if (unknown.length > 0) {
    fail(
      'daylightResponse.sensor',
      `names ${unknown.length} device(s) that cannot report how light it is`,
    );
  }

  return [...sensorIds];
}

export interface MappingRuleDto {
  id: string;
  function: LightFunction;
  inputKey: string | null;
  /**
   * Which of the controller's lights this rule drives, or null for all of them.
   *
   * null is not "none" and is not the full list written out: it means INHERIT,
   * so a rule aimed at everything follows a room that gains a lamp, exactly as
   * the device itself does. Writing the ids out instead would freeze the rule
   * against the lights that existed on the day it was saved.
   */
  deviceIds: string[] | null;
  /** Whatever `FUNCTION_PRESET` says this function takes, and nothing else. */
  preset?: MappingPreset;
}

/**
 * The mapping screen's rows: shape errors THROW; rows that no longer belong are
 * DROPPED and named.
 *
 * `groupKey` is checked against the lights ALREADY CHOSEN, not against the whole
 * Homey: a rule aimed at a light the controller does not target is a rule the
 * user cannot have meant, and it would resolve to a light they never selected on
 * the previous screen.
 *
 * The distinction is the whole of this signature. A malformed payload is a bug
 * in the view and refusing it is right. But a row whose light was deselected on
 * the previous screen, or whose function the remaining lamps cannot perform, is
 * a perfectly ordinary consequence of going back a step — and rejecting the
 * whole save for it made a controller's repair permanently unsaveable, with a
 * raw validation message and no way forward but starting over. The mapping
 * screen does not render such a row either, so the user could not even see what
 * was being complained about.
 *
 * Dropping and reporting is what `dedupeByInputKey`, `sanitiseEntries` and
 * `sanitiseCurve` all already do with their own payloads.
 */
/**
 * Which lights a rule names, in either of the two spellings a caller may use.
 *
 * `lights` is the buttons flow's: a list of device ids, or null for "all of the
 * controller's". `groupKey` is what the screen this flow replaced sent — one
 * device id, or the literal `__all__` — and it is still read because `setRules`
 * is a pair-session handler and pair sessions are a scriptable Web API surface
 * (platform §14), so the old spelling is somebody's script until it is not.
 *
 * A payload carrying both is a payload nobody wrote deliberately, so `lights`
 * wins and the older field is ignored rather than merged.
 */
function readRuleLights(rule: Record<string, unknown>, path: string): string[] | null {
  if (rule.lights !== undefined && rule.lights !== null) {
    return requireArray(rule.lights, `${path}.lights`, MAX_RULE_LIGHTS)
      .map((id, n) => requireString(id, `${path}.lights[${n}]`));
  }
  if (rule.lights === null) return null;

  const groupKey = rule.groupKey === undefined
    ? '__all__'
    : requireString(rule.groupKey, `${path}.groupKey`);
  return groupKey === '__all__' ? null : [groupKey];
}

export function validateMappingRules(
  raw: unknown,
  selected: ReadonlySet<string>,
  offered: readonly LightFunction[],
  /**
   * The keys this remote actually exposes, if the caller knows them.
   *
   * `groupKey` and `function` were both checked against what the controller
   * targets and offers; `inputKey` was only shape-checked, so a rule naming an
   * input the remote does not expose was persisted, showed as configured on the
   * mapping screen, generated no Flow and could never fire. Optional because a
   * caller that has not discovered a catalogue yet has nothing to check against,
   * and an empty set must not mean "drop everything".
   */
  catalogueKeys?: ReadonlySet<string>,
): { rules: MappingRuleDto[]; dropped: Array<{ index: number; reason: string }> } {
  const entries = requireArray(raw, 'rules', MAX_RULES);
  const rules: MappingRuleDto[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];

  entries.forEach((entry, i) => {
    const path = `rules[${i}]`;
    const rule = requireRecord(entry, path);
    const id = requireString(rule.id, `${path}.id`);
    const inputKey = rule.inputKey === null || rule.inputKey === undefined
      ? null
      : requireString(rule.inputKey, `${path}.inputKey`);
    const deviceIds = readRuleLights(rule, path);

    // ---- membership: dropped and named, never thrown --------------------
    const stranger = deviceIds?.find(deviceId => !selected.has(deviceId));
    if (stranger !== undefined) {
      dropped.push({ index: i, reason: `"${stranger}" is not one of this controller's lights` });
      return;
    }
    /**
     * A rule aimed at nothing is dropped, not stored as "all".
     *
     * An empty list is what a checklist with every box cleared sends, and the
     * two readings of it — "no lights" and "every light" — are opposite. The
     * screen never sends one (clearing the last box re-ticks "all lights"), so
     * this is the fail-closed half of that rule for every other way in.
     */
    if (deviceIds !== null && deviceIds.length === 0) {
      dropped.push({ index: i, reason: 'names no lights at all' });
      return;
    }

    if (!offered.includes(rule.function as LightFunction)) {
      dropped.push({
        index: i,
        reason: `"${String(rule.function)}" is not something the chosen lights can do`,
      });
      return;
    }

    if (inputKey !== null && catalogueKeys && !catalogueKeys.has(inputKey)) {
      dropped.push({ index: i, reason: `"${inputKey}" is not an event this remote exposes` });
      return;
    }

    // ---- shape: still throws --------------------------------------------
    const func = requireOneOf(rule.function, `${path}.function`, offered);
    if (!(func in FUNCTION_CAPABILITY)) fail(`${path}.function`, 'is not a light function');

    /**
     * The value a function needs, where its name is not enough — and BOTH
     * halves of the rule are enforced.
     *
     * A `brightness_set` with no preset is dropped rather than thrown, because
     * it is a row the screen can legitimately be mid-way through: the user has
     * picked the job and not yet chosen the brightness. A preset on any other
     * function is dropped too, because it is a value nothing will ever read and
     * keeping it would leave a stored rule nobody can explain.
     */
    const kind = FUNCTION_PRESET[func];
    const preset = rule.preset === undefined || rule.preset === null
      ? undefined
      : readMappingPreset(rule.preset, `${path}.preset`, kind);

    if (kind !== 'none' && preset === undefined) {
      dropped.push({ index: i, reason: `has no ${MISSING_VALUE[kind]}` });
      return;
    }
    if (kind === 'none' && preset !== undefined) {
      dropped.push({ index: i, reason: `"${func}" does not take a value` });
      return;
    }

    rules.push({
      id, function: func, inputKey, deviceIds,
      ...(preset !== undefined ? { preset } : {}),
    });
  });

  return { rules, dropped };
}
