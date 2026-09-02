import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowBridgeManager, type SyncRequest } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { ManagedFlowReference } from '../../lib/profiles/controller-profile';

/**
 * What happens to generated Flows when a pass does not run cleanly.
 *
 * Three failures this file exists for, all of which leave the user with
 * automation they did not ask for and cannot see the cause of:
 *
 *  1. A binding whose ARGUMENTS changed under an unchanged key. The old flow
 *     was left live and a replacement created beside it, so the lights did the
 *     old thing and the new thing. Nothing in the app admitted the old flow
 *     existed — its reference had been overwritten.
 *  2. A create that fails part-way through a multi-flow pass. The references
 *     for everything created BEFORE it were discarded with the thrown result,
 *     so the flows stayed live and untracked, and the next retry made a second
 *     set.
 *  3. A delete that fails on a flow that was already gone, counted as a
 *     failure — see the idempotency tests at the bottom.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const cardId = (short: string) => `${APP_ID}:${short}`;

interface HarnessOptions {
  /** Flows already live on the Homey, keyed by id. */
  flows?: Record<string, any>;
  /** Make the Nth createFlow call reject. 1-based. */
  failCreateNth?: number;
  /** Make deleteFlow reject for these ids. */
  failDeleteOf?: Set<string>;
  /** Make deleteFlow reject with a 404-shaped error for these ids. */
  notFoundOnDeleteOf?: Set<string>;
  /** Flow folders already on the Homey, keyed by id. */
  folders?: Record<string, any>;
}

function harness(options: HarnessOptions = {}) {
  const live: Record<string, any> = { ...(options.flows ?? {}) };
  const folders: Record<string, any> = { ...(options.folders ?? {}) };
  const created: string[] = [];
  const deleted: string[] = [];
  const foldersCreated: string[] = [];
  const foldersDeleted: string[] = [];
  const logs: string[] = [];
  let createCalls = 0;
  let nextFlowId = 1;
  let nextFolderId = 1;

  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };

  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => live,
      getFlowFolders: async () => folders,
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
      deleteFlowFolder: async ({ id }: { id: string }) => {
        foldersDeleted.push(id);
        delete folders[id];
      },
      updateFlow: async ({ id, flow }: { id: string; flow: any }) => {
        live[id] = { ...live[id], ...flow };
        return live[id];
      },
      createFlow: async ({ flow }: { flow: any }) => {
        createCalls += 1;
        if (options.failCreateNth === createCalls) {
          throw new Error('Homey refused the write');
        }
        const id = `new-${nextFlowId++}`;
        live[id] = { id, ...flow };
        created.push(id);
        return { id };
      },
      deleteFlow: async ({ id }: { id: string }) => {
        if (options.notFoundOnDeleteOf?.has(id)) {
          const error = new Error(`404 Not Found: Flow with ID ${id}`) as Error & { statusCode: number };
          error.statusCode = 404;
          throw error;
        }
        if (options.failDeleteOf?.has(id)) {
          const error = new Error('Missing Scopes') as Error & { statusCode: number };
          error.statusCode = 403;
          throw error;
        }
        deleted.push(id);
        delete live[id];
      },
    },
  };

  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return {
    live, folders, created, deleted, foldersCreated, foldersDeleted, logs,
    get createCalls() { return createCalls; },
    bridge: new FlowBridgeManager(api, APP_ID, (...args) => logs.push(args.join(' '))),
  };
}

/** A schedule-shaped binding: fixed trigger, one variant per boundary time. */
const CRON_TIME_CARD = {
  id: 'homey:manager:cron:time_exactly',
  uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
  argument: 'time',
};

/** The card is a parameter so a test can move it, as a firmware could. */
function scheduleInput(key: string, time: string, card = CRON_TIME_CARD) {
  return {
    key,
    label: `Schedule ${key}`,
    variantKey: `at:${time}`,
    binding: {
      kind: 'flow_fixed' as const,
      cardId: card.id,
      cardOwnerUri: card.uri,
      fixedArgs: { [card.argument]: time },
    },
  };
}

