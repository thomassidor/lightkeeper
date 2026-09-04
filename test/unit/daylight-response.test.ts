import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIGHT_ELEVATION, DARK_ELEVATION,
  brightnessFor, levelFromElevation, levelFromLux, orientationFactor,
  resolveLevel, windowAzimuthFor,
} from '../../lib/daylight/daylight-response';
import { DEFAULT_RESPONSE, SUN_PEAKS, type DaylightResponse } from '../../lib/daylight/daylight-types';

/**
 * The response is where a measurement becomes a brightness, and three of its
 * properties are the ones a user would notice going wrong:
 *
 *  - the lux ramp is LOGARITHMIC, so the indoor half of the range - every value
 *    a person can tell apart - occupies half the ramp rather than its bottom
 *    tenth;
 *  - it is DIRECTION-AGNOSTIC, so "dim the lamps as the day comes up" and
 *    "brighten the room with the day" are the same code with the two sliders
 *    swapped, and neither is a special case;
 *  - it can say I DO NOT KNOW. `source: 'none'` is what makes every consumer
 *    fall back to the brightness a person set by hand, and it is the reason that
 *    fixed value is kept beside the flag rather than replaced by it.
 *
 * Sensors beating the sky is asserted directly, because the alternative anybody
 * would reach for first - averaging a measurement with an inference - produces a
 * number that is neither and cannot be explained on a settings page.
 */

/** Lamps up as the daylight goes: the compensating case, and the default. */
const COMPENSATE: DaylightResponse = {
  sensors: ['sensor-a'], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25,
  sunPeak: 'none',
};
/** The same response with its ends swapped: the room follows the day instead. */
const FOLLOW: DaylightResponse = { ...COMPENSATE, dark: 0.25, bright: 0.9 };

const reading = (lux: number, deviceIds = ['sensor-a']) => ({ lux, deviceIds });

describe('levelFromLux', () => {
  test('the two ends are exactly 0 and 1', () => {
    assert.equal(levelFromLux(COMPENSATE, 5), 0);
    assert.equal(levelFromLux(COMPENSATE, 500), 1);
  });

  test('past either end it clamps rather than extrapolating', () => {
    assert.equal(levelFromLux(COMPENSATE, 0.001), 0);
    assert.equal(levelFromLux(COMPENSATE, 100_000), 1);
  });

  test('the midpoint of the ramp is the GEOMETRIC mean, not the arithmetic one', () => {
    // This single assertion is the whole logarithmic claim. sqrt(5 * 500) is
    // about 50 lx; on a linear ramp the halfway point would be 252.5, and 50 lx
    // - a lit room in the evening - would sit at level 0.09 instead of 0.5.
    const geometric = Math.sqrt(5 * 500);
    assert.ok(Math.abs(levelFromLux(COMPENSATE, geometric) - 0.5) < 1e-9);
    assert.ok(levelFromLux(COMPENSATE, 252.5) > 0.8, 'the arithmetic midpoint is near the top');
  });

  test('a reading of zero in a dark room is an answer, not an error', () => {
    // log10(0) is -Infinity, and log10 of a negative is NaN. Either reaching
    // brightnessFor produces a NaN dim value, which is a lamp told nothing.
    assert.equal(levelFromLux(COMPENSATE, 0), 0);
    assert.equal(levelFromLux(COMPENSATE, -12), 0);
  });

  test('a non-finite reading is treated as no light rather than propagated', () => {
    // Not an extreme - a refusal. A sensor that reports NaN or Infinity has
    // never reported a finite number, so LuminanceSource holds it unusable and
    // the sky answers instead; this branch is the net under that, and all it has
    // to do is not hand a NaN on to brightnessFor and from there to a lamp.
    assert.equal(levelFromLux(COMPENSATE, Number.NaN), 0);
    assert.equal(levelFromLux(COMPENSATE, Number.POSITIVE_INFINITY), 0);
  });

  test('a span that is not a span yields 0 rather than NaN', () => {
    // sanitiseResponse and validateDaylightResponse both refuse this, so it can
    // only arrive from a fixture - but a NaN here would reach a lamp silently.
    const flat: DaylightResponse = { ...COMPENSATE, darkLux: 100, brightLux: 100 };
    assert.equal(levelFromLux(flat, 100), 0);
    const inverted: DaylightResponse = { ...COMPENSATE, darkLux: 500, brightLux: 5 };
    assert.equal(levelFromLux(inverted, 50), 0);
  });

  test('it is eased, so it settles into both ends', () => {
    // A raised cosine is flat at the ends: a decade of lux just above the dark
    // end must move the level less than a decade in the middle does.
    const nearEnd = levelFromLux(COMPENSATE, 5 * 1.2) - levelFromLux(COMPENSATE, 5);
    const middle = levelFromLux(COMPENSATE, 50 * 1.2) - levelFromLux(COMPENSATE, 50);
    assert.ok(nearEnd < middle, `expected easing, got ${nearEnd} at the end and ${middle} mid-ramp`);
  });

  test('it is monotonic across the whole plausible range', () => {
    let previous = -1;
    for (let lux = 0; lux <= 2000; lux += 1) {
      const level = levelFromLux(COMPENSATE, lux);
      assert.ok(level >= previous, `level fell at ${lux} lux`);
      assert.ok(level >= 0 && level <= 1, `level out of range at ${lux} lux`);
      previous = level;
    }
  });
});

