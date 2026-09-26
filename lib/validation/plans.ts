import {
  fail, isRecord, optionalNumber,
  requireArray, requireBoolean, requireNumber, requireOneOf, requireRecord,
  requireString, requireUnitInterval,
} from './guards';
import { MINUTES_PER_DAY } from '../time/wall-clock';
import { isPaletteColor } from '../circadian/palette';
import { isTransition, type Transition } from '../support/interpolate';
import type { TargetSpec } from '../outputs/light-intent';
import {
  FUNCTION_PRESET, namesASource,
  type ControllerBehavior, type LightFunction, type MappingPreset, type MappingRule,
  type PresetKind,
} from '../mapping/mapping-types';
import type { ControllerProfile, ManagedFlowReference } from '../profiles/controller-profile';
import {
  ENTRY_ID_SHAPE,
  type SchedulePlan, type ScheduleEntry, type ScheduleEnd, type IsoWeekday,
} from '../schedules/schedule-types';
import {
  MIN_POINTS,
  type CircadianPlan, type CircadianPoint, type CircadianAnchor,
} from '../circadian/circadian-types';
import {
  MAX_OFFSET,
  type CircadianZone, type CircadianZones, type SimpleCircadianPlan,
} from '../circadian/simple-curve';
import {
  MAX_ELEVATION, MAX_LUX, MIN_ELEVATION, MIN_LUX,
  isSunPeak,
  type DaylightPlan, type DaylightResponse,
  type SunPeak,
} from '../daylight/daylight-types';
import type { LogicalSourceBinding, SelectableInput } from '../inputs/selectable-input';
import type { InputAction } from '../inputs/input-event';

/**
 * What the app is willing to act on.
 *
 * Persisted plans are not trusted data. They are JSON in a device store, and a
 * downgrade, a partial write, a hand-edit or a bug in a version that has since
 * been replaced can leave one in any shape at all — while the code downstream
 * reads `plan.entries.map(...)` and `switch (target.kind)` without asking. A
 * migration chain that ends in a cast is a chain that ends in a hope.
 *
 * Two things these guard that are worth naming, because they are the difference
 * between a bad plan and a bad outcome:
 *
 *  - **An unknown discriminant throws** rather than falling through a `switch`.
 *    A target kind the app cannot drive must read as "this device has no usable
 *    configuration", not as "there was nothing to write".
 *  - **`managedFlows` is shape-checked, and that is a DELETE gate.** The device
 *    layer's never-registered delete path hands these references straight to
 *    `bridge.removeAll`. A forged or corrupted reference is a flow id we were
 *    told to delete by something other than us, so nothing that fails the shape
 *    check may reach it. `validManagedFlowRefs()` is the filter, and it is
 *    separate from the throwing validator on purpose: a delete path must degrade
 *    to "delete fewer things", never to "throw and skip the cleanup".
 *
 * Caps are generous and documented at each site: they exist so a corrupted list
 * of 100 000 entries reports a bad plan instead of taking the app down inside a
 * device's `onInit`.
 */

/**
 * The root of each error path.
 *
 * Capitalised type names rather than `profile` / `schedule` / `circadian`,
 * because `test/unit/locales.test.ts` scans the source for string literals
 * shaped like `<localeGroup>.<key>` — and `schedule` and `circadian` are both
 * locale groups, so a path rooted at either read as a locale key that does not
 * exist. (The scan is over string literals, so this comment must not quote one
 * either.) A type name reads better in a log line anyway: "SchedulePlan.entries
 * [0].onAt is not a finite number" says what was wrong and where.
 */
const ROOT = {
  profile: 'ControllerProfile',
  schedule: 'SchedulePlan',
  circadian: 'CircadianPlan',
  simple: 'SimpleCircadianPlan',
  daylight: 'DaylightPlan',
} as const;

/** Well above the app's own limits — 64 mapping rows, 12 windows, 8 curve points. */
const MAX_MAPPINGS = 64;
const MAX_ENTRIES = 32;
const MAX_POINTS = 48;
const MAX_MANAGED_FLOWS = 256;
const MAX_CATALOGUE = 512;
const MAX_TARGET_DEVICES = 256;

/**
 * Every light function, as the stored-plan validator's allow-list.
 *
 * Written out rather than derived from `FUNCTION_CAPABILITY`'s keys so that
 * adding a function is a deliberate two-line change here as well: this list is
 * what decides whether a profile written by a NEWER build is quarantined, and
 * deriving it would silently accept a function this build cannot plan.
 *
 * `color_set` was the cost of that deliberateness going unpaid. It was added to
 * `LightFunction`, to `FUNCTION_CAPABILITY`, to `FUNCTION_PRESET` and to
 * `availableFunctions()` — so the buttons screen offered "Set colour" on any
 * lamp with `light_hue` and stored it happily — and never to this line. The
 * profile then failed THIS validator on the very next load, so a Light Remote
 * with a colour button paired cleanly and came up unavailable before the user
 * had touched it, saying only that its configuration could not be read.
 *
 * `plan-validation.test.ts` is what makes the next addition deliberate rather
 * than merely intended: it fails when this list and `FUNCTION_PRESET` disagree,
 * which keeps the allow-list hand-written and still catches an omission at
 * `npm test` instead of on somebody's tile.
 */
