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
   * `brightness` is the STORED level as the mapping engine resolves it — the
   * slider's number, not yet a `dim`. `ControllerRuntime.runIntents` puts it
   * through the app's `BrightnessScale` on the way to the planner, which then
   * reads it as a device value like every other absolute brightness. It used to
   * reach the planner raw, so a remote's 60% wrote 0.60 while a schedule's 60%
   * wrote 0.32.
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
 * The perceptual axis.
 *
 * All brightness arithmetic happens on p ∈ [0,1]; the device value is v = p^γ
 * with γ = 2.2. Deltas apply to p, then convert. Linear stepping feels violent
 * at the bottom of the range and inert at the top, which is why this is not
 * optional dressing.
 */
const GAMMA = 2.2;

/**
 * How a STORED brightness — a curve point, a schedule block, a response end, a
 * remote's preset — becomes the `dim` a lamp is sent. App-wide, chosen on the
 * settings page.
 *
 * `natural` is the perceptual axis above: 50% looks half as bright, and reads
 * 22% in Homey's own slider. `linear` sends the number as it was set, so 50%
 * here is 50% in Homey — asked for by a user who reads both side by side, which
 * the natural scale makes look like a bug. A stored percentage keeps its number
 * across a switch and changes its meaning; nothing is converted, because the
 * number IS what the person who asked for linear wants written.
 *
 * Deliberately NOT applied to relative steps: `applyPerceptualDelta` stays on
 * γ = 2.2 under both scales. A remote's step and a hold ramp show no number to
 * disagree with Homey's, and even feel at the bottom of the range is their
 * whole point.
 */
export type BrightnessScale = 'natural' | 'linear';

export const DEFAULT_BRIGHTNESS_SCALE: BrightnessScale = 'natural';

/** A stored or received scale, where anything unrecognised means the default. */
export function sanitizeBrightnessScale(value: unknown): BrightnessScale {
  return value === 'linear' ? 'linear' : DEFAULT_BRIGHTNESS_SCALE;
}

function gammaOf(scale: BrightnessScale): number {
  return scale === 'linear' ? 1 : GAMMA;
}

/**
 * The dimmest brightness a stored plan may hold, and the floor the brightness
 * sliders start at.
 *
 * A consequence of the gamma above, which is why it lives beside it. Quantisation
 * happens in DEVICE values, and `dim` reports `decimals: 2`, so a perceptual
 * brightness below 0.005^(1/2.2) ≈ 0.0900 rounds to `dim` 0.00 — off, on most
 * lamps. The sliders used to start at 5%, so the dimmest setting they offered was
 * inside that band.
 *
 * 0.10 rather than 0.09 because the sliders step in fives, and a floor a slider
 * cannot land on is a floor that has to be explained. `litDim` in the intent
 * planner is the safety net under this for any plan that predates it.
 *
 * The same 0.10 under the linear `BrightnessScale`, where it is a 10% device
 * floor rather than about 0.6%. Not made scale-dependent: the floor is applied
 * by the plan sanitisers, which are pure and know nothing of an app setting,
 * and a stored plan must not mean a different floor depending on when it was
 * loaded. The FAQ says so.
 */
export const MINIMUM_BRIGHTNESS = 0.1;


/**
 * Device value → the brightness as a person set it: perceptual under the
 * natural scale, the same number under linear. The scale is required rather
 * than defaulted so that no call site can quietly keep writing γ = 2.2.
 */
export function toPerceptual(value: number, scale: BrightnessScale): number {
  return Math.pow(clamp01(value), 1 / gammaOf(scale));
}

/** The brightness as a person set it → device value. See `toPerceptual`. */
export function toDevice(perceptual: number, scale: BrightnessScale): number {
  return Math.pow(clamp01(perceptual), gammaOf(scale));
}

/**
 * Apply a perceptual delta to a device value, returning a new device value.
 * The delta is expressed as a fraction of the perceptual range, so ±0.1 is
 * "one tenth of the way up the perceived scale" regardless of current level.
 *
 * Always γ = 2.2, whatever `BrightnessScale` says — see its docblock.
 */
export function applyPerceptualDelta(currentDeviceValue: number, perceptualDelta: number): number {
  const next = clamp01(toPerceptual(currentDeviceValue, 'natural') + perceptualDelta);
  return toDevice(next, 'natural');
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
