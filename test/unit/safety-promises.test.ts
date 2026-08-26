import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FlowBridgeManager, hasBeenUserEdited } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * One named test per PROMISE the app makes in prose.
 *
 * README.md and CLAUDE.md both state, in user-facing and maintainer-facing
 * language, things this app guarantees: that deleting a device removes only
 * its own Flows, that a Flow the user edited is never overwritten, that a
 * colour change never switches a lamp on. Each of those is implemented
 * somewhere and covered SOMEWHERE by a unit test of the module that implements
 * it — but nothing connected the sentence to the assertion, so a refactor that
 * quietly retired a promise would leave the sentence standing.
 *
 * The convention, and it matters more than the coverage:
 *
 *   - One test per promise, named with the promise's own words.
 *   - The test asserts the promise END TO END through the public surface a
 *     user's action actually reaches, not through the internal helper. A test
 *     that calls the private function the promise is implemented in re-passes
 *     the day someone stops calling it.
 *   - When a phase fixes a bug that a promise covers, the promise's test is
 *     added or tightened HERE as well as in the module's own file.
 *
 * Duplication with the per-module tests is the point. These are the sentences
 * we would have to retract.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const cardId = (short: string) => `${APP_ID}:${short}`;

/** A Flow as Homey serialises one, calling our bridge card. */
function generatedFlow(options: {
  id: string; controller: string; eventKey: string;
  name?: string; folder?: string | null; enabled?: boolean;
}) {
  return {
    id: options.id,
    name: options.name ?? `Lightkeeper ${options.eventKey}`,
    enabled: options.enabled ?? true,
    folder: options.folder ?? null,
    trigger: { id: 'homey:device:remote-1:n2_on', uri: 'homey:flowcardtrigger:homey:device:remote-1:n2_on', args: {} },
    conditions: [],
    actions: [{
      id: cardId('bridge_event'),
      uri: `homey:flowcardaction:${cardId('bridge_event')}`,
      group: 'then',
      args: { controller: options.controller, event_key: options.eventKey },
    }],
  };
}

function bridgeHarness(flows: Record<string, unknown>) {
  const deleted: string[] = [];
  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };
  const live = { ...flows };
  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => live,
      deleteFlow: async ({ id }: { id: string }) => {
        if (!(id in live)) throw new Error(`404 Not Found: Flow with ID ${id}`);
        deleted.push(id);
        delete (live as Record<string, unknown>)[id];
      },
    },
  };
  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return {
    deleted,
    live,
    bridge: new FlowBridgeManager(api, APP_ID, () => undefined),
  };
}

