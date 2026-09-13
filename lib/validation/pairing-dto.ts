import { validateTarget } from './plans';
import {
  requireArray, requireOneOf, requireRecord, requireString, requireUnitInterval, fail,
} from './guards';
import type { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import type { LightFunction } from '../mapping/mapping-types';
import {
  FUNCTION_CAPABILITY, FUNCTION_NEEDS_PRESET, type MappingPreset,
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

/** A target's shape, before anything is asked of the catalogue. */
function validateTargetDto(raw: unknown): TargetSpec {
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
  /** '__all__' inherits the controller's own targets; anything else is a device id. */
  groupKey: string;
  /** Required by `brightness_set`, refused by every other function. */
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
function readPreset(raw: unknown, path: string): MappingPreset {
  const preset = requireRecord(raw, path);
  return {
    brightness: requireUnitInterval(preset.brightness, `${path}.brightness`),
    ...(preset.temperature !== undefined
      ? { temperature: requireUnitInterval(preset.temperature, `${path}.temperature`) }
      : {}),
  };
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
    const groupKey = requireString(rule.groupKey, `${path}.groupKey`);
    const id = requireString(rule.id, `${path}.id`);
    const inputKey = rule.inputKey === null || rule.inputKey === undefined
      ? null
      : requireString(rule.inputKey, `${path}.inputKey`);

    // ---- membership: dropped and named, never thrown --------------------
    if (groupKey !== '__all__' && !selected.has(groupKey)) {
      dropped.push({ index: i, reason: `"${groupKey}" is not one of this controller's lights` });
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
    const needsPreset = FUNCTION_NEEDS_PRESET[func];
    const preset = rule.preset === undefined || rule.preset === null
      ? undefined
      : readPreset(rule.preset, `${path}.preset`);

    if (needsPreset && preset === undefined) {
      dropped.push({ index: i, reason: 'has no brightness to set' });
      return;
    }
    if (!needsPreset && preset !== undefined) {
      dropped.push({ index: i, reason: `"${func}" does not take a brightness` });
      return;
    }

    rules.push({
      id, function: func, inputKey, groupKey,
      ...(preset !== undefined ? { preset } : {}),
    });
  });

  return { rules, dropped };
}
