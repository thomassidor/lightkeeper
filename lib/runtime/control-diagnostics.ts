import { BoundedLog } from '../support/bounded-log';
import type { Capability, PlannedWrite } from '../outputs/intent-planner';
import type { WriteOutcome } from '../outputs/command-scheduler';
import type { EvidenceSink } from '../support/evidence-sink';
import type { BrightnessScale } from '../outputs/light-intent';
import { OVERRIDE_EXPIRY_MS } from '../outputs/target-state-cache';

export interface OverrideRecord {
  /** The FIRST report's time. The four-hour deadline is anchored to it. */
  at: number;
  capability: Capability;
  value: number;
  expected: number | null;
  source: 'external_report';
  /**
   * How many reports have restated this same override, and when the last one
   * arrived.
   *
   * A stuck lamp reports once a minute, and every one of those reports used to
   * push its own `override` row into the ring: 28 of one device's 32 rows were
   * four overrides said over and over. They are counted here instead, which is
   * also the honest place for them — it is one override that keeps being
   * confirmed, not thirty-two of them.
   */
  repeats?: number;
  lastAt?: number;
}

/**
 * File a report as an override, or restate the one already standing.
 *
 * Shared by every runtime that stands down for a person — three call sites
 * across the circadian and daylight runtimes carried this block, comments and
 * all, and both rules in it are safety properties:
 *
 *  - **The deadline is the FIRST report's time, never this one's.**
 *    `OVERRIDE_EXPIRY_MS` is the only way out of an override that does not
 *    need somebody to walk to a switch, and re-stamping on every report pushes
 *    it out for as long as the lamp keeps talking — which is exactly what a
 *    stuck lamp does. Seen on the reference Homey: four lamps reporting a value
 *    we never wrote, every minute, each report renewing the four hours that
 *    were supposed to end it. The history event keeps the real arrival time;
 *    only the deadline is anchored to the start.
 *  - **One override, one row.** A lamp that keeps restating it is counted on
 *    the record (`repeats`, `lastAt`) instead of pushing a row per report: 28 of
 *    one device's 32 event slots were four overrides said over and over, which
 *    is how the evidence for everything else was lost. The tile and the
 *    settings page read the record rather than the log.
 *
 * Returns true when this report RAISED the override, so the caller can say so
 * once in its log in its own words.
 */
export function noteOverrideReport(
  overrides: Map<string, OverrideRecord>,
  history: ControlHistory<ControlAction>,
  deviceId: string,
  report: Pick<OverrideRecord, 'capability' | 'value' | 'expected'>,
  now: number,
): boolean {
  const previous = overrides.get(deviceId);
  const record: OverrideRecord = { at: previous?.at ?? now, ...report, source: 'external_report' };
  if (previous !== undefined) {
    record.repeats = (previous.repeats ?? 1) + 1;
    record.lastAt = now;
  }
  overrides.set(deviceId, record);
  if (previous === undefined) history.events.add({ ...record, at: now, type: 'override', deviceId });
  return previous === undefined;
}

/**
 * Drop every override older than `OVERRIDE_EXPIRY_MS`, record that it lapsed,
 * and hand each lamp to `forget` — where the runtime drops what it last wrote,
 * which is half the fix rather than tidiness (see either runtime's
 * `expireOverrides`).
 */
export function expireOverrides(
  overrides: Map<string, OverrideRecord>,
  history: ControlHistory<ControlAction>,
  now: number,
  forget: (deviceId: string) => void,
): void {
  const cutoff = now - OVERRIDE_EXPIRY_MS;
  for (const [deviceId, record] of overrides) {
    if (record.at > cutoff) continue;
    overrides.delete(deviceId);
    forget(deviceId);
    history.events.add({ at: now, type: 'override_cleared', deviceId, reason: 'expired' });
  }
}

export interface TargetDecision {
  deviceId: string;
  status: 'overridden' | 'unavailable' | 'off' | 'prestage_declined' | 'unchanged' | 'queued' | 'inactive';
  commands: number;
}

export interface ControlEvent {
  /** The FIRST occurrence, when `count` says this row stands for several. */
  at: number;
  deviceId: string;
  type: 'power' | 'override' | 'override_cleared' | 'report_ignored';
  capability?: Capability;
  value?: number | boolean;
  expected?: number | null;
  reason?: string;
  /** Present only on a folded row: how many reports it stands for. */
  count?: number;
  /** The newest occurrence's time; `at` stays the first. */
  lastAt?: number;
}

export interface ControlAction {
  at: number;
  reason: string;
  writes: number;
  skipped: number;
  targets?: TargetDecision[];
  batchId?: string;
  completedAt?: number;
  outcomes?: WriteOutcome[];
  /**
   * Set only on a row standing for a RUN of identical passes that wrote
   * nothing: how many it stands for, and when the newest of them ran. `at` stays
   * the first. See `ControlHistory.action`.
   */
  count?: number;
  lastAt?: number;
}

/**
 * Whether two passes that wrote nothing are the same pass again: the same
 * reason and sentence, and the same verdict on every lamp. The curve's own
 * values (warmth, brightness, colour) are deliberately NOT compared, because
 * on a flat stretch they creep by thousandths per tick without a write. The row
 * carries the newest of them instead.
 */