/** A Flow as Homey serialises the one we would have generated for `input`. */
function asLiveFlow(id: string, controllerId: string, input: ReturnType<typeof scheduleInput>) {
  return {
    id,
    name: `Lightkeeper — ${input.label}`,
    enabled: true,
    folder: null,
    conditions: [],
    trigger: {
      id: input.binding.cardId,
      uri: input.binding.cardOwnerUri,
      args: { ...(input.binding as any).fixedArgs },
    },
    actions: [{
      id: cardId('bridge_event'),
      uri: `homey:flowcardaction:${cardId('bridge_event')}`,
      group: 'then',
      args: { controller: controllerId, event_key: input.key },
      droptoken: null,
    }],
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

function reference(flowId: string, bindingKey: string, variantKey: string, fingerprint: string): ManagedFlowReference {
  return { flowId, bindingKey, variantKey, fingerprint, managedVersion: 1, createdAt: 1 } as ManagedFlowReference;
}

/**
 * Two routes reach "this flow is obsolete", and only one of them worked.
 *
 * A change that moves the VARIANT KEY — a schedule retimed from 22:00 to 23:00,
 * where the time is in the variant key precisely so this happens — makes the
 * old key un-wanted, and the abandonment loop removes it. That route was
 * always correct and the first test here pins it.
 *
 * A change that moves only the FINGERPRINT leaves the key wanted, so the
 * abandonment loop's `if (wanted.has(key)) continue;` skipped it — while the
 * new flow's reference overwrote the old one. Live flow, no reference, no
 * screen admitting it exists. That is what the rest of this block is about.
 */
describe('an obsolete flow is REPLACED, not duplicated', () => {

  test('a variant-key change deletes the old flow via abandonment', async () => {
    // A schedule retimed from 22:00 to 23:00. The binding key is unchanged —
    // it is the same window — but the trigger's argument moved, so the
    // variant key moves with it and the fingerprint changes.
    const oldInput = scheduleInput('sched:0:on', '22:00');
    const h = harness({ flows: { 'f-old': asLiveFlow('f-old', 'lk-sched-1-1', oldInput) } });

    const result = await h.bridge.sync(request({
      fingerprint: 'fp-2',
      mapped: [scheduleInput('sched:0:on', '23:00')],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', 'fp-1')],
    }));

    assert.equal(result.created, 1, 'the new time got a flow');
    assert.equal(result.deleted, 1, 'the old one was removed');
    assert.deepEqual(h.deleted, ['f-old']);
    assert.equal(Object.keys(h.live).length, 1, 'exactly one flow is live — not two firing an hour apart');
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0]!.fingerprint, 'fp-2');
    assert.deepEqual(result.staleReplacements, []);
  });

  test('a fingerprint change on the SAME variant replaces in place', async () => {
    // The event surface moved under an unchanged binding — a re-paired remote.
    // The key stays wanted, so nothing else in sync() would ever remove it.
    const input = scheduleInput('sched:0:on', '22:00');
    const h = harness({ flows: { 'f-old': asLiveFlow('f-old', 'lk-sched-1-1', input) } });

    const result = await h.bridge.sync(request({
      fingerprint: 'fp-NEW',
      mapped: [input],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', 'fp-OLD')],
    }));

    assert.equal(result.created, 1);
    assert.equal(result.deleted, 1);
    assert.deepEqual(h.deleted, ['f-old']);
    assert.equal(Object.keys(h.live).length, 1);
  });

  test('when the replacement delete fails, both flows are named and reported', async () => {
    const input = scheduleInput('sched:0:on', '22:00');
    const h = harness({
      flows: { 'f-old': asLiveFlow('f-old', 'lk-sched-1-1', input) },
      failDeleteOf: new Set(['f-old']),
    });

    const result = await h.bridge.sync(request({
      fingerprint: 'fp-NEW',
      mapped: [input],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', 'fp-OLD')],
    }));

    assert.equal(result.created, 1);
    assert.equal(result.deleted, 0, 'nothing was deleted');
    assert.deepEqual(result.staleReplacements, ['f-old'],
      'the caller can surface a degraded state instead of proceeding silently');
    assert.equal(Object.keys(h.live).length, 2, 'both are live — which is exactly why it is reported');
    assert.ok(
      h.logs.some(line => line.includes('f-old') && line.includes('new-1')),
      'the log names BOTH flow ids, or the user cannot find the stale one',
    );
  });

  /**
   * The abandonment loop's own version of the test above, and it had none.
   *
   * The supersede path reported an undeletable flow; this one dropped the
   * reference and moved on, which made the flow unreachable by every other path
   * in the app: still live, still calling our bridge card, and its `controller`
   * argument still naming a device that IS live — so the orphan sweep sees no
   * orphan and never will.
   */
  test('when an abandoned flow will not delete, its reference is kept and reported', async () => {
    const stays = scheduleInput('sched:0:on', '22:00');
    const goes = scheduleInput('sched:1:on', '23:00');
    const h = harness({
      flows: {
        'f-stays': asLiveFlow('f-stays', 'lk-sched-1-1', stays),
        'f-goes': asLiveFlow('f-goes', 'lk-sched-1-1', goes),
      },
      failDeleteOf: new Set(['f-goes']),
    });

    // The second window was removed from the plan, so its flow is no longer
    // wanted — and the Homey refuses to delete it.
    const result = await h.bridge.sync(request({
      fingerprint: 'fp-1',
      mapped: [stays],
      existing: [
        reference('f-stays', 'sched:0:on', 'at:22:00', 'fp-1'),
        reference('f-goes', 'sched:1:on', 'at:23:00', 'fp-1'),
      ],
    }));

    assert.equal(result.deleted, 0, 'nothing was deleted');
    assert.deepEqual(result.staleReplacements, ['f-goes'],
      'the id is reported, so a caller can surface it and the user can find it');
    assert.ok(
      result.references.some(ref => ref.flowId === 'f-goes'),
      'and the reference SURVIVES, or nothing will ever try to delete it again',
    );
    assert.equal(Object.keys(h.live).length, 2, 'it really is still live');
  });

  test('a retained abandoned reference is retried on the next pass', async () => {
    const stays = scheduleInput('sched:0:on', '22:00');
    const goes = scheduleInput('sched:1:on', '23:00');
    const h = harness({
      flows: {
        'f-stays': asLiveFlow('f-stays', 'lk-sched-1-1', stays),
        'f-goes': asLiveFlow('f-goes', 'lk-sched-1-1', goes),
      },
    });

    // Same input as the pass above, but the Homey now accepts the delete — this
    // is the second reconcile, carrying the reference the first one kept.
    const result = await h.bridge.sync(request({
      fingerprint: 'fp-1',
      mapped: [stays],
      existing: [
        reference('f-stays', 'sched:0:on', 'at:22:00', 'fp-1'),
        reference('f-goes', 'sched:1:on', 'at:23:00', 'fp-1'),
      ],
    }));

    assert.equal(result.deleted, 1);
    assert.deepEqual(h.deleted, ['f-goes']);
    assert.deepEqual(result.staleReplacements, []);
    assert.ok(!result.references.some(ref => ref.flowId === 'f-goes'), 'and the reference is dropped');
  });

  /**
   * A firmware that MOVES Homey's own time trigger card must not strand a
   * schedule.
   *
   * The card's identity is the schedule's whole fingerprint, so a moved card
   * changes it — but `sync()` reaches the user-edit test first, and a different
   * `trigger.id` was read there as an unconditional edit. So the flow was left
   * alone, the device reported `state.flowEdited`, and the fingerprint branch
   * that exists to rebuild against the new card was unreachable in exactly the
   * case it was added for. The user was sent to a repair that could not help.
   */
  test('a moved platform trigger card replaces the flow instead of reading as an edit', async () => {
    const oldCard = {
      id: 'homey:manager:cron:time_exactly',
      uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
      argument: 'time',
    };
    const newCard = {
      id: 'homey:manager:cron:time_exactly_v2',
      uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly_v2',
      argument: 'time',
    };

    const input = scheduleInput('sched:0:on', '22:00', newCard);
    // The live flow still carries the OLD card, because that is what it was
    // created with.
    const h = harness({
      flows: { 'f-old': asLiveFlow('f-old', 'lk-sched-1-1', scheduleInput('sched:0:on', '22:00', oldCard)) },
    });

    const result = await h.bridge.sync(request({
      // A schedule's fingerprint IS its card's identity, so this moved with it.
      fingerprint: `time:${newCard.id}:${newCard.argument}`,
      mapped: [input],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', `time:${oldCard.id}:time`)],
    }));

    assert.deepEqual(result.userEdited, [],
      'a card the platform moved is not something the user did');
    assert.equal(result.created, 1, 'the schedule is rebuilt against the new card');
    assert.equal(result.deleted, 1, 'and the old flow goes');
  });

  test('a user-edited flow is still left alone when our own template moved', async () => {
    const card = {
      id: 'homey:manager:cron:time_exactly',
      uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
      argument: 'time',
    };
    const input = scheduleInput('sched:0:on', '22:00', card);
    const live = asLiveFlow('f-old', 'lk-sched-1-1', input);
    // The user added a condition — "only when I'm home". Everything except the
    // trigger's identity is still compared, so this is still their flow.
    (live as any).conditions = [{ id: 'homey:manager:presence:someone_home', args: {} }];

    const h = harness({ flows: { 'f-old': live } });

    const result = await h.bridge.sync(request({
      fingerprint: 'time:something:else',
      mapped: [input],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', 'time:old:time')],
    }));

    assert.deepEqual(result.userEdited, ['f-old'], 'their work survives a template change');
    assert.equal(result.created, 0);
    assert.equal(result.deleted, 0);
  });

  test('an unchanged binding is still reused, not replaced', async () => {
    const input = scheduleInput('sched:0:on', '22:00');
    const h = harness({ flows: { 'f-old': asLiveFlow('f-old', 'lk-sched-1-1', input) } });

    const result = await h.bridge.sync(request({
      fingerprint: 'fp-1',
      mapped: [input],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', 'fp-1')],
    }));

    assert.equal(result.reused, 1);
    assert.equal(result.created, 0);
    assert.equal(result.deleted, 0);
    assert.deepEqual(h.deleted, []);
  });

  test('a user-edited flow is never replaced, however the fingerprint moved', async () => {
    const input = scheduleInput('sched:0:on', '22:00');
    const edited = asLiveFlow('f-old', 'lk-sched-1-1', input);
    edited.trigger.args = { time: '06:30' };  // the user changed it in the editor

    const h = harness({ flows: { 'f-old': edited } });

    const result = await h.bridge.sync(request({
      fingerprint: 'fp-2',
      mapped: [input],
      existing: [reference('f-old', 'sched:0:on', 'at:22:00', 'fp-1')],
    }));

    assert.deepEqual(result.userEdited, ['f-old']);
    assert.equal(result.created, 0);
    assert.equal(result.deleted, 0);
    assert.deepEqual(h.deleted, []);
  });
});

