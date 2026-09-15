import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runPairView } from '../support/pair-view-harness';

/**
 * What the pairing screens DO, as opposed to whether they boot.
 *
 * `pair-view-boot.test.ts` proves each view reaches its first `emit()`;
 * `pair-view-styles.test.ts` proves the copies have not drifted. This file is
 * the third question and the one a user would notice: given a plausible reply,
 * does the screen let somebody do the thing it exists for, and does it refuse
 * the things it must?
 *
 * The views cannot be imported — they are HTML with an inline script — so each
 * runs in the harness, which is a small DOM and a stubbed `Homey`. Everything
 * asserted here is reachable from a finger.
 */

const DRIVERS = join(import.meta.dirname, '..', '..', 'drivers');
const read = (view: string) => {
  const [driver, file] = view.split('/');
  return readFileSync(join(DRIVERS, driver!, 'pair', file!), 'utf8');
};

// ---------------------------------------------------------------- the key

describe('the API key screen, which now sits between the intro and step one', () => {
  const run = (status: Record<string, unknown>) => runPairView(read('controller/credential.html'), {
    respond: { getCredentialStatus: status },
  });

  test('a stored, valid key skips the screen entirely', async () => {
    /**
     * The whole reason the key can sit early without costing anybody anything.
     *
     * It is per HOMEY, not per device, so every controller and schedule after
     * the first passes straight through — which is what makes "ask before the
     * work" cheap. The design canvas moved this screen to the END instead; that
     * was overruled, because somebody who reaches a four-step review and cannot
     * produce a key loses everything they just set up.
     */
    const view = run({ present: true, valid: true, nextView: 'remote' });
    await view.settle();

    assert.deepEqual(view.shown, ['remote']);
  });

  test('and the driver decides where it goes, because the file is shared', async () => {
    // One byte-identical file serves the controller and the schedule
    // (platform §8), so the view cannot know what follows it.
    const view = run({ present: true, valid: true, nextView: 'lights' });
    await view.settle();

    assert.deepEqual(view.shown, ['lights']);
  });

  test('no key means the form, and no navigation', async () => {
    const view = run({ present: false, valid: false, nextView: 'remote' });
    await view.settle();

    assert.deepEqual(view.shown, []);
    assert.ok(view.byId('cr-key'), 'the field is there to fill in');
  });
});

// ------------------------------------------------------------ the lights

