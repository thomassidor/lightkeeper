import {
  applyPerceptualDelta,
  clampToRange,
  quantise,
  requiredCapability,
  type LightIntent,
} from './light-intent';
import type { TargetStateCache } from './target-state-cache';
import { clamp01 } from './light-intent';
import type { ControllerBehavior } from '../mapping/mapping-types';

/**
 * Pure planning: group toggle, group brightness and while-off policy.
 *
 * Deliberately separated from anything that touches Homey. Group semantics are
 * the most subtle rules in the app, and keeping them free of I/O is what makes
 * them unit-testable. The adapter executes the plan this produces.
 */

/**
 * Every capability this app writes.
 *
 * The three colour ones arrived with the curve controller's palette (a point may
 * declare a colour instead of a colour temperature). They behave differently from
 * the first three in one way worth knowing: nothing in the app ever plans a
 * RELATIVE change to them. There is no "a bit more blue" gesture and no colour
 * ramp, so they need no desired-vs-actual arithmetic — only the echo dedupe (Hue
 * echoes duplicate for every capability, platform §6) and the write log.
 *
 * `light_mode` is a string (`'color'` | `'temperature'`), which is why it is the
 * one capability with no numeric state tracked anywhere.
 */
export type Capability =
  | 'onoff' | 'dim' | 'light_temperature'
  | 'light_mode' | 'light_hue' | 'light_saturation';

/**
 * What a write may carry.
 *
 * `string` arrived with `light_mode` ('color' | 'temperature'), which is the one
 * capability this app writes that is neither a number nor a boolean. Kept as a
 * bare `string` rather than a union of the two modes: the value is echoed to
 * `setCapabilityValue`, and narrowing it here would make a third mode on some
 * future firmware a compile error in six files rather than a value that works.
 */
export type WriteValue = boolean | number | string;

export interface PlannedWrite {
  deviceId: string;
  capability: Capability;
  value: WriteValue;
  /**
   * This dim write is expected to switch the light on by itself, so no separate
   * onoff write was planned. Measured on Hue: a dim write to an off lamp turns
   * it on, and dropping the extra write halves the time to light (269 ms rather
   * than 538 ms). The adapter verifies it and writes onoff only if the lamp
   * did not come on.
   */
  impliesOn?: boolean;
}

export interface SkippedTarget {
  deviceId: string;
  reason: string;
}

export interface IntentPlan {
  writes: PlannedWrite[];
  skipped: SkippedTarget[];
}

export function planIntent(
  intent: LightIntent,
  deviceIds: string[],
  cache: TargetStateCache,
  behavior: ControllerBehavior,
): IntentPlan {
  const capability = requiredCapability(intent);
  const writes: PlannedWrite[] = [];
  const skipped: SkippedTarget[] = [];

  // Partial support behaves like partial failure — execute on the
  // compatible subset, disclose, never fail the whole intent.
  const supported = deviceIds.filter(id => {
    if (cache.supports(id, capability)) return true;
    skipped.push({ deviceId: id, reason: `does not support ${capability}` });
    return false;
  });

  if (supported.length === 0) return { writes, skipped };

  switch (intent.type) {
    case 'toggle':
      return { writes: planGroupToggle(supported, cache), skipped };

    case 'power':
      for (const deviceId of supported) {
        writes.push({ deviceId, capability: 'onoff', value: intent.value });
      }
      return { writes, skipped };

    case 'brightness_delta':
      return planBrightnessDelta(intent.delta, supported, cache, behavior, skipped);

    case 'brightness_absolute':
      for (const deviceId of supported) {
        writes.push({ deviceId, capability: 'dim', value: clampDim(deviceId, intent.value, cache) });
      }
      return { writes, skipped };

    case 'color_absolute':
      return { writes: planColor(intent.hue, intent.saturation, supported, cache), skipped };

    case 'temperature_delta':
      return planTemperatureDelta(intent.delta, supported, cache, skipped);

    case 'temperature_absolute':
      for (const deviceId of supported) {
        writes.push(
          ...planTemperature(deviceId, clampTemperature(deviceId, intent.value, cache), cache),
        );
      }
      return { writes, skipped };
  }
}

/**
 * Toggle is a GROUP action, not independent inversion. If any
 * controllable target is on, turn all off; otherwise turn all on. This keeps a
 * room predictable once individual lights have drifted out of sync.
 */
function planGroupToggle(deviceIds: string[], cache: TargetStateCache): PlannedWrite[] {
  const anyOn = deviceIds.some(id => cache.currentOn(id) === true);
  const target = !anyOn;
  return deviceIds.map(deviceId => ({ deviceId, capability: 'onoff' as const, value: target }));
}

/**
 * Relative by default. The same normalised delta applies to every
 * target based on that target's OWN level, preserving deliberate differences.
 * Synchronised mode exists but must never be the default: it destroys existing
 * lighting composition.
 */
