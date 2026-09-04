import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const api = require('../../api') as {
  previewDevice(args: any): Promise<any>;
  testPreStage(args: any): Promise<any>;
  tickCurves(args: any): Promise<any>;
  tickDaylight(args: any): Promise<any>;
  testScheduleBoundary(args: any): Promise<any>;
  setScheduleEntries(args: any): Promise<any>;
  testControllerFunction(args: any): Promise<any>;
};

/**
 * The seven "try it now" routes.
 *
 * Each wraps a method the runtimes already had and that a pair session already
 * called; what is new is that the app itself, and `scripts/verify-hardware.mjs`
 * with it, can reach them once a device is paired. That closes the last lines of
 * the hardware pass that needed somebody standing in a room watching a lamp.
 *
 * Two properties are worth more than the happy paths here, and both are about
 * the one route that WRITES:
 *
 * - `setScheduleEntries` must sanitise with the same function the pair session
 *   uses, so a window the pairing screen would refuse cannot get in through the
 *   side door.
 * - It must persist through `device.applyPlan`, never the store, or
 *   `DeviceLifecycle`'s transaction — carried-forward Flows, rollback, published
 *   state — is skipped for exactly the writes least likely to be watched.
 */

const SCHEDULE_ID = 'lk-sched-1755500000000-200001';
const CURVE_ID = 'lk-circ-1755500000000-300001';
const CONTROLLER_ID = 'lk-ctrl-1755500000000-100001';
const DAYLIGHT_ID = 'lk-dayl-1755500000000-400001';

/** One stored window, 20:00 for two hours, every day. */
const WINDOW = { id: 'a', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 120 } };

interface Recorded {
  applied: unknown[];
  drained: number;
  probed: number;
  tickedAll: number;
  tickedDaylight: number;
  boundaries: Array<{ entryId: string; boundary: string }>;
  functions: Array<{ func: string; deviceIds?: string[] }>;
  plans: unknown[];
  storeWrites: number;
}

function homey(options: {
  curves?: string[];
  daylight?: string[];
  schedules?: string[];
  controllers?: string[];
  /** Schedule devices the driver can enumerate, by data.id. */
  installedSchedules?: string[];
  storedPlan?: Record<string, unknown>;
  /** Make applyPlan reject, the way a plan that will not start does. */
  applyFails?: string;
} = {}) {
  const recorded: Recorded = {
    applied: [], drained: 0, probed: 0, tickedAll: 0, tickedDaylight: 0,
    boundaries: [], functions: [], plans: [], storeWrites: 0,
  };

  const curve = (id: string) => ({
    controllerId: id,
    applyNow: async (reason: string, opts: any) => {
      recorded.applied.push({ id, reason, ...opts });
      return { writes: 2, skipped: 1 };
    },
    drain: async () => { recorded.drained += 1; },
    probePreStage: async () => {
      recorded.probed += 1;
      return { deviceId: 'l1', name: 'Hall lamp', stayedOff: true, restored: false };
    },
  });

  const schedule = (id: string) => ({
    controllerId: id,
    testEntry: async (entryId: string, boundary: string) => {
      recorded.boundaries.push({ entryId, boundary });
      return { writes: 3, skipped: 0, targets: 3 };
    },
  });

  const controller = (id: string) => ({
    controllerId: id,
    testFunction: async (func: string, deviceIds?: string[]) => {
      recorded.functions.push({ func, deviceIds });
      return { writes: 1, skipped: 0, targets: 1 };
    },
  });

  const registry = <T>(ids: string[], make: (id: string) => T) => {
    const runtimes = ids.map(make);
    return {
      all: () => runtimes,
      get: (id: string) => runtimes.find((r: any) => r.controllerId === id),
    };
  };

  const curves = {
    ...registry(options.curves ?? [], curve),
    tickAll: async () => { recorded.tickedAll += 1; },
  };

  /**
   * A Daylight light answers the same `applyNow`/`drain` pair, which is the
   * whole reason ONE preview route serves two registries. Reusing the `curve`
   * factory is the point rather than a shortcut: if the two runtimes' surfaces
   * ever diverge, that route stops being honest and this stops compiling.
   */
  const daylights = {
    ...registry(options.daylight ?? [], curve),
    tickAll: async () => { recorded.tickedDaylight += 1; },
  };

  const devices = (options.installedSchedules ?? []).map(id => ({
    getData: () => ({ id }),
    getStoreValue: (key: string) => {
      assert.equal(key, 'schedule', 'the plan lives under the driver’s own store key');
      return options.storedPlan ?? {
        schemaVersion: 1, enabled: true, target: { kind: 'devices', deviceIds: ['l1'] },
        entries: [WINDOW], managedFlows: [{ flowId: 'f1' }],
      };
    },
    setStoreValue: () => { recorded.storeWrites += 1; },
    applyPlan: async (plan: unknown) => {
      if (options.applyFails) throw new Error(options.applyFails);
      recorded.plans.push(plan);
    },
  }));

  return {
    recorded,
    homey: {
      app: {
        curves,
        daylights,
        schedules: registry(options.schedules ?? [], schedule),
        controllers: registry(options.controllers ?? [], controller),
        log: () => undefined,
        error: () => undefined,
      },
      drivers: {
        getDriver: (driverId: string) => {
          if (driverId !== 'schedule') throw new Error(`unexpected driver "${driverId}"`);
          return { getDevices: () => devices };
        },
      },
    },
  };
}

