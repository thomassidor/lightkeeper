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
   * schedule that did not fire. A circadian or Curve light is absent because
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
 * name. `unknown` values, not `any`: this is not a Homey API boundary, and
 * `Number()` takes them quite happily.
 */
export type MagnitudeReader = (args: Record<string, unknown>) => number;

/**
 * Coerce, refuse or route one bridge event.
 *
 * A magnitude that is not finite is dropped rather than passed on as `NaN`,
 * which would reach the planner as an arithmetic hole looking like a real delta.
 */
export function intakeBridgeEvent(
  cardId: string,
  args: unknown,
  magnitudeOf: MagnitudeReader | undefined,
  registries: IntakeRegistries,
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
