import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { runPairView } from '../support/pair-view-harness';

/**
 * Every pairing view actually RUNS, and asks the driver for its data.
 *
 * This is the test that was missing when `ends.html` shipped broken. It carried
 * the shared `stabiliseScrollbar()` helper, which reads `__root` by name, but had
 * been given its own boot preamble declaring `root` instead — so it threw
 * `ReferenceError: __root is not defined` before reaching its first `emit()`. The
 * screen rendered its static markup and then stopped, showing no error, because
 * the `.catch` was never reached.
 *
 * Everything that existed passed. The file matched its repair copy byte for byte,
 * its helpers matched the other views', its locale keys all resolved, and it
 * parsed. Nothing executed it, so nothing could see it.
 */

const DRIVERS = join(import.meta.dirname, '..', '..', 'drivers');

/** Every pair view on disk, as "<driver>/<file>". */
function views(): string[] {
  const found: string[] = [];
  for (const driver of readdirSync(DRIVERS)) {
    const dir = join(DRIVERS, driver, 'pair');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.html')) found.push(`${driver}/${file}`);
    }
  }
  return found.sort();
}

const read = (view: string) => {
  const [driver, file] = view.split('/');
  return readFileSync(join(DRIVERS, driver!, 'pair', file!), 'utf8');
};

/**
 * What each view asks for first, and what a plausible answer looks like.
 *
 * Enough for the view to get past its own boot and render something. The point is
 * not to assert the rendering — that is the driver's contract, tested elsewhere —
 * but that the script runs to completion and reaches its first `emit()`.
 */
const FIRST_CALL: Record<string, { event: string; reply: unknown }> = {
  // ---- shared by every driver ------------------------------------------
  'intro.html': {
    event: 'getIntro',
    reply: {
      title: 'Warm at night, cool at noon',
      blurb: 'Your lights follow the sun.',
      hero: 'day',
      decisions: [{ what: 'Which lights', why: 'Pick them by room' }],
      nextView: 'lights',
    },
  },
  'lights.html': {
    event: 'listTargets',
    reply: {
      rooms: [], zones: [], total: 0, current: null,
      subtitle: 'The lights this follows', stepIndex: 1, stepCount: 3, nextView: 'day',
    },
  },
  'review.html': {
    event: 'getReview',
    reply: { stepIndex: 3, stepCount: 3, rows: [], promise: 'It starts now.' },
  },
  'credential.html': {
    event: 'getCredentialStatus',
    reply: { present: true, valid: true, nextView: 'remote' },
  },

  // ---- circadian --------------------------------------------------------
  'day.html': {
    event: 'getDay',
    reply: {
      support: { onoff: 1, dim: 1, light_temperature: 1, total: 1 },
      lights: [],
      zones: {
        morning: { temperature: 0.78, brightness: 0.55 },
        midday: { temperature: 0.18, brightness: 0.9 },
        evening: { temperature: 0.86, brightness: 0.45 },
        morningEnd: 30,
        eveningStart: -60,
      },
      adjustBrightness: false,
      preStage: false,
      sun: { sunriseMinute: 390, sunsetMinute: 1180 },
      boundaries: {
        morningEndMinute: 420, morningEnd: '07:00',
        eveningStartMinute: 1120, eveningStart: '18:40',
        fromSun: true,
      },
      nextView: 'review',
      limits: { maxOffset: 150, offsetStep: 15, fallbackSunrise: 360, fallbackSunset: 1260 },
      timezone: 'Europe/Copenhagen',
    },
  },
  'tryit.html': {
    event: 'getPreview',
    reply: {
      points: [{ minute: 50, warmth: 0.8 }, { minute: 720, warmth: 0.2 }],
      nowMinute: 600,
    },
  },

  // ---- curve ------------------------------------------------------------
  'curve.html': {
    event: 'getCurve',
    reply: {
      points: [], palette: [], featuredColors: 8,
      adjustBrightness: false, preStage: false,
      minPoints: 2, maxPoints: 8,
    },
  },

  // ---- daylight ---------------------------------------------------------
  'sensor.html': {
    event: 'listSensors',
    reply: { rooms: [], selected: [], sky: null, sunsetAt: '19:48' },
  },
  'response.html': {
    event: 'getResponse',
    reply: {
      response: {
        sensor: null, darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25,
        darkElevation: -6, brightElevation: 25, sunPeak: 'flat',
      },
      sensorName: null, nowLux: null, week: null, staleFor: null,
      atDark: '20:18', atBright: '12:04',
    },
  },
  'sensordetail.html': {
    event: 'getSensorDetail',
    reply: { sensorName: 'Hall motion', nowLux: 41, week: null },
  },

  // ---- schedule ---------------------------------------------------------
  'blocks.html': {
    event: 'getSchedule',
    reply: {
      maxEntries: 12,
      support: { onoff: 1, dim: 1, light_temperature: 1, total: 1 },
      lights: [],
      entries: [{ id: 'a', onAt: 1140, end: { kind: 'time', at: 1380 } }],
      days: null,
      overlaps: [],
      timezone: 'Europe/Copenhagen',
    },
  },

  // ---- controller -------------------------------------------------------
  'remote.html': {
    // `checkReattach` fires first and its failure is swallowed — "this is not a
    // repair session" is the ordinary answer — so the call that has to succeed
    // for the screen to render is this one.
    event: 'listSources',
    reply: { rooms: [], current: null },
  },
  'buttons.html': {
    event: 'getButtons',
    reply: { gestures: [], jobs: {} },
  },
  'job.html': {
    event: 'getGesture',
    reply: {
      title: 'Left, pressed',
      jobs: [{ id: null, label: 'Nothing', needsPreset: false }],
      chosen: null, needsPreset: false, preset: null,
    },
  },
  'listen.html': {
    event: 'startListening',
    reply: { listening: true },
  },
};

