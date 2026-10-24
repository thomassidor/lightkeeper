import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedLog } from '../../lib/support/bounded-log';
import { FlowBridgeManager } from '../../lib/bridge/flow-bridge-manager';
import type { HomeyApiService } from '../../lib/homey-api-service';
import { CredentialService } from '../../lib/credential-service';
import { DeviceCatalog } from '../../lib/device-catalog';
import { FlowCardCatalogue } from '../../lib/flow-card-catalogue';

const api = require('../../api') as {
  countOrphans(args: any): Promise<any>;
  sweepOrphans(args: any): Promise<any>;
  getStatus(args: any): Promise<any>;
  getDiagnostics(args: any): Promise<any>;
  setCredential(args: any): Promise<any>;
  deleteCredential(args: any): Promise<any>;
  setBrightnessScale(args: any): Promise<any>;
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
  circTwo: 'lk-circ-1755500000000-300002',
  dayl: 'lk-dayl-1755500000000-400001',
  curve: 'lk-curve-1755500000000-500001',
};

type Write = { deviceId: string; capability: string; value: unknown; ok: boolean };

function homey(options: {
  controllers?: string[];
  schedules?: string[];
  circadian?: string[];
  /** Colour Curve Lights: the same `curves` registry as circadian, their own driver. */
  curve?: string[];
  daylight?: string[];
  /**
   * Registered runtimes whose device the DRIVER does not list — the window
   * between a device being torn down and its runtime unregistering, or a
   * driver whose list is momentarily behind. The registry alone must then be
   * enough to keep the device's Flows, which is the union's half of the job.
   */
  notInstalled?: string[];
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
   * Device ids whose `diagnostics()` throws, so the status payload can be
   * asserted against a device that cannot describe itself.
   */
  brokenDiagnostics?: string[];
  /**
   * A driver that will not list its devices — a restart in progress, or a
   * driver that failed to load. The sweep must refuse rather than treat the
   * devices it could not see as gone.
   */
  unreadableDriver?: 'controller' | 'schedule';
  /**
   * Per device kind for the per-runtime diagnostics, plus `interleaved` for
   * the app-level log the settings page actually reads.
   */
  writes?: {
    controller?: Write[]; schedule?: Write[]; circadian?: Write[];
    interleaved?: Write[];
  };
  /** The app's credential service. A stub reporting a valid key, unless given. */
  credentials?: unknown;
}) {
  const swept: Array<Set<string>> = [];
  const deleted: string[] = [];
  const stored = new Map<string, unknown>();
  const settings = { get: (key: string) => stored.get(key), set: (key: string, value: unknown) => stored.set(key, value) };

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
    diagnostics: () => (options.brokenDiagnostics?.includes(id)
      ? (() => { throw new Error(`no sunrise time is available to anchor to (${id})`); })()
      : {
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
      response: { sensor: null, darkLux: 5, brightLux: 500, dark: 0.9, bright: 0.25 },
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

  /**
   * The REAL two catalogues, over a client that refuses to be read. The
   * diagnostics route reports their counters, and must do it without asking
   * the Homey for anything: one trigger-card read from a bug report is the
   * mistake platform §15 records.
   */
  const reads = { count: 0 };
  const unreadable = {
    read: async () => {
      reads.count += 1;
      throw new Error('a report must not read the Homey to describe the catalogue');
    },
    reportReadFailure: () => false,
  } as unknown as HomeyApiService;

  return {
    swept,
    deleted,
    live,
    reads,
    // The handlers take the Homey argument object: { homey }.
    args: { homey: {
      // Any version: nothing here asserts one, and a hardcoded release number
      // in a fake manifest only ever goes stale.
      manifest: { id: 'com.thomassidor.lightkeeper', version: '0.0.0-test' },
      app: {
        recentEvents: new BoundedLog<never>(40),
        recentWrites: writeLog,
        // A real store behind the two calls, so the route test below reads
        // back what it wrote rather than what a stub was told to say.
        settings,
        brightnessScale: () => (settings.get('brightnessScale') === 'linear' ? 'linear' : 'natural'),
        setBrightnessScale: (scale: string) => settings.set('brightnessScale', scale),
        credentials: options.credentials ?? { getStatus: () => ({ present: true, valid: true }) },
        catalog: new DeviceCatalog(unreadable),
        cards: new FlowCardCatalogue(unreadable),
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
        curves: {
          all: () => [
            ...(options.circadian ?? []).map(id => runtime(id, 'circadian')),
            ...(options.curve ?? []).map(id => runtime(id, 'circadian')),
          ],
        },
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
         * each device answering `getData()`. Each driver lists its OWN
         * installed devices — every one with a runtime, except those named in
         * `notInstalled`, plus whatever `installedOnly` adds.
         *
         * All five drivers answer, and that is the point. This fake used to
         * hand circadian and daylight an empty list, send `curve` down the
         * schedule branch and list every runtime as installed — so a driver
         * loop that grew a third entry, or a union that lost a registry, was
         * invisible to every test below. A driver id this app does not have is
         * refused, as the SDK refuses it.
         */
        getDriver(driverId: string) {
          if (driverId === options.unreadableDriver) {
            throw new Error(`the ${driverId} driver is not ready`);
          }
          const byDriver: Record<string, string[]> = {
            controller: [...(options.controllers ?? []), ...(options.installedOnly?.controller ?? [])],
            schedule: [...(options.schedules ?? []), ...(options.installedOnly?.schedule ?? [])],
            circadian: options.circadian ?? [],
            curve: options.curve ?? [],
            daylight: options.daylight ?? [],
          };
          const installed = byDriver[driverId];
          if (installed === undefined) throw new Error(`Invalid Driver: ${driverId}`);
          const listed = installed.filter(id => !(options.notInstalled ?? []).includes(id));
          return {
            getDevices: () => listed.map(id => ({ getData: () => ({ id }) })),
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

/**
 * A sweep the way the settings page runs one: count first, then hand the count's
 * own approval back.
 *
 * Not a convenience. `POST /orphans` REFUSES a request with no `token`/`flowIds`
 * — a count is not consent, a specific list is — so a bare `sweepOrphans(h.args)`
 * now deletes nothing whatever the fixture says, and four tests that assert
 * "nothing was deleted" would have passed for the wrong reason forever.
 */
async function sweep(h: { args: any }) {
  const preview = await api.countOrphans(h.args);
  return api.sweepOrphans({
    ...h.args,
    body: { token: preview.token, flowIds: preview.flowIds },
  });
}

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

    await sweep(h);
    assert.deepEqual([...h.swept.at(-1)!].sort(), [ID.ctrl, ID.sched, ID.schedTwo].sort());
  });

  test('circadian devices are NOT in the live set, because they own no Flows', async () => {
    // The union is deliberately of the two registries that can appear in a
    // Flow's bridge arguments. A circadian light never does, so counting it
    // would inflate liveControllers and — worse — stop the "nothing is running"
    // refusal from firing on a Homey whose only Lightkeeper devices cannot own
    // a Flow at all.
    const h = homey({ circadian: [ID.circ], managed: [flow('f1', ID.ctrlGone)] });

    await sweep(h);
    assert.deepEqual([...h.swept.at(-1)!], []);

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, 'no_live_controllers');
  });

  test('Room-sensing Lights are NOT in the live set either, for the same reason', async () => {
    // A fifth device type that owns no Flows. Asserted separately from the
    // circadian one because the exclusion is a decision per device type, and a
    // fifth entry added to the driver loop by reflex is exactly how this breaks:
    // with one Room-sensing Light installed the set would stop being empty, the
    // refusal would stop firing, and a sweep on a Homey with no Flow-owning
    // device at all would delete every managed Flow it found.
    const h = homey({ daylight: [ID.dayl], managed: [flow('f1', ID.ctrlGone)] });

    await sweep(h);
    assert.deepEqual([...h.swept.at(-1)!], []);

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

    await sweep(h);
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

  /**
   * A count is not consent, a specific list is — and the route used to accept
   * neither.
   *
   * `sweepOrphans` fell through to an unapproved sweep when the body carried no
   * `token`/`flowIds`, justified as not breaking an older settings page. There
   * is no older page: nothing has ever been published. So the escape hatch
   * protected nobody while leaving the app's one bulk-delete callable with no
   * approval at all, over a surface anybody with a Personal API Key can reach
   * (platform §14).
   */
  test('a sweep with no approval in the body deletes nothing', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.ctrlGone)],
    });

    // The fixture has a real orphan, so a refusal here is the guard and not the
    // absence of anything to delete.
    assert.equal((await api.countOrphans(h.args)).orphans, 1);

    const result = await api.sweepOrphans(h.args);
    assert.equal(result.refused, 'no_approval');
    assert.deepEqual(h.deleted, []);
    // And it says how many it declined to touch rather than reporting zero.
    assert.equal(result.kept, 2);
  });

  test('half an approval is no approval', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.ctrlGone)],
    });
    const preview = await api.countOrphans(h.args);

    for (const body of [{ token: preview.token }, { flowIds: preview.flowIds }]) {
      const result = await api.sweepOrphans({ ...h.args, body });
      assert.equal(result.refused, 'no_approval');
    }
    assert.deepEqual(h.deleted, []);
  });

  test('an approval list longer than the cap is refused outright', async () => {
    const h = homey({ controllers: [ID.ctrl], managed: [flow('f1', ID.ctrlGone)] });
    const preview = await api.countOrphans(h.args);

    await assert.rejects(
      () => api.sweepOrphans({
        ...h.args,
        body: { token: preview.token, flowIds: new Array(2001).fill('f1') },
      }),
      /flowIds has more than 2000 entries/,
    );
    assert.deepEqual(h.deleted, []);
  });

  /**
   * A driver that will not enumerate is a refusal, not a smaller live set.
   *
   * `liveDeviceIds` logged the failure and carried on. With the controllers
   * live, the "nothing is running" guard does not fire — so every schedule
   * device without a registered runtime reads as unattributable, and the
   * preview, computed from the same shrunken set, agrees with the mistake
   * instead of catching it.
   */
  test('a driver that will not list its devices refuses the count and the sweep', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      schedules: [ID.sched],
      unreadableDriver: 'schedule',
      managed: [flow('f1', ID.ctrl), flow('f2', ID.sched)],
    });

    const preview = await api.countOrphans(h.args);
    assert.equal(preview.refused, 'devices_unreadable');

    const result = await api.sweepOrphans({
      ...h.args,
      body: { token: preview.token, flowIds: preview.flowIds },
    });
    assert.equal(result.refused, 'devices_unreadable');
    assert.deepEqual(h.deleted, []);
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

