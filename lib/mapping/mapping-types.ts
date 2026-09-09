import type { TargetSpec } from '../outputs/light-intent';

/** The lighting functions a user can assign an event to. */
export type LightFunction =
  | 'toggle' | 'on' | 'off'
  | 'brightness_up' | 'brightness_down'
  | 'warmer' | 'colder';

/** Which capability a function needs — drives which rows appear. */
export const FUNCTION_CAPABILITY: Record<LightFunction, 'onoff' | 'dim' | 'light_temperature'> = {
  toggle: 'onoff',
  on: 'onoff',
  off: 'onoff',
  brightness_up: 'dim',
  brightness_down: 'dim',
  warmer: 'light_temperature',
  colder: 'light_temperature',
};

export interface MappingRule {
  id: string;
  function: LightFunction;
  /** null = not assigned. */
  inputKey: string | null;
  /** null = inherit the controller's targets. Set per rule on the mapping screen. */
  target: TargetSpec | null;
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
