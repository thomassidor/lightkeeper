import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { solarElevation } from '../../lib/daylight/solar-elevation';

/**
 * Sixty lines of trigonometry with no way to eyeball the answer.
 *
 * A sign error, a degrees/radians slip or a UTC/local confusion in
 * `solarElevation` produces a number that looks entirely plausible — the sun at
 * 40 degrees when it is really at 4 — and the only symptom on a Homey is a room
 * that is dim at the wrong times of day. So none of the expectations below are
 * copied from a table. Every one is a value astronomy fixes independently of any
 * implementation:
 *
 *  - at a pole, elevation equals the sun's declination and does not change all
 *    day, so a longitude or hour-angle bug shows up as movement;
 *  - at solar noon, elevation is 90 minus the latitude-to-declination gap, which
 *    pins the declination itself;
 *  - the two hemispheres mirror at an equinox, which pins the latitude sign;
 *  - 15 degrees of longitude is exactly an hour, which pins the
 *    four-minutes-per-degree term.
 *
 * The declination at the 2026 solstices is 23.44 degrees either side of the
 * equator and at the equinoxes about zero; the tolerances below are 0.2 degrees
 * because the sampled instant is the nearest UTC midnight rather than the
 * solstice itself.
 */

/** Solstices and equinox, 2026, at UTC midnight. */
const JUNE = Date.UTC(2026, 5, 21);
const DECEMBER = Date.UTC(2026, 11, 21);
const MARCH_EQUINOX = Date.UTC(2026, 2, 20);

const HOUR = 3_600_000;
const MINUTE = 60_000;
const TILT = 23.44;

/** The highest and lowest the sun gets on one whole UTC day, sampled every minute. */
function overDay(latitude: number, longitude: number, dayMs: number) {
  let highest = -Infinity;
  let lowest = Infinity;
  for (let minute = 0; minute < 1440; minute += 1) {
    const elevation = solarElevation(latitude, longitude, dayMs + minute * MINUTE);
    highest = Math.max(highest, elevation);
    lowest = Math.min(lowest, elevation);
  }
  return { highest, lowest };
}

