import { BoundedLog } from '../support/bounded-log';
import type { Capability, PlannedWrite } from '../outputs/intent-planner';
import type { WriteOutcome } from '../outputs/command-scheduler';
import type { EvidenceSink } from '../support/evidence-sink';

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

export interface TargetDecision {
  deviceId: string;
  status: 'overridden' | 'off' | 'prestage_declined' | 'unchanged' | 'queued' | 'inactive';
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

export const DIAGNOSTIC_SEMANTICS = {
  brightness: 'perceptual_0_1',
  dim: 'device_0_1',
  brightnessConversion: 'dim = brightness^2.2, then capability quantisation and minimum lit level',
  writes: 'planned capability commands; see outcomes for completion',
  skipped: 'excluded targets; unchanged targets are listed separately in action.targets',
  writeSuccess: 'API accepted the command; physical lamp state is not verified',
  recentEvents: 'bridge Flow intake only; runtime power and override events are in recentControlEvents',
  timestamps: 'Unix milliseconds; sampledAt is the current snapshot, lastAction.at is its earlier evaluation',
  history: 'bounded, newest first, in memory only; reset on app restart',
  repeatedEvents: 'a run of identical reports is one row: count is how many, at is the first, lastAt the newest',
} as const;
