import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DaylightEvaluator } from '../../lib/daylight/daylight-evaluator';
import { DEFAULT_RESPONSE, type DaylightResponse } from '../../lib/daylight/daylight-types';
import type { LuminanceSource } from '../../lib/daylight/luminance-source';

/**
 * The seam between "where is the sun and what do the sensors say" and "what
 * brightness, then".
 *
 * Two things are worth a test here rather than being obvious. The first is that
 * NOTHING it can be handed makes it throw or return a NaN: its caller is a tick
 * that turns the answer into a dim write, and a NaN there is a lamp told nothing
 * at all with no error to show for it. `this.homey.geolocation.getLatitude()`
 * THROWS without the permission, so app.ts's closure can legitimately hand back
 * null, an empty object, or whatever a future firmware decides.
 *
 * The second is that a device with no sensors configured must not consult the
 * shared luminance service at all. It is shared, so a Daylight light that names
 * no sensor asking it for a mean would pick up whatever some other device's
 * sensors happen to read - a room dimmed by a reading from a different room.
 */

function harness(options: {
  location?: unknown;
  now?: number;
  reading?: { lux: number; deviceIds: string[] } | null;
} = {}) {
  const readCalls: string[][] = [];
  const luminance = {
    read(deviceIds: string[]) {
      readCalls.push(deviceIds);
      return options.reading ?? null;
    },
    watched() {
      return [{ deviceId: 's1', name: 'Hall', lux: 42, at: 1, available: true }];
    },
  } as unknown as LuminanceSource;

  const evaluator = new DaylightEvaluator({
    location: () => (('location' in options) ? options.location : { latitude: 55.68, longitude: 12.57 }),
    luminance,
    now: () => options.now ?? Date.UTC(2026, 5, 21, 10, 0),
  });

  return { evaluator, readCalls };
}

/** Noon in Copenhagen at the June solstice: the sun is high. */
const HIGH_SUN = Date.UTC(2026, 5, 21, 10, 0);
/** The middle of the same night. */
const NIGHT = Date.UTC(2026, 11, 21, 0, 0);

describe('DaylightEvaluator.evaluate', () => {
  test('a high sun with no sensors reads bright, and says so', () => {
    const { evaluator } = harness({ now: HIGH_SUN });
    const verdict = evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: [] });

    assert.equal(verdict.source, 'sky');
    assert.equal(verdict.level, 1);
    assert.equal(verdict.brightness, DEFAULT_RESPONSE.bright);
    assert.ok(verdict.elevation !== null && verdict.elevation > 50);
  });

  test('a winter midnight reads dark', () => {
    const { evaluator } = harness({ now: NIGHT });
    const verdict = evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: [] });

    assert.equal(verdict.source, 'sky');
    assert.equal(verdict.level, 0);
    assert.equal(verdict.brightness, DEFAULT_RESPONSE.dark);
    assert.ok(verdict.elevation !== null && verdict.elevation < -6);
  });

  test('a usable sensor reading wins over a bright sky', () => {
    const { evaluator } = harness({
      now: HIGH_SUN, reading: { lux: 5, deviceIds: ['s1'] },
    });
    const verdict = evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: ['s1'] });

    assert.equal(verdict.source, 'sensors');
    assert.equal(verdict.brightness, DEFAULT_RESPONSE.dark);
  });

  test('a device with no sensors never asks the shared service', () => {
    // It is SHARED. Asking it for a mean over an empty list, or worse over
    // whatever it happens to be holding, is a room dimmed by a reading from a
    // different room.
    const { evaluator, readCalls } = harness({ reading: { lux: 900, deviceIds: ['someone-elses'] } });
    const verdict = evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: [] });

    assert.deepEqual(readCalls, []);
    assert.equal(verdict.source, 'sky');
  });

  test('a device with sensors asks for exactly its own', () => {
    const { evaluator, readCalls } = harness({ reading: { lux: 50, deviceIds: ['s1'] } });
    evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: ['s1', 's2'] });

    assert.deepEqual(readCalls, [['s1', 's2']]);
  });

  test('no location and no sensor is I DO NOT KNOW', () => {
    // The verdict that makes a device report needs_repair and every consumer
    // fall back to the brightness a person set by hand.
    const { evaluator } = harness({ location: null });
    const verdict = evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: [] });

    assert.equal(verdict.source, 'none');
    assert.equal(verdict.elevation, null);
    // Still a usable number, because the caller writes it if it decides to.
    assert.equal(verdict.brightness, DEFAULT_RESPONSE.dark);
  });

  test('no location but a working sensor is fine, and needs no permission', () => {
    // Worth stating: a household with a lux sensor gets the whole feature even
    // if geolocation is refused or unset.
    const { evaluator } = harness({ location: null, reading: { lux: 900, deviceIds: ['s1'] } });
    const verdict = evaluator.evaluate({ ...DEFAULT_RESPONSE, sensors: ['s1'] });

    assert.equal(verdict.source, 'sensors');
    assert.equal(verdict.brightness, DEFAULT_RESPONSE.bright);
  });
});

