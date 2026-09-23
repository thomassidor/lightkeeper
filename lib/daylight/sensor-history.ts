import { localNow } from '../time/local-clock';
import { LUMINANCE_CAPABILITY, MAX_LUX, MIN_LUX, SENSOR_STALE_MS } from './daylight-types';
import type { IsoWeekday } from '../schedules/schedule-types';

/**
 * A light sensor's own last week, bucketed into the grid the pairing screen
 * draws — and the two lux numbers derived from it.
 *
 * **Why this exists at all.** `brightLux = 500` suits a south-facing kitchen and
 * almost nothing else: of the two live sensors measured in one house
 * (platform §16), one reaches 1278 lx and the other tops out at 164 with a p95
 * of 64.5. A response spanning 5 → 500 in the second room sits near its dark end
 * all day, holds the lamps near full, and reads as "this feature does nothing".
 * The defaults cannot be right for both rooms, and the sensor's own history is
 * available at pairing time — so the thresholds are pre-filled from the room
 * that will actually be measured rather than from a guess.
 *
 * The grid is also the EVIDENCE for those two numbers. Nobody can judge
 * "under 8 lx" in the abstract; anybody can judge it against a week that
 * visibly has a night and a day in it. The same picture is what makes the two
 * refusals honest — a cupboard sensor that reports faithfully and says nothing,
 * and a sensor that stopped on Saturday lunchtime — because in both cases the
 * grid shows it in one glance and no wording has to be trusted.
 *
 * **Everything below the reader is pure.** `readSensorWeek` is the one function
 * that touches Homey; `bucketWeek` and everything under it take samples and a
 * timezone and return numbers, for the same reason `solar-elevation.ts` is pure:
 * it is arithmetic whose correctness has to be checkable without a Homey.
 */

/** Two-hour buckets: 84 cells stay legible at 390px where 168 do not. */
export const BUCKET_MINUTES = 120;
export const COLUMNS = (24 * 60) / BUCKET_MINUTES;
export const ROWS = 7;

/**
 * Half a day of silence, not an hour.
 *
 * A still room legitimately goes quiet for hours — many Zigbee sensors report
 * only on change, which is why a reading is never treated as stale anywhere
 * else in this app (platform §16). But a sensor that has said nothing for half a
 * day has almost certainly stopped, and a stopped sensor holds the lights at one
 * brightness for ever. That is the one warning worth keeping inside pairing.
 *
 * It IS `SENSOR_STALE_MS`, not a second copy of the same twelve hours. The
 * response screen decides "quiet" from this week's verdict and from the live
 * reading's age together, and two thresholds would let the grid call a sensor
 * stopped while the card above it said nothing.
 */
export const SILENT_MS = SENSOR_STALE_MS;

/** One reading, as Homey's Insights hands it over. */
export interface HistorySample {
  /** Epoch milliseconds. */
  t: number;
  /** Lux. */
  v: number;
}

export type WeekVerdict =
  /** A night and a day, far enough apart to place two thresholds between. */
  | { kind: 'usable'; nightLux: number; noonLux: number }
  /** It reports faithfully and tells you nothing. */
  | { kind: 'flat'; low: number; high: number }
  /** It reported, and then stopped. */
  | { kind: 'stopped'; lastAt: number }
  /** Nothing at all in the window. */
  | { kind: 'nothing' };

export interface SensorWeek {
  /**
   * `ROWS` local days, oldest first, each `COLUMNS` two-hour buckets. A cell is
   * the mean lux reported in it, or `null` for a bucket nothing reported in.
   *
   * `null` is drawn hatched rather than dark, and that is not decoration: a gap
   * has to read as "no reading", never as "pitch dark". The sensor that stopped
   * on Saturday lunchtime is the case it was written for.
   */
  cells: (number | null)[][];
  /** Which weekday each row is, so a row can be labelled with the truth. */
  days: IsoWeekday[];
  /** How many of the `ROWS * COLUMNS` buckets carry a reading. */
  covered: number;
  /** The 5th and 95th percentile over every sample — the scale the grid is drawn on. */
  low: number;
  high: number;
  /** When the newest sample arrived, or null if there were none. */
  lastAt: number | null;
  verdict: WeekVerdict;
  /**
   * What to pre-fill the two thresholds with, or null when the week cannot
   * support a recommendation. Always `brightLux > darkLux`: a zero-width span is
   * a division by zero dressed up as a preference, and `sanitiseResponse` throws
   * BOTH values away when it sees one.
   *
   * Offered for a FLAT or STOPPED week too, not only a usable one. Picking such
   * a sensor used to route through a screen of its own ("A sensor not worth
   * using", "Sensor has gone quiet") with "Use it anyway" as one way out; the
   * 2026-09-23 design folds both into the response step, where Next IS "use it
   * anyway" — and a person who does that deserves thresholds from the week they
   * were just shown, not the defaults from a house that is not theirs.
   */
  suggestion: { darkLux: number; brightLux: number } | null;
}

