import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fakeHomey, makeDriver, translate, FakePairSession } from '../support/fake-homey';
import { fakeApiClient, lamp, type RawDeviceFixture } from '../support/fake-homey-api';
import { driverApp, type DriverAppOptions } from '../support/fake-lightkeeper-app';
import { DEFAULT_ZONES } from '../../lib/circadian/simple-curve';

const CircadianDriver = require('../../drivers/circadian/driver');

/**
 * The circadian light's pair and repair sessions, executed — above all the
 * try-it screen, which is the one pairing screen that WRITES to somebody's lamps
 * and then promises to put them back.
 *
 * The preview goes through the REAL `CircadianRuntimeManager.ephemeral`, so what
 * a fake lamp receives is what a real runtime planned: `light_mode` ahead of the
 * value it enables, as `planColor`/`planTemperature` always write it. That is
 * what makes the restore half worth testing — a preview changes a lamp's MODE,
 * and a restore that forgot the mode sent the old hue to a lamp now in
 * temperature mode, which a gating lamp ignores while reporting success
 * (platform §6).
 */

/** A lamp in COLOUR mode, the case the restore used to get wrong. */
const COLOURED = lamp('l1', 'Sofa lamp', 'z-living', {
  onoff: true, dim: 0.5, light_mode: 'color', light_hue: 0.1, light_saturation: 0.6, light_temperature: 0.4,
});

function rig(devices: RawDeviceFixture[] = [COLOURED, lamp('l2', 'Floor lamp', 'z-living', { onoff: false })],
  options: DriverAppOptions = {}) {
  const client = fakeApiClient(devices);
  const built = driverApp(client, options);
  const homey = fakeHomey({ app: built.app });
  const driver = makeDriver(CircadianDriver, homey);
  return { ...built, client, homey, driver };
}

async function paired(devices?: RawDeviceFixture[], options: DriverAppOptions = {}) {
  const r = rig(devices, options);
  const session = new FakePairSession();
  await r.driver.onPair(session);
  return { ...r, session };
}

async function withLights(ids = ['l1'], devices?: RawDeviceFixture[]) {
  const r = await paired(devices);
  await r.session.call('selectTargets', { kind: 'devices', deviceIds: ids });
  return r;
}

describe('the day screen', () => {
  test('refuses before any lights are chosen, translated', async () => {
    const { session } = await paired();
    for (const name of ['getDay', 'getPreview', 'save']) {
      await assert.rejects(session.call(name), { message: translate('errors.chooseLightsFirst') }, name);
    }
    await assert.rejects(session.call('previewAt', { minute: 600 }), { message: translate('errors.chooseLightsFirst') });
  });

  test('carries today\'s sun and where the two boundaries resolve against it', async () => {
    const { session } = await withLights();
    const day = await session.call('getDay');

    assert.equal(day.nextView, 'review');
    assert.equal(day.timezone, 'Europe/Copenhagen');
    assert.ok(Number.isFinite(day.sun.sunriseMinute), 'a Homey that knows where it is has a sunrise');
    assert.equal(day.boundaries.fromSun, true);
    assert.equal(day.boundaries.morningEndMinute, day.sun.sunriseMinute + DEFAULT_ZONES.morningEnd);
    assert.deepEqual(day.zones, DEFAULT_ZONES);
    assert.equal(day.support.light_temperature, 1);
  });

  test('with no location it says so, and uses the fixed hours', async () => {
    const { session } = await (async () => {
      const r = rig(undefined, { sky: { elevation: null, level: null, location: null } });
      const s = new FakePairSession();
      await r.driver.onPair(s);
      await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
      return { session: s };
    })();
    const day = await session.call('getDay');
    assert.deepEqual(day.sun, { sunriseMinute: null, sunsetMinute: null });
    assert.equal(day.boundaries.fromSun, false);
  });

  test('setDay corrects what the screen got wrong, per field, and echoes the snap', async () => {
    const { session, driver } = await withLights();
    const reply = await session.call('setDay', {
      ...DEFAULT_ZONES, morning: { temperature: 'hot', brightness: 0.5 }, morningEnd: 37, adjustBrightness: true,
    });

    assert.deepEqual(reply.corrected.sort(), ['morning temperature', 'morningEnd']);
    assert.equal(reply.zones.morning.temperature, DEFAULT_ZONES.morning.temperature);
    assert.equal(reply.zones.morningEnd, 30, 'snapped to the quarter hour');
    assert.equal(typeof reply.boundaries.morningEnd, 'string');
    assert.ok(driver.logs.some((entry: string) => entry.includes('Corrected morningEnd')));
  });
});

