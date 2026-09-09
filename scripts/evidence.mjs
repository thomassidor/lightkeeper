/** Seven-day test recordings. Uses its own Personal API Key, never the app's.
 * Configuration matches verify-hardware.mjs: HOMEY_ADDRESS + HOMEY_API_KEY,
 * or the gitignored scripts/hardware-env.json. No background laptop is needed. */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const loadModule = createRequire(import.meta.url);
const APP_ID = 'com.thomassidor.lightkeeper';

/** @param {any} app @param {any} status @param {string} destination */
export async function exportEvidence(app, status, destination) {
  if (!status.id || !Number.isSafeInteger(status.bytes)) throw new Error('No recording to export.');
  if (!destination.endsWith('.gz')) throw new Error('Use a .ndjson.gz destination for the compressed export.');
  const end = status.bytes;
  async function* records() {
    yield JSON.stringify({ schema: 1, type: 'export_manifest', exportedAt: Date.now(), status }) + '\n';
    let offset = 0;
    while (offset < end) {
      const page = await app.get({ path: `/evidence/${status.id}/${offset}/${end}` });
      if (typeof page.text !== 'string' || !Number.isSafeInteger(page.next) || page.next <= offset || page.next > end) {
        throw new Error('The recording export did not advance safely.');
      }
      yield page.text;
      offset = page.next;
    }
  }
  const output = await open(destination, 'wx');
  try { await pipeline(Readable.from(records()), createGzip(), output.createWriteStream()); }
  finally { await output.close(); }
}

/** Streaming analysis: a week of evidence never needs to fit in memory.
 * @param {string} source */
