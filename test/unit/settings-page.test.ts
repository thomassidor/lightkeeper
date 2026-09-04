import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runSettingsPage, type SettingsRun } from '../support/pair-view-harness';

/**
 * The app settings page, run rather than read.
 *
 * The old test plan's 1.2 was "four empty sections, not four blanks" and 8.1
 * was "all four sections now list something" — the first and last screens of
 * the hardware pass, and between them a good part of what a person opens a
 * phone for.
 * Neither needs a Homey: both are this page turning one JSON payload into text.
 *
 * The distinction 1.2 drew is the whole point. A section that renders nothing
 * looks identical to a section whose data failed to load, and on a clean install
 * EVERY section is empty — so the one screen where the difference matters most
 * is the one screen nobody has data for.
 */

const PAGE = readFileSync(
  join(import.meta.dirname, '..', '..', 'settings', 'index.html'), 'utf8');

/** A Homey with the app installed, nothing configured, and no key. */
const EMPTY = {
  credential: { present: false, valid: false },
  controllers: [],
  schedules: [],
  circadian: [],
  daylight: [],
  sky: null,
  sensors: [],
  recentEvents: [],
  recentWrites: [],
};

/** One of everything, as the pass has by §8. */
const POPULATED = {
  credential: { present: true, valid: true, lastCheckedAt: 1_756_000_000_000 },
  controllers: [{
    id: 'lk-ctrl-1',
    state: 'ready',
    sourceName: 'Hall remote',
    mappings: 3,
    managedFlows: 3,
    schedulerReady: true,
    targetNames: ['Hall lamp', 'Kitchen lamp'],
  }],
  schedules: [{
    id: 'lk-sched-1',
    state: 'ready',
    name: 'Evening',
    enabled: true,
    entries: [{ id: 'a', on: '20:00', off: '22:00', days: 'every day', active: false }],
    managedFlows: 2,
    timezone: 'Europe/Copenhagen',
    timezoneResolved: true,
    localTime: '20:41',
    targetNames: ['Hall lamp'],
    lastAction: null,
  }],
  circadian: [{
    id: 'lk-circ-1',
    state: 'ready',
    name: 'Living room day',
    enabled: true,
    now: { warmth: 0.8 },
    nextPoint: { id: 'p2', at: '21:00', inMinutes: 19 },
    points: [{ id: 'p1', at: '06:00', warmth: 0.9 }, { id: 'p2', at: '21:00', warmth: 1 }],
    timezone: 'Europe/Copenhagen',
    localTime: '20:41',
    targetNames: ['Hall lamp'],
    overridden: 0,
    preStage: false,
    preStageDisabled: null,
  }],
  daylight: [{
    id: 'lk-dayl-1',
    state: 'ready',
    name: 'Kitchen daylight',
    enabled: true,
    now: { level: 0.4, brightness: 0.62, source: 'sensors', elevation: 18 },
    response: { sensors: ['s1'], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25 },
    targetNames: ['Hall lamp'],
    overridden: 0,
    sensors: [{ deviceId: 's1', name: 'Hall motion', lux: 240, at: 1_756_000_000_000, available: true }],
  }],
  sky: { elevation: 18, level: 0.55, location: { latitude: 55.68, longitude: 12.57 } },
  sensors: [{ deviceId: 's1', name: 'Hall motion', lux: 240, at: 1_756_000_000_000, available: true }],
  recentEvents: [
    { at: 1_756_000_000_000, cardId: 'x:bridge_event', controller: 'lk-ctrl-1', eventKey: 'button1:short', accepted: true },
  ],
  recentWrites: [
    { at: 1_756_000_000_000, deviceId: 'l1', capability: 'light_temperature', value: 0.8, ok: true, ms: 275 },
  ],
};

/**
 * Tokens are rendered into the key, not dropped.
 *
 * The default stub returns the bare key, which is enough to assert WHICH
 * sentence a screen chose. It is not enough for T44, where the whole question is
 * whether the window's own times reached the screen — a key with the times
 * thrown away would pass while the page showed nothing useful.
 */