describe('the light picker', () => {
  const ROOMS = [
    {
      zoneId: 'z1',
      zoneName: 'Living room',
      lights: [
        { id: 'l1', name: 'Ceiling', capabilities: ['onoff', 'dim'], isLight: true, available: true, selected: false },
        { id: 'l2', name: 'Lamp', capabilities: ['onoff', 'dim'], isLight: true, available: true, selected: false },
      ],
    },
    {
      zoneId: 'z2',
      zoneName: 'Kitchen',
      lights: [
        { id: 'k1', name: 'Worktop', capabilities: ['onoff'], isLight: true, available: true, selected: false },
      ],
    },
  ];

  const run = (over: Record<string, unknown> = {}) => runPairView(read('controller/lights.html'), {
    respond: {
      listTargets: {
        rooms: ROOMS, zones: [], total: 3, current: null,
        subtitle: 'The lights', stepIndex: 1, stepCount: 3, nextView: 'day',
        ...over,
      },
      selectTargets: { count: 1, support: { onoff: 1, dim: 1, light_temperature: 0, total: 1 } },
    },
  });

  test('rooms with nothing chosen are folded, so a house of 54 lights fits', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('lt-open')?.children.length, 0, 'nothing is open yet');
    assert.equal(view.byId('lt-folded')?.children.length, 2, 'both rooms are one line each');
  });

  test('an empty selection says so, because the view no longer owns Next', async () => {
    /**
     * This used to assert a disabled button in the card, and the button is
     * gone: Homey draws the footer `Next` for every step whose `navigation`
     * names one, and a second one at the end of our own scroll content was a
     * duplicate the design never had. So the count line is what reports an
     * empty selection now — the screen states it rather than blocking on it.
     */
    const view = run();
    await view.settle();

    assert.equal(view.byId('lt-count')?.textContent, 'lights.noneChosen');
    assert.equal(view.byId('lt-next'), null, 'and no second Next is drawn');
  });

  test('ticking every light in ONE room stores a zone target', async () => {
    /**
     * The one piece of judgement on this screen, and it is invisible here on
     * purpose — the review screen is where it is stated.
     *
     * A zone target means a lamp added to that room next month is picked up
     * without anybody re-pairing, which is the capability the design's
     * checkbox-only picker would have dropped.
     */
    const view = run();
    await view.settle();

    view.fire(view.byId('lt-folded')!.children[1]!, 'click');
    const kitchen = view.byId('lt-open')!.children[0]!;
    view.fire(kitchen.descendants().find(node => node.className === 'light')!, 'click');
    await view.settle();

    const last = [...view.emitted].reverse().find(call => call.event === 'selectTargets');
    assert.deepEqual(last?.data, { kind: 'zone', zoneId: 'z2', includeSubzones: false });
  });

  test('a partly-ticked room is a plain device list', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    const living = view.byId('lt-open')!.children[0]!;
    view.fire(living.descendants().filter(node => node.className === 'light')[0]!, 'click');
    await view.settle();

    const last = [...view.emitted].reverse().find(call => call.event === 'selectTargets');
    assert.deepEqual(last?.data, { kind: 'devices', deviceIds: ['l1'] });
  });

  test('a repair session arrives with the device lights already ticked', async () => {
    const view = run({
      rooms: [{ ...ROOMS[0]!, lights: ROOMS[0]!.lights.map(l => ({ ...l, selected: true })) }],
      current: { kind: 'devices', deviceIds: ['l1', 'l2'] },
    });
    await view.settle();

    assert.equal(view.byId('lt-open')?.children.length, 1, 'a room with picks is open');
    assert.equal(view.byId('lt-count')?.textContent, 'lights.chosen');
  });

  test('a room the user opened can be put away again', async () => {
    /**
     * The header is the only collapse control there is, and before it existed a
     * list of rooms could only ever get longer — this screen opens onto a house
     * of 54 lights.
     */
    const view = run();
    await view.settle();

    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    assert.equal(view.byId('lt-open')?.children.length, 1, 'the room opened');

    const head = view.byId('lt-open')!.children[0]!.descendants()
      .find(node => node.className === 'toggle')!;
    view.fire(head, 'click');

    assert.equal(view.byId('lt-open')?.children.length, 0, 'and closed again');
    assert.equal(view.byId('lt-folded')?.children.length, 2);
  });

  test('a room with a light ticked in it still collapses', async () => {
    /**
     * A room opens ITSELF when something in it is chosen, which is what a repair
     * session wants — but that cannot be the whole rule, or a room you had
     * picked from would spring straight back open and the header would look
     * broken. What the user said outranks the ticks.
     */
    const view = run();
    await view.settle();

    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    const room = view.byId('lt-open')!.children[0]!;
    view.fire(room.descendants().filter(node => node.className === 'light')[0]!, 'click');
    await view.settle();

    view.fire(view.byId('lt-open')!.children[0]!.descendants()
      .find(node => node.className === 'toggle')!, 'click');

    assert.equal(view.byId('lt-open')?.children.length, 0, 'collapsed with a pick in it');
    assert.equal(view.byId('lt-count')?.textContent, 'lights.chosen', 'and the pick is kept');
  });

  test('an empty selection is not an error, and a later one clears the banner', async () => {
    /**
     * The screen pushes its whole selection on every tap, starting with the
     * empty one it opens with. The driver answers that with `null` rather than
     * refusing it — `target.deviceIds is empty` used to be printed across the
     * top of step 1 before anybody had touched the screen — and a push that
     * works clears whatever the last one reported.
     */
    const view = run();
    await view.settle();

    assert.equal(view.byId('lt-loadError')?.style.display, 'none', 'nothing to report yet');

    const failing = runPairView(read('controller/lights.html'), {
      respond: {
        listTargets: {
          rooms: ROOMS, zones: [], total: 3, current: null,
          subtitle: 'The lights', stepIndex: 1, stepCount: 3, nextView: 'day',
        },
        selectTargets: new Error('Homey said no'),
      },
    });
    await failing.settle();
    assert.equal(failing.byId('lt-loadError')?.textContent, 'Homey said no');
  });

  test('no lights at all is a state of this screen, not a dead end', async () => {
    // The one screen in the flow allowed two sentences, because the user's
    // model is wrong: they expect Lightkeeper to FIND lights, and it borrows
    // Homey's.
    const view = run({ rooms: [], total: 0 });
    await view.settle();

    assert.equal(view.byId('lt-picker')?.style.display, 'none');
    assert.notEqual(view.byId('lt-empty')?.style.display, 'none');
  });
});