export async function analyzeEvidence(source) {
  const input = createReadStream(source);
  const decoded = source.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  input.on('error', error => decoded.destroy(error));
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  /** @type {Record<string, number>} */
  const types = {};
  /** @type {Record<string, { attempts: number, failed: number, maxMs: number, totalMs: number }>} */
  const writes = {};
  /** @type {Record<string, number>} */
  const outcomes = {};
  /** @type {Record<string, { minLux: number, maxLux: number, samples: number, maxReadingAgeMs: number }>} */
  const sensors = {};
  const boots = new Set();
  /** @type {Map<string, number>} */
  const lastHealth = new Map();
  let maxSampleGapMs = 0, maxWithinBootGapMs = 0, maxRssBytes = 0, overrides = 0, malformed = 0;
  let lastHealthAt = null;
  let firstAt = Infinity, lastAt = 0;
  let manifest = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!row || typeof row.type !== 'string') { malformed++; continue; }
    types[row.type] = (types[row.type] ?? 0) + 1;
    if (row.type === 'export_manifest') { manifest = row.status; continue; }
    if (Number.isFinite(row.recordedAt)) { firstAt = Math.min(firstAt, row.recordedAt); lastAt = Math.max(lastAt, row.recordedAt); }
    boots.add(row.bootId);
    const data = row.data ?? {};
    if (row.type === 'write_result') {
      const key = `${data.controllerId ?? 'unknown'}/${data.deviceId}/${data.capability}`;
      const item = writes[key] ??= { attempts: 0, failed: 0, maxMs: 0, totalMs: 0 };
      item.attempts++; if (data.ok === false) item.failed++;
      if (Number.isFinite(data.ms)) { item.maxMs = Math.max(item.maxMs, data.ms); item.totalMs += data.ms; }
    }
    if (row.type === 'control_event' && data.action?.type === 'override') overrides++;
    if (row.type === 'control_completion') {
      for (const result of data.outcomes ?? []) outcomes[result.status] = (outcomes[result.status] ?? 0) + 1;
    }
    if (row.type === 'health_sample') {
      const prior = lastHealth.get(row.bootId);
      if (prior !== undefined) maxWithinBootGapMs = Math.max(maxWithinBootGapMs, row.recordedAt - prior);
      if (lastHealthAt !== null) maxSampleGapMs = Math.max(maxSampleGapMs, row.recordedAt - lastHealthAt);
      lastHealthAt = row.recordedAt;
      lastHealth.set(row.bootId, row.recordedAt);
      maxRssBytes = Math.max(maxRssBytes, data.memory?.rss ?? 0);
      for (const sensor of data.sensors ?? []) {
        const item = sensors[sensor.deviceId] ??= { minLux: Infinity, maxLux: 0, samples: 0, maxReadingAgeMs: 0 };
        if (typeof sensor.lux === 'number') { item.minLux = Math.min(item.minLux, sensor.lux); item.maxLux = Math.max(item.maxLux, sensor.lux); item.samples++; }
        if (typeof sensor.at === 'number') item.maxReadingAgeMs = Math.max(item.maxReadingAgeMs, row.recordedAt - sensor.at);
      }
    }
  }
  return { manifest, firstAt: Number.isFinite(firstAt) ? firstAt : null, lastAt: lastAt || null,
    boots: boots.size, types, writes, outcomes, sensors, overrides, maxSampleGapMs, maxWithinBootGapMs, maxRssBytes, malformed,
    interpretation: 'Write success is API acceptance. Sensor age alone is not a fault. Inspect the timeline around failures, overrides and gaps.' };
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'analyze' && argument) {
    console.log(JSON.stringify(await analyzeEvidence(argument), null, 2)); return;
  }
  if (!['start', 'status', 'stop', 'export', 'clear', 'note'].includes(command ?? '')) {
    console.log('Usage: node scripts/evidence.mjs start|status|stop|export [file.ndjson.gz]|clear <recording-id>|note "what you noticed"|analyze <file.ndjson.gz>');
    return;
  }
  /** @type {{ address?: string, key?: string }} */
  let config = {};
  try { config = JSON.parse(readFileSync(new URL('./hardware-env.json', import.meta.url), 'utf8')); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new Error('Could not read scripts/hardware-env.json.'); }
  const address = process.env.HOMEY_ADDRESS ?? config.address;
  const token = process.env.HOMEY_API_KEY ?? config.key;
  if (!address || !token) throw new Error('Set HOMEY_ADDRESS and HOMEY_API_KEY, using a key separate from the app.');
  const HomeyAPI = loadModule('homey-api/lib/HomeyAPI/HomeyAPI');
  const api = await HomeyAPI.createLocalAPI({ address, token });
  try {
    const app = await api.apps.getApp({ id: APP_ID });
    if (command === 'start' || command === 'stop') console.log(JSON.stringify(await app.post({ path: `/evidence/${command}`, body: {} }), null, 2));
    else if (command === 'clear') {
      if (!argument) throw new Error('Supply the recording id to clear.');
      console.log(JSON.stringify(await app.delete({ path: `/evidence/${encodeURIComponent(argument)}` }), null, 2));
    } else if (command === 'note') {
      if (!argument) throw new Error('Supply a short observation.');
      console.log(JSON.stringify(await app.post({ path: '/evidence/note', body: { text: argument } }), null, 2));
    } else {
      const status = await app.get({ path: '/evidence' });
      if (command === 'status') console.log(JSON.stringify(status, null, 2));
      else {
        mkdirSync(resolve('.evidence'), { recursive: true });
        const destination = argument ?? join('.evidence', `${status.id}-${Date.now()}.ndjson.gz`);
        await exportEvidence(app, status, destination);
        console.log(`Saved ${resolve(destination)}`);
        console.log(JSON.stringify(await analyzeEvidence(destination), null, 2));
      }
    }
  } finally { await api.destroy(); }
}

/**
 * Anything key-shaped, out of a message on its way to a terminal.
 *
 * A 64-hex archive key and a Personal API Key are both caught by this, and
 * this script's whole job is to move recorded evidence around, so a stray
 * error string is exactly where one would surface. Deliberately a copy of the
 * pattern in `lib/support/homey-errors.ts` rather than an import: this file is
 * a standalone `.mjs` run from a developer's machine and imports no app code.
 */
const KEY_MATERIAL = /[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{20,}|[0-9a-f]{20,}/gi;
/** @param {unknown} text */
const redactKeyMaterial = text => String(text).replace(KEY_MATERIAL, '<redacted>');

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // The REAL message, redacted — not a generic sentence. During the smoke
    // test a missing route (404), a rejected key (401) and an existing archive
    // (EEXIST) all failed identically here, and telling them apart is the
    // whole point of running the smoke test at all.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Evidence command failed: ${redactKeyMaterial(message)}`);
    console.error('Check connectivity, credentials, recording status and the output path.');
    process.exitCode = 1;
  });
}
