/**
 * Wall-clock minutes: the one representation of time this app uses.
 *
 * Everything about time here is a MINUTE COUNT since local midnight, 0–1439 —
 * never a timestamp and never a UTC offset. That is not laziness. Because the
 * Flow engine owns firing (platform §9), the app never has to answer "when is
 * the next 22:00 in Europe/Copenhagen", only "is it 22:00 there now". A minute
 * count is exactly that question's shape, and it is immune to every DST bug that
 * absolute-instant arithmetic invites.
 *
 * It lived twice — once in `schedule-types.ts`, once in `circadian-types.ts` —
 * as byte-identical copies. Two copies of a parser is two chances for a
 * schedule screen and a curve screen to disagree about what "7:30" means, which
 * is precisely the kind of thing nobody would ever think to test.
 */

export const MINUTES_PER_DAY = 1440;

/** 'HH:MM', for flow arguments, labels, diagnostics and the pairing screens. */
export function formatMinutes(minutes: number): string {
  const wrapped = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * 'HH:MM' → minutes since midnight, or null if it is not a time of day.
 *
 * A number is accepted too, because a view that has already parsed its own
 * input sends one — but it is range-checked rather than wrapped: a caller who
 * sends 1500 has a bug, and silently reading it as 01:00 the next day hides it.
 * `formatMinutes` wraps because an off-time past midnight is computed by
 * addition; this does not, because nothing computes an input.
 */
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
