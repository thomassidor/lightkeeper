import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CircadianRuntimeManager } from '../../lib/circadian/circadian-runtime-manager';
import { DaylightRuntimeManager } from '../../lib/daylight/daylight-runtime-manager';
import { ScheduleRuntimeManager } from '../../lib/schedules/schedule-runtime-manager';
import { LuminanceSource } from '../../lib/daylight/luminance-source';
import { DaylightEvaluator } from '../../lib/daylight/daylight-evaluator';
import { DEFAULT_RESPONSE } from '../../lib/daylight/daylight-types';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { SchedulePlan } from '../../lib/schedules/schedule-types';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import { startRuntime, cleanupResources } from '../../lib/runtime/runtime-resources';
import { FakeTimers } from '../support/fake-timers';
import { deferred, settle } from '../support/deferred';

/** Real runtimes, scheduler, adapter, evaluator and sensor ownership; only Homey is fake. */
function house() {
  const timers = new FakeTimers();
  const writes: Array<{ capabilityId: string; value: unknown }> = [];
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const lamp = { id: 'lamp', name: 'Lamp', zoneName: 'Room', available: true,
    capabilities: ['onoff', 'dim', 'light_temperature'],
    capabilitiesObj: { onoff: { value: true }, dim: { value: 0.5, min: 0, max: 1, decimals: 2 },
      light_temperature: { value: 0.5, min: 0, max: 1, decimals: 2 } } };
  const sensor = { id: 'sensor', name: 'Lux', available: true,
    capabilities: ['measure_luminance'], capabilitiesObj: { measure_luminance: { value: 500 } } };
  let present = true;
  let queries = 0;
  let failQuery = -1;
  let queryGate: Promise<void> | undefined;
  let handleGate: Promise<void> | undefined;
  let teardownGate: Promise<void> | undefined;
  const api = {
    credentials: { getStatus: () => ({ present: true, valid: true }) },
    read: async () => ({ devices: { getDevice: async ({ id }: { id: string }) => {
      if (handleGate) await handleGate;
      return { ...(id === 'lamp' ? lamp : sensor),
        setCapabilityValue: async (write: { capabilityId: string; value: unknown }) => { writes.push(write); },
        makeCapabilityInstance: (cap: string, listener: (value: unknown) => void) => {
          const key = `${id}:${cap}`;
          const set = listeners.get(key) ?? new Set();
          set.add(listener); listeners.set(key, set);
          return { destroy: async () => {
            if (id === 'lamp' && teardownGate) await teardownGate;
            set.delete(listener);
          } };
        } };
    } } }),
    track: (off: () => void) => off,
  } as unknown as HomeyApiService;
  const catalog = {
    device: async (id: string) => (id === 'sensor' ? sensor : present ? lamp : undefined),
    isOwnDevice: () => false,
    lightsInZone: async () => {
      queries += 1;
      if (queries === failQuery) throw new Error('catalogue unavailable');
      if (queryGate) await queryGate;
      return present ? [lamp] : [];
    },
  } as unknown as DeviceCatalog;
  const luminance = new LuminanceSource({ api, catalog, timers, log: () => {} });
  const daylight = new DaylightEvaluator({ location: () => null, luminance });
  const deps = { api, catalog, daylight, luminance, timezone: () => 'UTC',
    setInterval: timers.setInterval, clearInterval: timers.clearInterval, log: () => {} };
  const curves = new CircadianRuntimeManager(deps);
  const daylights = new DaylightRuntimeManager(deps);
  const bridge = {
    reconcile: async (_id: string, pass: () => Promise<void>) => pass(),
    sync: async () => ({ references: [], created: 0, deleted: 0, reused: 0,
      unsupported: [], userEdited: [], staleReplacements: [] }),
  } as unknown as FlowBridgeManager;
  const schedules = new ScheduleRuntimeManager({ ...deps, bridge });
  schedules.timeCard = async () => ({ card: null, candidates: [] });
  const target = { kind: 'zone' as const, zoneId: 'room', includeSubzones: false };
  const response = { ...DEFAULT_RESPONSE, sensors: ['sensor'] };
  const curve: CircadianPlan = { schemaVersion: 1, enabled: true, target,
    daylight: response, adjustBrightness: true, preStage: false,
    points: [0, 720].map(at => ({ id: String(at), anchor: { kind: 'clock', at },
      warmth: 0.5, brightness: 0.8, fromDaylight: true })) };
  const schedule: SchedulePlan = { schemaVersion: 1, enabled: true, target, daylight: response,
    managedFlows: [], entries: [{ id: 'window', onAt: 0, days: null,
      end: { kind: 'duration', minutes: 60 }, brightness: 0.8, fromDaylight: true }] };
  return { curves, daylights, schedules, curve, schedule, luminance, daylight, timers, writes,
    daylightPlan: { schemaVersion: 1, enabled: true, target, response },
    remove: () => { present = false; },
    failHealth: () => { failQuery = queries + 2; },
    holdQuery: (gate: Promise<void>) => { queryGate = gate; },
    holdHandle: (gate: Promise<void>) => { handleGate = gate; },
    holdTeardown: (gate: Promise<void>) => { teardownGate = gate; },
    reportOff: () => {
      lamp.capabilitiesObj.onoff.value = false;
      for (const fn of listeners.get('lamp:onoff') ?? []) fn(false);
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    async stop() {
      await curves.destroyAll(); await daylights.destroyAll(); await schedules.destroyAll();
      await luminance.destroy();
    } };
}

describe('runtime resource ownership across component boundaries', () => {
  test('saved curves and schedules keep sensors after pairing disconnect and restart', async () => {
    const h = house();
    try {
      await h.luminance.retain(['sensor'], 'pair');
      let curve = await h.curves.register('curve', h.curve, () => {});
      let schedule = await h.schedules.register('schedule', h.schedule, () => {});
      await h.luminance.release('pair');
      assert.equal(curve.currentValue()?.brightness, 0.25);
      await h.curves.unregister('curve');
      assert.equal(h.luminance.read(['sensor'])?.lux, 500, 'schedule has its own claim');
      await schedule.testEntry('window', 'on');
      assert.ok(h.writes.some(w => w.capabilityId === 'dim' && w.value === 0.05));
      await h.schedules.unregister('schedule');
      assert.equal(h.luminance.read(['sensor']), null);
      curve = await h.curves.register('curve', h.curve, () => {});
      schedule = await h.schedules.register('schedule', h.schedule, () => {});
      assert.equal(curve.currentValue()?.brightness, 0.25);
      assert.equal(schedule.currentPlan.daylight?.sensors[0], 'sensor');
    } finally { await h.stop(); }
  });

  test('simultaneous previews own independent claims', async () => {
    const h = house();
    const previews = await Promise.all([h.curves.ephemeral(h.curve), h.curves.ephemeral(h.curve),
      h.schedules.ephemeral(h.schedule), h.daylights.ephemeral(h.daylightPlan)]);
    try {
      assert.equal(new Set(previews.map(p => p.controllerId)).size, 4);
      for (const preview of previews.slice(0, -1)) await preview.stop();
      assert.equal(h.luminance.read(['sensor'])?.lux, 500);
    } finally {
      for (const preview of previews) await preview.stop();
      await h.stop();
    }
    assert.equal(h.listenerCount(), 0);
  });

  for (const kind of ['curve', 'daylight'] as const) {
    test(`${kind} revokes target membership before asynchronous teardown`, async () => {
      const h = house(); const gate = deferred();
      try {
        const runtime = kind === 'curve'
          ? await h.curves.register('runtime', h.curve, () => {})
          : await h.daylights.register('runtime', h.daylightPlan, () => {});
        await runtime.drain(); await settle(12);
        h.remove(); h.holdTeardown(gate.promise);
        const refreshing = runtime.refreshTargets(); await settle(12);
        const before = h.writes.length;
        await runtime.applyNow('preview', { force: true });
        await runtime.drain(); await settle(12);
        assert.equal(h.writes.length, before);
        gate.resolve(); await refreshing;
      } finally { gate.resolve(); await h.stop(); }
    });

    test(`${kind} failed startup releases listeners and sensor claims`, async () => {
      const h = house(); h.failHealth();
      try {
        const starting = kind === 'curve'
          ? h.curves.register('failed', h.curve, () => {})
          : h.daylights.register('failed', h.daylightPlan, () => {});
        await assert.rejects(starting, /catalogue unavailable/);
        assert.equal(h.listenerCount(), 0);
        assert.equal(h.luminance.watched().length, 0);
        assert.equal(h.curves.all().length + h.daylights.all().length, 0);
        assert.equal(h.timers.pending, 0);
      } finally { await h.stop(); }
    });

    for (const change of ['off', 'removed'] as const) {
      test(`${kind} cancels queued writes when a target is ${change}`, async () => {
        const h = house();
        try {
          const runtime = kind === 'curve'
            ? await h.curves.register('runtime', h.curve, () => {})
            : await h.daylights.register('runtime', h.daylightPlan, () => {});
          await runtime.drain(); await settle(12);
          await runtime.applyNow('preview', { force: true });
          if (change === 'off') h.reportOff();
          else { h.remove(); await runtime.refreshTargets(); }
          const before = h.writes.length;
          await runtime.drain(); await settle(12);
          assert.equal(h.writes.length, before);
        } finally { await h.stop(); }
      });
    }

    test(`${kind} target refresh cannot restore resources after stop`, async () => {
      const h = house();
      try {
        const runtime = kind === 'curve'
          ? await h.curves.register('runtime', h.curve, () => {})
          : await h.daylights.register('runtime', h.daylightPlan, () => {});
        await runtime.drain();
        const gate = deferred(); h.holdQuery(gate.promise);
        const refreshing = runtime.refreshTargets(); await settle(12);
        const stopping = runtime.stop(); gate.resolve();
        await Promise.all([refreshing, stopping]);
        const before = h.writes.length;
        await runtime.tick(); await settle(12);
        assert.equal(h.writes.length, before);
        assert.equal(h.listenerCount(), 0);
        assert.equal(h.luminance.watched().length, 0);
      } finally { await h.stop(); }
    });
  }

  test('a power-off during asynchronous handle acquisition prevents dispatch', async () => {
    const h = house();
    const runtime = await h.daylights.ephemeral(h.daylightPlan);
    try {
      const gate = deferred(); h.holdHandle(gate.promise);
      await runtime.applyNow('preview', { force: true }); await settle(12);
      h.reportOff(); gate.resolve(); await runtime.drain();
      assert.equal(h.writes.length, 0);
      assert.equal(runtime.diagnostics().recentFailures.length, 0);
    } finally { await runtime.stop(); await h.stop(); }
  });

  test('cleanup continues after failures and preserves the startup error', async () => {
    const error = new Error('start failed');
    const cleaned: string[] = [];
    await assert.rejects(startRuntime({ stop: async () => {
      await cleanupResources([
        () => { cleaned.push('first'); throw new Error('cleanup failed'); },
        () => { cleaned.push('second'); },
      ], () => {});
    } }, async () => { throw error; }, () => {}), e => e === error);
    assert.deepEqual(cleaned, ['first', 'second']);
  });
});
