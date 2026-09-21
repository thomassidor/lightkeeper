import type { PairSessionHost, HandlerRegistrar } from './pair-session';

/**
 * The two screens every flow now opens and closes with, as data.
 *
 * `intro.html` and `review.html` are ONE file each, shared by all five drivers
 * the way the light picker and the credential screen already are (platform §8).
 * That only works if everything driver-specific arrives in the payload — so this
 * is where a driver says what its intro promises and what its review reads back,
 * and neither view knows which device type it is drawing.
 *
 * Both live in `lib/` rather than in the drivers for the reason the rest of
 * `lib/pairing/` does: a file containing `extends Homey.Driver` cannot be
 * imported by a test at all (platform §13), and these are the screens whose
 * wording is most worth a test.
 *
 * Everything user-facing here is a locale KEY resolved through the host, never a
 * string built in `lib/`. A string hardcoded here could never be translated, no
 * matter what the locale files say.
 */

/** One of the decisions the numbered steps are about to ask for. */
export interface IntroDecision {
  /** Locale key: the decision, in three or four words. */
  whatKey: string;
  /** Locale key: why it is being asked, in one line. */
  whyKey: string;
}

export interface IntroScreen {
  titleKey: string;
  blurbKey: string;
  /** Which of the five pictures to draw. See `intro.html` for the renderers. */
  hero: 'day' | 'curve' | 'daylight' | 'schedule' | 'remote';
  decisions: IntroDecision[];
  /** The first numbered step. The intro itself carries no dot. */
  nextView: string;
}

/**
 * The intro's one handler.
 *
 * Read-only and stateless: nothing on this screen can be changed, which is why
 * it has no setter and why it is safe for it to be the one screen a returning
 * user might want to skip.
 */
export function registerIntroHandler(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  screen: IntroScreen,
): void {
  handler('getIntro', async () => ({
    title: host.translate(screen.titleKey),
    blurb: host.translate(screen.blurbKey),
    hero: screen.hero,
    decisions: screen.decisions.map(decision => ({
      what: host.translate(decision.whatKey),
      why: host.translate(decision.whyKey),
    })),
    nextView: screen.nextView,
  }));
}

/** One line of the readback. */
export interface ReviewRow {
  /** Locale key for the label. */
  labelKey: string;
  /** Already-resolved text — a lamp's name, a time, a count. Not a key. */
  value: string;
  /**
   * The step that owns this value, or absent for a row that only reports.
   *
   * A chevron is a promise that something opens. A row with no view renders as
   * plain text rather than as a button that does nothing, which is the same rule
   * the rest of the app applies to a control that looks configured and is not.
   */
  view?: string;
}

/**
 * An optional picture of what was just configured, above the rows.
 *
 * Three shapes, and three of the five drivers send none: a list of rows IS the
 * review of a remote's buttons, and a picture invented for it would be
 * decoration. The view draws nothing at all when this is absent, rather than an
 * empty frame that reads as something which failed to load.
 */
export type ReviewHero =
  /** A band of colour across the day — the circadian light's own shape. */
  | { kind: 'strip'; stops: string[] }
  /** One bar per hour, height for brightness and colour for colour. */
  | { kind: 'bars'; bars: Array<{ color: string; height: number }> }
  /** What the device would do RIGHT NOW, which is checkable against the room. */
  | { kind: 'now'; percent: string; detail: string }
  /**
   * The day, with this schedule's blocks on it. Percentages of the 24 hours,
   * so the view needs no clock arithmetic of its own — and a block crossing
   * midnight arrives as TWO entries, for the same reason `blocks.html` draws it
   * as two bars: a bar that wrapped would have to be drawn from the right edge
   * backwards, which is not a thing CSS does.
   */
  | { kind: 'timeline'; blocks: Array<{ left: number; width: number }> };

/**
 * The six stops the day strip is painted from, coolest to warmest.
 *
 * The same six the circadian day screen interpolates between, and they are
 * DUPLICATED there on purpose: that screen recomputes the whole gradient on
 * every pointer move while a boundary is dragged, so it cannot ask the driver
 * for it. Change one and change the other — `#dy-root`'s `STOPS` in
 * `drivers/circadian/pair/day.html`.
 */
const WARMTH_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [219, 232, 251]], [0.2, [234, 240, 251]], [0.4, [242, 230, 214]],
  [0.6, [244, 198, 138]], [0.8, [239, 166, 88]], [1, [232, 137, 44]],
];

