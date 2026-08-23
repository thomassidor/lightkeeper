import { MINUTES_PER_DAY, type IsoWeekday } from './schedule-types';

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
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(nowMs));

      const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
      const hour = Number(parts.find(p => p.type === 'hour')?.value);
      const minute = Number(parts.find(p => p.type === 'minute')?.value);
      const isoWeekday = ISO_WEEKDAY[weekday];

      if (isoWeekday && Number.isFinite(hour) && Number.isFinite(minute)) {
        return {
          // Some ICU builds render midnight as hour 24 under hour12: false.
          minutesOfDay: ((hour % 24) * 60 + minute) % MINUTES_PER_DAY,
          isoWeekday,
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
    minutesOfDay: local.getHours() * 60 + local.getMinutes(),
    isoWeekday: fromJsDay(local.getDay()),
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
