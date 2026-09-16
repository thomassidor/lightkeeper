import {
  applyPerceptualDelta,
  clampToRange,
  quantise,
  requiredCapability,
  type LightIntent,
} from './light-intent';
import type { TargetStateCache } from './target-state-cache';
import { stepFromDecimals } from './target-state-cache';
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
  /**
   * This write exists ONLY because the plan opted into colouring a lamp that is
   * off — a pre-stage write (platform §12). Its one and only consumer is write
   * health in `LightTargetAdapter.noteWriteHealth()`.
   *
   * It is here because a pre-stage FAILURE is evidence of nothing. Measured on
   * 4 September 2026 across 13 Philips Hue bulbs on one bridge: 4 rejected a
   * colour write to an off lamp as `is "soft off", command
   * (.color_temperature.mirek) may not have effect`, 9 took it and stayed off,
   * and the two bulbs that were genuinely dead rejected every axis with a
   * different sentence we are right not to match on. From the rejection alone a
   * soft-off lamp and a dead one look identical, so counting it against the
   * lamp's health marked healthy lamps as not responding for as long as they
   * were switched off.
   *
   * No planner function sets it. The circadian runtime does, because it is the
   * only layer that knows the write was speculative — the planner is given a
   * list of device ids and cannot tell one that is off from one that is lit.
   */
  preStage?: boolean;
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
        writes.push({ deviceId, capability: 'dim', value: litDim(deviceId, intent.value, cache) });
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

    case 'preset_absolute':
      for (const deviceId of supported) {
        writes.push({
          deviceId, capability: 'dim', value: litDim(deviceId, intent.brightness, cache),
        });
        // The warmth is best-effort ON TOP of the brightness, because the
        // capability gate above was `dim`: a brightness-only lamp in the same
        // room gets the brightness rather than being skipped for a warmth it was
        // never going to take.
        if (intent.temperature !== undefined && cache.supports(deviceId, 'light_temperature')) {
          writes.push(
            ...planTemperature(
              deviceId, clampTemperature(deviceId, intent.temperature, cache), cache,
            ),
          );
        }
      }
      return { writes, skipped };

    case 'temperature_cycle':
      return planTemperatureCycle(supported, cache, skipped);
  }
}

/**
 * How many stops one press of a cycling button moves through.
 *
 * Five, because the axis has to be walkable in a handful of presses and still
 * offer a recognisably different white at each stop. Fewer and the ends are all
 * there is; more and somebody is pressing a button eight times to get back to
 * where they started.
 */
const CYCLE_STOPS = 5;

/**
 * The next stop along the warmth axis, per device, wrapping at the top.
 *
 * Per device rather than as one group value, for the same reason
 * `planTemperatureDelta` is: two lamps that are currently at different whites
 * both move one step, rather than both jumping to whatever the first one's next
 * stop happened to be.
 *
 * A lamp whose current temperature is unreadable starts at the first stop. That
 * is a real case — a lamp that has never reported — and starting somewhere beats
 * doing nothing, which on a button press is indistinguishable from a broken
 * remote.
 */
