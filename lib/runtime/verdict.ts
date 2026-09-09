import type { ControllerState, StateDetail } from '../profiles/controller-profile';

/**
 * One thing that might be wrong, in the form the device layer can render.
 *
 * A runtime learns about its own health from two independent places — what
 * reconciliation found in the Flows, and what the lights themselves report —
 * and those two answers arrive at different times, from different code, on
 * different triggers. Holding each as a `Verdict` rather than writing it
 * straight to the visible state is what lets them be COMPOSED instead of
 * overwriting each other.
 */
export interface Verdict {
  state: ControllerState;
  detail?: StateDetail;
}

/**
 * How bad each state is, so that "worst wins" is a comparison rather than an
 * ordering of `setState` calls scattered through a file.
 *
 * The order is the order in which a user should act:
 *
 *   ready              nothing to do
 *   partial            some of it works; the rest needs a lamp looking at
 *   needs_repair       the app cannot fix this itself — open repair
 *   needs_credential   and repair cannot succeed until the key is replaced,
 *                      because repair WRITES Flows (platform §1)
 *   disabled           the user turned it off; their choice outranks our news
 *
 * `needs_credential` above `needs_repair` is the load-bearing pair. A dead key
 * makes every reconcile fail, so a controller with both would otherwise send
 * the user into a repair flow that cannot complete.
 */
const STATE_SEVERITY: Record<ControllerState, number> = {
  ready: 0,
  partial: 1,
  needs_repair: 2,
  needs_credential: 3,
  disabled: 4,
};

/**
 * The worst of what is known, or `null` when nothing is.
 *
 * Ties go to the EARLIER argument, so callers pass the verdict that names an
 * action first — a Flow the user must look at beats a lamp count they can do
 * nothing about, when both say `needs_repair`.
 */
export function worstVerdict(...verdicts: Array<Verdict | null | undefined>): Verdict | null {
  const known = verdicts.filter((verdict): verdict is Verdict => verdict !== null && verdict !== undefined);
  if (known.length === 0) return null;
  return known.reduce((held, next) =>
    STATE_SEVERITY[next.state] > STATE_SEVERITY[held.state] ? next : held);
}
