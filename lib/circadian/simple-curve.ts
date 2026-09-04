import { MINUTES_PER_DAY } from '../time/wall-clock';
import { sanitiseUnitInterval } from '../validation/unit-interval';
import type { CircadianPlan, CircadianPoint } from './circadian-types';
import type { TargetSpec } from '../outputs/light-intent';
import type { DaylightResponse } from '../daylight/daylight-types';

/**
 * A circadian light with no curve to draw: two ends of the day, and a shape.
 *
 * The curve controller (`drivers/curve/`) is the same engine with the curve
 * exposed — every point, every time, and a colour per point. It is the right tool
 * for somebody who wants a specific evening, and the wrong first experience for
 * everybody else: a five-point editor is a lot of screen for "warm at night, cool
 * in the day", which is what the feature is actually for.
 *
 * So this device type asks two questions — what does warmest look like, what does
 * coolest look like — and supplies the SHAPE itself. Same runtime, same write
 * gate, same override handling; the only difference is where the points come from.
 *
 * The shape is not configurable, and that is the decision. Once the times are
 * adjustable this is the curve controller with fewer fields, and the two device
 * types stop being different products. Somebody who wants their own times has one
 * already.
 */

export interface CircadianEnd {
  /** Normalised colour temperature 0–1, where 1 is the WARMEST end (§6). */
  temperature: number;
  /**
   * Perceptual brightness 0–1. Both ends carry one or neither does — the curve
   * engine interpolates brightness only where both bracketing points have it, and
   * half a brightness curve would have to invent the other half.
   */
  brightness?: number;
  /**
   * Take this end's brightness from the daylight instead of from the number
   * above.
   *
   * Per END rather than for the whole device, because the two ends of the day are
   * genuinely different questions — "as bright as the room needs at night" and
   * "as bright as the room needs at noon" — and somebody may well want one of
   * them answered by a sensor and the other by hand.
   *
   * The number STAYS and becomes the fallback. See the same field on a schedule
   * entry for why that is the load-bearing half of the design.
   */
  fromDaylight?: boolean;
}

export interface SimpleCircadianPlan {
  schemaVersion: number;
  /** The device's onoff capability: false = paused, nothing is written. */
  enabled: boolean;
  target: TargetSpec;
  /** What the lights look like at the warm end of the day — evening and night. */
  warmest: CircadianEnd;
  /** And at the cool end — the middle of the day. */
  coolest: CircadianEnd;
  /** Follow the brightness as well as the temperature. See CircadianEnd. */
  adjustBrightness: boolean;
  /**
   * ONE daylight response for the whole device, or none. See the same field on
   * `SchedulePlan` for why it is inline and why it is per device.
   */
  daylight?: DaylightResponse;
  /** Write to lights that are OFF. Opt-in and self-disabling; see §12. */
  preStage: boolean;
}

/**
 * The shape, in wall-clock minutes.
 *
 * Four points, not two, and the reason is the whole of what makes this feel right
 * rather than merely correct. Two points — coolest at midday, warmest at midnight
 * — give a curve that is only ever AT one of them for an instant and spends the
 * night on its way somewhere: it would start cooling at 23:00 and be halfway to
 * daylight by 04:00.
 *
 * Two points per end instead, so each end is HELD:
 *
 *   06:00 warmest ──┐ (the night's hold ends)
 *   11:00 coolest   │ cooling through the morning
 *   15:00 coolest   │ (held through the middle of the day)
 *   21:00 warmest ──┘ warming through the evening
 *
 * and the segment from 21:00 round to 06:00 is warmest at both ends, so the whole
 * night is flat. Cyclic interpolation is what makes that last sentence true
 * without a special case — see `circadian-curve.ts`.
 */
export const SIMPLE_SHAPE: readonly { id: string; minute: number; end: 'warmest' | 'coolest' }[] = [
  { id: 'dawn', minute: 6 * 60, end: 'warmest' },
  { id: 'morning', minute: 11 * 60, end: 'coolest' },
  { id: 'afternoon', minute: 15 * 60, end: 'coolest' },
  { id: 'evening', minute: 21 * 60, end: 'warmest' },
] as const;

/** What a new device starts with: a full warm night, a cool working day. */
export const DEFAULT_SIMPLE_PLAN: Omit<SimpleCircadianPlan, 'target' | 'schemaVersion'> = {
  enabled: true,
  warmest: { temperature: 1, brightness: 0.6 },
  coolest: { temperature: 0.15, brightness: 0.9 },
  adjustBrightness: false,
  preStage: false,
};

/**
 * The two ends and the shape, as the curve engine's points.
 *
 * Derived on every load and every save rather than stored: the shape is a
 * constant in this file, and persisting a copy of it would mean an installed
 * device keeping a shape a later version had improved. What is stored is the two
 * answers only the user can give.
 *
 * `brightness` is carried onto every point or onto none, which is the engine's
 * own rule (`adjustBrightness` is refused unless every point has one).
 */
