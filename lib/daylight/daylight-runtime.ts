import { acceptedTargets } from '../outputs/test-outcome';
import type { EvidenceSink } from '../support/evidence-sink';
import { ControlHistory, type ControlAction, type OverrideRecord, type TargetDecision } from '../runtime/control-diagnostics';
import { RuntimeLifetime, cleanupResources, startRuntime, SensorClaim } from '../runtime/runtime-resources';
import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import { CommandScheduler, type WriteOutcome } from '../outputs/command-scheduler';
import { LightTargetAdapter, type WriteRecord } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import {
  validCapabilityValue,
  FADE_OUT_GRACE_MS,
  FADE_OUT_MIN_MS,
  OVERRIDE_EXPIRY_MS,
  OVERRIDE_SETTLE_MS,
  withinOverrideTolerance,
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
import { canonical } from '../support/same';
import { withDefaults, type Timers } from '../support/timers';
import { SENSOR_STALE_MS, type DaylightPlan } from './daylight-types';
import type { DaylightEvaluator, DaylightVerdict } from './daylight-evaluator';
import type { LuminanceSource, WatchedSensor } from './luminance-source';
import { messageOf } from '../support/homey-errors';
import { VisibleState } from '../runtime/visible-state';
import { ValueBoard, VALUE_CAPABILITIES, type PublishedValues } from '../runtime/published-values';

/**
 * One Room-sensing Light, live.
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
  onEvidence?: EvidenceSink;
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

export interface DaylightAction extends ControlAction {
  at: number;
  reason: string;
  /** Perceptual brightness the response asked for, before slewing. */
  brightness?: number;
  sensors?: WatchedSensor[];
  level?: number;
  source?: string;
  elevation?: number | null;
  writes: number;
  skipped: number;
  /** Why a pass planned nothing. Absent on a pass that did something. */
  detail?: string;
}

export interface DaylightDiagnostics extends ReturnType<ControlHistory<DaylightAction>['snapshot']> {
  sampledAt: number;
  writeHistory: ReturnType<LightTargetAdapter['writeHistory']>;
  feedbackRisk: 'increasing_sensor_response' | null;
  /** How many times that risk has been observed happening. See FEEDBACK_RISE. */
  feedbackObservations: number;
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
    override: OverrideRecord | null;
    reported: ReturnType<TargetStateCache['reportedValues']>;
    /** Perceptual level this lamp is being held at. */
    aim: number | null;
    /**
     * Consecutive `dim` writes this lamp acknowledged and did not act on.
     * Absent when there are none. One number rather than the circadian light's
     * map, because brightness is the only axis this device type writes.
     *
     * Here for the reason its twin is: `ineffectiveWrite` stops a lamp that
     * ignores us from reading as a person, and what it leaves behind is a lamp
     * being written to for ever with nothing to show for it. That has to be
     * visible.
     */
    ignoredWrites?: number;
    /**
     * And `dim` writes it acknowledged and then took more than one report to
     * reach. Absent when there are none.
     *
     * The same argument as `ignoredWrites` above: `approachingWrite` stops a
     * slow fade reading as a person, and a lamp that fades for minutes has to
     * stay legible rather than quietly becoming the normal case.
     */
    approachingWrites?: number;
    /**
     * And reports of a lamp on its way OFF — part-way down, a median of half a
     * minute before it says so. Absent when there are none.
     *
     * The third of the same family: each one is a lamp doing something ordinary
     * that used to read as a person, and each has to stay countable afterwards,
     * because "nothing here looks like an override any more" is only reassuring
     * if you can see how often it nearly did.
     */
    fadeOutOverrides?: number;
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

/**
 * When to stop calling the feedback loop a risk and start calling it observed.
 *
 * `feedbackRisk` below is a statement about the CONFIGURATION — sensors named,
 * and a response that asks for more light as the room gets lighter. It is shown
 * on the pairing screen, where it belongs, and it says "this can run away". It
 * cannot say whether it did.
 *
 * These three say whether it did, and the test is the loop's own signature: we
 * raised the aim, and the reading then rose. In a room where the sensor cannot
 * see these lamps that coincidence is chance and will not repeat; where it can,
 * it is the mechanism. `FEEDBACK_RISE` is well above sensor noise on the
 * response's own 0..1 input axis, `FEEDBACK_WINDOW_MS` is long enough for a
 * report-on-change sensor to get around to reporting (many only do so on
 * change, so the rise need not land on the very next pass), and five
 * observations is far past coincidence.
 *
 * Measured on the reference Homey over 3.83 days: the kitchen device did this
 * 95 times — sensor reading a median of 1 lux with its lamp off and 680 lux
 * with it on, response pinned at its own bright end in 62.7% of lit samples.
 * `DAYLIGHT_DEADBAND` cannot damp that away; loop gain was about 3, so only the
 * response's `bright` ceiling bounded it. That is worth saying on the tile
 * rather than only in a diagnostics field nobody reads.
 */
const FEEDBACK_RISE = 0.05;
const FEEDBACK_WINDOW_MS = 10 * 60_000;
const FEEDBACK_OBSERVATIONS = 5;


/** The only two axes this device type has any business with. */
const WATCHED: Capability[] = ['onoff', 'dim'];

export class DaylightRuntime {
  private readonly lifetime = new RuntimeLifetime();
  private readonly sensorClaim: SensorClaim;
  private readonly cache = new TargetStateCache(() => this.now());
  private readonly adapter: LightTargetAdapter;
  private readonly resolver: TargetResolver;
  private readonly timers: Timers;
  private scheduler: CommandScheduler | null = null;
  private snapshot: TargetSnapshot | null = null;
  private targetIds: string[] = [];
  private targetNames: string[] = [];
  private readonly visible: VisibleState;
  private lastAction: DaylightAction | null = null;
  private readonly history = new ControlHistory<DaylightAction>((type, data) =>
    this.deps.onEvidence?.(type, { controllerId: this.controllerId, action: data }));

