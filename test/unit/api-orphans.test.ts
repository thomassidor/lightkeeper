import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedLog } from '../../lib/support/bounded-log';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';

const api = require('../../api') as {
  countOrphans(args: any): Promise<any>;
  sweepOrphans(args: any): Promise<any>;
  getStatus(args: any): Promise<any>;
};

/**
 * The orphan sweep is the only bulk delete this app performs, and it decides
 * what to delete by asking whether a generated Flow's device id is still live.
 *
 * With a second device type that also owns Flows, "live" has to mean BOTH
 * registries. A sweep that only knew about controllers would look at every
 * schedule's Flows, find their device ids missing, and delete the lot — and the
 * existing "refuse when nothing is running" guard would not have saved anyone,
 * because with one controller running the set is not empty. Hence this test.
 *
 * "Live" also has to mean INSTALLED, not merely REGISTERED. A device whose init
 * threw, whose store failed to migrate, or that is halfway through a restart
 * has no runtime — and every Flow it owns then reads as orphaned, on a Homey
 * where other devices are running so the refusal does not fire. It is still
 * there in the app; the user can still see it and repair it. Existing is the
 * test, not having started.
 *
 * The bridge here is the REAL FlowBridgeManager over a fake Homey, because
 * what is under test is which set api.ts hands it — a double that recomputed
 * the answer would be testing the double.
 */

const APP_ID = 'com.thomassidor.lightkeeper';
const CARD = `${APP_ID}:bridge_event`;

/** Real-shaped ids: the sweep requires the drivers' `lk-<kind>-<ms>-<rand>`. */
const ID = {
  ctrl: 'lk-ctrl-1755500000000-100001',
  ctrlGone: 'lk-ctrl-1755500000000-100002',
  ctrlUnregistered: 'lk-ctrl-1755500000000-100003',
  sched: 'lk-sched-1755500000000-200001',
  schedTwo: 'lk-sched-1755500000000-200002',
  schedGone: 'lk-sched-1755500000000-200003',
  circ: 'lk-circ-1755500000000-300001',
};

type Write = { deviceId: string; capability: string; value: unknown; ok: boolean };