const LIGHT_FUNCTIONS: readonly LightFunction[] = [
  'toggle', 'on', 'off',
  'brightness_up', 'brightness_down',
  'warmer', 'colder',
  'brightness_set', 'color_set', 'temperature_cycle',
  'lightkeeper_on',
];

const INPUT_ACTIONS: readonly InputAction[] = [
  'press', 'long_press', 'release', 'rotate_start', 'rotate_stop', 'rotate_delta',
];

const BINDING_KINDS = [
  'direct_capability', 'flow_fixed', 'flow_enum', 'flow_range', 'flow_token',
] as const;

// ------------------------------------------------------------------- shared

function validateTarget(raw: unknown, path: string): TargetSpec {
  const target = requireRecord(raw, path);
  const kind = requireOneOf(target.kind, `${path}.kind`, ['devices', 'zone'] as const);

  if (kind === 'devices') {
    const ids = requireArray(target.deviceIds, `${path}.deviceIds`, MAX_TARGET_DEVICES);
    return {
      kind: 'devices',
      deviceIds: ids.map((id, i) => requireString(id, `${path}.deviceIds[${i}]`)),
    };
  }

  return {
    kind: 'zone',
    zoneId: requireString(target.zoneId, `${path}.zoneId`),
    includeSubzones: requireBoolean(target.includeSubzones, `${path}.includeSubzones`),
  };
}

/**
 * One managed-Flow reference, or null if it is not one.
 *
 * Non-throwing because the delete path needs it that way. See the module comment.
 */
function readManagedFlowRef(raw: unknown): ManagedFlowReference | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.flowId !== 'string' || raw.flowId.length === 0) return null;
  if (typeof raw.bindingKey !== 'string' || raw.bindingKey.length === 0) return null;
  if (typeof raw.variantKey !== 'string') return null;
  if (typeof raw.fingerprint !== 'string') return null;
  if (typeof raw.managedVersion !== 'number' || !Number.isInteger(raw.managedVersion)) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;

  return {
    flowId: raw.flowId,
    bindingKey: raw.bindingKey,
    variantKey: raw.variantKey,
    fingerprint: raw.fingerprint,
    managedVersion: raw.managedVersion,
    createdAt: raw.createdAt,
  };
}

/**
 * The references a delete may act on, filtered rather than validated.
 *
 * This is the gate in front of `bridge.removeAll` on the never-registered delete
 * path. A reference that fails the shape check names a flow id nothing in this
 * app wrote, and deleting from one is deleting a user's Flow on the strength of
 * corrupted data. Filtering — not throwing — because a delete path that throws
 * skips the cleanup entirely and leaks every OTHER reference's Flow.
 */
export function validManagedFlowRefs(raw: unknown): ManagedFlowReference[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_MANAGED_FLOWS)
    .map(readManagedFlowRef)
    .filter((ref): ref is ManagedFlowReference => ref !== null);
}

function validateManagedFlows(raw: unknown, path: string): ManagedFlowReference[] {
  const list = requireArray(raw, path, MAX_MANAGED_FLOWS);
  return list.map((entry, i) => {
    const ref = readManagedFlowRef(entry);
    if (!ref) fail(`${path}[${i}]`, 'is not a managed Flow reference');
    return ref;
  });
}

// -------------------------------------------------------- controller profile

function validateBinding(raw: unknown, path: string): LogicalSourceBinding {
  const binding = requireRecord(raw, path);
  const kind = requireOneOf(binding.kind, `${path}.kind`, BINDING_KINDS);

  if (kind === 'direct_capability') {
    return {
      kind,
      capabilityId: requireString(binding.capabilityId, `${path}.capabilityId`),
      interpreter: requireOneOf(binding.interpreter, `${path}.interpreter`, [
        'boolean_press', 'numeric_delta', 'numeric_absolute', 'enum_selection',
      ] as const),
    };
  }

  const cardId = requireString(binding.cardId, `${path}.cardId`);
  const cardOwnerUri = requireString(binding.cardOwnerUri, `${path}.cardOwnerUri`);
  const fixedArgs = requireRecord(binding.fixedArgs, `${path}.fixedArgs`);

  switch (kind) {
    case 'flow_fixed':
      return { kind, cardId, cardOwnerUri, fixedArgs };
    case 'flow_enum':
      return {
        kind, cardId, cardOwnerUri, fixedArgs,
        argument: requireString(binding.argument, `${path}.argument`),
        value: binding.value,
      };
    case 'flow_range': {
      const values = requireArray(binding.values, `${path}.values`, MAX_MAPPINGS);
      return {
        kind, cardId, cardOwnerUri, fixedArgs,
        argument: requireString(binding.argument, `${path}.argument`),
        values: values.map((v, i) => requireNumber(v, `${path}.values[${i}]`)),
      };
    }
    case 'flow_token':
      return {
        kind, cardId, cardOwnerUri, fixedArgs,
        tokenId: requireString(binding.tokenId, `${path}.tokenId`),
      };
  }
}