function planBrightnessDelta(
  delta: number,
  deviceIds: string[],
  cache: TargetStateCache,
  behavior: ControllerBehavior,
  skipped: SkippedTarget[],
): IntentPlan {
  const writes: PlannedWrite[] = [];
  const turningOnViaDim = new Set<string>();

  const synchronisedValue = behavior.groupBrightnessMode === 'synchronised'
    ? computeSynchronisedTarget(delta, deviceIds, cache)
    : null;

  for (const deviceId of deviceIds) {
    const isOn = cache.currentOn(deviceId);
    const current = cache.currentDim(deviceId) ?? 0;

    // While-off policy.
    if (isOn === false) {
      if (delta > 0) {
        if (behavior.increaseWhileOff === 'ignore') {
          skipped.push({ deviceId, reason: 'off, and increase-while-off is set to ignore' });
          continue;
        }
        // Turn on AND apply. The dim write below carries the "on" for us,
        // so no separate onoff write is queued — see PlannedWrite.impliesOn.
        turningOnViaDim.add(deviceId);
      } else if (behavior.decreaseWhileOff === 'ignore') {
        skipped.push({ deviceId, reason: 'off, and decrease-while-off is set to ignore' });
        continue;
      } else {
        // Update desired level only — no write, so the light stays off. The
        // one place a desired value is adopted with no write behind it, and it
        // is deliberate: the next press should carry on from where this one
        // left the level, not from where the lamp last physically was.
        // commitDesired without a seq, because there is no write to lose a
        // race to.
        const next = advanceDim(
          deviceId, current, applyPerceptualDelta(current, delta), delta, cache,
        );
        cache.commitDesired(deviceId, 'dim', next);
        skipped.push({ deviceId, reason: 'off — desired level updated without turning on' });
        continue;
      }
    }

    const raw = synchronisedValue ?? applyPerceptualDelta(current, delta);
    const next = advanceDim(deviceId, current, raw, delta, cache);

    // Where the result would fall below the minimum, turn off rather
    // than clamping, when configured to do so.
    if (behavior.offBelowMinimum && delta < 0 && next <= behavior.minimumBrightness) {
      writes.push({ deviceId, capability: 'onoff', value: false });
      continue;
    }

    if (next <= 0 && delta < 0) {
      writes.push({ deviceId, capability: 'dim', value: Math.max(next, behavior.minimumBrightness) });
      continue;
    }

    writes.push({
      deviceId, capability: 'dim', value: next,
      ...(turningOnViaDim.has(deviceId) ? { impliesOn: true } : {}),
    });
  }

  return { writes, skipped };
}

/** One absolute level for every compatible target — advanced mode only. */
function computeSynchronisedTarget(
  delta: number,
  deviceIds: string[],
  cache: TargetStateCache,
): number {
  const levels = deviceIds
    .map(id => cache.currentDim(id))
    .filter((v): v is number => typeof v === 'number');
  const reference = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
  return applyPerceptualDelta(reference, delta);
}

/**
 * Temperature deltas are linear on the normalised axis — the perceptual curve
 * is a brightness phenomenon and applying it here would be wrong.
 * A temperature change must never implicitly turn a light on.
 */
function planTemperatureDelta(
  delta: number,
  deviceIds: string[],
  cache: TargetStateCache,
  skipped: SkippedTarget[],
): IntentPlan {
  const writes: PlannedWrite[] = [];
  for (const deviceId of deviceIds) {
    /**
     * An off lamp is skipped, and the docblock above is why.
     *
     * A `dim` write turns an off Hue lamp on — that is measured (platform §6)
     * — and whether `light_temperature` does the same is per-integration and
     * untested. So "a temperature change must never implicitly turn a light
     * on" was a promise the code did not keep on any integration where it
     * does: press "warmer" in a dark room and the lights come up.
     *
     * The circadian runtime's pre-staging writes colour to off lamps on
     * purpose, and is unaffected — it plans its own writes and carries its own
     * probe and its own opt-in for exactly this uncertainty (§12).
     */
    if (cache.currentOn(deviceId) === false) {
      skipped.push({ deviceId, reason: 'off — temperature never turns a light on' });
      continue;
    }
    const current = cache.currentTemperature(deviceId) ?? 0.5;
    const next = clampTemperature(deviceId, current + delta, cache);
    writes.push(...planTemperature(deviceId, next, cache));
  }
  return { writes, skipped };
}

function clampDim(deviceId: string, value: number, cache: TargetStateCache): number {
  const options = cache.capabilitiesOf(deviceId)?.dim;
  const min = options?.min ?? 0;
  const max = options?.max ?? 1;
  return quantise(clampToRange(value, min, max), options?.decimals);
}