function homey(options: {
  controllers?: string[];
  schedules?: string[];
  circadian?: string[];
  /** Flows on the Homey, as `flow(id, controllerId)` builds them. */
  managed?: Array<Record<string, unknown>>;
  /**
   * Devices the DRIVER can see but that have no runtime — a failed init, a
   * bad migration, a restart in progress.
   */
  installedOnly?: { controller?: string[]; schedule?: string[] };
  /** Per device kind, so the getStatus fallback can actually be observed. */
  writes?: { controller?: Write[]; schedule?: Write[]; circadian?: Write[] };
}) {
  const swept: Array<Set<string>> = [];
  const deleted: string[] = [];

  const runtime = (id: string, kind: string) => ({
    controllerId: id,
    currentState: 'ready',
    currentProfile: { source: { name: id }, mappings: [], managedFlows: [] },
    diagnostics: () => ({
      kind,
      name: id,
      enabled: true,
      entries: [],
      managedFlows: [],
      // Circadian-only fields. Harmless on the other two: getStatus reads them
      // per kind, and a fake that answers everything cannot show a mix-up.
      now: { warmth: 0.9 },
      nextPoint: { id: 'night', at: '23:00', inMinutes: 45 },
      points: [],
      targets: [],
      preStage: false,
      preStageDisabled: null,
      recentWrites: (kind === 'controller' ? options.writes?.controller
        : kind === 'schedule' ? options.writes?.schedule
          : options.writes?.circadian) ?? [],
      schedulerReady: true,
      targetNames: [],
      timezone: 'Europe/Copenhagen',
      localTime: 'Tue 22:15',
    }),
  });

  const live: Record<string, any> = {};
  for (const record of options.managed ?? []) live[String(record.id)] = record;

  const client = {
    flow: {
      getFlowCardActions: async () => ({
        a: { id: CARD, uri: `homey:flowcardaction:${CARD}` },
        b: { id: `${APP_ID}:bridge_numeric_event`, uri: `homey:flowcardaction:${APP_ID}:bridge_numeric_event` },
        c: { id: `${APP_ID}:bridge_token_event`, uri: `homey:flowcardaction:${APP_ID}:bridge_token_event` },
      }),
      getFlows: async () => live,
      getFlowFolders: async () => ({}),
      deleteFlow: async ({ id }: { id: string }) => {
        deleted.push(id);
        delete live[id];
      },
    },
  };

  const bridgeApi = {
    read: async () => client,
    withWriteClient: async (operation: (c: any) => Promise<unknown>) => operation(client),
  } as unknown as HomeyApiService;

  const real = new FlowBridgeManager(bridgeApi, APP_ID, () => undefined);
  // Wrapped only to record which live set api.ts computed — the work itself is
  // the real manager's.
  const bridge = {
    findManagedFlows: () => real.findManagedFlows(),
    countOrphans: (liveIds: Set<string>) => {
      swept.push(liveIds);
      return real.countOrphans(liveIds);
    },
    sweepOrphans: (liveIds: Set<string>, approved?: any) => {
      swept.push(liveIds);
      return real.sweepOrphans(liveIds, approved);
    },
  };

  return {
    swept,
    deleted,
    live,
    // The handlers take the Homey argument object: { homey }.
    args: { homey: {
      // Any version: nothing here asserts one, and a hardcoded release number
      // in a fake manifest only ever goes stale.
      manifest: { id: 'com.thomassidor.lightkeeper', version: '0.0.0-test' },
      app: {
        recentEvents: new BoundedLog<never>(40),
        credentials: { getStatus: () => ({ present: true, valid: true }) },
        controllers: { all: () => (options.controllers ?? []).map(id => runtime(id, 'controller')) },
        schedules: {
          all: () => (options.schedules ?? []).map(id => runtime(id, 'schedule')),
          timeCard: async () => ({ card: null, candidates: [] }),
        },
        circadian: { all: () => (options.circadian ?? []).map(id => runtime(id, 'circadian')) },
        bridge,
        log: () => { /* the api's own best-effort log */ },
      },
      drivers: {
        /**
         * The SDK's own shape: `homey.drivers.getDriver(id).getDevices()`,
         * each device answering `getData()`. Every device with a runtime is
         * installed too — a runtime cannot exist without one — plus whatever
         * `installedOnly` adds.
         */
        getDriver(driverId: string) {
          const withRuntimes = driverId === 'controller'
            ? (options.controllers ?? [])
            : (options.schedules ?? []);
          const extra = driverId === 'controller'
            ? (options.installedOnly?.controller ?? [])
            : (options.installedOnly?.schedule ?? []);
          if (driverId === 'circadian') return { getDevices: () => [] };
          return {
            getDevices: () => [...withRuntimes, ...extra].map(id => ({ getData: () => ({ id }) })),
          };
        },
      },
    } },
  };
}

/** A generated flow as Homey serialises one. */
const flow = (id: string, controllerId: string) => ({
  id,
  name: id,
  folder: null,
  actions: [{ id: CARD, args: { controller: controllerId, event_key: 'k' } }],
});

