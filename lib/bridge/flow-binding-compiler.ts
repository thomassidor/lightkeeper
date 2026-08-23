import type { LogicalSourceBinding } from '../inputs/selectable-input';

/**
 * Compile logical bindings into concrete flow definitions.
 *
 * Two platform findings shape this module (see CLAUDE.md):
 *
 *  1. A card's `uri` is a full resource URI that EMBEDS its id, e.g.
 *     `homey:flowcardaction:homey:manager:alarms:enable_next`. It is not
 *     `homey:app:<appId>`. Constructing one yields 404 Not Found, which reads
 *     exactly like a permission refusal. Card URIs are therefore only ever
 *     echoed back from enumeration, never built here.
 *  2. `droptoken` is a TOP-LEVEL property of an action, not an entry in args.
 *     A token owned by the flow's own trigger is referenced by its bare id;
 *     global tokens use "<ownerUri>|<tokenId>".
 */

export const RANGE_EXPANSION_CEILING = 12;

export interface BridgeCardRefs {
  /** Fixed and enum events. */
  event: { id: string; uri: string };
  /** Range-expanded events carrying a literal amount. */
  numeric: { id: string; uri: string };
  /** Events whose amount arrives as a trigger token. */
  token: { id: string; uri: string };
}

export interface FlowAction {
  id: string;
  uri: string;
  args: Record<string, unknown>;
  group?: string;
  droptoken?: string;
}

export interface FlowTrigger {
  id: string;
  uri: string;
  args: Record<string, unknown>;
}

export interface CompiledFlow {
  /** Distinguishes range-expanded variants of one binding. Stable. */
  variantKey: string;
  name: string;
  trigger: FlowTrigger;
  actions: FlowAction[];
}

export interface CompileRequest {
  controllerId: string;
  /** The SelectableInput.key this binding belongs to. */
  bindingKey: string;
  binding: LogicalSourceBinding;
  cards: BridgeCardRefs;
  /** Display name used in the generated flow's title. */
  label: string;
  sourceName: string;
  ceiling?: number;
  /**
   * Overrides the variant key of a `flow_fixed` binding.
   *
   * Reuse is keyed on (controller, binding key, variant key) plus the
   * fingerprint, and a reused flow's trigger is never rewritten — so anything
   * that lives in the TRIGGER'S ARGUMENTS and can change while the binding key
   * stays the same has to appear here, or the edit is silently ignored. A light
   * schedule moved from 22:00 to 23:00 is exactly that case: same schedule, same
   * binding key, different trigger argument. With the time in the variant key
   * the old flow is no longer wanted and is deleted, and a new one is created.
   */
  variantKey?: string;
}

/**
 * Raised when a control's range would need more flow variants than the ceiling
 * allows. The caller marks the control unsupported and carries on: declining
 * one control beats filling a user's Flow list with hundreds of generated rows.
 */
export class RangeExpansionTooLargeError extends Error {
  constructor(readonly variants: number, readonly ceiling: number) {
    super(`Range expansion would need ${variants} flow variants, above the ceiling of ${ceiling}`);
    this.name = 'RangeExpansionTooLargeError';
  }
}

/**
 * Create only the variants needed by mapped events, never every discovered
 * event.
 */
export function compileBinding(request: CompileRequest): CompiledFlow[] {
  const { binding } = request;

  switch (binding.kind) {
    case 'flow_fixed':
      return [buildFlow(request, request.variantKey ?? 'fixed', binding.cardId, binding.cardOwnerUri,
        binding.args, request.cards.event, {})];

    case 'flow_enum':
      return [buildFlow(request, `enum:${String(binding.value)}`, binding.cardId, binding.cardOwnerUri,
        { [binding.argument]: binding.value }, request.cards.event, {})];

    case 'flow_token':
      return [buildFlow(request, 'token', binding.cardId, binding.cardOwnerUri, binding.args,
        request.cards.token, { droptoken: binding.tokenId })];

    case 'flow_range':
      return compileRange(request, binding);

    case 'direct_capability':
      // Adapter interface only; no device tested so far needs it. A capability
      // source needs no flow at all.
      return [];
  }
}

/**
 * Range expansion: where a numeric value is a fixed trigger argument rather
 * than a token, compile the logical event into one flow per value, each passing
 * its own literal amount to the numeric bridge card. This is what makes a
 * single "Dial — Turn right" entry work against an integration that models
 * detents as separate argument values.
 */
function compileRange(
  request: CompileRequest,
  binding: Extract<LogicalSourceBinding, { kind: 'flow_range' }>,
): CompiledFlow[] {
  const ceiling = request.ceiling ?? RANGE_EXPANSION_CEILING;
  const [from, to] = binding.valueRange;
  const variants = to - from + 1;

  // Beyond the ceiling, mark unsupported and log — silently generating fifty
  // flows is worse than declining.
  if (variants > ceiling || variants <= 0) {
    throw new RangeExpansionTooLargeError(variants, ceiling);
  }

  const flows: CompiledFlow[] = [];
  for (let value = from; value <= to; value++) {
    flows.push(buildFlow(
      request,
      `range:${value}`,
      binding.cardId,
      binding.cardOwnerUri,
      { [binding.argument]: String(value) },
      request.cards.numeric,
      { extraArgs: { value } },
    ));
  }
  return flows;
}

function buildFlow(
  request: CompileRequest,
  variantKey: string,
  cardId: string,
  cardUri: string,
  triggerArgs: Record<string, unknown>,
  bridgeCard: { id: string; uri: string },
  options: { droptoken?: string; extraArgs?: Record<string, unknown> },
): CompiledFlow {
  const action: FlowAction = {
    id: bridgeCard.id,
    uri: bridgeCard.uri,
    group: 'then',
    args: {
      controller: request.controllerId,
      event_key: request.bindingKey,
      ...(options.extraArgs ?? {}),
    },
  };

  if (options.droptoken !== undefined) action.droptoken = options.droptoken;

  return {
    variantKey,
    name: flowName(request, variantKey),
    trigger: { id: cardId, uri: cardUri, args: triggerArgs },
    actions: [action],
  };
}

/**
 * Named so a user browsing their Flow list can tell what these are and which
 * controller owns them, without opening one.
 */
function flowName(request: CompileRequest, variantKey: string): string {
  const suffix = variantKey.startsWith('range:') ? ` (${variantKey.slice(6)})` : '';
  return `Lightkeeper — ${request.sourceName}: ${request.label}${suffix}`;
}

/** Idempotency key: one flow per binding per variant. */
export function managedKey(controllerId: string, bindingKey: string, variantKey: string): string {
  return `${controllerId}::${bindingKey}::${variantKey}`;
}
