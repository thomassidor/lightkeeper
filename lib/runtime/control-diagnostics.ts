import { BoundedLog } from '../support/bounded-log';
import type { Capability, PlannedWrite } from '../outputs/intent-planner';
import type { WriteOutcome } from '../outputs/command-scheduler';
import type { EvidenceSink } from '../support/evidence-sink';

export interface OverrideRecord {
  at: number;
  capability: Capability;
  value: number;
  expected: number | null;
  source: 'external_report';
}

export interface TargetDecision {
  deviceId: string;
  status: 'overridden' | 'off' | 'prestage_declined' | 'unchanged' | 'queued' | 'inactive';
  commands: number;
}

export interface ControlEvent {
  at: number;
  deviceId: string;
  type: 'power' | 'override' | 'override_cleared' | 'report_ignored';
  capability?: Capability;
  value?: number | boolean;
  expected?: number | null;
  reason?: string;
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
} as const;
