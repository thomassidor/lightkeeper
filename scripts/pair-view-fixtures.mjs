/**
 * What each pairing view is answered with when it is RENDERED for a look.
 *
 * `test/unit/pair-view-boot.test.ts` has its own minimal replies, and they are
 * minimal on purpose: what that test proves is that a view reaches its first
 * `emit()` without throwing, and empty lists prove it just as well as full ones.
 *
 * These are the opposite. They exist so `scripts/render-views.mjs` can produce a
 * contact sheet somebody actually looks at, and a screen rendered from empty
 * lists shows nothing worth looking at — no rooms, no grid, no swatches. So this
 * is demo data: a plausible household, in enough detail that every control on
 * every screen is drawn at least once.
 *
 * `test/unit/pair-view-render-fixtures.test.ts` discovers the views from disk and
 * fails if one has no entry here, so a new screen cannot quietly go unrendered.
 *
 * THREE views are one FILE and five SCREENS. `intro.html`, `lights.html` and
 * `review.html` are shared by every driver (platform §8) and differ entirely in
 * what the driver answers them with — a different picture, different rows,
 * a different number of steps. Keyed by file alone, the contact sheet drew the
 * circadian intro five times and the four other device types were never on it.
 * So `DRIVER_REPLIES` below is keyed `<driver>/<file>` and the renderer prefers
 * it; `RENDER_REPLIES` keeps one entry per file for everything else.
 *
 * Their text is RESOLVED from locales/en.json through the same keys the drivers
 * pass, rather than transcribed: a fixture that repeats a string is a fixture
 * that goes stale the first time the string is edited, silently, on the one
 * page whose whole job is to be looked at.
 */
import { readFileSync } from 'node:fs';

/**
 * Which language to resolve in: `--lang <code>`, the same flag render-views.mjs
 * takes, read here because this module's fixtures are built at import time.
 */
const LANG_AT = process.argv.indexOf('--lang');
export const RENDER_LANG = LANG_AT >= 0 ? String(process.argv[LANG_AT + 1]) : 'en';

const EN = JSON.parse(
  readFileSync(new URL(`../locales/${RENDER_LANG}.json`, import.meta.url), 'utf8'));

/**
 * `Homey.__`, near enough: a dotted key and `__token__` substitution — and the
 * plural step `lib/support/i18n.ts` adds, so a counted fixture reads as the
 * driver would send it.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [tokens]
 */
function say(key, tokens) {
  let node = EN;
  for (const part of key.split('.')) node = node?.[part];
  if (node && typeof node === 'object' && typeof tokens?.count === 'number') {
    const form = new Intl.PluralRules(RENDER_LANG).select(tokens.count);
    node = node[form] ?? node.other;
  }
  let text = typeof node === 'string' ? node : key;
  for (const [name, value] of Object.entries(tokens ?? {})) {
    text = text.split(`__${name}__`).join(String(value));
  }
  return text;
}

/**
 * The intro payload a driver builds, from the same keys its driver.ts passes.
 *
 * @param {string} titleKey
 * @param {string} blurbKey
 * @param {string} hero
 * @param {[string, string][]} decisions
 * @param {string} nextView
 */
function intro(titleKey, blurbKey, hero, decisions, nextView) {
  return {
    getIntro: {
      title: say(titleKey),
      blurb: say(blurbKey),
      hero,
      decisions: decisions.map(([whatKey, whyKey]) =>
        ({ what: say(whatKey), why: say(whyKey) })),
      nextView,
    },
  };
}

/**
 * The light picker, which differs per driver only in its subtitle and its place.
 *
 * @param {string} subtitleKey
 * @param {number} stepIndex
 * @param {number} stepCount
 * @param {string} nextView
 */
function picker(subtitleKey, stepIndex, stepCount, nextView) {
  return {
    listTargets: {
      rooms: ROOMS,
      zones: ROOMS.map(room => ({ id: room.zoneId, name: room.zoneName })),
      total: 54,
      current: { kind: 'devices', deviceIds: ['l1', 'l2'] },
      subtitle: say(subtitleKey),
      stepIndex,
      stepCount,
      nextView,
    },
    selectTargets: { count: 2, support: SUPPORT },
  };
}

/**
 * Lights the picker and every downstream screen agree about.
 *
 * `isLight` is what the picker marks a candidate with, and the last entry is
 * why the field is here: everything with `onoff` is offered, so a real house
 * puts sockets and fans in this list — three sockets, a fan, a dishwasher and a
 * NAS among 54 candidates on the reference Homey. The contact sheet has to show
 * the marker, or a screen that draws a dishwasher as a bulb looks correct in
 * review.
 */
const LIGHTS = [
  { id: 'l1', name: 'Ceiling', zoneName: 'Living room', capabilities: ['onoff', 'dim', 'light_temperature'], isLight: true, available: true, selected: true },
  { id: 'l2', name: 'Reading lamp', zoneName: 'Living room', capabilities: ['onoff', 'dim', 'light_temperature'], isLight: true, available: true, selected: true },
  { id: 'l3', name: 'Shelf strip', zoneName: 'Living room', capabilities: ['onoff', 'dim', 'light_hue'], isLight: true, available: true, selected: false },
  { id: 'l4', name: 'Corner uplight', zoneName: 'Living room', capabilities: ['onoff', 'dim'], isLight: true, available: false, selected: false },
  { id: 'p1', name: 'Dishwasher', zoneName: 'Living room', capabilities: ['onoff'], isLight: false, available: true, selected: false },
];

