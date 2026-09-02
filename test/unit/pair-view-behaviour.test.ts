import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runPairView, type FakeNode, type ViewRun } from '../support/pair-view-harness';

/**
 * What the pairing SCREENS refuse, and what they draw.
 *
 * `pair-view-boot.test.ts` proves every view starts and asks the driver for its
 * data. This one proves the rules a person would otherwise verify by hand on a
 * phone, and it exists because those rules were the largest block of
 * `docs/hardware-test-plan.md`: T15, and the old 2.3, 2.6, 4.3, 5.2, 5.3 and 5.6,
 * were seven hardware steps for behaviour that never needed a Homey at all.
 *
 * The rules themselves are ALSO enforced server-side and tested there —
 * `dedupeByInputKey` in mapping-and-state, `entriesOverlap` in schedule-overlap,
 * `sanitiseCurve` in circadian-types. That is not duplication: the server-side
 * test proves a bad save is rejected, and this proves the user is stopped before
 * making one. A screen that lets you build something the driver will silently
 * drop is exactly the "looks configured and does nothing" failure this app
 * exists to prevent.
 */

const DRIVERS = join(import.meta.dirname, '..', '..', 'drivers');

const read = (driver: string, file: string) =>
  readFileSync(join(DRIVERS, driver, 'pair', file), 'utf8');

/** Every range/select/button under a node, for terse assertions. */
const inputsOf = (node: FakeNode, type: string) =>
  node.descendants().filter(n => n.type === type);

// --------------------------------------------------------------- credential

describe('the API key screen (2.2, 2.3)', () => {
  const status = { present: false, valid: false, nextView: 'source' };

  const open = (reply: unknown, onSave?: unknown) => runPairView(read('controller', 'credential.html'), {
    respond: { getCredentialStatus: reply, ...(onSave === undefined ? {} : { setCredential: onSave }) },
  });

  test('with no key saved it shows the form rather than skipping ahead', async () => {
    const view = open(status);
    await view.settle();

    assert.equal(view.byId('cr-wrap')!.style.visibility, 'visible');
    assert.deepEqual(view.shown, [], 'it must not navigate past a screen the user needs');
  });

  test('with a working key it skips straight to the next screen', async () => {
    // The other half of 3.1: a schedule paired after a controller must not ask
    // for the key again. The driver says which view follows, because this file
    // is byte-shared between drivers and cannot know.
    const view = open({ present: true, valid: true, nextView: 'targets' });
    await view.settle();

    assert.deepEqual(view.shown, ['targets']);
    assert.notEqual(view.byId('cr-wrap')!.style.visibility, 'visible',
      'a user with a key should never see the setup screen flash past');
  });

  test('nonsense is refused, and the screen stays put', async () => {
    // 2.3. The refusal wording comes from the driver's classification, not from
    // the view guessing — `failureText` maps `failure` to a locale key.
    const view = open(status, { present: false, valid: false, failure: 'malformed' });
    await view.settle();

    view.byId('cr-key')!.value = 'not-a-key';
    view.fire(view.byId('cr-save')!, 'click');
    await view.settle();

    const message = view.byId('cr-msg')!;
    assert.equal(message.textContent, 'credential.malformed');
    assert.equal(message.className, 'msg bad');
    assert.deepEqual(view.shown, [], 'a refused key must not advance the session');
  });

  test('an empty box is refused without troubling the driver', async () => {
    const view = open(status);
    await view.settle();

    view.byId('cr-key')!.value = '   ';
    view.fire(view.byId('cr-save')!, 'click');
    await view.settle();

    assert.equal(view.byId('cr-msg')!.textContent, 'credential.pasteFirst');
    assert.equal(view.emitted.filter(c => c.event === 'setCredential').length, 0);
  });

  test('an accepted key advances to the view the driver named', async () => {
    const view = open(status, { present: true, valid: true });
    await view.settle();

    view.byId('cr-key')!.value = 'a-real-looking-key';
    view.fire(view.byId('cr-save')!, 'click');
    await view.settle();

    assert.deepEqual(view.shown, ['source']);
  });
});

