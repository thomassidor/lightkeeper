/**
 * The app's own `/diagnostics`, pulled off a real Homey.
 *
 * Configuration matches evidence.mjs and verify-hardware.mjs: HOMEY_ADDRESS +
 * HOMEY_API_KEY, or the gitignored scripts/hardware-env.json. Read-only — it
 * calls one GET route and writes nothing to the Homey.
 *
 * **The default is a DIGEST, and that is the whole point of the script.** The
 * raw document from a six-device house is roughly a megabyte of JSON: sixty
 * recorded actions and up to a hundred and twenty control events per runtime,
 * most of them identical ticks. Pasting that anywhere — a terminal, an issue, a
 * model's context — buries the four lines that matter under the ninety-nine per
 * cent that never changes. `--raw` and `--save` exist for when the detail IS
 * the question; reach for them second.
 *
 * What the digest chooses to show is not a guess. Every field `notable()` looks
 * at is one a real capture turned out to hinge on: a lamp that ignores writes, a
 * lamp that takes minutes to obey one, pre-staging stood down for a whole room,
 * an override nobody raised, a sensor that has gone quiet.
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const loadModule = createRequire(import.meta.url);
const APP_ID = 'com.thomassidor.lightkeeper';

/**
 * What to call one runtime.
 *
 * A Light Remote has no `name` of its own in diagnostics — it is identified by
 * the remote it listens to — so without the fallback every controller prints as
 * a bare `lk-ctrl-…` uuid, which is the one thing a reader cannot match to
 * anything in their house.
 */
const nameOf = (/** @type {any} */ runtime) =>
  runtime.name ?? runtime.source?.name ?? runtime.controllerId;

/** Every runtime in one list, each tagged with the section it came from. */
function runtimes(/** @type {any} */ diagnostics) {
  return [
    ...(diagnostics.controllers ?? []).map((/** @type {any} */ r) => ({ section: 'controller', ...r })),
    ...(diagnostics.schedules ?? []).map((/** @type {any} */ r) => ({ section: 'schedule', ...r })),
    ...(diagnostics.circadian ?? []).map((/** @type {any} */ r) => ({ section: r.kind ?? 'circadian', ...r })),
    ...(diagnostics.daylight ?? []).map((/** @type {any} */ r) => ({ section: 'daylight', ...r })),
  ];
}

const mb = (/** @type {unknown} */ bytes) =>
  typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : 'n/a';

/** Ages are measured against the Homey's own clock, never this machine's. */
function age(/** @type {number} */ now, /** @type {unknown} */ at) {
  if (typeof at !== 'number') return 'never';
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

/** How long until a moment still ahead of the Homey's clock. */
function until(/** @type {number} */ now, /** @type {unknown} */ at) {
  if (typeof at !== 'number') return 'unknown';
  const hours = (at - now) / 3600_000;
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
}

/**
 * Group one kind of control event by whatever distinguishes it.
 *
 * `report_ignored` carries a reason and `override` carries the capability, and
 * those are the two axes a reader asks about — "what kept being set aside" and
 * "what kept being taken over".
 *
 * `count` rather than 1 per row: the app folds a run of identical reports into
 * one row carrying how many it stands for, so counting rows would under-report
 * exactly the runs worth noticing.
 */
function countBy(/** @type {any[]} */ events, /** @type {string} */ type) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const event of events) {
    if (event.type !== type) continue;
    const key = event.reason ?? event.capability ?? '—';
    counts[key] = (counts[key] ?? 0) + (event.count ?? 1);
  }
  return counts;
}

const asList = (/** @type {Record<string, number>} */ counts) =>
  Object.entries(counts).map(([key, count]) => `${key} x${count}`).join(', ');

/**
 * The lines worth looking twice at, across every device.
 *
 * Deliberately a flat list rather than a per-device tree: the question this
 * answers is "is anything wrong", and a reader should not have to walk six
 * devices to find out that the answer is no.
 */
