import type { HomeyApiService } from '../homey-api-service';
import { credentialFailureKey, redactKeyMaterial } from '../credential-service';
import type { DeviceCatalog } from '../device-catalog';
import type { SourceDiscoveryService } from '../source-discovery-service';
import { FlowBridgeManager } from '../bridge/flow-bridge-manager';
import { MappingEngine } from '../mapping/mapping-engine';
import { SupersedeGate, contestedControls } from '../mapping/supersede-gate';
import { CommandScheduler } from '../outputs/command-scheduler';
import { LightTargetAdapter } from '../outputs/light-target-adapter';
import { TargetResolver } from '../outputs/target-resolver';
import { TargetStateCache } from '../outputs/target-state-cache';
import { planIntent, type Capability } from '../outputs/intent-planner';
import { RampEngine, canRamp } from '../outputs/ramp-engine';
import type { LightIntent } from '../outputs/light-intent';
import type { ControllerProfile, ControllerState, StateDetail } from '../profiles/controller-profile';
import type { HealthAssessment, HealthMonitor } from './health-monitor';
import type { InputEvent } from '../inputs/input-event';
import type { SelectableInput } from '../inputs/selectable-input';
import type { ControllerBehavior, LightFunction } from '../mapping/mapping-types';

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

/** A health verdict as a StateDetail the device layer can translate. */
function detailFor(assessment: HealthAssessment): StateDetail {
  return {
    ...(assessment.messageKey ? { key: assessment.messageKey } : {}),
    ...(assessment.tokens ? { tokens: assessment.tokens } : {}),
    ...(assessment.detail ? { text: assessment.detail } : {}),
  };
}

/** The same function-to-intent mapping the engine uses, without a rule. */
export function intentForFunction(func: LightFunction, behavior: ControllerBehavior): LightIntent {
  switch (func) {
    case 'toggle': return { type: 'toggle' };
    case 'on': return { type: 'power', value: true };
    case 'off': return { type: 'power', value: false };
    case 'brightness_up': return { type: 'brightness_delta', delta: behavior.brightnessStep };
    case 'brightness_down': return { type: 'brightness_delta', delta: -behavior.brightnessStep };
    // Higher is warmer on this axis (§6), so 'warmer' adds.
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
  onProfileChange: (profile: ControllerProfile) => void;
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
    this.resolver = new TargetResolver(deps.catalog);
  }

  get currentState(): ControllerState { return this.state; }
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

      this.setState(assessment.state, detailFor(assessment));
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
      this.setState(assessment.state, detailFor(assessment));
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
      this.deps.onProfileChange(this.profile);
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
    }, event => void this.execute(event));

    // A hold may only ramp where the source gives a reliable stop
    // signal. Everything else steps.
    this.rampable = new Set(
      catalogue
        .map(input => input.controlId)
        .filter(controlId => canRamp(controlId, catalogue)),
    );

    this.ramps = new RampEngine(
      intent => void this.runIntent(intent),
      (controlId, reason) => this.deps.log(`Ramp on ${controlId} stopped: ${reason}`),
    );

    this.scheduler = new CommandScheduler({
      minWriteIntervalMs: this.profile.behavior.minWriteIntervalMs,
      onError: (deviceId, capability, error) =>
        this.deps.log(`Write failed on ${deviceId}/${capability}:`, (error as Error)?.message),
    }, (deviceId, capability, value) => this.adapter.write(deviceId, capability, value));

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

  /** Run on app start, controller start, repair and source change. */
  async reconcileFlows(): Promise<void> {
    const catalogue = this.profile.catalogue ?? [];
    const mappedKeys = new Set(
      this.profile.mappings.map(m => m.inputKey).filter((k): k is string => k !== null),
    );
    const mapped = catalogue.filter(input => mappedKeys.has(input.key));

    if (mapped.length === 0) return;

    try {
      const result = await this.deps.bridge.sync({
        controllerId: this.controllerId,
        sourceName: this.profile.source.name ?? 'remote',
        fingerprint: this.profile.source.eventSurfaceFingerprint,
        mapped,
        existing: this.profile.managedFlows,
      });

      const before = JSON.stringify(this.profile.managedFlows);
      this.profile = { ...this.profile, managedFlows: result.references };
      // Persisting unconditionally would emit device.update, which invalidates
      // the catalog, which restarts this runtime, which reconciles again — a
      // loop that tore down the scheduler between submit and flush.
      if (JSON.stringify(result.references) !== before) {
        this.deps.onProfileChange(this.profile);
      }

      if (result.userEdited.length > 0) {
        this.setState('needs_repair', { key: 'state.flowEdited' });
      }
      this.deps.log(
        `Flows reconciled: ${result.created} created, ${result.reused} reused, ${result.deleted} deleted`,
      );
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
    this.gate.submit({ ...event, value: inputKey });
  }

  private async execute(event: InputEvent): Promise<void> {
    const inputKey = String(event.value ?? '');

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
    const resolved = await this.resolver.resolve(this.profile.target);
    const ids = resolved.devices.map(d => d.id);
    if (JSON.stringify(ids) === JSON.stringify(this.targetIds)) return;

    this.targetIds = ids;
    this.targetNames = resolved.devices.map(d => `${d.name} (${d.zoneName})`);
    this.resolver.primeCache(resolved.devices, this.cache);
    for (const device of resolved.devices) {
      await this.adapter.subscribe(device.id, WATCHED);
    }
    this.deps.log(`Targets re-resolved: ${ids.length} light(s)`);
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

  private setState(state: ControllerState, detail?: StateDetail): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onStateChange(state, detail);
  }

  /** Never exposes secrets or unrelated Homey configuration. */
  diagnostics(): Record<string, unknown> {
    return {
      controllerId: this.controllerId,
      state: this.state,
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
