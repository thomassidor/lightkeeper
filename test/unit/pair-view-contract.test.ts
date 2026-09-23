import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fakeHomey, makeDriver, translate, FakePairSession } from '../support/fake-homey';
import { fakeApiClient, lamp, type RawDeviceFixture } from '../support/fake-homey-api';
import { driverApp, stubSource, type DriverAppOptions } from '../support/fake-lightkeeper-app';
import { runPairView, type FakeNode } from '../support/pair-view-harness';
import { LEAVE_ALONE } from '../../lib/outputs/lightkeeper-settings';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';

const DRIVERS = {
  controller: require('../../drivers/controller/driver'),
  circadian: require('../../drivers/circadian/driver'),
  curve: require('../../drivers/curve/driver'),
  daylight: require('../../drivers/daylight/driver'),
  schedule: require('../../drivers/schedule/driver'),
} as const;
type DriverId = keyof typeof DRIVERS;

/**
 * The view ↔ driver payload contract, checked with REAL replies on both sides.
 *
 * `pair-view-behaviour.test.ts` runs every view against payloads written by
 * hand, and `driver-*.test.ts` checks every handler's reply against what a test
 * expects. Neither can see the one mistake that falls between them: a driver
 * that renames a field, or a view that reads one nobody sends — the screen
 * renders, the field is `undefined`, and the row says "undefined" or nothing at
 * all. Both halves could not meet in one test until the drivers could be loaded
 * (platform §13); here a driver's own handler answers the view's own `emit`.
 *
 * `Homey.__` is the real locale lookup, so what these assert on is the sentence
 * a person would read.
 */

const VIEWS = join(import.meta.dirname, '..', '..', 'drivers');
const view = (driver: DriverId, file: string) => readFileSync(join(VIEWS, driver, 'pair', file), 'utf8');

const REMOTE = 'remote-1';
const DEVICES: RawDeviceFixture[] = [
  lamp('l1', 'Sofa lamp', 'z-living', { onoff: true, light_mode: 'color' }),
  lamp('l2', 'Floor lamp', 'z-living', { onoff: false }),
  { id: REMOTE, name: 'Kitchen STYRBAR', zone: 'z-living', class: 'remote', capabilities: { measure_battery: 90 } },
];

async function session(driver: DriverId, options: DriverAppOptions = {}) {
  const client = fakeApiClient(DEVICES);
  const built = driverApp(client, {
    surfaces: {
      [REMOTE]: {
        fingerprint: 'fp', rejected: [],
        inputs: [{
          key: 'on|press', controlId: 'on', label: 'On — Press', action: 'press', carriesMagnitude: false,
          binding: { kind: 'flow_fixed', cardId: 'on', cardOwnerUri: `homey:device:${REMOTE}`, fixedArgs: {} },
        }],
      },
    },
    ...options,
  });
  const instance = makeDriver(DRIVERS[driver], fakeHomey({ app: built.app }));
  const s = new FakePairSession();
  await instance.onPair(s);
  if (driver === 'controller') await s.call('selectSource', REMOTE);
  await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1', 'l2'] });
  if (driver === 'schedule') {
    await s.call('setSchedules', { entries: [{ id: 'a', onAt: 1200, end: { kind: 'duration', minutes: 120 } }] });
  }
  return { ...built, client, session: s };
}

/**
 * Every text a view drew, for the strings a missing field turns into.
 *
 * LEAF elements only, and never a `<script>` or `<style>` — the harness parses
 * the view's own source into the tree, and the script says `undefined` a great
 * deal on purpose.
 */
function texts(root: FakeNode): string[] {
  return root.descendants()
    .filter(node => node.tagName !== 'script' && node.tagName !== 'style' && node.children.length === 0)
    .map(node => node.textContent);
}

function assertNoHoles(root: FakeNode, what: string) {
  for (const text of texts(root)) {
    assert.ok(!/\bundefined\b|\[object Object\]|\bNaN\b/.test(text), `${what} drew "${text}"`);
  }
}

const translateForView = (key: string, tokens?: Record<string, unknown>) => translate(key, tokens);

