/**
 * What each pairing view is answered with when it is RENDERED for a look.
 *
 * `test/unit/pair-view-boot.test.ts` has its own minimal replies, and they are
 * minimal on purpose: what that test proves is that a view reaches its first
 * `emit()` without throwing, and empty lists prove it just as well as full ones.
 *
 * These are the opposite. They exist so `scripts/render-views.mjs` can produce a
 * contact sheet somebody actually looks at, and a screen rendered from empty
 * lists shows nothing worth looking at — no rows, no chart, no chips. So this is
 * demo data: a plausible household, in enough detail that every control on every
 * screen is drawn at least once.
 *
 * `test/unit/pair-view-render-fixtures.test.ts` discovers the views from disk and
 * fails if one has no entry here, so a new screen cannot quietly go unrendered.
 */

/** Lights the picker and every downstream screen agree about. */
/**
 * `isLight` is what the picker marks a candidate with, and the last entry is
 * why the field is here: everything with `onoff` is offered, so a real house
 * puts sockets and fans in this list — three sockets, a fan, a dishwasher and a
 * NAS among 54 candidates on the reference Homey, 4 September 2026. The contact
 * sheet has to show the marker, or a screen that draws a dishwasher as a bulb
 * looks correct in review.
 *
 * Appended LAST on purpose: five call sites take `LIGHTS.slice(0, 2)` for the
 * mapping and preview screens, where a socket has no business being.
 */
const LIGHTS = [
  { id: 'l1', name: 'Ceiling', zoneName: 'Living room', capabilities: ['onoff', 'dim', 'light_temperature'], isLight: true },
  { id: 'l2', name: 'Reading lamp', zoneName: 'Living room', capabilities: ['onoff', 'dim', 'light_temperature'], isLight: true },
  { id: 'l3', name: 'Worktop', zoneName: 'Kitchen', capabilities: ['onoff', 'dim'], isLight: true },
  { id: 'p1', name: 'Dishwasher', zoneName: 'Kitchen', capabilities: ['onoff'], isLight: false },
];

const SUPPORT = { onoff: 3, dim: 3, light_temperature: 2, total: 3 };

const PALETTE = [
  { id: 'amber', label: 'Amber', hue: 0.11, saturation: 0.75 },
  { id: 'rose', label: 'Rose', hue: 0.95, saturation: 0.55 },
  { id: 'ocean', label: 'Ocean', hue: 0.55, saturation: 0.6 },
  { id: 'forest', label: 'Forest', hue: 0.33, saturation: 0.5 },
];

const TIMEZONE = 'Europe/Copenhagen';

/**
 * Three sensor states in one list: a fresh reading, an hour-old one, and a
 * sensor that has never reported.
 *
 * The ages matter to the render. A reading is never treated as stale — many
 * Zigbee sensors report only on change (platform §16) — so the AGE is the only
 * thing on screen that can reveal a sensor which has stopped, and a fixture
 * where every reading was fresh would never draw that.
 */
/**
 * What the shared daylight card is answered with, on the three screens that
 * carry it as a SECTION rather than as the whole screen.
 *
 * `standalone: false` is the difference from the Daylight light's own fixture:
 * there the card draws the Save and Test footer, here the surrounding screen
 * owns it, and a render that got that wrong would show two.
 */
const SENSOR_READINGS = [
  { deviceId: 's1', name: 'Living room motion', lux: 240, at: Date.now() - 30_000, available: true },
  { deviceId: 's2', name: 'Hall motion', lux: 12, at: Date.now() - 3_600_000, available: true },
  { deviceId: 's5', name: 'Bedroom motion', lux: null, at: null, available: true },
];

const DAYLIGHT_RESPONSE = { sensors: ['s1', 's2'], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25 };
const DAYLIGHT_NOW = { level: 0.42, brightness: 0.63, source: 'sensors', elevation: 18 };

