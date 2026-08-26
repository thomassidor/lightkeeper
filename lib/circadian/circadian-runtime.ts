import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import { CommandScheduler, type WriteOutcome } from '../outputs/command-scheduler';
import { LightTargetAdapter, type WriteRecord } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import { TargetStateCache } from '../outputs/target-state-cache';
import { planIntent, type Capability, type PlannedWrite } from '../outputs/intent-planner';
import { toDevice } from '../outputs/light-intent';
import { DEFAULT_BEHAVIOR } from '../mapping/mapping-types';
import type { ControllerState, StateDetail } from '../profiles/controller-profile';
import { sameDetail } from '../profiles/controller-profile';
import { assessTargets } from '../runtime/target-health';
import {
  diffTargets, releaseTarget, resolveSnapshot, type TargetSnapshot,
} from '../outputs/target-snapshot';
import { fireAndForget } from '../support/async';
import { withDefaults, type Timers } from '../support/timers';
// The Homey's own wall clock is not schedule-specific — it lives under
// lib/schedules/ because that is where it was needed first. Importing it beats
// a second copy of the Intl handling and its fallback.
import { describeClock, localNow } from '../time/local-clock';
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
  /**
   * One app-wide log of every write attempted by ANY runtime.
   *
   * Optional so the pairing screen's ephemeral rigs (which have no app) still
   * work unchanged. Its consumer is the settings page: "did anything reach a
   * light" is a question about the whole Homey, and answering it from the
   * FIRST controller's log — which is what api.ts did — made it permanently
   * empty for a household that runs only schedules, and permanently
   * misleading for one that runs both.
   */
  onWriteResult?: (entry: WriteRecord) => void;
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
  onPlanChange: (plan: CircadianPlan) => Promise<void>;
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

/**
 * What `diagnostics()` returns. See ControllerDiagnostics for why it is typed.
 *
 * No `credential` field, and its absence is the feature: this device type
 * generates no Flows, so no API key is involved in anything it does (CLAUDE.md
 * §12).
 */
