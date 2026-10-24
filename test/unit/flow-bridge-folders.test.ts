import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import { HomeyApiService } from '../../lib/homey-api-service';
import { CredentialService, type CredentialStatus } from '../../lib/credential-service';
import { NO_CACHE } from '../../lib/flow-card-catalogue';
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
 *     somewhere of their own stays where they put it (README.md's "What you
 *     can rely on" promises this), and
 *     hasBeenUserEdited() deliberately never compares folders, so nothing else
 *     would catch it.
 *   - a folder failure NEVER blocks a flow write. Folders are presentation.
 *
 * Before this, no test asserted that a created flow carried a folder at all.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
// Real-shaped, as the drivers mint them: the orphan sweep will only delete a
// flow whose controller argument matches `lk-<kind>-<ms>-<rand>`, so a
// placeholder id here would make the sweep test silently pass by deleting
// nothing at all.
const CONTROLLER = 'lk-ctrl-1755500000000-100001';
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
    fixedArgs: {},
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
 * The folder calls a test can make fail, ONE AT A TIME.
 *
 * `failFolders` fails `getFlowFolders` first, so `load()` degrades to "no
 * folders" and no other folder method ever runs under failure — which left the
 * catch in every one of them unpinned. Each of these reaches exactly one:
 *
 *   createFlowFolder    resolveForDevice's create (or load()'s, without a root)
 *   getFlowFolders      every folder read; a predicate picks which one
 *   updateFlowFolder    renameIfOurs
 *   placeFlow           placeExisting — an updateFlow that carries a folder
 *   deleteFlowFolder    cleanUpEmpty's inner delete
 *   getFlowsAfterDelete cleanUpEmpty's re-read of the flows, which is the only
 *                       getFlows that comes after a deleteFlow
 */
type FolderCall =
  | 'createFlowFolder' | 'getFlowFolders' | 'updateFlowFolder' | 'placeFlow'
  | 'deleteFlowFolder' | 'getFlowsAfterDelete';

const refused = () => Object.assign(new Error('403 Missing Scopes'), { statusCode: 403 });

/**
 * A Homey whose flows and folders actually change when written to, so a test
 * can assert the END STATE rather than a sequence of calls.
 *
 * `api` swaps the pass-through service for another one built over the same
 * client — the REAL `HomeyApiService`, in the platform §2 test at the bottom.
 */
function harness(options: {
  folders?: FolderRow[];
  flows?: Array<ReturnType<typeof liveFlow>>;
  failFolders?: boolean;
  fail?: Partial<Record<FolderCall, (arg: any) => boolean>>;
  api?: (client: any) => HomeyApiService;
} = {}) {
  const folders = new Map((options.folders ?? []).map(f => [f.id, { ...f }]));
  const flows = new Map((options.flows ?? []).map(f => [f.id, { ...f } as any]));
  const calls = {
    createdFolders: [] as any[], deletedFolders: [] as string[], renamed: [] as any[],
    /** The argument of every `getFlowFolders` call — platform §15 wants `NO_CACHE` in each. */
    folderReads: [] as unknown[],
  };
  let next = 0;
  let flowDeletes = 0;
  const id = (prefix: string) => `${prefix}-${(next += 1)}`;
  const failing = (call: FolderCall, arg?: unknown) => options.fail?.[call]?.(arg) === true;

  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };

  const client = {
    flow: {
      // By name first, as production asks (platform §3: echoed, never built).
      getFlowCardAction: async ({ uri, id: shortId }: { uri: string; id: string }) =>
        cardByName(actions, uri, shortId),
      getFlowCardActions: async () => actions,
      getFlows: async () => {
        if (flowDeletes > 0 && failing('getFlowsAfterDelete')) throw new Error('socket hang up');
        return Object.fromEntries(flows);
      },

      getFlowFolders: async (opts?: unknown) => {
        calls.folderReads.push(opts);
        if (options.failFolders || failing('getFlowFolders', opts)) throw refused();
        return Object.fromEntries(folders);
      },
      createFlowFolder: async ({ flowfolder }: any) => {
        if (options.failFolders || failing('createFlowFolder', flowfolder)) throw refused();
        const row = { id: id('folder'), name: flowfolder.name, parent: flowfolder.parent ?? null };
        folders.set(row.id, row);
        calls.createdFolders.push({ ...row });
        return row;
      },
      updateFlowFolder: async ({ id: folderId, flowfolder }: any) => {
        if (failing('updateFlowFolder', { id: folderId, ...flowfolder })) throw refused();
        const row = folders.get(folderId)!;
        Object.assign(row, flowfolder);
        calls.renamed.push({ id: folderId, ...flowfolder });
        return row;
      },
      deleteFlowFolder: async ({ id: folderId }: any) => {
        if (failing('deleteFlowFolder', folderId)) throw refused();
        folders.delete(folderId);
        calls.deletedFolders.push(folderId);
      },

      createFlow: async ({ flow }: any) => {
        const row = { ...flow, id: id('flow'), folder: flow.folder ?? null };
        flows.set(row.id, row);
        return row;
      },
      updateFlow: async ({ id: flowId, flow }: any) => {
        if ('folder' in flow && failing('placeFlow', { id: flowId, ...flow })) throw refused();
        Object.assign(flows.get(flowId), flow);
      },
      deleteFlow: async ({ id: flowId }: any) => { flowDeletes += 1; flows.delete(flowId); },
    },
  };

  const api = options.api?.(client) ?? {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return {
    bridge: new FlowBridgeManager(api, APP_ID, () => { /* quiet */ }),
    folders, flows, calls,
    folderNamed: (name: string) => [...folders.values()].find(f => f.name === name),
  };
}

