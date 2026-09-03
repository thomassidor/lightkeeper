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
 * Adding a colour is adding an entry here plus its locale key. Removing one is
 * NOT safe: a stored plan names it, and `sanitiseCurve` drops a point whose
 * colour it cannot resolve — so a removed colour silently deletes a point from
 * somebody's curve. Deprecate by leaving it in place.
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
}

/**
 * Ordered as they read on a screen — warm to cool, then the two that are
 * neither. Not ordered by hue: the wheel puts red next to magenta, which is not
 * how anyone browses a list of colours for a room.
 */
export const PALETTE: readonly PaletteColor[] = [
  { id: 'candle', labelKey: 'palette.candle', hue: 0.08, saturation: 0.55 },
  { id: 'amber', labelKey: 'palette.amber', hue: 0.11, saturation: 0.75 },
  { id: 'peach', labelKey: 'palette.peach', hue: 0.04, saturation: 0.45 },
  { id: 'rose', labelKey: 'palette.rose', hue: 0.96, saturation: 0.50 },
  { id: 'lavender', labelKey: 'palette.lavender', hue: 0.75, saturation: 0.40 },
  { id: 'ocean', labelKey: 'palette.ocean', hue: 0.55, saturation: 0.70 },
  { id: 'forest', labelKey: 'palette.forest', hue: 0.35, saturation: 0.55 },
  { id: 'ember', labelKey: 'palette.ember', hue: 0.02, saturation: 0.85 },
] as const;

const BY_ID = new Map(PALETTE.map(color => [color.id, color]));

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
