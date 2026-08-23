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

export class MappingEngine {
  constructor(
    private rules: MappingRule[],
    private behavior: ControllerBehavior,
  ) {}

  update(rules: MappingRule[], behavior: ControllerBehavior): void {
    this.rules = rules;
    this.behavior = behavior;
  }

  /** Unmapped input resolves to null — never a guess. Fail closed. */
  resolve({ inputKey, event }: MappingEngineInput): ResolvedIntent | null {
    const rule = this.rules.find(r => r.inputKey === inputKey);
    if (!rule) return null;

    return { intent: this.intentFor(rule, event), rule, target: rule.target };
  }

  private intentFor(rule: MappingRule, event: InputEvent): LightIntent {
    switch (rule.function) {
      case 'toggle':
        return { type: 'toggle' };
      case 'on':
        return { type: 'power', value: true };
      case 'off':
        return { type: 'power', value: false };
      case 'brightness_up':
        return { type: 'brightness_delta', delta: this.stepFor(event, 'brightness') };
      case 'brightness_down':
        return { type: 'brightness_delta', delta: -this.stepFor(event, 'brightness') };
      case 'warmer':
        // Warmer means a HIGHER value on Homey's normalised axis: 0 is the
        // coolest end, 1 the warmest. homey-lib's own capability hint says so —
        // "A higher value means a warmer color". Getting it backwards is what
        // made a schedule set to "Warmest" write 0 and light a room cold white
        // on its first live run.
        return { type: 'temperature_delta', delta: this.stepFor(event, 'temperature') };
      case 'colder':
        return { type: 'temperature_delta', delta: -this.stepFor(event, 'temperature') };
    }
    // No default arm: the switch covers every LightFunction, and an added
    // member must fail to compile here rather than silently resolve to null.
  }

  /**
   * The step for one activation, scaled by magnitude where the source reports
   * it. Magnitude is forwarded from the binding, never chosen by the user.
   */
  private stepFor(event: InputEvent, kind: 'brightness' | 'temperature'): number {
    const base = kind === 'brightness'
      ? this.behavior.brightnessStep
      : this.behavior.temperatureStep;

    const magnitude = typeof event.magnitude === 'number' ? Math.abs(event.magnitude) : 1;
    // A magnitude of zero would silently do nothing; treat it as one notch.
    return base * (magnitude > 0 ? magnitude : 1);
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
