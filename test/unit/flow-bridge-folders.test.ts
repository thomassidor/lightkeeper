import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { ManagedFlowReference } from '../../lib/profiles/controller-profile';
import type { SelectableInput } from '../../lib/inputs/selectable-input';

/**
 * Where a generated flow LIVES.
 *
 * Generated flows are grouped one folder per Lightkeeper device, nested inside
 * the app's own folder. Nothing about ownership may depend on that — a flow is
 * ours because our bridge action carries the controller id — so these tests
 * exist to pin the two rules that are easy to break in the other direction:
 *
 *   - a flow is only ever moved OUT of our own root folder. One the user filed
 *     somewhere of their own stays where they put it (README's promise), and
 *     hasBeenUserEdited() deliberately never compares folders, so nothing else
 *     would catch it.
 *   - a folder failure NEVER blocks a flow write. Folders are presentation.
 *
 * Before this, no test asserted that a created flow carried a folder at all.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const CONTROLLER = 'ctrl-1';
const DEVICE = 'device-1';
const BINDING_KEY = 'n2_on|press';
const TRIGGER_ID = `homey:device:${DEVICE}:n2_on`;

const cardId = (shortId: string) => `${APP_ID}:${shortId}`;

const INPUT: SelectableInput = {
  key: BINDING_KEY,
  controlId: 'up',
  label: 'Up — Press',
  action: 'press',
  carriesMagnitude: false,
  binding: {
    kind: 'flow_fixed',
    cardId: TRIGGER_ID,
    cardOwnerUri: `homey:flowcardtrigger:${TRIGGER_ID}`,
    args: {},
  },
};

/** A generated flow exactly as sync() would find it again — not user-edited. */
function liveFlow(id: string, folder: string | null, controller = CONTROLLER) {
  return {
    id,
    name: 'Lightkeeper — STYRBAR: Up — Press',
    folder,
    trigger: { id: TRIGGER_ID, args: {} },
    actions: [{
      id: cardId('bridge_event'),
      args: { controller, event_key: BINDING_KEY },
      droptoken: null,
    }],
  };
}

const reference = (flowId: string): ManagedFlowReference => ({
  flowId,
  bindingKey: BINDING_KEY,
  variantKey: 'fixed',
  fingerprint: 'fp-1',
  managedVersion: 1,
  createdAt: 1,
});

interface FolderRow { id: string; name: string; parent: string | null }

/**
 * A Homey whose flows and folders actually change when written to, so a test
 * can assert the END STATE rather than a sequence of calls.
 */
function harness(options: {
  folders?: FolderRow[];
  flows?: Array<ReturnType<typeof liveFlow>>;
  failFolders?: boolean;
} = {}) {
  const folders = new Map((options.folders ?? []).map(f => [f.id, { ...f }]));
  const flows = new Map((options.flows ?? []).map(f => [f.id, { ...f } as any]));
  const calls = { createdFolders: [] as any[], deletedFolders: [] as string[], renamed: [] as any[] };
  let next = 0;
  const id = (prefix: string) => `${prefix}-${(next += 1)}`;

  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };

  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => Object.fromEntries(flows),

      getFlowFolders: async () => {
        if (options.failFolders) throw new Error('403 Missing Scopes');
        return Object.fromEntries(folders);
      },
      createFlowFolder: async ({ flowfolder }: any) => {
        if (options.failFolders) throw new Error('403 Missing Scopes');
        const row = { id: id('folder'), name: flowfolder.name, parent: flowfolder.parent ?? null };
        folders.set(row.id, row);
        calls.createdFolders.push({ ...row });
        return row;
      },
      updateFlowFolder: async ({ id: folderId, flowfolder }: any) => {
        const row = folders.get(folderId)!;
        Object.assign(row, flowfolder);
        calls.renamed.push({ id: folderId, ...flowfolder });
        return row;
      },
      deleteFlowFolder: async ({ id: folderId }: any) => {
        folders.delete(folderId);
        calls.deletedFolders.push(folderId);
      },

      createFlow: async ({ flow }: any) => {
        const row = { ...flow, id: id('flow'), folder: flow.folder ?? null };
        flows.set(row.id, row);
        return row;
      },
      updateFlow: async ({ id: flowId, flow }: any) => {
        Object.assign(flows.get(flowId)!, flow);
      },
      deleteFlow: async ({ id: flowId }: any) => { flows.delete(flowId); },
    },
  };

  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return {
    bridge: new FlowBridgeManager(api, APP_ID, () => { /* quiet */ }),
    folders, flows, calls,
    folderNamed: (name: string) => [...folders.values()].find(f => f.name === name),
  };
}

