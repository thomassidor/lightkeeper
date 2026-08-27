/**
 * The shapes `homey-api` actually hands back, at the seams where we normalise
 * them.
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

/**
 * A flow, as `flow.getFlows()` returns it.
 *
 * `trigger` and each action carry BOTH an `id` and a `uri`, and the uri embeds
 * the id (platform §3). Neither is ever constructed here — both are echoed back
 * from enumeration, and this type is part of saying so.
 */
export interface RawFlow {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  folder?: unknown;
  trigger?: RawFlowCardRef;
  conditions?: unknown;
  actions?: RawFlowCardRef[];
}

export interface RawFlowCardRef {
  id?: unknown;
  uri?: unknown;
  args?: unknown;
  group?: unknown;
  /** A TOP-LEVEL property of an action, not an entry in args (platform §5). */
  droptoken?: unknown;
}

/**
 * A flow folder, as `flow.getFlowFolders()` returns it.
 *
 * Nesting is real: `parent` is a folder id or null, and both `createFlowFolder`
 * and `updateFlowFolder` accept one (platform §11). A lookup must key on
 * (name, parent) — name alone picks up a device folder a user happened to name
 * `Lightkeeper` and nests everything inside one device.
 */
export interface RawFlowFolder {
  id?: unknown;
  name?: unknown;
  parent?: unknown;
}

/** A trigger card, as `flow.getFlowCardTriggers()` returns it (~1700 of them). */
export interface RawFlowCard {
  id?: unknown;
  uri?: unknown;
  title?: unknown;
  args?: RawCardArgument[];
  tokens?: RawCardToken[];
}

export interface RawCardArgument {
  name?: unknown;
  type?: unknown;
  title?: unknown;
  values?: Array<{ id?: unknown; title?: unknown }>;
  /** A query string, e.g. `driver_id=remote_control_n2&class=remote`. */
  filter?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
}

export interface RawCardToken {
  /** Token identity is `id`, never `name`; using `name` produces broken flows. */
  id?: unknown;
  type?: unknown;
  /** Carries the scale, e.g. "Steps (1000/turn)". */
  title?: unknown;
}
