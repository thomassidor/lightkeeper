import type { InputEvent } from '../inputs/input-event';
import type { LightIntent, TargetSpec } from '../outputs/light-intent';
import {
  FUNCTION_CAPABILITY, RETIRED_FUNCTIONS,
  isBrightnessPreset, isColorPreset,
  type ControllerBehavior, type LightFunction, type MappingPreset, type MappingRule,
} from './mapping-types';
import { paletteColor } from '../circadian/palette';

/**
 * Resolves normalised events into configured light intents.
 * Pure: no Homey, no I/O, no timers.
 */

export interface ResolvedIntent {
  intent: LightIntent;
  rule: MappingRule;
  /** null means inherit the controller's targets. */
  target: TargetSpec | null;
}

export interface MappingEngineInput {
  /** The binding key the event arrived on. */
  inputKey: string;
  event: InputEvent;
}

/**
 * A light function plus a magnitude becomes a light intent. THE one translator.
 *
 * There were two, and they had to agree: this one, reached when a real gesture
 * arrives, and `intentForFunction` in the controller runtime, reached by the Test
 * control on the mapping screen. The Test control exists precisely so a user can
 * confirm before saving that a row does what they expect, so a Test that
 * translates differently from the live path is worse than no Test at all.
 *
 * The direction of `warmer` is the one line in this app most worth reading twice:
 * warmer means a HIGHER value on Homey's normalised axis — 0 is the coolest end,
 * 1 the warmest. homey-lib's own capability hint says so ("A higher value means a
 * warmer color"), and getting it backwards is what made a schedule set to
 * "Warmest" write 0 and light a room cold white on its first live run
 * (platform §6).
 */
export function intentForLightFunction(
  func: LightFunction,
  behavior: ControllerBehavior,
  magnitude: number = 1,
  preset?: MappingPreset,
): LightIntent {
  const scale = Number.isFinite(magnitude) && Math.abs(magnitude) > 0 ? Math.abs(magnitude) : 1;
  const brightness = behavior.brightnessStep * scale;
  const temperature = behavior.temperatureStep * scale;

  switch (func) {
    case 'toggle': return { type: 'toggle' };
    case 'on': return { type: 'power', value: true };
    case 'off': return { type: 'power', value: false };
    case 'brightness_up': return { type: 'brightness_delta', delta: brightness };
    case 'brightness_down': return { type: 'brightness_delta', delta: -brightness };
    case 'warmer': return { type: 'temperature_delta', delta: temperature };
    case 'colder': return { type: 'temperature_delta', delta: -temperature };
    case 'temperature_cycle': return { type: 'temperature_cycle' };
    /**
     * The one function whose name is not enough, so the one that can arrive
     * without what it needs.
     *
     * A rule with no preset should be impossible — `validateMappingRules`
     * refuses one on the way in and `validateControllerProfile` refuses one on
     * the way back out — but this is the live gesture path and failing closed
     * beats writing a brightness nobody chose. Turning the lights on is the
     * honest degradation: the button was meant to produce light, and it does,
     * at whatever the lamps were last set to.
     */
    case 'brightness_set':
      return preset !== undefined && isBrightnessPreset(preset)
        ? {
          type: 'preset_absolute',
          brightness: preset.brightness,
          ...(preset.temperature !== undefined ? { temperature: preset.temperature } : {}),
        }
        : { type: 'power', value: true };

    /**
     * The same closed-palette colour a Colour Curve Light writes, on a press.
     *
     * It degrades the same way `brightness_set` does, and for one more reason
     * besides a missing preset: a palette id that no longer resolves. Removing a
     * colour from the palette is documented as unsafe for exactly this class of
     * reader, but a hand-edited profile can still name one — and turning the
     * lights on is the honest answer to "this button was meant to produce
     * light", where writing a hue nobody chose is not.
     */
    case 'color_set': {
      const colour = preset !== undefined && isColorPreset(preset)
        ? paletteColor(preset.color)
        : undefined;
      return colour === undefined
        ? { type: 'power', value: true }
        : { type: 'color_absolute', hue: colour.hue, saturation: colour.saturation };
    }
  }
  // No default arm: the switch covers every LightFunction, and an added member
  // must fail to compile here rather than silently resolve to undefined.
}

export class MappingEngine {
  /**
   * Both readonly: a mapping engine is REPLACED, never mutated.
   *
   * There was an `update()` here with no caller anywhere, tests included —
   * `ControllerRuntime.buildRuntime()` constructs a fresh engine on every start
   * and every profile change, which is what makes the whole runtime's state
   * consistent with one plan. A mutator invited the other pattern.
   */
  constructor(
    private readonly rules: MappingRule[],
    private readonly behavior: ControllerBehavior,
  ) {}

  /** Unmapped input resolves to null — never a guess. Fail closed. */
  resolve({ inputKey, event }: MappingEngineInput): ResolvedIntent | null {
    const rule = this.rules.find(r => r.inputKey === inputKey);
    if (!rule) return null;

    return { intent: this.intentFor(rule, event), rule, target: rule.target };
  }

  /**
   * Magnitude is forwarded from the binding, never chosen by the user, and a
   * magnitude of zero would silently do nothing — so it becomes one notch.
   */
  private intentFor(rule: MappingRule, event: InputEvent): LightIntent {
    const magnitude = typeof event.magnitude === 'number' ? event.magnitude : 1;
    return intentForLightFunction(rule.function, this.behavior, magnitude, rule.preset);
  }
}

/**
 * Which functions are offerable given the targets' combined capabilities.
 *
 * The order is the grid the buttons screen draws, read left to right: the power
 * row, the brightness row, the colour row, each ending in the one that sets a
 * value rather than nudging one. A screen that lays them out in three columns
 * and a list that yields them in another order would drift the first time a
 * function was added, so the order lives here with the rule.
 *
 * `temperature_cycle` is deliberately absent — see RETIRED_FUNCTIONS. A stored
 * rule that names it is still honoured; this list is what a person may CHOOSE.
 */
export function availableFunctions(
  support: { onoff: number; dim: number; light_temperature: number; light_hue?: number },
): LightFunction[] {
  const available: LightFunction[] = [];
  if (support.onoff > 0) available.push('on', 'off', 'toggle');
  if (support.dim > 0) available.push('brightness_up', 'brightness_down', 'brightness_set');
  if (support.light_temperature > 0) available.push('warmer', 'colder');
  if ((support.light_hue ?? 0) > 0) available.push('color_set');
  return available;
}

/**
 * What may be STORED, as against what may be chosen.
 *
 * A retired function is honoured for as long as somebody has one (see
 * RETIRED_FUNCTIONS), so a validator that checked stored rules against
 * `availableFunctions()` would quietly delete a working button the next time the
 * whole set was written back. It still has to be a function the chosen lamps can
 * perform — a warmth cycle aimed at lights with no warmth is the same dead row
 * as any other, retired or not.
 */
export function honouredFunctions(
  support: { onoff: number; dim: number; light_temperature: number; light_hue?: number },
): LightFunction[] {
  const offered = availableFunctions(support);
  const capable = new Set(offered.map(fn => FUNCTION_CAPABILITY[fn]));
  return [...offered, ...RETIRED_FUNCTIONS.filter(fn => capable.has(FUNCTION_CAPABILITY[fn]))];
}
