/**
 * The parts of `docs/hardware-test-plan.md` a script can answer.
 *
 * Run from a laptop against a real Homey, over the same `createLocalAPI` client
 * and the same Personal API Key the app itself uses for Flow writes (platform
 * §1). It does NOT install the app and it cannot pair devices — Homey's pair
 * sessions are not an API surface — so it verifies a Homey you have already set
 * up by hand, and the pass's "starts from nothing" premise stays a manual job.
 *
 * WHAT IT COVERS, by test-plan line:
 *
 *   spike       — nothing; it answers whether the rest can run at all
 *   flows       — 1.3, 2.9, 3.5, 4.6, 5.9          read-only
 *   redaction   — 8.2, 8.3, 8.4, 8.5               read-only
 *   credential  — 7.1, 7.2, 7.4, 7.6, 7.7          writes the key, needs --yes
 *   rejoin      — 4.7, 4.8, 5.8                    writes to your lamps, needs --yes
 *
 * WHAT IT DELIBERATELY DOES NOT COVER:
 *
 * - Anything needing a finger on a remote — 2.10-2.12. A generated Flow can be
 *   run over the API, but that bypasses the real release event, and "the release
 *   event was dropped" is the entire reason the ramp hard-stops at 10 seconds.
 * - Anything needing eyes on a screen: the pairing views, the four device
 *   pictures, the curve chart.
 * - Re-deriving what the curve SHOULD be at this moment. That would re-implement
 *   the engine the unit suite already covers, and a test that mirrors the
 *   implementation proves nothing. Instead this asks the app what it wrote
 *   (`recentWrites`) and checks the lamp is holding that.
 *
 * CONFIGURATION. Either two environment variables:
 *
 *   HOMEY_ADDRESS=http://192.168.1.23   HOMEY_API_KEY=<personal api key>
 *
 * or `scripts/hardware-env.json` — `{ "address": "...", "key": "..." }` — which
 * is gitignored, because a Personal API Key is a credential and this repo's rule
 * is that nothing from a real Homey gets committed (see test/fixtures/README.md).
 *
 * The key is never printed. `redaction` searches for it on purpose and reports
 * only whether it was found.
 *
 * USAGE
 *
 *   node scripts/verify-hardware.mjs spike
 *   node scripts/verify-hardware.mjs flows redaction
 *   node scripts/verify-hardware.mjs rejoin --yes
 *   node scripts/verify-hardware.mjs all              # every read-only command
 *
 * Output is one line per test-plan line, in the plan's own `section.line OK`
 * form, so it pastes straight into a report. Exit code is 1 if anything FAILED.
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
// homey-api ships JS with JSDoc rather than type declarations, so everything it
// returns is `any` here for the same reason it is `any` in the app.
const { HomeyAPI } = /** @type {any} */ (require('homey-api'));

const APP_ID = 'com.thomassidor.lightkeeper';

/** The three bridge action cards. A Flow calling one of these is ours. */
const BRIDGE_CARDS = ['bridge_event', 'bridge_numeric_event', 'bridge_token_event'];

/** The two drivers that own Flows, and the two that must never own one (platform §12). */
const FLOW_OWNING_DRIVERS = ['controller', 'schedule'];
const FLOWLESS_DRIVERS = ['circadian', 'curve'];

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// ---------------------------------------------------------------- reporting

/** @type {Array<{ line: string, status: string, detail: string }>} */
const results = [];

/**
 * One line of the report. `line` is a test-plan number — `4.7` — or `-` for
 * something the plan does not number.
 *
 * @param {string} line
 * @param {'OK'|'FAILED'|'SKIPPED'|'INFO'} status
 * @param {string} detail
 */
function report(line, status, detail) {
  results.push({ line, status, detail });
  const label = line === '-' ? '    ' : line.padEnd(4);
  console.log(`${label} ${status.padEnd(7)} ${detail}`);
}

/**
 * Progress that is not a result. Kept out of the report.
 *
 * @param {string} message
 */
function note(message) {
  console.log(`          ${message}`);
}

// ------------------------------------------------------------ configuration

/** @returns {{ address: string, key: string }} */
function loadConfig() {
  const file = join(here, 'hardware-env.json');
  /** @type {any} */
  let fromFile = {};
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8'));
  }

  const address = String(process.env.HOMEY_ADDRESS ?? fromFile.address ?? '').replace(/\/$/, '');
  const key = String(process.env.HOMEY_API_KEY ?? fromFile.key ?? '');

  if (!address || !key) {
    throw new Error(
      'No Homey address or API key. Set HOMEY_ADDRESS and HOMEY_API_KEY, or write '
      + 'scripts/hardware-env.json as { "address": "http://192.168.1.23", "key": "..." }.',
    );
  }
  return { address, key };
}

