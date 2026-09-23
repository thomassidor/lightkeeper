/**
 * The colours a curve point may be set to, and nothing else.
 *
 * A closed palette rather than a colour picker, for three reasons that are all
 * about the same thing — a curve is a thing that runs unattended for months:
 *
 *  - **Hue and saturation are a two-dimensional choice with one good answer per
 *    intent.** "Amber" is a decision; hue 0.08 at saturation 0.62 is a pair of
 *    numbers someone landed on once and can never reproduce. A named colour
 *    survives being read back on a settings page a year later.
 *  - **Most of the plane is a bad idea in a living room at 21:00.** A fully
 *    saturated green is a colour a picker offers and nobody wants a whole room
 *    to be. The palette is the place to have that judgement once.
 *  - **A name is translatable; a coordinate is not.** These carry locale keys,
 *    which is the same rule as everything else user-facing in `lib/`.
 *
 * Values are Homey's normalised 0–1 axes. `light_hue` is the colour wheel
 * (0 = red, through yellow, green, cyan, blue, magenta, back to red) and
 * `light_saturation` is how far from white. Both are read off the same
 * `capabilitiesObj` the rest of the app reads its ranges from, and the planner
 * clamps against each lamp's own options before anything is written.
 *
 * Adding a colour is adding an entry here plus its locale key, and a place in
 * `PALETTE_LAYOUT`. Removing one is NOT safe: a stored plan names it, and
 * `sanitiseCurve` drops a point whose colour it cannot resolve — so a removed
 * colour silently deletes a point from somebody's curve. Deprecate by marking
 * it `hidden` and taking it out of the layout.
 */

export interface PaletteColor {
  /** Stored in the plan. Stable forever; see the module comment. */
  id: string;
  /** Locale key, because a name built in `lib/` could never be translated. */
  labelKey: string;
  /** Homey's normalised colour wheel, 0–1. */
  hue: number;
  /** Homey's normalised distance from white, 0–1. */
  saturation: number;
  /**
   * What the selector paints, as the design drew it. Absent on a hidden colour.
   *
   * A hex beside the two axes rather than instead of them, because the axes are
   * what a LAMP is sent and the hex is what a screen shows — and `colourSwatch()`
   * cannot recover a designer's exact hex from a hue and a saturation, having no
   * third axis to recover it with.
   */
  swatch?: string;
  /** In the palette so a stored plan still resolves, and never drawn. */
  hidden?: true;
}

/**
 * The palette: every colour a plan may name.
 *
 * **Redrawn on 2026-09-23 from the design's own hexes.** Each drawn colour's
 * hue and saturation is the HSV reading of its `swatch`, so the screen and the
 * lamp are told the same colour; a colour that existed before kept its id (and
 * so every stored point that names it) and was re-tuned to the nearest swatch.
 * Eleven are new, and one — `moss` — has no swatch and is kept, hidden.
 *
 * **The whites are near-white HUES, not colour temperatures**, and that is the
 * one thing worth knowing before adding to this list. A point's `color`
 * replaces its warmth on a lamp that can take a colour, so "cool white" here is
 * a faintly blue hue rather than a `light_temperature` value. The first row runs
 * candlelight to bright white along exactly the stops of `--lk-warm-ramp`. A
 * lamp with no colour capability is unaffected either way: it gets the point's
 * `warmth`, which is why `warmth` stays required even on a coloured point.
 */
