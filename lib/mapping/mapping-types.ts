import type { TargetSpec } from '../outputs/light-intent';

/** The lighting functions a user can assign an event to. */
export type LightFunction =
  | 'toggle' | 'on' | 'off'
  | 'brightness_up' | 'brightness_down'
  | 'warmer' | 'colder'
  | 'brightness_set' | 'temperature_cycle';

/** Which capability a function needs — drives which rows appear. */
export const FUNCTION_CAPABILITY: Record<LightFunction, 'onoff' | 'dim' | 'light_temperature'> = {
  toggle: 'onoff',
  on: 'onoff',
  off: 'onoff',
  brightness_up: 'dim',
  brightness_down: 'dim',
  warmer: 'light_temperature',
  colder: 'light_temperature',
  brightness_set: 'dim',
  temperature_cycle: 'light_temperature',
};

/**
 * The functions that carry a stored value, and what that value is.
 *
 * `brightness_set` is the one a person actually asks for — "this button makes it
 * cosy" — and it is the first function in this app that cannot be expressed by
 * its name alone: it needs the brightness, and optionally the warmth, that the
 * button should produce. Everything else is relative or a power state, which is
 * why nothing here needed a value before.
 *
 * `temperature_cycle` needs none. It steps through the warmth axis and wraps,
 * which is the gesture a one-button remote gets instead of a warmer and a cooler
 * button, and where it starts is wherever the lamp already is.
 */
export const FUNCTION_NEEDS_PRESET: Record<LightFunction, boolean> = {
  toggle: false,
  on: false,
  off: false,
  brightness_up: false,
  brightness_down: false,
  warmer: false,
  colder: false,
  brightness_set: true,
  temperature_cycle: false,
};

/**
 * The value a function needs, where its name is not enough.
 *
 * Named `preset` rather than `args`, and that is worth a line: `fixedArgs` one
 * layer over means a generated Flow card's ARGUMENTS, which is a different thing
 * entirely, and a `MappingRule.args` sitting beside a `Binding.fixedArgs` would
 * be genuinely confusing to read.
 */
export interface MappingPreset {
  /** Perceptual brightness 0–1, on the same axis every other slider in the app uses. */
  brightness: number;
  /** Normalised colour temperature 0–1, where 1 is warmest. Absent = leave it alone. */
  temperature?: number;
}

export interface MappingRule {
  id: string;
  function: LightFunction;
  /** null = not assigned. */
  inputKey: string | null;
  /** null = inherit the controller's targets. Set per rule on the mapping screen. */
  target: TargetSpec | null;
  /**
   * Required when `function` is `brightness_set`, refused otherwise.
   *
   * Both halves are enforced — in `validateMappingRules` on the way in and in
   * `validateControllerProfile` on the way back out — because a rule that says
   * "a set brightness" and carries no brightness is the "looks configured, does
   * nothing" failure this app exists to prevent, and a preset on a `toggle` is a
   * value nothing will ever read.
   */
  preset?: MappingPreset;
}

/** Locked defaults. */
export interface ControllerBehavior {
  /** Perceptual step for one brightness activation. */
  brightnessStep: number;
  /** Normalised step for one temperature activation. */
  temperatureStep: number;
  /** Relative preserves inter-light differences and is the default. */
  groupBrightnessMode: 'relative' | 'synchronised';
  /** What an increase does to a light that is currently off. */
  increaseWhileOff: 'turn_on_and_apply' | 'ignore';
  decreaseWhileOff: 'update_desired_only' | 'ignore';
  /** Below minimum, turn off rather than clamp. */
  offBelowMinimum: boolean;
  /**
   * The floor on a dim-DOWN, as a **device value** — not a perceptual one.
   *
   * Two constants in this app are called something like "minimum brightness"
   * and they are in different units, which is worth stating because the names
   * do not:
   *
   *   `minimumBrightness` (here, 0.01)     a DEVICE value. Compared against
   *                                        `next`, which the planner has
   *                                        already put through gamma and
   *                                        quantised, so the comparison is
   *                                        in consistent units.
   *   `MINIMUM_BRIGHTNESS` (0.10, in       a PERCEPTUAL floor. Where the three
   *   `outputs/light-intent.ts`)           brightness sliders start and what
   *                                        the migration chains lift stored
   *                                        plans to.
   *
   * And 0.01 is not really a policy number: it is the `decimals: 2`
   * representable step, which is what most lamps declare, and it happens to
   * equal `toDevice(0.10)` quantised. It is not user-editable and never has
   * been. On a lamp declaring `decimals: 1` it is not representable AT ALL, so
   * the planner routes it through `litDim()` rather than trusting it as a
   * floor — see the dim-down branch in `intent-planner.ts`.
   *
   * The name stays because the field is PERSISTED in every controller profile,
   * and a migration step to rename a constant nobody can change is more risk
   * than the clarity is worth. This comment is the fix.
   */
  minimumBrightness: number;
  /** Only applied where a control carries both discrete and hold. */
  supersedeMs: number;
  /**
   * The floor between two writes to the same target. This is the only
   * burst control: the scheduler flushes on the leading edge, so an isolated
   * press goes out immediately and only a genuine burst is held and coalesced.
   */
  minWriteIntervalMs: number;
}

export const DEFAULT_BEHAVIOR: ControllerBehavior = {
  brightnessStep: 0.1,
  temperatureStep: 0.1,
  groupBrightnessMode: 'relative',
  increaseWhileOff: 'turn_on_and_apply',
  decreaseWhileOff: 'update_desired_only',
  offBelowMinimum: false,
  minimumBrightness: 0.01,
  supersedeMs: 250,
  minWriteIntervalMs: 200,
};