// ------------------------------------------------------------------ preview

describe('POST /devices/:id/preview (T21, T27, T28)', () => {
  test('applies the saved plan, forced, and drains before answering', async () => {
    const { homey: h, recorded } = homey({ curves: [CURVE_ID] });

    const result = await api.previewDevice({ homey: h, params: { id: CURVE_ID } });

    assert.deepEqual(result, { writes: 2, skipped: 1 });
    assert.deepEqual(recorded.applied, [{ id: CURVE_ID, reason: 'preview', force: true }]);
    // Forced, because the caller asked for a visible change and is owed one even
    // where the lamps already sit close to the curve.
    assert.equal(recorded.drained, 1,
      'drained, so `writes` is what was attempted rather than what was queued');
  });

  test('an id that is not running is refused by name', async () => {
    const { homey: h } = homey({ curves: [] });
    await assert.rejects(
      () => api.previewDevice({ homey: h, params: { id: CURVE_ID } }),
      /no circadian, Curve or Daylight light with id "lk-circ-1755500000000-300001" is running/,
    );
  });

  test('a Daylight light previews through the SAME route', async () => {
    // Two registries, one route: "apply this device's plan to its lights now"
    // is the same request whether the plan is a curve or a daylight response,
    // and a second route would mean a caller that has to know which kind of
    // device it is holding an id for.
    const { homey: h, recorded } = homey({ daylight: [DAYLIGHT_ID] });

    const result = await api.previewDevice({ homey: h, params: { id: DAYLIGHT_ID } });

    assert.deepEqual(result, { writes: 2, skipped: 1 });
    assert.deepEqual(recorded.applied, [{ id: DAYLIGHT_ID, reason: 'preview', force: true }]);
    assert.equal(recorded.drained, 1);
  });

  test('a curve id is still found when Daylight lights are running too', async () => {
    // The fallback must not shadow the first registry.
    const { homey: h, recorded } = homey({ curves: [CURVE_ID], daylight: [DAYLIGHT_ID] });

    await api.previewDevice({ homey: h, params: { id: CURVE_ID } });
    assert.deepEqual(recorded.applied, [{ id: CURVE_ID, reason: 'preview', force: true }]);
  });

  test('a missing id is refused before anything is looked up', async () => {
    const { homey: h, recorded } = homey({ curves: [CURVE_ID] });
    await assert.rejects(() => api.previewDevice({ homey: h, params: {} }), /no device id/);
    assert.deepEqual(recorded.applied, []);
  });
});

describe('POST /devices/:id/prestage-test (T22)', () => {
  test('it probes, and a lamp that came on is a RESULT rather than an error', async () => {
    /**
     * "stayedOff: false" is the answer that says this household's integration
     * turns a lamp on when you write a colour to it (platform §6). Reporting
     * that as a failure would make the honest answer look like a broken app.
     */
    const { homey: h, recorded } = homey({ curves: [CURVE_ID] });

    const result = await api.testPreStage({ homey: h, params: { id: CURVE_ID } });

    assert.equal(recorded.probed, 1);
    assert.deepEqual(result, {
      deviceId: 'l1', name: 'Hall lamp', stayedOff: true, restored: false,
    });
  });

  test('an unknown id is refused', async () => {
    const { homey: h } = homey({ curves: [] });
    await assert.rejects(() => api.testPreStage({ homey: h, params: { id: CURVE_ID } }));
  });
});

