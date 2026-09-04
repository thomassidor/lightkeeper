/**
 * The device and zone shapes `homey-api` hands back, at the seam where we
 * normalise them (`lib/device-catalog.ts`, the only consumer).
 *
 * `homey-api` ships JavaScript with JSDoc rather than type declarations, so `any`
 * at that boundary is deliberate and stays (CLAUDE.md's conventions section says
 * so). What was NOT deliberate is `any` propagating past the boundary: every
 * normalisation site read `d.capabilitiesObj` and `f.trigger.uri` with no
 * statement anywhere of what it expected, so a field renamed upstream produced
 * `undefined` rather than an error.
 *
 * These are structural and PARTIAL on purpose. They describe the fields this app
 * reads and make no claim about the rest — every field is optional, because the
 * client genuinely may not send one and the normalisers already handle that.
 * They are assertions about our expectations, not about Athom's API.
 *
 * **It once described the flow and card shapes too, and did not earn them.**
 * `RawFlow`, `RawFlowCardRef`, `RawFlowFolder`, `RawFlowCard`, `RawCardArgument`
 * and `RawCardToken` were declared here and referenced by nothing: every flow
 * and card seam — `flow-bridge-manager.ts`, `flow-folder-manager.ts`,
 * `flow-card-catalogue.ts`, `source-discovery-service.ts` — reads bare `any`
 * instead, and two of the six duplicated live shapes (`CardArgument` in
 * `inputs/magnitude-collapser.ts`, `CardToken` in `inputs/event-normalizer.ts`).
 * They survived because `test/unit/module-surface.test.ts` scans exported
 * VALUES and puts types out of scope deliberately, so nothing was ever going to
 * notice. Typing those seams would be a real improvement; six unread interfaces
 * describing them was not, so they are gone rather than left as an aspiration.
 */

/** A device, as `devices.getDevices()` returns it. */
export interface RawDevice {
  id?: unknown;
  name?: unknown;
  class?: unknown;
  virtualClass?: unknown;
  zone?: unknown;
  /**
   * `driverUri` and `zoneName` are deprecated in homey-api 3.19 and log a
   * warning on every access, which is why neither is listed and both are
   * resolved by us instead.
   */
  driverId?: unknown;
  ownerUri?: unknown;
  available?: unknown;
  capabilities?: unknown;
  capabilitiesObj?: unknown;
}

/** A zone, as `zones.getZones()` returns it. */
export interface RawZone {
  id?: unknown;
  name?: unknown;
  parent?: unknown;
}
