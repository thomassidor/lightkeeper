import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Device, fakeHomey, makeDevice, makeDriver, translate, FakePairSession, type FakeHomey,
} from '../support/fake-homey';
import { fakeApiClient, lamp } from '../support/fake-homey-api';
import { driverApp } from '../support/fake-lightkeeper-app';
import { settle } from '../support/deferred';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import { VALUE_CAPABILITIES } from '../../lib/runtime/published-values';
import { CONTROL_CAPABILITY } from '../../lib/pairing/control-choice';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { CURRENT_SCHEMA_VERSION } from '../../lib/profiles/controller-profile';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';

const ControllerDevice = require('../../drivers/controller/device');
const CircadianDevice = require('../../drivers/circadian/device');
const CurveDevice = require('../../drivers/curve/device');
const DaylightDevice = require('../../drivers/daylight/device');
const ScheduleDevice = require('../../drivers/schedule/device');

const CircadianDriver = require('../../drivers/circadian/driver');
const CurveDriver = require('../../drivers/curve/driver');
const DaylightDriver = require('../../drivers/daylight/driver');
const ScheduleDriver = require('../../drivers/schedule/driver');

/**
 * The five `device.ts` files and the `LightkeeperDevice` shell they extend,
 * executed through the SDK entry points Homey calls.
 *
 * `DeviceLifecycle` has been tested against a fake owner for a long time
 * (`device-transactions.test.ts`). What had no test was every device type's OWN
 * answers to it — the pause switch and whether paused is still available, the
 * pause state carried across an edit, the circadian registry adapter that
 * expands two ends into points, and the controller's handling of a changed
 * remote's Flows — because each lives in a file that `extends Homey.Device`
 * (platform §13). `safety-promises.test.ts` read two of those flags out of the
 * source text with a regex; the tests below are what they actually do.
 *
 * Every stored plan here is one a real DRIVER's save handler produced, so a
 * plan that validates here is a plan the pairing screens can actually make.
 */

// ------------------------------------------------------------------ plans

async function savedPlan(Driver: any, storeKey: string, prepare?: (s: FakePairSession) => Promise<void>) {
  const client = fakeApiClient([lamp('l1', 'Sofa lamp')]);
  const { app } = driverApp(client);
  const driver = makeDriver(Driver, fakeHomey({ app }));
  const session = new FakePairSession();
  await driver.onPair(session);
  await session.call('selectTargets', { kind: 'devices', deviceIds: ['l1'] });
  await prepare?.(session);
  const saved = await session.call('save', '');
  return saved.device.store[storeKey];
}

const plans = {
  circadian: () => savedPlan(CircadianDriver, 'circadian'),
  curve: () => savedPlan(CurveDriver, 'curve'),
  daylight: () => savedPlan(DaylightDriver, 'daylight'),
  schedule: () => savedPlan(ScheduleDriver, 'schedule', async s => {
    await s.call('setSchedules', { entries: [{ id: 'a', onAt: 1200, end: { kind: 'duration', minutes: 60 } }] });
  }),
};

function controllerProfile(sourceId: string, flows: string[]) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION, enabled: true,
    source: { deviceId: sourceId, name: 'STYRBAR', eventSurfaceFingerprint: `fp-${sourceId}` },
    target: { kind: 'devices', deviceIds: ['l1'] },
    mappings: [{ id: 'r1', function: 'toggle', inputKey: 'on|press', target: null }],
    behavior: { ...DEFAULT_BEHAVIOR },
    managedFlows: flows.map(flowId => ({
      flowId, bindingKey: 'on|press', variantKey: 'fixed', fingerprint: `fp-${sourceId}`, managedVersion: 1, createdAt: 1,
    })),
    catalogue: [{
      key: 'on|press', controlId: 'on', label: 'On — Press', action: 'press', carriesMagnitude: false,
      binding: { kind: 'flow_fixed', cardId: 'on', cardOwnerUri: `homey:device:${sourceId}`, fixedArgs: {} },
    }],
  };
}

// ------------------------------------------------------------------ the rig

/** One ordered log across the registry, the bridge and the device store. */
type Event = [string, ...unknown[]];

interface RegistryOptions {
  failRegister?: (plan: any) => boolean;
  state?: string;
}

