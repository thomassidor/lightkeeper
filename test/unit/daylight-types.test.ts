import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RESPONSE, MAX_SENSORS, MIN_LUX,
  sanitiseResponse, usableLocation,
} from '../../lib/daylight/daylight-types';
import { MINIMUM_BRIGHTNESS } from '../../lib/outputs/light-intent';
import {
  CURRENT_DAYLIGHT_SCHEMA_VERSION, migrateDaylightPlan,
} from '../../lib/daylight/daylight-migrations';

/**
 * Everything a daylight card sends is untrusted: it arrives from a webview over
 * the pairing channel, and it lands in four different device stores.
 *
 * This sanitiser CORRECTS per field and names what it corrected, where
 * sanitiseCurve() drops rows instead. Both policies are right for what they
 * guard, and the reason is worth asserting rather than only commenting: a
 * malformed curve point is a point the user asked for and cannot have, so
 * dropping it and saying so is honest - whereas a malformed brightLux has one
 * obvious right answer, and refusing the whole response would throw away four
 * good fields with it.
 *
 * The two ends are the interesting case. Every other stored brightness in this
 * app reads 0 as "leave brightness alone", because it has that alternative. An
 * end of a daylight response has none - it is asked for a number on every tick -
 * so 0 is lifted to MINIMUM_BRIGHTNESS rather than treated as unset, and the
 * safety property that a positive brightness is never written as darkness holds
 * here through a different mechanism from everywhere else.
 */

const VALID = { sensors: ['a', 'b'], darkLux: 8, brightLux: 400, dark: 0.8, bright: 0.3 };

describe('sanitiseResponse - a valid response survives untouched', () => {
  test('every field is kept and nothing is reported', () => {
    const { response, corrected } = sanitiseResponse(VALID);
    assert.deepEqual(response, VALID);
    assert.deepEqual(corrected, []);
  });

  test('no sensors at all is valid, because the sun is a complete answer', () => {
    const { response, corrected } = sanitiseResponse({ ...VALID, sensors: [] });
    assert.deepEqual(response.sensors, []);
    assert.deepEqual(corrected, []);
  });

  test('the two ends may be either way round, and neither is corrected', () => {
    const { corrected } = sanitiseResponse({ ...VALID, dark: 0.25, bright: 0.9 });
    assert.deepEqual(corrected, []);
  });
});

describe('sanitiseResponse - the sensor list', () => {
  test('a non-list is replaced and reported', () => {
    const { response, corrected } = sanitiseResponse({ ...VALID, sensors: 'sensor-a' });
    assert.deepEqual(response.sensors, []);
    assert.ok(corrected.includes('sensors'));
  });

  test('an absent list is not a correction, only an empty one', () => {
    const { response, corrected } = sanitiseResponse({ ...VALID, sensors: undefined });
    assert.deepEqual(response.sensors, []);
    assert.deepEqual(corrected, []);
  });

  test('blanks and non-strings are dropped and reported', () => {
    const { response, corrected } = sanitiseResponse({
      ...VALID, sensors: ['a', '', '  ', 7, null, 'b'],
    });
    assert.deepEqual(response.sensors, ['a', 'b']);
    assert.ok(corrected.includes('sensors'));
  });

  test('ids are trimmed, because a webview sends what a user pasted', () => {
    const { response } = sanitiseResponse({ ...VALID, sensors: ['  a  '] });
    assert.deepEqual(response.sensors, ['a']);
  });

  test('a sensor named twice is kept once', () => {
    // Twice in the list is twice in the mean, which is a weighting nobody asked
    // for and that no screen would show.
    const { response, corrected } = sanitiseResponse({ ...VALID, sensors: ['a', 'a', 'b'] });
    assert.deepEqual(response.sensors, ['a', 'b']);
    assert.ok(corrected.includes('sensors'));
  });

  test('the list is capped, and the cap is reported rather than silent', () => {
    const many = Array.from({ length: MAX_SENSORS + 4 }, (_, i) => `s${i}`);
    const { response, corrected } = sanitiseResponse({ ...VALID, sensors: many });
    assert.equal(response.sensors.length, MAX_SENSORS);
    assert.ok(corrected.includes('sensors'));
  });
});

