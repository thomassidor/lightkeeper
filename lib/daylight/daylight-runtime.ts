import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import { CommandScheduler, type WriteOutcome } from '../outputs/command-scheduler';
import { LightTargetAdapter, type WriteRecord } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import {
  OVERRIDE_SETTLE_MS,
  OVERRIDE_TOLERANCE,
  TargetStateCache,
} from '../outputs/target-state-cache';
import { planIntent, type Capability, type PlannedWrite } from '../outputs/intent-planner';
import { toDevice, toPerceptual } from '../outputs/light-intent';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { assessTargets } from '../runtime/target-health';
import {
  diffTargets, releaseTarget, resolveSnapshot, type TargetSnapshot,
} from '../outputs/target-snapshot';
import { fireAndForget } from '../support/async';
import { withDefaults, type Timers } from '../support/timers';
import type { DaylightPlan } from './daylight-types';
import type { DaylightEvaluator, DaylightVerdict } from './daylight-evaluator';
import type { LuminanceSource, WatchedSensor } from './luminance-source';
import { messageOf } from '../support/homey-errors';
import { VisibleState } from '../runtime/visible-state';

/**
 * One Daylight light, live.
 *
 * The brightness-only sibling of `CircadianRuntime`, and shorter than it by
 * everything a colour brings: no palette, no `light_mode`, no hue override, and
 * — the one worth stating — **no pre-staging at all**. Pre-staging is a
 * colour-only idea because a `dim` write turns an off lamp on (measured on Hue,
 * platform §6), so a device type whose only axis is brightness has nothing to
 * pre-stage and no option to get wrong. It writes to lamps that are already on
 * and never switches one on or off, which is the same promise the two
 * curve-driven types make (platform §12).
 *
 * Three things cause a write, and they are the circadian runtime's three:
 *
 *  1. **A light was switched on.** The rising edge of `onoff`, over the
 *     capability subscription we already hold, so a lamp lands at the right
 *     level however it was switched on. Forced past every gate below, because
 *     the lamp has just restored whatever level it was last at.
 *  2. **The tick**, once a minute from the manager's single shared timer.
 *  3. **Start, and any change of plan or targets.**
 *
 * What is NEW here, and is the whole of the interesting engineering, is the pair
 * of dampers in §"the two gates" below. A light sensor in the same room as the
 * lamps it drives measures those lamps too, so this is a closed loop, and an
 * undamped closed loop hunts.
 */

export interface DaylightRuntimeDeps {
  /** @see WriteRecord — one app-wide log of every write by ANY runtime. */
  onWriteResult?: (entry: WriteRecord) => void;
  api: HomeyApiService;
  catalog: DeviceCatalog;
  /** Sun position and sensor readings, already resolved. See daylight-evaluator.ts. */
  daylight: DaylightEvaluator;
  /** Shared, ref-counted; this runtime retains its own plan's sensors and no others. */
  luminance: LuminanceSource;
  displayName: () => string;
  now?: () => number;
  log: (...args: unknown[]) => void;
  onStateChange: (state: ControllerState, detail?: StateDetail) => void;
}

export interface DaylightAction {
  at: number;
  reason: string;
  /** Perceptual brightness the response asked for, before slewing. */
  brightness?: number;
  level?: number;
  source?: string;
  elevation?: number | null;
  writes: number;
  skipped: number;
  /** Why a pass planned nothing. Absent on a pass that did something. */
  detail?: string;
}

export interface DaylightDiagnostics {
  controllerId: string;
  kind: 'daylight';
  stateRevision: number;
  name: string;
  state: ControllerState;
  enabled: boolean;
  response: DaylightPlan['response'];
  /** What the response asks for right now, and where that came from. */
  now: DaylightVerdict;
  /** Every sensor this device named, with its reading and that reading's AGE. */
  sensors: WatchedSensor[];
  targetIds: string[];
  targetNames: string[];
  targets: Array<{
    id: string;
    on: boolean | null;
    canDim: boolean;
    overridden: boolean;
    /** Perceptual level this lamp is being held at. */
    aim: number | null;
  }>;
  lastAction: DaylightAction | null;
  recentFailures: ReturnType<LightTargetAdapter['failures']>;
  recentWrites: readonly WriteRecord[];
  schedulerReady: boolean;
}

