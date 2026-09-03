import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PALETTE, mixColors, paletteColor, isPaletteColor } from '../../lib/circadian/palette';
import { valueAt, resolvePoints } from '../../lib/circadian/circadian-curve';
import { sanitiseCurve, type CircadianPoint } from '../../lib/circadian/circadian-types';
import { migrateCurvePlan, CURRENT_CURVE_SCHEMA_VERSION } from '../../lib/circadian/curve-migrations';
import { planIntent } from '../../lib/outputs/intent-planner';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';

/**
 * A curve point may be a COLOUR instead of a colour temperature.
 *
 * Two decisions carry the whole feature, and both are about not inventing
 * anything:
 *
 *  - **The palette is closed.** Hue and saturation are a two-dimensional choice
 *    with one good answer per intent, most of the plane is a bad idea in a living
 *    room, and a name survives being read back a year later where a coordinate
 *    does not.
 *  - **A colour is never blended with a colour temperature.** A segment with a
 *    colour at only one end HOLDS that colour. Fading "amber" into "4000 K" means
 *    inventing a shade nobody chose — the same argument platform §12 makes about
 *    brightness.
 */

const point = (over: Partial<CircadianPoint> & { at: number }): CircadianPoint => ({
  id: `p${over.at}`,
  anchor: { kind: 'clock', at: over.at },
  warmth: over.warmth ?? 0.5,
  ...(over.brightness !== undefined ? { brightness: over.brightness } : {}),
  ...(over.color !== undefined ? { color: over.color } : {}),
});

describe('the palette', () => {
  test('every colour has a stable id, a locale key and both axes', () => {
    for (const colour of PALETTE) {
      assert.match(colour.id, /^[a-z]+$/, colour.id);
      assert.match(colour.labelKey, /^palette\.[a-z]+$/, colour.id);
      assert.ok(colour.hue >= 0 && colour.hue <= 1, `${colour.id} hue`);
      assert.ok(colour.saturation >= 0 && colour.saturation <= 1, `${colour.id} saturation`);
    }
  });

  test('ids are unique, because a plan names one', () => {
    const ids = new Set(PALETTE.map(colour => colour.id));
    assert.equal(ids.size, PALETTE.length);
  });

  test('lookup and membership agree', () => {
    for (const colour of PALETTE) {
      assert.equal(paletteColor(colour.id), colour);
      assert.equal(isPaletteColor(colour.id), true);
    }
    assert.equal(paletteColor('chartreuse'), undefined);
    for (const nope of ['chartreuse', '', null, undefined, 7, {}]) {
      assert.equal(isPaletteColor(nope), false, JSON.stringify(nope));
    }
  });

  test('an adjacent pair still blends through the shades between them', () => {
    // Rose (0.96) to peach (0.04) goes through red, not backward through green —
    // which is the difference between a sunset and a mistake.
    //
    // It used to be the short arc round the wheel that guaranteed this. It is
    // now a straight line across the disc, and for a pair this close the two are
    // nearly the same line: what changed is the WIDE pairs, below.
    const rose = paletteColor('rose')!;
    const peach = paletteColor('peach')!;

    const half = mixColors(rose, peach, 0.5);
    assert.ok(half.hue > 0.98 || half.hue < 0.02, `${half.hue} should be near the wrap`);

    assert.equal(mixColors(rose, peach, 0).hue, rose.hue);
    assert.ok(Math.abs(mixColors(rose, peach, 1).hue - peach.hue) < 1e-9);
  });

  test('a blend never leaves the wheel', () => {
    for (const from of PALETTE) {
      for (const to of PALETTE) {
        for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
          const mixed = mixColors(from, to, fraction);
          assert.ok(mixed.hue >= 0 && mixed.hue < 1, `${from.id}->${to.id} @${fraction}: ${mixed.hue}`);
          assert.ok(mixed.saturation >= 0 && mixed.saturation <= 1, `${from.id}->${to.id}`);
        }
      }
    }
  });

  test('two shades of one hue blend along that hue', () => {
    // Same hue at two saturations sit on one ray from the middle, so the line
    // between them lies along it: the hue is held and the saturation is linear.
    const a = { id: 'a', labelKey: 'x', hue: 0.5, saturation: 0.2 };
    const b = { id: 'b', labelKey: 'y', hue: 0.5, saturation: 0.8 };
    const half = mixColors(a, b, 0.5);
    assert.ok(Math.abs(half.saturation - 0.5) < 1e-9);
    assert.ok(Math.abs(half.hue - 0.5) < 1e-9, 'and the hue does not wander');
  });
});

