import { withDefaults } from '../support/timers';

import { isDiscreteAction, isHoldAction, type InputEvent } from '../inputs/input-event';

/**
 * The press-versus-hold race. CRITICAL.
 *
 * STYRBAR emits a short-press event before a hold on some controls. Untreated,
 * holding to dim also toggles the light.
 *
 * When — and ONLY when — the same controlId carries both a discrete and a hold
 * mapping, delay the discrete action by supersedeMs. If the hold's leading
 * event arrives inside the window, cancel the discrete action and start the
 * ramp. Otherwise execute normally.
 *
 * Controls with a single mapping incur ZERO added latency. Never apply
 * globally — a 250 ms delay on every button would make the whole app feel
 * broken, which is precisely the failure this design avoids.
 */

export interface SupersedeGateOptions {
  supersedeMs: number;
  /** Which controlIds carry BOTH a discrete and a hold mapping. */
  contestedControlIds: ReadonlySet<string>;
  /** Injected so tests need no wall clock. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * What goes through the gate: the normalised event, plus the binding key it
 * arrived on.
 *
 * The key travels alongside the event rather than inside it. It used to ride in
 * `InputEvent.value` — a field documented as the event's OWN value — which
 * worked only for as long as nothing set a real one.
 */
export interface GatedInput {
  event: InputEvent;
  /** The binding key the event arrived on. */
  inputKey: string;
}

export type Dispatch = (input: GatedInput) => void;

interface Pending {
  input: GatedInput;
  handle: unknown;
}

export class SupersedeGate {
  private readonly pending = new Map<string, Pending>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly options: SupersedeGateOptions,
    private readonly dispatch: Dispatch,
  ) {
    // See lib/support/timers.ts: the public options stay piecemeal because the
    // tests stub them individually; the fallback is shared.
    const timers = withDefaults(options);
    this.setTimer = timers.setTimeout;
    this.clearTimer = timers.clearTimeout;
  }

  /**
   * Feed every normalised event through here. Returns true when the event was
   * held back pending the supersede window.
   */
  submit(input: GatedInput): boolean {
    const { event } = input;
    const contested = this.options.contestedControlIds.has(event.controlId);

    // Fast path: uncontested controls dispatch immediately. This is the
    // zero-added-latency guarantee.
    if (!contested) {
      this.dispatch(input);
      return false;
    }

    if (isHoldAction(event.action)) {
      // The hold won the race — drop the discrete action that preceded it.
      this.cancelPending(event.controlId);
      this.dispatch(input);
      return false;
    }

    if (!isDiscreteAction(event.action)) {
      // Releases and stops are neither; they never race a press.
      this.dispatch(input);
      return false;
    }

    // Discrete action on a contested control: hold it briefly.
    this.cancelPending(event.controlId);
    const handle = this.setTimer(() => {
      this.pending.delete(event.controlId);
      this.dispatch(input);
    }, this.options.supersedeMs);

    this.pending.set(event.controlId, { input, handle });
    return true;
  }

  private cancelPending(controlId: string): void {
    const pending = this.pending.get(controlId);
    if (!pending) return;
    this.clearTimer(pending.handle);
    this.pending.delete(controlId);
  }

  /** Drop everything in flight — app shutdown, controller stop, target loss. */
  cancelAll(): void {
    for (const controlId of [...this.pending.keys()]) this.cancelPending(controlId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Work out which controls need the gate at all, from the mappings actually
 * configured. A control that carries only a press, or only a hold, is never
 * contested — and the spec is emphatic that the gate must not apply globally.
 */
export function contestedControls(
  assignments: Array<{ controlId: string; action: InputEvent['action'] }>,
): Set<string> {
  const discrete = new Set<string>();
  const hold = new Set<string>();

  for (const { controlId, action } of assignments) {
    if (isHoldAction(action)) hold.add(controlId);
    else if (isDiscreteAction(action)) discrete.add(controlId);
  }

  const contested = new Set<string>();
  for (const controlId of discrete) {
    if (hold.has(controlId)) contested.add(controlId);
  }
  return contested;
}