/**
 * A relative brightness step that is guaranteed to MOVE, where the range allows.
 *
 * The perceptual curve is steepest at the bottom, and quantisation happens in
 * DEVICE values: at dim 0.00 a ramp's 0.06 perceptual tick is 0.06^2.2 ≈ 0.002 in
 * device terms, which `quantise(…, 2)` rounds straight back to 0.00. So every
 * tick of a ten-second hold recomputed from 0.00 and wrote 0.00 again, and the
 * lamp could not be lifted off the floor at all. Reachable through the app's own
 * defaults: `decreaseWhileOff: 'update_desired_only'` walks the desired level
 * down to 0.00 with no `minimumBrightness` floor, because there is no write to
 * put a floor under.
 *
 * So where rounding would eat the whole step, take one representable step in the
 * direction asked for instead. One step rather than an accumulated residue
 * because it needs no state between ticks — and because the honest reading of
 * "brighten this" is "brighten it by something a lamp can show", not "by an
 * amount that rounds to nothing".
 *
 * A step that is genuinely at the end of the range still does nothing, which is
 * correct: `clampToRange` has the last word.
 */
function advanceDim(
  deviceId: string,
  current: number,
  raw: number,
  delta: number,
  cache: TargetStateCache,
): number {
  const next = clampDim(deviceId, raw, cache);
  if (delta === 0 || next !== clampDim(deviceId, current, cache)) return next;

  const options = cache.capabilitiesOf(deviceId)?.dim;
  const decimals = options?.decimals;
  // No declared resolution means nothing was quantised away, so nothing to do.
  if (decimals === undefined || !Number.isFinite(decimals)) return next;

  const step = Math.pow(10, -Math.max(0, Math.floor(decimals)));
  return clampDim(deviceId, next + (delta > 0 ? step : -step), cache);
}

function clampTemperature(deviceId: string, value: number, cache: TargetStateCache): number {
  const options = cache.capabilitiesOf(deviceId)?.light_temperature;
  const min = options?.min ?? 0;
  const max = options?.max ?? 1;
  return quantise(clampToRange(value, min, max), options?.decimals);
}

/**
 * A colour: mode, then hue, then saturation.
 *
 * `light_mode` comes first and only where the lamp has one. A lamp sitting in
 * temperature mode ignores a hue it is given — it is not an error, the write
 * simply has no visible effect, which is the worst kind of failure this app can
 * produce. `WRITE_ORDER` in the scheduler puts mode ahead of hue for the same
 * reason it puts `onoff` ahead of `dim`: the value has to land on a lamp that is
 * in a state to show it.
 *
 * Hue and saturation always go together. Half a colour is a colour nobody chose:
 * a hue written onto yesterday's saturation is a shade the user never selected.
 *
 * No `hasMoved`-style gate here — that is the caller's business, and the curve
 * runtime has its own. Unlike a colour temperature, a hue has no meaningful
 * resolution to compare against: `homey-lib` gives `light_hue` no `decimals`, so
 * there is no step below which a write is provably a no-op.
 */
/**
 * A temperature write, preceded by the mode switch that makes it land.
 *
 * The mirror of `planColor`, and it exists because only one half of the pair
 * was ever written. A lamp sitting in COLOUR mode ignores a temperature exactly
 * as a lamp in temperature mode ignores a hue — silently, reporting the write
 * as accepted and keeping its old value. That asymmetry is invisible until one
 * device writes both to the same lamp, which is what a Curve light with a
 * coloured point does: the colour switches the lamp to colour mode, and every
 * later temperature-only point is then thrown away by the lamp.
 *
 * Only where the lamp HAS `light_mode`. A lamp without it has one mode, cannot
 * be in the wrong one, and would be sent a capability it does not have.
 *
 * `WRITE_ORDER` in the command scheduler puts `light_mode` ahead of both
 * `light_temperature` and `light_hue`, so this ordering survives the queue.
 */
function planTemperature(
  deviceId: string,
  value: number,
  cache: TargetStateCache,
): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  if (cache.supports(deviceId, 'light_mode')) {
    writes.push({ deviceId, capability: 'light_mode', value: 'temperature' });
  }
  writes.push({ deviceId, capability: 'light_temperature', value });
  return writes;
}

function planColor(
  hue: number,
  saturation: number,
  deviceIds: string[],
  cache: TargetStateCache,
): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  for (const deviceId of deviceIds) {
    if (cache.supports(deviceId, 'light_mode')) {
      writes.push({ deviceId, capability: 'light_mode', value: 'color' });
    }
    writes.push({ deviceId, capability: 'light_hue', value: clamp01(hue) });
    // A lamp with hue but no saturation is not a shape homey-lib produces, but
    // skipping the write costs nothing and asserting it would be a guess.
    if (cache.supports(deviceId, 'light_saturation')) {
      writes.push({ deviceId, capability: 'light_saturation', value: clamp01(saturation) });
    }
  }
  return writes;
}