function registry(events: Event[], options: RegistryOptions = {}) {
  const runtimes = new Map<string, any>();
  const registered: Array<{ id: string; plan: any; extra: unknown[]; onPlanChange: (plan: any) => Promise<void> }> = [];
  return {
    registered,
    runtimes,
    async register(id: string, plan: any, _onState: unknown, onPlanChange: (plan: any) => Promise<void>,
      displayName: () => string, ...extra: unknown[]) {
      events.push(['register', plan?.source?.deviceId ?? plan?.enabled]);
      registered.push({ id, plan, extra, onPlanChange });
      if (options.failRegister?.(plan)) throw new Error('the runtime would not start');
      const runtime = {
        currentState: options.state ?? (plan.enabled === false ? 'disabled' : 'ready'),
        currentDetail: undefined,
        currentProfile: plan,
        currentPlan: plan,
        name: displayName(),
        destroyed: 0,
        updates: [] as unknown[],
        reconciled: 0,
        destroy: async () => { runtime.destroyed += 1; },
        updatePlan: async (next: unknown) => { runtime.updates.push(next); },
        reconcileFlows: async () => { runtime.reconciled += 1; },
      };
      runtimes.set(id, runtime);
      return runtime;
    },
    async unregister(id: string) {
      events.push(['unregister', id]);
      runtimes.delete(id);
    },
    get: (id: string) => runtimes.get(id),
  };
}

function bridge(events: Event[], options: { removes?: (refs: Array<{ flowId: string }>) => number } = {}) {
  return {
    releaseReferences: (owner: string, ids: string[]) => { events.push(['release', owner, [...ids]]); },
    deferCleanup: (owner: string, ids: string[]) => { events.push(['defer', owner, [...ids]]); },
    removeAll: async (refs: Array<{ flowId: string }>) => {
      events.push(['removeAll', refs.map(ref => ref.flowId)]);
      return options.removes ? options.removes(refs) : refs.length;
    },
    forgetOwner: (owner: string) => { events.push(['forget', owner]); },
  };
}

function device(Cls: any, id: string, store: Record<string, unknown>, app: Record<string, unknown>,
  capabilities: string[] = []) {
  const homey: FakeHomey = fakeHomey({ app });
  const instance = makeDevice(Cls, homey, { id, name: 'Kitchen', store, capabilities });
  return instance as Device & Record<string, any>;
}

/** Route the device's store writes into the shared event log. */
function watchStore(instance: Device, events: Event[]) {
  const original = instance.setStoreValue.bind(instance);
  instance.setStoreValue = async (key: string, value: unknown) => {
    events.push(['store', (value as { source?: { deviceId?: string } } | null)?.source?.deviceId ?? key]);
    await original(key, value);
  };
}

// ------------------------------------------------------------------ controller