const SUPPORT = { onoff: 3, dim: 3, light_temperature: 2, light_hue: 2, total: 3 };
const TIMEZONE = 'Europe/Copenhagen';

/**
 * The whole palette, so the render shows the default ten AND what folds out.
 *
 * Hue and saturation are Homey's normalised axes, and `swatch` is the design's
 * own hex, which is what a selector paints. Copied from lib/circadian/palette.ts
 * with the labels resolved; `moss` is there and hidden, as it is on a Homey.
 */
const PALETTE = [
  { id: 'candle', label: 'Candlelight', hue: 0.082, saturation: 0.81, swatch: '#e8892c' },
  { id: 'amber', label: 'Warm amber', hue: 0.086, saturation: 0.632, swatch: '#efa658' },
  { id: 'warmwhite', label: 'Warm white', hue: 0.094, saturation: 0.434, swatch: '#f4c68a' },
  { id: 'neutral', label: 'Neutral white', hue: 0.095, saturation: 0.116, swatch: '#f2e6d6' },
  { id: 'coolwhite', label: 'Cool white', hue: 0.599, saturation: 0.127, swatch: '#dbe8fb' },
  { id: 'coral', label: 'Sunset coral', hue: 0.021, saturation: 0.719, swatch: '#e0533f' },
  { id: 'sunflower', label: 'Sunflower', hue: 0.142, saturation: 0.715, swatch: '#ddc63f' },
  { id: 'forest', label: 'Forest', hue: 0.37, saturation: 0.464, swatch: '#5aa86b' },
  { id: 'ocean', label: 'Ocean', hue: 0.569, saturation: 0.658, swatch: '#3f86b8' },
  { id: 'orchid', label: 'Orchid', hue: 0.8, saturation: 0.462, swatch: '#a763b8' },
  { id: 'crimson', label: 'Crimson', hue: 0.01, saturation: 0.761, swatch: '#b8342c' },
  { id: 'ember', label: 'Ember', hue: 0.034, saturation: 0.802, swatch: '#d94f2b' },
  { id: 'rose', label: 'Rose', hue: 0.944, saturation: 0.56, swatch: '#d85f88' },
  { id: 'blush', label: 'Blush', hue: 0.967, saturation: 0.417, swatch: '#f08ca0' },
  { id: 'peach', label: 'Peach', hue: 0.019, saturation: 0.282, swatch: '#f5b8b0' },
  { id: 'rust', label: 'Rust', hue: 0.071, saturation: 0.84, swatch: '#c2641f' },
  { id: 'apricot', label: 'Apricot', hue: 0.1, saturation: 0.741, swatch: '#e8a33c' },
  { id: 'gold', label: 'Gold', hue: 0.129, saturation: 0.612, swatch: '#e8c85a' },
  { id: 'butter', label: 'Butter', hue: 0.131, saturation: 0.492, swatch: '#f0d77a' },
  { id: 'cream', label: 'Cream', hue: 0.129, saturation: 0.287, swatch: '#f7e7b0' },
  { id: 'pine', label: 'Pine', hue: 0.404, saturation: 0.615, swatch: '#2f7a4f' },
  { id: 'leaf', label: 'Leaf', hue: 0.39, saturation: 0.5, swatch: '#4f9e6a' },
  { id: 'lime', label: 'Lime', hue: 0.225, saturation: 0.541, swatch: '#9fc45a' },
  { id: 'teal', label: 'Teal', hue: 0.489, saturation: 0.594, swatch: '#3f9b95' },
  { id: 'mint', label: 'Mint', hue: 0.382, saturation: 0.17, swatch: '#b9dfc4' },
  { id: 'navy', label: 'Navy', hue: 0.602, saturation: 0.696, swatch: '#2a4f8a' },
  { id: 'cobalt', label: 'Cobalt', hue: 0.62, saturation: 0.672, swatch: '#3f63c0' },
  { id: 'sky', label: 'Sky', hue: 0.566, saturation: 0.504, swatch: '#6fb3e0' },
  { id: 'ice', label: 'Ice blue', hue: 0.568, saturation: 0.223, swatch: '#bcdcf2' },
  { id: 'indigo', label: 'Indigo', hue: 0.716, saturation: 0.659, swatch: '#4a2f8a' },
  { id: 'iris', label: 'Iris', hue: 0.68, saturation: 0.582, swatch: '#5b52c4' },
  { id: 'violet', label: 'Violet', hue: 0.735, saturation: 0.589, swatch: '#7d4fc0' },
  { id: 'magenta', label: 'Magenta', hue: 0.891, saturation: 0.51, swatch: '#c25fa0' },
  { id: 'lavender', label: 'Lavender', hue: 0.758, saturation: 0.178, swatch: '#d9c2ec' },
  { id: 'moss', label: 'Moss', hue: 0.30, saturation: 0.45, hidden: true },
];

