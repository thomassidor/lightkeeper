import type { HomeyApiService } from '../homey-api-service';
import { credentialFailureKey, redactKeyMaterial } from '../credential-service';
import type { DeviceCatalog } from '../device-catalog';
import type { SourceDiscoveryService } from '../source-discovery-service';
import { FlowBridgeManager } from '../bridge/flow-bridge-manager';
import { MappingEngine } from '../mapping/mapping-engine';
import { SupersedeGate, contestedControls, type GatedInput } from '../mapping/supersede-gate';
import { CommandScheduler } from '../outputs/command-scheduler';
import { LightTargetAdapter, type WriteRecord } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import { TargetStateCache } from '../outputs/target-state-cache';
import { planIntent, type Capability } from '../outputs/intent-planner';
import { RampEngine, canRamp } from '../outputs/ramp-engine';
import {
  diffTargets, releaseTarget, resolveSnapshot, type TargetSnapshot,
} from '../outputs/target-snapshot';
import type { LightIntent } from '../outputs/light-intent';
import type { ControllerProfile, ControllerState, StateDetail } from '../profiles/controller-profile';
import { sameDetail } from '../profiles/controller-profile';
import type { HealthMonitor } from './health-monitor';
import type { InputEvent } from '../inputs/input-event';
import type { SelectableInput } from '../inputs/selectable-input';
import type { ControllerBehavior, LightFunction } from '../mapping/mapping-types';
import { fireAndForget } from '../support/async';

/** Which ramp, if any, a resolved intent corresponds to. */
function rampFor(intent: LightIntent): { kind: 'brightness' | 'temperature'; direction: -1 | 1 } | null {
  if (intent.type === 'brightness_delta') {
    return { kind: 'brightness', direction: intent.delta >= 0 ? 1 : -1 };
  }
  if (intent.type === 'temperature_delta') {
    return { kind: 'temperature', direction: intent.delta >= 0 ? 1 : -1 };
  }
  // Toggling or setting power has no continuous form.
  return null;
}

/** The same function-to-intent mapping the engine uses, without a rule. */
export function intentForFunction(func: LightFunction, behavior: ControllerBehavior): LightIntent {
  switch (func) {
    case 'toggle': return { type: 'toggle' };
    case 'on': return { type: 'power', value: true };
    case 'off': return { type: 'power', value: false };
    case 'brightness_up': return { type: 'brightness_delta', delta: behavior.brightnessStep };
    case 'brightness_down': return { type: 'brightness_delta', delta: -behavior.brightnessStep };
    // Higher is warmer on this axis (CLAUDE.md §6), so 'warmer' adds.
    case 'warmer': return { type: 'temperature_delta', delta: behavior.temperatureStep };
    case 'colder': return { type: 'temperature_delta', delta: -behavior.temperatureStep };
  }
}

/**
 * Owns all listeners and state for ONE virtual controller device.
 *
 * Everything here is torn down on stop or delete: no timers, subscriptions or
 * queues survive.
 */

export interface ControllerRuntimeDeps {
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
  discovery: SourceDiscoveryService;
  bridge: FlowBridgeManager;
  /**
   * Detects an unpaired source, a changed event surface, or missing targets.
   * Optional so the ephemeral Test runtime can skip it — a rig that drives
   * lights before save has no health state to report.
   */
  health?: HealthMonitor;
  /**
   * The Lightkeeper device's own name, read live rather than captured — it
   * names this controller's Flow folder, and the user may rename the device at
   * any time. Mirrors ScheduleRuntimeDeps.displayName.
   */
  displayName: () => string;
  log: (...args: unknown[]) => void;
  onStateChange: (state: ControllerState, detail?: StateDetail) => void;
  /**
   * Called whenever the profile itself changes — in particular after
   * reconciliation learns which Flows it now owns.
   *
   * This must NOT be folded into onStateChange: that only fires on a state
   * CHANGE, so a controller that reconciles while already "ready" never
   * persisted its managed flow references. The stored profile kept
   * managedFlows: [], so every restart re-created every Flow and deleting the
   * device removed none of them.
   */
  onProfileChange: (profile: ControllerProfile) => Promise<void>;
}

const WATCHED: Capability[] = ['onoff', 'dim', 'light_temperature'];