// --------------------------------------------------------------- connection

/**
 * The same client the app builds for Flow writes: createLocalAPI with the
 * Personal API Key (platform §1). Managers connect individually — a top-level
 * connect does not cover them — and a manager that will not connect is degraded
 * rather than fatal, exactly as in HomeyApiService.read().
 *
 * @param {{ address: string, key: string }} config
 * @returns {Promise<any>}
 */
async function connect(config) {
  const api = await HomeyAPI.createLocalAPI({ address: config.address, token: config.key });
  for (const name of ['devices', 'zones', 'flow', 'flowtoken', 'apps']) {
    const manager = api[name];
    if (manager && typeof manager.connect === 'function') {
      try {
        await manager.connect();
      } catch (error) {
        note(`manager "${name}" would not connect: ${messageOf(error)}`);
      }
    }
  }
  return api;
}

/**
 * The app's own Web API, over the same key. Every endpoint in `.homeycompose/`
 * is session-authenticated rather than `public: true`, so whether a Personal API
 * Key may call them at all is the question `spike` exists to answer.
 *
 * @param {any} api
 */
async function appApi(api) {
  const app = await api.apps.getApp({ id: APP_ID });
  return {
    /** @param {string} path @returns {Promise<any>} */
    get: (path) => app.get({ path }),
    /** @param {string} path @param {any} body @returns {Promise<any>} */
    post: (path, body) => app.post({ path, body }),
    /** @param {string} path @returns {Promise<any>} */
    del: (path) => app.delete({ path }),
  };
}

// ------------------------------------------------------------------ helpers

