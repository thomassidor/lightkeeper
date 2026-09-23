import { CircadianRuntimeManager } from '../../lib/circadian/circadian-runtime-manager';
import { ControllerRuntimeManager } from '../../lib/runtime/controller-runtime-manager';
import type { PublishedValues } from '../../lib/runtime/published-values';
import type { WatchedSensor } from '../../lib/daylight/luminance-source';
import type { SensorWeek } from '../../lib/daylight/sensor-history';
import type { DeviceCatalog } from '../../lib/device-catalog';
import { fakeApiService, realCatalog, type FakeApiClient } from './fake-homey-api';

/**
 * `this.homey.app` as a DRIVER sees it: the `LightkeeperApp` contract, with the
 * real catalogue and — where a handler's promise is about real lamps — the real
 * runtime managers, over one fake `homey-api` client.
 *
 * Real where the handler under test makes a promise about what the lights do:
 * the curve preview and restore, and the controller's Test control. Recorded
 * stubs everywhere else, because a pairing handler's job there is to pass the
 * right plan to the right registry, and asserting on that is the test.
 */

/** A live Lightkeeper runtime as a source picker or a hero card reads it. */
export interface StubSource {
  controllerId: string;
  deviceName: string;
  currentPlan: { target: { kind: 'devices'; deviceIds: string[] }; writesLights?: boolean };
  publishedValues(): PublishedValues;
  currentValue(): { warmth?: number; color?: { hue: number; saturation: number } } | null;
}

export function stubSource(
  controllerId: string,
  deviceName: string,
  options: { lights?: string[]; values?: PublishedValues; writesLights?: boolean } = {},
): StubSource {
  return {
    controllerId,
    deviceName,
    currentPlan: {
      target: { kind: 'devices', deviceIds: options.lights ?? [] },
      ...(options.writesLights === false ? { writesLights: false } : {}),
    },
    publishedValues: () => options.values ?? {},
    currentValue: () => ({ warmth: 0.6 }),
  };
}

/** What every stubbed collaborator was asked to do, in order. */
export interface AppRecord {
  ephemeral: Array<{ kind: 'curve' | 'daylight' | 'schedule'; plan: any }>;
  applied: Array<{ kind: string; reason: string; options: unknown }>;
  stopped: string[];
  retained: Array<{ ids: string[]; owner: string }>;
  released: string[];
  credentials: string[];
  entries: Array<{ entryId: string; boundary: string }>;
  discovered: string[];
}

export interface DriverAppOptions {
  curves?: StubSource[];
  daylights?: StubSource[];
  schedules?: StubSource[];
  sensors?: WatchedSensor[];
  week?: SensorWeek | null;
  sky?: Record<string, unknown>;
  /** What `discovery.discover` answers, per device id. */
  surfaces?: Record<string, { inputs: unknown[]; fingerprint: string; fingerprintV2?: string; rejected?: unknown[] }>;
  reattach?: { deviceId: string; deviceName: string } | undefined;
  credentialValid?: boolean;
}

/**
 * The app, for a driver test.
 *
 * `curves.ephemeral` is the REAL `CircadianRuntimeManager`'s, and so is
 * `controllers.ephemeral`: both are the Test control and the try-it screen, and
 * "the Test control works before save, and without Flows" is a promise about
 * the real runtime. Their bridge refuses every call, so a Test that reached for
 * a Flow fails loudly instead of passing.
 */
export function driverApp(client: FakeApiClient, options: DriverAppOptions = {}) {
  const record: AppRecord = {
    ephemeral: [], applied: [], stopped: [], retained: [], released: [], credentials: [], entries: [],
    discovered: [],
  };
  const api = fakeApiService(client);
  const catalog: DeviceCatalog = realCatalog(client);
  const log = () => undefined;

  const bridge = {
    reconcile: async () => { throw new Error('the Test control reached for a Flow'); },
    sync: async () => { throw new Error('the Test control reached for a Flow'); },
    removeAll: async () => { throw new Error('the Test control reached for a Flow'); },
  };
  const discovery = {
    discover: async (device: { id: string }) => {
      record.discovered.push(device.id);
      return options.surfaces?.[device.id] ?? { inputs: [], fingerprint: '', rejected: [] };
    },
    rankSources: async (devices: Array<{ id: string; name: string }>) =>
      devices.map(device => ({ device, eventCount: options.surfaces?.[device.id]?.inputs.length ?? 0 })),
  };

  const realCurves = new CircadianRuntimeManager({
    api, catalog, timezone: () => 'Europe/Copenhagen', log,
    setInterval: () => 0, clearInterval: () => undefined,
  });
  const realControllers = new ControllerRuntimeManager({
    api, catalog, discovery: discovery as never, bridge: bridge as never, log,
  });

  const stubRuntime = (kind: 'daylight' | 'schedule', plan: unknown) => {
    record.ephemeral.push({ kind, plan });
    return {
      applyNow: async (reason: string, opts: unknown) => {
        record.applied.push({ kind, reason, options: opts });
        return { writes: 2, skipped: 0 };
      },
      drain: async () => undefined,
      stop: async () => { record.stopped.push(kind); },
      testEntry: async (entryId: string, boundary: string) => {
        record.entries.push({ entryId, boundary });
        return { writes: 1, skipped: 0 };
      },
    };
  };

  const registry = (runtimes: StubSource[]) => ({
    all: () => runtimes,
    get: (id: string) => runtimes.find(runtime => runtime.controllerId === id),
  });

  const app = {
    api,
    catalog,
    bridge,
    discovery,
    health: {
      findReattachCandidate: async () => options.reattach,
    },
    credentials: {
      getStatus: () => ({ present: options.credentialValid ?? false, valid: options.credentialValid ?? false }),
      setCredential: async (token: string) => {
        record.credentials.push(token);
        return { present: true, valid: token === 'good-key' };
      },
    },
    curves: {
      ...registry(options.curves ?? []),
      ephemeral: async (plan: any) => {
        record.ephemeral.push({ kind: 'curve', plan });
        return realCurves.ephemeral(plan);
      },
    },
    controllers: {
      all: () => [],
      get: () => undefined,
      ephemeral: (profile: any) => realControllers.ephemeral(profile),
    },
    daylights: {
      ...registry(options.daylights ?? []),
      ephemeral: async (plan: unknown) => stubRuntime('daylight', plan),
    },
    schedules: {
      ...registry(options.schedules ?? []),
      ephemeral: async (plan: unknown) => stubRuntime('schedule', plan),
    },
    daylight: {
      sensors: () => options.sensors ?? [],
      sky: () => options.sky ?? { elevation: 20, level: 0.8, location: { latitude: 55.68, longitude: 12.57 } },
      evaluate: () => ({ brightness: 0.42, source: 'sensor', elevation: 20 }),
    },
    luminance: {
      retain: async (ids: string[], owner: string) => { record.retained.push({ ids: [...ids], owner }); },
      release: async (owner: string) => { record.released.push(owner); },
      week: async () => options.week ?? null,
    },
  };

  return { app, record, api, catalog };
}
