import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleRuntime } from '../../lib/schedules/schedule-runtime';
import {
  sanitiseEntries, sanitiseEntryId, ENTRY_ID_SHAPE,
  type SchedulePlan, type ScheduleEntry,
} from '../../lib/schedules/schedule-types';
import { activeEntries, entriesOverlap } from '../../lib/schedules/schedule-window';
import { eventKeyFor, parseEventKey } from '../../lib/schedules/schedule-bindings';
import { localNowResolved } from '../../lib/time/local-clock';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';
import type { ManagedFlowReference } from '../../lib/profiles/controller-profile';
import { settle as sharedSettle } from '../support/deferred';

/**
 * Two windows over the same lights fight, and the loser is the room.
 *
 * 17:00–23:00 alongside 20:00–01:00 goes dark at 23:00 while the second window
 * still believes the lights are on — and no screen in the app admits to it. Two
 * layers, both needed: the sanitiser refuses to SAVE such a pair, and the runtime
 * recomputes at the boundary because plans stored by earlier versions already
 * contain them.
 *
 * The other thing here is catch-up, the one path that switches lights on without
 * a Flow having fired. It is gated on being able to prove there is something that
 * will switch them off again.
 */

function entry(over: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return { id: 'a', onAt: 22 * 60, days: null, end: { kind: 'duration', minutes: 90 }, ...over };
}

const at = (hhmm: string, minutes: number, over: Partial<ScheduleEntry> = {}): ScheduleEntry => {
  const [h, m] = hhmm.split(':').map(Number);
  return entry({ onAt: h * 60 + m, end: { kind: 'duration', minutes }, ...over });
};

describe('entriesOverlap — the weekly circle', () => {
  test('the review\'s case: 17:00–23:00 and 20:00–01:00', () => {
    assert.equal(entriesOverlap(at('17:00', 360), at('20:00', 300, { id: 'b' })), true);
  });

  test('touching end to start is not an overlap', () => {
    // The off boundary is exclusive everywhere else in this app; it is here too.
    assert.equal(entriesOverlap(at('17:00', 180), at('20:00', 60, { id: 'b' })), false);
  });

  test('cross-midnight against the next morning', () => {
    // Fri 23:30 + 2h runs to Sat 01:30; Sat 00:30 + 1h sits inside it.
    const friNight = at('23:30', 120, { days: [5] });
    const satEarly = at('00:30', 60, { id: 'b', days: [6] });
    assert.equal(entriesOverlap(friNight, satEarly), true);
  });

  test('cross-midnight against the SAME day is a different question', () => {
    // Sun 23:30 + 2h wraps to Monday, so it collides with a Monday 00:30 window
    // even though the two never share a start day.
    assert.equal(
      entriesOverlap(at('23:30', 120, { days: [7] }), at('00:30', 60, { id: 'b', days: [1] })),
      true,
    );
    // Wrapping across the week boundary is the same arithmetic, not a special case.
    assert.equal(
      entriesOverlap(at('23:30', 120, { days: [1] }), at('00:30', 60, { id: 'b', days: [6] })),
      false,
    );
  });

  test('disjoint day sets never overlap, whatever the times', () => {
    assert.equal(
      entriesOverlap(at('10:00', 300, { days: [1, 2] }), at('11:00', 60, { id: 'b', days: [4, 5] })),
      false,
    );
  });

  test('"every day" overlaps anything that overlaps it in time', () => {
    assert.equal(
      entriesOverlap(at('10:00', 120, { days: null }), at('11:00', 60, { id: 'b', days: [3] })),
      true,
    );
    assert.equal(
      entriesOverlap(at('10:00', 60, { days: null }), at('11:00', 60, { id: 'b', days: [3] })),
      false,
    );
  });

  test('an entry always overlaps itself', () => {
    const e = at('07:00', 30);
    assert.equal(entriesOverlap(e, { ...e, id: 'b' }), true);
  });
});

describe('the sanitiser refuses to save an overlap', () => {
  const row = (id: string, onAt: string, minutes: number, days?: number[]) => ({
    id, onAt, end: { kind: 'duration', minutes }, ...(days ? { days } : {}),
  });

  test('the later row is dropped, naming the one it clashes with', () => {
    const { entries, dropped } = sanitiseEntries([
      row('evening', '17:00', 360),
      row('night', '20:00', 300),
    ]);

    assert.deepEqual(entries.map(e => e.id), ['evening']);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'overlaps schedule "evening"');
  });

  test('non-overlapping rows all survive', () => {
    const { entries, dropped } = sanitiseEntries([
      row('morning', '07:00', 60),
      row('evening', '17:00', 120),
      row('night', '23:00', 120),
    ]);
    assert.equal(entries.length, 3);
    assert.equal(dropped.length, 0);
  });

  test('the same times on different days are fine', () => {
    const { entries } = sanitiseEntries([
      row('weekday', '07:00', 60, [1, 2, 3, 4, 5]),
      row('weekend', '07:00', 60, [6, 7]),
    ]);
    assert.equal(entries.length, 2);
  });
});