/** @param {unknown} error */
function messageOf(error) {
  return String(/** @type {any} */ (error)?.message ?? error);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll until `check` returns something truthy, or give up.
 *
 * @template T
 * @param {() => Promise<T | null>} check
 * @param {{ timeoutMs: number, everyMs: number, what: string }} opts
 * @returns {Promise<T | null>}
 */
async function waitFor(check, opts) {
  const deadline = Date.now() + opts.timeoutMs;
  note(`waiting up to ${Math.round(opts.timeoutMs / 1000)}s for ${opts.what}...`);
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(opts.everyMs);
  }
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Every Lightkeeper device on the Homey, by driver.
 *
 * `dataId` is the id in `data`, not the Homey device id: that is the id a Flow's
 * bridge arguments carry, and the only thing that makes a Flow attributable —
 * see findManagedFlows in lib/bridge/flow-bridge-manager.ts.
 *
 * @param {any} api
 */
async function lightkeeperDevices(api) {
  const devices = Object.values(/** @type {any} */ (await api.devices.getDevices()));
  /** @type {Array<{ homeyId: string, dataId: string, name: string, driver: string, available: boolean }>} */
  const found = [];
  for (const device of /** @type {any[]} */ (devices)) {
    const driverId = String(device?.driverId ?? '');
    if (!driverId.includes(APP_ID)) continue;
    found.push({
      homeyId: String(device.id),
      dataId: String(device?.data?.id ?? ''),
      name: String(device?.name ?? ''),
      driver: driverId.split(':').pop() ?? '',
      available: device?.available !== false,
    });
  }
  return found;
}

/**
 * Every Flow that calls one of our bridge cards, with the device id it is
 * attributed to.
 *
 * Card ids are matched the way `bridgeCards()` matches them — app id plus short
 * id, with an endsWith fallback — rather than constructed, because a card URI
 * may never be built by hand (platform §3). Reading is a safer case than
 * writing, but there is no reason to keep two spellings of one rule.
 *
 * @param {any} api
 */
async function managedFlows(api) {
  /** @param {string} id */
  const isOurs = (id) => BRIDGE_CARDS.some(short => id.endsWith(`:${short}`)) && id.includes(APP_ID);

  const flows = Object.values(/** @type {any} */ (await api.flow.getFlows()));
  const folders = Object.values(/** @type {any} */ (await api.flow.getFlowFolders()));

  /** @type {Map<string, string>} */
  const folderNames = new Map();
  for (const folder of /** @type {any[]} */ (folders)) {
    folderNames.set(String(folder.id), String(folder?.name ?? ''));
  }

  /** @type {Array<{ flowId: string, name: string, ownerDataId: string, folderName: string | null, enabled: boolean }>} */
  const found = [];
  for (const flow of /** @type {any[]} */ (flows)) {
    for (const action of /** @type {any[]} */ (flow?.actions ?? [])) {
      if (!isOurs(String(action?.id ?? ''))) continue;
      const folderId = flow?.folder ? String(flow.folder) : null;
      found.push({
        flowId: String(flow.id),
        name: String(flow?.name ?? ''),
        ownerDataId: String(action?.args?.controller ?? ''),
        folderName: folderId ? (folderNames.get(folderId) ?? null) : null,
        enabled: flow?.enabled !== false,
      });
      break;
    }
  }
  return found;
}

/**
 * One lamp's current value for a capability, read fresh.
 *
 * Deliberately re-fetched rather than read off a cached device object: the whole
 * point of the rejoin checks is what the lamp holds AFTER the app wrote to it.
 *
 * @param {any} api
 * @param {string} deviceId
 * @param {string} capability
 * @returns {Promise<number | boolean | string | null>}
 */
async function capabilityValue(api, deviceId, capability) {
  const device = await api.devices.getDevice({ id: deviceId });
  const value = device?.capabilitiesObj?.[capability]?.value;
  return value === undefined ? null : value;
}

// -------------------------------------------------------------------- spike

/**
 * Can the rest of this script run? Three questions, in the order they gate each
 * other: does the key reach the Homey, does it reach the app's own Web API, and
 * is what comes back the shape the checks below expect.
 *
 * @param {any} api
 */
async function commandSpike(api) {
  note(`Homey software version ${api.softwareVersion ?? '(not reported)'}`);

  const devices = await lightkeeperDevices(api);
  report('-', 'INFO', `${devices.length} Lightkeeper device(s): `
    + (devices.map(d => `${d.driver}/${d.name}`).join(', ') || 'none'));

  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('-', 'FAILED', `could not reach the app over the API: ${messageOf(error)}`);
    return;
  }

  /** @type {any} */
  let status;
  try {
    status = await app.get('/');
  } catch (error) {
    report('-', 'FAILED',
      `GET /api/app/${APP_ID}/ was refused: ${messageOf(error)}. `
      + 'The app Web API is out of reach with this key, so `credential` and `redaction` '
      + 'cannot run, and `rejoin` cannot ask the app what it wrote. `flows` still can.');
    return;
  }

  report('-', 'OK', 'the app Web API answers with this key — every command below can run');
  report('-', 'INFO', `credential: present=${status?.credential?.present} valid=${status?.credential?.valid}`);
  report('-', 'INFO', `${status?.controllers?.length ?? 0} controller(s), `
    + `${status?.schedules?.length ?? 0} schedule(s), `
    + `${status?.circadian?.length ?? 0} circadian/curve light(s) running`);

  try {
    /** @type {any} */
    const diagnostics = await app.get('/diagnostics');
    const curves = /** @type {any[]} */ (diagnostics?.circadian ?? []);
    const onTargets = curves.reduce(
      (sum, c) => sum + /** @type {any[]} */ (c?.targets ?? []).filter(t => t?.on === true).length, 0);
    report('-', 'OK', `GET /diagnostics answers; ${curves.length} curve runtime(s), `
      + `${onTargets} lamp(s) currently on — the rejoin checks need at least one`);
    if (!curves.every(c => Array.isArray(c?.recentWrites))) {
      report('-', 'FAILED', 'a curve runtime reported no recentWrites array; '
        + 'the rejoin checks read that to see what the app wrote');
    }
  } catch (error) {
    report('-', 'FAILED', `GET /diagnostics was refused: ${messageOf(error)}`);
  }
}

// -------------------------------------------------------------------- flows

/**
 * Lines 1.3, 2.9, 3.5, 4.6 and 5.9 — which Flows exist and who owns them.
 * Read-only, so this is the one safe to run on any Homey at any time.
 *
 * @param {any} api
 */
