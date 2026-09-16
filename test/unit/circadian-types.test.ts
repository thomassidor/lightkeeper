import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_POINTS, MIN_POINTS, sanitiseCurve,
} from '../../lib/circadian/circadian-types';
import {
  migrateCircadianPlan, CURRENT_CIRCADIAN_SCHEMA_VERSION,
} from '../../lib/circadian/circadian-migrations';
import {
  DEFAULT_ZONES, MAX_OFFSET, ZONE_RAMP,
  expandSimplePlan, foldBackSimplePlan, resolveBoundaries, sanitiseZones, zonePoints,
} from '../../lib/circadian/simple-curve';
import { valueAt } from '../../lib/circadian/circadian-curve';

/**
 * Everything the curve screen sends arrives from a webview and is therefore
 * untrusted, exactly like a generated Flow's arguments. The rule is the same one
 * sanitiseEntries() follows: DROP an invalid row and say why, never repair it
 * into something the user did not ask for — a half-filled row must not become a
 * point that holds a room at 0% warmth all evening.
 */

const clock = (at: number, warmth: number, extra: Record<string, unknown> = {}) =>
  ({ id: `p${at}`, anchor: { kind: 'clock', at }, warmth, ...extra });

describe('sanitiseCurve', () => {
  test('accepts a well-formed curve and sorts it into day order', () => {
    const result = sanitiseCurve([clock(1080, 1), clock(360, 0.2)]);
    assert.deepEqual(result.points.map(p => p.warmth), [0.2, 1]);
    assert.deepEqual(result.dropped, []);
  });

  test("accepts the screen's 'HH:MM' shorthand as an anchor", () => {
    // The whole UI is built on a time string; making it know about the anchor
    // union would be coupling for its own sake.
    const result = sanitiseCurve([{ at: '06:30', warmth: 0.9 }, { at: '21:00', warmth: 1 }]);
    assert.deepEqual(result.points.map(p => p.anchor), [
      { kind: 'clock', at: 390 },
      { kind: 'clock', at: 1260 },
    ]);
  });

  test('drops a point with no usable time, and names it', () => {
    const result = sanitiseCurve([clock(360, 0.2), { at: 'half seven', warmth: 1 }, clock(1080, 1)]);
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.dropped, [{ index: 1, reason: 'the time is not a time of day' }]);
  });

  test('drops a point with no warmth rather than choosing one', () => {
    const result = sanitiseCurve([
      clock(360, 0.2), { anchor: { kind: 'clock', at: 780 } }, clock(1080, 1),
    ]);
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.dropped, [
      { index: 1, reason: 'the warmth is not a number between 0 and 1' },
    ]);
  });

  /**
   * A sun anchor is refused, and this test replaces one that asserted the
   * opposite.
   *
   * The old one read "accepts a sun anchor, now that one can be resolved", on
   * the belief that the circadian light's sun-following had made point anchors
   * resolvable. It had not: the zones carry sun-anchored BOUNDARIES, and
   * `zonePoints()` emits CLOCK anchors from them. A Colour Curve Light's stored
   * points go to `valueAt()` with no `AnchorContext` at all, so a sun-anchored
   * point threw out of `resolveAnchor()` on every tick — the device silently
   * stopped writing, and `getStatus` took the whole settings page down with it.
   *
   * Both `CircadianAnchor`'s docblock and `resolveAnchor`'s already claimed this
   * refusal. Now it exists.
   */
  test('refuses a sun anchor, because nothing can resolve one for a point', () => {
    const result = sanitiseCurve([
      { anchor: { kind: 'sun', event: 'sunset', offset: -30 }, warmth: 1 },
      clock(360, 0.2),
      clock(1080, 1),
    ]);
    assert.equal(result.points.length, 2);
    assert.ok(result.points.every(point => point.anchor.kind === 'clock'));
    assert.deepEqual(result.dropped, [
      { index: 0, reason: 'a point cannot follow the sun yet' },
    ]);
  });

  test('a well-formed sun anchor is refused for the same reason as a malformed one', () => {
    // The shape no longer matters, so the reason no longer varies with it: the
    // point is dropped because the ANCHOR KIND has nothing to resolve against,
    // not because the event or the offset was wrong.
    const result = sanitiseCurve([
      { anchor: { kind: 'sun', event: 'moonrise', offset: 0 }, warmth: 1 },
      { anchor: { kind: 'sun', event: 'sunset', offset: 'soon' }, warmth: 1 },
      clock(360, 0.2),
      clock(1080, 1),
    ]);
    assert.equal(result.points.length, 2);
    assert.deepEqual(result.dropped.map(d => d.reason), [
      'a point cannot follow the sun yet',
      'a point cannot follow the sun yet',
    ]);
  });

  test('drops a second point at the same minute', () => {
    // Two anchors on one minute is a zero-length segment: a division by zero
    // dressed up as a user preference.
    const result = sanitiseCurve([clock(360, 0.2), { at: '06:00', warmth: 0.9 }, clock(1080, 1)]);
    assert.equal(result.points.length, 2);
    assert.match(result.dropped[0].reason, /already at 06:00/);
  });

  test('caps the curve and says what it refused', () => {
    const many = Array.from({ length: MAX_POINTS + 3 }, (_, i) => clock(i * 60, i / 20));
    const result = sanitiseCurve(many);
    assert.equal(result.points.length, MAX_POINTS);
    assert.equal(result.dropped.length, 3);
    assert.match(result.dropped[0].reason, /over the limit/);
  });

  test('a curve of one point is dropped entirely', () => {
    // Kept, it would read as configured on every screen and hold the lights at
    // one colour for ever.
    const result = sanitiseCurve([clock(360, 0.2)]);
    assert.deepEqual(result.points, []);
    assert.match(result.dropped[0].reason, new RegExp(`at least ${MIN_POINTS}`));
  });

  test('nothing in, nothing out — and no complaint about a curve nobody wrote', () => {
    assert.deepEqual(sanitiseCurve([]), { points: [], adjustBrightness: false, dropped: [] });
    assert.deepEqual(sanitiseCurve(null).points, []);
  });

  test('warmth is clamped rather than dropped', () => {
    const result = sanitiseCurve([clock(360, 4), clock(1080, -1)]);
    assert.deepEqual(result.points.map(p => p.warmth), [1, 0]);
  });

  test('brightness of zero is treated as unset, not as darkness', () => {
    const result = sanitiseCurve([clock(360, 0.2, { brightness: 0 }), clock(1080, 1)]);
    assert.equal(result.points[0].brightness, undefined);
  });

  test('adjustBrightness survives only when every point carries a brightness', () => {
    const partial = sanitiseCurve(
      [clock(360, 0.2, { brightness: 0.4 }), clock(1080, 1)], true,
    );
    assert.equal(partial.adjustBrightness, false, 'a half-dimmed curve would have to be invented');

    const full = sanitiseCurve(
      [clock(360, 0.2, { brightness: 0.4 }), clock(1080, 1, { brightness: 0.9 })], true,
    );
    assert.equal(full.adjustBrightness, true);
  });

  test('duplicate ids are dropped, so a point cannot shadow another', () => {
    const result = sanitiseCurve([
      { id: 'same', at: '06:00', warmth: 0.2 },
      { id: 'same', at: '18:00', warmth: 1 },
    ]);
    assert.equal(result.points.length, 0, 'one survivor is below the minimum, so the curve goes');
    assert.match(result.dropped[0].reason, /duplicate point id/);
  });
});

