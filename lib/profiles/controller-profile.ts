import type { ControllerBehavior, MappingRule } from '../mapping/mapping-types';
import type { SelectableInput } from '../inputs/selectable-input';
import type { TargetSpec } from '../outputs/light-intent';

export const CURRENT_SCHEMA_VERSION = 1;

/** Spec §9.2 */
export type ControllerState = 'ready' | 'partial' | 'needs_repair' | 'needs_credential' | 'disabled';

/**
 * Why a controller is in the state it is, carried in a form the device layer
 * can translate (§14).
 *
 * `key` plus `tokens` is the preferred shape: lib/ has no access to `homey.__`,
 * so a state reason produced here would otherwise reach the user as hardcoded
 * English no matter what the locale files say. `text` is the escape hatch for
 * strings we did not author — an error message from the Homey API, say — and is
 * shown as-is.
 */
export interface StateDetail {
  key?: string;
  tokens?: Record<string, string | number>;
  text?: string;
}

/** Spec §6.4 — what is persisted about each generated flow. */
export interface ManagedFlowReference {
  flowId: string;
  /** Which logical binding this flow implements. */
  bindingKey: string;
  /** Distinguishes range-expanded variants of one binding. */
  variantKey: string;
  /** Schema fingerprint at creation time (§9.3). */
  fingerprint: string;
  managedVersion: number;
  createdAt: number;
}

/**
 * Spec §9.1. Persisted in the virtual device store; Homey IDs are
 * authoritative and names are display-only caches.
 */
export interface ControllerProfile {
  schemaVersion: number;
  enabled: boolean;
  source: {
    deviceId: string;
    ownerAppId?: string;
    driverId?: string;
    /** §9.3 — what makes repair safe after an integration update. */
    eventSurfaceFingerprint: string;
    /** Display-only cache. */
    name?: string;
  };
  target: TargetSpec;
  mappings: MappingRule[];
  behavior: ControllerBehavior;
  managedFlows: ManagedFlowReference[];
  /**
   * The catalogue as it stood at configuration time. Kept so the mapping screen
   * can be reopened with existing values preselected (AC-17) without needing
   * the source device to be reachable.
   */
  catalogue?: SelectableInput[];
}

export function findMapping(profile: ControllerProfile, inputKey: string): MappingRule | undefined {
  return profile.mappings.find(m => m.inputKey === inputKey);
}

export function assignedInputKeys(profile: ControllerProfile): string[] {
  return profile.mappings.map(m => m.inputKey).filter((k): k is string => k !== null);
}

/**
 * §8.3 conflict rule: one lighting function per normalised event in MVP.
 * Returns the rule that would be displaced by assigning this input.
 */
export function conflictingRule(
  profile: ControllerProfile,
  inputKey: string,
  exceptRuleId: string,
): MappingRule | undefined {
  return profile.mappings.find(m => m.inputKey === inputKey && m.id !== exceptRuleId);
}