export const PALETTE: readonly PaletteColor[] = [
  // Drawn, in the order the screen first meets them: the default ten, then the
  // twenty-five behind "Show more colours". `ocean` is drawn twice (the default
  // blue, and the middle of the blues row) and stored once.
  { id: 'candle', labelKey: 'palette.candle', hue: 0.082, saturation: 0.81, swatch: '#e8892c' },
  { id: 'amber', labelKey: 'palette.amber', hue: 0.086, saturation: 0.632, swatch: '#efa658' },
  { id: 'warmwhite', labelKey: 'palette.warmwhite', hue: 0.094, saturation: 0.434, swatch: '#f4c68a' },
  { id: 'neutral', labelKey: 'palette.neutral', hue: 0.095, saturation: 0.116, swatch: '#f2e6d6' },
  { id: 'coolwhite', labelKey: 'palette.coolwhite', hue: 0.599, saturation: 0.127, swatch: '#dbe8fb' },
  { id: 'coral', labelKey: 'palette.coral', hue: 0.021, saturation: 0.719, swatch: '#e0533f' },
  { id: 'sunflower', labelKey: 'palette.sunflower', hue: 0.142, saturation: 0.715, swatch: '#ddc63f' },
  { id: 'forest', labelKey: 'palette.forest', hue: 0.37, saturation: 0.464, swatch: '#5aa86b' },
  { id: 'ocean', labelKey: 'palette.ocean', hue: 0.569, saturation: 0.658, swatch: '#3f86b8' },
  { id: 'orchid', labelKey: 'palette.orchid', hue: 0.8, saturation: 0.462, swatch: '#a763b8' },
  { id: 'crimson', labelKey: 'palette.crimson', hue: 0.01, saturation: 0.761, swatch: '#b8342c' },
  { id: 'ember', labelKey: 'palette.ember', hue: 0.034, saturation: 0.802, swatch: '#d94f2b' },
  { id: 'rose', labelKey: 'palette.rose', hue: 0.944, saturation: 0.56, swatch: '#d85f88' },
  { id: 'blush', labelKey: 'palette.blush', hue: 0.967, saturation: 0.417, swatch: '#f08ca0' },
  { id: 'peach', labelKey: 'palette.peach', hue: 0.019, saturation: 0.282, swatch: '#f5b8b0' },
  { id: 'rust', labelKey: 'palette.rust', hue: 0.071, saturation: 0.84, swatch: '#c2641f' },
  { id: 'apricot', labelKey: 'palette.apricot', hue: 0.1, saturation: 0.741, swatch: '#e8a33c' },
  { id: 'gold', labelKey: 'palette.gold', hue: 0.129, saturation: 0.612, swatch: '#e8c85a' },
  { id: 'butter', labelKey: 'palette.butter', hue: 0.131, saturation: 0.492, swatch: '#f0d77a' },
  { id: 'cream', labelKey: 'palette.cream', hue: 0.129, saturation: 0.287, swatch: '#f7e7b0' },
  { id: 'pine', labelKey: 'palette.pine', hue: 0.404, saturation: 0.615, swatch: '#2f7a4f' },
  { id: 'leaf', labelKey: 'palette.leaf', hue: 0.39, saturation: 0.5, swatch: '#4f9e6a' },
  { id: 'lime', labelKey: 'palette.lime', hue: 0.225, saturation: 0.541, swatch: '#9fc45a' },
  { id: 'teal', labelKey: 'palette.teal', hue: 0.489, saturation: 0.594, swatch: '#3f9b95' },
  { id: 'mint', labelKey: 'palette.mint', hue: 0.382, saturation: 0.17, swatch: '#b9dfc4' },
  { id: 'navy', labelKey: 'palette.navy', hue: 0.602, saturation: 0.696, swatch: '#2a4f8a' },
  { id: 'cobalt', labelKey: 'palette.cobalt', hue: 0.62, saturation: 0.672, swatch: '#3f63c0' },
  { id: 'sky', labelKey: 'palette.sky', hue: 0.566, saturation: 0.504, swatch: '#6fb3e0' },
  { id: 'ice', labelKey: 'palette.ice', hue: 0.568, saturation: 0.223, swatch: '#bcdcf2' },
  { id: 'indigo', labelKey: 'palette.indigo', hue: 0.716, saturation: 0.659, swatch: '#4a2f8a' },
  { id: 'iris', labelKey: 'palette.iris', hue: 0.68, saturation: 0.582, swatch: '#5b52c4' },
  { id: 'violet', labelKey: 'palette.violet', hue: 0.735, saturation: 0.589, swatch: '#7d4fc0' },
  { id: 'magenta', labelKey: 'palette.magenta', hue: 0.891, saturation: 0.51, swatch: '#c25fa0' },
  { id: 'lavender', labelKey: 'palette.lavender', hue: 0.758, saturation: 0.178, swatch: '#d9c2ec' },

  // NOT DRAWN, and still resolvable: a stored point may name it. See the module
  // comment on why a colour is never removed.
  { id: 'moss', labelKey: 'palette.moss', hue: 0.30, saturation: 0.45, hidden: true },
] as const;

/**
 * Which swatches the colour selector draws, and where.
 *
 * Five across everywhere — two rows by default, and five more rows of one hue
 * family each, deep to pale, behind "Show more colours". Ids rather than
 * entries, because the grid is a picture of the palette and not the palette:
 * `ocean` is in it twice, and `moss` is in the palette and not in it at all.
 * curve-colour.test.ts holds the two together.
 */
export const PALETTE_LAYOUT: { readonly featured: readonly string[]; readonly more: readonly string[] } = {
  featured: [
    // Whites, candlelight to bright white.
    'candle', 'amber', 'warmwhite', 'neutral', 'coolwhite',
    // One of each colour.
    'coral', 'sunflower', 'forest', 'ocean', 'orchid',
  ],
  more: [
    'crimson', 'ember', 'rose', 'blush', 'peach', //        reds and pinks
    'rust', 'apricot', 'gold', 'butter', 'cream', //         oranges and yellows
    'pine', 'leaf', 'lime', 'teal', 'mint', //               greens
    'navy', 'cobalt', 'ocean', 'sky', 'ice', //              blues
    'indigo', 'iris', 'violet', 'magenta', 'lavender', //    purples
  ],
};

const BY_ID = new Map(PALETTE.map(color => [color.id, color]));