function sameIdlePass(a: ControlAction & { detail?: string }, b: ControlAction & { detail?: string }): boolean {
  if (a.writes !== 0 || b.writes !== 0) return false;
  if (a.reason !== b.reason || a.detail !== b.detail || a.skipped !== b.skipped) return false;
  const left = a.targets ?? [];
  const right = b.targets ?? [];
  return left.length === right.length && left.every((target, i) => {
    const other = right[i]!;
    return target.deviceId === other.deviceId && target.status === other.status
      && target.commands === other.commands;
  });
}

/** Keep decisions independently of capability writes: six lamps must not erase
 * an hour of history in five ticks. All buffers remain bounded in memory. */
export class ControlHistory<T extends ControlAction> {
  readonly actions: BoundedLog<T>;
  readonly events: BoundedLog<ControlEvent>;

  constructor(sink?: EvidenceSink) {
    this.actions = new BoundedLog<T>(60, entry => sink?.('control_action', entry));
    this.events = new BoundedLog<ControlEvent>(120, entry => sink?.('control_event', entry));
  }

  /**
   * Record one pass. A pass that wrote nothing and matches the NEWEST row
   * exactly is folded into it instead of taking a slot of its own.
   *
   * The same argument as `ignored()` below, for actions. Every runtime records
   * one action per tick, and on a flat stretch of curve, a publish-only device,
   * a paused one or a room with every lamp off, every one of them is the same
   * "nothing to do". Sixty slots then hold one hour of identical rows. The pass
   * that last actually wrote is evicted after that hour, which is the row a
   * reader needs. Those rows also made up most of `/diagnostics`' megabyte.
   *
   * Only the newest row is compared, never a window as `ignored()` does.
   * Actions do not interleave the way five lamps' echoes do, and folding into
   * an older row would put a pass before a write that happened first. Any pass
   * that wrote is never folded, so its `batchId` and outcomes stay its own.
   * The evidence sink still sees every pass.
   */
  action(entry: T): void {
    this.actions.addRepeat(
      entry,
      existing => sameIdlePass(existing, entry),
      existing => {
        const first = existing.at;
        const count = (existing.count ?? 1) + 1;
        Object.assign(existing, entry, { at: first, count, lastAt: entry.at });
      },
      1,
    );
  }

  /**
   * A report we set aside, folded into the row for the last one like it.
   *
   * Every suppression reason lands here — including the wholly routine echo of
   * a write the app has just made, which is most of the traffic on a device
   * that pre-stages. Folding keeps the reason visible (and its count, which is
   * itself a signal: a lamp echoing forty times is worth seeing) at the cost of
   * one slot rather than forty.
   */
  ignored(event: ControlEvent): void {
    this.events.addRepeat(
      event,
      existing => existing.type === 'report_ignored'
        && existing.deviceId === event.deviceId
        && existing.capability === event.capability
        && existing.reason === event.reason,
      existing => {
        existing.count = (existing.count ?? 1) + 1;
        existing.lastAt = event.at;
        // The newest value, beside the first `at`: what the lamp is saying NOW
        // is the more useful half, and the run's start is what dates the row.
        existing.value = event.value;
      },
    );
  }

  decisions(ids: string[], excluded: Map<string, TargetDecision['status']>, writes: PlannedWrite[]): TargetDecision[] {
    return ids.map(deviceId => {
      const commands = writes.filter(write => write.deviceId === deviceId).length;
      return { deviceId, status: excluded.get(deviceId) ?? (commands ? 'queued' : 'unchanged'), commands };
    });
  }

  snapshot() {
    return {
      recentActions: this.actions.entries(),
      recentControlEvents: this.events.entries(),
      history: { actions: this.actions.retention(), events: this.events.retention() },
    };
  }
}

/**
 * What the numbers in a diagnostics document mean. A function of the app's
 * `BrightnessScale` because one of them is: a capture read without knowing
 * which scale wrote it would put every `dim` on the wrong curve.
 */
export function diagnosticSemantics(scale: BrightnessScale) {
  return { brightnessScale: scale, ...BRIGHTNESS_SEMANTICS[scale], ...DIAGNOSTIC_SEMANTICS };
}

const BRIGHTNESS_SEMANTICS = {
  natural: {
    brightness: 'perceptual_0_1',
    brightnessConversion: 'dim = brightness^2.2, then capability quantisation and minimum lit level',
  },
  linear: {
    brightness: 'linear_0_1',
    brightnessConversion: 'dim = brightness (linear scale), then capability quantisation and minimum lit level',
  },
} as const;

const DIAGNOSTIC_SEMANTICS = {
  dim: 'device_0_1',
  brightnessSteps: 'remote steps and hold ramps move along gamma 2.2 under either scale',
  writes: 'planned capability commands; see outcomes for completion',
  skipped: 'excluded targets; unchanged targets are listed separately in action.targets',
  writeSuccess: 'API accepted the command; physical lamp state is not verified',
  recentEvents: 'bridge Flow intake only; runtime power and override events are in recentControlEvents',
  timestamps: 'Unix milliseconds; sampledAt is the current snapshot, lastAction.at is its earlier evaluation',
  history: 'bounded, newest first, in memory only; reset on app restart',
  repeatedEvents: 'a run of identical reports is one row: count is how many, at is the first, lastAt the newest',
  repeatedActions: 'a run of identical passes that wrote nothing is one row the same way, carrying the newest pass\'s values',
} as const;
