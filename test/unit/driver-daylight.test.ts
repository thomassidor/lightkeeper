import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fakeHomey, makeDriver, translate, FakePairSession } from '../support/fake-homey';
import { fakeApiClient, lamp, luxSensor, type RawDeviceFixture } from '../support/fake-homey-api';
import { driverApp, type DriverAppOptions } from '../support/fake-lightkeeper-app';
import { DEFAULT_RESPONSE } from '../../lib/daylight/daylight-types';
import type { SensorWeek } from '../../lib/daylight/sensor-history';

const DaylightDriver = require('../../drivers/daylight/driver');

/**
 * The Room-sensing Light's pair and repair sessions, executed.
 *
 * The behaviour worth a test here that `lib/` cannot show: the sensor's week
 * pre-fills the two lux thresholds ONCE — and never over a pair of thresholds a
 * person has already had the chance to keep, even when what they kept is the
 * defaults. Before `luxChosen` the only test was "still equal to the defaults",
 * which cannot tell a default nobody looked at from one somebody chose.
 */

const DEVICES: RawDeviceFixture[] = [
  lamp('l1', 'Desk lamp', 'z-living'),
  luxSensor('s1', 'Window sensor', 'z-living', 340),
  luxSensor('s2', 'Hall sensor', 'z-hall', null),
];

function week(suggestion: SensorWeek['suggestion']): SensorWeek {
  return {
    cells: [], days: [], covered: 84, low: 3, high: 900, lastAt: Date.now() - 60_000,
    verdict: { kind: 'usable', nightLux: 2, noonLux: 800 }, suggestion,
  };
}

const SUGGESTED = { darkLux: 12, brightLux: 260 };

async function paired(options: DriverAppOptions = {}) {
  const client = fakeApiClient(DEVICES);
  const built = driverApp(client, {
    week: week(SUGGESTED),
    sensors: [{ deviceId: 's1', name: 'Window sensor', lux: 340, at: Date.now() - 1000, available: true }],
    ...options,
  });
  const homey = fakeHomey({ app: built.app });
  const driver = makeDriver(DaylightDriver, homey);
  const session = new FakePairSession();
  await driver.onPair(session);
  await session.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
  return { ...built, driver, session };
}

async function repaired(stored: unknown, options: DriverAppOptions = {}) {
  const client = fakeApiClient(DEVICES);
  const built = driverApp(client, { week: week(SUGGESTED), ...options });
  const driver = makeDriver(DaylightDriver, fakeHomey({ app: built.app }));
  const session = new FakePairSession();
  const applied: any[] = [];
  await driver.onRepair(session, {
    getStoreValue: (key: string) => (key === 'daylight' ? stored : undefined),
    applyPlan: async (plan: unknown) => { applied.push(plan); },
  });
  return { ...built, driver, session, applied };
}

function storedPlan(response: Partial<typeof DEFAULT_RESPONSE>) {
  return {
    schemaVersion: 1, enabled: true, target: { kind: 'devices', deviceIds: ['l1'] },
    response: { ...DEFAULT_RESPONSE, ...response },
  };
}

describe('the sensor list', () => {
  test('every lux sensor, by room, with its reading and its AGE — and they are retained while open', async () => {
    const { session, record } = await paired();
    const list = await session.call('listSensors');

    const sensors = list.rooms.flatMap((room: { sensors: Array<{ id: string; lux: number | null; at: number | null }> }) => room.sensors);
    assert.deepEqual(sensors.map((sensor: { id: string }) => sensor.id).sort(), ['s1', 's2']);
    const hall = sensors.find((sensor: { id: string }) => sensor.id === 's2');
    assert.equal(hall.lux, null, 'a null reading is unknown, never 0 lux');
    assert.equal(hall.at, null);
    assert.ok(sensors.find((sensor: { id: string }) => sensor.id === 's1').at > 0);
    assert.deepEqual(record.retained[0]!.ids.sort(), ['s1', 's2']);
    assert.equal(typeof list.sunsetAt, 'string');
  });

  test('a lamp is not a sensor, however it is asked for', async () => {
    const { session, record } = await paired();
    // Refused, not quietly dropped: a pair session is a scriptable surface
    // (platform §14), and a lamp subscribed to as a sensor never reports a lux.
    await assert.rejects(session.call('setSensor', { sensor: 'l1' }), /cannot report how light it is/);
    assert.deepEqual(await session.call('setSensor', { sensor: 's1' }), { sensor: 's1' });
    assert.deepEqual(record.retained.at(-1), { ids: ['s1'], owner: record.retained.at(-1)!.owner });
    assert.deepEqual(await session.call('setSensor', {}), { sensor: null }, 'nothing chosen is the sun');
  });

  test('the session\'s sensors are released on disconnect, whoever else holds them', async () => {
    const { session, record } = await paired();
    await session.call('setSensor', { sensor: 's1' });
    await session.call('disconnect');
    assert.equal(record.released.length, 1);
    assert.equal(record.released[0], record.retained[0]!.owner);
  });
});