describe('days is fail-closed', () => {
  const withDays = (days: unknown) => sanitiseEntries([
    { id: 'a', onAt: '07:00', end: { kind: 'duration', minutes: 30 }, days },
  ]);

  test('only null and undefined mean every day', () => {
    assert.equal(withDays(null).entries[0].days, null);
    assert.equal(withDays(undefined).entries[0].days, null);
  });

  test('anything else non-array drops the entry', () => {
    // Silently becoming "every day" did MORE than the user asked for: a Mon–Fri
    // schedule turned into a seven-day one.
    for (const bad of ['1,2,3', { 1: true }, false, 0, 7]) {
      const { entries, dropped } = withDays(bad);
      assert.equal(entries.length, 0, JSON.stringify(bad));
      assert.equal(dropped[0].reason, 'days is not a list');
    }
  });

  test('an array still filters its own members', () => {
    assert.deepEqual(withDays([1, 2, 'x', 9, 2]).entries[0].days, [1, 2]);
    assert.equal(withDays([1, 2, 3, 4, 5, 6, 7]).entries[0].days, null);
    assert.equal(withDays(['x']).dropped[0].reason, 'no days are selected');
  });
});

describe('entry ids are server-generated', () => {
  test('a valid id round-trips through repair unchanged', () => {
    for (const id of ['s0', 'sa1b2c3d4', 'morning-lights', 'A_B-1']) {
      assert.equal(sanitiseEntryId(id), id);
    }
  });

  test('anything that could break the event key is replaced', () => {
    // `sched:<id>:<boundary>` is split on ':', so a colon-bearing id parses as a
    // different entry — or as nothing — and the schedule silently never fires.
    for (const bad of ['a:b', '', '   ', 'x'.repeat(33), undefined, 42, { id: 'a' }, 'a b']) {
      const generated = sanitiseEntryId(bad);
      assert.match(generated, ENTRY_ID_SHAPE, JSON.stringify(bad));
      assert.notEqual(generated, bad);
    }
  });

  test('a generated id survives the event key round-trip', () => {
    const id = sanitiseEntryId('has:colons');
    const parsed = parseEventKey(eventKeyFor(id, 'off'));
    assert.deepEqual(parsed, { entryId: id, boundary: 'off' });
  });

  test('a colon-bearing id from a view is regenerated at save', () => {
    const { entries } = sanitiseEntries([
      { id: 'sched:evil:on', onAt: '07:00', end: { kind: 'duration', minutes: 30 } },
    ]);
    assert.equal(entries.length, 1);
    assert.ok(!entries[0].id.includes(':'));
    assert.match(entries[0].id, ENTRY_ID_SHAPE);
  });

  test('two generated ids do not collide', () => {
    const ids = new Set(Array.from({ length: 200 }, () => sanitiseEntryId(null)));
    assert.equal(ids.size, 200);
  });
});

describe('activeEntries orders by latest started', () => {
  // Tuesday 22:15 local.
  const clock = { minutesOfDay: 22 * 60 + 15, isoWeekday: 2 as const };

  test('the smallest elapsed comes first, whatever the array order', () => {
    const evening = at('17:00', 360, { id: 'evening' });
    const night = at('20:00', 300, { id: 'night' });
    const late = at('22:00', 120, { id: 'late' });

    for (const order of [[evening, night, late], [late, night, evening], [night, late, evening]]) {
      assert.deepEqual(
        activeEntries(order, clock).map(a => a.entry.id),
        ['late', 'night', 'evening'],
      );
    }
  });

  test('entries whose window does not contain now are absent', () => {
    assert.deepEqual(activeEntries([at('07:00', 60)], clock), []);
  });
});

// ---------------------------------------------------------------- the runtime

function light(id: string) {
  return {
    id,
    name: id,
    zoneName: 'Kitchen',
    capabilities: ['onoff', 'dim', 'light_temperature'],
    capabilitiesObj: {
      onoff: { value: false },
      dim: { min: 0, max: 1, decimals: 2, value: 0.5 },
      light_temperature: { min: 0, max: 1, decimals: 2, value: 0.5 },
    },
    available: true,
  };
}