describe('levelFromElevation', () => {
  test('civil twilight is the bottom of the ramp and stays there all night', () => {
    assert.equal(levelFromElevation(DARK_ELEVATION), 0);
    assert.equal(levelFromElevation(-30), 0);
    assert.equal(levelFromElevation(-90), 0);
  });

  test('a high sun is the top of it', () => {
    assert.equal(levelFromElevation(BRIGHT_ELEVATION), 1);
    assert.equal(levelFromElevation(75), 1);
  });

  test('the horizon sits low on the ramp, which is the point of the dark end', () => {
    // The sun ON the horizon is not a lit room. Anchoring the dark end at 0
    // degrees instead of -6 would have the lamps already dropping while the sky
    // still needs them.
    const horizon = levelFromElevation(0);
    assert.ok(horizon > 0 && horizon < 0.1, `expected the horizon low on the ramp, got ${horizon}`);
  });

  test('it is monotonic and bounded from below the horizon to overhead', () => {
    let previous = -1;
    for (let degrees = -90; degrees <= 90; degrees += 0.5) {
      const level = levelFromElevation(degrees);
      assert.ok(level >= previous, `level fell at ${degrees} degrees`);
      assert.ok(level >= 0 && level <= 1, `level out of range at ${degrees} degrees`);
      previous = level;
    }
  });

  test('a non-finite elevation is no light rather than a NaN', () => {
    assert.equal(levelFromElevation(Number.NaN), 0);
  });
});

describe('brightnessFor', () => {
  test('the ends are returned verbatim, to the last bit', () => {
    assert.equal(brightnessFor(COMPENSATE, 0), 0.9);
    assert.equal(brightnessFor(COMPENSATE, 1), 0.25);
  });

  test('an interpolated end would miss it by an ULP, which is why it is not', () => {
    // mix(1, 0.1, 1) is 0.09999999999999998 - one bit below the end the user
    // set, and below MINIMUM_BRIGHTNESS with it. Nothing downstream breaks
    // (litDim is the net under exactly this), but "the bright slider is what a
    // bright day gets" stops being exactly true, and that is a claim a settings
    // page makes.
    const steep = { ...COMPENSATE, dark: 1, bright: 0.1 };
    assert.equal(brightnessFor(steep, 1), 0.1);
    assert.equal(brightnessFor(steep, 0), 1);
  });

  test('it works in BOTH directions, with no mode and no special case', () => {
    // The same level, the two responses, and the answers are each other's.
    assert.equal(brightnessFor(FOLLOW, 0), 0.25);
    assert.equal(brightnessFor(FOLLOW, 1), 0.9);
    assert.equal(brightnessFor(COMPENSATE, 0.5), brightnessFor(FOLLOW, 0.5));
  });

  test('a level outside 0-1 clamps rather than pushing a lamp past an end', () => {
    assert.equal(brightnessFor(COMPENSATE, -5), 0.9);
    assert.equal(brightnessFor(COMPENSATE, 12), 0.25);
    assert.equal(brightnessFor(COMPENSATE, Number.NaN), 0.9);
  });

  test('the result never leaves the brightness axis', () => {
    for (const response of [COMPENSATE, FOLLOW, DEFAULT_RESPONSE]) {
      for (let level = 0; level <= 1; level += 0.01) {
        const brightness = brightnessFor(response, level);
        assert.ok(brightness >= 0 && brightness <= 1, `out of range at level ${level}`);
      }
    }
  });
});