describe('the try-it screen', () => {
  test('getPreview draws the resolved points and names now', async () => {
    const { session } = await withLights();
    const preview = await session.call('getPreview');
    assert.ok(preview.points.length >= 3);
    for (const point of preview.points) assert.ok(point.minute >= 0 && point.minute < 1440);
    assert.ok(preview.nowMinute >= 0 && preview.nowMinute < 1440);
    assert.ok(preview.boundaries.morningEndMinute < preview.boundaries.eveningStartMinute);
  });

  test('a minute that is not a number is refused', async () => {
    const { session } = await withLights();
    await assert.rejects(session.call('previewAt', { minute: 'noon' }), { message: translate('errors.notATimeOfDay') });
    await assert.rejects(session.call('previewAt', undefined), { message: translate('errors.notATimeOfDay') });
  });

  test('scrubbing writes a real preview and reports what each lamp was SENT', async () => {
    const { session, client } = await withLights(['l1', 'l2']);
    const outcome = await session.call('previewAt', { minute: 22 * 60 });

    const sent = client.writes.filter(write => write.deviceId === 'l1').map(write => write.capabilityId);
    assert.ok(sent.includes('light_temperature'), `the evening warmth was written: ${sent.join(', ')}`);
    assert.ok(sent.indexOf('light_mode') < sent.indexOf('light_temperature'), 'mode ahead of the value it enables');
    assert.deepEqual(outcome.targets.map((t: { name: string }) => t.name), ['Sofa lamp', 'Floor lamp']);
    assert.equal(outcome.targets[0].written, true);
  });

  /**
   * The defect this was written for: `putBack` restored dim, temperature, hue,
   * saturation and onoff — never `light_mode`. A lamp that was in colour mode
   * came out of the preview in temperature mode, and the restore then sent its
   * hue to a lamp whose mode makes it ignore one.
   */
  test('Stop preview puts light_mode back AHEAD of the colour it enables', async () => {
    const { session, client } = await withLights(['l1']);
    await session.call('previewAt', { minute: 22 * 60 });
    await session.call('previewAt', { minute: 12 * 60 });
    client.writes.length = 0;

    assert.deepEqual(await session.call('restorePreview'), { restored: 1 });

    assert.deepEqual(client.writes.map(write => [write.capabilityId, write.value]), [
      ['dim', 0.5],
      ['light_mode', 'color'],
      ['light_hue', 0.1],
      ['light_saturation', 0.6],
      ['onoff', true],
    ], 'the snapshot from BEFORE the first scrub, and the temperature axis — inactive in colour mode — left alone');
  });

  test('a lamp in temperature mode gets its mode and its warmth, and no hue', async () => {
    const warm = lamp('l1', 'Sofa lamp', 'z-living', { light_mode: 'temperature', light_temperature: 0.7 });
    const { session, client } = await withLights(['l1'], [warm]);
    await session.call('previewAt', { minute: 13 * 60 });
    client.writes.length = 0;

    await session.call('restorePreview');
    assert.deepEqual(client.writes.map(write => write.capabilityId),
      ['dim', 'light_mode', 'light_temperature', 'onoff']);
    assert.equal(client.writes[1]!.value, 'temperature');
  });

  test('a one-mode lamp gets every axis it reported, and a lamp that was OFF is switched off LAST', async () => {
    const plain: RawDeviceFixture = {
      id: 'l1', name: 'Old bulb', zone: 'z-living', class: 'light',
      capabilities: { onoff: false, dim: 0.3, light_temperature: 0.2 },
    };
    const { session, client } = await withLights(['l1'], [plain]);
    await session.call('previewAt', { minute: 22 * 60 });
    client.writes.length = 0;

    await session.call('restorePreview');
    assert.deepEqual(client.writes.map(write => [write.capabilityId, write.value]),
      [['dim', 0.3], ['light_temperature', 0.2], ['onoff', false]]);
  });

  test('the snapshot is per SESSION, and a second restore has nothing to do', async () => {
    const first = await withLights(['l1']);
    await first.session.call('previewAt', { minute: 22 * 60 });

    // A second session on the SAME driver instance, which is a singleton on a
    // Homey. It took no snapshot, so its Stop preview restores nothing — and in
    // particular not the first session's lamps.
    const second = new FakePairSession();
    await first.driver.onPair(second);
    assert.deepEqual(await second.call('restorePreview'), { restored: 0 });

    assert.deepEqual(await first.session.call('restorePreview'), { restored: 1 });
    assert.deepEqual(await first.session.call('restorePreview'), { restored: 0 });
  });

  test('a lamp that refuses is skipped and logged; the others are still put back', async () => {
    const { session, client, driver } = await withLights(['l1', 'l2']);
    await session.call('previewAt', { minute: 22 * 60 });
    client.refusing.add('l1');

    assert.deepEqual(await session.call('restorePreview'), { restored: 1 });
    assert.ok(driver.errors.some((line: string) => line.startsWith('Could not put Sofa lamp back')));
  });

  test('previewNow runs the whole plan through the same ephemeral runtime', async () => {
    const { session, record } = await withLights(['l1']);
    const outcome = await session.call('previewNow');
    assert.equal(typeof outcome.writes, 'number');
    assert.equal(record.ephemeral.length, 1);
    assert.ok(Array.isArray(record.ephemeral[0]!.plan.points), 'the two ends were expanded into points');
  });
});