async function commandFlows(api) {
  const devices = await lightkeeperDevices(api);
  const flows = await managedFlows(api);

  report('1.3', 'INFO', `${flows.length} generated Flow(s) in total`);

  /** @type {Map<string, typeof flows>} */
  const byOwner = new Map();
  for (const flow of flows) {
    const list = byOwner.get(flow.ownerDataId) ?? [];
    list.push(flow);
    byOwner.set(flow.ownerDataId, list);
  }

  for (const driver of FLOW_OWNING_DRIVERS) {
    const line = driver === 'controller' ? '2.9' : '3.5';
    const owned = devices.filter(d => d.driver === driver);
    if (owned.length === 0) {
      report(line, 'SKIPPED', `no ${driver} device paired`);
      continue;
    }
    for (const device of owned) {
      const mine = byOwner.get(device.dataId) ?? [];
      const folders = [...new Set(mine.map(f => f.folderName ?? '(no folder)'))];
      // The folder is presentation only and the user may move a Flow anywhere,
      // so where a Flow is filed is reported and never treated as a failure —
      // see the two rules at the top of lib/bridge/flow-folder-manager.ts.
      report(line, mine.length > 0 ? 'OK' : 'FAILED',
        `${driver} "${device.name}": ${mine.length} Flow(s), `
        + `folder(s) ${folders.join(', ') || 'none'}`);
      const disabled = mine.filter(f => !f.enabled).length;
      if (disabled > 0) {
        report(line, 'FAILED', `${disabled} of them are switched off — a disabled Flow `
          + 'also reads as user-edited, so the device will be marked for repair');
      }
    }
  }

  // 4.6 and 5.9: the whole design of these two device types is that they write
  // to lights directly and generate nothing (platform §12). A Flow attributed to
  // one of them is not cosmetic — it means something built a bridge that should
  // not exist.
  for (const driver of FLOWLESS_DRIVERS) {
    const line = driver === 'circadian' ? '4.6' : '5.9';
    const owned = devices.filter(d => d.driver === driver);
    if (owned.length === 0) {
      report(line, 'SKIPPED', `no ${driver} device paired`);
      continue;
    }
    const offenders = owned.filter(d => (byOwner.get(d.dataId) ?? []).length > 0);
    if (offenders.length === 0) {
      report(line, 'OK', `${owned.length} ${driver} light(s), no Flow attributed to any of them`);
      continue;
    }
    for (const device of offenders) {
      const mine = byOwner.get(device.dataId) ?? [];
      report(line, 'FAILED', `${driver} "${device.name}" owns ${mine.length} Flow(s): `
        + mine.map(f => f.name).join(', '));
    }
  }

  // Not a numbered line, but the same read answers it: a Flow whose owner is not
  // a device on this Homey is exactly what the orphan sweep is for.
  const liveIds = new Set(devices.map(d => d.dataId));
  const orphaned = flows.filter(f => !liveIds.has(f.ownerDataId));
  if (orphaned.length > 0) {
    report('-', 'INFO', `${orphaned.length} Flow(s) attributed to a device that is not `
      + 'installed — app settings offers to sweep these');
  }

  const unavailable = devices.filter(d => !d.available);
  if (unavailable.length > 0) {
    report('-', 'INFO', `unavailable device(s): ${unavailable.map(d => d.name).join(', ')}`);
  }
}

// ---------------------------------------------------------------- redaction

/**
 * Line 8.5 — the key must not be in the diagnostics report. Done by machine
 * because "search it for your API key" by eye is exactly the check a tired
 * person waves through, and the cost of missing it is a key in a bug report.
 *
 * 8.2, 8.3 and 8.4 come off the same two reads, so they are here too.
 *
 * @param {any} api
 * @param {string} key
 */
async function commandRedaction(api, key) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('8.5', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @type {any} */
  let diagnostics;
  try {
    diagnostics = await app.get('/diagnostics');
  } catch (error) {
    report('8.5', 'SKIPPED', `GET /diagnostics was refused: ${messageOf(error)}`);
    return;
  }

  const serialised = JSON.stringify(diagnostics);

  // The whole key AND a distinctive slice, because a report could carry a
  // truncated echo — the plan asks for "a distinctive dozen characters" for
  // exactly that reason.
  const slice = key.length >= 16 ? key.slice(4, 16) : key;
  const hits = [];
  if (serialised.includes(key)) hits.push('the whole key');
  if (slice && serialised.includes(slice)) hits.push('a 12-character slice of it');

  if (hits.length === 0) {
    report('8.5', 'OK', `${serialised.length} characters of diagnostics, no key material in it`);
  } else {
    report('8.5', 'FAILED', `the diagnostics report contains ${hits.join(' and ')}`);
  }

  /** @type {any} */
  const status = await app.get('/').catch(() => null);
  if (!status) return;

  report('8.2', (status.recentEvents?.length ?? 0) > 0 ? 'OK' : 'INFO',
    `${status.recentEvents?.length ?? 0} recent remote press(es) recorded`);
  report('8.3', (status.recentWrites?.length ?? 0) > 0 ? 'OK' : 'INFO',
    `${status.recentWrites?.length ?? 0} recent write(s) to lights recorded`);

  for (const schedule of /** @type {any[]} */ (status.schedules ?? [])) {
    // A schedule refuses to fire on a clock it does not trust, so an unresolved
    // timezone is a failure here rather than a note: the device looks well and
    // never fires.
    report('8.4', schedule.timezoneResolved ? 'OK' : 'FAILED',
      `schedule "${schedule.name}": ${schedule.entries?.length ?? 0} window(s), `
      + `clock ${schedule.localTime} ${schedule.timezone}`
      + (schedule.timezoneResolved ? '' : ' — TIMEZONE UNRESOLVED, it will refuse to fire'));
  }
}