function validateCatalogueEntry(raw: unknown, path: string): SelectableInput {
  const input = requireRecord(raw, path);
  const direction = optionalNumber(input.direction, `${path}.direction`, { integer: true });
  if (direction !== undefined && direction !== -1 && direction !== 1) {
    fail(`${path}.direction`, 'is neither -1 nor 1');
  }

  return {
    key: requireString(input.key, `${path}.key`),
    controlId: requireString(input.controlId, `${path}.controlId`),
    label: requireString(input.label, `${path}.label`),
    action: requireOneOf(input.action, `${path}.action`, INPUT_ACTIONS),
    ...(direction !== undefined ? { direction: direction as -1 | 1 } : {}),
    carriesMagnitude: requireBoolean(input.carriesMagnitude, `${path}.carriesMagnitude`),
    ...(input.magnitudePerTurn !== undefined
      ? { magnitudePerTurn: requireNumber(input.magnitudePerTurn, `${path}.magnitudePerTurn`, { min: 0 }) }
      : {}),
    binding: validateBinding(input.binding, `${path}.binding`),
  };
}

function validateMappingRule(raw: unknown, path: string): MappingRule {
  const rule = requireRecord(raw, path);
  const func = requireOneOf(rule.function, `${path}.function`, LIGHT_FUNCTIONS);

  /**
   * The preset half of the rule, REFUSED rather than dropped.
   *
   * The screen's own validator drops a half-finished row, because a row somebody
   * is still filling in is a normal state there. This reads a STORED plan, where
   * the same shape means a partial write, a hand edit or a downgrade — and a
   * button whose job is "a set brightness" and which carries no brightness is
   * exactly the "looks configured, does nothing" failure quarantining exists
   * for.
   */
  const kind = FUNCTION_PRESET[func];
  const preset = rule.preset === undefined || rule.preset === null
    ? undefined
    : readMappingPreset(rule.preset, `${path}.preset`, kind);

  if (kind !== 'none' && preset === undefined) {
    fail(`${path}.preset`, `is missing, and "${func}" cannot run without one`);
  }
  if (kind === 'none' && preset !== undefined) {
    fail(`${path}.preset`, `is set, but "${func}" never reads one`);
  }

  return {
    id: requireString(rule.id, `${path}.id`),
    function: func,
    inputKey: rule.inputKey === null ? null : requireString(rule.inputKey, `${path}.inputKey`),
    target: rule.target === null || rule.target === undefined
      ? null
      : validateTarget(rule.target, `${path}.target`),
    ...(preset !== undefined ? { preset } : {}),
  };
}

/**
 * A rule's value, read as the KIND its function declares and never as both.
 *
 * Shared with `validateMappingRules` on the pairing side, which reaches it
 * through this module the same way it reaches `validateTarget` — one reader, so
 * a value the screen may send and a value a profile may hold cannot drift apart.
 *
 * The kind is the caller's, not the payload's: trusting a `color` field to mean
 * "this is a colour preset" would let a brightness job be stored with a colour
 * and no brightness, which is the shape the union exists to make unsayable.
 */
export function readMappingPreset(raw: unknown, path: string, kind: PresetKind): MappingPreset {
  const preset = requireRecord(raw, path);

  /**
   * Two device ids and a switch — and the one refusal worth spelling out.
   *
   * A preset naming NEITHER source is refused rather than stored, because it is
   * plain "On" wearing a name that promises the level and the warmth as well.
   * Stored, it would be a row that reads as configured on every screen and puts
   * the lamps wherever they were last left, which is the exact failure this app
   * exists to prevent. The buttons screen cannot send one — choosing the job
   * leaves both rows saying "Leave it alone" until one is answered, and the
   * screen will not push until it is — but a pair session is a scriptable Web
   * API surface (platform §14), so the screen is not the only way in.
   *
   * The ids themselves are NOT checked against the live registries here. A
   * validator runs on a stored plan at `onInit`, where a curve device that has
   * not registered yet would look deleted — and quarantining a whole remote
   * because one of its buttons names a device that is merely still starting is
   * far worse than the press degrading to "on" for a moment. The live check
   * belongs where the press happens, and `resolveSources` is it.
   */
  if (kind === 'lightkeeper') {
    const lightkeeper = {
      colourSource: requireString(preset.colourSource, `${path}.colourSource`),
      brightnessSource: requireString(preset.brightnessSource, `${path}.brightnessSource`),
      pressAgainOff: requireBoolean(preset.pressAgainOff, `${path}.pressAgainOff`),
    };
    if (!namesASource(lightkeeper)) {
      fail(path, 'names no Lightkeeper device to take a colour or a brightness from');
    }
    return lightkeeper;
  }

  if (kind === 'colour') {
    const color = requireString(preset.color, `${path}.color`);
    if (!isPaletteColor(color)) fail(`${path}.color`, 'is not a colour in the palette');
    return { color };
  }

  return {
    brightness: requireUnitInterval(preset.brightness, `${path}.brightness`),
    ...(preset.temperature !== undefined
      ? { temperature: requireUnitInterval(preset.temperature, `${path}.temperature`) }
      : {}),
  };
}