describe('safety promises', () => {

  /**
   * README.md: "Deleting a Lightkeeper device deletes only the Flows it
   * created." CLAUDE.md, Safety properties: "Attribution is the controller id
   * carried in the bridge action's arguments."
   */
  test('deleting a device removes only the flows carrying its own id', async () => {
    const h = bridgeHarness({
      'f-mine-1': generatedFlow({ id: 'f-mine-1', controller: 'lk-ctrl-1-1', eventKey: 'press:up' }),
      'f-mine-2': generatedFlow({ id: 'f-mine-2', controller: 'lk-ctrl-1-1', eventKey: 'press:down' }),
      'f-theirs': generatedFlow({ id: 'f-theirs', controller: 'lk-ctrl-2-2', eventKey: 'press:up' }),
      'f-user': {
        id: 'f-user',
        name: 'Somebody else’s flow',
        trigger: { id: 'homey:manager:cron:time_exactly', args: { time: '07:00' } },
        actions: [{ id: 'homey:manager:alarms:enable_next', args: {} }],
      },
    });

    // What device.onDeleted() calls, with the references the device stored.
    const removed = await h.bridge.removeAll([
      { flowId: 'f-mine-1', bindingKey: 'press:up', fingerprint: 'fp', managedVersion: 1, createdAt: 1 },
      { flowId: 'f-mine-2', bindingKey: 'press:down', fingerprint: 'fp', managedVersion: 1, createdAt: 1 },
    ] as any);

    assert.equal(removed, 2);
    assert.deepEqual(h.deleted.sort(), ['f-mine-1', 'f-mine-2']);
    assert.ok('f-theirs' in h.live, 'another device’s flow survives');
    assert.ok('f-user' in h.live, 'a flow we never made is never touched');
  });

  /**
   * README.md: "A Flow you have edited is never overwritten." CLAUDE.md, I8:
   * a renamed or moved Flow is reused IN PLACE — folder placement and name are
   * deliberately NOT evidence of an edit, because the per-device folder
   * migration depends on moving flows we already own.
   */
  test('a renamed or moved flow is reused in place, not read as edited', () => {
    const expected = {
      bindingKey: 'press:up',
      trigger: { id: 'homey:device:remote-1:n2_on', uri: 'x', args: {} },
      actions: [{
        id: cardId('bridge_event'),
        uri: `homey:flowcardaction:${cardId('bridge_event')}`,
        args: { controller: 'lk-ctrl-1-1', event_key: 'press:up' },
      }],
    } as any;

    const renamedAndMoved = generatedFlow({
      id: 'f1', controller: 'lk-ctrl-1-1', eventKey: 'press:up',
      name: 'My kitchen up button', folder: 'some-folder-the-user-picked',
    });

    assert.equal(
      hasBeenUserEdited(renamedAndMoved, expected), false,
      'renaming a generated flow, or filing it elsewhere, is not an edit',
    );
  });

  /**
   * README.md: "A Flow you have edited is never overwritten." The other half:
   * a materially changed action IS an edit, and the device goes to repair
   * rather than having the change stamped over.
   */
  test('a flow whose action arguments were changed reads as edited', () => {
    const expected = {
      bindingKey: 'press:up',
      trigger: { id: 'homey:device:remote-1:n2_on', uri: 'x', args: {} },
      actions: [{
        id: cardId('bridge_event'),
        uri: `homey:flowcardaction:${cardId('bridge_event')}`,
        args: { controller: 'lk-ctrl-1-1', event_key: 'press:up' },
      }],
    } as any;

    const repointed = generatedFlow({ id: 'f1', controller: 'lk-ctrl-1-1', eventKey: 'press:DOWN' });
    assert.equal(hasBeenUserEdited(repointed, expected), true);
  });

  /**
   * CLAUDE.md, Safety properties: "The orphan sweep refuses to run when no
   * Lightkeeper device of either kind is live, because every managed Flow would
   * then look orphaned."
   */
  test('the sweep refuses outright when nothing is running', async () => {
    const h = bridgeHarness({
      'f1': generatedFlow({ id: 'f1', controller: 'lk-ctrl-1-1', eventKey: 'press:up' }),
      'f2': generatedFlow({ id: 'f2', controller: 'lk-sched-2-2', eventKey: 'sched:0:on' }),
    });

    const result = await h.bridge.sweepOrphans(new Set<string>());

    assert.equal(result.refused, 'no_live_controllers');
    assert.equal(result.deleted, 0);
    assert.equal(result.kept, 2);
    assert.deepEqual(h.deleted, [], 'not one flow was deleted');
  });

  /**
   * The same promise from the other side: with one device live, the refusal
   * does NOT fire, so the live set must be the union of both Flow-owning
   * registries or a schedule's flows are swept by a controller's liveness.
   * (api.ts liveDeviceIds — asserted here as the consequence.)
   */
  test('a live device does not license deleting another kind of device’s flows', async () => {
    const h = bridgeHarness({
      'f-ctrl': generatedFlow({ id: 'f-ctrl', controller: 'lk-ctrl-1-1', eventKey: 'press:up' }),
      'f-sched': generatedFlow({ id: 'f-sched', controller: 'lk-sched-2-2', eventKey: 'sched:0:on' }),
    });

    // The union, as liveDeviceIds() builds it.
    const result = await h.bridge.sweepOrphans(new Set(['lk-ctrl-1-1', 'lk-sched-2-2']));

    assert.equal(result.deleted, 0);
    assert.equal(result.kept, 2);
    assert.deepEqual(h.deleted, []);
  });
});

/**
 * The `§n` tags in lib/ are citations into CLAUDE.md's platform reference —
 * the durable record of things that took real hardware to establish. A tag
 * pointing at a section that no longer exists sends the next reader nowhere,
 * and renumbering the reference is exactly the edit that would do it.
 */
describe('platform-reference citations', () => {
  const root = join(import.meta.dirname, '..', '..');

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, found);
      else if (entry.endsWith('.ts')) found.push(full);
    }
    return found;
  }

  test('every §n referenced from lib/ names a section that exists', () => {
    const doc = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    const sections = new Set(
      [...doc.matchAll(/^## (\d+)\./gm)].map(match => match[1]),
    );
    assert.ok(sections.size >= 12, 'the platform reference should still have its sections');

    const missing: string[] = [];
    for (const file of sourceFiles(join(root, 'lib'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/§(\d+)/g)) {
        if (!sections.has(match[1]!)) {
          missing.push(`${relative(root, file)} cites §${match[1]} — no such section`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});