/**
 * The circadian light stores three zones and two sun-anchored boundaries.
 *
 * It used to store two ends of the day and take a fixed four-point shape at
 * 06:00, 11:00, 15:00 and 21:00. Two things were wrong with that. A fixed 21:00
 * is an hour after sunset in December and two hours before it in June, so the
 * "evening" somebody set arrives at the wrong time for most of the year. And
 * "warmest" was one value the day passed through TWICE — once before the morning
 * and once after the evening — which no single control could honestly draw.
 */
describe('the three zones', () => {
  const CONTEXT = { sunriseMinute: 6 * 60 + 30, sunsetMinute: 20 * 60 };

  test('a boundary follows the sun, plus the offset stored against it', () => {
    const { morningEndMinute, eveningStartMinute, fromSun } = resolveBoundaries(
      { ...DEFAULT_ZONES, morningEnd: 30, eveningStart: -60 }, CONTEXT,
    );
    assert.equal(morningEndMinute, 7 * 60, 'sunrise 06:30 plus half an hour');
    assert.equal(eveningStartMinute, 19 * 60, 'sunset 20:00 less an hour');
    assert.equal(fromSun, true);
  });

  test('with no sun at all it falls back to fixed hours, and says so', () => {
    // Two cases reach this and both are real: a Homey that has never been told
    // where it is, and a polar day with no sunrise to anchor to for weeks.
    // Neither is a reason to stop running.
    const { morningEndMinute, eveningStartMinute, fromSun } = resolveBoundaries(
      { ...DEFAULT_ZONES, morningEnd: 0, eveningStart: 0 }, {},
    );
    assert.equal(morningEndMinute, 6 * 60);
    assert.equal(eveningStartMinute, 21 * 60);
    assert.equal(fromSun, false);
  });

  test('the boundaries cannot trade places on a short winter day', () => {
    // THE reason this is a function rather than two additions. North of about
    // 60° the shortest day is under six hours, so a morning pushed late and an
    // evening pulled early cross over — and a crossed pair does not fail, it
    // silently produces a day that runs midday, morning, evening, midday.
    const { morningEndMinute, eveningStartMinute } = resolveBoundaries(
      { ...DEFAULT_ZONES, morningEnd: MAX_OFFSET, eveningStart: -MAX_OFFSET },
      { sunriseMinute: 10 * 60, sunsetMinute: 14 * 60 },
    );
    assert.ok(
      eveningStartMinute > morningEndMinute,
      `evening ${eveningStartMinute} must stay after morning ${morningEndMinute}`,
    );
    assert.ok(
      eveningStartMinute - morningEndMinute > 2 * ZONE_RAMP,
      'and with room for both ramps, or the middle zone never holds',
    );
  });

  test('six points: three zones held flat, and three ramps between them', () => {
    const points = zonePoints(
      { ...DEFAULT_ZONES, morningEnd: 30, eveningStart: -60 }, CONTEXT,
    );
    assert.equal(points.length, 6);

    const at = (id: string) => points.find(point => point.id === id)!;
    assert.equal(at('morning-hold').anchor.kind, 'clock');
    assert.deepEqual(
      points.map(point => (point.anchor.kind === 'clock' ? point.anchor.at : -1)),
      [ZONE_RAMP, 7 * 60 - ZONE_RAMP, 7 * 60 + ZONE_RAMP,
        19 * 60 - ZONE_RAMP, 19 * 60 + ZONE_RAMP, 24 * 60 - ZONE_RAMP],
    );

    // Each zone is held at its own temperature at both of its own points.
    assert.equal(at('night-end').warmth, DEFAULT_ZONES.morning.temperature);
    assert.equal(at('morning-hold').warmth, DEFAULT_ZONES.morning.temperature);
    assert.equal(at('midday-start').warmth, DEFAULT_ZONES.midday.temperature);
    assert.equal(at('midday-hold').warmth, DEFAULT_ZONES.midday.temperature);
    assert.equal(at('evening-start').warmth, DEFAULT_ZONES.evening.temperature);
    assert.equal(at('night-start').warmth, DEFAULT_ZONES.evening.temperature);
  });

  test('the night ramps across midnight rather than stepping at it', () => {
    // Not in the design canvas, and deliberate: the canvas reads morning from
    // midnight and evening up to it, which became a step change the moment the
    // two stopped being the same value. Interpolation is cyclic, so a ramp
    // across midnight is the same rule applied a third time.
    const zones = {
      ...DEFAULT_ZONES,
      morning: { temperature: 0.2 },
      evening: { temperature: 0.9 },
    };
    const points = zonePoints(zones, CONTEXT);

    const justBefore = valueAt(points, 24 * 60 - 1).warmth;
    const justAfter = valueAt(points, 1).warmth;
    assert.ok(
      Math.abs(justBefore - justAfter) < 0.05,
      `midnight must not jump: ${justBefore} then ${justAfter}`,
    );

    // And both ends are still genuinely held well away from it.
    assert.equal(valueAt(points, 22 * 60).warmth, 0.9);
    assert.equal(valueAt(points, 4 * 60).warmth, 0.2);
  });

  test('brightness is all-or-nothing across the expansion', () => {
    const withOne = zonePoints(
      { ...DEFAULT_ZONES, midday: { temperature: 0.2 } }, CONTEXT, true,
    );
    assert.ok(
      withOne.every(point => point.brightness === undefined),
      'two thirds of a brightness curve would have to invent the rest',
    );

    const withAll = zonePoints(DEFAULT_ZONES, CONTEXT, true);
    assert.ok(withAll.every(point => point.brightness !== undefined));

    const optedOut = zonePoints(DEFAULT_ZONES, CONTEXT, false);
    assert.ok(optedOut.every(point => point.brightness === undefined));
  });

  test('the shape is derived, never stored', () => {
    // `expandSimplePlan` snapshots the points against the FALLBACK hours and
    // keeps the zones beside them; the runtime re-derives from the zones on
    // every tick against the day's real sunrise. Storing the snapshot alone
    // would freeze the boundaries at whatever the sun was doing at registration.
    const plan = {
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices' as const, deviceIds: ['l1'] },
      zones: DEFAULT_ZONES,
      adjustBrightness: false,
      preStage: false,
    };
    const expanded = expandSimplePlan(plan);

    assert.deepEqual(expanded.zones, DEFAULT_ZONES);
    assert.equal(expanded.points.length, 6);
    assert.equal(
      (expanded.points[1]!.anchor as { at: number }).at,
      6 * 60 + DEFAULT_ZONES.morningEnd - ZONE_RAMP,
      'the snapshot uses the fallback sunrise, plus the stored offset',
    );
  });

  test('the fold-back folds onto the plan given, not onto some earlier one', () => {
    // A repair applies the NEW plan and then persists; folding onto whatever the
    // store held would write back the plan the user had just replaced.
    const edited = {
      schemaVersion: 1,
      enabled: true,
      target: { kind: 'devices' as const, deviceIds: ['l1'] },
      zones: { ...DEFAULT_ZONES, morningEnd: 90 },
      adjustBrightness: true,
      preStage: true,
    };
    const folded = foldBackSimplePlan(edited, { enabled: false, preStage: false });

    assert.equal(folded.zones.morningEnd, 90, 'the edit survives');
    assert.equal(folded.adjustBrightness, true);
    assert.equal(folded.enabled, false, 'and the two runtime fields come back');
    assert.equal(folded.preStage, false);
  });
});