describe('sanitiseResponse - the lux span', () => {
  test('an unreadable end falls back to the default and is reported', () => {
    const { response, corrected } = sanitiseResponse({ ...VALID, darkLux: 'soon' });
    assert.equal(response.darkLux, DEFAULT_RESPONSE.darkLux);
    assert.ok(corrected.includes('darkLux'));
  });

  test('lux is clamped into a range a sensor could plausibly report', () => {
    const { response } = sanitiseResponse({ ...VALID, darkLux: -40, brightLux: 5_000_000 });
    assert.equal(response.darkLux, MIN_LUX);
    assert.equal(response.brightLux, 100_000);
  });

  test('a zero-width span is refused, both ends reset, and it is reported', () => {
    // The failure this exists for: darkLux === brightLux is a division by zero
    // dressed up as a preference, and levelFromLux would hand a NaN level to
    // brightnessFor and a NaN dim value to a lamp - a light told nothing at all.
    const { response, corrected } = sanitiseResponse({ ...VALID, darkLux: 100, brightLux: 100 });
    assert.equal(response.darkLux, DEFAULT_RESPONSE.darkLux);
    assert.equal(response.brightLux, DEFAULT_RESPONSE.brightLux);
    assert.ok(corrected.includes('brightLux'));
  });

  test('an inverted span is refused the same way', () => {
    const { response, corrected } = sanitiseResponse({ ...VALID, darkLux: 900, brightLux: 20 });
    assert.equal(response.darkLux, DEFAULT_RESPONSE.darkLux);
    assert.equal(response.brightLux, DEFAULT_RESPONSE.brightLux);
    assert.ok(corrected.includes('brightLux'));
  });

  test('clamping cannot produce an inverted span it then keeps', () => {
    // Both ends land on MIN_LUX after clamping, so the span check has to run
    // AFTER the clamp rather than before it.
    const { response } = sanitiseResponse({ ...VALID, darkLux: -1, brightLux: -2 });
    assert.ok(response.brightLux > response.darkLux);
  });
});

describe('sanitiseResponse - the two ends', () => {
  test('an unreadable end falls back and is reported', () => {
    const { response, corrected } = sanitiseResponse({ ...VALID, bright: 'half' });
    assert.equal(response.bright, DEFAULT_RESPONSE.bright);
    assert.ok(corrected.includes('bright'));
  });

  test('zero is lifted to the floor, NOT treated as unset', () => {
    // The policy difference from every other stored brightness, and the reason
    // it exists: there is no "leave it alone" for a response end, so 0 would be
    // a positive request written as darkness.
    const { response, corrected } = sanitiseResponse({ ...VALID, dark: 0 });
    assert.equal(response.dark, MINIMUM_BRIGHTNESS);
    assert.ok(corrected.includes('dark'));
  });

  test('anything under the floor is lifted to it', () => {
    const { response } = sanitiseResponse({ ...VALID, dark: 0.04, bright: 0.09 });
    assert.equal(response.dark, MINIMUM_BRIGHTNESS);
    assert.equal(response.bright, MINIMUM_BRIGHTNESS);
  });

  test('a slider reporting a shade over 1 is a slider at maximum', () => {
    const { response } = sanitiseResponse({ ...VALID, dark: 1.0000001 });
    assert.equal(response.dark, 1);
  });

  test('a completely empty payload yields the defaults, all reported', () => {
    const { response, corrected } = sanitiseResponse(undefined);
    assert.deepEqual(response, DEFAULT_RESPONSE);
    assert.deepEqual(corrected.sort(), ['bright', 'brightLux', 'dark', 'darkLux']);
  });
});

describe('usableLocation', () => {
  test('a real latitude and longitude comes back', () => {
    assert.deepEqual(usableLocation({ latitude: 55.68, longitude: 12.57 }), {
      latitude: 55.68, longitude: 12.57,
    });
  });

  test('numeric strings are accepted, because homey-api boundaries are loose', () => {
    assert.deepEqual(usableLocation({ latitude: '55.68', longitude: '12.57' }), {
      latitude: 55.68, longitude: 12.57,
    });
  });

  test('0, 0 is refused, and that is the whole point of this function', () => {
    // It is a real place - the Gulf of Guinea - and it is also what an unset
    // field reads as. On a Homey in somebody's house the second is
    // overwhelmingly more likely, and the cost of guessing wrong is a confident
    // sun elevation for a point in the ocean dimming a room in Denmark by it.
    // Reporting that we do not know is what falls back to the user's own value.
    assert.equal(usableLocation({ latitude: 0, longitude: 0 }), null);
  });

  test('but a zero on ONE axis is a real place and is kept', () => {
    assert.deepEqual(usableLocation({ latitude: 51.48, longitude: 0 }), {
      latitude: 51.48, longitude: 0,
    });
    assert.deepEqual(usableLocation({ latitude: 0, longitude: -78.5 }), {
      latitude: 0, longitude: -78.5,
    });
  });

  test('out of range is refused rather than clamped', () => {
    // Clamping a latitude of 400 to 90 would answer for the north pole. There is
    // no plausible reading behind that number, so there is nothing to salvage.
    assert.equal(usableLocation({ latitude: 400, longitude: 12 }), null);
    assert.equal(usableLocation({ latitude: -91, longitude: 12 }), null);
    assert.equal(usableLocation({ latitude: 55, longitude: 181 }), null);
  });

  test('a null on ONE axis is refused, not read as the equator', () => {
    // `Number(null)` is 0, so a bare coercion would turn a latitude that was
    // never set into the equator - and with a real longitude beside it the 0,0
    // refusal below never fires. A Danish living room dimmed by the sun off the
    // coast of Ghana is the failure this guard exists for.
    assert.equal(usableLocation({ latitude: null, longitude: 12.57 }), null);
    assert.equal(usableLocation({ latitude: 55.68, longitude: null }), null);
    assert.equal(usableLocation({ latitude: '', longitude: 12.57 }), null);
    assert.equal(usableLocation({ latitude: true, longitude: 12.57 }), null);
    assert.equal(usableLocation({ latitude: [], longitude: 12.57 }), null);
  });

  test('a missing, malformed or non-finite location is refused', () => {
    // getLatitude() throws without the permission, and the app.ts closure hands
    // back null; these are the shapes that arrive when it does not throw but has
    // nothing either.
    assert.equal(usableLocation(null), null);
    assert.equal(usableLocation(undefined), null);
    assert.equal(usableLocation('55.68,12.57'), null);
    assert.equal(usableLocation({}), null);
    assert.equal(usableLocation({ latitude: Number.NaN, longitude: 12 }), null);
    assert.equal(usableLocation({ latitude: 55, longitude: Number.POSITIVE_INFINITY }), null);
  });
});

