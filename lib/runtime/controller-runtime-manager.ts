import { ControllerRuntime, type ControllerRuntimeDeps } from './controller-runtime';
import type { HomeyApiService } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { SourceDiscoveryService } from '../source-discovery-service';
import type { FlowBridgeManager } from '../bridge/flow-bridge-manager';
import type { HealthMonitor } from './health-monitor';
import type { ControllerProfile, ControllerState, StateDetail } from '../profiles/controller-profile';
import type { InputEvent } from '../inputs/input-event';
import { RuntimeRegistry } from './runtime-registry';
import type { WriteRecord } from '../outputs/light-target-adapter';

/**
 * Registry of live controller runtimes.
 *
 * The App owns this; individual virtual devices register themselves on init and
 * deregister on delete, so bridge events can be routed by controller id.
 */

export interface RuntimeManagerDeps {
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
  /** Health assessment, handed to every registered runtime. */
  health?: HealthMonitor;
  log: (...args: unknown[]) => void;
}

/**
 * How many step-units a full turn of a dial should be worth. With the default
 * 0.1 brightness step, one full turn sweeps the whole perceptual range, which
 * is what a dimmer dial should feel like.
 */
export const NOTCHES_PER_TURN = 10;

/**
 * Convert a raw magnitude into step multiples. Magnitude is forwarded from the
 * source, never chosen by the user.
 *
 * The Hue Tap Dial reports its rotation as "Steps (1000/turn)", so a small
 * nudge arrives as 151. Multiplying a 0.1 step by 151 slams the lights to full
 * on the first touch — raw counts have to be scaled by the integration's own
 * stated units-per-turn. Where no scale is declared the value is already a
 * count of detents or clicks and passes through unchanged.
 */
export function normaliseMagnitude(raw: number | undefined, perTurn: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;

  const magnitude = Math.abs(raw);

  // A declared scale is trusted: a genuine full turn SHOULD sweep the full
  // range. Clamping here would make a fast turn feel broken.
  if (perTurn && perTurn > 1) {
    return (magnitude / perTurn) * NOTCHES_PER_TURN;
  }

  // No declared scale. A plausible detent or click count passes through, but a
  // large raw value is fine-grained units we have no scale for — treating one
  // event as 151 steps takes the lights to full in a single nudge. Cap it: a
  // slightly small movement is recoverable, a slam to maximum is not.
  return clampNotches(magnitude);
}

/** No single event may move more than half the range. */
const MAX_NOTCHES_PER_EVENT = NOTCHES_PER_TURN / 2;

function clampNotches(notches: number): number {
  return Math.min(notches, MAX_NOTCHES_PER_EVENT);
}

export class ControllerRuntimeManager {
  /**
   * The Map, its ordering rules, the catalogue coalescer and the teardown all
   * live in RuntimeRegistry — see that file for why they are shared and this is
   * not a base class. What is left below is controller-specific: dispatch with a
   * reason, magnitude scaling, and the credential fan-out.
   */
  private readonly registry: RuntimeRegistry<ControllerRuntime>;

  constructor(private readonly deps: RuntimeManagerDeps) {
    this.registry = new RuntimeRegistry({ log: deps.log, label: 'controller' });
  }

  async register(
    controllerId: string,
    profile: ControllerProfile,
    onStateChange: (state: ControllerState, detail?: StateDetail) => void,
    onProfileChange: (profile: ControllerProfile) => Promise<void> = async () => { },
    displayName: () => string = () => 'controller',
  ): Promise<ControllerRuntime> {
    const runtimeDeps: ControllerRuntimeDeps = {
      api: this.deps.api,
      catalog: this.deps.catalog,
      discovery: this.deps.discovery,
      bridge: this.deps.bridge,
      ...(this.deps.health ? { health: this.deps.health } : {}),
      displayName,
      ...(this.deps.onWriteResult ? { onWriteResult: this.deps.onWriteResult } : {}),
      log: this.deps.log,
      onStateChange,
      onProfileChange,
    };

    return this.registry.register(controllerId, async () => {
      const runtime = new ControllerRuntime(controllerId, profile, runtimeDeps);
      await runtime.start();
      return runtime;
    });
  }