describe('orphan counting across both device types', () => {
  test('a schedule\'s flows are not counted as orphans', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      schedules: [ID.sched],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.sched), flow('f3', ID.sched)],
    });

    const result = await api.countOrphans(h.args);
    assert.equal(result.total, 3);
    assert.equal(result.orphans, 0);
    assert.equal(result.liveControllers, 2);
  });

  test('flows from a deleted device of either type are orphans', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      schedules: [ID.sched],
      managed: [flow('f1', ID.ctrlGone), flow('f2', ID.schedGone), flow('f3', ID.sched)],
    });

    const result = await api.countOrphans(h.args);
    assert.equal(result.orphans, 2);
    assert.deepEqual(result.examples, ['f1', 'f2']);
  });

  test('the sweep is handed the union of both registries', async () => {
    const h = homey({ controllers: [ID.ctrl], schedules: [ID.sched, ID.schedTwo] });

    await api.sweepOrphans(h.args);
    assert.deepEqual([...h.swept[0]!].sort(), [ID.ctrl, ID.sched, ID.schedTwo].sort());
  });

  test('circadian devices are NOT in the live set, because they own no Flows', async () => {
    // The union is deliberately of the two registries that can appear in a
    // Flow's bridge arguments. A circadian light never does, so counting it
    // would inflate liveControllers and — worse — stop the "nothing is running"
    // refusal from firing on a Homey whose only Lightkeeper devices cannot own
    // a Flow at all.
    const h = homey({ circadian: [ID.circ], managed: [flow('f1', ID.ctrlGone)] });

    await api.sweepOrphans(h.args);
    assert.deepEqual([...h.swept[0]!], []);

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, 'no_live_controllers');
  });

  test('with only schedules running, the sweep is not refused', async () => {
    // A household that uses schedules and no remotes still has live devices, and
    // the "nothing is running" guard must not read that as an empty Homey.
    const h = homey({ schedules: [ID.sched], managed: [flow('f1', ID.sched)] });

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, undefined);
    assert.equal(result.liveControllers, 1);
  });

  /**
   * A device that exists but never registered.
   *
   * This is the one the "nothing is running" refusal cannot catch: with other
   * devices live the set is not empty, so the guard passes and every Flow of
   * the broken device reads as orphaned. It is still installed, still visible
   * in the app, and still repairable — deleting its Flows would turn a repair
   * into a re-pair.
   */
  test('a device that failed to register still keeps its flows', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      installedOnly: { controller: [ID.ctrlUnregistered] },
      managed: [flow('f1', ID.ctrl), flow('f2', ID.ctrlUnregistered)],
    });

    const preview = await api.countOrphans(h.args);
    assert.equal(preview.orphans, 0, 'installed is the test, not having started');

    await api.sweepOrphans(h.args);
    assert.deepEqual(h.deleted, []);
  });

  test('a schedule that failed to register is protected too', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      installedOnly: { schedule: [ID.schedGone] },
      managed: [flow('f1', ID.schedGone)],
    });

    const preview = await api.countOrphans(h.args);
    assert.equal(preview.orphans, 0);
  });

  test('a device that is genuinely gone is still swept', async () => {
    // The guard above must not become "never delete anything".
    const h = homey({
      controllers: [ID.ctrl],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.ctrlGone)],
    });

    const preview = await api.countOrphans(h.args);
    assert.equal(preview.orphans, 1);

    await api.sweepOrphans({ ...h.args, body: { token: preview.token, flowIds: preview.flowIds } });
    assert.deepEqual(h.deleted, ['f2']);
  });

  test('a sweep whose approval has gone stale deletes nothing', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.ctrlGone)],
    });

    const preview = await api.countOrphans(h.args);
    const result = await api.sweepOrphans({
      ...h.args,
      body: { token: 'a token from a different count', flowIds: preview.flowIds },
    });

    assert.equal(result.refused, 'stale_preview');
    assert.deepEqual(h.deleted, []);
  });

  test('with nothing running at all, the count is still refused', async () => {
    const h = homey({ managed: [flow('f1', ID.ctrl)] });

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, 'no_live_controllers');
  });
});

describe('the settings payload', () => {
  test('reports circadian lights, with where their curve is now', async () => {
    const h = homey({ circadian: [ID.circ] });

    const status = await api.getStatus(h.args);
    assert.equal(status.circadian.length, 1);
    assert.equal(status.circadian[0].name, ID.circ);
    // The pair of facts that says "this is working" without waiting for dusk.
    assert.equal(status.circadian[0].now.warmth, 0.9);
    assert.equal(status.circadian[0].nextPoint.at, '23:00');
  });

  test('reports schedules alongside controllers', async () => {
    const h = homey({ controllers: [ID.ctrl], schedules: [ID.sched] });

    const status = await api.getStatus(h.args);
    assert.equal(status.controllers.length, 1);
    assert.equal(status.schedules.length, 1);
    assert.equal(status.schedules[0].name, ID.sched);
    // The clock the times are read against — the answer to "it fired an hour out".
    assert.equal(status.schedules[0].timezone, 'Europe/Copenhagen');
    assert.equal(status.schedules[0].localTime, 'Tue 22:15');
  });

  test('recent writes fall back to a schedule when there is no controller', async () => {
    // "Did anything reach a light" must still answer on a Homey that has only
    // schedules on it — otherwise the one list that distinguishes "never fired"
    // from "fired and was refused" is permanently empty for those households.
    const write = { deviceId: 'light-1', capability: 'onoff', value: true, ok: true };
    const h = homey({ schedules: [ID.sched], writes: { schedule: [write] } });

    const status = await api.getStatus(h.args);
    assert.equal(status.controllers.length, 0);
    assert.deepEqual(status.recentWrites, [write]);
  });

  test("with a controller running, its writes win over a schedule's", async () => {
    // Documented as "the FIRST controller only" — an indicator, not a merged log.
    const ctrl = { deviceId: 'light-1', capability: 'dim', value: 0.5, ok: true };
    const sched = { deviceId: 'light-2', capability: 'onoff', value: false, ok: true };
    const h = homey({
      controllers: [ID.ctrl], schedules: [ID.sched],
      writes: { controller: [ctrl], schedule: [sched] },
    });

    assert.deepEqual((await api.getStatus(h.args)).recentWrites, [ctrl]);
  });
});