describe('every pair view boots', () => {
  const all = views();

  test('there are views to run, discovered from disk', () => {
    assert.ok(all.length >= 8, `found ${all.length}: ${all.join(', ')}`);
  });

  test('each one has a first call declared here', () => {
    // So a new view cannot be added without saying what it asks for — which is
    // the same reason the other view tests discover their subjects from disk.
    for (const view of all) {
      const file = view.split('/')[1]!;
      assert.ok(FIRST_CALL[file], `${view} has no entry in FIRST_CALL`);
    }
  });

  for (const view of all) {
    const file = view.split('/')[1]!;

    test(`${view} runs without throwing`, () => {
      const expected = FIRST_CALL[file]!;
      const run = runPairView(read(view), {
        respond: { [expected.event]: expected.reply },
      });
      assert.equal(run.error, null, `${view} threw: ${(run.error as Error)?.message}`);
    });

    test(`${view} asks the driver for its data`, () => {
      const expected = FIRST_CALL[file]!;
      const run = runPairView(read(view), {
        respond: { [expected.event]: expected.reply },
      });
      assert.ok(
        run.emitted.some(call => call.event === expected.event),
        `${view} never emitted "${expected.event}" — it emitted `
        + `[${run.emitted.map(c => c.event).join(', ')}]`,
      );
    });
  }
});

