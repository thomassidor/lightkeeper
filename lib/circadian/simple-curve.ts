import { MINUTES_PER_DAY } from '../time/wall-clock';
import { MINIMUM_BRIGHTNESS } from '../outputs/light-intent';
import { sanitiseUnitInterval } from '../validation/unit-interval';
import type { AnchorContext } from './circadian-curve';
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
 * How long each boundary takes to cross, in minutes either side of it.
 *
 * Fifty minutes, so a zone change is something you notice having happened
 * rather than something you watch happen. It is also what keeps each zone FLAT:
 * two points at one temperature with a ramp between them is the only way to hold
 * a value on an interpolating curve, which is the same trick the old four-point
 * shape used.
 */
export const ZONE_RAMP = 50;

/**
 * How far a boundary may be pushed off its sunrise or sunset, in minutes.
 *
 * Two and a half hours either way, stepped by a quarter of an hour on screen.
 * Wider than anybody sensible needs and narrow enough that the two boundaries
 * cannot trade places on an ordinary day — and `zonePoints` clamps the resolved
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
  /** Write to lights that are OFF. Opt-in and self-disabling; see platform §12. */
  preStage: boolean;
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
 * `preStage: true` is what a NEW device starts with, and that is a reversal.
 *
 * It was `false` because a colour written to an off lamp switches it on through
 * some integrations (platform §6), and "lights coming on by themselves at night
 * is a far worse failure than a half-second of the wrong white". That reasoning
 * is still right about the failure; what it got wrong was the alternative,
 * because the half-second is not what opting out actually bought. Measured on
 * the reference Homey: a lamp switched on at the wall reports itself on, the
 * runtime fires within 70 ms, and the colour lands 1.3 to 1.9 s later. Every
 * light in the house visibly changed colour after somebody had already looked
 * at it, every time, for as long as the app has existed.
 *
 * What makes the reversal safe is that the protection is unchanged and does not
 * depend on anybody opting in: `verifyStayedOff` probes 1.5 s after the first
 * pre-stage write and, if the lamp came on, turns pre-staging off for the whole
 * device and PERSISTS that. The exposure is therefore one lamp coming on once,
 * on an integration that does this, before the device stops doing it for good.
 *
 * It is one lamp coming ON, not one staying on unnoticed: the probe does not
 * switch it back, because by then our doing it and somebody walking into the
 * room are indistinguishable (platform §12). That is the cost, it is bounded,
 * and the pairing screen now carries a test that answers the question against
 * the household's own lamps before any of it happens.
 *
 * Deliberately NOT applied to devices that already exist. They were paired
 * under the opt-in promise, and the store's own gate still reads
 * `preStage === true`, so an absent key stays off. See lib/validation/plans.ts.
 */
export const DEFAULT_SIMPLE_PLAN: Omit<SimpleCircadianPlan, 'target' | 'schemaVersion'> = {
  enabled: true,
  zones: DEFAULT_ZONES,
  adjustBrightness: false,
  preStage: true,
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

  // Each zone needs room for its own ramp plus half of each neighbour's, or two
  // boundaries land on top of one another and the middle zone never holds.
  const slack = 3 * ZONE_RAMP;

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
 * The three zones as the curve engine's six points.
 *
 * Six, because holding three values flat needs two points each, and the ramps
 * between them are where the day actually changes:
 *
 * ```
 *   00:00+R  morning ─┐ (the night's ramp into the morning ends)
 *   A−R      morning ─┘ held all morning
 *   A+R      midday  ─┐ cooling across the morning boundary
 *   B−R      midday  ─┘ held through the middle of the day
 *   B+R      evening ─┐ warming across the evening boundary
 *   24:00−R  evening ─┘ held all evening
 * ```
 *
 * The pair around MIDNIGHT is the one the design canvas does not draw, and it is
 * deliberate. The canvas reads the morning temperature from midnight and the
 * evening temperature up to midnight, which was a step change the moment those
 * two stopped being the same value — the lights would jump at 00:00 every night.
 * The engine's interpolation is cyclic, so a ramp across midnight is the same
 * rule applied a third time rather than a special case.
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

  const withBrightness = adjustBrightness
    && zones.morning.brightness !== undefined
    && zones.midday.brightness !== undefined
    && zones.evening.brightness !== undefined;

  const point = (id: string, minute: number, key: ZoneKey): CircadianPoint => {
    const zone = zones[key];
    return {
      id,
      anchor: { kind: 'clock', at: wrap(minute) },
      warmth: zone.temperature,
      ...(withBrightness ? { brightness: zone.brightness! } : {}),
    };
  };

  return [
    point('night-end', ZONE_RAMP, 'morning'),
    point('morning-hold', morningEndMinute - ZONE_RAMP, 'morning'),
    point('midday-start', morningEndMinute + ZONE_RAMP, 'midday'),
    point('midday-hold', eveningStartMinute - ZONE_RAMP, 'midday'),
    point('evening-start', eveningStartMinute + ZONE_RAMP, 'evening'),
    point('night-start', MINUTES_PER_DAY - ZONE_RAMP, 'evening'),
  ];
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
    preStage: plan.preStage,
  };
}

/**
 * The other half of `expandSimplePlan`: what the runtime knows, folded back onto
 * what this device type stores.
 *
 * Only two fields can move while a runtime is running. `preStage` turns ITSELF
 * off after observing a lamp come on from a colour write (platform §12), and
 * that verdict has to survive a restart or the same lamp is switched on again
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
  runtimePlan: { enabled: boolean; preStage: boolean },
): SimpleCircadianPlan {
  return { ...onto, enabled: runtimePlan.enabled, preStage: runtimePlan.preStage };
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
