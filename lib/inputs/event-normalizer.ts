import type { InputAction } from './input-event';
import type { LogicalSourceBinding, SelectableInput } from './selectable-input';
import {
  type CardArgument,
  classifyArgument,
  dedupeByKey,
  directionOf,
  numericRangeOf,
} from './magnitude-collapser';

export interface CardToken {
  /** Token identity is `id`, not `name` — using `name` produces broken flows. */
  id: string;
  type: string;
  title?: unknown;
}

/** A trigger card resolved as belonging to a source device. */
export interface DiscoveredTriggerCard {
  /** Full id, e.g. homey:device:<uuid>:tapdial_button_pressed */
  id: string;
  /** Trailing segment, e.g. tapdial_button_pressed */
  shortId: string;
  uri: string;
  title: string;
  args: CardArgument[];
  tokens: CardToken[];
}

/**
 * Cards that report state rather than input. Every device carries a pile of
 * these (battery thresholds, alarms, "changed" events) and they are not
 * gestures — offering them as remote controls would be nonsense.
 */
const STATE_CARD = /^(measure_|alarm_|meter_)|_threshold_|_changed$|_duration$/;

/** Distinguish a hold from a press from a release, by id and by title. */
// Separators matter: real titles say "long pressed" with a space while card ids
// say "long_press". Matching only the underscore form silently demoted every
// STYRBAR hold to a press, which would have made the supersede gate dead code.
const LONG_PRESS = /(long[\s_]?press|held|hold)/i;
const RELEASE = /(release[sd]?|let[\s_]?go)/i;
const ROTATE_STOP = /(rotation[\s_]?stopped|stops?[\s_]?rotating|rotate[\s_]?stop)/i;
const ROTATE_START = /(rotation[\s_]?started|rotated|rotate[\s_]?start|rotation[\s_]?dimmed|dimmed)/i;
const PRESS = /(press(ed)?|click(ed)?|push(ed)?|tap(ped)?)/i;

/**
 * Titles from real integrations follow "<Control> was <action>", e.g.
 * "Higher brightness was long pressed", "Left button was pressed". Splitting
 * on that gives a stable control identity that groups a press and its
 * long-press onto ONE physical control — which is exactly what the supersede
 * gate needs in order to know a control carries both.
 */
const TITLE_CONTROL = /^(.*?)\s+(?:was|is|has been|stops?|starts?)\b/i;

export interface NormalizeOptions {
  sourceDeviceId: string;
  /** Beyond this many variants a control is marked unsupported. */
  rangeExpansionCeiling?: number;
}

export interface NormalizeResult {
  inputs: SelectableInput[];
  /** Controls declined, with the reason — surfaced in diagnostics. */
  rejected: Array<{ cardId: string; reason: string }>;
}

const DEFAULT_RANGE_CEILING = 12;

