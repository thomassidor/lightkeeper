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
 * Pure planning for §7.3, §7.4 and §7.8. Not a module named in §10 — the spec
 * puts this inside light-target-adapter — but group semantics are the most
 * subtle rules in the app and §11.1 demands they be unit tested, so they are
 * separated from anything that touches Homey. The adapter executes the plan.
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

  // §7.9 / AC-09: partial support behaves like partial failure — execute on the
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
 * §7.3 — toggle is a GROUP action, not independent inversion. If any
 * controllable target is on, turn all off; otherwise turn all on. This keeps a
 * room predictable once individual lights have drifted out of sync.
 */
function planGroupToggle(deviceIds: string[], cache: TargetStateCache): PlannedWrite[] {
  const anyOn = deviceIds.some(id => cache.currentOn(id) === true);
  const target = !anyOn;
  return deviceIds.map(deviceId => ({ deviceId, capability: 'onoff' as const, value: target }));
}

/**
 * §7.4 — relative by default. The same normalised delta applies to every
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

    // §7.8 while-off policy.
    if (isOn === false) {
      if (delta > 0) {
        if (behavior.increaseWhileOff === 'ignore') {
          skipped.push({ deviceId, reason: 'off, and increase-while-off is set to ignore' });
          continue;
        }
        // §7.8 turn on AND apply. The dim write below carries the "on" for us,
        // so no separate onoff write is queued — see PlannedWrite.impliesOn.
        turningOnViaDim.add(deviceId);
      } else if (behavior.decreaseWhileOff === 'ignore') {
        skipped.push({ deviceId, reason: 'off, and decrease-while-off is set to ignore' });
        continue;
      } else {
        // Update desired level only — no write, so the light stays off.
        const next = clampDim(deviceId, applyPerceptualDelta(current, delta), cache);
        cache.noteWrite(deviceId, 'dim', next);
        skipped.push({ deviceId, reason: 'off — desired level updated without turning on' });
        continue;
      }
    }

    const raw = synchronisedValue ?? applyPerceptualDelta(current, delta);
    const next = clampDim(deviceId, raw, cache);

    // §7.8 — where the result would fall below the minimum, turn off rather
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
 * is a brightness phenomenon (§7.2) and applying it here would be wrong.
 * §7.8: a temperature change must never implicitly turn a light on.
 */
function planTemperatureDelta(
  delta: number,
  deviceIds: string[],
  cache: TargetStateCache,
  skipped: SkippedTarget[],
): IntentPlan {
  const writes: PlannedWrite[] = [];
  for (const deviceId of deviceIds) {
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
