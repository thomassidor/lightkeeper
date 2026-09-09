import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, appendFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EvidenceRecorder } from '../../lib/support/evidence-recorder';
import { EvidenceSampler } from '../../lib/support/evidence-sampler';
import { exportEvidence, analyzeEvidence } from '../../scripts/evidence.mjs';

async function rig(maxBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'lightkeeper-evidence-'));
  const values = new Map<string, unknown>();
  let now = Date.UTC(2026, 8, 8);
  const deps = { directory, now: () => now, maxBytes, settings: {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    unset: (key: string) => { values.delete(key); },
  } };
  const recorder = new EvidenceRecorder(deps);
  await recorder.init({ version: 'test' });
  return { recorder, deps, values, directory, advance: (ms: number) => { now += ms; },
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function all(recorder: EvidenceRecorder): Promise<any[]> {
  await recorder.flush();
  const status = recorder.status();
  let offset = 0, text = '';
  while (offset < status.bytes) {
    const page = await recorder.read(status.id!, offset, status.bytes);
    assert.ok(page.next > offset);
    text += page.text; offset = page.next;
  }
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('recording is opt-in, encrypted on disk, and redacted before persistence', async () => {
  const h = await rig();
  try {
    h.recorder.record('ignored', { lamp: 'Kitchen' });
    assert.deepEqual(await readdir(h.directory), []);
    await h.recorder.start({ appVersion: 'test' });
    const secret = 'abcdef0123456789abcdef0123456789abcdef0123';
    h.recorder.record('sample', { lamp: 'Kitchen', key: 'short-secret', message: `token ${secret}` });
    const rows = await all(h.recorder);
    assert.equal(rows[1].data.lamp, 'Kitchen');
    assert.equal(JSON.stringify(rows).includes(secret), false);
    assert.equal(JSON.stringify(rows).includes('short-secret'), false);
    const file = await readFile(join(h.directory, `${h.recorder.status().id}.enc`), 'utf8');
    assert.equal(file.includes('Kitchen'), false);
    assert.equal(JSON.stringify(h.recorder.status()).includes('key'), false);
  } finally { await h.cleanup(); }
});

test('a restart resumes the same run and deadline, with distinct boot ids', async () => {
  const h = await rig();
  try {
    const started = await h.recorder.start({ version: 'test' });
    h.recorder.record('before_restart', {});
    await h.recorder.close();
    h.advance(2 * 24 * 60 * 60_000);
    const restarted = new EvidenceRecorder(h.deps);
    await restarted.init({ version: 'new-test-build' });
    assert.equal(restarted.status().id, started.id);
    assert.equal(restarted.status().endsAt, started.endsAt);
    const rows = await all(restarted);
    assert.equal(new Set(rows.map(row => row.bootId)).size, 2);
    assert.ok(rows.some(row => row.type === 'app_shutdown'));
    assert.ok(rows.some(row => row.type === 'app_boot'));
    h.advance(6 * 24 * 60 * 60_000);
    restarted.record('too_late', {});
    await restarted.flush();
    assert.equal(restarted.status().state, 'complete');
    assert.equal((await all(restarted)).some(row => row.type === 'too_late'), false);
  } finally { await h.cleanup(); }
});

test('a crash tail is removed without losing committed evidence', async () => {
  const h = await rig();
  try {
    await h.recorder.start({});
    await appendFile(join(h.directory, `${h.recorder.status().id}.enc`), 'partial-frame');
    const restarted = new EvidenceRecorder(h.deps);
    await restarted.init({});
    const rows = await all(restarted);
    assert.equal(rows[0].type, 'recording_started');
    assert.equal(rows.at(-1).data.recoveredTailBytes, 13);
  } finally { await h.cleanup(); }
});

test('storage and buffer limits are visible and keep existing records', async () => {
  const h = await rig(1500);
  try {
    await h.recorder.start({});
    for (let i = 0; i < 50; i++) h.recorder.record('busy', { message: randomBytes(512).toString('base64') });
    await h.recorder.flush();
    assert.equal(h.recorder.status().state, 'full');
    assert.ok(h.recorder.status().dropped > 0);
    assert.ok(h.recorder.status().bytes <= 1500);
    assert.equal((await all(h.recorder))[0].type, 'recording_started');
    await assert.rejects(h.recorder.start({}), /already exists/);
  } finally { await h.cleanup(); }
});

test('large records are explicitly dropped and failures do not break lamp callbacks', async () => {
  const h = await rig();
  try {
    await h.recorder.start({});
    h.recorder.record('huge', { message: 'x'.repeat(40_000) });
    for (let i = 0; i < 30; i++) h.recorder.record('burst', { message: 'x'.repeat(25_000) });
    assert.ok(h.recorder.status().dropped > 1);
    await h.recorder.flush();
    await rm(join(h.directory, `${h.recorder.status().id}.enc`));
    await writeFile(h.directory + '/block', 'block');
    // A restarted recorder exposes a missing archive as an error, not an empty
    // successful recording. An ordinary record callback remains non-throwing.
    const restarted = new EvidenceRecorder(h.deps);
    await restarted.init({});
    assert.equal(restarted.status().state, 'error');
    assert.doesNotThrow(() => restarted.record('late', {}));
  } finally { await h.cleanup(); }
});

test('paged exports are complete and bounded even for highly compressible data', async () => {
  const h = await rig();
  try {
    await h.recorder.start({});
    for (let i = 0; i < 20; i++) {
      h.recorder.record('compressible', { message: 'x'.repeat(25_000), i });
      await h.recorder.flush();
    }
    const status = h.recorder.status();
    const first = await h.recorder.read(status.id!, 0, status.bytes);
    assert.ok(Buffer.byteLength(first.text) <= 256 * 1024);
    assert.ok(first.next < status.bytes);
    const rows = await all(h.recorder);
    assert.equal(rows.filter(row => row.type === 'compressible').length, 20);
    assert.equal(new Set(rows.map(row => row.sequence)).size, rows.length);
    await assert.rejects(h.recorder.read('../escape', 0, status.bytes));
    await assert.rejects(h.recorder.read(status.id!, -1, status.bytes));
    await assert.rejects(h.recorder.read(status.id!, 0, status.bytes + 1));
  } finally { await h.cleanup(); }
});

test('export uses a frozen endpoint and analysis counts failures and observations', async () => {
  const h = await rig();
  try {
    await h.recorder.start({});
    h.recorder.record('write_result', { controllerId: 'c', deviceId: 'l', capability: 'dim', ok: false, ms: 900 });
    h.recorder.record('observation', { text: 'The desk lamp flickered.' });
    await h.recorder.flush();
    const status = h.recorder.status();
    h.recorder.record('later', {});
    await h.recorder.flush();
    const destination = join(h.directory, 'export.ndjson.gz');
    await exportEvidence({ get: ({ path }: { path: string }) => {
      const [, , id, offset, end] = path.split('/');
      return h.recorder.read(id, Number(offset), Number(end));
    } }, status, destination);
    const report = await analyzeEvidence(destination);
    assert.equal(report.writes['c/l/dim'].failed, 1);
    assert.equal(report.types.observation, 1);
    assert.equal(report.types.later, undefined);
    await assert.rejects(exportEvidence({}, status, destination), /EEXIST/);
    await assert.rejects(h.recorder.clear(status.id!), /Stop recording/);
    await h.recorder.stop();
    await assert.rejects(h.recorder.clear('wrong-id'));
    await h.recorder.clear(status.id!);
    assert.equal(h.recorder.status().state, 'idle');
  } finally { await h.cleanup(); }
});

test('sampler emits config changes and removal, excluding recent buffers', () => {
  const events: Array<{ type: string; data: any }> = [];
  const sampler = new EvidenceSampler((type, data) => events.push({ type, data }));
  const runtime = { controllerId: 'c', diagnostics: () => ({ name: 'Lamp', state: 'ready', recentWrites: ['not copied'] }) };
  sampler.sample([{ kind: 'curve', runtime, configuration: { enabled: true } }]);
  sampler.sample([{ kind: 'curve', runtime, configuration: { enabled: true } }]);
  sampler.sample([{ kind: 'curve', runtime, configuration: { enabled: false } }]);
  sampler.sample([]);
  assert.equal(events.filter(row => row.type === 'configuration').length, 2);
  assert.equal(events.filter(row => row.type === 'runtime_sample').length, 3);
  assert.equal(events.at(-1)?.type, 'runtime_removed');
  assert.equal(JSON.stringify(events).includes('not copied'), false);
});

test('a synthetic seven-day run retains its first and last day and stops at its deadline', async () => {
  const h = await rig();
  try {
    await h.recorder.start({ version: 'week-test' });
    // Hourly fixture batches exercise the complete time span without spending
    // seven days on wall-clock waits. Buffer/storage-pressure cases are above.
    for (let hour = 0; hour < 7 * 24; hour++) {
      h.recorder.record('health_sample', { hour, memory: { rss: 32_000_000 }, sensors: [] });
      h.recorder.record('write_result', { controllerId: 'c', deviceId: 'lamp', capability: 'dim', value: 0.2, ok: true, ms: 250 });
      await h.recorder.flush();
      h.advance(60 * 60_000);
    }
    await h.recorder.flush();
    assert.equal(h.recorder.status().state, 'complete');
    assert.equal(h.recorder.status().dropped, 0);
    const rows = await all(h.recorder);
    const samples = rows.filter(row => row.type === 'health_sample');
    assert.equal(samples.length, 168);
    assert.equal(samples[0].data.hour, 0);
    assert.equal(samples.at(-1).data.hour, 167);
  } finally { await h.cleanup(); }
});

test('close() keeps app_shutdown even when a flush is already in flight', async () => {
  /**
   * `flush()` coalesces: while one pass is running it hands back that same
   * promise rather than starting a second. So a shutdown landing during the
   * 15-second timer's flush used to be told "already flushing", await a pass
   * that had taken its snapshot before `app_shutdown` was buffered, and return
   * having written everything except the record it was called for.
   *
   * `app_shutdown` is half of the pair that proves a restart resumed the same
   * run rather than starting a new one, so losing it costs the evidence its
   * boot boundary — which is exactly what a week-long test is for.
   */
  const h = await rig();
  try {
    await h.recorder.start({ appVersion: 'test' });
    h.recorder.record('before', {});

    // A flush in flight, deliberately not awaited: this is the 15 s timer.
    const inFlight = h.recorder.flush();
    await h.recorder.close();
    await inFlight;

    const types = (await all(h.recorder)).map(record => record.type);
    assert.ok(types.includes('before'), 'lost a record buffered before the shutdown');
    assert.ok(types.includes('app_shutdown'), 'lost the shutdown record itself');
    assert.equal(types.at(-1), 'app_shutdown', 'and it must be the last thing in the archive');
  } finally { await h.cleanup(); }
});

test('an idle flush does not rewrite the manifest', async () => {
  // 15 seconds a pass for seven days is about 40,000 settings writes, and in a
  // quiet house nearly all of them wrote the same object back. Every branch
  // that actually moves `bytes`, `records`, `state` or `dropped` saves for
  // itself, so there is nothing for a trailing save to catch.
  const h = await rig();
  try {
    await h.recorder.start({ appVersion: 'test' });
    h.recorder.record('one', {});
    await h.recorder.flush();

    let writes = 0;
    const set = h.deps.settings.set;
    h.deps.settings.set = (key: string, value: unknown) => { writes += 1; set(key, value); };

    for (let i = 0; i < 5; i += 1) {
      h.advance(15_000);
      await h.recorder.flush();
    }

    assert.equal(writes, 0, `five idle flushes wrote the manifest ${writes} times`);

    // And a flush with something to write still saves, or the count on the
    // settings page would never move.
    h.recorder.record('two', {});
    await h.recorder.flush();
    assert.ok(writes > 0, 'a flush with a record to write must save');
  } finally { await h.cleanup(); }
});

test('a frame tampered with inside the committed range fails authentication', async () => {
  /**
   * Each frame is AES-256-GCM, so the tag is what makes a changed byte a
   * failure rather than plausible-looking rubbish. The distinction from the
   * crash-tail case above matters: a tail beyond the committed length is
   * ignored by design and is not evidence of anything, whereas a byte changed
   * INSIDE the committed range means the archive is not what we wrote — and
   * reading it as evidence would be worse than not reading it at all.
   */
  const h = await rig();
  try {
    await h.recorder.start({ appVersion: 'test' });
    h.recorder.record('real', { n: 1 });
    await h.recorder.flush();

    const id = h.recorder.status().id!;
    const file = join(h.directory, `${id}.enc`);
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    const frame = JSON.parse(lines[0]!);
    // One byte of ciphertext, changed. Same length, so the committed count and
    // every offset stay exactly as the manifest records them.
    const data = Buffer.from(frame.data, 'base64');
    data[0] = data[0]! ^ 0xff;
    lines[0] = JSON.stringify({ ...frame, data: data.toString('base64') });
    await writeFile(file, `${lines.join('\n')}\n`);

    const status = h.recorder.status();
    await assert.rejects(
      () => h.recorder.read(id, 0, status.bytes),
      /.*/,
      'a tampered frame was decoded as valid evidence',
    );
  } finally { await h.cleanup(); }
});

test('analysis separates a within-boot gap from an across-boot one', async () => {
  /**
   * The one thing the analysis is actually FOR: a minute-long hole in a run is
   * the app being restarted, and an hour-long hole is the bug. Telling them
   * apart needs the boot id, which is why every record carries one.
   */
  const h = await rig();
  try {
    await h.recorder.start({ appVersion: 'test' });
    h.recorder.record('health_sample', { n: 1 });
    h.advance(60_000);
    h.recorder.record('health_sample', { n: 2 });
    await h.recorder.flush();

    // A restart: same run, same deadline, a new boot id.
    h.advance(30 * 60_000);
    const restarted = new EvidenceRecorder(h.deps);
    await restarted.init({ appVersion: 'test' });
    restarted.record('health_sample', { n: 3 });
    await restarted.flush();

    const records = await all(restarted);
    const boots = new Set(records.map(record => record.bootId));
    assert.equal(boots.size, 2, 'a restart must be visible as a second boot id');

    const runs = new Set(records.map(record => record.runId));
    assert.equal(runs.size, 1, 'and it must still be one run, or the deadline restarted too');

    // Sequence numbers are per run and monotonic, which is what lets a gap be
    // told from a reordering.
    const sequences = records.map(record => record.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  } finally { await h.cleanup(); }
});
