import type { DeviceCatalog, CatalogDevice } from '../device-catalog';
import { assessTargets, type UnwritableTargets } from './target-health';
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

/**
 * More than one remote matches, so there is no ONE tap to offer.
 *
 * Reported rather than resolved: the app cannot tell two identical STYRBARs
 * apart — that is what "portable fingerprint" means — and picking one would be
 * a coin toss that silently rebinds a controller to a remote another
 * controller is using. Repair already lets the user choose; this is what sends
 * them there with an accurate sentence instead of a wrong one-tap offer.
 */
export interface AmbiguousReattach {
  candidates: Array<{ deviceId: string; deviceName: string }>;
}

/**
 * How long a remote's discovered event surface is reused while its catalogue
 * row stays the same. See `surfaceOf`.
 */
export const SURFACE_MEMO_MS = 60 * 60_000;

type Discovered = Awaited<ReturnType<SourceDiscoveryService['discover']>>;

export class HealthMonitor {
  /**
   * The last surface discovered per source device, with the catalogue row it
   * was discovered against. Bounded by the remotes in use: an entry past its
   * hour is dropped the next time anything is discovered.
   */
  private readonly surfaces = new Map<string, { row: string; at: number; discovered: Discovered }>();

  /**
   * `sourcesInUse` is the device id every LIVE controller is currently
   * listening to, and it is what keeps a one-tap re-attach honest in a
   * household with two of the same remote.
   *
   * The portable fingerprint is device-agnostic by design — it hashes card
   * SHORT ids, which is exactly "the same card on another device" — so two
   * STYRBARs or two BILRESAs always tie, and the search below simply returned
   * whichever `allDevices()` listed first. Nothing excluded a device that is
   * the live source of ANOTHER controller. BILRESA is precisely the re-add case
   * platform §7 describes, so a household with two of them could be told
   * "Bedroom remote looks like this remote, re-added. Re-attach in one tap" —
   * about remote B, which is still driving controller B. The name is shown, so
   * an attentive user can decline; the copy promises one tap.
   *
   * Optional, defaulting to "nothing is in use": the ephemeral pairing rigs and
   * the older tests construct a monitor with three arguments, and a monitor
   * with no view of the registries should behave as it always did rather than
   * silently claim there are no conflicts.
   */
  constructor(
    private readonly catalog: DeviceCatalog,
    private readonly discovery: SourceDiscoveryService,
    private readonly credentialValid: () => boolean,
    private readonly sourcesInUse: () => ReadonlySet<string> = () => new Set(),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `unwritable` comes from the caller's own LightTargetAdapter, because the
   * monitor is shared by every controller and the adapter is not: one
   * HealthMonitor is built in app.ts, one adapter per runtime. Optional so the
   * ephemeral pairing rigs and the tests that only care about availability can
   * go on calling this with one argument.
   */
  async assess(
    profile: ControllerProfile,
    unwritable?: UnwritableTargets,
  ): Promise<HealthAssessment> {
    if (!profile.enabled) return { state: 'disabled' };

    const source = await this.catalog.device(profile.source.deviceId);

    if (!source) {
      /**
       * The source is gone. Before declaring "needs repair", look for the same
       * remote re-added under a new device ID — in ONE scan.
       *
       * This used to ask twice: `findReattachCandidate` (stopping at two) and
       * then `findReattachCandidates` (all of them). Every candidate `discover()`
       * matches its device against the whole trigger catalogue, and this branch
       * runs on every catalogue change for as long as the remote stays gone,
       * which for BILRESA is "recurring, not exceptional". One full list answers
       * both questions: exactly one is the tap, more than one is the ambiguity.
       */
      const { candidates } = await this.findReattachCandidates(profile);
      if (candidates.length === 1) {
        const candidate: ReattachCandidate = { ...candidates[0]!, matchedOn: 'owner+driver+fingerprint' };
        return {
          state: 'needs_repair',
          detail: {
            key: 'source.reattach',
            tokens: { name: candidate.deviceName },
            text: `"${candidate.deviceName}" looks like this remote, re-added. Re-attach in one tap.`,
          },
          reattach: candidate,
        };
      }

      /**
       * No ONE candidate — which is not the same as no candidates.
       *
       * Two identical remotes tie on the portable fingerprint by construction,
       * so the honest answer is "open repair and pick", not a coin toss. Said
       * with its own sentence rather than falling through to "no longer
       * paired", which would be untrue and would send the user looking for a
       * remote sitting on the shelf in front of them.
       */
      if (candidates.length > 1) {
        return {
          state: 'needs_repair',
          detail: {
            key: 'source.reattachAmbiguous',
            tokens: { count: candidates.length },
            text: `${candidates.length} remotes look like this one. Open repair to choose.`,
          },
        };
      }

      return {
        state: 'needs_repair',
        detail: {
          key: 'state.sourceGone',
          text: 'The remote this controller uses is no longer paired.',
        },
      };
    }

    if (!source.available) {
      // Forget its surface: an integration restarting is the likeliest reason,
      // and the row it comes back with is otherwise identical to the one before.
      this.surfaces.delete(source.id);
      return { state: 'needs_repair', detail: { key: 'state.sourceUnavailable' } };
    }

    // An integration update can change the event surface under us. A
    // remembered surface may only ever clear a controller, never fail one: a
    // disagreement is re-read live before it becomes a verdict.
    const { discovered, remembered } = await this.surfaceOf(source);
    if (surfaceMoved(profile, discovered) && (!remembered || surfaceMoved(profile, await this.discoverLive(source)))) {
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
    const targets = await assessTargets(this.catalog, profile.target, unwritable);
    return targets.detail
      ? { state: targets.state, detail: targets.detail }
      : { state: targets.state };
  }

  /**
   * The source's event surface — remembered while its catalogue row is unchanged
   * and the memory is under `SURFACE_MEMO_MS` old, discovered live otherwise.
   *
   * Every discovery matches the remote against the whole trigger catalogue, and
   * `assess()` runs on every catalogue change: on the reference Homey that was
   * a full read of 1748 cards 13 times an hour (after `isNoOpZoneUpdate` had
   * already removed the zone traffic), driven by a dashboard tablet flapping
   * `available` and an integration re-sending a device with nothing changed —
   * neither of them the remote. Re-discovering is only worth it when something
   * about the REMOTE could have moved.
   *
   * The row is `id`, `available`, `driverId` and `ownerUri`: an integration
   * update restarts its app, which is expected to show here as availability —
   * and `assess()` drops the memory whenever it sees the source unavailable,
   * because the row it comes back with is the same as the one before. That is
   * not measured, so the hour is the backstop — an update that moved the
   * surface without touching the row is noticed within the hour instead of on
   * whatever catalogue change happened to come next. And the cost of being wrong
   * runs the safe way: `assess()` never declares `surfaceChanged` from memory.
   */
  private async surfaceOf(source: CatalogDevice): Promise<{ discovered: Discovered; remembered: boolean }> {
    const known = this.surfaces.get(source.id);
    if (known && known.row === surfaceRow(source) && this.now() - known.at < SURFACE_MEMO_MS) {
      return { discovered: known.discovered, remembered: true };
    }
    return { discovered: await this.discoverLive(source), remembered: false };
  }

  private async discoverLive(source: CatalogDevice): Promise<Discovered> {
    const discovered = await this.discovery.discover(source);
    const at = this.now();
    for (const [id, entry] of this.surfaces) {
      if (at - entry.at >= SURFACE_MEMO_MS) this.surfaces.delete(id);
    }
    this.surfaces.set(source.id, { row: surfaceRow(source), at, discovered });
    return discovered;
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
    // Two is already enough to know there is no one-tap answer, and every
    // extra `discover()` is a catalogue read (platform §15).
    const matches = await this.scanForReattach(profile, 2);
    if (matches.length !== 1) return undefined;
    return { ...matches[0]!, matchedOn: 'owner+driver+fingerprint' };
  }

  /**
   * The same search, reported as the ambiguity it is: every candidate.
   *
   * `assess()` asks this one, once, because it needs the count for the
   * ambiguous sentence anyway. `findReattachCandidate` stays for the repair
   * screen, which only wants to know whether to offer the tap and stops at two.
   */
  async findReattachCandidates(profile: ControllerProfile): Promise<AmbiguousReattach> {
    return { candidates: await this.scanForReattach(profile) };
  }

  /** The one scan both questions are answered from, optionally stopping early. */
  private async scanForReattach(
    profile: ControllerProfile,
    stopAt = Number.POSITIVE_INFINITY,
  ): Promise<Array<{ deviceId: string; deviceName: string }>> {
    if (!profile.source.eventSurfaceFingerprint) return [];

    const inUse = this.sourcesInUse();
    const devices = await this.catalog.allDevices();
    const matches: Array<{ deviceId: string; deviceName: string }> = [];

    for (const device of devices) {
      // A device already used by this controller is not a re-attach candidate.
      if (device.id === profile.source.deviceId) continue;
      // Nor is one another LIVE controller is listening to. Re-attaching onto
      // it would leave two controllers driving from one remote, with the other
      // one's mappings silently competing for the same gestures.
      if (inUse.has(device.id)) continue;
      if (!matchesOwnerAndDriver(device, profile)) continue;

      const discovered = await this.discovery.discover(device);
      if (!surfaceIsPortablyTheSame(profile, discovered)) continue;
      matches.push({ deviceId: device.id, deviceName: device.name });
      if (matches.length >= stopAt) break;
    }

    return matches;
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

/** What about a source device would make its remembered surface worth re-reading. */
function surfaceRow(device: CatalogDevice): string {
  return JSON.stringify([device.id, device.available, device.driverId, device.ownerUri]);
}

export function matchesOwnerAndDriver(device: CatalogDevice, profile: ControllerProfile): boolean {
  // Match on owner app plus driver, never on model name alone. The same
  // hardware exposes a different surface through a different pairing path.
  if (profile.source.driverId && device.driverId !== profile.source.driverId) return false;
  if (profile.source.ownerAppId && device.ownerUri !== profile.source.ownerAppId) return false;
  return Boolean(profile.source.driverId || profile.source.ownerAppId);
}

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
export function surfaceMoved(
  profile: ControllerProfile,
  discovered: { fingerprint: string; fingerprintV2?: string },
): boolean {
  const storedV2 = profile.source.eventSurfaceFingerprintV2;
  if (storedV2 && discovered.fingerprintV2) return discovered.fingerprintV2 !== storedV2;
  return discovered.fingerprint !== profile.source.eventSurfaceFingerprint;
}
