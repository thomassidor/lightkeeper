import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bindingsFor, bindingsForPlan, boundaryLabel, daysLabel, eventKeyFor, parseEventKey,
} from '../../lib/schedules/schedule-bindings';
import { discoverTimeCard, timeArgumentValue } from '../../lib/schedules/time-card-discovery';
import { migrateSchedulePlan, CURRENT_SCHEDULE_SCHEMA_VERSION } from '../../lib/schedules/schedule-migrations';
import type { ScheduleEntry } from '../../lib/schedules/schedule-types';
import { FlowBridgeManager, hasBeenUserEdited } from '../../lib/bridge/flow-bridge-manager';
import { compileBinding } from '../../lib/bridge/flow-binding-compiler';
import type { HomeyApiService } from '../../lib/homey-api-service';

/**
 * A schedule reaches the Homey as two generated Flows, through the same compiler
 * and the same reconciler a remote's Flows go through. The traps are all in that
 * shared path:
 *
 *  - a card URI may never be constructed, only echoed back from enumeration (§3);
 *  - reuse is keyed on (binding key, variant key) plus fingerprint and a reused
 *    Flow's trigger is never rewritten, so the TIME has to be in the variant key
 *    or a retimed schedule keeps firing at the old time;
 *  - a Flow the user edited by hand is never overwritten, and editing the time in
 *    the Flow itself is exactly that.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
/** The real card, as confirmed on hardware. */
const TIME_CARD = {
  id: 'homey:manager:cron:time_exactly',
  uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
  argument: 'time',
};

function entry(over: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return { id: 'a', onAt: 22 * 60, days: null, end: { kind: 'duration', minutes: 90 }, ...over };
}

function cardId(shortId: string) {
  return `${APP_ID}:${shortId}`;
}

/**
 * `prefix` gives each harness its own flow ids. Without it the second sync's
 * newly created flows were handed the same ids as the first's, and sync's own
 * "never delete a flow we just created" guard correctly refused to delete them —
 * a fixture artefact that reads exactly like a deletion bug.
 */
function bridgeHarness(flows: Record<string, unknown> = {}, prefix = 'new') {
  const created: any[] = [];
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
      getFlowFolders: async () => ({}),
      createFlowFolder: async () => ({ id: 'folder' }),
      createFlow: async ({ flow }: any) => {
        created.push(flow);
        return { id: `${prefix}-${created.length}` };
      },
      deleteFlow: async ({ id }: { id: string }) => { deleted.push(id); },
    },
  };

  const api = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  return { bridge: new FlowBridgeManager(api, APP_ID, () => { /* quiet */ }), created, deleted };
}

describe('schedule event keys', () => {
  test('round-trip through the bridge argument', () => {
    assert.equal(eventKeyFor('abc', 'on'), 'sched:abc:on');
    assert.deepEqual(parseEventKey('sched:abc:off'), { entryId: 'abc', boundary: 'off' });
  });

  test('anything malformed parses to null, because the argument is untrusted', () => {
    // These arrive from a Flow the user can edit, so a lenient parse would let a
    // typo drive someone's lights.
    for (const key of ['sched:abc', 'sched::on', 'sched:abc:maybe', 'x:abc:on',
      'sched:abc:on:extra', '', 'n2_on|press']) {
      assert.equal(parseEventKey(key), null, key);
    }
  });
});

describe('schedule labels', () => {
  test('common day sets read as phrases, not lists', () => {
    assert.equal(daysLabel(null), 'every day');
    assert.equal(daysLabel([1, 2, 3, 4, 5, 6, 7]), 'every day');
    assert.equal(daysLabel([1, 2, 3, 4, 5]), 'Mon–Fri');
    assert.equal(daysLabel([6, 7]), 'weekends');
    assert.equal(daysLabel([1, 3]), 'Mon, Wed');
  });

  test('a boundary label names the time it actually fires at', () => {
    const e = entry({ onAt: 23 * 60, end: { kind: 'duration', minutes: 120 }, days: [5] });
    assert.equal(boundaryLabel(e, 'on'), 'On at 23:00, Fri');
    assert.equal(boundaryLabel(e, 'off'), 'Off at 01:00, Fri');
  });
});