  /**
   * A runtime that is never registered and generates no flows — it exists only
   * so the Test control can drive real lights before save. Callers must
   * stop it.
   */
  async ephemeral(profile: ControllerProfile): Promise<ControllerRuntime> {
    const runtime = new ControllerRuntime('__test__', profile, {
      api: this.deps.api,
      catalog: this.deps.catalog,
      discovery: this.deps.discovery,
      bridge: this.deps.bridge,
      displayName: () => 'test',
      log: this.deps.log,
      onStateChange: () => { /* a test rig has no health state */ },
      onProfileChange: async () => { /* ephemeral: nothing to persist */ },
    });
    await runtime.startWithoutFlows();
    return runtime;
  }

  async unregister(controllerId: string): Promise<void> {
    return this.registry.unregister(controllerId);
  }

  get(controllerId: string): ControllerRuntime | undefined {
    return this.registry.get(controllerId);
  }

  all(): ControllerRuntime[] {
    return this.registry.all();
  }

  /**
   * Route a validated bridge event, saying WHY it refused — the difference
   * between a flow that fires and does nothing, and one we can diagnose.
   */
  dispatchWithReason(
    controllerId: string,
    eventKey: string,
    extra: { magnitude?: number },
  ): { accepted: boolean; reason?: string } {
    const runtime = this.registry.get(controllerId);
    if (!runtime) {
      return {
        accepted: false,
        reason: `no running controller "${controllerId}" (running: ${this.registry.ids.join(', ') || 'none'})`,
      };
    }

    const catalogue = runtime.currentProfile.catalogue ?? [];
    const input = catalogue.find(i => i.key === eventKey);
    if (!input) {
      return {
        accepted: false,
        reason: `event "${eventKey}" is not in this controller's catalogue of ${catalogue.length}`,
      };
    }

    // Never allow a generated flow to control a controller other than the one
    // encoded in its managed binding — the lookup above is that check.
    const isMapped = runtime.currentProfile.mappings.some(m => m.inputKey === eventKey);
    if (!isMapped) {
      return {
        accepted: false,
        reason: `event "${eventKey}" is not mapped to any function`,
      };
    }

    const magnitude = normaliseMagnitude(extra.magnitude, input.magnitudePerTurn);

    const event: InputEvent = {
      controlId: input.controlId,
      action: input.action,
      ...(magnitude !== undefined ? { magnitude } : {}),
    };

    runtime.handleInput(event, eventKey);
    return { accepted: true };
  }

  /** Devices or zones changed. Coalesced, and it never restarts a runtime. */
  async onCatalogChange(): Promise<void> {
    this.registry.onCatalogChange();
  }

  /**
   * A credential was entered or invalidated. Controllers keep driving lights
   * either way; only flow reconciliation depends on it.
   */
  async onCredentialChange(): Promise<void> {
    if (!this.deps.api.credentials.getStatus().valid) {
      // The key just died, or was deleted from settings. There is nothing to
      // reconcile — but a controller that still reports "ready" while its Flow
      // maintenance is dead is telling the user something untrue, and would go on
      // doing so until the next restart. assessHealth() never declares a
      // controller ready, so re-asking can only ever be honest.
      for (const runtime of this.registry.all()) {
        try {
          await runtime.assessHealth();
        } catch (error) {
          this.deps.log('Health re-check after a credential loss failed:', (error as Error)?.message);
        }
      }
      return;
    }

    for (const runtime of this.registry.all()) {
      try {
        await runtime.reconcileFlows();
        // Reconciling is not enough on its own: a controller that went
        // needs_credential stays there, and its device stays unavailable, until
        // something re-checks its health. Safe to call unconditionally —
        // reconcileFlows reports its own failures as state rather than throwing,
        // and the re-check asks the monitor rather than assuming the best.
        await runtime.recoverFromCredentialFailure();
      } catch (error) {
        this.deps.log('Reconcile after credential change failed:', (error as Error)?.message);
      }
    }
  }

  async destroyAll(): Promise<void> {
    return this.registry.destroyAll();
  }
}
