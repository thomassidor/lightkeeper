import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CircadianRuntimeManager } from '../../lib/circadian/circadian-runtime-manager';
import { DaylightRuntimeManager } from '../../lib/daylight/daylight-runtime-manager';
import { ScheduleRuntimeManager } from '../../lib/schedules/schedule-runtime-manager';
import { ControllerRuntimeManager } from '../../lib/runtime/controller-runtime-manager';
import { eventKeyFor } from '../../lib/schedules/schedule-bindings';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { LuminanceSource } from '../../lib/daylight/luminance-source';
import { DaylightEvaluator } from '../../lib/daylight/daylight-evaluator';
import { DEFAULT_RESPONSE } from '../../lib/daylight/daylight-types';
import type { CircadianPlan } from '../../lib/circadian/circadian-types';
import type { SchedulePlan } from '../../lib/schedules/schedule-types';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { SourceDiscoveryService } from '../../lib/source-discovery-service';
import type { ControllerProfile } from '../../lib/profiles/controller-profile';
import type { SelectableInput } from '../../lib/inputs/selectable-input';
import type { InputAction } from '../../lib/inputs/input-event';
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
  let failReconcile = false;
  let failSensor = false;
  let lampReads = 0;
  // homey-api's client-replacement hook. Every LightTargetAdapter registers on
  // it when it resumes and only `unsubscribeAll()` lets go, so it is the one
  // resource a SCHEDULE holds that a capability listener count cannot see:
  // a schedule subscribes to no lamp.
  const replacements = new Set<() => void>();
  const api = {
    credentials: { getStatus: () => ({ present: true, valid: true }) },
    onReadReplacement: (listener: () => void) => {
      replacements.add(listener);
      return () => { replacements.delete(listener); };
    },
    read: async () => ({ devices: { getDevice: async ({ id, $cache }: { id: string; $cache?: boolean }) => {
      if (handleGate) await handleGate;
      if (id === 'sensor' && failSensor) throw new Error('sensor unreachable');
      // LIVE reads only. A write's device handle is a `getDevice` too, but one
      // homey-api answers from its cache on a Homey, and it is fetched once.
      if (id === 'lamp' && $cache === false) lampReads += 1;
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
  // `timers` as well as the two interval members: since fe1ee0c every manager
  // forwards it to the runtimes it builds, so their write queues, adapters,
  // gates and ramps all run on this clock and a teardown can be checked for
  // anything it left armed.
  const deps = { api, catalog, daylight, luminance, timezone: () => 'UTC', timers,
    setInterval: timers.setInterval, clearInterval: timers.clearInterval, log: () => {} };
  const curves = new CircadianRuntimeManager(deps);
  const daylights = new DaylightRuntimeManager(deps);
  const bridge = {
    reconcile: async (_id: string, pass: () => Promise<void>) => {
      if (failReconcile) throw new Error('bridge unavailable');
      return pass();
    },
    sync: async () => ({ references: [], created: 0, deleted: 0, reused: 0,
      unsupported: [], userEdited: [], staleReplacements: [] }),
    removeAll: async () => {},
  } as unknown as FlowBridgeManager;
  const schedules = new ScheduleRuntimeManager({ ...deps, bridge });
  schedules.timeCard = async () => ({ card: null, candidates: [] });
  const discovery = {
    discover: async () => ({ inputs: [], fingerprint: 'fp', rejected: [] }),
  } as unknown as SourceDiscoveryService;
  const controllers = new ControllerRuntimeManager({ api, catalog, discovery, bridge, timers, log: () => {} });
  const target = { kind: 'zone' as const, zoneId: 'room', includeSubzones: false };
  const response = { ...DEFAULT_RESPONSE, sensor: 'sensor' };
  const curve: CircadianPlan = { schemaVersion: 2, enabled: true, target,
    adjustBrightness: true, transition: 'balanced', preStage: false,
    points: [0, 720].map(at => ({ id: String(at), anchor: { kind: 'clock', at },
      warmth: 0.5, brightness: 0.8 })) };
  const schedule: SchedulePlan = { schemaVersion: 1, enabled: true, target, days: null,
    managedFlows: [], entries: [{ id: 'window', onAt: 0,
      end: { kind: 'duration', minutes: 60 }, brightness: 0.8 }] };
  // A remote with every timer a controller can arm: `up` ramps (a hold with a
  // release beside it), and `btn` is CONTESTED (a press and a hold on one
  // control), so its press waits in the supersede gate.
  const input = (key: string, controlId: string, action: InputAction): SelectableInput => ({
    key, controlId, label: key, action, carriesMagnitude: false,
    binding: { kind: 'flow_fixed', cardId: key, cardOwnerUri: 'homey:app:test', fixedArgs: {} },
  });
  const profile: ControllerProfile = { schemaVersion: 1, enabled: true,
    source: { deviceId: 'remote', driverId: 'driver', ownerAppId: 'homey:app:test',
      eventSurfaceFingerprint: 'fp', name: 'Remote' },
    target, behavior: { ...DEFAULT_BEHAVIOR }, managedFlows: [],
    catalogue: [input('up-hold', 'up', 'long_press'), input('up-release', 'up', 'release'),
      input('btn-press', 'btn', 'press'), input('btn-hold', 'btn', 'long_press')],
    mappings: [
      { id: 'ramp', function: 'brightness_up', inputKey: 'up-hold', target: null },
      { id: 'press', function: 'toggle', inputKey: 'btn-press', target: null },
      { id: 'hold', function: 'brightness_down', inputKey: 'btn-hold', target: null },
    ] };
  return { curves, daylights, schedules, controllers, curve, schedule, profile, luminance, daylight,
    timers, writes,
    daylightPlan: { schemaVersion: 1, enabled: true, target, response },
    remove: () => { present = false; },
    failHealth: () => { failQuery = queries + 2; },
    failReconcile: () => { failReconcile = true; },
    /** The lux sensor refuses to be subscribed to, so the sensor service arms a retry. */
    failSensor: () => { failSensor = true; },
    /** How many times anything has read the lamp LIVE (`$cache: false`). */
    lampReads: () => lampReads,
    replacementCount: () => replacements.size,
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
      await controllers.destroyAll();
      await luminance.destroy();
    } };
}

type House = ReturnType<typeof house>;
type Kind = 'controller' | 'schedule' | 'curve' | 'daylight';

/**
 * One registered runtime of any kind, and the one thing every kind can be asked
 * to do: queue a burst of writes to the lamp now. The four have no common write
 * entry point — a remote runs an intent, a schedule fires a boundary, the two
 * engines apply — so the rig names each one rather than pretending they share.
 */
async function registered(h: House, kind: Kind, id = 'runtime'): Promise<{
  stop: () => Promise<void>;
  refreshTargets: () => Promise<void>;
  write: () => Promise<void>;
}> {
  switch (kind) {
    case 'controller': {
      const runtime = await h.controllers.register(id, h.profile, () => {});
      return { stop: () => runtime.stop(), refreshTargets: () => runtime.refreshTargets(),
        write: async () => { await runtime.runIntent({ type: 'brightness_delta', delta: 0.1 }); } };
    }
    case 'schedule': {
      // 00:00 UTC on the fake clock is exactly this window's on boundary.
      const runtime = await h.schedules.register(id, h.schedule, () => {});
      return { stop: () => runtime.stop(), refreshTargets: () => runtime.refreshTargets(),
        write: async () => { runtime.handleEvent(eventKeyFor('window', 'on')); await settle(4); } };
    }
    case 'curve': {
      const runtime = await h.curves.register(id, h.curve, () => {});
      return { stop: () => runtime.stop(), refreshTargets: () => runtime.refreshTargets(),
        write: async () => { await runtime.applyNow('preview', { force: true }); } };
    }
    case 'daylight': {
      const runtime = await h.daylights.register(id, h.daylightPlan, () => {});
      return { stop: () => runtime.stop(), refreshTargets: () => runtime.refreshTargets(),
        write: async () => { await runtime.applyNow('preview', { force: true }); } };
    }
  }
}

function managerOf(h: House, kind: Kind): { unregister(id: string): Promise<void>; all(): unknown[] } {
  return { controller: h.controllers, schedule: h.schedules, curve: h.curves, daylight: h.daylights }[kind];
}

describe('runtime resource ownership across component boundaries', () => {
  test('a saved Room-sensing Light keeps its sensor after a pairing disconnect and a restart', async () => {
    // The claim is ref-counted and TOTAL per owner, so the question this asks is
    // whether a live device's claim survives the pairing session that made it
    // letting go. It has to: releasing a session's claim must never take a saved
    // device's subscription with it.
    //
    // Only a Room-sensing Light holds one now. A circadian light and a schedule used
    // to, through the `fromDaylight` flag on a point or a window — the pairing
    // rewrite removed that, so neither touches the sensor service at all, and
    // that absence is asserted here rather than assumed.
    const h = house();
    try {
      await h.luminance.retain(['sensor'], 'pair');
      let daylight = await h.daylights.register('daylight', h.daylightPlan, () => {});
      await h.luminance.release('pair');
      assert.equal(h.luminance.read('sensor')?.lux, 500, 'the device has its own claim');

      // Neither of the other two asks for anything, so unregistering them cannot
      // disturb it.
      const curve = await h.curves.register('curve', h.curve, () => {});
      const schedule = await h.schedules.register('schedule', h.schedule, () => {});
      await h.curves.unregister('curve');
      await h.schedules.unregister('schedule');
      assert.equal(h.luminance.read('sensor')?.lux, 500);
      assert.ok(curve && schedule);

      await h.daylights.unregister('daylight');
      assert.equal(h.luminance.read('sensor'), null, 'the last claim releases it');

      daylight = await h.daylights.register('daylight', h.daylightPlan, () => {});
      assert.equal(h.luminance.read('sensor')?.lux, 500, 'and registering takes it again');
      assert.equal(daylight.currentPlan.response.sensor, 'sensor');
    } finally { await h.stop(); }
  });

  test('simultaneous previews own independent claims', async () => {
    const h = house();
    const previews = await Promise.all([h.curves.ephemeral(h.curve), h.curves.ephemeral(h.curve),
      h.schedules.ephemeral(h.schedule), h.daylights.ephemeral(h.daylightPlan)]);
    try {
      assert.equal(new Set(previews.map(p => p.controllerId)).size, 4);
      for (const preview of previews.slice(0, -1)) await preview.stop();
      assert.equal(h.luminance.read('sensor')?.lux, 500);
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

/**
 * "Nothing survives teardown", for all four lamp-writing runtimes.
 *
 * The two above loop over the curve and the Room-sensing Light only, and that is
 * how a controller's `stop()` could be hollowed out entirely with the suite
 * green: nothing ever stopped a controller holding a ramp, a gated press and a
 * held write, and then looked at what was left. A schedule fared little better —
 * only an empty body was caught. Every write queue now runs on the house's fake
 * clock (fe1ee0c), so "left armed" is a number this can read.
 */
describe('teardown leaves nothing armed, for every kind of runtime', () => {
  const kinds: Kind[] = ['controller', 'schedule', 'curve', 'daylight'];

  for (const kind of kinds) {
    /**
     * The behavioural half of fe1ee0c. A second burst to one lamp inside the
     * 200 ms rate window is HELD, and it is the injected clock that lets it go.
     * On a queue built without the runtime's timers the hold is a REAL 200 ms,
     * so the write is still held after the fake advance below — which is what
     * made every rate-limited write invisible to these tests, and every
     * teardown assertion about armed timers unprovable.
     */
    test(`${kind}: a second write inside the rate window is held until the fake clock advances`, async () => {
      const h = house();
      try {
        const runtime = await registered(h, kind);
        await settle(12); h.timers.advance(1000); await settle(12);
        const before = h.writes.length;
        await runtime.write(); await settle(12);
        const first = h.writes.length;
        assert.ok(first > before, 'the first burst goes out on the leading edge');

        await runtime.write(); await settle(12);
        assert.equal(h.writes.length, first, 'the second is held for the rate window');

        h.timers.advance(200); await settle(12);
        assert.ok(h.writes.length > first, 'and released by the runtime\'s own clock');
      } finally { await h.stop(); }
    });

    /**
     * The whole of what a running runtime can hold, released by one stop: a
     * held write on the rate window, the capability listeners, the adapter's
     * replacement hook — and, on a controller, a ramp's interval and a press
     * waiting in the supersede gate. `pending > 0` first, or the zero after
     * proves nothing. Each of `ramps.stopAll()`, `gate.cancelAll()`,
     * `scheduler.stop()` and `adapter.unsubscribeAll()` leaves one of these
     * behind on its own.
     */
    test(`${kind}: stop() leaves no timer, no listener and no late write`, async () => {
      const h = house();
      const hooks = h.replacementCount();
      try {
        const runtime = await registered(h, kind);
        await settle(12); h.timers.advance(1000); await settle(12);
        if (kind === 'controller') {
          // Uncontested hold on a rampable control: a ramp, ticking every 100 ms.
          const controller = h.controllers.get('runtime');
          controller?.handleInput({ controlId: 'up', action: 'long_press' }, 'up-hold');
          await settle(4);
          // A press on the contested control waits 250 ms in the gate.
          controller?.handleInput({ controlId: 'btn', action: 'press' }, 'btn-press');
        }
        await runtime.write(); await settle(12);
        await runtime.write(); await settle(12);
        const before = h.writes.length;
        assert.ok(h.timers.pending >= (kind === 'controller' ? 3 : 1),
          'a held write (and on a controller, a ramp and a gated press) are armed');
        assert.ok(kind === 'schedule' || h.listenerCount() > 0, 'and the lamp is watched');

        await managerOf(h, kind).unregister('runtime');

        assert.equal(h.listenerCount(), 0);
        assert.equal(h.timers.pending, 0);
        assert.equal(h.replacementCount(), hooks, 'the adapter let go of its replacement hook');
        h.timers.advance(10_000); await settle(12);
        assert.equal(h.writes.length, before, 'nothing lands after teardown');
      } finally { await h.stop(); }
    });
  }

  /**
   * PERF-9. The test above awaits `unregister()`, so it cannot tell a timer
   * disarmed by `stop()`'s synchronous prefix from one disarmed by its cleanup,
   * which runs behind the lifetime lock. Platform §17: during app shutdown that
   * cleanup may never run. So these hold the cleanup open (the lamp's listener
   * will not finish tearing down) and look at the clock BEFORE awaiting
   * anything. Each kind arms what it can: held writes everywhere, a ramp and a
   * gated press on a controller, the 5 s pre-stage probe on a curve, a sensor
   * retry on a Room-sensing Light.
   */
  for (const kind of kinds) {
    test(`${kind}: every timer is disarmed before stop() first awaits`, async () => {
      const h = house();
      if (kind === 'daylight') h.failSensor();
      const persisted: unknown[] = [];
      const release = deferred<void>();
      // The curve and daylight managers' shared ticker belongs to the MANAGER,
      // and this stops the runtime alone; it is the one timer allowed to stay.
      const ticker = kind === 'curve' || kind === 'daylight' ? 1 : 0;
      try {
        let runtime: { stop: () => Promise<void>; write: () => Promise<void> };
        if (kind === 'curve') {
          // Pre-staging on, this lamp proven, a warmth the lamp is not at: an
          // OFF lamp is sent a colour, and the probe that watches it is armed.
          const plan: CircadianPlan = { ...h.curve, preStage: true, preStageLights: ['lamp'],
            points: h.curve.points.map(point => ({ ...point, warmth: 0.2 })) };
          const curve = await h.curves.register('runtime', plan, () => {}, async next => { persisted.push(next); });
          runtime = { stop: () => curve.stop(), write: async () => { await curve.applyNow('tick', { force: true }); } };
        } else {
          runtime = await registered(h, kind);
        }
        await settle(12); h.timers.advance(1000); await settle(12);
        if (kind === 'curve') { h.reportOff(); await settle(12); }
        if (kind === 'controller') {
          const controller = h.controllers.get('runtime');
          controller?.handleInput({ controlId: 'up', action: 'long_press' }, 'up-hold');
          await settle(4);
          controller?.handleInput({ controlId: 'btn', action: 'press' }, 'btn-press');
        }
        await runtime.write(); await settle(12);
        if (kind !== 'daylight') { await runtime.write(); await settle(12); }
        assert.ok(h.timers.pending >= (kind === 'controller' ? 3 : 1), `something is armed on a ${kind}`);

        h.holdTeardown(release.promise);
        const stopping = runtime.stop();

        assert.equal(h.timers.pending, ticker, 'nothing the runtime armed is left when stop() returns its promise');

        h.timers.advance(10_000); await settle(12);
        assert.equal(h.timers.pending, ticker);
        assert.deepEqual(persisted, [], 'a probe that never fires persists nothing');
        release.resolve();
        await stopping;
      } finally { release.resolve(); await h.stop(); }
    });
  }

  /**
   * PERF-5. A curve and a Room-sensing Light read each lamp at start, to know
   * whether it is on (the 2 September bug in platform §15), and subscribe to
   * it. Those used to be two reads of the same lamp; the subscription's own
   * read now seeds the values. A controller only subscribes, so one read is
   * all it ever made. A schedule watches no lamp at start.
   */
  for (const kind of kinds) {
    test(`${kind}: starting reads each lamp at most once`, async () => {
      const h = house();
      try {
        await registered(h, kind); await settle(12);
        assert.equal(h.lampReads(), kind === 'schedule' ? 0 : 1);
      } finally { await h.stop(); }
    });
  }

  /**
   * PERF-7, end to end: a room with its lamp off gives the same "nothing to
   * do" every minute, and those minutes are one row in the action history.
   */
  for (const kind of ['curve', 'daylight'] as const) {
    test(`${kind}: an hour of identical idle ticks is one history row`, async () => {
      const h = house();
      try {
        await registered(h, kind); await settle(12);
        h.reportOff(); await settle(12);
        const manager = kind === 'curve' ? h.curves : h.daylights;
        for (let minute = 0; minute < 60; minute += 1) {
          h.timers.advance(60_000); await settle(4);
        }
        const runtime = manager.get('runtime')!;
        const idle = runtime.diagnostics().recentActions.filter(action => action.writes === 0);
        const newest = idle[0]!;
        assert.ok(idle.length <= 2, `${idle.length} idle rows`);
        assert.ok((newest.count ?? 1) >= 58, `the run is counted: ${newest.count}`);
        assert.equal(newest, runtime.diagnostics().recentActions[0], 'the run is the newest row');
      } finally { await h.stop(); }
    });
  }

  test('a curve that only publishes still reads its lamps once, without watching them', async () => {
    const h = house();
    try {
      await h.curves.register('runtime', { ...h.curve, writesLights: false }, () => {});
      await settle(12);
      assert.equal(h.lampReads(), 1, 'a preview still has to know which lamps are on');
      assert.equal(h.listenerCount(), 0, 'and a device that writes nothing subscribes to nothing');
    } finally { await h.stop(); }
  });

  for (const kind of ['controller', 'schedule'] as const) {
    /**
     * The same promise the curve and the Room-sensing Light make above, for the
     * two runtimes that own Flows. Here it is the bridge that fails, AFTER the
     * controller has subscribed to its lamp: a start that throws must still go
     * through `stop()`, or the listeners it already took outlive a runtime that
     * was never registered and that nothing will ever stop.
     */
    test(`${kind} failed startup releases listeners and timers`, async () => {
      const h = house(); h.failReconcile();
      const hooks = h.replacementCount();
      try {
        await assert.rejects(registered(h, kind, 'failed'), /bridge unavailable/);
        assert.equal(h.listenerCount(), 0);
        assert.equal(h.replacementCount(), hooks);
        assert.equal(managerOf(h, kind).all().length, 0);
        assert.equal(h.timers.pending, 0);
      } finally { await h.stop(); }
    });

    test(`${kind} target refresh cannot restore resources after stop`, async () => {
      const h = house();
      const hooks = h.replacementCount();
      try {
        const runtime = await registered(h, kind);
        await settle(12);
        const gate = deferred(); h.holdQuery(gate.promise);
        const refreshing = runtime.refreshTargets(); await settle(12);
        const stopping = runtime.stop(); gate.resolve();
        await Promise.all([refreshing, stopping]);
        const before = h.writes.length;
        await runtime.write(); await settle(12);
        h.timers.advance(10_000); await settle(12);
        assert.equal(h.writes.length, before);
        assert.equal(h.listenerCount(), 0);
        assert.equal(h.replacementCount(), hooks);
        assert.equal(h.timers.pending, 0);
      } finally { await h.stop(); }
    });
  }

  for (const kind of ['curve', 'daylight'] as const) {
    /**
     * One interval for every device of a kind, started with the first and
     * stopped with the last. Left running over an empty map it ticks nothing,
     * which is why nothing noticed: it is simply a timer that outlives every
     * device it was for.
     */
    test(`the ${kind} manager's ticker stops with its last device`, async () => {
      const h = house();
      try {
        await registered(h, kind, 'a'); await registered(h, kind, 'b');
        await settle(12); h.timers.advance(1000); await settle(12);
        await managerOf(h, kind).unregister('a');
        assert.ok(h.timers.pending > 0, 'one device is left, so the tick runs on');
        await managerOf(h, kind).unregister('b');
        assert.equal(h.timers.pending, 0);
      } finally { await h.stop(); }
    });

    test(`destroyAll stops the ${kind} manager's ticker`, async () => {
      const h = house();
      try {
        await registered(h, kind, 'a');
        await settle(12);
        assert.ok(h.timers.pending > 0);
        await (kind === 'curve' ? h.curves.destroyAll() : h.daylights.destroyAll());
        assert.equal(h.timers.pending, 0);
      } finally { await h.stop(); }
    });
  }
});

/**
 * The registry's catalogue-change debounce runs on the manager's timers too.
 *
 * Every manager forwarded `timers` to its runtimes but built its
 * RuntimeRegistry without them, so the one timer the registry arms — the
 * debounced target refresh after a catalogue change — stayed on the real clock
 * in every rig, and "destroyAll leaves nothing armed" could only be shown on a
 * bare registry. Here it is shown through each real manager: the debounce is
 * visible on the fake clock, and tearing the manager down disarms it.
 */
describe('a catalogue change arms its refresh on the manager\'s clock, and teardown disarms it', () => {
  const kinds: Kind[] = ['controller', 'schedule', 'curve', 'daylight'];
  for (const kind of kinds) {
    test(`${kind}: the pending refresh is a fake timer, and destroyAll clears it`, async () => {
      const h = house();
      const manager = { controller: h.controllers, schedule: h.schedules, curve: h.curves, daylight: h.daylights }[kind];
      try {
        await registered(h, kind);
        await settle(12); h.timers.advance(1000); await settle(12);
        const before = h.timers.pending;

        await manager.onCatalogChange();
        assert.equal(h.timers.pending, before + 1, 'the debounced refresh waits on the injected clock');

        await manager.destroyAll();
        assert.equal(h.timers.pending, 0);
      } finally { await h.stop(); }
    });
  }
});