const syncRequest = (deviceName: string, existing: ManagedFlowReference[] = []) => ({
  controllerId: CONTROLLER,
  sourceName: 'STYRBAR',
  deviceName,
  fingerprint: 'fp-1',
  mapped: [INPUT],
  existing,
});

const ROOT: FolderRow = { id: 'root', name: 'Lightkeeper', parent: null };

describe('placing a generated flow', () => {
  test('a new flow lands in a folder named after the DEVICE, nested under Lightkeeper', async () => {
    const h = harness();

    await h.bridge.sync(syncRequest('Kitchen dial'));

    const root = h.folderNamed('Lightkeeper')!;
    const child = h.folderNamed('Kitchen dial')!;
    assert.equal(root.parent, null, 'the app folder sits at the top level');
    assert.equal(child.parent, root.id, 'the device folder nests inside it');
    assert.equal([...h.flows.values()][0]!.folder, child.id);
  });

  test('the device folder is named after the device, not the source remote', async () => {
    const h = harness();

    await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.equal(h.folderNamed('STYRBAR'), undefined);
  });

  test('an existing device folder is reused rather than duplicated', async () => {
    const h = harness({ folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }] });

    await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.deepEqual(h.calls.createdFolders, [], 'nothing new was created');
    assert.equal([...h.flows.values()][0]!.folder, 'kitchen');
  });

  test('a same-named folder under a DIFFERENT parent is not mistaken for ours', async () => {
    // Lookup keys on name AND parent. Without the parent check, a folder the
    // user happens to have named "Kitchen dial" elsewhere collects our flows.
    const h = harness({
      folders: [ROOT, { id: 'theirs', name: 'Kitchen dial', parent: 'somewhere-else' }],
    });

    await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.equal(h.calls.createdFolders.length, 1);
    assert.equal(h.calls.createdFolders[0].parent, 'root');
    assert.notEqual([...h.flows.values()][0]!.folder, 'theirs');
  });

  test('a folder named Lightkeeper that is NOT top-level is not taken for the app folder', async () => {
    // Same trap one level up: matching the root on name alone would nest every
    // device folder inside whatever the user called "Lightkeeper".
    const h = harness({ folders: [{ id: 'decoy', name: 'Lightkeeper', parent: 'somewhere-else' }] });

    await h.bridge.sync(syncRequest('Kitchen dial'));

    const root = [...h.folders.values()].find(f => f.name === 'Lightkeeper' && f.parent === null);
    assert.ok(root, 'a real top-level app folder was created');
    assert.equal(h.folderNamed('Kitchen dial')!.parent, root!.id);
  });
});