/** The by-name lookup `bridgeCards()` tries first: our own card, or a 404. */
function cardByName(actions: Record<string, { id: string; uri: string }>, uri: string, shortId: string) {
  const card = uri === `homey:app:${APP_ID}`
    ? Object.values(actions).find(c => c.id === cardId(shortId))
    : undefined;
  if (!card) throw Object.assign(new Error(`404 Not Found: FlowCardAction with ID ${shortId}`), { statusCode: 404 });
  return card;
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
    assert.equal(h.folderNamed('Kitchen dial')!.parent, root.id);
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
    // README.md: "A Flow you filed somewhere yourself stays there ... only ever
    // out of the Lightkeeper folder, never out of one of yours." Nothing else
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
      flows: [liveFlow('flow-1', 'shared'), liveFlow('flow-2', 'shared', 'lk-ctrl-1755500000000-100002')],
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

    const deleted = await h.bridge.removeAll(CONTROLLER, [reference('flow-1')]);

    assert.equal(deleted, 1);
    assert.deepEqual(h.calls.deletedFolders, ['kitchen']);
    assert.ok(h.folders.has('root'), 'the app folder is the anchor the next device resolves against');
  });

  test('a folder that still holds something is never deleted', async () => {
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'kitchen'), liveFlow('flow-2', 'kitchen', 'lk-ctrl-1755500000000-100002')],
    });

    await h.bridge.removeAll(CONTROLLER, [reference('flow-1')]);

    assert.deepEqual(h.calls.deletedFolders, []);
  });

  /**
   * A DELETE never creates a folder, and there are two ways that used to
   * happen.
   *
   * `removeAll()` and the orphan sweep call `load()` only to find empty device
   * folders to clean up — they never place a flow. So a user who deleted the
   * `Lightkeeper` folder and then deleted their last device got an empty root
   * recreated BY the deletion. Worse, with a dead API key the same path
   * attempted a folder WRITE from a delete, and `withWriteClient` classifies
   * that failure app-wide before the folder manager's own catch can swallow
   * it — so tidying up after a removal could flip every device to
   * `needs_credential`.
   */
  test('deleting the last device does not recreate a root the user removed', async () => {
    const h = harness({
      // No ROOT: the user deleted the Lightkeeper folder in the Flow editor.
      folders: [{ id: 'kitchen', name: 'Kitchen dial', parent: null }],
      flows: [liveFlow('flow-1', 'kitchen')],
    });

    const deleted = await h.bridge.removeAll(CONTROLLER, [reference('flow-1')]);

    assert.equal(deleted, 1, 'the flow must still be deleted');
    assert.deepEqual(
      h.calls.createdFolders, [],
      'a deletion recreated the folder the user had just removed',
    );
  });

  test('and the orphan sweep does not either', async () => {
    const h = harness({
      folders: [{ id: 'gone', name: 'Deleted dial', parent: null }],
      flows: [liveFlow('flow-1', 'gone', 'lk-ctrl-1755500000000-999999')],
    });

    const result = await h.bridge.sweepOrphans(new Set([CONTROLLER]));

    assert.equal(result.deleted, 1);
    assert.deepEqual(h.calls.createdFolders, []);
  });

  test('the orphan sweep clears the folders it empties', async () => {
    const h = harness({
      folders: [ROOT, { id: 'gone', name: 'Deleted dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'gone', 'lk-ctrl-1755500000000-999999')],
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

/**
 * "Folder work never blocks a Flow write", one folder method at a time.
 *
 * The test above refuses EVERY folder call, and the first one refused is
 * `load()`'s read — so the view comes back empty and no other method runs
 * under failure at all. Each test here lets `load()` succeed and refuses
 * exactly one later call, which is the only way the catch inside that method
 * is ever reached. A catch that rethrew would surface as `sync()` or
 * `removeAll()` rejecting, with the Flow write it was meant to protect undone.
 */
describe('each folder method swallows its own failure', () => {
  test('a refused device-folder create still gets the flow, filed in no folder', async () => {
    // resolveForDevice's create. The root exists, so load() never writes.
    const h = harness({ folders: [ROOT], fail: { createFlowFolder: () => true } });

    const result = await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.equal(result.created, 1, 'the flow is created regardless');
    assert.equal([...h.flows.values()][0]!.folder, null, 'and simply filed nowhere');
  });

  test('a failed re-read before creating falls back to the snapshot, so no duplicate is made', async () => {
    // findByName re-reads the folders live inside the lock. When that read
    // fails it must answer from the view load() already holds — which here
    // has the device's folder in it — rather than throw or create a second one.
    let reads = 0;
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      fail: { getFlowFolders: () => (reads += 1) > 1 },
    });

    const result = await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.equal(reads, 2, 'load() read once, and the re-read was the one refused');
    assert.equal(result.created, 1);
    assert.deepEqual(h.calls.createdFolders, [], 'the snapshot already knew the folder');
    assert.equal([...h.flows.values()][0]!.folder, 'kitchen');
  });

  test('a refused rename leaves the flow reused and the folder as it was', async () => {
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'kitchen')],
      fail: { updateFlowFolder: () => true },
    });

    const result = await h.bridge.sync(syncRequest('Hallway dial', [reference('flow-1')]));

    assert.equal(result.reused, 1);
    assert.deepEqual(result.references.map(r => r.flowId), ['flow-1']);
    assert.equal(h.folders.get('kitchen')!.name, 'Kitchen dial', 'cosmetic, and left for the next pass');
    assert.equal(h.flows.get('flow-1')!.folder, 'kitchen');
  });

  test('a refused move leaves the flow reused exactly where it was', async () => {
    // placeExisting runs INSIDE sync's try, so a catch that rethrew would also
    // send the pass through compensation and lose its references.
    const h = harness({
      folders: [ROOT],
      flows: [liveFlow('flow-1', 'root')],
      fail: { placeFlow: () => true },
    });

    const result = await h.bridge.sync(syncRequest('Kitchen dial', [reference('flow-1')]));

    assert.equal(result.reused, 1);
    assert.deepEqual(result.references.map(r => r.flowId), ['flow-1']);
    assert.ok(h.flows.has('flow-1'), 'a flow that would not move still works');
    assert.equal(h.flows.get('flow-1')!.folder, 'root');
  });

  test('a refused folder delete neither undoes the flow deletes nor stops the next folder', async () => {
    // cleanUpEmpty's INNER catch. Rethrown, the outer catch would swallow it —
    // so the visible difference is the second empty folder, left behind.
    const h = harness({
      folders: [
        ROOT,
        { id: 'kitchen', name: 'Kitchen dial', parent: 'root' },
        { id: 'kitchen-2', name: 'Kitchen dial 2', parent: 'root' },
      ],
      flows: [liveFlow('flow-1', 'kitchen'), liveFlow('flow-2', 'kitchen-2')],
      fail: { deleteFlowFolder: (folderId: string) => folderId === 'kitchen' },
    });

    const deleted = await h.bridge.removeAll(CONTROLLER, [reference('flow-1'), reference('flow-2')]);

    assert.equal(deleted, 2, 'both flows are gone and counted');
    assert.equal(h.flows.size, 0);
    assert.deepEqual(h.calls.deletedFolders, ['kitchen-2'], 'one refusal did not stop the next folder');
    assert.ok(h.folders.has('kitchen'), 'the refused one is simply still there');
  });

  test('an unreadable flow list after the deletes still settles removeAll', async () => {
    // cleanUpEmpty's OUTER catch: it cannot tell which folders are empty, so it
    // deletes none — and the flows it was cleaning up after stay deleted.
    const h = harness({
      folders: [ROOT, { id: 'kitchen', name: 'Kitchen dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'kitchen')],
      fail: { getFlowsAfterDelete: () => true },
    });

    const deleted = await h.bridge.removeAll(CONTROLLER, [reference('flow-1')]);

    assert.equal(deleted, 1);
    assert.equal(h.flows.has('flow-1'), false);
    assert.deepEqual(h.calls.deletedFolders, [], 'nothing deleted on a guess');
  });

  test('and the orphan sweep still reports what it deleted', async () => {
    const h = harness({
      folders: [ROOT, { id: 'gone', name: 'Deleted dial', parent: 'root' }],
      flows: [liveFlow('flow-1', 'gone', 'lk-ctrl-1755500000000-999999')],
      fail: { getFlowsAfterDelete: () => true },
    });

    const result = await h.bridge.sweepOrphans(new Set([CONTROLLER]));

    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(h.calls.deletedFolders, []);
  });
});

describe('the folder read opts out of the homey-api cache', () => {
  /**
   * Platform §15: `getFlowFolders` is a `getAll`, and `homey-api` retains
   * every `getAll` result for the life of the client unless told not to. The
   * source scan in flow-card-catalogue.test.ts used to excuse this call site
   * because a §15 comment sat a few lines above it, so dropping the flag went
   * unnoticed. This asserts what actually reaches the client.
   */
  test('every getFlowFolders call carries NO_CACHE, on the create path and the delete path', async () => {
    const h = harness({ folders: [ROOT], flows: [liveFlow('flow-1', 'root')] });

    await h.bridge.sync(syncRequest('Kitchen dial'));
    await h.bridge.removeAll(CONTROLLER, [reference('flow-1')]);

    assert.ok(h.calls.folderReads.length >= 3, 'load(), findByName() and the delete path all read');
    for (const opts of h.calls.folderReads) {
      assert.deepEqual(opts, { ...NO_CACHE });
    }
  });
});

/**
 * The folder layer through the REAL `HomeyApiService.withWriteClient`.
 *
 * Every other harness here hands the bridge a pass-through write client, and
 * the real one does something before the folder manager's catch ever runs: it
 * CLASSIFIES the failure app-wide (platform §2), and a "Missing Scopes" refusal
 * publishes `insufficient_scope` to every device through `onStatusChange`. So
 * the folder manager swallowing an error does not mean nobody saw it.
 *
 * What this pins is the END STATE on the create path only: after a refused
 * folder write the flow still exists, filed in no folder, and the key is
 * reported valid. The intermediate `insufficient_scope` publication that
 * happens today is deliberately NOT asserted: whether a folder-only refusal
 * should publish a credential verdict at all is being changed (on the delete
 * path, where no write follows, it leaves the key reported invalid after a
 * removal that succeeded — the situation `load()`'s docblock describes), and a
 * test pinning the sequence would lock in exactly that behaviour.
 */
describe('a folder refusal through the real write client (platform §2)', () => {
  function realService(statuses: CredentialStatus[]) {
    const store = new Map<string, unknown>([['flowWriteApiKey', 'user:session:secret']]);
    let credentials!: CredentialService;
    const api = (client: any) => {
      credentials = new CredentialService({
        settings: {
          get: k => store.get(k),
          set: (k, v) => { store.set(k, v); },
          unset: k => { store.delete(k); },
        },
        createWriteClient: async () => client,
        getLocalAddress: async () => 'http://127.0.0.1:80',
        log: () => { /* quiet */ },
        onStatusChange: status => { statuses.push(status); },
      });
      // Only the read client is replaced; withWriteClient is the real one.
      class Service extends HomeyApiService {
        protected override async createAppApi(): Promise<any> { return client; }
      }
      return new Service({ api: {} }, credentials);
    };
    return { api, credentials: () => credentials };
  }

  test('a refused root create still leaves the flow written and the key valid', async () => {
    const statuses: CredentialStatus[] = [];
    const real = realService(statuses);
    // No root yet, so load() writes one — and that write is refused.
    const h = harness({ fail: { createFlowFolder: () => true }, api: real.api });
    real.credentials().reportSuccess();

    const result = await h.bridge.sync(syncRequest('Kitchen dial'));

    assert.equal(result.created, 1, 'the flow is still created');
    assert.equal(h.flows.size, 1);
    assert.equal([...h.flows.values()][0]!.folder, null, 'filed in no folder');
    assert.equal(real.credentials().getStatus().valid, true, 'the key is reported working at the end');
  });
});