// --------------------------------------------------------------- credential

/**
 * §7 without the button presses: 7.1, 7.2, 7.4, 7.6 and 7.7.
 *
 * Destructive in the recoverable sense — it removes the stored key and puts it
 * back — so it needs `--yes`, and it needs the key it is given to be the real
 * one, because that is what it restores at the end.
 *
 * @param {any} api
 * @param {string} key
 */
async function commandCredential(api, key) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('7.1', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @returns {Promise<any>} */
  const status = () => app.get('/');

  /** @param {any} s */
  const flowOwners = (s) => [
    .../** @type {any[]} */ (s?.controllers ?? []),
    .../** @type {any[]} */ (s?.schedules ?? []),
  ];

  /** @param {any} s */
  const curveStates = (s) => /** @type {any[]} */ (s?.circadian ?? [])
    .map(c => `${c.name}=${c.state}`).join(', ');

  const before = await status();
  if (!before?.credential?.present || !before?.credential?.valid) {
    report('7.1', 'FAILED', `no working key is saved (present=${before?.credential?.present} `
      + `valid=${before?.credential?.valid}) — paste one in first, this command restores `
      + 'the key it is given and cannot invent one');
    return;
  }
  report('7.1', 'OK', 'a working API key is saved');

  const flowsBefore = await managedFlows(api);
  const ownersBefore = flowOwners(before).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`);
  note(`Flow-owning devices before: ${ownersBefore.join(', ') || 'none'}`);

  // 7.2 — a bad key must not unseat the working one. This is the regression that
  // made every device unavailable on a typo.
  /** @type {any} */
  const refusal = await app.post('/credential', { token: 'not-a-key' });
  const afterBad = await status();
  const stillValid = afterBad?.credential?.valid === true;
  const stillWorking = flowOwners(afterBad).every(o => o.state !== 'needs_credential');
  report('7.2', refusal?.valid === false && stillValid && stillWorking ? 'OK' : 'FAILED',
    `nonsense refused (valid=${refusal?.valid} failure=${refusal?.failure ?? 'none'}), `
    + `stored key still valid=${stillValid}, `
    + `no device pushed to needs_credential=${stillWorking}`);

  // 7.4 — removing the key must degrade the devices and delete nothing.
  await app.del('/credential');
  const degraded = await waitFor(async () => {
    const s = await status();
    const owners = flowOwners(s);
    return owners.length > 0 && owners.every(o => o.state === 'needs_credential') ? s : null;
  }, { timeoutMs: 60_000, everyMs: 3_000, what: 'the Flow-owning devices to report needs_credential' });

  if (degraded) {
    report('7.4', 'OK', 'controller and schedule went to needs_credential after the key was removed');
  } else {
    const s = await status();
    report('7.4', 'FAILED', 'they did not all reach needs_credential within 60s: '
      + flowOwners(s).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`).join(', '));
  }

  const flowsAfterRemoval = await managedFlows(api);
  report('7.4', flowsAfterRemoval.length === flowsBefore.length ? 'OK' : 'FAILED',
    `${flowsAfterRemoval.length} generated Flow(s) after removal, was ${flowsBefore.length} — `
    + 'losing the key must not delete anything');

  // 7.7 — neither light-driving device type holds a key or has a
  // needs_credential state at all (platform §12), so nothing here may touch them.
  const midway = await status();
  const curvesTouched = /** @type {any[]} */ (midway?.circadian ?? [])
    .filter(c => c.state === 'needs_credential');
  report('7.7', curvesTouched.length === 0 ? 'OK' : 'FAILED',
    curvesTouched.length === 0
      ? `circadian and Curve lights untouched with no key stored: ${curveStates(midway) || 'none paired'}`
      : `${curvesTouched.length} of them reported needs_credential, which they have no state for`);

  // 7.6 — and back, without a restart.
  /** @type {any} */
  const restored = await app.post('/credential', { token: key });
  if (restored?.valid !== true) {
    report('7.6', 'FAILED', `the real key was refused on the way back in: `
      + `failure=${restored?.failure ?? 'none'}. The devices are still without a key — `
      + 'paste it in from app settings.');
    return;
  }

  const recovered = await waitFor(async () => {
    const s = await status();
    const owners = flowOwners(s);
    return owners.length > 0 && owners.every(o => o.state !== 'needs_credential') ? s : null;
  }, { timeoutMs: 90_000, everyMs: 3_000, what: 'the devices to return to ready without a restart' });

  if (recovered) {
    report('7.6', 'OK', 'controller and schedule left needs_credential without an app restart: '
      + flowOwners(recovered).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`).join(', '));
  } else {
    const s = await status();
    report('7.6', 'FAILED', 'they were still without a key 90s after the key went back in: '
      + flowOwners(s).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`).join(', ')
      + ' — recoverFromCredentialFailure is what should have cleared this');
  }

  const flowsAtEnd = await managedFlows(api);
  report('-', flowsAtEnd.length === flowsBefore.length ? 'INFO' : 'FAILED',
    `${flowsAtEnd.length} generated Flow(s) at the end, was ${flowsBefore.length}`);
}

