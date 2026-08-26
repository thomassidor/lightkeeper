/**
 * Magnitude collapse. The single most consequential piece of
 * normalisation in the app.
 *
 * Events differing only in magnitude are ONE selectable entry. A dial exposing
 * separate argument values for one, two, three… detents must appear as a single
 * "Dial — Turn right". Magnitude is preserved in the binding and forwarded at
 * runtime; it is never a user-facing choice.
 *
 * The trap this exists to avoid, quoting the spec: "A Matter count field
 * frequently represents wheel detents rather than repeated clicks; misreading
 * it produces a picker full of nonsense entries and a dimmer that jumps."
 * Confirmed on real hardware — IKEA BILRESA exposes
 * switch_multi_press_multi with button 1–9 AND count 1–18. Expanded naively
 * that is 162 picker entries.
 */

export interface CardArgumentValue {
  id: string;
  title?: unknown;
}

export interface CardArgument {
  name: string;
  type: string;
  title?: unknown;
  values?: CardArgumentValue[];
  filter?: string;
  min?: number;
  max?: number;
  step?: number;
}

export type ArgumentRole =
  /** Selects WHICH physical control fired. Expand: one selectable per value. */
  | 'control_selector'
  /** Selects a direction. Expand, but into directional variants of one control. */
  | 'direction'
  /** Carries HOW MUCH. Never expand into the picker; preserve as magnitude. */
  | 'magnitude'
  /** Free numeric input, not enumerable — excluded from the catalogue. */
  | 'numeric_open'
  /** Not enumerable and must not be exposed. */
  | 'unsupported';

/**
 * Argument names carry more signal than value shapes do, so they are checked
 * first. BILRESA's `button` argument holds "1".."9" — pure numbers that look
 * exactly like a count — and only the name distinguishes them.
 */
const CONTROL_NAMES = /^(button|switch|scene|control|key|pad|endpoint)s?$/i;
const MAGNITUDE_NAMES = /^(count|steps?|times|repeats?|amount|level|value|delta|rotation|speed)$/i;
const DIRECTION_NAMES = /^(direction|rotate_direction|rotation_direction|way|turn)$/i;

const DIRECTION_VALUES = /^(either|any|both|cw|ccw|clock_?wise|counter_?clock_?wise|anti_?clock_?wise|left|right|up|down|increase|decrease|forward|backward)$/i;

/** Beyond this many contiguous numbers, a nameless enum is a count, not a control. */
const NUMERIC_CONTROL_CEILING = 4;

export function classifyArgument(arg: CardArgument): ArgumentRole {
  if (arg.type === 'autocomplete') return 'unsupported';
  if (arg.type === 'number' || arg.type === 'range') return 'numeric_open';
  if (arg.type !== 'dropdown') return 'unsupported';

  const values = arg.values ?? [];
  if (values.length === 0) return 'unsupported';

  if (DIRECTION_NAMES.test(arg.name)) return 'direction';
  if (MAGNITUDE_NAMES.test(arg.name)) return 'magnitude';
  if (CONTROL_NAMES.test(arg.name)) return 'control_selector';

  // Fall back to value shape.
  const ids = values.map(v => String(v.id));
  if (ids.every(id => DIRECTION_VALUES.test(id))) return 'direction';

  if (isContiguousNumericRange(ids)) {
    return ids.length > NUMERIC_CONTROL_CEILING ? 'magnitude' : 'control_selector';
  }

  return 'control_selector';
}

/**
 * Whether a dropdown's option ids form an unbroken run of integers.
 *
 * This is what separates a magnitude (1..255 brightness steps, collapsed to a
 * single numeric binding) from a control selector (button 1, 2, 3, which must
 * stay distinct events).
 */
function isContiguousNumericRange(ids: string[]): boolean {
  if (ids.length < 2) return false;
  const numbers = ids.map(id => Number(id));
  if (numbers.some(n => !Number.isInteger(n))) return false;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
}

/**
 * The EXACT numeric values a dropdown offers, sorted and de-duplicated, or null
 * if any option is not a finite number.
 *
 * Not `[min, max]`. The endpoints are the same for {1, 2, 3} and for {1, 3}, and
 * expanding the second as a range invents a flow whose trigger asks for a value
 * the card does not accept — `createFlow` refuses it with a 404 that reads like a
 * permission problem. It also could not express a decimal set at all: {0.5, 1.0}
 * walked as integers is one variant, at 0.5.
 *
 * Sorted so the compiled flows come out in a stable order, and de-duplicated
 * because a repeated option is one value, not two flows.
 */
export function numericValuesOf(arg: CardArgument): number[] | null {
  const ids = (arg.values ?? []).map(v => Number(v.id));
  if (!ids.length || ids.some(n => !Number.isFinite(n))) return null;
  return [...new Set(ids)].sort((a, b) => a - b);
}

export type Direction = -1 | 1;

/**
 * Map a direction value id onto a signed direction, or null for "either",
 * which is not a usable direction — binding "either way" to Brighter would
 * make turning the dial left brighten the lights.
 */
export function directionOf(valueId: string): Direction | null {
  const id = valueId.toLowerCase().replace(/[\s_-]/g, '');
  if (/^(cw|clockwise|right|up|increase|forward|next)$/.test(id)) return 1;
  if (/^(ccw|counterclockwise|anticlockwise|left|down|decrease|backward|previous|prev)$/.test(id)) return -1;
  return null;
}

/**
 * Collapse a set of already-built keys so that entries differing only by a
 * magnitude component become one. Defence in depth: classification above
 * should prevent magnitude ever reaching the picker, but a vendor can always
 * ship a card shape nobody anticipated, and a duplicated picker entry is a
 * visible bug where a silently dropped one is not.
 */
export function dedupeByKey<T extends { key: string }>(
  items: T[],
): { kept: T[]; collisions: T[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const collisions: T[] = [];
  for (const item of items) {
    if (seen.has(item.key)) {
      // Reported rather than dropped in silence. A key is what a MappingRule
      // stores, so two inputs sharing one means the second can never be mapped
      // and never be diagnosed — the picker shows one row where the remote has
      // two gestures, with nothing anywhere saying which was lost.
      collisions.push(item);
      continue;
    }
    seen.add(item.key);
    kept.push(item);
  }
  return { kept, collisions };
}
