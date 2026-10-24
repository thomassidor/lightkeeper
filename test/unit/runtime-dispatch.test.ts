import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ControllerRuntimeManager } from '../../lib/runtime/controller-runtime-manager';
import { ScheduleRuntimeManager } from '../../lib/schedules/schedule-runtime-manager';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { eventKeyFor } from '../../lib/schedules/schedule-bindings';
import type { ControllerRuntime } from '../../lib/runtime/controller-runtime';
import type { ScheduleRuntime } from '../../lib/schedules/schedule-runtime';
import type { SchedulePlan } from '../../lib/schedules/schedule-types';
import type { ControllerProfile } from '../../lib/profiles/controller-profile';
import type { SelectableInput } from '../../lib/inputs/selectable-input';
import type { InputAction } from '../../lib/inputs/input-event';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { SourceDiscoveryService } from '../../lib/source-discovery-service';
import { fakeApiClient, fakeApiService, realCatalog, lamp, type RawDeviceFixture } from '../support/fake-homey-api';
import { FakeTimers } from '../support/fake-timers';
import { settle } from '../support/deferred';

/**
 * Bridge dispatch on the REAL runtime managers.
 *
 * "Bridge arguments are untrusted" (CLAUDE.md, Safety properties). A generated
 * Flow's action arguments — the controller id and the event key — are editable
 * by anybody with the Flow editor open, and arrive here after the intake layer
 * (`bridge-event-intake.ts`) has checked only their SHAPE. Whether they name a
 * live device, an event that device knows and an event it was told to act on
 * is decided in `dispatchWithReason`, and every one of those refusals has to
 * fail CLOSED: refused, with a reason, and nothing handed to a runtime.
 *
 * Before this file `app-entry.test.ts` stubbed both managers' dispatch and
 * nothing else called it, so a "helpful" fall-back — the only running
 * controller for an id that matches none, the first catalogue entry for a key
 * that matches none — would have shipped green. Each would turn a forged or
 * stale Flow into a light switching in somebody's house, which is the one
 * outcome the refusal exists to prevent.
 *
 * The managers, runtimes, catalogue and write path are all real; only Homey
 * (the `homey-api` client), the Flow bridge and source discovery are fakes.
 */

const REMOTE = 'remote-1';

function remote(): RawDeviceFixture {
  return {
    id: REMOTE, name: 'Kitchen STYRBAR', zone: 'z-living', class: 'remote',
    capabilities: { measure_battery: 80 },
    ownerUri: 'homey:app:com.ikea.tradfri', driverId: 'homey:app:com.ikea.tradfri:remote',
  };
}

function input(key: string, controlId: string, action: InputAction): SelectableInput {
  return {
    key, controlId, action, label: key, carriesMagnitude: false,
    binding: { kind: 'flow_fixed', cardId: `${key}_card`, cardOwnerUri: `homey:device:${REMOTE}`, fixedArgs: {} },
  };
}

/**
 * The remote's catalogue. ORDER MATTERS for one of the mutants this file is
 * here to kill: `ON` is first and mapped, so a dispatch that fell back to
 * `catalogue[0]` for a key it does not know would be accepted and would act.
 */
const ON = input('on|press', 'on', 'press');
const OFF = input('off|press', 'off', 'press');
/** Held and released: the long press is mapped, its release is not. */
const DIM_HOLD = input('dim|long_press', 'dim', 'long_press');
const DIM_RELEASE = input('dim|release', 'dim', 'release');
/** A press on the held control. Same control, not a stop signal. */
const DIM_PRESS = input('dim|press', 'dim', 'press');
/** A second held control whose long press is NOT mapped. */
const WARM_HOLD = input('warm|long_press', 'warm', 'long_press');
const WARM_RELEASE = input('warm|release', 'warm', 'release');
const CATALOGUE = [ON, OFF, DIM_HOLD, DIM_RELEASE, DIM_PRESS, WARM_HOLD, WARM_RELEASE];

