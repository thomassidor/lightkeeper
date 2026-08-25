import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

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
 */

type Write = { deviceId: string; capability: string; value: unknown; ok: boolean };

function homey(options: {
  controllers?: string[];
  schedules?: string[];
  circadian?: string[];
  managed?: Array<{ flowId: string; name: string; controllerId: string }>;
  /** Per device kind, so the getStatus fallback can actually be observed. */
  writes?: { controller?: Write[]; schedule?: Write[]; circadian?: Write[] };
}) {
  const swept: Array<Set<string>> = [];

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

  return {
    swept,
    // The handlers take the Homey argument object: { homey }.
    args: { homey: {
      // Any version: nothing here asserts one, and a hardcoded release number
      // in a fake manifest only ever goes stale.
      manifest: { id: 'com.thomassidor.lightkeeper', version: '0.0.0-test' },
      app: {
        recentEvents: [],
        credentials: { getStatus: () => ({ present: true, valid: true }) },
        controllers: { all: () => (options.controllers ?? []).map(id => runtime(id, 'controller')) },
        schedules: {
          all: () => (options.schedules ?? []).map(id => runtime(id, 'schedule')),
          timeCard: async () => ({ card: null, candidates: [] }),
        },
        circadian: { all: () => (options.circadian ?? []).map(id => runtime(id, 'circadian')) },
        bridge: {
          findManagedFlows: async () => options.managed ?? [],
          sweepOrphans: async (live: Set<string>) => {
            swept.push(live);
            return { deleted: 0, kept: 0, failed: 0 };
          },
        },
      },
    } },
  };
}

const flow = (flowId: string, controllerId: string) => ({ flowId, name: flowId, controllerId });

describe('orphan counting across both device types', () => {
  test('a schedule\'s flows are not counted as orphans', async () => {
    const h = homey({
      controllers: ['ctrl-1'],
      schedules: ['sched-1'],
      managed: [flow('f1', 'ctrl-1'), flow('f2', 'sched-1'), flow('f3', 'sched-1')],
    });

    const result = await api.countOrphans(h.args);
    assert.equal(result.total, 3);
    assert.equal(result.orphans, 0);
    assert.equal(result.liveControllers, 2);
  });

  test('flows from a deleted device of either type are orphans', async () => {
    const h = homey({
      controllers: ['ctrl-1'],
      schedules: ['sched-1'],
      managed: [flow('f1', 'ctrl-gone'), flow('f2', 'sched-gone'), flow('f3', 'sched-1')],
    });

    const result = await api.countOrphans(h.args);
    assert.equal(result.orphans, 2);
    assert.deepEqual(result.examples, ['f1', 'f2']);
  });

  test('the sweep is handed the union of both registries', async () => {
    const h = homey({ controllers: ['ctrl-1'], schedules: ['sched-1', 'sched-2'] });

    await api.sweepOrphans(h.args);
    assert.deepEqual([...h.swept[0]!].sort(), ['ctrl-1', 'sched-1', 'sched-2']);
  });

  test('circadian devices are NOT in the live set, because they own no Flows', async () => {
    // The union is deliberately of the two registries that can appear in a
    // Flow's bridge arguments. A circadian light never does, so counting it
    // would inflate liveControllers and — worse — stop the "nothing is running"
    // refusal from firing on a Homey whose only Lightkeeper devices cannot own
    // a Flow at all.
    const h = homey({ circadian: ['circ-1'], managed: [flow('f1', 'ctrl-gone')] });

    await api.sweepOrphans(h.args);
    assert.deepEqual([...h.swept[0]!], []);

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, 'no_live_controllers');
  });

  test('with only schedules running, the sweep is not refused', async () => {
    // A household that uses schedules and no remotes still has live devices, and
    // the "nothing is running" guard must not read that as an empty Homey.
    const h = homey({ schedules: ['sched-1'], managed: [flow('f1', 'sched-1')] });

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, undefined);
    assert.equal(result.liveControllers, 1);
  });

  test('with nothing running at all, the count is still refused', async () => {
    const h = homey({ managed: [flow('f1', 'ctrl-1')] });

    const result = await api.countOrphans(h.args);
    assert.equal(result.refused, 'no_live_controllers');
  });
});

describe('the settings payload', () => {
  test('reports circadian lights, with where their curve is now', async () => {
    const h = homey({ circadian: ['circ-1'] });

    const status = await api.getStatus(h.args);
    assert.equal(status.circadian.length, 1);
    assert.equal(status.circadian[0].name, 'circ-1');
    // The pair of facts that says "this is working" without waiting for dusk.
    assert.equal(status.circadian[0].now.warmth, 0.9);
    assert.equal(status.circadian[0].nextPoint.at, '23:00');
  });

  test('reports schedules alongside controllers', async () => {
    const h = homey({ controllers: ['ctrl-1'], schedules: ['sched-1'] });

    const status = await api.getStatus(h.args);
    assert.equal(status.controllers.length, 1);
    assert.equal(status.schedules.length, 1);
    assert.equal(status.schedules[0].name, 'sched-1');
    // The clock the times are read against — the answer to "it fired an hour out".
    assert.equal(status.schedules[0].timezone, 'Europe/Copenhagen');
    assert.equal(status.schedules[0].localTime, 'Tue 22:15');
  });

  test('recent writes fall back to a schedule when there is no controller', async () => {
    // "Did anything reach a light" must still answer on a Homey that has only
    // schedules on it — otherwise the one list that distinguishes "never fired"
    // from "fired and was refused" is permanently empty for those households.
    const write = { deviceId: 'light-1', capability: 'onoff', value: true, ok: true };
    const h = homey({ schedules: ['sched-1'], writes: { schedule: [write] } });

    const status = await api.getStatus(h.args);
    assert.equal(status.controllers.length, 0);
    assert.deepEqual(status.recentWrites, [write]);
  });

  test("with a controller running, its writes win over a schedule's", async () => {
    // Documented as "the FIRST controller only" — an indicator, not a merged log.
    const ctrl = { deviceId: 'light-1', capability: 'dim', value: 0.5, ok: true };
    const sched = { deviceId: 'light-2', capability: 'onoff', value: false, ok: true };
    const h = homey({
      controllers: ['ctrl-1'], schedules: ['sched-1'],
      writes: { controller: [ctrl], schedule: [sched] },
    });

    assert.deepEqual((await api.getStatus(h.args)).recentWrites, [ctrl]);
  });
});
