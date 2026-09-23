import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fakeHomey, makeDriver, translate, FakePairSession } from '../support/fake-homey';
import { fakeApiClient, lamp } from '../support/fake-homey-api';
import { driverApp, type DriverAppOptions } from '../support/fake-lightkeeper-app';
import { DEFAULT_POINTS, MIN_POINTS } from '../../lib/circadian/circadian-types';

const CurveDriver = require('../../drivers/curve/driver');
const ScheduleDriver = require('../../drivers/schedule/driver');

/**
 * The two remaining drivers' pair and repair sessions, executed: the Colour
 * Curve Light and the light schedule. See `driver-controller.test.ts` for why
 * none of this could run before `test/support/fake-homey.ts`.
 */

const DEVICES = [
  // ON, so a curve preview — which writes only to lit lamps unless it
  // pre-stages — has something to reach.
  lamp('l1', 'Sofa lamp', 'z-living', { onoff: true }),
  lamp('l2', 'Hall spot', 'z-hall', { onoff: false }),
];

async function session(Driver: any, options: DriverAppOptions & { repair?: { key: string; plan: unknown } } = {}) {
  const client = fakeApiClient(DEVICES);
  const built = driverApp(client, options);
  const driver = makeDriver(Driver, fakeHomey({ app: built.app }));
  const s = new FakePairSession();
  const applied: any[] = [];
  if (options.repair) {
    const { key, plan } = options.repair;
    await driver.onRepair(s, {
      getStoreValue: (asked: string) => (asked === key ? plan : undefined),
      applyPlan: async (next: unknown) => { applied.push(next); },
    });
  } else {
    await driver.onPair(s);
  }
  return { ...built, client, driver, session: s, applied };
}