function notable(/** @type {any} */ diagnostics) {
  const now = diagnostics.generatedAt ?? Date.now();
  /** @type {string[]} */
  const lines = [];
  if (diagnostics.credential?.present && !diagnostics.credential?.valid) {
    lines.push('credential: present but NOT valid — every Flow-writing device is stranded');
  }
  for (const runtime of runtimes(diagnostics)) {
    const name = nameOf(runtime);
    if (runtime.state !== 'ready' && runtime.enabled !== false) lines.push(`${name}: state is ${runtime.state}`);
    if (runtime.recentFailures?.length) lines.push(`${name}: ${runtime.recentFailures.length} recent write failure(s)`);
    if (runtime.feedbackObservations > 0) {
      lines.push(`${name}: ${runtime.feedbackObservations} feedback observation(s) — its lamps may be driving their own sensor`);
    }
    for (const sensor of runtime.sensors ?? []) {
      if (sensor.available === false) lines.push(`${name}: sensor ${sensor.name} is unavailable`);
      else if (typeof sensor.at === 'number' && now - sensor.at > 6 * 3600_000) {
        lines.push(`${name}: sensor ${sensor.name} last reported ${age(now, sensor.at)}`);
      }
    }
    for (const target of runtime.targets ?? []) {
      const label = `${name} / ${String(target.id).slice(0, 8)}`;
      /**
       * A lamp that acks and does nothing, and a lamp that takes minutes to
       * obey, are both invisible in every other field: the app deliberately
       * does NOT stand down for either, so they read as a runtime with nothing
       * to do. These two counters are the only place they surface at all.
       */
      const counted = (/** @type {unknown} */ value) =>
        typeof value === 'number' ? String(value) : asList(/** @type {Record<string, number>} */ (value));
      if (target.ignoredWrites) lines.push(`${label}: ignored writes — ${counted(target.ignoredWrites)}`);
      if (target.approachingWrites) lines.push(`${label}: slow to obey — ${counted(target.approachingWrites)}`);
      if (target.overridden) {
        // `repeats` is the stuck-lamp signature: an override nobody raised, being
        // restated by the lamp itself for as long as the app lets it stand.
        const repeats = target.override?.repeats;
        lines.push(`${label}: overridden ${age(now, target.override?.at)}`
          + ` (${target.override?.capability} ${target.override?.value}, wanted ${target.override?.expected ?? '—'})`
          + (repeats ? `, restated ${repeats}x, last ${age(now, target.override?.lastAt)}` : ''));
      }
      if (target.preStageBackoff?.retestAt) {
        lines.push(`${label}: pre-staging stood down after ${target.preStageBackoff.periods} off-periods,`
          + ` retest in ${until(now, target.preStageBackoff.retestAt)}`);
      }
    }
  }
  return lines;
}

