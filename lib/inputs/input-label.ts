/**
 * A remote's gesture label — "Dial — Turn right" — in the user's language.
 *
 * The normalizer builds every label in English, and that English is STORED: it
 * is in each profile's catalogue, and it is part of every generated Flow's name
 * ("Lightkeeper — Hall remote: Dial — Turn right"), which cannot be renamed
 * without reading as a user's edit (docs/localisation.md). So the stored label
 * stays English, and the screens translate it on the way out.
 *
 * Translated by PARSING rather than by storing parts beside the label, for two
 * reasons: every profile paired before this change has only the label, and the
 * vocabulary is closed — the normalizer composes a label from exactly the words
 * below and the vendor's own wording, never anything else. The words are
 * exported and the normalizer builds from them, so the two cannot drift, and
 * `input-label.test.ts` round-trips every label the reference remotes produce.
 *
 * Anything that is not one of our words is the vendor's ("1 up rotary",
 * "Scroll up") and passes through untouched — it is already in whatever
 * language the integration speaks.
 */

/** The generic control names, when the card gives none of its own. */
export const CONTROL_WORDS = { dial: 'Dial', button: 'Button', control: 'Control' } as const;

/** What each gesture is called in English, keyed by its locale key. */
export const GESTURE_WORDS = {
  press: 'Press',
  longPress: 'Long press',
  release: 'Release',
  turnRight: 'Turn right',
  turnLeft: 'Turn left',
  turn: 'Turn',
  startTurning: 'Start turning',
  stopTurning: 'Stop turning',
  select: 'Select',
} as const;

/** A direction appended to a gesture whose own word does not carry one. */
export const DIRECTION_WORDS = { up: 'up', down: 'down' } as const;

/** Between the control and the action, in the stored English label. */
export const LABEL_SEPARATOR = ' — ';

type Translate = (key: string, tokens?: Record<string, string | number>) => string;

const byWord = <T extends Record<string, string>>(table: T) =>
  new Map(Object.entries(table).map(([key, word]) => [word, key] as const));

const GESTURE_BY_WORD = byWord(GESTURE_WORDS);
const DIRECTION_BY_WORD = byWord(DIRECTION_WORDS);

/** "Dial", "Dial 1", or the vendor's own name. */
function localiseControl(control: string, translate: Translate): string {
  for (const [key, word] of Object.entries(CONTROL_WORDS)) {
    if (control === word) return translate(`input.control.${key}`);
    // "Dial 1": our word, then the selector value's own title.
    if (control.startsWith(`${word} `)) {
      return translate('input.controlNamed', {
        control: translate(`input.control.${key}`),
        name: control.slice(word.length + 1),
      });
    }
  }
  return control;
}

/** "Press", "Press up", "up", or — when it is none of ours — itself. */
function localiseAction(action: string, translate: Translate): string {
  const gesture = GESTURE_BY_WORD.get(action);
  if (gesture) return translate(`input.gesture.${gesture}`);

  const direction = DIRECTION_BY_WORD.get(action);
  if (direction) return translate(`input.direction.${direction}`);

  const space = action.lastIndexOf(' ');
  if (space > 0) {
    const head = GESTURE_BY_WORD.get(action.slice(0, space));
    const tail = DIRECTION_BY_WORD.get(action.slice(space + 1));
    if (head && tail) {
      return translate('input.gestureDirection', {
        gesture: translate(`input.gesture.${head}`),
        direction: translate(`input.direction.${tail}`),
      });
    }
  }
  return action;
}

/**
 * The two halves of a stored label, translated. `action` is '' for a label
 * that is a control alone ("1 up rotary"), which is how the screens tell.
 */
export function localiseInputLabel(label: string, translate: Translate): { control: string; action: string } {
  const at = label.indexOf(LABEL_SEPARATOR);
  if (at === -1) return { control: localiseControl(label, translate), action: '' };
  return {
    control: localiseControl(label.slice(0, at), translate),
    action: localiseAction(label.slice(at + LABEL_SEPARATOR.length), translate),
  };
}

/** The whole label on one line — "Dial · Turn right" — in the user's language. */
export function localisedInputLine(label: string, translate: Translate): string {
  const { control, action } = localiseInputLabel(label, translate);
  return action === '' ? control : translate('input.line', { control, action });
}