describe('the review and the control choice', () => {
  test('the day as a strip, the three zones in words, and where the sun puts the boundaries', async () => {
    const { session } = await withLights(['l1', 'l2']);
    await session.call('setDay', { ...DEFAULT_ZONES, adjustBrightness: true });
    const review = await session.call('getReview');

    assert.equal(review.hero.kind, 'strip');
    assert.equal(review.hero.stops.length, 49);
    assert.deepEqual(review.rows.map((row: { label: string }) => row.label), [
      translate('review.lights'), translate('review.morning'), translate('review.midday'),
      translate('review.evening'), translate('review.followsSun'),
    ]);
    assert.equal(review.rows[2].value, `${translate('warmth.coolWhite')} · 90%`);
    assert.deepEqual(review.control.modes, ['after', 'before', 'none']);
    assert.equal(review.control.selected, 'after');
    assert.equal(review.control.lightCount, 2);
  });

  test('brightness off reads as the warmth alone', async () => {
    const { session } = await withLights();
    await session.call('setDay', { ...DEFAULT_ZONES, adjustBrightness: false });
    const review = await session.call('getReview');
    assert.equal(review.rows[3].value, translate('warmth.deepAmber'));
  });

  test('"Don\'t change lights automatically" is stored as writesLights: false', async () => {
    const { session } = await withLights();
    assert.deepEqual(await session.call('setControl', { mode: 'none' }), { mode: 'none' });
    const saved = await session.call('save', '');
    assert.equal(saved.device.store.circadian.writesLights, false);
    await assert.rejects(session.call('setControl', { mode: 'sideways' }));
  });
});

describe('save and repair', () => {
  test('a new device carries the zones, a derived name and a circadian id', async () => {
    const { session } = await withLights(['l1', 'l2']);
    const saved = await session.call('save', '  ');

    assert.equal(saved.created, true);
    assert.match(saved.device.data.id, /^lk-circ-/);
    assert.equal(saved.device.name, 'Living room circadian');
    const plan = saved.device.store.circadian;
    assert.deepEqual(plan.zones, DEFAULT_ZONES);
    assert.equal(plan.preStage, false);
    assert.equal('writesLights' in plan, false, 'stored only when false');
  });

  test('repair opens on the stored plan and applies to the device', async () => {
    const r = rig();
    const session = new FakePairSession();
    const stored = {
      schemaVersion: 2, enabled: false, target: { kind: 'devices', deviceIds: ['l2'] },
      zones: { ...DEFAULT_ZONES, eveningStart: -30 }, adjustBrightness: false, preStage: true,
      preStageLights: ['l2'], writesLights: false,
    };
    const applied: any[] = [];
    await r.driver.onRepair(session, {
      getStoreValue: (key: string) => (key === 'circadian' ? stored : undefined),
      applyPlan: async (plan: unknown) => { applied.push(plan); },
    });

    const day = await session.call('getDay');
    assert.equal(day.zones.eveningStart, -30);
    assert.equal(day.adjustBrightness, false);
    const review = await session.call('getReview');
    assert.equal(review.control.selected, 'none');
    assert.deepEqual(review.control.tested, { fresh: false, lights: [{ name: 'Floor lamp', ok: true }] });

    assert.deepEqual(await session.call('save', 'x'), { updated: true });
    assert.deepEqual(applied[0].preStageLights, ['l2']);
    assert.equal(applied[0].writesLights, false);
  });

  test('a repair with nothing stored falls back to the defaults rather than throwing', async () => {
    const r = rig();
    const session = new FakePairSession();
    await r.driver.onRepair(session, { getStoreValue: () => undefined, applyPlan: async () => undefined });
    await session.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    assert.deepEqual((await session.call('getDay')).zones, DEFAULT_ZONES);
  });

  test('onInit and add_device', async () => {
    const { driver, session } = await paired();
    await driver.onInit();
    assert.ok(driver.logs.includes('Circadian driver initialised'));
    assert.equal(await session.call('add_device'), true);
    assert.equal((await session.call('getIntro')).hero, 'day');
  });
});
