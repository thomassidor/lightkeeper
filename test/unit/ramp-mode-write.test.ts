import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ownsNothing, zoneLights } from '../support/fake-catalog';
import { ControllerRuntimeManager } from '../../lib/runtime/controller-runtime-manager';
import { HealthMonitor } from '../../lib/runtime/health-monitor';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { RampEngine } from '../../lib/outputs/ramp-engine';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { DeviceCatalog, CatalogDevice } from '../../lib/device-catalog';
import type { SourceDiscoveryService } from '../../lib/source-discovery-service';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { ControllerProfile } from '../../lib/profiles/controller-profile';

/**
 * The mode write is established once per HOLD, not once per tick.
 *
 * `planTemperature()` emits `light_mode` ahead of every temperature because a
 * lamp that gates discards a value written in the wrong mode (platform §6), and
 * the controller applies no deadband — so a ten-second warmer/colder hold
 * re-planned the mode write on every one of its ~50 flushes. `runFlush` awaits
 * its writes in order, and a `light_mode` ack costs 212 ms against a value
 * write's 278 ms (measured across sixteen lamps, 4 September 2026), so the
 * redundant write sat in front of every step and roughly halved the hold's
 * rate.
 *
 * What must NOT be built instead, and why these tests pin the narrow version: a
 * remembered per-lamp mode. §6 measured that a lamp may accept
 * `light_mode: 'temperature'` and go on reporting `'color'`, and the app
 * subscribes to `light_mode` nowhere — so a memory could never be checked, and
 * a person switching a lamp to colour in the vendor app would be invisible to
 * it. Every later temperature would then be silently discarded on a gating
 * lamp, which is the bug §6 exists to record.
 */

const SOURCE_ID = 'remote-1';
const LIGHT_ID = 'light-1';

function device(id: string, capabilities: string[]): CatalogDevice {
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
      value: c === 'onoff' ? true : c === 'light_mode' ? 'color' : 0.5,
      ...(c === 'dim' || c === 'light_temperature' ? { min: 0, max: 1, decimals: 2 } : {}),
    }])),
  };
}

function profile(): ControllerProfile {
  return {
    schemaVersion: 1,
    enabled: true,
    source: {
      deviceId: SOURCE_ID,
      driverId: 'driver-1',
      ownerAppId: 'homey:app:nl.philips.hue',
      eventSurfaceFingerprint: 'fp-1',
      name: 'Bedroom dial',
    },
    target: { kind: 'devices', deviceIds: [LIGHT_ID] },
    // No mappings and no flows: these tests drive runIntent directly, which is
    // the same path a ramp tick takes.
    mappings: [],
    behavior: { ...DEFAULT_BEHAVIOR },
    managedFlows: [],
    catalogue: [],
  };
}

function harness() {
  const written: Array<{ capability: string; value: unknown }> = [];

  const devices = () => [
    device(SOURCE_ID, ['onoff']),
    device(LIGHT_ID, ['onoff', 'dim', 'light_temperature', 'light_mode']),
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

  const api = {
    read: async () => ({
      devices: {
        getDevice: async () => ({
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

  const health = new HealthMonitor(catalog, discovery, () => true);
  const manager = new ControllerRuntimeManager({
    api, catalog, discovery, bridge, health, log: () => { /* quiet */ },
  });

  return {
    manager,
    written,
    capabilities: () => written.map(w => w.capability),
    register: async () => manager.register(LIGHT_ID, profile(), () => { /* state ignored */ }),
  };
}

describe('the mode write inside a ramp', () => {
  test('an ordinary temperature intent writes light_mode ahead of the value', async () => {
    const h = harness();
    const runtime = await h.register();

    await runtime.runIntentNow({ type: 'temperature_delta', delta: 0.1 });

    assert.deepEqual(h.capabilities(), ['light_mode', 'light_temperature'],
      'the mode has to land first, or a gating lamp discards the value');
    await h.manager.destroyAll();
  });

  test('modeAlreadySet drops the mode write and keeps the value', async () => {
    const h = harness();
    const runtime = await h.register();

    const result = await runtime.runIntentNow(
      { type: 'temperature_delta', delta: 0.1 }, undefined, { modeAlreadySet: true },
    );

    assert.deepEqual(h.capabilities(), ['light_temperature'],
      'the mode was established by the tick that opened the hold');
    assert.equal(result.writes, 1, 'the reported count is what was submitted, not what was planned');
    await h.manager.destroyAll();
  });

  test('a brightness intent is unaffected — it plans no mode write at all', async () => {
    const h = harness();
    const runtime = await h.register();

    await runtime.runIntentNow({ type: 'brightness_delta', delta: 0.1 }, undefined,
      { modeAlreadySet: true });

    assert.deepEqual(h.capabilities(), ['dim']);
    await h.manager.destroyAll();
  });
});

describe('what the ramp engine tells its consumer', () => {
  class FakeClock {
    private seq = 0;
    private intervals = new Map<number, { fn: () => void; every: number; next: number }>();
    now = 0;

    setInterval = (fn: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.intervals.set(id, { fn, every: ms, next: this.now + ms });
      return id;
    };

    clearInterval = (handle: unknown): void => { this.intervals.delete(handle as number); };
    nowFn = (): number => this.now;

    advance(ms: number): void {
      const target = this.now + ms;
      for (;;) {
        const due = [...this.intervals.entries()]
          .filter(([, t]) => t.next <= target)
          .sort((a, b) => a[1].next - b[1].next)[0];
        if (!due) break;
        const timer = due[1];
        this.now = timer.next;
        timer.next += timer.every;
        timer.fn();
      }
      this.now = target;
    }
  }

  test('every tick carries the ramp, counting from 1, and a re-hold starts over', () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    const engine = new RampEngine(
      (_intent, ramp) => seen.push(ramp.ticks),
      () => { /* stops ignored */ },
      { setInterval: clock.setInterval, clearInterval: clock.clearInterval, now: clock.nowFn },
    );

    engine.start('warm', 'temperature', -1);
    clock.advance(300);
    assert.deepEqual(seen, [1, 2, 3], 'the first tick of a hold must be distinguishable');

    // A fresh hold re-establishes the mode, so a lamp somebody switched to
    // colour between two holds is corrected by the next one.
    engine.start('warm', 'temperature', -1);
    clock.advance(200);
    assert.deepEqual(seen, [1, 2, 3, 1, 2]);

    engine.stop('warm', 'released');
  });
});