const ref = (bindingKey: string): ManagedFlowReference => ({
  flowId: `f-${bindingKey}`,
  bindingKey,
  variantKey: '',
  fingerprint: 'fp',
  managedVersion: 1,
  createdAt: 0,
});

/** References for every boundary of every entry, as a healthy reconcile leaves. */
function refsFor(entries: ScheduleEntry[]): ManagedFlowReference[] {
  return entries.flatMap(e => [ref(eventKeyFor(e.id, 'on')), ref(eventKeyFor(e.id, 'off'))]);
}

function harness(options: {
  plan: SchedulePlan;
  now?: number;
  timezone?: string;
  timeCard?: unknown;
}) {
  const devices = [light('l1'), light('l2')];
  const writes: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  const states: Array<{ state: string; detail?: any }> = [];
  const logs: string[] = [];

  const api = {
    credentials: { getStatus: () => ({ present: true, valid: true }) },
    async read() {
      return {
        devices: {
          getDevice: async ({ id }: { id: string }) => ({
            async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
              writes.push({ deviceId: id, capability: capabilityId, value });
            },
            makeCapabilityInstance: () => ({ destroy: () => { /* unused */ } }),
          }),
        },
      };
    },
    track: (unsubscribe: unknown) => unsubscribe,
  } as unknown as HomeyApiService;

  const catalog = {
    async device(id: string) { return devices.find(d => d.id === id); },
    async devicesInZone() { return devices; },
  } as unknown as DeviceCatalog;

  const bridge = {
    reconcile: async (_id: string, pass: () => Promise<unknown>) => pass(),
    async sync(request: any) {
      return {
        references: request.mapped.map((input: any, index: number) => ({
          flowId: `f${index}`,
          bindingKey: input.key,
          variantKey: input.variantKey,
          fingerprint: request.fingerprint,
          managedVersion: 1,
          createdAt: 0,
        })),
        created: 0, deleted: 0, reused: 0, unsupported: [], userEdited: [], staleReplacements: [],
      };
    },
    async removeAll() { return 0; },
  } as unknown as FlowBridgeManager;

  const runtime = new ScheduleRuntime('sched-1', options.plan, {
    api,
    catalog,
    bridge,
    timeCard: async () => (options.timeCard !== undefined ? options.timeCard : {
      card: {
        id: 'homey:manager:cron:time_exactly',
        uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly',
        argument: 'time',
      },
      candidates: [],
    }) as any,
    timezone: () => options.timezone ?? 'Europe/Copenhagen',
    displayName: () => 'Kitchen schedule',
    now: () => options.now ?? TUESDAY_2215,
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    onStateChange: (state, detail) => states.push({ state, detail }),
    onPlanChange: async () => { /* the device's job */ },
  });

  return { runtime, writes, states, logs };
}

function plan(entries: ScheduleEntry[], over: Partial<SchedulePlan> = {}): SchedulePlan {
  return {
    schemaVersion: 1,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1', 'l2'] },
    entries,
    managedFlows: refsFor(entries),
    ...over,
  };
}

/**
 * The write queue flushes on the leading edge and does not await the flush it
 * started, so a test that asserts immediately sees only the first write. Yield a
 * few turns rather than sleeping — twelve is well past any burst these tests
 * produce.
 *
 * `settle` itself is `test/support/deferred.ts`'s; three files each carried a
 * private copy of exactly this loop with an incompatible signature, while five
 * other files imported the shared one.
 */
const settle = () => sharedSettle(12);

/** 2026-08-18 is a Tuesday; 20:15 UTC is 22:15 in Copenhagen. */
const TUESDAY_2215 = Date.UTC(2026, 7, 18, 20, 15);
/** 21:00 UTC is 23:00 in Copenhagen — the off boundary of a 17:00–23:00 window. */
const TUESDAY_2300 = Date.UTC(2026, 7, 18, 21, 0);
/** 23:00 UTC is 01:00 on the Wednesday in Copenhagen. */
const WEDNESDAY_0100 = Date.UTC(2026, 7, 18, 23, 0);