describe('a pass that fails part-way leaves nothing behind', () => {

  test('the 2nd of 3 creates failing leaves zero net new flows', async () => {
    const h = harness({ failCreateNth: 2 });

    await assert.rejects(h.bridge.sync(request({
      mapped: [
        scheduleInput('sched:0:on', '22:00'),
        scheduleInput('sched:0:off', '23:00'),
        scheduleInput('sched:1:on', '07:00'),
      ],
    })), /Homey refused the write/, 'the original failure reaches the caller');

    assert.equal(h.createCalls, 2, 'it stopped at the failure rather than ploughing on');
    assert.deepEqual(Object.keys(h.live), [],
      'the flow created before the failure was compensated away');
    assert.deepEqual(h.deleted, h.created,
      'exactly this pass’s creations were removed, nothing else');
  });

  test('flows that were REUSED are never compensated away', async () => {
    const kept = scheduleInput('sched:0:on', '22:00');
    const h = harness({
      flows: { 'f-kept': asLiveFlow('f-kept', 'lk-sched-1-1', kept) },
      failCreateNth: 1,
    });

    await assert.rejects(h.bridge.sync(request({
      mapped: [kept, scheduleInput('sched:0:off', '23:00')],
      existing: [reference('f-kept', 'sched:0:on', 'at:22:00', 'fp-1')],
    })), /Homey refused the write/);

    assert.ok('f-kept' in h.live, 'a flow this pass did not create is not this pass’s to remove');
    assert.deepEqual(h.deleted, []);
  });

  test('a compensating delete that itself fails is logged, and the original error still wins', async () => {
    const h = harness({ failCreateNth: 2, failDeleteOf: new Set(['new-1']) });

    await assert.rejects(h.bridge.sync(request({
      mapped: [scheduleInput('sched:0:on', '22:00'), scheduleInput('sched:0:off', '23:00')],
    })), /Homey refused the write/, 'the caller sees the cause, not the cleanup');

    assert.ok('new-1' in h.live, 'it could not be removed');
    assert.ok(
      h.logs.some(line => line.includes('new-1')),
      'and the id it could not remove is in the log',
    );
  });

  test('the happy path is untouched', async () => {
    const h = harness();

    const result = await h.bridge.sync(request({
      mapped: [scheduleInput('sched:0:on', '22:00'), scheduleInput('sched:0:off', '23:00')],
    }));

    assert.equal(result.created, 2);
    assert.equal(result.deleted, 0);
    assert.deepEqual(h.deleted, []);
    assert.equal(Object.keys(h.live).length, 2);
    assert.equal(result.references.length, 2);
  });
});