// --------------------------------------------------------------- the day

describe('the circadian day screen', () => {
  const ZONES = {
    morning: { temperature: 0.78, brightness: 0.55 },
    midday: { temperature: 0.18, brightness: 0.9 },
    evening: { temperature: 0.86, brightness: 0.45 },
    morningEnd: 30,
    eveningStart: -60,
  };
  const BOUNDARIES = {
    morningEndMinute: 411, morningEnd: '06:51',
    eveningStartMinute: 1128, eveningStart: '18:48',
    fromSun: true,
  };

  const run = (over: Record<string, unknown> = {}) => runPairView(read('circadian/day.html'), {
    respond: {
      getDay: {
        support: { onoff: 2, dim: 2, light_temperature: 2, total: 2 },
        lights: [],
        zones: ZONES,
        adjustBrightness: false,
        preStage: false,
        sun: { sunriseMinute: 381, sunsetMinute: 1188 },
        boundaries: BOUNDARIES,
        nextView: 'review',
        limits: { maxOffset: 150, offsetStep: 15, fallbackSunrise: 360, fallbackSunset: 1260 },
        timezone: 'Europe/Copenhagen',
        ...over,
      },
      setDay: { zones: ZONES, adjustBrightness: true, corrected: [], boundaries: BOUNDARIES },
    },
  });

  test('the morning is open and the other two are rows', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('dy-zoneName')?.textContent, 'day.morning');
    assert.equal(view.byId('dy-others')?.children.length, 2);
  });

  test('midday has no boundary stepper, because it is what lies between', async () => {
    // A stepper there would be a control for something that is not a value.
    const view = run();
    await view.settle();

    assert.notEqual(view.byId('dy-stepper')?.style.display, 'none', 'the morning has one');

    view.fire(view.byId('dy-others')!.children[0]!, 'click');
    assert.equal(view.byId('dy-zoneName')?.textContent, 'day.midday');
    assert.equal(view.byId('dy-stepper')?.style.display, 'none');
  });

  test('the boundary reads as an offset from the sun, not as a clock time', async () => {
    // "Sunrise +30m" survives the year; "06:51" is true for one day.
    const view = run();
    await view.settle();

    assert.match(String(view.byId('dy-boundaryAt')?.textContent), /day\.sunrise \+30m/);
  });

  test('with no sun to anchor to it says so rather than drawing one', async () => {
    // A polar day, or a Homey that has never been told where it is. Both are
    // real, and neither is a reason to stop running.
    const view = run({
      sun: { sunriseMinute: null, sunsetMinute: null },
      boundaries: { ...BOUNDARIES, fromSun: false },
    });
    await view.settle();

    assert.equal(view.byId('dy-sunriseMark')?.style.display, 'none');
    assert.equal(view.byId('dy-sunsetMark')?.style.display, 'none');
    assert.match(String(view.byId('dy-today')?.textContent), /day\.todayFixed/);
  });

  test('brightness is opt-in, and switching it on gives every zone one', async () => {
    /**
     * All or nothing across the three, and checked in the VIEW as well as in
     * the sanitiser: the engine interpolates brightness only where both
     * bracketing points carry one, so a zone without one would leave the curve
     * inventing the missing segments.
     */
    const view = run();
    await view.settle();
    assert.equal(view.byId('dy-brightBlock')?.style.display, 'none');

    view.fire(view.byId('dy-brightToggle')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setDay')?.data as Record<string, any>;
    assert.equal(pushed.adjustBrightness, true);
    for (const key of ['morning', 'midday', 'evening']) {
      assert.notEqual(pushed[key].brightness, undefined, `${key} carries a brightness`);
    }
  });

  test('stepping a boundary goes through the driver, which owns the clamp', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('dy-boundaryUp')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setDay')?.data as Record<string, any>;
    assert.equal(pushed.morningEnd, 45, 'one quarter-hour step');
  });
});