/** Where each swatch is drawn — `PALETTE_LAYOUT`, as `paletteForScreen()` sends it. */
const LAYOUT = {
  featured: ['candle', 'amber', 'warmwhite', 'neutral', 'coolwhite', 'coral', 'sunflower', 'forest', 'ocean', 'orchid'],
  more: ['crimson', 'ember', 'rose', 'blush', 'peach', 'rust', 'apricot', 'gold', 'butter', 'cream', 'pine', 'leaf', 'lime', 'teal', 'mint', 'navy', 'cobalt', 'ocean', 'sky', 'ice', 'indigo', 'iris', 'violet', 'magenta', 'lavender'],
};

/** A house with more rooms than fit on one screen, so the fold is drawn. */
const ROOMS = [
  { zoneId: 'z1', zoneName: 'Living room', lights: LIGHTS },
  { zoneId: 'z2', zoneName: 'Kitchen', lights: [
    { id: 'k1', name: 'Worktop', zoneName: 'Kitchen', capabilities: ['onoff', 'dim'], isLight: true, available: true, selected: false },
    { id: 'k2', name: 'Island', zoneName: 'Kitchen', capabilities: ['onoff', 'dim'], isLight: true, available: true, selected: false },
  ] },
  { zoneId: 'z3', zoneName: 'Bedroom', lights: [
    { id: 'b1', name: 'Bedside', zoneName: 'Bedroom', capabilities: ['onoff', 'dim'], isLight: true, available: true, selected: false },
  ] },
  { zoneId: 'z4', zoneName: 'Hallway', lights: [
    { id: 'h1', name: 'Hall ceiling', zoneName: 'Hallway', capabilities: ['onoff'], isLight: true, available: true, selected: false },
  ] },
];

/**
 * A week with an obvious day and night, plus two missing cells.
 *
 * The gaps matter to the render: a cell with no reading is drawn HATCHED rather
 * than dark, and a fixture with no gaps would never draw one — which is the
 * distinction the whole grid turns on.
 */
function week() {
  const cells = [];
  for (let row = 0; row < 7; row += 1) {
    const line = [];
    for (let column = 0; column < 12; column += 1) {
      const night = column <= 2 || column >= 10;
      const missing = row === 6 && column >= 10;
      line.push(missing ? null : (night ? 4 + column : 30 + column * 22));
    }
    cells.push(line);
  }
  return {
    cells,
    days: [1, 2, 3, 4, 5, 6, 7],
    covered: 82,
    low: 3,
    high: 280,
    lastAt: Date.now() - 12 * 60 * 1000,
    verdict: { kind: 'usable', nightLux: 6, noonLux: 150 },
    suggestion: { darkLux: 8, brightLux: 160 },
  };
}

const RESPONSE = {
  sensor: 's1',
  darkLux: 8,
  brightLux: 160,
  dark: 0.92,
  bright: 0.22,
  darkElevation: -6,
  brightElevation: 25,
  sunPeak: 'flat',
  transition: 'balanced',
};

const ZONES = {
  morning: { temperature: 0.78, brightness: 0.55 },
  midday: { temperature: 0.18, brightness: 0.9 },
  evening: { temperature: 0.86, brightness: 0.45 },
  morningEnd: 30,
  eveningStart: -60,
};

const BOUNDARIES = {
  morningEndMinute: 411,
  morningEnd: '06:51',
  eveningStartMinute: 1128,
  eveningStart: '18:48',
  fromSun: true,
};

/**
 * A day of the Colour Curve Light, one bar an hour, for the review's picture.
 *
 * The same twenty-four the design canvas draws, so the contact sheet and the
 * canvas can be held against each other without allowing for different data.
 */
const CURVE_BARS = [
  { color: '#a96ba9', height: 0.38 },
  { color: '#b06fa0', height: 0.39 },
  { color: '#b87595', height: 0.40 },
  { color: '#c17b8a', height: 0.41 },
  { color: '#ca817f', height: 0.42 },
  { color: '#d88c6d', height: 0.43 },
  { color: '#efa658', height: 0.44 },
  { color: '#f0bd8f', height: 0.52 },
  { color: '#e2e6f2', height: 0.68 },
  { color: '#dbe8fb', height: 0.80 },
  { color: '#dde5f1', height: 0.76 },
  { color: '#e2e2e8', height: 0.72 },
  { color: '#e8e0df', height: 0.69 },
  { color: '#eee3da', height: 0.66 },
  { color: '#f2e6d6', height: 0.64 },
  { color: '#edc9b6', height: 0.71 },
  { color: '#e8ab96', height: 0.78 },
  { color: '#e48376', height: 0.85 },
  { color: '#e26a58', height: 0.90 },
  { color: '#e0533f', height: 0.94 },
  { color: '#c85356', height: 0.76 },
  { color: '#b6567f', height: 0.58 },
  { color: '#ab5da0', height: 0.42 },
  { color: '#a763b8', height: 0.37 },
];

