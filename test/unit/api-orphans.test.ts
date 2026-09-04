import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedLog } from '../../lib/support/bounded-log';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';

const api = require('../../api') as {
  countOrphans(args: any): Promise<any>;
  sweepOrphans(args: any): Promise<any>;
  getStatus(args: any): Promise<any>;
  getDiagnostics(args: any): Promise<any>;
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
  dayl: 'lk-dayl-1755500000000-400001',
};

type Write = { deviceId: string; capability: string; value: unknown; ok: boolean };

function homey(options: {
  controllers?: string[];
  schedules?: string[];
  circadian?: string[];
  daylight?: string[];
  /** Flows on the Homey, as `flow(id, controllerId)` builds them. */
  managed?: Array<Record<string, unknown>>;
  /**
   * Devices the DRIVER can see but that have no runtime — a failed init, a
   * bad migration, a restart in progress.
   */
  installedOnly?: { controller?: string[]; schedule?: string[] };
  /** What a schedule has ALREADY resolved, if anything. Never looked up here. */
  timeCard?: { card: null; candidates: never[] };
  /**
   * Per device kind for the per-runtime diagnostics, plus `interleaved` for
   * the app-level log the settings page actually reads.
   */
  writes?: {
    controller?: Write[]; schedule?: Write[]; circadian?: Write[];
    interleaved?: Write[];
  };
}) {
  const swept: Array<Set<string>> = [];
  const deleted: string[] = [];

  /**
   * The app-level write log every runtime's adapter feeds.
   *
   * Seeded here from `options.writes` in the order they would have arrived, so
   * the payload assertions below are about what the settings page renders
   * rather than about which runtime happened to be first.
   */
  const writeLog = new BoundedLog<Write>(50);
  for (const write of options.writes?.interleaved ?? []) writeLog.add(write);

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
      // Daylight-only fields, harmless on the others for the same reason as the
      // circadian ones above.
      response: { sensors: [], darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25 },
      sensors: [],
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
        recentWrites: writeLog,
        credentials: { getStatus: () => ({ present: true, valid: true }) },
        controllers: { all: () => (options.controllers ?? []).map(id => runtime(id, 'controller')) },
        schedules: {
          all: () => (options.schedules ?? []).map(id => runtime(id, 'schedule')),
          /**
           * Throws on purpose. Diagnostics must PEEK at the time card and never
           * ask for it: the lookup reads every trigger card on the Homey, and
           * that read raises the app's memory floor for the rest of its run
           * (platform §15). A bug report must not change what it reports on.
           */
          timeCard: async () => { throw new Error('getDiagnostics must not provoke the time card lookup'); },
          peekTimeCard: () => options.timeCard ?? null,
        },
        /**
         * One registry for BOTH curve-driven device types. Named `curves`
         * because a curve is what both of them run — and its absence from
         * `liveDeviceIds` is what these tests are about.
         */
        curves: { all: () => (options.circadian ?? []).map(id => runtime(id, 'circadian')) },
        /**
         * A fifth device type that owns no Flows either, and its absence from
         * `liveDeviceIds` is part of what these tests are about.
         */
        daylights: { all: () => (options.daylight ?? []).map(id => runtime(id, 'daylight')) },
        daylight: {
          sky: () => ({ elevation: 40, level: 1, location: { latitude: 55.68, longitude: 12.57 } }),
          sensors: () => [],
        },
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
          // Neither owns a Flow, so neither is enumerated by liveDeviceIds and
          // neither has devices to offer here.
          if (driverId === 'circadian' || driverId === 'daylight') return { getDevices: () => [] };
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

  test('Daylight lights are NOT in the live set either, for the same reason', async () => {
    // A fifth device type that owns no Flows. Asserted separately from the
    // circadian one because the exclusion is a decision per device type, and a
    // fifth entry added to the driver loop by reflex is exactly how this breaks:
    // with one Daylight light installed the set would stop being empty, the
    // refusal would stop firing, and a sweep on a Homey with no Flow-owning
    // device at all would delete every managed Flow it found.
    const h = homey({ daylight: [ID.dayl], managed: [flow('f1', ID.ctrlGone)] });

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

  test('recent writes answer on a Homey that has only schedules', async () => {
    // "Did anything reach a light" must answer for a household that uses no
    // remotes at all. Reading the FIRST CONTROLLER's log — which is what this
    // did — left the one list that tells "never fired" from "fired and could
    // not reach the light" permanently empty for them.
    const write = { deviceId: 'light-1', capability: 'onoff', value: true, ok: true };
    const h = homey({
      schedules: [ID.sched],
      writes: { schedule: [write], interleaved: [write] },
    });

    const status = await api.getStatus(h.args);
    assert.equal(status.controllers.length, 0);
    assert.deepEqual(status.recentWrites, [write]);
  });

  test('writes from different runtimes are merged, newest first', async () => {
    // One time-ordered log for the whole app, not whichever runtime happened
    // to be first in the list.
    const ctrl = { deviceId: 'light-1', capability: 'dim', value: 0.5, ok: true };
    const sched = { deviceId: 'light-2', capability: 'onoff', value: false, ok: true };
    const h = homey({
      controllers: [ID.ctrl], schedules: [ID.sched],
      writes: { controller: [ctrl], schedule: [sched], interleaved: [ctrl, sched] },
    });

    assert.deepEqual(
      (await api.getStatus(h.args)).recentWrites, [sched, ctrl],
      'newest first — the schedule wrote after the controller did',
    );
  });

  test('a runtime keeps its OWN write log for per-device diagnostics', async () => {
    // The merged log answers "did anything reach a light"; the per-runtime one
    // answers "which of my devices cannot reach its lights", and both are
    // needed. Nothing here replaced the second with the first.
    const ctrl = { deviceId: 'light-1', capability: 'dim', value: 0.5, ok: true };
    const h = homey({ controllers: [ID.ctrl], writes: { controller: [ctrl] } });

    const diagnostics = await api.getDiagnostics(h.args);
    assert.deepEqual(diagnostics.controllers[0].recentWrites, [ctrl]);
  });
});