// ------------------------------------------------------------- the curve

describe('the curve screen', () => {
  const PALETTE = Array.from({ length: 24 }, (_, i) => ({
    id: `c${i}`, label: `Colour ${i}`, hue: i / 24, saturation: 0.6,
  }));

  const run = (over: Record<string, unknown> = {}) => runPairView(read('curve/curve.html'), {
    respond: {
      getCurve: {
        points: [
          { id: 'p1', anchor: { kind: 'clock', at: 390 }, warmth: 0.9, color: 'c0' },
          { id: 'p2', anchor: { kind: 'clock', at: 840 }, warmth: 0.2, color: 'c5' },
        ],
        palette: PALETTE,
        featuredColors: 8,
        adjustBrightness: false,
        preStage: false,
        minPoints: 2,
        maxPoints: 8,
        ...over,
      },
      setCurve: { count: 2, adjustBrightness: false, dropped: [] },
    },
  });

  test('eight colours are shown and the rest fold out in place', async () => {
    // A set is a decision; twenty-four shown at once is a tuning session.
    const view = run();
    await view.settle();

    assert.equal(view.byId('cv-featured')?.children.length, 8);
    assert.equal(view.byId('cv-rest')?.style.display, 'none');

    view.fire(view.byId('cv-more')!, 'click');
    assert.notEqual(view.byId('cv-rest')?.style.display, 'none');
    assert.equal(view.byId('cv-rest')?.children.length, 16);
  });

  test('a point cannot be stepped onto another point minute', async () => {
    // Two points at one minute is a zero-length segment: a division by zero
    // dressed up as a user preference.
    const view = run({
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 825 }, warmth: 0.9, color: 'c0' },
        { id: 'p2', anchor: { kind: 'clock', at: 840 }, warmth: 0.2, color: 'c5' },
      ],
    });
    await view.settle();

    const before = view.byId('cv-time')?.textContent;
    view.fire(view.byId('cv-timeUp')!, 'click');
    assert.equal(view.byId('cv-time')?.textContent, before, 'the step onto 14:00 is refused');
  });

  test('the last two points cannot be removed, because two is the fewest', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('cv-remove')?.style.display, 'none');
  });

  test('brightness is all-or-nothing across every point', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('cv-brightToggle')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setCurve')?.data as Record<string, any>;
    assert.equal(pushed.adjustBrightness, true);
    assert.ok(
      pushed.points.every((point: any) => point.brightness !== undefined),
      'a half-dimmed curve would have to invent the missing segments',
    );
  });
});

// ------------------------------------------------------------ the blocks

