import type { InputEvent } from '../inputs/input-event';
import type { LightIntent, TargetSpec } from '../outputs/light-intent';
import type { ControllerBehavior, LightFunction, MappingRule } from './mapping-types';

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
    return intentForLightFunction(rule.function, this.behavior, magnitude);
  }
}

/** Which functions are offerable given the targets' combined capabilities. */
export function availableFunctions(
  support: { onoff: number; dim: number; light_temperature: number },
): LightFunction[] {
  const available: LightFunction[] = [];
  if (support.onoff > 0) available.push('toggle', 'on', 'off');
  if (support.dim > 0) available.push('brightness_up', 'brightness_down');
  if (support.light_temperature > 0) available.push('warmer', 'colder');
  return available;
}