describe('deletes are idempotent', () => {

  test('a flow the user already deleted counts as deleted, not as a failure', async () => {
    const input = scheduleInput('sched:0:on', '22:00');
    const h = harness({
      flows: { 'f-gone': asLiveFlow('f-gone', 'lk-sched-1-1', input) },
      notFoundOnDeleteOf: new Set(['f-gone']),
    });

    // Nothing mapped any more, but a reference remains: the abandonment path.
    const result = await h.bridge.sync(request({
      mapped: [scheduleInput('sched:9:on', '05:00')],
      existing: [reference('f-gone', 'sched:0:on', 'at:22:00', 'fp-1')],
    }));

    assert.equal(result.deleted, 1, '404 means the desired end state holds');
    assert.ok(
      !h.logs.some(line => line.includes('Could not delete flow f-gone')),
      'and it is not reported as a problem',
    );
  });

  test('a 403 on delete is still a failure', async () => {
    const input = scheduleInput('sched:0:on', '22:00');
    const h = harness({
      flows: { 'f-locked': asLiveFlow('f-locked', 'lk-sched-1-1', input) },
      failDeleteOf: new Set(['f-locked']),
    });

    const result = await h.bridge.sync(request({
      mapped: [scheduleInput('sched:9:on', '05:00')],
      existing: [reference('f-locked', 'sched:0:on', 'at:22:00', 'fp-1')],
    }));

    assert.equal(result.deleted, 0, '"we could not tell" is not "it is gone"');
    assert.ok(h.logs.some(line => line.includes('Could not delete flow f-locked')));
  });
});