describe('POST /curves/tick', () => {
  test('one call ticks every curve-driven device, and says how many', async () => {
    // One timer serves both device types (platform §12), so there is one tick
    // for the whole Homey rather than one per device.
    const { homey: h, recorded } = homey({ curves: [CURVE_ID, 'lk-curv-1755500000000-300002'] });

    assert.deepEqual(await api.tickCurves({ homey: h }), { ticked: 2 });
    assert.equal(recorded.tickedAll, 1);
  });

  test('with nothing running it reports zero rather than failing', async () => {
    const { homey: h } = homey({ curves: [] });
    assert.deepEqual(await api.tickCurves({ homey: h }), { ticked: 0 });
  });
});

describe('POST /daylight/tick', () => {
  test('one call ticks every Daylight light, and says how many', async () => {
    // Its own route rather than folded into tickCurves, because a pass watching
    // whether the daylight loop settles wants to advance THAT clock and nothing
    // else — and because the other name would then be a lie.
    const { homey: h, recorded } = homey({
      daylight: [DAYLIGHT_ID, 'lk-dayl-1755500000000-400002'],
    });

    assert.deepEqual(await api.tickDaylight({ homey: h }), { ticked: 2 });
    assert.equal(recorded.tickedDaylight, 1);
    assert.equal(recorded.tickedAll, 0, 'it must not tick the curves as well');
  });

  test('with nothing running it reports zero rather than failing', async () => {
    const { homey: h } = homey({ daylight: [] });
    assert.deepEqual(await api.tickDaylight({ homey: h }), { ticked: 0 });
  });
});

// ----------------------------------------------------------------- schedule

describe('POST /schedules/:id/test (T14)', () => {
  test('it fires the named boundary', async () => {
    const { homey: h, recorded } = homey({ schedules: [SCHEDULE_ID] });

    const result = await api.testScheduleBoundary({
      homey: h, params: { id: SCHEDULE_ID }, body: { entryId: 'a', boundary: 'off' },
    });

    assert.deepEqual(result, { writes: 3, skipped: 0, targets: 3 });
    assert.deepEqual(recorded.boundaries, [{ entryId: 'a', boundary: 'off' }]);
  });

  test('anything that is not "off" is an on-boundary', async () => {
    // Two boundaries exist and only one of them is spelled 'off'. Guessing from
    // a typo'd third value would fire the wrong end of a window.
    const { homey: h, recorded } = homey({ schedules: [SCHEDULE_ID] });

    for (const boundary of ['on', 'ON', undefined, 'nonsense']) {
      await api.testScheduleBoundary({
        homey: h, params: { id: SCHEDULE_ID }, body: { entryId: 'a', boundary },
      });
    }
    assert.deepEqual(recorded.boundaries.map(b => b.boundary), ['on', 'on', 'on', 'on']);
  });

  test('a missing entryId is refused', async () => {
    const { homey: h, recorded } = homey({ schedules: [SCHEDULE_ID] });
    await assert.rejects(
      () => api.testScheduleBoundary({ homey: h, params: { id: SCHEDULE_ID }, body: {} }),
      /no entryId/,
    );
    assert.deepEqual(recorded.boundaries, []);
  });
});

