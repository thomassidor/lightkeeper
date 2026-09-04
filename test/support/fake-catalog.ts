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

/**
 * `lightsInZone`, derived from the fake's own `devicesInZone`.
 */
export function zoneLights<T extends { capabilities: string[] }>(
  devicesInZone: (zoneId: string, includeSubzones: boolean) => Promise<T[]>,
): (zoneId: string, includeSubzones: boolean) => Promise<T[]> {
  return async (zoneId, includeSubzones) => {
    const inZone = await devicesInZone(zoneId, includeSubzones);
    return inZone.filter(d => d.capabilities.includes('onoff'));
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
