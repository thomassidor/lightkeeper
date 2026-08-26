import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import { CommandScheduler } from '../outputs/command-scheduler';
import { LightTargetAdapter } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import { TargetStateCache } from '../outputs/target-state-cache';
import { planIntent, type Capability, type PlannedWrite } from '../outputs/intent-planner';
import { toDevice } from '../outputs/light-intent';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { assessTargets } from '../runtime/target-health';
import { fireAndForget } from '../support/async';
// The Homey's own wall clock is not schedule-specific — it lives under
// lib/schedules/ because that is where it was needed first. Importing it beats
// a second copy of the Intl handling and its fallback.
import { describeClock, localNow } from '../schedules/local-time';
import { nextPointAfter, resolvePoints, valueAt, type CurveValue } from './circadian-curve';
import { formatMinutes, type CircadianPlan } from './circadian-types';

/**
 * One circadian light, live.
 *
 * There are no Flows here and there is no clock to wait for. A schedule fires at
 * boundaries, which is why it delegates timekeeping to the Flow engine
 * (CLAUDE.md §9); a circadian curve has a value at every minute, so the runtime
 * simply asks the curve where it is whenever it has reason to. It has three:
 *
 *  1. **A light was switched on.** The reason this feature exists. Homey reports
 *     the rising edge of `onoff` over the capability subscription we already
 *     hold, and the right colour goes out immediately — so a lamp is correct
 *     however it was switched on: the wall switch, the Hue app, another Flow, a
 *     Lightkeeper remote.
 *  2. **The tick**, once a minute from the manager's single shared timer. Only
 *     lights that are on, only where the curve has moved by at least one step of
 *     the capability's own resolution.
 *  3. **Start, and any change of plan or targets**, so a restart mid-evening
 *     corrects the room rather than waiting for the next minute.
 *
 * Everything reached from here is shared with the remote controller and the
 * schedule: the same resolver, capability cache, write planner and write queue.
 */

export interface CircadianRuntimeDeps {
  api: HomeyApiService;
  catalog: DeviceCatalog;
  /** The Homey's IANA timezone, or undefined to fall back to process-local. */
  timezone: () => string | undefined;
  /** The device's name, for logs and diagnostics. */
  displayName: () => string;
  now?: () => number;
  /** Injectable so the pre-stage probe does not cost tests a real 1.5 seconds. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  log: (...args: unknown[]) => void;
  onStateChange: (state: ControllerState, detail?: StateDetail) => void;
  /**
   * Kept even though there are no managed Flows to persist: pre-staging can turn
   * ITSELF off after observing a light come on, and that verdict has to survive a
   * restart or the same lamp gets switched on again tomorrow night.
   */
  onPlanChange: (plan: CircadianPlan) => void;
}

export interface CircadianAction {
  at: number;
  reason: string;
  warmth: number;
  brightness?: number;
  writes: number;
  skipped: number;
}

/**
 * How far a reported colour must be from the one we wrote before it counts as
 * somebody overriding us.
 *
 * Comfortably above `light_temperature`'s own 0.01 resolution (CLAUDE.md §6), so
 * a bridge that rounds our 0.47 to 0.46 does not read as a human reaching for
 * the Hue app — and far below any change a person would make on purpose.
 */
const OVERRIDE_TOLERANCE = 0.03;

/**
 * Changes arriving this soon after our own write are ours: a bridge can report
 * an intermediate value part-way through a transition, and the echo dedupe in
 * TargetStateCache only covers an EXACT repeat within 1.5 s.
 */
const SETTLE_MS = 3000;

/** Mirrors the adapter's own post-write check, in the opposite direction. */
const PRE_STAGE_CHECK_MS = 1500;

export class CircadianRuntime {
  private readonly cache = new TargetStateCache();
  private readonly adapter: LightTargetAdapter;
  private readonly resolver: TargetResolver;
  private scheduler: CommandScheduler | null = null;
  private targetIds: string[] = [];
  private targetNames: string[] = [];
  private state: ControllerState = 'disabled';
  private lastAction: CircadianAction | null = null;

  /**
   * Lights somebody has taken control of by hand, and when.
   *
   * Per device, never persisted: a restart is a clean slate, which is the right
   * bias for a feature whose whole job is to be correct by default. Cleared by
   * either edge of `onoff` — "switch it off and on again" is the gesture people
   * already have for putting a light back to how it ought to be.
   */
  private readonly overrides = new Map<string, { at: number; value: number }>();

  /** What we last sent each light, in DEVICE values, and when. */
  private readonly lastWritten = new Map<string, { warmth?: number; brightness?: number; at: number }>();