for (const driver of Object.keys(DRIVERS) as DriverId[]) {
  describe(`${driver}: intro.html and review.html, fed by the driver`, () => {
    test('the intro draws what getIntro sends — title, blurb, hero and every decision', async () => {
      const { session: s } = await session(driver);
      const reply = await s.call('getIntro');
      const run = runPairView(view(driver, 'intro.html'), { respond: { getIntro: reply }, translate: translateForView });
      await run.settle();

      assert.equal(run.error, null);
      assert.equal(run.byId('in-title')!.textContent, reply.title);
      assert.equal(run.byId('in-blurb')!.textContent, reply.blurb);
      assert.notEqual(run.byId('in-hero')!.style.display, 'none', `a "${reply.hero}" hero the view cannot draw`);
      const decisions = run.byId('in-plan')!.querySelectorAll('.decision');
      assert.equal(decisions.length, reply.decisions.length);
      assert.equal(decisions[0]!.querySelector('.what')!.textContent, reply.decisions[0].what);
      assertNoHoles(run.root, 'intro');
    });

    test('the review draws every row, the hero it was sent, and the control only where there is one', async () => {
      const { session: s } = await session(driver);
      const reply = await s.call('getReview');
      const run = runPairView(view(driver, 'review.html'), {
        respond: { getReview: reply },
        translate: translateForView,
      });
      await run.settle();

      assert.equal(run.error, null);
      const rows = run.byId('rv-rows')!.querySelectorAll('.row');
      assert.equal(rows.length, reply.rows.length);
      reply.rows.forEach((row: { label: string; value: string; view?: string }, i: number) => {
        assert.equal(rows[i]!.querySelector('.label')!.textContent, row.label);
        assert.equal(rows[i]!.querySelector('.value')!.textContent, row.value);
        assert.equal(rows[i]!.tagName, row.view ? 'button' : 'div', 'a row with a view is the only kind that opens one');
      });
      assert.equal(run.byId('rv-hero')!.style.display === 'none', reply.hero === undefined);
      assert.equal(run.byId('rv-controlBlock')!.style.display === 'none', reply.control === undefined);
      assertNoHoles(run.root, 'review');
    });
  });
}

describe('circadian: tryit.html, fed by the driver', () => {
  test('boot, scrub, and put back — every payload the driver\'s own', async () => {
    const { session: s, client } = await session('circadian');
    const preview = await s.call('getPreview');
    // The view sends the minute it opened on, which is the preview's `now`.
    const shown = await s.call('previewAt', { minute: preview.nowMinute });
    const restored = await s.call('restorePreview');
    assert.ok(client.writes.length > 0, 'a real preview ran and was put back');

    const run = runPairView(view('circadian', 'tryit.html'), {
      respond: { getPreview: preview, previewAt: shown, restorePreview: restored },
      translate: translateForView,
    });
    await run.settle();
    assert.equal(run.error, null);

    const zone = run.byId('ti-what')!.textContent.split(' · ')[0];
    assert.ok([translate('day.morning'), translate('day.midday'), translate('day.evening')].includes(zone!),
      `the boundaries arrived under the names the view reads: "${zone}"`);

    run.fire(run.byId('ti-show')!, 'click');
    await run.settle();
    const lamps = run.byId('ti-lamps')!.querySelectorAll('.row');
    assert.deepEqual(lamps.map(row => row.querySelector('.label')!.textContent), ['Sofa lamp', 'Floor lamp']);
    assert.deepEqual(lamps.map(row => row.querySelector('.value')!.textContent),
      shown.targets.map((t: { written: boolean }) => translate(t.written ? 'tryit.set' : 'tryit.leftAlone')));
    assert.notEqual(run.byId('ti-restore')!.style.display, 'none', 'Stop preview is offered once something was shown');

    run.fire(run.byId('ti-restore')!, 'click');
    await run.settle();
    assert.equal(run.byId('ti-lamps')!.style.display, 'none');
    assert.equal(run.byId('ti-restore')!.style.display, 'none');
    assertNoHoles(run.root, 'tryit');
  });
});