// ------------------------------------------------------------------ mapping

describe('the mapping screen keeps one rule per gesture (2.6)', () => {
  /**
   * Two lights, so the screen renders "All lights" plus a per-light section and
   * a gesture can be displaced ACROSS sections — which is the case that made
   * this worth testing: the losing row can be in a collapsed section, screens
   * away from the one the user is looking at.
   */
  const MAPPING = {
    functions: [
      { function: 'toggle', label: 'Toggle', capability: 'onoff' },
      { function: 'brightness_up', label: 'Brighter', capability: 'dim' },
    ],
    groups: [
      { key: '__all__', label: 'All lights', capabilities: ['onoff', 'dim'], deviceIds: ['l1', 'l2'] },
      { key: 'l1', label: 'Hall lamp', zoneName: 'Hall', capabilities: ['onoff', 'dim'], deviceIds: ['l1'] },
    ],
    controls: [
      {
        id: 'button1',
        label: 'Button one',
        inputs: [
          { key: 'button1:short', label: 'Short press' },
          { key: 'button1:long', label: 'Long press' },
        ],
      },
    ],
    rules: [],
    lights: [{ id: 'l1', name: 'Hall lamp' }, { id: 'l2', name: 'Kitchen lamp' }],
  };

  const open = () => runPairView(read('controller', 'mapping.html'), {
    respond: { getMapping: MAPPING, setRules: { count: 0 } },
  });

  /**
   * The select for one (section, function) pair.
   *
   * Located structurally, because the view carries no ids or data attributes on
   * these — it tracks them in a `widgets.selects` registry a test cannot reach.
   * So this walks the same path a user's eye does: find the section by its
   * title, then the row by its label.
   */
  function selectFor(view: ViewRun, groupLabel: string, functionLabel: string): FakeNode {
    const section = view.root.querySelectorAll('details').find(details =>
      details.querySelector('.group-title')?.textContent === groupLabel);
    assert.ok(section, `no section titled "${groupLabel}"`);

    const row = section.querySelectorAll('.fn').find(fn =>
      fn.querySelector('.label')?.textContent === functionLabel);
    assert.ok(row, `no "${functionLabel}" row in "${groupLabel}"`);

    const select = row.querySelectorAll('select')[0];
    assert.ok(select, `no select in the "${functionLabel}" row`);
    return select;
  }

  test('the screen renders a section per group, with the gestures of this remote', async () => {
    // 2.5's other half: the list must be THIS remote's events, not a generic set.
    const view = open();
    await view.settle();

    const sections = view.root.descendants().filter(n => n.tagName === 'details');
    assert.equal(sections.length, 2, 'one "All lights" section and one per light');

    // The gestures come from `controls`, which the driver discovered on THIS
    // remote. A generic list here would be the bug 2.5 is looking for.
    const options = selectFor(view, 'All lights', 'Toggle')
      .querySelectorAll('option').map(n => n.value);
    assert.deepEqual(options, ['', 'button1:short', 'button1:long'],
      'the empty "not assigned" option, then the gestures of this remote');
  });

  test('assigning a gesture already in use takes it away from the first row', async () => {
    const view = open();
    await view.settle();

    const first = selectFor(view, 'All lights', 'Toggle');
    first.value = 'button1:short';
    view.fire(first, 'change');
    await view.settle();

    const second = selectFor(view, 'All lights', 'Brighter');
    second.value = 'button1:short';
    view.fire(second, 'change');
    await view.settle();

    const sent = view.emitted.filter(c => c.event === 'setRules');
    const rules = sent[sent.length - 1]!.data as Array<{ function: string; inputKey: string }>;
    const assigned = rules.filter(r => r.inputKey);

    assert.equal(assigned.length, 1, `two rows kept the same gesture: ${JSON.stringify(rules)}`);
    assert.equal(assigned[0]!.function, 'brightness_up', 'the row just set should keep it');
    assert.equal(first.value, '', 'the displaced row must be visibly cleared, not silently dropped');
  });

  test('both rows say what happened, where it happened', async () => {
    /**
     * The regression: this used to be one sentence at the foot of a very tall
     * page, so the only thing the user saw was a row resetting to "Not
     * assigned" — later, and with no explanation.
     */
    const view = open();
    await view.settle();

    const first = selectFor(view, 'All lights', 'Toggle');
    first.value = 'button1:short';
    view.fire(first, 'change');
    await view.settle();

    const second = selectFor(view, 'Hall lamp', 'Toggle');
    second.value = 'button1:short';
    view.fire(second, 'change');
    await view.settle();

    const notes = view.root.descendants()
      .filter(n => n.className.split(/\s+/).includes('fn-note'))
      .filter(n => n.style.display === 'block');
    assert.equal(notes.length, 2, 'the row that lost it and the row that took it');
    assert.deepEqual(
      notes.map(n => n.textContent).sort(),
      ['mapping.movedTo', 'mapping.takenFrom'],
    );

    // And the losing row's section is opened, or the note is as invisible as
    // the page-foot message it replaced.
    const moved = notes.find(n => n.textContent === 'mapping.movedTo')!;
    assert.equal(moved.closest('details')?.open, true);
  });

  test('clearing a row removes its rule rather than leaving an empty one', async () => {
    const view = open();
    await view.settle();

    const select = selectFor(view, 'All lights', 'Toggle');
    select.value = 'button1:short';
    view.fire(select, 'change');
    await view.settle();

    select.value = '';
    view.fire(select, 'change');
    await view.settle();

    const sent = view.emitted.filter(c => c.event === 'setRules');
    assert.deepEqual(sent[sent.length - 1]!.data, []);
  });
});