describe('the schedule blocks screen', () => {
  const ENTRIES = [
    { id: 'a', onAt: 420, end: { kind: 'time', at: 520 } },
    { id: 'b', onAt: 1155, end: { kind: 'time', at: 1410 } },
  ];

  const run = (over: Record<string, unknown> = {}) => runPairView(read('schedule/blocks.html'), {
    respond: {
      getSchedule: {
        maxEntries: 12,
        support: { onoff: 2, dim: 2, light_temperature: 2, total: 2 },
        lights: [],
        entries: ENTRIES,
        days: null,
        overlaps: [],
        timezone: 'Europe/Copenhagen',
        ...over,
      },
      setSchedules: { count: 2, dropped: [], days: null, overlaps: [] },
    },
  });

  test('an overlap is DRAWN and explained, never refused', async () => {
    /**
     * The rule the rewrite reversed. Two blocks over the same lights do fight,
     * and the runtime has always had a deterministic answer — the later one
     * wins while they overlap. Dropping a row somebody had just drawn was the
     * worse surprise, so the region is outlined and the banner says what will
     * happen. Next is never blocked.
     */
    const view = run({ overlaps: [{ a: 'a', b: 'b' }], entries: [
      { id: 'a', onAt: 1020, end: { kind: 'time', at: 1410 } },
      { id: 'b', onAt: 1200, end: { kind: 'time', at: 60 } },
    ] });
    await view.settle();

    assert.notEqual(view.byId('bl-overlap')?.style.display, 'none', 'the banner is shown');
    // Nothing blocks the step. There is no Next in this view at all any more —
    // Homey's own footer carries it — so "never blocked" is now the absence of
    // anything that could block it.
    assert.equal(view.byId('bl-next'), null, 'and no Next of ours to block');
    assert.ok(
      view.byId('bl-timeline')!.children.some(child => child.className === 'clash'),
      'the conflicting region is outlined on the timeline',
    );
  });

  test('the days belong to the schedule, and are one row above the list', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('bl-days')?.children.length, 7, 'seven chips, once');
    for (const chip of view.byId('bl-days')!.children) {
      assert.equal(chip.getAttribute('aria-pressed'), 'true', 'null means every day');
    }
  });

  test('unticking the last day is every day, not never', async () => {
    // A schedule that can never fire looks configured and tells nobody why.
    const view = run({ days: [1] });
    await view.settle();

    view.fire(view.byId('bl-days')!.children[0]!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setSchedules')?.data as Record<string, any>;
    assert.equal(pushed.days, null);
  });

  test('a block is named by its own times, and the off-time is absolute', async () => {
    // Any name the app invented would be wrong for somebody, and "for 90
    // minutes" and "until 23:30" render identically while being different
    // stored things.
    const view = run();
    await view.settle();

    assert.equal(view.byId('bl-blockTitle')?.textContent, '07:00 → 08:40');

    view.fire(view.byId('bl-offHourUp')!, 'click');
    await view.settle();
    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setSchedules')?.data as Record<string, any>;
    assert.equal(pushed.entries[0].end.kind, 'time');
  });
});

// ------------------------------------------------------------ the sensor

