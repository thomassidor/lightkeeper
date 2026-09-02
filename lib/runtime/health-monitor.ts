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
    if (surfaceMoved(profile, discovered)) {
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
          text: 'Lightkeeper needs a new API key to manage its Flows.',
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
      if (!surfaceIsPortablyTheSame(profile, discovered)) continue;
      return {
        deviceId: device.id,
        deviceName: device.name,
        matchedOn: 'owner+driver+fingerprint',
      };
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
  static applyReattach(
    profile: ControllerProfile,
    candidate: ReattachCandidate,
    discovered: {
      inputs: ControllerProfile['catalogue'];
      fingerprint: string;
      fingerprintV2?: string;
    },
  ): ControllerProfile {
    return {
      ...profile,
      source: {
        ...profile.source,
        deviceId: candidate.deviceId,
        name: candidate.deviceName,
        /**
         * The NEW device's own surface hashes, and this is not bookkeeping.
         *
         * A fingerprint is compared against the device it was taken from. Both
         * of them embed something device-specific — v2 hashes the card's full
         * `id` and `uri`, and those contain the device id (platform §4) — so a
         * profile that kept the old device's hashes after re-attaching to a new
         * one disagreed with itself on the very next health check: `assess()`
         * called `surfaceMoved()`, the hashes could not match, and the device
         * went straight back to needs_repair with "This remote now exposes
         * different events." One tap, and then the same dead end.
         */
        eventSurfaceFingerprint: discovered.fingerprint,
        ...(discovered.fingerprintV2 !== undefined
          ? { eventSurfaceFingerprintV2: discovered.fingerprintV2 }
          : {}),
      },
      // The old flows point at a device that no longer exists; reconciliation
      // recreates them against the new one.
      managedFlows: [],
      catalogue: discovered.inputs ?? profile.catalogue,
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

/**
 * Has the remote's event surface moved since this controller was configured?
 *
 * Versioned on purpose. `fingerprintV2` hashes more than v1 does — argument
 * filters, numeric bounds, a token's title (which carries the scale, and
 * therefore the difference between a nudge and a slam), the card's full id and
 * uri, and the normalizer's own version. Comparing v2 against a profile that
 * only ever stored v1 would disagree every time, so every installed controller
 * would report needs_repair on the upgrade — a mass false alarm about a surface
 * that had not moved.
 *
 * So: a profile that carries a v2 hash is compared on v2, and one that does not
 * keeps v1 semantics until it is next saved or repaired. That upgrade is
 * one-way; nothing writes a profile without a v2 any more.
 */
/**
 * Is this a DIFFERENT device of the same shape?
 *
 * Deliberately not `surfaceMoved()`, and the difference is the whole of why
 * one-tap re-attach was dead. `surfaceMoved()` asks "has the surface under MY
 * device changed", and answers it on v2 wherever a profile carries one — but v2
 * hashes each card's full `id` and `uri`, and both embed the device id
 * (platform §4). Comparing two different devices on it can only ever disagree,
 * so `findReattachCandidate` rejected every candidate it was ever offered, and
 * the user was dropped into a full remap with a correct, unhelpful "no longer
 * paired". Platform §7 records that BILRESA's cards vanish on every Homey
 * restart, which is what the feature exists for.
 *
 * v1 is the right question here rather than a compromise: it hashes each card's
 * `shortId` instead of its full id, which is exactly "the same card on another
 * device", and it is stored on every profile ever written. Nothing is lost by
 * not using v2's extra strictness either, because a re-attach re-discovers the
 * new device and adopts ITS catalogue and ITS hashes — see `applyReattach`. The
 * scale of a dial comes from the new device, not from the match.
 */
export function surfaceIsPortablyTheSame(
  profile: ControllerProfile,
  discovered: { fingerprint: string },
): boolean {
  return discovered.fingerprint === profile.source.eventSurfaceFingerprint;
}

export function surfaceMoved(
  profile: ControllerProfile,
  discovered: { fingerprint: string; fingerprintV2?: string },
): boolean {
  const storedV2 = profile.source.eventSurfaceFingerprintV2;
  if (storedV2 && discovered.fingerprintV2) return discovered.fingerprintV2 !== storedV2;
  return discovered.fingerprint !== profile.source.eventSurfaceFingerprint;
}