function profile(catalogue: SelectableInput[] = CATALOGUE): ControllerProfile {
  return {
    schemaVersion: 1,
    enabled: true,
    source: {
      deviceId: REMOTE, driverId: 'homey:app:com.ikea.tradfri:remote',
      ownerAppId: 'homey:app:com.ikea.tradfri', eventSurfaceFingerprint: 'fp', name: 'Kitchen STYRBAR',
    },
    target: { kind: 'devices', deviceIds: ['l1'] },
    mappings: [
      { id: 'r1', function: 'toggle', inputKey: ON.key, target: null },
      { id: 'r2', function: 'brightness_up', inputKey: DIM_HOLD.key, target: null },
    ],
    behavior: { ...DEFAULT_BEHAVIOR },
    managedFlows: [],
    catalogue,
  };
}

/** One remote, one lamp, a quiet bridge, and every handled input recorded. */
function controllerHouse() {
  const client = fakeApiClient([remote(), lamp('l1', 'Sofa lamp')]);
  const api = fakeApiService(client);
  const catalog = realCatalog(client);
  const timers = new FakeTimers(Date.UTC(2026, 7, 18, 10, 0));

  const bridge = {
    reconcile: async (_id: string, pass: () => Promise<unknown>) => pass(),
    sync: async () => ({
      references: [], created: 0, reused: 0, deleted: 0,
      userEdited: [], unsupported: [], staleReplacements: [],
    }),
    removeAll: async () => 0,
  } as unknown as FlowBridgeManager;
  // The same catalogue back, so `refreshCatalogue()` adopts nothing.
  const discovery = {
    discover: async () => ({ inputs: CATALOGUE, fingerprint: 'fp', rejected: [] }),
  } as unknown as SourceDiscoveryService;

  const manager = new ControllerRuntimeManager({
    api, catalog, discovery, bridge, timers, log: () => { /* quiet */ },
  });

  const handled: Array<{ controller: string; key: string; action: string }> = [];
  /** Wrap the runtime's own entry point, so "nothing handled" is observed, not inferred. */
  const spy = (id: string, runtime: ControllerRuntime) => {
    const original = runtime.handleInput.bind(runtime);
    runtime.handleInput = (event, key) => {
      handled.push({ controller: id, key, action: event.action });
      original(event, key);
    };
    return runtime;
  };

  return {
    manager,
    handled,
    async register(id: string, catalogue?: SelectableInput[]) {
      return spy(id, await manager.register(id, profile(catalogue), () => { /* state is not under test */ }));
    },
  };
}

