import { MINUTES_PER_DAY } from '../time/wall-clock';
import { MINIMUM_BRIGHTNESS } from '../outputs/light-intent';
import { sanitiseUnitInterval } from '../validation/unit-interval';
import type { AnchorContext, CurveValue } from './circadian-curve';
import {
  DEFAULT_TRANSITION, mix, sanitiseTransition, shape, type Transition,
} from '../support/interpolate';
import type { CircadianPlan, CircadianPoint } from './circadian-types';
import type { TargetSpec } from '../outputs/light-intent';

/**
 * A circadian light with no curve to draw: three parts of the day, and two
 * boundaries that follow the sun.
 *
 * The curve controller (`drivers/curve/`) is the same engine with the curve
 * exposed — every point, every time, and a colour per point. It is the right
 * tool for somebody who wants a specific evening, and the wrong first
 * experience for everybody else.
 *
 * **Why three zones and not two ends.** This device used to ask for a warmest
 * and a coolest and supply a fixed four-point shape at 06:00, 11:00, 15:00 and
 * 21:00. Two things were wrong with that, and the second is the one that
 * mattered. A fixed 21:00 is wrong twice a year — it is an hour after sunset in
 * December and two hours before it in June, so the "evening" the user set
 * arrives at the wrong time for most of the year. And "warmest" was a single
 * value the day passed through TWICE, once before the morning and once after the
 * evening, which no single control could honestly represent: a screen drawing one
 * handle for it was lying by omission.
 *
 * So the boundaries anchor to real sunrise and sunset with an offset the user
 * can step, and the morning and the evening get their own temperatures. The cost
 * is one more decision at setup and a fallback for the days a sunrise does not
 * exist, both of which are paid below.
 */

/**
 * The shortest a zone may be, in minutes, once its boundaries are resolved.
 *
 * Two and a half hours. Each zone's value sits at its CENTRE and the day
 * blends from one centre to the next (`zoneValueAt`), so a zone this short is
 * one whose own colour is only ever passed through — which is still a day in
 * order, where a zone of zero width would not be. It is the same 150 minutes
 * the old fixed-ramp shape needed, kept so that no stored offset resolves
 * differently than it did.
 */
export const MIN_ZONE_MINUTES = 150;

/**
 * How far a boundary may be pushed off its sunrise or sunset, in minutes.
 *
 * Two and a half hours either way, stepped by a quarter of an hour on screen.
 * Wider than anybody sensible needs and narrow enough that the two boundaries
 * cannot trade places on an ordinary day — and `resolveBoundaries` clamps the resolved
 * minutes anyway, for the days that are not ordinary.
 */
export const MAX_OFFSET = 150;
export const OFFSET_STEP = 15;

/**
 * Where the boundaries sit when the sun cannot be computed.
 *
 * Two cases reach this and both are real: a Homey that has never been told where
 * it is (`usableLocation` refuses `0,0`, and rightly), and a latitude inside a
 * polar day or night where there is no sunrise to anchor to for weeks. Neither
 * is a reason to stop running — a circadian light on fixed hours is still a
 * circadian light, and these two are the hours the previous version of this
 * device used for its whole life.
 */
export const FALLBACK_SUNRISE = 6 * 60;
export const FALLBACK_SUNSET = 21 * 60;

/** One part of the day: what the lights look like while it lasts. */
export interface CircadianZone {
  /** Normalised colour temperature 0–1, where 1 is the WARMEST end (platform §6). */
  temperature: number;
  /**
   * Perceptual brightness 0–1. Every zone carries one or none of them does — the
   * curve engine interpolates brightness only where both bracketing points have
   * it, and two thirds of a brightness curve would have to invent the rest.
   */
  brightness?: number;
}

export type ZoneKey = 'morning' | 'midday' | 'evening';

