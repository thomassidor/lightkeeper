import type { InputAction } from './input-event';

/**
 * Spec §6.3 — how a normalised event is bound back to its raw source.
 * Persisted in the controller profile; the compiler turns it into flows.
 */
export type LogicalSourceBinding =
  | { kind: 'direct_capability'; capabilityId: string; interpreter: ValueInterpreter }
  | { kind: 'flow_fixed'; cardId: string; cardOwnerUri: string; args: Record<string, unknown> }
  | { kind: 'flow_enum'; cardId: string; cardOwnerUri: string; argument: string; value: unknown }
  | { kind: 'flow_range'; cardId: string; cardOwnerUri: string; argument: string; valueRange: [number, number] }
  | {
    kind: 'flow_token';
    cardId: string;
    cardOwnerUri: string;
    args: Record<string, unknown>;
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
 * Spec §5.3 — what the mapping UI consumes. Never live raw events, and never
 * magnitude variants (§5.4 collapses those before they reach here).
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

/** Grouped for the event picker (§8.3): by physical control, in stable order. */
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