function assertClose(actual: number, expected: number, tolerance: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${expected} give or take ${tolerance}, got ${actual}`,
  );
}

describe('solarElevation - the poles, where the answer is a constant', () => {
  test('at the north pole on the June solstice the sun sits at the declination', () => {
    assertClose(solarElevation(90, 0, JUNE + 12 * HOUR), TILT, 0.2, 'north pole noon');
  });

  test('and it does not move all day, at any longitude', () => {
    // The whole hour-angle term collapses at a pole, because cos(latitude) is
    // zero there. If this moves, longitude or the equation of time is reaching
    // the answer twice.
    const readings = [0, 6, 12, 18].map(hour => solarElevation(90, 0, JUNE + hour * HOUR));
    const spread = Math.max(...readings) - Math.min(...readings);
    assert.ok(spread < 0.02, `expected a flat day at the pole, got a spread of ${spread}`);

    // A longitude at the pole is meaningless, and the maths must agree.
    assertClose(
      solarElevation(90, 174, JUNE + 3 * HOUR),
      solarElevation(90, -12, JUNE + 3 * HOUR),
      0.02,
      'longitude at the pole',
    );
  });

  test('the south pole is the north pole negated on the same day', () => {
    assertClose(solarElevation(-90, 0, JUNE + 12 * HOUR), -TILT, 0.2, 'south pole, June');
    assertClose(solarElevation(-90, 0, DECEMBER + 12 * HOUR), TILT, 0.2, 'south pole, December');
  });
});

describe('solarElevation - noon, where 90 minus the latitude gap is the answer', () => {
  test('the equator reaches almost overhead at an equinox', () => {
    // Not exactly 90: the equinox instant is not UTC midnight on the 20th, so
    // the declination is a fraction of a degree off zero.
    assertClose(overDay(0, 0, MARCH_EQUINOX).highest, 90, 0.3, 'equator, equinox');
  });

  test('the equator at the June solstice tops out at 90 minus the tilt', () => {
    assertClose(overDay(0, 0, JUNE).highest, 90 - TILT, 0.2, 'equator, June');
  });

  test('a mid-latitude summer and winter noon differ by twice the tilt', () => {
    // Copenhagen, the reference Homey's own latitude.
    const summer = overDay(55.68, 12.57, JUNE).highest;
    const winter = overDay(55.68, 12.57, DECEMBER).highest;
    assertClose(summer, 90 - (55.68 - TILT), 0.2, 'Copenhagen, June');
    assertClose(winter, 90 - (55.68 + TILT), 0.2, 'Copenhagen, December');
    assertClose(summer - winter, 2 * TILT, 0.3, 'the span between solstices');
  });

  test('the hemispheres mirror at an equinox, which is what pins the latitude sign', () => {
    assertClose(overDay(45, 0, MARCH_EQUINOX).highest, 45, 0.3, 'latitude 45 north');
    assertClose(overDay(-45, 0, MARCH_EQUINOX).highest, 45, 0.3, 'latitude 45 south');
  });
});

describe('solarElevation - the arctic cases the ramp has to survive', () => {
  test('midnight sun: above the arctic circle in June the sun never sets', () => {
    assert.ok(overDay(70, 0, JUNE).lowest > 0, 'expected the sun up all day at 70 north in June');
  });

  test('polar night: the same place in December never sees it rise', () => {
    assert.ok(
      overDay(70, 0, DECEMBER).highest < 0,
      'expected the sun down all day at 70 north in December',
    );
  });

  test('acos is clamped, so a pole never yields NaN', () => {
    // The two terms can sum to a shade over 1 at a pole, and acos of that is
    // NaN, which reaches a lamp as no write at all rather than as an error.
    for (const latitude of [90, -90, 89.999999]) {
      for (let hour = 0; hour < 24; hour += 1) {
        const elevation = solarElevation(latitude, 0, JUNE + hour * HOUR);
        assert.ok(Number.isFinite(elevation), `NaN at latitude ${latitude}, hour ${hour}`);
      }
    }
  });
});

describe('solarElevation - longitude and time', () => {
  test('15 degrees east is exactly one hour earlier', () => {
    assertClose(
      solarElevation(50, 15, JUNE + 11 * HOUR),
      solarElevation(50, 0, JUNE + 12 * HOUR),
      0.01,
      '15 degrees of longitude',
    );
  });

  test('the day runs up and back down, with one peak', () => {
    // One maximum, not two: an hour angle wrapped on the wrong side of midnight
    // gives a day with a notch in the middle of it.
    const readings: number[] = [];
    for (let minute = 0; minute < 1440; minute += 10) {
      readings.push(solarElevation(55.68, 12.57, JUNE + minute * MINUTE));
    }
    let turns = 0;
    for (let i = 1; i < readings.length - 1; i += 1) {
      if ((readings[i] > readings[i - 1]) !== (readings[i + 1] > readings[i])) turns += 1;
    }
    // One peak and one trough over a UTC day, and the trough may fall on the
    // boundary, so at most two turning points.
    assert.ok(turns <= 2, `expected a smooth day, found ${turns} turning points`);
  });

  test('the equation of time is applied, so solar noon is not clock noon', () => {
    // At longitude 0 in early November the real sun runs about 16 minutes ahead
    // of the clock. Were the term missing, the peak would land on 12:00 exactly.
    let peakMinute = 0;
    let peak = -Infinity;
    for (let minute = 0; minute < 1440; minute += 1) {
      const elevation = solarElevation(51.5, 0, Date.UTC(2026, 10, 3) + minute * MINUTE);
      if (elevation > peak) {
        peak = elevation;
        peakMinute = minute;
      }
    }
    assert.ok(
      Math.abs(peakMinute - 720) > 10,
      `expected solar noon well off 12:00, found it at minute ${peakMinute}`,
    );
    assert.ok(
      Math.abs(peakMinute - 720) < 20,
      `expected solar noon within 20 minutes of 12:00, found it at minute ${peakMinute}`,
    );
  });

  test('a non-finite instant does not throw', () => {
    // The clock is an injected seam, and a test double handing back NaN must not
    // take a runtime down inside a tick.
    assert.ok(!Number.isFinite(solarElevation(55, 12, Number.NaN)));
  });
});
