/**
 * The `DeviceCatalog` methods a fake catalogue has to answer, and no more.
 *
 * Several suites stand in for the catalogue with a literal that stubs
 * `allZones`, `device` and `devicesInZone`. Two rules moved INTO the catalogue
 * after the first probe run — "which devices in a zone are lights" and "is this
 * one of ours" — because each had been copied into three callers, which is how
 * a fix could be applied twice and still miss a door.
 *
 * These helpers exist so the fakes answer those two without each inventing an
 * answer. They do NOT stand in for the rules: `device-catalog-lights.test.ts`
 * drives the real methods on a real `DeviceCatalog`, including the Lightkeeper
 * exclusion, which is the part no fake here can prove.
 */

import { DeviceCatalog } from '../../lib/device-catalog';

/**
 * `lightsInZone`, derived from the fake's own `devicesInZone`.
 *
 * Calls the REAL `DeviceCatalog.isLightClass()` rather than restating it. This
 * helper used to filter on `onoff` alone — the rule `lightCandidates()` keeps,
 * and not the one `lightsInZone()` has had since class started counting — so
 * every suite built on it resolved a zone to smart sockets, TVs and dishwashers
 * that the real catalogue would never have handed a runtime. A fixture device
 * that should resolve from a zone therefore has to say `class: 'light'` (or
 * `virtualClass: 'light'`), exactly as it would have to on a Homey.
 *
 * The own-device exclusion is `ownsNothing()` below: a fake has no app id, and
 * the real catalogue constructed without one excludes nothing either.
 */
export function zoneLights<T extends { capabilities: string[]; class: string; virtualClass?: string | null }>(
  devicesInZone: (zoneId: string, includeSubzones: boolean) => Promise<T[]>,
): (zoneId: string, includeSubzones: boolean) => Promise<T[]> {
  return async (zoneId, includeSubzones) => {
    const inZone = await devicesInZone(zoneId, includeSubzones);
    return inZone.filter(d =>
      DeviceCatalog.isLightClass({ class: d.class, virtualClass: d.virtualClass ?? null })
      && d.capabilities.includes('onoff') && !ownsNothing());
  };
}

/**
 * `isOwnDevice`, for a catalogue with no app around it.
 *
 * The same answer the real one gives when constructed without an app id, which
 * is what the ephemeral pairing rigs do.
 */
export function ownsNothing(): boolean {
  return false;
}
