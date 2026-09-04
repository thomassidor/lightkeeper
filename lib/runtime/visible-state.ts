import { sameDetail } from '../profiles/controller-profile';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';

/**
 * The state a user can SEE, and the one place that decides when it moved.
 *
 * Held by each of the four runtimes rather than inherited, and both halves of
 * that are deliberate.
 *
 * **Why it is shared.** `setState`, `lastDetail` and `stateRevision` were the
 * same twenty-four lines — docblock included — in `circadian-runtime.ts`,
 * `schedule-runtime.ts` and `controller-runtime.ts`, and the same logic again in
 * `daylight-runtime.ts` with the fields hoisted and the argument dropped. The
 * argument below is the kind that is expensive to rediscover, and four copies of
 * it is three chances for the next edit to land in one file and not the others.
 *
 * **Why a field and not a base class.** `DeviceRuntime` in
 * `devices/device-lifecycle.ts` is satisfied STRUCTURALLY — the runtimes are
 * matched by shape, not by ancestry — so each keeps its own `currentState` and
 * `currentDetail` getters and simply reads them off here. A base class would put
 * the four runtimes in a hierarchy CLAUDE.md keeps flat on purpose, and would buy
 * nothing that composition does not.
 *
 * **The callback stays SYNCHRONOUS.** `device-lifecycle.ts` takes the state
 * callback as synchronous by contract, because it cannot be awaited and is what
 * the second per-device FIFO orders its availability verdicts against. Nothing
 * here may make it a promise.
 *
 * **Why the comparison includes the detail.** It used to be `state === state`
 * alone, which is not what the device layer renders: it renders the state AND
 * its detail, and the detail is where the sentence lives. So a device that went
 * from "the API key expired" to "the API key has no Flow permission" — both
 * `needs_credential` — kept showing the first message, and the user re-minted a
 * key with the same problem because the app never stopped telling them to.
 */
export class VisibleState {
  private state: ControllerState = 'disabled';

  /** The detail last handed to the device layer, for the comparison in `set`. */
  private detail: StateDetail | undefined;

  /** Diagnostics only: how many times the visible state has actually moved. */
  private moves = 0;

  constructor(private readonly onChange: (state: ControllerState, detail?: StateDetail) => void) {}

  get current(): ControllerState { return this.state; }

  get currentDetail(): StateDetail | undefined { return this.detail; }

  get revision(): number { return this.moves; }

  /** Adopt a state, and tell the device layer only if a user could see it. */
  set(state: ControllerState, detail?: StateDetail): void {
    if (this.state === state && sameDetail(this.detail, detail)) return;
    this.state = state;
    this.detail = detail;
    this.moves += 1;
    this.onChange(state, detail);
  }
}