// ------------------------------------------------------------------- rejoin

/**
 * 4.7, 5.8 and 4.8 — the two checks that are the real prize, because they are
 * genuine behaviour that the unit suite cannot reach and that a person otherwise
 * verifies by standing in a room watching a lamp.
 *
 * It does NOT re-derive what the curve should be. It asks the app what it wrote
 * (`recentWrites`, which carries the capability and the exact value) and checks
 * the lamp is holding that. Re-deriving would re-implement the engine, and a
 * check that mirrors the implementation proves nothing.
 *
 * Writes to your lamps: one is switched off and on, and then handed a value by
 * hand to test the override. Needs `--yes`.
 *
 * @param {any} api
 */
async function commandRejoin(api) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('4.7', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @returns {Promise<any[]>} */
  const curves = async () => {
    /** @type {any} */
    const diagnostics = await app.get('/diagnostics');
    return /** @type {any[]} */ (diagnostics?.circadian ?? []);
  };

  const all = await curves();
  if (all.length === 0) {
    report('4.7', 'SKIPPED', 'no circadian or Curve light is running');
    return;
  }

  for (const runtime of all) {
    const kind = String(runtime?.kind ?? 'circadian');
    // 5.8 is the Curve light's line and 4.7 the circadian one; the check is the
    // same, so `kind` decides which number it reports against.
    const rejoinLine = kind === 'curve' ? '5.8' : '4.7';
    const label = `${kind} "${runtime?.name ?? runtime?.id}"`;

    if (runtime?.enabled === false) {
      report(rejoinLine, 'SKIPPED', `${label} is switched off`);
      continue;
    }

    const targets = /** @type {any[]} */ (runtime?.targets ?? []);
    const candidate = targets.find(t => t?.on === true && t?.canWarm === true);
    if (!candidate) {
      report(rejoinLine, 'SKIPPED', `${label}: no target lamp is both on and able to change `
        + 'warmth right now — switch one on and run this again');
      continue;
    }

    const lampId = String(candidate.id);
    const lampName = /** @type {string} */ (
      runtime.targetNames?.[runtime.targetIds?.indexOf?.(lampId)] ?? lampId);
    note(`${label}: testing against lamp "${lampName}"`);

    await rejoinAfterPowerCycle(api, app, runtime.id, lampId, lampName, label, rejoinLine);
    // 4.8 is written once, for the circadian light, but the behaviour belongs to
    // the shared engine — so it runs for a Curve light too and reports against
    // the same number.
    await handOverAndRejoin(api, app, runtime.id, lampId, lampName, label);
  }
}

/**
 * The lamp goes off and on, and the app must write to it again.
 *
 * @param {any} api
 * @param {any} app
 * @param {string} runtimeId
 * @param {string} lampId
 * @param {string} lampName
 * @param {string} label
 * @param {string} line
 */