describe('a controller whose remote changes', () => {
  const ID = 'lk-ctrl-1';

  test('keeps the old remote\'s Flows until the new profile has COMMITTED, then deletes them', async () => {
    const events: Event[] = [];
    const controllers = registry(events);
    const instance = device(ControllerDevice, ID, { profile: controllerProfile('old', ['f1', 'f2']) },
      { controllers, bridge: bridge(events) });
    watchStore(instance, events);
    await instance.onInit();
    events.length = 0;

    await instance.applyPlan(controllerProfile('new', []));

    assert.deepEqual(events, [
      // Released first, so the new runtime's first sync neither reuses them nor
      // reads them as user edits of its own...
      ['release', ID, ['f1', 'f2']],
      ['register', 'new'],
      ['store', 'new'],
      // ...and deleted only now, when there is no rollback left to point at them.
      ['removeAll', ['f1', 'f2']],
    ]);
    assert.deepEqual(instance.getStoreValue('profile').managedFlows, []);
    assert.ok(instance.logs.includes('Source changed: removed 2 of 2 flow(s) from the old remote'));
  });

  /**
   * The defect: the Flows were deleted in `prepareApply`, before the register.
   * A register that then failed rolled back to the old profile — whose
   * `managedFlows` named two Flows that no longer existed.
   */
  test('a FAILED apply deletes nothing, and the rolled-back profile still owns its live Flows', async () => {
    const events: Event[] = [];
    const controllers = registry(events, { failRegister: plan => plan.source.deviceId === 'new' });
    const instance = device(ControllerDevice, ID, { profile: controllerProfile('old', ['f1']) },
      { controllers, bridge: bridge(events) });
    await instance.onInit();

    await assert.rejects(instance.applyPlan(controllerProfile('new', [])), /would not start/);

    assert.equal(events.some(([name]) => name === 'removeAll'), false, 'no Flow was deleted');
    const restored = instance.getStoreValue('profile');
    assert.equal(restored.source.deviceId, 'old');
    assert.deepEqual(restored.managedFlows.map((ref: { flowId: string }) => ref.flowId), ['f1']);
    assert.equal(controllers.get(ID)?.currentProfile.source.deviceId, 'old', 'the old runtime is back');
  });

  test('a delete that does not stick is handed to the next reconcile, not forgotten', async () => {
    const events: Event[] = [];
    const instance = device(ControllerDevice, ID, { profile: controllerProfile('old', ['f1', 'f2']) },
      { controllers: registry(events), bridge: bridge(events, { removes: () => 1 }) });
    await instance.onInit();
    events.length = 0;

    await instance.applyPlan(controllerProfile('new', []));
    assert.deepEqual(events.at(-1), ['defer', ID, ['f1', 'f2']]);
  });

  test('a delete that THROWS cannot fail a save that has already committed', async () => {
    const events: Event[] = [];
    const failing = { ...bridge(events), removeAll: async () => { throw new Error('socket closed'); } };
    const instance = device(ControllerDevice, ID, { profile: controllerProfile('old', ['f1']) },
      { controllers: registry(events), bridge: failing });
    await instance.onInit();

    await instance.applyPlan(controllerProfile('new', []));
    assert.equal(instance.getStoreValue('profile').source.deviceId, 'new');
    assert.ok(instance.errors.some((line: string) => line.startsWith('Finishing the new configuration failed')));
  });

  test('the same remote carries its Flows forward and deletes nothing', async () => {
    const events: Event[] = [];
    const instance = device(ControllerDevice, ID, { profile: controllerProfile('old', ['f1']) },
      { controllers: registry(events), bridge: bridge(events) });
    await instance.onInit();
    events.length = 0;

    await instance.applyPlan(controllerProfile('old', []));
    assert.equal(events.some(([name]) => name === 'removeAll' || name === 'release'), false);
    assert.deepEqual(instance.getStoreValue('profile').managedFlows.map((ref: { flowId: string }) => ref.flowId), ['f1']);
  });

  test('has no pause switch, so disabled reads as unavailable', async () => {
    const events: Event[] = [];
    const stored = { ...controllerProfile('old', []), enabled: false };
    const instance = device(ControllerDevice, ID, { profile: stored }, { controllers: registry(events), bridge: bridge(events) });
    await instance.onInit();
    assert.equal(instance.fake.listeners.has('onoff'), false);
    assert.equal(instance.availabilityFor('disabled'), false);
    assert.equal(instance.availabilityFor('partial'), true);
  });

  test('deleted with no runtime, it removes the Flows its RAW store names', async () => {
    const events: Event[] = [];
    // A profile that will not validate, so no runtime ever starts.
    const broken = { ...controllerProfile('old', ['f9']), mappings: 'not a list' };
    const instance = device(ControllerDevice, ID, { profile: broken }, { controllers: registry(events), bridge: bridge(events) });
    await instance.onInit();
    assert.equal(instance.fake.unavailableMessage, translate('state.invalidConfiguration'));

    await instance.onDeleted();
    assert.deepEqual(events.filter(([name]) => name !== 'unregister'), [['removeAll', ['f9']], ['forget', ID]]);
  });
});

describe('the bridge journal the controller now relies on', () => {
  function realBridge() {
    const settings = new Map<string, unknown>();
    const manager = new FlowBridgeManager({} as HomeyApiService, 'com.thomassidor.lightkeeper', () => undefined,
      undefined, {
        get: key => settings.get(key),
        set: (key, value) => { settings.set(key, value); },
        unset: key => { settings.delete(key); },
      });
    return { manager, settings };
  }

  test('releaseReferences drops only the named references, and deferCleanup queues them once', () => {
    const { manager, settings } = realBridge();
    settings.set('flowJournal:lk-ctrl-1', {
      references: [{ flowId: 'f1' }, { flowId: 'f2' }, { flowId: 'f3' }], cleanup: ['old'], staged: [],
    });

    manager.releaseReferences('lk-ctrl-1', ['f1', 'f3']);
    manager.deferCleanup('lk-ctrl-1', ['f1', 'old']);
    manager.releaseReferences('lk-ctrl-1', []);
    manager.deferCleanup('lk-ctrl-1', []);

    assert.deepEqual(settings.get('flowJournal:lk-ctrl-1'), {
      references: [{ flowId: 'f2' }], cleanup: ['old', 'f1'], staged: [],
    });
  });
});

