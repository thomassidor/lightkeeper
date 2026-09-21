import type { TargetSpec } from '../outputs/light-intent';
import { LEAVE_ALONE } from '../outputs/lightkeeper-settings';

/**
 * The lighting functions a user can assign an event to.
 *
 * The nine the buttons screen offers are a 3×3 grid: power, brightness and
 * colour across, and "up, down, set a value" down each column. That shape is
 * the reason `color_set` exists and the reason `temperature_cycle` is no longer
 * offered — see RETIRED_FUNCTIONS below, which is also why it is still HERE.
 */
export type LightFunction =
  | 'toggle' | 'on' | 'off'
  | 'brightness_up' | 'brightness_down'
  | 'warmer' | 'colder'
  | 'brightness_set' | 'color_set' | 'temperature_cycle'
  | 'lightkeeper_on';

/** Which capability a function needs — drives which rows appear. */
export const FUNCTION_CAPABILITY:
Record<LightFunction, 'onoff' | 'dim' | 'light_temperature' | 'light_hue'> = {
  toggle: 'onoff',
  on: 'onoff',
  off: 'onoff',
  brightness_up: 'dim',
  brightness_down: 'dim',
  warmer: 'light_temperature',
  colder: 'light_temperature',
  brightness_set: 'dim',
  color_set: 'light_hue',
  temperature_cycle: 'light_temperature',
  /**
   * `onoff`, although it writes a level and a colour too.
   *
   * This record answers "which lamps may be offered this job", and the honest
   * answer for a job whose name is "On" is every lamp that can be switched on.
   * A lamp with no `dim` still comes on; the planner skips the brightness half
   * for it, exactly as it does for `preset_absolute`. Asking for `dim` here
   * would take the job away from a plain switched lamp in the same room for the
   * sake of a value it was never going to take.
   */
  lightkeeper_on: 'onoff',
};

/**
 * Offered to nobody new, honoured for everybody who has one.
 *
 * `temperature_cycle` lost its place when the job list became a grid: the third
 * column is "set a value", and for the warmth row that value is a colour. A
 * retired function is NOT a deleted one — a button already assigned to it goes
 * on stepping through warm and cool, the engine still resolves it and a stored
 * profile carrying it still validates. It simply cannot be chosen again.
 *
 * Deleting it instead would have quarantined every profile that names it, which
 * is the same argument the palette makes about removing a colour.
 */
export const RETIRED_FUNCTIONS: readonly LightFunction[] = ['temperature_cycle'];

/**
 * The functions that carry a stored value, and WHICH value each one carries.
 *
 * `brightness_set` and `color_set` are the two a person actually asks for —
 * "this button makes it cosy" — and they are the functions that cannot be
 * expressed by their name alone: one needs the brightness (and optionally the
 * warmth) the button should produce, the other the colour. Everything else is
 * relative or a power state, which is why nothing here needed a value at first.
 *
 * It replaced a boolean. Two kinds of value cannot be told apart by "does it
 * need one", and the screen has to know which editor to open under the tile.
 *
 * `temperature_cycle` needs none. It steps through the warmth axis and wraps,
 * which is the gesture a one-button remote gets instead of a warmer and a cooler
 * button, and where it starts is wherever the lamp already is.
 */
export type PresetKind = 'none' | 'brightness' | 'colour' | 'lightkeeper';

export const FUNCTION_PRESET: Record<LightFunction, PresetKind> = {
  toggle: 'none',
  on: 'none',
  off: 'none',
  brightness_up: 'none',
  brightness_down: 'none',
  warmer: 'none',
  colder: 'none',
  brightness_set: 'brightness',
  color_set: 'colour',
  temperature_cycle: 'none',
  lightkeeper_on: 'lightkeeper',
};

export interface BrightnessPreset {
  /** Perceptual brightness 0–1, on the same axis every other slider in the app uses. */
  brightness: number;
  /** Normalised colour temperature 0–1, where 1 is warmest. Absent = leave it alone. */
  temperature?: number;
}

