/**
 * "Has this changed?", asked without `JSON.stringify`.
 *
 * `JSON.stringify(a) === JSON.stringify(b)` is not an equality test, it is a
 * SERIALISATION test, and the two differ in ways that matter here:
 *
 *  - key ORDER decides the answer, so two objects with the same fields written
 *    in a different order read as different. Every one of these comparisons gates
 *    a persist, and a false "changed" emits `device.update`, which invalidates
 *    the catalogue, which lands back in `onCatalogChange` — the loop the runtimes
 *    already document at that exact spot;
 *  - `undefined` disappears, so a field present-and-undefined equals a field
 *    absent, sometimes usefully and sometimes not;
 *  - it is O(size) in allocation for a question that is usually answered by the
 *    first field.
 *
 * These are field-wise, and each says which fields it deliberately ignores.
 */

import type { ManagedFlowReference } from '../profiles/controller-profile';
import type { SelectableInput } from '../inputs/selectable-input';

/**
 * Two sets of managed Flow references, as reconciliation compares them.
 *
 * Compared on `(flowId, fingerprint, variantKey)` and the ORDER they arrive in,
 * because `sync()` returns them in the order it wanted them and a reordering
 * genuinely is a different set of Flows for a different set of bindings.
 *
 * `createdAt` is deliberately ignored: a reused Flow keeps its original
 * timestamp, so comparing it would report "changed" on a pass that reused
 * everything — the exact false positive this function exists to avoid.
 * `bindingKey` and `managedVersion` are ignored because neither can change while
 * the other three stay the same: the binding key is half of what a reference is
 * looked up by, and the version is a constant.
 */
export function sameManagedFlows(
  a: readonly ManagedFlowReference[],
  b: readonly ManagedFlowReference[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((ref, i) => {
    const other = b[i]!;
    return ref.flowId === other.flowId
      && ref.fingerprint === other.fingerprint
      && ref.variantKey === other.variantKey;
  });
}

/**
 * Two discovered catalogues, as `refreshCatalogue` compares them.
 *
 * Compared on what a MAPPING depends on: the key (which a rule stores), the
 * label (which the mapping screen shows), the action and direction (which decide
 * the gesture), and the binding — because a binding that moved is a Flow that has
 * to be rebuilt.
 *
 * Deliberately ignored: `carriesMagnitude` and `magnitudePerTurn`. Both are
 * derived from the binding, so a change in either implies a change in the binding
 * and is already caught. Nothing else on a `SelectableInput` is compared, and
 * that is the point of listing them: a field added later is NOT compared until
 * somebody decides it should be.
 */
export function sameCatalogue(
  a: readonly SelectableInput[],
  b: readonly SelectableInput[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((input, i) => {
    const other = b[i]!;
    return input.key === other.key
      && input.label === other.label
      && input.action === other.action
      && input.direction === other.direction
      && sameBinding(input.binding, other.binding);
  });
}

/**
 * Two bindings.
 *
 * This one IS structural, and honestly so: a binding is a small closed union
 * whose members carry `fixedArgs` and `values`, both of which are open-ended
 * enough that a field-wise comparison would be a second implementation of the
 * union. It is compared by a canonical serialisation — sorted keys, so key order
 * cannot decide the answer, which is the specific failure `JSON.stringify` has.
 */
function sameBinding(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * A stable string for an arbitrary value: object keys sorted at every level.
 *
 * `undefined` becomes `null` rather than vanishing, so a field present and
 * undefined does not silently equal a field absent.
 */
export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(',')}}`;
}