// ------------------------------------------------------------------ the four switchable types

const SWITCHABLE = [
  { name: 'circadian', Cls: CircadianDevice, storeKey: 'circadian', registryKey: 'curves', plan: plans.circadian },
  { name: 'curve', Cls: CurveDevice, storeKey: 'curve', registryKey: 'curves', plan: plans.curve },
  { name: 'daylight', Cls: DaylightDevice, storeKey: 'daylight', registryKey: 'daylights', plan: plans.daylight },
  { name: 'schedule', Cls: ScheduleDevice, storeKey: 'schedule', registryKey: 'schedules', plan: plans.schedule },
] as const;

/**
 * The behavioural form of `safety-promises.test.ts`'s "a device that can be
 * paused can be un-paused", which read `override readonly withPauseSwitch =
 * true` out of the source with a regex. What the promise IS: a paused device
 * with a switch on its tile stays available, and the switch un-pauses it.
 */
for (const kind of SWITCHABLE) {
  describe(`a ${kind.name} device`, () => {
    test('paused, it is AVAILABLE, shows off, and its own switch resumes it', async () => {
      const events: Event[] = [];
      const reg = registry(events);
      const paused = { ...await kind.plan(), enabled: false };
      const instance = device(kind.Cls, `lk-${kind.name}-1`, { [kind.storeKey]: paused },
        { [kind.registryKey]: reg }, ['onoff']);

      await instance.setUnavailable('the key died while it was paused');
      await instance.onInit();

      assert.equal(instance.fake.available, true, 'an unavailable device cannot be switched back on');
      assert.equal(instance.getCapabilityValue('onoff'), false);
      assert.equal(instance.availabilityFor('disabled'), true);

      const listener = instance.fake.listeners.get('onoff');
      assert.ok(listener, 'the tile carries the pause switch');
      await listener(true);
      assert.equal(instance.getStoreValue(kind.storeKey).enabled, true);
      assert.ok(instance.logs.includes('Resumed'));
    });

    test('an edit keeps the pause somebody set', async () => {
      const events: Event[] = [];
      const reg = registry(events);
      const base = await kind.plan();
      const instance = device(kind.Cls, `lk-${kind.name}-1`, { [kind.storeKey]: { ...base, enabled: false } },
        { [kind.registryKey]: reg }, ['onoff']);
      await instance.onInit();

      await instance.applyPlan({ ...base, enabled: true });
      assert.equal(instance.getStoreValue(kind.storeKey).enabled, false);
      assert.equal(instance.getCapabilityValue('onoff'), false);
    });

    test('its value capabilities are added to a tile paired before they existed', async () => {
      const reg = registry([]);
      const instance = device(kind.Cls, `lk-${kind.name}-1`, { [kind.storeKey]: await kind.plan() },
        { [kind.registryKey]: reg }, ['onoff']);
      await instance.onInit();
      for (const capability of instance.valueCapabilities) {
        assert.equal(instance.hasCapability(capability), true, capability);
      }
      assert.ok(instance.valueCapabilities.includes(VALUE_CAPABILITIES.brightness));
    });

    /**
     * The tile's control picker, on the REAL plan shapes: whatever it stores has
     * to be something this device type's own validator reads back, or the next
     * restart quarantines the device it was meant to adjust.
     */
    test(kind.name === 'schedule'
      ? 'it has no control picker'
      : 'its control picker stores a mode its own validator reads back', async () => {
      const reg = registry([]);
      const instance = device(kind.Cls, `lk-${kind.name}-1`, { [kind.storeKey]: await kind.plan() },
        { [kind.registryKey]: reg }, ['onoff']);
      await instance.onInit();

      const listener = instance.fake.listeners.get(CONTROL_CAPABILITY);
      if (kind.name === 'schedule') {
        assert.equal(listener, undefined);
        assert.equal(instance.hasCapability(CONTROL_CAPABILITY), false);
        return;
      }
      assert.ok(listener, 'the tile carries the picker');
      assert.equal(instance.getCapabilityValue(CONTROL_CAPABILITY), 'after');

      await listener('none');
      const stored = instance.getStoreValue(kind.storeKey);
      assert.equal(stored.writesLights, false);
      assert.deepEqual(instance.migrate(stored).plan, stored, 'the validator reads it back unchanged');
      assert.equal(instance.getCapabilityValue(CONTROL_CAPABILITY), 'none');

      if (kind.name === 'daylight') {
        // Paired before the picker existed, so `addCapability` gave it all three
        // values — and the manifest's narrowing reaches only a fresh pair.
        const values = instance.fake.capabilityOptions.get(CONTROL_CAPABILITY)?.values as Array<{ id: string; title: { en: string } }>;
        assert.deepEqual(values?.map(value => value.id), ['after', 'none'], 'the picker offers what the device accepts');
        assert.ok(values.every(value => typeof value.title.en === 'string' && value.title.en !== ''), 'with their own titles');
        await assert.rejects(Promise.resolve(listener('before')));
        assert.equal(instance.getStoreValue(kind.storeKey).writesLights, false);
      } else {
        await listener('before');
        assert.equal(instance.getStoreValue(kind.storeKey).preStage, true);
        assert.equal(instance.fake.warning, translate('warnings.preStageUntested'));
      }
    });

    if (kind.name !== 'schedule') {
      test('a device paired before its control picker existed still starts', async () => {
        // The SDK refuses a listener for a capability a device does not have,
        // and `reconcileCapabilities` is what adds this one to an upgraded tile.
        const instance = device(kind.Cls, `lk-${kind.name}-1`, { [kind.storeKey]: await kind.plan() },
          { [kind.registryKey]: registry([]) }, ['onoff']);
        await instance.onInit();
        assert.equal(instance.hasCapability(CONTROL_CAPABILITY), true);
        assert.ok(instance.fake.listeners.get(CONTROL_CAPABILITY), 'and answers its picker');
      });

      test('a picker the driver already narrowed is not set again', async () => {
        const homey: FakeHomey = fakeHomey({ app: { [kind.registryKey]: registry([]) } });
        const modes = kind.name === 'daylight' ? ['after', 'none'] : ['after', 'before', 'none'];
        const options = kind.name === 'daylight' ? { values: modes.map(id => ({ id, title: { en: id } })) } : {};
        const instance = makeDevice(kind.Cls, homey, {
          id: `lk-${kind.name}-1`, store: { [kind.storeKey]: await kind.plan() },
          capabilities: ['onoff', CONTROL_CAPABILITY], capabilityOptions: { [CONTROL_CAPABILITY]: options },
        }) as Device & Record<string, any>;
        await instance.onInit();
        assert.deepEqual(instance.fake.capabilityOptions.get(CONTROL_CAPABILITY), options);
        assert.equal(instance.logs.some((line: string) => line.startsWith('Narrowed')), false);
      });
    }

    test('with nothing stored it says so, and registers nothing', async () => {
      const events: Event[] = [];
      const instance = device(kind.Cls, `lk-${kind.name}-1`, {}, { [kind.registryKey]: registry(events) }, ['onoff']);
      await instance.onInit();
      assert.equal(instance.fake.available, false);
      assert.equal(instance.fake.unavailableMessage, translate(instance.missingKey));
      assert.equal(events.some(([name]) => name === 'register'), false);
    });
  });
}

