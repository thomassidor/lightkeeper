import type { DeviceCatalog, CatalogDevice } from '../device-catalog';
import type { SourceDiscoveryService } from '../source-discovery-service';
import type { ControllerProfile, ControllerState } from '../profiles/controller-profile';

/**
 * Spec §9.2 and §9.4 — detects missing sources and targets, broken flows and
 * changed card schemas, and offers one-tap re-attach.
 */

export interface HealthAssessment {
  state: ControllerState;
  /** Locale key plus tokens, so the device layer can translate (§14 Danish). */
  messageKey?: string;
  tokens?: Record<string, string | number>;
  /** English fallback, for logs and diagnostics. */
  detail?: string;
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
      // §9.4 — the source is gone. Before declaring "needs repair", look for
      // the same remote re-added under a new device ID.
      const candidate = await this.findReattachCandidate(profile);
      return candidate
        ? {
          state: 'needs_repair',
          messageKey: 'source.reattach',
          tokens: { name: candidate.deviceName },
          detail: `"${candidate.deviceName}" looks like this remote, re-added. Re-attach in one tap.`,
          reattach: candidate,
        }
        : {
          state: 'needs_repair',
          messageKey: 'state.sourceGone',
          detail: 'The remote this controller uses is no longer paired.',
        };
    }

    // §9.3 — an integration update can change the event surface under us.
    const discovered = await this.discovery.discover(source);
    if (discovered.fingerprint !== profile.source.eventSurfaceFingerprint) {
      return {
        state: 'needs_repair',
        messageKey: 'state.surfaceChanged',
        detail: 'This remote now exposes different events. Open repair to remap it.',
      };
    }

    if (profile.managedFlows.length > 0 && !this.credentialValid()) {
      // The mappings are fine; only the credential is not (§9.2).
      return {
        state: 'needs_credential',
        messageKey: 'state.needsCredential',
        detail: 'Light Link needs a valid API key to maintain its Flows.',
      };
    }

    const targets = await this.resolveTargetHealth(profile);
    if (targets.available === 0) {
      return {
        state: 'needs_repair',
        messageKey: 'state.noTargets',
        detail: 'None of this controller\'s lights are available.',
      };
    }
    if (targets.available < targets.total) {
      return {
        state: 'partial',
        messageKey: 'state.someTargets',
        tokens: { count: targets.total - targets.available, total: targets.total },
        detail: `${targets.total - targets.available} of ${targets.total} lights unavailable.`,
      };
    }

    return { state: 'ready' };
  }

  /**
   * §9.4 CRITICAL — one-tap re-attach.
   *
   * On BILRESA, trigger cards disappear after a Homey restart and the device
   * must be removed and re-added. That is recurring, not exceptional. A generic
   * "needs repair" state that makes the user redo the mapping every time
   * defeats the product.
   *
   * A candidate must match on owner app AND driver AND event-surface
   * fingerprint. Where the fingerprint has changed we fall back to §6.5 and
   * require remapping — never guess a new binding.
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

  private async resolveTargetHealth(profile: ControllerProfile): Promise<{ total: number; available: number }> {
    if (profile.target.kind === 'devices') {
      const devices = await Promise.all(profile.target.deviceIds.map(id => this.catalog.device(id)));
      const present = devices.filter((d): d is CatalogDevice => d !== undefined);
      return {
        total: profile.target.deviceIds.length,
        available: present.filter(d => d.available).length,
      };
    }

    const inZone = await this.catalog.devicesInZone(profile.target.zoneId, profile.target.includeSubzones);
    const lights = inZone.filter(d => d.capabilities.includes('onoff'));
    return { total: lights.length, available: lights.filter(d => d.available).length };
  }
}

export function matchesOwnerAndDriver(device: CatalogDevice, profile: ControllerProfile): boolean {
  // §2.4 — match on owner app plus driver, never on model name alone. The same
  // hardware exposes a different surface through a different pairing path.
  if (profile.source.driverId && device.driverId !== profile.source.driverId) return false;
  if (profile.source.ownerAppId && device.ownerUri !== profile.source.ownerAppId) return false;
  return Boolean(profile.source.driverId || profile.source.ownerAppId);
}