const withTokens = (key: string, tokens?: Record<string, unknown>) => {
  const values = Object.values(tokens ?? {});
  return values.length ? `${key}(${values.join(', ')})` : key;
};

const open = (status: unknown, orphans: unknown = NO_ORPHANS) => runSettingsPage(PAGE, {
  respond: { 'GET /': status, 'GET /orphans': orphans },
  translate: withTokens,
});

/** No generated Flows at all, which is what T2 expects on a clean Homey. */
const NO_ORPHANS = {
  total: 0, orphans: 0, unmanaged: 0, liveControllers: 0, flowIds: [], examples: [], token: 't',
};

/** Every rendered string under a section, so "blank" is distinguishable from "empty". */
function textOf(view: SettingsRun, id: string): string {
  const section = view.byId(id);
  assert.ok(section, `no #${id} on the page`);
  return section.descendants().map(n => n.textContent).join(' ').trim();
}

describe('the settings page on a Homey with nothing set up (the old 1.2)', () => {
  test('it runs at all, and asks the app for its status', async () => {
    const view = open(EMPTY);
    await view.settle();

    assert.equal(view.error, null, `the page threw: ${(view.error as Error)?.message}`);
    // Two reads at boot: the status, and the generated-Flow count beside it.
    assert.deepEqual(
      view.calls.map(c => `${c.method} ${c.path}`).sort(),
      ['GET /', 'GET /orphans'],
    );
  });

  test('every section says it is empty, rather than being empty', async () => {
    const view = open(EMPTY);
    await view.settle();

    // The four sections the plan names, each with its own sentence.
    assert.equal(textOf(view, 'controllers'), 'settings.noControllers');
    assert.equal(textOf(view, 'schedules'), 'settings.noSchedules');
    assert.equal(textOf(view, 'circadian'), 'settings.noCircadian');
    assert.equal(view.byId('credText')!.textContent, 'settings.keyMissing');
  });

  test('no key ever saved is amber, not red', async () => {
    /**
     * Nothing is broken — the setup simply is not finished. Red is reserved for
     * a key that was supposed to work and does not, and a first-run screen
     * painted red is a first-run screen that reads as a fault.
     */
    const view = open(EMPTY);
    await view.settle();
    assert.equal(view.byId('credText')!.className, 'msg partial');
  });

  test('a key that was saved and has stopped working IS red', async () => {
    const view = open({
      ...EMPTY,
      credential: { present: true, valid: false, failure: 'session_expired' },
    });
    await view.settle();

    assert.equal(view.byId('credText')!.className, 'msg broken');
    assert.equal(view.byId('credText')!.textContent, 'credential.expired',
      'the reason comes from the classifier, not from the page guessing');
  });

  test('the two logs say they are empty too', async () => {
    const view = open(EMPTY);
    await view.settle();

    assert.equal(view.byId('events')!.textContent, 'settings.noPresses');
    assert.equal(view.byId('writes')!.textContent, 'settings.noWrites');
  });
});