function validateBehavior(raw: unknown, path: string): ControllerBehavior {
  const behavior = requireRecord(raw, path);
  return {
    brightnessStep: requireUnitInterval(behavior.brightnessStep, `${path}.brightnessStep`),
    temperatureStep: requireUnitInterval(behavior.temperatureStep, `${path}.temperatureStep`),
    groupBrightnessMode: requireOneOf(behavior.groupBrightnessMode, `${path}.groupBrightnessMode`, [
      'relative', 'synchronised',
    ] as const),
    increaseWhileOff: requireOneOf(behavior.increaseWhileOff, `${path}.increaseWhileOff`, [
      'turn_on_and_apply', 'ignore',
    ] as const),
    decreaseWhileOff: requireOneOf(behavior.decreaseWhileOff, `${path}.decreaseWhileOff`, [
      'update_desired_only', 'ignore',
    ] as const),
    offBelowMinimum: requireBoolean(behavior.offBelowMinimum, `${path}.offBelowMinimum`),
    minimumBrightness: requireUnitInterval(behavior.minimumBrightness, `${path}.minimumBrightness`),
    // Generous ceilings: these are milliseconds, and a stored 10^9 would hold a
    // ramp open for a fortnight.
    supersedeMs: requireNumber(behavior.supersedeMs, `${path}.supersedeMs`, { min: 0, max: 10_000 }),
    minWriteIntervalMs: requireNumber(
      behavior.minWriteIntervalMs, `${path}.minWriteIntervalMs`, { min: 0, max: 60_000 },
    ),
  };
}

export function validateControllerProfile(raw: unknown): ControllerProfile {
  const profile = requireRecord(raw, ROOT.profile);
  const source = requireRecord(profile.source, `${ROOT.profile}.source`);

  return {
    schemaVersion: requireNumber(profile.schemaVersion, `${ROOT.profile}.schemaVersion`, {
      min: 0, integer: true,
    }),
    enabled: requireBoolean(profile.enabled, `${ROOT.profile}.enabled`),
    source: {
      deviceId: requireString(source.deviceId, `${ROOT.profile}.source.deviceId`),
      ...(source.ownerAppId !== undefined
        ? { ownerAppId: requireString(source.ownerAppId, `${ROOT.profile}.source.ownerAppId`) } : {}),
      ...(source.driverId !== undefined
        ? { driverId: requireString(source.driverId, `${ROOT.profile}.source.driverId`) } : {}),
      ...(source.name !== undefined
        ? { name: requireString(source.name, `${ROOT.profile}.source.name`) } : {}),
      // An empty fingerprint is meaningful: it is what a profile written before
      // the surface check existed carries, and findReattachCandidate refuses on
      // it deliberately. So this one may be empty and must still be a string.
      eventSurfaceFingerprint: typeof source.eventSurfaceFingerprint === 'string'
        ? source.eventSurfaceFingerprint
        : fail(`${ROOT.profile}.source.eventSurfaceFingerprint`, 'is not a string'),
      ...(source.eventSurfaceFingerprintV2 !== undefined
        ? {
          eventSurfaceFingerprintV2: requireString(
            source.eventSurfaceFingerprintV2, `${ROOT.profile}.source.eventSurfaceFingerprintV2`,
          ),
        }
        : {}),
    },
    target: validateTarget(profile.target, `${ROOT.profile}.target`),
    mappings: requireArray(profile.mappings, `${ROOT.profile}.mappings`, MAX_MAPPINGS)
      .map((rule, i) => validateMappingRule(rule, `${ROOT.profile}.mappings[${i}]`)),
    behavior: validateBehavior(profile.behavior, `${ROOT.profile}.behavior`),
    managedFlows: validateManagedFlows(profile.managedFlows, `${ROOT.profile}.managedFlows`),
    ...(profile.catalogue !== undefined
      ? {
        catalogue: requireArray(profile.catalogue, `${ROOT.profile}.catalogue`, MAX_CATALOGUE)
          .map((input, i) => validateCatalogueEntry(input, `${ROOT.profile}.catalogue[${i}]`)),
      }
      : {}),
  };
}

// ------------------------------------------------------------ schedule plan