describe('POST /schedules/:id/entries (T13, T15)', () => {
  const call = (h: any, entries: unknown) =>
    api.setScheduleEntries({ homey: h, params: { id: SCHEDULE_ID }, body: { entries } });

  test('it saves windows through applyPlan, never the store', async () => {
    /**
     * Load-bearing. `DeviceLifecycle.apply()` is what carries `managedFlows`
     * forward, rolls back a plan that will not start, and publishes the state.
     * A direct `setStoreValue` would look identical from here and skip all
     * three — on the one route least likely to be watched while it runs.
     */
    const { homey: h, recorded } = homey({
      schedules: [SCHEDULE_ID], installedSchedules: [SCHEDULE_ID],
    });

    const result = await call(h, [WINDOW]);

    assert.equal(result.count, 1);
    assert.deepEqual(result.dropped, []);
    assert.equal(recorded.plans.length, 1);
    assert.equal(recorded.storeWrites, 0, 'the store must not be written behind the lifecycle');

    // And the rest of the stored plan survives — the route replaces the windows,
    // not the device.
    const plan = recorded.plans[0] as any;
    assert.deepEqual(plan.target, { kind: 'devices', deviceIds: ['l1'] });
    assert.deepEqual(plan.managedFlows, [{ flowId: 'f1' }]);
    assert.equal(plan.enabled, true);
    assert.equal(plan.entries.length, 1);
  });

  test('an overlapping window is dropped and NAMED, by the pairing sanitiser', async () => {
    /**
     * T15. The same `sanitiseEntries` the pair session calls, so a window the
     * pairing screen would refuse cannot get in through this door — and the
     * reason comes back rather than the count quietly being one lower.
     */
    const { homey: h, recorded } = homey({
      schedules: [SCHEDULE_ID], installedSchedules: [SCHEDULE_ID],
    });

    const result = await call(h, [
      WINDOW,
      { id: 'b', onAt: 21 * 60, days: null, end: { kind: 'duration', minutes: 30 } },
    ]);

    assert.equal(result.count, 1, 'the later of an overlapping pair loses');
    assert.equal(result.dropped.length, 1);
    assert.match(result.dropped[0].reason, /^overlaps/);
    assert.equal((recorded.plans[0] as any).entries.length, 1);
  });

  test('a payload where everything is dropped is refused, not saved empty', async () => {
    // A schedule with no windows is a device that looks configured and can never
    // fire — the exact failure this app exists to prevent — so it is a throw
    // that names the reasons rather than a save of nothing.
    const { homey: h, recorded } = homey({
      schedules: [SCHEDULE_ID], installedSchedules: [SCHEDULE_ID],
    });

    await assert.rejects(() => call(h, [{ id: 'x', onAt: 99999 }]), /every window was dropped/);
    assert.deepEqual(recorded.plans, []);
  });

  test('an empty list is refused with its own sentence', async () => {
    const { homey: h, recorded } = homey({
      schedules: [SCHEDULE_ID], installedSchedules: [SCHEDULE_ID],
    });

    await assert.rejects(() => call(h, []), /needs at least one window/);
    assert.deepEqual(recorded.plans, []);
  });

  test('the twelve-window cap is the sanitiser’s, and it holds here too', async () => {
    // Twelve windows is twenty-four generated Flows. Past that the user's own
    // Flow list stops being readable.
    const { homey: h } = homey({
      schedules: [SCHEDULE_ID], installedSchedules: [SCHEDULE_ID],
    });

    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `e${i}`, onAt: i * 90, days: null, end: { kind: 'duration', minutes: 30 },
    }));
    const result = await call(h, many);

    assert.equal(result.count, 12);
    assert.equal(result.dropped.length, 3);
  });

  test('a device that is not installed is refused before anything is sanitised', async () => {
    const { homey: h, recorded } = homey({ schedules: [SCHEDULE_ID], installedSchedules: [] });
    await assert.rejects(() => call(h, [WINDOW]), /no schedule device with id .* is installed/);
    assert.deepEqual(recorded.plans, []);
  });

  test('a plan the device refuses propagates, rather than reporting success', async () => {
    const { homey: h } = homey({
      schedules: [SCHEDULE_ID], installedSchedules: [SCHEDULE_ID],
      applyFails: 'no time trigger card on this Homey',
    });
    await assert.rejects(() => call(h, [WINDOW]), /no time trigger card/);
  });
});

// --------------------------------------------------------------- controller

describe('POST /controllers/:id/test', () => {
  test('it runs the named function against the controller’s own lights', async () => {
    const { homey: h, recorded } = homey({ controllers: [CONTROLLER_ID] });

    const result = await api.testControllerFunction({
      homey: h, params: { id: CONTROLLER_ID }, body: { func: 'toggle' },
    });

    assert.deepEqual(result, { writes: 1, skipped: 0, targets: 1 });
    assert.deepEqual(recorded.functions, [{ func: 'toggle', deviceIds: undefined }]);
  });

  test('a device list narrows it', async () => {
    const { homey: h, recorded } = homey({ controllers: [CONTROLLER_ID] });

    await api.testControllerFunction({
      homey: h,
      params: { id: CONTROLLER_ID },
      body: { func: 'brightness_up', deviceIds: ['l1', 'l2'] },
    });

    assert.deepEqual(recorded.functions, [{ func: 'brightness_up', deviceIds: ['l1', 'l2'] }]);
  });

  test('a missing func is refused', async () => {
    const { homey: h, recorded } = homey({ controllers: [CONTROLLER_ID] });
    await assert.rejects(
      () => api.testControllerFunction({ homey: h, params: { id: CONTROLLER_ID }, body: {} }),
      /no func/,
    );
    assert.deepEqual(recorded.functions, []);
  });
});
