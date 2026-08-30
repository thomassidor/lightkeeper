import type { Capability, PlannedWrite, WriteValue } from './intent-planner';
import { withDefaults, type Timers } from '../support/timers';

/**
 * Coalesce bursts, serialise per-target writes, cap write
 * frequency, and GUARANTEE a final write after the burst ends.
 *
 * A fast dial turn produces a flood of events. Writing each one saturates
 * Zigbee, Z-Wave or a cloud integration and the light ends up wherever the
 * queue happened to stop. Coalescing fixes the flood; the guaranteed final
 * write is what makes the light end at the correct level.
 *
 * `submit()` returns a COMPLETION, and that is the second thing this class is
 * for. "We planned three writes" is not "three writes reached a light", and
 * for a long time it was the only thing anything downstream could know:
 *
 *   - the target-state cache committed desired values before dispatch, so a
 *     write that failed left the app believing a lamp was at a level it had
 *     never reached, and the next relative step planned from the fiction;
 *   - the circadian runtime recorded `lastWritten` the moment it submitted, so
 *     a coalesced-away write was never retried;
 *   - the Test control on the pairing screen returned before anything had
 *     happened.
 *
 * A caller that ignores the return value is unaffected — nothing here waits on
 * anyone reading it.
 *
 * Queues are never persisted — runtime state is rebuilt from live
 * device values after a restart.
 */

export type Executor = (
  deviceId: string,
  capability: Capability,
  value: WriteValue,
  options?: { impliesOn?: boolean },
) => Promise<void>;

/**
 * What became of one planned write. A discriminated union because the four
 * failures are not interchangeable: `coalesced` means a newer value owns this
 * capability and there is nothing to retry, while `failed` and
 * `dropped_capacity` both mean the light did not move and the next tick should
 * try again.
 */
export type WriteOutcome =
  | { status: 'succeeded'; deviceId: string; capability: Capability; value: WriteValue; ms: number }
  /** `error` is the SANITISED message only — never an error object (I2). */
  | { status: 'failed'; deviceId: string; capability: Capability; error: string }
  /** A later value replaced this one before it was flushed. */
  | { status: 'coalesced'; deviceId: string; capability: Capability }
  /** The scheduler was already tracking its maximum number of devices. */
  | { status: 'dropped_capacity'; deviceId: string; capability: Capability }
  /** stop() came first. */
  | { status: 'cancelled'; deviceId: string; capability: Capability; reason: string };

export interface SubmitResult {
  /**
   * Identifies this batch across the outcomes it produces. The circadian
   * runtime correlates its pre-stage probe to the write generation that
   * started it, so an older probe cannot disable pre-staging on the strength
   * of a lamp a newer write turned on.
   */
  batchId: string;
  /** Settles when every write in the batch has succeeded, failed or been given up on. */
  completion: Promise<WriteOutcome[]>;
}

export interface SchedulerOptions {
  minWriteIntervalMs: number;
  /** Bounded so a runaway source cannot exhaust memory. */
  maxQueuedDevices?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
  onError?: (deviceId: string, capability: Capability, error: unknown) => void;
}

/** One caller waiting on one capability's outcome. */
interface Waiter {
  settle: (outcome: WriteOutcome) => void;
}

interface PendingWrite {
  value: WriteValue;
  impliesOn: boolean;
  waiters: Waiter[];
}

interface DeviceQueue {
  pending: Map<Capability, PendingWrite>;
  timer: unknown;
  lastWriteAt: number;
  /**
   * The flush currently running for this device, or null.
   *
   * A boolean `flushing` was enough to keep two flushes off one device, but it
   * gave `drain()` nothing to AWAIT: drain called flush(), flush saw the flag
   * and returned immediately, and drain resolved while the writes it was
   * supposed to be draining were still in flight. Every caller of drain() —
   * stop, the Test control, the circadian tick — read that as "done".
   */
  activeFlush: Promise<void> | null;
}

const DEFAULT_MAX_QUEUED_DEVICES = 64;