/** The three zones and the two boundaries between them. */
export interface CircadianZones {
  /** Midnight until the morning boundary. */
  morning: CircadianZone;
  /** Between the two boundaries — the middle of the day. */
  midday: CircadianZone;
  /** From the evening boundary until midnight. */
  evening: CircadianZone;
  /** Minutes either side of today's sunrise. Negative is before it. */
  morningEnd: number;
  /** Minutes either side of today's sunset. */
  eveningStart: number;
}

export interface SimpleCircadianPlan {
  schemaVersion: number;
  /** The device's onoff capability: false = paused, nothing is written. */
  enabled: boolean;
  target: TargetSpec;
  zones: CircadianZones;
  /** Follow the brightness as well as the temperature. See `CircadianZone`. */
  adjustBrightness: boolean;
  /** How each zone blends into the next. See `zoneValueAt`. */
  transition: Transition;
  /** Write to lights that are OFF — only those in `preStageLights`. See CircadianPlan. */
  preStage: boolean;
  /** The lamps a pre-stage test proved safe. See CircadianPlan.preStageLights. */
  preStageLights?: string[];
  /**
   * Absent = keep the lights up to date all day; `false` = publish only.
   * Stored only when false. See lib/runtime/writes-lights.ts for why the gate
   * is `!== false`.
   */
  writesLights?: false;
}

/** What a new device starts with: a warm morning and evening, a cool working day. */
export const DEFAULT_ZONES: CircadianZones = {
  morning: { temperature: 0.78, brightness: 0.55 },
  midday: { temperature: 0.18, brightness: 0.9 },
  evening: { temperature: 0.86, brightness: 0.45 },
  morningEnd: 30,
  eveningStart: -60,
};

/**
 * What a new circadian light starts with: brightness ON, pre-staging OFF.
 *
 * **Brightness on** because the zones above already carry one each, and the
 * 2026-09-23 design makes "Set brightness too" the default everywhere it is
 * offered. A saved device keeps what it stored.
 *
 * **Pre-staging off, and that is the SECOND reversal.** It started off (a colour
 * written to an off lamp switches it on through some integrations, platform
 * §6), was turned on for new devices in 0.6.5 because opting out cost every
 * switch-on a visible colour change 1.3–1.9 s after the lamp came on, and is off
 * again now because the question it answered has moved to where it can be
 * answered properly. The review screen asks "How Lightkeeper controls your
 * lights", and "Set lights before they turn on" pre-stages only the lamps its
 * own per-lamp test watched stay off (`preStageLights`). Defaulting it on would
 * mean defaulting to a choice nobody can make before the test has run — and a
 * chosen-but-untested device behaves as option 1 anyway.
 *
 * `verifyStayedOff` still guards the lamps that did pass: one that later comes
 * on from a pre-stage write is struck off the list, persisted.
 */
export const DEFAULT_SIMPLE_PLAN: Omit<SimpleCircadianPlan, 'target' | 'schemaVersion'> = {
  enabled: true,
  zones: DEFAULT_ZONES,
  adjustBrightness: true,
  transition: DEFAULT_TRANSITION,
  preStage: false,
};

/** The two boundaries as minutes of the local day, in an order the curve can use. */
export interface ResolvedBoundaries {
  morningEndMinute: number;
  eveningStartMinute: number;
  /** False when the sun was not available and the fixed hours were used instead. */
  fromSun: boolean;
}

/**
 * Where today's boundaries actually fall, clamped so the day stays in order.
 *
 * **The clamp is not belt and braces; it is the whole reason this is a function
 * rather than two additions.** An offset is stored once and resolved against a
 * sunrise that moves all year, so a pair that is sensible in June can invert in
 * December: north of about 60° the shortest day is under six hours, and a
 * morning pushed late plus an evening pulled early crosses over. A crossed pair
 * does not fail — `resolvePoints` sorts by minute, so it silently produces a day
 * that runs midday, morning, evening, midday, which is far worse than failing.
 *
 * So the morning boundary is held clear of the evening one, and both are held
 * clear of midnight, exactly as the design canvas's own `bounds()` does.
 */
