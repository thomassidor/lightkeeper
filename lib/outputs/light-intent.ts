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
  | { type: 'color_absolute'; hue: number; saturation: number };

/** Which capability an intent needs. Drives the partial-support disclosure. */
export function requiredCapability(intent: LightIntent): 'onoff' | 'dim' | 'light_temperature' | 'light_hue' {
  switch (intent.type) {
    case 'toggle':
    case 'power':
      return 'onoff';
    case 'brightness_delta':
    case 'brightness_absolute':
      return 'dim';
    case 'temperature_delta':
    case 'temperature_absolute':
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
 * The perceptual axis.
 *
 * All brightness arithmetic happens on p ∈ [0,1]; the device value is v = p^γ
 * with γ = 2.2. Deltas apply to p, then convert. Linear stepping feels violent
 * at the bottom of the range and inert at the top, which is why this is not
 * optional dressing.
 */
export const GAMMA = 2.2;

/** Device value → perceptual position. */
export function toPerceptual(value: number): number {
  return Math.pow(clamp01(value), 1 / GAMMA);
}

/** Perceptual position → device value. */
export function toDevice(perceptual: number): number {
  return Math.pow(clamp01(perceptual), GAMMA);
}

/**
 * Apply a perceptual delta to a device value, returning a new device value.
 * The delta is expressed as a fraction of the perceptual range, so ±0.1 is
 * "one tenth of the way up the perceived scale" regardless of current level.
 */
export function applyPerceptualDelta(currentDeviceValue: number, perceptualDelta: number): number {
  const next = clamp01(toPerceptual(currentDeviceValue) + perceptualDelta);
  return toDevice(next);
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