function validateScheduleEnd(raw: unknown, path: string): ScheduleEnd {
  const end = requireRecord(raw, path);
  const kind = requireOneOf(end.kind, `${path}.kind`, ['duration', 'time'] as const);
  if (kind === 'duration') {
    return {
      kind,
      minutes: requireNumber(end.minutes, `${path}.minutes`, {
        min: 1, max: MINUTES_PER_DAY - 1, integer: true,
      }),
    };
  }
  return {
    kind,
    at: requireNumber(end.at, `${path}.at`, { min: 0, max: MINUTES_PER_DAY - 1, integer: true }),
  };
}

/**
 * Which days a schedule runs on: a list of ISO weekdays, or null for every day.
 *
 * On the PLAN since the pairing rewrite, not on each window — see the field's own
 * note on `SchedulePlan`. An empty list is refused rather than read as "never":
 * a schedule that can never fire looks configured and does nothing, which is the
 * failure this whole module exists to quarantine.
 */
function validateWeekdays(raw: unknown, path: string): IsoWeekday[] | null {
  if (raw === null || raw === undefined) return null;
  const list = requireArray(raw, path, 7);
  const days = list.map((day, i) => requireNumber(day, `${path}[${i}]`, {
    min: 1, max: 7, integer: true,
  }) as IsoWeekday);
  if (days.length === 0) fail(path, 'is an empty list, so the schedule could never fire');
  return days;
}