describe('a colour on the curve', () => {
  test('both ends coloured blends between them', () => {
    const points = [
      point({ at: 21 * 60, warmth: 1, color: 'amber' }),
      point({ at: 23 * 60, warmth: 1, color: 'ocean' }),
    ];
    const amber = paletteColor('amber')!;
    const ocean = paletteColor('ocean')!;

    // At the point itself, allowing for the eased blend's floating-point drift:
    // fraction 0 through `mix` is not bit-identical to the endpoint.
    const at = valueAt(points, 21 * 60).color!;
    assert.ok(Math.abs(at.hue - amber.hue) < 1e-9, `${at.hue}`);
    assert.ok(Math.abs(at.saturation - amber.saturation) < 1e-9, `${at.saturation}`);
    const middle = valueAt(points, 22 * 60).color!;
    assert.ok(middle.hue !== amber.hue && middle.hue !== ocean.hue, JSON.stringify(middle));
  });

  test('one end coloured HOLDS that colour across the whole segment', () => {
    // Not blended towards the temperature end: a colour temperature is a point on
    // a different axis, and fading between them invents a shade nobody chose.
    const points = [
      point({ at: 19 * 60, warmth: 0.4 }),
      point({ at: 21 * 60, warmth: 1, color: 'amber' }),
      point({ at: 23 * 60, warmth: 0.8 }),
    ];
    const amber = paletteColor('amber')!;

    for (const minute of [19 * 60, 20 * 60, 21 * 60, 22 * 60, 23 * 60 - 1]) {
      assert.deepEqual(
        valueAt(points, minute).color,
        { hue: amber.hue, saturation: amber.saturation },
        `${minute}`,
      );
    }
  });

  test('so ONE coloured point colours the two segments either side of it', () => {
    // Stated as a test because it is the consequence a user notices: "amber at
    // 21:00" is amber from 19:00 to 23:00, not an amber instant. A point is a
    // value the day passes THROUGH, and a colour cannot be passed through in one
    // minute without a step.
    const points = [
      point({ at: 6 * 60, warmth: 0.2 }),
      point({ at: 19 * 60, warmth: 0.4 }),
      point({ at: 21 * 60, warmth: 1, color: 'amber' }),
      point({ at: 23 * 60, warmth: 0.8 }),
    ];

    // Inside the two segments the coloured point touches:
    assert.ok(valueAt(points, 20 * 60).color, '19:00-21:00 is coloured');
    assert.ok(valueAt(points, 22 * 60).color, '21:00-23:00 is coloured');
    // And outside them:
    assert.equal(valueAt(points, 12 * 60).color, undefined, '06:00-19:00 is not');
  });

  test('neither end coloured leaves no colour at all', () => {
    const points = [point({ at: 6 * 60, warmth: 0.2 }), point({ at: 21 * 60, warmth: 1 })];
    assert.equal(valueAt(points, 12 * 60).color, undefined);
    assert.equal('color' in valueAt(points, 12 * 60), false);
  });

  test('warmth is always present, coloured or not', () => {
    // It is what a lamp with no colour capability is written to instead, and what
    // the neighbouring temperature segments interpolate towards — so the curve's
    // SHAPE does not depend on which lamps can do colour.
    const points = [
      point({ at: 21 * 60, warmth: 0.9, color: 'ember' }),
      point({ at: 23 * 60, warmth: 1, color: 'candle' }),
    ];
    const value = valueAt(points, 22 * 60);
    assert.ok(value.warmth > 0.9 && value.warmth < 1, `${value.warmth}`);
    assert.ok(value.color);
  });

  test('the midnight-spanning segment carries a colour too', () => {
    // Cyclic interpolation, the same property the warmth relies on.
    const points = [
      point({ at: 6 * 60, warmth: 0.2 }),
      point({ at: 23 * 60, warmth: 1, color: 'candle' }),
    ];
    assert.ok(valueAt(points, 2 * 60).color, '23:00 to 06:00 wraps through midnight');
  });

  test('a single-point curve still reports its colour', () => {
    // Reachable only through the ephemeral runtime the pairing screen drives with
    // half-filled input; the sanitiser refuses fewer than two points on a save.
    const points = [point({ at: 21 * 60, warmth: 1, color: 'rose' })];
    const rose = paletteColor('rose')!;
    assert.deepEqual(valueAt(points, 0).color, { hue: rose.hue, saturation: rose.saturation });
  });

  /**
   * A blended hue/saturation pair is no longer any palette entry, so a screen
   * that wants to SAY what the lights are doing cannot name it from `color`
   * alone. It used to report the warmth beside it instead — "Now at 36% warmth"
   * on a curve whose every point was a colour, a number those lamps are not
   * being sent.
   */
  test('a coloured segment names the palette colours it came from', () => {
    const points = [
      point({ at: 21 * 60, warmth: 1, color: 'amber' }),
      point({ at: 23 * 60, warmth: 1, color: 'rose' }),
    ];
    // Mid-segment the value is neither, so BOTH are named: pretending it is one
    // of them would be the same lie in a prettier form.
    assert.deepEqual(valueAt(points, 22 * 60).colorLabelKeys, ['palette.amber', 'palette.rose']);
  });

  test('a segment holding one colour flat names only that one', () => {
    const points = [
      point({ at: 19 * 60, warmth: 0.4 }),
      point({ at: 21 * 60, warmth: 1, color: 'amber' }),
      point({ at: 23 * 60, warmth: 0.8 }),
    ];
    for (const minute of [20 * 60, 22 * 60]) {
      assert.deepEqual(valueAt(points, minute).colorLabelKeys, ['palette.amber'], `${minute}`);
    }
  });

  test('two ends of the SAME colour name it once', () => {
    // "between amber and amber" is a sentence no screen should have to render.
    const points = [
      point({ at: 21 * 60, warmth: 1, color: 'candle' }),
      point({ at: 23 * 60, warmth: 1, color: 'candle' }),
    ];
    assert.deepEqual(valueAt(points, 22 * 60).colorLabelKeys, ['palette.candle']);
  });

  test('a warmth segment names nothing, which is what lets a screen say warmth', () => {
    const points = [point({ at: 6 * 60, warmth: 0.2 }), point({ at: 21 * 60, warmth: 1 })];
    assert.equal(valueAt(points, 12 * 60).colorLabelKeys, undefined);
    assert.equal('colorLabelKeys' in valueAt(points, 12 * 60), false);
  });

  test('the keys are keys, not words — lib/ cannot translate', () => {
    for (const colour of PALETTE) {
      const points = [point({ at: 21 * 60, warmth: 1, color: colour.id })];
      assert.deepEqual(valueAt(points, 21 * 60).colorLabelKeys, [colour.labelKey], colour.id);
    }
  });

  test('resolvePoints carries the colour into diagnostics', () => {
    const resolved = resolvePoints([point({ at: 21 * 60, color: 'forest' })]);
    assert.equal(resolved[0].color, 'forest');
  });
});