/** Night is 22:00–06:00 and the middle of the day 10:00–16:00, as bucket indices. */
const NIGHT_COLUMNS = [0, 1, 2, 11];
const NOON_COLUMNS = [5, 6, 7];

/**
 * The whole grid, from raw samples.
 *
 * `nowMs` rather than `Date.now()` so a test can place a week wherever it likes,
 * and `timezone` because the rows are local days and the columns local hours — a
 * grid bucketed in UTC would draw a Danish night straddling two rows.
 */
export function bucketWeek(
  samples: readonly HistorySample[],
  timezone: string | undefined,
  nowMs: number,
): SensorWeek {
  const cells: (number | null)[][] = [];
  const sums: number[][] = [];
  const counts: number[][] = [];
  for (let row = 0; row < ROWS; row++) {
    cells.push(new Array<number | null>(COLUMNS).fill(null));
    sums.push(new Array<number>(COLUMNS).fill(0));
    counts.push(new Array<number>(COLUMNS).fill(0));
  }

  const days: IsoWeekday[] = [];
  for (let row = 0; row < ROWS; row++) {
    // Row 0 is the oldest of the seven; the last row is today. Walked the same
    // way `rowFor` files samples — see `weekdayOfRow`, which is the whole point.
    days.push(weekdayOfRow(ROWS - 1 - row, timezone, nowMs));
  }

  const usable: number[] = [];
  let lastAt: number | null = null;

  for (const sample of samples) {
    if (!Number.isFinite(sample.t) || !Number.isFinite(sample.v)) continue;
    // Negative is not a reading, and above MAX_LUX is a sensor reporting
    // something that is not lux.
    if (sample.v < 0 || sample.v > MAX_LUX) continue;

    const row = rowFor(sample.t, timezone, nowMs);
    if (row === null) continue;
    const column = Math.min(
      COLUMNS - 1,
      Math.floor(localNow(timezone, sample.t).minutesOfDay / BUCKET_MINUTES),
    );

    sums[row]![column]! += sample.v;
    counts[row]![column]! += 1;
    usable.push(sample.v);
    if (lastAt === null || sample.t > lastAt) lastAt = sample.t;
  }

  let covered = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const n = counts[row]![column]!;
      if (n === 0) continue;
      cells[row]![column] = sums[row]![column]! / n;
      covered += 1;
    }
  }

  const sorted = [...usable].sort((a, b) => a - b);
  const low = sorted.length > 0 ? percentile(sorted, 0.05) : 0;
  const high = sorted.length > 0 ? percentile(sorted, 0.95) : 0;

  const verdict = judge(cells, sorted, low, high, lastAt, nowMs);
  return { cells, days, covered, low, high, lastAt, verdict, suggestion: suggest(verdict, cells, low, high) };
}

/**
 * Which row a sample belongs in, or null if it falls outside the seven days.
 *
 * Both instants are reduced to their own local midnight before the subtraction,
 * and the result is ROUNDED rather than floored: a clock change inside the week
 * makes one of the differences 23 or 25 hours, and flooring would silently shift
 * every row before the change by one.
 */
function rowFor(sampleMs: number, timezone: string | undefined, nowMs: number): number | null {
  const back = Math.round((localMidnight(timezone, nowMs) - localMidnight(timezone, sampleMs))
    / 86_400_000);
  if (!Number.isFinite(back) || back < 0 || back > ROWS - 1) return null;
  return ROWS - 1 - back;
}

/** The instant local midnight began, for the local day containing `ms`. */
function localMidnight(timezone: string | undefined, ms: number): number {
  return ms - localNow(timezone, ms).minutesOfDay * 60_000;
}

