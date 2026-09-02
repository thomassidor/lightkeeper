import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ScheduleRuntime } from '../../lib/schedules/schedule-runtime';
import type { SchedulePlan } from '../../lib/schedules/schedule-types';
import { eventKeyFor } from '../../lib/schedules/schedule-bindings';
import type { DeviceCatalog } from '../../lib/device-catalog';
import type { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { settle as sharedSettle } from '../support/deferred';

/**
 * What a schedule runtime is responsible for is exactly what a generated Flow
 * cannot express: whether today is one of this schedule's days, whether it is
 * paused, whether a window is already in progress after a restart, and what "on"
 * means for a set of lights that may not all dim.
 *
 * Every event here arrives the way the real one does — from a Flow whose
 * arguments the user can edit — so refusals matter as much as the writes.
 */

interface FakeDevice {
  id: string;
  name: string;
  zoneName: string;
  capabilities: string[];
  capabilitiesObj: Record<string, unknown>;
  available: boolean;
}

function light(id: string, capabilities: string[] = ['onoff', 'dim', 'light_temperature']): FakeDevice {
  const capabilitiesObj: Record<string, unknown> = {};
  if (capabilities.includes('onoff')) capabilitiesObj.onoff = { value: false };
  if (capabilities.includes('dim')) capabilitiesObj.dim = { min: 0, max: 1, decimals: 2, value: 0.5 };
  if (capabilities.includes('light_temperature')) {
    capabilitiesObj.light_temperature = { min: 0, max: 1, decimals: 2, value: 0.5 };
  }
  return { id, name: id, zoneName: 'Kitchen', capabilities, capabilitiesObj, available: true };
}

function harness(options: {
  plan: SchedulePlan;
  devices?: FakeDevice[];
  now?: number;
  timezone?: string;
  credentialValid?: boolean;
  timeCard?: unknown;
  /**
   * Return a reference for the ON boundary only, as a half-finished reconcile
   * does — or a Flow the user deleted, or a dead key at first save.
   *
   * Catch-up's licence to switch lights on rests on something being scheduled to
   * switch them off again, and reconciliation normally supplies both references
   * before catch-up runs. This is how a test reaches the gate at all.
   */
  onlyOnBoundary?: boolean;
} = { plan: plan() }) {
  const devices = options.devices ?? [light('l1'), light('l2')];
  const writes: Array<{ deviceId: string; capability: string; value: unknown }> = [];
  const states: Array<{ state: string; detail?: unknown }> = [];
  const synced: unknown[] = [];
  const logs: string[] = [];

  const deviceHandle = (id: string) => ({
    async setCapabilityValue({ capabilityId, value }: { capabilityId: string; value: unknown }) {
      writes.push({ deviceId: id, capability: capabilityId, value });
    },
    makeCapabilityInstance: () => ({ destroy: () => { /* unused */ } }),
  });

  const api = {
    credentials: {
      getStatus: () => ({
        present: true,
        valid: options.credentialValid ?? true,
      }),
    },
    async read() {
      return { devices: { getDevice: async ({ id }: { id: string }) => deviceHandle(id) } };
    },
    track: (unsubscribe: unknown) => unsubscribe,
  } as unknown as HomeyApiService;

  const catalog = {
    async device(id: string) { return devices.find(d => d.id === id); },
    async devicesInZone() { return devices; },
  } as unknown as DeviceCatalog;

  const bridge = {
    /**
     * The real one single-flights per device (see FlowBridgeManager). Straight
     * through here on purpose: coalescing has its own tests against the real
     * class, and a double that reimplemented it would be testing the double.
     */
    reconcile: async (_deviceId: string, pass: () => Promise<unknown>) => pass(),
    async sync(request: unknown) {
      synced.push(request);
      const mapped = (request as any).mapped
        .filter((input: any) => !(options.onlyOnBoundary && String(input.key).endsWith(':off')));
      return {
        references: mapped.map((input: any, index: number) => ({
          flowId: `f${index}`,
          bindingKey: input.key,
          variantKey: input.variantKey,
          fingerprint: (request as any).fingerprint,
          managedVersion: 1,
          createdAt: 0,
        })),
        created: 2, deleted: 0, reused: 0, unsupported: [], userEdited: [], staleReplacements: [],
      };
    },
    async removeAll() { return 0; },
  } as unknown as FlowBridgeManager;

  const runtime = new ScheduleRuntime('sched-1', options.plan, {
    api,
    catalog,
    bridge,
    timeCard: async () => (options.timeCard !== undefined
      ? options.timeCard
      : { card: { id: 'homey:manager:cron:time_exactly', uri: 'homey:flowcardtrigger:homey:manager:cron:time_exactly', argument: 'time' }, candidates: [] }) as any,
    timezone: () => options.timezone ?? 'Europe/Copenhagen',
    displayName: () => 'Kitchen schedule',
    now: () => options.now ?? Date.UTC(2026, 7, 18, 20, 15),
    log: (...args: unknown[]) => logs.push(args.join(' ')),
    onStateChange: (state, detail) => states.push({ state, detail }),
    onPlanChange: async () => { /* persistence is the device's job */ },
  });

  return { runtime, writes, states, synced, logs };
}

function plan(over: Partial<SchedulePlan> = {}): SchedulePlan {
  return {
    schemaVersion: 1,
    enabled: true,
    target: { kind: 'devices', deviceIds: ['l1', 'l2'] },
    entries: [{ id: 'a', onAt: 22 * 60, days: null, end: { kind: 'duration', minutes: 90 } }],
    managedFlows: [],
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
const TUESDAY_1000 = Date.UTC(2026, 7, 18, 8, 0);

describe('schedule boundaries', () => {
  test('an on event switches every target on', async () => {
    const h = harness({ plan: plan(), now: TUESDAY_1000 });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent(eventKeyFor('a', 'on'));
    assert.equal(outcome.accepted, true);
    await settle();

    assert.deepEqual(
      h.writes.filter(w => w.capability === 'onoff').map(w => w.value),
      [true, true],
    );
  });

  test('an off event switches them off', async () => {
    const h = harness({ plan: plan(), now: TUESDAY_1000 });
    await h.runtime.startWithoutFlows();
    await h.runtime.testEntry('a', 'off');
    await settle();

    assert.deepEqual(h.writes, [
      { deviceId: 'l1', capability: 'onoff', value: false },
      { deviceId: 'l2', capability: 'onoff', value: false },
    ]);
  });

  test('brightness and warmth are applied after the power write', async () => {
    const h = harness({
      plan: plan({
        entries: [{
          id: 'a', onAt: 22 * 60, days: null,
          end: { kind: 'duration', minutes: 90 },
          brightness: 0.5, temperature: 0.2,
        }],
      }),
      now: TUESDAY_1000,
    });
    await h.runtime.startWithoutFlows();
    await h.runtime.testEntry('a', 'on');
    await settle();

    // onoff before dim, so the level lands on a lit lamp — the write queue's
    // ordering, not ours.
    assert.deepEqual(
      h.writes.filter(w => w.deviceId === 'l1').map(w => w.capability),
      ['onoff', 'dim', 'light_temperature'],
    );

    // Brightness is stored perceptually: 0.5 perceptual is 0.5^2.2 ≈ 0.22 of
    // the device's own range, quantised to the capability's two decimals.
    const dim = h.writes.find(w => w.deviceId === 'l1' && w.capability === 'dim');
    assert.equal(dim!.value, 0.22);
    const temperature = h.writes.find(w => w.capability === 'light_temperature');
    assert.equal(temperature!.value, 0.2);
  });

  test('a light that cannot dim still gets switched on', async () => {
    const h = harness({
      plan: plan({
        target: { kind: 'devices', deviceIds: ['plain', 'dimmer'] },
        entries: [{
          id: 'a', onAt: 22 * 60, days: null,
          end: { kind: 'duration', minutes: 90 }, brightness: 0.5,
        }],
      }),
      devices: [light('plain', ['onoff']), light('dimmer', ['onoff', 'dim'])],
      now: TUESDAY_1000,
    });
    await h.runtime.startWithoutFlows();
    const result = await h.runtime.testEntry('a', 'on');
    await settle();

    assert.deepEqual(h.writes.filter(w => w.deviceId === 'plain').map(w => w.capability), ['onoff']);
    assert.deepEqual(h.writes.filter(w => w.deviceId === 'dimmer').map(w => w.capability), ['onoff', 'dim']);
    // Partial support is not partial failure: nothing is reported as skipped,
    // because every light did get the part of the intent it can perform.
    assert.equal(result.skipped, 0);
  });
});

describe('refusing an event', () => {
  test('a key that is not a schedule boundary is refused', async () => {
    const h = harness({ plan: plan() });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent('n2_on|press');
    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason!, /not a schedule event key/);
    assert.equal(h.writes.length, 0);
  });

  test('an unknown entry id is refused, not guessed at', async () => {
    const h = harness({ plan: plan() });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent(eventKeyFor('gone', 'on'));
    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason!, /is not in this device's plan/);
  });

  test('a paused schedule refuses everything', async () => {
    const h = harness({ plan: plan({ enabled: false }) });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent(eventKeyFor('a', 'on'));
    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason!, /paused/);
  });

  test('a day the schedule does not run on is refused', async () => {
    // Tuesday, and the schedule runs at weekends only.
    const h = harness({
      plan: plan({ entries: [{ id: 'a', onAt: 22 * 60, days: [6, 7], end: { kind: 'duration', minutes: 90 } }] }),
      now: TUESDAY_2215,
    });
    await h.runtime.startWithoutFlows();

    const outcome = h.runtime.handleEvent(eventKeyFor('a', 'on'));
    assert.equal(outcome.accepted, false);
    assert.match(outcome.reason!, /not one of this schedule's days/);
    assert.equal(h.writes.length, 0);
  });

  test('the off event of a midnight-crossing window is accepted on the following day', async () => {
    // Saturday 00:30 local. The window began at 23:30 on Friday, which is the
    // day the schedule actually runs.
    const saturday0030 = Date.UTC(2026, 7, 21, 22, 30);
    const h = harness({
      plan: plan({
        entries: [{
          id: 'a', onAt: 23 * 60 + 30, days: [5], end: { kind: 'duration', minutes: 120 },
        }],
      }),
      now: saturday0030,
    });
    await h.runtime.startWithoutFlows();

    assert.equal(h.runtime.handleEvent(eventKeyFor('a', 'off')).accepted, true);
    // The on event on that same Saturday is not Friday's, and is refused.
    assert.equal(h.runtime.handleEvent(eventKeyFor('a', 'on')).accepted, false);
  });
});

describe('catch-up after a restart', () => {
  test('applies a window that is already in progress', async () => {
    // 22:15 local, inside 22:00–23:30.
    const h = harness({ plan: plan(), now: TUESDAY_2215 });
    await h.runtime.start();
    await settle();

    assert.ok(h.writes.some(w => w.capability === 'onoff' && w.value === true));
    assert.ok(h.logs.some(line => line.includes('Catching up')));
  });

  test('does nothing for a window that has already ended', async () => {
    // 10:00 local, hours after the evening window.
    const h = harness({ plan: plan(), now: TUESDAY_1000 });
    await h.runtime.start();

    // Deliberate: switching a user's lights off at app start, on the guess that
    // we might once have switched them on, is the worse surprise.
    assert.equal(h.writes.length, 0);
  });

  test('a paused schedule is not caught up', async () => {
    const h = harness({ plan: plan({ enabled: false }), now: TUESDAY_2215 });
    await h.runtime.start();
    assert.equal(h.writes.length, 0);
  });
});

describe('flow reconciliation', () => {
  test('two flows per schedule, with the time in the variant key', async () => {
    const h = harness({ plan: plan(), now: TUESDAY_1000 });
    await h.runtime.start();

    const request = h.synced[0] as any;
    assert.equal(request.mapped.length, 2);
    assert.deepEqual(request.mapped.map((m: any) => m.key), ['sched:a:on', 'sched:a:off']);
    assert.deepEqual(request.mapped.map((m: any) => m.variantKey), ['at:22:00', 'at:23:30']);
    // The trigger argument is the wall-clock time, and the card is echoed back
    // from enumeration rather than constructed.
    assert.deepEqual(request.mapped[0].binding.fixedArgs, { time: '22:00' });
    assert.equal(request.mapped[0].binding.cardId, 'homey:manager:cron:time_exactly');
    assert.equal(h.runtime.currentPlan.managedFlows.length, 2);
  });

  test('a schedule is reconciled even while paused', async () => {
    // Pausing is "do not act", not "throw the Flows away".
    const h = harness({ plan: plan({ enabled: false }), now: TUESDAY_1000 });
    await h.runtime.start();
    assert.equal(h.synced.length, 1);
    assert.equal(h.runtime.currentState, 'disabled');
  });

  test('no usable time card leaves the schedule in repair, and says what it saw', async () => {
    const h = harness({
      plan: plan(),
      now: TUESDAY_1000,
      timeCard: { card: null, candidates: [{ id: 'homey:manager:cron:every', args: 'minutes:number', note: 'no time argument' }] },
    });
    await h.runtime.start();

    assert.equal(h.runtime.currentState, 'needs_repair');
    assert.deepEqual(h.states[0], { state: 'needs_repair', detail: { key: 'state.noTimeCard' } });
    assert.ok(h.logs.some(line => line.includes('homey:manager:cron:every')));
  });

  test('a dead API key is reported as needing a key, not as needing repair', async () => {
    const h = harness({ plan: plan(), now: TUESDAY_1000, credentialValid: false });
    await h.runtime.start();
    assert.equal(h.runtime.currentState, 'needs_credential');
  });
});

describe('teardown', () => {
  test('stop() drops the write queue so nothing fires afterwards', async () => {
    const h = harness({ plan: plan(), now: TUESDAY_1000 });
    await h.runtime.startWithoutFlows();
    await h.runtime.stop();

    // No scheduler, no targets: the event is accepted (it is a valid schedule on
    // a valid day) but recorded as dropped rather than writing to a light the
    // runtime no longer owns.
    h.runtime.handleEvent(eventKeyFor('a', 'off'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.writes.length, 0);
    assert.equal((h.runtime.diagnostics().lastAction as any)?.note, 'no targets');
  });

  test('diagnostics carry the clock, the windows and no key material', async () => {
    const h = harness({ plan: plan(), now: TUESDAY_2215 });
    await h.runtime.startWithoutFlows();

    const diagnostics = h.runtime.diagnostics();
    assert.equal(diagnostics.timezone, 'Europe/Copenhagen');
    assert.equal(diagnostics.localTime, 'Tue 22:15');
    /**
     * `end` is carried raw, beside the computed `off`.
     *
     * The clock strings are lossy: "until 23:30" and "for 90 minutes from
     * 22:00" render identically and are not the same stored thing. A bug report
     * reads differently depending on which the user set, and anything that reads
     * a schedule and writes it back would otherwise rewrite every duration as a
     * time.
     */
    assert.deepEqual(diagnostics.entries, [{
      id: 'a', on: '22:00', off: '23:30', days: 'every day', active: true,
      end: { kind: 'duration', minutes: 90 },
    }]);
    assert.ok(!JSON.stringify(diagnostics).includes('token'));
  });
});

/**
 * A schedule whose last window the user deleted.
 *
 * `reconcileFlows()` used to return early on an empty entry list, so the two
 * generated Flows of the window that had just been removed stayed live and the
 * plan went on referencing them. The lights kept switching at a time the app's
 * own screens no longer showed — and because the references were still there,
 * nothing read as orphaned either.
 */
describe('a schedule emptied of every window', () => {

  test('reconciles its flows away instead of returning early', async () => {
    const h = harness({
      plan: plan({
        entries: [],
        managedFlows: [
          { flowId: 'f0', bindingKey: 'sched:a:on', variantKey: 'at:22:00', fingerprint: 'fp', managedVersion: 1, createdAt: 1 },
          { flowId: 'f1', bindingKey: 'sched:a:off', variantKey: 'at:23:30', fingerprint: 'fp', managedVersion: 1, createdAt: 1 },
        ] as any,
      }),
    });

    await h.runtime.reconcileFlows();

    assert.equal(h.synced.length, 1, 'the bridge was asked to reconcile');
    assert.deepEqual((h.synced[0] as any).mapped, [], 'with nothing wanted');
    assert.equal((h.synced[0] as any).existing.length, 2, 'and both stored references handed over');
  });

  test('nothing scheduled AND nothing stored still costs no pass', async () => {
    const h = harness({ plan: plan({ entries: [], managedFlows: [] }) });

    await h.runtime.reconcileFlows();

    assert.deepEqual(h.synced, [], 'the cold-start case must not pay a flow and folder read');
  });
});

/**
 * Catch-up's whole licence to switch a household's lights on.
 *
 * A window whose on-Flow already fired while the app was down will not fire
 * again until tomorrow, so catch-up applies a window that CONTAINS now. That is
 * only safe because something else is scheduled to end it — the off Flow. With
 * no reference to one, catching up means lighting rooms with nothing to turn
 * them off again, which is the one failure worse than a dark evening.
 *
 * `safety-promises.test.ts` claimed this and did not check it: it declared its
 * own `hasOff` predicate and asserted that against hand-built lists, never
 * calling the runtime, so it would have passed with the gate deleted. This calls
 * the runtime.
 */
describe('catch-up will not light a room it cannot switch off again', () => {
  const inside = plan({
    entries: [{ id: 'night', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 300 } }],
  });

  test('a missing OFF reference refuses the catch-up, and says why', async () => {
    const h = harness({ plan: inside, now: TUESDAY_2215, onlyOnBoundary: true });

    await h.runtime.start();
    await settle();

    assert.deepEqual(h.writes, [], 'not one write');
    const refusals = h.runtime.diagnostics().catchUpRefusals;
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]!.entryId, 'night');
    assert.match(refusals[0]!.reason, /off boundary/);
  });

  test('with both references recorded it catches up', async () => {
    const h = harness({ plan: inside, now: TUESDAY_2215 });

    await h.runtime.start();
    await settle();

    assert.ok(h.writes.length > 0, 'the room is lit');
    assert.deepEqual(h.runtime.diagnostics().catchUpRefusals, []);
    assert.equal(h.runtime.diagnostics().lastAction?.note, 'catch-up');
  });

  test('the refusal is visible in diagnostics, not only in the log', async () => {
    // Catch-up is the one path that switches lights on without a Flow having
    // fired, so its refusals are what a "why did nothing happen at 22:01"
    // report needs — and a refusal that is only logged is invisible from the
    // settings page.
    const h = harness({ plan: inside, now: TUESDAY_2215, onlyOnBoundary: true });

    await h.runtime.start();
    await settle();

    assert.ok(h.runtime.diagnostics().catchUpRefusals.length > 0);
  });
});
