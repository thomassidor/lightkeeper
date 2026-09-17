import { VALUE_CAPABILITIES, type PublishedValues } from '../runtime/published-values';

/**
 * "It is dark enough" — the Room-sensing Light's own reading, offered to
 * anybody else's Flow.
 *
 * The value it compares is the one the device already decided: a sensor reading
 * turned into a 0..1 through the response's own lux ends, or the sun's elevation
 * through its own degree ends, chosen by the same rule the device uses to drive
 * its lamps. That is the point of the card. A Flow that re-decided "dark" from a
 * raw lux number would be a second threshold to keep in step with the first, and
 * the one the user actually tuned — on a screen showing that sensor's own week —
 * would be the one they were not using.
 */

/** The published daylight level, or null when the device cannot tell. */
export function levelOf(values: PublishedValues): number | null {
  const value = values[VALUE_CAPABILITIES.daylight];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Whether it is at or below the threshold the user set on the card.
 *
 * **False when there is no reading**, never true, and this is the whole of the
 * card's safety argument. `null` here means a Room-sensing Light with no usable
 * sensor and no location for the sun — a flat battery, or a Homey never told
 * where it is. The condition is almost always guarding "switch these lights on",
 * so the two ways to be wrong are a room that stays dark and a room that lights
 * itself in daylight, repeatedly, with nothing on screen explaining why. Leaving
 * the lights alone is the same answer the device itself gives in that state, and
 * the FAQ already promises it.
 *
 * Inclusive at the threshold, so a card set to 0 asks for pitch dark and a card
 * set to 1 is always true while the device can read anything at all — both ends
 * mean what the slider says they mean.
 */
export function isDarkEnough(values: PublishedValues, threshold: unknown): boolean {
  const level = levelOf(values);
  if (level === null) return false;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return false;
  return level <= threshold;
}