describe('sanitiseZones — a screen sending nonsense falls back per FIELD', () => {
  test('nothing droppable: three zones are not a list', () => {
    const { zones, corrected } = sanitiseZones({});
    assert.deepEqual(zones, DEFAULT_ZONES);
    assert.ok(corrected.includes('morning temperature'));
    assert.ok(corrected.includes('evening temperature'));
  });

  test('a good zone survives beside a bad one', () => {
    const { zones, corrected } = sanitiseZones({
      morning: { temperature: 0.4, brightness: 0.5 },
      midday: { temperature: 'cool' },
      evening: { temperature: 0.95 },
      morningEnd: 45,
      eveningStart: -30,
    });

    assert.equal(zones.morning.temperature, 0.4);
    assert.equal(zones.midday.temperature, DEFAULT_ZONES.midday.temperature);
    assert.equal(zones.evening.temperature, 0.95);
    assert.deepEqual(corrected, ['midday temperature']);
  });

  test('an offset is snapped to the step and clamped, and says so', () => {
    // The screen steps in quarter hours, so a stored 37 could only come from a
    // hand-edited store or a scripted pair session — and "sunset −37m" on a
    // screen whose every control moves in fifteens reads as a bug in the screen.
    const { zones, corrected } = sanitiseZones({
      ...DEFAULT_ZONES, morningEnd: 37, eveningStart: -9000,
    });
    assert.equal(zones.morningEnd, 30);
    assert.equal(zones.eveningStart, -MAX_OFFSET);
    assert.ok(corrected.includes('morningEnd'));
    assert.ok(corrected.includes('eveningStart'));
  });

  test('adjustBrightness is checked here, never trusted from the screen', () => {
    const { adjustBrightness } = sanitiseZones({ ...DEFAULT_ZONES, adjustBrightness: true });
    assert.equal(adjustBrightness, true, 'every default zone carries a brightness');

    const off = sanitiseZones({ ...DEFAULT_ZONES, adjustBrightness: 'yes' });
    assert.equal(off.adjustBrightness, false, 'anything but a real true is a no');
  });
});