describe('DaylightEvaluator - nothing it is handed makes it throw', () => {
  const RUBBISH: unknown[] = [
    null, undefined, 0, '', 'here', true, [], {},
    { latitude: 55.68 }, { longitude: 12.57 },
    { latitude: 0, longitude: 0 },
    { latitude: Number.NaN, longitude: 12.57 },
    { latitude: null, longitude: 12.57 },
    { latitude: 400, longitude: 12.57 },
  ];

  test('every shape a geolocation closure can hand back yields a usable verdict', () => {
    for (const location of RUBBISH) {
      const { evaluator } = harness({ location });
      const verdict = evaluator.evaluate(DEFAULT_RESPONSE);

      assert.ok(Number.isFinite(verdict.level), `level was not finite for ${JSON.stringify(location)}`);
      assert.ok(Number.isFinite(verdict.brightness), `brightness was not finite for ${JSON.stringify(location)}`);
      assert.ok(verdict.brightness >= 0 && verdict.brightness <= 1);
      assert.equal(verdict.source, 'none', `expected no source for ${JSON.stringify(location)}`);
    }
  });

  test('a location accessor that throws is the app boundary, not ours', () => {
    // app.ts wraps getLatitude() in a try/catch because it throws without the
    // permission. If that ever regresses, this asserts the failure arrives here
    // rather than being swallowed into a plausible-looking brightness.
    const evaluator = new DaylightEvaluator({
      location: () => { throw new Error('missing permission'); },
      luminance: { read: () => null, watched: () => [] } as unknown as LuminanceSource,
      now: () => HIGH_SUN,
    });
    assert.throws(() => evaluator.evaluate(DEFAULT_RESPONSE), /missing permission/);
  });

  test('the response ends are never left behind, whatever the inputs', () => {
    const responses: DaylightResponse[] = [
      DEFAULT_RESPONSE,
      { ...DEFAULT_RESPONSE, dark: 0.25, bright: 0.9 },
      { ...DEFAULT_RESPONSE, dark: 1, bright: 0.1 },
    ];
    for (const response of responses) {
      for (const now of [HIGH_SUN, NIGHT, Date.UTC(2026, 2, 20, 6, 0)]) {
        const { evaluator } = harness({ now });
        const { brightness } = evaluator.evaluate(response);
        const low = Math.min(response.dark, response.bright);
        const high = Math.max(response.dark, response.bright);
        assert.ok(brightness >= low && brightness <= high, `${brightness} outside [${low}, ${high}]`);
      }
    }
  });
});

describe('DaylightEvaluator.sky - the readout a person checks first', () => {
  test('it answers without being given a device or a response', () => {
    const { evaluator } = harness({ now: HIGH_SUN });
    const sky = evaluator.sky();

    assert.ok(sky.elevation !== null && sky.elevation > 50);
    assert.equal(sky.level, 1);
    assert.deepEqual(sky.location, { latitude: 55.68, longitude: 12.57 });
  });

  test('with no position it says so rather than guessing', () => {
    // This is the single fastest check that the permission resolved: a null here
    // and a plausible number there are the two answers, and they are different
    // problems.
    const { evaluator } = harness({ location: { latitude: 0, longitude: 0 } });
    assert.deepEqual(evaluator.sky(), { elevation: null, level: null, location: null });
  });

  test('the sky level ignores the response ends entirely', () => {
    // It is one number for the whole app, so it cannot be scaled by any one
    // device's two sliders.
    const { evaluator } = harness({ now: NIGHT });
    assert.equal(evaluator.sky().level, 0);
  });

  test('sensors() passes the shared service straight through', () => {
    const { evaluator } = harness();
    assert.deepEqual(evaluator.sensors(), [
      { deviceId: 's1', name: 'Hall', lux: 42, at: 1, available: true },
    ]);
  });
});