export class ControllerRuntime {
  private readonly cache = new TargetStateCache();
  private readonly adapter: LightTargetAdapter;
  private readonly resolver: TargetResolver;
  private scheduler: CommandScheduler | null = null;
  private engine: MappingEngine | null = null;
  private gate: SupersedeGate | null = null;
  private ramps: RampEngine | null = null;
  /** Controls whose hold may ramp rather than step. */
  private rampable = new Set<string>();

  private targetIds: string[] = [];
  private targetNames: string[] = [];
  private lastEvent: { key: string; at: number } | null = null;
  private lastIntent: {
    intent: LightIntent; at: number; writes: number; skipped: number; note?: string;
  } | null = null;
  private state: ControllerState = 'disabled';

  constructor(
    readonly controllerId: string,
    private profile: ControllerProfile,
    private readonly deps: ControllerRuntimeDeps,
  ) {
    this.adapter = new LightTargetAdapter(deps.api, this.cache, deps.log);
    if (deps.onWriteResult) this.adapter.setWriteSink(deps.onWriteResult);
    this.resolver = new TargetResolver(deps.catalog);
  }

  get currentState(): ControllerState { return this.state; }
  /** The reason for that state, so the device layer can report it verbatim. */
  get currentDetail(): StateDetail | undefined { return this.lastDetail; }
  get currentProfile(): ControllerProfile { return this.profile; }

  async start(): Promise<void> {
    if (!this.profile.enabled) {
      this.setState('disabled');
      return;
    }

    await this.refreshCatalogue();
    await this.buildRuntime();
    await this.reconcileFlows();
    // Last, so a genuine health problem — the remote unpaired, or its event
    // surface changed under us — wins over the target-count assessment
    // buildRuntime() made. Without this the checks never ran in production at
    // all: assess() had no caller outside the tests.
    await this.assessHealth();
  }

  /**
   * Ask the health monitor whether this controller is actually
   * sound, and adopt its verdict when it is worse than what we already know.
   *
   * Never downgrades to 'ready': buildRuntime() has scheduler and subscription
   * knowledge the monitor does not, so a runtime that failed to start must not
   * be declared healthy by a check that only looks at the catalogue.
   */
  async assessHealth(): Promise<void> {
    if (!this.deps.health) return;

    try {
      const assessment = await this.deps.health.assess(this.profile);
      if (assessment.state === 'ready') return;

      this.setState(assessment.state, assessment.detail);
    } catch (error) {
      // A health check that cannot run is not itself a controller fault.
      this.deps.log('Health assessment failed:', (error as Error)?.message);
    }
  }

  /**
   * A usable credential arrived — leave needs_credential if nothing else is wrong.
   *
   * assessHealth() above deliberately never declares a controller ready, because
   * a runtime that failed to build knows things the monitor does not.
   * needs_credential is the one state where that reasoning does not apply: it
   * says the mappings, targets and subscriptions were all sound and only the key
   * was not. Without this the device stays unavailable until the app restarts, so
   * the whole "mint a new key, paste it in" recovery ends with nothing coming
   * back — which is indistinguishable, from outside, from the new key being bad.
   */
  async recoverFromCredentialFailure(): Promise<void> {
    if (this.state !== 'needs_credential') return;

    // No monitor (the ephemeral test rig) — the reconcile that just succeeded is
    // the only evidence available, and it is good enough.
    if (!this.deps.health) {
      this.setState('ready');
      return;
    }

    try {
      const assessment = await this.deps.health.assess(this.profile);
      this.setState(assessment.state, assessment.detail);
    } catch (error) {
      // Leave the controller where it is rather than guessing it is well.
      this.deps.log('Health re-check after a credential change failed:', (error as Error)?.message);
    }
  }