describe('the week\'s suggestion', () => {
  test('pre-fills the lux thresholds the first time a sensor is shown', async () => {
    const { session } = await paired();
    await session.call('setSensor', { sensor: 's1' });
    const reply = await session.call('getResponse');

    assert.equal(reply.response.darkLux, SUGGESTED.darkLux);
    assert.equal(reply.response.brightLux, SUGGESTED.brightLux);
    assert.equal(reply.sensorName, 'Window sensor');
    assert.equal(reply.nowLux, 340);
    assert.equal(reply.sun, null, 'with a sensor, the week carries the argument');
    assert.equal(reply.staleFor, null);
  });

  test('never over thresholds somebody edited — even back to the defaults', async () => {
    const { session } = await paired();
    await session.call('setSensor', { sensor: 's1' });
    await session.call('getResponse');
    // They looked, and put the numbers back where they started.
    await session.call('setDaylight', { response: { ...DEFAULT_RESPONSE, sensor: 's1' } });

    const reply = await session.call('getResponse');
    assert.equal(reply.response.darkLux, DEFAULT_RESPONSE.darkLux);
    assert.equal(reply.response.brightLux, DEFAULT_RESPONSE.brightLux);
  });

  test('never over the thresholds a repaired device was SAVED with, defaults included', async () => {
    const { session } = await repaired(storedPlan({ sensor: 's1' }));
    const reply = await session.call('getResponse');
    assert.equal(reply.response.darkLux, DEFAULT_RESPONSE.darkLux,
      'this is the case the old "still at the defaults" test overwrote');
    assert.equal(reply.response.brightLux, DEFAULT_RESPONSE.brightLux);
  });

  test('a repaired device that followed the SUN has never shown a lux number, so it is still owed one', async () => {
    const { session } = await repaired(storedPlan({ sensor: null }));
    await session.call('setSensor', { sensor: 's1' });
    const reply = await session.call('getResponse');
    assert.equal(reply.response.darkLux, SUGGESTED.darkLux);
  });

  test('an edit made while following the sun does not settle the lux thresholds', async () => {
    const { session } = await paired();
    await session.call('setDaylight', { response: { ...DEFAULT_RESPONSE, sensor: null, dark: 0.8 } });
    await session.call('setSensor', { sensor: 's1' });
    assert.equal((await session.call('getResponse')).response.darkLux, SUGGESTED.darkLux);
  });

  test('a week with no suggestion leaves the defaults alone', async () => {
    const { session } = await paired({ week: week(null) });
    await session.call('setSensor', { sensor: 's1' });
    assert.equal((await session.call('getResponse')).response.darkLux, DEFAULT_RESPONSE.darkLux);
  });
});

