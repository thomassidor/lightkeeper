import type { ControllerBehavior, MappingRule } from '../mapping/mapping-types';
import type { SelectableInput } from '../inputs/selectable-input';
import type { TargetSpec } from '../outputs/light-intent';

export const CURRENT_SCHEMA_VERSION = 1;

/** How a controller reports itself: working, degraded, or needing attention. */
export type ControllerState = 'ready' | 'partial' | 'needs_repair' | 'needs_credential' | 'disabled';

/**
 * Why a controller is in the state it is, carried in a form the device layer
 * can translate.
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

/** What is persisted about each generated flow. */
export interface ManagedFlowReference {
  flowId: string;
  /** Which logical binding this flow implements. */
  bindingKey: string;
  /** Distinguishes range-expanded variants of one binding. */
  variantKey: string;
  /** Schema fingerprint at creation time. */
  fingerprint: string;
  managedVersion: number;
  createdAt: number;
}

/**
 * Persisted in the virtual device store; Homey IDs are
 * authoritative and names are display-only caches.
 */
export interface ControllerProfile {
  schemaVersion: number;
  enabled: boolean;
  source: {
    deviceId: string;
    ownerAppId?: string;
    driverId?: string;
    /** What makes repair safe after an integration update. */
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
   * can be reopened with existing values preselected without needing
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
 * Conflict rule: one lighting function per normalised event.
 * Returns the rule that would be displaced by assigning this input.
 */
export function conflictingRule(
  profile: ControllerProfile,
  inputKey: string,
  exceptRuleId: string,
): MappingRule | undefined {
  return profile.mappings.find(m => m.inputKey === inputKey && m.id !== exceptRuleId);
}

/**
 * One rule per normalised event, enforced on a whole rule set.
 *
 * The mapping screen is keyed on (light group, function), so nothing there
 * stopped one gesture being assigned twice — and MappingEngine.resolve() takes
 * the FIRST match, so the second assignment silently did nothing. A control that
 * looks configured and has no effect is the exact failure this app exists to
 * prevent, so duplicates are collapsed rather than tolerated.
 *
 * First wins, matching the engine. Displaced rules are returned so the caller
 * can say what it dropped.
 */
export function dedupeByInputKey<T extends { inputKey: string | null }>(
  rules: T[],
): { rules: T[]; displaced: T[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const displaced: T[] = [];

  for (const rule of rules) {
    if (rule.inputKey !== null && seen.has(rule.inputKey)) {
      displaced.push(rule);
      continue;
    }
    if (rule.inputKey !== null) seen.add(rule.inputKey);
    kept.push(rule);
  }

  return { rules: kept, displaced };
}

/**
 * Which managed flows a saved profile may keep, and which are now dead.
 *
 * Carrying the existing references forward is what stops reconciliation
 * orphaning a set and creating duplicates when only the mappings changed. But a
 * flow's trigger embeds its source DEVICE id, so the moment the source changes —
 * one-tap re-attach after a BILRESA re-add, or picking a different remote in
 * repair — every old reference points at a flow whose trigger can no longer
 * match. Kept, those flows fail hasBeenUserEdited() on the trigger id and the
 * controller lands in "a user edited this flow" repair, with no new flows
 * created. They cannot be reached by the orphan sweep either: their controller id
 * still belongs to a live controller.
 *
 * So: same source, keep; different source, hand them back for deletion.
 */
export function carryForwardFlows(
  previous: ControllerProfile | null | undefined,
  next: ControllerProfile,
): { profile: ControllerProfile; obsolete: ManagedFlowReference[] } {
  const existing = previous?.managedFlows ?? [];
  const sameSource = previous?.source?.deviceId === next.source.deviceId;

  if (sameSource) {
    return { profile: { ...next, managedFlows: existing }, obsolete: [] };
  }

  return { profile: { ...next, managedFlows: [] }, obsolete: existing };
}
