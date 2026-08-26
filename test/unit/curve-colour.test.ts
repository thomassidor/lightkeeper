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
 *    inventing a shade nobody chose — the same argument CLAUDE.md §12 makes about
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

  test('hue blends the SHORT way round the wheel', () => {
    // Rose (0.96) to peach (0.04) is 0.08 forward through red, not 0.92 backward
    // through green — which is the difference between a sunset and a mistake.
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

  test('saturation is linear, because it is a distance and not an angle', () => {
    const a = { id: 'a', labelKey: 'x', hue: 0.5, saturation: 0.2 };
    const b = { id: 'b', labelKey: 'y', hue: 0.5, saturation: 0.8 };
    assert.ok(Math.abs(mixColors(a, b, 0.5).saturation - 0.5) < 1e-9);
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
    const { plan, migrated, fromVersion } = migrateCurvePlan({
      target: { kind: 'devices', deviceIds: ['l1'] },
    });
    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(plan.schemaVersion, CURRENT_CURVE_SCHEMA_VERSION);
    assert.deepEqual(plan.points, []);
    assert.equal(plan.preStage, false);
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