export function expandSimplePlan(plan: SimpleCircadianPlan): CircadianPlan {
  const withBrightness = plan.adjustBrightness
    && plan.warmest.brightness !== undefined
    && plan.coolest.brightness !== undefined;

  const points: CircadianPoint[] = SIMPLE_SHAPE.map(({ id, minute, end }) => {
    const source = plan[end];
    return {
      id,
      anchor: { kind: 'clock', at: minute % MINUTES_PER_DAY },
      warmth: source.temperature,
      ...(withBrightness ? { brightness: source.brightness! } : {}),
      // Carried onto every point derived from that end, so the runtime sees the
      // flag wherever the shape put it. Only alongside a brightness, for the
      // same reason the field itself is only meaningful with one.
      ...(withBrightness && source.fromDaylight === true ? { fromDaylight: true } : {}),
    };
  });

  return {
    schemaVersion: plan.schemaVersion,
    enabled: plan.enabled,
    target: plan.target,
    points,
    adjustBrightness: withBrightness,
    // Carried through, because the expanded plan is what the runtime evaluates
    // and a response left behind here would leave every `fromDaylight` above
    // pointing at nothing.
    ...(plan.daylight !== undefined ? { daylight: plan.daylight } : {}),
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
 * Everything else in the expanded plan is derived from `SIMPLE_SHAPE`, so reading
 * it back would be reading back a constant.
 *
 * It lives HERE, beside the expansion it inverts, rather than in
 * `drivers/circadian/device.ts` where it was: that file extends `Homey.Device`
 * and so cannot be imported by a test at all (platform §13), which is exactly why
 * a bug in the fold-back — persisting the pre-edit plan on every repair — shipped
 * without anything failing.
 *
 * `onto` is the plan the fold is FOR. It used to be read from the device store
 * inside the driver, and `DeviceLifecycle.apply()` persists after registering, so
 * on a repair the store still held the plan the user had just replaced.
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
 * Nothing is DROPPED here, because there is nothing droppable: two ends are not a
 * list, and a device with one end is not a degraded device, it is a device with no
 * curve at all. So a missing or unusable value falls back to the default for that
 * end — and the caller is told which, so the screen can say so rather than
 * silently showing something else.
 */
export function sanitiseSimplePlan(raw: unknown): {
  warmest: CircadianEnd;
  coolest: CircadianEnd;
  adjustBrightness: boolean;
  corrected: string[];
} {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const corrected: string[] = [];

  const end = (key: 'warmest' | 'coolest'): CircadianEnd => {
    const fallback = DEFAULT_SIMPLE_PLAN[key];
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
    return {
      temperature,
      ...(brightness !== null && brightness > 0
        ? { brightness }
        : { brightness: fallback.brightness! }),
      // An end always ends up with a brightness above, so there is no "only
      // alongside one" check to make here — unlike a curve point or a schedule
      // window, where a brightness is genuinely optional.
      ...(given.fromDaylight === true ? { fromDaylight: true } : {}),
    };
  };

  const warmest = end('warmest');
  const coolest = end('coolest');

  return {
    warmest,
    coolest,
    // All-or-nothing, checked here rather than trusted from the screen — the same
    // rule the curve's own sanitiser applies across every point.
    adjustBrightness: source.adjustBrightness === true
      && warmest.brightness !== undefined && coolest.brightness !== undefined,
    corrected,
  };
}

/**
 * Derive the two ends from an existing point-based plan.
 *
 * The migration path for a circadian device saved when this driver WAS the curve
 * editor. The warmest and coolest points are the honest answer — they are the two
 * values the user actually chose, and the ones the shape above is built to hold.
 * Whatever they set between them is lost, and it has to be: this device type has
 * nowhere to put it. The changelog says so, and `drivers/curve/` is where that
 * curve can be rebuilt if they want it back.
 */
export function endsFromPoints(points: readonly CircadianPoint[]): {
  warmest: CircadianEnd;
  coolest: CircadianEnd;
} {
  if (points.length === 0) {
    return { warmest: DEFAULT_SIMPLE_PLAN.warmest, coolest: DEFAULT_SIMPLE_PLAN.coolest };
  }

  const sorted = [...points].sort((a, b) => a.warmth - b.warmth);
  const coolestPoint = sorted[0]!;
  const warmestPoint = sorted[sorted.length - 1]!;

  const from = (point: CircadianPoint): CircadianEnd => ({
    temperature: point.warmth,
    ...(point.brightness !== undefined ? { brightness: point.brightness } : {}),
  });

  return { warmest: from(warmestPoint), coolest: from(coolestPoint) };
}
