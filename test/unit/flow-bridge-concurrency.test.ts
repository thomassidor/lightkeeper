import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowBridgeManager, type SyncRequest } from '../../lib/bridge/flow-bridge-manager';
import { FlowFolderManager } from '../../lib/bridge/flow-folder-manager';
import { KeyedMutex } from '../../lib/support/keyed-mutex';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { deferred, settle } from '../support/deferred';

/**
 * What happens when two passes overlap.
 *
 * At boot they routinely do, and the app itself is what makes them: a runtime
 * starts and reconciles; that reconcile's first `createFlow` is what proves the
 * API key can write; proving it flips the credential status; the status flip
 * fans out to every runtime and asks them all to reconcile. So the first pass
 * of the first device is still in flight when the second is requested, over the
 * same stored references — and both create.
 *
 * Three separate races, three separate guards:
 *
 *   sync per device      SingleFlight, in FlowBridgeManager.reconcile()
 *   root folder          KeyedMutex('flow-root'), inside FlowFolderManager.load()
 *   credential fan-out   a 250 ms trailing debounce in app.ts
 *
 * The first two are here. The third is in app.ts and is asserted by the shape
 * of the code rather than by this file — it needs a Homey instance.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const cardId = (short: string) => `${APP_ID}:${short}`;

function scheduleInput(key: string, time: string) {
  return {
    key,
    label: `Schedule ${key}`,
    variantKey: `at:${time}`,
    binding: {
      kind: 'flow_fixed' as const,
      cardId: 'homey:manager:cron:time_exactly',
      cardOwnerUri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
      fixedArgs: { time },
    },
  };
}

function request(overrides: Partial<SyncRequest> & Pick<SyncRequest, 'mapped'>): SyncRequest {
  return {
    controllerId: 'lk-sched-1-1',
    sourceName: 'Clock',
    deviceName: 'Evening lights',
    fingerprint: 'fp-1',
    existing: [],
    ...overrides,
  };
}

/**
 * A Homey whose flow reads can be held open, so a second caller is guaranteed
 * to arrive while the first is mid-pass.
 */
function harness() {
  const live: Record<string, any> = {};
  const folders: Record<string, any> = {};
  const foldersCreated: string[] = [];
  let nextFlowId = 1;
  let nextFolderId = 1;
  /** Set to hold every getFlows() call until resolved. */
  let gate: Promise<void> | null = null;

  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };

  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => {
        if (gate) await gate;
        return live;
      },
      getFlowFolders: async () => {
        if (gate) await gate;
        return folders;
      },
      createFlow: async ({ flow }: { flow: any }) => {
        const id = `flow-${nextFlowId++}`;
        live[id] = { id, ...flow };
        return { id };
      },
      createFlowFolder: async ({ flowfolder }: { flowfolder: any }) => {
        const id = `folder-${nextFolderId++}`;
        folders[id] = { id, name: flowfolder.name, parent: flowfolder.parent ?? null };
        foldersCreated.push(String(flowfolder.name));
        return folders[id];
      },
      updateFlowFolder: async ({ id, flowfolder }: { id: string; flowfolder: any }) => {
        folders[id] = { ...folders[id], ...flowfolder };
        return folders[id];
      },
      deleteFlowFolder: async ({ id }: { id: string }) => { delete folders[id]; },
      updateFlow: async ({ id, flow }: { id: string; flow: any }) => {
        live[id] = { ...live[id], ...flow };
        return live[id];
      },
      deleteFlow: async ({ id }: { id: string }) => { delete live[id]; },
    },
  };

  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return {
    live, folders, foldersCreated,
    setGate: (promise: Promise<void> | null) => { gate = promise; },
    api,
    bridge: new FlowBridgeManager(api, APP_ID, () => undefined),
  };
}

