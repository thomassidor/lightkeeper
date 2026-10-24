import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CredentialService, type CredentialStatus } from '../../lib/credential-service';
import { HomeyApiService } from '../../lib/homey-api-service';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';

/**
 * A folder refusal is not a credential verdict.
 *
 * Folders are presentation only (CLAUDE.md, "Folder work never blocks a Flow
 * write"), and the folder manager has always swallowed its own failures. But it
 * reached the Homey through `HomeyApiService.withWriteClient`, which CLASSIFIES
 * every failure app-wide (platform §2) before the caller's catch runs — so a
 * folder delete refused with "Missing Scopes" published `insufficient_scope` to
 * every device. On a create pass the Flow write that followed published `valid`
 * again; on the two DELETE paths (a device's removal and the orphan sweep)
 * nothing followed, so every Flow-owning device sat in `needs_credential` after
 * a removal that had succeeded, until the app restarted.
 *
 * Everything here runs through a REAL `CredentialService` and the REAL
 * `withWriteClient`: a pass-through write client, which every other bridge
 * harness uses, cannot see a verdict at all.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const OWNER = 'lk-ctrl-1755500000000-100001';
const GONE = 'lk-ctrl-1755500000000-999999';
const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:11111111-2222-3333-4444-555555555555:'
  + '0123456789abcdef0123456789abcdef01234567';
const cardId = (shortId: string) => `${APP_ID}:${shortId}`;

/** What a Homey says to a key whose session cannot write the thing asked for. */
function missingScopes(): Error {
  // The key in the message as well: an upstream error may quote the request.
  return Object.assign(new Error(`Missing Scopes (token ${KEY})`), { statusCode: 403 });
}

function generated(id: string, controller: string, folder: string) {
  return {
    id,
    name: `Lightkeeper — ${id}`,
    folder,
    trigger: { id: 'homey:device:remote:n2_on', args: {} },
    conditions: [],
    actions: [{ id: cardId('bridge_event'), args: { controller, event_key: 'k' } }],
  };
}

function rig(options: {
  flows?: Record<string, any>;
  failFolderDelete?: boolean;
  failFolderCreate?: boolean;
  failFlowDelete?: boolean;
} = {}) {
  const flows: Record<string, any> = { ...(options.flows ?? {}) };
  const folders: Record<string, any> = {
    root: { id: 'root', name: 'Lightkeeper', parent: null },
    kitchen: { id: 'kitchen', name: 'Kitchen dial', parent: 'root' },
  };
  if (options.failFolderCreate) delete folders.root;
  const statuses: CredentialStatus[] = [];
  const logged: string[] = [];
  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };
  let next = 0;

  const client = {
    destroy: () => undefined,
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => ({ ...flows }),
      getFlow: async ({ id }: { id: string }) => {
        if (!flows[id]) throw Object.assign(new Error(`404 Not Found: Flow with ID ${id}`), { statusCode: 404 });
        return flows[id];
      },
      getFlowFolders: async () => ({ ...folders }),
      createFlowFolder: async ({ flowfolder }: any) => {
        if (options.failFolderCreate) throw missingScopes();
        const row = { id: `folder-${(next += 1)}`, name: flowfolder.name, parent: flowfolder.parent ?? null };
        folders[row.id] = row;
        return row;
      },
      updateFlowFolder: async ({ id, flowfolder }: any) => ({ ...(folders[id] = { ...folders[id], ...flowfolder }) }),
      deleteFlowFolder: async ({ id }: { id: string }) => {
        if (options.failFolderDelete) throw missingScopes();
        delete folders[id];
      },
      createFlow: async ({ flow }: any) => {
        const row = { ...flow, id: `flow-${(next += 1)}`, folder: flow.folder ?? null };
        flows[row.id] = row;
        return row;
      },
      updateFlow: async ({ id, flow }: any) => { flows[id] = { ...flows[id], ...flow }; },
      deleteFlow: async ({ id }: { id: string }) => {
        if (options.failFlowDelete) throw missingScopes();
        delete flows[id];
      },
    },
  };

  const store = new Map<string, unknown>([['flowWriteApiKey', KEY]]);
  const credentials = new CredentialService({
    settings: {
      get: k => store.get(k),
      set: (k, v) => { store.set(k, v); },
      unset: k => { store.delete(k); },
    },
    createWriteClient: async () => client,
    getLocalAddress: async () => 'http://127.0.0.1:80',
    log: (...args) => { logged.push(args.map(String).join(' ')); },
    onStatusChange: status => { statuses.push(status); },
  });
  // Only the READ client is replaced; `withWriteClient` and everything behind
  // it is the shipped code.
  class Service extends HomeyApiService {
    protected override async createAppApi(): Promise<any> { return client; }
  }
  const api = new Service({ api: {} }, credentials);
  const bridge = new FlowBridgeManager(api, APP_ID, (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });

  // A key already known good, as it is once the app has validated it.
  credentials.reportSuccess();
  statuses.length = 0;

  return { bridge, credentials, statuses, logged, flows, folders };
}

