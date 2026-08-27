import { randomUUID } from 'node:crypto';

import type { TargetSpec } from '../outputs/light-intent';
import type { ManagedFlowReference } from '../profiles/controller-profile';
import { MINUTES_PER_DAY, formatMinutes, parseMinutes } from '../time/wall-clock';
import { sanitiseUnitInterval } from '../validation/unit-interval';
import { entriesOverlap } from './schedule-window';

// Re-exported because half the app imports these from here, and because the
// minute-count contract below is the reason they exist. See lib/time/wall-clock.
export { MINUTES_PER_DAY, formatMinutes, parseMinutes };

/**
 * What a light schedule is, as persisted in its virtual device's store.
 *
 * Everything about time here is a WALL-CLOCK MINUTE COUNT — minutes since local
 * midnight, 0–1439 — never a timestamp and never a UTC offset. That is not
 * laziness: the Flow engine owns firing (see lib/schedules/schedule-bindings.ts),
 * so the app never has to answer "when is the next 22:00 in Europe/Copenhagen",
 * only "is it 22:00 there now, and is today a day this schedule runs". A minute
 * count is exactly that question's shape, and it is immune to every DST bug that
 * absolute-instant arithmetic invites.
 */

/**
 * Two flows per schedule, so twelve schedules is twenty-four generated Flows.
 * Past that the user's Flow list stops being readable, which is the same
 * reasoning as RANGE_EXPANSION_CEILING in the flow compiler.
 */
export const MAX_ENTRIES = 12;

const MIN_DURATION_MINUTES = 1;
/** A window of a full day would never switch anything off. */
const MAX_DURATION_MINUTES = MINUTES_PER_DAY - 1;

/** ISO 8601 weekday numbering: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const ALL_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7] as const;

/** Which end of a schedule's window an event refers to. */
export type ScheduleBoundary = 'on' | 'off';

export type ScheduleEnd =
  /** Elapsed minutes after the on-time. Compiled into a computed off-time. */
  | { kind: 'duration'; minutes: number }
  /** An absolute wall-clock minute. Earlier than the on-time means "tomorrow". */
  | { kind: 'time'; at: number };

export interface ScheduleEntry {
  id: string;
  /** Minutes since local midnight. */
  onAt: number;
  /** Which days it starts on. null means every day. */
  days: IsoWeekday[] | null;
  end: ScheduleEnd;
  /**
   * Perceptual brightness 0–1, converted with toDevice() at plan time so "40%"
   * means 40% of PERCEIVED brightness — the same axis the dimming gestures use.
   * Absent = leave brightness alone and only switch on.
   */
  brightness?: number;
  /** Normalised colour temperature 0–1, where 1 is the WARMEST end (platform §6). */
  temperature?: number;
}

export interface SchedulePlan {
  schemaVersion: number;
  /** The device's onoff capability: false = paused, flows stay, nothing fires. */
  enabled: boolean;
  target: TargetSpec;
  entries: ScheduleEntry[];
  managedFlows: ManagedFlowReference[];
}

/**
 * Everything a schedule screen can send is untrusted, the same way generated
 * flow arguments are: it arrives from a webview over the pairing channel, and a
 * half-filled row must not become a schedule that fires at 00:00 every day.
 * Invalid entries are DROPPED and named, never silently repaired into something
 * the user did not ask for.
 */
