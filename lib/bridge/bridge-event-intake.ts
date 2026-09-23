import { parseEventKey } from '../schedules/schedule-bindings';

/**
 * What happens to a bridge event between a generated Flow firing and a light
 * moving.
 *
 * **Generated Flow arguments are untrusted.** They are ordinary editable fields
 * in the user's Flow editor, so "the Flow fired" is never on its own permission
 * to write to anybody's lights: every incoming argument is coerced, checked
 * against a live device and an expected binding key, and refused with a reason
 * when it does not hold. That is one of CLAUDE.md's stated safety properties.
 *
 * It lived in `app.ts`, inside a class that `extends Homey.App` — so no test
 * could import it at all (platform §13) and the property had no test anywhere,
 * while `api.ts`'s parallel surface is tested by `require`-ing the module. This
 * is the same split `lib/devices/device-lifecycle.ts` made one layer down and
 * `lib/pairing/` made one layer up: every rule here, the SDK shell in `app.ts`.
 */

/** What a registry says about an event it was handed. */
export interface DispatchOutcome {
  accepted: boolean;
  reason?: string;
}

/**
 * A bridge event as received, accepted or refused — without the timestamp.
 *
 * `app.ts` stamps `at` on the way into its log, so nothing here has to reach for
 * a clock and every result is a pure function of its input.
 */
export interface IntakeRecord {
  cardId: string;
  controller: string;
  eventKey: string;
  magnitude?: number;
  accepted: boolean;
  reason?: string;
}

export interface IntakeResult extends DispatchOutcome {
  /** For the app's own recentEvents log, and thence the settings page. */
  record: IntakeRecord;
}

export interface IntakeRegistries {
  /**
   * The two registries that can own a Flow, and they are asked by the SHAPE of
   * the event key rather than in turn.
   *
   * A schedule boundary key is unmistakable, and asking the controller registry
   * about one first would produce a refusal reason about a missing mapping
   * catalogue — exactly the wrong sentence to leave in the diagnostics of a
   * schedule that did not fire. A circadian or Colour Curve Light is absent because
   * neither owns a Flow, so neither can be named in one (platform §12).
   */
  schedule(controllerId: string, eventKey: string): DispatchOutcome;
  controller(
    controllerId: string,
    eventKey: string,
    options: { magnitude?: number },
  ): DispatchOutcome;
}

/**
 * The three bridge cards differ only in where their magnitude comes from.
 *
 * The plain one has none; the numeric one reads `value`; the token one reads
 * `droptoken`, which is a TOP-LEVEL property of the action rather than an entry
 * in `args` (platform §5) — which is why this is a reader rather than a field
 * name. `unknown` values, not `any`: this is not a Homey API boundary.
 *
 * `undefined` means "this card carried no usable number". What the intake does
 * with that depends on whether the card is REQUIRED to carry one — see
 * `IntakeOptions.requireMagnitude`.
 */
export type MagnitudeReader = (args: Record<string, unknown>) => number | undefined;

/**
 * A magnitude as a Flow argument carries it, or `undefined` — never a guess.
 *
 * Not a bare `Number()`, and CLAUDE.md's "`Number(null)` is 0" bullet is the
 * precedent: `Number(null)` and `Number('')` are both 0 and `Number(true)` is 1,
 * so an emptied argument, a token that resolved to nothing and a boolean all
 * used to arrive as a real-looking amount. Zero is not harmless either, which
 * is what the old reading assumed: `MappingEngine.intentFor` turns a magnitude
 * of 0 into ONE NOTCH ("a magnitude of zero would silently do nothing"), so an
 * emptied `value` moved the lights a full step that nobody asked for.
 *
 * Accepted: a finite number, and a string that is a finite number once trimmed
 * — the numeric card's literal is written by us as a number but the Flow editor
 * is free to hand it back as text. Everything else is absent.
 */
export function readMagnitude(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The two readers the shipped cards use, named so `app.ts` and a test cannot
 * each write their own.
 */
export const MAGNITUDE_READERS = {
  value: (args: Record<string, unknown>) => readMagnitude(args.value),
  droptoken: (args: Record<string, unknown>) => readMagnitude(args.droptoken),
} as const satisfies Record<string, MagnitudeReader>;

export interface IntakeOptions {
  /**
   * The card exists to carry an amount, so an event without one is REFUSED.
   *
   * Fail closed, for the reason every other refusal here gives: the numeric
   * card's `value` is a literal this app generated, so an absent one is a Flow
   * somebody edited, and the token card's `droptoken` resolving to nothing is a
   * trigger that did not say how far the dial went. Dispatching either with no
   * magnitude would reach the mapping engine's one-notch default — a guess at
   * an amount, which is exactly "executing heuristically".
   *
   * Opt-in rather than inferred from `magnitudeOf` being present, so a caller
   * that passes a reader for its own reasons keeps the older contract: a
   * non-finite reading is dropped and the event still dispatches.
   */
  requireMagnitude?: boolean;
}

/** The reason a required magnitude's absence is recorded under. */
export const MISSING_MAGNITUDE = 'the card carried no usable value';

/**
 * Coerce, refuse or route one bridge event.
 *
 * A magnitude that is not finite is dropped rather than passed on as `NaN`,
 * which would reach the planner as an arithmetic hole looking like a real delta
 * — or, with `requireMagnitude`, the whole event is refused.
 */
export function intakeBridgeEvent(
  cardId: string,
  args: unknown,
  magnitudeOf: MagnitudeReader | undefined,
  registries: IntakeRegistries,
  options: IntakeOptions = {},
): IntakeResult {
  const raw = args as Record<string, unknown> | null | undefined;
  const controller = String(raw?.controller ?? '');
  const eventKey = String(raw?.event_key ?? '');

  // Fail closed, and say which half was missing. A flow whose arguments have
  // been emptied out in the editor lands here.
  if (!controller || !eventKey) {
    const reason = 'missing controller or event key';
    return { accepted: false, reason, record: { cardId, controller, eventKey, accepted: false, reason } };
  }

  const parsed = magnitudeOf ? magnitudeOf(raw ?? {}) : undefined;
  const magnitude = typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;

  if (options.requireMagnitude && magnitude === undefined) {
    const reason = MISSING_MAGNITUDE;
    return { accepted: false, reason, record: { cardId, controller, eventKey, accepted: false, reason } };
  }

  const outcome = parseEventKey(eventKey)
    ? registries.schedule(controller, eventKey)
    : registries.controller(controller, eventKey, {
      ...(magnitude !== undefined ? { magnitude } : {}),
    });

  return {
    ...outcome,
    record: {
      cardId,
      controller,
      eventKey,
      ...(magnitude !== undefined ? { magnitude } : {}),
      accepted: outcome.accepted,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    },
  };
}