  /**
   * Lights somebody has taken control of by hand, and when.
   *
   * Per device, never persisted: a restart is a clean slate, which is the right
   * bias for a feature whose whole job is to be correct by default. Cleared by
   * either edge of `onoff` — "switch it off and on again" is the gesture people
   * already have for putting a light back to how it ought to be — and, failing
   * that, by `expireOverrides()` after `OVERRIDE_EXPIRY_MS`. The second half is
   * not a nicety: the gesture assumes a person raised the override, and a lamp
   * that quietly reverts our writes raises one just as well. See the constant
   * for the four days of evidence that put it there.
   */
  private readonly overrides = new Map<string, OverrideRecord>();
  /** Per device: overrides that turned out to be the lamp fading out. See FADE_OUT_GRACE_MS. */
  private readonly fadeOuts = new Map<string, number>();

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

  /**
   * The open half of a raise-then-rise test: what the reading was when we last
   * raised a lamp, and when. Cleared once the test resolves either way.
   */
  private feedbackProbe: { level: number; at: number } | null = null;

  /** How many times that test has come back positive. See FEEDBACK_RISE. */
  private feedbackObservations = 0;

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
    this.sensorClaim = new SensorClaim(deps.luminance, controllerId);
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log, { now: () => this.now() });
    if (deps.onWriteResult) this.adapter.setWriteSink(entry => deps.onWriteResult?.({ ...entry, controllerId: this.controllerId }));
  }

  get currentState(): ControllerState { return this.visible.current; }
  get currentDetail(): StateDetail | undefined { return this.visible.currentDetail; }
  get currentPlan(): DaylightPlan { return this.plan; }

  /** What the room's light asks for, for the capability rows (platform §18). */
  private readonly values = new ValueBoard();

  watchValues(onValues: (values: PublishedValues) => void): void {
    this.values.watch(onValues);
  }

  /**
   * What this runtime has published, for the Flow cards that compose it.
   *
   * The BOARD rather than a fresh computation, deliberately: the `set_lights`
   * card and a hand-built Flow using the same device's tag must not be able to
   * disagree about what "now" means, and the board is what the tag holds.
   */
  publishedValues(): PublishedValues {
    return this.values.current;
  }

  /** The device's own name, for the Flow cards' pickers. */
  get deviceName(): string {
    return this.deps.displayName();
  }

  /**
   * Publish how light it is and what that asks of the lamps.
   *
   * `level` is `null` rather than `0` when there is nothing to read it from — no
   * sun position and no usable sensor. Zero is a real reading on that axis and
   * means pitch dark, so publishing it for "I cannot tell" would let a Flow
   * gating on darkness fire all day with a flat sensor battery. The brightness
   * beside it is NOT nulled: `brightnessFor` returns the response's own stored
   * dark end verbatim at level 0, which is the documented fallback — a room that
   * went dark because a sensor did is the worse surprise.
   */
  private publishValues(): void {
    const verdict = this.currentValue();
    this.values.set({
      [VALUE_CAPABILITIES.brightness]: toDevice(verdict.brightness),
      [VALUE_CAPABILITIES.daylight]: verdict.source === 'none' ? null : verdict.level,
    });
  }

  private now(): number { return this.timers.now(); }

  async start(): Promise<void> {
    return this.lifetime.start(async current => {
      this.adapter.resume();
      await this.buildRuntime(current);
      if (!current()) return;
      await this.assessHealth();
      if (!current()) return;
      // Not deferred to the first tick: a restart at dusk must correct the room
      // now, not in up to a minute's time.
      await this.applyNow('start');
      if (!current()) return;
    });
  }

  /** Targets, cache, queue and subscriptions — no health, no writes. */
  async startIdle(): Promise<void> {
    return this.lifetime.start(async current => {
      this.adapter.resume();
      await this.buildRuntime(current);
      if (!current()) return;
    });
  }

  private async buildRuntime(current: () => boolean): Promise<void> {
    const resolved = await resolveSnapshot(this.resolver, this.plan.target);
    if (!current()) return;
    this.snapshot = resolved;
    this.targetIds = resolved.ids;
    this.targetNames = resolved.names;
    this.resolver.primeCache(resolved.devices, this.cache);

    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: DEFAULT_BEHAVIOR.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        this.deps.log(`Write failed on ${deviceId}/${capability}:`, messageOf(error)),
    }, (deviceId, capability, value, options) =>
      this.adapter.write(deviceId, capability, value, {
        ...options,
        eligible: () => current() && this.targetIds.includes(deviceId)
          && (options?.eligible?.() ?? true)
          && (capability !== 'dim' || this.cache.state(deviceId).actualOn === true),
      }));

    // Ref-counted and shared: five devices naming one sensor cost one
    // subscription. Total for this owner, so a sensor dropped from the plan is
    // released by the same call that retains the new one.
    await this.sensorClaim.retain(this.plan.response.sensor === null ? [] : [this.plan.response.sensor]);
    if (!current()) return;

    // Once, here. The tick deliberately does NOT refresh: live values arrive
    // over the subscriptions below, and re-reading every target every minute
    // would put a round trip per light per minute into an app that otherwise
    // only talks to Homey when something happens.
    await Promise.all(this.targetIds.map(id => this.adapter.refresh(id)));
    if (!current()) return;
    await this.subscribeAll();
    if (!current()) return;
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
    if (!validCapabilityValue(capability, value)) {
      this.history.ignored({ at: this.now(), type: 'report_ignored', deviceId, capability, reason: 'invalid_value' });
      return;
    }
    this.deps.onEvidence?.('target_report', { controllerId: this.controllerId, deviceId, capability, value, external });
    if (!external) return;

    if (capability === 'onoff' && typeof value === 'boolean') {
      this.history.events.add({ at: this.now(), type: 'power', deviceId, value });
    }

    if (capability === 'onoff') {
      if (value === false) this.scheduler?.cancelTarget(deviceId);
      const cleared = this.overrides.get(deviceId);
      if (cleared !== undefined) {
        this.overrides.delete(deviceId);
        // Was that "override" this lamp beginning to fade out? See
        // FADE_OUT_GRACE_MS: a dim report below what we wanted, followed by the
        // lamp's own off within the minute, is the lamp leaving rather than
        // somebody arriving. Recorded as what it was instead of as a person.
        const sinceRaised = this.now() - cleared.at;
        const fadingOut = value === false
          && cleared.capability === 'dim'
          && sinceRaised >= FADE_OUT_MIN_MS
          && sinceRaised < FADE_OUT_GRACE_MS
          && cleared.expected !== null
          && cleared.value < cleared.expected;
        if (fadingOut) this.fadeOuts.set(deviceId, (this.fadeOuts.get(deviceId) ?? 0) + 1);
        this.history.events.add({
          at: this.now(), type: 'override_cleared', deviceId,
          reason: fadingOut ? 'power_fade_out' : 'power_changed',
        });
        this.deps.log(fadingOut
          ? `${deviceId} was switching off, not overridden; daylight control resumes`
          : `${deviceId} was power-cycled; daylight control resumes`);
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

    /**
     * A `dim` of 0 is a lamp going off, never a person overriding us.
     *
     * `lamp_off` alone was not enough, because it reads `actualOn` and that only
     * moves when the `onoff` report itself lands. Measured over 3.83 days on the
     * reference Homey: this integration reports `dim 0` a median of 29.9 SECONDS
     * before the matching `onoff: false` (232 pairs, min 29.2 s). For that whole
     * window the cache still believes the lamp is on, the power-settling window
     * has not opened, and the report walks straight into `noteOverride` — 296 of
     * the 327 overrides in that recording were this and nothing else.
     *
     * Each one put a false "overridden" badge on the device for half a minute
     * and, worse, flooded the 120-entry event log, evicting the real control
     * history that makes a genuine fault diagnosable. Had one `onoff` report
     * gone missing it would have been permanent.
     *
     * The value test needs no clock and no ordering. Neither runtime can write
     * 0: `MINIMUM_BRIGHTNESS` is 0.10 perceptual and `litDim()` guarantees a
     * positive brightness is never written as darkness, so a reported 0 is
     * always the lamp's own. And a person dragging a dimmer to zero turns the
     * lamp OFF, which arrives as `onoff` and clears any override anyway — so
     * reading it as "off" rather than "overridden" loses nothing and is what
     * actually happened.
     *
     * Still recorded as `report_ignored`, under its own reason, so the evidence
     * shows the report rather than swallowing it.
     */
    const ignored = capability === 'dim' && (value === 0 || this.cache.state(deviceId).actualOn !== true)
      ? (value === 0 ? 'dim_zero' : 'lamp_off')
      : this.cache.overrideSuppression(deviceId, capability, value);
    if (ignored) {
      this.history.ignored({ at: this.now(), type: 'report_ignored', deviceId, capability,
        ...(typeof value === 'number' ? { value } : {}), reason: ignored });
      return;
    }

    if (capability === 'dim') this.noteOverride(deviceId, value);
  }

  /**
   * Drop overrides that have outlived `OVERRIDE_EXPIRY_MS`, and say so.
   *
   * Lazy rather than timed, deliberately. The 60 s tick already calls this by
   * way of `applyNow`, so a whole timer would buy nothing but a second thing to
   * stop on teardown — and reading the clock at the two points that ASK about
   * overrides keeps the rule testable through the injected `now()` instead of
   * through real elapsed time.
   *
   * `diagnostics()` calls it too, so the settings page and the device tile can
   * never show a lamp as overridden after control has in fact resumed.
   *
   * Forgetting what we last wrote is half the fix rather than tidiness. While
   * the override stood, somebody (or the lamp itself) moved it, and our record
   * still describes the value we last landed — so the no-op filter would look
   * at an unchanged plan, see an unchanged intended value, and write nothing at
   * all. The override would lapse and the lamp would stay exactly where it was
   * put, which is the same silence one layer down. Dropped for the same reason
   * the power-off path drops it: what we sent an hour ago no longer describes
   * this lamp. The next pass re-seeds from its real level and slews back.
   */
  private expireOverrides(): void {
    const cutoff = this.now() - OVERRIDE_EXPIRY_MS;
    for (const [deviceId, record] of this.overrides) {
      if (record.at > cutoff) continue;
      this.overrides.delete(deviceId);
      this.aim.delete(deviceId);
      this.committed.delete(deviceId);
      this.history.events.add({ at: this.now(), type: 'override_cleared', deviceId, reason: 'expired' });
      this.deps.log(`${deviceId}'s manual override has lapsed; daylight control resumes`);
    }
  }

  /** Somebody changed this light's level by hand. Stand down for it. */
  private noteOverride(deviceId: string, value: unknown): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return;
    const reported = value;

    const last = this.committed.get(deviceId);
    if (last) {
      // Still settling from our own write, or within the rounding a bridge is
      // entitled to apply to it.
      if (this.now() - last.at < OVERRIDE_SETTLE_MS) return;
      if (withinOverrideTolerance(reported - last.device)) return;
    }

    if (!this.overrides.has(deviceId)) {
      this.deps.log(
        `${deviceId} was dimmed externally (${reported}); daylight will leave it alone `
        + 'until it is switched off and on again, or for four hours',
      );
    }
    /**
     * The FIRST report's time, not this one's. `OVERRIDE_EXPIRY_MS` is the only
     * way out of an override that does not need somebody to walk to a switch,
     * and re-stamping on every report pushes it out for as long as the lamp
     * keeps talking — which is exactly what a stuck lamp does. Seen on the
     * reference Homey: four lamps reporting a value we never wrote, every
     * minute, each report renewing the four hours that were supposed to end it.
     * The history event below keeps the real arrival time; only the deadline is
     * anchored to the start.
     */
    const startedAt = this.overrides.get(deviceId)?.at ?? this.now();
    const record: OverrideRecord = { at: startedAt, capability: 'dim', value: reported, expected: last?.device ?? null, source: 'external_report' };
    // One override, one row. A lamp that keeps restating it — a stuck bulb
    // reporting once a minute — is counted on the record instead of pushing a
    // row per report: 28 of one device's 32 event slots were four overrides
    // said over and over, which is how the evidence for everything else was
    // lost. `repeats` carries the same information in one slot, and the tile
    // and the settings page read the record rather than the log.
    const previous = this.overrides.get(deviceId);
    if (previous !== undefined) {
      record.repeats = (previous.repeats ?? 1) + 1;
      record.lastAt = this.now();
    }
    this.overrides.set(deviceId, record);
    if (previous === undefined) this.history.events.add({ ...record, at: this.now(), type: 'override', deviceId });
  }

  /** Once a minute, from the manager's single shared timer. */
  async tick(): Promise<void> {
    await this.applyNow('tick');
    // See `assessedInputs`: this is the only thing that can notice a lamp that
    // has stopped accepting writes, or a daylight source that has come back.
    await this.reassessIfInputsMoved();
  }

  /** Write everything outstanding now rather than when the rate limit allows. */
  async drain(): Promise<void> {
    await this.scheduler?.drain();
  }

  /** What the response asks for right now. Never throws, never a NaN. */
  currentValue(): DaylightVerdict {
    return this.deps.daylight.evaluate(this.plan.response);
  }

  /**
   * `waitForResults` is what a "try it now" needs and what a tick must never
   * do: hold the call open until the queue has drained and every command in
   * the batch has come back, so the count reported is lamps that ACCEPTED the
   * write rather than commands that were planned.
   *
   * It is an explicit option rather than a sniff at `reason` — which is what
   * it was first written as, `reason === 'preview'`. A reason string is for
   * the log and for diagnostics; making the control flow depend on its exact
   * spelling means any caller that logs a different word silently loses the
   * wait, and any caller that happens to log 'preview' silently gains it.
   * The second half is not hypothetical: `runtime-lifecycle-safety.test.ts`
   * drove a power-off through a preview and deadlocked, because the wait was
   * on and the test held the write's own device handle.
   */
  async applyNow(
    reason: string,
    options: { deviceIds?: string[]; force?: boolean; waitForResults?: boolean } = {},
  ): Promise<{ writes: number; skipped: number }> {
    // Before every early return below, for the reason `publishValues` gives.
    this.publishValues();

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

    this.expireOverrides();

    const candidates = options.deviceIds ?? this.targetIds;
    if (candidates.length === 0) return this.noteNothingToDo(reason, 'no lights are selected');

    let skipped = 0;
    const excluded = new Map<string, TargetDecision['status']>();
    const wanted = new Map<string, number>();

    for (const deviceId of candidates) {
      if (!options.force && this.overrides.has(deviceId)) {
        excluded.set(deviceId, 'overridden');
        skipped += 1;
        continue;
      }

      /**
       * Only lamps that are already on, and there is no option to change that.
       *
       * A `dim` write turns an off lamp on — measured, not suspected — so a
       * Room-sensing Light that wrote to off lamps would switch a household's lights
       * on one at a time through the night. The circadian types make this a
       * per-plan choice because a COLOUR write is only sometimes on; brightness
       * always is.
       */
      if (this.cache.state(deviceId).actualOn !== true) {
        excluded.set(deviceId, 'off');
        skipped += 1;
        continue;
      }

      // Always an aim, even when the deadband says do not move it: the aim IS
      // the state, and the decision about whether that state needs a write is
      // the no-op filter's in planWrites().
      wanted.set(deviceId, this.aimFor(deviceId, verdict.brightness, options.force === true));
    }

    const current = this.lifetime.current();
    const writes = this.planWrites(wanted, options.force === true);
    // Recorded here rather than in noteOutcomes: an aim that only advanced on a
    // successful write would stall on any lamp whose resolution swallows a slew
    // step. See the `aim` field.
    let raisedAim = false;
    for (const [deviceId, level] of wanted) {
      const previous = this.aim.get(deviceId);
      // A seeded aim is not a raise: `aimFor` starts from the lamp's own level,
      // so the first pass after a power-on says nothing about which way we moved it.
      if (previous !== undefined && level > previous) raisedAim = true;
      this.aim.set(deviceId, level);
    }
    this.noteFeedback(verdict, raisedAim);

    if (!this.scheduler) {
      // Recorded rather than swallowed: writes counted against a queue that does
      // not exist looks exactly like a working app with no effect.
      this.deps.log('No scheduler: the daylight runtime is not started, so writes were dropped');
      return this.noteNothingToDo(reason, 'the runtime is not started, so writes were dropped', skipped);
    }

    const action: DaylightAction = {
      at: this.now(), reason, writes: writes.length, skipped,
      brightness: verdict.brightness,
      level: verdict.level,
      source: verdict.source,
      elevation: verdict.elevation,
      targets: this.history.decisions(candidates, excluded, writes),
      sensors: this.deps.daylight.sensors().filter(sensor => sensor.deviceId === this.plan.response.sensor),
    };

    let awaitedCompletion: Promise<WriteOutcome[]> | undefined;
    if (writes.length > 0) {
      const { batchId, completion } = this.scheduler.submit(writes);
      if (options.waitForResults === true) awaitedCompletion = completion;
      action.batchId = batchId;
      // Bookkeeping behind the completion, for the reason the circadian runtime
      // learned it: recording a write the scheduler coalesced away — or one that
      // failed — as done tells both gates the lamp is already where it needs to
      // be, and then every later tick agrees and the lamp never moves again.
      fireAndForget(
        completion.then(outcomes => {
          action.completedAt = this.now();
          action.outcomes = outcomes;
          this.deps.onEvidence?.('control_completion', { controllerId: this.controllerId, batchId: action.batchId, at: action.completedAt, outcomes });
          if (current()) this.noteOutcomes(outcomes);
        }),
        this.deps.log,
        'Daylight write bookkeeping',
      );
    }

    this.lastAction = action;
    this.history.actions.add(action);

    if (awaitedCompletion) {
      await this.scheduler.drain();
      return { writes: acceptedTargets(await awaitedCompletion), skipped };
    }
    return { writes: writes.length, skipped };
  }

  private noteNothingToDo(
    reason: string,
    detail: string,
    skipped = 0,
  ): { writes: number; skipped: number } {
    this.lastAction = { at: this.now(), reason, detail, writes: 0, skipped,
      targets: this.targetIds.map(deviceId => ({ deviceId, status: 'inactive', commands: 0 })),
    };
    this.history.actions.add(this.lastAction);
    return { writes: 0, skipped };
  }

  /**
   * Is this device CONFIGURED such that its lamps can drive their own sensor?
   *
   * Named sensors, and a response that rises with the reading. Shown on the
   * pairing screen as advice; here it is the precondition for looking for the
   * loop actually happening.
   */
  private feedbackRisk(): 'increasing_sensor_response' | null {
    return this.plan.response.sensor !== null && this.plan.response.bright > this.plan.response.dark
      ? 'increasing_sensor_response' : null;
  }

  /**
   * This device's own sensor, if it has one and it has gone quiet for longer
   * than `SENSOR_STALE_MS`.
   *
   * `null` covers three different healthy cases and one that is somebody else's
   * leg: no sensor named (the sun is a complete answer), a sensor that is
   * talking, and a sensor that has never reported at all — that last one leaves
   * `source` as 'sky' or 'none', which the legs above already report better than
   * "it went quiet" would.
   */
  private staleSensor(): { name: string; ageMs: number } | null {
    const wanted = this.plan.response.sensor;
    if (wanted === null) return null;
    const sensor = this.deps.daylight.sensors().find(candidate => candidate.deviceId === wanted);
    if (sensor === undefined || sensor.at === null) return null;
    const ageMs = this.now() - sensor.at;
    return ageMs >= SENSOR_STALE_MS ? { name: sensor.name, ageMs } : null;
  }

  /** Observed often enough to be worth telling the household about. */
  private feedbackObserved(): boolean {
    return this.feedbackObservations >= FEEDBACK_OBSERVATIONS;
  }

  /**
   * One pass of the raise-then-rise test.
   *
   * Deliberately NOT "the response is pinned at its bright end": on a sunny
   * afternoon an increasing response sits there legitimately, and flagging that
   * would be a false alarm on a correctly placed sensor. What cannot be a
   * coincidence five times over is the reading going UP shortly after we turned
   * these lamps up.
   *
   * Only while the reading comes from sensors at all — a level computed from
   * the sun's elevation (platform §16) is not something this app's lamps can
   * move, so the test is meaningless and the probe is dropped rather than left
   * open to resolve against unrelated data later.
   */
  private noteFeedback(verdict: DaylightVerdict, raisedAim: boolean): void {
    if (this.feedbackRisk() === null || verdict.source !== 'sensors') {
      this.feedbackProbe = null;
      return;
    }
    const probe = this.feedbackProbe;
    if (probe !== null) {
      if (this.now() - probe.at > FEEDBACK_WINDOW_MS) this.feedbackProbe = null;
      else if (verdict.level >= probe.level + FEEDBACK_RISE) {
        this.feedbackObservations += 1;
        this.feedbackProbe = null;
      }
    }
    if (raisedAim) this.feedbackProbe = { level: verdict.level, at: this.now() };
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
      if (outcome.status !== 'succeeded' || !this.targetIds.includes(outcome.deviceId)) continue;
      if (outcome.capability !== 'dim') continue;
      this.committed.set(outcome.deviceId, {
        device: outcome.value as number,
        at: this.now(),
      });
    }
  }

  /**
   * The health inputs as of the last assessment, so a tick can tell whether
   * anything a verdict depends on has actually moved.
   *
   * `assessHealth()` used to run at start and on a target-set change and
   * NOWHERE else — `refreshTargets()` returns early on an unchanged
   * fingerprint, and `tick()` never asked. So the write-failure streak in
   * `light-target-adapter.ts`, whose whole stated purpose is that a runtime
   * must not "go on writing to that lamp every minute for ever behind a green
   * tile", did exactly that: a lamp cut at the wall stays `available: true`
   * (platform §6), the target fingerprint never moves, and
   * `unwritableTargets()` was consulted once, at start, when it was empty.
   *
   * Re-asking is cheap and is NOT the round trip §12 forbids on a tick:
   * `assessTargets` reads the in-memory catalogue, and the rest is this
   * runtime's own state.
   */
  private assessedInputs: string | null = null;

  /**
   * What a verdict is computed FROM. Compared, never shown.
   *
   * The daylight SOURCE is in here as well as the unwritable set, because it
   * is the other half of this device type's own verdict: `state.noDaylight`
   * stands while nothing can tell how light it is, and it has to clear by
   * itself when the household finally gives the Homey a location or changes
   * the sensor's battery. Nothing else would ever ask again.
   */
  private healthInputs(): string {
    const unwritable = [...this.adapter.unwritableTargets()].sort().join(',');
    // Whether it is stale, not how stale: the age moves every second, and an
    // input that always differs would re-assess — and so re-`retrySubscriptions`
    // — on every tick, which is the one thing this string exists to prevent.
    return `${this.currentValue().source}|${unwritable}|${this.feedbackObserved()}`
      + `|${this.staleSensor() !== null}`;
  }

  /**
   * Re-assess only when something a verdict depends on has changed.
   *
   * Guarded rather than unconditional because `assessHealth()` awaits
   * `retrySubscriptions()`, and a runtime whose lamps are all fine has no
   * reason to retry anything once a minute for ever.
   */
  private async reassessIfInputsMoved(): Promise<void> {
    if (this.healthInputs() === this.assessedInputs) return;
    await this.assessHealth();
  }

  async assessHealth(): Promise<void> {
    await this.adapter.retrySubscriptions();
    // Recorded AFTER the retry, so what is remembered is what was assessed:
    // a retry that fixed a subscription changes the inputs it is compared to.
    this.assessedInputs = this.healthInputs();
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
     * A Room-sensing Light pointed at lamps that cannot dim does nothing at all, and
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

    /**
     * The sensor stopped talking.
     *
     * Not a control decision — the reading goes on being used, and that is
     * deliberate: many Zigbee sensors report only on change, so a quiet sensor in
     * a stable room is telling the truth and a timeout would fall back to the sky
     * precisely then (see `luminance-source.ts`). This leg changes nothing about
     * what is written. It only says out loud what the app already knows, because
     * a frozen sensor is otherwise INVISIBLE: the device holds the room at one
     * brightness and goes on reporting 'ready' for as long as the app runs.
     *
     * The 12-hour warning existed only on the pairing screen, which is the one
     * moment the sensor is working by definition. This is the same threshold at
     * the only other moment that matters.
     *
     * 'partial', not 'needs_repair': the lamps are still being driven to a
     * defensible level, and the sensor may simply come back. Ranked after the
     * target and source legs for the usual reason — "your lamps are gone" is the
     * more actionable sentence — and before the feedback leg, because a sensor
     * that stopped reporting cannot be feeding anything back.
     */
    const stale = this.staleSensor();
    if (assessment.state === 'ready' && stale !== null) {
      this.setState('partial', {
        key: 'state.daylightSensorStale',
        text: 'Its light sensor has stopped reporting, so its lights are held where they are.',
        tokens: { name: stale.name, hours: Math.floor(stale.ageMs / 3_600_000) },
      });
      return;
    }

    /**
     * The feedback loop, once it has been WATCHED happening rather than merely
     * being possible. See FEEDBACK_RISE for what counts as watching.
     *
     * Last, and only over a 'ready': a device whose lamps are gone or which
     * cannot read the daylight at all has a more actionable problem, and this
     * must never be what a person sees instead of that. It is 'partial' rather
     * than 'needs_repair' because nothing here is broken — the lamps are being
     * driven, just to a level they are choosing for themselves.
     */
    if (assessment.state === 'ready' && this.feedbackObserved()) {
      this.setState('partial', {
        key: 'state.daylightFeedback',
        text: 'Its lamps are brightening their own sensor. Move the sensor, or lower the bright end.',
      });
      return;
    }

    this.setState(assessment.state, assessment.detail);
  }

  /** Devices or zones changed: re-resolve without tearing the queue down. */
  async refreshTargets(): Promise<void> {
    return this.lifetime.run(async current => {
      const next = await resolveSnapshot(this.resolver, this.plan.target);
      if (!current()) return;
      // The fingerprint, not the id list — see target-snapshot.ts. It matters here
      // for the same reason it matters to a curve: every write is clamped and
      // quantised against the target's own `dim` options, so a lamp re-paired
      // under the same id with different `decimals` would be gated against a
      // resolution it no longer has.
      if (this.snapshot && this.snapshot.fingerprint === next.fingerprint) return;

      const { removed } = diffTargets(this.snapshot, next);
      // Revoke membership before awaiting teardown, so concurrent ticks cannot
      // enqueue fresh commands for a target we are already releasing.
      this.targetIds = next.ids;
      for (const deviceId of removed) {
        // The acceptance bar: after a light leaves the plan, switching it on must
        // produce ZERO writes. It kept its capability subscription otherwise, and
        // the rising edge of `onoff` is THE feature — so the runtime dutifully
        // dimmed a lamp that was no longer any of its business.
        this.scheduler?.cancelTarget(deviceId);
        await releaseTarget(deviceId, {
          unsubscribe: id => this.adapter.unsubscribe(id),
          cancelPending: id => this.adapter.cancelPending(id),
          cache: this.cache,
        });
        if (!current()) return;
        this.fadeOuts.delete(deviceId);
        if (this.overrides.delete(deviceId)) {
          this.history.events.add({ at: this.now(), type: 'override_cleared', deviceId, reason: 'target_removed' });
        }
        this.aim.delete(deviceId);
        this.committed.delete(deviceId);
      }

      this.snapshot = next;
      this.targetNames = next.names;
      this.resolver.primeCache(next.devices, this.cache);
      await Promise.all(next.ids.map(id => this.adapter.refresh(id)));
      if (!current()) return;
      await this.subscribeAll();
      if (!current()) return;
      this.deps.log(`Daylight targets re-resolved: ${next.ids.length} light(s)`);

      await this.applyNow('targets changed');
      await this.assessHealth();
    });
  }

  async updatePlan(plan: DaylightPlan): Promise<void> {
    /**
     * Evidence of a feedback loop survives a plan edit that did not change the
     * response, and it has to.
     *
     * It used to be cleared in `stop()`, alongside `aim` and `committed` — which
     * belong there, because both describe the OLD plan and would gate the new
     * plan's first write. The observation count describes the ROOM, and
     * `updatePlan()` is stop-then-start, so renaming the device or adding a lamp
     * threw away the only record that its lamps light their own sensor.
     *
     * That mattered because the count is slow by construction. It needs five
     * raise-then-rise passes, and on the reference Homey two had accumulated in
     * 22.7 hours — call it two and a half days of uninterrupted uptime to reach
     * the threshold that puts the warning on the tile. Anything that resets it
     * more often than that is not a reset, it is a cap.
     *
     * `canonical()` rather than a field-wise comparison, and this is the one
     * place that argument runs the other way: a field added to `DaylightResponse`
     * later is a field that could change how the loop behaves, so the safe answer
     * for an unknown field is "the evidence is void". Field-wise would keep it.
     */
    const responseChanged = canonical(plan.response) !== canonical(this.plan.response);
    this.plan = plan;
    await this.stop();
    if (responseChanged) this.forgetFeedback();
    await startRuntime(this, () => this.start(), this.deps.log);
  }

  /** Both halves of the raise-then-rise test, dropped together. */
  private forgetFeedback(): void {
    this.feedbackProbe = null;
    this.feedbackObservations = 0;
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.adapter.suspend();
    return this.lifetime.stop(async () => {
      this.scheduler?.stop();
      this.scheduler = null;
      // The adapter's own pending checks outlive this runtime unless released.
      await cleanupResources([
        () => this.adapter.unsubscribeAll(),
        () => this.sensorClaim.release(),
      ], this.deps.log);
      this.cache.clear();
      for (const deviceId of this.overrides.keys()) {
        this.history.events.add({ at: this.now(), type: 'override_cleared', deviceId, reason: 'runtime_stopped' });
      }
      this.overrides.clear();
      this.fadeOuts.clear();
      // Cleared for the reason the circadian runtime's colour record had to be:
      // `updatePlan()` is stop-then-start and `start()`'s own apply is NOT forced,
      // so a record from the old plan would have the deadband decline the new
      // plan's first write.
      this.aim.clear();
      this.committed.clear();
      /**
       * The OPEN probe goes, the count stays. A probe is a half-finished
       * measurement against a reading from before the runtime stopped, and
       * resolving it afterwards would compare across the gap. The count is
       * finished measurements, and nothing about stopping makes them untrue —
       * see `updatePlan`, which is the only thing entitled to drop them.
       */
      this.feedbackProbe = null;
      this.targetIds = [];
      this.targetNames = [];
      // Or the next refresh diffs the new plan's targets against the old plan's.
      this.snapshot = null;
    });
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
    // Before the snapshot, never after: a lapsed override must not be drawn as
    // a standing one on the settings page or the device tile.
    this.expireOverrides();
    return {
      sampledAt: this.now(),
      writeHistory: this.adapter.writeHistory(),
      feedbackRisk: this.feedbackRisk(),
      feedbackObservations: this.feedbackObservations,
      ...this.history.snapshot(),
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
        .filter(sensor => sensor.deviceId === this.plan.response.sensor),
      targetIds: this.targetIds,
      targetNames: this.targetNames,
      targets: this.targetIds.map(id => ({
        id,
        on: this.cache.state(id).actualOn ?? null,
        canDim: this.cache.supports(id, 'dim'),
        overridden: this.overrides.has(id),
        override: this.overrides.get(id) ?? null,
        reported: this.cache.reportedValues(id),
        aim: this.aim.get(id) ?? null,
        ...(this.cache.ignoredCount(id, 'dim') > 0
          ? { ignoredWrites: this.cache.ignoredCount(id, 'dim') }
          : {}),
        ...(this.cache.approachingCount(id, 'dim') > 0
          ? { approachingWrites: this.cache.approachingCount(id, 'dim') }
          : {}),
        // Only when it has happened: a row of zeroes on every target would bury
        // the fields that mean something.
        ...(this.fadeOuts.has(id) ? { fadeOutOverrides: this.fadeOuts.get(id)! } : {}),
      })),
      lastAction: this.lastAction,
      recentFailures: this.adapter.failures(),
      recentWrites: this.adapter.writes(),
      schedulerReady: this.scheduler !== null,
    };
  }
}