describe('the settings page with one of every device type (the old 8.1)', () => {
  test('all five sections list something', async () => {
    const view = open(POPULATED);
    await view.settle();

    assert.ok(textOf(view, 'controllers').includes('Hall remote'));
    assert.ok(textOf(view, 'schedules').includes('Evening'));
    assert.ok(textOf(view, 'circadian').includes('Living room day'));
    assert.ok(textOf(view, 'daylight').includes('Kitchen daylight'));
    assert.equal(view.byId('credText')!.textContent, 'settings.keyValid');
    assert.equal(view.byId('credText')!.className, 'msg ready');

    for (const id of ['controllers', 'schedules', 'circadian', 'daylight']) {
      assert.ok(
        !textOf(view, id).includes('settings.no'),
        `#${id} still shows its empty-state sentence with data present`,
      );
    }
  });

  test('a Daylight light says WHERE its brightness came from', async () => {
    /**
     * The one fact that makes this device type supportable. "Sensors" and "sun"
     * behave very differently — one measures the room, one infers it — so
     * somebody whose lamps are not doing what they expect has to know which of
     * the two is answering before anything else on this page helps.
     */
    const view = open(POPULATED);
    await view.settle();

    const text = textOf(view, 'daylight');
    assert.ok(text.includes('settings.daylightNow'), `no brightness line in "${text}"`);
    assert.ok(text.includes('Hall motion'), 'the sensor it is reading is not named');
  });

  test('the sky readout is shown even with no Daylight light configured', async () => {
    // Independent of any device on purpose: "does it know where the sun is" is a
    // question about the app, and it is the fastest check that the geolocation
    // permission resolved on this Homey.
    const view = open({ ...EMPTY, sky: { elevation: 18, level: 0.55, location: null }, sensors: [] });
    await view.settle();

    const text = textOf(view, 'daylight');
    assert.ok(text.includes('settings.daylightSky'), `no sky line in "${text}"`);
    assert.ok(text.includes('settings.noDaylight'), 'and it still says nothing is set up');
  });

  test('no location is reported as such rather than as a broken device', async () => {
    // Amber, not red: a Homey with no location is not broken, and a household
    // with a light sensor does not need one at all.
    const view = open({ ...EMPTY, sky: null, sensors: [] });
    await view.settle();

    const text = textOf(view, 'daylight');
    assert.ok(text.includes('settings.daylightNoLocation'), `no location notice in "${text}"`);
  });

  test('a frozen sensor is visible through the AGE of its reading', async () => {
    /**
     * The one failure this feature cannot detect for itself. A reading is never
     * treated as stale — many Zigbee sensors report only on change, so a quiet
     * sensor in a stable room is telling the truth (platform §16) — which leaves
     * the age as the only thing on screen that can reveal one that has stopped.
     */
    const view = open({
      ...EMPTY,
      sky: { elevation: 18, level: 0.55, location: null },
      sensors: [{ deviceId: 's1', name: 'Hall motion', lux: 240, at: Date.now() - 7_200_000, available: true }],
    });
    await view.settle();

    const text = textOf(view, 'daylight');
    assert.ok(text.includes('settings.daylightSensorLux'), `no reading line in "${text}"`);
  });

  test('a schedule shows its window, and the clock it will fire on (T44)', async () => {
    // "It went off at the wrong time" is usually a timezone answer, so the zone
    // is on screen beside the window rather than buried in diagnostics.
    const view = open(POPULATED);
    await view.settle();

    const text = textOf(view, 'schedules');
    assert.ok(text.includes('20:00'), `no on-time in "${text}"`);
    assert.ok(text.includes('22:00'), 'no off-time');
    assert.ok(text.includes('Europe/Copenhagen'), 'no timezone');
    assert.ok(text.includes('20:41'), 'no local clock');
  });

  test('the circadian section carries both device types together', async () => {
    /**
     * A circadian light and a Curve light are one engine and one registry
     * (platform §12), so the settings page lists them in one section — which is
     * what the old 8.1 meant by "the circadian and Curve lights together".
     */
    const view = open({
      ...POPULATED,
      circadian: [
        ...POPULATED.circadian,
        { ...POPULATED.circadian[0]!, id: 'lk-curv-1', name: 'Kitchen curve' },
      ],
    });
    await view.settle();

    const text = textOf(view, 'circadian');
    assert.ok(text.includes('Living room day'));
    assert.ok(text.includes('Kitchen curve'));
  });

  test('recent presses and writes are listed once there are any (T42, T43)', async () => {
    const view = open(POPULATED);
    await view.settle();

    assert.ok(textOf(view, 'events').includes('button1:short'));
    assert.notEqual(view.byId('events')!.textContent, 'settings.noPresses');
    assert.ok(textOf(view, 'writes').includes('light_temperature'));
  });

  test('a device needing a key says so, and the page still renders the rest', async () => {
    // The state that matters most on this screen: T38 puts the controller and
    // the schedule here, and the two light-driving types must be untouched.
    const view = open({
      ...POPULATED,
      credential: { present: false, valid: false },
      controllers: [{ ...POPULATED.controllers[0]!, state: 'needs_credential' }],
      schedules: [{ ...POPULATED.schedules[0]!, state: 'needs_credential' }],
    });
    await view.settle();

    assert.ok(textOf(view, 'controllers').includes('settings.stateNeedsCredential'));
    assert.ok(textOf(view, 'schedules').includes('settings.stateNeedsCredential'));
    assert.ok(
      !textOf(view, 'circadian').includes('settings.stateNeedsCredential'),
      'a circadian or Curve light has no needs_credential state at all (platform §12)',
    );
  });
});