function digest(/** @type {any} */ diagnostics) {
  const now = diagnostics.generatedAt ?? Date.now();
  const heap = diagnostics.heap ?? {};
  /** @type {string[]} */
  const out = [];
  out.push(`${diagnostics.app?.id ?? APP_ID} ${diagnostics.app?.version ?? '?'} — captured ${new Date(now).toISOString()}`);
  out.push(`credential: present=${diagnostics.credential?.present} valid=${diagnostics.credential?.valid}, checked ${age(now, diagnostics.credential?.lastCheckedAt)}`);
  out.push(`heap: ${mb(heap.heapUsed)} of ${mb(heap.heapTotal)} (limit ${mb(heap.heapLimit)}), peak RSS ${mb(heap.maxRss)}, up ${((heap.uptimeSeconds ?? 0) / 3600).toFixed(1)}h`);
  out.push('');

  for (const runtime of runtimes(diagnostics)) {
    const targets = runtime.targets ?? [];
    const on = targets.filter((/** @type {any} */ t) => t.on === true).length;
    const overridden = targets.filter((/** @type {any} */ t) => t.overridden).length;
    out.push(`-- ${nameOf(runtime)} (${runtime.section}) — ${runtime.state}${runtime.enabled === false ? ', switched off' : ''}`
      + (runtime.writesLights === false ? ', publishes only' : ''));
    const sensor = runtime.sensors?.[0];
    // A Light Remote reports its lights as ids alone: it writes Flows rather
    // than driving the lamps itself, so it tracks no per-target state to show.
    const lights = runtime.targetIds?.length ?? targets.length;
    out.push(`   ${lights} lights${targets.length ? `, ${on} on, ${overridden} overridden` : ''}`
      + (sensor ? `; ${sensor.name} ${sensor.lux} lux ${age(now, sensor.at)}` : ''));

    const action = runtime.lastAction;
    if (action) {
      out.push(`   last pass ${age(now, action.at)}: ${action.reason}${action.detail ? ` — ${action.detail}` : ''},`
        + ` ${action.writes} write(s), ${action.skipped} skipped`);
    }
    if (runtime.section === 'daylight') {
      out.push(`   holding ${Number(runtime.now?.brightness).toFixed(2)} from ${runtime.now?.source}`
        + (runtime.feedbackRisk ? `; feedback risk armed, ${runtime.feedbackObservations} seen` : ''));
    }
    if (runtime.section === 'controller') {
      out.push(`   ${runtime.managedFlows?.length ?? 0} managed Flow(s), ${runtime.mappings?.length ?? 0} button(s),`
        + ` last press ${age(now, runtime.lastEvent?.at)}`);
    }
    // Ticks are the overwhelming majority of both histories and say nothing.
    // What a reader wants is the shape of the exceptions.
    const events = runtime.recentControlEvents ?? [];
    const overrides = countBy(events, 'override');
    const ignored = countBy(events, 'report_ignored');
    if (Object.keys(overrides).length) out.push(`   overrides seen: ${asList(overrides)}`);
    if (Object.keys(ignored).length) out.push(`   reports set aside: ${asList(ignored)}`);
    // Not a concern, so deliberately here and not in `notable()`: it is the
    // count of overrides that turned out to be a lamp switching itself off.
    const fadeOuts = (runtime.targets ?? [])
      .reduce((/** @type {number} */ sum, /** @type {any} */ t) => sum + (t.fadeOutOverrides ?? 0), 0);
    if (fadeOuts) out.push(`   ${fadeOuts} override(s) were the lamp fading out`);
    out.push('');
  }

  const concerns = notable(diagnostics);
  out.push(concerns.length ? `Worth a look (${concerns.length}):` : 'Nothing stands out.');
  for (const line of concerns) out.push(`  - ${line}`);
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node scripts/diagnostics.mjs [--raw] [--save [file.json]]');
    console.log('  (default)  a digest: state, last pass, and anything worth a second look');
    console.log('  --raw      the whole document, unabridged, to stdout');
    console.log('  --save     the whole document to temp/ (gitignored), digest to stdout');
    return;
  }
  const raw = args.includes('--raw');
  const save = args.includes('--save');
  const next = save ? args[args.indexOf('--save') + 1] : undefined;
  const destination = next && !next.startsWith('--') ? next : null;

  /** @type {{ address?: string, key?: string }} */
  let config = {};
  try { config = JSON.parse(readFileSync(new URL('./hardware-env.json', import.meta.url), 'utf8')); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new Error('Could not read scripts/hardware-env.json.'); }
  const address = process.env.HOMEY_ADDRESS ?? config.address;
  const token = process.env.HOMEY_API_KEY ?? config.key;
  if (!address || !token) throw new Error('Set HOMEY_ADDRESS and HOMEY_API_KEY, or fill in scripts/hardware-env.json.');

  const HomeyAPI = loadModule('homey-api/lib/HomeyAPI/HomeyAPI');
  const api = await HomeyAPI.createLocalAPI({ address, token });
  try {
    const app = await api.apps.getApp({ id: APP_ID });
    const diagnostics = await app.get({ path: '/diagnostics' });
    if (raw && !save) { console.log(JSON.stringify(diagnostics, null, 2)); return; }
    if (save) {
      // temp/ is gitignored for exactly this: a capture carries device names,
      // zone names and the owner's display name (test/fixtures/README.md).
      mkdirSync(resolve('temp'), { recursive: true });
      const stamp = new Date(diagnostics.generatedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-');
      const path = destination ?? join('temp', `diagnostics-${stamp}.json`);
      writeFileSync(path, JSON.stringify(diagnostics, null, 2));
      console.log(`Saved ${resolve(path)}\n`);
    }
    console.log(digest(diagnostics));
  } finally { await api.destroy(); }
}

/**
 * Anything key-shaped, out of a message on its way to a terminal.
 *
 * A copy of the pattern in evidence.mjs for the reason given there: a
 * standalone `.mjs` run from a developer's machine that imports no app code,
 * and the one place a Personal API Key could surface.
 */
const KEY_MATERIAL = /[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{20,}|(?<![.\d])[0-9a-f]{20,}/gi;
/** @param {unknown} text */
const redactKeyMaterial = text => String(text).replace(KEY_MATERIAL, '<redacted>');

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // The real message, redacted — not a generic sentence. A missing route
    // (404), a rejected key (401) and an unreachable Homey all fail here, and
    // telling them apart is the whole point of running this at all.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not read diagnostics: ${redactKeyMaterial(message)}`);
    console.error('Check the address, the key, and that the app is installed and running.');
    process.exitCode = 1;
  });
}