describe('the sanitiser and a colour', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'p1', at: '21:00', warmth: 0.9, ...over,
  });

  test('a known colour is kept', () => {
    const { points, dropped } = sanitiseCurve(
      [row({ color: 'amber' }), row({ id: 'p2', at: '06:00', warmth: 0.2 })],
      false,
    );
    assert.deepEqual(dropped, []);
    assert.equal(points.find(p => p.id === 'p1')?.color, 'amber');
  });

  test('an unknown colour drops the POINT, not the colour', () => {
    // A curve that silently reverted one point to white would look like it was
    // working, and finding out why means noticing a colour that is subtly not the
    // one you chose. A missing point is visible on the screen and in the chart.
    const { points, dropped } = sanitiseCurve(
      [row({ color: 'chartreuse' }), row({ id: 'p2', at: '06:00', warmth: 0.2 })],
      false,
    );
    assert.equal(points.length, 0, 'and a one-point curve is no curve');
    assert.ok(dropped.some(d => /not one this version offers/.test(d.reason)), JSON.stringify(dropped));
  });

  test('absent, null and empty all mean "no colour"', () => {
    for (const colour of [undefined, null, '']) {
      const { points } = sanitiseCurve(
        [row({ color: colour }), row({ id: 'p2', at: '06:00', warmth: 0.2 })],
        false,
      );
      assert.equal(points.length, 2, JSON.stringify(colour));
      assert.equal('color' in points[0], false, JSON.stringify(colour));
    }
  });
});

