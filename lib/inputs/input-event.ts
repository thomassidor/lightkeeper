/** Spec §5.2 — the stable input contract every source adapter normalises into. */

export type InputAction =
  | 'press' | 'long_press' | 'release'
  | 'rotate_delta' | 'rotate_start' | 'rotate_stop'
  | 'selection';

export type Provenance =
  | 'capability'
  | 'flow_fixed'
  | 'flow_argument'
  | 'flow_token'
  | 'derived';

export interface InputEvent {
  sourceDeviceId: string;
  /** Stable id of the physical control, e.g. the top rocker or the dial. */
  controlId: string;
  /** Human label for that control, e.g. 'Dial', 'Top button'. */
  controlLabel: string;
  action: InputAction;
  direction?: -1 | 1;
  /** Signed, normalised. Preserved from the source; never a user-facing choice. */
  magnitude?: number;
  value?: string | number | boolean;
  provenance: Provenance;
  timestamp: number;
}

/**
 * Which actions represent a sustained gesture rather than a discrete one.
 * The supersede gate (§7.6) only engages where a single control carries both.
 */
export const HOLD_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'long_press', 'rotate_start',
]);

export const DISCRETE_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'press', 'selection', 'rotate_delta',
]);

/** A gesture that continues while held, and so may ramp rather than step (§5.5). */
export function isHoldAction(action: InputAction): boolean {
  return HOLD_ACTIONS.has(action);
}

/** A one-shot gesture. The counterpart to isHoldAction, and what the supersede gate contests (§7.6). */
export function isDiscreteAction(action: InputAction): boolean {
  return DISCRETE_ACTIONS.has(action);
}