const ref = (flowId: string) => ({
  flowId, bindingKey: 'k', variantKey: 'fixed', fingerprint: 'fp', managedVersion: 1, createdAt: 1,
});

describe('a refused FOLDER write publishes no credential verdict', () => {
  test('deleting a device: the Flow goes, the folder stays, and the key is still valid', async () => {
    const h = rig({ flows: { f1: generated('f1', OWNER, 'kitchen') }, failFolderDelete: true });

    const removed = await h.bridge.removeAll(OWNER, [ref('f1')]);

    assert.equal(removed, 1);
    assert.equal(h.flows.f1, undefined, 'the Flow was deleted');
    assert.ok(h.folders.kitchen, 'the folder delete was refused, and that is all');
    assert.deepEqual(h.statuses, [], 'nothing was published to the devices');
    assert.equal(h.credentials.getStatus().valid, true);
  });

  test('the orphan sweep: the same', async () => {
    const h = rig({ flows: { f1: generated('f1', GONE, 'kitchen') }, failFolderDelete: true });

    const result = await h.bridge.sweepOrphans(new Set([OWNER]));

    assert.equal(result.deleted, 1);
    assert.deepEqual(h.statuses, []);
    assert.equal(h.credentials.getStatus().valid, true);
  });

  test('a refused root create on a reconcile publishes nothing either, and the Flow is still made', async () => {
    const h = rig({ failFolderCreate: true });

    const result = await h.bridge.sync({
      controllerId: OWNER, deviceName: 'Kitchen dial', sourceName: 'STYRBAR', fingerprint: 'fp',
      existing: [],
      mapped: [{
        key: 'k', label: 'Up — Press',
        binding: {
          kind: 'flow_fixed', cardId: 'homey:device:remote:n2_on',
          cardOwnerUri: 'homey:flowcardtrigger:homey:device:remote:n2_on', fixedArgs: {},
        },
      }],
    });

    assert.equal(result.created, 1);
    assert.deepEqual(h.statuses, [], 'no insufficient_scope, then valid: no blink at all');
  });

  test('a folder failure is still redacted on its way to the log', async () => {
    const h = rig({ flows: { f1: generated('f1', OWNER, 'kitchen') }, failFolderDelete: true });
    await h.bridge.removeAll(OWNER, [ref('f1')]);

    const line = h.logged.find(entry => entry.includes('Could not delete the empty folder'));
    assert.ok(line, h.logged.join('\n'));
    assert.equal(line.includes(KEY), false, line);
    assert.equal(line.includes('0123456789abcdef0123456789abcdef01234567'), false, line);
  });
});

describe('a refused FLOW write is still classified app-wide (platform §2)', () => {
  test('a Flow delete refused with Missing Scopes publishes insufficient_scope', async () => {
    const h = rig({ flows: { f1: generated('f1', OWNER, 'kitchen') }, failFlowDelete: true });

    const removed = await h.bridge.removeAll(OWNER, [ref('f1')]);

    assert.equal(removed, 0);
    assert.deepEqual(h.statuses.map(s => (s.valid ? 'valid' : s.failure)), ['insufficient_scope']);
    assert.equal(h.credentials.getStatus().failure, 'insufficient_scope');
  });
});