describe('an off boundary inside another window is suppressed', () => {
  const evening = at('17:00', 360, { id: 'evening' });
  const night = at('20:00', 300, { id: 'night', brightness: 0.4, temperature: 0.9 });

  test('23:00 does not darken a room the 20:00 window still owns', async () => {
    const h = harness({ plan: plan([evening, night]), now: TUESDAY_2300 });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent(eventKeyFor('evening', 'off'));
    assert.equal(outcome.accepted, true);
    await settle();

    assert.equal(
      h.writes.some(w => w.capability === 'onoff' && w.value === false),
      false,
      'nothing was switched off',
    );
    // The surviving window's own values are re-applied, because that is what the
    // room should be showing.
    assert.ok(h.writes.some(w => w.capability === 'dim'));
    assert.ok(h.writes.some(w => w.capability === 'light_temperature'));
    assert.match(String((h.runtime.diagnostics() as any).lastAction.note), /kept on.*"night"/);
  });

  test('01:00 does darken it, because nothing is left', async () => {
    const h = harness({ plan: plan([evening, night]), now: WEDNESDAY_0100 });
    await h.runtime.startWithoutFlows();

    h.runtime.handleEvent(eventKeyFor('night', 'off'));
    await settle();

    assert.deepEqual(
      h.writes.filter(w => w.capability === 'onoff').map(w => w.value),
      [false, false],
    );
  });

  test('a lone window switches off normally', async () => {
    const h = harness({ plan: plan([evening]), now: TUESDAY_2300 });
    await h.runtime.startWithoutFlows();

    h.runtime.handleEvent(eventKeyFor('evening', 'off'));
    await settle();

    assert.deepEqual(
      h.writes.filter(w => w.capability === 'onoff').map(w => w.value),
      [false, false],
    );
  });

  test('the Test control does exactly what it was asked, overlap or not', async () => {
    const h = harness({ plan: plan([evening, night]), now: TUESDAY_2300 });
    await h.runtime.startWithoutFlows();

    await h.runtime.testEntry('evening', 'off');
    await settle();

    assert.deepEqual(
      h.writes.filter(w => w.capability === 'onoff').map(w => w.value),
      [false, false],
      'a test is a test',
    );
  });

  test('three-way overlap keeps the latest-started one', async () => {
    const late = at('22:00', 180, { id: 'late', brightness: 0.2 });
    const h = harness({ plan: plan([evening, night, late]), now: TUESDAY_2300 });
    await h.runtime.startWithoutFlows();

    h.runtime.handleEvent(eventKeyFor('evening', 'off'));
    await settle();

    assert.match(String((h.runtime.diagnostics() as any).lastAction.note), /"late"/);
  });
});

describe('catch-up applies one window, deterministically', () => {
  test('the latest-started active entry wins, whatever the array order', async () => {
    const evening = at('17:00', 360, { id: 'evening', brightness: 0.9 });
    const night = at('20:00', 300, { id: 'night', brightness: 0.3 });

    for (const entries of [[evening, night], [night, evening]]) {
      const h = harness({ plan: plan(entries), now: TUESDAY_2215 });
      await h.runtime.startWithoutFlows();
      await h.runtime.catchUp();
      await settle();

      const dims = h.writes.filter(w => w.capability === 'dim').map(w => w.value);
      assert.ok(dims.length > 0, 'something was applied');
      // 0.3 perceptual is a lower device value than 0.9; the exact curve is the
      // planner's business, so compare against the other candidate instead.
      assert.ok(
        dims.every(v => Number(v) < 0.6),
        `the night window's level should have won, got ${JSON.stringify(dims)}`,
      );
    }
  });

  test('a window that already ended is left alone', async () => {
    const h = harness({ plan: plan([at('07:00', 60)]), now: TUESDAY_2215 });
    await h.runtime.startWithoutFlows();
    await h.runtime.catchUp();
    await settle();
    assert.deepEqual(h.writes, []);
  });

  test('a cross-midnight window on a restricted day catches up on the right day', async () => {
    // Tuesday 23:00 + 3h. At 01:00 Wednesday the window is Tuesday's.
    const tuesdayNight = at('23:00', 180, { id: 'tue', days: [2] });
    const h = harness({ plan: plan([tuesdayNight]), now: WEDNESDAY_0100 });
    await h.runtime.startWithoutFlows();
    await h.runtime.catchUp();
    await settle();
    assert.ok(h.writes.some(w => w.capability === 'onoff' && w.value === true));

    // The same clock against a Wednesday-only window is not inside anything.
    const wednesdayNight = at('23:00', 180, { id: 'wed', days: [3] });
    const other = harness({ plan: plan([wednesdayNight]), now: WEDNESDAY_0100 });
    await other.runtime.startWithoutFlows();
    await other.runtime.catchUp();
    await settle();
    assert.deepEqual(other.writes, []);
  });
});

