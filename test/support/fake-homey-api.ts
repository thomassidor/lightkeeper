import { DeviceCatalog } from '../../lib/device-catalog';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * A `homey-api` read client with a handful of devices in it — enough for the
 * REAL `DeviceCatalog` to stand on, and for the real write path to write to.
 *
 * The companion to `fake-homey.ts`. That file fakes the SDK an entry point
 * EXTENDS; this one fakes the client the app READS the house through. They are
 * separate because they are separate seams (platform §1: the app's own token
 * and the SDK are two different things), and because most driver tests want the
 * real catalogue — the light picker, the zone expansion and the "is this one of
 * ours" rule are all in it, and a hand-written catalogue fake would be a second
 * copy of those rules that proved nothing about the first.
 *
 * Every device is LIVE: a `setCapabilityValue` updates the value the next
 * `getDevice` returns and fires any `makeCapabilityInstance` listener, so a
 * runtime that writes and then reads back sees its own write, as on a Homey.
 * `FakeApiOptions` opts into the two things a Homey does that this does not by
 * default: duplicated echoes (platform §6) and the `getAll` cache serving a
 * later `getDevice` (platform §15).
 */

export interface RawDeviceFixture {
  id: string;
  name: string;
  zone: string;
  class?: string;
  capabilities: Record<string, unknown>;
  ownerUri?: string;
  driverId?: string;
  data?: { id: string };
  available?: boolean;
  settings?: Record<string, unknown>;
}

/** A dimmable, tunable lamp with a mode, in `zone`. */
export function lamp(id: string, name: string, zone = 'z-living', values: Record<string, unknown> = {}): RawDeviceFixture {
  return {
    id, name, zone, class: 'light',
    capabilities: {
      onoff: true, dim: 0.5, light_temperature: 0.4, light_hue: 0.1, light_saturation: 0.6,
      light_mode: 'temperature',
      ...values,
    },
  };
}

/** A lux sensor. */
export function luxSensor(id: string, name: string, zone = 'z-living', lux: unknown = 120): RawDeviceFixture {
  return { id, name, zone, class: 'sensor', capabilities: { measure_luminance: lux } };
}

export interface ZoneFixture { id: string; name: string; parent?: string | null }

export const ZONES: ZoneFixture[] = [
  { id: 'z-home', name: 'Home', parent: null },
  { id: 'z-living', name: 'Living room', parent: 'z-home' },
  { id: 'z-hall', name: 'Hall', parent: 'z-home' },
];

export interface CapabilityWrite { deviceId: string; capabilityId: string; value: unknown }

/**
 * Two ways `homey-api` behaves that the default client does NOT model, each
 * opt-in so every test written against the simple client keeps meaning what it
 * meant.
 */
export interface FakeApiOptions {
  /**
   * Platform §6: "Setting `dim` once produces two identical callbacks." Every
   * `makeCapabilityInstance` listener is called twice per write. The platform
   * does not promise the second one either, which is why this is not the
   * default: nothing may DEPEND on it, and code that only works with one echo
   * is what this is for.
   */
  duplicateEchoes?: boolean;
  /**
   * Platform §15: a `getAll` writes every item into the manager's cache, and a
   * single-item `get` then answers from that cache unless it passes
   * `$cache: false`. With this on, `getDevices()` and `getDevice()` read and
   * fill a per-device SNAPSHOT exactly that way — `$cache: false` skips the
   * read, `$updateCache: false` skips the write — so a reader that forgets the
   * flag sees the value as it was when something last cached it.
   */
  cache?: boolean;
}

/** The two `homey-api` flags a read can carry (platform §15). */
interface CacheFlags { $cache?: boolean; $updateCache?: boolean }

export interface FakeApiClient {
  devices: {
    getDevices(args?: CacheFlags): Promise<Record<string, unknown>>;
    getDevice(args: { id: string } & CacheFlags): Promise<any>;
    on(event: string, fn: () => void): void;
    off(event: string, fn: () => void): void;
  };
  zones: {
    getZones(): Promise<Record<string, unknown>>;
    on(event: string, fn: () => void): void;
    off(event: string, fn: () => void): void;
  };
  apps: { getApps(): Promise<Record<string, unknown>> };
  flow: Record<string, (...args: any[]) => Promise<unknown>>;
  /** Every capability write that reached a device, in order. */
  readonly writes: CapabilityWrite[];
  /** Make one device's writes reject — a lamp cut at the wall. */
  readonly refusing: Set<string>;
  /** Fire a device-manager event, as a device being added does. */
  emitDevices(event: string): void;
  /** Add or replace a device. */
  put(device: RawDeviceFixture): void;
  remove(id: string): void;
  /** The arguments of every `getDevice` call, in order — to assert what a reader asked for. */
  readonly deviceReads: Array<{ id: string } & CacheFlags>;
}