/** Four gestures, so the buttons screen shows both assigned and unassigned rows. */
const GESTURES = [
  { key: 'button.top|true', label: 'Top · Press' },
  { key: 'button.top|hold', label: 'Top · Long press' },
  { key: 'button.bottom|true', label: 'Bottom · Press' },
  { key: 'button.left|true', label: 'Left · Press' },
];

/** The lights a demo remote drives, and the two a demo button aims at. */
const RULE_LIGHTS = [
  { id: 'light-1', name: 'Floor lamp' },
  { id: 'light-2', name: 'Shelf strip' },
  { id: 'light-3', name: 'Reading lamp' },
];

/**
 * The palette as `paletteForScreen()` sends it: each colour with the CSS it is
 * painted in, which for a drawn colour is its own hex — so the job screen,
 * which paints from `swatch` alone, draws exactly what the other two do.
 */
const PALETTE_SWATCHES = PALETTE.map(colour => ({
  ...colour,
  swatch: colour.swatch ?? `hsl(${Math.round(colour.hue * 360)},`
    + `${Math.round((0.25 + colour.saturation * 0.55) * 100)}%,`
    + `${Math.round(86 - colour.saturation * 36)}%)`,
}));

/**
 * "How Lightkeeper controls your lights", as `reviewControl()` sends it.
 *
 * "Set lights before they turn on" chosen and already tested, so one render
 * shows the radio group, the unfolded option and both kinds of result row —
 * which is three of the design's five screenshots of this control at once.
 */
const CONTROL = {
  modes: ['after', 'before', 'none'],
  selected: 'before',
  lightCount: 2,
  tested: {
    fresh: true,
    restored: 2,
    lights: [{ name: 'Ceiling', ok: true }, { name: 'Reading lamp', ok: false }],
  },
};

