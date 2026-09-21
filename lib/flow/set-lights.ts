import type { LightIntent } from '../outputs/light-intent';
import {
  intentsFor, settingsFrom, type PowerChoice, type ValueSources,
} from '../outputs/lightkeeper-settings';

/**
 * "Set these lights the way Lightkeeper would" — the CARD's own decisions, with
 * no SDK anywhere near.
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
 * **That composition is no longer here**: it is
 * `lib/outputs/lightkeeper-settings.ts`, because a Light Remote's
 * `lightkeeper_on` button job needs the same two sources read the same way, and
 * a `lib/mapping` file importing from `lib/flow` would have said a button was a
 * kind of Flow card. What is left below is what belongs to the card and to
 * nothing else — the plan shape it reports as a card result, the fail-closed
 * refusal, and the "only lights already on" rule. The lifted names are
 * re-exported so a caller that wants the card's whole vocabulary still has one
 * import.
 *
 * `app.ts` holds the shell only, exactly as it does for the bridge cards: it
 * extends `Homey.App` and cannot be imported by a test (platform §13), so every
 * decision below lives where one can reach it.
 */

export {
  LEAVE_ALONE, isPowerChoice, intentsFor, settingsFrom, resolveSources,
} from '../outputs/lightkeeper-settings';
export type {
  PowerChoice, ValueSource, ColourSource, LightSettings, ValueSources, SourceRegistry,
} from '../outputs/lightkeeper-settings';

export interface SetLightsPlan {
  intents: LightIntent[];
  /** Set when nothing will be written, and why. */
  refused?: string;
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
 *
 * A button carrying the same two sources deliberately does NOT refuse — it falls
 * back to plain "on" — and the difference is the situation rather than the rule.
 * A Flow reports a false result somewhere a user can read it; a button press
 * reports nothing at all, so doing nothing is indistinguishable from a broken
 * remote. See `resolveSources`, which both go through.
 */
export function planSetLights(sources: ValueSources, power: PowerChoice): SetLightsPlan {
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