export function fakeApiClient(
  devices: RawDeviceFixture[] = [],
  zones: ZoneFixture[] = ZONES,
  options: FakeApiOptions = {},
): FakeApiClient {
  // Cloned, because every device here is LIVE and a write mutates it: a
  // fixture shared between two tests would otherwise carry the first test's
  // writes into the second.
  const table = new Map(devices.map(device => [device.id, structuredClone(device)]));
  const writes: CapabilityWrite[] = [];
  const refusing = new Set<string>();
  const deviceListeners = new Map<string, Set<() => void>>();
  const capabilityListeners = new Map<string, Set<(value: unknown) => void>>();

  const capabilitiesObj = (device: RawDeviceFixture) => Object.fromEntries(
    Object.entries(device.capabilities).map(([id, value]) => [id, {
      value,
      ...(id === 'dim' || id.startsWith('light_') && id !== 'light_mode' ? { min: 0, max: 1, decimals: 2 } : {}),
    }]),
  );

  const raw = (device: RawDeviceFixture) => ({
    id: device.id,
    name: device.name,
    class: device.class ?? 'light',
    zone: device.zone,
    driverId: device.driverId ?? 'homey:app:com.example:bulb',
    ownerUri: device.ownerUri ?? 'homey:app:com.example',
    data: device.data ?? { id: `data-${device.id}` },
    available: device.available !== false,
    capabilities: Object.keys(device.capabilities),
    capabilitiesObj: capabilitiesObj(device),
    ...(device.settings ? { settings: device.settings } : {}),
  });

  /**
   * `view` is what the handle SAYS — the device, or a cached snapshot of it —
   * and `device` is what its methods act on. A cached `getDevice` in
   * `homey-api` is the same: stale fields, a live write path.
   */
  const handle = (device: RawDeviceFixture, view: RawDeviceFixture = device) => ({
    ...raw(view),
    async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
      if (refusing.has(device.id)) throw new Error(`${device.name} did not answer`);
      writes.push({ deviceId: device.id, capabilityId, value });
      device.capabilities[capabilityId] = value;
      const listeners = [...capabilityListeners.get(`${device.id}:${capabilityId}`) ?? []];
      for (let echo = 0; echo < (options.duplicateEchoes ? 2 : 1); echo += 1) {
        for (const fn of listeners) fn(value);
      }
    },
    makeCapabilityInstance(capabilityId: string, fn: (value: unknown) => void) {
      const key = `${device.id}:${capabilityId}`;
      const set = capabilityListeners.get(key) ?? new Set();
      set.add(fn);
      capabilityListeners.set(key, set);
      return { destroy: () => { set.delete(fn); } };
    },
  });

  /** `options.cache` only: the snapshot a cached read answers with, per device id. */
  const cached = new Map<string, RawDeviceFixture>();
  const deviceReads: Array<{ id: string } & CacheFlags> = [];
  const readsCache = (flags: CacheFlags | undefined) => options.cache === true && flags?.$cache !== false;
  const fillsCache = (flags: CacheFlags | undefined) => options.cache === true && flags?.$updateCache !== false;

  return {
    writes,
    refusing,
    deviceReads,
    devices: {
      getDevices: async flags => {
        if (fillsCache(flags)) {
          for (const device of table.values()) cached.set(device.id, structuredClone(device));
        }
        return Object.fromEntries([...table.values()].map(device => [
          device.id,
          raw(readsCache(flags) ? cached.get(device.id) ?? device : device),
        ]));
      },
      getDevice: async args => {
        deviceReads.push({ ...args });
        const device = table.get(args.id);
        if (!device) throw Object.assign(new Error(`Device not found: ${args.id}`), { statusCode: 404 });
        const snapshot = readsCache(args) ? cached.get(args.id) : undefined;
        if (snapshot) return handle(device, snapshot);
        if (fillsCache(args)) cached.set(device.id, structuredClone(device));
        return handle(device);
      },
      on: (event, fn) => {
        const set = deviceListeners.get(event) ?? new Set();
        set.add(fn);
        deviceListeners.set(event, set);
      },
      off: (event, fn) => { deviceListeners.get(event)?.delete(fn); },
    },
    zones: {
      getZones: async () => Object.fromEntries(zones.map(zone => [zone.id, { ...zone, parent: zone.parent ?? null }])),
      on: () => undefined,
      off: () => undefined,
    },
    apps: { getApps: async () => ({ 'com.example': { id: 'com.example', name: 'Example Bulbs' } }) },
    flow: {
      getFlows: async () => ({}),
      getAdvancedFlows: async () => ({}),
      getFlowFolders: async () => ({}),
    },
    emitDevices: event => { for (const fn of deviceListeners.get(event) ?? []) fn(); },
    put: device => { table.set(device.id, structuredClone(device)); },
    remove: id => { table.delete(id); },
  };
}

/**
 * The slice of `HomeyApiService` a catalogue, an adapter and a driver's restore
 * path touch, over one fake client.
 *
 * Cast at the one place it is handed to real code, because the real class has
 * private fields a structural fake cannot have.
 */
export function fakeApiService(client: FakeApiClient): HomeyApiService {
  const tracked = new Set<() => unknown>();
  const service = {
    read: async () => client,
    reportReadFailure: () => false,
    track: (unsubscribe: () => unknown) => {
      tracked.add(unsubscribe);
      return async () => { tracked.delete(unsubscribe); await unsubscribe(); };
    },
    onReadReplacement: () => () => undefined,
    withWriteClient: async () => { throw new Error('no API key in this rig — a Flow write was attempted'); },
    destroy: async () => { for (const fn of tracked) await fn(); tracked.clear(); },
    credentials: { getStatus: () => ({ present: false, valid: false }) },
  };
  return service as unknown as HomeyApiService;
}

/** The real catalogue over a fake client. `ownAppId` excludes this app's devices. */
export function realCatalog(client: FakeApiClient, ownAppId: string | null = 'com.thomassidor.lightkeeper'): DeviceCatalog {
  return new DeviceCatalog(fakeApiService(client), ownAppId);
}