/**
 * The transition to nothing.
 *
 * Both runtimes used to return early when nothing was mapped, so this pass
 * never ran at all — see the runtime tests for that half. This is the other
 * half: that `sync()` with an empty `mapped` actually reconciles to empty
 * rather than quietly reusing what it finds.
 */
describe('an empty desired set reconciles to empty', () => {

  test('every stored flow is deleted and no reference survives', async () => {
    const a = scheduleInput('sched:0:on', '22:00');
    const b = scheduleInput('sched:0:off', '23:30');
    const h = harness({
      flows: {
        'f-a': asLiveFlow('f-a', 'lk-sched-1-1', a),
        'f-b': asLiveFlow('f-b', 'lk-sched-1-1', b),
      },
    });

    const result = await h.bridge.sync(request({
      mapped: [],
      existing: [
        reference('f-a', 'sched:0:on', 'at:22:00', 'fp-1'),
        reference('f-b', 'sched:0:off', 'at:23:30', 'fp-1'),
      ],
    }));

    assert.equal(result.deleted, 2);
    assert.equal(result.created, 0);
    assert.equal(result.reused, 0);
    assert.deepEqual(result.references, [], 'the device is left referencing nothing');
    assert.deepEqual(Object.keys(h.live), [], 'and nothing is live');
  });

  test('no device folder is created for a pass that wants no flows', async () => {
    const a = scheduleInput('sched:0:on', '22:00');
    const h = harness({ flows: { 'f-a': asLiveFlow('f-a', 'lk-sched-1-1', a) } });

    await h.bridge.sync(request({
      mapped: [],
      existing: [reference('f-a', 'sched:0:on', 'at:22:00', 'fp-1')],
    }));

    assert.deepEqual(
      h.foldersCreated, ['Lightkeeper'],
      'the app root is made either way — it is the anchor the next device resolves '
      + 'against (platform §11). The DEVICE folder is what must not be made only to '
      + 'be cleaned up again.',
    );
    assert.ok(
      !h.foldersCreated.includes('Evening lights'),
      'no folder for a device that is about to have no flows',
    );
  });

  test('a normal pass still gets its folders', async () => {
    const h = harness();

    await h.bridge.sync(request({ mapped: [scheduleInput('sched:0:on', '22:00')] }));

    assert.deepEqual(
      h.foldersCreated, ['Lightkeeper', 'Evening lights'],
      'the app root, then the device folder inside it',
    );
  });
});