describe('overlapping reconciles for one device', () => {

  test('two overlapping passes produce one flow per binding, not two', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    // A stand-in for the device store. The runtime reads `managedFlows` off
    // its profile at the START of each pass and writes the result back at the
    // end, so it is `existing` that carries a pass's work to the next one —
    // and it is only ever fresh because single-flight guarantees the two
    // passes do not interleave. Sharing the first pass's promise instead
    // would skip the second pass entirely; running them concurrently would
    // have both read `[]` and both create.
    const device = { managedFlows: [] as any[] };
    const pass = async () => {
      const result = await h.bridge.sync(request({
        mapped: [scheduleInput('sched:0:on', '22:00')],
        existing: device.managedFlows,
      }));
      device.managedFlows = result.references;
      return result;
    };

    // Both requested before either can finish — the boot storm, exactly.
    const first = h.bridge.reconcile('lk-sched-1-1', pass);
    await settle();
    const second = h.bridge.reconcile('lk-sched-1-1', pass);
    await settle();

    h.setGate(null);
    hold.resolve();
    await Promise.all([first, second]);

    assert.equal(
      Object.keys(h.live).length, 1,
      'one binding, one flow — the second pass reused what the first created',
    );
    assert.equal(device.managedFlows.length, 1);
  });

  test('without serialisation the same two passes WOULD duplicate', async () => {
    // The counter-example, so the guarantee above is not mistaken for
    // something the rest of the code would give us anyway.
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    const device = { managedFlows: [] as any[] };
    const pass = async () => {
      const result = await h.bridge.sync(request({
        mapped: [scheduleInput('sched:0:on', '22:00')],
        existing: device.managedFlows,
      }));
      device.managedFlows = result.references;
      return result;
    };

    // Straight to sync(), bypassing reconcile().
    const both = Promise.all([pass(), pass()]);
    await settle();
    h.setGate(null);
    hold.resolve();
    await both;

    assert.equal(
      Object.keys(h.live).length, 2,
      'both read an empty store and both created — this is the bug reconcile() closes',
    );
  });

  test('a request arriving mid-pass is answered by a pass that reads the NEW state', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    const device = { managedFlows: [] as any[] };
    let desired = [scheduleInput('sched:0:on', '22:00')];
    const pass = async () => {
      const result = await h.bridge.sync(request({
        mapped: desired,
        existing: device.managedFlows,
      }));
      device.managedFlows = result.references;
      return result;
    };

    const first = h.bridge.reconcile('lk-sched-1-1', pass);
    await settle();

    // The user edits the schedule while the first pass is still in flight.
    // This is WHY the second request exists, so answering it with the first
    // pass's result would be answering a question nobody asked.
    desired = [scheduleInput('sched:0:on', '22:00'), scheduleInput('sched:0:off', '23:30')];
    const second = h.bridge.reconcile('lk-sched-1-1', pass);
    await settle();

    h.setGate(null);
    hold.resolve();

    const firstResult = await first;
    const secondResult = await second;

    assert.equal(firstResult.references.length, 1, 'the first pass answered the old state');
    assert.equal(secondResult.references.length, 2, 'the second saw the edit');
    assert.equal(Object.keys(h.live).length, 2, 'and the Homey ended up with both flows');
  });

  test('three overlapping requests cost two passes, not three', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    const device = { managedFlows: [] as any[] };
    let passes = 0;
    const pass = async () => {
      passes += 1;
      const result = await h.bridge.sync(request({
        mapped: [scheduleInput('sched:0:on', '22:00')],
        existing: device.managedFlows,
      }));
      device.managedFlows = result.references;
      return result;
    };

    const first = h.bridge.reconcile('lk-sched-1-1', pass);
    await settle();
    const rest = [
      h.bridge.reconcile('lk-sched-1-1', pass),
      h.bridge.reconcile('lk-sched-1-1', pass),
      h.bridge.reconcile('lk-sched-1-1', pass),
    ];
    await settle();

    h.setGate(null);
    hold.resolve();
    await Promise.all([first, ...rest]);

    assert.equal(passes, 2, 'one in flight plus one trailing re-run');
  });

  test('two different devices are not serialised against each other', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    const started: string[] = [];
    const pass = (id: string) => async () => {
      started.push(id);
      return h.bridge.sync(request({
        controllerId: id,
        deviceName: id,
        mapped: [scheduleInput('sched:0:on', '22:00')],
      }));
    };

    const a = h.bridge.reconcile('lk-sched-a', pass('a'));
    const b = h.bridge.reconcile('lk-sched-b', pass('b'));
    await settle();

    assert.deepEqual(started, ['a', 'b'], 'both are underway — one device must not block another');

    h.setGate(null);
    hold.resolve();
    await Promise.all([a, b]);
  });
});

describe('the app root folder is created exactly once', () => {

  test('concurrent load() calls do not create two Lightkeeper folders', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    // Two folder managers sharing one app-wide mutex, which is how the real
    // one is wired: FlowBridgeManager owns the mutex and hands it in.
    const mutex = new KeyedMutex();
    const one = new FlowFolderManager(h.api, () => undefined, mutex);
    const two = new FlowFolderManager(h.api, () => undefined, mutex);

    const first = one.load();
    await settle();
    const second = two.load();
    await settle();

    h.setGate(null);
    hold.resolve();

    const [viewA, viewB] = await Promise.all([first, second]);

    assert.deepEqual(h.foldersCreated, ['Lightkeeper'], 'read-then-create ran once');
    assert.equal(viewA.root, viewB.root, 'and both callers agree which folder is the root');
  });

  test('two devices reconciling at once share one root and get their own folders', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    const a = h.bridge.reconcile('lk-sched-a', () => h.bridge.sync(request({
      controllerId: 'lk-sched-a', deviceName: 'Kitchen', mapped: [scheduleInput('sched:0:on', '22:00')],
    })));
    await settle();
    const b = h.bridge.reconcile('lk-sched-b', () => h.bridge.sync(request({
      controllerId: 'lk-sched-b', deviceName: 'Hallway', mapped: [scheduleInput('sched:0:on', '07:00')],
    })));
    await settle();

    h.setGate(null);
    hold.resolve();
    await Promise.all([a, b]);

    assert.equal(
      h.foldersCreated.filter(name => name === 'Lightkeeper').length, 1,
      'one root, however many devices raced for it',
    );
    assert.ok(h.foldersCreated.includes('Kitchen'));
    assert.ok(h.foldersCreated.includes('Hallway'));
  });

  test('two devices the user gave the SAME name share one folder rather than making two', async () => {
    const h = harness();
    const hold = deferred();
    h.setGate(hold.promise);

    const a = h.bridge.reconcile('lk-sched-a', () => h.bridge.sync(request({
      controllerId: 'lk-sched-a', deviceName: 'Lights', mapped: [scheduleInput('sched:0:on', '22:00')],
    })));
    await settle();
    const b = h.bridge.reconcile('lk-sched-b', () => h.bridge.sync(request({
      controllerId: 'lk-sched-b', deviceName: 'Lights', mapped: [scheduleInput('sched:0:on', '07:00')],
    })));
    await settle();

    h.setGate(null);
    hold.resolve();
    await Promise.all([a, b]);

    assert.equal(
      h.foldersCreated.filter(name => name === 'Lights').length, 1,
      'resolveForDevice matches on name, so racing for one name must not make two folders',
    );
  });
});
