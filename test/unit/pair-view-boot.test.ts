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
  'credential.html': {
    event: 'getCredentialStatus',
    reply: { present: true, valid: true, nextView: 'source' },
  },
  'source.html': {
    event: 'listSources',
    reply: { rooms: [], selectedId: null },
  },
  'targets.html': {
    event: 'listTargets',
    reply: { rooms: [], zones: [], selection: { kind: 'devices', deviceIds: [] } },
  },
  'mapping.html': {
    event: 'getMapping',
    reply: { functions: [], groups: [], controls: [], rules: [], lights: [] },
  },
  'schedule.html': {
    event: 'getSchedule',
    reply: {
      maxEntries: 12, support: { dim: 1, light_temperature: 1 }, lights: [],
      entries: [], timezone: 'Europe/Copenhagen',
    },
  },
  'curve.html': {
    event: 'getCurve',
    reply: {
      minPoints: 2, maxPoints: 8, support: { dim: 1, light_temperature: 1 }, lights: [],
      points: [
        { id: 'p1', anchor: { kind: 'clock', at: 360 }, warmth: 0.2 },
        { id: 'p2', anchor: { kind: 'clock', at: 1260 }, warmth: 1 },
      ],
      palette: [{ id: 'amber', label: 'Amber', hue: 0.11, saturation: 0.75 }],
      adjustBrightness: false, preStage: false, timezone: 'Europe/Copenhagen',
    },
  },
  'ends.html': {
    event: 'getEnds',
    reply: {
      support: { dim: 1, light_temperature: 1 },
      lights: [{ id: 'l1', name: 'Lamp', zoneName: 'Hall' }],
      warmest: { temperature: 1, brightness: 0.5 },
      coolest: { temperature: 0.15, brightness: 0.9 },
      adjustBrightness: false,
      preStage: false,
      shape: [
        { at: '06:00', end: 'warmest' }, { at: '11:00', end: 'coolest' },
        { at: '15:00', end: 'coolest' }, { at: '21:00', end: 'warmest' },
      ],
      timezone: 'Europe/Copenhagen',
    },
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

describe('the two ends screen renders both ends', () => {
  const run = () => {
    const expected = FIRST_CALL['ends.html']!;
    return runPairView(read('circadian/ends.html'), {
      // Every interaction pushes both ends back before doing anything else, so
      // the save path is stubbed here too.
      respond: {
        [expected.event]: expected.reply,
        setEnds: { warmest: {}, coolest: {}, adjustBrightness: false, corrected: [] },
      },
    });
  };

  test('two cards, one per end, each named and timed', async () => {
    // The failure this pins: the screen showed its heading, its checkboxes and
    // its buttons, and nothing between them.
    const view = run();
    await view.settle();

    const list = view.byId('end-list');
    assert.ok(list, 'no #end-list');
    assert.equal(list.children.length, 2, 'one card per end');

    const names = list.descendants()
      .filter(node => node.className === 'name')
      .map(node => node.textContent);
    assert.deepEqual(names, ['circadian.end_warmest', 'circadian.end_coolest']);

    const when = list.descendants().filter(node => node.className === 'when');
    assert.equal(when.length, 2, 'each end says roughly when it applies');
    for (const node of when) assert.notEqual(node.textContent, '', 'and says it non-empty');
  });

  test('a warmth slider per end, and a brightness one where the lights dim', async () => {
    const view = run();
    await view.settle();

    const ranges = view.byId('end-list')!.descendants().filter(node => node.type === 'range');
    assert.equal(ranges.length, 4, 'warmth and brightness, twice');
    // Warmest at 100, coolest at 15: the stored values, not the defaults.
    assert.deepEqual(ranges.map(node => node.value), ['100', '50', '15', '90']);
  });

  test('the brightness-following row is revealed only when the lights dim', async () => {
    const withDim = run();
    await withDim.settle();
    assert.equal(withDim.byId('end-brightnessRow')!.style.display, 'flex');

    const expected = FIRST_CALL['ends.html']!;
    const withoutDim = runPairView(read('circadian/ends.html'), {
      respond: {
        [expected.event]: {
          ...(expected.reply as Record<string, unknown>),
          support: { dim: 0, light_temperature: 1 },
        },
      },
    });
    await withoutDim.settle();
    assert.equal(withoutDim.byId('end-brightnessRow')!.style.display, 'none');
    // And no brightness slider at all, rather than one that is ignored.
    const ranges = withoutDim.byId('end-list')!.descendants().filter(node => node.type === 'range');
    assert.equal(ranges.length, 2);
  });

  test('the summary names the lights and the clock', async () => {
    const view = run();
    await view.settle();
    assert.notEqual(view.byId('end-summary')!.textContent, '');
  });

  test('moving a slider sends both ends back', async () => {
    const view = run();
    await view.settle();

    const warmth = view.byId('end-list')!.descendants().find(node => node.type === 'range')!;
    warmth.value = '40';
    view.fire(warmth, 'input');

    const label = view.byId('end-list')!.querySelector('.value');
    assert.equal(label?.textContent, 'schedule.warmthNeutral', 'the label follows the slider');

    view.fire(warmth, 'change');
    await view.settle();

    const sent = view.emitted.filter(call => call.event === 'setEnds');
    assert.equal(sent.length, 1);
    assert.equal((sent[0]!.data as { warmest: { temperature: number } }).warmest.temperature, 0.4);
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