describe('catch-up refuses without a trusted off boundary', () => {
  const active = at('20:00', 300, { id: 'night' });

  const refusal = (runtime: ScheduleRuntime) =>
    (runtime.diagnostics() as any).catchUpRefusals as Array<{ entryId: string; reason: string }>;

  test('no off reference means no catch-up', async () => {
    // The on Flow exists, the off Flow does not. Switching the lights on now
    // means switching them on with nothing scheduled to switch them off.
    const h = harness({
      plan: plan([active], { managedFlows: [ref(eventKeyFor('night', 'on'))] }),
      now: TUESDAY_2215,
    });
    await h.runtime.startWithoutFlows();
    await h.runtime.catchUp();
    await settle();

    assert.deepEqual(h.writes, []);
    assert.match(refusal(h.runtime)[0].reason, /no off boundary/);
    assert.equal(refusal(h.runtime)[0].entryId, 'night');
  });

  test('no references at all means no catch-up', async () => {
    const h = harness({ plan: plan([active], { managedFlows: [] }), now: TUESDAY_2215 });
    await h.runtime.startWithoutFlows();
    await h.runtime.catchUp();
    await settle();
    assert.deepEqual(h.writes, []);
  });

  test('unhealthy Flows mean no catch-up', async () => {
    // No time card on this Homey: reconciliation marks the Flows untrustworthy,
    // so nothing is going to fire and catch-up must not stand in for it.
    const h = harness({
      plan: plan([active]),
      now: TUESDAY_2215,
      timeCard: { card: null, candidates: [] },
    });
    await h.runtime.start();
    await settle();

    assert.deepEqual(h.writes, []);
    assert.match(refusal(h.runtime)[0].reason, /untrustworthy/);
  });

  test('an unresolved timezone means no catch-up, and repairs the device', async () => {
    const h = harness({ plan: plan([active]), now: TUESDAY_2215, timezone: 'Mars/Olympus_Mons' });
    await h.runtime.start();
    await settle();

    assert.deepEqual(h.writes, []);
    assert.match(refusal(h.runtime)[0].reason, /timezone unresolved/);
    assert.ok(
      h.states.some(s => s.state === 'needs_repair' && s.detail?.key === 'state.noTimezone'),
      JSON.stringify(h.states),
    );
  });

  test('a paused schedule does not catch up, and records nothing', async () => {
    const h = harness({ plan: plan([active], { enabled: false }), now: TUESDAY_2215 });
    await h.runtime.startWithoutFlows();
    await h.runtime.catchUp();
    await settle();
    assert.deepEqual(h.writes, []);
    assert.deepEqual(refusal(h.runtime), []);
  });

  test('the healthy path still catches up', async () => {
    const h = harness({ plan: plan([active]), now: TUESDAY_2215 });
    await h.runtime.start();
    await settle();

    assert.ok(h.writes.some(w => w.capability === 'onoff' && w.value === true));
    assert.deepEqual(refusal(h.runtime), []);
  });
});

describe('an unresolved timezone blocks boundary events too', () => {
  test('a boundary is refused with the reason, rather than run on a guess', async () => {
    const h = harness({
      plan: plan([at('20:00', 300, { id: 'night' })]),
      now: TUESDAY_2215,
      timezone: 'Nowhere/At_All',
    });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent(eventKeyFor('night', 'off'));
    assert.equal(outcome.accepted, false);
    assert.match(String(outcome.reason), /timezone unresolved/);
    await settle();
    assert.deepEqual(h.writes, []);
  });

  test('diagnostics say which clock is in use', async () => {
    const good = harness({ plan: plan([at('20:00', 60)]), now: TUESDAY_2215 });
    assert.equal((good.runtime.diagnostics() as any).timezoneResolved, true);

    const bad = harness({ plan: plan([at('20:00', 60)]), now: TUESDAY_2215, timezone: 'Nope/Nope' });
    assert.equal((bad.runtime.diagnostics() as any).timezoneResolved, false);
  });

  test('localNowResolved reports the fallback honestly', () => {
    assert.equal(localNowResolved('Europe/Copenhagen', TUESDAY_2215).resolved, true);
    assert.equal(localNowResolved(undefined, TUESDAY_2215).resolved, false);
    assert.equal(localNowResolved('Not/AZone', TUESDAY_2215).resolved, false);
    // The clock is still usable in every case — that is why it is a fallback and
    // not an exception.
    assert.equal(typeof localNowResolved(undefined, TUESDAY_2215).clock.minutesOfDay, 'number');
  });
});
