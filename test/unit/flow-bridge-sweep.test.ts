import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FlowBridgeManager, mintDeviceId, LIGHTKEEPER_DEVICE_ID,
} from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * The orphan sweep is the only bulk-delete this app performs. It classifies a
 * generated Flow as an orphan by asking whether its controller id is in the set
 * of RUNNING controllers — which means an empty set makes every Flow look
 * orphaned. That is indistinguishable from "the runtimes have not registered
 * yet", so the sweep refuses rather than guessing.
 */

const APP_ID = 'com.thomassidor.lightkeeper';

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

/**
 * A generated flow that calls our bridge card on behalf of `controllerId`.
 *
 * The controller ids below are REAL-shaped (`lk-ctrl-<ms>-<rand>`, as the
 * drivers mint them) because the sweep now requires that shape before it will
 * delete anything: an id a person could type into the argument field is not
 * proof the flow was generated. See looksGenerated.
 */
function managedFlow(id: string, controllerId: string) {
  return {
    id,
    name: `Lightkeeper — ${id}`,
    actions: [{ id: cardId('bridge_event'), args: { controller: controllerId, event_key: 'k' } }],
  };
}

const ALIVE = 'lk-ctrl-1755500000000-111111';
const GONE = 'lk-ctrl-1755500000000-222222';
const ALSO_GONE = 'lk-sched-1755500000000-333333';

describe('orphan sweep', () => {
  test('deletes flows whose controller is gone, keeps the rest', async () => {
    const h = harness({
      f1: managedFlow('f1', ALIVE),
      f2: managedFlow('f2', GONE),
      f3: { id: 'f3', name: 'Someone else’s flow', actions: [{ id: 'homey:manager:alarms:enable' }] },
    });

    const result = await h.bridge.sweepOrphans(new Set([ALIVE]));

    assert.deepEqual(h.deleted, ['f2']);
    assert.equal(result.deleted, 1);
    assert.equal(result.kept, 1);
    assert.equal(result.refused, undefined);
  });

  test('refuses to sweep when no controller is running', async () => {
    const h = harness({
      f1: managedFlow('f1', ALIVE),
      f2: managedFlow('f2', ALSO_GONE),
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
      f1: managedFlow('f1', GONE),
      f2: { id: 'f2', name: 'User flow', actions: [{ id: 'homey:manager:speech:say' }] },
      f3: { id: 'f3', name: 'No actions' },
    });

    await h.bridge.sweepOrphans(new Set([ALIVE]));

    assert.deepEqual(h.deleted, ['f1']);
  });

  /**
   * A flow that calls one of our cards but does NOT match the template we
   * generate. It is still ATTRIBUTED — the card is ours and the sweep can see
   * it — but attribution is not licence to delete. The bridge cards are
   * ordinary action cards in the user's Flow editor, so somebody building
   * their own flow around one is a thing that can happen, and having the app
   * silently delete it would be the worst failure in this file.
   */
  test('a flow using our card with a hand-typed controller arg is never deleted', async () => {
    const h = harness({
      f1: managedFlow('f1', GONE),
      f2: {
        id: 'f2',
        name: 'My own shortcut',
        actions: [{ id: cardId('bridge_event'), args: { controller: 'kitchen', event_key: 'k' } }],
      },
    });

    const result = await h.bridge.sweepOrphans(new Set([ALIVE]));

    assert.deepEqual(h.deleted, ['f1'], 'only the one that matches the template');
    assert.equal(result.unmanaged, 1, 'the other is reported, not removed');
    assert.equal(result.kept, 1);
  });

  test('a flow with a SECOND action is not ours to delete', async () => {
    // Every generated flow has exactly one action. A user who added a
    // notification beside ours has made the flow theirs.
    const h = harness({
      f1: {
        id: 'f1',
        name: 'Lightkeeper — with a twist',
        actions: [
          { id: cardId('bridge_event'), args: { controller: GONE, event_key: 'k' } },
          { id: 'homey:manager:notifications:create_notification', args: {} },
        ],
      },
    });

    const result = await h.bridge.sweepOrphans(new Set([ALIVE]));

    assert.deepEqual(h.deleted, []);
    assert.equal(result.unmanaged, 1);
  });

  test('a flow with an empty event key is not ours to delete', async () => {
    const h = harness({
      f1: {
        id: 'f1',
        name: 'Half-built',
        actions: [{ id: cardId('bridge_event'), args: { controller: GONE, event_key: '' } }],
      },
    });

    const result = await h.bridge.sweepOrphans(new Set([ALIVE]));

    assert.deepEqual(h.deleted, []);
    assert.equal(result.unmanaged, 1);
  });
});