describe('schedule bindings', () => {
  test('one fixed-argument binding per boundary', () => {
    const [on, off] = bindingsFor(entry(), TIME_CARD);

    assert.equal(on!.key, 'sched:a:on');
    assert.equal(off!.key, 'sched:a:off');
    // Echoed verbatim: never `homey:app:<appId>`, never assembled here.
    assert.equal(on!.binding.cardOwnerUri, TIME_CARD.uri);
    assert.deepEqual((on!.binding as any).args, { time: '22:00' });
    assert.deepEqual((off!.binding as any).args, { time: '23:30' });
  });

  test('the variant key carries the time', () => {
    assert.equal(bindingsFor(entry(), TIME_CARD)[0]!.variantKey, 'at:22:00');
    assert.equal(bindingsFor(entry({ onAt: 6 * 60 + 5 }), TIME_CARD)[0]!.variantKey, 'at:06:05');
  });

  test('a whole plan compiles to two flows per schedule', () => {
    const bindings = bindingsForPlan([entry(), entry({ id: 'b', onAt: 7 * 60 })], TIME_CARD);
    assert.deepEqual(bindings.map(b => b.key), ['sched:a:on', 'sched:a:off', 'sched:b:on', 'sched:b:off']);
  });

  test('the compiler puts the time in the trigger and the key in our action', () => {
    const [on] = bindingsFor(entry(), TIME_CARD);
    const flows = compileBinding({
      controllerId: 'sched-1',
      bindingKey: on!.key,
      binding: on!.binding,
      variantKey: on!.variantKey!,
      cards: {
        event: { id: cardId('bridge_event'), uri: `homey:flowcardaction:${cardId('bridge_event')}` },
        numeric: { id: cardId('bridge_numeric_event'), uri: 'x' },
        token: { id: cardId('bridge_token_event'), uri: 'y' },
      },
      label: boundaryLabel(entry(), 'on'),
      sourceName: 'Kitchen schedule',
    });

    assert.equal(flows.length, 1);
    assert.equal(flows[0]!.variantKey, 'at:22:00');
    assert.equal(flows[0]!.name, 'Lightkeeper — Kitchen schedule: On at 22:00, every day');
    assert.deepEqual(flows[0]!.trigger, { id: TIME_CARD.id, uri: TIME_CARD.uri, args: { time: '22:00' } });
    assert.deepEqual(flows[0]!.actions[0]!.args, { controller: 'sched-1', event_key: 'sched:a:on' });
  });
});

describe('retiming a schedule', () => {
  const fingerprint = `time:${TIME_CARD.id}:${TIME_CARD.argument}`;

  async function syncEntry(h: ReturnType<typeof bridgeHarness>, e: ScheduleEntry, existing: any[] = []) {
    return h.bridge.sync({
      controllerId: 'sched-1',
      sourceName: 'Kitchen schedule',
      fingerprint,
      mapped: bindingsForPlan([e], TIME_CARD),
      existing,
    });
  }

  test('an unchanged schedule reuses its flows', async () => {
    const first = bridgeHarness();
    const initial = await syncEntry(first, entry());
    assert.equal(initial.created, 2);

    const live = Object.fromEntries(first.created.map((flow, index) => [`new-${index + 1}`, {
      id: `new-${index + 1}`, name: flow.name, trigger: flow.trigger, actions: flow.actions,
    }]));

    const second = bridgeHarness(live, 'second');
    const again = await syncEntry(second, entry(), initial.references);
    assert.equal(again.reused, 2);
    assert.equal(again.created, 0);
    assert.deepEqual(second.deleted, []);
  });

  test('changing the time replaces the flow rather than reusing it', async () => {
    const first = bridgeHarness();
    const initial = await syncEntry(first, entry());

    const live = Object.fromEntries(first.created.map((flow, index) => [`new-${index + 1}`, {
      id: `new-${index + 1}`, name: flow.name, trigger: flow.trigger, actions: flow.actions,
    }]));

    const second = bridgeHarness(live, 'second');
    const retimed = await syncEntry(second, entry({ onAt: 23 * 60 }), initial.references);

    // Both boundaries moved, so both flows are new and both old ones are gone.
    // Without the time in the variant key this reported "2 reused" and the
    // schedule went on firing at 22:00.
    assert.equal(retimed.created, 2);
    assert.equal(retimed.reused, 0);
    assert.deepEqual(second.deleted.sort(), ['new-1', 'new-2']);
    assert.deepEqual(
      second.created.map(flow => flow.trigger.args.time).sort(),
      ['00:30', '23:00'],
    );
  });
});

