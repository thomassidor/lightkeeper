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
 * Raised when a stored range carries nothing usable — no values, or a value that
 * is not a finite number.
 *
 * Reached only through corrupted persistence, which is exactly why it exists: a
 * count-up loop between two NaN endpoints is not an error, it is an empty loop,
 * and the control quietly stops working with nothing anywhere to read. This
 * surfaces through the same `unsupported` path the ceiling refusal does, so the
 * device reports repair and names the control.
 */
export class InvalidRangeError extends Error {
  constructor(readonly reason: string) {
    super(`This control's range cannot be expanded into flows: ${reason}`);
    this.name = 'InvalidRangeError';
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
        {}, request.cards.event, {})];

    case 'flow_enum':
      return [buildFlow(request, `enum:${String(binding.value)}`, binding.cardId, binding.cardOwnerUri,
        { [binding.argument]: binding.value }, request.cards.event, {})];

    case 'flow_token':
      return [buildFlow(request, 'token', binding.cardId, binding.cardOwnerUri, {},
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
 *
 * The values are the card's OWN, not a range walked between two endpoints: a
 * dropdown offering 1 and 3 accepts 1 and 3, and a flow asking for 2 is refused
 * at create time by a 404 that reads like a permission problem.
 */
function compileRange(
  request: CompileRequest,
  binding: Extract<LogicalSourceBinding, { kind: 'flow_range' }>,
): CompiledFlow[] {
  const ceiling = request.ceiling ?? RANGE_EXPANSION_CEILING;
  const values = binding.values ?? [];

  if (values.length === 0) throw new InvalidRangeError('it lists no values');
  if (values.some(value => !Number.isFinite(value))) {
    throw new InvalidRangeError('one of its values is not a number');
  }

  // Beyond the ceiling, mark unsupported and log — silently generating fifty
  // flows is worse than declining.
  if (values.length > ceiling) {
    throw new RangeExpansionTooLargeError(values.length, ceiling);
  }

  return values.map(value => buildFlow(
    request,
    `range:${value}`,
    binding.cardId,
    binding.cardOwnerUri,
    { [binding.argument]: String(value) },
    request.cards.numeric,
    { extraArgs: { value } },
  ));
}

/**
 * `variantArgs` are merged OVER the binding's own `fixedArgs`, in one place.
 *
 * One place is the whole point: the selector and direction that pin an event to
 * one control live in `fixedArgs`, and the per-variant argument — an enum value,
 * a detent — is what distinguishes the flows of one binding from each other. A
 * kind that assembled its own trigger arguments would be a kind that could
 * forget the selector, which is the bug this shape exists to make impossible.
 */
function buildFlow(
  request: CompileRequest,
  variantKey: string,
  cardId: string,
  cardUri: string,
  variantArgs: Record<string, unknown>,
  bridgeCard: { id: string; uri: string },
  options: { droptoken?: string; extraArgs?: Record<string, unknown> },
): CompiledFlow {
  const fixedArgs = 'fixedArgs' in request.binding ? request.binding.fixedArgs ?? {} : {};
  const triggerArgs = { ...fixedArgs, ...variantArgs };

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

/**
 * Which of a set of mapped inputs the compiler would decline, and why.
 *
 * The pairing screen's preflight. Answering it needs no Homey, no API key and
 * no cards that exist: `compileBinding` is pure, and the card refs are read
 * only for an `id` and `uri` to echo into a flow this will throw away. So the
 * placeholders below are honest rather than a shortcut — nothing here can
 * reach a real flow, which is the one thing CLAUDE.md §3's rule protects.
 *
 * Returns the declined inputs rather than throwing, and returns no sentence:
 * `lib/` has no access to `homey.__`, so a message built here could never be
 * translated. The caller phrases it.
 */
export function findUncompilableBindings(
  inputs: Array<{ key: string; label: string; binding: LogicalSourceBinding }>,
  mappedKeys: Set<string>,
  sourceName: string,
): Array<{ bindingKey: string; label: string; reason: string }> {
  const placeholder = { id: 'preflight', uri: 'preflight' };
  const cards: BridgeCardRefs = { event: placeholder, numeric: placeholder, token: placeholder };

  const declined: Array<{ bindingKey: string; label: string; reason: string }> = [];
  for (const input of inputs) {
    // Discovery offers every event surface it finds; only what the user
    // actually assigned has to compile.
    if (!mappedKeys.has(input.key)) continue;
    try {
      compileBinding({
        controllerId: 'preflight',
        bindingKey: input.key,
        binding: input.binding,
        cards,
        label: input.label,
        sourceName,
      });
    } catch (error) {
      if (error instanceof RangeExpansionTooLargeError || error instanceof InvalidRangeError) {
        declined.push({ bindingKey: input.key, label: input.label, reason: error.message });
        continue;
      }
      // Anything else is a bug in the compiler rather than a control we are
      // declining, and swallowing it here would hide it.
      throw error;
    }
  }
  return declined;
}
