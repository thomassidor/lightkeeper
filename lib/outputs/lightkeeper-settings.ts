import type { LightIntent } from './light-intent';
import { VALUE_CAPABILITIES, type PublishedValues } from '../runtime/published-values';

/**
 * "What do two other Lightkeeper devices want the lights to be, right now" —
 * the arithmetic of it, with no SDK and no Flow anywhere near.
 *
 * This was the middle of `lib/flow/set-lights.ts` and moved out when it got a
 * second caller. The `set_lights` Flow card composes a colour source and a
 * brightness source into one ordered write; the `lightkeeper_on` job on a Light
 * Remote's button composes exactly the same two, on a press. Two callers is the
 * bar this codebase sets for lifting something out, and the alternative was a
 * `lib/mapping` and a `lib/runtime` file importing from `lib/flow` — which would
 * have said the button was a kind of Flow card, and it is not.
 *
 * What stayed behind in `set-lights.ts` is what belongs to the CARD: the plan
 * shape it returns, the fail-closed refusal it reports as a card result, and
 * `eligibleTargets`, whose "only lights already on" rule is a promise the card
 * makes and the button deliberately does not (a button whose job is "on" is
 * always the `'on'` branch).
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

/**
 * The stored id that means "do not set this at all".
 *
 * One spelling for both callers, and that is load-bearing rather than tidy: it
 * is the `id` of the Flow card's top autocomplete row AND the value a button's
 * stored preset holds for an unset source, so a rule saved on one screen reads
 * the same to the other. A literal `'none'` written out in a second place is a
 * second thing to keep in step with this one.
 */
export const LEAVE_ALONE = 'none';

/** What a Lightkeeper runtime offers a composed pass. All three types have it. */
export interface ValueSource {
  publishedValues(): PublishedValues;
}

/**
 * A curve-driven runtime, which can also offer a colour.
 *
 * Read separately from the published values rather than out of them, because
 * what the board publishes is a NAME — one or two `palette.*` keys, for a row a
 * person reads — and a lamp takes a hue and a saturation. The board is
 * deliberately not the place to widen into a structure only this wants.
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

export interface ValueSources {
  colour: ColourSource | null;
  brightness: ValueSource | null;
  /** Ids the user chose that no live Lightkeeper device answers to. */
  missing: readonly string[];
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
 * the same ones a user could have dragged in as tags, so a card, a button and a
 * hand-built Flow cannot disagree about what "now" means. It also means the
 * brightness is already a device value, which is the axis a lamp takes.
 */
export function settingsFrom(sources: ValueSources): LightSettings {
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
 *
 * The ORDER matters to whoever executes these and is the reason they come back
 * as a list rather than one at a time: the switch first, then the colour, then
 * the level, so a single `scheduler.submit()` of all their writes together lets
 * `WRITE_ORDER` do the rest. Handed over one at a time they become three
 * bursts, which is exactly the stepping this exists to avoid.
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
 * Where a chosen id is looked up — the four runtime registries, named as the two
 * questions they answer rather than as four collections.
 *
 * An interface rather than the app itself, for the reason everything in `lib/`
 * is: `app.ts` extends `Homey.App` and no test can import it (platform §13).
 * The chains behind these two methods used to be two private methods on that
 * class, which is why the rule they encode — a colour comes only from a
 * curve-driven device, a brightness from a curve, a schedule or a Room-sensing
 * Light — had no test at all.
 */
export interface SourceRegistry {
  colour(id: string): ColourSource | undefined;
  brightness(id: string): ValueSource | undefined;
}

/**
 * Two chosen ids, as the two sources they name — or as an entry in `missing`.
 *
 * A chosen id that no live runtime answers to is pushed onto `missing` rather
 * than quietly treated as "leave alone". The two callers then do different
 * things with that, and both are right: the Flow card refuses the whole pass,
 * because half a set of settings written to a room is the worst outcome and
 * nothing would report it; a button falls back to plain "on", because a button
 * press that does nothing at all is worse still and the lights coming on is
 * what the button was for. What they must not do is differ about what counts as
 * missing, which is why the reading is here.
 */
export function resolveSources(
  registry: SourceRegistry,
  colourId: unknown,
  brightnessId: unknown,
): ValueSources {
  const missing: string[] = [];

  const lookup = <T>(id: unknown, get: (id: string) => T | undefined): T | null => {
    if (typeof id !== 'string' || id === LEAVE_ALONE || id.length === 0) return null;
    const found = get(id);
    if (!found) { missing.push(id); return null; }
    return found;
  };

  return {
    colour: lookup(colourId, id => registry.colour(id)),
    brightness: lookup(brightnessId, id => registry.brightness(id)),
    missing,
  };
}