  /** Set when pre-staging disabled itself; reported in diagnostics, never hidden. */
  private preStageDisabled: { at: number; deviceId: string } | null = null;

  private readonly probes = new Set<unknown>();

  constructor(
    readonly controllerId: string,
    private plan: CircadianPlan,
    private readonly deps: CircadianRuntimeDeps,
  ) {
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log);
    this.resolver = new TargetResolver(deps.catalog);
  }

  get currentState(): ControllerState { return this.state; }
  get currentPlan(): CircadianPlan { return this.plan; }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.setTimeout ? this.deps.setTimeout(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimeout) this.deps.clearTimeout(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  async start(): Promise<void> {
    await this.buildRuntime();
    await this.assessHealth();
    // Not deferred to the first tick: a restart at 21:00 must correct the room
    // now, not in up to a minute's time.
    await this.applyNow('start');
  }

  /** Targets, cache, queue and subscriptions — no health, no writes. */
  async startIdle(): Promise<void> {
    await this.buildRuntime();
  }

  private async buildRuntime(): Promise<void> {
    const resolved = await this.resolver.resolve(this.plan.target);
    this.targetIds = resolved.devices.map(d => d.id);
    this.targetNames = resolved.devices.map(d => `${d.name} (${d.zoneName})`);
    this.resolver.primeCache(resolved.devices, this.cache);

    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: DEFAULT_BEHAVIOR.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        this.deps.log(`Write failed on ${deviceId}/${capability}:`, (error as Error)?.message),
    }, (deviceId, capability, value, options) =>
      this.adapter.write(deviceId, capability, value, options));

    // Once, here. The tick deliberately does NOT refresh: live values arrive over
    // the subscriptions below, and re-reading every target every minute would put
    // a round trip per light per minute into an app that otherwise only talks to
    // Homey when something happens. (The schedule runtime does refresh before it
    // acts — it fires twice a day, off a cache that may be hours stale.)
    await Promise.all(this.targetIds.map(id => this.adapter.refresh(id)));
    await this.subscribeAll();
  }

  private async subscribeAll(): Promise<void> {
    const capabilities: Capability[] = ['onoff', 'light_temperature'];
    if (this.plan.adjustBrightness) capabilities.push('dim');

    for (const deviceId of this.targetIds) {
      await this.adapter.subscribe(deviceId, capabilities, (id, capability, value, external) =>
        this.onCapabilityChange(id, capability, value, external));
    }
  }

  /**
   * A target's capability changed. `external` is the cache's verdict on whether
   * it was a real change or the echo of our own write — and because echoes
   * arrive duplicated (CLAUDE.md §6), it is also what makes one power-on produce
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
        this.deps.log(`${deviceId} was power-cycled; circadian control resumes`);
      }

      if (value === true) {
        // The whole point of the feature. Forced past the "has the curve moved"
        // gate: the lamp has just restored whatever colour it was last at, so
        // what we wrote an hour ago says nothing about what it is showing now.
        fireAndForget(
          this.applyNow('switched on', { deviceIds: [deviceId], force: true }),
          this.deps.log,
          `Circadian apply on power-on for ${deviceId}`,
        );
      } else {
        // Off: forget what we wrote, for the same reason.
        this.lastWritten.delete(deviceId);
      }
      return;
    }

    if (capability === 'light_temperature') this.noteOverride(deviceId, 'warmth', value);
    if (capability === 'dim' && this.plan.adjustBrightness) this.noteOverride(deviceId, 'brightness', value);
  }

  /** Somebody changed this light's colour or level by hand. Stand down for it. */
  private noteOverride(deviceId: string, field: 'warmth' | 'brightness', value: unknown): void {
    const reported = Number(value);
    if (!Number.isFinite(reported)) return;

    const last = this.lastWritten.get(deviceId);
    if (last) {
      // Still settling from our own write, or within the rounding a bridge is
      // entitled to apply to it.
      if (this.now() - last.at < SETTLE_MS) return;
      const ours = last[field];
      if (ours !== undefined && Math.abs(reported - ours) <= OVERRIDE_TOLERANCE) return;
    }

    if (!this.overrides.has(deviceId)) {
      this.deps.log(
        `${deviceId} was changed by hand (${field} ${reported}); circadian will leave it alone `
        + 'until it is switched off and on again',
      );
    }
    this.overrides.set(deviceId, { at: this.now(), value: reported });
  }

  /** Once a minute, from the manager's single shared timer. */
  async tick(): Promise<void> {
    await this.applyNow('tick');
  }

  /**
   * Write everything outstanding now rather than when the queue's rate limit
   * next allows it.
   *
   * The queue holds a second write to the same light for 200 ms, which is right
   * for a dial being turned and wrong for "press this button and watch": without
   * this, the pairing screen's preview reports writes that have not been
   * attempted yet.
   */
  async drain(): Promise<void> {
    await this.scheduler?.drain();
  }

  /** Where the curve is right now, in the Homey's own timezone. */
  currentValue(): CurveValue | null {
    if (this.plan.points.length === 0) return null;
    const clock = localNow(this.deps.timezone(), this.now());
    return valueAt(this.plan.points, clock.minutesOfDay);
  }

  /**
   * Bring the lights to where the curve says they should be.
   *
   * `force` skips the "has it moved enough to be worth a write" gate and the
   * override check; it is for the moment a light comes on and for the pairing
   * screen's preview, where the user has explicitly asked for a change they can see.
   */
  async applyNow(
    reason: string,
    options: { deviceIds?: string[]; force?: boolean } = {},
  ): Promise<{ writes: number; skipped: number }> {
    if (!this.plan.enabled) return { writes: 0, skipped: 0 };
    if (this.plan.points.length === 0) return { writes: 0, skipped: 0 };

    const value = this.currentValue();
    if (!value) return { writes: 0, skipped: 0 };

    const candidates = options.deviceIds ?? this.targetIds;
    if (candidates.length === 0) return { writes: 0, skipped: 0 };

    let skipped = 0;
    const eligible: string[] = [];
    const lit: string[] = [];

    for (const deviceId of candidates) {
      if (!options.force && this.overrides.has(deviceId)) {
        skipped += 1;
        continue;
      }

      const isOn = this.cache.state(deviceId).actualOn === true;
      if (isOn) lit.push(deviceId);

      // A light that is off is only worth writing to when the user has opted into
      // pre-staging, and even then only its colour — see the brightness leg below.
      if (!isOn && !this.plan.preStage) {
        skipped += 1;
        continue;
      }
      eligible.push(deviceId);
    }

    const writes = this.planWrites(value, eligible, lit, options.force === true);

    if (!this.scheduler) {
      // Recorded rather than swallowed: writes counted against a queue that does
      // not exist looks exactly like a working app with no effect.
      this.deps.log('No scheduler: the circadian runtime is not started, so writes were dropped');
      return { writes: 0, skipped };
    }

    if (writes.length > 0) {
      this.scheduler.submit(writes);
      this.noteWrites(writes);
      // Only the colour of an off light can be a pre-stage write; brightness is
      // never sent to one.
      for (const write of writes) {
        if (write.capability === 'light_temperature'
          && this.cache.state(write.deviceId).actualOn !== true) {
          this.verifyStayedOff(write.deviceId);
        }
      }
    }

    this.lastAction = {
      at: this.now(),
      reason,
      warmth: value.warmth,
      ...(value.brightness !== undefined ? { brightness: value.brightness } : {}),
      writes: writes.length,
      skipped,
    };

    return { writes: writes.length, skipped };
  }

  /**
   * Colour for everything eligible; brightness only for lights that are already
   * on.
   *
   * That asymmetry is not fussiness. A `dim` write to an off lamp turns it on —
   * measured on Hue, and the reason `impliesOn` exists in the planner — so
   * pre-staging brightness would switch a household's lights on one at a time
   * through the night. Pre-staging is a colour-only idea.
   */
  private planWrites(
    value: CurveValue,
    eligible: string[],
    lit: string[],
    force: boolean,
  ): PlannedWrite[] {
    const planned: PlannedWrite[] = [];

    if (eligible.length > 0) {
      const temperature = planIntent(
        { type: 'temperature_absolute', value: value.warmth },
        eligible, this.cache, DEFAULT_BEHAVIOR,
      );
      // planIntent has already clamped and quantised against each target's OWN
      // capability options, so this compares the value that would actually be
      // sent — not the curve's idea of it.
      planned.push(...temperature.writes.filter(write =>
        force || this.hasMoved(write.deviceId, 'warmth', write.value as number)));
    }

    if (this.plan.adjustBrightness && value.brightness !== undefined && lit.length > 0) {
      const brightness = planIntent(
        // Stored perceptually, written in device values — 40% means 40% of
        // PERCEIVED brightness here as it does everywhere else in the app.
        { type: 'brightness_absolute', value: toDevice(value.brightness) },
        // `lit` is already a subset of `eligible`: the override check runs before
        // either list is built.
        lit, this.cache, DEFAULT_BEHAVIOR,
      );
      planned.push(...brightness.writes.filter(write =>
        force || this.hasMoved(write.deviceId, 'brightness', write.value as number)));
    }

    return planned;
  }

  /**
   * Has the curve moved far enough since our last write to this light to be
   * worth another one?
   *
   * The gate that keeps a once-a-minute tick from becoming a once-a-minute write:
   * across the steepest default segment the curve moves about 0.003 a minute, and
   * `light_temperature` reports `decimals: 2`, so anything finer is a no-op at the
   * lamp (CLAUDE.md §6). In practice this is one write per light every few
   * minutes.
   */
  private hasMoved(deviceId: string, field: 'warmth' | 'brightness', next: number): boolean {
    const last = this.lastWritten.get(deviceId);
    const previous = last?.[field];
    if (previous === undefined) return true;
    return Math.abs(next - previous) >= this.stepFor(deviceId, field);
  }

  private stepFor(deviceId: string, field: 'warmth' | 'brightness'): number {
    const capabilities = this.cache.capabilitiesOf(deviceId);
    const options = field === 'warmth' ? capabilities?.light_temperature : capabilities?.dim;
    const decimals = options?.decimals;
    if (decimals === undefined || !Number.isFinite(decimals)) return 0.01;
    return Math.pow(10, -Math.max(0, Math.floor(decimals)));
  }

  private noteWrites(writes: PlannedWrite[]): void {
    for (const write of writes) {
      const entry = this.lastWritten.get(write.deviceId) ?? { at: this.now() };
      if (write.capability === 'light_temperature') entry.warmth = write.value as number;
      if (write.capability === 'dim') entry.brightness = write.value as number;
      entry.at = this.now();
      this.lastWritten.set(write.deviceId, entry);
    }
  }

  /**
   * The mirror of the adapter's `verifyCameOn`: did a colour write to an off lamp
   * leave it off?
   *
   * If it did not, pre-staging is not safe on this integration and turns itself
   * off for the whole device — persisted, so tonight's surprise is not repeated
   * tomorrow. It deliberately does NOT switch the light back off: by now we
   * cannot tell our own doing from somebody walking in and hitting the switch,
   * and switching off a room a person has just lit is the worse failure of the
   * two. The pairing screen's probe DOES restore it, because there the user
   * asked for the test and is standing in front of the lamp.
   */
  private verifyStayedOff(deviceId: string): void {
    const timer = this.setTimer(() => {
      this.probes.delete(timer);
      if (this.cache.state(deviceId).actualOn !== true) return;
      this.disablePreStage(deviceId);
    }, PRE_STAGE_CHECK_MS);
    this.probes.add(timer);
  }

  private disablePreStage(deviceId: string): void {
    if (!this.plan.preStage) return;
    this.plan = { ...this.plan, preStage: false };
    this.preStageDisabled = { at: this.now(), deviceId };
    this.deps.log(
      `${deviceId} switched itself on from a colour write, so pre-staging has been turned off `
      + 'for this device. Its lights will be corrected as they come on instead.',
    );
    this.deps.onPlanChange(this.plan);
  }

  /**
   * Prove pre-staging on this household's own lights, from the pairing screen,
   * before it is switched on for good.
   *
   * Writes through the adapter rather than the queue: there is nothing to
   * coalesce and the answer has to be about one specific write.
   */
  async probePreStage(waitMs: number = PRE_STAGE_CHECK_MS): Promise<{
    deviceId: string | null; name?: string; stayedOff: boolean; restored: boolean; reason?: string;
  }> {
    const value = this.currentValue();
    if (!value) return { deviceId: null, stayedOff: false, restored: false, reason: 'no curve' };

    await Promise.all(this.targetIds.map(id => this.adapter.refresh(id)));

    const index = this.targetIds.findIndex(id =>
      this.cache.supports(id, 'light_temperature') && this.cache.state(id).actualOn !== true);

    if (index === -1) {
      return {
        deviceId: null, stayedOff: false, restored: false,
        reason: 'every light is already on, so there is nothing to pre-set',
      };
    }

    const deviceId = this.targetIds[index];
    const name = this.targetNames[index];
    await this.adapter.write(deviceId, 'light_temperature', value.warmth);
    await new Promise(resolve => this.setTimer(() => resolve(null), waitMs));
    await this.adapter.refresh(deviceId);

    const cameOn = this.cache.state(deviceId).actualOn === true;
    if (!cameOn) return { deviceId, ...(name ? { name } : {}), stayedOff: true, restored: false };

    // We turned it on, in a test the user asked for and was told about, so we put
    // it back.
    let restored = true;
    try {
      await this.adapter.write(deviceId, 'onoff', false);
    } catch {
      restored = false;
    }
    return { deviceId, ...(name ? { name } : {}), stayedOff: false, restored };
  }

  /**
   * Targets present, and at least one of them able to change colour — in that
   * order of severity. There is no credential leg: this device type writes no
   * Flows, so a dead API key cannot affect it.
   */
  async assessHealth(): Promise<void> {
    if (!this.plan.enabled) {
      this.setState('disabled');
      return;
    }

    const assessment = await assessTargets(this.deps.catalog, this.plan.target);
    if (assessment.state === 'needs_repair') {
      this.setState(assessment.state, assessment.detail);
      return;
    }

    // A circadian light pointed at lamps that cannot change colour does nothing
    // at all, and would otherwise report 'ready' for ever. Some-but-not-all is
    // already 'partial' by way of assessTargets — a group where three of five
    // lights can change colour still works, and says so.
    const warmthCapable = this.targetIds.filter(id => this.cache.supports(id, 'light_temperature'));
    if (this.targetIds.length > 0 && warmthCapable.length === 0) {
      this.setState('needs_repair', {
        key: 'state.noWarmthTargets',
        text: 'None of its lights can change colour temperature.',
      });
      return;
    }

    this.setState(assessment.state, assessment.detail);
  }

  /** Devices or zones changed: re-resolve without tearing the queue down. */
  async refreshTargets(): Promise<void> {
    const resolved = await this.resolver.resolve(this.plan.target);
    const ids = resolved.devices.map(d => d.id);
    if (JSON.stringify(ids) === JSON.stringify(this.targetIds)) return;

    for (const deviceId of this.targetIds) {
      if (!ids.includes(deviceId)) {
        await this.adapter.unsubscribe(deviceId);
        this.overrides.delete(deviceId);
        this.lastWritten.delete(deviceId);
      }
    }

    this.targetIds = ids;
    this.targetNames = resolved.devices.map(d => `${d.name} (${d.zoneName})`);
    this.resolver.primeCache(resolved.devices, this.cache);
    await Promise.all(ids.map(id => this.adapter.refresh(id)));
    await this.subscribeAll();
    this.deps.log(`Circadian targets re-resolved: ${ids.length} light(s)`);

    await this.applyNow('targets changed');
  }

  async updatePlan(plan: CircadianPlan): Promise<void> {
    this.plan = plan;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    for (const timer of this.probes) this.clearTimer(timer);
    this.probes.clear();
    this.scheduler?.stop();
    this.scheduler = null;
    // The adapter's own pending checks outlive this runtime unless released.
    await this.adapter.unsubscribeAll();
    this.cache.clear();
    this.overrides.clear();
    this.lastWritten.clear();
    this.targetIds = [];
    this.targetNames = [];
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
    if (this.state === state) return;
    this.state = state;
    this.deps.onStateChange(state, detail);
  }

  /** Never exposes secrets or unrelated Homey configuration. */
  diagnostics(): Record<string, unknown> {
    const timezone = this.deps.timezone();
    const clock = localNow(timezone, this.now());
    const value = this.plan.points.length > 0 ? this.currentValue() : null;
    const next = nextPointAfter(this.plan.points, clock.minutesOfDay);

    return {
      controllerId: this.controllerId,
      kind: 'circadian',
      name: this.deps.displayName(),
      state: this.state,
      enabled: this.plan.enabled,
      // The two facts every "it went the wrong colour at the wrong time" report
      // needs, and the only place the resolved timezone is visible at all.
      timezone: timezone ?? 'process-local',
      localTime: describeClock(clock),
      points: resolvePoints(this.plan.points).map(point => ({
        id: point.id,
        at: formatMinutes(point.minute),
        warmth: point.warmth,
        ...(point.brightness !== undefined ? { brightness: point.brightness } : {}),
      })),
      now: value,
      nextPoint: next ? { id: next.id, at: formatMinutes(next.minute), inMinutes: next.inMinutes } : null,
      adjustBrightness: this.plan.adjustBrightness,
      preStage: this.plan.preStage,
      preStageDisabled: this.preStageDisabled,
      targetIds: this.targetIds,
      targetNames: this.targetNames,
      targets: this.targetIds.map(id => ({
        id,
        on: this.cache.state(id).actualOn ?? null,
        canWarm: this.cache.supports(id, 'light_temperature'),
        overridden: this.overrides.has(id),
        lastWritten: this.lastWritten.get(id) ?? null,
      })),
      lastAction: this.lastAction,
      recentFailures: this.adapter.failures(),
      recentWrites: this.adapter.writes(),
      schedulerReady: this.scheduler !== null,
    };
  }
}