describe('the brightness scale', () => {
  test('is natural until somebody chooses, and the status says so', async () => {
    const h = homey({});
    assert.equal((await api.getStatus(h.args)).brightnessScale, 'natural');
  });

  test('a choice is stored, echoed, and read back by the next status', async () => {
    const h = homey({});
    assert.deepEqual(await api.setBrightnessScale({ ...h.args, body: { scale: 'linear' } }), { brightnessScale: 'linear' });
    assert.equal((await api.getStatus(h.args)).brightnessScale, 'linear');
    assert.equal((await api.getDiagnostics(h.args)).semantics.brightnessScale, 'linear');
  });

  test('anything that is not one of the two scales is refused, and nothing changes', async () => {
    const h = homey({});
    await api.setBrightnessScale({ ...h.args, body: { scale: 'linear' } });
    for (const body of [{ scale: 'Linear' }, { scale: 1 }, {}, null]) {
      await assert.rejects(api.setBrightnessScale({ ...h.args, body }), /natural.*linear/);
    }
    assert.equal((await api.getStatus(h.args)).brightnessScale, 'linear');
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

  /**
   * One device that cannot describe itself must not blank the page.
   *
   * Every list in `getStatus` called `runtime.diagnostics()` straight inside a
   * `.map()`, so a single throw made `GET /` fail and the settings page rendered
   * NOTHING — no other device, no credential box, no orphan sweep, on the one
   * screen somebody reaches for when something is wrong.
   *
   * Reachable: a Colour Curve Light whose stored plan carried a sun anchor threw
   * out of `valueAt()` on every call. That plan is refused at both gates now, so
   * this is the second half of the fix rather than the whole of it — the point
   * being that the page survives whatever the next such bug turns out to be.
   */
  test('a device whose diagnostics throw is left out, and the rest still render', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      schedules: [ID.sched],
      circadian: [ID.circ, ID.circTwo],
      daylight: [ID.dayl],
      brokenDiagnostics: [ID.circ],
    });

    const status = await api.getStatus(h.args);

    // The broken one is absent; its healthy sibling is not.
    assert.deepEqual(status.circadian.map((card: any) => card.id), [ID.circTwo]);
    // And every other list is untouched, which is the whole point.
    assert.equal(status.controllers.length, 1);
    assert.equal(status.schedules.length, 1);
    assert.equal(status.daylight.length, 1);
    assert.equal(status.credential.valid, true);
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

  /**
   * How often the catalogue is invalidated and the card catalogues are read had
   * never been recorded, and it decides what a catalogue change costs. Reported
   * from counters alone.
   */
  test('diagnostics carry the catalogue counters, and reading them reads nothing', async () => {
    const h = homey({ controllers: [ID.ctrl] });

    const diagnostics = await api.getDiagnostics(h.args);

    assert.deepEqual(Object.keys(diagnostics.catalog).sort(), ['cards', 'devices']);
    assert.equal(diagnostics.catalog.devices.refreshes, 0);
    assert.deepEqual(diagnostics.catalog.devices.invalidations, {});
    assert.equal(diagnostics.catalog.cards.triggers.fetches, 0);
    assert.equal(diagnostics.catalog.cards.actions.retained, false);
    assert.equal(h.reads.count, 0, 'the report must not provoke the reads it counts');
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

/**
 * "The API key is never returned over the app API", asserted on what the
 * handlers RETURN rather than on what `api.ts` spells.
 *
 * `webview-safety.test.ts` used to stand in for this with a source search for
 * the settings storage key's name, which proves only that `api.ts` does not
 * name it — a handler returning `app.credentials` wholesale, or spreading a
 * status object that had grown a `token`, would have passed. Here a REAL
 * `CredentialService` holds a key, and every route that touches the credential
 * or reports on the app is serialised and searched for it, including the two
 * that are handed the key itself.
 */
describe('the app API never returns the stored key', () => {
  /** Synthetic, and shaped like a real key so a redactor would recognise it. */
  const KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:11111111-2222-3333-4444-555555555555:'
    + '0123456789abcdef0123456789abcdef01234567';
  const SECRET = '0123456789abcdef0123456789abcdef01234567';
  const PASTED = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee:11111111-2222-3333-4444-555555555555:'
    + 'fedcba9876543210fedcba9876543210fedcba98';

  function holdingKey(writeClient: () => Promise<unknown>) {
    const store = new Map<string, unknown>([['flowWriteApiKey', KEY]]);
    const credentials = new CredentialService({
      settings: {
        get: k => store.get(k),
        set: (k, v) => { store.set(k, v); },
        unset: k => { store.delete(k); },
      },
      createWriteClient: writeClient,
      getLocalAddress: async () => 'http://127.0.0.1:80',
      log: () => { /* quiet */ },
    });
    return homey({ controllers: [ID.ctrl], schedules: [ID.sched], credentials });
  }

  function assertNoKey(label: string, response: unknown): void {
    const serialised = JSON.stringify(response) ?? '';
    for (const secret of [KEY, SECRET, PASTED, PASTED.slice(-40)]) {
      assert.equal(serialised.includes(secret), false, `${label} returned key material`);
    }
  }

  test('status, diagnostics and the orphan count carry no key', async () => {
    const h = holdingKey(async () => ({}));
    const status = await api.getStatus(h.args);
    // The service is real and the key is there, so this is not vacuous.
    assert.equal(status.credential.present, true);
    assertNoKey('getStatus', status);
    assertNoKey('getDiagnostics', await api.getDiagnostics(h.args));
    assertNoKey('countOrphans', await api.countOrphans(h.args));
  });

  test('a refused key comes back as a status, not as itself', async () => {
    // The handshake fails with an error that ECHOES the token, which is the
    // refusal path and the one place an error object has been near the key.
    const h = holdingKey(async () => { throw new Error(`401 Unauthorized for token ${PASTED}`); });
    const status = await api.setCredential({ ...h.args, body: { token: PASTED } });
    assert.equal(status.valid, false);
    assertNoKey('setCredential (refused)', status);
    assertNoKey('getStatus after a refusal', await api.getStatus(h.args));
  });

  test('an accepted key comes back as a status, not as itself', async () => {
    const client = {
      // What `flowWriteProbe` does with a write client: sweep, create a
      // folder, delete it.
      flow: {
        getFlowFolders: async () => ({}),
        createFlowFolder: async () => ({ id: 'probe-folder' }),
        deleteFlowFolder: async () => undefined,
      },
      destroy: () => undefined,
    };
    const h = holdingKey(async () => client);
    const status = await api.setCredential({ ...h.args, body: { token: PASTED } });
    assert.equal(status.valid, true, 'the probe was meant to succeed here');
    assertNoKey('setCredential (accepted)', status);
    assertNoKey('getStatus after acceptance', await api.getStatus(h.args));
    assertNoKey('deleteCredential', await api.deleteCredential(h.args));
  });
});

/**
 * The live set is BOTH registries AND both drivers' installed devices — and
 * only those four sources.
 *
 * The two halves cover different gaps. The driver lists cover a device with no
 * runtime (a failed init, a bad migration); the registries cover a runtime the
 * driver does not list at that moment. Either half alone leaves one of those
 * devices' Flows reading as orphaned on a Homey where something else is
 * running, so the "nothing is running" refusal does not save them.
 */
describe('the orphan sweep\'s live set, source by source', () => {
  test('a registered controller the driver does not list still keeps its flows', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      schedules: [ID.sched],
      notInstalled: [ID.ctrl],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.sched)],
    });

    const preview = await api.countOrphans(h.args);
    assert.equal(preview.orphans, 0, 'the controller registry is half the union');
    await sweep(h);
    assert.ok(h.swept.at(-1)!.has(ID.ctrl));
    assert.deepEqual(h.deleted, []);
  });

  test('a registered schedule the driver does not list still keeps its flows', async () => {
    const h = homey({
      controllers: [ID.ctrl],
      schedules: [ID.sched],
      notInstalled: [ID.sched],
      managed: [flow('f1', ID.ctrl), flow('f2', ID.sched)],
    });

    const preview = await api.countOrphans(h.args);
    assert.equal(preview.orphans, 0, 'the schedule registry is the other half');
    await sweep(h);
    assert.ok(h.swept.at(-1)!.has(ID.sched));
    assert.deepEqual(h.deleted, []);
  });

  test('installed lights of the three Flow-less types never join the live set', async () => {
    // Each of these drivers now LISTS its devices, so this fails if the driver
    // loop in liveDeviceIds grows a third entry by reflex — the exclusion has
    // to be a decision, and an empty fake list made it look like one for free.
    const h = homey({
      controllers: [ID.ctrl],
      circadian: [ID.circ],
      curve: [ID.curve],
      daylight: [ID.dayl],
    });

    await sweep(h);
    assert.deepEqual([...h.swept.at(-1)!], [ID.ctrl]);
    assert.equal((await api.countOrphans(h.args)).liveControllers, 1);
  });

  test('a Colour Curve Light alone does not lift the refusal', async () => {
    // The third Flow-less type, asserted on its own for the reason the circadian
    // and Room-sensing tests above give: the refusal is what stops a sweep on a
    // Homey with no Flow owner deleting every managed Flow it finds.
    const h = homey({ curve: [ID.curve], managed: [flow('f1', ID.ctrlGone)] });

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, 'no_live_controllers');
    await sweep(h);
    assert.deepEqual(h.deleted, []);
  });
});