describe('controller dispatch refuses what it cannot attribute', () => {
  test('an unknown controller id is refused, naming who IS running, and no controller acts', async () => {
    // Two live controllers, so a fall-back has somewhere to go. A Flow whose
    // `controller` argument names a deleted device, or one typed by hand, must
    // reach neither of them.
    const h = controllerHouse();
    await h.register('ctrl-1');
    await h.register('ctrl-2');

    const outcome = h.manager.dispatchWithReason('ctrl-gone', ON.key, {});

    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason ?? '', /no running controller "ctrl-gone"/);
    assert.match(outcome.reason ?? '', /ctrl-1, ctrl-2/, 'and says which ids are running, for the log');
    assert.deepEqual(h.handled, [], 'not routed to any other controller');

    await h.manager.destroyAll();
  });

  test('a key not in the catalogue is refused, never matched to the nearest entry', async () => {
    const h = controllerHouse();
    const runtime = await h.register('ctrl-1');

    const outcome = h.manager.dispatchWithReason('ctrl-1', 'ghost|press', {});

    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason ?? '', /"ghost\|press" is not in this controller's catalogue of 7/);
    assert.deepEqual(h.handled, []);
    assert.equal(runtime.diagnostics().lastEvent, null, 'the runtime never saw it');

    await h.manager.destroyAll();
  });

  test('another controller\'s event, sent to this one, is refused', async () => {
    // The lookup in THIS controller's catalogue is the check that a generated
    // Flow can only drive the controller encoded in its binding: a key that
    // belongs to a different remote must not be honoured here because it
    // happens to be well-formed.
    const h = controllerHouse();
    await h.register('ctrl-1', [ON, OFF, DIM_HOLD, DIM_RELEASE]);
    await h.register('ctrl-2');

    const outcome = h.manager.dispatchWithReason('ctrl-1', WARM_HOLD.key, {});

    assert.equal(outcome.accepted, false);
    assert.deepEqual(h.handled, []);

    await h.manager.destroyAll();
  });

  test('a key in the catalogue that is not mapped is refused', async () => {
    // A gesture the user left unassigned. Its Flow should not exist, but a
    // stale one can, and "it was in the catalogue" is not permission to act.
    const h = controllerHouse();
    await h.register('ctrl-1');

    const outcome = h.manager.dispatchWithReason('ctrl-1', OFF.key, {});

    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason ?? '', /"off\|press" is not mapped to any function/);
    assert.deepEqual(h.handled, []);

    await h.manager.destroyAll();
  });

  test('a release whose long press is mapped IS accepted, as the stop of that hold', async () => {
    // The positive control for everything above, and the one exception to
    // "mapped or refused": a release is never mapped itself, but it is what
    // ends the ramp its control's long press started. Refusing it would leave
    // that ramp running into the 10 s hard stop on every hold.
    const h = controllerHouse();
    const runtime = await h.register('ctrl-1');

    const outcome = h.manager.dispatchWithReason('ctrl-1', DIM_RELEASE.key, {});

    assert.deepEqual(outcome, { accepted: true });
    assert.deepEqual(h.handled, [{ controller: 'ctrl-1', key: DIM_RELEASE.key, action: 'release' }]);
    assert.equal(runtime.diagnostics().lastEvent?.key, DIM_RELEASE.key);

    await h.manager.destroyAll();
  });

  test('and a mapped press is accepted and handed to its own controller only', async () => {
    const h = controllerHouse();
    await h.register('ctrl-1');
    await h.register('ctrl-2');

    assert.deepEqual(h.manager.dispatchWithReason('ctrl-2', ON.key, {}), { accepted: true });
    assert.deepEqual(h.handled, [{ controller: 'ctrl-2', key: ON.key, action: 'press' }]);

    await h.manager.destroyAll();
  });

  test('a release whose control\'s long press is NOT mapped is refused', async () => {
    // The stop-dependency is about a MAPPED hold. `warm|long_press` is in the
    // catalogue and nothing is assigned to it, so there is no ramp its release
    // could be stopping.
    const h = controllerHouse();
    await h.register('ctrl-1');

    const outcome = h.manager.dispatchWithReason('ctrl-1', WARM_RELEASE.key, {});

    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason ?? '', /not mapped/);
    assert.deepEqual(h.handled, []);

    await h.manager.destroyAll();
  });

  test('a press on the held control is not a stop signal, and is refused when unmapped', async () => {
    // Same control as the mapped hold, but a press is not what ends a ramp.
    // Only `release` and `rotate_stop` ride on the hold's mapping.
    const h = controllerHouse();
    await h.register('ctrl-1');

    const outcome = h.manager.dispatchWithReason('ctrl-1', DIM_PRESS.key, {});

    assert.equal(outcome.accepted, false);
    assert.deepEqual(h.handled, []);

    await h.manager.destroyAll();
  });
});

/** 21:59 in Copenhagen on Tuesday 18 August 2026 — a minute before the window. */
const TUESDAY_2159 = Date.UTC(2026, 7, 18, 19, 59);