describe('the sweep only deletes what the user was shown', () => {
  test('a stale token refuses the whole sweep', async () => {
    const h = harness({
      f1: managedFlow('f1', ALIVE),
      f2: managedFlow('f2', GONE),
    });

    const preview = await h.bridge.countOrphans(new Set([ALIVE]));
    assert.equal(preview.orphans, 1);
    assert.deepEqual(preview.flowIds, ['f2']);

    // Between the count and the click, the device that owns f1 finished
    // restarting — or another one was deleted. Either way the set the user
    // approved is not the set in front of us now.
    const result = await h.bridge.sweepOrphans(new Set([ALIVE, GONE]), {
      token: preview.token,
      flowIds: preview.flowIds,
    });

    assert.equal(result.refused, 'stale_preview');
    assert.deepEqual(h.deleted, [], 'not one flow, on a set the user did not approve');
  });

  test('a matching token deletes exactly the approved set', async () => {
    const h = harness({
      f1: managedFlow('f1', ALIVE),
      f2: managedFlow('f2', GONE),
      f3: managedFlow('f3', ALSO_GONE),
    });

    const preview = await h.bridge.countOrphans(new Set([ALIVE]));
    const result = await h.bridge.sweepOrphans(new Set([ALIVE]), {
      token: preview.token,
      flowIds: preview.flowIds,
    });

    assert.equal(result.refused, undefined);
    assert.deepEqual(h.deleted.sort(), ['f2', 'f3']);
  });

  test('an id that was never in the preview is not deleted even under a valid token', async () => {
    // Belt and braces behind the token: the approval is a LIST, and an id
    // outside it is not deleted whatever the hash says.
    const h = harness({
      f1: managedFlow('f1', ALIVE),
      f2: managedFlow('f2', GONE),
      f3: managedFlow('f3', ALSO_GONE),
    });

    const preview = await h.bridge.countOrphans(new Set([ALIVE]));
    const result = await h.bridge.sweepOrphans(new Set([ALIVE]), {
      token: preview.token,
      flowIds: ['f2'],
    });

    assert.deepEqual(h.deleted, ['f2']);
    assert.equal(result.deleted, 1);
    assert.equal(result.kept, 2);
  });

  test('no approval at all still sweeps — an older settings page must keep working', async () => {
    const h = harness({
      f1: managedFlow('f1', ALIVE),
      f2: managedFlow('f2', GONE),
    });

    const result = await h.bridge.sweepOrphans(new Set([ALIVE]));

    assert.deepEqual(h.deleted, ['f2']);
    assert.equal(result.deleted, 1);
  });

  test('the preview counts unmanaged flows separately from orphans', async () => {
    const h = harness({
      f1: managedFlow('f1', GONE),
      f2: {
        id: 'f2',
        name: 'Hand-built',
        actions: [{ id: cardId('bridge_event'), args: { controller: 'nope', event_key: 'k' } }],
      },
    });

    const preview = await h.bridge.countOrphans(new Set([ALIVE]));

    assert.equal(preview.total, 2, 'both are attributed');
    assert.equal(preview.orphans, 1, 'only one is a candidate for deletion');
    assert.equal(preview.unmanaged, 1);
    assert.deepEqual(preview.flowIds, ['f1']);
  });
});

describe('the device-id pattern accepts both shapes, forever', () => {
  test('a freshly minted id matches, per kind', () => {
    for (const kind of ['ctrl', 'sched', 'circ'] as const) {
      const id = mintDeviceId(kind);
      assert.match(id, LIGHTKEEPER_DEVICE_ID, id);
      assert.ok(id.startsWith(`lk-${kind}-`));
    }
  });

  test('and so does the legacy timestamp-and-random shape', () => {
    // Not deprecated — PERMANENT. A device id is baked into the `controller`
    // argument of every Flow that device owns and into the device's own `data`,
    // neither of which can be rewritten. A pattern that stopped matching it would
    // make every existing device's Flows unattributable, which the sweep reads
    // as orphaned.
    for (const id of ['lk-ctrl-1755500000000-123456', 'lk-sched-1-1', 'lk-circ-1755500000000-9']) {
      assert.match(id, LIGHTKEEPER_DEVICE_ID, id);
    }
  });

  test('nothing else does', () => {
    for (const id of [
      'lk-light-1755500000000-1',
      'ctrl-1755500000000-1',
      'lk-ctrl-',
      'lk-ctrl-not-a-uuid',
      'lk-ctrl-1755500000000',
      // A hand-typed value in a Flow argument, which is the whole point of the
      // pattern: it is the sweep's proof that WE wrote the id.
      'my-controller',
      '',
    ]) {
      assert.doesNotMatch(id, LIGHTKEEPER_DEVICE_ID, id);
    }
  });

  test('two minted ids never collide', () => {
    // Date.now() plus Math.random() had a real, if small, chance of colliding for
    // two devices created in the same millisecond — and a collision means each
    // device can delete the other's Flows.
    const ids = new Set(Array.from({ length: 500 }, () => mintDeviceId('ctrl')));
    assert.equal(ids.size, 500);
  });
});
