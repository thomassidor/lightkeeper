import type { Capability, PlannedWrite } from './intent-planner';

/**
 * Spec §7.5 — coalesce bursts, serialise per-target writes, cap write
 * frequency, and GUARANTEE a final write after the burst ends.
 *
 * A fast dial turn produces a flood of events. Writing each one saturates
 * Zigbee, Z-Wave or a cloud integration and the light ends up wherever the
 * queue happened to stop. Coalescing fixes the flood; the guaranteed final
 * write is what makes the light end at the correct level (AC-10).
 *
 * Queues are never persisted (§7.5) — runtime state is rebuilt from live
 * device values after a restart.
 */

export type Executor = (
  deviceId: string,
  capability: Capability,
  value: boolean | number,
  options?: { impliesOn?: boolean },
) => Promise<void>;

export interface SchedulerOptions {
  minWriteIntervalMs: number;
  /** Bounded so a runaway source cannot exhaust memory (§12). */
  maxQueuedDevices?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  onError?: (deviceId: string, capability: Capability, error: unknown) => void;
}

interface DeviceQueue {
  pending: Map<Capability, boolean | number>;
  impliesOn: Set<Capability>;
  timer: unknown;
  lastWriteAt: number;
  flushing: boolean;
}

const DEFAULT_MAX_QUEUED_DEVICES = 64;

/**
 * Turning on and dimming in the same burst must arrive in a sensible order:
 * switch on first so the dim lands on a lit lamp, and switch off last so the
 * light does not visibly jump before going dark.
 */
const WRITE_ORDER: Capability[] = ['onoff', 'dim', 'light_temperature'];

export class CommandScheduler {
  private readonly queues = new Map<string, DeviceQueue>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private stopped = false;

  constructor(
    private readonly options: SchedulerOptions,
    private readonly executor: Executor,
  ) {
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? (handle => clearTimeout(handle as NodeJS.Timeout));
    this.now = options.now ?? (() => Date.now());
  }

  submit(writes: PlannedWrite[]): void {
    if (this.stopped) return;

    for (const write of writes) {
      const queue = this.queueFor(write.deviceId);
      if (!queue) continue;
      // Latest value wins — this IS the coalescing.
      queue.pending.set(write.capability, write.value);
      if (write.impliesOn) queue.impliesOn.add(write.capability);
      else queue.impliesOn.delete(write.capability);
    }

    for (const deviceId of new Set(writes.map(w => w.deviceId))) {
      this.schedule(deviceId);
    }
  }

  private queueFor(deviceId: string): DeviceQueue | null {
    let queue = this.queues.get(deviceId);
    if (queue) return queue;

    const limit = this.options.maxQueuedDevices ?? DEFAULT_MAX_QUEUED_DEVICES;
    if (this.queues.size >= limit) return null;

    // Never rate-limit the FIRST write against a zero timestamp — that would
    // add minWriteIntervalMs of latency to every button press.
    queue = {
      pending: new Map(), impliesOn: new Set(), timer: null,
      lastWriteAt: Number.NEGATIVE_INFINITY, flushing: false,
    };
    this.queues.set(deviceId, queue);
    return queue;
  }

  private schedule(deviceId: string): void {
    const queue = this.queues.get(deviceId);
    if (!queue || queue.timer !== null || queue.flushing) return;

    const sinceLast = this.now() - queue.lastWriteAt;
    const rateDelay = Math.max(0, this.options.minWriteIntervalMs - sinceLast);

    // Leading edge: the FIRST action after a quiet period goes out immediately.
    // Waiting out the burst window unconditionally added its full duration to
    // every isolated button press — latency the user feels on every single
    // press, to coalesce a burst that is not happening. Bursts still coalesce,
    // because anything arriving during the write or the rate window is held
    // and flushed after (§7.5's guaranteed final write).
    if (rateDelay === 0) {
      void this.flush(deviceId);
      return;
    }

    queue.timer = this.setTimer(() => {
      queue.timer = null;
      void this.flush(deviceId);
    }, rateDelay);
  }

  private async flush(deviceId: string): Promise<void> {
    const queue = this.queues.get(deviceId);
    // Leading-edge flushes start without a timer, so stop() must be able to
    // cancel one that is already under way.
    if (!queue || queue.flushing || this.stopped) return;

    const snapshot = [...queue.pending.entries()];
    const impliesOn = new Set(queue.impliesOn);
    queue.pending.clear();
    queue.impliesOn.clear();
    if (snapshot.length === 0) return;

    queue.flushing = true;
    queue.lastWriteAt = this.now();

    snapshot.sort((a, b) => WRITE_ORDER.indexOf(a[0]) - WRITE_ORDER.indexOf(b[0]));
    const turningOff = snapshot.find(([cap, value]) => cap === 'onoff' && value === false);
    if (turningOff) {
      snapshot.splice(snapshot.indexOf(turningOff), 1);
      snapshot.push(turningOff);
    }

    // Serialised per target; failures are independent (§7.9) so one bad write
    // never blocks the rest of this device's burst, let alone other devices.
    for (const [capability, value] of snapshot) {
      if (this.stopped) break;
      try {
        await this.executor(deviceId, capability, value, { impliesOn: impliesOn.has(capability) });
      } catch (error) {
        this.options.onError?.(deviceId, capability, error);
      }
    }

    queue.flushing = false;

    // Anything that arrived mid-flush gets its own pass. This is the
    // guaranteed final write.
    if (queue.pending.size > 0 && !this.stopped) this.schedule(deviceId);
  }

  /** Write everything outstanding immediately. Used on stop and by tests. */
  async drain(): Promise<void> {
    for (const [deviceId, queue] of this.queues) {
      if (queue.timer !== null) {
        this.clearTimer(queue.timer);
        queue.timer = null;
      }
      await this.flush(deviceId);
    }
  }

  get queuedDeviceCount(): number {
    return [...this.queues.values()].filter(q => q.pending.size > 0).length;
  }

  stop(): void {
    this.stopped = true;
    for (const queue of this.queues.values()) {
      if (queue.timer !== null) this.clearTimer(queue.timer);
      queue.timer = null;
      queue.pending.clear();
      queue.impliesOn.clear();
    }
    this.queues.clear();
  }
}