function schedulePlan(): SchedulePlan {
  return {
    schemaVersion: 1,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1'] },
    entries: [{ id: 'a', onAt: 22 * 60, end: { kind: 'duration', minutes: 90 } }],
    days: null,
    managedFlows: [],
  };
}

/** Two schedules over one lamp (OFF, so an accepted on-boundary is a visible write). */
function scheduleHouse() {
  const client = fakeApiClient([lamp('l1', 'Sofa lamp', 'z-living', { onoff: false })]);
  const api = fakeApiService(client);
  const catalog = realCatalog(client);
  // A minute BEFORE the window, so start()'s catch-up has nothing to apply and
  // every write in this house comes from a dispatch. The on boundary is still
  // accepted: a boundary a minute early is inside the tolerance.
  const timers = new FakeTimers(TUESDAY_2159);

  const bridge = {
    reconcile: async (_id: string, pass: () => Promise<unknown>) => pass(),
    sync: async (request: { mapped: Array<{ key: string; variantKey?: string }> }) => ({
      references: request.mapped.map((m, i) => ({
        flowId: `f${i}`, bindingKey: m.key, variantKey: m.variantKey, fingerprint: 'fp',
        managedVersion: 1, createdAt: 0,
      })),
      created: request.mapped.length, reused: 0, deleted: 0,
      userEdited: [], unsupported: [], staleReplacements: [],
    }),
    removeAll: async () => 0,
  } as unknown as FlowBridgeManager;

  const manager = new ScheduleRuntimeManager({
    api, catalog, bridge, timers, timezone: () => 'Europe/Copenhagen', log: () => { /* quiet */ },
  });
  // The card lookup is the bridge's business, not dispatch's.
  manager.timeCard = async () => ({
    card: { id: 'homey:manager:cron:time_exactly', uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly', argument: 'time' },
    candidates: [],
  });

  const handled: Array<{ schedule: string; key: string }> = [];
  const spy = (id: string, runtime: ScheduleRuntime) => {
    const original = runtime.handleEvent.bind(runtime);
    runtime.handleEvent = key => {
      handled.push({ schedule: id, key });
      return original(key);
    };
    return runtime;
  };

  return {
    client,
    manager,
    handled,
    async register(id: string) {
      return spy(id, await manager.register(id, schedulePlan(), () => { /* state is not under test */ }));
    },
  };
}

describe('schedule dispatch refuses what it cannot attribute', () => {
  test('an unknown schedule id is refused, and no other schedule acts on its boundary', async () => {
    // Both live schedules have an entry "a" and it is a minute from its on
    // boundary, so the key would be accepted by EITHER of them. That is what
    // makes a fall-back to "some schedule" dangerous rather than merely wrong.
    const h = scheduleHouse();
    await h.register('sched-1');
    await h.register('sched-2');
    await settle(6);
    const before = h.client.writes.length;

    const outcome = h.manager.dispatchWithReason('sched-gone', eventKeyFor('a', 'on'));
    await settle(6);

    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason ?? '', /no running schedule "sched-gone" \(running: sched-1, sched-2\)/);
    assert.deepEqual(h.handled, [], 'no runtime was asked');
    assert.equal(h.client.writes.length, before, 'and no lamp moved');

    await h.manager.destroyAll();
  });

  test('the same boundary sent to a schedule that exists is applied (the positive control)', async () => {
    const h = scheduleHouse();
    await h.register('sched-1');
    await settle(6);
    const before = h.client.writes.length;

    const outcome = h.manager.dispatchWithReason('sched-1', eventKeyFor('a', 'on'));
    await settle(6);

    assert.deepEqual(outcome, { accepted: true });
    assert.deepEqual(h.handled, [{ schedule: 'sched-1', key: eventKeyFor('a', 'on') }]);
    assert.deepEqual(
      h.client.writes.slice(before).map(w => [w.deviceId, w.capabilityId, w.value]),
      [['l1', 'onoff', true]],
    );

    await h.manager.destroyAll();
  });
});
