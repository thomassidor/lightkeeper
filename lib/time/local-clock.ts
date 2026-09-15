import { MINUTES_PER_DAY } from './wall-clock';
import type { IsoWeekday } from '../schedules/schedule-types';

/**
 * The Homey's own wall clock, reduced to the only two facts a schedule needs.
 *
 * The SDK gives exactly one timezone primitive — `homey.clock.getTimezone()`,
 * synchronous, an IANA name, no permission required — and nothing else. There is
 * no cron manager in SDK v3 and no sunrise/sunset helper, so everything below is
 * ours.
 *
 * Deliberately NOT here: any conversion from a wall-clock time to an absolute
 * instant. That is the code that DST breaks (a local time that does not exist,
 * or exists twice), and because the Flow engine owns firing we never need it.
 *
 * It lives under `lib/time/` rather than `lib/schedules/` because the circadian
 * runtime reads it too, and its import used to carry an apology for the
 * location. The apology is retired.
 */

export interface LocalClock {
  /** Minutes since local midnight, 0–1439. */
  minutesOfDay: number;
  /** ISO 8601: 1 = Monday … 7 = Sunday. */
  isoWeekday: IsoWeekday;
}

const ISO_WEEKDAY: Record<string, IsoWeekday> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/**
 * Formatted with a FIXED 'en-US' locale, never the Homey's language: the only
 * consumers are the lookup table above and two integers, so a localised weekday
 * name would be a bug that only appears on someone else's Homey.
 */
export function localNow(timezone: string | undefined, nowMs: number): LocalClock {
  return localNowResolved(timezone, nowMs).clock;
}

/**
 * One `Intl.DateTimeFormat` per timezone, reused.
 *
 * Constructing one is not a plain object allocation: it builds an ICU formatter
 * in ICU's own native arenas, which is memory `v8.getHeapStatistics()` cannot
 * see and a heap profile will never show. This function is called from both 60 s
 * tick paths and from four places in `app.ts` and `api.ts`, so the old
 * construct-per-call was allocating off-heap on a timer for the life of the app.
 *
 * The map is bounded by the number of distinct timezone strings a Homey reports,
 * which is one — it changes only if the household moves — so this is a memo, not
 * a cache that needs eviction. An unusable timezone never reaches here: the
 * caller's `try` catches the construction throw exactly as before, and a
 * rejected string is simply never memoised.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The same clock, plus whether the Homey's own timezone was actually used.
 *
 * The fallback below is right for a circadian light — a curve an hour out is
 * still a curve, and refusing to run would be worse. It is NOT right for a
 * schedule: the generated Flows fire on the HOMEY's clock, so a day check run
 * against a different clock refuses legitimate boundaries around midnight, and a
 * wrong-DAY refusal means a window that simply never happens. So the two callers
 * need different answers to "did that work", and this is where they get it.
 */
export function localNowResolved(
  timezone: string | undefined,
  nowMs: number,
): { clock: LocalClock; resolved: boolean } {
  if (timezone) {
    try {
      const parts = formatterFor(timezone).formatToParts(new Date(nowMs));

      const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
      const hour = Number(parts.find(p => p.type === 'hour')?.value);
      const minute = Number(parts.find(p => p.type === 'minute')?.value);
      const isoWeekday = ISO_WEEKDAY[weekday];

      if (isoWeekday && Number.isFinite(hour) && Number.isFinite(minute)) {
        return {
          clock: {
            // Some ICU builds render midnight as hour 24 under hour12: false.
            minutesOfDay: ((hour % 24) * 60 + minute) % MINUTES_PER_DAY,
            isoWeekday,
          },
          resolved: true,
        };
      }
    } catch {
      // An unknown zone, or an ICU build without timezone data. Falling through
      // to process-local time is right for a Homey Pro, which runs in the
      // household's own zone anyway — and a schedule an hour out beats a
      // schedule that throws on every event.
    }
  }

  const local = new Date(nowMs);
  return {
    clock: {
      minutesOfDay: local.getHours() * 60 + local.getMinutes(),
      isoWeekday: fromJsDay(local.getDay()),
    },
    resolved: false,
  };
}

/** JavaScript counts Sunday as 0; ISO counts it as 7. */
export function fromJsDay(day: number): IsoWeekday {
  return (day === 0 ? 7 : day) as IsoWeekday;
}

export function previousWeekday(day: IsoWeekday): IsoWeekday {
  return (day === 1 ? 7 : day - 1) as IsoWeekday;
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** English, for diagnostics and logs only — never for a device's status text. */
export function describeClock(clock: LocalClock): string {
  const hours = Math.floor(clock.minutesOfDay / 60);
  const minutes = clock.minutesOfDay % 60;
  return `${WEEKDAY_NAMES[clock.isoWeekday - 1]} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * The Homey's own timezone, or `undefined` — the one place that asks.
 *
 * `homey.clock.getTimezone()` is the SDK's only timezone primitive and every
 * schedule and curve decision is made against it. Three things make this worth
 * a function rather than three try/catches:
 *
 *  - **It is read per call, never cached.** A household that corrects its
 *    Homey's timezone must not have to restart the app for a schedule to start
 *    firing at the right hour.
 *  - **`clock` can be absent.** Optional-chained rather than assumed, because a
 *    pair-session rig has no Homey behind it and `getTimezone` has been
 *    observed to throw on a Homey that has not resolved its own location yet.
 *  - **`undefined` rather than a guess.** Every consumer already refuses to act
 *    on an untrusted clock — `localNowResolved()` below is that refusal — and a
 *    default of UTC would silently fire a 22:00 window at 23:00 or 00:00, which
 *    is the worst possible way to be wrong about a schedule.
 *
 * It was three copies: two in `app.ts` and one, returning `null` instead of
 * `undefined`, in `pair-session.ts`.
 */
export function timezoneOf(
  clock: { getTimezone(): string } | undefined | null,
): string | undefined {
  try {
    return clock?.getTimezone() ?? undefined;
  } catch {
    return undefined;
  }
}
