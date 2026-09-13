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
 */

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

const SUPPORT = { onoff: 3, dim: 3, light_temperature: 2, total: 3 };
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

/** Four gestures, so the buttons screen shows both assigned and unassigned rows. */
const GESTURES = [
  { key: 'button.top|true', buttonLabel: 'Top', actionLabel: 'Pressed' },
  { key: 'button.top|hold', buttonLabel: 'Top', actionLabel: 'Held' },
  { key: 'button.bottom|true', buttonLabel: 'Bottom', actionLabel: 'Pressed' },
  { key: 'button.left|true', buttonLabel: 'Left', actionLabel: 'Pressed' },
];

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
      preStage: false,
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
      preStage: false,
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
        { id: 'a', onAt: 420, end: { kind: 'time', at: 520 } },
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
          { id: 'r3', name: 'Kitchen button', ownerName: 'Aqara', available: false, eventCount: 0 },
        ] },
      ],
      current: 'r1',
    },
    selectSource: {
      deviceName: 'Hall remote', ownerName: 'IKEA Trådfri',
      eventCount: 8, controls: 4, usable: true, rejected: [],
    },
  },

  'buttons.html': {
    getButtons: {
      gestures: GESTURES,
      jobs: {
        'button.top|true': { label: 'On / off' },
        'button.top|hold': { label: 'Brighter' },
        'button.bottom|true': { label: 'Turn off' },
      },
    },
  },

  'job.html': {
    getGesture: {
      title: 'Left — Pressed',
      jobs: [
        { id: null, label: 'Nothing', needsPreset: false },
        { id: 'toggle', label: 'On / off', needsPreset: false },
        { id: 'off', label: 'Turn off', needsPreset: false },
        { id: 'brightness_up', label: 'Brighter', needsPreset: false },
        { id: 'brightness_down', label: 'Dimmer', needsPreset: false },
        { id: 'brightness_set', label: 'A set brightness', needsPreset: true },
        { id: 'temperature_cycle', label: 'Step through warm and cool', needsPreset: false },
      ],
      // The one job that carries a value, chosen so the render draws its
      // controls rather than only the list.
      chosen: 'brightness_set',
      needsPreset: true,
      preset: { brightness: 0.6, temperature: 0.85 },
    },
    setGesture: { set: true },
    test: { writes: 2, skipped: 0, targets: 2 },
  },

  'listen.html': {
    startListening: { listening: true },
    stopListening: { listening: false },
  },
};