describe('the circadian registry adapter', () => {
  test('registers the EXPANDED plan as a circadian kind, and folds a runtime change back onto two ends', async () => {
    const reg = registry([]);
    const stored = await plans.circadian();
    const instance = device(CircadianDevice, 'lk-circ-1', { circadian: stored }, { curves: reg }, ['onoff']);
    await instance.onInit();

    const call = reg.registered[0]!;
    assert.ok(Array.isArray(call.plan.points) && call.plan.points.length > 0, 'the runtime takes points');
    assert.deepEqual(call.extra, ['circadian'], 'so diagnostics can tell it from a curve');

    // The runtime learned a lamp comes on from a colour write, and says so.
    await call.onPlanChange({ ...call.plan, preStage: true, preStageLights: ['l1'] });
    await settle(2);
    const persisted = instance.getStoreValue('circadian');
    assert.deepEqual(persisted.zones, stored.zones, 'still two ends, not points');
    assert.deepEqual(persisted.preStageLights, ['l1']);
    assert.equal(persisted.points, undefined);
  });

  test('the pause switch hands the runtime POINTS, never the stored two ends', async () => {
    const reg = registry([]);
    const instance = device(CircadianDevice, 'lk-circ-1', { circadian: await plans.circadian() }, { curves: reg }, ['onoff']);
    await instance.onInit();

    await instance.fake.listeners.get('onoff')!(false);
    const update = reg.get('lk-circ-1').updates[0];
    assert.ok(Array.isArray(update.points), 'the bug this adapter exists for: updatePlan got no points');
    assert.equal(update.enabled, false);
  });

  test('planOf folds onto the plan being applied, not the store it is replacing', () => {
    const instance = device(CircadianDevice, 'lk-circ-1', {}, { curves: registry([]) });
    assert.throws(() => instance.planOf({ currentPlan: { enabled: true, preStage: false } }, null),
      /no stored plan/);
    const base = { zones: { a: 1 }, enabled: true, preStage: false } as never;
    assert.deepEqual(instance.planOf({ currentPlan: { enabled: false, preStage: true } }, base),
      { zones: { a: 1 }, enabled: false, preStage: true });
  });
});