export function resolveBoundaries(
  zones: CircadianZones,
  context: AnchorContext = {},
): ResolvedBoundaries {
  const fromSun = context.sunriseMinute !== undefined && context.sunsetMinute !== undefined;
  const sunrise = context.sunriseMinute ?? FALLBACK_SUNRISE;
  const sunset = context.sunsetMinute ?? FALLBACK_SUNSET;

  // Each zone keeps a minimum width, or two boundaries land on top of one
  // another and the middle zone is never reached at all.
  const slack = MIN_ZONE_MINUTES;

  const morningEndMinute = clamp(sunrise + zones.morningEnd, slack, MINUTES_PER_DAY - 2 * slack);
  const eveningStartMinute = clamp(
    sunset + zones.eveningStart,
    morningEndMinute + slack,
    MINUTES_PER_DAY - slack,
  );

  return { morningEndMinute, eveningStartMinute, fromSun };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The three zones as three points, one at each zone's CENTRE.
 *
 * These are for READING — the diagnostics' point list, "next point", and the
 * snapshot on an expanded plan — and not what the runtime evaluates. Handed to
 * `valueAt` they would put the change halfway between two centres rather than
 * at the boundary somebody set; `zoneValueAt` is the evaluator, and it is
 * centred on the boundaries.
 *
 * Clock anchors rather than sun anchors, because the boundaries have already
 * been clamped against each other by `resolveBoundaries` and a sun anchor would
 * throw that away — see the note on `CircadianPlan.zones` for how this stays
 * fresh as the sun moves through the year.
 */
export function zonePoints(
  zones: CircadianZones,
  context: AnchorContext = {},
  adjustBrightness = false,
): CircadianPoint[] {
  const { morningEndMinute, eveningStartMinute } = resolveBoundaries(zones, context);
  const withBrightness = zonesCarryBrightness(zones, adjustBrightness);

  const point = (key: ZoneKey, minute: number): CircadianPoint => {
    const zone = zones[key];
    return {
      id: key,
      anchor: { kind: 'clock', at: wrap(Math.round(minute)) },
      warmth: zone.temperature,
      ...(withBrightness ? { brightness: zone.brightness! } : {}),
    };
  };

  return [
    point('morning', morningEndMinute / 2),
    point('midday', (morningEndMinute + eveningStartMinute) / 2),
    point('evening', (eveningStartMinute + MINUTES_PER_DAY) / 2),
  ];
}

function zonesCarryBrightness(zones: CircadianZones, adjustBrightness: boolean): boolean {
  return adjustBrightness
    && zones.morning.brightness !== undefined
    && zones.midday.brightness !== undefined
    && zones.evening.brightness !== undefined;
}

/**
 * What a circadian light holds at this minute of the local day.
 *
 * **Zone to zone, centred on each boundary.** Every zone's value belongs to its
 * centre, and the day blends from one zone into the next across a window
 * centred on the boundary between them — so the boundary somebody set
 * ("Ends: sunrise +30m") is always the halfway point of the change, whatever
 * the transition. Quick then changes AT the boundary; Gradual spreads the same
 * change out as far as the window allows.
 *
 * The window is symmetric, as wide as the SHORTER of its two zones allows: the
 * blend reaches that zone's centre exactly and stops short of the longer one's,
 * which holds its own value flat for the difference. Symmetric because the
 * alternative — each half as long as its own zone — puts a kink in the curve at
 * the boundary, which for Balanced and Quick is the exact moment it is moving
 * fastest.
 *
 * Three boundaries, not two: evening → morning crosses midnight. The morning
 * zone starts at 00:00 and the evening one ends there, so a day without that
 * third blend would step at midnight every night the two differ.
 *
 * This replaced six points with fixed 50-minute ramps either side of each
 * boundary, which held every zone flat and blended only across 100 minutes.
 * Existing devices were migrated to Quick, the nearest of the three to that
 * shape — see lib/circadian/circadian-migrations.ts.
 */
export function zoneValueAt(
  zones: CircadianZones,
  context: AnchorContext,
  adjustBrightness: boolean,
  transition: Transition,
  minutesOfDay: number,
): CurveValue {
  const { morningEndMinute: morningEnd, eveningStartMinute: eveningStart } =
    resolveBoundaries(zones, context);
  const withBrightness = zonesCarryBrightness(zones, adjustBrightness);
  const now = wrap(minutesOfDay);

  const value = (from: CircadianZone, to: CircadianZone, fraction: number): CurveValue => {
    const shaped = shape(transition, fraction);
    return {
      warmth: mix(from.temperature, to.temperature, shaped),
      ...(withBrightness ? { brightness: mix(from.brightness!, to.brightness!, shaped) } : {}),
    };
  };

  // Each boundary with the zones either side of it and how long those zones
  // are. The midnight one sits at 0 and is measured cyclically.
  const boundaries: [number, ZoneKey, number, ZoneKey, number][] = [
    [morningEnd, 'morning', morningEnd, 'midday', eveningStart - morningEnd],
    [eveningStart, 'midday', eveningStart - morningEnd, 'evening', MINUTES_PER_DAY - eveningStart],
    [0, 'evening', MINUTES_PER_DAY - eveningStart, 'morning', morningEnd],
  ];

  for (const [at, before, beforeLength, after, afterLength] of boundaries) {
    const half = Math.min(beforeLength, afterLength) / 2;
    // Signed distance from the boundary, the short way round the clock.
    const offset = ((now - at + MINUTES_PER_DAY * 1.5) % MINUTES_PER_DAY) - MINUTES_PER_DAY / 2;
    if (half > 0 && Math.abs(offset) < half) {
      return value(zones[before], zones[after], (offset + half) / (2 * half));
    }
  }

  // Outside every window: holding a zone's own value.
  const key: ZoneKey = now < morningEnd ? 'morning' : now < eveningStart ? 'midday' : 'evening';
  return value(zones[key], zones[key], 0);
}

function wrap(minute: number): number {
  return ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * The zones as the plan the runtime evaluates.
 *
 * `points` here is a SNAPSHOT taken against the fallback hours, and `zones` is
 * the source it came from. Both are on the plan on purpose: everything downstream
 * of the runtime — the pure curve engine, the validator, the diagnostics, the
 * preview — reads an ordinary point list and needs to go on doing so, while the
 * runtime re-derives that list from `zones` on every tick against the day's real
 * sunrise. Without the re-derivation the boundaries would be frozen at whatever
 * the sun was doing when the device was last registered, and sunrise moves by
 * four minutes a day around an equinox.
 */
export function expandSimplePlan(plan: SimpleCircadianPlan): CircadianPlan {
  const points = zonePoints(plan.zones, {}, plan.adjustBrightness);
  return {
    schemaVersion: plan.schemaVersion,
    enabled: plan.enabled,
    target: plan.target,
    points,
    zones: plan.zones,
    adjustBrightness: points.every(p => p.brightness !== undefined),
    transition: plan.transition,
    preStage: plan.preStage,
    // Field by field above, so a new stored field has to be carried here by
    // name or the runtime never sees it.
    ...(plan.preStageLights !== undefined ? { preStageLights: [...plan.preStageLights] } : {}),
    ...(plan.writesLights === false ? { writesLights: false as const } : {}),
  };
}

/**
 * The other half of `expandSimplePlan`: what the runtime knows, folded back onto
 * what this device type stores.
 *
 * Only two things can move while a runtime is running. `preStageLights` loses a
 * lamp after observing it come on from a colour write (platform §12), and that
 * verdict has to survive a restart or the same lamp is switched on again
 * tomorrow night; `enabled` moves when somebody uses the pause switch.
 * Everything else in the expanded plan is derived from the zones, so reading it
 * back would be reading back a derivation.
 *
 * It lives HERE, beside the expansion it inverts, rather than in
 * `drivers/circadian/device.ts` where it was: that file extends `Homey.Device`
 * and so cannot be imported by a test at all (platform §13), which is exactly why
 * a bug in the fold-back — persisting the pre-edit plan on every repair — shipped
 * without anything failing.
 */
export function foldBackSimplePlan(
  onto: SimpleCircadianPlan,
  runtimePlan: { enabled: boolean; preStage: boolean; preStageLights?: string[] },
): SimpleCircadianPlan {
  // `preStageLights` rather than `preStage` is what the runtime moves now: a
  // lamp seen coming on is struck off the list, and the choice itself stays.
  // Absent on the runtime side means absent here too, never an empty list.
  const { preStageLights: _dropped, ...rest } = onto;
  return {
    ...rest,
    enabled: runtimePlan.enabled,
    preStage: runtimePlan.preStage,
    ...(runtimePlan.preStageLights !== undefined
      ? { preStageLights: [...runtimePlan.preStageLights] } : {}),
  };
}

/**
 * Everything a screen sends is untrusted, the same way a schedule's rows are.
 *
 * Nothing is DROPPED here, because there is nothing droppable: three zones are
 * not a list, and a device with two of them is not a degraded device, it is a
 * device with no curve at all. So a missing or unusable value falls back to the
 * default for that zone — and the caller is told which, so the screen can say so
 * rather than silently showing something else.
 */
export function sanitiseZones(raw: unknown): {
  zones: CircadianZones;
  adjustBrightness: boolean;
  transition: Transition;
  corrected: string[];
} {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const corrected: string[] = [];

  const zone = (key: ZoneKey): CircadianZone => {
    const fallback = DEFAULT_ZONES[key];
    const given = (source[key] && typeof source[key] === 'object'
      ? source[key]
      : {}) as Record<string, unknown>;

    let temperature = sanitiseUnitInterval(given.temperature);
    if (temperature === null) {
      corrected.push(`${key} temperature`);
      temperature = fallback.temperature;
    }

    // A brightness of 0 is "on, at nothing" — unset, as it is in a schedule row.
    const brightness = sanitiseUnitInterval(given.brightness);
      // Floored rather than stored as sent. A positive brightness is never
      // written as darkness, and the bottom of the axis is where that bites: 5%
      // is `dim` 0.0014, which `decimals: 2` rounds to 0.00 — off, on most
      // integrations. `litDim` is the net under this at write time, but a plan
      // that STORES 5% would show 5% on every screen while the lamp went dark.
      // This used to be a migration step's job, and the migrations are gone.
    return {
      temperature,
      brightness: brightness !== null && brightness > 0
        ? Math.max(MINIMUM_BRIGHTNESS, brightness)
        : fallback.brightness!,
    };
  };

  const morning = zone('morning');
  const midday = zone('midday');
  const evening = zone('evening');

  return {
    zones: {
      morning,
      midday,
      evening,
      morningEnd: offset(source.morningEnd, DEFAULT_ZONES.morningEnd, 'morningEnd', corrected),
      eveningStart: offset(
        source.eveningStart, DEFAULT_ZONES.eveningStart, 'eveningStart', corrected,
      ),
    },
    // All-or-nothing, checked here rather than trusted from the screen — the same
    // rule the curve's own sanitiser applies across every point.
    adjustBrightness: source.adjustBrightness === true
      && morning.brightness !== undefined
      && midday.brightness !== undefined
      && evening.brightness !== undefined,
    transition: sanitiseTransition(source.transition, corrected),
    corrected,
  };
}


/**
 * One boundary offset: a whole number of quarter hours, inside the range.
 *
 * Snapped to the step rather than merely clamped, because the screen steps in
 * quarter hours and a stored 37 could only have come from a hand-edited store or
 * a scripted pair session (platform §14) — and "sunset −37m" on a screen whose
 * every control moves in fifteens reads as a bug in the screen.
 */
function offset(raw: unknown, fallback: number, field: string, corrected: string[]): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    if (raw !== undefined) corrected.push(field);
    return fallback;
  }
  const stepped = Math.round(raw / OFFSET_STEP) * OFFSET_STEP;
  const clamped = clamp(stepped, -MAX_OFFSET, MAX_OFFSET);
  if (clamped !== raw) corrected.push(field);
  return clamped;
}
