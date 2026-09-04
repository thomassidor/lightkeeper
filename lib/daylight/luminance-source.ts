import { KeyedMutex } from '../support/keyed-mutex';
import type { HomeyApiService, Unsubscribe } from '../homey-api-service';
import type { DeviceCatalog } from '../device-catalog';
import type { DaylightReading } from './daylight-response';
import { LUMINANCE_CAPABILITY } from './daylight-types';
import { messageOf } from '../support/homey-errors';

/**
 * What the household's light sensors currently read, shared by every device that
 * asked.
 *
 * An app-level service, a sibling of `DeviceCatalog` rather than a per-runtime
 * object, and the reason is arithmetic: a Daylight light, three schedules and a
 * Curve light may every one of them name the sensor in the hall. Five runtimes
 * each holding their own subscription to it is five listeners on one battery
 * device, five teardowns to get right, and five chances to leak one. So
 * subscriptions are REF-COUNTED here and the runtimes only retain and release.
 *
 * **Deliberately not routed through `LightTargetAdapter` and `TargetStateCache`,
 * and that is not effort avoided** (platform §16). The `Capability` union in
 * lib/outputs/intent-planner.ts is the set of capabilities this app WRITES;
 * `measure_luminance` is `setable: false`, carries no `min` and no `max`, and
 * `TargetStateCache.supports()` returns false for it because it is not in
 * `TargetCapabilities`. Widening either would put a read-only sensor into the
 * write path. What IS borrowed is the subscription pattern itself —
 * `makeCapabilityInstance` plus `api.track()` teardown, serialised per device by
 * `KeyedMutex` — because that is the part with the bug in it.
 */

interface Watched {
  /** How many devices have retained this sensor. Zero means unsubscribe. */
  owners: Set<string>;
  off: Unsubscribe | null;
  /** The last finite reading, in lux. `null` means it has never reported one. */
  lux: number | null;
  at: number | null;
  name: string;
  /** Homey's own availability flag, refreshed from the catalog. */
  available: boolean;
}

export interface WatchedSensor {
  deviceId: string;
  name: string;
  lux: number | null;
  /** When that reading arrived. Reported so a FROZEN sensor is visible. */
  at: number | null;
  available: boolean;
}

export interface LuminanceDeps {
  api: HomeyApiService;
  catalog: DeviceCatalog;
  now?: () => number;
  log: (...args: unknown[]) => void;
}

export class LuminanceSource {
  private readonly sensors = new Map<string, Watched>();
  /** Serialised per sensor: a read-then-create is only safe if two callers cannot both read absent. */
  private readonly lock = new KeyedMutex();