  /**
   * Re-discover the source's event catalogue at start.
   *
   * The catalogue is persisted with the profile, so anything learned about an
   * event AFTER a controller was saved — the dial's units-per-turn scale, for
   * one — would otherwise never reach an existing setup, and the user would
   * have to delete and recreate the controller to benefit from a fix.
   *
   * Binding keys are derived from card ids and are stable across re-discovery,
   * so existing mappings keep pointing at the right events. If the event
   * surface has genuinely changed, the fingerprint check in HealthMonitor is
   * what catches it — this only refreshes metadata.
   */
  private async refreshCatalogue(): Promise<void> {
    try {
      const device = await this.deps.catalog.device(this.profile.source.deviceId);
      if (!device) return;

      const discovered = await this.deps.discovery.discover(device);
      if (discovered.inputs.length === 0) return;

      const existingKeys = new Set((this.profile.catalogue ?? []).map(i => i.key));
      const stillPresent = discovered.inputs.filter(i => existingKeys.has(i.key));

      // Only adopt the refreshed catalogue if it still covers what we had;
      // otherwise leave the stored one alone and let health assessment decide.
      if (existingKeys.size > 0 && stillPresent.length < existingKeys.size) return;

      if (JSON.stringify(discovered.inputs) === JSON.stringify(this.profile.catalogue ?? [])) return;

      this.profile = { ...this.profile, catalogue: discovered.inputs };
      await this.deps.onProfileChange(this.profile);
    } catch (error) {
      this.deps.log('Could not refresh the event catalogue:', (error as Error)?.message);
    }
  }

  /**
   * Targets and scheduler only — no flow generation. Used by the Test control,
   * which must work before save and therefore before any flow exists.
   */
  async startWithoutFlows(): Promise<void> {
    await this.buildRuntime();
  }

  /** Run one mapped function against its own targets, right now. */
  async testFunction(
    func: LightFunction,
    deviceIds?: string[],
  ): Promise<{ writes: number; skipped: number; targets: number }> {
    const targets = deviceIds && deviceIds.length ? deviceIds : this.targetIds;

    // Re-read live state first. The device catalog is cached and only
    // invalidates on Homey events, so a second Test would otherwise plan
    // against the state from before the first one — making group toggle see
    // "nothing is on" every time and only ever switch lights ON.
    await Promise.all(targets.map(id => this.adapter.refresh(id)));

    const intent = intentForFunction(func, this.profile.behavior);
    const result = await this.runIntentNow(intent, targets);
    return { ...result, targets: targets.length };
  }