describe('a flow edited by hand', () => {
  const compiled = {
    variantKey: 'at:22:00',
    name: 'Lightkeeper — Kitchen schedule: On at 22:00, every day',
    trigger: { id: TIME_CARD.id, uri: TIME_CARD.uri, args: { time: '22:00' } },
    actions: [{
      id: cardId('bridge_event'),
      uri: `homey:flowcardaction:${cardId('bridge_event')}`,
      group: 'then',
      args: { controller: 'sched-1', event_key: 'sched:a:on' },
    }],
  };

  test('an untouched flow is not user-edited', () => {
    assert.equal(hasBeenUserEdited({ trigger: compiled.trigger, actions: compiled.actions }, compiled), false);
  });

  test('a time changed in the Flow itself counts as user-edited', () => {
    // The trigger id and our action arguments are still exactly what we wrote,
    // so before trigger arguments were compared this read as untouched and the
    // user's edit was silently ignored.
    const edited = {
      trigger: { id: TIME_CARD.id, uri: TIME_CARD.uri, args: { time: '06:30' } },
      actions: compiled.actions,
    };
    assert.equal(hasBeenUserEdited(edited, compiled), true);
  });

  test('extra arguments Homey echoes back are not an edit', () => {
    const echoed = {
      trigger: { id: TIME_CARD.id, uri: TIME_CARD.uri, args: { time: '22:00', tokens: [] } },
      actions: compiled.actions,
    };
    assert.equal(hasBeenUserEdited(echoed, compiled), false);
  });
});

