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
 * what the driver answers them with — a different promise, a different picture,
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

const EN = JSON.parse(
  readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));

/**
 * `Homey.__`, near enough: a dotted key and `__token__` substitution.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [tokens]
 */
function say(key, tokens) {
  let node = EN;
  for (const part of key.split('.')) node = node?.[part];
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
 * The whole palette, so the render shows the featured eight AND what folds out.
 *
 * Hue and saturation are Homey's normalised axes; the view turns them into
 * something a browser will paint.
 */
const PALETTE = [
  { id: 'amber', label: 'Warm amber', hue: 0.11, saturation: 0.75 },
  { id: 'candle', label: 'Candlelight', hue: 0.08, saturation: 0.55 },
  { id: 'coral', label: 'Sunset coral', hue: 0.02, saturation: 0.55 },
  { id: 'neutral', label: 'Neutral white', hue: 0.10, saturation: 0.05 },
  { id: 'coolwhite', label: 'Cool white', hue: 0.58, saturation: 0.08 },
  { id: 'ocean', label: 'Ocean', hue: 0.55, saturation: 0.70 },
  { id: 'forest', label: 'Forest', hue: 0.35, saturation: 0.55 },
  { id: 'violet', label: 'Violet', hue: 0.78, saturation: 0.55 },
  { id: 'ember', label: 'Ember', hue: 0.02, saturation: 0.85 },
  { id: 'crimson', label: 'Crimson', hue: 0.99, saturation: 0.75 },
  { id: 'blush', label: 'Blush', hue: 0.98, saturation: 0.35 },
  { id: 'rose', label: 'Rose', hue: 0.96, saturation: 0.50 },
  { id: 'peach', label: 'Peach', hue: 0.04, saturation: 0.45 },
  { id: 'apricot', label: 'Apricot', hue: 0.07, saturation: 0.60 },
  { id: 'gold', label: 'Gold', hue: 0.13, saturation: 0.65 },
  { id: 'lime', label: 'Lime', hue: 0.25, saturation: 0.60 },
  { id: 'moss', label: 'Moss', hue: 0.30, saturation: 0.45 },
  { id: 'mint', label: 'Mint', hue: 0.42, saturation: 0.40 },
  { id: 'teal', label: 'Teal', hue: 0.48, saturation: 0.65 },
  { id: 'sky', label: 'Sky', hue: 0.58, saturation: 0.45 },
  { id: 'indigo', label: 'Indigo', hue: 0.70, saturation: 0.70 },
  { id: 'lavender', label: 'Lavender', hue: 0.75, saturation: 0.40 },
  { id: 'orchid', label: 'Orchid', hue: 0.82, saturation: 0.45 },
  { id: 'magenta', label: 'Magenta', hue: 0.88, saturation: 0.65 },
];

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
 * The same palette as the job screen is sent it: painted, not as two axes.
 *
 * That screen draws its swatches once and asks the driver for the colour, so
 * the driver runs `colourSwatch()` — the fixture runs the same two curves so a
 * render shows what a Homey would.
 */
const PALETTE_SWATCHES = PALETTE.map(colour => ({
  id: colour.id,
  label: colour.label,
  swatch: `hsl(${Math.round(colour.hue * 360)},`
    + `${Math.round((0.25 + colour.saturation * 0.55) * 100)}%,`
    + `${Math.round(86 - colour.saturation * 36)}%)`,
}));

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
      ],
      promise: 'Lightkeeper sets these 2 lights whenever they are on, starting now.',
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
      preStage: true,
      sun: { sunriseMinute: 381, sunsetMinute: 1188 },
      boundaries: BOUNDARIES,
      nextView: 'review',
      limits: { maxOffset: 150, offsetStep: 15, fallbackSunrise: 360, fallbackSunset: 1260 },
      timezone: TIMEZONE,
    },
    setDay: { zones: ZONES, adjustBrightness: true, corrected: [], boundaries: BOUNDARIES },
  },

  'tryit.html': {
    getPreview: {
      points: [
        { minute: 50, warmth: 0.78 },
        { minute: 361, warmth: 0.78 },
        { minute: 461, warmth: 0.18 },
        { minute: 1078, warmth: 0.18 },
        { minute: 1178, warmth: 0.86 },
        { minute: 1390, warmth: 0.86 },
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
      featuredColors: 8,
      adjustBrightness: true,
      preStage: true,
      minPoints: 2,
      maxPoints: 8,
      timezone: TIMEZONE,
    },
    setCurve: { count: 5, adjustBrightness: true, dropped: [] },
  },

  // ---- daylight -----------------------------------------------------------
  'sensor.html': {
    listSensors: {
      rooms: [
        { zoneName: 'Kitchen', sensors: [
          { id: 's1', name: 'Kitchen motion', zoneName: 'Kitchen', lux: 41, at: Date.now() - 60_000, available: true, selected: true },
          { id: 's2', name: 'Window sensor', zoneName: 'Kitchen', lux: 1400, at: Date.now() - 90_000, available: true, selected: false },
        ] },
        { zoneName: 'Hall', sensors: [
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
        { zoneName: 'Living room', sensors: [
          { id: 's5', name: 'Shelf sensor', zoneName: 'Living room', lux: 90, at: Date.now() - 400_000, available: true, selected: false },
        ] },
        { zoneName: 'Bedroom', sensors: [
          { id: 's6', name: 'Bedroom motion', zoneName: 'Bedroom', lux: 4, at: Date.now() - 7_200_000, available: true, selected: false },
        ] },
        { zoneName: 'Dining', sensors: [] },
        { zoneName: 'Landing', sensors: [] },
        { zoneName: 'Garden', sensors: [
          { id: 's7', name: 'Garden light sensor', zoneName: 'Garden', lux: 8200, at: Date.now() - 120_000, available: true, selected: false },
        ] },
        { zoneName: 'Basement', sensors: [] },
        { zoneName: '', unzoned: true, sensors: [] },
      ],
      selected: ['s1'],
      sky: { elevation: 18, level: 0.55, location: { latitude: 55.68, longitude: 12.57 } },
      sunsetAt: '19:48',
    },
    setSensor: { sensor: 's1' },
    inspectSensor: { inspecting: 's1' },
  },

  'response.html': {
    getResponse: {
      response: RESPONSE,
      sensorName: 'Kitchen motion',
      nowLux: 41,
      week: week(),
      staleFor: null,
      atDark: '20:18',
      atBright: '12:04',
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

  'sensordetail.html': {
    getSensorDetail: {
      sensorName: 'Kitchen motion',
      nowLux: 41,
      week: week(),
    },
    setSensor: { sensor: 's1' },
  },

  // ---- schedule -----------------------------------------------------------
  'blocks.html': {
    getSchedule: {
      maxEntries: 12,
      support: SUPPORT,
      lights: LIGHTS.slice(0, 2),
      entries: [
        // The SELECTED block, and it carries a brightness so the render draws
        // that control open rather than only its switch — the same reason the
        // day, curve and job fixtures set theirs.
        { id: 'a', onAt: 420, end: { kind: 'time', at: 520 }, brightness: 0.8 },
        { id: 'b', onAt: 1155, end: { kind: 'time', at: 1410 }, brightness: 0.2, temperature: 0.95 },
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
            lights: say('targets.allCount', { count: say('count.three') }),
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
            lights: say('targets.allCount', { count: say('count.three') }),
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
      ],
      // The newest job, chosen, so the render draws the grid, the palette that
      // opens under it AND the checklist. A job carrying no value would show
      // the screen's two halves and neither of its editors.
      chosen: 'color_set',
      presetKind: 'colour',
      preset: { color: 'amber' },
      colors: PALETTE_SWATCHES,
      featuredColors: 8,
      lights: RULE_LIGHTS,
      allLabel: say('job.allLights', { count: say('count.three') }),
      chosenLights: ['light-1'],
    },
    setGesture: { set: true },
    test: { writes: 2, skipped: 0, targets: 2 },
  },

  'listen.html': {
    startListening: { listening: true },
    stopListening: { listening: false },
  },
};

/**
 * The three shared views, per driver.
 *
 * Keyed `<driver>/<file>`, and `scripts/render-views.mjs` prefers these over the
 * per-file entries above. Every value is either resolved from the locale through
 * the key the driver passes, or is demo data of the same SHAPE the driver builds
 * — the number of steps, the hero, the rows, the promise. Nothing here is a
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
      promise: say('review.promiseController'),
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
      rows: [
        { label: say('review.lights'), value: 'Ceiling, Reading lamp', view: 'lights' },
        { label: say('review.timeBlocks'), value: '3', view: 'blocks' },
        { label: say('review.onTheseDays'), value: 'Mon to Fri', view: 'blocks' },
      ],
      promise: say('review.promiseSchedule', { count: 2 }),
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
      ],
      promise: say('review.promiseCircadian', { count: 2 }),
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
      ],
      promise: say('review.promiseCurve', { count: 2 }),
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
      ],
      promise: say('review.promiseDaylight', { count: 2 }),
    },
  },
};