describe('the circadian chain, after the reset', () => {
  /**
   * Emptied with the other four. There is no honest step from two ends of the
   * day to three zones: two temperatures cannot say what the morning and the
   * evening should each look like, and inventing the third from the other two
   * would produce an evening nobody chose — on the device whose whole job is the
   * colour of somebody's evening.
   */
  const CURRENT = {
    schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1'] },
    zones: DEFAULT_ZONES,
    adjustBrightness: false,
    preStage: false,
  };

  test('a current plan passes through untouched', () => {
    const { plan, migrated, steps } = migrateCircadianPlan(CURRENT);
    assert.equal(migrated, false);
    assert.deepEqual(steps, []);
    assert.deepEqual(plan, CURRENT as never);
  });

  test('a plan from before the reset is quarantined, not guessed at', () => {
    // Including a version-less one: version 0 has no step either. DeviceLifecycle
    // turns the throw into an unavailable device with a reason, which is the
    // "delete it and add it again" signal.
    assert.throws(() => migrateCircadianPlan({ ...CURRENT, schemaVersion: undefined }));
    assert.throws(() => migrateCircadianPlan({ ...CURRENT, schemaVersion: 0 }));
    assert.throws(() => migrateCircadianPlan({
      schemaVersion: 4,
      enabled: true,
      target: { kind: 'devices', deviceIds: ['l1'] },
      warmest: { temperature: 1, brightness: 0.6 },
      coolest: { temperature: 0.15, brightness: 0.9 },
      adjustBrightness: false,
      preStage: false,
    }));
  });

  test('a plan from a NEWER build is refused rather than downgraded', () => {
    assert.throws(() => migrateCircadianPlan({
      ...CURRENT, schemaVersion: CURRENT_CIRCADIAN_SCHEMA_VERSION + 1,
    }));
  });

  test('pre-staging is never enabled by anything but a real true', () => {
    // Lights coming on by themselves at night is a far worse failure than a
    // half-second of the wrong white, so this stays opt-in at every seam.
    for (const notTrue of ['true', 1, {}, undefined]) {
      const { plan } = migrateCircadianPlan({ ...CURRENT, preStage: notTrue });
      assert.equal(plan.preStage, false, `on ${JSON.stringify(notTrue)}`);
    }
  });

  test('the chain still ends in its validator', () => {
    assert.throws(() => migrateCircadianPlan({
      ...CURRENT,
      zones: { ...DEFAULT_ZONES, midday: { temperature: 4 } },
    }));
    assert.throws(() => migrateCircadianPlan('not a plan'));
  });
});