describe('finding Homey\'s time trigger card', () => {
  /**
   * Transcribed from a diagnostics export off a real Homey Pro 2023 (firmware
   * 13.4.0) — these are the cards it actually offered, including the three it
   * offered that must NOT be chosen.
   */
  const cards = [
    {
      id: 'homey:manager:cron:time_exactly',
      uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
      args: [{ name: 'time', type: 'time' }],
    },
    {
      id: 'homey:manager:cron:time_exactly_day',
      uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly_day',
      args: [{ name: 'time', type: 'time' }, { name: 'day', type: 'multiselect' }],
    },
    {
      id: 'homey:manager:energy:dynamic_electricity_price_period_lowest_start_between',
      uri: 'u3',
      args: [{ name: 'duration', type: 'number' }, { name: 'unit', type: 'dropdown' },
        { name: 'startTime', type: 'time' }, { name: 'endTime', type: 'time' }],
    },
    { id: 'homey:manager:cron:every', uri: 'u4', args: [{ name: 'minutes', type: 'number' }] },
  ];

  test('matches on shape, and echoes the uri back verbatim', () => {
    const { card } = discoverTimeCard(cards);
    assert.deepEqual(card, {
      id: 'homey:manager:cron:time_exactly',
      uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
      argument: 'time',
    });
  });

  test('the day-filtered sibling is declined, and that is deliberate', () => {
    // `time_exactly_day` carries the weekday itself, which sounds like exactly
    // what a schedule wants. It is not taken: the day set would then live in the
    // Flow, so every day-of-week edit would rewrite Flows, and its `multiselect`
    // value tokens are not something we can enumerate ahead of time. The app
    // checks the weekday on receipt instead. See CLAUDE.md §9.
    const { candidates } = discoverTimeCard(cards);
    const sibling = candidates.find(c => c.id === 'homey:manager:cron:time_exactly_day');
    assert.match(sibling!.note, /not only that/);
  });

  test('a confirmed id outranks an unknown card of the same shape', () => {
    // Ranking, never filtering: an unfamiliar card still works if it is the only
    // one, but where both are on offer the one seen on hardware wins.
    const { card } = discoverTimeCard([
      { id: 'homey:manager:somethingelse:at_time', uri: 'u1', args: [{ name: 'time', type: 'time' }] },
      cards[0]!,
    ]);
    assert.equal(card!.id, 'homey:manager:cron:time_exactly');
  });

  test('declines an app-provided card, however well named', () => {
    // An app's cards exist only while that app is running (§3), which is not a
    // dependency to take on for the thing that fires every schedule.
    const { card } = discoverTimeCard([
      { id: 'com.someone.timer:at_time', uri: 'u', args: [{ name: 'time', type: 'time' }] },
    ]);
    assert.equal(card, null);
  });

  test('a card with no uri is unusable rather than half-usable', () => {
    const { card } = discoverTimeCard([
      { id: 'homey:manager:cron:time_exactly', args: [{ name: 'time', type: 'time' }] },
    ]);
    assert.equal(card, null);
  });

  test('reports the candidates it considered, for a firmware nobody has seen', () => {
    const { candidates } = discoverTimeCard(cards);
    // Everything carrying a time argument is listed, usable or not — the note says
    // which, and that list is what a report from an unseen firmware turns on.
    assert.deepEqual(candidates.map(c => c.id), [
      'homey:manager:cron:time_exactly',
      'homey:manager:cron:time_exactly_day',
      'homey:manager:energy:dynamic_electricity_price_period_lowest_start_between',
    ]);
    assert.match(candidates[0]!.args, /time:time/);
    assert.match(candidates[0]!.note, /usable/);
  });

  test('the argument value is a wall-clock string', () => {
    assert.equal(timeArgumentValue(22 * 60 + 5), '22:05');
    assert.equal(timeArgumentValue(0), '00:00');
  });
});

describe('schedule plan migration', () => {
  test('fills in the defaults a version-less plan predates', () => {
    const { plan, migrated, fromVersion } = migrateSchedulePlan({
      target: { kind: 'devices', deviceIds: ['l1'] },
    });

    assert.equal(migrated, true);
    assert.equal(fromVersion, 0);
    assert.equal(plan.schemaVersion, CURRENT_SCHEDULE_SCHEMA_VERSION);
    assert.equal(plan.enabled, true);
    assert.deepEqual(plan.entries, []);
    assert.deepEqual(plan.managedFlows, []);
  });

  test('a current plan is left alone', () => {
    const stored = {
      schemaVersion: CURRENT_SCHEDULE_SCHEMA_VERSION,
      enabled: false,
      target: { kind: 'devices', deviceIds: ['l1'] },
      entries: [{ id: 'a', onAt: 60, days: null, end: { kind: 'duration', minutes: 30 } }],
      managedFlows: [],
    };
    const { plan, migrated } = migrateSchedulePlan(stored);
    assert.equal(migrated, false);
    assert.deepEqual(plan, stored as never);
  });

  test('refuses a plan from a newer version rather than corrupting it', () => {
    assert.throws(
      () => migrateSchedulePlan({ schemaVersion: CURRENT_SCHEDULE_SCHEMA_VERSION + 1 }),
      /newer than this app understands/,
    );
    assert.throws(() => migrateSchedulePlan(null), /not an object/);
  });
});