async function rejoinAfterPowerCycle(api, app, runtimeId, lampId, lampName, label, line) {
  const lamp = await api.devices.getDevice({ id: lampId });

  await lamp.setCapabilityValue({ capabilityId: 'onoff', value: false });
  await sleep(4_000);
  const switchedOnAt = Date.now();
  await lamp.setCapabilityValue({ capabilityId: 'onoff', value: true });

  const write = await waitFor(
    () => writeAfter(app, runtimeId, lampId, switchedOnAt),
    { timeoutMs: 120_000, everyMs: 5_000, what: `${label} to write to "${lampName}" after it came on` });

  if (!write) {
    report(line, 'FAILED', `${label}: nothing was written to "${lampName}" in the 120s after `
      + 'it was switched back on — it did not rejoin');
    return;
  }

  const held = await capabilityValue(api, lampId, String(write.capability));
  const wanted = Number(write.value);
  const actual = Number(held);
  const matches = Number.isFinite(wanted) && Number.isFinite(actual)
    ? Math.abs(wanted - actual) <= 0.02
    : held === write.value;

  report(line, matches ? 'OK' : 'FAILED',
    `${label}: "${lampName}" came back on and was written `
    + `${write.capability}=${round(write.value)}; the lamp now holds ${round(held)}`
    + (matches ? '' : ' — it did not take'));
}

/**
 * A value written by hand must be left alone, and a power cycle must end the
 * override.
 *
 * @param {any} api
 * @param {any} app
 * @param {string} runtimeId
 * @param {string} lampId
 * @param {string} lampName
 * @param {string} label
 */
async function handOverAndRejoin(api, app, runtimeId, lampId, lampName, label) {
  const lamp = await api.devices.getDevice({ id: lampId });
  const current = Number(await capabilityValue(api, lampId, 'light_temperature'));
  if (!Number.isFinite(current)) {
    report('4.8', 'SKIPPED', `${label}: "${lampName}" reports no light_temperature to take over`);
    return;
  }

  // Far enough from where the curve has it that the app cannot mistake our value
  // for its own, and clamped so it stays inside the capability's range.
  const byHand = current > 0.5 ? clamp(current - 0.35, 0, 1) : clamp(current + 0.35, 0, 1);
  await lamp.setCapabilityValue({ capabilityId: 'light_temperature', value: byHand });
  note(`${label}: set "${lampName}" to light_temperature=${round(byHand)} by hand`);

  // The curve ticks once a minute, so the app needs a tick to notice and another
  // to prove it is leaving the lamp alone.
  const overridden = await waitFor(async () => {
    const target = await targetOf(app, runtimeId, lampId);
    return target?.overridden === true ? target : null;
  }, { timeoutMs: 150_000, everyMs: 10_000, what: `${label} to notice the lamp was taken over` });

  if (!overridden) {
    report('4.8', 'FAILED', `${label}: "${lampName}" was not marked overridden within 150s — `
      + 'the app may be about to write over a value somebody set by hand');
  } else {
    const stillOurs = Number(await capabilityValue(api, lampId, 'light_temperature'));
    const left = Math.abs(stillOurs - byHand) <= 0.02;
    report('4.8', left ? 'OK' : 'FAILED',
      `${label}: "${lampName}" marked overridden and still holds ${round(stillOurs)} `
      + `(set by hand to ${round(byHand)})`
      + (left ? '' : ' — the app wrote over it'));
  }

  // And it must rejoin, or we have left the user's lamp permanently out of the
  // curve. This runs whether the check above passed or failed, for the same
  // reason: the lamp goes back under the app's control either way.
  await sleep(2_000);
  await lamp.setCapabilityValue({ capabilityId: 'onoff', value: false });
  await sleep(4_000);
  const switchedOnAt = Date.now();
  await lamp.setCapabilityValue({ capabilityId: 'onoff', value: true });

  const write = await waitFor(
    () => writeAfter(app, runtimeId, lampId, switchedOnAt),
    { timeoutMs: 120_000, everyMs: 5_000, what: `${label} to take "${lampName}" back` });

  if (!write) {
    report('4.8', 'FAILED', `${label}: "${lampName}" did not rejoin after being switched off `
      + 'and on — it is left overridden, and holding a value this script set. '
      + 'Switch it off and on again by hand.');
    return;
  }

  const target = await targetOf(app, runtimeId, lampId);
  report('4.8', target?.overridden === false ? 'OK' : 'FAILED',
    `${label}: "${lampName}" rejoined after a power cycle `
    + `(written ${write.capability}=${round(write.value)}, overridden=${target?.overridden})`);
}