/**
 * The two gates, and between them they are why this device type does not hunt.
 *
 * A `measure_luminance` sensor in the room whose lamps this drives reads those
 * lamps as well as the sky, so raising the lamps raises the reading, which lowers
 * the lamps, which lowers the reading. That is a control loop, and the honest
 * position is that the app damps it rather than removing it — the FAQ says so,
 * and names the sensor placements that avoid it altogether.
 *
 * `DAYLIGHT_DEADBAND` is a deadband, in PERCEPTUAL units, measured against what
 * was last actually written to that lamp. Under it, nothing moves. That is what
 * makes the loop SETTLE instead of orbiting: once inside the band there is no
 * next write to provoke the next reading. 0.02 is finer than the eye on a wall
 * and coarser than the jitter of a sensor reporting to two decimals.
 *
 * `MAX_STEP_PER_TICK` is a slew limit, also perceptual, also per lamp. It turns
 * a large step into a ramp over a minute or two, which does two jobs: any
 * residual hunting is gentle rather than a room flashing, and a genuine change
 * (a cloud, a curtain) arrives as a fade instead of a jump.
 *
 * They must stay in this order — the slew strictly larger than the deadband.
 * Were the step per tick smaller than the band, a target just outside the band
 * would be approached in increments that never leave it, and the lamp would
 * creep and stall.
 */
const DAYLIGHT_DEADBAND = 0.02;
const MAX_STEP_PER_TICK = 0.05;


/** The only two axes this device type has any business with. */
const WATCHED: Capability[] = ['onoff', 'dim'];

export class DaylightRuntime {
  private readonly cache = new TargetStateCache();
  private readonly adapter: LightTargetAdapter;
  private readonly resolver: TargetResolver;
  private readonly timers: Timers;
  private scheduler: CommandScheduler | null = null;
  private snapshot: TargetSnapshot | null = null;
  private targetIds: string[] = [];
  private targetNames: string[] = [];
  private readonly visible: VisibleState;
  private lastAction: DaylightAction | null = null;

  /**
   * Lights somebody has taken control of by hand, and when.
   *
   * Per device, never persisted: a restart is a clean slate, which is the right
   * bias for a feature whose whole job is to be correct by default. Cleared by
   * either edge of `onoff` — "switch it off and on again" is the gesture people
   * already have for putting a light back to how it ought to be.
   */
  private readonly overrides = new Map<string, { at: number; value: number }>();

  /**
   * Where each lamp is currently AIMED, on the perceptual axis.
   *
   * Advanced on every pass that decides to move, whether or not a write goes
   * out — and that is the whole reason it is separate from `committed` below.
   *
   * Folding the two together stalls, and it stalled in a test before it could
   * stall in a living room. `dim` on a lamp declaring `decimals: 1` moves in
   * tenths, so through γ = 2.2 every perceptual aim from 0.10 to about 0.45
   * quantises to the SAME `dim` of 0.1. Those writes are genuine no-ops and are
   * rightly dropped — but if the aim only advanced when a write succeeded, it
   * would never leave 0.10: the next pass would recompute the same step from the
   * same place, drop the same no-op, and the lamp would sit at a tenth for ever
   * while the room went dark around it. An aim that advances regardless crosses
   * that plateau in a few quiet ticks and writes the moment the lamp can
   * actually show the difference.
   */
  private readonly aim = new Map<string, number>();

  /**
   * What each lamp was last CONFIRMED to be holding: the device value that
   * landed, and when.
   *
   * Success-gated, unlike the aim, and for the reason the circadian runtime
   * learned the hard way — a write that was coalesced away or that failed must
   * not be recorded as landed, or the no-op filter suppresses the retry for
   * ever. The timestamp is the settle window, so our own echo is not read as
   * somebody reaching for a dimmer.
   */
  private readonly committed = new Map<string, { device: number; at: number }>();