  /** Rebuild targets, cache, engine and gate from the current profile. */
  private async buildRuntime(): Promise<void> {
    const resolved = await this.resolver.resolve(this.profile.target);
    this.targetIds = resolved.devices.map(d => d.id);
    this.targetNames = resolved.devices.map(d => `${d.name} (${d.zoneName})`);
    this.resolver.primeCache(resolved.devices, this.cache);

    for (const device of resolved.devices) {
      await this.adapter.subscribe(device.id, WATCHED);
    }

    this.engine = new MappingEngine(this.profile.mappings, this.profile.behavior);

    // The gate engages ONLY for controls carrying both a discrete and a
    // hold mapping. Everything else keeps zero added latency.
    const catalogue = this.profile.catalogue ?? [];
    const assignments = this.profile.mappings
      .filter(rule => rule.inputKey !== null)
      .map(rule => catalogue.find(input => input.key === rule.inputKey))
      .filter((input): input is SelectableInput => input !== undefined)
      .map(input => ({ controlId: input.controlId, action: input.action }));

    this.gate = new SupersedeGate({
      supersedeMs: this.profile.behavior.supersedeMs,
      contestedControlIds: contestedControls(assignments),
    }, input => fireAndForget(this.execute(input), this.deps.log, 'Executing an input'));

    // A hold may only ramp where the source gives a reliable stop
    // signal. Everything else steps.
    this.rampable = new Set(
      catalogue
        .map(input => input.controlId)
        .filter(controlId => canRamp(controlId, catalogue)),
    );

    this.ramps = new RampEngine(
      intent => fireAndForget(this.runIntent(intent), this.deps.log, 'A ramp tick'),
      (controlId, reason) => this.deps.log(`Ramp on ${controlId} stopped: ${reason}`),
    );

    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: this.profile.behavior.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        this.deps.log(`Write failed on ${deviceId}/${capability}:`, (error as Error)?.message),
    }, (deviceId, capability, value, options) =>
      this.adapter.write(deviceId, capability, value, options));

    /**
     * The implied-on correction goes through the SCHEDULER, not straight at
     * the device.
     *
     * It is a real write to a real lamp and had none of what every other write
     * gets: no ordering against whatever else is in flight for that device, no
     * rate cap, no outcome, and — the one that actually bit — no
     * noteEcho/commitDesired pairing, so its echo came back looking like
     * somebody else had switched the light on.
     */
    this.adapter.setImpliedOnFallback(async deviceId => {
      await this.runIntent({ type: 'power', value: true }, [deviceId]);
    });

    if (resolved.devices.length === 0) {
      this.setState('needs_repair', { key: 'state.noTargets' });
    } else if (resolved.missing.length > 0) {
      this.setState('partial', {
        key: 'state.someTargets',
        tokens: {
          count: resolved.missing.length,
          total: resolved.devices.length + resolved.missing.length,
        },
      });
    } else {
      this.setState('ready');
    }
  }

  /**
   * Run on app start, controller start, repair and source change.
   *
   * Single-flighted through the bridge, per controller: at boot all four of
   * those can arrive at once, and two passes interleaving over one set of
   * stored references leaves the loser's flows live and unreferenced. A
   * request that arrives mid-pass gets a fresh trailing pass, never this
   * one's result — it asked because the state changed.
   */
  async reconcileFlows(): Promise<void> {
    return this.deps.bridge.reconcile(this.controllerId, () => this.reconcileFlowsNow());
  }

  private async reconcileFlowsNow(): Promise<void> {
    const catalogue = this.profile.catalogue ?? [];
    const mappedKeys = new Set(
      this.profile.mappings.map(m => m.inputKey).filter((k): k is string => k !== null),
    );
    const mapped = catalogue.filter(input => mappedKeys.has(input.key));

    /**
     * Nothing mapped AND nothing stored: the cold-start case, and the only one
     * that may skip the pass.
     *
     * It used to skip whenever nothing was mapped, which is a different thing.
     * A user who unmapped every gesture — repair, remap to nothing, save —
     * left every generated Flow live and every reference in the profile, and
     * the remote went on driving the lights from Flows the app no longer
     * believed in. `sync()` with an empty `mapped` is exactly the right call
     * there: everything stored becomes un-wanted and is deleted.
     */
    if (mapped.length === 0 && this.profile.managedFlows.length === 0) return;

    try {
      const result = await this.deps.bridge.sync({
        controllerId: this.controllerId,
        sourceName: this.profile.source.name ?? 'remote',
        deviceName: this.deps.displayName(),
        fingerprint: this.profile.source.eventSurfaceFingerprint,
        mapped,
        existing: this.profile.managedFlows,
      });

      const before = JSON.stringify(this.profile.managedFlows);
      this.profile = { ...this.profile, managedFlows: result.references };
      // Persisting unconditionally would emit device.update, which invalidates
      // the catalog, which restarts this runtime, which reconciles again — a
      // loop that tore down the scheduler between submit and flush.
      //
      // AWAITED, and its failure is a state: references that never reached the
      // store describe Flows nothing will find after a restart — the next pass
      // creates a second set beside them. Repair is the honest verdict, and the
      // Flows stay where they are: the journal in sync() is what makes the next
      // pass adopt-or-recreate rather than duplicate.
      let persistFailed = false;
      if (JSON.stringify(result.references) !== before) {
        try {
          await this.deps.onProfileChange(this.profile);
        } catch (error) {
          persistFailed = true;
          this.deps.log(
            'Could not persist managed Flow references:', (error as Error)?.message,
          );
        }
      }

      if (result.userEdited.length > 0) {
        this.setState('needs_repair', { key: 'state.flowEdited' });
      }

      /**
       * A control the compiler declined — a range needing more flow variants
       * than the ceiling allows (CLAUDE.md §7: BILRESA's 162 combinations are
       * what the ceiling is for).
       *
       * It was logged and nowhere else. The mapping row stayed on screen
       * looking configured, the gesture did nothing, and the only evidence was
       * a line in the app log. Repair is the right state: the fix is to map
       * that control to something else, which is what repair is for.
       */
      if (result.unsupported.length > 0) {
        this.unsupported = result.unsupported;
        this.setState('needs_repair', {
          key: 'state.unsupportedMapping',
          tokens: { controls: result.unsupported.map(u => u.bindingKey).join(', ') },
        });
      } else {
        this.unsupported = [];
      }

      this.deps.log(
        `Flows reconciled: ${result.created} created, ${result.reused} reused, ${result.deleted} deleted`,
      );
      if (result.staleReplacements.length > 0) {
        // The replacements are correct and live; the flows they replaced are
        // ALSO still live and still firing. Not a repair — nothing is broken
        // and a remap would not help — but it must not pass for a clean run.
        this.deps.log(
          `${result.staleReplacements.length} superseded flow(s) could not be deleted `
          + `and are still firing: ${result.staleReplacements.join(', ')}`,
        );
      }

      // Last, so it wins over the verdicts above: whatever else this pass
      // learned, a reference we could not store is the problem to report.
      if (persistFailed) this.setState('needs_repair', { key: 'state.persistFailed' });
    } catch (error) {
      const failure = this.deps.api.credentials.getStatus();
      if (failure.present && !failure.valid) {
        // The mappings are fine; only the credential is not. The failure
        // CODE carries the translation; `hint` is English and only a fallback.
        this.setState('needs_credential', {
          key: credentialFailureKey(failure.failure),
          ...(failure.hint ? { text: failure.hint } : {}),
        });
      } else {
        // Not our string to translate — an API error, shown verbatim. Verbatim
        // means redacted: this text reaches setUnavailable() on the device, and
        // an upstream error can quote the API key back inside its own message.
        this.setState('needs_repair', {
          text: redactKeyMaterial(String((error as Error)?.message ?? '')),
        });
      }
    }
  }

  /**
   * Entry point for bridge events. The caller must already have validated
   * that the controller and binding key exist.
   */
  handleInput(event: InputEvent, inputKey: string): void {
    this.lastEvent = { key: inputKey, at: Date.now() };
    if (!this.gate) return;
    // The gate re-enters via execute() once the supersede window resolves.
    this.gate.submit({ event, inputKey });
  }

  private async execute({ event, inputKey }: GatedInput): Promise<void> {
    // ANY other input from this controller stops a running ramp.
    if (this.ramps) {
      const isStopSignal = event.action === 'release' || event.action === 'rotate_stop';

      // A stop signal ends a ramp ONLY if one is actually running for that
      // control. Returning unconditionally threw away the Tap Dial's whole
      // dimming gesture: its rotation_stopped card IS the event, and it is the
      // one carrying the `steps` magnitude — there was never a ramp to stop.
      if (isStopSignal && this.ramps.isRamping(event.controlId)) {
        this.ramps.stop(event.controlId, 'released');
        return;
      }

      if (!isStopSignal) this.ramps.stopAllExcept(null, 'other_input');
    }

    const resolved = this.engine?.resolve({ inputKey, event });
    if (!resolved) return;

    const targets = resolved.target
      ? (await this.resolver.resolve(resolved.target)).devices.map(d => d.id)
      : this.targetIds;

    // A hold on a rampable control starts a ramp instead of one step.
    if (this.ramps && event.action === 'long_press' && this.rampable.has(event.controlId)) {
      const ramp = rampFor(resolved.intent);
      if (ramp) {
        this.ramps.start(event.controlId, ramp.kind, ramp.direction);
        return;
      }
    }

    await this.runIntent(resolved.intent, targets);
  }

  /** Shared by live events and the Test control, which needs no flow. */
  async runIntent(intent: LightIntent, targetIds: string[] = this.targetIds): Promise<{ writes: number; skipped: number }> {
    const plan = planIntent(intent, targetIds, this.cache, this.profile.behavior);

    // `this.scheduler?.submit()` used to swallow this case entirely: the intent
    // was recorded as N writes while nothing was ever queued, which looked
    // exactly like a working app that had no effect on any light.
    if (!this.scheduler) {
      this.deps.log('No scheduler: the runtime is not started, so writes were dropped');
      this.lastIntent = {
        intent, at: Date.now(), writes: 0, skipped: plan.skipped.length,
        note: 'dropped — runtime not started',
      };
      return { writes: 0, skipped: plan.skipped.length };
    }

    this.scheduler.submit(plan.writes);
    this.lastIntent = { intent, at: Date.now(), writes: plan.writes.length, skipped: plan.skipped.length };
    return { writes: plan.writes.length, skipped: plan.skipped.length };
  }

  /** Test controls execute immediately — waiting on a burst window would feel broken. */
  async runIntentNow(intent: LightIntent, targetIds: string[] = this.targetIds): Promise<{ writes: number; skipped: number }> {
    const result = await this.runIntent(intent, targetIds);
    await this.scheduler?.drain();
    return result;
  }

  /**
   * Re-resolve targets after a device or zone change without tearing
   * down the scheduler, gate or subscriptions. A full restart here dropped
   * writes that were already queued.
   */
  async refreshTargets(): Promise<void> {
    const next = await resolveSnapshot(this.resolver, this.profile.target);
    // The fingerprint, not the id list: a light re-paired under the same id
    // with a different dim range, or one that went unavailable and came back,
    // is a change the id list cannot see. See target-snapshot.ts.
    if (this.snapshot && this.snapshot.fingerprint === next.fingerprint) return;

    const { removed, addedOrChanged } = diffTargets(this.snapshot, next);

    for (const deviceId of removed) {
      await releaseTarget(deviceId, {
        unsubscribe: id => this.adapter.unsubscribe(id),
        cancelPending: id => this.adapter.cancelPending(id),
        cache: this.cache,
      });
    }

    // A control mid-ramp against a set that no longer exists has nothing left
    // to ramp. Stopping is not merely tidy: the ramp writes on every tick.
    if (next.ids.length === 0 && removed.length > 0) this.ramps?.stopAll('target_unavailable');

    this.snapshot = next;
    this.targetIds = next.ids;
    this.targetNames = next.names;
    this.resolver.primeCache(next.devices, this.cache);
    for (const deviceId of addedOrChanged) {
      await this.adapter.subscribe(deviceId, WATCHED);
    }
    this.deps.log(`Targets re-resolved: ${next.ids.length} light(s)`);

    // A target that came back, or one that vanished, changes the verdict —
    // and without this the device kept whatever state it had until a restart.
    await this.assessHealth();
  }

  async updateProfile(profile: ControllerProfile): Promise<void> {
    this.profile = profile;
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    // Never leave a light mid-ramp across a restart.
    this.ramps?.stopAll('shutdown');
    this.ramps = null;
    this.gate?.cancelAll();
    this.gate = null;
    this.scheduler?.stop();
    this.scheduler = null;
    this.engine = null;
    // Capability subscriptions and pending post-write checks are the adapter's,
    // and outlive this runtime unless explicitly released.
    await this.adapter.unsubscribeAll();
    this.cache.clear();
    this.targetIds = [];
    this.targetNames = [];
  }

  /** Remove only resources demonstrably owned by this controller. */
  async destroy(): Promise<void> {
    await this.stop();
    await this.deps.bridge.removeAll(this.profile.managedFlows);
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

  /**
   * Controls the flow compiler declined, from the last reconcile.
   *
   * Kept as state rather than only logged: it is the difference between a
   * mapping row that is configured and one that is configured AND compiles,
   * and only the second one will ever move a light.
   */
  private unsupported: Array<{ bindingKey: string; reason: string }> = [];

  /** Never exposes secrets or unrelated Homey configuration. */

  /**
   * The target set this runtime is currently built against.
   *
   * Held rather than recomputed so refreshTargets() can diff: what has to be
   * released is exactly what is in the old one and not the new.
   */
  private snapshot: TargetSnapshot | null = null;

  diagnostics(): Record<string, unknown> {
    return {
      controllerId: this.controllerId,
      state: this.state,
      // How many times the VISIBLE state has moved. A device stuck on a
      // stale message with a rising revision means the device layer is not
      // rendering what it is being told.
      stateRevision: this.stateRevision,
      // Empty on a healthy controller. Non-empty is the only place a declined
      // control is visible from outside the app log.
      unsupported: this.unsupported,
      source: this.profile.source,
      targetIds: this.targetIds,
      // Names, not just ids: a controller quietly pointed at the wrong room
      // looks identical to a broken one.
      targetNames: this.targetNames,
      mappings: this.profile.mappings,
      managedFlows: this.profile.managedFlows,
      catalogueSize: this.profile.catalogue?.length ?? 0,
      lastEvent: this.lastEvent,
      lastIntent: this.lastIntent,
      recentFailures: this.adapter.failures(),
      // Planned versus actually attempted: the distinction that matters when a
      // controller reports activity but no light moves.
      recentWrites: this.adapter.writes(),
      schedulerReady: this.scheduler !== null,
      credential: this.deps.api.credentials.getStatus(),
    };
  }
}
