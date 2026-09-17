import type { LightIntent } from '../outputs/light-intent';
import { VALUE_CAPABILITIES, type PublishedValues } from '../runtime/published-values';

/**
 * "Set these lights the way Lightkeeper would" — every rule of it, with no SDK
 * anywhere near.
 *
 * The card this serves is the one thing the capability rows alone cannot do.
 * With them a user can already drop "Room-sensing Light: Brightness now" into
 * Homey's own "Dim to" card and get the right level; what they cannot do is get
 * the brightness, the colour and the switch into ONE pass. Three built-in cards
 * are three separate writes, so a lamp comes on as it was, changes colour, then
 * changes level — and on a lamp that gates a colour behind its mode (platform
 * §6) the order the user happens to drag them into decides whether the colour
 * lands at all.
 *
 * So the card composes TWO Lightkeeper devices — colour from one, brightness
 * from another — and hands the result to the same planner and the same write
 * queue every runtime uses, which is where `WRITE_ORDER` puts `light_mode`
 * ahead of the colour and `onoff` ahead of the level for free.
 *
 * `app.ts` holds the shell only, exactly as it does for the bridge cards: it
 * extends `Homey.App` and cannot be imported by a test (platform §13), so every
 * decision below lives where one can reach it.
 */

/**
 * What to do about the switch.
 *
 * Two options, not three, and the missing one is the point. "Leave the switch
 * alone" reads like the safe choice and is not offered, because a `dim` write
 * turns an off lamp on — measured, twenty-five of twenty-five (platform §12) —
 * so the only honest way to leave a lamp's switch alone is not to write to it.
 * That is what `only_on` is. Offering both would have given the same behaviour
 * two names, one of which promised something it could not do.
 */
export type PowerChoice = 'on' | 'only_on';

export function isPowerChoice(value: unknown): value is PowerChoice {
  return value === 'on' || value === 'only_on';
}

/** The autocomplete entry that means "do not set this at all". */
export const LEAVE_ALONE = 'none';

/** What a Lightkeeper runtime offers this card. All three types have it. */
export interface ValueSource {
  publishedValues(): PublishedValues;
}

/**
 * A curve-driven runtime, which can also offer a colour.
 *
 * Read separately from the published values rather than out of them, because
 * what the board publishes is a NAME — one or two `palette.*` keys, for a row a
 * person reads — and a lamp takes a hue and a saturation. The board is
 * deliberately not the place to widen into a structure only this card wants.
 */
export interface ColourSource extends ValueSource {
  currentValue(): { color?: { hue: number; saturation: number } } | null;
}

export interface LightSettings {
  /** Device `dim`, 0..1, already through the perceptual curve. Null leaves it alone. */
  brightness: number | null;
  /** `light_temperature`, 0..1, 1 = warmest. Null leaves warmth alone. */
  temperature: number | null;
  /** Hue and saturation, 0..1 each. Wins over `temperature` when present. */
  colour: { hue: number; saturation: number } | null;
}

export interface SetLightsSources {
  colour: ColourSource | null;
  brightness: ValueSource | null;
  /** Ids the user chose that no live Lightkeeper device answers to. */
  missing: readonly string[];
}

export interface SetLightsPlan {
  intents: LightIntent[];
  /** Set when nothing will be written, and why. */
  refused?: string;
}

/** A published number, or null if it is anything else. */
function numberFrom(values: PublishedValues, capabilityId: string): number | null {
  const value = values[capabilityId];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * What the two chosen devices want, right now.
 *
 * Both numbers come off the published values rather than being recomputed, and
 * that is deliberate: those are the same numbers the capability rows show and
 * the same ones a user could have dragged in as tags, so this card and the
 * hand-built Flow beside it cannot disagree about what "now" means. It also
 * means the brightness is already a device value, which is the axis a lamp
 * takes.
 */
export function settingsFrom(sources: SetLightsSources): LightSettings {
  const curve = sources.colour;
  const colourValues = curve?.publishedValues();

  return {
    brightness: sources.brightness
      ? numberFrom(sources.brightness.publishedValues(), VALUE_CAPABILITIES.brightness)
      : null,
    temperature: colourValues
      ? numberFrom(colourValues, VALUE_CAPABILITIES.temperature)
      : null,
    colour: curve?.currentValue()?.color ?? null,
  };
}

/**
 * The intents one pass is made of, in the order they are built.
 *
 * A colour and a colour temperature are never both sent: they are two ways of
 * saying the same thing to a lamp, and a lamp told both ends up wherever its
 * mode handling leaves it. The curve's own rule is the same one — a coloured
 * stretch colours the lamps that can, and the warmth exists for the lamps that
 * cannot (platform §12) — so the colour wins here, and the lamps with no colour
 * capability are the ones `planColor` skips rather than the ones it lies to.
 */
export function intentsFor(settings: LightSettings, power: PowerChoice): LightIntent[] {
  const intents: LightIntent[] = [];

  if (power === 'on') intents.push({ type: 'power', value: true });

  if (settings.colour) {
    intents.push({
      type: 'color_absolute',
      hue: settings.colour.hue,
      saturation: settings.colour.saturation,
    });
  } else if (settings.temperature !== null) {
    intents.push({ type: 'temperature_absolute', value: settings.temperature });
  }

  if (settings.brightness !== null) {
    intents.push({ type: 'brightness_absolute', value: settings.brightness });
  }

  return intents;
}

/**
 * The whole decision: what this card will do, or why it will do nothing.
 *
 * **Fail closed on a source that is not there.** A Flow card's arguments are as
 * untrusted as a bridge Flow's (CLAUDE.md): a device can be deleted, or simply
 * not running, while a Flow that names it still fires. Writing the half of the
 * settings that survived would be the worst outcome — a room lit at the right
 * brightness in last week's colour, with nothing saying so. A missing source
 * refuses the whole pass and names it.
 */
export function planSetLights(sources: SetLightsSources, power: PowerChoice): SetLightsPlan {
  if (sources.missing.length > 0) {
    return {
      intents: [],
      refused: `no running Lightkeeper device answers to ${sources.missing.join(', ')}`,
    };
  }

  const intents = intentsFor(settingsFrom(sources), power);
  if (intents.length === 0) {
    return {
      intents,
      refused: 'nothing was chosen to set, and the lights were not to be switched on',
    };
  }

  return { intents };
}

/**
 * The lights this pass may touch.
 *
 * The safety property the whole card rests on: **a lamp that is off is written
 * to only when "switch them on" was chosen.** It has to be enforced on the
 * TARGETS and not on the writes, because the write that would break it is a
 * `dim` — which carries no `onoff` of its own and turns the lamp on anyway.
 * Filtering planned writes instead would let exactly that one through.
 *
 * A lamp whose state is unknown counts as off. This runs after a live refresh,
 * so "unknown" means the lamp did not answer, and switching on a lamp nobody
 * asked to switch on is the failure worth avoiding.
 */
export function eligibleTargets(
  deviceIds: readonly string[],
  power: PowerChoice,
  isOn: (deviceId: string) => boolean,
): string[] {
  if (power === 'on') return [...deviceIds];
  return deviceIds.filter(isOn);
}