// ----------------------------------------------------------------- schedule

describe('the schedule screen refuses overlapping windows (3.4)', () => {
  /**
   * The refusal is on SAVE, not on add.
   *
   * The screen lets you build any two windows it likes; `sanitiseEntries` in the
   * driver is what drops the later of an overlapping pair, and the screen's job
   * is to turn that `dropped` list back into a sentence rather than saving a
   * device that quietly holds one window fewer than the user typed.
   *
   * Which is worth saying plainly, because the test-plan line reads "it should
   * refuse to save, saying the windows overlap" — and it is the save that
   * refuses. A test that asserted a refusal on `Add` would have been asserting
   * against a screen that does not exist.
   */
  const SCHEDULE = {
    maxEntries: 12,
    support: { onoff: 2, dim: 2, light_temperature: 2, total: 2 },
    lights: [{ id: 'l1', name: 'Hall lamp', zoneName: 'Hall' }],
    entries: [],
    timezone: 'Europe/Copenhagen',
  };

  const open = (entries: unknown[], setSchedules: unknown) =>
    runPairView(read('schedule', 'schedule.html'), {
      respond: {
        getSchedule: { ...SCHEDULE, entries },
        setSchedules,
        save: { created: true, device: { name: 'Schedule', data: { id: 'lk-sched-1' } } },
        add_device: true,
      },
    });

  /** Two windows over the same lights, the second inside the first. */
  const OVERLAPPING = [
    { id: 'a', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 120 } },
    { id: 'b', onAt: 21 * 60, days: null, end: { kind: 'duration', minutes: 30 } },
  ];

  test('a dropped overlap stops the save and says which it was', async () => {
    const view = open(OVERLAPPING, {
      count: 1,
      dropped: [{ id: 'b', reason: 'overlaps schedule "a"' }],
    });
    await view.settle();
    assert.equal(view.byId('sch-list')!.querySelectorAll('.card').length, 2);

    view.fire(view.byId('sch-save')!, 'click');
    await view.settle();

    const message = view.byId('sch-msg')!;
    assert.equal(message.className, 'msg bad');
    assert.equal(message.textContent, 'schedule.droppedOverlap',
      'an overlap gets its own sentence — the rows both look complete, so '
      + '"check the times" would read as a typo hunt');

    // And nothing was saved. A device created here would hold one window fewer
    // than the screen is showing.
    assert.equal(view.emitted.filter(c => c.event === 'save').length, 0);
    assert.deepEqual(view.created, []);
    assert.equal(view.finished, false);

    // The save button is handed back, or the screen is a dead end.
    assert.equal(view.byId('sch-save')!.disabled, false);
  });

  test('a drop for any other reason gets the general sentence', async () => {
    const view = open(OVERLAPPING, {
      count: 1,
      dropped: [{ id: 'b', reason: 'on-time is not a minute of the day' }],
    });
    await view.settle();

    view.fire(view.byId('sch-save')!, 'click');
    await view.settle();

    assert.equal(view.byId('sch-msg')!.textContent, 'schedule.droppedSome');
    assert.equal(view.emitted.filter(c => c.event === 'save').length, 0);
  });

  test('windows the driver accepts whole do save', async () => {
    // The control: without this, the two tests above would pass on a screen
    // that could never save anything at all.
    const view = open(
      [{ id: 'a', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 120 } }],
      { count: 1, dropped: [] },
    );
    await view.settle();

    view.fire(view.byId('sch-save')!, 'click');
    await view.settle();

    assert.equal(view.emitted.filter(c => c.event === 'save').length, 1);
    assert.equal(view.created.length, 1, 'createDevice stages it');
    assert.ok(view.emitted.some(c => c.event === 'add_device'),
      'createDevice alone does not add the device — the view must emit add_device too');
    assert.equal(view.finished, true);
  });

  test('pairing opens with one window already there', async () => {
    // An empty screen with an "add" button makes the user do a step the app
    // could have done for them — and it is why the "no windows" case below has
    // to be reached by REMOVING one rather than by starting with none.
    const view = open([], { count: 1, dropped: [] });
    await view.settle();

    assert.equal(view.byId('sch-list')!.querySelectorAll('.card').length, 1);
  });

  test('removing the last window blocks the save, without troubling the driver', async () => {
    const view = open([], { count: 0, dropped: [] });
    await view.settle();

    view.click(view.byId('sch-list')!.querySelectorAll('[data-act="remove"]')[0]!);
    await view.settle();
    assert.equal(view.byId('sch-list')!.querySelectorAll('.card').length, 0);

    view.fire(view.byId('sch-save')!, 'click');
    await view.settle();

    assert.equal(view.byId('sch-msg')!.textContent, 'schedule.needOne');
    assert.equal(view.emitted.filter(c => c.event === 'setSchedules').length, 0,
      'a schedule with no windows is not a device worth building');
  });

  test('the cap is enforced on screen, not only on save', async () => {
    // Twelve windows is twenty-four generated Flows; past that the user's own
    // Flow list stops being readable, which is why the cap exists at all.
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`, onAt: i * 60, days: null, end: { kind: 'duration', minutes: 30 },
    }));
    const view = open(entries, { count: 12, dropped: [] });
    await view.settle();

    view.fire(view.byId('sch-add')!, 'click');
    await view.settle();

    assert.equal(view.byId('sch-list')!.querySelectorAll('.card').length, 12,
      'a thirteenth window must not appear');
    assert.equal(view.byId('sch-msg')!.className, 'msg bad');
  });
});

// -------------------------------------------------------------------- curve

describe('the curve screen (5.2, 5.3, 5.6)', () => {
  const PALETTE = [
    { id: 'amber', label: 'Amber', hue: 0.11, saturation: 0.75 },
    { id: 'ocean', label: 'Ocean', hue: 0.55, saturation: 0.6 },
  ];

  const point = (id: string, at: number, warmth: number, color?: string) => ({
    id, anchor: { kind: 'clock', at }, warmth, ...(color ? { color } : {}),
  });

  const open = (points: unknown[]) => runPairView(read('curve', 'curve.html'), {
    respond: {
      getCurve: {
        minPoints: 2,
        maxPoints: 8,
        support: { onoff: 1, dim: 1, light_temperature: 1, total: 1 },
        lights: [{ id: 'l1', name: 'Hall lamp', zoneName: 'Hall' }],
        points,
        palette: PALETTE,
        adjustBrightness: false,
        preStage: false,
        timezone: 'Europe/Copenhagen',
      },
      setCurve: { count: points.length, adjustBrightness: false, dropped: [] },
    },
  });

  const dots = (view: ViewRun) => view.byId('cir-dots')!.children;

  test('the chart draws one dot per point, and follows an added one', async () => {
    const view = open([point('p1', 360, 0.9), point('p2', 1260, 0.3)]);
    await view.settle();

    assert.equal(dots(view).length, 2);
    assert.equal(view.byId('cir-list')!.querySelectorAll('.card').length, 2);

    view.fire(view.byId('cir-add')!, 'click');
    await view.settle();

    assert.equal(dots(view).length, 3, 'the chart must follow the points');
    assert.equal(view.byId('cir-list')!.querySelectorAll('.card').length, 3);
  });

  test('and follows a removed one, down to the minimum', async () => {
    const view = open([point('p1', 360, 0.9), point('p2', 1260, 0.3), point('p3', 720, 0.5)]);
    await view.settle();
    assert.equal(dots(view).length, 3);

    const remove = view.byId('cir-list')!.querySelectorAll('[data-act="remove"]')[0]!;
    view.click(remove);
    await view.settle();

    assert.equal(dots(view).length, 2);

    // At the minimum the remove buttons are not offered at all: a curve of one
    // point is a fixed colour that would look configured and do nothing.
    assert.equal(view.byId('cir-list')!.querySelectorAll('[data-act="remove"]').length, 0);
  });

  test('a coloured point is drawn in its colour, and larger (5.3)', async () => {
    const view = open([point('p1', 360, 0.9, 'amber'), point('p2', 1260, 0.3)]);
    await view.settle();

    const [amber, plain] = dots(view);

    /**
     * Asserted on `style`, and that distinction is the whole test.
     *
     * The view used to set a `fill` ATTRIBUTE here. It was there, it was the
     * right colour, and it drew nothing: `.dot` carries `fill: var(--lk-surface)`
     * in this view's own stylesheet, and a CSS declaration beats a presentation
     * attribute. A test asserting the attribute passed the entire time the
     * screen was wrong — which is what a rendered contact sheet is for, and why
     * this assertion moved rather than being deleted.
     */
    // hsl(40, 75%, 55%) — the palette entry, not a colour this test invented.
    assert.equal(amber!.style.fill, 'hsl(40, 75%, 55%)');
    assert.equal(amber!.getAttribute('r'), '4.5');

    assert.equal(plain!.style.fill, undefined, 'an uncoloured point keeps the chart colour');
    assert.equal(plain!.getAttribute('fill'), null, 'and sets no fill any other way either');
    assert.equal(plain!.getAttribute('r'), '3.5');
  });

  test('setting a colour on screen recolours that dot without a round trip', async () => {
    const view = open([point('p1', 360, 0.9), point('p2', 1260, 0.3)]);
    await view.settle();
    assert.equal(dots(view)[0]!.style.fill, undefined);

    const colour = view.byId('cir-list')!.querySelectorAll('[data-act="colour"]')[0]!;
    colour.value = 'ocean';
    view.click(colour, 'change');
    await view.settle();

    assert.equal(dots(view)[0]!.style.fill, 'hsl(198, 60%, 55%)');
    assert.equal(dots(view)[0]!.getAttribute('r'), '4.5');
  });

  test('the colour list offers the palette the driver sent, plus "no colour"', async () => {
    // The palette is closed on purpose — a colour a downgrade knows and this
    // build does not is a quarantine, never a default — so the screen must not
    // invent entries.
    const view = open([point('p1', 360, 0.9), point('p2', 1260, 0.3)]);
    await view.settle();

    const options = view.byId('cir-list')!.querySelectorAll('[data-act="colour"]')[0]!
      .querySelectorAll('option').map(o => o.getAttribute('value'));
    assert.deepEqual(options, ['', 'amber', 'ocean']);
  });

  test('the warmth note appears only on a coloured point, and follows the select', async () => {
    /**
     * The one control on this screen whose label stops being the whole truth.
     * Choosing "amber" leaves a warmth slider that does nothing visible on a
     * colour bulb — it is still what colourless lamps are written to, and what
     * the neighbouring segments interpolate towards — so the explanation has to
     * be next to the slider rather than at the top of a page four points up.
     */
    const view = open([point('p1', 360, 0.9, 'amber'), point('p2', 1260, 0.3)]);
    await view.settle();

    const notes = view.byId('cir-list')!.querySelectorAll('[data-role="warmthNote"]');
    assert.equal(notes.length, 2, 'every point carries the note, hidden or not');
    assert.equal(notes[0]!.textContent, 'circadian.colourHelp');
    assert.ok(!notes[0]!.classList.contains('off'), 'the coloured point shows it');
    assert.ok(notes[1]!.classList.contains('off'), 'the uncoloured point does not');

    // Choosing a colour must show it WITHOUT a re-render: the row is left alone
    // on a colour change, so a note added by render() would never appear.
    const colour = view.byId('cir-list')!.querySelectorAll('[data-act="colour"]')[1]!;
    colour.value = 'ocean';
    view.click(colour, 'change');
    await view.settle();

    assert.ok(!notes[1]!.classList.contains('off'), 'and choosing one shows it in place');

    // And back off again, on the same node.
    colour.value = '';
    view.click(colour, 'change');
    await view.settle();

    assert.ok(notes[1]!.classList.contains('off'), 'clearing the colour hides it again');
  });

  test('a ninth point is refused, and the screen says so (5.6)', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => point(`p${i}`, i * 150, 0.5));
    const view = open(eight);
    await view.settle();

    assert.equal(dots(view).length, 8);
    // The button is disabled at the cap, which is the honest way to say "no".
    assert.equal(view.byId('cir-add')!.disabled, true);

    // And pressing it anyway — which a disabled button in a webview still
    // allows through some input paths — must not add a ninth.
    view.fire(view.byId('cir-add')!, 'click');
    await view.settle();

    assert.equal(dots(view).length, 8, 'a ninth point must not appear');
    assert.equal(view.byId('cir-msg')!.className, 'msg bad');
    assert.equal(view.byId('cir-msg')!.textContent, 'circadian.atMost');
  });

  test('moving the warmth slider updates its label and the chart', async () => {
    const view = open([point('p1', 360, 0.9), point('p2', 1260, 0.3)]);
    await view.settle();

    const before = dots(view)[0]!.getAttribute('cy');
    // `input`, not `change`: the view updates sliders in place on `input` so a
    // drag does not re-render the list out from under the pointer.
    const warmth = view.byId('cir-list')!.querySelectorAll('[data-act="warmth"]')[0]!;
    warmth.value = '10';
    view.click(warmth, 'input');
    await view.settle();

    assert.notEqual(dots(view)[0]!.getAttribute('cy'), before, 'the dot should move');
  });
});

// --------------------------------------------------------------------- ends

describe('the two ends screen says when each end applies (the old 4.3)', () => {
  test('each end names both of its clock times, from the shape the driver sent', async () => {
    /**
     * A slider labelled "warmest" with no times beside it is a slider whose
     * effect the user has to guess at. The shape is a constant in `lib/` and
     * this screen is its only consumer, so it arrives rather than being
     * hardcoded — and that means it can arrive wrong.
     */
    const view = runPairView(read('circadian', 'ends.html'), {
      respond: {
        getEnds: {
          support: { onoff: 1, dim: 1, light_temperature: 1, total: 1 },
          lights: [{ id: 'l1', name: 'Hall lamp', zoneName: 'Hall' }],
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
        setEnds: { warmest: {}, coolest: {}, adjustBrightness: false, corrected: [] },
      },
      // The real tokens, so the times themselves are asserted rather than a key.
      translate: (key, tokens) => `${key}:${Object.values(tokens ?? {}).join(',')}`,
    });
    await view.settle();

    const when = view.byId('end-list')!.querySelectorAll('.when').map(n => n.textContent);
    assert.equal(when.length, 2);
    assert.ok(when[0]!.includes('06:00') && when[0]!.includes('21:00'),
      `the warmest end should name its two times, got "${when[0]}"`);
    assert.ok(when[1]!.includes('11:00') && when[1]!.includes('15:00'),
      `the coolest end should name its two times, got "${when[1]}"`);
  });

  test('an end with a single time in the shape still says something', async () => {
    // The shape is a constant today, but the screen must not produce an empty
    // caption if it ever carries one point for an end.
    const view = runPairView(read('circadian', 'ends.html'), {
      respond: {
        getEnds: {
          support: { onoff: 1, dim: 0, light_temperature: 1, total: 1 },
          lights: [{ id: 'l1', name: 'Hall lamp', zoneName: 'Hall' }],
          warmest: { temperature: 1 },
          coolest: { temperature: 0.15 },
          adjustBrightness: false,
          preStage: false,
          shape: [{ at: '07:00', end: 'warmest' }, { at: '12:00', end: 'coolest' }],
          timezone: 'Europe/Copenhagen',
        },
        setEnds: { warmest: {}, coolest: {}, adjustBrightness: false, corrected: [] },
      },
    });
    await view.settle();

    for (const node of view.byId('end-list')!.querySelectorAll('.when')) {
      assert.notEqual(node.textContent, '');
    }
    // dim: 0, so no brightness sliders are offered at all.
    assert.equal(inputsOf(view.byId('end-list')!, 'range').length, 2);
  });
});

// ------------------------------------------------------------- light picker

/**
 * The one pairing screen all FOUR device types share, and it had no behaviour
 * test.
 *
 * Its only executed path in the suite was the empty-house early return: the boot
 * fixture replies with `rooms: []`, so nothing ever reached the tiles, the zone
 * select or `refresh()` — which means no `selectTargets` round trip was
 * exercised anywhere, in any driver.
 *
 * The failure path is the one that matters. `selectTargets` had no `.catch`, so
 * on any rejection — a stale device id, a repair whose stored zone was deleted, a
 * transient catalogue read, the emit timeout, or deselecting the last light — the
 * tiles and the count went on showing one thing while the pair session held
 * another, silently. Nothing downstream re-sends or re-checks it, so Next and
 * then Save could create a device aimed at lights the user never chose.
 */
describe('the light picker', () => {
  const HOUSE = {
    rooms: [{
      zoneName: 'Kitchen',
      lights: [
        { id: 'l1', name: 'Ceiling', capabilities: ['onoff', 'dim'], selected: false },
        { id: 'l2', name: 'Counter', capabilities: ['onoff'], selected: false },
      ],
    }],
    zones: [{ id: 'z1', name: 'Kitchen' }],
  };

  const support = { onoff: 2, dim: 1, light_temperature: 0, total: 2 };

  const open = (respond: Record<string, unknown>) =>
    runPairView(read('controller', 'targets.html'), { respond });

  const tiles = (view: ViewRun) =>
    view.root.descendants().filter(n => (n.className ?? '').split(' ').includes('tile'));

  test('it draws a tile per light, grouped by room', async () => {
    const view = open({ listTargets: HOUSE, selectTargets: { count: 0, support } });
    await view.settle();

    assert.ok(!view.error, String(view.error));
    assert.equal(tiles(view).length, 2, 'one tile per light');

    const names = view.root.descendants()
      .filter(n => (n.className ?? '').split(' ').includes('name'))
      .map(n => n.textContent);
    assert.deepEqual(names, ['Ceiling', 'Counter']);

    const rooms = view.root.descendants()
      .filter(n => (n.className ?? '').split(' ').includes('section-title'))
      .map(n => n.textContent);
    assert.deepEqual(rooms, ['Kitchen'], 'grouped per room — a flat grid of a whole house is unusable');
  });

  test('tapping a light selects it and tells the driver', async () => {
    const view = open({ listTargets: HOUSE, selectTargets: { count: 1, support } });
    await view.settle();

    view.click(tiles(view)[0]!);
    await view.settle();

    const sent = view.emitted.filter(c => c.event === 'selectTargets');
    assert.ok(sent.length > 0, 'the session was told');
    assert.deepEqual((sent.at(-1)!.data as any).deviceIds, ['l1']);
    assert.ok((tiles(view)[0]!.className ?? '').includes('sel'), 'and the tile shows it');
  });

  /**
   * The regression this describe block exists for. With no stub the harness
   * rejects, which is what a stale id or a timed-out emit does.
   */
  test('a refused selectTargets is reported, not swallowed', async () => {
    const view = open({ listTargets: HOUSE });
    await view.settle();

    view.click(tiles(view)[0]!);
    await view.settle();

    const banner = view.byId('tg-loadError')!;
    assert.equal(banner.style.display, 'block',
      'the screen must not go on showing a selection the session does not have');
    assert.ok(banner.textContent.length > 0);
  });

  test('the message is reachable in ZONE mode too', async () => {
    // `#tg-loadError` used to live inside `#tg-devicesPane`, which switchMode
    // hides in zone mode — so a failure while picking a zone was invisible.
    const view = open({ listTargets: HOUSE });
    await view.settle();

    const zoneTab = view.root.descendants()
      .find(n => n.attributes['data-mode'] === 'zone')!;
    view.fire(zoneTab, 'click');
    await view.settle();

    assert.equal(view.byId('tg-devicesPane')!.style.display, 'none', 'the pane really is hidden');
    assert.equal(view.byId('tg-loadError')!.style.display, 'block', 'and the message is not');
  });

  test('a later success clears the message', async () => {
    // `fail()` never cleared, so one transient failure would otherwise leave a
    // red banner up for the rest of the session.
    let allow = false;
    const view = runPairView(read('controller', 'targets.html'), {
      respond: {
        listTargets: HOUSE,
        get selectTargets() {
          if (!allow) throw new Error('refused');
          return { count: 1, support };
        },
      },
    });
    await view.settle();

    view.click(tiles(view)[0]!);
    await view.settle();
    assert.equal(view.byId('tg-loadError')!.style.display, 'block');

    allow = true;
    view.click(tiles(view)[1]!);
    await view.settle();

    assert.equal(view.byId('tg-loadError')!.style.display, 'none', 'the banner does not outlive the failure');
  });

  test('an empty house says so rather than drawing nothing', async () => {
    const view = open({ listTargets: { rooms: [], zones: [] } });
    await view.settle();

    assert.equal(view.byId('tg-loadError')!.style.display, 'block');
    assert.equal(tiles(view).length, 0);
  });

  test('a repair opens on the zone tab when the stored target is a zone', async () => {
    const view = open({
      listTargets: { ...HOUSE, current: { kind: 'zone', zoneId: 'z1', includeSubzones: false } },
      selectTargets: { count: 2, support },
    });
    await view.settle();

    assert.equal(view.byId('tg-zonePane')!.style.display, 'block');
    assert.equal(view.byId('tg-subzones')!.checked, false, 'and it seeds the stored choice');
  });
});