describe('controller: source.html, fed by the driver', () => {
  const sources: DriverAppOptions = {
    curves: [stubSource('lk-curv-1', 'Evening curve', { lights: ['l1'] })],
    daylights: [stubSource('lk-dayl-1', 'Room sensing', { values: { [VALUE_CAPABILITIES.brightness]: 0.3 } })],
  };

  test('the rows, the chosen one, and the warning about a source that drives these lamps too', async () => {
    const { session: s } = await session('controller', sources);
    await s.call('editGesture', 'on|press');
    await s.call('editSource', 'colour');
    await s.call('setSource', { id: 'lk-curv-1' });
    const reply = await s.call('getSource');

    const run = runPairView(view('controller', 'source.html'), {
      respond: { getSource: reply, setSource: { chosen: LEAVE_ALONE } },
      translate: translateForView,
    });
    await run.settle();
    assert.equal(run.error, null);

    assert.equal(run.byId('sr-title')!.textContent, translate('job.takeColourTitle'));
    const picks = run.byId('sr-list')!.querySelectorAll('.pick');
    assert.deepEqual(picks.map(pick => pick.querySelector('.name')!.textContent),
      reply.sources.map((row: { name: string }) => row.name));
    assert.equal(picks.find(pick => pick.getAttribute('aria-checked') === 'true')!.querySelector('.name')!.textContent,
      'Evening curve');
    // The curve drives l1, which this button drives too — the view must be
    // sent enough to say so, under the list, naming the device.
    assert.notEqual(run.byId('sr-warn')!.style.display, 'none');
    assert.equal(run.byId('sr-warn')!.querySelector('.lead')!.textContent,
      translate('sourceWarn.keepsUpdated', { name: 'Evening curve' }));
    assertNoHoles(run.root, 'source');
  });

  test('a refusal from the driver puts the tapped row back and shows the driver\'s sentence', async () => {
    const { session: s } = await session('controller', sources);
    await s.call('editGesture', 'on|press');
    await s.call('editSource', 'colour');
    await s.call('setSource', { id: 'lk-curv-1' });
    const reply = await s.call('getSource');
    const refusal = await s.call('setSource', { id: LEAVE_ALONE }).catch((error: Error) => error);
    assert.ok(refusal instanceof Error, 'clearing the only source is refused');

    const run = runPairView(view('controller', 'source.html'), {
      respond: { getSource: reply, setSource: refusal },
      translate: translateForView,
    });
    await run.settle();

    const leave = run.byId('sr-list')!.querySelectorAll('.pick')
      .find(pick => pick.querySelector('.name')!.textContent === translate('flow.leaveAlone'))!;
    run.fire(leave, 'click');
    await run.settle();

    assert.equal(run.byId('sr-error')!.textContent, translate('job.needASource'));
    const checked = run.byId('sr-list')!.querySelectorAll('.pick').find(pick => pick.getAttribute('aria-checked') === 'true')!;
    assert.equal(checked.querySelector('.name')!.textContent, 'Evening curve', 'the row that was refused is not left looking accepted');
  });
});

/**
 * Every view a driver SENDS a session to, read off the replies it actually
 * gives — the behavioural form of `repair-views.test.ts`'s "every view id a
 * driver names is a view that driver declares", which had to regex the ids out
 * of the source text because the driver could not be loaded (platform §13).
 * Homey renders an empty screen for an unknown view id rather than failing.
 */
describe('every view a driver names is one it declares', () => {
  const declared = (driver: DriverId) => new Set(
    (JSON.parse(readFileSync(join(VIEWS, driver, 'driver.compose.json'), 'utf8')) as { pair?: Array<{ id: string }> })
      .pair?.map(entry => entry.id) ?? [],
  );

  for (const driver of Object.keys(DRIVERS) as DriverId[]) {
    test(driver, async () => {
      const { session: s } = await session(driver);
      const named: string[] = [];
      const take = (reply: unknown) => {
        const value = (reply as { nextView?: unknown } | null)?.nextView;
        if (typeof value === 'string') named.push(value);
      };

      take(await s.call('getIntro'));
      take(await s.call('listTargets'));
      if (s.has('getCredentialStatus')) take(await s.call('getCredentialStatus'));
      if (s.has('getDay')) take(await s.call('getDay'));
      for (const row of (await s.call('getReview')).rows as Array<{ view?: string }>) {
        if (row.view) named.push(row.view);
      }

      assert.ok(named.length >= 3, `${driver} named ${named.join(', ')}`);
      for (const id of named) assert.ok(declared(driver).has(id), `${driver} sends a session to "${id}"`);
    });
  }
});

/**
 * A driver is a singleton on a Homey, so a field a handler writes is shared by
 * every concurrent pair and repair session. `pairing-sessions.test.ts` checks
 * for `this.x =` in the source; this checks the instance itself, after a
 * session has been through every screen that has state to keep.
 */
describe('a driver keeps nothing of a session on itself', () => {
  for (const driver of Object.keys(DRIVERS) as DriverId[]) {
    test(driver, async () => {
      const client = fakeApiClient(DEVICES);
      const built = driverApp(client);
      const instance = makeDriver(DRIVERS[driver], fakeHomey({ app: built.app }));
      const before = Object.getOwnPropertyNames(instance).sort();

      const s = new FakePairSession();
      await instance.onPair(s);
      await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
      await s.call('getReview').catch(() => undefined);
      await s.call('save', '').catch(() => undefined);

      assert.deepEqual(Object.getOwnPropertyNames(instance).sort(), before);
    });
  }
});