/** A warmth on homey-lib's axis as something a browser will paint (platform §6). */
export function warmthSwatch(value: number): string {
  const v = Math.max(0, Math.min(1, value));
  let a = WARMTH_STOPS[0]!;
  let b = WARMTH_STOPS[WARMTH_STOPS.length - 1]!;
  for (let i = 0; i < WARMTH_STOPS.length - 1; i += 1) {
    if (v >= WARMTH_STOPS[i]![0] && v <= WARMTH_STOPS[i + 1]![0]) {
      a = WARMTH_STOPS[i]!;
      b = WARMTH_STOPS[i + 1]!;
      break;
    }
  }
  const f = (v - a[0]) / ((b[0] - a[0]) || 1);
  const channel = (i: 0 | 1 | 2) => Math.round(a[1][i] + (b[1][i] - a[1][i]) * f);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

/**
 * A palette colour as something a browser will paint.
 *
 * Two curves, and both are there because a swatch is judged ON WHITE while the
 * colour it stands for is judged in a room:
 *
 *  - **Lightness falls as saturation rises**, so a saturated hue reads as a
 *    colour rather than as a pastel.
 *  - **Saturation is lifted off zero**, because Homey's `light_saturation` for
 *    a near-white is 0.05 and `hsl(36, 5%, …)` is grey. The two whites in the
 *    palette are near-white HUES; drawn at their stored saturation they came
 *    out as two indistinguishable greys, and the screen whose job is to show
 *    that this device does colour opened with a row of them.
 *
 * DUPLICATED in `css()` in drivers/curve/pair/curve.html, which repaints the
 * chart on every drag and so cannot ask the driver. Change one and change the
 * other.
 */
export function colourSwatch(colour: { hue: number; saturation: number }): string {
  const saturation = Math.round((0.25 + colour.saturation * 0.55) * 100);
  const lightness = Math.round(86 - colour.saturation * 36);
  return `hsl(${Math.round(colour.hue * 360)},${saturation}%,${lightness}%)`;
}

export interface ReviewScreen {
  stepIndex: number;
  stepCount: number;
  rows: ReviewRow[];
  hero?: ReviewHero;
  /**
   * Locale key for the sentence under the rows: what the device will do, in the
   * present tense, naming how many lights. It is the promise the Add button is
   * about to keep, so it is stated before the button rather than after it.
   */
  promiseKey: string;
  promiseTokens?: Record<string, string | number>;
}

export function registerReviewHandler(
  host: PairSessionHost,
  handler: HandlerRegistrar,
  build: () => Promise<ReviewScreen> | ReviewScreen,
): void {
  handler('getReview', async () => {
    const screen = await build();
    return {
      stepIndex: screen.stepIndex,
      stepCount: screen.stepCount,
      rows: screen.rows.map(row => ({
        label: host.translate(row.labelKey),
        value: row.value,
        ...(row.view !== undefined ? { view: row.view } : {}),
      })),
      promise: host.translate(screen.promiseKey, screen.promiseTokens),
      ...(screen.hero !== undefined ? { hero: screen.hero } : {}),
    };
  });
}

/**
 * A colour temperature as a WORD, for a readback.
 *
 * "Soft warm" is what the slider said; 0.62 is not. A review screen that showed
 * the number would be reporting something the user never saw, which is the
 * opposite of what a readback is for.
 *
 * Five bands rather than a continuum, and the boundaries are the design
 * canvas's own: they are where the names stop describing what you would see.
 * Returns a locale KEY, because a word built in `lib/` could never be
 * translated.
 */
export function warmthKey(value: number): string {
  /**
   * HIGH is warm, and this is the one line in this file most worth reading
   * twice.
   *
   * `warmth` is the normalised colour-temperature axis where 1 is the WARMEST
   * end — not a convention this app chose, but homey-lib's own ("a higher value
   * means a warmer color"). Getting it backwards is what once shipped a schedule
   * set to "Warmest" that wrote 0 and lit a room cold white at bedtime
   * (platform §6), and the first render of the day screen had this ladder
   * inverted: midday at 0.18 read "Warm" beside a blue swatch.
   */
  if (value >= 0.82) return 'warmth.deepAmber';
  if (value >= 0.62) return 'warmth.warm';
  if (value >= 0.44) return 'warmth.softWarm';
  if (value >= 0.24) return 'warmth.softWhite';
  return 'warmth.coolWhite';
}

/**
 * What the review's Lights row reads back — and WHICH of the two shapes the
 * picker stored.
 *
 * "4 in Kitchen" and "4 picked" behave differently the next time somebody adds
 * a lamp to that room, and this line is the only place that difference is ever
 * visible. `lights.html` deliberately does not show it: making the picker
 * explain its own storage would be a control nobody asked for, on the screen
 * least able to afford one.
 *
 * Here rather than in each driver because it was in ALL FIVE of them, character
 * for character — so a wording change was five edits, and the count that the
 * room shape now carries would have been five more.
 */
export async function lightsSummary(
  host: PairSessionHost,
  target: { kind: string; zoneId?: string },
  summary: { count: number },
  allZones: () => Promise<Array<{ id: string; name?: string }>>,
): Promise<string> {
  if (target.kind === 'zone') {
    const zones = await allZones();
    const zone = zones.find(candidate => candidate.id === target.zoneId);
    // The count belongs on this line as much as the room does: "Everything in
    // Garden" is a rule and says nothing about tonight, whereas "4 in Garden"
    // is the rule AND how many lamps it currently reaches — which is the number
    // the promise sentence below it counts.
    return host.translate('review.wholeRoom', { count: summary.count, room: zone?.name ?? '?' });
  }
  return host.translate('review.someLights', { count: summary.count });
}
