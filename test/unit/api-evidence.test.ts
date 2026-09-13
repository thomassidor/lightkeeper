import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EvidenceFeature } from '../../lib/support/evidence-feature';

const api = require('../../api.ts');

/**
 * The six routes that drive the week-long recorder, at the boundary a webview
 * actually reaches them through.
 *
 * These matter more than their size suggests. The recorder is the ONE feature
 * whose whole value is being switched on for a week and then read back, so a
 * route that accepts something it should not — or refuses something it should
 * not — is not discovered until the week is over and the evidence is wrong.
 * `noteEvidence` in particular is the only route that takes free text from a
 * human, and it is the only place in the app that does.
 *
 * The rules being tested live in `EvidenceFeature`, not in `api.ts` — the
 * handlers moved there so a launch build can drop them by returning no routes
 * at all (`lib/support/evidence-feature.ts`). So a REAL feature is built here
 * over a fake recorder, and the routes are still called through `api`: the path
 * under test is the whole of it, handler and rule alike, which is more than
 * this file used to cover.
 */

interface Recorded { type: string; data: unknown }

function homey(options: {
  state?: string;
  endsAt?: number;
  /** Make the archive refuse a write, the way a full `/userdata` does. */
  flushFails?: string;
} = {}) {
  const records: Recorded[] = [];
  let flushes = 0;

  const status = () => ({
    state: options.state ?? 'recording',
    id: 'a-run-id',
    endsAt: options.endsAt ?? Date.now() + 60_000,
    bytes: 1024,
    records: records.length,
    dropped: 0,
  });

  const evidence = {
    status,
    record: (type: string, data: unknown) => { records.push({ type, data }); },
    flush: async () => {
      flushes += 1;
      if (options.flushFails) throw new Error(options.flushFails);
    },
    init: async () => undefined,
    start: async () => ({ ...status(), started: true }),
    stop: async () => ({ ...status(), state: 'stopped' }),
    clear: async (id: string) => ({ ...status(), state: 'idle', cleared: id }),
    read: async (id: string, offset: number, end: number) => ({ id, offset, end, frames: [] }),
  };

  const feature = new EvidenceFeature(
    {
      settings: { get: () => undefined, set: () => undefined, unset: () => undefined },
      context: () => ({ appVersion: 'test' }),
      sample: () => ({ runtimes: [], sensors: [], credential: null }),
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => undefined,
      log: () => undefined,
    },
    () => evidence as never,
  );

  return {
    records,
    flushCount: () => flushes,
    feature,
    homey: {
      app: {
        evidence: feature,
        log: () => undefined,
        error: () => undefined,
      },
    } as any,
  };
}

/** Built lazily by `init()`, so every test opens by building it. */
async function ready(options: Parameters<typeof homey>[0] = {}) {
  const h = homey(options);
  await h.feature.init();
  return h;
}

describe('GET /evidence', () => {
  test('flushes before reporting, so the count is not one buffer behind', async () => {
    // The document tells the tester to "check that the count increases after a
    // minute". Reporting a status computed before the pending buffer was
    // written would show a stalled count on a recorder that is working.
    const h = await ready();
    const status = await api.getEvidence({ homey: h.homey });

    assert.equal(h.flushCount(), 1);
    assert.equal(status.state, 'recording');
  });
});

describe('POST /evidence/note', () => {
  test('an observation is recorded and flushed immediately', async () => {
    // Flushed rather than buffered: the note exists to be correlated with what
    // the household saw at that moment, and a crash in the next fifteen
    // seconds would take the note and leave the behaviour.
    const h = await ready();
    await api.noteEvidence({ homey: h.homey, body: { text: 'kitchen went dark' } });

    assert.deepEqual(h.records, [{ type: 'observation', data: { text: 'kitchen went dark' } }]);
    assert.equal(h.flushCount(), 1);
  });

  test('surrounding whitespace is trimmed', async () => {
    const h = await ready();
    await api.noteEvidence({ homey: h.homey, body: { text: '  hall lamp flickered \n' } });
    assert.deepEqual(h.records[0]?.data, { text: 'hall lamp flickered' });
  });

  test('nothing is recorded when no recording is running', async () => {
    for (const state of ['idle', 'stopped', 'complete', 'full', 'error']) {
      const h = await ready({ state });
      await assert.rejects(
        () => api.noteEvidence({ homey: h.homey, body: { text: 'something' } }),
        /No active recording/,
        `state "${state}" accepted a note`,
      );
      assert.deepEqual(h.records, [], `state "${state}" recorded anyway`);
    }
  });

  test('nor after the seven days are up, even if the state still says recording', async () => {
    // The deadline is the promise the privacy notice makes, so it is enforced
    // at the route as well as by the flush that eventually notices it.
    const h = await ready({ endsAt: Date.now() - 1 });
    await assert.rejects(
      () => api.noteEvidence({ homey: h.homey, body: { text: 'late' } }),
      /No active recording/,
    );
    assert.deepEqual(h.records, []);
  });

  test('an empty, whitespace-only, missing or non-string note is refused', async () => {
    for (const body of [
      { text: '' }, { text: '   ' }, { text: '\n\t' },
      {}, undefined, { text: null }, { text: 42 }, { text: ['a'] }, { text: { a: 1 } },
    ]) {
      const h = await ready();
      await assert.rejects(
        () => api.noteEvidence({ homey: h.homey, body }),
        /at most 1000 characters/,
        `accepted ${JSON.stringify(body)}`,
      );
      assert.deepEqual(h.records, [], `recorded ${JSON.stringify(body)}`);
    }
  });

  test('a thousand characters is the limit, and it is inclusive', async () => {
    const ok = await ready();
    await api.noteEvidence({ homey: ok.homey, body: { text: 'x'.repeat(1000) } });
    assert.equal((ok.records[0]?.data as any).text.length, 1000);

    const over = await ready();
    await assert.rejects(
      () => api.noteEvidence({ homey: over.homey, body: { text: 'x'.repeat(1001) } }),
      /at most 1000 characters/,
    );
    assert.deepEqual(over.records, []);
  });
});

describe('the start, stop, clear and read routes', () => {
  test('start goes through the feature, because the sample needs the runtimes', async () => {
    // Not `recorder.start()` directly: a run has to open with one health
    // sample, and the feature is what holds the host that can produce one.
    const h = await ready({ state: 'idle' });
    const status = await api.startEvidence({ homey: h.homey });
    assert.equal(status.started, true);
  });

  test('stop reports the archive it stopped', async () => {
    const h = await ready();
    assert.equal((await api.stopEvidence({ homey: h.homey })).state, 'stopped');
  });

  test('clear takes the id from the path and coerces it to a string', async () => {
    const h = await ready();
    const status = await api.clearEvidence({ homey: h.homey, params: { id: 'a-run-id' } });
    assert.equal((status as any).cleared, 'a-run-id');
  });

  test('read passes the byte range through as numbers', async () => {
    // The export streams in ranges, so a string offset would concatenate
    // rather than add and the second chunk would start in the wrong place.
    const h = await ready();
    const frame = await api.readEvidence({
      homey: h.homey,
      params: { id: 'a-run-id', offset: '2048', end: '4096' },
    });

    assert.equal(frame.offset, 2048);
    assert.equal(frame.end, 4096);
    assert.equal(typeof frame.offset, 'number');
  });
});
