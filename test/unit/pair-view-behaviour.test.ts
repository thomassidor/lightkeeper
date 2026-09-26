import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runPairView } from '../support/pair-view-harness';
import { valueAt as curveValueAt } from '../../lib/circadian/circadian-curve';
import { DEFAULT_POINTS as REAL_POINTS } from '../../lib/circadian/circadian-types';
import { PALETTE as REAL_PALETTE } from '../../lib/circadian/palette';
import { colourSwatch } from '../../lib/pairing/flow-screens';
import { buildSourceList } from '../../lib/pairing/source-list';

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

// -------------------------------------------------------------- the intro

describe('the intro, and the picture it draws for a Light Remote', () => {
  const intro = (hero: string) => runPairView(read('controller/intro.html'), {
    respond: {
      getIntro: {
        title: 'Give the buttons a job', blurb: 'A sentence.', hero,
        decisions: [{ what: 'Which remote', why: 'Press a button' }],
        nextView: 'credential',
      },
    },
  });

  test('a remote is drawn as its three gestures, in the order a user meets them', async () => {
    /**
     * The hero used to be the buttons screen in miniature — three rows of
     * "Top / pressed / On and off" — which drew a screen two steps ahead and
     * said nothing the title had not. Press, hold and turn are what
     * `event-normalizer.ts` can actually tell apart, so they are what the
     * picture may promise.
     */
    const view = intro('remote');
    await view.settle();

    const caps = view.byId('in-hero')!.querySelectorAll('.cap');
    assert.deepEqual(caps.map(cap => cap.className), ['cap', 'cap hold', 'cap turn']);
    // `Homey.__` is the identity here, so a label IS the key it asks for, and
    // locales.test.ts is what proves the key exists.
    assert.deepEqual(
      view.byId('in-hero')!.querySelectorAll('.lab').map(node => node.textContent),
      ['intro.remotePress', 'intro.remoteHold', 'intro.remoteTurn'],
    );
  });

  test('and every cap carries the disc the CSS draws the gesture on', async () => {
    // The mark on a turned dial and the halo on a held press are both drawn on
    // the inner disc, so a cap without one renders as an empty ring.
    const view = intro('remote');
    await view.settle();

    for (const cap of view.byId('in-hero')!.querySelectorAll('.cap')) {
      assert.equal(cap.children.length, 1, 'one disc per cap');
      assert.equal(cap.children[0]!.tagName, 'b');
    }
  });

  test('an unknown hero hides the frame rather than leaving a gap', async () => {
    const view = intro('no-such-picture');
    await view.settle();

    assert.equal(view.byId('in-hero')!.style['display'], 'none');
  });
});

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

  test('every room starts folded, as one line each', async () => {
    /**
     * Nothing open until somebody taps a room.
     *
     * It used to open the room something was ticked in, else the first room,
     * which put one room's lights in front of a household that had not said
     * which room it wanted. Folded, each line already says "n of m", which is
     * what this step asks first.
     */
    const view = run();
    await view.settle();

    assert.equal(view.byId('lt-open')?.children.length, 0, 'no room is open');
    assert.equal(view.byId('lt-folded')?.children.length, 2, 'every room is one line');
  });

  test('ONE room is open at a time, and opening a second closes the first', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    await view.settle();
    assert.equal(view.byId('lt-open')?.children.length, 1, 'the tapped room opened');
    assert.ok(
      view.byId('lt-open')!.children[0]!.className.includes('solo'),
      'the open one wears the accent border, because it is the only one',
    );

    // Kitchen is now the only folded line; opening it must close Living room.
    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    await view.settle();

    assert.equal(view.byId('lt-open')?.children.length, 1, 'still exactly one');
    assert.equal(
      view.byId('lt-open')!.children[0]!.descendants()
        .find(node => node.className === 'name')?.textContent,
      'Kitchen',
      'and it is the one just tapped',
    );
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

  test('opening a room scrolls it into view', async () => {
    /**
     * The open room renders ABOVE the folded list, so tapping a room at the
     * bottom of a long house opens a card nobody is looking at: the page does
     * not move and the only visible change is the row vanishing from under the
     * finger, which reads as the tap having closed something.
     *
     * Asserted on the CONTAINER's scroller rather than on the window, because
     * that is the element a pair view actually has to move — it is found by
     * walking up from the view's own root, and getting that walk wrong is
     * silent.
     */
    const view = run();
    await view.settle();

    view.scroller.scrollTop = 900;
    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    await view.settle();

    assert.equal(view.scroller.scrollTop, 0);
  });

  test('closing a room leaves the scroll alone', async () => {
    // The card that just closed is already where the eye is; yanking the page
    // to the top would move the thing somebody was looking at.
    const view = run();
    await view.settle();
    view.fire(view.byId('lt-folded')!.children[0]!, 'click');
    await view.settle();

    view.scroller.scrollTop = 900;
    const header = view.byId('lt-open')!.children[0]!
      .descendants().find(node => node.className === 'toggle')!;
    view.fire(header, 'click');
    await view.settle();

    assert.equal(view.scroller.scrollTop, 900);
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

    // Folded like any other, and its line is where the picks show: "2 of 2".
    assert.equal(view.byId('lt-open')?.children.length, 0, 'no room opens itself');
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
     * A pick inside a room must not hold it open, or a room you had picked
     * from would spring straight back open and the header would look broken.
     * What the user said outranks the ticks.
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

  test('the Transition card: three rows, the stored one checked, a curve drawn in each', async () => {
    const view = run({ transition: 'quick' });
    await view.settle();

    const host = view.byId('dy-transition')!;
    const rows = host.querySelectorAll('[role="radio"]');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.getAttribute('data-transition')), ['gradual', 'balanced', 'quick']);
    assert.deepEqual(rows.map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true']);
    assert.equal(host.querySelectorAll('polyline').length, 3, 'one thumbnail per row');
  });

  test('tapping a Transition row checks it and sends it to the driver', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('dy-transition')!.querySelector('[data-transition="gradual"]')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setDay')?.data as Record<string, any>;
    assert.equal(pushed.transition, 'gradual');
    const checked = view.byId('dy-transition')!.querySelector('[aria-checked="true"]');
    assert.equal(checked?.getAttribute('data-transition'), 'gradual');
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
  /**
   * Ten, then the rest — with `c5` drawn a second time and an id the palette
   * does not have, because the real layout draws one colour twice and a
   * screen must survive a layout ahead of its palette.
   */
  const LAYOUT = {
    featured: PALETTE.slice(0, 10).map(colour => colour.id),
    more: [...PALETTE.slice(10).map(colour => colour.id), 'c5', 'nope'],
  };

  const run = (over: Record<string, unknown> = {}) => runPairView(read('curve/curve.html'), {
    respond: {
      getCurve: {
        points: [
          { id: 'p1', anchor: { kind: 'clock', at: 390 }, warmth: 0.9, color: 'c0' },
          { id: 'p2', anchor: { kind: 'clock', at: 840 }, warmth: 0.2, color: 'c5' },
        ],
        palette: PALETTE,
        layout: LAYOUT,
        adjustBrightness: false,
        minPoints: 2,
        maxPoints: 8,
        ...over,
      },
      setCurve: { count: 2, adjustBrightness: false, dropped: [] },
    },
  });

  test('the Transition card: three rows, the stored one checked, a curve drawn in each', async () => {
    const view = run({ transition: 'quick' });
    await view.settle();

    const host = view.byId('cv-transition')!;
    const rows = host.querySelectorAll('[role="radio"]');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.getAttribute('data-transition')), ['gradual', 'balanced', 'quick']);
    assert.deepEqual(rows.map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true']);
    assert.equal(host.querySelectorAll('polyline').length, 3, 'one thumbnail per row');
  });

  test('tapping a Transition row checks it and sends it to the driver', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('cv-transition')!.querySelector('[data-transition="gradual"]')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setCurve')?.data as Record<string, any>;
    assert.equal(pushed.transition, 'gradual');
    const checked = view.byId('cv-transition')!.querySelector('[aria-checked="true"]');
    assert.equal(checked?.getAttribute('data-transition'), 'gradual');
  });


  test('ten colours are shown and the rest fold out in place, as the layout says', async () => {
    // A set is a decision; everything shown at once is a tuning session.
    const view = run();
    await view.settle();

    assert.equal(view.byId('cv-featured')?.children.length, 10);
    assert.equal(view.byId('cv-rest')?.style.display, 'none');

    view.fire(view.byId('cv-more')!, 'click');
    assert.notEqual(view.byId('cv-rest')?.style.display, 'none');
    // Fourteen, plus `c5` again; the unknown id is skipped rather than drawn blank.
    assert.equal(view.byId('cv-rest')?.children.length, 15);
  });

  test('a colour drawn twice is selected in both places', async () => {
    const view = run();
    await view.settle();
    view.fire(view.byId('cv-more')!, 'click');

    const pressed = [...view.byId('cv-featured')!.children, ...view.byId('cv-rest')!.children]
      .filter(swatch => swatch.getAttribute('aria-pressed') === 'true');
    // The first point is c0; select the second, which is c5.
    assert.equal(pressed.length, 1);
    view.fire(view.byId('cv-featured')!.children[5]!, 'click');
    await view.settle();
    const nowPressed = [...view.byId('cv-featured')!.children, ...view.byId('cv-rest')!.children]
      .filter(swatch => swatch.getAttribute('aria-pressed') === 'true');
    assert.equal(nowPressed.length, 2, 'c5 in the default rows and again in the fold-out');
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

  test('the chart blends between points, because the engine does', async () => {
    /**
     * The chart used to hold each colour flat and snap at the halfway mark, on
     * the argument that a blended hue is no palette entry and the screen should
     * not draw a colour nobody could have chosen. The engine blends —
     * `mixColors()` is what a coloured segment actually does — so the picture
     * disagreed with the day: five bands of colour where the room fades through
     * the shades between them.
     *
     * Asserted against the ENGINE rather than against remembered values, because
     * the view carries a hand-copied duplicate of that maths (it repaints on
     * every edit and cannot ask the driver), and a copy is only worth having if
     * something fails when it drifts.
     */
    const view = run({
      points: REAL_POINTS,
      palette: REAL_PALETTE.map(colour => ({
        id: colour.id, label: colour.id, hue: colour.hue, saturation: colour.saturation,
      })),
      adjustBrightness: true,
    });
    await view.settle();

    const bars = view.byId('cv-chart')!.children.filter(child => child.tagName === 'i');
    assert.equal(bars.length, 24, 'one bar an hour');

    for (let hour = 0; hour < 24; hour += 1) {
      assert.equal(
        bars[hour]!.style.background,
        colourSwatch(curveValueAt(REAL_POINTS, hour * 60).color!),
        `the bar at ${hour}:00 is the colour the engine holds there`,
      );
    }

    // And the blend is visible rather than merely equal to itself: 11:00 sits
    // between cool white and neutral and is neither of them.
    assert.notEqual(bars[11]!.style.background, bars[9]!.style.background);
    assert.notEqual(bars[11]!.style.background, bars[14]!.style.background);
  });

  test('the chart carries no handles — the dashed line is the only mark', async () => {
    // A dot per point, the selected one filled, sat on top of the bars they were
    // drawn from at 390px. The bars are the shape; the line says which point is
    // open, and the card below names it.
    const view = run({ points: REAL_POINTS, adjustBrightness: true });
    await view.settle();

    const chart = view.byId('cv-chart')!;
    assert.equal(chart.querySelectorAll('.dot').length, 0);
    assert.equal(chart.querySelectorAll('.at').length, 1);
  });

  test('switching brightness off remembers what each point held', async () => {
    /**
     * The default curve arrives with a shape — 44% at dawn, 94% in the evening,
     * 36% at night — and one tap of the toggle used to replace all five with a
     * flat 80% with no way back inside the session.
     */
    const view = run({ points: REAL_POINTS, adjustBrightness: true });
    await view.settle();

    view.fire(view.byId('cv-brightToggle')!, 'click');
    await view.settle();
    view.fire(view.byId('cv-brightToggle')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setCurve')?.data as Record<string, any>;
    assert.deepEqual(
      pushed.points.map((point: any) => point.brightness),
      REAL_POINTS.map(point => point.brightness),
    );
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
          zoneId: 'z1',
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

  test('one room is open, and every other room is a line with its count', async () => {
    /**
     * Both halves matter, and this screen has been wrong in both directions.
     * Opening every room that had a sensor made a house into a stack of cards
     * each bordered as the one being worked in; folding them with nothing but a
     * heading hid the sensors behind rooms nobody had a reason to tap. A count
     * on every folded row is what makes one-at-a-time honest.
     */
    const view = run({
      rooms: [
        { zoneId: 'z1', zoneName: 'Kitchen', sensors: [
          { id: 's1', name: 'Kitchen motion', lux: 41, at: Date.now(), available: true, selected: false },
        ] },
        { zoneId: 'z2', zoneName: 'Hall', sensors: [
          { id: 's3', name: 'Hall motion', lux: 12, at: Date.now(), available: true, selected: false },
          { id: 's4', name: 'Porch', lux: 9, at: Date.now(), available: true, selected: false },
        ] },
        { zoneId: 'z3', zoneName: 'Dining', sensors: [] },
      ],
      selected: [],
    });
    await view.settle();

    assert.equal(view.byId('sn-list')?.children.length, 1, 'exactly one room is open');

    const folded = view.byId('sn-folded')!.children;
    assert.equal(folded.length, 2, 'and the other two are one line each');
    assert.equal(
      folded[0]!.descendants().find(node => node.className === 'value')?.textContent,
      '2',
      'a folded room that HAS sensors says how many',
    );
    assert.equal(folded[0]!.disabled, false, 'and can be opened');
    assert.equal(
      folded[1]!.descendants().find(node => node.className === 'value')?.textContent,
      'sensor.noneHere',
      'a room with none says so',
    );
    assert.equal(folded[1]!.disabled, true, 'and there is nothing to open');
  });

  test('opening a sensor room scrolls it into view', async () => {
    const view = run({
      rooms: [
        { zoneId: 'z1', zoneName: 'Kitchen', sensors: [
          { id: 's1', name: 'Kitchen motion', lux: 41, at: Date.now(), available: true, selected: false },
        ] },
        { zoneId: 'z2', zoneName: 'Hall', sensors: [
          { id: 's3', name: 'Hall motion', lux: 12, at: Date.now(), available: true, selected: false },
        ] },
      ],
      selected: [],
    });
    await view.settle();

    view.scroller.scrollTop = 900;
    view.fire(view.byId('sn-folded')!.children[0]!, 'click');
    await view.settle();

    assert.equal(view.scroller.scrollTop, 0);
    assert.equal(
      view.byId('sn-list')!.children[0]!.descendants()
        // The title's own text node: the element's whole textContent also
        // carries the close button's chevron, which the harness now reads
        // back as a browser would.
        .find(node => node.className === 'room-title')?.firstChild?.textContent,
      'Hall',
      'and the room that opened is the one that was tapped',
    );
  });

  test('tapping a sensor chooses it and goes straight on to its week', async () => {
    // The detail screen that used to sit in between is gone: the response
    // step draws the same week, and says there what is wrong with a flat or a
    // stopped sensor, so one tap is one decision.
    const view = run();
    await view.settle();

    const row = view.byId('sn-list')!.querySelectorAll('.sensor')[0]!;
    view.fire(row, 'click');
    await view.settle();

    const chose = view.emitted.find(call => call.event === 'setSensor');
    assert.ok(chose, 'the tap chose the sensor');
    assert.equal(typeof (chose!.data as { sensor?: unknown }).sensor, 'string');
    assert.equal(view.emitted.some(call => call.event === 'inspectSensor'), false);
    assert.deepEqual(view.shown, ['response']);
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

  test('the Transition card: three rows, the stored one checked, a curve drawn in each', async () => {
    const view = run({ response: { ...RESPONSE, transition: 'quick' } });
    await view.settle();

    const host = view.byId('rs-transition')!;
    const rows = host.querySelectorAll('[role="radio"]');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.getAttribute('data-transition')), ['gradual', 'balanced', 'quick']);
    assert.deepEqual(rows.map(row => row.getAttribute('aria-checked')), ['false', 'false', 'true']);
    assert.equal(host.querySelectorAll('polyline').length, 3, 'one thumbnail per row');
  });

  test('tapping a Transition row checks it and sends it to the driver', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('rs-transition')!.querySelector('[data-transition="gradual"]')!, 'click');
    await view.settle();

    const pushed = [...view.emitted].reverse()
      .find(call => call.event === 'setDaylight')?.data as Record<string, any>;
    assert.equal(pushed.response.transition, 'gradual');
    const checked = view.byId('rs-transition')!.querySelector('[aria-checked="true"]');
    assert.equal(checked?.getAttribute('data-transition'), 'gradual');
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

  /** A week of the given verdict: seven rows of twelve cells, the last few empty. */
  const weekOf = (verdict: Record<string, unknown>, gapFrom = 12) => ({
    cells: Array.from({ length: 7 }, (_, row) => Array.from({ length: 12 }, (_, column) =>
      (row === 6 && column >= gapFrom ? null : 2 + column))),
    days: [1, 2, 3, 4, 5, 6, 7],
    covered: 80,
    low: 1,
    high: 400,
    lastAt: Date.now() - 9 * 3_600_000,
    verdict,
    suggestion: { darkLux: 2, brightLux: 5 },
  });
  const finding = (view: ReturnType<typeof run>) => view.byId('rs-week')!.querySelector('.week-finding');

  test('a sensor that has gone quiet is said inside its week, as an error', async () => {
    // Half a day of silence, not an hour: a still room legitimately goes quiet
    // for hours, but a stopped sensor holds the lights at one brightness. It
    // used to be a screen of its own; now it is the week card's own block.
    const view = run({
      staleFor: 9, lastReport: 'Sat 12:40',
      week: weekOf({ kind: 'stopped', lastAt: Date.now() - 9 * 3_600_000 }, 6),
    });
    await view.settle();

    const block = finding(view);
    assert.ok(block, 'the quiet sensor is named in its own week');
    assert.ok(block!.className.split(' ').includes('bad'), 'on the error ground');
    assert.equal(block!.children[0]!.textContent, 'week.quiet');
    assert.equal(view.byId('rs-week')!.querySelector('.tick'), null, 'no "now" on a sensor with no now');
    assert.ok(view.byId('rs-week')!.querySelector('.week-legend'), 'and the hatched hours are explained');
  });

  test('a flat sensor is said inside its week, as a warning, with the cards as normal', async () => {
    const view = run({ week: weekOf({ kind: 'flat', low: 1, high: 4 }) });
    await view.settle();

    const block = finding(view);
    assert.ok(block, 'the flat week is named');
    assert.ok(block!.className.split(' ').includes('warn'), 'on the warning ground, not the error one');
    assert.equal(block!.children[0]!.textContent, 'week.flat');
    // No ways out drawn in the card: Previous and Next are the ways out.
    assert.equal(view.byId('rs-week')!.querySelectorAll('button').length, 0);
    assert.match(String(view.byId('rs-thresholdVal')?.textContent), /response\.underLux/);
  });

  test('a usable week keeps its one-line verdict, and draws no block', async () => {
    const view = run({ week: weekOf({ kind: 'usable', nightLux: 2, noonLux: 300 }) });
    await view.settle();

    assert.equal(finding(view), null);
    assert.ok(view.byId('rs-week')!.querySelector('.week-verdict'));
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
        ...over,
      },
      save: { created: true, device: { name: 'Kitchen daylight', data: { id: 'x' } } },
      add_device: true,
      setControl: { mode: 'before' },
      testPreStage: {
        lights: [{ name: 'Floor lamp', ok: true }, { name: 'Shelf strip', ok: false }],
        restored: 2,
      },
    },
  });

  const THREE = { modes: ['after', 'before', 'none'], selected: 'after', lightCount: 2 };
  const picks = (view: ReturnType<typeof run>) => view.byId('rv-control')!.querySelectorAll('.pick');

  test('a schedule or a remote has no control choice, and no closing sentence either', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('rv-controlBlock')!.style.display, 'none');
    assert.equal(view.byId('rv-promise'), null, 'the sentence is gone on all five');
  });

  test('the three ways to control the lights, with the default chosen', async () => {
    const view = run({ control: THREE });
    await view.settle();

    assert.notEqual(view.byId('rv-controlBlock')!.style.display, 'none');
    assert.deepEqual(picks(view).map(pick => pick.getAttribute('aria-checked')), ['true', 'false', 'false']);
    // Nothing unfolds under the default.
    assert.equal(view.byId('rv-control')!.querySelector('.more'), null);
  });

  test('choosing "before" tells the driver, and offers the test until it has run', async () => {
    const view = run({ control: THREE });
    await view.settle();

    view.fire(picks(view)[1]!, 'click');
    await view.settle();

    const told = view.emitted.find(call => call.event === 'setControl');
    assert.deepEqual(told?.data, { mode: 'before' });
    const more = view.byId('rv-control')!.querySelector('.more');
    assert.ok(more, 'the option unfolds');
    assert.equal(more!.querySelector('.btn')!.textContent, 'review.control.test');
    assert.equal(more!.querySelector('.tested'), null, 'no result before a test');
  });

  test('the test answers per lamp, and the button gives way to the answer', async () => {
    const view = run({ control: { ...THREE, selected: 'before' } });
    await view.settle();

    view.fire(view.byId('rv-control')!.querySelector('.btn')!, 'click');
    await view.settle();

    assert.ok(view.emitted.some(call => call.event === 'testPreStage'));
    const lamps = view.byId('rv-control')!.querySelectorAll('.lamp');
    assert.equal(lamps.length, 2);
    assert.ok(lamps[0]!.className.split(' ').includes('pass'), 'the lamp that stayed off');
    assert.ok(!lamps[1]!.className.split(' ').includes('pass'), 'and the one that is changed after');
    assert.equal(view.byId('rv-control')!.querySelector('.btn'), null, 'the button is replaced');
    assert.match(String(view.byId('rv-control')!.querySelector('.note')!.textContent), /testedNow/);
  });

  test('a repair reads back the last test and offers to run it again', async () => {
    const view = run({
      control: {
        ...THREE, selected: 'before',
        tested: { fresh: false, lights: [{ name: 'Floor lamp', ok: true }] },
      },
    });
    await view.settle();

    assert.match(String(view.byId('rv-control')!.querySelector('.note')!.textContent), /testedBefore/);
    assert.equal(view.byId('rv-control')!.querySelector('.morelink')!.textContent, 'review.control.testAgain');
  });

  test('a Room-sensing Light is offered two, worded for brightness', async () => {
    const view = run({ control: { modes: ['after', 'none'], selected: 'after', lightCount: 2 } });
    await view.settle();

    assert.equal(picks(view).length, 2);
    assert.equal(
      view.byId('rv-control')!.querySelector('.why')!.textContent,
      'review.control.afterBrightnessWhy',
    );
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

  test('a save in flight says so on the button itself', async () => {
    /**
     * The present participle of the button's own verb, and the same button —
     * it keeps its size and takes the disabled fill rather than growing a
     * spinner, because this system has no icon set at all.
     */
    const view = run();
    await view.settle();

    // The resting label comes from `data-i18n`, which Homey's own i18n pass
    // fills at injection — the harness does not run it, so only the in-flight
    // label is assertable here.
    const save = view.byId('rv-save')!;
    view.fire(save, 'click');
    assert.equal(save.textContent, 'review.adding', 'the label is the verb, continuing');
    assert.equal(save.disabled, true);
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

// ------------------------------------------------------------ the remote

describe('the remote picker, against the list the driver really sends', () => {
  /**
   * The reply is BUILT by `groupSourcesByRoom`, not transcribed.
   *
   * This screen shipped reading `room.sources` while the picker returned
   * `room.devices`, and every check in the suite passed: the boot test answers
   * with `rooms: []`, so the loop over a room's remotes never ran, and the
   * render fixture was written to match the view rather than the driver. On a
   * real Homey step 1 of 4 drew "Cannot read properties of undefined (reading
   * 'length')" and there was no way past it.
   *
   * So the one thing worth pinning is that the two ends agree — which they can
   * only be shown to do by passing the picker's own output to the view.
   */
  const RANKED = [
    { device: { id: 'r1', name: 'Hall remote', zone: 'z1', zoneName: 'Hallway', ownerName: 'IKEA Tradfri', available: true }, eventCount: 8 },
    { device: { id: 'r2', name: 'Bedside dimmer', zone: 'z1', zoneName: 'Hallway', ownerName: 'Philips Hue', available: true }, eventCount: 4 },
    { device: { id: 'r3', name: 'Kitchen button', zone: 'z2', zoneName: 'Kitchen', ownerName: 'Aqara', available: false }, eventCount: 0 },
  ];

  const run = (current: string | null = null, selected: unknown = undefined) => runPairView(
    read('controller/remote.html'), {
      respond: {
        checkReattach: null,
        listSources: {
          ...buildSourceList(RANKED, current ?? undefined),
          total: RANKED.length,
          current,
        },
        selectSource: selected ?? {
          deviceName: 'Hall remote', ownerName: 'IKEA Tradfri', eventCount: 8,
          controls: [{ controlId: 'button.top', label: 'Top', inputs: [] }],
          usable: true, rejected: [],
        },
      },
    },
  );

  test('only what Homey can hear a gesture from is on the screen to begin with', async () => {
    const view = run();
    await view.settle();

    assert.equal(view.byId('rm-error')!.style.display, 'none',
      view.byId('rm-error')!.textContent);
    // The Kitchen button reports nothing, so its whole room is behind the fold.
    assert.deepEqual(
      view.byId('rm-rooms')!.querySelectorAll('.room-title').map(node => node.textContent),
      ['Hallway'],
    );
    assert.deepEqual(
      view.byId('rm-rooms')!.querySelectorAll('.name').map(node => node.textContent),
      ['Bedside dimmer', 'Hall remote'],
    );
    assert.equal(view.byId('rm-others')!.style.display, 'none');
    assert.equal(view.byId('rm-otherCount')!.textContent, '1');
  });

  test('the rest of the house is one row away, and says how many', async () => {
    // Folded, never filtered: a remote whose events reach the Homey by a route
    // this app cannot count ahead of time is rare and real, so "my remote is
    // not in the list" has to have an answer on the screen.
    const view = run();
    await view.settle();

    view.fire(view.byId('rm-otherToggle')!, 'click');
    await view.settle();

    assert.equal(view.byId('rm-others')!.style.display, '');
    assert.deepEqual(
      view.byId('rm-others')!.querySelectorAll('.name').map(node => node.textContent),
      ['Kitchen button'],
    );

    view.fire(view.byId('rm-otherToggle')!, 'click');
    await view.settle();
    assert.equal(view.byId('rm-others')!.style.display, 'none');
  });

  test('a remote that has been heard from says how much, and an unavailable one says so', async () => {
    const view = run();
    await view.settle();
    view.fire(view.byId('rm-otherToggle')!, 'click');
    await view.settle();

    // `Homey.__` is the identity in the harness, so a label IS its key.
    const meta = view.byId('rm-rooms')!.querySelectorAll('.meta').map(node => node.textContent);
    assert.equal(meta[0], 'remote.events · Philips Hue');

    const other = view.byId('rm-others')!.querySelectorAll('.meta').map(node => node.textContent);
    assert.equal(other[0], 'remote.noEvents · Aqara · remote.unavailable');
  });

  test('the search spans both lists, and does not make the user open the second', async () => {
    // A fold that hides the device somebody has just typed the name of is a
    // search that did nothing.
    const view = run();
    await view.settle();

    view.byId('rm-search')!.value = 'kitchen';
    view.fire(view.byId('rm-search')!, 'input');
    await view.settle();

    assert.deepEqual(
      view.byId('rm-rooms')!.querySelectorAll('.name').map(node => node.textContent), []);
    assert.deepEqual(
      view.byId('rm-others')!.querySelectorAll('.name').map(node => node.textContent),
      ['Kitchen button'],
    );
    // The fold means nothing while a search is running: everything that matches
    // is already drawn.
    assert.equal(view.byId('rm-otherRow')!.style.display, 'none');
    assert.equal(view.byId('rm-empty')!.style.display, 'none');
  });

  test('a search that matches nothing says so, and does not say "add one to Homey"', async () => {
    const view = run();
    await view.settle();

    view.byId('rm-search')!.value = 'zzz';
    view.fire(view.byId('rm-search')!, 'input');
    await view.settle();

    assert.equal(view.byId('rm-empty')!.style.display, '');
    assert.equal(view.byId('rm-empty')!.textContent, 'remote.noMatch');
  });

  test('tapping one marks it, and only it', async () => {
    // The tick is drawn by `.remote[aria-pressed="true"] .box`, so this is the
    // whole of what a selection looks like. Every row used to be cleared and
    // none set, leaving a screen that answered a tap with nothing visible.
    const view = run();
    await view.settle();

    const rows = view.byId('rm-rooms')!.querySelectorAll('.remote');
    view.fire(rows[1]!, 'click');
    await view.settle();

    assert.deepEqual(
      rows.map(row => row.getAttribute('aria-pressed')),
      ['false', 'true'],
    );
    assert.equal(view.byId('rm-msg')!.textContent, 'remote.found');
  });

  test('a repair session opens on the remote the controller already uses, even a silent one', async () => {
    // r3 reports nothing, which is the ordinary reason to repair — the
    // integration changed underneath it. Folding it away would leave a screen
    // whose only tick is somewhere the user cannot see.
    const view = run('r3');
    await view.settle();

    const rows = view.byId('rm-rooms')!.querySelectorAll('.remote');
    assert.deepEqual(
      rows.map(row => row.getAttribute('aria-pressed')),
      ['false', 'false', 'true'],
    );
    assert.equal(view.byId('rm-otherCount')!.textContent, '0');
  });

  test('a remote nothing can be read from reports itself here, not three screens later', async () => {
    const view = run(null, {
      deviceName: 'Kitchen button', ownerName: 'Aqara', eventCount: 0,
      controls: [], usable: false, rejected: [],
    });
    await view.settle();
    view.fire(view.byId('rm-otherToggle')!, 'click');
    await view.settle();

    view.fire(view.byId('rm-others')!.querySelectorAll('.remote')[0]!, 'click');
    await view.settle();

    assert.equal(view.byId('rm-msg')!.className, 'msg bad');
    assert.equal(view.byId('rm-msg')!.textContent, 'remote.unusable');
  });

  test('nothing heard from anything opens the second list itself', async () => {
    // Otherwise the whole screen is one closed row, and the house it is hiding
    // is the only place the remote can be.
    const view = runPairView(read('controller/remote.html'), {
      respond: {
        checkReattach: null,
        listSources: {
          ...buildSourceList([RANKED[2]!], undefined), total: 1, current: null,
        },
      },
    });
    await view.settle();

    assert.equal(view.byId('rm-others')!.style.display, '');
    assert.deepEqual(
      view.byId('rm-others')!.querySelectorAll('.name').map(node => node.textContent),
      ['Kitchen button'],
    );
    assert.equal(view.byId('rm-empty')!.style.display, 'none');
  });

  test('no remotes at all is a state of the screen, not an error', async () => {
    const view = runPairView(read('controller/remote.html'), {
      respond: {
        checkReattach: null,
        listSources: { rooms: [], others: [], otherCount: 0, total: 0, current: null },
      },
    });
    await view.settle();

    assert.equal(view.byId('rm-empty')!.style.display, '');
    assert.equal(view.byId('rm-empty')!.textContent, 'remote.none');
    assert.equal(view.byId('rm-otherBlock')!.style.display, 'none');
    assert.equal(view.byId('rm-error')!.style.display, 'none');
  });
});

// ----------------------------------------------------------- the buttons

describe('the controller buttons screen', () => {
  const run = () => runPairView(read('controller/buttons.html'), {
    respond: {
      getButtons: {
        gestures: [
          { key: 'button.top|true', label: 'Top · Press' },
          { key: 'button.left|true', label: 'Left · Press' },
        ],
        jobs: {
          'button.top|true': { label: 'On / off', detail: 'On / off · all three' },
        },
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
    // job is a button somebody set up exactly as they meant to, so the row
    // recedes — no red, no badge, nothing to clear.
    const view = run();
    await view.settle();

    const rows = view.byId('bt-list')!.children;
    assert.match(rows[1]!.className, /unset/);
    assert.ok(
      !rows[1]!.descendants().some(node => node.className === 'sub'),
      'and no second line, because there is no job and no lights to name',
    );
    assert.equal(
      rows[1]!.descendants().find(node => node.className.includes('value'))!.textContent,
      'buttons.notSet',
    );
  });

  test('every row says what it is in a mark as well as in a word', async () => {
    // Counting what is left to do used to mean reading the right-hand column
    // downwards. The mark answers it in the margin, and the two states differ
    // in fill rather than in colour.
    const view = run();
    await view.settle();

    const rows = view.byId('bt-list')!.children;
    for (const row of rows) {
      assert.ok(
        row.descendants().some(node => node.className === 'mark'),
        'every gesture row carries its own mark',
      );
    }
    assert.doesNotMatch(rows[0]!.className, /unset/);
    assert.match(rows[1]!.className, /unset/);
  });

  test('a set row says what it does AND which lights, without opening anything', async () => {
    // A per-button target that can only be found by opening a row is a feature
    // nobody discovers: a remote whose top button dims the floor lamp would
    // read exactly like one that dims everything.
    const view = run();
    await view.settle();

    const row = view.byId('bt-list')!.children[0]!;
    assert.equal(row.descendants().find(node => node.className === 'label')?.textContent,
      'Top · Press');
    assert.equal(row.descendants().find(node => node.className === 'sub')?.textContent,
      'On / off · all three');
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
});
// ------------------------------------------------------- the job editor

describe('the job editor, pushed from one gesture', () => {
  const JOBS = [
    { id: 'on', label: 'On', preset: 'none' },
    { id: 'off', label: 'Off', preset: 'none' },
    { id: 'toggle', label: 'On and off', preset: 'none' },
    { id: 'brightness_up', label: 'Brighter', preset: 'none' },
    { id: 'brightness_down', label: 'Dimmer', preset: 'none' },
    { id: 'brightness_set', label: 'A set brightness', preset: 'brightness' },
    { id: 'warmer', label: 'Warmer', preset: 'none' },
    { id: 'colder', label: 'Cooler', preset: 'none' },
    { id: 'color_set', label: 'Set colour', preset: 'colour' },
  ];

  const LIGHTS = [
    { id: 'l1', name: 'Floor lamp' },
    { id: 'l2', name: 'Shelf strip' },
    { id: 'l3', name: 'Reading lamp' },
  ];

  const run = (over: Record<string, unknown> = {}) => runPairView(read('controller/job.html'), {
    respond: {
      getGesture: {
        title: 'Top · Press',
        jobs: JOBS,
        chosen: null,
        presetKind: 'none',
        preset: null,
        colors: [
          { id: 'amber', label: 'Warm amber', swatch: 'hsl(40,66%,59%)' },
          { id: 'candle', label: 'Candlelight', swatch: 'hsl(29,55%,66%)' },
          { id: 'ocean', label: 'Ocean', swatch: 'hsl(198,64%,61%)' },
          { id: 'forest', label: 'Forest', swatch: 'hsl(126,55%,66%)' },
        ],
        layout: { featured: ['amber', 'candle'], more: ['ocean', 'forest'] },
        lights: LIGHTS,
        allLabel: 'All three lights',
        chosenLights: null,
        ...over,
      },
      setGesture: { set: true },
      test: { writes: 2, skipped: 0, targets: 2 },
    },
  });

  const lastSet = (view: ReturnType<typeof runPairView>) =>
    [...view.emitted].reverse().find(call => call.event === 'setGesture')?.data as
      { job: string | null; preset: unknown; lights: string[] | null } | undefined;

  test('nine jobs as a grid, and "do nothing" is not one of them', async () => {
    // Position carries the grouping — power, brightness, colour across; up,
    // down, set a value down — so a tenth tile in the grid would put a job in a
    // family it does not belong to. The absence of a job sits below it instead.
    const view = run();
    await view.settle();

    assert.equal(view.byId('jb-grid')!.children.length, 9);
    assert.ok(view.byId('jb-none'), 'and it has a control of its own');
  });

  test('a job is saved with the lights it drives, not just with its own name', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('jb-grid')!.children[3]!, 'click');
    await view.settle();

    assert.deepEqual(lastSet(view), {
      job: 'brightness_up',
      preset: null,
      // null is "all of them", which keeps following the room.
      lights: null,
    });
  });

  test('ticking one light aims the button at that light alone', async () => {
    const view = run();
    await view.settle();

    const rows = view.byId('jb-lights')!.children;
    // Row 0 is "All three lights"; the rest are the lights themselves.
    view.fire(rows[1]!, 'click');
    await view.settle();

    assert.deepEqual(lastSet(view)?.lights, ['l1']);
  });

  test('ticking every light is stored as "all of them", never as a list', async () => {
    // The two are not equivalent: a list freezes against today's lights while
    // "all" follows the device, so the screen cannot offer a second way to say
    // the same thing that quietly stops being true.
    const view = run();
    await view.settle();

    const rows = () => view.byId('jb-lights')!.children;
    view.fire(rows()[1]!, 'click');
    await view.settle();
    view.fire(rows()[2]!, 'click');
    await view.settle();
    view.fire(rows()[3]!, 'click');
    await view.settle();

    assert.equal(lastSet(view)?.lights, null);
    assert.equal(rows()[0]!.attributes['aria-pressed'], 'true');
  });

  test('clearing the last light goes back to all of them rather than to none', async () => {
    const view = run({ chosenLights: ['l1'] });
    await view.settle();

    view.fire(view.byId('jb-lights')!.children[1]!, 'click');
    await view.settle();

    assert.equal(lastSet(view)?.lights, null);
  });

  test('a light checklist of one is no question at all, so it is not asked', async () => {
    const view = run({ lights: [{ id: 'l1', name: 'Floor lamp' }] });
    await view.settle();

    assert.equal(view.byId('jb-lights')!.style.display, 'none');
    assert.equal(view.byId('jb-toTitle')!.style.display, 'none');
  });

  test('the colour job arrives with a colour, because one without is refused', async () => {
    // The driver drops a rule that says it sets a colour and carries none — so
    // the first tap fills one in rather than pushing something that comes back
    // as an error under the tile just chosen.
    const view = run();
    await view.settle();

    view.fire(view.byId('jb-grid')!.children[8]!, 'click');
    await view.settle();

    assert.deepEqual(lastSet(view)?.preset, { color: 'amber' });
    assert.equal(view.byId('jb-colours')!.style.display, '');
  });

  test('only the featured colours are shown until the rest are asked for', async () => {
    const view = run({ chosen: 'color_set', presetKind: 'colour', preset: { color: 'ocean' } });
    await view.settle();

    assert.equal(view.byId('jb-featured')!.children.length, 2);
    assert.equal(view.byId('jb-rest')!.style.display, 'none');

    view.fire(view.byId('jb-more')!, 'click');
    await view.settle();

    assert.equal(view.byId('jb-rest')!.children.length, 2);
    assert.equal(view.byId('jb-rest')!.style.display, '');
  });

  test('the brightness editor opens only under the job that carries one', async () => {
    const view = run();
    await view.settle();
    assert.equal(view.byId('jb-preset')!.style.display, 'none');

    view.fire(view.byId('jb-grid')!.children[5]!, 'click');
    await view.settle();

    assert.equal(view.byId('jb-preset')!.style.display, '');
    assert.deepEqual(lastSet(view)?.preset, { brightness: 0.6 });
  });

  test('"do nothing" clears the job, and takes the Test control with it', async () => {
    const view = run({ chosen: 'toggle' });
    await view.settle();
    assert.equal(view.byId('jb-tryCard')!.style.display, '');

    view.fire(view.byId('jb-none')!, 'click');
    await view.settle();

    assert.equal(lastSet(view)?.job, null);
    assert.equal(view.byId('jb-tryCard')!.style.display, 'none');
  });

  test('Test runs against the lights this button drives, not against all of them', async () => {
    const view = run({ chosen: 'toggle', chosenLights: ['l2'] });
    await view.settle();

    view.fire(view.byId('jb-try')!, 'click');
    await view.settle();

    assert.deepEqual(
      view.emitted.find(call => call.event === 'test')?.data,
      { func: 'toggle', deviceIds: ['l2'] },
    );
  });
});

/**
 * The harness's `textContent`, held to the DOM's rules.
 *
 * It was a plain field: a label built from `createTextNode` read back as empty
 * from its parent, and assigning it to an element left that element's children
 * in place. Two tests here had been asserting against that — one read a room
 * title as 'Hall' when a browser reads 'Hall›', the other counted every string
 * once per ancestor — so the rules are pinned where the next change to the
 * harness will meet them.
 */
describe('the pair-view harness DOM', () => {
  const html = `<div class="wrap" id="t-root"><p id="t-p">Static<b id="t-b">bold</b>text</p>`
    + `<div id="t-host"></div><script>
      var host = document.getElementById('t-host');
      var label = document.createElement('span');
      label.appendChild(document.createTextNode('made '));
      label.appendChild(document.createTextNode('of nodes'));
      host.appendChild(label);
    </script></div>`;

  test('reading textContent concatenates every descendant, text nodes included', () => {
    const view = runPairView(html);
    assert.equal(view.error, null);
    // No spaces at the tag boundaries on purpose: the parser trims the text
    // between two tags, because in these files it is almost always markup
    // indentation — a known departure from a browser, which would keep them.
    assert.equal(view.byId('t-p')!.textContent, 'Staticboldtext',
      'markup text and child elements, in document order');
    assert.equal(view.byId('t-host')!.textContent, 'made of nodes');
  });

  test('writing textContent replaces every child, elements too', () => {
    const view = runPairView(html);
    const p = view.byId('t-p')!;
    p.textContent = 'replaced';
    assert.equal(p.textContent, 'replaced');
    assert.equal(p.children.length, 0, 'the <b> is gone, as in a browser');
    assert.equal(view.byId('t-b'), null);
    assert.equal(p.childNodes.length, 1);
  });
});