describe('resolveLevel - which input is believed', () => {
  test('a usable sensor reading wins, and the sky is not consulted', () => {
    // Both available, and the answer is the sensor's alone. Were the two
    // blended, a sensor reading 5 lx under a bright noon sky would land
    // somewhere in the middle - a number that is neither measurement nor
    // inference, and that moves when either moves.
    const resolved = resolveLevel(COMPENSATE, { elevation: 45, reading: reading(5) });
    assert.equal(resolved.source, 'sensors');
    assert.equal(resolved.level, 0);
  });

  test('the sky answers when there is no sensor at all', () => {
    // The many households that own no lux sensor. This is what makes the device
    // work for them rather than reporting itself broken.
    const resolved = resolveLevel({ ...COMPENSATE, sensors: [] }, {
      elevation: BRIGHT_ELEVATION, reading: null,
    });
    assert.equal(resolved.source, 'sky');
    assert.equal(resolved.level, 1);
  });

  test('a reading over zero usable sensors is not a reading', () => {
    // LuminanceSource returns the mean over the sensors it could use, and the
    // list is empty when every one of them is unavailable or has never
    // reported. A mean of nothing is 0, and believing it would drive a room to
    // the dark end on the strength of a flat battery.
    const resolved = resolveLevel(COMPENSATE, { elevation: 45, reading: reading(0, []) });
    assert.equal(resolved.source, 'sky');
  });

  test('neither input is I DO NOT KNOW, not a guess', () => {
    // The verdict that makes a device report needs_repair and every consumer
    // fall back to the brightness a person set by hand.
    const resolved = resolveLevel(COMPENSATE, { elevation: null, reading: null });
    assert.equal(resolved.source, 'none');
    assert.equal(resolved.level, 0);
  });

  test('a non-finite elevation counts as no location', () => {
    const resolved = resolveLevel(COMPENSATE, { elevation: Number.NaN, reading: null });
    assert.equal(resolved.source, 'none');
  });

  test('the default response reads a lit evening room as needing the lamps up', () => {
    // An end-to-end sanity check on the defaults themselves: 20 lx is a room at
    // dusk with nothing on, and it should land nearer the dark end than the
    // bright one.
    const { level } = resolveLevel(DEFAULT_RESPONSE, { elevation: -2, reading: reading(20) });
    const brightness = brightnessFor(DEFAULT_RESPONSE, level);
    assert.ok(brightness > 0.6, `expected the lamps well up at 20 lux, got ${brightness}`);
  });

  test('and a room with real daylight in it as needing them down', () => {
    const { level } = resolveLevel(DEFAULT_RESPONSE, { elevation: 40, reading: reading(800) });
    const brightness = brightnessFor(DEFAULT_RESPONSE, level);
    assert.equal(brightness, DEFAULT_RESPONSE.bright);
  });
});

/**
 * The orientation model: what "when does this room get the most sun" buys.
 *
 * Every assertion here is about a PROPERTY rather than a number, because the
 * model is fitted to nothing and its numbers are a judgement. The properties are
 * not: they are what makes it safe to ship over installed devices.
 */
