import type { TargetSpec } from '../outputs/light-intent';
import type { ManagedFlowReference } from '../profiles/controller-profile';

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

export const MINUTES_PER_DAY = 1440;

/**
 * Two flows per schedule, so twelve schedules is twenty-four generated Flows.
 * Past that the user's Flow list stops being readable, which is the same
 * reasoning as RANGE_EXPANSION_CEILING in the flow compiler.
 */
export const MAX_ENTRIES = 12;

export const MIN_DURATION_MINUTES = 1;
/** A window of a full day would never switch anything off. */
export const MAX_DURATION_MINUTES = MINUTES_PER_DAY - 1;

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
  /** Normalised colour temperature 0–1, 0 being the warmest (§6). */
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

/** 'HH:MM', for flow arguments, labels and the pairing screen alike. */
export function formatMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/** 'HH:MM' → minutes since midnight, or null if it is not a time. */
export function parseMinutes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return rounded >= 0 && rounded < MINUTES_PER_DAY ? rounded : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
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
    if (days !== null && days.length === 0) return drop('no days are selected');

    const end = sanitiseEnd(source.end, onAt);
    if (typeof end === 'string') return drop(end);

    const id = typeof source.id === 'string' && source.id.trim() !== ''
      ? source.id.trim()
      : `s${index}`;
    if (entries.some(e => e.id === id)) return drop(`duplicate schedule id "${id}"`);

    const brightness = sanitiseUnit(source.brightness);
    const temperature = sanitiseUnit(source.temperature);

    entries.push({
      id,
      onAt,
      days,
      end,
      // A brightness of 0 would be "on, at nothing"; treat it as unset rather
      // than writing a lamp to zero and calling it lit.
      ...(brightness !== null && brightness > 0 ? { brightness } : {}),
      ...(temperature !== null ? { temperature } : {}),
    });
  });

  return { entries, dropped };
}

function sanitiseDays(raw: unknown): IsoWeekday[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;

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

function sanitiseUnit(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}
