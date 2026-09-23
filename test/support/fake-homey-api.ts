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

export interface FakeApiClient {
  devices: {
    getDevices(): Promise<Record<string, unknown>>;
    getDevice(args: { id: string }): Promise<any>;
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
}

export function fakeApiClient(
  devices: RawDeviceFixture[] = [],
  zones: ZoneFixture[] = ZONES,
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

  const handle = (device: RawDeviceFixture) => ({
    ...raw(device),
    async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
      if (refusing.has(device.id)) throw new Error(`${device.name} did not answer`);
      writes.push({ deviceId: device.id, capabilityId, value });
      device.capabilities[capabilityId] = value;
      for (const fn of capabilityListeners.get(`${device.id}:${capabilityId}`) ?? []) fn(value);
    },
    makeCapabilityInstance(capabilityId: string, fn: (value: unknown) => void) {
      const key = `${device.id}:${capabilityId}`;
      const set = capabilityListeners.get(key) ?? new Set();
      set.add(fn);
      capabilityListeners.set(key, set);
      return { destroy: () => { set.delete(fn); } };
    },
  });

  return {
    writes,
    refusing,
    devices: {
      getDevices: async () => Object.fromEntries([...table.values()].map(device => [device.id, raw(device)])),
      getDevice: async ({ id }) => {
        const device = table.get(id);
        if (!device) throw Object.assign(new Error(`Device not found: ${id}`), { statusCode: 404 });
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