export function normalizeCards(
  cards: DiscoveredTriggerCard[],
  options: NormalizeOptions,
): NormalizeResult {
  const inputs: SelectableInput[] = [];
  const rejected: Array<{ cardId: string; reason: string }> = [];
  const ceiling = options.rangeExpansionCeiling ?? DEFAULT_RANGE_CEILING;

  for (const card of cards) {
    if (STATE_CARD.test(card.shortId)) continue;

    const roles = card.args.map(arg => ({ arg, role: classifyArgument(arg) }));

    if (roles.some(r => r.role === 'unsupported')) {
      rejected.push({
        cardId: card.id,
        reason: `argument "${roles.find(r => r.role === 'unsupported')!.arg.name}" is not enumerable`,
      });
      continue;
    }
    if (roles.some(r => r.role === 'numeric_open')) {
      rejected.push({
        cardId: card.id,
        reason: 'free numeric argument — no fixed set of values to offer as events',
      });
      continue;
    }

    const action = actionOf(card);
    if (!action) {
      rejected.push({ cardId: card.id, reason: 'could not determine gesture semantics' });
      continue;
    }

    const selector = roles.find(r => r.role === 'control_selector');
    const direction = roles.find(r => r.role === 'direction');
    const magnitude = roles.find(r => r.role === 'magnitude');

    // Range expansion is bounded: silently generating fifty flows is
    // worse than declining.
    if (magnitude) {
      const range = numericRangeOf(magnitude.arg);
      const variants = range ? range[1] - range[0] + 1 : Number.MAX_SAFE_INTEGER;
      if (variants > ceiling) {
        rejected.push({
          cardId: card.id,
          reason: `magnitude argument "${magnitude.arg.name}" would need ${variants} flow variants, above the ceiling of ${ceiling}`,
        });
        continue;
      }
    }

    // A rotation with no resolvable direction cannot drive Brighter or Dimmer —
    // "Dial — Turn" is not something a user can map. Mark it unsupported
    // rather than guess. (Tap Dial's rotation_dimmed lands here; it reports an
    // absolute level, which belongs to "Set brightness" and is not offered.)
    const isRotation = action === 'rotate_delta' || action === 'rotate_start' || action === 'rotate_stop';
    const hasUsableDirection = direction
      && (direction.arg.values ?? []).some(v => directionOf(String(v.id)) !== null);
    if (isRotation && !hasUsableDirection) {
      rejected.push({
        cardId: card.id,
        reason: 'rotation without a resolvable direction — cannot drive a directional function',
      });
      continue;
    }

    const tokenMagnitude = card.tokens.find(t => t.type === 'number');
    const carriesMagnitude = Boolean(magnitude || tokenMagnitude);

    const built = buildSelectables({
      card, action, selector, direction, magnitude, tokenMagnitude, carriesMagnitude,
      sourceDeviceId: options.sourceDeviceId,
    });

    inputs.push(...built);
  }

  const { kept, dropped } = collapseSemanticDuplicates(dedupeByKey(inputs));
  for (const d of dropped) {
    rejected.push({ cardId: d.key, reason: `duplicate gesture, superseded by ${d.inFavourOf}` });
  }

  return { inputs: kept, rejected };
}

interface BuildContext {
  card: DiscoveredTriggerCard;
  action: InputAction;
  selector?: { arg: CardArgument };
  direction?: { arg: CardArgument };
  magnitude?: { arg: CardArgument };
  tokenMagnitude?: CardToken;
  carriesMagnitude: boolean;
  sourceDeviceId: string;
}

function buildSelectables(ctx: BuildContext): SelectableInput[] {
  const { card, action, selector, direction, magnitude, tokenMagnitude } = ctx;
  const out: SelectableInput[] = [];

  const baseControl = controlIdentityOf(card, action);
  const perTurn = magnitudePerTurnOf(tokenMagnitude);

  // Direction values become directional variants of ONE control (the dial),
  // never separate controls.
  const directionValues = direction
    ? (direction.arg.values ?? []).map(v => ({ id: String(v.id), dir: directionOf(String(v.id)) }))
      .filter(v => v.dir !== null)
    : [null];

  // Control-selector values become separate controls. The value's own TITLE is
  // the integration's human name for that control — "Scroll up", not "1" — so
  // prefer it over anything derived from the id. This is the difference between
  // a picker that reads like the remote in your hand and one full of numbers.
  const selectorValues = selector
    ? (selector.arg.values ?? []).map(v => ({ id: String(v.id), title: titleTextOf(v.title) }))
    : [null];

  for (const selectorValue of selectorValues) {
    for (const dirValue of directionValues) {
      const controlId = selectorValue !== null
        ? `${baseControl.id}:${selectorValue.id}`
        : baseControl.id;

      const valueLabel = selectorValue === null
        ? null
        : selectorValue.title ?? humanise(selectorValue.id);

      // When the card gave no identity of its own ("A button is pressed"), the
      // selector value IS the control name — "On", not "Button On".
      const controlLabel = valueLabel === null
        ? baseControl.label
        : isGenericBase(baseControl.id)
          ? valueLabel
          : `${baseControl.label} ${valueLabel}`;

      // Where the integration's own name already describes the gesture — IKEA
      // BILRESA labels its wheel positions "1 up rotary" — appending "Press"
      // produces "1 up rotary — Press", which reads as a contradiction. Trust
      // the vendor's wording and leave the action off.
      const gestureNamed = valueLabel !== null && GESTURE_IN_NAME.test(valueLabel);
      const label = gestureNamed
        ? controlLabel
        : `${controlLabel} — ${actionLabel(action, dirValue?.dir ?? undefined)}`;

      const binding = bindingFor(ctx, selectorValue?.id ?? null, dirValue?.id ?? null, magnitude, tokenMagnitude);

      out.push({
        key: keyFor(card, selectorValue?.id ?? null, dirValue?.id ?? null, action),
        controlId,
        label,
        action,
        ...(dirValue?.dir !== undefined && dirValue?.dir !== null ? { direction: dirValue.dir } : {}),
        carriesMagnitude: ctx.carriesMagnitude,
        ...(perTurn !== undefined ? { magnitudePerTurn: perTurn } : {}),
        binding,
      });
    }
  }

  return out;
}