/**
 * The most recent successful write to this lamp after `since`, or null.
 *
 * `recentWrites` is per runtime and carries the capability and the exact value,
 * which is what makes this a check of the app's behaviour rather than a
 * re-implementation of its maths.
 *
 * @param {any} app
 * @param {string} runtimeId
 * @param {string} lampId
 * @param {number} since
 * @returns {Promise<{ capability: string, value: unknown, at: number } | null>}
 */
async function writeAfter(app, runtimeId, lampId, since) {
  /** @type {any} */
  const diagnostics = await app.get('/diagnostics');
  const runtime = /** @type {any[]} */ (diagnostics?.circadian ?? [])
    .find(c => String(c?.id) === runtimeId);
  const writes = /** @type {any[]} */ (runtime?.recentWrites ?? [])
    .filter(w => String(w?.deviceId) === lampId && Number(w?.at) >= since && w?.ok !== false)
    // Warmth or colour, never the on/off we did ourselves.
    .filter(w => String(w?.capability) !== 'onoff')
    .sort((a, b) => Number(b.at) - Number(a.at));
  const latest = writes[0];
  return latest
    ? { capability: String(latest.capability), value: latest.value, at: Number(latest.at) }
    : null;
}

/**
 * One runtime's view of one target lamp.
 *
 * @param {any} app
 * @param {string} runtimeId
 * @param {string} lampId
 * @returns {Promise<any>}
 */
async function targetOf(app, runtimeId, lampId) {
  /** @type {any} */
  const diagnostics = await app.get('/diagnostics');
  const runtime = /** @type {any[]} */ (diagnostics?.circadian ?? [])
    .find(c => String(c?.id) === runtimeId);
  return /** @type {any[]} */ (runtime?.targets ?? []).find(t => String(t?.id) === lampId) ?? null;
}

/** @param {unknown} value */
function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : String(value);
}

// --------------------------------------------------------------------- main

const READ_ONLY = ['spike', 'flows', 'redaction'];
const DESTRUCTIVE = ['credential', 'rejoin'];

async function main() {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes('--yes');
  let commands = argv.filter(a => !a.startsWith('--'));

  if (commands.length === 0) commands = ['spike'];
  if (commands.includes('all')) commands = [...READ_ONLY];

  const unknown = commands.filter(c => ![...READ_ONLY, ...DESTRUCTIVE].includes(c));
  if (unknown.length > 0) {
    console.error(`Unknown command(s): ${unknown.join(', ')}`);
    console.error(`Known: ${[...READ_ONLY, ...DESTRUCTIVE].join(', ')}, all`);
    process.exitCode = 2;
    return;
  }

  const needsConfirmation = commands.filter(c => DESTRUCTIVE.includes(c));
  if (needsConfirmation.length > 0 && !confirmed) {
    // Say what each one actually does rather than listing both effects
    // whichever was asked for: "a lamp is switched off and on" is not a
    // warning somebody should have to discard as inapplicable.
    const effects = needsConfirmation.map(c => c === 'credential'
      ? 'credential removes the stored API key and puts it back'
      : 'rejoin switches one of your lamps off and on, and sets a colour on it by hand');
    console.error(`This changes your Homey: ${effects.join('; ')}. Re-run with --yes.`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  console.log(`Lightkeeper hardware verification against ${config.address}`);
  console.log(`Commands: ${commands.join(', ')}\n`);

  const api = await connect(config);

  for (const command of commands) {
    console.log(`--- ${command}`);
    if (command === 'spike') await commandSpike(api);
    if (command === 'flows') await commandFlows(api);
    if (command === 'redaction') await commandRedaction(api, config.key);
    if (command === 'credential') await commandCredential(api, config.key);
    if (command === 'rejoin') await commandRejoin(api);
    console.log('');
  }

  const failed = results.filter(r => r.status === 'FAILED');
  const passed = results.filter(r => r.status === 'OK');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  console.log(`${passed.length} OK, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const failure of failed) console.log(`  ${failure.line} ${failure.detail}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  // The message may have been near the key, so it is printed rather than the
  // whole error: a stack from homey-api can quote the request back, and this
  // script's own rule is the app's — the key is never printed.
  console.error(`\nverify-hardware failed: ${messageOf(error)}`);
  process.exitCode = 1;
});