export interface ColorPreset {
  /**
   * A palette id, never a hue and a saturation.
   *
   * The same closed palette the Colour Curve Light chooses from, and for the
   * same reasons written down at the top of `lib/circadian/palette.ts`: a name
   * survives being read back a year later, a coordinate does not, and a name is
   * translatable. `paletteColor()` turns it into the two axes at the moment the
   * intent is built.
   */
  color: string;
}

/**
 * The value a function needs, where its name is not enough — whichever kind of
 * value that is. Never both, and never a choice.
 *
 * Named `preset` rather than `args`, and that is worth a line: `fixedArgs` one
 * layer over means a generated Flow card's ARGUMENTS, which is a different thing
 * entirely, and a `MappingRule.args` sitting beside a `Binding.fixedArgs` would
 * be genuinely confusing to read.
 *
 * A union rather than one record with optional halves, because "a preset" is
 * not a thing in its own right: it is the rest of the sentence a job started,
 * and a `brightness` on a colour job is a number nothing will ever read. Every
 * reader discriminates, which is the point.
 */
/**
 * Two other Lightkeeper devices, named — not a colour and not a brightness.
 *
 * The value behind "On – with Lightkeeper": which device this button takes its
 * colour and warmth from, which one it takes its level from, and whether a
 * second press turns the lights off again. What the lamps actually receive is
 * whatever those two devices want at the moment of the press, which is why the
 * stored value is two ids rather than the numbers they were showing when the
 * button was configured.
 *
 * **Both ids are always stored**, `LEAVE_ALONE` for "do not set this at all",
 * and that is what makes `isLightkeeperPreset` below able to recognise a preset
 * with neither source chosen. An optional field would have left `{}` — which is
 * a `BrightnessPreset` missing its brightness, a `ColorPreset` missing its
 * colour and this, all at once, and the union exists precisely so that shape is
 * unsayable.
 *
 * `validateMappingPreset` refuses a preset where both are `LEAVE_ALONE`: that is
 * plain "On" under a name that promises more, which is the "looks configured,
 * does nothing" failure this app exists to prevent.
 */
export interface LightkeeperPreset {
  /** A Lightkeeper device id, or `LEAVE_ALONE`. Only curve-driven devices qualify. */
  colourSource: string;
  /** A Lightkeeper device id, or `LEAVE_ALONE`. A curve, a schedule or a Room-sensing Light. */
  brightnessSource: string;
  /**
   * Whether a second press switches the lights off.
   *
   * The same group rule `planGroupToggle` uses — if any target is on, they all
   * go off — so the app has one answer to "what does pressing again do" rather
   * than two that differ by which tile was chosen.
   */
  pressAgainOff: boolean;
}

export type MappingPreset = BrightnessPreset | ColorPreset | LightkeeperPreset;

/** Narrowing for the union above, in one place so the test can name it. */
export function isBrightnessPreset(preset: MappingPreset): preset is BrightnessPreset {
  return 'brightness' in preset;
}

export function isColorPreset(preset: MappingPreset): preset is ColorPreset {
  return 'color' in preset;
}

export function isLightkeeperPreset(preset: MappingPreset): preset is LightkeeperPreset {
  return 'colourSource' in preset;
}

/** Whether a stored preset names any source at all, as against naming none. */
export function namesASource(preset: LightkeeperPreset): boolean {
  return preset.colourSource !== LEAVE_ALONE || preset.brightnessSource !== LEAVE_ALONE;
}

export interface MappingRule {
  id: string;
  function: LightFunction;
  /** null = not assigned. */
  inputKey: string | null;
  /** null = inherit the controller's targets. Set per rule on the mapping screen. */
  target: TargetSpec | null;
  /**
   * Required by whatever `FUNCTION_PRESET` says this function takes, refused
   * where it says `none`, and of the KIND it names.
   *
   * All three are enforced — in `validateMappingRules` on the way in and in
   * `validateControllerProfile` on the way back out — because a rule that says
   * "a set brightness" and carries no brightness is the "looks configured, does
   * nothing" failure this app exists to prevent, a preset on a `toggle` is a
   * value nothing will ever read, and a colour on a brightness job is both.
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