describe('the day screen renders a day', () => {
  /**
   * The screen the two-ended one became.
   *
   * It is the hardest of the fifteen to boot — a gradient computed from the
   * zones, two handles placed against today's sunrise and sunset, a card for the
   * selected zone and rows for the other two — and every one of those depends on
   * the reply having arrived. The failure this pins is the one the old ends
   * screen actually shipped: a heading, some controls, and nothing between them.
   */
  const run = () => {
    const expected = FIRST_CALL['day.html']!;
    const zones = (expected.reply as { zones: unknown }).zones;
    return runPairView(read('circadian/day.html'), {
      respond: {
        [expected.event]: expected.reply,
        // Every interaction pushes the whole day back before doing anything
        // else, so the echo is stubbed here too.
        setDay: {
          zones,
          // The driver echoes what it ACCEPTED, and `sanitiseZones` accepts
          // `adjustBrightness` once every zone carries a brightness — which the
          // view ensures before it pushes. A stub that always echoed `false`
          // would turn the switch straight back off and hide a control the real
          // driver would have shown.
          adjustBrightness: true,
          corrected: [],
          boundaries: (expected.reply as { boundaries: unknown }).boundaries,
        },
      },
    });
  };

  test('the strip is painted, and both handles are placed on it', async () => {
    const view = run();
    await view.settle();

    const strip = view.byId('dy-strip');
    assert.ok(strip, 'no #dy-strip');
    assert.match(
      String(strip.style.background), /linear-gradient/,
      'the day strip is the control; an unpainted one is a screen with no day on it',
    );

    for (const id of ['dy-morningHandle', 'dy-eveningHandle']) {
      const handle = view.byId(id);
      assert.ok(handle, `no #${id}`);
      assert.match(String(handle.style.left), /%$/, `${id} was never placed`);
    }
  });

  test('sunrise and sunset are marked, because the offsets are read against them', async () => {
    const view = run();
    await view.settle();

    for (const id of ['dy-sunriseMark', 'dy-sunsetMark']) {
      const mark = view.byId(id);
      assert.ok(mark, `no #${id}`);
      assert.notEqual(mark.style.display, 'none', `${id} is hidden despite a sun being sent`);
    }
  });

  test('one zone is open and the other two are rows', async () => {
    const view = run();
    await view.settle();

    assert.ok(view.byId('dy-zoneName')?.textContent, 'the open zone has no name');
    const others = view.byId('dy-others');
    assert.ok(others, 'no #dy-others');
    assert.equal(others.children.length, 2, 'the two zones that are not open are rows');
  });

  test('brightness is off by default, and switching it on reveals the slider', async () => {
    // A circadian light changes colour; touching brightness is a separate
    // decision, so the control is not there until it is asked for.
    const view = run();
    await view.settle();

    const block = view.byId('dy-brightBlock');
    assert.ok(block, 'no #dy-brightBlock');
    assert.equal(block.style.display, 'none', 'brightness is opt-in');

    view.fire(view.byId('dy-brightToggle')!, 'click');
    await view.settle();
    assert.notEqual(block.style.display, 'none', 'switching it on shows the slider');
  });

  test('stepping a boundary pushes the whole day back', async () => {
    const view = run();
    await view.settle();

    view.fire(view.byId('dy-boundaryUp')!, 'click');
    await view.settle();

    assert.ok(
      view.emitted.some(call => call.event === 'setDay'),
      'the driver applies the clamp, so every step has to go through it',
    );
  });
});

describe('every view only uses classes its own stylesheet defines', () => {
  /**
   * The other half of what shipped broken: `ends.html` was written with `.head`,
   * `.title` and `.foot`, none of which exist, and `.btn primary` where the class
   * is `.btn-primary`. The screen rendered — unstyled, which reads as broken.
   */
  test('no view references a class nothing styles', () => {
    const problems: string[] = [];

    for (const view of views()) {
      const source = read(view);
      const rootId = /class="wrap" id="([\w-]+)"/.exec(source)?.[1];
      assert.ok(rootId, `${view}: no root id`);

      // Every class the view's own <style> mentions, at any depth: `#root .tile
      // .name` is a rule for `.name`, and a pattern anchored to the root id
      // immediately followed by the class cannot see it.
      const style = source.slice(source.indexOf('<style>'), source.indexOf('</style>'));
      const styled = new Set([...style.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]!));
      // `wrap` names the root itself, and the base styles a handful of bare
      // elements (h2, p, button) rather than classes.
      styled.add('wrap');

      /**
       * Only tokens that could BE a class name.
       *
       * Two views build their markup as strings, so a `class="…"` match there
       * captures the concatenation — `tab' + (isDuration ? ' on' : '') + '` — and
       * every fragment of it. The real class names in that expression appear as
       * bare tokens anyway (`tab`, `on`), so dropping anything that is not a
       * plausible identifier loses nothing and invents nothing.
       */
      const CLASS_NAME = /^[a-zA-Z][\w-]*$/;
      const used = new Set<string>();
      const collect = (value: string) => {
        for (const name of value.trim().split(/\s+/)) {
          if (CLASS_NAME.test(name)) used.add(name);
        }
      };
      for (const [, value] of source.matchAll(/class="([^"{}]+)"/g)) collect(value!);
      // Classes the SCRIPT builds, which the markup never names.
      for (const [, value] of source.matchAll(/node\('[\w#]+', '([^'{}]+)'/g)) collect(value!);

      for (const name of used) {
        if (!styled.has(name)) problems.push(`${view}: .${name}`);
      }
    }

    assert.deepEqual(
      problems, [],
      'a class the view uses that its own scoped stylesheet never defines — the '
      + 'view renders, unstyled, which reads as broken',
    );
  });
});
