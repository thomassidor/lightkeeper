import type { InputEvent } from '../inputs/input-event';
import type { LightIntent, TargetSpec } from '../outputs/light-intent';
import type { ControllerBehavior, LightFunction, MappingRule } from './mapping-types';

/**
 * Spec §4 — resolves normalised events into configured light intents.
 * Pure: no Homey, no I/O, no timers.
 */

export interface ResolvedIntent {
  intent: LightIntent;
  rule: MappingRule;
  /** null means inherit the controller's targets (§4.2). */
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

  /** Unmapped input resolves to null — never a guess (§12: fail closed). */
  resolve({ inputKey, event }: MappingEngineInput): ResolvedIntent | null {
    const rule = this.rules.find(r => r.inputKey === inputKey);
    if (!rule) return null;

    const intent = this.intentFor(rule, event);
    if (!intent) return null;

    return { intent, rule, target: rule.target };
  }

  private intentFor(rule: MappingRule, event: InputEvent): LightIntent | null {
    switch (rule.function) {
      case 'toggle':
        return { type: 'toggle' };
      case 'on':
        return { type: 'power', value: true };
      case 'off':
        return { type: 'power', value: false };
      case 'brightness_up':
        return { type: 'brightness_delta', delta: this.stepFor(rule, event, 'brightness') };
      case 'brightness_down':
        return { type: 'brightness_delta', delta: -this.stepFor(rule, event, 'brightness') };
      case 'warmer':
        // Warmer means a LOWER colour temperature value on Homey's normalised
        // axis, where 0 is warm and 1 is cold.
        return { type: 'temperature_delta', delta: -this.stepFor(rule, event, 'temperature') };
      case 'colder':
        return { type: 'temperature_delta', delta: this.stepFor(rule, event, 'temperature') };
      default:
        return null;
    }
  }

  /**
   * §8.4 — step and sensitivity per row, magnitude used where available.
   * Magnitude is forwarded from the binding, never chosen by the user (§5.4).
   */
  private stepFor(rule: MappingRule, event: InputEvent, kind: 'brightness' | 'temperature'): number {
    const options = rule.options ?? {};
    const base = options.step
      ?? (kind === 'brightness' ? this.behavior.brightnessStep : this.behavior.temperatureStep);
    const sensitivity = options.sensitivity ?? 1;

    const useMagnitude = options.useMagnitude ?? true;
    const magnitude = useMagnitude && typeof event.magnitude === 'number'
      ? Math.abs(event.magnitude)
      : 1;

    // A magnitude of zero would silently do nothing; treat it as one notch.
    const notches = magnitude > 0 ? magnitude : 1;

    return base * sensitivity * notches;
  }
}

/** Which functions are offerable given the targets' combined capabilities (§8.3). */
export function availableFunctions(
  support: { onoff: number; dim: number; light_temperature: number },
): LightFunction[] {
  const available: LightFunction[] = [];
  if (support.onoff > 0) available.push('toggle', 'on', 'off');
  if (support.dim > 0) available.push('brightness_up', 'brightness_down');
  if (support.light_temperature > 0) available.push('warmer', 'colder');
  return available;
}
