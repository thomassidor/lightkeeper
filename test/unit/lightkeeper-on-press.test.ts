import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ownsNothing, zoneLights } from '../support/fake-catalog';
import { ControllerRuntimeManager } from '../../lib/runtime/controller-runtime-manager';
import { HealthMonitor } from '../../lib/runtime/health-monitor';
import { DEFAULT_BEHAVIOR, type LightkeeperPreset } from '../../lib/mapping/mapping-types';
import { LEAVE_ALONE, type SourceRegistry } from '../../lib/outputs/lightkeeper-settings';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { DeviceCatalog, CatalogDevice } from '../../lib/device-catalog';
import type { SourceDiscoveryService } from '../../lib/source-discovery-service';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { ControllerProfile } from '../../lib/profiles/controller-profile';

/**
 * A `lightkeeper_on` press, end to end, through a real runtime and a real queue.
 *
 * `lightkeeper-on.test.ts` proves what one press is MADE of. This proves what
 * actually reaches a lamp, and the three things it pins are all properties of
 * the path rather than of the arithmetic:
 *
 *  - **ONE submit, so `WRITE_ORDER` can order the whole pass.** The queue puts
 *    `light_mode` ahead of the hue it enables and `onoff` ahead of the level,
 *    and it can only order writes it is given at once. Three `runIntent` calls
 *    would reproduce, inside one button press, exactly the stepping that three
 *    built-in Flow cards produce and that `set_lights` exists to avoid.
 *  - **A chosen device that is not running degrades to plain "on".** Never
 *    nothing — a press that did nothing is indistinguishable from a broken
 *    remote — and never half, because the right brightness in last week's
 *    colour is the outcome nothing would report.
 *  - **Press again turns them off, by the same group rule the toggle job uses.**
 */

const SOURCE_ID = 'remote-1';
const LIGHT_ID = 'light-1';
const CURVE = 'lk-curve-1';
const DAYLIGHT = 'lk-daylight-1';

function device(id: string, capabilities: string[], on = true): CatalogDevice {
  return {
    id,
    name: id,
    class: 'light',
    virtualClass: null,
    zone: 'zone-1',
    zoneName: 'Kitchen',
    driverId: 'driver-1',
    ownerUri: 'homey:app:nl.philips.hue',
    ownerName: 'Philips Hue',
    available: true,
    capabilities,
    capabilitiesObj: Object.fromEntries(capabilities.map(c => [c, {
      value: c === 'onoff' ? on : c === 'light_mode' ? 'temperature' : 0.5,
      ...(c === 'dim' || c === 'light_temperature' || c === 'light_hue'
        ? { min: 0, max: 1, decimals: 2 } : {}),
    }])),
  };
}

const PRESET: LightkeeperPreset = {
  colourSource: CURVE, brightnessSource: DAYLIGHT, pressAgainOff: true,
};

function profile(preset: LightkeeperPreset): ControllerProfile {
  return {
    schemaVersion: 1,
    enabled: true,
    source: {
      deviceId: SOURCE_ID,
      driverId: 'driver-1',
      ownerAppId: 'homey:app:nl.philips.hue',
      eventSurfaceFingerprint: 'fp-1',
      name: 'Hall remote',
    },
    target: { kind: 'devices', deviceIds: [LIGHT_ID] },
    mappings: [{
      id: 'r1', function: 'lightkeeper_on', inputKey: 'btn|press', target: null, preset,
    }],
    behavior: { ...DEFAULT_BEHAVIOR },
    managedFlows: [],
    catalogue: [],
  };
}