export function sanitiseEntries(
  raw: unknown,
): { entries: ScheduleEntry[]; dropped: Array<{ index: number; reason: string }> } {
  const entries: ScheduleEntry[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];
  const list = Array.isArray(raw) ? raw : [];

  list.forEach((candidate, index) => {
    const drop = (reason: string) => dropped.push({ index, reason });

    if (!candidate || typeof candidate !== 'object') return drop('not an object');
    if (entries.length >= MAX_ENTRIES) return drop(`over the limit of ${MAX_ENTRIES} schedules`);

    const source = candidate as Record<string, unknown>;
    const onAt = parseMinutes(source.onAt);
    if (onAt === null) return drop('the on-time is not a time of day');

    const days = sanitiseDays(source.days);
    if (days === 'invalid') return drop('days is not a list');
    if (days !== null && days.length === 0) return drop('no days are selected');

    const end = sanitiseEnd(source.end, onAt);
    if (typeof end === 'string') return drop(end);

    const id = sanitiseEntryId(source.id);
    if (entries.some(e => e.id === id)) return drop(`duplicate schedule id "${id}"`);

    const brightness = sanitiseUnit(source.brightness);
    const temperature = sanitiseUnit(source.temperature);

    const entry: ScheduleEntry = {
      id,
      onAt,
      days,
      end,
      // A brightness of 0 would be "on, at nothing"; treat it as unset rather
      // than writing a lamp to zero and calling it lit.
      ...(brightness !== null && brightness > 0 ? { brightness } : {}),
      ...(temperature !== null ? { temperature } : {}),
    };

    /**
     * Two windows over the same lights fight: the one that ends first switches
     * them off while the other still believes them on, and no screen in the app
     * admits to it. Refusing at save is the honest half of the fix — the runtime
     * handles the pairs that earlier versions already stored.
     *
     * The LATER row is the one dropped, because the earlier one is the one the
     * user can already see working.
     */
    const clash = entries.find(existing => entriesOverlap(existing, entry));
    if (clash) return drop(`overlaps schedule "${clash.id}"`);

    entries.push(entry);
  });

  return { entries, dropped };
}

/**
 * The pattern a schedule entry id must match.
 *
 * Load-bearing rather than cosmetic: the id goes into `sched:<id>:<boundary>`,
 * which is a generated Flow's `event_key` argument, and `parseEventKey` splits it
 * on `:`. An id containing a colon parses as a different entry — or as nothing —
 * so a schedule the user could see would silently never fire.
 */
export const ENTRY_ID_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Ids are SERVER-generated. A client-sent id is honoured only if it round-trips
 * through repair intact and matches the shape above; anything else gets a fresh
 * one, and because the binding key changes with it, the Flow lifecycle replaces
 * that entry's Flows cleanly rather than leaving a pair that can never fire.
 */
export function sanitiseEntryId(raw: unknown): string {
  const candidate = typeof raw === 'string' ? raw.trim() : '';
  if (ENTRY_ID_SHAPE.test(candidate)) return candidate;
  return `s${randomUUID().slice(0, 8)}`;
}

/**
 * `null` for "every day" — and ONLY for the two values that mean it.
 *
 * Anything else non-array used to become `null` too, so a string, an object or a
 * `false` sent by a half-broken view turned a Mon–Fri schedule into a
 * seven-day one. That is the opposite of failing closed: it does MORE than the
 * user asked for. Now it is 'invalid', and the caller drops the entry with a
 * reason the pairing screen already knows how to show.
 */
function sanitiseDays(raw: unknown): IsoWeekday[] | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return 'invalid';

  const days = [...new Set(raw.map(Number))]
    .filter((day): day is IsoWeekday => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);

  // Every day IS the null case. Collapsing it keeps one representation of one
  // meaning, so labels and comparisons do not have to handle both.
  if (days.length === 7) return null;
  return days;
}

/** Returns the end, or a reason string explaining why there is not one. */
function sanitiseEnd(raw: unknown, onAt: number): ScheduleEnd | string {
  if (!raw || typeof raw !== 'object') return 'the off-time is missing';
  const source = raw as Record<string, unknown>;

  if (source.kind === 'duration') {
    const minutes = Number(source.minutes);
    if (!Number.isFinite(minutes)) return 'the duration is not a number';
    const rounded = Math.round(minutes);
    if (rounded < MIN_DURATION_MINUTES) return 'the duration is shorter than a minute';
    if (rounded > MAX_DURATION_MINUTES) return 'the duration is a day or longer';
    return { kind: 'duration', minutes: rounded };
  }

  if (source.kind === 'time') {
    const at = parseMinutes(source.at);
    if (at === null) return 'the off-time is not a time of day';
    // Equal times would mean a zero-length window, or a 24-hour one — either
    // way the user cannot have meant it.
    if (at === onAt) return 'the off-time is the same as the on-time';
    return { kind: 'time', at };
  }

  return 'the off-time is neither a duration nor a time';
}

/** See lib/validation/unit-interval.ts. "0 means unset" is this file's policy. */
const sanitiseUnit = sanitiseUnitInterval;