describe('a schedule device', () => {
  test('carries its Flows forward across an edit — its trigger names no remote', async () => {
    const reg = registry([]);
    const stored = { ...await plans.schedule(), managedFlows: [
      { flowId: 'f1', bindingKey: 'a:on', variantKey: 'at:20:00', fingerprint: 'x', managedVersion: 1, createdAt: 1 },
    ] };
    const instance = device(ScheduleDevice, 'lk-sched-1', { schedule: stored }, { schedules: reg }, ['onoff']);
    await instance.onInit();

    await instance.applyPlan({ ...stored, managedFlows: [] });
    assert.deepEqual(instance.getStoreValue('schedule').managedFlows.map((ref: { flowId: string }) => ref.flowId), ['f1']);
    assert.deepEqual(instance.rawFlowRefs().map((ref: { flowId: string }) => ref.flowId), ['f1']);
  });
});

// ------------------------------------------------------------------ the shell

describe('LightkeeperDevice, the SDK shell', () => {
  async function curveDevice() {
    const events: Event[] = [];
    const reg = registry(events);
    const instance = device(CurveDevice, 'lk-curv-1', { curve: await plans.curve() },
      { curves: reg, bridge: bridge(events) }, ['onoff']);
    await instance.onInit();
    return { instance, reg, events };
  }

  test('the device id is data.id, and translate is homey.__ made plural-aware', async () => {
    const { instance } = await curveDevice();
    assert.equal(instance.deviceId, 'lk-curv-1');
    assert.equal(instance.translate('state.noCurve'), translate('state.noCurve'));
    // A plural group picks its form by `count` (lib/support/i18n.ts), so a
    // counted StateDetail from lib/ is grammatical without knowing it is one.
    assert.equal(instance.translate('review.someLights', { count: 3 }), translate('review.someLights.other', { count: 3 }));
    assert.equal(instance.translate('targets.someLights', { count: 1 }), '1 light');
    assert.equal(instance.translate('no.such.key'), 'no.such.key');
  });

  test('a rename reaches the runtime; a delete destroys it and forgets its journal', async () => {
    const { instance, reg, events } = await curveDevice();
    const runtime = reg.get('lk-curv-1');
    await instance.onRenamed();
    assert.equal(runtime.reconciled, 1);

    await instance.onDeleted();
    assert.equal(runtime.destroyed, 1);
    assert.deepEqual(events.slice(-2), [['unregister', 'lk-curv-1'], ['forget', 'lk-curv-1']]);
  });

  test('uninit unregisters, and removeFlows is the bridge\'s', async () => {
    const { instance, events } = await curveDevice();
    await instance.onUninit();
    assert.deepEqual(events.at(-1), ['unregister', 'lk-curv-1']);
    assert.equal(await instance.removeFlows([{ flowId: 'x' }]), 1);
    assert.deepEqual(events.at(-1), ['removeAll', ['x']]);
  });

  test('a runtime state after apply decides availability, translated', async () => {
    const events: Event[] = [];
    const reg = registry(events, { state: 'needs_repair' });
    const instance = device(CurveDevice, 'lk-curv-1', {}, { curves: reg }, ['onoff']);
    await instance.onInit();
    await instance.applyPlan(await plans.curve());
    assert.equal(instance.fake.available, false);
    assert.equal(instance.fake.unavailableMessage, translate('state.needsRepair'));
  });
});