const DAYLIGHT_SENSORS = {
  rooms: [
    {
      zoneName: 'Living room',
      sensors: [
        { id: 's1', name: 'Living room motion', zoneName: 'Living room', available: true, lux: 240, selected: true },
        { id: 's3', name: 'Window sensor', zoneName: 'Living room', available: true, lux: 1400, selected: false },
      ],
    },
    {
      zoneName: 'Hall',
      sensors: [
        { id: 's2', name: 'Hall motion', zoneName: 'Hall', available: true, lux: 12, selected: true },
        { id: 's4', name: 'Cupboard sensor', zoneName: 'Hall', available: false, lux: null, selected: false },
      ],
    },
  ],
  selected: ['s1', 's2'],
};

const DAYLIGHT_CARD = {
  standalone: false,
  response: DAYLIGHT_RESPONSE,
  limits: { minLux: 0.1, maxLux: 100000 },
  now: DAYLIGHT_NOW,
  sky: { elevation: 18, level: 0.55, location: { latitude: 55.68, longitude: 12.57 } },
  sensorReadings: SENSOR_READINGS,
};

const DAYLIGHT_SET = {
  response: DAYLIGHT_RESPONSE,
  corrected: [],
  now: DAYLIGHT_NOW,
  sensorReadings: SENSOR_READINGS,
};

/**
 * Keyed by view FILE NAME, not by driver: `targets.html` is one screen shared by
 * four drivers, and rendering it four times from four fixtures would be four
 * chances for them to disagree about the same picture.
 */