function bindingFor(
  ctx: BuildContext,
  selectorValue: string | null,
  directionValue: string | null,
  magnitude?: { arg: CardArgument },
  tokenMagnitude?: CardToken,
): LogicalSourceBinding {
  const { card, selector, direction } = ctx;

  const args: Record<string, unknown> = {};
  if (selector && selectorValue !== null) args[selector.arg.name] = selectorValue;
  if (direction && directionValue !== null) args[direction.arg.name] = directionValue;

  // A number token carries the amount — the token bridge card handles it.
  if (tokenMagnitude) {
    return {
      kind: 'flow_token',
      cardId: card.id,
      cardOwnerUri: card.uri,
      args,
      tokenId: tokenMagnitude.id,
    };
  }

  // A fixed enum magnitude means one flow per value, each passing its own
  // literal amount to the numeric bridge card (range expansion).
  if (magnitude) {
    const range = numericRangeOf(magnitude.arg) ?? [1, 1];
    return {
      kind: 'flow_range',
      cardId: card.id,
      cardOwnerUri: card.uri,
      argument: magnitude.arg.name,
      valueRange: range,
    };
  }

  if (selector && selectorValue !== null && !direction) {
    return {
      kind: 'flow_enum',
      cardId: card.id,
      cardOwnerUri: card.uri,
      argument: selector.arg.name,
      value: selectorValue,
    };
  }

  return {
    kind: 'flow_fixed',
    cardId: card.id,
    cardOwnerUri: card.uri,
    args,
  };
}

/** Stable across restarts and re-discovery — it is persisted in the profile. */
function keyFor(
  card: DiscoveredTriggerCard,
  selectorValue: string | null,
  directionValue: string | null,
  action: InputAction,
): string {
  return [card.shortId, selectorValue, directionValue, action]
    .filter(part => part !== null && part !== undefined)
    .join('|');
}

const ROTARY_HINT = /dial|wheel|knob|rotat|scroll/i;

/**
 * A control name that already states the gesture. Appending an action to these
 * yields nonsense like "1 up rotary — Press".
 */
const GESTURE_IN_NAME = /rotar|rotat|scroll|turn|dial|wheel|swipe|slide/i;

/**
 * Which gesture a trigger card represents, read from its short id and title.
 *
 * Returns null when the card is not a recognisable input — that is a normal
 * outcome, not a failure, and the caller records it as a rejection so the
 * pairing UI can say what it declined and why.
 */
export function actionOf(card: DiscoveredTriggerCard): InputAction | null {
  const haystack = `${card.shortId} ${card.title}`;

  // Order matters: "long pressed" also matches /press/, and a rotation card
  // titled "Dial stops rotating" must not be read as a release.
  if (ROTATE_STOP.test(haystack)) return 'rotate_stop';
  if (LONG_PRESS.test(haystack)) return 'long_press';
  if (ROTATE_START.test(haystack)) return 'rotate_start';
  if (RELEASE.test(haystack)) return 'release';
  if (PRESS.test(haystack)) return 'press';
  return null;
}

/**
 * Identity of the physical control.
 *
 * Grouping matters more than prettiness: a press and its long-press MUST land
 * on the same controlId, because that is how the supersede gate knows a
 * control carries both and needs the 250 ms window.
 */
export function controlIdentityOf(
  card: DiscoveredTriggerCard,
  action?: InputAction,
): { id: string; label: string } {
  // Rotary identity follows the GESTURE, not the card name. Matching the name
  // alone made "tapdial_button_pressed" a dial, because the vendor prefix
  // happens to contain "dial" — four buttons vanished into the dial control.
  const isRotation = action === 'rotate_delta' || action === 'rotate_start' || action === 'rotate_stop';
  if (isRotation || (action === undefined && ROTARY_HINT.test(card.title ?? ''))) {
    return { id: 'dial', label: 'Dial' };
  }

  const match = TITLE_CONTROL.exec(card.title ?? '');
  if (match?.[1]) {
    const label = match[1].trim();
    // "A button", "The switch" carry no identity of their own — the selector
    // argument supplies it, so fall back to a generic base.
    if (!/^(a|an|the)\s/i.test(label)) {
      return { id: slug(label), label: capitalise(label) };
    }
    return { id: 'button', label: 'Button' };
  }

  const stripped = card.shortId
    .replace(/_(multi|press|pressed|long_press2?|click|clicked|released?|start(ed)?|stopp?(ed)?)$/g, '')
    .replace(/_/g, ' ')
    .trim();

  const label = stripped.length ? capitalise(stripped) : 'Control';
  return { id: slug(label), label };
}

