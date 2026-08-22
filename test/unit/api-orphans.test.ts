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

function homey(options: {
  controllers?: string[];
  schedules?: string[];
  managed?: Array<{ flowId: string; name: string; controllerId: string }>;
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
      recentWrites: [],
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
      manifest: { id: 'com.thomassidor.lightkeeper', version: '0.2.0' },
      app: {
        recentEvents: [],
        credentials: { getStatus: () => ({ present: true, valid: true }) },
        controllers: { all: () => (options.controllers ?? []).map(id => runtime(id, 'controller')) },
        schedules: {
          all: () => (options.schedules ?? []).map(id => runtime(id, 'schedule')),
          timeCard: async () => ({ card: null, candidates: [] }),
        },
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
    const h = homey({ schedules: ['sched-1'] });
    const status = await api.getStatus(h.args);
    assert.deepEqual(status.recentWrites, []);
    assert.equal(status.controllers.length, 0);
  });
});