export const RENDER_REPLIES = {
  // ---- shared by every driver --------------------------------------------
  'intro.html': {
    getIntro: {
      title: 'Warm at night, cool at noon',
      blurb: 'Your lights follow the sun instead of sitting at one colour all day.',
      hero: 'day',
      decisions: [
        { what: 'Which lights', why: 'Pick them by room' },
        { what: 'Morning, midday, evening', why: 'How warm each part of the day is, and how bright' },
        { what: 'Check it over', why: 'Everything is changeable later' },
      ],
      nextView: 'lights',
    },
  },

  'lights.html': {
    listTargets: {
      rooms: ROOMS,
      zones: ROOMS.map(room => ({ id: room.zoneId, name: room.zoneName })),
      total: 54,
      current: { kind: 'devices', deviceIds: ['l1', 'l2'] },
      subtitle: 'The lights this follows the day with.',
      stepIndex: 1,
      stepCount: 3,
      nextView: 'day',
    },
    selectTargets: { count: 2, support: SUPPORT },
  },

  'review.html': {
    getReview: {
      stepIndex: 3,
      stepCount: 3,
      rows: [
        { label: 'Lights', value: '2 picked', view: 'lights' },
        { label: 'Morning', value: 'Warm · 55%', view: 'day' },
        { label: 'Midday', value: 'Cool white · 90%', view: 'day' },
        { label: 'Evening', value: 'Deep amber · 45%', view: 'day' },
        { label: 'Follows the sun', value: '06:51 – 18:48', view: 'day' },
        { label: 'Transition', value: 'Balanced', view: 'day' },
      ],
      control: CONTROL,
      // The rows above are a circadian light's, so the hero is its day. Three
      // of the five drivers send none at all and the frame is then not drawn —
      // which this fixture cannot show, being one entry for one file.
      hero: {
        kind: 'strip',
        stops: [
          'rgb(239,166,88) 0%', 'rgb(242,230,214) 18%', 'rgb(234,240,251) 30%',
          'rgb(234,240,251) 62%', 'rgb(242,230,214) 74%', 'rgb(239,166,88) 88%',
          'rgb(239,166,88) 100%',
        ],
      },
    },
  },

  'credential.html': {
    // Deliberately NOT valid: a valid key makes this screen skip itself, and a
    // contact sheet of a screen that skipped itself shows nothing.
    getCredentialStatus: { present: false, valid: false, nextView: 'remote' },
  },

  // ---- circadian ----------------------------------------------------------
  'day.html': {
    getDay: {
      support: SUPPORT,
      lights: LIGHTS.slice(0, 2),
      zones: ZONES,
      // On, so the render shows the brightness slider as well as the switch.
      adjustBrightness: true,
      sun: { sunriseMinute: 381, sunsetMinute: 1188 },
      boundaries: BOUNDARIES,
      nextView: 'review',
      limits: { maxOffset: 150, offsetStep: 15, fallbackSunrise: 360, fallbackSunset: 1260 },
      timezone: TIMEZONE,
      transition: 'balanced',
    },
    setDay: {
      zones: ZONES, adjustBrightness: true, transition: 'balanced', corrected: [], boundaries: BOUNDARIES,
    },
  },

  'tryit.html': {
    getPreview: {
      // Samples of the engine, as getPreview sends them (every ten minutes in
      // the real payload; a few are enough to draw the same day).
      points: [
        { minute: 0, warmth: 0.82 },
        { minute: 200, warmth: 0.78 },
        { minute: 300, warmth: 0.74 },
        { minute: 411, warmth: 0.48 },
        { minute: 520, warmth: 0.22 },
        { minute: 620, warmth: 0.18 },
        { minute: 1040, warmth: 0.18 },
        { minute: 1128, warmth: 0.52 },
        { minute: 1220, warmth: 0.85 },
        { minute: 1300, warmth: 0.86 },
      ],
      boundaries: { morningEndMinute: 411, eveningStartMinute: 1128 },
      nowMinute: 1180,
    },
    previewAt: { writes: 2, skipped: 0, targets: [] },
    restorePreview: { restored: 2 },
  },

  // ---- curve --------------------------------------------------------------
  'curve.html': {
    getCurve: {
      support: SUPPORT,
      lights: LIGHTS.slice(0, 3),
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 390 }, warmth: 0.9, color: 'amber', brightness: 0.44 },
        { id: 'p2', anchor: { kind: 'clock', at: 540 }, warmth: 0.2, color: 'coolwhite', brightness: 0.8 },
        { id: 'p3', anchor: { kind: 'clock', at: 840 }, warmth: 0.4, color: 'neutral', brightness: 0.64 },
        { id: 'p4', anchor: { kind: 'clock', at: 1140 }, warmth: 0.75, color: 'coral', brightness: 0.94 },
        { id: 'p5', anchor: { kind: 'clock', at: 1350 }, warmth: 1, color: 'violet', brightness: 0.36 },
      ],
      palette: PALETTE,
      layout: LAYOUT,
      adjustBrightness: true,
      minPoints: 2,
      maxPoints: 8,
      timezone: TIMEZONE,
      transition: 'balanced',
    },
    setCurve: { count: 5, adjustBrightness: true, transition: 'balanced', dropped: [] },
  },

  // ---- daylight -----------------------------------------------------------
  'sensor.html': {
    listSensors: {
      rooms: [
        { zoneId: 'z1', zoneName: 'Kitchen', sensors: [
          { id: 's1', name: 'Kitchen motion', zoneName: 'Kitchen', lux: 41, at: Date.now() - 60_000, available: true, selected: true },
          { id: 's2', name: 'Window sensor', zoneName: 'Kitchen', lux: 1400, at: Date.now() - 90_000, available: true, selected: false },
        ] },
        { zoneId: 'z2', zoneName: 'Hall', sensors: [
          { id: 's3', name: 'Hall motion', zoneName: 'Hall', lux: 12, at: Date.now() - 3_600_000, available: true, selected: false },
          // Greyed rather than hidden: a dead sensor somebody expects to see is
          // then explained rather than missing.
          { id: 's4', name: 'Cupboard sensor', zoneName: 'Hall', lux: null, at: null, available: false, selected: false },
        ] },
        /**
         * The rest of the house, sensor or not.
         *
         * Which rooms have NO light sensor is half of what this screen answers,
         * and it is only answerable if those rooms are on the list saying so —
         * so the fixture carries a house rather than the two rooms that happen
         * to have one, and the folded list and its `none` rows are drawn.
         */
        { zoneId: 'z3', zoneName: 'Living room', sensors: [
          { id: 's5', name: 'Shelf sensor', zoneName: 'Living room', lux: 90, at: Date.now() - 400_000, available: true, selected: false },
        ] },
        { zoneId: 'z4', zoneName: 'Bedroom', sensors: [
          { id: 's6', name: 'Bedroom motion', zoneName: 'Bedroom', lux: 4, at: Date.now() - 7_200_000, available: true, selected: false },
        ] },
        { zoneId: 'z5', zoneName: 'Dining', sensors: [] },
        { zoneId: 'z6', zoneName: 'Landing', sensors: [] },
        { zoneId: 'z7', zoneName: 'Garden', sensors: [
          { id: 's7', name: 'Garden light sensor', zoneName: 'Garden', lux: 8200, at: Date.now() - 120_000, available: true, selected: false },
        ] },
        { zoneId: 'z8', zoneName: 'Basement', sensors: [] },
        { zoneId: 'z9', zoneName: '', unzoned: true, sensors: [] },
      ],
      selected: ['s1'],
      sky: { elevation: 18, level: 0.55, location: { latitude: 55.68, longitude: 12.57 } },
      sunsetAt: '19:48',
    },
    setSensor: { sensor: 's1' },
  },

  'response.html': {
    getResponse: {
      response: RESPONSE,
      sensorName: 'Kitchen motion',
      nowLux: 41,
      week: week(),
      staleFor: null,
      lastReport: null,
      atDark: '20:18',
      atBright: '12:04',
      /**
       * Today's sun. Null on the sensor path in the real payload, and present
       * here so a render of THIS screen can also be read against the sun
       * variant — the fixture serves both, and the view decides which card to
       * draw from `response.sensor` rather than from this.
       */
      sun: { elevation: 12.4, peak: 41.8, sunset: '19:48', now: '10:04' },
    },
    setDaylight: {
      response: RESPONSE,
      corrected: [],
      now: { level: 0.42, brightness: 0.63, source: 'sensors', elevation: 18 },
      atDark: '20:18',
      atBright: '12:04',
    },
    previewNow: { writes: 2, skipped: 0 },
  },

  // ---- schedule -----------------------------------------------------------
  'blocks.html': {
    getSchedule: {
      maxEntries: 12,
      support: SUPPORT,
      // The same closed set the curve screen draws from: a block picks a colour
      // rather than a warmth as of this release.
      palette: PALETTE_SWATCHES,
      layout: LAYOUT,
      lights: LIGHTS.slice(0, 2),
      entries: [
        // The SELECTED block, and it carries a brightness so the render draws
        // that control open rather than only its switch — the same reason the
        // day, curve and job fixtures set theirs.
        { id: 'a', onAt: 420, end: { kind: 'time', at: 520 }, brightness: 0.8 },
        { id: 'b', onAt: 1155, end: { kind: 'time', at: 1410 }, brightness: 0.2,
          temperature: 0.95, color: 'amber' },
        // Crosses midnight AND overlaps the one above, so the render draws both
        // the wrapped bar and the outlined conflict.
        { id: 'c', onAt: 1290, end: { kind: 'time', at: 60 } },
      ],
      days: [1, 2, 3, 4, 5],
      overlaps: [{ a: 'b', b: 'c' }],
      timezone: TIMEZONE,
    },
    setSchedules: {
      count: 3,
      dropped: [],
      days: [1, 2, 3, 4, 5],
      overlaps: [{ a: 'b', b: 'c' }],
    },
  },

  // ---- controller ---------------------------------------------------------
  'remote.html': {
    checkReattach: null,
    listSources: {
      rooms: [
        { zoneName: 'Hallway', sources: [
          { id: 'r1', name: 'Hall remote', ownerName: 'IKEA Trådfri', available: true, eventCount: 8 },
          { id: 'r2', name: 'Bedside dimmer', ownerName: 'Philips Hue', available: true, eventCount: 4 },
        ] },
        { zoneName: 'Kitchen', sources: [
          { id: 'r3', name: 'Kitchen button', ownerName: 'Aqara', available: false, eventCount: 2 },
        ] },
      ],
      /**
       * The rest of the house, which on a real Homey is most of it. Drawn
       * folded, so what the render shows is the ROW — which is the thing worth
       * looking at, since it is all that stands between the user and a hundred
       * devices they did not come here for.
       */
      others: [
        { zoneName: 'Kitchen', sources: [
          { id: 'o1', name: 'Dishwasher', ownerName: 'Bosch', available: true, eventCount: 0 },
        ] },
        { zoneName: 'Living room', sources: [
          { id: 'o2', name: 'Ceiling spots', ownerName: 'Philips Hue', available: true, eventCount: 0 },
          { id: 'o3', name: 'Floor lamp', ownerName: 'IKEA Trådfri', available: true, eventCount: 0 },
        ] },
      ],
      candidateCount: 3,
      otherCount: 3,
      total: 6,
      current: 'r1',
    },
    selectSource: {
      deviceName: 'Hall remote', ownerName: 'IKEA Trådfri',
      eventCount: 8, usable: true, rejected: [],
      // `controls` is the driver's list of the remote's controls, and the
      // screen shows its LENGTH. A bare 4 here rendered a message no real
      // Homey could produce.
      controls: [
        { controlId: 'button.top', label: 'Top', inputs: [] },
        { controlId: 'button.bottom', label: 'Bottom', inputs: [] },
        { controlId: 'button.left', label: 'Left', inputs: [] },
        { controlId: 'button.right', label: 'Right', inputs: [] },
      ],
    },
  },

  'buttons.html': {
    getButtons: {
      gestures: GESTURES,
      // Resolved through the same keys the driver passes, so a renamed job is
      // renamed on the contact sheet too. `detail` is composed the way the
      // driver composes it — the job, then the lights it drives — because the
      // whole point of that line is that a per-button target is legible from
      // the list.
      jobs: {
        'button.top|true': {
          label: say('functions.toggle'),
          detail: say('buttons.detail', {
            job: say('functions.toggle'),
            lights: say('targets.allCount', { count: 3 }),
          }),
        },
        'button.top|hold': {
          label: say('functions.brightness_up'),
          detail: say('buttons.detail', {
            job: say('functions.brightness_up'),
            lights: 'Floor lamp',
          }),
        },
        'button.bottom|true': {
          label: say('functions.off'),
          detail: say('buttons.detail', {
            job: say('functions.off'),
            lights: say('targets.allCount', { count: 3 }),
          }),
        },
      },
    },
  },

  'job.html': {
    getGesture: {
      title: 'Top · Long press',
      /**
       * Nine, in the order the driver yields them, which is the order the grid
       * reads: power across the top, brightness in the middle, warmth and
       * colour at the bottom, and the third column setting a value in each row.
       * "Do nothing" is NOT in this list — it is the tile below the grid, and
       * drawing it here would put it in the grid.
       */
      jobs: [
        { id: 'on', label: say('functions.on'), preset: 'none' },
        { id: 'off', label: say('functions.off'), preset: 'none' },
        { id: 'toggle', label: say('functions.toggle'), preset: 'none' },
        { id: 'brightness_up', label: say('functions.brightness_up'), preset: 'none' },
        { id: 'brightness_down', label: say('functions.brightness_down'), preset: 'none' },
        { id: 'brightness_set', label: say('functions.brightness_set'), preset: 'brightness' },
        { id: 'warmer', label: say('functions.warmer'), preset: 'none' },
        { id: 'colder', label: say('functions.colder'), preset: 'none' },
        { id: 'color_set', label: say('functions.color_set'), preset: 'colour' },
        /**
         * The tenth, and it is NOT a tenth grid cell — the view pulls it out by
         * its preset kind and draws it as the card above. It trails the nine
         * here because that is the order `availableFunctions()` yields, and a
         * fixture that reordered them would render a grid this app never draws.
         */
        { id: 'lightkeeper_on', label: say('functions.lightkeeper_on'), preset: 'lightkeeper' },
      ],
      // The newest job, chosen, so the render draws the grid, the palette that
      // opens under it AND the checklist. A job carrying no value would show
      // the screen's two halves and neither of its editors.
      chosen: 'color_set',
      presetKind: 'colour',
      preset: { color: 'amber' },
      colors: PALETTE_SWATCHES,
      layout: LAYOUT,
      lights: RULE_LIGHTS,
      allLabel: say('job.allLights', { count: 3 }),
      chosenLights: ['light-1'],
      /**
       * The two rows of the card, in the words the driver resolves for them.
       *
       * Both answered, so the render shows the card at rest rather than
       * half-filled — and neither is "Leave it alone", because a contact sheet
       * of the unset state would say nothing about the screen's real shape.
       */
      sourceNames: { colour: 'Follow the sun', brightness: 'Desk sensor light' },
      sourceWarnings: { colour: null, brightness: { name: 'Desk sensor light', sharedLights: 3 } },
    },
    setGesture: { set: true },
    test: { writes: 2, skipped: 0, targets: 2 },
  },

  /**
   * Which setup a button takes a value from — one file, two questions, and the
   * BRIGHTNESS one is drawn because it is the richer of the two: a bar and a
   * percentage per row, where the colour question draws one swatch.
   */
  'source.html': {
    getSource: {
      kind: 'brightness',
      title: say('job.takeBrightnessTitle'),
      blurb: say('job.takeBlurb'),
      note: say('job.levelNote'),
      empty: say('job.noSources'),
      chosen: 'lk-daylight-1',
      sources: [
        { id: 'none', name: say('flow.leaveAlone'), subtitle: say('flow.leaveAloneHint') },
        { id: 'lk-curve-1', name: 'Evening curve',
          subtitle: 'Colour Curve Light · Living room', level: 0.4 },
        { id: 'lk-circadian-1', name: 'Follow the sun',
          subtitle: 'Circadian light · Whole house', level: 0.75 },
        { id: 'lk-sched-1', name: "Kids' bedtime",
          subtitle: "Light schedule · Kids' room", level: 0.15 },
        { id: 'lk-daylight-1', name: 'Desk sensor light',
          subtitle: 'Room-sensing Light · Office', level: 0.9,
          // The chosen row drives its own lights too, so the render shows the
          // warning a household sees when a button and a device share lamps.
          warn: { sharedLights: 3 } },
      ],
    },
    setSource: { chosen: 'lk-daylight-1' },
  },

};