/**
 * The warmth a palette colour stands in for, on a lamp that cannot take one.
 *
 * Hue 0 to 0.15 is the warm end of the spectrum and 0.5 to 0.7 the cool end, so
 * this is that mapping and nothing cleverer. A near-white lands near the middle,
 * which is what a white should be.
 *
 * It is here rather than in a screen because TWO stored shapes now carry a
 * colour and each needs the same fallback beside it: a curve point (`warmth` is
 * required alongside `color`) and a schedule block (`temperature`, same idea).
 * Without the fallback, what a block does would depend on which of the
 * household's lamps happen to do colour — the colour ones would go amber and
 * the temperature-only ones would go nowhere at all.
 *
 * `warmthFor()` in drivers/curve/pair/curve.html is the same function again,
 * for the same reason `css()` and `blend()` are: that screen recomputes on
 * every tap and cannot ask the driver. Change one and change the other.
 */
export function warmthForColor(color: { hue: number; saturation: number }): number {
  const warmish = color.hue < 0.2 || color.hue > 0.9;
  const base = warmish ? 0.9 : 0.25;
  return base * color.saturation + 0.5 * (1 - color.saturation);
}

/** A palette colour by id, or undefined for one this version does not know. */
export function paletteColor(id: string): PaletteColor | undefined {
  return BY_ID.get(id);
}

export function isPaletteColor(id: unknown): boolean {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * Blend two palette colours: a straight line across the colour DISC, not an arc
 * round the hue wheel.
 *
 * Hue and saturation are polar coordinates — an angle and a distance from white
 * — so each colour is a point on a disc, and the blend is the straight line
 * between those two points. Read back out as an angle and a distance, a wide
 * pair therefore fades in towards the pale middle and back out again, rather
 * than swinging round the rim at full saturation.
 *
 * That is the whole point, and it is the same argument this module already makes
 * about not inventing shades. Interpolating the ANGLE means every hue between
 * the two ends gets painted on someone's wall, and for a wide pair those are
 * hues nobody chose: `ember` (0.02) to `ocean` (0.55) is 0.53 of a turn, so the
 * short way round ran backwards through rose, magenta, purple and violet at
 * near-constant saturation, and half of an hour-long segment was purple. 14 of
 * the 28 palette pairs are more than a quarter-turn apart — `peach` to `ocean`
 * went through violet, `candle` to `ocean` through green.
 *
 * No arc can fix that: two hues half a wheel apart have nothing between them
 * either way round. Fading through pale is the honest answer, because pale is
 * what both ends have in common.
 *
 * Adjacent warm pairs — the pairs the wheel-blend was chosen for — barely move:
 * amber to rose shifts about 0.015 in hue and 0.05 in saturation, so amber still
 * blends through orange to rose. What changes is that it now does it across the
 * chord rather than along the rim.
 *
 * The endpoints are returned VERBATIM rather than computed. The round trip
 * through `atan2`/`hypot` is accurate to about 2e-16, which is not the same as
 * exact, and a curve sitting exactly on one of its own points should report that
 * point's colour and not a value 2e-16 away from it.
 *
 * Only ever called between two points that BOTH carry a colour — see
 * `valueAt()` for why a segment with a colour at only one end holds that
 * colour instead of blending. Blending a colour with a colour temperature would
 * mean inventing a shade nobody chose, which is the one thing this feature must
 * not do.
 */
export function mixColors(
  from: PaletteColor,
  to: PaletteColor,
  fraction: number,
): { hue: number; saturation: number } {
  if (fraction <= 0) return { hue: from.hue, saturation: from.saturation };
  if (fraction >= 1) return { hue: to.hue, saturation: to.saturation };

  const [fromX, fromY] = toDisc(from);
  const [toX, toY] = toDisc(to);

  const x = fromX + (toX - fromX) * fraction;
  const y = fromY + (toY - fromY) * fraction;

  const saturation = Math.hypot(x, y);
  /**
   * At the very middle of the disc there is no angle to read — `atan2(0, 0)` is
   * 0, which is red, and a pair whose line passes close to white would swing
   * violently through it. So near the middle the hue is held at whichever end
   * the blend is closer to: it is unsaturated there, the hue is not visible
   * anyway, and holding it beats inventing red.
   *
   * `peach` to `ocean` is the pair that gets closest, passing within 0.017 of
   * white.
   */
  if (saturation < HUE_FLOOR) {
    return { hue: fraction < 0.5 ? from.hue : to.hue, saturation };
  }

  return { hue: normaliseHue(Math.atan2(y, x) / TURN), saturation };
}

/** A turn of the hue wheel, in radians. Hue is 0–1; `atan2` is not. */
const TURN = 2 * Math.PI;

/**
 * Below this distance from white a colour has no visible hue, so the blend holds
 * an endpoint's hue rather than reading an angle that is about to swing.
 */
const HUE_FLOOR = 0.02;

/** A palette colour as a point on the disc: an angle and a distance from white. */
function toDisc(color: PaletteColor): [number, number] {
  return [
    color.saturation * Math.cos(TURN * color.hue),
    color.saturation * Math.sin(TURN * color.hue),
  ];
}

/** Back into 0–1, because `atan2` returns −π…π and hue wraps at 1. */
function normaliseHue(hue: number): number {
  return ((hue % 1) + 1) % 1;
}