/**
 * "A credential is validated by a real Flow WRITE", at the settings page's own
 * route.
 *
 * The write probe is pinned for pair sessions and for boot; the settings page
 * reaches `setCredential` through `api.ts`, which supplies its own validator. A
 * route that handed the service a validator doing nothing would accept a key
 * that can read but not write — the exact key platform §1 says looks fine until
 * the first reconcile — and store it.
 */
describe('the settings route proves a key by writing with it', () => {
  const PASTED = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee:11111111-2222-3333-4444-555555555555:'
    + 'fedcba9876543210fedcba9876543210fedcba98';

  test('a key whose folder write is refused is reported invalid and is not stored', async () => {
    const store = new Map<string, unknown>();
    const client = {
      flow: {
        // Reads succeed: a read-only key gets this far, which is the trap.
        getFlowFolders: async () => ({}),
        createFlowFolder: async () => {
          throw Object.assign(new Error('Missing Scopes'), { statusCode: 403 });
        },
        deleteFlowFolder: async () => undefined,
      },
      destroy: () => undefined,
    };
    const credentials = new CredentialService({
      settings: {
        get: k => store.get(k),
        set: (k, v) => { store.set(k, v); },
        unset: k => { store.delete(k); },
      },
      createWriteClient: async () => client,
      getLocalAddress: async () => 'http://127.0.0.1:80',
      log: () => { /* quiet */ },
    });
    const h = homey({ credentials });

    const status = await api.setCredential({ ...h.args, body: { token: PASTED } });

    assert.equal(status.valid, false);
    assert.equal(status.failure, 'insufficient_scope');
    assert.equal(store.size, 0, 'a key that cannot write must not be stored');
    assert.equal(credentials.hasCredential(), false);
  });
});