/** True when the control identity came from a selector argument, not the card. */
function isGenericBase(id: string): boolean {
  return id === 'button' || id === 'control';
}

/**
 * Rotation cards overlap: a Tap Dial exposes rotation_started (direction only)
 * AND rotation_stopped (direction plus a `steps` token). Both would render as
 * "Dial — Turn right", which is wrong: one user-meaningful gesture, one
 * entry. Collapse them, preferring the variant that carries magnitude — losing
 * magnitude would turn a proportional dimmer into a fixed step.
 */
function collapseSemanticDuplicates(
  inputs: SelectableInput[],
): { kept: SelectableInput[]; dropped: Array<{ key: string; inFavourOf: string }> } {
  const best = new Map<string, SelectableInput>();
  const dropped: Array<{ key: string; inFavourOf: string }> = [];

  for (const input of inputs) {
    const semantic = [input.controlId, semanticClass(input.action), input.direction ?? ''].join('|');
    const incumbent = best.get(semantic);
    if (!incumbent) {
      best.set(semantic, input);
      continue;
    }
    const winner = preferred(incumbent, input);
    const loser = winner === incumbent ? input : incumbent;
    best.set(semantic, winner);
    dropped.push({ key: loser.key, inFavourOf: winner.key });
  }

  return { kept: [...best.values()], dropped };
}

function semanticClass(action: InputAction): string {
  switch (action) {
    case 'rotate_delta':
    case 'rotate_start':
    case 'rotate_stop':
      return 'rotate';
    case 'press':
    case 'selection':
      return 'press';
    default:
      return action;
  }
}

/**
 * Preference order, most significant first:
 *  1. carries magnitude — never trade a proportional dimmer for a fixed step
 *  2. fires on press-down rather than on release — lower perceived latency
 *  3. stable by key, so discovery is deterministic across runs
 */
function preferred(a: SelectableInput, b: SelectableInput): SelectableInput {
  if (a.carriesMagnitude !== b.carriesMagnitude) return a.carriesMagnitude ? a : b;

  const aInitial = /initial/.test(a.key);
  const bInitial = /initial/.test(b.key);
  if (aInitial !== bInitial) return aInitial ? a : b;

  return a.key <= b.key ? a : b;
}

function actionLabel(action: InputAction, direction?: -1 | 1): string {
  switch (action) {
    case 'press': return 'Press';
    case 'long_press': return 'Long press';
    case 'release': return 'Release';
    case 'rotate_delta': return direction === 1 ? 'Turn right' : direction === -1 ? 'Turn left' : 'Turn';
    case 'rotate_start': return 'Start turning';
    case 'rotate_stop': return direction === 1 ? 'Turn right' : direction === -1 ? 'Turn left' : 'Stop turning';
    case 'selection': return 'Select';
  }
}

/**
 * Units per full turn, read from a token's own title — "Steps (1000/turn)".
 * Without this a raw step count is meaningless as a brightness delta.
 */
export function magnitudePerTurnOf(token: { title?: unknown } | undefined): number | undefined {
  const title = titleTextOf(token?.title);
  if (!title) return undefined;
  const match = /(\d+)\s*(?:\/|per\s+)\s*turn/i.exec(title);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 1 ? value : undefined;
}

/** Locale objects arrive as { en: "..." }; plain strings pass through. */
export function titleTextOf(title: unknown): string | null {
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (title && typeof title === 'object') {
    const en = (title as Record<string, unknown>).en;
    if (typeof en === 'string' && en.trim()) return en.trim();
  }
  return null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function humanise(value: string): string {
  if (/^\d+$/.test(value)) return `Button ${value}`;
  return value
    // "button1" reads better as "Button 1".
    .replace(/^([a-z]+)(\d+)$/i, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, c => c.toUpperCase());
}
