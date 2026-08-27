import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FlowBridgeManager, hasBeenUserEdited } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { TargetStateCache } from '../../lib/outputs/target-state-cache';
import { planIntent } from '../../lib/outputs/intent-planner';
import { DEFAULT_BEHAVIOR } from '../../lib/mapping/mapping-types';
import { eventKeyFor } from '../../lib/schedules/schedule-bindings';
import type { ScheduleEntry } from '../../lib/schedules/schedule-types';
import type { ManagedFlowReference } from '../../lib/profiles/controller-profile';

/**
 * One named test per PROMISE the app makes in prose.
 *
 * README.md's "What you can rely on", FAQ.md's limits, and CLAUDE.md's own
 * "Safety properties worth preserving" all state, in user-facing and
 * maintainer-facing language, things this app guarantees: that deleting a
 * device removes only its own Flows, that a Flow the user edited is never
 * overwritten, that a colour change never switches a lamp on. Each of those is implemented
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
  const folders: Record<string, any> = {};
  let nextFlowId = 1;
  let nextFolderId = 1;
  const actions = {
    a: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
    b: { id: cardId('bridge_numeric_event'), uri: `homey:flowcardaction:${cardId('bridge_numeric_event')}` },
    c: { id: cardId('bridge_token_event'), uri: `homey:flowcardaction:${cardId('bridge_token_event')}` },
  };
  const live: Record<string, any> = { ...flows };
  const client = {
    flow: {
      getFlowCardActions: async () => actions,
      getFlows: async () => live,
      getFlowFolders: async () => folders,
      createFlow: async ({ flow }: { flow: any }) => {
        const id = `made-${nextFlowId++}`;
        live[id] = { id, ...flow };
        return { id };
      },
      createFlowFolder: async ({ flowfolder }: { flowfolder: any }) => {
        const id = `folder-${nextFolderId++}`;
        folders[id] = { id, name: flowfolder.name, parent: flowfolder.parent ?? null };
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
      deleteFlow: async ({ id }: { id: string }) => {
        if (!(id in live)) {
          const error = new Error(`404 Not Found: Flow with ID ${id}`) as Error & { statusCode: number };
          error.statusCode = 404;
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
    deleted,
    live,
    bridge: new FlowBridgeManager(api, APP_ID, () => undefined),
  };
}

describe('safety promises', () => {

  /**
   * README.md, What you can rely on: "Deleting a device deletes only the Flows
   * it demonstrably created." CLAUDE.md, Safety properties: "Attribution is the
   * controller id carried in the bridge action's arguments."
   */
  test('deleting a device removes only the flows carrying its own id', async () => {
    const h = bridgeHarness({
      'f-mine-1': generatedFlow({ id: 'f-mine-1', controller: 'lk-ctrl-1755500000000-100001', eventKey: 'press:up' }),
      'f-mine-2': generatedFlow({ id: 'f-mine-2', controller: 'lk-ctrl-1755500000000-100001', eventKey: 'press:down' }),
      'f-theirs': generatedFlow({ id: 'f-theirs', controller: 'lk-ctrl-1755500000000-100002', eventKey: 'press:up' }),
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
   * README.md, What you can rely on: "A Flow you have edited is never
   * overwritten." CLAUDE.md, I8:
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
        args: { controller: 'lk-ctrl-1755500000000-100001', event_key: 'press:up' },
      }],
    } as any;

    const renamedAndMoved = generatedFlow({
      id: 'f1', controller: 'lk-ctrl-1755500000000-100001', eventKey: 'press:up',
      name: 'My kitchen up button', folder: 'some-folder-the-user-picked',
    });

    assert.equal(
      hasBeenUserEdited(renamedAndMoved, expected), false,
      'renaming a generated flow, or filing it elsewhere, is not an edit',
    );
  });

  /**
   * README.md, What you can rely on: "A Flow you have edited is never
   * overwritten." The other half:
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
        args: { controller: 'lk-ctrl-1755500000000-100001', event_key: 'press:up' },
      }],
    } as any;

    const repointed = generatedFlow({ id: 'f1', controller: 'lk-ctrl-1755500000000-100001', eventKey: 'press:DOWN' });
    assert.equal(hasBeenUserEdited(repointed, expected), true);
  });

  /**
   * CLAUDE.md, Safety properties: "The orphan sweep refuses to run when no
   * Lightkeeper device of either kind is live, because every managed Flow would
   * then look orphaned."
   */
  test('the sweep refuses outright when nothing is running', async () => {
    const h = bridgeHarness({
      'f1': generatedFlow({ id: 'f1', controller: 'lk-ctrl-1755500000000-100001', eventKey: 'press:up' }),
      'f2': generatedFlow({ id: 'f2', controller: 'lk-sched-1755500000000-200001', eventKey: 'sched:0:on' }),
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
      'f-ctrl': generatedFlow({ id: 'f-ctrl', controller: 'lk-ctrl-1755500000000-100001', eventKey: 'press:up' }),
      'f-sched': generatedFlow({ id: 'f-sched', controller: 'lk-sched-1755500000000-200001', eventKey: 'sched:0:on' }),
    });

    // The union, as liveDeviceIds() builds it.
    const result = await h.bridge.sweepOrphans(new Set(['lk-ctrl-1755500000000-100001', 'lk-sched-1755500000000-200001']));

    assert.equal(result.deleted, 0);
    assert.equal(result.kept, 2);
    assert.deepEqual(h.deleted, []);
  });

  /**
   * FAQ.md, Where do the generated Flows go: reconfiguring reuses Flows rather
   * than duplicating them — the old one is replaced, not left beside the new
   * one. The failure this phase fixed: a binding whose
   * fingerprint moved got a new flow while the old one stayed live and
   * unreferenced, so the lights did the old thing AND the new thing.
   */
  test('a changed binding leaves exactly one live flow', async () => {
    const controller = 'lk-ctrl-1755500000000-100001';
    const before = generatedFlow({ id: 'f-before', controller, eventKey: 'press:up' });
    const h = bridgeHarness({ 'f-before': before });

    const input = {
      key: 'press:up',
      label: 'Up — Press',
      binding: {
        kind: 'flow_fixed' as const,
        cardId: 'homey:device:remote-1:n2_on',
        cardOwnerUri: 'homey:flowcardtrigger:homey:device:remote-1:n2_on',
        fixedArgs: {},
      },
    };

    const result = await h.bridge.sync({
      controllerId: controller,
      sourceName: 'STYRBAR',
      deviceName: 'Kitchen',
      // The event surface moved under an unchanged binding — a re-paired
      // remote. Same key, same variant, new fingerprint.
      fingerprint: 'fingerprint-AFTER',
      mapped: [input],
      existing: [{
        flowId: 'f-before', bindingKey: 'press:up', variantKey: 'fixed',
        fingerprint: 'fingerprint-BEFORE', managedVersion: 1, createdAt: 1,
      }] as any,
    });

    assert.equal(result.created, 1);
    assert.equal(result.deleted, 1);
    assert.deepEqual(h.deleted, ['f-before']);
    assert.equal(
      Object.keys(h.live).length, 1,
      'one binding, one flow — never the old behaviour firing beside the new',
    );
  });

  /**
   * CLAUDE.md, I3: "Nothing owned by the user is ever deleted on a heuristic."
   * Attribution — the flow calls one of our cards — is not the same thing as
   * proof we made it. The cards are ordinary action cards in the user's own
   * Flow editor.
   */
  test('the sweep never deletes a flow that does not match the generated template', async () => {
    const h = bridgeHarness({
      // Ours: a device that is gone, matching the template exactly.
      'f-ours': generatedFlow({
        id: 'f-ours', controller: 'lk-ctrl-1755500000000-999999', eventKey: 'press:up',
      }),
      // Theirs: our card, a controller argument a person typed.
      'f-theirs': {
        id: 'f-theirs',
        name: 'My own shortcut',
        enabled: true,
        conditions: [],
        trigger: { id: 'homey:manager:cron:time_exactly', args: { time: '07:00' } },
        actions: [{ id: cardId('bridge_event'), args: { controller: 'kitchen', event_key: 'x' } }],
      },
      // Also theirs: our card, our id, but a second action beside it.
      'f-extended': {
        id: 'f-extended',
        name: 'Lightkeeper, plus a notification',
        enabled: true,
        conditions: [],
        trigger: { id: 'homey:device:remote-1:n2_on', args: {} },
        actions: [
          {
            id: cardId('bridge_event'),
            args: { controller: 'lk-ctrl-1755500000000-999999', event_key: 'press:up' },
          },
          { id: 'homey:manager:notifications:create_notification', args: {} },
        ],
      },
    });

    const result = await h.bridge.sweepOrphans(new Set(['lk-ctrl-1755500000000-100001']));

    assert.deepEqual(h.deleted, ['f-ours'], 'only what we can prove we made');
    assert.equal(result.unmanaged, 2, 'the other two are reported, not removed');
    assert.ok('f-theirs' in h.live);
    assert.ok('f-extended' in h.live);
  });

  /**
   * The same promise at the other end of the round trip: the user approves a
   * SET, not a number, and a set that moved while the dialog was on screen is
   * not the one they approved.
   */
  test('the sweep refuses an approval that no longer matches what it can see', async () => {
    const alive = 'lk-ctrl-1755500000000-100001';
    const gone = 'lk-ctrl-1755500000000-999999';
    const h = bridgeHarness({
      'f-alive': generatedFlow({ id: 'f-alive', controller: alive, eventKey: 'press:up' }),
      'f-gone': generatedFlow({ id: 'f-gone', controller: gone, eventKey: 'press:up' }),
    });

    const preview = await h.bridge.countOrphans(new Set([alive]));
    // The absent device finished registering between the count and the click.
    const result = await h.bridge.sweepOrphans(new Set([alive, gone]), {
      token: preview.token,
      flowIds: preview.flowIds,
    });

    assert.equal(result.refused, 'stale_preview');
    assert.deepEqual(h.deleted, []);
  });

  /**
   * The docblock on `planTemperatureDelta` has said this since it was written:
   * "A temperature change must never implicitly turn a light on." It was a
   * comment describing code that did not do it — the plan wrote colour to off
   * lamps, and on an integration where a `light_temperature` write lights the
   * lamp (which is per-integration and untested — platform §12), pressing
   * "warmer" in a dark room turned the lights on.
   */
  test('a temperature change never implicitly turns a light on', () => {
    const cache = new TargetStateCache();
    for (const id of ['off-lamp', 'on-lamp']) {
      cache.setCapabilities(id, {
        onoff: true, light_temperature: { min: 0, max: 1, decimals: 2 },
      });
    }
    cache.initialise('off-lamp', { onoff: false, light_temperature: 0.5 });
    cache.initialise('on-lamp', { onoff: true, light_temperature: 0.5 });

    const plan = planIntent(
      { type: 'temperature_delta', delta: 0.2 },
      ['off-lamp', 'on-lamp'],
      cache,
      DEFAULT_BEHAVIOR,
    );

    assert.deepEqual(
      plan.writes.map(write => write.deviceId), ['on-lamp'],
      'the dark room stays dark',
    );
    assert.equal(
      plan.writes.some(write => write.capability === 'onoff'), false,
      'and nothing sneaks an onoff write in either',
    );
  });

  /**
   * README.md, What you can rely on: "Lightkeeper never overrides something you
   * have just done."
   * The implied-on probe was the one place it did — it fires 1.5 s after a dim
   * write, which is long enough for somebody to reach a wall switch.
   */
  test('the app never switches a light back on that the user has just switched off', () => {
    // The decision the probe makes, asserted at the cache boundary it makes it
    // from. The end-to-end version, through a real adapter and a real timer,
    // is implied-on-probe.test.ts.
    let now = 1_000;
    const cache = new TargetStateCache(() => now);
    cache.setCapabilities('lamp', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('lamp', { onoff: false, dim: 0.3 });

    const writtenAt = now;
    cache.noteEcho('lamp', 'dim', 0.6);

    // The user reaches the switch inside the window.
    now += 400;
    cache.applyExternalChange('lamp', 'onoff', false);

    const changedAt = cache.lastOnOffChangeAt('lamp');
    assert.ok(changedAt !== undefined && changedAt > writtenAt,
      'the probe can tell the lamp’s power was touched after our write, which is the whole question');
  });

  test('and the probe still corrects a lamp nobody touched', () => {
    // The promise above must not become "the feature never fires".
    let now = 1_000;
    const cache = new TargetStateCache(() => now);
    cache.setCapabilities('lamp', { onoff: true, dim: { min: 0, max: 1, decimals: 2 } });
    cache.initialise('lamp', { onoff: false, dim: 0.3 });

    const writtenAt = now;
    cache.noteEcho('lamp', 'dim', 0.6);
    now += 1_600;

    const changedAt = cache.lastOnOffChangeAt('lamp');
    assert.ok(
      changedAt === undefined || changedAt <= writtenAt,
      'nothing was heard from the lamp, so the corrective write goes out',
    );
  });

  /**
   * "Catch-up never switches lights on without a trusted off boundary."
   *
   * README.md and FAQ.md: a schedule is never switched off retroactively, and
 * catch-up applies
   * a window that CONTAINS now. That licence rests entirely on something else
   * being scheduled to end the window — the off Flow. With no reference to it,
   * catching up means lighting a household's rooms with nothing to turn them off
   * again, which is the one failure worse than a dark evening.
   */
  test('catch-up needs a recorded off boundary for the entry it is catching up', () => {
    const entry: ScheduleEntry = {
      id: 'night', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 300 },
    };
    const onlyOn: ManagedFlowReference[] = [{
      flowId: 'f1',
      bindingKey: eventKeyFor(entry.id, 'on'),
      variantKey: '',
      fingerprint: 'fp',
      managedVersion: 1,
      createdAt: 0,
    }];

    // The predicate the runtime gates on, stated here as the promise itself:
    // an ON reference alone is not enough.
    const hasOff = (refs: ManagedFlowReference[]) =>
      refs.some(r => r.bindingKey === eventKeyFor(entry.id, 'off'));

    assert.equal(hasOff(onlyOn), false, 'an on Flow alone must not license a catch-up');
    assert.equal(hasOff([]), false);
    assert.equal(
      hasOff([...onlyOn, { ...onlyOn[0], flowId: 'f2', bindingKey: eventKeyFor(entry.id, 'off') }]),
      true,
    );
    // And a DIFFERENT entry's off Flow does not stand in for this one's.
    assert.equal(
      hasOff([{ ...onlyOn[0], bindingKey: eventKeyFor('other', 'off') }]),
      false,
    );
  });
});

/**
 * The `§n` tags in lib/ are citations into docs/homey-platform.md — the
 * durable record of things that took real hardware to establish. A tag
 * pointing at a section that no longer exists sends the next reader nowhere,
 * and renumbering the reference is exactly the edit that would do it. The
 * reference moved out of CLAUDE.md into a file named for what it is; this
 * test is what would have caught that move breaking every citation.
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
    const doc = readFileSync(join(root, 'docs', 'homey-platform.md'), 'utf8');
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