function validateScheduleEntry(raw: unknown, path: string): ScheduleEntry {
  const entry = requireRecord(raw, path);

  /**
   * The id has a SHAPE, and it is load-bearing rather than cosmetic.
   *
   * It goes into `sched:<id>:<boundary>`, which is a generated Flow's
   * `event_key` argument, and `parseEventKey` splits it on `:`. An id containing
   * a colon parses as a different entry or as nothing at all — and `app.ts`
   * routes an unparseable key to the CONTROLLER registry, so the window never
   * fires and the rejection names the wrong subsystem entirely.
   *
   * `sanitiseEntryId` enforces this on both of the app's own write paths. This
   * is the stored-plan path, which had only `requireString` while every
   * neighbouring field was range-checked — so a store written out of band (a
   * `createPairSessionDevice` carrying a hand-crafted `store`, platform §14) or
   * a partial write got through.
   */
  const id = requireString(entry.id, `${path}.id`);
  if (!ENTRY_ID_SHAPE.test(id)) {
    fail(`${path}.id`, 'is not a usable schedule id');
  }

  const onAt = requireNumber(entry.onAt, `${path}.onAt`, {
    min: 0, max: MINUTES_PER_DAY - 1, integer: true,
  });
  const end = validateScheduleEnd(entry.end, `${path}.end`);

  /**
   * Equal times, refused here as `sanitiseEnd` already refuses them on the way
   * in ("either way the user cannot have meant it").
   *
   * Admitted, it makes `windowLengthMinutes()` return 1440 — contradicting its
   * own documented range of 1–1439 — and `activeWindow()` non-null at every
   * minute of every day, so the window can never end.
   */
  if (end.kind === 'time' && end.at === onAt) {
    fail(`${path}.end.at`, 'is the same as the on-time, which is not a window');
  }

  /**
   * A palette colour, and the same refusal the curve point path makes: an id
   * this version does not know fails the PLAN rather than being dropped to a
   * default. The sanitiser drops the block on the way in; by the time a plan is
   * stored, a colour nobody can resolve means the store is not one we can vouch
   * for, and DeviceLifecycle quarantines the device with a reason.
   */
  let color: string | undefined;
  if (entry.color !== undefined) {
    const id = requireString(entry.color, `${path}.color`);
    if (!isPaletteColor(id)) fail(`${path}.color`, 'is not a colour this version offers');
    color = id;
  }

  return {
    id,
    onAt,
    end,
    ...(entry.brightness !== undefined
      ? { brightness: requireUnitInterval(entry.brightness, `${path}.brightness`) }
      : {}),
    ...(entry.temperature !== undefined
      ? { temperature: requireUnitInterval(entry.temperature, `${path}.temperature`) } : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

export function validateSchedulePlan(raw: unknown): SchedulePlan {
  const plan = requireRecord(raw, ROOT.schedule);

  const entries = uniqueIds(
    requireArray(plan.entries, `${ROOT.schedule}.entries`, MAX_ENTRIES)
      .map((entry, i) => validateScheduleEntry(entry, `${ROOT.schedule}.entries[${i}]`)),
    `${ROOT.schedule}.entries`,
  );
  return {
    ...planRoot(plan, ROOT.schedule),
    entries,
    days: validateWeekdays(plan.days, `${ROOT.schedule}.days`),
    managedFlows: validateManagedFlows(plan.managedFlows, `${ROOT.schedule}.managedFlows`),
  };
}

/**
 * Ids have to be distinct, because they are what a boundary event is routed by.
 *
 * Two entries sharing one id means `plan.entries.find(...)` answers with
 * whichever comes first and the other can never fire, while both appear on
 * screen. `sanitiseEntries` refuses duplicates on the way in; this is the
 * stored-plan path, which did not.
 */
function uniqueIds<T extends { id: string }>(items: T[], path: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) fail(path, `contains more than one entry with id "${item.id}"`);
    seen.add(item.id);
  }
  return items;
}

// ----------------------------------------------------------- circadian plan

function validateAnchor(raw: unknown, path: string): CircadianAnchor {
  const anchor = requireRecord(raw, path);
  /**
   * `clock` only, and the comment this replaces is the reason it has to be said
   * here as well as in `sanitiseAnchor`.
   *
   * That comment read "resolvable since the circadian light's boundaries started
   * following the sun", which is true of the BOUNDARIES and not of a point's
   * anchor — two different mechanisms, and the conflation is what let a plan
   * through that `resolveAnchor()` then threw on every tick (see
   * `CircadianAnchor` in lib/circadian/circadian-types.ts).
   *
   * `sanitiseCurve` is the pairing screen's gate; this one is the STORE's, and a
   * store can be written out of band. Failing here quarantines the device with a
   * reason on its tile, which is the honest outcome for a plan the runtime
   * cannot evaluate — and strictly better than the silence it replaces.
   */
  requireOneOf(anchor.kind, `${path}.kind`, ['clock'] as const);

  return {
    kind: 'clock',
    at: requireNumber(anchor.at, `${path}.at`, {
      min: 0, max: MINUTES_PER_DAY - 1, integer: true,
    }),
  };
}

function validateCircadianPoint(raw: unknown, path: string): CircadianPoint {
  const point = requireRecord(raw, path);

  /**
   * A colour this build does not offer is refused, not defaulted.
   *
   * Only reachable through a downgrade — a plan saved by a version with a larger
   * palette. Quarantining the device is the honest outcome: the alternative is a
   * curve that runs at a colour nobody chose, which looks like it is working.
   */
  let color: string | undefined;
  if (point.color !== undefined) {
    const id = requireString(point.color, `${path}.color`);
    if (!isPaletteColor(id)) fail(`${path}.color`, 'is not a colour this version offers');
    color = id;
  }

  return {
    id: requireString(point.id, `${path}.id`),
    anchor: validateAnchor(point.anchor, `${path}.anchor`),
    warmth: requireUnitInterval(point.warmth, `${path}.warmth`),
    ...(point.brightness !== undefined
      ? { brightness: requireUnitInterval(point.brightness, `${path}.brightness`) }
      : {}),
    ...(color !== undefined ? { color } : {}),
  };
}

export function validateCircadianPlan(raw: unknown): CircadianPlan {
  const plan = requireRecord(raw, ROOT.circadian);
  const points = uniqueIds(
    requireArray(plan.points, `${ROOT.circadian}.points`, MAX_POINTS)
      .map((point, i) => validateCircadianPoint(point, `${ROOT.circadian}.points[${i}]`)),
    `${ROOT.circadian}.points`,
  );

  /**
   * A LOWER bound too, not only the ceiling.
   *
   * `points` was bounded from above alone, so a stored plan with zero or one
   * point validated, registered, and reported `ready` — while `applyNow()`
   * returned early or the curve sat flat at a single warmth forever. A device
   * that looks configured and does nothing is the precise failure this app
   * exists to prevent, and quarantining it is what this module is for. The
   * user-facing paths already refuse it (`buildPlan` in the Curve driver, and
   * `sanitiseCurve`), so this covers a store written out of band or a partial
   * write — the population named in the module header.
   */
  if (points.length < MIN_POINTS) {
    fail(`${ROOT.circadian}.points`, `has fewer than ${MIN_POINTS} points, so there is no curve`);
  }
  const adjustBrightness = requireBoolean(plan.adjustBrightness, `${ROOT.circadian}.adjustBrightness`);

  // "Present on every point or on none" is the curve's own rule: a half-dimmed
  // curve would have to invent the missing segments, and inventing a brightness
  // for someone's living room is the one thing this feature must not do.
  if (adjustBrightness && points.some(point => point.brightness === undefined)) {
    fail(`${ROOT.circadian}.adjustBrightness`, 'is set while a point carries no brightness');
  }

  // The zones a circadian light stores, when this plan came from one. Validated
  // through the same function the simple plan uses, because they are the same
  // three zones and a second copy of the rules is a second thing to get wrong.
  const zones = plan.zones === undefined
    ? undefined
    : validateZones(plan.zones, `${ROOT.circadian}.zones`);

  return {
    ...planRoot(plan, ROOT.circadian),
    points,
    adjustBrightness,
    transition: requireTransition(plan.transition, `${ROOT.circadian}.transition`),
    ...(zones !== undefined ? { zones } : {}),
    // Opt-in, so anything other than a real `true` is a no — and a device that
    // predates the key must keep reading "no".
    preStage: plan.preStage === true,
    ...storedPreStageLights(plan),
    ...storedWritesLights(plan),
  };
}

// ---------------------------------------------------- simple circadian plan

function validateZone(raw: unknown, path: string): CircadianZone {
  const zone = requireRecord(raw, path);
  return {
    temperature: requireUnitInterval(zone.temperature, `${path}.temperature`),
    ...(zone.brightness !== undefined
      ? { brightness: requireUnitInterval(zone.brightness, `${path}.brightness`) }
      : {}),
  };
}

/**
 * The three zones and the two sun-anchored boundaries between them.
 *
 * Shared by both circadian shapes: a circadian light stores these as its whole
 * plan, and the expanded plan the runtime holds carries the same object so the
 * points can be re-derived against today's sun. One function, so the two cannot
 * come to disagree about what a zone is.
 *
 * The offsets are bounded at `MAX_OFFSET` rather than at a day. Beyond that they
 * are not adjustments to a sunrise any more, and `resolveBoundaries` would clamp
 * them anyway — refusing here means a store that got there out of band is
 * quarantined with a named path rather than silently behaving as if it said
 * something else.
 */
function validateZones(raw: unknown, path: string): CircadianZones {
  const zones = requireRecord(raw, path);
  const offset = (value: unknown, field: string) => requireNumber(value, `${path}.${field}`, {
    min: -MAX_OFFSET, max: MAX_OFFSET, integer: true,
  });

  return {
    morning: validateZone(zones.morning, `${path}.morning`),
    midday: validateZone(zones.midday, `${path}.midday`),
    evening: validateZone(zones.evening, `${path}.evening`),
    morningEnd: offset(zones.morningEnd, 'morningEnd'),
    eveningStart: offset(zones.eveningStart, 'eveningStart'),
  };
}

/**
 * The three-zone plan a circadian light stores.
 *
 * The SHAPE is not validated because it is not stored: `zoneValueAt` derives the
 * day from the zones, the transition and the day's sun every tick (see `simple-curve.ts`
 * for why). What is here is the answers only the user can give.
 */
export function validateSimpleCircadianPlan(raw: unknown): SimpleCircadianPlan {
  const plan = requireRecord(raw, ROOT.simple);
  const zones = validateZones(plan.zones, `${ROOT.simple}.zones`);
  const adjustBrightness = requireBoolean(plan.adjustBrightness, `${ROOT.simple}.adjustBrightness`);

  // Every zone or none, which is the curve engine's own rule: it interpolates
  // brightness only where both bracketing points carry one, and two thirds of a
  // brightness curve would have to invent the rest.
  if (adjustBrightness
    && (zones.morning.brightness === undefined
      || zones.midday.brightness === undefined
      || zones.evening.brightness === undefined)) {
    fail(`${ROOT.simple}.adjustBrightness`, 'is set while a zone carries no brightness');
  }

  return {
    ...planRoot(plan, ROOT.simple),
    zones,
    adjustBrightness,
    transition: requireTransition(plan.transition, `${ROOT.simple}.transition`),
    // Opt-in, so anything other than a real `true` is a no.
    preStage: plan.preStage === true,
    ...storedPreStageLights(plan),
    ...storedWritesLights(plan),
  };
}

/**
 * The lamps a pre-stage test proved safe, as the ids it stored.
 *
 * FORGIVING, unlike most of this file, and deliberately: a malformed entry here
 * can only ever mean a lamp that is not pre-staged, which is the safe answer,
 * so it is dropped rather than quarantining a device over it. Not checked
 * against the targets, because a room target is resolved at runtime and this
 * validator cannot know its lamps; an id that no longer names a target simply
 * never matches one. Absent in, absent out, so a plan without it round-trips
 * to exactly itself — and an existing `preStage: true` device reads as "chosen,
 * not tested", which pre-stages nothing (`preStagesLamp()`).
 */
function storedPreStageLights(plan: Record<string, unknown>): { preStageLights?: string[] } {
  if (!Array.isArray(plan.preStageLights)) return {};
  const ids = plan.preStageLights.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return { preStageLights: [...new Set(ids)] };
}

/**
 * `writesLights`, read the OPPOSITE way to `preStage` beside it.
 *
 * Opt-OUT: only a real `false` turns it off, and an absent key — every device
 * paired before the flag existed — keeps writing to its lights. Copying the
 * `=== true` line above would stop every existing engine device on update. The
 * key is returned only when false, so a plan that never had it round-trips to
 * exactly itself. See lib/runtime/writes-lights.ts.
 */
function storedWritesLights(plan: Record<string, unknown>): { writesLights?: false } {
  return plan.writesLights === false ? { writesLights: false } : {};
}

/**
 * The three fields every stored DEVICE plan opens with.
 *
 * A schedule, a Colour Curve Light, a circadian light and a Room-sensing Light all carry a
 * schema version, a pause flag and a target, in that order, and each wrote the
 * same four lines out with only `ROOT.<kind>` differing. One helper makes "every
 * plan has these three" structural rather than a thing four functions happen to
 * agree about.
 *
 * The CONTROLLER profile is deliberately not in the group: it carries a `source`
 * object where these carry a `target`, so it shares only two of the three and
 * pressing it through here would need a second signature to save two lines.
 */
function planRoot(plan: Record<string, unknown>, root: string): {
  schemaVersion: number;
  enabled: boolean;
  target: TargetSpec;
} {
  return {
    schemaVersion: requireNumber(plan.schemaVersion, `${root}.schemaVersion`, {
      min: 0, integer: true,
    }),
    enabled: requireBoolean(plan.enabled, `${root}.enabled`),
    target: validateTarget(plan.target, `${root}.target`),
  };
}

/**
 * One of the four answers to "when does this room get the most sun".
 *
 * A fifth value cannot come from a screen, so a fifth means the store was
 * written by something else.
 */
function requireSunPeak(value: unknown, path: string): SunPeak {
  if (!isSunPeak(value)) fail(path, 'is not one of morning, midday, afternoon or flat');
  return value;
}

/**
 * Required on every engine plan, and refused rather than defaulted — the same
 * policy as `sunPeak`. Every stored plan older than the field is given one by
 * its migration chain before it gets here, so an absent value at this point is
 * a partial write, not an old device.
 */
function requireTransition(value: unknown, path: string): Transition {
  if (!isTransition(value)) fail(path, 'is not one of gradual, balanced or quick');
  return value;
}

/**
 * One daylight response, validated at whichever of FOUR paths holds it.
 *
 * The `path` argument is what makes one function serve four stores: a
 * Room-sensing Light keeps its response at the root of its plan, and a schedule, a
 * circadian light and a Colour Curve Light each keep one in an optional field. Four copies of
 * these six checks is four chances for them to disagree about what a response is.
 */
function validateDaylightResponse(raw: unknown, path: string): DaylightResponse {
  const response = requireRecord(raw, path);

  // One sensor or none. `null` is not a degraded state — it is the sun, which
  // is the complete answer most households get.
  const sensor = response.sensor === null || response.sensor === undefined
    ? null
    : requireString(response.sensor, `${path}.sensor`);

  const darkLux = requireNumber(response.darkLux, `${path}.darkLux`, { min: MIN_LUX, max: MAX_LUX });
  const brightLux = requireNumber(response.brightLux, `${path}.brightLux`, {
    min: MIN_LUX, max: MAX_LUX,
  });

  // A zero-width or inverted span is a division by zero dressed up as a
  // preference — the same failure two curve points at one minute would be, and
  // it would reach `levelFromLux` as a NaN level and a lamp as no write at all.
  if (!(brightLux > darkLux)) {
    fail(`${path}.brightLux`, 'is not above darkLux, so the response has no span');
  }

  const darkElevation = requireNumber(response.darkElevation, `${path}.darkElevation`, {
    min: MIN_ELEVATION, max: MAX_ELEVATION,
  });
  const brightElevation = requireNumber(response.brightElevation, `${path}.brightElevation`, {
    min: MIN_ELEVATION, max: MAX_ELEVATION,
  });
  // The same refusal the lux pair gets, for the same reason: no span is a
  // division by zero that reaches a lamp as no write at all.
  if (!(brightElevation > darkElevation)) {
    fail(`${path}.brightElevation`, 'is not above darkElevation, so the response has no span');
  }

  return {
    sensor,
    darkLux,
    brightLux,
    // Both ends are REQUIRED, unlike every other stored brightness in this app.
    // A response is asked for a number on every tick and has no "leave it alone"
    // to fall back on, so an absent end is a plan that cannot be evaluated
    // rather than one that does less.
    dark: requireUnitInterval(response.dark, `${path}.dark`),
    bright: requireUnitInterval(response.bright, `${path}.bright`),
    darkElevation,
    brightElevation,
    // REFUSED rather than defaulted, unlike the sanitiser's policy on the same
    // field. The sanitiser reads a screen and repairs what it sends; this reads a
    // STORED plan, where an unknown value means a partial write, a hand edit or
    // a downgrade — and quarantining it with a named path is what tells somebody
    // which device to repair.
    sunPeak: requireSunPeak(response.sunPeak, `${path}.sunPeak`),
    transition: requireTransition(response.transition, `${path}.transition`),
  };
}

export function validateDaylightPlan(raw: unknown): DaylightPlan {
  const plan = requireRecord(raw, ROOT.daylight);
  return {
    ...planRoot(plan, ROOT.daylight),
    response: validateDaylightResponse(plan.response, `${ROOT.daylight}.response`),
    ...storedWritesLights(plan),
  };
}

/** Exported for the pairing DTO checks, which validate a target on its own. */
export { validateTarget };
