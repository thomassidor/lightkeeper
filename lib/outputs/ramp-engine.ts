import type { LightIntent } from './light-intent';

/**
 * Ramp safety. CRITICAL.
 *
 * Tick at 100 ms; default rate 60% of perceptual range per second.
 *
 * HARD STOP AFTER 10 SECONDS. NOT CONFIGURABLE. Release events are routinely
 * dropped on Zigbee and unreliable on Matter/Thread — a stuck ramp is a
 * certainty, not a risk, and a light ramping forever is the worst failure this
 * app can produce.
 *
 * Also stops on: any other input from the same controller, target
 * unavailability, and app shutdown. All ramps are cancelled on onUninit so a
 * light is never left mid-ramp across a restart.
 */

export const TICK_MS = 100;
export const DEFAULT_RATE_PER_SECOND = 0.6;

/** Not configurable. Deliberately not read from behaviour or settings. */
export const HARD_STOP_MS = 10_000;

export type RampDirection = -1 | 1;

export interface RampOptions {
  /** Fraction of the perceptual range per second. */
  ratePerSecond?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
}

export interface ActiveRamp {
  controlId: string;
  kind: 'brightness' | 'temperature';
  direction: RampDirection;
  startedAt: number;
  ticks: number;
}

export type RampTick = (intent: LightIntent) => void;

export type RampStopReason =
  | 'released'
  | 'hard_stop'
  | 'superseded'
  | 'other_input'
  | 'target_unavailable'
  | 'shutdown';

export class RampEngine {
  private ramps = new Map<string, { ramp: ActiveRamp; handle: unknown }>();

  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly ratePerSecond: number;

  constructor(
    private readonly onTick: RampTick,
    private readonly onStop: (controlId: string, reason: RampStopReason, ramp: ActiveRamp) => void,
    options: RampOptions = {},
  ) {
    this.setTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = options.clearInterval ?? (handle => clearInterval(handle as NodeJS.Timeout));
    this.now = options.now ?? (() => Date.now());
    this.ratePerSecond = options.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
  }

  get activeCount(): number {
    return this.ramps.size;
  }

  isRamping(controlId: string): boolean {
    return this.ramps.has(controlId);
  }

  /**
   * Begin ramping. Starting a ramp on a control that is already ramping
   * restarts it rather than stacking two.
   */
  start(controlId: string, kind: ActiveRamp['kind'], direction: RampDirection): void {
    this.stop(controlId, 'superseded');

    const ramp: ActiveRamp = { controlId, kind, direction, startedAt: this.now(), ticks: 0 };
    const deltaPerTick = (this.ratePerSecond * TICK_MS) / 1000 * direction;

    const handle = this.setTimer(() => {
      const elapsed = this.now() - ramp.startedAt;

      // The hard stop is checked BEFORE emitting, so a ramp can never run past
      // the limit even by one tick.
      if (elapsed >= HARD_STOP_MS) {
        this.stop(controlId, 'hard_stop');
        return;
      }

      ramp.ticks += 1;
      this.onTick(ramp.kind === 'brightness'
        ? { type: 'brightness_delta', delta: deltaPerTick }
        : { type: 'temperature_delta', delta: deltaPerTick });
    }, TICK_MS);

    this.ramps.set(controlId, { ramp, handle });
  }

  stop(controlId: string, reason: RampStopReason): boolean {
    const entry = this.ramps.get(controlId);
    if (!entry) return false;

    this.clearTimer(entry.handle);
    this.ramps.delete(controlId);
    // 'superseded' means an immediate restart of the same control; reporting it
    // as a stop would produce a misleading pair of events in diagnostics.
    if (reason !== 'superseded') this.onStop(controlId, reason, entry.ramp);
    return true;
  }

  /**
   * Any other input from the same controller stops every ramp. Pressing
   * another button while holding one must not leave the first ramping.
   */
  stopAllExcept(controlId: string | null, reason: RampStopReason): number {
    let stopped = 0;
    for (const id of [...this.ramps.keys()]) {
      if (id === controlId) continue;
      if (this.stop(id, reason)) stopped += 1;
    }
    return stopped;
  }

  /** Cancel everything — app shutdown, controller stop, target loss. */
  stopAll(reason: RampStopReason = 'shutdown'): number {
    let stopped = 0;
    for (const id of [...this.ramps.keys()]) {
      if (this.stop(id, reason)) stopped += 1;
    }
    return stopped;
  }

  active(): ActiveRamp[] {
    return [...this.ramps.values()].map(entry => entry.ramp);
  }
}

/**
 * Do not offer a continuous hold-ramp without a reliable release or stop
 * signal, or repeated source events. Where absent, offer stepping instead.
 *
 * Decided from the discovered catalogue, per control: a hold may ramp only if
 * that same control also exposes a release, or the source emits repeats.
 */
export function canRamp(
  controlId: string,
  catalogue: Array<{ controlId: string; action: string }>,
): boolean {
  const forControl = catalogue.filter(input => input.controlId === controlId);
  const hasHold = forControl.some(input => input.action === 'long_press' || input.action === 'rotate_start');
  if (!hasHold) return false;

  return forControl.some(input => input.action === 'release' || input.action === 'rotate_stop');
}
