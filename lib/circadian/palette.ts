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
 * Blend two palette colours.
 *
 * Hue takes the SHORT way round the wheel, which is what makes amber blend
 * through orange to rose rather than the long way through green. Saturation is
 * linear, because it is a distance rather than an angle.
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
  let delta = to.hue - from.hue;
  // The wheel wraps at 1, so a difference over half a turn is shorter the other
  // way: 0.96 → 0.08 is 0.12 forward, not 0.88 backward.
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;

  const hue = ((from.hue + delta * fraction) % 1 + 1) % 1;
  return {
    hue,
    saturation: from.saturation + (to.saturation - from.saturation) * fraction,
  };
}
