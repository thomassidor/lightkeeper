/**
 * Whether an engine device keeps its own lights up to date, or only publishes.
 *
 * The three engine device types — a circadian light, a Colour Curve Light and a
 * Room-sensing Light — used to have one job each: own their lights all day and
 * apply their values whenever one comes on. A remote's "On – with Lightkeeper"
 * button reads the same devices ON DEMAND, and the two models collided on the
 * reference Homey: pointed at lamps its sources already drove, one button press
 * became three Lightkeeper devices writing to the same five bulbs — two
 * brightnesses, the colour twice, ~30 writes in 3 s through one Hue bridge — and
 * the lamps visibly stepped between them. `writesLights: false` is the second
 * model made expressible: the device goes on computing and PUBLISHING (the
 * capability rows, the Flow tags, the sources a button or `set_lights` reads)
 * and writes to no lamp at all.
 *
 * THE GATE IS `!== false`, and that is the opposite of `preStage`'s. Every
 * device paired before this flag existed has no key and must keep writing, so an
 * absent key means ON. Copying `preStage === true` here would silently stop every
 * existing device in every house on the next update. The key is therefore only
 * ever STORED when false, which also keeps a plan written before this change
 * byte-identical after a round trip through the validators.
 */

/** Anything that may carry the flag. Absent is on. */
export interface WritesLightsFlag {
  writesLights?: boolean;
}

/** True unless the plan explicitly says it only publishes. */
export function keepsLightsUpdated(plan: WritesLightsFlag): boolean {
  return plan.writesLights !== false;
}

/**
 * The flag as it is stored: present only when it says "no".
 *
 * Spread into a plan literal — `{ ...writesLightsField(x), … }` — so that the
 * default never appears in storage and a store written before the flag existed
 * validates back to exactly itself.
 */
export function writesLightsField(writes: boolean): { writesLights?: false } {
  return writes ? {} : { writesLights: false };
}

/**
 * A pairing screen's switch, taken only when it arrives as a real boolean.
 *
 * A payload that leaves it out keeps what the session already holds. Reading an
 * absent key as "off" would quietly turn a device into one that only publishes
 * the first time any screen emitted without it. Junk keeps the fallback too,
 * because a screen that sent junk did not say "only publish".
 */
export function writesLightsFrom(payload: unknown, fallback: boolean): boolean {
  const value = (payload as { writesLights?: unknown } | null | undefined)?.writesLights;
  return typeof value === 'boolean' ? value : fallback;
}