/** @type {Record<string, Record<string, unknown>>} */
export const RENDER_REPLIES = {
  'credential.html': {
    // Deliberately WITHOUT a key: the screen only draws itself when there is
    // something to ask for, so a "valid" fixture would render a blank page.
    getCredentialStatus: { present: false, valid: false, nextView: 'source' },
    setCredential: { present: false, valid: false, failure: 'malformed' },
  },

  'source.html': {
    listSources: {
      rooms: [
        {
          zoneName: 'Living room',
          devices: [
            {
              id: 's1', name: 'Hall remote', zoneName: 'Living room',
              ownerName: 'Philips Hue', available: true, eventCount: 8, selected: true,
            },
            {
              id: 's2', name: 'Tap dial', zoneName: 'Living room',
              ownerName: 'Philips Hue', available: true, eventCount: 12, selected: false,
            },
          ],
        },
        {
          zoneName: 'Kitchen',
          devices: [{
            id: 's3', name: 'Worktop switch', zoneName: 'Kitchen',
            ownerName: 'Zigbee', available: true, eventCount: 4, selected: false,
          }],
        },
      ],
      selectedId: 's1',
    },
    selectSource: {
      deviceName: 'Hall remote', ownerName: 'Philips Hue', eventCount: 8,
      controls: [], usable: true, rejected: [],
    },
  },

  'targets.html': {
    listTargets: {
      // The driver supplies this line, so the render has to as well or the
      // contact sheet shows the one screen that never says what it is for.
      subtitle: 'The lights this remote will control.',
      rooms: [
        {
          zoneName: 'Living room',
          lights: LIGHTS.filter(l => l.zoneName === 'Living room')
            .map(l => ({ ...l, available: true, selected: true })),
        },
        {
          zoneName: 'Kitchen',
          lights: LIGHTS.filter(l => l.zoneName === 'Kitchen')
            .map(l => ({ ...l, available: true, selected: false })),
        },
      ],
      zones: [
        { id: 'z1', name: 'Living room' },
        { id: 'z2', name: 'Kitchen' },
      ],
      current: { kind: 'devices', deviceIds: ['l1', 'l2'] },
    },
    selectTargets: { count: 2, support: SUPPORT },
  },

  'mapping.html': {
    getMapping: {
      functions: [
        { function: 'toggle', label: 'Toggle', capability: 'onoff' },
        { function: 'on', label: 'On', capability: 'onoff' },
        { function: 'off', label: 'Off', capability: 'onoff' },
        { function: 'brightness_up', label: 'Brighter', capability: 'dim' },
        { function: 'brightness_down', label: 'Dimmer', capability: 'dim' },
        { function: 'warmer', label: 'Warmer', capability: 'light_temperature' },
        { function: 'colder', label: 'Cooler', capability: 'light_temperature' },
      ],
      groups: [
        {
          key: '__all__', label: 'All lights',
          capabilities: ['onoff', 'dim', 'light_temperature'], deviceIds: ['l1', 'l2'],
        },
        {
          key: 'l1', label: 'Ceiling', zoneName: 'Living room',
          capabilities: ['onoff', 'dim', 'light_temperature'], deviceIds: ['l1'],
        },
        {
          key: 'l2', label: 'Reading lamp', zoneName: 'Living room',
          capabilities: ['onoff', 'dim', 'light_temperature'], deviceIds: ['l2'],
        },
      ],
      controls: [
        {
          id: 'top', label: 'Top button',
          inputs: [
            { key: 'top:short', label: 'Press', actionLabel: 'Press' },
            { key: 'top:long', label: 'Hold', actionLabel: 'Hold' },
          ],
        },
        {
          id: 'bottom', label: 'Bottom button',
          inputs: [
            { key: 'bottom:short', label: 'Press', actionLabel: 'Press' },
            { key: 'bottom:long', label: 'Hold', actionLabel: 'Hold' },
          ],
        },
        { id: 'dial', label: 'Dial', inputs: [{ key: 'dial:turn', label: 'Turn' }] },
      ],
      // One of each shape: a group rule, a per-light override, and a dial.
      rules: [
        { id: '__all__-toggle', function: 'toggle', inputKey: 'top:short', groupKey: '__all__' },
        { id: '__all__-brightness_up', function: 'brightness_up', inputKey: 'top:long', groupKey: '__all__' },
        { id: 'l2-toggle', function: 'toggle', inputKey: 'bottom:short', groupKey: 'l2' },
      ],
      lights: LIGHTS.slice(0, 2),
    },
    setRules: { count: 3 },
    test: { writes: 2, targets: 2, skipped: 0 },
  },

  'schedule.html': {
    // The card's own three calls. Every driver that carries it answers these,
    // which is what lets one view file serve four screens.
    getDaylight: DAYLIGHT_CARD,
    listSensors: DAYLIGHT_SENSORS,
    setDaylight: DAYLIGHT_SET,
    getSchedule: {
      maxEntries: 12,
      support: SUPPORT,
      lights: LIGHTS.slice(0, 2),
      // Two windows, one of them weekdays-only and one crossing midnight, so
      // the day chips and the "(starts …)" case are both on the page.
      entries: [
        {
          // The morning window follows the daylight and the evening one does
          // not, so the render shows the choice in both positions AND the shared
          // card, which is hidden until a window references it.
          id: 'e1', onAt: 7 * 60, days: [1, 2, 3, 4, 5],
          end: { kind: 'duration', minutes: 90 }, brightness: 0.6, temperature: 0.35,
          fromDaylight: true,
        },
        {
          id: 'e2', onAt: 22 * 60 + 30, days: null,
          end: { kind: 'time', at: 60 }, brightness: 0.2, temperature: 1,
        },
      ],
      timezone: TIMEZONE,
    },
    setSchedules: { count: 2, dropped: [] },
    test: { writes: 2, skipped: 0, targets: 2 },
  },

  'ends.html': {
    // The card's own three calls. Every driver that carries it answers these,
    // which is what lets one view file serve four screens.
    getDaylight: DAYLIGHT_CARD,
    listSensors: DAYLIGHT_SENSORS,
    setDaylight: DAYLIGHT_SET,
    getEnds: {
      support: SUPPORT,
      lights: LIGHTS.slice(0, 2),
      // The warm end follows the daylight and the cool one does not, so the
      // render shows the choice in both positions AND the shared card, which is
      // hidden until something references it.
      warmest: { temperature: 1, brightness: 0.55, fromDaylight: true },
      coolest: { temperature: 0.15, brightness: 0.9 },
      // On, so both sliders per end are drawn rather than only warmth.
      adjustBrightness: true,
      // On, so the render shows the pre-stage CHECK, which is revealed with the
      // option and is otherwise a block of this screen no contact sheet covers.
      preStage: true,
      shape: [
        { at: '06:00', end: 'warmest' }, { at: '11:00', end: 'coolest' },
        { at: '15:00', end: 'coolest' }, { at: '21:00', end: 'warmest' },
      ],
      timezone: TIMEZONE,
    },
    setEnds: {
      warmest: { temperature: 1, brightness: 0.55 },
      coolest: { temperature: 0.15, brightness: 0.9 },
      adjustBrightness: true,
      corrected: [],
    },
    previewNow: { writes: 2, skipped: 0 },
    testPreStage: { deviceId: 'l2', name: 'Reading lamp', stayedOff: true, restored: false },
  },

  'curve.html': {
    // The card's own three calls. Every driver that carries it answers these,
    // which is what lets one view file serve four screens.
    getDaylight: DAYLIGHT_CARD,
    listSensors: DAYLIGHT_SENSORS,
    setDaylight: DAYLIGHT_SET,
    getCurve: {
      minPoints: 2,
      maxPoints: 8,
      support: SUPPORT,
      lights: LIGHTS.slice(0, 2),
      // Five points, two of them coloured, so the chart shows both dot sizes and
      // the colour selects are not all on "colour temperature".
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.9, brightness: 0.5 },
        // One point following the daylight, so the render shows the choice in
        // both positions and the shared card below the list.
        { id: 'p2', anchor: { kind: 'clock', at: 9 * 60 }, warmth: 0.35, brightness: 0.9, fromDaylight: true },
        { id: 'p3', anchor: { kind: 'clock', at: 17 * 60 }, warmth: 0.45, brightness: 0.8, color: 'ocean' },
        { id: 'p4', anchor: { kind: 'clock', at: 20 * 60 }, warmth: 0.8, brightness: 0.6, color: 'amber' },
        { id: 'p5', anchor: { kind: 'clock', at: 23 * 60 }, warmth: 1, brightness: 0.3 },
      ],
      palette: PALETTE,
      adjustBrightness: true,
      // On, so the render shows the pre-stage CHECK, which is revealed with the
      // option and is otherwise a block of this screen no contact sheet covers.
      preStage: true,
      timezone: TIMEZONE,
    },
    setCurve: { count: 5, adjustBrightness: true, dropped: [] },
    previewNow: { writes: 2, skipped: 0 },
    testPreStage: { deviceId: 'l2', name: 'Reading lamp', stayedOff: true, restored: false },
  },

  'daylight.html': {
    getDaylight: {
      // Its own last screen, so the render shows the Save footer. On the other
      // drivers the same card is a section of their screen and draws none.
      standalone: true,
      support: SUPPORT,
      lights: LIGHTS.slice(0, 2),
      response: {
        // Two sensors, so the readout is a list rather than one line.
        sensors: ['s1', 's2'],
        darkLux: 5,
        brightLux: 500,
        dark: 0.9,
        bright: 0.25,
      },
      limits: { minLux: 0.1, maxLux: 100000 },
      now: { level: 0.42, brightness: 0.63, source: 'sensors', elevation: 18 },
      sky: { elevation: 18, level: 0.55, location: { latitude: 55.68, longitude: 12.57 } },
      // One reading fresh, one an hour old and one absent — the three states the
      // readout can be in, and the ages are the only way a frozen sensor shows.
      sensorReadings: SENSOR_READINGS,
    },
    listSensors: DAYLIGHT_SENSORS,
    setDaylight: DAYLIGHT_SET,
    previewNow: { writes: 2, skipped: 0 },
  },
};