function planTemperatureCycle(
  deviceIds: string[],
  cache: TargetStateCache,
  skipped: SkippedTarget[],
): IntentPlan {
  const writes: PlannedWrite[] = [];
  const step = 1 / (CYCLE_STOPS - 1);

  for (const deviceId of deviceIds) {
    // An off lamp is skipped for the same reason `planTemperatureDelta` skips
    // one: whether a `light_temperature` write turns a lamp on is
    // per-integration and untested, and a cycling button must not light a dark
    // room (platform §6).
    if (cache.currentOn(deviceId) === false) {
      skipped.push({ deviceId, reason: 'off — temperature never turns a light on' });
      continue;
    }
    const current = cache.currentTemperature(deviceId);
    const index = current === undefined ? -1 : Math.round(current / step);
    const next = (((index + 1) % CYCLE_STOPS) + CYCLE_STOPS) % CYCLE_STOPS * step;
    writes.push(...planTemperature(deviceId, clampTemperature(deviceId, next, cache), cache));
  }

  return { writes, skipped };
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

    /**
     * In SYNCHRONISED mode the group's target is the answer, and `advanceDim`'s
     * nudge must not be applied to it.
     *
     * `advanceDim` guarantees that a lamp MOVES, which is right per lamp and
     * wrong for a group: a lamp already sitting on the group target reads as
     * "did not move" and gets nudged one representable step past everybody
     * else. Measured: A at 0.13 and B at 0.00, +0.1 → A 0.14, B 0.13. Every
     * later press repeats it, so the one lamp that started in the right place
     * is the one that drifts. The group's guarantee is that the GROUP moves,
     * and `synchronisedValue` is already that movement.
     */
    const raw = synchronisedValue ?? applyPerceptualDelta(current, delta);
    const next = synchronisedValue !== null
      ? clampDim(deviceId, raw, cache)
      : advanceDim(deviceId, current, raw, delta, cache);

    // Where the result would fall below the minimum, turn off rather
    // than clamping, when configured to do so.
    if (behavior.offBelowMinimum && delta < 0 && next <= behavior.minimumBrightness) {
      writes.push({ deviceId, capability: 'onoff', value: false });
      continue;
    }

    if (next <= 0 && delta < 0) {
      /**
       * Through `litDim`, because `minimumBrightness` is not a floor on every
       * lamp.
       *
       * Its default is 0.01 — which is the `decimals: 2` representable step
       * wearing a policy name (see `minimumDimValue` in `mapping-types.ts`).
       * On a lamp declaring `decimals: 1`, `dim` moves in tenths, so 0.01
       * quantises to 0.00: by the app's own model that is darkness, written in
       * the one branch whose entire purpose is to refuse to write darkness.
       * Reachable with real numbers — `decimals: 1`, dim 0.1, delta −0.1.
       *
       * `litDim` is the existing safety net for exactly this and needs no
       * second copy of the argument: it lifts a rounded-away positive to one
       * representable step, and leaves a genuine zero alone.
       */
      writes.push({
        deviceId,
        capability: 'dim',
        value: litDim(deviceId, Math.max(next, behavior.minimumBrightness), cache),
      });
      continue;
    }

    /**
     * A write that is expected to switch the lamp ON is never darkness.
     *
     * `advanceDim` guarantees a lamp MOVES, and the branch above catches the
     * `delta < 0` case — but SYNCHRONISED mode bypasses `advanceDim` entirely
     * (see the note on `raw`), and the `next <= 0` guard is `delta < 0` only. So
     * an off lamp being raised, in a group whose average is near the floor, on a
     * lamp declaring `decimals: 1`, planned `{ dim: 0, impliesOn: true }`: the
     * adapter then probes, finds the lamp still off, and switches it on at
     * nothing. Through `litDim` for the same reason the branch above is —
     * `minimumBrightness` is not a floor on every lamp.
     */
    const turningOn = turningOnViaDim.has(deviceId);
    writes.push({
      deviceId,
      capability: 'dim',
      value: turningOn ? litDim(deviceId, Math.max(next, behavior.minimumBrightness), cache) : next,
      ...(turningOn ? { impliesOn: true } : {}),
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
 * The smallest change this lamp can actually show, or `undefined` where it
 * declares no resolution and nothing is being quantised away.
 *
 * Shared by the two places that have to reason about what rounding eats:
 * `litDim` below and `advanceDim` further down.
 */
function representableStep(deviceId: string, cache: TargetStateCache): number | undefined {
  return stepFromDecimals(cache.capabilitiesOf(deviceId)?.dim?.decimals);
}

/**
 * An absolute level that asks for light and gets light.
 *
 * The perceptual curve is steepest at the bottom and quantisation happens in
 * DEVICE values, so a brightness a person chose deliberately can round away to
 * nothing: γ = 2.2 turns 5% into 0.05^2.2 ≈ 0.0014, and `dim` reports
 * `decimals: 2`, so it is written as 0.00. Anything below about 9% does the
 * same. That is the LOWEST position the brightness sliders offer — `min="5"` in
 * every one of them — so the dimmest setting a user can pick was the one that
 * meant off at the lamp, and on a circadian curve it held there for the eight
 * minutes either side of the point.
 *
 * So where rounding would eat the whole request, write one representable step
 * instead: the dimmest thing the lamp can show, which is what "as dim as
 * possible" asks for. Zero is still reachable and still means zero — it is only
 * a positive request that is kept positive.
 *
 * The same argument as `advanceDim`, one axis over: that one keeps a relative
 * step from rounding to a no-op, this one keeps an absolute level from rounding
 * to darkness. It lives here, in the absolute branch, rather than in `clampDim`
 * — the delta path deliberately allows low values, and `offBelowMinimum`
 * deliberately turns a lamp off below its minimum, and both go through
 * `clampDim` too.
 *
 * **Open question, answerable only on hardware:** what a lamp declaring
 * `decimals: 1` actually does with a `dim` of 0.01 — accept and round to zero,
 * accept and clamp to its own smallest step, or refuse. This writes one declared
 * step rather than anything smaller, which is safe under all three answers; the
 * question only matters if someone proposes writing below the declared
 * resolution on the grounds that a lamp might honour it.
 */
function litDim(deviceId: string, value: number, cache: TargetStateCache): number {
  const quantised = clampDim(deviceId, value, cache);
  if (value <= 0 || quantised > 0) return quantised;

  const step = representableStep(deviceId, cache);
  // No declared resolution means nothing was rounded away, so a zero here is a
  // zero the caller asked for.
  if (step === undefined) return quantised;

  return clampDim(deviceId, step, cache);
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

  // No declared resolution means nothing was quantised away, so nothing to do.
  const step = representableStep(deviceId, cache);
  if (step === undefined) return next;

  return clampDim(deviceId, next + (delta > 0 ? step : -step), cache);
}

function clampTemperature(deviceId: string, value: number, cache: TargetStateCache): number {
  const options = cache.capabilitiesOf(deviceId)?.light_temperature;
  const min = options?.min ?? 0;
  const max = options?.max ?? 1;
  return quantise(clampToRange(value, min, max), options?.decimals);
}

/**
 * A temperature write, preceded by the mode switch that makes it land.
 *
 * The mirror of `planColor`, and it exists because only one half of the pair
 * was ever written. A lamp sitting in COLOUR mode ignores a temperature exactly
 * as a lamp in temperature mode ignores a hue — silently, reporting the write
 * as accepted and keeping its old value. That asymmetry is invisible until one
 * device writes both to the same lamp, which is what a Colour Curve Light with a
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