/**
 * The weekday to write on a row, derived the way the row is FILLED.
 *
 * This used to be `localNow(timezone, nowMs - back * 86_400_000).isoWeekday` — a
 * rigid 24 hours per step, while `rowFor` above deliberately goes via local
 * midnights precisely because "a clock change inside the week makes one of the
 * differences 23 or 25 hours". The two disagreed across every DST transition.
 *
 * Worked, Europe/Copenhagen, now Monday 31 March 2025 00:30 local: the
 * spring-forward Sunday was 23 hours long, so `nowMs - 86_400_000` lands on
 * SATURDAY 23:30 — and the row that `rowFor` fills with Sunday's samples was
 * labelled Sat, along with every row before the transition. Twice a year, on the
 * grid that exists to be the evidence for the two lux thresholds.
 *
 * Noon of the target local day, because a day that is 23 or 25 hours long still
 * unambiguously contains its own midday, while its midnight is exactly the
 * instant the shift can move.
 */
function weekdayOfRow(back: number, timezone: string | undefined, nowMs: number): IsoWeekday {
  const start = localMidnight(timezone, nowMs) - back * 86_400_000;
  return localNow(timezone, start + 43_200_000).isoWeekday;
}

/** Linear-interpolated percentile over an already-sorted list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/**
 * What this week is worth, in the order the answers matter.
 *
 * Stopped is decided before flat because a sensor that stopped a month ago also
 * looks flat, and "it stopped on Saturday" is the far more useful sentence.
 */
function judge(
  cells: readonly (number | null)[][],
  sorted: readonly number[],
  low: number,
  high: number,
  lastAt: number | null,
  nowMs: number,
): WeekVerdict {
  if (sorted.length === 0 || lastAt === null) return { kind: 'nothing' };
  if (nowMs - lastAt >= SILENT_MS) return { kind: 'stopped', lastAt };

  // Two stops of range, and a bright end worth acting on. A cupboard sensor
  // reporting 1 to 4 lx clears neither.
  const floor = Math.max(low, MIN_LUX);
  if (high < 10 || high < 4 * floor) return { kind: 'flat', low, high };

  const nightLux = bandValue(cells, NIGHT_COLUMNS, 0.25);
  const noonLux = bandValue(cells, NOON_COLUMNS, 0.75);
  if (nightLux === null || noonLux === null || noonLux <= nightLux) {
    return { kind: 'flat', low, high };
  }
  return { kind: 'usable', nightLux, noonLux };
}

