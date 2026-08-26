import {
  applyPerceptualDelta,
  clampToRange,
  quantise,
  requiredCapability,
  type LightIntent,
} from './light-intent';
import type { TargetStateCache } from './target-state-cache';
import type { ControllerBehavior } from '../mapping/mapping-types';

/**
 * Pure planning: group toggle, group brightness and while-off policy.
 *
 * Deliberately separated from anything that touches Homey. Group semantics are
 * the most subtle rules in the app, and keeping them free of I/O is what makes
 * them unit-testable. The adapter executes the plan this produces.
 */

export type Capability = 'onoff' | 'dim' | 'light_temperature';

export interface PlannedWrite {
  deviceId: string;
  capability: Capability;
  value: boolean | number;
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

    case 'temperature_delta':
      return planTemperatureDelta(intent.delta, supported, cache, skipped);

    case 'temperature_absolute':
      for (const deviceId of supported) {
        writes.push({
          deviceId,
          capability: 'light_temperature',
          value: clampTemperature(deviceId, intent.value, cache),
        });
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
        const next = clampDim(deviceId, applyPerceptualDelta(current, delta), cache);
        cache.commitDesired(deviceId, 'dim', next);
        skipped.push({ deviceId, reason: 'off — desired level updated without turning on' });
        continue;
      }
    }

    const raw = synchronisedValue ?? applyPerceptualDelta(current, delta);
    const next = clampDim(deviceId, raw, cache);

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
     * A `dim` write turns an off Hue lamp on — that is measured (CLAUDE.md §6)
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
    writes.push({ deviceId, capability: 'light_temperature', value: next });
  }
  return { writes, skipped };
}

function clampDim(deviceId: string, value: number, cache: TargetStateCache): number {
  const options = cache.capabilitiesOf(deviceId)?.dim;
  const min = options?.min ?? 0;
  const max = options?.max ?? 1;
  return quantise(clampToRange(value, min, max), options?.decimals);
}

function clampTemperature(deviceId: string, value: number, cache: TargetStateCache): number {
  const options = cache.capabilitiesOf(deviceId)?.light_temperature;
  const min = options?.min ?? 0;
  const max = options?.max ?? 1;
  return quantise(clampToRange(value, min, max), options?.decimals);
}
