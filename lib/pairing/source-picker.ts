import { colourSwatch, warmthSwatch } from './flow-screens';
import { toPerceptual } from '../outputs/light-intent';
import { LEAVE_ALONE } from '../outputs/lightkeeper-settings';
import { VALUE_CAPABILITIES, type PublishedValues } from '../runtime/published-values';

/**
 * What the two "take it from" screens offer, and what each row says.
 *
 * The pushed picker behind a `lightkeeper_on` button: one screen, two
 * questions, keyed on which one the driver reports. It is here rather than in
 * `driver.ts` for the reason every other pairing DECISION is (platform §13) —
 * and because the two rules below are the kind that look obvious and are not.
 *
 * Nothing here translates. Every user-visible word arrives as an argument.
 */

export type SourceKind = 'colour' | 'brightness';

export function isSourceKind(value: unknown): value is SourceKind {
  return value === 'colour' || value === 'brightness';
}

/** One Lightkeeper device, as the picker is given it. */
export interface SourceDevice {
  id: string;
  name: string;
  /** The device's own driver name and room. Empty when the catalogue has neither. */
  subtitle: string;
  /** Whatever that device is publishing right now. */
  values: PublishedValues;
  /**
   * A curve-driven device's live value, for the colour list only.
   *
   * The published board carries the colour as a NAME — one or two `palette.*`
   * keys — which cannot be painted, so the hue and saturation are read from the
   * runtime the same way `set_lights` reads them.
   */
  current?: { warmth: number; color?: { hue: number; saturation: number } } | null;
  /**
   * Whether that device drives its OWN lights all day, rather than only
   * publishing (lib/runtime/writes-lights.ts). Absent reads as no, because the
   * warning below is the only thing it feeds and a warning must be earned.
   */
  keepsLightsUpdated?: boolean;
  /** How many of THIS button's lamps that device also drives. See `sharedLightCount`. */
  sharedLights?: number;
}

/** One row, as the screen draws it. */
export interface SourceRow {
  id: string;
  name: string;
  subtitle: string;
  /** Colour list only: a CSS colour, or null where the device has nothing to show yet. */
  swatch?: string | null;
  /** Brightness list only: PERCEPTUAL 0–1, or null where nothing is being called for. */
  level?: number | null;
  /**
   * Present when this source keeps its own lights up to date, which makes
   * "On – with Lightkeeper" a second writer wherever the two share a lamp.
   * `sharedLights` is how many of this button's lamps that is; zero still
   * warns, more softly, because the device is writing to lamps all the same.
   */
  warn?: { sharedLights: number };
}

/**
 * How many of a button's lamps another device drives too, counting a Homey
 * device group as the lamps inside it.
 *
 * Groups are the reason this is more than a set intersection. The case it was
 * written for had the remote on "Ceiling Lamp" — a group of three spots — and
 * the Colour Curve Light on the three spots themselves: no id in common, and
 * every one of those bulbs written by both at every switch-on. Expanded on BOTH
 * sides, because the source may be the one holding the group.
 *
 * Counted in the BUTTON's lamps, since that is what the warning is about: "3 of
 * these lights". A group counts once for each member it shares.
 */
export function sharedLightCount(
  buttonLights: readonly string[],
  sourceLights: readonly string[],
  membersOf: (id: string) => readonly string[] | undefined,
): number {
  const expand = (ids: readonly string[]) => ids.flatMap(id => membersOf(id) ?? [id]);
  const driven = new Set(expand(sourceLights));
  return new Set(expand(buttonLights).filter(id => driven.has(id))).size;
}

/**
 * The level a brightness source is calling for, as a PERCEPTUAL fraction.
 *
 * `lightkeeper_brightness` is published as a DEVICE value — the axis a lamp is
 * addressed on, through γ = 2.2 — and every percentage anywhere in pairing is
 * perceptual: the job screen's own brightness slider, the curve editor, the
 * daylight response. Drawing the raw published number as "%" beside them would
 * put two different axes under one sign, so somebody who set a curve to 40%
 * would find this screen reporting 13% for the same device and have no way at
 * all to tell which was lying.
 */
export function sourceLevel(values: PublishedValues): number | null {
  const value = values[VALUE_CAPABILITIES.brightness];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return toPerceptual(value);
}

/**
 * What a colour source is producing now — a colour, a warmth, or nothing.
 *
 * The same order the curve itself resolves in and the same one `intentsFor`
 * writes in: a coloured stretch of the curve wins, and the warmth is what the
 * lamps that cannot take a colour get (platform §12). A device between plans, or
 * one whose timezone has not resolved, has neither and gets no swatch rather
 * than a default one — a grey dot that means "not running" is honest, and a
 * warm dot that means it would be a guess about what the lamps would do.
 *
 * Returned as a discriminated shape rather than as a CSS string because `lib/`
 * must not decide how a swatch is painted twice: `colourSwatch()` and
 * `warmthSwatch()` in `flow-screens.ts` already do that, and the caller picks
 * between them.
 */
export function sourceColour(
  values: PublishedValues,
  current: { warmth: number; color?: { hue: number; saturation: number } } | null | undefined,
): { colour: { hue: number; saturation: number } } | { warmth: number } | null {
  if (current?.color) return { colour: current.color };
  if (current && Number.isFinite(current.warmth)) return { warmth: current.warmth };

  // The board as the fallback, for a runtime that has published a warmth but
  // cannot answer `currentValue()` — a schedule's window, or a curve caught
  // between a plan change and its first tick.
  const published = values[VALUE_CAPABILITIES.temperature];
  if (typeof published === 'number' && Number.isFinite(published)) return { warmth: published };

  return null;
}

/**
 * A colour source's swatch, painted the way every other swatch in this app is.
 *
 * `colourSwatch()` and `warmthSwatch()` rather than a third set of curves — the
 * curve editor already carries a second copy of the first one, and its docblock
 * says why that is a cost rather than a pattern. This screen draws its rows once
 * per open, so it can simply ask.
 */
function paintSwatch(device: SourceDevice): string | null {
  const showing = sourceColour(device.values, device.current);
  if (showing === null) return null;
  return 'colour' in showing ? colourSwatch(showing.colour) : warmthSwatch(showing.warmth);
}

/**
 * Every offer for one of the two screens, "leave it alone" first.
 *
 * At the top rather than the bottom because it is the answer for half the
 * buttons this job will be used on — somebody who wants the level to follow the
 * room and the colour left to the lamps is choosing one source, not two. That is
 * where `sourceChoices()` puts it in the Flow card's autocompletes, and the two
 * screens asking the same question should not disagree about the order.
 *
 * Sorted by name, and the leave-alone row is exempt from the sort rather than
 * sorted to the top by a name it happens to start with — a translated label
 * would land somewhere else in the list the first time this app had a second
 * language, which is precisely the kind of thing `docs/localisation.md` exists
 * to keep possible.
 */
export function sourceRows(
  kind: SourceKind,
  devices: readonly SourceDevice[],
  leaveAlone: { name: string; subtitle: string },
): SourceRow[] {
  const rows: SourceRow[] = [...devices]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(device => ({
      id: device.id,
      name: device.name,
      subtitle: device.subtitle,
      ...(kind === 'brightness'
        ? { level: sourceLevel(device.values) }
        : { swatch: paintSwatch(device) }),
      ...(device.keepsLightsUpdated === true
        ? { warn: { sharedLights: device.sharedLights ?? 0 } }
        : {}),
    }));

  return [{ id: LEAVE_ALONE, name: leaveAlone.name, subtitle: leaveAlone.subtitle }, ...rows];
}
