/**
 * The lines every curve in this app interpolates with.
 *
 * They were private to lib/circadian/circadian-curve.ts, which was right while
 * one feature owned the only curve. A second one now reads a level off a ramp
 * — lux and sun elevation, in lib/daylight/daylight-response.ts — and the wrong
 * answer would have been to write a second easing. Two easings in one app is
 * two shapes a user can feel the difference between and nobody chose.
 *
 * So there is ONE family of shapes, here, and every engine imports it. Since
 * 0.6.6 the user picks which member — the "Transition" choice on the three
 * engine device types' editing screens. Until then there was a single raised
 * cosine, `0.5 − 0.5·cos(πt)`, and it is gone rather than kept as a fourth
 * option: Balanced is within 0.016 of it at every `t` (asserted in
 * interpolate.test.ts), which is below the curve's own colour deadband, so a
 * device migrated from the cosine to Balanced does not visibly change.
 *
 * `views/shared/transition-shape.js` is the same maths for the pairing screens,
 * which cannot import this. Change one, change both.
 */

/** How a value moves between two points. Stored on every engine plan. */
export type Transition = 'gradual' | 'balanced' | 'quick';

export const TRANSITIONS: readonly Transition[] = ['gradual', 'balanced', 'quick'];

/** What a NEW device gets. Existing devices get what their migration chose. */
export const DEFAULT_TRANSITION: Transition = 'balanced';

/**
 * The logistic's steepness for the two eased shapes.
 *
 * 6 settles into each end almost as flat as the old raised cosine did, which is
 * why it is the default: a change of gradient at a curve's point is visible on a
 * wall as the app twitching. 16 spends nearly the whole change in the middle
 * third — "changes all at once" without being a step, which a lamp would show as
 * a jump.
 */
const BALANCED_K = 6;
const QUICK_K = 16;

export function isTransition(value: unknown): value is Transition {
  return value === 'gradual' || value === 'balanced' || value === 'quick';
}

/**
 * The transition a screen sent, or the default. Absent is not a correction —
 * a scripted session (platform §14) that never mentions it has not sent
 * anything wrong — but a value that is not one of the three is.
 */
export function sanitiseTransition(raw: unknown, corrected: string[]): Transition {
  if (isTransition(raw)) return raw;
  if (raw !== undefined) corrected.push('transition');
  return DEFAULT_TRANSITION;
}

/**
 * The shaped fraction: 0 → 0, 1 → 1, monotonic, whatever the transition.
 *
 * The logistic is NORMALISED — `(s(t) − s(0)) / (s(1) − s(0))` — because a bare
 * one never reaches 0 or 1, and a curve that stops 0.3% short of its own point
 * never writes the value the person chose there.
 */
export function shape(transition: Transition, fraction: number): number {
  const t = Math.max(0, Math.min(1, fraction));
  if (transition === 'gradual') return t;
  const k = transition === 'quick' ? QUICK_K : BALANCED_K;
  const s = (x: number): number => 1 / (1 + Math.exp(-k * (x - 0.5)));
  const low = s(0);
  return (s(t) - low) / (s(1) - low);
}

/** Linear blend. Bare on purpose — the shape is applied to the FRACTION, not here. */
export function mix(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}