/** A percentile over just some columns — the night, or the middle of the day. */
function bandValue(
  cells: readonly (number | null)[][],
  columns: readonly number[],
  fraction: number,
): number | null {
  const values: number[] = [];
  for (const row of cells) {
    for (const column of columns) {
      const value = row[column];
      if (value !== null && value !== undefined) values.push(value);
    }
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return percentile(values, fraction);
}

/**
 * The two thresholds, from the week's own night and noon.
 *
 * The dark end sits a little ABOVE the measured night, so an ordinary evening
 * counts as dark rather than falling just outside it; the bright end sits at the
 * middle of the day rather than at its peak, so one sunny hour does not define
 * "bright" for the whole room. Both are snapped to a round number, because a
 * threshold of 7.43 lx invites a precision the measurement does not have.
 */
function suggest(
  verdict: WeekVerdict,
  cells: readonly (number | null)[][],
  low: number,
  high: number,
): { darkLux: number; brightLux: number } | null {
  if (verdict.kind === 'usable') return fromNightAndNoon(verdict.nightLux, verdict.noonLux);

  if (verdict.kind === 'stopped') {
    // What it reported before it stopped is still a week of this room: if that
    // much holds a night and a noon, it is the same suggestion a working
    // sensor would have produced.
    const nightLux = bandValue(cells, NIGHT_COLUMNS, 0.25);
    const noonLux = bandValue(cells, NOON_COLUMNS, 0.75);
    if (nightLux !== null && noonLux !== null && noonLux > nightLux) {
      return fromNightAndNoon(nightLux, noonLux);
    }
  }

  if (verdict.kind === 'nothing') return null;

  // Flat, or stopped without a night and a noon to read: the week's own range,
  // bottom and top. Nothing to act on, as the screen says — but these are the
  // numbers this sensor actually reports, which a default is not.
  const darkLux = ceilNicely(Math.max(MIN_LUX, low * 1.3));
  let brightLux = roundNicely(Math.max(high, MIN_LUX));
  if (brightLux <= darkLux) brightLux = roundNicely(darkLux * 4);
  return { darkLux, brightLux };
}

function fromNightAndNoon(nightLux: number, noonLux: number): { darkLux: number; brightLux: number } {
  // The dark end rounds UP the ladder, not to the nearest rung. Rounding to the
  // nearest deletes the very margin the 1.3 is there to add: a room whose night
  // reads 5 lx wants 6.5, and the nearest rung is 5 again — which makes the
  // darkest night the only thing that counts as dark, and an ordinary evening
  // no longer qualifies.
  const darkLux = ceilNicely(Math.max(MIN_LUX, nightLux * 1.3));
  let brightLux = roundNicely(noonLux);
  // The sanitiser throws BOTH values away on a zero-width span, so a week whose
  // night and noon round together must not be allowed to produce one.
  if (brightLux <= darkLux) brightLux = roundNicely(darkLux * 4);
  return { darkLux, brightLux };
}

/** The 1 / 2 / 5 × 10ⁿ ladder every threshold is snapped to. */
const RUNGS = [1, 2, 5, 10] as const;

/** Snap to the nearest rung — the number a person would have picked. */
export function roundNicely(value: number): number {
  return onLadder(value, (mantissa) => mantissa <= 1.5 ? 1 : mantissa <= 3.5 ? 2 : mantissa <= 7.5 ? 5 : 10);
}

/** Snap to the rung at or above — for a threshold that must not lose its margin. */
function ceilNicely(value: number): number {
  return onLadder(value, (mantissa) => RUNGS.find(rung => rung >= mantissa - 1e-9) ?? 10);
}

function onLadder(value: number, pick: (mantissa: number) => number): number {
  if (!Number.isFinite(value) || value <= MIN_LUX) return MIN_LUX;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.round(pick(value / magnitude) * magnitude * 100) / 100;
}

/** The Insights log id for a device's luminance capability. */
export function luminanceLogId(deviceId: string): string {
  return `homey:device:${deviceId}:${LUMINANCE_CAPABILITY}`;
}

/**
 * The one impure function: a week of samples out of Homey's own Insights.
 *
 * Homey logs every numeric capability to Insights by default, so a
 * `measure_luminance` sensor has a log whether or not anybody asked for one.
 * `getLogEntries` answers `{ values: [{ t, v }] }`.
 *
 * Returns `null` rather than throwing when there is no log or it cannot be read.
 * The app's own token has read scope across the API — every flow READ succeeds
 * and only writes are refused (platform §1) — but "very likely" is not
 * "measured", and a screen that broke on a Homey where this read is refused
 * would be a worse outcome than one that quietly falls back to the defaults,
 * which is exactly what happened before this existed.
 */
export async function readSensorWeek(
  api: any,
  deviceId: string,
  resolution = 'last7Days',
): Promise<HistorySample[] | null> {
  try {
    const log = await api?.insights?.getLogEntries({
      id: luminanceLogId(deviceId),
      resolution,
      // Both halves of the opt-out, for both of platform §15's reasons.
      // MEMORY: `insights` is one of the managers `HomeyApiService.read()`
      // connects, so `isConnected()` is true and anything this returns is
      // written into `ManagerInsights.__cache` for the life of the client — a
      // week of samples per sensor, kept forever, to draw one pairing screen
      // that is closed seconds later. CORRECTNESS: a week is a moving window,
      // so a cached answer means the screen redraws yesterday's.
      $cache: false,
      $updateCache: false,
    });
    const values = Array.isArray(log?.values) ? log.values : null;
    if (!values) return null;

    const samples: HistorySample[] = [];
    for (const entry of values) {
      // `Number(null)` is 0 and 0 lux is pitch dark, so a gap Homey encodes as
      // null has to be dropped rather than coerced — the same trap `asLux`
      // guards on the live subscription.
      if (entry?.v === null || entry?.v === undefined) continue;
      const t = typeof entry?.t === 'number' ? entry.t : Date.parse(String(entry?.t));
      const v = Number(entry.v);
      if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
      samples.push({ t, v });
    }
    return samples;
  } catch {
    return null;
  }
}