export interface CircadianDiagnostics {
  controllerId: string;
  kind: 'circadian';
  /** See ControllerDiagnostics.stateRevision. */
  stateRevision: number;
  name: string;
  state: ControllerState;
  enabled: boolean;
  /** "It went the wrong colour at the wrong time" is usually a timezone answer. */
  timezone: string;
  localTime: string;
  points: Array<{ id: string; at: string; warmth: number; brightness?: number }>;
  /** Where the curve is now, and where it goes next. */
  now: CurveValue | null;
  nextPoint: { id: string; at: string; inMinutes: number } | null;
  adjustBrightness: boolean;
  preStage: boolean;
  preStageDisabled: { at: number; deviceId: string } | null;
  targetIds: string[];
  targetNames: string[];
  targets: Array<{
    id: string;
    on: boolean | null;
    canWarm: boolean;
    /**
     * A light somebody has taken over by hand. Reported because one that stopped
     * following the curve on purpose looks exactly like one that stopped by
     * accident.
     */
    overridden: boolean;
    lastWritten: unknown;
  }>;
  lastAction: CircadianAction | null;
  recentFailures: readonly unknown[];
  recentWrites: readonly WriteRecord[];
  schedulerReady: boolean;
}

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

  /**
   * Pre-stage probes, keyed BY DEVICE and carrying the write generation that
   * started each one.
   *
   * A flat Set could not be reached by device, so a probe could not be
   * cancelled by a newer write or by the light leaving the plan — and a probe
   * that fires late disables pre-staging for the whole device, PERSISTED. The
   * generation is what makes the verdict correlated rather than circumstantial:
   * an old probe must not blame our write for a lamp that a newer write, or a
   * person, switched on.
   */
  private readonly probes = new Map<string, { timer: unknown; generation: number }>();
  /** Monotonic per device; bumped on every write that could start a probe. */
  private readonly writeGeneration = new Map<string, number>();

  /** The target set this runtime is built against. See the controller's. */
  private snapshot: TargetSnapshot | null = null;

  constructor(
    readonly controllerId: string,
    private plan: CircadianPlan,
    private readonly deps: CircadianRuntimeDeps,
  ) {
    // In the constructor BODY, not a field initialiser: a field initialiser runs
    // before the parameter property `deps` is assigned, so `withDefaults(this.deps)`
    // there silently resolves to real timers and every injected clock is ignored.
    this.timers = withDefaults(deps);
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log);
    if (deps.onWriteResult) this.adapter.setWriteSink(deps.onWriteResult);
    this.resolver = new TargetResolver(deps.catalog);
  }

  get currentState(): ControllerState { return this.state; }
  /** The reason for that state, so the device layer can report it verbatim. */
  get currentDetail(): StateDetail | undefined { return this.lastDetail; }
  get currentPlan(): CircadianPlan { return this.plan; }

  /**
   * One resolved set of timers, filled in by `withDefaults`.
   *
   * The public options stay piecemeal — `setTimeout`, `clearTimeout`, `now` as
   * separate fields — because every test stubs one or two of them and
   * `test/support/fake-timers.ts` is deliberately compatible with that shape.
   * What is shared is the FALLBACK: four classes each had their own
   * `deps.setTimeout ? ... : setTimeout(...)` line, and they had already drifted
   * on how they cast the handle.
   */
  private timers!: Timers;

  private now(): number {
    return this.timers.now();
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.timers.setTimeout(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    this.timers.clearTimeout(handle);
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
      /**
       * Which lights this batch is PRE-STAGING: off now, and being sent a
       * colour. Captured before dispatch, because by the time the outcomes
       * arrive the lamp may well be on — which is the entire question the
       * probe exists to answer.
       *
       * A generation per device, bumped here, is what correlates a probe to
       * the write that started it: a probe cannot survive a newer write and
       * then blame it (see verifyStayedOff).
       */
      const preStaged = new Map<string, number>();
      for (const write of writes) {
        // Only the colour of an off light can be a pre-stage write; brightness
        // is never sent to one (CLAUDE.md §12).
        if (write.capability !== 'light_temperature') continue;
        if (this.cache.state(write.deviceId).actualOn === true) continue;
        const generation = (this.writeGeneration.get(write.deviceId) ?? 0) + 1;
        this.writeGeneration.set(write.deviceId, generation);
        preStaged.set(write.deviceId, generation);
      }

      const { completion } = this.scheduler.submit(writes);

      /**
       * Bookkeeping moves behind the completion, and so does the probe.
       *
       * `lastWritten` used to be recorded the moment the batch was submitted,
       * so a write the scheduler coalesced away — or one that failed — was
       * recorded as done, and the "has the curve moved far enough" gate then
       * suppressed every retry. The lamp stayed at the colour it was.
       *
       * The probe used to start on the same optimism, which is worse: it
       * decides whether to DISABLE pre-staging for the whole device, and
       * persists that. Starting its 5 s window before the write had left meant
       * the window could close before the lamp had even been asked.
       */
      fireAndForget(completion.then(outcomes => {
        this.noteOutcomes(outcomes);
        for (const outcome of outcomes) {
          if (outcome.status !== 'succeeded') continue;
          if (outcome.capability !== 'light_temperature') continue;
          const generation = preStaged.get(outcome.deviceId);
          if (generation === undefined) continue;
          this.verifyStayedOff(outcome.deviceId, generation);
        }
      }), this.deps.log, 'Circadian write bookkeeping');
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

  /**
   * Record what actually LANDED, from the batch's outcomes.
   *
   * `lastWritten` is what the "has the curve moved far enough to be worth a
   * write" gate compares against, so recording a value that never reached the
   * lamp tells the gate the lamp is already where it needs to be — and the
   * next tick, and every tick after it, agrees. A coalesced-away write is the
   * quiet version of the same thing: a newer batch owns that capability, and
   * claiming this one landed would suppress the retry that batch IS.
   *
   * So only `succeeded` counts. `failed`, `dropped_capacity` and `cancelled`
   * all leave the device eligible again on the next tick, which is the whole
   * recovery mechanism this runtime has.
   */
  private noteOutcomes(outcomes: WriteOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.status !== 'succeeded') continue;
      const entry = this.lastWritten.get(outcome.deviceId) ?? { at: this.now() };
      if (outcome.capability === 'light_temperature') entry.warmth = outcome.value as number;
      if (outcome.capability === 'dim') entry.brightness = outcome.value as number;
      entry.at = this.now();
      this.lastWritten.set(outcome.deviceId, entry);
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
  private verifyStayedOff(deviceId: string, generation: number): void {
    // One probe per device: a newer write cancels the older one's, because the
    // older one can no longer tell us anything about a lamp the newer write
    // has since touched.
    this.cancelProbe(deviceId);

    const timer = this.setTimer(() => {
      this.probes.delete(deviceId);
      // Superseded between scheduling and firing: this probe is about a write
      // that is no longer the last thing we did to this lamp.
      if ((this.writeGeneration.get(deviceId) ?? 0) !== generation) return;
      if (this.cache.state(deviceId).actualOn !== true) return;
      fireAndForget(
        this.disablePreStage(deviceId), this.deps.log, 'Turning pre-staging off',
      );
    }, PRE_STAGE_CHECK_MS);
    this.probes.set(deviceId, { timer, generation });
  }

  /** Drop a device's outstanding pre-stage probe, if it has one. */
  private cancelProbe(deviceId: string): void {
    const existing = this.probes.get(deviceId);
    if (!existing) return;
    this.clearTimer(existing.timer);
    this.probes.delete(deviceId);
  }

  private async disablePreStage(deviceId: string): Promise<void> {
    if (!this.plan.preStage) return;
    this.plan = { ...this.plan, preStage: false };
    this.preStageDisabled = { at: this.now(), deviceId };
    this.deps.log(
      `${deviceId} switched itself on from a colour write, so pre-staging has been turned off `
      + 'for this device. Its lights will be corrected as they come on instead.',
    );
    // AWAITED: this is the one verdict this device type persists, and a write
    // that silently failed would switch the same lamp on again tomorrow night.
    await this.deps.onPlanChange(this.plan);
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
    const next = await resolveSnapshot(this.resolver, this.plan.target);
    // The fingerprint, not the id list — see target-snapshot.ts. This runtime
    // is the one where it matters most: it clamps every write to the target's
    // own light_temperature range, so a lamp re-paired under the same id with
    // a different range gets the wrong colour on every tick, forever.
    if (this.snapshot && this.snapshot.fingerprint === next.fingerprint) return;

    const { removed } = diffTargets(this.snapshot, next);
    for (const deviceId of removed) {
      /**
       * The acceptance bar for the whole task: after a light leaves the plan,
       * switching it on must produce ZERO writes.
       *
       * It kept its capability subscription, so the rising edge of `onoff`
       * still arrived — and the rising edge is THE feature (CLAUDE.md §12), so
       * the runtime dutifully wrote a colour to a lamp that was no longer any
       * of its business.
       */
      await releaseTarget(deviceId, {
        unsubscribe: id => this.adapter.unsubscribe(id),
        cancelPending: id => this.adapter.cancelPending(id),
        cache: this.cache,
      });
      this.overrides.delete(deviceId);
      this.lastWritten.delete(deviceId);
      this.cancelProbe(deviceId);
    }

    this.snapshot = next;
    this.targetIds = next.ids;
    this.targetNames = next.names;
    this.resolver.primeCache(next.devices, this.cache);
    await Promise.all(next.ids.map(id => this.adapter.refresh(id)));
    await this.subscribeAll();
    this.deps.log(`Circadian targets re-resolved: ${next.ids.length} light(s)`);

    await this.applyNow('targets changed');
    await this.assessHealth();
  }

  async updatePlan(plan: CircadianPlan): Promise<void> {
    this.plan = plan;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    for (const probe of this.probes.values()) this.clearTimer(probe.timer);
    this.probes.clear();
    this.writeGeneration.clear();
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

  /**
   * Adopt a state, and tell the device layer when anything a user could SEE
   * has changed.
   *
   * The comparison used to be `state === state` alone, which is not what the
   * device layer renders: it renders the state AND its detail, and the detail
   * is where the sentence lives. So a device that went from "the API key
   * expired" to "the API key has no Flow permission" — both `needs_credential`
   * — kept showing the first message, and the user re-minted a key with the
   * same problem because the app never stopped telling them to.
   */
  private setState(state: ControllerState, detail?: StateDetail): void {
    if (this.state === state && sameDetail(this.lastDetail, detail)) return;
    this.state = state;
    this.lastDetail = detail;
    this.stateRevision += 1;
    this.deps.onStateChange(state, detail);
  }

  /** The detail last handed to the device layer, for the comparison above. */
  private lastDetail: StateDetail | undefined;
  /** Diagnostics only: how many times the visible state has actually moved. */
  private stateRevision = 0;

  /** Never exposes secrets or unrelated Homey configuration. */
  diagnostics(): CircadianDiagnostics {
    const timezone = this.deps.timezone();
    const clock = localNow(timezone, this.now());
    const value = this.plan.points.length > 0 ? this.currentValue() : null;
    const next = nextPointAfter(this.plan.points, clock.minutesOfDay);

    return {
      controllerId: this.controllerId,
      kind: 'circadian',
      // How many times the VISIBLE state has moved. A device stuck on a
      // stale message with a rising revision means the device layer is not
      // rendering what it is being told.
      stateRevision: this.stateRevision,
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