describe('the daylight sensor screen', () => {
  const run = (over: Record<string, unknown> = {}) => runPairView(read('daylight/sensor.html'), {
    respond: {
      listSensors: {
        rooms: [{
          zoneName: 'Kitchen',
          sensors: [
            { id: 's1', name: 'Kitchen motion', lux: 41, at: Date.now(), available: true, selected: true },
            { id: 's2', name: 'Cupboard', lux: null, at: null, available: false, selected: false },
          ],
        }],
        selected: ['s1'],
        sky: null,
        sunsetAt: '19:48',
        ...over,
      },
      setSensor: { sensor: null },
      inspectSensor: { inspecting: 's1' },
    },
  });

  test('the sun is a peer, not what happens when you fail to choose', async () => {
    const view = run();
    await view.settle();

    assert.ok(view.byId('sn-useSun'), 'the sun is its own option');
    assert.match(String(view.byId('sn-sunNow')?.textContent), /sensor\.sunsetAt/);
  });

  test('a sensor that is not responding is shown greyed, never hidden', async () => {
    // A dead sensor somebody expects to see is then explained rather than
    // missing.
    const view = run();
    await view.settle();

    const rows = view.byId('sn-list')!.querySelectorAll('.sensor');
    assert.equal(rows.length, 2, 'both are listed');
    assert.equal(rows.filter(row => row.matches('.dead')).length, 1, 'and the dead one is marked');
  });

  test('with no sensors at all the screen says so and offers the sun', async () => {
    const view = run({ rooms: [], selected: [] });
    await view.settle();

    assert.notEqual(view.byId('sn-none')?.style.display, 'none');
    assert.equal(view.byId('sn-useSensor')?.disabled, true);
  });

  test('tapping a sensor opens its week rather than choosing it', async () => {
    // The whole argument for the choice is what that sensor has been reading,
    // and a lux number on one line cannot carry it.
    const view = run();
    await view.settle();

    view.fire(view.byId('sn-list')!.querySelectorAll('.sensor')[0]!, 'click');
    await view.settle();

    assert.ok(view.emitted.some(call => call.event === 'inspectSensor'));
    assert.deepEqual(view.shown, ['sensordetail']);
  });
});

// ---------------------------------------------------------- the response

describe('the daylight response screen', () => {
  const RESPONSE = {
    sensor: 's1', darkLux: 8, brightLux: 160, dark: 0.92, bright: 0.22,
    darkElevation: -6, brightElevation: 25, sunPeak: 'flat',
  };

  const run = (over: Record<string, unknown> = {}) => runPairView(read('daylight/response.html'), {
    respond: {
      getResponse: {
        response: RESPONSE,
        sensorName: 'Kitchen motion',
        nowLux: 41,
        week: null,
        staleFor: null,
        atDark: '20:18',
        atBright: '12:04',
        ...over,
      },
      setDaylight: { response: RESPONSE, corrected: [], atDark: '20:18', atBright: '12:04' },
    },
  });

  test('with a sensor the thresholds are lux, and the week is the evidence', async () => {
    const view = run();
    await view.settle();

    assert.notEqual(view.byId('rs-week')?.style.display, 'none');
    assert.equal(view.byId('rs-sunBlock')?.style.display, 'none', 'no sun question with a sensor');
    assert.match(String(view.byId('rs-thresholdVal')?.textContent), /response\.underLux/);
  });

  test('following the sun swaps the unit and asks the one question it can', async () => {
    /**
     * Elevation is symmetric about solar noon, so nothing else can tell an
     * east-facing room from a west-facing one. Asked as an observation rather
     * than a compass bearing, because somebody who lives in a room knows when
     * the sun comes in.
     */
    const view = run({ response: { ...RESPONSE, sensor: null }, sensorName: null, week: null });
    await view.settle();

    assert.notEqual(view.byId('rs-sunBlock')?.style.display, 'none');
    assert.equal(view.byId('rs-peaks')?.children.length, 4, 'four answers, each a shape');
    assert.match(String(view.byId('rs-thresholdVal')?.textContent), /response\.degreesAt/);
  });

  test('a sensor that has gone quiet is the one warning kept inside pairing', async () => {
    // Half a day of silence, not an hour: a still room legitimately goes quiet
    // for hours, but a stopped sensor makes the whole device a no-op.
    const view = run({ staleFor: 14 });
    await view.settle();

    assert.notEqual(view.byId('rs-stale')?.style.display, 'none');
  });

  test('the two ends are one card and one row, and tapping swaps them', async () => {
    const view = run();
    await view.settle();
    assert.match(String(view.byId('rs-endName')?.textContent), /whenDark/);

    view.fire(view.byId('rs-others')!.children[0]!, 'click');
    assert.match(String(view.byId('rs-endName')?.textContent), /whenBright/);
  });
});

// ------------------------------------------------------------ the review