/** A curve that is on a coloured stretch, and a room sensor calling for a level. */
function liveRegistry(): SourceRegistry {
  return {
    colour: id => (id === CURVE ? {
      publishedValues: () => ({ [VALUE_CAPABILITIES.temperature]: 0.86 }),
      currentValue: () => ({ color: { hue: 0.08, saturation: 0.55 } }),
    } : undefined),
    brightness: id => (id === DAYLIGHT ? {
      publishedValues: () => ({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
    } : undefined),
  };
}

/** Every registry empty — a curve deleted, or an app that has not started one. */
const EMPTY_REGISTRY: SourceRegistry = { colour: () => undefined, brightness: () => undefined };

function harness(options: { sources?: SourceRegistry; lampOn?: boolean } = {}) {
  const written: Array<{ capability: string; value: unknown }> = [];

  const devices = () => [
    device(SOURCE_ID, ['onoff']),
    device(LIGHT_ID, ['onoff', 'dim', 'light_temperature', 'light_hue', 'light_saturation',
      'light_mode'], options.lampOn ?? false),
  ];

  const catalog = {
    device: async (id: string) => devices().find(d => d.id === id),
    allDevices: async () => devices(),
    devicesInZone: async () => devices(),
    lightsInZone: zoneLights(async () => devices()),
    isOwnDevice: ownsNothing,
  } as unknown as DeviceCatalog;

  const discovery = {
    discover: async () => ({ inputs: [], fingerprint: 'fp-1', rejected: [] }),
  } as unknown as SourceDiscoveryService;

  const bridge = {
    reconcile: async (_deviceId: string, pass: () => Promise<unknown>) => pass(),
    sync: async () => ({
      references: [], created: 0, reused: 0, deleted: 0,
      userEdited: [], staleReplacements: [], unsupported: [],
    }),
  } as unknown as FlowBridgeManager;

  /**
   * `getDevice` answers with the device's own `capabilitiesObj`, and that is
   * load-bearing rather than thorough.
   *
   * `testFunction` re-reads live state before it plans, and `refresh()` hands
   * whatever comes back to `cache.initialise()` — which assigns all five fields
   * unconditionally. A stub returning only the two methods therefore BLANKS the
   * state `primeCache` had just seeded from the catalogue, so `currentOn` came
   * back undefined and "press again to turn off" could never fire in a test
   * while working perfectly on a Homey.
   */
  const api = {
    read: async () => ({
      devices: {
        getDevice: async ({ id }: { id: string }) => ({
          ...devices().find(candidate => candidate.id === id),
          makeCapabilityInstance: () => ({ destroy: () => { /* nothing to release */ } }),
          setCapabilityValue: async (
            { capabilityId, value }: { capabilityId: string; value: unknown },
          ) => {
            written.push({ capability: capabilityId, value });
          },
        }),
      },
    }),
    track: (fn: () => void) => fn,
    credentials: { getStatus: () => ({ present: true, valid: true }) },
  } as unknown as HomeyApiService;

  const logged: string[] = [];
  const health = new HealthMonitor(catalog, discovery, () => true);
  const manager = new ControllerRuntimeManager({
    api,
    catalog,
    discovery,
    bridge,
    health,
    ...(options.sources ? { sources: options.sources } : {}),
    log: (...args: unknown[]) => { logged.push(args.map(String).join(' ')); },
  });

  return {
    manager,
    written,
    logged,
    capabilities: () => written.map(entry => entry.capability),
    register: async (preset: LightkeeperPreset = PRESET) =>
      manager.register(LIGHT_ID, profile(preset), () => { /* state ignored */ }),
  };
}

describe('a composed press, through the real queue', () => {
  test('the switch, the colour and the level land as one ordered burst', async () => {
    const h = harness({ sources: liveRegistry() });
    const runtime = await h.register();

    await runtime.testFunction('lightkeeper_on');

    /**
     * `onoff` before `dim`, and `light_mode` before the hue it enables — which
     * is `WRITE_ORDER`'s doing rather than `intentsFor`'s, and it can only do
     * it because all three intents were planned into one submit. The proof is
     * the position of `light_mode`: it comes from the COLOUR intent, which
     * `intentsFor` puts second, and it has been sorted ahead of the `dim` that
     * came from the third.
     */
    assert.deepEqual(h.capabilities(), [
      'onoff', 'dim', 'light_mode', 'light_hue', 'light_saturation',
    ]);
    assert.deepEqual(h.written[0], { capability: 'onoff', value: true });
    assert.deepEqual(h.written[1], { capability: 'dim', value: 0.26 });
    assert.deepEqual(h.written[3], { capability: 'light_hue', value: 0.08 });

    await h.manager.destroyAll();
  });

  test('a warmth stretch sends a temperature, and never a colour beside it', async () => {
    const h = harness({
      sources: {
        colour: () => ({
          publishedValues: () => ({ [VALUE_CAPABILITIES.temperature]: 0.86 }),
          currentValue: () => null,
        }),
        brightness: () => ({
          publishedValues: () => ({ [VALUE_CAPABILITIES.brightness]: 0.26 }),
        }),
      },
    });
    const runtime = await h.register();

    await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.capabilities(), ['onoff', 'dim', 'light_mode', 'light_temperature']);
    assert.ok(!h.capabilities().includes('light_hue'),
      'a lamp told both ends up wherever its mode handling leaves it');

    await h.manager.destroyAll();
  });

  test('a source that is gone switches the lights on and says so', async () => {
    const h = harness({ sources: EMPTY_REGISTRY });
    const runtime = await h.register();

    const result = await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.capabilities(), ['onoff'],
      'plain "on" — never nothing, and never the half that survived');
    assert.equal(result.writes, 1);
    assert.ok(h.logged.some(line => line.includes(CURVE) && line.includes(DAYLIGHT)),
      'and both missing devices are named, or nothing explains a button that went plain');

    await h.manager.destroyAll();
  });

  test('with no registry at all it behaves as if the devices were gone', async () => {
    // Which is what an app that has not wired the registry looks like, and what
    // every test rig in this suite is. A defined behaviour, not a crash.
    const h = harness();
    const runtime = await h.register();

    await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.capabilities(), ['onoff']);
    await h.manager.destroyAll();
  });

  test('one source alone writes its half and leaves the other to the lamps', async () => {
    const h = harness({ sources: liveRegistry() });
    const runtime = await h.register({ ...PRESET, colourSource: LEAVE_ALONE });

    await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.capabilities(), ['onoff', 'dim'],
      '"leave it alone" is not a missing device, so the pass is not degraded');

    await h.manager.destroyAll();
  });
});

describe('pressing again', () => {
  test('a lamp that is on goes off, and nothing else is written', async () => {
    const h = harness({ sources: liveRegistry(), lampOn: true });
    const runtime = await h.register();

    await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.written, [{ capability: 'onoff', value: false }],
      'the second press is a power-off, not a power-off plus the values it would have set');

    await h.manager.destroyAll();
  });

  test('a lamp that is off comes on with the values, as the first press', async () => {
    const h = harness({ sources: liveRegistry(), lampOn: false });
    const runtime = await h.register();

    await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.written[0], { capability: 'onoff', value: true });

    await h.manager.destroyAll();
  });

  test('switched off, the button is a one-way "on" whatever the lamps are doing', async () => {
    const h = harness({ sources: liveRegistry(), lampOn: true });
    const runtime = await h.register({ ...PRESET, pressAgainOff: false });

    await runtime.testFunction('lightkeeper_on');

    assert.deepEqual(h.capabilities(), [
      'onoff', 'dim', 'light_mode', 'light_hue', 'light_saturation',
    ]);
    assert.deepEqual(h.written[0], { capability: 'onoff', value: true });

    await h.manager.destroyAll();
  });
});