describe('the settings page never shows key material', () => {
  test('a stored key is not rendered anywhere, even though the page could read it', async () => {
    /**
     * The SDK lets this page's own webview read the setting back — that is the
     * boundary `credential-service.ts` documents rather than pretends away. What
     * is enforced here is that the page never does: it renders a verdict, never
     * the value.
     */
    const view = open({ ...EMPTY, credential: { present: true, valid: true } });
    await view.settle();

    const rendered = view.root.descendants()
      .map(n => `${n.textContent} ${n.value}`).join(' ');
    assert.ok(!rendered.includes('flowWriteApiKey'), 'the setting is not even named');
    assert.equal(view.byId('key')!.value, '', 'the key box starts empty and stays empty');
  });
});

describe('the generated-Flow count, and its refusal (T2, T52)', () => {
  test('a clean Homey reports none, and offers nothing to delete', async () => {
    const view = open(EMPTY, NO_ORPHANS);
    await view.settle();

    assert.equal(view.byId('orphanText')!.textContent, 'settings.noneOrphaned(0)');
    assert.equal(view.byId('sweep')!.style.display, 'none');
  });

  test('with nothing running the count is refused rather than shown', async () => {
    /**
     * A load-bearing safety property, not a display detail: with no Flow-owning
     * device live, EVERY managed Flow looks orphaned. Offering a delete there
     * would offer to delete all of them, so the count is withheld and the button
     * is hidden — and the API would refuse the sweep anyway.
     */
    const view = open(EMPTY, {
      total: 7, orphans: 7, unmanaged: 0, liveControllers: 0,
      flowIds: [], examples: [], token: 't', refused: 'no_live_controllers',
    });
    await view.settle();

    assert.equal(view.byId('orphanText')!.textContent, 'settings.sweepRefused(7)');
    assert.equal(view.byId('sweep')!.style.display, 'none',
      'a delete that the API will refuse must not be offered');
  });

  test('real orphans are counted, and the button says how many', async () => {
    const view = open(EMPTY, {
      total: 9, orphans: 2, unmanaged: 1, liveControllers: 1,
      flowIds: ['f1', 'f2'], examples: ['Hall remote — Toggle'], token: 'tok',
    });
    await view.settle();

    assert.ok(view.byId('orphanText')!.textContent.startsWith('settings.orphansFound(2, 9, 1)'));
    // Flows that call our card but were not built by us are mentioned so the
    // totals add up on screen. They are never deleted.
    assert.ok(view.byId('orphanText')!.textContent.includes('settings.sweepUnmanaged(1)'));
    assert.equal(view.byId('sweep')!.style.display, 'inline-block');
    assert.equal(view.byId('sweep')!.textContent, 'settings.deleteOrphans(2)');
  });

  test('the sweep sends back the exact list it showed, not just a count', async () => {
    // "A count is not consent, a specific list is." The page hands back the
    // token and the flow ids it displayed, so a Flow that appeared between the
    // preview and the press is not swept on the strength of an older count.
    const view = open(EMPTY, {
      total: 9, orphans: 2, unmanaged: 0, liveControllers: 1,
      flowIds: ['f1', 'f2'], examples: [], token: 'tok',
    });
    await view.settle();

    view.fire(view.byId('sweep')!, 'click');
    await view.settle();

    const sweep = view.calls.find(c => c.method === 'POST' && c.path === '/orphans');
    assert.ok(sweep, 'the sweep was never sent');
    assert.deepEqual(sweep.body, { token: 'tok', flowIds: ['f1', 'f2'] });
  });
});