describe('the Colour Curve Light', () => {
  test('a new curve starts from the default points WITH brightness', async () => {
    const { session: s } = await session(CurveDriver);
    await assert.rejects(s.call('getCurve'), { message: translate('errors.chooseLightsFirst') });
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });

    const curve = await s.call('getCurve');
    assert.equal(curve.points.length, DEFAULT_POINTS.length);
    assert.equal(curve.adjustBrightness, true);
    assert.equal(curve.minPoints, MIN_POINTS);
    assert.ok(curve.palette.length > 0 && curve.layout.featured.length > 0);
    assert.equal(curve.palette[0].label, translate(`palette.${curve.palette[0].id}`));
    assert.equal(curve.timezone, 'Europe/Copenhagen');
  });

  test('setCurve drops a bad point and names why', async () => {
    const { session: s, driver } = await session(CurveDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    const reply = await s.call('setCurve', {
      points: [...DEFAULT_POINTS, { id: 'bad', anchor: { kind: 'clock', at: 'noon' }, warmth: 0.5 }],
      adjustBrightness: true,
    });
    assert.equal(reply.count, DEFAULT_POINTS.length);
    assert.equal(reply.dropped.length, 1);
    assert.ok(driver.logs.some((line: string) => line.startsWith('Dropped point 6')));
  });

  test('a curve of one point cannot be saved, and the refusal is translated', async () => {
    const { session: s } = await session(CurveDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await s.call('setCurve', { points: [DEFAULT_POINTS[0]] });
    await assert.rejects(s.call('save', ''), { message: translate('errors.curveNeedsPoints', { count: MIN_POINTS }) });
    await assert.rejects(s.call('previewNow'), { message: translate('errors.curveNeedsPoints', { count: MIN_POINTS }) });
  });

  test('the review draws one bar an hour and reads the brightness range', async () => {
    const { session: s } = await session(CurveDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    const review = await s.call('getReview');

    assert.equal(review.hero.kind, 'bars');
    assert.equal(review.hero.bars.length, 24);
    assert.equal(review.rows[1].value, `${DEFAULT_POINTS.length} · 06:30–22:30`);
    assert.equal(review.rows[2].value, translate('review.brightnessRange', { min: 36, max: 94 }));
    assert.deepEqual(review.control.modes, ['after', 'before', 'none']);
  });

  test('brightness off reads as "not changed"', async () => {
    const { session: s } = await session(CurveDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await s.call('setCurve', { points: [...DEFAULT_POINTS], adjustBrightness: false });
    const review = await s.call('getReview');
    assert.equal(review.rows[2].value, translate('review.notChanged'));
    for (const bar of review.hero.bars) assert.equal(bar.height, 1);
  });

  test('previewNow runs a real ephemeral curve and the lamps answer', async () => {
    const { session: s, client } = await session(CurveDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await s.call('previewNow');
    assert.ok(client.writes.some(write => write.deviceId === 'l1'), 'the preview reached the lamp');
  });

  test('save stores a curv device; repair seeds from the store and applies', async () => {
    const { session: s } = await session(CurveDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    const saved = await s.call('save', 'Evening');
    assert.match(saved.device.data.id, /^lk-curv-/);
    assert.equal(saved.device.name, 'Evening');
    assert.equal(saved.device.store.curve.points.length, DEFAULT_POINTS.length);

    const stored = { ...saved.device.store.curve, adjustBrightness: false, points: [] };
    const repair = await session(CurveDriver, { repair: { key: 'curve', plan: stored } });
    const curve = await repair.session.call('getCurve');
    assert.equal(curve.points.length, DEFAULT_POINTS.length, 'an empty stored list falls back to the defaults');
    assert.equal(curve.adjustBrightness, false, 'but the stored brightness choice is kept');
    assert.deepEqual(await repair.session.call('save', ''), { updated: true });
  });

  test('onInit and the intro', async () => {
    const { driver, session: s } = await session(CurveDriver);
    await driver.onInit();
    assert.ok(driver.logs.includes('Curve driver initialised'));
    assert.equal((await s.call('getIntro')).hero, 'curve');
    assert.equal(await s.call('add_device'), true);
  });
});

describe('the light schedule', () => {
  const WINDOW = { id: 'a', onAt: 22 * 60, end: { kind: 'duration', minutes: 180 }, brightness: 0.5, color: 'amber' };

  test('the key screen jumps to THIS driver\'s first step', async () => {
    const { session: s } = await session(ScheduleDriver);
    const status = await s.call('getCredentialStatus');
    assert.equal(status.nextView, 'lights', 'a view that does not exist renders an empty screen');
    assert.equal((await s.call('getIntro')).nextView, 'credential');
  });

  test('getSchedule refuses before lights, and then offers the palette and the overlaps', async () => {
    const { session: s } = await session(ScheduleDriver);
    await assert.rejects(s.call('getSchedule'), { message: translate('errors.chooseLightsFirst') });
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    const schedule = await s.call('getSchedule');
    assert.equal(schedule.maxEntries, 12);
    assert.deepEqual(schedule.entries, []);
    assert.deepEqual(schedule.overlaps, []);
    assert.ok(schedule.palette.length > 0);
  });

  /**
   * The bare list is the case that was broken: `'entries' in []` is true, so an
   * array was read as a wrapper and `sanitiseEntries` was handed
   * `Array.prototype.entries`. Every row dropped, "0 schedules", no error.
   */
  test('setSchedules sanitises, takes the days with the rows, and accepts the bare list too', async () => {
    const { session: s, driver } = await session(ScheduleDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });

    const reply = await s.call('setSchedules', { entries: [WINDOW, { id: 'b', onAt: 'late' }], days: [6, 7] });
    assert.equal(reply.count, 1);
    assert.equal(reply.dropped.length, 1);
    assert.deepEqual(reply.days, [6, 7]);
    assert.ok(driver.logs.some((line: string) => line.startsWith('Dropped schedule 2')));

    const bare = await s.call('setSchedules', [WINDOW, { ...WINDOW, id: 'c', onAt: 23 * 60 }]);
    assert.equal(bare.count, 2);
    assert.deepEqual(bare.days, [6, 7], 'a bare list leaves the days alone');
    assert.equal(bare.overlaps.length, 1, 'two windows that fight are reported, never refused');
  });

  test('save refuses an empty schedule, translated', async () => {
    const { session: s } = await session(ScheduleDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await assert.rejects(s.call('save', ''), { message: translate('errors.addASchedule') });
    await assert.rejects(s.call('test', { entryId: 'a', boundary: 'on' }), { message: translate('errors.addASchedule') });
  });

  test('the Test control applies one end through an ephemeral runtime', async () => {
    const { session: s, record } = await session(ScheduleDriver);
    await assert.rejects(s.call('test', { entryId: 'a', boundary: 'on' }), { message: translate('errors.chooseLightsFirst') });
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await s.call('setSchedules', { entries: [WINDOW] });

    await s.call('test', { entryId: 'a', boundary: 'off' });
    await s.call('test', { entryId: 'a', boundary: 'anything else' });
    assert.deepEqual(record.entries, [{ entryId: 'a', boundary: 'off' }, { entryId: 'a', boundary: 'on' }]);
    assert.deepEqual(record.stopped, ['schedule', 'schedule']);
  });

  test('the review draws the day, splitting a block that crosses midnight in two', async () => {
    const { session: s } = await session(ScheduleDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await s.call('setSchedules', { entries: [WINDOW] });
    const review = await s.call('getReview');

    assert.equal(review.hero.kind, 'timeline');
    assert.deepEqual(review.hero.blocks, [{ left: 91.67, width: 8.33 }, { left: 0, width: 4.17 }]);
    assert.equal(review.rows[1].value, '1');
    assert.equal(review.rows[2].value, 'every day');
    assert.equal('control' in review, false);
  });

  test('save stores a sched device with no Flows yet; repair opens on the stored days', async () => {
    const { session: s } = await session(ScheduleDriver);
    await s.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
    await s.call('setSchedules', { entries: [WINDOW] });
    const saved = await s.call('save', '');
    assert.match(saved.device.data.id, /^lk-sched-/);
    assert.equal(saved.device.name, 'Sofa lamp schedule');
    assert.deepEqual(saved.device.store.schedule.managedFlows, []);

    const repair = await session(ScheduleDriver, {
      repair: { key: 'schedule', plan: { ...saved.device.store.schedule, days: [1, 2, 3, 4, 5] } },
    });
    assert.deepEqual((await repair.session.call('getSchedule')).days, [1, 2, 3, 4, 5]);
    assert.deepEqual(await repair.session.call('save', ''), { updated: true });
    assert.equal(repair.applied.length, 1);
  });

  test('onInit', async () => {
    const { driver } = await session(ScheduleDriver);
    await driver.onInit();
    assert.ok(driver.logs.includes('Schedule driver initialised'));
  });
});