  constructor(private readonly deps: LuminanceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Say which sensors one device needs, and stop needing every other one.
   *
   * Idempotent and total for that owner: pass the whole list every time, and a
   * sensor dropped from a plan is released by the same call that retains the
   * new one. A runtime calling this on every plan change is the intended use.
   */
  async retain(deviceIds: string[], owner: string): Promise<void> {
    const wanted = new Set(deviceIds);

    for (const [deviceId, watched] of this.sensors) {
      if (wanted.has(deviceId) || !watched.owners.has(owner)) continue;
      watched.owners.delete(owner);
      await this.dropIfUnwanted(deviceId);
    }

    for (const deviceId of wanted) {
      await this.lock.run(deviceId, () => this.subscribeNow(deviceId, owner));
    }
  }

  /** Give up every sensor one device held. Called from a runtime's stop(). */
  async release(owner: string): Promise<void> {
    for (const [deviceId, watched] of [...this.sensors]) {
      if (!watched.owners.has(owner)) continue;
      watched.owners.delete(owner);
      await this.dropIfUnwanted(deviceId);
    }
  }

  /**
   * The mean over the USABLE sensors, or nothing.
   *
   * A mean rather than the brightest, and it is a decision: the sensors somebody
   * picked are the weighting. Somebody who does not want a shaded corner's
   * opinion of the room does not select it, and taking the maximum instead would
   * quietly let one window-facing sensor speak for a whole flat.
   *
   * Usable excludes a sensor that is gone, one Homey reports unavailable, and
   * one that has never reported a finite number. It deliberately does NOT
   * exclude an OLD reading: many Zigbee sensors report only on change, so a
   * quiet sensor in a stable room is telling the truth, and a staleness timeout
   * would fall back to the sky exactly then. A frozen sensor is made visible
   * instead — `watched()` carries every reading's age, and the settings page
   * shows it (platform §16).
   */
  read(deviceIds: string[]): DaylightReading | null {
    const used: string[] = [];
    let total = 0;

    for (const deviceId of deviceIds) {
      const watched = this.sensors.get(deviceId);
      if (watched === undefined || !watched.available) continue;
      if (watched.lux === null || !Number.isFinite(watched.lux)) continue;
      total += watched.lux;
      used.push(deviceId);
    }

    if (used.length === 0) return null;
    return { lux: total / used.length, deviceIds: used };
  }

  /** Every sensor being watched, for the settings page and diagnostics. */
  watched(): WatchedSensor[] {
    return [...this.sensors].map(([deviceId, watched]) => ({
      deviceId,
      name: watched.name,
      lux: watched.lux,
      at: watched.at,
      available: watched.available,
    }));
  }

  /**
   * Re-read every watched sensor's metadata after the catalog changes.
   *
   * Availability is what makes a sensor usable, and it arrives on the catalog's
   * device events rather than over a capability subscription — so without this a
   * sensor whose battery died went on being averaged with its last reading for
   * as long as the app ran.
   */
  async onCatalogChange(): Promise<void> {
    for (const [deviceId, watched] of this.sensors) {
      await this.refreshMetadata(deviceId, watched);
    }
  }

  /** Drop every subscription. The app-level backstop, called from onUninit. */
  async destroy(): Promise<void> {
    for (const [deviceId, watched] of [...this.sensors]) {
      watched.owners.clear();
      await this.dropIfUnwanted(deviceId);
    }
    this.sensors.clear();
  }

  private async subscribeNow(deviceId: string, owner: string): Promise<void> {
    const existing = this.sensors.get(deviceId);
    if (existing !== undefined) {
      existing.owners.add(owner);
      return;
    }

    const watched: Watched = {
      owners: new Set([owner]), off: null, lux: null, at: null, name: deviceId, available: false,
    };
    // In the map BEFORE the awaits below, so a second retain() for the same
    // sensor — which the lock has queued behind this one — adds an owner rather
    // than building a second subscription to the same lamp.
    this.sensors.set(deviceId, watched);

    // Seeded from the catalog first, because a battery sensor may not report for
    // many minutes and a device that has to wait for that is a device that
    // reports needs_repair on every restart.
    await this.refreshMetadata(deviceId, watched);

    try {
      const client = await this.deps.api.read();
      const device = await client.devices.getDevice({ id: deviceId });
      const instance = device.makeCapabilityInstance(LUMINANCE_CAPABILITY, (value: unknown) => {
        // Never let a listener's failure take the subscription down with it:
        // this callback runs inside Homey's own event dispatch.
        try {
          this.note(deviceId, value);
        } catch (error) {
          this.deps.log(`Luminance listener for ${deviceId} threw:`, messageOf(error));
        }
      });
      // track() hands back a wrapper that also removes itself from the service's
      // teardown set, so tearing down here leaves nothing for destroy() to call
      // a second time.
      watched.off = this.deps.api.track(() => instance.destroy());
    } catch (error) {
      // Kept in the map with `off: null`. It has an owner, `available` is
      // whatever the catalog said, and `read()` skips it — so the sky answers
      // and the device reports why rather than failing to start.
      this.deps.log(`Could not subscribe to luminance on ${deviceId}:`, messageOf(error));
    }
  }

  private note(deviceId: string, value: unknown): void {
    const watched = this.sensors.get(deviceId);
    if (watched === undefined) return;

    const lux = asLux(value);
    // Not a reading. Keeping the previous one is right: the sensor is still
    // there and the last thing it said is still the best answer available,
    // which is the opposite of what treating this as 0 would do to a room.
    if (lux === null) {
      this.deps.log(`Ignoring an unusable luminance report from ${deviceId}:`, value);
      return;
    }

    watched.lux = lux;
    watched.at = this.now();
  }

  private async refreshMetadata(deviceId: string, watched: Watched): Promise<void> {
    try {
      const device = await this.deps.catalog.device(deviceId);
      if (device === undefined) {
        // Gone from the Homey. Unavailable rather than removed, because the
        // owners still name it and a re-paired sensor should come back on its
        // own — and because a device the user can see in a plan should be
        // visible on the settings page as missing rather than absent from it.
        watched.available = false;
        return;
      }

      watched.name = device.name;
      // Both halves matter: a device that has lost the capability is no more use
      // than one that is offline, and a plan can name a sensor that was replaced
      // by something else at the same id.
      watched.available = device.available && device.capabilities.includes(LUMINANCE_CAPABILITY);

      // Seed the value only if nothing has arrived over the subscription. A
      // catalog read is a snapshot and the subscription is live, so letting the
      // snapshot win would replay an old reading over a current one.
      if (watched.lux === null) {
        // Through the same guard as a live report: a capabilitiesObj entry whose
        // value is null would otherwise seed 0 lux, which is pitch dark.
        const current = asLux(device.capabilitiesObj[LUMINANCE_CAPABILITY]?.value);
        if (current !== null) {
          watched.lux = current;
          watched.at = this.now();
        }
      }
    } catch (error) {
      this.deps.log(`Could not read luminance metadata for ${deviceId}:`, messageOf(error));
      watched.available = false;
    }
  }

  private async dropIfUnwanted(deviceId: string): Promise<void> {
    const watched = this.sensors.get(deviceId);
    if (watched === undefined || watched.owners.size > 0) return;

    // Out of the map first, so a retain() racing this builds a fresh
    // subscription rather than adding an owner to one being torn down.
    this.sensors.delete(deviceId);
    if (watched.off === null) return;
    try {
      await watched.off();
    } catch (error) {
      this.deps.log(`Could not release luminance on ${deviceId}:`, messageOf(error));
    }
  }
}

/**
 * A lux value, or nothing — and NOT via a bare `Number()`.
 *
 * `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all 0, and
 * 0 lux is not "no reading", it is PITCH DARK. A sensor whose battery has gone
 * and whose integration reports `null` would therefore have driven a whole room
 * to the dark end of its response with a number it never sent. Found by the test
 * that fires every junk value at a live listener.
 *
 * Numeric strings ARE accepted: `measure_luminance` is declared `type: number`
 * so Homey should hand over a number, but homey-api boundaries are loose and an
 * integration reporting "640" means 640. Nothing else is coerced.
 */
function asLux(value: unknown): number | null {
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
  } else if (typeof value !== 'number') {
    return null;
  }

  const lux = Number(value);
  if (!Number.isFinite(lux) || lux < 0) return null;
  return lux;
}