describe('which way the room faces', () => {
  const ROOM: DaylightResponse = {
    sensors: [], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25, sunPeak: 'none',
  };

  /** Sun due east, due south, due west — the bearings, not times. */
  const EAST = 90;
  const SOUTH = 180;
  const WEST = 270;

  test('none returns the bare elevation ramp, to the bit', () => {
    // The promise that makes this shippable: a device that never answered the
    // question is unchanged, not approximately unchanged.
    for (const elevation of [-10, -6, 0, 12, 25, 60]) {
      for (const azimuth of [EAST, SOUTH, WEST, 0, 359]) {
        const { level } = resolveLevel(ROOM, {
          elevation, reading: null, azimuth, latitude: 55.7,
        });
        assert.equal(level, levelFromElevation(elevation),
          `elevation ${elevation}, azimuth ${azimuth}`);
      }
    }
  });

  test('the factor is never above 1, so no room reads BRIGHTER than the sky', () => {
    // The old model implicitly treated every room as optimally oriented, so
    // every correction has to be downward — otherwise answering the question
    // could make an installed device's lamps dimmer than before.
    for (const peak of SUN_PEAKS) {
      for (let azimuth = 0; azimuth < 360; azimuth += 5) {
        const factor = orientationFactor(peak, 55.7, azimuth);
        assert.ok(factor <= 1 + 1e-12, `${peak} at ${azimuth}° gave ${factor}`);
        assert.ok(factor > 0, `${peak} at ${azimuth}° gave ${factor}`);
      }
    }
  });

  test('a north-facing room is dimmer than the sky but never dark', () => {
    // Most of what reaches a room the sun never enters is diffuse skylight,
    // which arrives from everywhere. A factor of zero would black it out at noon.
    const midday: DaylightResponse = { ...ROOM, sunPeak: 'midday' };
    const behind = orientationFactor(midday.sunPeak, 55.7, 0); // sun due north
    assert.ok(behind > 0.2 && behind < 0.5, `expected a diffuse floor, got ${behind}`);
  });

  test('morning and afternoon rooms peak on OPPOSITE sides of noon', () => {
    // The whole point. Elevation alone cannot do this: it is symmetric about
    // solar noon, so 08:00 and 16:00 are the same number.
    const morningRoom: DaylightResponse = { ...ROOM, sunPeak: 'morning' };
    const afternoonRoom: DaylightResponse = { ...ROOM, sunPeak: 'afternoon' };

    const atEast = (r: DaylightResponse) =>
      resolveLevel(r, { elevation: 20, reading: null, azimuth: EAST, latitude: 55.7 }).level;
    const atWest = (r: DaylightResponse) =>
      resolveLevel(r, { elevation: 20, reading: null, azimuth: WEST, latitude: 55.7 }).level;

    assert.ok(atEast(morningRoom) > atWest(morningRoom),
      'a morning room should be brighter with the sun in the east');
    assert.ok(atWest(afternoonRoom) > atEast(afternoonRoom),
      'an afternoon room should be brighter with the sun in the west');
    // And they are mirror images of each other.
    assert.ok(Math.abs(atEast(morningRoom) - atWest(afternoonRoom)) < 1e-9,
      'morning-at-east should equal afternoon-at-west');
  });

  test('the middle of the day faces SOUTH up north and NORTH down south', () => {
    // The sun crosses the northern sky below the equator, so a hardcoded 180
    // would put every southern-hemisphere midday room on the wrong side.
    assert.equal(windowAzimuthFor('midday', 55.7), 180);
    assert.equal(windowAzimuthFor('midday', -33.9), 0);
    // Sunrise is in the east everywhere, so these do not flip.
    assert.equal(windowAzimuthFor('morning', -33.9), 90);
    assert.equal(windowAzimuthFor('afternoon', -33.9), 270);
    assert.equal(windowAzimuthFor('none', 55.7), null);
  });

  test('a SENSOR overrides the model entirely', () => {
    // A sensor measures this room. Modelling a room already measured would be
    // applying a guess on top of a reading.
    const facing: DaylightResponse = { ...ROOM, sensors: ['s1'], sunPeak: 'afternoon' };
    const withSensor = resolveLevel(facing, {
      elevation: 20,
      reading: { lux: 500, deviceIds: ['s1'] },
      azimuth: EAST,
      latitude: 55.7,
    });
    assert.equal(withSensor.source, 'sensors');
    assert.equal(withSensor.level, levelFromLux(facing, 500));
  });

  test('the level stays inside 0..1 whatever the inputs', () => {
    for (const peak of SUN_PEAKS) {
      for (const elevation of [-90, -6, 0, 45, 90]) {
        for (const azimuth of [0, 90, 180, 270, 359]) {
          const { level } = resolveLevel({ ...ROOM, sunPeak: peak }, {
            elevation, reading: null, azimuth, latitude: 55.7,
          });
          assert.ok(level >= 0 && level <= 1, `${peak}/${elevation}/${azimuth} gave ${level}`);
        }
      }
    }
  });
});
