import { CommandScheduler } from '../outputs/command-scheduler';
import { LightTargetAdapter, type WriteRecord } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import { TargetStateCache } from '../outputs/target-state-cache';
import { planIntent, type PlannedWrite } from '../outputs/intent-planner';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';
import { cleanupResources } from '../runtime/runtime-resources';
import { messageOf } from '../support/homey-errors';
import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { TargetSpec } from '../outputs/light-intent';
import { eligibleTargets, type PowerChoice, type SetLightsPlan } from './set-lights';

/**
 * The write path behind the `set_lights` Flow card.
 *
 * A card can be pointed at any lights in the house, including lights no
 * Lightkeeper device owns, so it cannot borrow a runtime's resolver or its
 * queue — a runtime's targets are its own plan's, and its cache carries override
 * state this card has no business in. It gets its own, and one of each for the
 * whole app rather than one per invocation: a motion Flow can fire every few
 * seconds, and building a resolver, a cache and a queue each time would throw
 * away the capability metadata that makes the next pass correct.
 *
 * It follows the app's own rule about teardown — nothing survives it. The
 * scheduler is stopped and the adapter released in `destroy()`, which `app.ts`
 * calls from `onUninit` beside the four managers.
 */
export interface FlowLightWriterDeps {
  api: HomeyApiService;
  catalog: DeviceCatalog;
  log: (...args: unknown[]) => void;
  onWriteResult?: (entry: WriteRecord & { controllerId: string }) => void;
}

/** Which device the write records are filed under on the settings page. */
const SOURCE = 'flow-card';

export interface FlowWriteResult {
  writes: number;
  skipped: number;
  /** Set when nothing was written, and why. */
  refused?: string;
}

export class FlowLightWriter {
  private readonly cache = new TargetStateCache(() => Date.now());

  private readonly adapter: LightTargetAdapter;

  private readonly resolver: TargetResolver;

  private readonly scheduler: CommandScheduler;

  constructor(private readonly deps: FlowLightWriterDeps) {
    this.resolver = new TargetResolver(deps.catalog);
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log);
    if (deps.onWriteResult) {
      this.adapter.setWriteSink(entry => deps.onWriteResult?.({ ...entry, controllerId: SOURCE }));
    }
    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: DEFAULT_BEHAVIOR.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        deps.log(`Flow card write failed on ${deviceId}/${capability}:`, messageOf(error)),
    }, (deviceId, capability, value, options) =>
      this.adapter.write(deviceId, capability, value, options ?? {}));
  }

  /**
   * Run one pass: resolve the lights, refresh what they are, plan, write.
   *
   * The refresh is not optional and it is not an optimisation. The catalog is
   * cached and only invalidates on Homey events (platform §15), so a lamp
   * switched off by hand a minute ago can still read as on — and "only lights
   * already on" would then write to it, which is the one thing this card
   * promises not to do. `ScheduleRuntime.apply()` refreshes first for exactly
   * the same reason.
   *
   * The whole pass is awaited to the queue's drain, because a Flow card's own
   * result is what tells the user whether the card did anything.
   */
  async apply(spec: TargetSpec, plan: SetLightsPlan, power: PowerChoice): Promise<FlowWriteResult> {
    if (plan.refused) return { writes: 0, skipped: 0, refused: plan.refused };

    const resolved = await this.resolver.resolve(spec);
    if (resolved.devices.length === 0) {
      return { writes: 0, skipped: 0, refused: 'none of the chosen lights are there any more' };
    }
    this.resolver.primeCache(resolved.devices, this.cache);

    const all = resolved.devices.map(device => device.id);
    await Promise.all(all.map(id => this.adapter.refresh(id)));

    const targets = eligibleTargets(all, power, id => this.cache.state(id).actualOn === true);
    if (targets.length === 0) {
      return { writes: 0, skipped: all.length, refused: 'none of the chosen lights are on' };
    }

    /**
     * One submit for every intent together, not one per intent.
     *
     * That is what makes this a single ordered burst: `WRITE_ORDER` inside the
     * queue is what puts `light_mode` ahead of the hue it enables and `onoff`
     * ahead of the level, and it can only order writes it is given at once.
     * Submitting per intent would reproduce, inside one card, the very stepping
     * that three built-in cards do.
     */
    const writes: PlannedWrite[] = [];
    let skipped = all.length - targets.length;
    for (const intent of plan.intents) {
      const planned = planIntent(intent, targets, this.cache, DEFAULT_BEHAVIOR);
      writes.push(...planned.writes);
      skipped += planned.skipped.length;
    }

    if (writes.length === 0) return { writes: 0, skipped, refused: 'none of these lights can be set that way' };

    this.scheduler.submit(writes);
    await this.scheduler.drain();
    return { writes: writes.length, skipped };
  }

  async destroy(): Promise<void> {
    this.scheduler.stop();
    this.adapter.suspend();
    await cleanupResources([
      () => this.adapter.unsubscribeAll(),
    ], this.deps.log);
  }
}