/**
 * The three shared views, per driver.
 *
 * Keyed `<driver>/<file>`, and `scripts/render-views.mjs` prefers these over the
 * per-file entries above. Every value is either resolved from the locale through
 * the key the driver passes, or is demo data of the same SHAPE the driver builds
 * — the number of steps, the hero, the rows, the control choice. Nothing here is a
 * screen's own wording written out a second time.
 */
export const DRIVER_REPLIES = {
  // ---- remote controller: four steps, and the only flow with a remote -----
  'controller/intro.html': intro(
    'intro.controllerTitle', 'intro.controllerBlurb', 'remote',
    [['intro.theRemote', 'intro.theRemoteWhy'],
     ['intro.whichLights', 'intro.whichLightsWhy'],
     ['intro.theButtons', 'intro.theButtonsWhy'],
     ['intro.checkIt', 'intro.checkItWhy']],
    'credential'),
  'controller/lights.html': picker('targets.subtitleController', 2, 4, 'buttons'),
  'controller/review.html': {
    getReview: {
      stepIndex: 4,
      stepCount: 4,
      // No hero: a list of rows IS the review of a remote's buttons.
      rows: [
        { label: say('review.remote'), value: 'Hall remote', view: 'remote' },
        { label: say('review.lights'), value: 'Ceiling, Reading lamp', view: 'lights' },
        { label: say('review.buttonsWithAJob'), value: '4 / 6', view: 'buttons' },
      ],
    },
  },

  // ---- light schedule: three steps, and the second key-gated flow ---------
  'schedule/intro.html': intro(
    'intro.scheduleTitle', 'intro.scheduleBlurb', 'schedule',
    [['intro.whichLights', 'intro.whichLightsWhy'],
     ['intro.theBlocks', 'intro.theBlocksWhy'],
     ['intro.checkIt', 'intro.checkItWhy']],
    'credential'),
  'schedule/lights.html': picker('targets.subtitleSchedule', 1, 3, 'blocks'),
  'schedule/review.html': {
    getReview: {
      stepIndex: 3,
      stepCount: 3,
      /**
       * The same three blocks `blocks.html`'s fixture carries, as percentages
       * of the day — including the one that crosses midnight, which arrives as
       * two so the render shows the wrap.
       */
      hero: {
        kind: 'timeline',
        blocks: [
          { left: 29.17, width: 6.94 },
          { left: 80.21, width: 17.71 },
          { left: 89.58, width: 10.42 },
          { left: 0, width: 4.17 },
        ],
      },
      rows: [
        { label: say('review.lights'), value: '2 in Living room', view: 'lights' },
        { label: say('review.timeBlocks'), value: '3', view: 'blocks' },
        { label: say('review.onTheseDays'), value: 'Mon to Fri', view: 'blocks' },
      ],
    },
  },

  // ---- circadian light: the day strip, on the intro and again on the review
  'circadian/intro.html': intro(
    'intro.circadianTitle', 'intro.circadianBlurb', 'day',
    [['intro.whichLights', 'intro.whichLightsWhy'],
     ['intro.theDay', 'intro.theDayWhy'],
     ['intro.checkIt', 'intro.checkItWhy']],
    'lights'),
  'circadian/lights.html': picker('targets.subtitleCircadian', 1, 3, 'day'),
  'circadian/review.html': {
    getReview: {
      stepIndex: 3,
      stepCount: 3,
      rows: [
        { label: say('review.lights'), value: 'Ceiling, Reading lamp', view: 'lights' },
        { label: say('review.morning'), value: 'Warm · 55%', view: 'day' },
        { label: say('review.midday'), value: 'Cool white · 90%', view: 'day' },
        { label: say('review.evening'), value: 'Deep amber · 45%', view: 'day' },
        { label: say('review.transition'), value: say('transition.balanced'), view: 'day' },
      ],
      // The default, as a new device pairs: nothing unfolds.
      control: { modes: ['after', 'before', 'none'], selected: 'after', lightCount: 2 },
      hero: {
        kind: 'strip',
        stops: [
          'rgb(239,166,88) 0%', 'rgb(242,230,214) 18%', 'rgb(234,240,251) 30%',
          'rgb(234,240,251) 62%', 'rgb(242,230,214) 74%', 'rgb(239,166,88) 88%',
          'rgb(239,166,88) 100%',
        ],
      },
    },
  },

  // ---- Colour Curve Light: the same bars its own step 2 draws --------------------
  'curve/intro.html': intro(
    'intro.curveTitle', 'intro.curveBlurb', 'curve',
    [['intro.whichLights', 'intro.whichLightsWhy'],
     ['intro.theCurve', 'intro.theCurveWhy'],
     ['intro.checkIt', 'intro.checkItWhy']],
    'lights'),
  'curve/lights.html': picker('targets.subtitleCurve', 1, 3, 'curve'),
  'curve/review.html': {
    getReview: {
      stepIndex: 3,
      stepCount: 3,
      hero: { kind: 'bars', bars: CURVE_BARS },
      rows: [
        { label: say('review.lights'), value: 'Ceiling, Reading lamp', view: 'lights' },
        { label: say('review.colourChanges'), value: '5 · 06:30–22:30', view: 'curve' },
        { label: say('review.brightness'), value: say('review.brightnessRange', { min: 36, max: 94 }), view: 'curve' },
        { label: say('review.transition'), value: say('transition.balanced'), view: 'curve' },
      ],
      control: CONTROL,
    },
  },

  // ---- Room-sensing Light: four steps, and the only review with a live reading
  'daylight/intro.html': intro(
    'intro.daylightTitle', 'intro.daylightBlurb', 'daylight',
    [['intro.whichLights', 'intro.whichLightsWhy'],
     ['intro.theSensor', 'intro.theSensorWhy'],
     ['intro.theResponse', 'intro.theResponseWhy'],
     ['intro.checkIt', 'intro.checkItWhy']],
    'lights'),
  'daylight/lights.html': picker('targets.subtitleDaylight', 1, 4, 'sensor'),
  'daylight/review.html': {
    getReview: {
      stepIndex: 4,
      stepCount: 4,
      hero: {
        kind: 'now',
        percent: '77%',
        detail: say('review.nowFromSensor', { lux: 41, sensor: 'Kitchen motion' }),
      },
      rows: [
        { label: say('review.lights'), value: 'Worktop, Island', view: 'lights' },
        { label: say('review.readsFrom'), value: 'Kitchen motion', view: 'sensor' },
        { label: say('review.darkRoom'),
          value: `${say('review.underLux', { lux: 8 })} → 92%`, view: 'response' },
        { label: say('review.brightRoom'),
          value: `${say('review.overLux', { lux: 160 })} → 22%`, view: 'response' },
        { label: say('review.transition'), value: say('transition.balanced'), view: 'response' },
      ],
      // Two of the three: a Room-sensing Light has nothing to set in advance.
      control: { modes: ['after', 'none'], selected: 'after', lightCount: 2 },
    },
  },
};
