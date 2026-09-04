import {
  fail, isRecord, optionalNumber,
  requireArray, requireBoolean, requireNumber, requireOneOf, requireRecord,
  requireString, requireUnitInterval,
} from './guards';
import { MINUTES_PER_DAY } from '../time/wall-clock';
import { isPaletteColor } from '../circadian/palette';
import type { TargetSpec } from '../outputs/light-intent';
import type { ControllerBehavior, LightFunction, MappingRule } from '../mapping/mapping-types';
import type { ControllerProfile, ManagedFlowReference } from '../profiles/controller-profile';
import {
  ENTRY_ID_SHAPE,
  type SchedulePlan, type ScheduleEntry, type ScheduleEnd, type IsoWeekday,
} from '../schedules/schedule-types';
import {
  MIN_POINTS,
  type CircadianPlan, type CircadianPoint, type CircadianAnchor,
} from '../circadian/circadian-types';
import type { CircadianEnd, SimpleCircadianPlan } from '../circadian/simple-curve';
import {
  MAX_SENSORS, MAX_LUX, MIN_LUX,
  type DaylightPlan, type DaylightResponse,
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

const LIGHT_FUNCTIONS: readonly LightFunction[] = [
  'toggle', 'on', 'off', 'brightness_up', 'brightness_down', 'warmer', 'colder',
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
  return {
    id: requireString(rule.id, `${path}.id`),
    function: requireOneOf(rule.function, `${path}.function`, LIGHT_FUNCTIONS),
    inputKey: rule.inputKey === null ? null : requireString(rule.inputKey, `${path}.inputKey`),
    target: rule.target === null || rule.target === undefined
      ? null
      : validateTarget(rule.target, `${path}.target`),
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

function validateScheduleEntry(raw: unknown, path: string): ScheduleEntry {
  const entry = requireRecord(raw, path);

  let days: IsoWeekday[] | null = null;
  if (entry.days !== null && entry.days !== undefined) {
    const list = requireArray(entry.days, `${path}.days`, 7);
    days = list.map((day, i) => requireNumber(day, `${path}.days[${i}]`, {
      min: 1, max: 7, integer: true,
    }) as IsoWeekday);
    if (days.length === 0) fail(`${path}.days`, 'is an empty list');
  }

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

  return {
    id,
    onAt,
    days,
    end,
    ...brightnessWithDaylight(entry, path, 'window'),
    ...(entry.temperature !== undefined
      ? { temperature: requireUnitInterval(entry.temperature, `${path}.temperature`) } : {}),
  };
}

export function validateSchedulePlan(raw: unknown): SchedulePlan {
  const plan = requireRecord(raw, ROOT.schedule);

  const entries = uniqueIds(
    requireArray(plan.entries, `${ROOT.schedule}.entries`, MAX_ENTRIES)
      .map((entry, i) => validateScheduleEntry(entry, `${ROOT.schedule}.entries[${i}]`)),
    `${ROOT.schedule}.entries`,
  );
  const daylight = optionalDaylight(plan, ROOT.schedule, entries, `${ROOT.schedule}.entries`);

  return {
    ...planRoot(plan, ROOT.schedule),
    entries,
    ...(daylight !== undefined ? { daylight } : {}),
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
  const kind = requireOneOf(anchor.kind, `${path}.kind`, ['clock', 'sun'] as const);

  if (kind === 'sun') {
    /**
     * Declared in the type from day one so anchoring to real sunrise and sunset
     * lands later as a new variant rather than a reshape of every stored plan —
     * and refused here for the same reason `sanitiseCurve` refuses it and
     * `resolveAnchor` throws on it: it needs `homey:manager:geolocation`, which
     * this app does not declare, and solar maths the SDK does not provide
     * (platform §9 and §12). A plan carrying one is a plan from a future build.
     */
    fail(`${path}.kind`, 'is "sun", which this version cannot resolve');
  }

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
    ...brightnessWithDaylight(point, path, 'point'),
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

  const daylight = optionalDaylight(plan, ROOT.circadian, points, `${ROOT.circadian}.points`);

  return {
    ...planRoot(plan, ROOT.circadian),
    points,
    adjustBrightness,
    ...(daylight !== undefined ? { daylight } : {}),
    // Opt-in, so anything other than a real `true` is a no. Matching the 0 → 1
    // migration, which reads `preStage === true` for the same reason.
    preStage: plan.preStage === true,
  };
}

// ---------------------------------------------------- simple circadian plan

function validateEnd(raw: unknown, path: string): CircadianEnd {
  const end = requireRecord(raw, path);
  return {
    temperature: requireUnitInterval(end.temperature, `${path}.temperature`),
    ...brightnessWithDaylight(end, path, 'end'),
  };
}

/**
 * The two-ended plan a circadian light stores.
 *
 * The SHAPE is not validated because it is not stored: `expandSimplePlan` derives
 * the four points from a constant every time (see `simple-curve.ts` for why). What
 * is here is the two answers only the user can give.
 */
export function validateSimpleCircadianPlan(raw: unknown): SimpleCircadianPlan {
  const plan = requireRecord(raw, ROOT.simple);
  const warmest = validateEnd(plan.warmest, `${ROOT.simple}.warmest`);
  const coolest = validateEnd(plan.coolest, `${ROOT.simple}.coolest`);
  const adjustBrightness = requireBoolean(plan.adjustBrightness, `${ROOT.simple}.adjustBrightness`);

  // Both ends or neither, which is the curve engine's own rule: it interpolates
  // brightness only where both bracketing points carry one, and half a brightness
  // curve would have to invent the other half.
  if (adjustBrightness && (warmest.brightness === undefined || coolest.brightness === undefined)) {
    fail(`${ROOT.simple}.adjustBrightness`, 'is set while an end carries no brightness');
  }

  const daylight = optionalDaylight(
    plan, ROOT.simple, [warmest, coolest], `${ROOT.simple}.warmest`,
  );

  return {
    ...planRoot(plan, ROOT.simple),
    warmest,
    coolest,
    adjustBrightness,
    ...(daylight !== undefined ? { daylight } : {}),
    // Opt-in, so anything other than a real `true` is a no.
    preStage: plan.preStage === true,
  };
}

/**
 * The three fields every stored DEVICE plan opens with.
 *
 * A schedule, a Curve light, a circadian light and a Daylight light all carry a
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
 * The ROW-level half of the `fromDaylight` rule: a brightness, and the flag
 * that may stand in front of it.
 *
 * `fromDaylight` is refused without a `brightness` because that brightness is
 * the FALLBACK — four paths lead back to it and all four are real: no flag, no
 * response on the plan, no evaluator wired, or an evaluator that cannot tell how
 * light it is. A window that came on at nothing would be worse than one that
 * came on at the level somebody chose last month. Refused rather than dropped:
 * see `requireDaylightAvailable` for why the stored-plan path is stricter than
 * the screen's.
 *
 * `noun` is a parameter rather than a fixed word because the failure message is
 * what somebody reads to find the row to repair, and `plan-validation.test.ts`
 * asserts it. This lived as the same eight lines in `validateEntry`,
 * `validatePoint` and `validateEnd`, differing only in that word — three copies
 * of the one rule CLAUDE.md requires "in every sanitiser and every validator",
 * in the module whose own comment warns that copies are "chances for them to
 * disagree".
 *
 * Key order is `brightness` then `fromDaylight`, matching what the three call
 * sites produced before, because the result is spread into a stored plan.
 */
function brightnessWithDaylight(
  row: Record<string, unknown>,
  path: string,
  noun: string,
): { brightness?: number; fromDaylight?: true } {
  const brightness = row.brightness !== undefined
    ? requireUnitInterval(row.brightness, `${path}.brightness`)
    : undefined;

  if (row.fromDaylight !== true) {
    return brightness !== undefined ? { brightness } : {};
  }
  if (brightness === undefined) {
    fail(`${path}.fromDaylight`, `is set while the ${noun} carries no brightness to fall back to`);
  }
  return { brightness, fromDaylight: true };
}

// -------------------------------------------------------------- daylight

/**
 * The OPTIONAL daylight response the three curve-and-schedule plans may carry,
 * plus the plan-level half of the `fromDaylight` rule that goes with it.
 *
 * The two are one function on purpose. A row that says it follows the daylight,
 * on a device with no daylight response, is a row that looks configured and does
 * nothing — the precise failure this app exists to prevent, and the one the
 * mapping engine's "one rule per gesture" guard exists for in its own corner.
 * The sanitisers cannot check it: each of them sees only the list, never the plan
 * around it. Validating the response and asserting its availability were two
 * calls that every carrier had to remember to make in pairs, so a fourth plan
 * type could have done the first and not the second and nothing would have said
 * so. Now there is no way to have one without the other.
 *
 * REFUSED rather than repaired, unlike the sanitisers' policy on the same field.
 * A stored plan in this state did not come from a screen — it came from a
 * partial write, a hand-edited store or a downgrade — and quarantining it with a
 * named path is what tells somebody which device to repair.
 *
 * `rowsPath` is separate from `root` because the two name different things: the
 * response is refused at `<root>.daylight`, but an unsatisfiable row is refused
 * at the LIST that holds it, which is what somebody needs in order to find it.
 * A Daylight light is not a caller — its response is required, at its own root.
 */
function optionalDaylight(
  plan: Record<string, unknown>,
  root: string,
  rows: Array<{ fromDaylight?: boolean }>,
  rowsPath: string,
): DaylightResponse | undefined {
  const daylight = plan.daylight === undefined
    ? undefined
    : validateDaylightResponse(plan.daylight, `${root}.daylight`);

  if (daylight === undefined && rows.some(row => row.fromDaylight === true)) {
    fail(rowsPath, 'follows the daylight, but this device has no daylight response');
  }
  return daylight;
}

/**
 * One daylight response, validated at whichever of FOUR paths holds it.
 *
 * The `path` argument is what makes one function serve four stores: a Daylight
 * light keeps its response at the root of its plan, and a schedule, a circadian
 * light and a Curve light each keep one in an optional field. Four copies of
 * these six checks is four chances for them to disagree about what a response is.
 */
function validateDaylightResponse(raw: unknown, path: string): DaylightResponse {
  const response = requireRecord(raw, path);

  const sensors = requireArray(response.sensors, `${path}.sensors`, MAX_SENSORS)
    .map((id, i) => requireString(id, `${path}.sensors[${i}]`));

  // A sensor named twice would be weighted twice in the mean — a weighting
  // nobody asked for, and invisible on the screen that set it.
  const seen = new Set<string>();
  for (const id of sensors) {
    if (seen.has(id)) fail(`${path}.sensors`, `names "${id}" more than once`);
    seen.add(id);
  }

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

  return {
    sensors,
    darkLux,
    brightLux,
    // Both ends are REQUIRED, unlike every other stored brightness in this app.
    // A response is asked for a number on every tick and has no "leave it alone"
    // to fall back on, so an absent end is a plan that cannot be evaluated
    // rather than one that does less.
    dark: requireUnitInterval(response.dark, `${path}.dark`),
    bright: requireUnitInterval(response.bright, `${path}.bright`),
  };
}

export function validateDaylightPlan(raw: unknown): DaylightPlan {
  const plan = requireRecord(raw, ROOT.daylight);
  return {
    ...planRoot(plan, ROOT.daylight),
    response: validateDaylightResponse(plan.response, `${ROOT.daylight}.response`),
  };
}

/** Exported for the pairing DTO checks, which validate a target on its own. */
export { validateTarget };