/**
 * Turning on and dimming in the same burst must arrive in a sensible order:
 * switch on first so the dim lands on a lit lamp, and switch off last so the
 * light does not visibly jump before going dark.
 */
/**
 * The order writes to one device go out in.
 *
 * `onoff` first so a level lands on a lit lamp. Then `light_mode`, BEFORE both
 * of the things it governs: a lamp ignores a hue it is given while in
 * temperature mode, and ignores a temperature while in colour mode — silently,
 * either way, reporting the write as accepted and keeping its old value.
 *
 * `light_mode` used to sit after `light_temperature`, which was invisible for
 * as long as nothing wrote colour and temperature to the same lamp. A Curve
 * light does: a coloured point puts a lamp into colour mode, and every later
 * temperature-only point was then dropped on the floor. Found on hardware — a
 * lamp written 0.43 sat at 0.87 and would not take a temperature from anything,
 * this app or otherwise, until its mode was changed back.
 */
const WRITE_ORDER: Capability[] = [
  'onoff', 'dim', 'light_mode', 'light_temperature', 'light_hue', 'light_saturation',
];

export class CommandScheduler {
  private readonly queues = new Map<string, DeviceQueue>();
  private readonly timers: Timers;
  private readonly now: () => number;
  private stopped = false;
  private nextBatch = 1;

