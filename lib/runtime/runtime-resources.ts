import { randomUUID } from 'node:crypto';
import { KeyedMutex } from '../support/keyed-mutex';
import { messageOf } from '../support/homey-errors';
import type { LuminanceSource } from '../daylight/luminance-source';

/** Start before publishing, but always dispose a partially acquired runtime. */
export async function startRuntime<T extends { stop(): Promise<void> }>(
  runtime: T,
  start: () => Promise<void>,
  log: (...args: unknown[]) => void,
): Promise<T> {
  try {
    await start();
    return runtime;
  } catch (error) {
    await cleanupResources([() => runtime.stop()], log);
    throw error;
  }
}

/** One broken teardown must not abandon the resources behind it. */
export async function cleanupResources(
  cleanups: Array<() => Promise<unknown> | void>,
  log: (...args: unknown[]) => void,
): Promise<void> {
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { log('Resource cleanup failed:', messageOf(error)); }
  }
}

export function previewOwner(): string { return `__preview-${randomUUID()}__`; }

/**
 * Stop invalidates work immediately, then waits for acquisitions to settle before
 * disposing them. A queued refresh belongs to the generation that requested it.
 */
export class RuntimeLifetime {
  private generation = 0;
  private active = false;
  private readonly lock = new KeyedMutex();

  current(): () => boolean {
    const generation = this.generation;
    return () => this.active && this.generation === generation;
  }

  start(work: (current: () => boolean) => Promise<void>): Promise<void> {
    this.active = true;
    this.generation += 1;
    return this.run(work);
  }

  run(work: (current: () => boolean) => Promise<void>): Promise<void> {
    const current = this.current();
    return this.lock.run('resources', async () => { if (current()) await work(current); });
  }

  stop(cleanup: () => Promise<void>): Promise<void> {
    this.active = false;
    this.generation += 1;
    return this.lock.run('resources', cleanup);
  }
}

/** The claim is separate from the evaluator: reading a value never acquires it. */
export class SensorClaim {
  constructor(private readonly source: LuminanceSource | undefined, private readonly owner: string) {}

  async retain(ids: string[]): Promise<void> { await this.source?.retain(ids, this.owner); }
  async release(): Promise<void> { await this.source?.release(this.owner); }
}