describe('the review screen', () => {
  const run = (over: Record<string, unknown> = {}) => runPairView(read('controller/review.html'), {
    respond: {
      getReview: {
        stepIndex: 3,
        stepCount: 3,
        rows: [
          { label: 'Lights', value: '2 picked', view: 'lights' },
          { label: 'Right now', value: '77%' },
        ],
        promise: 'It starts now.',
        ...over,
      },
      save: { created: true, device: { name: 'Kitchen daylight', data: { id: 'x' } } },
      add_device: true,
    },
  });

  test('a row that owns a step is a button back to it; one that only reports is not', async () => {
    // A chevron is a promise that something opens.
    const view = run();
    await view.settle();

    const rows = view.byId('rv-rows')!.children;
    assert.equal(rows[0]!.tagName, 'button');
    assert.equal(rows[1]!.tagName, 'div');

    view.fire(rows[0]!, 'click');
    assert.deepEqual(view.shown, ['lights']);
  });

  test('saving creates the device and leaves', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('rv-save')!, 'click');
    await view.settle();

    assert.equal(view.created.length, 1);
    assert.equal(view.finished, true);
  });

  test('a repair session updates rather than creating a second device', async () => {
    const view = runPairView(read('controller/review.html'), {
      respond: {
        getReview: { stepIndex: 3, stepCount: 3, rows: [], promise: '' },
        save: { updated: true },
      },
    });
    await view.settle();

    view.fire(view.byId('rv-save')!, 'click');
    await view.settle();

    assert.deepEqual(view.created, []);
    assert.equal(view.finished, true);
  });

  test('a save that fails leaves the button usable and says why', async () => {
    const view = runPairView(read('controller/review.html'), {
      respond: { getReview: { stepIndex: 3, stepCount: 3, rows: [], promise: '' } },
    });
    await view.settle();

    view.fire(view.byId('rv-save')!, 'click');
    await view.settle();

    assert.equal(view.finished, false);
    assert.equal(view.byId('rv-save')?.disabled, false, 'a stuck button is a dead screen');
    assert.notEqual(view.byId('rv-error')?.style.display, 'none');
  });
});

// ----------------------------------------------------------- the buttons

describe('the controller buttons screen', () => {
  const run = () => runPairView(read('controller/buttons.html'), {
    respond: {
      getButtons: {
        gestures: [
          { key: 'button.top|true', buttonLabel: 'Top', actionLabel: 'Pressed' },
          { key: 'button.left|true', buttonLabel: 'Left', actionLabel: 'Pressed' },
        ],
        jobs: { 'button.top|true': { label: 'On / off' } },
      },
      editGesture: { editing: 'button.left|true' },
    },
  });

  test('one row per thing the remote can do, in the order the buttons sit', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('bt-list')?.children.length, 2);
  });

  test('a gesture with no job reads as finished, not as a warning', async () => {
    // "Not assigned" five times over read as unfinished work. A button with no
    // job is a button somebody set up exactly as they meant to.
    const view = run();
    await view.settle();

    const rows = view.byId('bt-list')!.children;
    const none = rows[1]!.descendants().find(node => node.className.includes('job'))!;
    assert.match(none.className, /none/);
    assert.equal(none.textContent, 'buttons.nothing');
  });

  test('tapping a row tells the driver which one before pushing the editor', async () => {
    // A pair session has no query string, so a reload of the editor would
    // otherwise land on nothing.
    const view = run();
    await view.settle();

    view.fire(view.byId('bt-list')!.children[1]!, 'click');
    await view.settle();

    assert.deepEqual(
      view.emitted.find(call => call.event === 'editGesture')?.data,
      'button.left|true',
    );
    assert.deepEqual(view.shown, ['job']);
  });

  test('a real press highlights its own row', async () => {
    const view = run();
    await view.settle();

    view.push('heard', 'button.left|true');
    assert.match(view.byId('bt-list')!.children[1]!.className, /sel/);
  });
});