describe('the colour reaches the lights', () => {
  const cache = () => {
    const c = new TargetStateCache();
    // A full-colour lamp: hue, saturation AND a temperature mode to switch out of.
    c.setCapabilities('full', {
      onoff: true,
      light_temperature: { min: 0, max: 1, decimals: 2 },
      light_hue: { min: 0, max: 1 },
      light_saturation: { min: 0, max: 1 },
      light_mode: true,
    });
    // Colour-only: no mode, because there is no temperature mode to leave.
    c.setCapabilities('colouronly', {
      onoff: true,
      light_hue: { min: 0, max: 1 },
      light_saturation: { min: 0, max: 1 },
    });
    // White-only.
    c.setCapabilities('white', { onoff: true, light_temperature: { min: 0, max: 1, decimals: 2 } });
    return c;
  };

  const plan = (ids: string[]) => planIntent(
    { type: 'color_absolute', hue: 0.11, saturation: 0.75 },
    ids, cache(), DEFAULT_BEHAVIOR,
  );

  test('mode comes first, then hue, then saturation', () => {
    // A lamp in temperature mode IGNORES a hue it is given — not an error, just
    // no visible effect, which is the worst failure this app can produce.
    const { writes } = plan(['full']);
    assert.deepEqual(writes.map(w => w.capability), ['light_mode', 'light_hue', 'light_saturation']);
    assert.equal(writes[0].value, 'color');
    assert.equal(writes[1].value, 0.11);
    assert.equal(writes[2].value, 0.75);
  });

  test('a colour-only lamp gets no mode write', () => {
    const { writes } = plan(['colouronly']);
    assert.deepEqual(writes.map(w => w.capability), ['light_hue', 'light_saturation']);
  });

  test('a white-only lamp is SKIPPED, and said to be', () => {
    // Partial support behaves like partial failure: execute on the compatible
    // subset, disclose, never fail the whole intent.
    const { writes, skipped } = plan(['white']);
    assert.deepEqual(writes, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /light_hue/);
  });

  test('a mixed set writes to what it can and reports the rest', () => {
    const { writes, skipped } = plan(['full', 'white', 'colouronly']);
    assert.deepEqual([...new Set(writes.map(w => w.deviceId))], ['full', 'colouronly']);
    assert.deepEqual(skipped.map(s => s.deviceId), ['white']);
  });

  test('the capability test is HUE, not light_mode', () => {
    // Testing for `light_mode` would skip a colour-only lamp that can do exactly
    // what was asked. homey-lib pairs hue and saturation on every colour-capable
    // light; `light_mode` exists only where there is also a temperature mode.
    const c = cache();
    assert.equal(c.supports('colouronly', 'light_hue'), true);
    assert.equal(c.supports('colouronly', 'light_mode'), false);
  });
});