  constructor(
    readonly controllerId: string,
    private plan: DaylightPlan,
    private readonly deps: DaylightRuntimeDeps,
  ) {
    // Constructor BODY, like `timers` below: a field initialiser runs before
    // the parameter property `deps` is assigned.
    this.visible = new VisibleState((state, detail) => deps.onStateChange(state, detail));
    this.timers = withDefaults({ ...(deps.now !== undefined ? { now: deps.now } : {}) });
    this.resolver = new TargetResolver(deps.catalog);
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log);
    if (deps.onWriteResult) this.adapter.setWriteSink(deps.onWriteResult);
  }

  get currentState(): ControllerState { return this.visible.current; }
  get currentDetail(): StateDetail | undefined { return this.visible.currentDetail; }
  get currentPlan(): DaylightPlan { return this.plan; }

  private now(): number { return this.timers.now(); }

  async start(): Promise<void> {
    await this.buildRuntime();
    await this.assessHealth();
    // Not deferred to the first tick: a restart at dusk must correct the room
    // now, not in up to a minute's time.
    await this.applyNow('start');
  }

  /** Targets, cache, queue and subscriptions — no health, no writes. */
  async startIdle(): Promise<void> {
    await this.buildRuntime();
  }

  private async buildRuntime(): Promise<void> {
    const resolved = await resolveSnapshot(this.resolver, this.plan.target);
    this.snapshot = resolved;
    this.targetIds = resolved.ids;
    this.targetNames = resolved.names;
    this.resolver.primeCache(resolved.devices, this.cache);

    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: DEFAULT_BEHAVIOR.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        this.deps.log(`Write failed on ${deviceId}/${capability}:`, messageOf(error)),
    }, (deviceId, capability, value, options) =>
      this.adapter.write(deviceId, capability, value, options));

    // Ref-counted and shared: five devices naming one sensor cost one
    // subscription. Total for this owner, so a sensor dropped from the plan is
    // released by the same call that retains the new one.
    await this.deps.luminance.retain(this.plan.response.sensors, this.controllerId);

    // Once, here. The tick deliberately does NOT refresh: live values arrive
    // over the subscriptions below, and re-reading every target every minute
    // would put a round trip per light per minute into an app that otherwise
    // only talks to Homey when something happens.
    await Promise.all(this.targetIds.map(id => this.adapter.refresh(id)));
    await this.subscribeAll();
  }

  private async subscribeAll(): Promise<void> {
    for (const deviceId of this.targetIds) {
      await this.adapter.subscribe(deviceId, WATCHED, (id, capability, value, external) =>
        this.onCapabilityChange(id, capability, value, external));
    }
  }

  /**
   * A target's capability changed. `external` is the cache's verdict on whether
   * it was a real change or the echo of our own write — and because echoes
   * arrive duplicated (platform §6), it is also what makes one power-on produce
   * exactly one response rather than two.
   */
  private onCapabilityChange(
    deviceId: string,
    capability: Capability,
    value: unknown,
    external: boolean,
  ): void {
    if (!external) return;

    if (capability === 'onoff') {
      if (this.overrides.delete(deviceId)) {
        this.deps.log(`${deviceId} was power-cycled; daylight control resumes`);
      }

      if (value === true) {
        // The whole point of the feature, and forced past both gates: the lamp
        // has just restored whatever level it was last at, so what we sent it an
        // hour ago says nothing about where it is now. Slewing here would look
        // like a fault rather than a feature.
        fireAndForget(
          this.applyNow('switched on', { deviceIds: [deviceId], force: true }),
          this.deps.log,
          `Daylight apply on power-on for ${deviceId}`,
        );
      } else {
        // Off: forget both records, for the same reason. A lamp restores
        // whatever level it was last at, which neither of them now describes.
        this.aim.delete(deviceId);
        this.committed.delete(deviceId);
      }
      return;
    }

    if (capability === 'dim') this.noteOverride(deviceId, value);
  }

  /** Somebody changed this light's level by hand. Stand down for it. */
  private noteOverride(deviceId: string, value: unknown): void {
    const reported = Number(value);
    if (!Number.isFinite(reported)) return;

    const last = this.committed.get(deviceId);
    if (last) {
      // Still settling from our own write, or within the rounding a bridge is
      // entitled to apply to it.
      if (this.now() - last.at < OVERRIDE_SETTLE_MS) return;
      if (Math.abs(reported - last.device) <= OVERRIDE_TOLERANCE) return;
    }

    if (!this.overrides.has(deviceId)) {
      this.deps.log(
        `${deviceId} was dimmed by hand (${reported}); daylight will leave it alone `
        + 'until it is switched off and on again',
      );
    }
    this.overrides.set(deviceId, { at: this.now(), value: reported });
  }

  /** Once a minute, from the manager's single shared timer. */
  async tick(): Promise<void> {
    await this.applyNow('tick');
  }

  /** Write everything outstanding now rather than when the rate limit allows. */
  async drain(): Promise<void> {
    await this.scheduler?.drain();
  }

  /** What the response asks for right now. Never throws, never a NaN. */
  currentValue(): DaylightVerdict {
    return this.deps.daylight.evaluate(this.plan.response);
  }

  async applyNow(
    reason: string,
    options: { deviceIds?: string[]; force?: boolean } = {},
  ): Promise<{ writes: number; skipped: number }> {
    if (!this.plan.enabled) return this.noteNothingToDo(reason, 'the plan is switched off');

    const verdict = this.currentValue();
    /**
     * Nothing to go on, so nothing is written — and this is the case the whole
     * "keep the fixed value beside the flag" decision was made for. Here, on the
     * device type whose plan IS a response, there is no fixed value to fall back
     * to, so the honest act is to leave the lamps exactly as they are and report
     * why. `assessHealth` puts the device into needs_repair for the same reason.
     */
    if (verdict.source === 'none') {
      return this.noteNothingToDo(reason, 'there is no sun position and no usable sensor');
    }

    const candidates = options.deviceIds ?? this.targetIds;
    if (candidates.length === 0) return this.noteNothingToDo(reason, 'no lights are selected');

    let skipped = 0;
    const wanted = new Map<string, number>();

    for (const deviceId of candidates) {
      if (!options.force && this.overrides.has(deviceId)) {
        skipped += 1;
        continue;
      }

      /**
       * Only lamps that are already on, and there is no option to change that.
       *
       * A `dim` write turns an off lamp on — measured, not suspected — so a
       * Daylight light that wrote to off lamps would switch a household's lights
       * on one at a time through the night. The circadian types make this a
       * per-plan choice because a COLOUR write is only sometimes on; brightness
       * always is.
       */
      if (this.cache.state(deviceId).actualOn !== true) {
        skipped += 1;
        continue;
      }

      // Always an aim, even when the deadband says do not move it: the aim IS
      // the state, and the decision about whether that state needs a write is
      // the no-op filter's in planWrites().
      wanted.set(deviceId, this.aimFor(deviceId, verdict.brightness, options.force === true));
    }

    const writes = this.planWrites(wanted, options.force === true);
    // Recorded here rather than in noteOutcomes: an aim that only advanced on a
    // successful write would stall on any lamp whose resolution swallows a slew
    // step. See the `aim` field.
    for (const [deviceId, level] of wanted) this.aim.set(deviceId, level);

    if (!this.scheduler) {
      // Recorded rather than swallowed: writes counted against a queue that does
      // not exist looks exactly like a working app with no effect.
      this.deps.log('No scheduler: the daylight runtime is not started, so writes were dropped');
      return this.noteNothingToDo(reason, 'the runtime is not started, so writes were dropped', skipped);
    }

    if (writes.length > 0) {
      const { completion } = this.scheduler.submit(writes);
      // Bookkeeping behind the completion, for the reason the circadian runtime
      // learned it: recording a write the scheduler coalesced away — or one that
      // failed — as done tells both gates the lamp is already where it needs to
      // be, and then every later tick agrees and the lamp never moves again.
      fireAndForget(
        completion.then(outcomes => this.noteOutcomes(outcomes)),
        this.deps.log,
        'Daylight write bookkeeping',
      );
    }

    this.lastAction = {
      at: this.now(),
      reason,
      brightness: verdict.brightness,
      level: verdict.level,
      source: verdict.source,
      elevation: verdict.elevation,
      writes: writes.length,
      skipped,
    };

    return { writes: writes.length, skipped };
  }

  private noteNothingToDo(
    reason: string,
    detail: string,
    skipped = 0,
  ): { writes: number; skipped: number } {
    this.lastAction = { at: this.now(), reason, detail, writes: 0, skipped };
    return { writes: 0, skipped };
  }

  /**
   * Where this lamp should aim this pass. Never null — the decision about
   * whether to WRITE is the no-op filter's, not this function's.
   *
   * Two gates, and separating them this way is what makes the loop both settle
   * and converge:
   *
   *  1. **Deadband.** If the response has moved less than `DAYLIGHT_DEADBAND`
   *     from where we are already aiming, the aim does not move. That is what
   *     makes the loop SETTLE: once inside the band there is no new aim, so no
   *     new write, so nothing to provoke the next reading.
   *  2. **Slew.** Otherwise the aim advances toward the target by at most
   *     `MAX_STEP_PER_TICK`, from the aim rather than from the lamp's reported
   *     level. The first pass has no aim to advance and seeds from the lamp's
   *     real level, which is where starting-from-where-it-actually-is belongs.
   *
   * Note it does NOT snap to the target once inside the band. Snapping would
   * make the settled aim jitter with the reading, and the aim is what the next
   * pass's deadband is measured against.
   */
  private aimFor(deviceId: string, wanted: number, force: boolean): number {
    if (force) return wanted;

    const current = this.aim.get(deviceId);
    if (current === undefined) {
      const reported = this.cache.currentDim(deviceId);
      if (reported === undefined) return wanted;
      return this.step(toPerceptual(reported), wanted);
    }

    if (Math.abs(wanted - current) < DAYLIGHT_DEADBAND) return current;
    return this.step(current, wanted);
  }

  private step(from: number, to: number): number {
    const delta = to - from;
    if (Math.abs(delta) <= MAX_STEP_PER_TICK) return to;
    return from + Math.sign(delta) * MAX_STEP_PER_TICK;
  }

  /**
   * One `brightness_absolute` intent per distinct level, then the no-op filter.
   *
   * Grouped by level rather than one intent per device because that is what
   * `planIntent` is shaped for, and because in the overwhelmingly common case —
   * every lamp in step — it is one call. `litDim` inside it is what keeps a
   * positive brightness from being written as darkness at the bottom of the axis.
   */
  private planWrites(wanted: Map<string, number>, force: boolean): PlannedWrite[] {
    const byLevel = new Map<number, string[]>();
    for (const [deviceId, level] of wanted) {
      const group = byLevel.get(level);
      if (group === undefined) byLevel.set(level, [deviceId]);
      else group.push(deviceId);
    }

    const planned: PlannedWrite[] = [];
    for (const [level, deviceIds] of byLevel) {
      const plan = planIntent(
        { type: 'brightness_absolute', value: toDevice(level) },
        deviceIds, this.cache, DEFAULT_BEHAVIOR,
      );
      /**
       * A write whose DEVICE value equals the last one that landed is provably a
       * no-op at the lamp, and dropping it is free.
       *
       * Per device, not per batch — the same rule the circadian runtime's
       * temperature leg had to learn. There is only one capability in play here
       * so the `NaN`-on-`light_mode` trap cannot bite, but the shape is kept the
       * same so the two read alike.
       */
      planned.push(...plan.writes.filter(write =>
        force || this.deviceValueMoved(write.deviceId, write.value as number)));
    }
    return planned;
  }

  private deviceValueMoved(deviceId: string, next: number): boolean {
    const last = this.committed.get(deviceId);
    return last === undefined || last.device !== next;
  }

  /**
   * Record what actually LANDED, from the batch's outcomes.
   *
   * Only `succeeded` counts. `failed`, `dropped_capacity` and `cancelled` all
   * leave the device eligible again on the next tick, which is the whole
   * recovery mechanism this runtime has — and a `coalesced` write means a newer
   * batch owns that capability, so claiming this one landed would suppress the
   * retry that batch IS.
   *
   * Only the DEVICE value is recorded, and that is the point of the split: the
   * aim is already recorded by the pass that computed it, and reading a
   * perceptual value back out of `toPerceptual(outcome.value)` would be lossy —
   * the round trip through γ = 2.2 and the capability's `decimals` means every
   * pass would start a little short of where the last one finished.
   */
  private noteOutcomes(outcomes: WriteOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.status !== 'succeeded') continue;
      if (outcome.capability !== 'dim') continue;
      this.committed.set(outcome.deviceId, {
        device: outcome.value as number,
        at: this.now(),
      });
    }
  }

  async assessHealth(): Promise<void> {
    if (!this.plan.enabled) {
      this.setState('disabled');
      return;
    }

    const assessment = await assessTargets(
      this.deps.catalog, this.plan.target, this.adapter.unwritableTargets(),
    );
    if (assessment.state === 'needs_repair') {
      this.setState(assessment.state, assessment.detail);
      return;
    }

    /**
     * A Daylight light pointed at lamps that cannot dim does nothing at all, and
     * would otherwise report 'ready' for ever. Some-but-not-all is already
     * 'partial' by way of assessTargets — a group where three of five lamps dim
     * still works, and says so.
     */
    const drivable = this.targetIds.filter(id => this.cache.supports(id, 'dim'));
    if (this.targetIds.length > 0 && drivable.length === 0) {
      this.setState('needs_repair', {
        key: 'state.noDimTargets',
        text: 'None of its lights can change their brightness.',
      });
      return;
    }

    /**
     * Nothing to read the daylight FROM, which is this device type's own way of
     * being misconfigured: no usable light sensor and no position to compute a
     * sun elevation from — the permission refused, or a Homey that has never
     * been told where it is (platform §16).
     *
     * Checked after the target legs, so "your lamps are gone" is reported ahead
     * of "and it does not know where the sun is": the first is the one a person
     * can act on.
     */
    if (this.currentValue().source === 'none') {
      this.setState('needs_repair', {
        key: 'state.noDaylightSource',
        text: 'It cannot tell how light it is: no light sensor, and no location.',
      });
      return;
    }

    this.setState(assessment.state, assessment.detail);
  }

  /** Devices or zones changed: re-resolve without tearing the queue down. */
  async refreshTargets(): Promise<void> {
    const next = await resolveSnapshot(this.resolver, this.plan.target);
    // The fingerprint, not the id list — see target-snapshot.ts. It matters here
    // for the same reason it matters to a curve: every write is clamped and
    // quantised against the target's own `dim` options, so a lamp re-paired
    // under the same id with different `decimals` would be gated against a
    // resolution it no longer has.
    if (this.snapshot && this.snapshot.fingerprint === next.fingerprint) return;

    const { removed } = diffTargets(this.snapshot, next);
    for (const deviceId of removed) {
      // The acceptance bar: after a light leaves the plan, switching it on must
      // produce ZERO writes. It kept its capability subscription otherwise, and
      // the rising edge of `onoff` is THE feature — so the runtime dutifully
      // dimmed a lamp that was no longer any of its business.
      await releaseTarget(deviceId, {
        unsubscribe: id => this.adapter.unsubscribe(id),
        cancelPending: id => this.adapter.cancelPending(id),
        cache: this.cache,
      });
      this.overrides.delete(deviceId);
      this.aim.delete(deviceId);
      this.committed.delete(deviceId);
    }

    this.snapshot = next;
    this.targetIds = next.ids;
    this.targetNames = next.names;
    this.resolver.primeCache(next.devices, this.cache);
    await Promise.all(next.ids.map(id => this.adapter.refresh(id)));
    await this.subscribeAll();
    this.deps.log(`Daylight targets re-resolved: ${next.ids.length} light(s)`);

    await this.applyNow('targets changed');
    await this.assessHealth();
  }

  async updatePlan(plan: DaylightPlan): Promise<void> {
    this.plan = plan;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.scheduler = null;
    // The adapter's own pending checks outlive this runtime unless released.
    await this.adapter.unsubscribeAll();
    // Ref-counted, so this releases only this device's claim: a sensor another
    // Lightkeeper device also named keeps its subscription.
    await this.deps.luminance.release(this.controllerId);
    this.cache.clear();
    this.overrides.clear();
    // Cleared for the reason the circadian runtime's colour record had to be:
    // `updatePlan()` is stop-then-start and `start()`'s own apply is NOT forced,
    // so a record from the old plan would have the deadband decline the new
    // plan's first write.
    this.aim.clear();
    this.committed.clear();
    this.targetIds = [];
    this.targetNames = [];
    // Or the next refresh diffs the new plan's targets against the old plan's.
    this.snapshot = null;
  }

  /**
   * There are no Flows to remove, which is the one line worth writing here: a
   * reader coming from ControllerRuntime or ScheduleRuntime will look for the
   * bridge cleanup and should find out immediately that there is none.
   */
  async destroy(): Promise<void> {
    await this.stop();
  }

  private setState(state: ControllerState, detail?: StateDetail): void {
    this.visible.set(state, detail);
  }

  /** Never exposes secrets or unrelated Homey configuration. */
  diagnostics(): DaylightDiagnostics {
    return {
      controllerId: this.controllerId,
      kind: 'daylight',
      stateRevision: this.visible.revision,
      name: this.deps.displayName(),
      state: this.visible.current,
      enabled: this.plan.enabled,
      response: this.plan.response,
      now: this.currentValue(),
      // Filtered to this device's own sensors: the service is shared, and a
      // report listing another device's sensors is a report that sends the
      // reader to the wrong room.
      sensors: this.deps.daylight.sensors()
        .filter(sensor => this.plan.response.sensors.includes(sensor.deviceId)),
      targetIds: this.targetIds,
      targetNames: this.targetNames,
      targets: this.targetIds.map(id => ({
        id,
        on: this.cache.state(id).actualOn ?? null,
        canDim: this.cache.supports(id, 'dim'),
        overridden: this.overrides.has(id),
        aim: this.aim.get(id) ?? null,
      })),
      lastAction: this.lastAction,
      recentFailures: this.adapter.failures(),
      recentWrites: this.adapter.writes(),
      schedulerReady: this.scheduler !== null,
    };
  }
}
