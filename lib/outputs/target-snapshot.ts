import type { CatalogDevice } from '../device-catalog';
import type { TargetResolver } from './target-resolver';
import type { TargetStateCache } from './target-state-cache';
import type { TargetSpec } from './light-intent';

/**
 * "Have this device's targets changed?", answered honestly.
 *
 * All three runtimes asked it as `JSON.stringify(ids) === JSON.stringify(old)`,
 * which is true in three cases where the answer should be no:
 *
 *  - a light RE-PAIRED under the same id, coming back with a different dim
 *    range. The clamps stayed calibrated to the old one, so "full brightness"
 *    stopped meaning full brightness.
 *  - a light going UNAVAILABLE and back. Nothing re-primed the cache, so the
 *    runtime went on planning against values from before it vanished.
 *  - a light gaining or losing `light_temperature` through a firmware update,
 *    which is exactly the kind of change an integration ships quietly.
 *
 * The fingerprint covers everything a plan is actually built from: which
 * devices, whether each is available, and each one's capability options
 * (CLAUDE.md §6 — these are NOT uniform and must be read, never assumed).
 * Names are excluded: a renamed light is the same light, and re-priming the
 * cache for a rename would drop live state for nothing.
 */

export interface TargetSnapshot {
  ids: string[];
  names: string[];
  devices: CatalogDevice[];
  missing: string[];
  summary: { onoff: number; dim: number; light_temperature: number; total: number };
  fingerprint: string;
}

const WATCHED_CAPABILITIES = ['onoff', 'dim', 'light_temperature'] as const;

export async function resolveSnapshot(
  resolver: TargetResolver,
  spec: TargetSpec,
): Promise<TargetSnapshot> {
  const resolved = await resolver.resolve(spec);
  return {
    ids: resolved.devices.map(device => device.id),
    names: resolved.devices.map(device => `${device.name} (${device.zoneName})`),
    devices: resolved.devices,
    missing: resolved.missing,
    summary: resolved.summary,
    fingerprint: fingerprintOf(resolved.devices, resolved.missing),
  };
}

/**
 * Stable across runs and across key order — the devices are sorted by id and
 * each one's options are serialised in a fixed order, so two identical Homeys
 * produce the same string and a reordered zone listing does not.
 */
function fingerprintOf(devices: CatalogDevice[], missing: string[]): string {
  const parts = [...devices]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(device => {
      const caps = WATCHED_CAPABILITIES.map(capability => {
        if (!device.capabilities.includes(capability)) return `${capability}:-`;
        const options = device.capabilitiesObj?.[capability];
        // min/max/step/decimals, in that order, always. `undefined` is
        // rendered rather than skipped so "no step" and "step 0" differ.
        return [
          capability,
          options?.min ?? '',
          options?.max ?? '',
          options?.step ?? '',
          options?.decimals ?? '',
        ].join(':');
      }).join(',');
      // Availability is in the fingerprint because it changes what a plan can
      // do, and because a light coming back needs its cache re-primed.
      return `${device.id}|${device.available === false ? 'off' : 'on'}|${caps}`;
    });

  // Missing ids are part of it too: a target the user picked that has since
  // been deleted is a real change of state, and its return is another.
  return [...parts, ...[...missing].sort().map(id => `${id}|missing`)].join(';');
}

/**
 * What a runtime has to release, and what it has to prime, to go from one
 * snapshot to the next.
 */
export interface TargetDiff {
  /** No longer targets. Subscriptions, cache state and probes must be released. */
  removed: string[];
  /** New, or changed enough to need re-priming. */
  addedOrChanged: string[];
}

export function diffTargets(previous: TargetSnapshot | null, next: TargetSnapshot): TargetDiff {
  const before = new Set(previous?.ids ?? []);
  const after = new Set(next.ids);

  return {
    removed: [...before].filter(id => !after.has(id)),
    // Everything still present is re-primed, not only the new ones: the
    // fingerprint has already told us SOMETHING changed, and working out which
    // device's options moved would cost more than re-reading values we are
    // holding anyway.
    addedOrChanged: [...after],
  };
}

/**
 * Release everything a runtime holds for a device that has stopped being a
 * target.
 *
 * Its own function because all three runtimes need it and only one of them did
 * any of it. The circadian case is the one that shows why: a light dropped
 * from the plan kept its capability subscription, so the next time somebody
 * switched it on, the rising edge still arrived and the runtime still wrote a
 * colour to a lamp it no longer had any business touching.
 */
export async function releaseTarget(
  deviceId: string,
  parts: {
    unsubscribe: (deviceId: string) => Promise<void>;
    cancelPending: (deviceId: string) => void;
    cache: TargetStateCache;
  },
): Promise<void> {
  // Order matters: stop the events first, then drop the state they would have
  // written to, then the timer that could still fire against both.
  await parts.unsubscribe(deviceId);
  parts.cancelPending(deviceId);
  parts.cache.forget(deviceId);
}