describe('flows that already exist', () => {
  test('one still sitting in the flat app folder is moved into its device folder', async () => {
    // The upgrade path: before per-device folders every flow was created in the
    // root, and a reused flow is never rewritten, so it would stay there.
    const h = harness({ folders: [ROOT], flows: [liveFlow('flow-1', 'root')] });

    const result = await h.bridge.sync(syncRequest('Kitchen dial', [reference('flow-1')]));

    assert.equal(result.reused, 1);
    assert.equal(h.flows.get('flow-1')!.folder, h.folderNamed('Kitchen dial')!.id);
  });

  test('one in no folder at all is moved too', async () => {
    const h = harness({ folders: [ROOT], flows: [liveFlow('flow-1', null)] });

    await h.bridge.sync(syncRequest('Kitchen dial', [reference('flow-1')]));

    assert.equal(h.flows.get('flow-1')!.folder, h.folderNamed('Kitchen dial')!.id);
  });

  test('one that looks user-edited is not filed either', async () => {
    // "Left alone" means left alone. The device goes to repair; its flow is not
    // quietly rearranged underneath the user in the meantime.
    const edited = { ...liveFlow('flow-1', 'root'), trigger: { id: 'homey:device:other:n2_on', args: {} } };
    const h = harness({ folders: [ROOT], flows: [edited] });

    const result = await h.bridge.sync(syncRequest('Kitchen dial', [reference('flow-1')]));

    assert.deepEqual(result.userEdited, ['flow-1']);
    assert.equal(h.flows.get('flow-1')!.folder, 'root');
  });

  test('one the USER moved elsewhere stays exactly where they put it', async () => {
    // README: "any folder you moved those Flows into survives". Nothing else
    // guards this — hasBeenUserEdited() never looks at a flow's folder.
    const h = harness({
      folders: [ROOT, { id: 'mine', name: 'My evening flows', parent: null }],
      flows: [liveFlow('flow-1', 'mine')],
    });

    const result = await h.bridge.sync(syncRequest('Kitchen dial', [reference('flow-1')]));

    assert.equal(result.reused, 1);
    assert.equal(h.flows.get('flow-1')!.folder, 'mine');
  });
});

describe('renaming the device', () => {
  test('renames its folder rather than moving every flow', async () => {
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'kitchen')],
    });

    await h.bridge.sync(syncRequest('Hallway dial', [reference('flow-1')]));

    assert.deepEqual(h.calls.renamed, [{ id: 'kitchen', name: 'Hallway dial' }]);
    assert.deepEqual(h.calls.createdFolders, [], 'no second folder appeared');
    assert.equal(h.flows.get('flow-1')!.folder, 'kitchen', 'the flow never moved');
  });

  test('a folder holding ANOTHER device\'s flows is left alone', async () => {
    // Two Lightkeeper devices the user gave the same name share a folder.
    // Without this guard each renames it back on every reconcile, forever.
    const h = harness({
      folders: [ROOT, { id: 'shared', name: 'Dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'shared'), liveFlow('flow-2', 'shared', 'ctrl-2')],
    });

    await h.bridge.sync(syncRequest('Hallway dial', [reference('flow-1')]));

    assert.deepEqual(h.calls.renamed, []);
    assert.equal(h.folders.get('shared')!.name, 'Dial');
  });
});

describe('cleaning up after a deletion', () => {
  test('deleting a device removes its now-empty folder, but keeps the app folder', async () => {
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'kitchen')],
    });

    const deleted = await h.bridge.removeAll([reference('flow-1')]);

    assert.equal(deleted, 1);
    assert.deepEqual(h.calls.deletedFolders, ['kitchen']);
    assert.ok(h.folders.has('root'), 'the app folder is the anchor the next device resolves against');
  });

  test('a folder that still holds something is never deleted', async () => {
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'kitchen'), liveFlow('flow-2', 'kitchen', 'ctrl-2')],
    });

    await h.bridge.removeAll([reference('flow-1')]);

    assert.deepEqual(h.calls.deletedFolders, []);
  });

  test('the orphan sweep clears the folders it empties', async () => {
    const h = harness({
      folders: [ROOT, { id: 'gone', name: 'Deleted dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'gone', 'ctrl-vanished')],
    });

    const result = await h.bridge.sweepOrphans(new Set([CONTROLLER]));

    assert.equal(result.deleted, 1);
    assert.deepEqual(h.calls.deletedFolders, ['gone']);
  });
});

describe('folders are never allowed to break flows', () => {
  test('a Homey that refuses every folder call still gets its flow', async () => {
    // The whole folder layer is organisational. A user whose key cannot write
    // folders must still end up with working flows.
    const h = harness({ failFolders: true });

    const result = await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.equal(result.created, 1);
    assert.equal([...h.flows.values()][0]!.folder, null, 'created without a folder, not refused');
  });

  test('a device with no name yet still gets a folder', async () => {
    // createFlowFolder requires a name string; an empty one falls back.
    const h = harness();

    await h.bridge.sync(syncRequest('   '));

    assert.equal(h.calls.createdFolders.length, 1, 'the root doubles as the fallback folder');
  });
});