describe('the response screen', () => {
  test('refuses before lights are chosen', async () => {
    const client = fakeApiClient(DEVICES);
    const built = driverApp(client);
    const driver = makeDriver(DaylightDriver, fakeHomey({ app: built.app }));
    const session = new FakePairSession();
    await driver.onPair(session);
    await assert.rejects(session.call('getResponse'), { message: translate('errors.chooseLightsFirst') });
    await assert.rejects(session.call('previewNow'), { message: translate('errors.chooseLightsFirst') });
  });

  test('following the sun it draws today\'s sun, and labels both ends with a clock time', async () => {
    const { session } = await paired();
    const reply = await session.call('getResponse');
    assert.equal(reply.week, null);
    assert.ok(reply.sun && Number.isFinite(reply.sun.elevation) && reply.sun.peak >= reply.sun.elevation);
    assert.match(reply.atDark ?? '', /^\d\d:\d\d$/);
    assert.match(reply.atBright ?? '', /^\d\d:\d\d$/);
  });

  test('a sensor silent for half a day says for how long, and when it last spoke', async () => {
    const quiet = Date.now() - 20 * 3_600_000;
    const { session } = await paired({
      sensors: [{ deviceId: 's1', name: 'Window sensor', lux: 5, at: quiet, available: true }],
      week: { ...week(SUGGESTED), lastAt: quiet },
    });
    await session.call('setSensor', { sensor: 's1' });
    const reply = await session.call('getResponse');
    assert.equal(reply.staleFor, 20);
    assert.match(reply.lastReport, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* \d\d:\d\d$/);
  });

  test('setDaylight sanitises, re-checks the sensor against the catalogue and evaluates now', async () => {
    const { session, record } = await paired();
    await assert.rejects(session.call('setDaylight', { response: { ...DEFAULT_RESPONSE, sensor: 'l1' } }),
      /cannot report how light it is/, 'a lamp id is not a sensor');

    const reply = await session.call('setDaylight', { response: { ...DEFAULT_RESPONSE, sensor: 's1', dark: 'very' } });
    assert.equal(reply.response.sensor, 's1');
    assert.ok(reply.corrected.some((field: string) => field.includes('dark')), reply.corrected.join(', '));
    assert.equal(reply.now.brightness, 0.42);
    assert.deepEqual(record.retained.at(-1)!.ids, ['s1']);

    // The bare shape, without the `response` wrapper, is read too.
    const bare = await session.call('setDaylight', { ...DEFAULT_RESPONSE, sensor: null });
    assert.equal(bare.response.sensor, null);
  });

  test('previewNow is FORCED through an ephemeral runtime and stopped after', async () => {
    const { session, record } = await paired();
    assert.deepEqual(await session.call('previewNow'), { writes: 2, skipped: 0 });
    assert.equal(record.ephemeral[0]!.kind, 'daylight');
    assert.deepEqual(record.applied[0]!.options, { force: true, waitForResults: true, preview: true });
    assert.deepEqual(record.stopped, ['daylight']);
  });
});

describe('review, control and save', () => {
  test('the review says what it would do right now and where the number came from', async () => {
    const { session } = await paired();
    await session.call('setSensor', { sensor: 's1' });
    await session.call('getResponse');
    const review = await session.call('getReview');

    assert.equal(review.hero.kind, 'now');
    assert.equal(review.hero.percent, '42%');
    assert.equal(review.hero.detail, translate('review.nowFromSensor', { lux: 340, degrees: 20, sensor: 'Window sensor' }));
    assert.equal(review.rows[1].value, 'Window sensor');
    assert.equal(review.rows[2].value, `${translate('review.underLux', { lux: SUGGESTED.darkLux })} → 90%`);
    // Two of the three: a brightness written to an off lamp switches it on.
    assert.deepEqual(review.control.modes, ['after', 'none']);
  });

  test('following the sun, the review reads in degrees', async () => {
    const { session } = await paired();
    const review = await session.call('getReview');
    assert.equal(review.rows[1].value, translate('review.theSun'));
    assert.equal(review.rows[2].value, `${translate('review.belowDegrees', { degrees: -6 })} → 90%`);
  });

  test('a sensor that has gone reads as missing, not as a blank', async () => {
    const { session } = await repaired(storedPlan({ sensor: 'vanished' }));
    const review = await session.call('getReview');
    assert.equal(review.rows[1].value, translate('review.missingSensor'));
  });

  test('"before" is refused outright — this device type has nothing to pre-stage', async () => {
    const { session } = await paired();
    await assert.rejects(session.call('setControl', { mode: 'before' }));
    assert.deepEqual(await session.call('setControl', { mode: 'none' }), { mode: 'none' });
    assert.equal(session.has('testPreStage'), false);
  });

  test('save creates a dayl device; repair applies', async () => {
    const { session } = await paired();
    const saved = await session.call('save', '');
    assert.match(saved.device.data.id, /^lk-dayl-/);
    assert.equal(saved.device.name, 'Desk lamp daylight');
    assert.deepEqual(saved.device.store.daylight.target, { kind: 'devices', deviceIds: ['l1'] });

    const repair = await repaired(storedPlan({ sensor: 's1' }));
    assert.deepEqual(await repair.session.call('save', 'x'), { updated: true });
    assert.equal(repair.applied[0].response.sensor, 's1');
  });

  test('onInit and the intro', async () => {
    const { driver, session } = await paired();
    await driver.onInit();
    assert.ok(driver.logs.includes('Daylight driver initialised'));
    assert.equal((await session.call('getIntro')).hero, 'daylight');
    assert.equal(await session.call('add_device'), true);
  });
});
