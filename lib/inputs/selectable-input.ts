import type { InputAction } from './input-event';

/**
 * How a normalised event is bound back to its raw source.
 * Persisted in the controller profile; the compiler turns it into flows.
 *
 * **`fixedArgs` is on every flow kind, and that is the point.** It carries the
 * trigger arguments that pin the event down — which button fired, which way the
 * dial turned — and they are needed whatever ELSE the card does. Three of the
 * five kinds used to have somewhere to put them and `flow_range` did not, so a
 * card with a selector AND a direction AND an enumerated magnitude compiled into
 * flows that set only the magnitude: a Flow per detent, none of them saying which
 * button or which direction. Every variant fired on every turn of every control
 * on the remote.
 *
 * `flow_enum` keeps its `argument`/`value` pair ON TOP of `fixedArgs` rather than
 * folding into `flow_fixed`, because that pair is also what its variant key is
 * built from (`enum:<value>`) — see DEVIATIONS.md for the fold that was
 * considered and why it cannot keep that key stable.
 */
export type LogicalSourceBinding =
  | { kind: 'direct_capability'; capabilityId: string; interpreter: ValueInterpreter }
  | { kind: 'flow_fixed'; cardId: string; cardOwnerUri: string; fixedArgs: Record<string, unknown> }
  | {
    kind: 'flow_enum';
    cardId: string;
    cardOwnerUri: string;
    fixedArgs: Record<string, unknown>;
    argument: string;
    value: unknown;
  }
  | {
    kind: 'flow_range';
    cardId: string;
    cardOwnerUri: string;
    fixedArgs: Record<string, unknown>;
    argument: string;
    /**
     * The EXACT values the card offers, sorted and de-duplicated.
     *
     * Not a `[min, max]` pair. A dropdown offering {1, 3} is two detents, and
     * expanding a range invented a flow for a value the card never accepts —
     * which fails at create time with a 404 that reads like a permission
     * problem. Decimal sets ({0.5, 1.0}) could not be expressed at all.
     */
    values: number[];
  }
  | {
    kind: 'flow_token';
    cardId: string;
    cardOwnerUri: string;
    fixedArgs: Record<string, unknown>;
    /**
     * The token's `id`, not its `name`; using `name` silently produces broken
     * flows. For a token
     * owned by the flow's own trigger this is referenced bare; global tokens
     * use "<ownerUri>|<tokenId>".
     */
    tokenId: string;
  };

export type ValueInterpreter =
  | 'boolean_press'
  | 'numeric_delta'
  | 'numeric_absolute'
  | 'enum_selection';

/**
 * What the mapping UI consumes. Never live raw events, and never
 * magnitude variants (collapses those before they reach here).
 */
export interface SelectableInput {
  /** Stable binding key; what a MappingRule stores. */
  key: string;
  controlId: string;
  /** e.g. 'Dial — Turn right' */
  label: string;
  action: InputAction;
  direction?: -1 | 1;
  carriesMagnitude: boolean;
  /**
   * Raw units in one full turn of a dial, when the integration says so.
   * The Hue Tap Dial reports "Steps (1000/turn)", so a small nudge arrives as
   * 151 — feeding that straight into a 0.1 step would jump the lights to full.
   */
  magnitudePerTurn?: number;
  binding: LogicalSourceBinding;
}

/** Grouped for the event picker: by physical control, in stable order. */
export interface ControlGroup {
  controlId: string;
  label: string;
  inputs: SelectableInput[];
}

/**
 * Gather inputs under the physical control they belong to, preserving
 * discovery order.
 *
 * The mapping screen is organised per control — "the up button", with its press
 * and its hold beneath it — because that is how people describe a remote.
 */
export function groupByControl(inputs: SelectableInput[]): ControlGroup[] {
  const groups = new Map<string, ControlGroup>();
  for (const input of inputs) {
    let group = groups.get(input.controlId);
    if (!group) {
      group = { controlId: input.controlId, label: controlLabelOf(input), inputs: [] };
      groups.set(input.controlId, group);
    }
    group.inputs.push(input);
  }
  return [...groups.values()];
}

/** 'Dial — Turn right' → 'Dial' */
function controlLabelOf(input: SelectableInput): string {
  const [control] = input.label.split(' — ');
  return control ?? input.controlId;
}
