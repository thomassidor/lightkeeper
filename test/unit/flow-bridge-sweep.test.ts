import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * The orphan sweep is the only bulk-delete this app performs. It classifies a
 * generated Flow as an orphan by asking whether its controller id is in the set
 * of RUNNING controllers — which means an empty set makes every Flow look
 * orphaned. That is indistinguishable from "the runtimes have not registered
 * yet", so the sweep refuses rather than guessing.
 */

const APP_ID = 'com.thomassidor.lightlink';

function cardId(shortId: string) {
  return `${APP_ID}:${shortId}`;
}

function harness(flows: Record<string, unknown>) {
  const deleted: string[] = [];

  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };

  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => flows,
      deleteFlow: async ({ id }: { id: string }) => { deleted.push(id); },
    },
  };

  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  const bridge = new FlowBridgeManager(api, APP_ID, () => { /* quiet */ });
  return { bridge, deleted };
}

/** A generated flow that calls our bridge card on behalf of `controllerId`. */
function managedFlow(id: string, controllerId: string) {
  return {
    id,
    name: `Light Link — ${id}`,
    actions: [{ id: cardId('bridge_event'), args: { controller: controllerId, event_key: 'k' } }],
  };
}

describe('orphan sweep', () => {
  test('deletes flows whose controller is gone, keeps the rest', async () => {
    const h = harness({
      f1: managedFlow('f1', 'alive'),
      f2: managedFlow('f2', 'deleted-controller'),
      f3: { id: 'f3', name: 'Someone else’s flow', actions: [{ id: 'homey:manager:alarms:enable' }] },
    });

    const result = await h.bridge.sweepOrphans(new Set(['alive']));

    assert.deepEqual(h.deleted, ['f2']);
    assert.equal(result.deleted, 1);
    assert.equal(result.kept, 1);
    assert.equal(result.refused, undefined);
  });

  test('refuses to sweep when no controller is running', async () => {
    const h = harness({
      f1: managedFlow('f1', 'c1'),
      f2: managedFlow('f2', 'c2'),
    });

    const result = await h.bridge.sweepOrphans(new Set());

    assert.equal(result.refused, 'no_live_controllers');
    assert.deepEqual(h.deleted, [], 'nothing may be deleted on an empty live set');
    assert.equal(result.kept, 2);
  });

  test('an empty live set with nothing managed is not a refusal', async () => {
    const h = harness({
      f3: { id: 'f3', name: 'Unrelated', actions: [{ id: 'homey:manager:alarms:enable' }] },
    });

    const result = await h.bridge.sweepOrphans(new Set());

    assert.equal(result.refused, undefined);
    assert.equal(result.deleted, 0);
    assert.equal(result.kept, 0);
  });

  test('never touches a flow that does not call one of our cards', async () => {
    const h = harness({
      f1: managedFlow('f1', 'gone'),
      f2: { id: 'f2', name: 'User flow', actions: [{ id: 'homey:manager:speech:say' }] },
      f3: { id: 'f3', name: 'No actions' },
    });

    await h.bridge.sweepOrphans(new Set(['alive']));

    assert.deepEqual(h.deleted, ['f1']);
  });
});
