/**
 * The two lines every curve in this app interpolates with.
 *
 * They were private to lib/circadian/circadian-curve.ts, which was right while
 * one feature owned the only curve. A second one now reads a level off a ramp
 * — lux and sun elevation, in lib/daylight/daylight-response.ts — and the wrong
 * answer would have been to write a second easing. Two easings in one app is
 * two shapes a user can feel the difference between and nobody chose.
 *
 * So: ONE raised cosine, here, and both features import it.
 */

/**
 * Raised cosine: 0 → 0, 1 → 1, flat at both ends.
 *
 * Flat at the ends is the whole point. A linear ramp arrives at a curve's point
 * still moving and leaves it still moving, so the moment it turns is visible on
 * a wall; this one settles into each end.
 */
export function ease(fraction: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * fraction);
}

/** Linear blend. Bare on purpose — the easing is applied to the FRACTION, not here. */
export function mix(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}
