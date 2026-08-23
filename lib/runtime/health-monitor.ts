import type { DeviceCatalog, CatalogDevice } from '../device-catalog';
import { assessTargets } from './target-health';
import type { SourceDiscoveryService } from '../source-discovery-service';
import type {
  ControllerProfile, ControllerState, StateDetail,
} from '../profiles/controller-profile';

/**
 * Detects missing sources and targets, broken flows and
 * changed card schemas, and offers one-tap re-attach.
 */

export interface HealthAssessment {
  state: ControllerState;
  /**
   * Locale key plus tokens, so the device layer can translate it; `text` is the
   * English fallback for logs. This is the same StateDetail every other verdict
   * in the app speaks — it used to be three flat fields here plus an adapter in
   * ControllerRuntime to convert them.
   */
  detail?: StateDetail;
  /** Set when the source device has gone but a re-attach candidate exists. */
  reattach?: ReattachCandidate;
}

export interface ReattachCandidate {
  deviceId: string;
  deviceName: string;
  /** Why we believe this is the same remote, re-added. */
  matchedOn: 'owner+driver+fingerprint';
}

export class HealthMonitor {
  constructor(
    private readonly catalog: DeviceCatalog,
    private readonly discovery: SourceDiscoveryService,
    private readonly credentialValid: () => boolean,
  ) {}

  async assess(profile: ControllerProfile): Promise<HealthAssessment> {
    if (!profile.enabled) return { state: 'disabled' };

    const source = await this.catalog.device(profile.source.deviceId);

    if (!source) {
      // The source is gone. Before declaring "needs repair", look for
      // the same remote re-added under a new device ID.
      const candidate = await this.findReattachCandidate(profile);
      return candidate
        ? {
          state: 'needs_repair',
          detail: {
            key: 'source.reattach',
            tokens: { name: candidate.deviceName },
            text: `"${candidate.deviceName}" looks like this remote, re-added. Re-attach in one tap.`,
          },
          reattach: candidate,
        }
        : {
          state: 'needs_repair',
          detail: {
            key: 'state.sourceGone',
            text: 'The remote this controller uses is no longer paired.',
          },
        };
    }

    // An integration update can change the event surface under us.
    const discovered = await this.discovery.discover(source);
    if (discovered.fingerprint !== profile.source.eventSurfaceFingerprint) {
      return {
        state: 'needs_repair',
        detail: {
          key: 'state.surfaceChanged',
          text: 'This remote now exposes different events. Open repair to remap it.',
        },
      };
    }

    if (profile.managedFlows.length > 0 && !this.credentialValid()) {
      // The mappings are fine; only the credential is not.
      return {
        state: 'needs_credential',
        detail: {
          key: 'state.needsCredential',
          text: 'Lightkeeper needs a valid API key to maintain its Flows.',
        },
      };
    }

    // Delegated, not repeated: assessTargets() is the one place that turns a
    // target count into a verdict, and a schedule asks it the same question.
    // HealthMonitor kept its own copy of this arithmetic, down to the same
    // locale keys and the same tokens, while target-health.ts claimed in its
    // own docblock to have taken it over.
    const targets = await assessTargets(this.catalog, profile.target);
    return targets.detail
      ? { state: targets.state, detail: targets.detail }
      : { state: targets.state };
  }

  /**
   * CRITICAL — one-tap re-attach.
   *
   * On BILRESA, trigger cards disappear after a Homey restart and the device
   * must be removed and re-added. That is recurring, not exceptional. A generic
   * "needs repair" state that makes the user redo the mapping every time
   * defeats the product.
   *
   * A candidate must match on owner app AND driver AND event-surface
   * fingerprint. Where the fingerprint has changed we require remapping
   * instead — never guess a new binding.
   */
  async findReattachCandidate(profile: ControllerProfile): Promise<ReattachCandidate | undefined> {
    if (!profile.source.eventSurfaceFingerprint) return undefined;

    const devices = await this.catalog.allDevices();
    const plausible = devices.filter(device =>
      // A device already used by this controller is not a re-attach candidate.
      device.id !== profile.source.deviceId
      && matchesOwnerAndDriver(device, profile));

    for (const device of plausible) {
      const discovered = await this.discovery.discover(device);
      if (discovered.fingerprint === profile.source.eventSurfaceFingerprint) {
        return {
          deviceId: device.id,
          deviceName: device.name,
          matchedOn: 'owner+driver+fingerprint',
        };
      }
    }

    return undefined;
  }

  /**
   * Rebind to the new device ID, preserving every mapping and target. The
   * binding keys are derived from card short ids, which are stable across a
   * re-add, so the catalogue keys still line up.
   *
   * Clearing managedFlows here is only half the contract: the device layer must
   * not put them back. `carryForwardFlows()` in lib/profiles/controller-profile.ts
   * is what enforces that, and it is load-bearing — the old flows trigger on the
   * device id that just disappeared, so keeping them makes reconciliation read
   * them as user-edited and create nothing.
   */
  static applyReattach(profile: ControllerProfile, candidate: ReattachCandidate, catalogue: ControllerProfile['catalogue']): ControllerProfile {
    return {
      ...profile,
      source: {
        ...profile.source,
        deviceId: candidate.deviceId,
        name: candidate.deviceName,
      },
      // The old flows point at a device that no longer exists; reconciliation
      // recreates them against the new one.
      managedFlows: [],
      catalogue: catalogue ?? profile.catalogue,
    };
  }

}

export function matchesOwnerAndDriver(device: CatalogDevice, profile: ControllerProfile): boolean {
  // Match on owner app plus driver, never on model name alone. The same
  // hardware exposes a different surface through a different pairing path.
  if (profile.source.driverId && device.driverId !== profile.source.driverId) return false;
  if (profile.source.ownerAppId && device.ownerUri !== profile.source.ownerAppId) return false;
  return Boolean(profile.source.driverId || profile.source.ownerAppId);
}
