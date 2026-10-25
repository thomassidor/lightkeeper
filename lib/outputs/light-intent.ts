/** What the mapping engine produces and the scheduler executes. */

export type TargetSpec =
  | { kind: 'devices'; deviceIds: string[] }
  | { kind: 'zone'; zoneId: string; includeSubzones: boolean };

export type LightIntent =
  | { type: 'toggle' }
  | { type: 'power'; value: boolean }
  | { type: 'brightness_delta'; delta: number }
  | { type: 'brightness_absolute'; value: number }
  | { type: 'temperature_delta'; delta: number }
  | { type: 'temperature_absolute'; value: number }
  /**
   * A colour, from the curve controller's palette.
   *
   * Hue and saturation together, never separately: half a colour is a colour
   * nobody chose. `light_mode` is written alongside them because a lamp sitting
   * in temperature mode ignores a hue it is given — see planColor().
   */
  | { type: 'color_absolute'; hue: number; saturation: number }
  /**
   * A brightness, and optionally a warmth, in one gesture.
   *
   * The intent behind a button whose job is "make it cosy". Compound rather than
   * two intents, because the mapping engine resolves one gesture to one intent
   * and the two writes have to reach the queue together — a brightness that
   * landed and a warmth that did not is a room nobody asked for.
   *
   * `brightness` is the stored level as the mapping engine resolves it, which
   * is Homey's `dim` like every other stored brightness (`MINIMUM_BRIGHTNESS`),
   * so the planner reads it as a device value with no conversion.
   */
  | { type: 'preset_absolute'; brightness: number; temperature?: number }
  /**
   * One step along the warmth axis, wrapping at the top.
   *
   * The gesture a one-button remote gets instead of a warmer and a cooler
   * button. It is not a `temperature_delta`: a delta clamps at the ends, so a
   * button that only ever warms would stop working the first time it reached
   * the top and never come back. Planned per device against what each lamp is
   * currently showing, which is why it is an intent rather than a delta the
   * mapping engine could have produced.
   */
  | { type: 'temperature_cycle' };

/** Which capability an intent needs. Drives the partial-support disclosure. */
export function requiredCapability(intent: LightIntent): 'onoff' | 'dim' | 'light_temperature' | 'light_hue' {
  switch (intent.type) {
    case 'toggle':
    case 'power':
      return 'onoff';
    case 'brightness_delta':
    case 'brightness_absolute':
    // Dim, not light_temperature: the brightness is the half that is always
    // present, and a lamp that can dim but not change colour should still get
    // the brightness a preset asks for rather than being skipped entirely.
    case 'preset_absolute':
      return 'dim';
    case 'temperature_delta':
    case 'temperature_absolute':
    case 'temperature_cycle':
      return 'light_temperature';
    /**
     * Hue, not saturation and not `light_mode`.
     *
     * The planner uses this ONE capability to decide whether a target can take
     * the intent at all, and hue is the honest test: `homey-lib` pairs hue and
     * saturation on every colour-capable light, while `light_mode` exists only
     * on lamps that ALSO have a temperature mode to switch out of. Testing for
     * `light_mode` would skip a colour-only lamp that can do exactly what was
     * asked.
     */
    case 'color_absolute':
      return 'light_hue';
  }
}

/**
 * The perceptual axis, for MOVEMENT only — never for a number anybody reads.
 *
 * A remote's step, a hold ramp and a Room-sensing Light's fade move along
 * p ∈ [0,1] with the device value v = p^γ, γ = 2.2: equal steps in `dim` feel
 * violent at the bottom of the range and inert at the top, and none of these
 * shows a number to disagree with anything. That is the whole of this axis's
 * remit now — every stored or shown brightness is Homey's `dim`
 * (`MINIMUM_BRIGHTNESS`).
 */
const GAMMA = 2.2;

/** A `dim` on the perceptual axis. See `GAMMA`. */
export function perceivedFromDim(value: number): number {
  return Math.pow(clamp01(value), 1 / GAMMA);
}

/** A point on the perceptual axis as a `dim`. See `GAMMA`. */
export function dimFromPerceived(perceptual: number): number {
  return Math.pow(clamp01(perceptual), GAMMA);
}

/**
 * The dimmest brightness a stored plan may hold: one hundredth, Homey's own
 * 1%.
 *
 * **Every stored brightness is Homey's `dim`** — a curve point, a schedule
 * block, a response end, a remote's preset, the published *Brightness now*.
 * 50% here is 50% in Homey's own slider, which is the only number a person can
 * check it against. Until 1.0.0 an app-wide setting offered a second, perceptual
 * meaning (`v = p^2.2`, so 50% read 22% in Homey) and made it the default; it
 * was dropped as a scale of our own invention, and `legacyNaturalToDim()` is
 * what carries a plan stored on it forward.
 *
 * 0.01 because `dim` reports `decimals: 2` on the lamps measured, so anything
 * below rounds to 0.00 — off, on most lamps. `litDim` in the intent planner is
 * the safety net under this for a lamp with a coarser resolution.
 */
export const MINIMUM_BRIGHTNESS = 0.01;

/**
 * A brightness stored on the retired natural scale, as Homey's `dim`.
 *
 * Used by the one migration step per store that carries 1.0.0's plans forward,
 * and nowhere else. Rounded to a thousandth — finer than any lamp resolves —
 * and floored at `MINIMUM_BRIGHTNESS`, so a dim night setting stays lit rather
 * than rounding to nothing. A plan saved while the setting said *Same as Homey*
 * already holds dim values and is not passed through this.
 */
export function legacyNaturalToDim(perceptual: number): number {
  return Math.max(MINIMUM_BRIGHTNESS, Math.round(dimFromPerceived(perceptual) * 1000) / 1000);
}

/**
 * One stored brightness carried forward: converted from the natural scale,
 * left alone when it was saved under *Same as Homey* (already a `dim`), and
 * left alone when it is not a number at all — the validator behind every
 * migration chain is what decides what a malformed value means, not this.
 */
export function carryBrightness(value: unknown, legacy: 'natural' | 'linear'): unknown {
  if (legacy === 'linear' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return value;
  return legacyNaturalToDim(value);
}

/**
 * Apply a perceptual delta to a device value, returning a new device value.
 * The delta is expressed as a fraction of the perceptual range, so ±0.1 is
 * "one tenth of the way up the perceived scale" regardless of current level.
 *
 * Always γ = 2.2 — see `GAMMA`.
 */
export function applyPerceptualDelta(currentDeviceValue: number, perceptualDelta: number): number {
  return dimFromPerceived(clamp01(perceivedFromDim(currentDeviceValue) + perceptualDelta));
}

/** Confine a normalised 0–1 value, treating NaN and Infinity as 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Clamp into a capability's own range. min/max/step must
 * not be assumed identical across targets, so every write goes through this
 * with that target's own options.
 */
export function clampToRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Round to a capability's decimals. Observed on real hardware: `dim` reports
 * decimals: 2, so writes finer than 0.01 are no-ops — callers accumulate
 * instead of writing, or a slow dial would never move the light at all.
 */
export function quantise(value: number, decimals: number | undefined): number {
  if (decimals === undefined || !Number.isFinite(decimals)) return value;
  const factor = Math.pow(10, Math.max(0, Math.floor(decimals)));
  return Math.round(value * factor) / factor;
}
