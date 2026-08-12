import type { TargetSpec } from '../outputs/light-intent';

/** The lighting functions a user can assign an event to. */
export type LightFunction =
  | 'toggle' | 'on' | 'off'
  | 'brightness_up' | 'brightness_down'
  | 'warmer' | 'colder';

export const ALL_FUNCTIONS: readonly LightFunction[] = [
  'toggle', 'on', 'off', 'brightness_up', 'brightness_down', 'warmer', 'colder',
] as const;

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

export const FUNCTION_CATEGORY: Record<LightFunction, 'power' | 'brightness' | 'temperature'> = {
  toggle: 'power',
  on: 'power',
  off: 'power',
  brightness_up: 'brightness',
  brightness_down: 'brightness',
  warmer: 'temperature',
  colder: 'temperature',
};

export interface MappingRule {
  id: string;
  function: LightFunction;
  /** null = not assigned. */
  inputKey: string | null;
  /** null = inherit the controller's targets. Set per rule on the mapping screen. */
  target: TargetSpec | null;
  options?: MappingOptions;
}

/** Per-row tuning. Everything optional; defaults live in ControllerBehavior. */
export interface MappingOptions {
  /** Perceptual step per activation, 0–1. */
  step?: number;
  /** Multiply magnitude before applying. */
  sensitivity?: number;
  useMagnitude?: boolean;
  acceleration?: boolean;
  minimum?: number;
  maximum?: number;
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
  minimumBrightness: number;
  /** Only applied where a control carries both discrete and hold. */
  supersedeMs: number;
  /**
   * The floor between two writes to the same target. This is the only
   * burst control: the scheduler flushes on the leading edge, so an isolated
   * press goes out immediately and only a genuine burst is held and coalesced.
   * An earlier `burstWindowMs` delay was removed because it added its full
   * duration to every single press to coalesce a burst that was not happening.
   */
  minWriteIntervalMs: number;
  /** Off by default on lossy transports. */
  acceleration: boolean;
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
  acceleration: false,
};