describe('the curve plan has its own store and its own chain', () => {
  const validPlan = () => ({
    schemaVersion: CURRENT_CURVE_SCHEMA_VERSION,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1'] },
    points: [
      { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.2 },
      { id: 'p2', anchor: { kind: 'clock', at: 21 * 60 }, warmth: 1, color: 'amber' },
    ],
    adjustBrightness: false,
    preStage: false,
  });

  test('a complete plan passes unchanged', () => {
    const { plan, migrated } = migrateCurvePlan(validPlan());
    assert.equal(migrated, false);
    assert.deepEqual(plan, validPlan());
  });

  test('a plan with no version is brought forward', () => {
    const { points } = validPlan();
    const { plan, migrated, fromVersion } = migrateCurvePlan({
      target: { kind: 'devices', deviceIds: ['l1'] },
      points,
    });
    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(plan.schemaVersion, CURRENT_CURVE_SCHEMA_VERSION);
    assert.deepEqual(plan.points, points);
    // Opt-in, so an absent value is a no rather than an unknown.
    assert.equal(plan.preStage, false);
    assert.equal(plan.enabled, true);
  });

  /**
   * The 0 → 1 step fills `points` with `[]` when there is none, and its own
   * comment says no such plan can exist — the driver shipped at version 1, and
   * the step is there only so version 0 is not a special case in the runner.
   * So an empty curve reaching the validator is corruption, not an upgrade, and
   * quarantine is the honest answer: a curve with no points reports `ready` and
   * writes nothing, which is the failure this app exists to prevent.
   */
  test('a versionless plan with no points quarantines rather than running empty', () => {
    assert.throws(
      () => migrateCurvePlan({ target: { kind: 'devices', deviceIds: ['l1'] } }),
      /points has fewer than 2 points/,
    );
  });

  test('a colour this build does not offer quarantines the device', () => {
    // Reachable only through a downgrade — a plan saved by a version with a
    // larger palette. Refusing beats running at a colour nobody chose.
    const plan = validPlan();
    (plan.points[1] as any).color = 'chartreuse';
    assert.throws(() => migrateCurvePlan(plan), /not a colour this version offers/);
  });

  test('the label says Curve, so its errors are not the circadian light\'s', () => {
    assert.throws(() => migrateCurvePlan({ schemaVersion: 99 }), /Curve schema version 99/);
    assert.throws(() => migrateCurvePlan(null), /not an object/);
  });
});

/**
 * The blend is a straight line across the colour disc, and these are the
 * properties that made it worth changing from an arc round the rim.
 *
 * Nothing here pinned the DIRECTION of a blend before: the all-pairs test above
 * asserts only that a hue stays on the wheel, so ember fading to ocean through
 * magenta and purple passed it silently.
 */