describe('the daylight migration chain', () => {
  const TARGET = { kind: 'devices', deviceIds: ['l1'] };

  test('a plan with no schemaVersion is brought forward with safe defaults', () => {
    const { plan, migrated, fromVersion } = migrateDaylightPlan({ target: TARGET });

    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(plan.schemaVersion, CURRENT_DAYLIGHT_SCHEMA_VERSION);
    assert.equal(plan.enabled, true);
    assert.deepEqual(plan.response, DEFAULT_RESPONSE);
  });

  test('a PARTIAL response keeps the half that survived', () => {
    // The case this step exists for. Spreading DEFAULT_RESPONSE over the whole
    // thing would be shorter and would throw away the fields a partial write
    // did land, which is the one thing a migration must not do.
    const { plan } = migrateDaylightPlan({
      target: TARGET,
      response: { sensors: ['s1'], dark: 0.7 },
    });

    assert.deepEqual(plan.response.sensors, ['s1']);
    assert.equal(plan.response.dark, 0.7);
    assert.equal(plan.response.brightLux, DEFAULT_RESPONSE.brightLux);
  });

  test('a response that is not an object is replaced rather than crashing', () => {
    // A step runs BEFORE the chain's validator, so the stored shape has not been
    // checked yet and may be anything at all.
    for (const rubbish of [null, 'response', 42, [], true]) {
      const { plan } = migrateDaylightPlan({ target: TARGET, response: rubbish });
      assert.deepEqual(plan.response, DEFAULT_RESPONSE, `failed on ${JSON.stringify(rubbish)}`);
    }
  });

  test('a plan already at the current version is not migrated', () => {
    const stored = {
      schemaVersion: CURRENT_DAYLIGHT_SCHEMA_VERSION,
      enabled: false,
      target: TARGET,
      response: { sensors: ['s1'], darkLux: 8, brightLux: 400, dark: 0.8, bright: 0.3 },
    };
    const { plan, migrated } = migrateDaylightPlan(stored);

    assert.equal(migrated, false);
    assert.deepEqual(plan, stored);
  });

  test('a plan from a NEWER build is refused rather than downgraded', () => {
    // Guessing at a shape a later version invented is how a device comes back
    // from a downgrade holding a plan that half works.
    assert.throws(() => migrateDaylightPlan({
      schemaVersion: CURRENT_DAYLIGHT_SCHEMA_VERSION + 1,
      enabled: true,
      target: TARGET,
      response: DEFAULT_RESPONSE,
    }));
  });

  test('the chain ends in the validator, so a bad plan is quarantined not cast', () => {
    // What every one of the five chains has in common, and the reason none of
    // them ends in a cast: DeviceLifecycle turns this throw into
    // state.invalidConfiguration rather than letting the runtime read it.
    assert.throws(() => migrateDaylightPlan({
      schemaVersion: CURRENT_DAYLIGHT_SCHEMA_VERSION,
      enabled: true,
      target: TARGET,
      response: { sensors: [], darkLux: 500, brightLux: 5, dark: 0.9, bright: 0.25 },
    }), /brightLux is not above darkLux/);
  });
});
