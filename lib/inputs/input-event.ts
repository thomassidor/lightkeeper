/** The stable input contract every source adapter normalises into. */

export type InputAction =
  | 'press' | 'long_press' | 'release'
  | 'rotate_delta' | 'rotate_start' | 'rotate_stop'
  | 'selection';

/**
 * Deliberately only what something reads.
 *
 * It used to carry sourceDeviceId, controlLabel, direction, provenance and a
 * timestamp as well — all populated on every event, none of them ever read
 * again. Diagnostics record their own copy of what arrived (see
 * `App.recentEvents`), so these were cost without a reader. The binding key
 * travels beside the event as `GatedInput`, not inside it.
 */
export interface InputEvent {
  /** Stable id of the physical control, e.g. the top rocker or the dial. */
  controlId: string;
  action: InputAction;
  /** Signed, normalised. Preserved from the source; never a user-facing choice. */
  magnitude?: number;
}

/**
 * Which actions represent a sustained gesture rather than a discrete one.
 * The supersede gate only engages where a single control carries both.
 */
const HOLD_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'long_press', 'rotate_start',
]);

const DISCRETE_ACTIONS: ReadonlySet<InputAction> = new Set<InputAction>([
  'press', 'selection', 'rotate_delta',
]);

/** A gesture that continues while held, and so may ramp rather than step. */
export function isHoldAction(action: InputAction): boolean {
  return HOLD_ACTIONS.has(action);
}

/** A one-shot gesture. The counterpart to isHoldAction, and what the supersede gate contests. */
export function isDiscreteAction(action: InputAction): boolean {
  return DISCRETE_ACTIONS.has(action);
}