  constructor(
    private readonly options: SchedulerOptions,
    private readonly executor: Executor,
  ) {
    // The piecemeal options predate lib/support/timers.ts and are kept: a
    // dozen existing tests pass `setTimeout`/`now` on their own, and a fake
    // that stubs one and inherits the rest is a normal thing to want.
    this.timers = withDefaults({
      ...(options.setTimeout ? { setTimeout: options.setTimeout } : {}),
      ...(options.clearTimeout ? { clearTimeout: options.clearTimeout } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.now = () => this.timers.now();
  }

  /**
   * Queue a batch of writes. Synchronous-fast: nothing here awaits, so a
   * caller on the event path is never blocked by a slow radio.
   */
  submit(writes: PlannedWrite[]): SubmitResult {
    const batchId = `b${this.nextBatch++}`;
    const outcomes: WriteOutcome[] = [];

    if (writes.length === 0) {
      return { batchId, completion: Promise.resolve(outcomes) };
    }

    let settleBatch!: (value: WriteOutcome[]) => void;
    const completion = new Promise<WriteOutcome[]>(resolve => { settleBatch = resolve; });

    let outstanding = writes.length;
    const record = (outcome: WriteOutcome): void => {
      outcomes.push(outcome);
      outstanding -= 1;
      if (outstanding === 0) settleBatch(outcomes);
    };

    if (this.stopped) {
      for (const write of writes) {
        record({
          status: 'cancelled', deviceId: write.deviceId, capability: write.capability,
          reason: 'scheduler stopped',
        });
      }
      return { batchId, completion };
    }

    for (const write of writes) {
      const queue = this.queueFor(write.deviceId);
      if (!queue) {
        // The cap is on CONCURRENT devices (idle queues are evicted), so
        // reaching it means a genuine flood rather than a long tail. Say so:
        // silently dropping the write is what made this indistinguishable
        // from a light that simply did not respond.
        this.options.onError?.(
          write.deviceId, write.capability, new Error('scheduler at capacity'),
        );
        record({ status: 'dropped_capacity', deviceId: write.deviceId, capability: write.capability });
        continue;
      }

      const existing = queue.pending.get(write.capability);
      if (existing) {
        // Latest value wins — this IS the coalescing. Whoever was waiting on
        // the value being replaced is told so: there is nothing to retry,
        // because a newer value for the same capability is on its way.
        for (const waiter of existing.waiters) {
          waiter.settle({ status: 'coalesced', deviceId: write.deviceId, capability: write.capability });
        }
      }

      queue.pending.set(write.capability, {
        value: write.value,
        impliesOn: write.impliesOn === true,
        waiters: [{ settle: record }],
      });
    }

    for (const deviceId of new Set(writes.map(w => w.deviceId))) {
      if (this.queues.has(deviceId)) this.schedule(deviceId);
    }

    return { batchId, completion };
  }

  private queueFor(deviceId: string): DeviceQueue | null {
    let queue = this.queues.get(deviceId);
    if (queue) return queue;

    const limit = this.options.maxQueuedDevices ?? DEFAULT_MAX_QUEUED_DEVICES;
    if (this.queues.size >= limit) {
      this.reclaimIdleQueues();
      if (this.queues.size >= limit) return null;
    }

    // Never rate-limit the FIRST write against a zero timestamp — that would
    // add minWriteIntervalMs of latency to every button press.
    queue = {
      pending: new Map(), timer: null,
      lastWriteAt: Number.NEGATIVE_INFINITY, activeFlush: null,
    };
    this.queues.set(deviceId, queue);
    return queue;
  }

  private schedule(deviceId: string): void {
    const queue = this.queues.get(deviceId);
    if (!queue || queue.timer !== null || queue.activeFlush !== null) return;

    const sinceLast = this.now() - queue.lastWriteAt;
    const rateDelay = Math.max(0, this.options.minWriteIntervalMs - sinceLast);

    // Leading edge: the FIRST action after a quiet period goes out immediately.
    // Waiting out the burst window unconditionally added its full duration to
    // every isolated button press — latency the user feels on every single
    // press, to coalesce a burst that is not happening. Bursts still coalesce,
    // because anything arriving during the write or the rate window is held
    // and flushed after — the guaranteed final write.
    if (rateDelay === 0) {
      // The rejection cannot escape: flush() catches per write.
      void this.flush(deviceId);
      return;
    }

    queue.timer = this.timers.setTimeout(() => {
      queue.timer = null;
      void this.flush(deviceId);
    }, rateDelay);
  }

  /**
   * Write everything queued for one device.
   *
   * Re-entrant callers get the IN-FLIGHT flush's promise rather than
   * `undefined`, which is what lets drain() wait for a flush it did not start.
   */
  private flush(deviceId: string): Promise<void> {
    const queue = this.queues.get(deviceId);
    if (!queue) return Promise.resolve();
    if (queue.activeFlush) return queue.activeFlush;
    if (this.stopped) return Promise.resolve();

    const run = this.runFlush(deviceId, queue);
    queue.activeFlush = run;
    return run;
  }

  private async runFlush(deviceId: string, queue: DeviceQueue): Promise<void> {
    try {
      const snapshot = [...queue.pending.entries()];
      queue.pending.clear();
      if (snapshot.length === 0) return;

      queue.lastWriteAt = this.now();

      snapshot.sort((a, b) => WRITE_ORDER.indexOf(a[0]) - WRITE_ORDER.indexOf(b[0]));
      const turningOff = snapshot.find(([cap, write]) => cap === 'onoff' && write.value === false);
      if (turningOff) {
        snapshot.splice(snapshot.indexOf(turningOff), 1);
        snapshot.push(turningOff);
      }

      // Serialised per target; failures are independent so one bad write
      // never blocks the rest of this device's burst, let alone other devices.
      for (const [capability, write] of snapshot) {
        if (this.stopped) {
          for (const waiter of write.waiters) {
            waiter.settle({ status: 'cancelled', deviceId, capability, reason: 'scheduler stopped' });
          }
          continue;
        }
        const startedAt = this.now();
        try {
          await this.executor(deviceId, capability, write.value, { impliesOn: write.impliesOn });
          for (const waiter of write.waiters) {
            waiter.settle({
              status: 'succeeded', deviceId, capability,
              value: write.value, ms: this.now() - startedAt,
            });
          }
        } catch (error) {
          this.options.onError?.(deviceId, capability, error);
          // The message only. The adapter has already classified and redacted
          // it; an error OBJECT from the API boundary can quote the key back
          // inside itself (I2).
          const message = String((error as Error)?.message ?? error);
          for (const waiter of write.waiters) {
            waiter.settle({ status: 'failed', deviceId, capability, error: message });
          }
        }
      }
    } finally {
      queue.activeFlush = null;
    }

    // Anything that arrived mid-flush gets its own pass. This is the
    // guaranteed final write.
    if (queue.pending.size > 0 && !this.stopped) this.schedule(deviceId);
  }

  /**
   * Make room by dropping queues that can no longer affect anything.
   *
   * Reclaiming is what turns maxQueuedDevices into a bound on CONCURRENT
   * devices rather than on how many the app has ever written to. Without it a
   * household with 70 lights filled the map once and stayed full, after which
   * every further write to a 65th device was dropped in silence.
   *
   * The condition is exact, and getting it wrong costs the rate limit: an idle
   * queue still carries `lastWriteAt`, which is the ONLY thing stopping the
   * next write to that device going out immediately. So a queue is evictable
   * only once its rate window has also passed — at which point dropping it and
   * rebuilding it are indistinguishable.
   *
   * Lazy rather than timed: it runs when the cap is actually reached, which on
   * every normal Homey is never.
   */
  private reclaimIdleQueues(): number {
    const cutoff = this.now() - this.options.minWriteIntervalMs;
    let reclaimed = 0;
    for (const [deviceId, queue] of [...this.queues]) {
      if (queue.pending.size > 0 || queue.timer !== null || queue.activeFlush !== null) continue;
      if (queue.lastWriteAt > cutoff) continue;
      this.queues.delete(deviceId);
      reclaimed += 1;
    }
    return reclaimed;
  }

  /**
   * Write everything outstanding, and do not resolve until it has landed.
   *
   * The loop is not belt and braces: a flush can queue another pass (the
   * guaranteed final write), and a caller submitting mid-drain is exactly what
   * the Test control does. It ends when a full sweep finds nothing running,
   * nothing pending and no timer anywhere.
   */
  async drain(): Promise<void> {
    // Bounded so a pathological producer cannot spin here forever. 50 passes
    // is far beyond any real burst; reaching it means something upstream is
    // writing in a loop, and blocking teardown would be the worse failure.
    for (let pass = 0; pass < 50; pass += 1) {
      let worked = false;

      for (const [deviceId, queue] of [...this.queues]) {
        if (queue.timer !== null) {
          this.timers.clearTimeout(queue.timer);
          queue.timer = null;
          worked = true;
        }
        if (queue.activeFlush) {
          await queue.activeFlush;
          worked = true;
        }
        if (queue.pending.size > 0) {
          await this.flush(deviceId);
          worked = true;
        }
      }

      if (!worked) return;
    }
  }

  stop(): void {
    this.stopped = true;
    for (const queue of this.queues.values()) {
      if (queue.timer !== null) this.timers.clearTimeout(queue.timer);
      queue.timer = null;
      // Everything still queued is never going to be written. Say so, rather
      // than leaving a completion promise that never settles — a circadian
      // runtime awaiting one at teardown would hang the app's onUninit.
      for (const [capability, write] of queue.pending) {
        for (const waiter of write.waiters) {
          waiter.settle({
            status: 'cancelled', deviceId: deviceIdOf(this.queues, queue), capability,
            reason: 'scheduler stopped',
          });
        }
      }
      queue.pending.clear();
    }
    this.queues.clear();
  }

  /** Diagnostics only: how many devices are being tracked right now. */
  get trackedDevices(): number {
    return this.queues.size;
  }
}

/**
 * The id a queue is filed under.
 *
 * Only stop() needs it — every other path already has the id in hand — so the
 * queue does not carry one, and this reverse lookup runs once per device at
 * teardown rather than once per write.
 */
function deviceIdOf(queues: Map<string, DeviceQueue>, queue: DeviceQueue): string {
  for (const [deviceId, candidate] of queues) {
    if (candidate === queue) return deviceId;
  }
  return '';
}