describe('a wide blend fades through pale, not through a hue nobody chose', () => {
  const ember = paletteColor('ember')!;
  const ocean = paletteColor('ocean')!;
  const peach = paletteColor('peach')!;

  test('ember to ocean loses its saturation in the middle', () => {
    // 0.53 of a turn apart, so the arc had to cross a quarter of the wheel
    // whichever way it went: backward through rose, magenta, purple and violet
    // at a saturation that never dropped below 0.7. Half of an hour-long
    // segment was purple.
    const half = mixColors(ember, ocean, 0.5);
    assert.ok(half.saturation < 0.15,
      `the middle of a wide blend should be near white, got ${half.saturation}`);
  });

  test('a narrow blend keeps its saturation', () => {
    // The pairs the wheel-blend was chosen for must not have been flattened:
    // candle to amber is 0.03 of a turn, and stays a colour all the way across.
    const candle = paletteColor('candle')!;
    const amber = paletteColor('amber')!;
    const half = mixColors(candle, amber, 0.5);

    assert.ok(half.saturation > 0.6, `${half.saturation} should still be a colour`);
    assert.ok(half.hue > candle.hue && half.hue < amber.hue,
      `${half.hue} should sit between the two`);
  });

  test('no blend is more saturated than the more saturated end', () => {
    /**
     * The property that says "fades through pale" rather than just "changes
     * saturation": a straight line between two points of a disc never leaves
     * it, so the blend can only ever be less saturated than the ends, never
     * more. An arc round the rim could not promise this either way.
     */
    for (const from of PALETTE) {
      for (const to of PALETTE) {
        const ceiling = Math.max(from.saturation, to.saturation) + 1e-9;
        for (let step = 0; step <= 20; step += 1) {
          const mixed = mixColors(from, to, step / 20);
          assert.ok(mixed.saturation <= ceiling,
            `${from.id}->${to.id} @${step / 20}: ${mixed.saturation} > ${ceiling}`);
        }
      }
    }
  });

  test('the endpoints are the endpoints, exactly', () => {
    /**
     * Returned verbatim rather than computed. The round trip through
     * atan2/hypot is accurate to about 2e-16, which is not the same as exact,
     * and a curve sitting on one of its own points should report that point.
     */
    for (const from of PALETTE) {
      for (const to of PALETTE) {
        assert.deepEqual(mixColors(from, to, 0), { hue: from.hue, saturation: from.saturation });
        assert.deepEqual(mixColors(from, to, 1), { hue: to.hue, saturation: to.saturation });
      }
    }
  });

  test('the palest pair still reports a usable hue', () => {
    /**
     * Peach to ocean is the pair whose line passes closest to the middle —
     * within 0.017 of white. There is no angle at the middle of a disc
     * (atan2(0, 0) is 0, which is red), so the blend holds an endpoint hue
     * through that band rather than swinging through it.
     */
    for (let step = 0; step <= 40; step += 1) {
      const fraction = step / 40;
      const mixed = mixColors(peach, ocean, fraction);
      assert.ok(Number.isFinite(mixed.hue) && mixed.hue >= 0 && mixed.hue < 1,
        `@${fraction}: ${mixed.hue}`);
      if (mixed.saturation < 0.02) {
        const held = fraction < 0.5 ? peach.hue : ocean.hue;
        assert.equal(mixed.hue, held, `@${fraction} should hold an end, not invent red`);
      }
    }
  });
});

/**
 * The brightness floor, applied to what is already stored.
 *
 * The sliders now start at 10% because 5% quantises to `dim` 0.00 at the lamp —
 * off, on most integrations. Flooring the WRITE was not enough on its own: a
 * stored 5% loaded into a slider that starts at 10% displays 10% while the plan
 * still says 5%, so the card would show one number and save another.
 */
describe('a stored brightness comes up to the floor', () => {
  const storedAt = (brightness: number | undefined) => ({
    schemaVersion: 1,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1'] },
    points: [
      { id: 'p1', anchor: { kind: 'clock', at: 6 * 60 }, warmth: 0.2, brightness },
      { id: 'p2', anchor: { kind: 'clock', at: 21 * 60 }, warmth: 1, brightness: 0.6 },
    ],
    adjustBrightness: brightness !== undefined,
    preStage: false,
  });

  test('5% becomes 10%', () => {
    const { plan, migrated, steps } = migrateCurvePlan(storedAt(0.05));

    assert.equal(migrated, true);
    assert.ok(steps.includes(1), `the 1 -> 2 step must have run, got ${steps.join(',')}`);
    assert.equal(plan.points[0].brightness, 0.1);
    assert.equal(plan.points[1].brightness, 0.6, 'and nothing above the floor moves');
  });

  test('a point with no brightness stays without one', () => {
    /**
     * The engine interpolates brightness only where BOTH bracketing points have
     * it, so inventing one here would turn a temperature-only curve into a
     * dimming one.
     */
    const { plan } = migrateCurvePlan(storedAt(undefined));
    assert.equal(plan.points[0].brightness, undefined);
  });

  test('a plan already at the current version is left alone', () => {
    const raw = { ...storedAt(0.05), schemaVersion: CURRENT_CURVE_SCHEMA_VERSION };
    const { plan, migrated } = migrateCurvePlan(raw);

    assert.equal(migrated, false);
    assert.equal(plan.points[0].brightness, 0.05,
      'the floor is a migration, not a validator — litDim still catches this one at write time');
  });
});
