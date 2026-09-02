/**
 * The parts of `docs/hardware-test-plan.md` a script can answer.
 *
 * Run from a laptop against a real Homey, over the same `createLocalAPI` client
 * the app itself uses for Flow writes (platform §1). It does NOT install the
 * app, so the pass's "starts from nothing" premise still begins by hand.
 *
 * WHAT IT COVERS, by test-plan line:
 *
 *   spike       — nothing; it answers whether the rest can run at all
 *   memory      — T59, T60                         read-only
 *   flows       — T2, T8, T16, T23, T30            read-only
 *   redaction   — T42-T45                          read-only
 *   credential  — T35-T41                          writes the key, needs --yes
 *   rejoin      — T24, T25, T29                    writes to your lamps, needs --yes
 *   restart     — T1, T4, T31, T32, T34            restarts the app, needs --yes
 *   bridge      — T33                              runs a generated Flow, needs --yes
 *   schedule    — T13, T14, T15, T17, T18          retimes and fires a schedule,
 *                                                  restores it after. Needs --yes
 *   preview     — T21, T22, T27, T28               writes the curve to your lamps,
 *                                                  needs --yes
 *   teardown    — T47-T52                          DELETES the devices this pass
 *                                                  built. Needs --yes
 *   pair        — T5, T6, T7, T12, T13, T19, T20, T26
 *                                                  BUILDS one of each device
 *                                                  type over the API, its own
 *                                                  even if you have some already.
 *                                                  Needs --yes
 *   repair      — T46                              opens a repair session per
 *                                                  device, saves nothing. Needs --yes
 *   pairspike   — nothing; the one-off probe that proved pairing over the API
 *                 works at all (platform §14). Needs --yes
 *
 *   all         — the four read-only commands
 *   full        — the whole pass, in the plan's own order, ending in teardown
 *
 * IT ONLY EVER TOUCHES ITS OWN DEVICES. Every device this pass builds is named
 * with a marker — see `MARKER` below, and the comment there for why the name and
 * not a file on the laptop. Every command selects from the marked ones, and
 * `teardown` deletes only those, re-checking the mark against the Homey
 * immediately before each permanent delete. A controller, schedule, circadian or
 * Curve light that YOU paired is never chosen, never written to and never
 * deleted, so a `full` run can be done on the Homey you actually live with.
 *
 * WHAT IT STILL DOES TO YOUR HOMEY, because these cannot be scoped to a device:
 *
 * - `credential` removes the app's stored API key and puts it back, and there is
 *   one key for the whole app. EVERY Flow-owning device on the Homey — yours
 *   included — goes to `needs_credential` for up to a minute or so and then
 *   recovers. Nothing is deleted; T38 asserts that, by Flow id. If the put-back
 *   fails, the report says so and you paste a key in from app settings.
 * - `restart` restarts the whole app. There is no per-device restart, so every
 *   Lightkeeper device is briefly unavailable. That is also why T32 keeps
 *   looking at all of them rather than only at ours.
 * - The LAMPS are shared. `pickLights()` picks from your real lights; there are
 *   no others. `preview`, `rejoin` and `schedule` write colour, switch lamps off
 *   and on, and set values by hand — on lamps your own devices may also drive.
 *   `HOMEY_TEST_ROOM` is the containment, and worth setting.
 * - During a run there are TWO devices of each type, probably on the same
 *   remote. Nothing here presses a remote, so this only shows if you do.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER:
 *
 * - Anything needing a finger on a remote — T9-T11. `bridge` runs a generated
 *   Flow's own action card, which proves dispatch, mapping and the write path;
 *   it bypasses the real release event, and "the release event was dropped" is
 *   the entire reason the ramp hard-stops at 10 seconds. The same technique IS
 *   honest for T33, T37 and T39, where the question is only whether the Flow
 *   path is still live.
 * - Anything needing eyes on a screen. Those are covered off-hardware instead:
 *   the pairing screens' own rules by `test/unit/pair-view-behaviour.test.ts`,
 *   the settings page by `test/unit/settings-page.test.ts`, the four device
 *   pictures by `test/unit/assets.test.ts`, and how it all LOOKS by
 *   `npm run render:views`.
 * - Re-deriving what the curve SHOULD be at this moment. That would re-implement
 *   the engine the unit suite already covers, and a test that mirrors the
 *   implementation proves nothing. Instead this asks the app what it wrote
 *   (`recentWrites`) and checks the lamp is holding that.
 *
 * CONFIGURATION. Either environment variables:
 *
 *   HOMEY_ADDRESS=http://192.168.1.23
 *   HOMEY_API_KEY=<this script's own key>
 *   HOMEY_APP_KEY=<the key the app holds>     # only `credential` needs it
 *
 * or `scripts/hardware-env.json` —
 * `{ "address": "...", "key": "...", "appKey": "..." }` — which is gitignored,
 * because a Personal API Key is a credential and this repo's rule is that
 * nothing from a real Homey gets committed (see test/fixtures/README.md).
 *
 * TWO KEYS, and they must be different for `credential`. A key holds a single
 * live session and concurrent holders evict one another (platform §2), which is
 * why CONTRIBUTING.md forbids sharing one between the app and an external
 * script. `credential` is where that goes from likely to certain: it removes the
 * app's key and pastes it back, over a connection authenticated with the key it
 * is removing. `requireTwoKeys()` refuses rather than half-finishing.
 *
 * The script's key needs FULL access: it reads devices and zones, reads and
 * writes Flows, triggers one, and calls the app's own Web API. A key's
 * permissions cannot be widened after it is created.
 *
 * No key is ever printed. `redaction` searches for both on purpose and reports
 * only whether either was found.
 *
 * USAGE
 *
 *   node scripts/verify-hardware.mjs spike
 *   node scripts/verify-hardware.mjs flows redaction
 *   node scripts/verify-hardware.mjs rejoin --yes
 *   node scripts/verify-hardware.mjs pairspike --yes
 *   node scripts/verify-hardware.mjs all              # every read-only command
 *
 * Output is one line per test-plan line, in the plan's own `Tn OK` form, so it
 * pastes straight into a report. Exit code is 1 if anything FAILED.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
 * One line of the report. `line` is a test-plan number — `T24` — or `-` for
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

// ------------------------------------------------------------------ asking

/**
 * Read one line from the terminal, echoing it only when it is not a secret.
 *
 * Raw mode, deliberately, and NOT readline: an earlier version muted
 * readline's echo through its private `_writeToOutput`, passed a piped test,
 * and printed a live API key in full on a real Windows terminal. Nothing is
 * written here unless this code writes it, and for a secret it never does.
 * Where raw mode is unavailable a secret prompt REFUSES rather than falling
 * back to visible input.
 *
 * @param {string} question
 * @param {boolean} secret
 * @returns {Promise<string>}
 */
const askTerminal = (question, secret) => new Promise((resolve, reject) => {
  const { stdin, stdout } = process;

  if (secret && typeof stdin.setRawMode !== 'function') {
    reject(new Error(
      'This terminal cannot hide typed input, and a key must never be echoed. '
      + 'Set HOMEY_APP_KEY in the environment instead, or add "appKey" to '
      + 'scripts/hardware-env.json by hand.',
    ));
    return;
  }

  stdout.write(question);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let value = '';

  const restore = () => {
    stdin.removeListener('data', onData);
    stdin.setRawMode?.(false);
    stdin.pause();
  };

  const finish = () => {
    restore();
    stdout.write('\n');
    resolve(value.trim());
  };

  /** @param {string} chunk */
  function onData(chunk) {
    for (const character of chunk) {
      // Enter, on either line ending.
      if (character === '\r' || character === '\n') return finish();

      // Ctrl-C: put the terminal back as it was found, then go.
      if (character === '\u0003') {
        restore();
        stdout.write('\n');
        process.exit(130);
      }

      // Backspace and delete.
      if (character === '\u007f' || character === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          if (!secret) stdout.write('\b \b');
        }
        continue;
      }

      // No other control character belongs in a key or an address.
      if (character < ' ') continue;

      value += character;
      // The one place anything typed is echoed, and it is closed to secrets.
      if (!secret) stdout.write(character);
    }
    return undefined;
  }

  stdin.on('data', onData);
});

/**
 * Ask the person to switch a lamp on, and wait.
 *
 * A circadian or Curve light writes colour only to lamps that are already on
 * (platform §12), so with every target off there is genuinely nothing for
 * `preview` or `rejoin` to observe. Skipping was honest but unhelpful: it named
 * no lamp, so the reader had to work out which of 55 lights the device was
 * pointed at before they could act on it.
 *
 * Names the lamps, waits, and re-checks. Says so and moves on where there is
 * nobody to ask — a script blocking on a prompt in an unattended run is worse
 * than a skipped line.
 *
 * @param {string[]} names
 * @param {string} label
 * @returns {Promise<boolean>} whether to look again
 */
async function askForALampOn(names, label) {
  if (!process.stdin.isTTY) return false;

  console.log('');
  console.log(`  ACTION NEEDED — ${label} has no lamp switched on.`);
  console.log(`  Switch ON any one of: ${names.join(', ')}`);
  const answer = await askTerminal('  Then press ENTER, or type s to skip: ', false);
  console.log('');
  return !answer.toLowerCase().startsWith('s');
}

// ------------------------------------------------------------ configuration

const CONFIG_FILE = join(here, 'hardware-env.json');

/**
 * What is on disk and in the environment, without asking anybody anything.
 *
 * @returns {{ address: string, key: string, appKey: string, room: string }}
 */
function readConfig() {
  /** @type {any} */
  let fromFile = {};
  if (existsSync(CONFIG_FILE)) {
    // The BOM is stripped rather than tolerated. On Windows PowerShell 5.1
    // `Set-Content -Encoding utf8` writes UTF-8 WITH a byte-order mark, which is
    // the obvious way to create this file and which JSON.parse rejects with
    // `Unexpected token` naming an invisible character.
    fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''));
  }

  return {
    address: String(process.env.HOMEY_ADDRESS ?? fromFile.address ?? '').replace(/\/$/, ''),
    key: String(process.env.HOMEY_API_KEY ?? fromFile.key ?? ''),
    // NOT defaulted to `key`. The whole point of the second one is that it is a
    // DIFFERENT key, and a default that silently made them equal is what this
    // used to do — which made "is it configured?" unanswerable.
    appKey: String(process.env.HOMEY_APP_KEY ?? fromFile.appKey ?? ''),
    /**
     * Which room the test lamps come from.
     *
     * A pass builds four devices and then switches their lamps on and off,
     * writes colours to them and power-cycles one. Doing that to whichever
     * lights happen to sort first across a whole house is antisocial: on this
     * Homey it reached a bedroom and a child's room. Naming one room keeps the
     * disruption where its owner put it.
     *
     * Empty means the whole house, which is the old behaviour and the right
     * default for a Homey with three lamps on it.
     */
    room: String(process.env.HOMEY_TEST_ROOM ?? fromFile.room ?? ''),
  };
}

/**
 * Ask, rather than refusing and printing instructions.
 *
 * Configuring this by hand meant knowing that two keys exist, which of them the
 * app holds, that they have to differ, and that the file lives in `scripts/` and
 * is gitignored. Four things to get right before the first useful line of
 * output, every one of them a footnote somewhere.
 *
 * Asks only for what the requested commands actually need, only when stdin is a
 * terminal, and offers to save so it is a one-off. A non-interactive run — CI, a
 * pipe — still gets a plain error, because a script blocking on a prompt nobody
 * can see is worse than one that fails.
 *
 * @param {string[]} commands
 * @returns {Promise<{ address: string, key: string, appKey: string, room: string }>}
 */
async function ensureConfig(commands) {
  const config = readConfig();
  const needsAppKey = commands.includes('credential');

  const missing = [];
  if (!config.address) missing.push('address');
  if (!config.key) missing.push('key');
  // A second key that is merely EQUAL to the first is missing, not present.
  if (needsAppKey && (!config.appKey || config.appKey === config.key)) missing.push('appKey');

  if (missing.length === 0) return config;

  if (!process.stdin.isTTY) {
    throw new Error(
      `Missing configuration: ${missing.join(', ')}. Set HOMEY_ADDRESS, HOMEY_API_KEY and `
      + 'HOMEY_APP_KEY, or write scripts/hardware-env.json as '
      + '{ "address": "http://192.168.1.23", "key": "...", "appKey": "..." }. '
      + 'Run this from a terminal and it will ask you instead.',
    );
  }


  try {
    console.log('\nThis needs a few things before it can reach your Homey.');
    console.log(`They go in ${CONFIG_FILE}, which is gitignored — so this is a one-off.\n`);

    if (!config.address) {
      config.address = (await askTerminal('Homey address (e.g. http://192.168.1.23): ', false))
        .replace(/\/$/, '');
    }

    if (!config.key) {
      console.log('\nMake an API key for this script, and paste it below.');
      console.log('');
      console.log('  1. Open my.homey.app -> this Homey -> Settings -> API Keys');
      console.log('  2. New API Key with FULL ACCESS, and create it');
      console.log('  3. Copy it, and paste it here');
      console.log('');
      console.log('Nothing appears as you paste. That is deliberate — a key on screen');
      console.log('ends up in a screenshot.');
      config.key = await askTerminal('  Paste the key: ', true);
    }

    if (needsAppKey && (!config.appKey || config.appKey === config.key)) {
      /**
       * The wording matters more here than it looks.
       *
       * This prompt used to open with WHY a second key is needed — sessions,
       * eviction, a platform reference — and left the reader at a blinking
       * cursor with no idea what to type. Somebody hit it and said so. The
       * instruction goes first now; the reason comes after, for whoever wants
       * it.
       */
      console.log('\nOne more key — or just press ENTER to skip.');
      console.log('');
      console.log('  Press ENTER     run everything except section 7');
      console.log('  Paste a key     also run section 7');
      console.log('');
      console.log('Section 7 checks what happens when the app loses its API key. The');
      console.log('script needs a spare key for that, or it would cut off its own');
      console.log('connection. To make one: my.homey.app -> Settings -> API Keys, paste');
      console.log('it into Homey settings -> Lightkeeper, then paste the same key here.');
      const answer = await askTerminal('  Key, or ENTER to skip: ', true);
      if (answer && answer === config.key) {
        console.log('  That is the same key the script uses, so section 7 will be skipped.');
      } else {
        config.appKey = answer;
      }
    }

    if (!config.address || !config.key) {
      throw new Error('An address and a key for the script are both required.');
    }

    const save = (await askTerminal('\nSave these for next time? [Y/n] ', false)).toLowerCase();
    if (save === '' || save === 'y' || save === 'yes') {
      // 0600: it holds live credentials, in a directory whose other contents are
      // committed and shared.
      writeFileSync(CONFIG_FILE, `${JSON.stringify({
        address: config.address,
        key: config.key,
        ...(config.appKey ? { appKey: config.appKey } : {}),
        ...(config.room ? { room: config.room } : {}),
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      console.log(`Saved to ${CONFIG_FILE}\n`);
    } else {
      console.log('Not saved — it will ask again next time.\n');
    }

    return config;
  } finally {
    /**
     * Whatever happened, hand the terminal back.
     *
     * A throw between `setRawMode(true)` and the listener that clears it would
     * otherwise leave the user's shell in raw mode — no echo, no line editing,
     * Ctrl-C inert — which looks like the terminal itself has broken.
     */
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
}

/**
 * Refuse to run a command that needs BOTH keys while there is only one.
 *
 * A Personal API Key holds a single live session, and two concurrent holders
 * evict one another (platform §2) — which is why CONTRIBUTING.md says never to
 * share a key between the app and an external script. `credential` is the
 * command that makes that collision certain rather than likely: it removes the
 * app's key and pastes it back, over a connection authenticated with the same
 * key it is removing. The symptom is not a clean failure but a run that half
 * works and leaves the app without a key.
 *
 * Every other command is fine on one key, so this is checked per command rather
 * than at startup.
 *
 * @param {{ key: string, appKey: string }} config
 */
function requireTwoKeys(config) {
  if (config.key && config.appKey && config.key !== config.appKey) return;
  throw new Error(
    'This command needs TWO Personal API Keys and has one. Run it from a terminal '
    + 'and it will ask for the second, or set HOMEY_APP_KEY to the key the APP '
    + 'holds — a key holds a single session and concurrent holders evict each '
    + 'other (platform §2), so running this with one key can leave the app with no '
    + 'key at all.',
  );
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
  note(`connecting to ${config.address}...`);
  const api = await HomeyAPI.createLocalAPI({ address: config.address, token: config.key });

  /**
   * Every connect is BOUNDED, and a failure is not fatal.
   *
   * `connect()` opens a realtime socket, and nothing in this script needs one:
   * every check here is request/response over HTTP. Run from a laptop rather
   * than from the Homey, one of these hangs indefinitely instead of refusing —
   * which presented as a script that printed nothing at all and had to be
   * killed. Bounded and best-effort is the honest shape for something we do not
   * need in the first place.
   */
  for (const name of ['devices', 'zones', 'flow', 'apps']) {
    const manager = api[name];
    if (!manager || typeof manager.connect !== 'function') continue;
    try {
      await withTimeout(manager.connect(), 15_000, `connecting manager "${name}"`);
    } catch (error) {
      note(`manager "${name}" did not connect (${messageOf(error)}) — carrying on, `
        + 'the checks below do not need a realtime socket');
    }
  }
  return api;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, what) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close every realtime socket so the process can exit.
 *
 * Without this the script printed its whole report and then hung forever: a
 * connected manager holds an open socket, and node does not exit while one is
 * alive. Deliberately not `process.exit()` — that truncates buffered stdout on
 * Windows, which would eat the last lines of the very report this exists to
 * produce.
 *
 * @param {any} api
 */
function disconnectAll(api) {
  for (const name of ['devices', 'zones', 'flow', 'apps', 'drivers']) {
    const manager = api?.[name];
    try {
      if (manager && typeof manager.destroy === 'function') manager.destroy();
    } catch {
      // A socket that will not close cannot stop us reporting what we found.
    }
  }
  // The managers are not enough on their own. The client holds the socket
  // SESSION and a map of refresh timers above them, and either keeps node alive
  // by itself — destroying only the managers still hung.
  try {
    if (typeof api?.destroy === 'function') api.destroy();
  } catch {
    // As above.
  }
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
  const raw = String(/** @type {any} */ (error)?.message ?? error);

  /**
   * An unknown app route comes back as an Express HTML page, not an error.
   *
   * The whole page ends up as the "reason" on a report line — twelve lines of
   * `<!DOCTYPE html>` where a sentence belongs, repeated once per failure and
   * again in the summary. Worse, it buries the one fact that matters: the route
   * is missing because the Homey is running an OLDER BUILD than the checkout.
   * Every route this script calls ships with the app, so a 404 here is never a
   * typo — it is an install that predates the code.
   */
  const route = /Cannot (GET|POST|PUT|DELETE) (\S+)/.exec(raw);
  if (route && /<!DOCTYPE html>/i.test(raw)) {
    return `the installed app has no ${route[1]} ${route[2]} — the Homey is running an `
      + 'older build than this checkout. Reinstall it: npx homey app install';
  }

  return raw;
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

/**
 * How far a lamp may sit from the value it was written and still count.
 *
 * A lamp does not have to report back what it was sent. It clamps to its own
 * physical range and quantises to its own steps, and neither is visible in the
 * capability options Homey reports — measured on this Homey: 0.930 written,
 * 0.850 held (a bulb at its warm ceiling), and 0.800 written, 0.840 held.
 *
 * The number has to be loose enough for that and tight enough to still catch a
 * write the lamp THREW AWAY, which is the failure this check exists for: a lamp
 * left in colour mode ignored a temperature completely and sat 0.44 away from
 * it. So: 0.1, which is comfortably above the quantisation seen and far below a
 * discarded write.
 */
const LAMP_TOLERANCE = 0.1;

/**
 * Capabilities whose round trip is not the app's promise.
 *
 * `light_mode` is written to make a value land, not as a value in itself. A lamp
 * may keep reporting `color` while accepting the temperature that follows —
 * observed here — and failing on that would report a working write as broken.
 */
const ENABLER_CAPABILITIES = new Set(['light_mode']);

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * One runtime's id, whichever of the app's two spellings it arrived in.
 *
 * `GET /` summaries call it `id`; `GET /diagnostics` runtimes call it
 * `controllerId`. Both are the device's `data.id`, and that is also what a
 * Flow's bridge arguments carry — so there is one identity here and two names
 * for it.
 *
 * This exists because reading the wrong one is silent. `commandRejoin` matched
 * diagnostics runtimes on `.id`, which does not exist on them: every compare
 * was `"undefined" === undefined`, every lookup missed, and T24, T25 and T29
 * reported FAILED after their full timeouts — the three lines this script calls
 * its real prize. Nothing said why, because a missed lookup and a lamp that
 * never rejoined look identical from here.
 *
 * @param {any} entry
 * @returns {string}
 */
function runtimeId(entry) {
  return String(entry?.controllerId ?? entry?.id ?? '');
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
 * The mark this pass puts on every device it builds, and the only thing that
 * tells them from the ones the user paired themselves.
 *
 * The Homey is the state store. A device that exists carries its own
 * provenance, on the machine that owns it, readable by a `schedule` run in a
 * separate process an hour after the `pair` that built it — which a gitignored
 * run-state file on one laptop is not, and which is a second source of truth
 * that can disagree with the first in both directions.
 *
 * It is a PREFIX because T18 renames a schedule to "<name> (verify)" and back
 * (commandSchedule, below): a suffix marker would be destroyed and restored by
 * the very test that has to survive it.
 *
 * Losing the mark fails safe. Rename one of these in the Homey app and this
 * pass stops touching it AND stops deleting it — which is what renaming a
 * device means. The cost is that `pair` builds a duplicate next run, and the
 * recovery is to delete the unmarked leftover by hand.
 *
 * A flag inside the device's `store` was considered as a second, rename-proof
 * mark and declined: it is unverified whether the Web API returns `store` at
 * all, and it would put a foreign key inside a plan blob the app migrates.
 */
const MARKER = '[verify]';

/** @param {string} name */
function markName(name) {
  return `${MARKER} ${name}`;
}

/** @param {string} name */
function isMarked(name) {
  return String(name ?? '').trimStart().startsWith(MARKER);
}

/**
 * Only the devices this pass built — on this run, or on an abandoned earlier
 * one.
 *
 * @param {any} api
 */
async function ourDevices(api) {
  return (await lightkeeperDevices(api)).filter(device => isMarked(device.name));
}

/**
 * Their `data.id`s, which is what every diagnostics runtime is keyed by and what
 * every generated Flow carries in `args.controller`.
 *
 * @param {any} api
 * @returns {Promise<Set<string>>}
 */
async function ourDataIds(api) {
  return new Set((await ourDevices(api)).map(device => device.dataId));
}

/**
 * One sentence, so every command says the same thing when this pass has nothing
 * of its own to work on and the report reads as one voice.
 */
const NOTHING_OF_OURS = 'run `pair --yes` first. A device you paired yourself is never '
  + `mutated or deleted by this pass — it is not marked ${MARKER}`;

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
  note(`Homey software version ${api.version ?? '(not reported)'}`);

  /**
   * Split in the first lines of the report, because it is the whole promise of
   * this pass: these are the ones it built and will delete, and those are yours,
   * which it does not touch.
   */
  const devices = await lightkeeperDevices(api);
  const mine = devices.filter(d => isMarked(d.name));
  const theirs = devices.filter(d => !isMarked(d.name));
  report('-', 'INFO', `${devices.length} Lightkeeper device(s): ${mine.length} built by this `
    + `pass (${mine.map(d => `${d.driver}/${d.name}`).join(', ') || 'none'}); `
    + `${theirs.length} of your own, which this pass leaves alone`
    + (theirs.length ? ` (${theirs.map(d => `${d.driver}/${d.name}`).join(', ')})` : ''));

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

// ------------------------------------------------------------------- memory

/**
 * Lines T59 and T60 — the app's memory footprint on a real Homey.
 *
 * Homey's own guideline is 30 MB of PSS (Proportional Set Size: private memory,
 * excluding anything shared with other apps). The app sat at 48 MB, almost all
 * of it `homey-api` holding both flow card catalogues forever — see platform
 * §15 for the mechanism and the measurements.
 *
 * This reads the same number the app-profiling tool shows, over the Web API:
 *
 *   GET /api/manager/apps/app/:id/usage   ManagerApps.getAppUsage
 *   GET /api/manager/system/memory        ManagerSystem.getMemoryInfo
 *
 * Neither response is described in `homey-api`'s specification — the operations
 * are there, the shapes are not — so `pssBytesIn()` SEARCHES rather than
 * indexes, and says what it looked at when it finds nothing. A reading that
 * cannot be found must read as "no reading", never as a pass.
 *
 * @param {any} api
 */
async function commandMemory(api) {
  const readings = [];

  /** @type {any} */
  let usage = null;
  try {
    usage = await api.apps.getAppUsage({ id: APP_ID });
    const found = pssBytesIn(usage);
    if (found) readings.push({ source: 'apps.getAppUsage', ...found });
  } catch (error) {
    report('-', 'INFO', `apps.getAppUsage was refused: ${messageOf(error)}`);
  }

  try {
    /** @type {any} */
    const memory = await api.system.getMemoryInfo();
    // The per-app breakdown is keyed by app id on every shape seen so far.
    const mine = memory?.[APP_ID] ?? memory?.apps?.[APP_ID] ?? null;
    const found = pssBytesIn(mine);
    if (found) readings.push({ source: 'system.getMemoryInfo', ...found });

    const total = pssBytesIn(memory?.total) ?? pssBytesIn({ total: memory?.total });
    if (total) {
      report('-', 'INFO', `Homey-wide memory reading alongside it: ${mb(total.bytes)} MB`);
    }
  } catch (error) {
    report('-', 'INFO', `system.getMemoryInfo was refused: ${messageOf(error)}`);
  }

  if (readings.length === 0) {
    report('T59', 'SKIPPED',
      'neither endpoint reported anything PSS-shaped for this app. '
      + `apps.getAppUsage returned keys: ${describeKeys(usage)}. `
      + 'Read the number by hand at tools.developer.homey.app/tools/app-profiling '
      + 'and widen pssBytesIn() to match what you see.');
    return;
  }

  const reading = readings[0];
  const megabytes = mb(reading.bytes);
  const detail = `${megabytes} MB PSS (${reading.source}, field "${reading.field}")`
    + (readings.length > 1 ? `; ${readings[1].source} says ${mb(readings[1].bytes)} MB` : '');

  report('T59', ...verdictFor(megabytes, detail));

  return megabytes;
}

/**
 * Line T60 — the same reading after the catalogue-reading commands have run.
 *
 * A one-off reading cannot tell a footprint that is small from one that is
 * about to grow: the card catalogues are read lazily, so an app that has not
 * been asked anything yet looks thin whatever it does with the answer. This is
 * the delta across a pass that provokes those reads.
 *
 * @param {any} api
 * @param {number|undefined} before
 */
async function reportMemoryDelta(api, before) {
  if (before === undefined) return;
  const after = await (async () => {
    try {
      const found = pssBytesIn(await api.apps.getAppUsage({ id: APP_ID }));
      return found ? mb(found.bytes) : undefined;
    } catch {
      return undefined;
    }
  })();

  if (after === undefined) {
    report('T60', 'SKIPPED', 'the second reading could not be taken');
    return;
  }

  const delta = Math.round((after - before) * 10) / 10;
  const [status, detail] = verdictFor(
    after,
    `${after} MB PSS after the pass (${delta >= 0 ? '+' : ''}${delta} MB)`,
  );
  report('T60', status, `${detail}. `
    + 'The rise across a pass should be small: the catalogue read that sets the floor has '
    + 'already happened by now (platform §15).');
}

/**
 * Homey's own guideline. The app is deliberately NOT under it — see the ceiling.
 */
const MEMORY_GUIDELINE_MB = 30;

/**
 * The accepted ceiling, and the number that actually fails this line.
 *
 * Measured 30 August 2026 on Homey Pro 2023, the same app minutes apart:
 * **31.9 MB** before it had read a flow card catalogue, **43.9 MB** immediately
 * after one, and 45.2 MB at the end of a `full` pass. One ~11.6 MB catalogue
 * read costs ~12 MB of floor and V8 never gives those pages back (platform
 * §15), so ~44 MB is the state of any Homey running a controller, a schedule,
 * or that has paired anything. Going lower would mean parsing that response
 * incrementally instead of through `homey-api`; it was costed and declined.
 *
 * 50 rather than 46, because the reading moves with how many apps are installed
 * on the Homey — it is every app's cards being parsed, and this is one house.
 *
 * BE HONEST ABOUT WHAT THIS LINE CAN AND CANNOT CATCH. It is a smoke check for
 * something going badly wrong — a second catalogue read reintroduced, a new
 * bulk fetch — and nothing finer. It CANNOT catch retention coming back:
 * holding a parsed catalogue and merely having parsed one cost the same RSS,
 * because the pages are the same pages and neither is returned. The sharp
 * signal for that is the app's own `heapUsed` after a read (a few MB when it
 * lets go, ~17 MB higher when it does not), which the app does not expose.
 * If this ever needs to be a real regression test, that is what to add.
 */
const MEMORY_CEILING_MB = 50;

/**
 * Three-way, because "over Homey's guideline" and "worse than we accepted" are
 * different facts and only the second is a regression.
 *
 * @param {number} megabytes
 * @param {string} detail
 * @returns {['OK'|'FAILED'|'INFO', string]}
 */
function verdictFor(megabytes, detail) {
  if (megabytes > MEMORY_CEILING_MB) {
    return ['FAILED', `${detail} — past the ${MEMORY_CEILING_MB} MB ceiling. `
      + 'Something is reading more than the one trigger catalogue the app accepts; '
      + 'see platform §15.'];
  }
  if (megabytes > MEMORY_GUIDELINE_MB) {
    return ['INFO', `${detail} — over Homey's ${MEMORY_GUIDELINE_MB} MB guideline and inside the `
      + `${MEMORY_CEILING_MB} MB we accepted. Expected: the remaining cost is the high-water mark `
      + 'of one catalogue parse, not anything held (platform §15).'];
  }
  return ['OK', `${detail} — inside Homey's ${MEMORY_GUIDELINE_MB} MB guideline`];
}

/**
 * The first PSS-shaped number anywhere in a response, with the key it came from.
 *
 * Searches rather than indexes because the shape is undocumented. Keys are
 * matched in preference order — an exact `pss` beats a generic `memory`, so a
 * response carrying both does not report the wrong one.
 *
 * @param {unknown} value
 * @returns {{ bytes: number, field: string } | null}
 */
function pssBytesIn(value) {
  if (!value || typeof value !== 'object') return null;

  for (const pattern of [/^pss$/i, /pss/i, /^mem(ory)?$/i, /^rss$/i, /mem(ory)?/i, /^size$/i]) {
    const hit = findNumber(value, pattern, new Set());
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {any} node
 * @param {RegExp} pattern
 * @param {Set<any>} seen
 * @returns {{ bytes: number, field: string } | null}
 */
function findNumber(node, pattern, seen) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);

  for (const [key, raw] of Object.entries(node)) {
    if (pattern.test(key) && typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return { bytes: raw, field: key };
    }
  }
  for (const raw of Object.values(node)) {
    const nested = findNumber(raw, pattern, seen);
    if (nested) return nested;
  }
  return null;
}

/**
 * Bytes to megabytes, one decimal.
 *
 * A value under 4096 is already megabytes — no Homey app is 4 KB, and the two
 * endpoints have not been seen agreeing on a unit.
 *
 * @param {number} bytes
 */
function mb(bytes) {
  const megabytes = bytes < 4096 ? bytes : bytes / (1024 * 1024);
  return Math.round(megabytes * 10) / 10;
}

/** @param {unknown} value */
function describeKeys(value) {
  if (!value || typeof value !== 'object') return String(value);
  return Object.keys(value).join(', ') || '(none)';
}

// -------------------------------------------------------------------- flows

/**
 * Lines T2, T8, T16, T23 and T30 — which Flows exist and who owns them.
 * Read-only, so this is the one safe to run on any Homey at any time.
 *
 * @param {any} api
 */
async function commandFlows(api) {
  /**
   * `all` for the census, `devices` for every assertion. A user's controller
   * with no Flows yet is their business; ours having none is a failure.
   */
  const all = await lightkeeperDevices(api);
  const devices = all.filter(d => isMarked(d.name));
  const flows = await managedFlows(api);

  const ourIds = new Set(devices.map(d => d.dataId));
  report('T2', 'INFO', `${flows.length} generated Flow(s) in total, `
    + `${flows.filter(f => ourIds.has(f.ownerDataId)).length} of them belonging to devices `
    + 'this pass built');

  /** @type {Map<string, typeof flows>} */
  const byOwner = new Map();
  for (const flow of flows) {
    const list = byOwner.get(flow.ownerDataId) ?? [];
    list.push(flow);
    byOwner.set(flow.ownerDataId, list);
  }

  for (const driver of FLOW_OWNING_DRIVERS) {
    const line = driver === 'controller' ? 'T8' : 'T16';
    const owned = devices.filter(d => d.driver === driver);
    if (owned.length === 0) {
      report(line, 'SKIPPED', `no ${driver} device built by this pass — ${NOTHING_OF_OURS}`);
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

  // T23 and T30: the whole design of these two device types is that they write
  // to lights directly and generate nothing (platform §12). A Flow attributed to
  // one of them is not cosmetic — it means something built a bridge that should
  // not exist.
  for (const driver of FLOWLESS_DRIVERS) {
    const line = driver === 'circadian' ? 'T23' : 'T30';
    const owned = devices.filter(d => d.driver === driver);
    if (owned.length === 0) {
      report(line, 'SKIPPED', `no ${driver} device built by this pass — ${NOTHING_OF_OURS}`);
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
  // `all`, not `devices`: a Flow owned by a device the USER paired is not an
  // orphan, and reporting it as sweepable would be an invitation to delete it.
  const liveIds = new Set(all.map(d => d.dataId));
  const orphaned = flows.filter(f => !liveIds.has(f.ownerDataId));
  if (orphaned.length > 0) {
    report('-', 'INFO', `${orphaned.length} Flow(s) attributed to a device that is not `
      + 'installed — app settings offers to sweep these');
  }

  const unavailable = all.filter(d => !d.available);
  if (unavailable.length > 0) {
    report('-', 'INFO', `unavailable device(s): ${unavailable.map(d => d.name).join(', ')}`);
  }
}

// ---------------------------------------------------------------- redaction

/**
 * Line T45 — the key must not be in the diagnostics report. Done by machine
 * because "search it for your API key" by eye is exactly the check a tired
 * person waves through, and the cost of missing it is a key in a bug report.
 *
 * T42, T43 and T44 come off the same two reads, so they are here too.
 *
 * @param {any} api
 * @param {string[]} keys every key in play — the app's, and this script's
 */
async function commandRedaction(api, keys) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('T45', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @type {any} */
  let diagnostics;
  try {
    diagnostics = await app.get('/diagnostics');
  } catch (error) {
    report('T45', 'SKIPPED', `GET /diagnostics was refused: ${messageOf(error)}`);
    return;
  }

  const serialised = JSON.stringify(diagnostics);

  // The whole key AND a distinctive slice, because a report could carry a
  // truncated echo — the plan asks for "a distinctive dozen characters" for
  // exactly that reason. Deduplicated, so a one-key setup does not report the
  // same hit twice.
  const hits = [];
  for (const key of [...new Set(keys)].filter(Boolean)) {
    const slice = key.length >= 16 ? key.slice(4, 16) : key;
    if (serialised.includes(key)) hits.push('a whole key');
    else if (slice && serialised.includes(slice)) hits.push('a 12-character slice of a key');
  }

  if (hits.length === 0) {
    report('T45', 'OK', `${serialised.length} characters of diagnostics, no key material in it`);
  } else {
    report('T45', 'FAILED', `the diagnostics report contains ${hits.join(' and ')}`);
  }

  /** @type {any} */
  const status = await app.get('/').catch(() => null);
  if (!status) return;

  report('T42', (status.recentEvents?.length ?? 0) > 0 ? 'OK' : 'INFO',
    `${status.recentEvents?.length ?? 0} recent remote press(es) recorded`);
  report('T43', (status.recentWrites?.length ?? 0) > 0 ? 'OK' : 'INFO',
    `${status.recentWrites?.length ?? 0} recent write(s) to lights recorded`);

  for (const schedule of /** @type {any[]} */ (status.schedules ?? [])) {
    // A schedule refuses to fire on a clock it does not trust, so an unresolved
    // timezone is a failure here rather than a note: the device looks well and
    // never fires.
    report('T44', schedule.timezoneResolved ? 'OK' : 'FAILED',
      `schedule "${schedule.name}": ${schedule.entries?.length ?? 0} window(s), `
      + `clock ${schedule.localTime} ${schedule.timezone}`
      + (schedule.timezoneResolved ? '' : ' — TIMEZONE UNRESOLVED, it will refuse to fire'));
  }
}

// --------------------------------------------------------------- credential

/**
 * The API-key lines without the button presses: T35, T36, T38, T40 and T41.
 *
 * Destructive in the recoverable sense — it removes the stored key and puts it
 * back — so it needs `--yes`, and the key it is given must be the APP's key
 * (`HOMEY_APP_KEY`), because that is what it restores at the end. It must not be
 * the key this script connected with: see `requireTwoKeys()`, which is what
 * stops that happening.
 *
 * @param {any} api
 * @param {string} key the app's own key, to restore at the end
 */
async function commandCredential(api, key) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('T35', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
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
    report('T35', 'FAILED', `no working key is saved (present=${before?.credential?.present} `
      + `valid=${before?.credential?.valid}) — paste one in first, this command restores `
      + 'the key it is given and cannot invent one');
    return;
  }
  report('T35', 'OK', 'a working API key is saved');

  const flowsBefore = await managedFlows(api);
  const ownersBefore = flowOwners(before).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`);
  note(`Flow-owning devices before: ${ownersBefore.join(', ') || 'none'}`);

  /**
   * The stored key is app-wide, so T36/T38/T40 below deliberately keep looking
   * at EVERY Flow-owning device: the user's genuinely do degrade and recover
   * with ours, and asserting over all of them is the honest test as well as a
   * read-only one. Only the Flow that gets FIRED has to be one of ours.
   */
  const ourControllers = await ourDataIds(api);

  // T36 — a bad key must not unseat the working one. This is the regression that
  // made every device unavailable on a typo.
  /** @type {any} */
  const refusal = await app.post('/credential', { token: 'not-a-key' });
  const afterBad = await status();
  const stillValid = afterBad?.credential?.valid === true;
  const stillWorking = flowOwners(afterBad).every(o => o.state !== 'needs_credential');
  report('T36', refusal?.valid === false && stillValid && stillWorking ? 'OK' : 'FAILED',
    `nonsense refused (valid=${refusal?.valid} failure=${refusal?.failure ?? 'none'}), `
    + `stored key still valid=${stillValid}, `
    + `no device pushed to needs_credential=${stillWorking}`);

  /**
   * T37 — and the gesture still works.
   *
   * Run through the generated Flow's own action card rather than pressed. That
   * is honest HERE, unlike at T9: the question this line asks is whether the
   * path from a Flow to a light survived a bad key, not whether the radio works.
   */
  const afterBadKey = await fireBridgeEvent(api, app, ourControllers);
  report('T37', afterBadKey.skipped ? 'SKIPPED' : afterBadKey.ok ? 'OK' : 'FAILED',
    `with nonsense rejected, the generated Flow still fires: ${afterBadKey.detail}`);

  // T38 — removing the key must degrade the devices and delete nothing.
  await app.del('/credential');
  const degraded = await waitFor(async () => {
    const s = await status();
    const owners = flowOwners(s);
    return owners.length > 0 && owners.every(o => o.state === 'needs_credential') ? s : null;
  }, { timeoutMs: 60_000, everyMs: 3_000, what: 'the Flow-owning devices to report needs_credential' });

  if (degraded) {
    report('T38', 'OK', 'controller and schedule went to needs_credential after the key was removed');
  } else {
    const s = await status();
    report('T38', 'FAILED', 'they did not all reach needs_credential within 60s: '
      + flowOwners(s).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`).join(', '));
  }

  /**
   * Compared BY FLOW ID, and failing only on a Flow that has GONE.
   *
   * A count cannot tell "the user's controller reconciled and added one" from
   * "the key removal deleted one of ours", and with the user's own devices left
   * standing throughout a run, the first happens. A Flow arriving is normal; a
   * Flow vanishing is the bug this line exists to catch.
   */
  const flowsAfterRemoval = await managedFlows(api);
  const lostOnRemoval = flowsBefore.filter(f => !flowsAfterRemoval.some(n => n.flowId === f.flowId));
  report('T38', lostOnRemoval.length === 0 ? 'OK' : 'FAILED',
    `${flowsAfterRemoval.length} generated Flow(s) after removal, was ${flowsBefore.length} — `
    + 'losing the key must not delete anything'
    + (lostOnRemoval.length
      ? `, but ${lostOnRemoval.length} are GONE: ${lostOnRemoval.map(f => f.name).join(', ')}`
      : ''));

  /**
   * T39 — with NO key at all, the Flows are still there and still fire.
   *
   * The safety property in one line: losing the key pauses Flow MAINTENANCE, it
   * does not stop the lights working. A user whose key expired keeps their
   * remotes until they get round to pasting a new one in.
   */
  const withoutKey = await fireBridgeEvent(api, app, ourControllers);
  report('T39', withoutKey.skipped ? 'SKIPPED' : withoutKey.ok ? 'OK' : 'FAILED',
    `with no key stored at all, the generated Flow still fires: ${withoutKey.detail}`);

  // T41 — neither light-driving device type holds a key or has a
  // needs_credential state at all (platform §12), so nothing here may touch them.
  const midway = await status();
  const curvesTouched = /** @type {any[]} */ (midway?.circadian ?? [])
    .filter(c => c.state === 'needs_credential');
  report('T41', curvesTouched.length === 0 ? 'OK' : 'FAILED',
    curvesTouched.length === 0
      ? `circadian and Curve lights untouched with no key stored: ${curveStates(midway) || 'none paired'}`
      : `${curvesTouched.length} of them reported needs_credential, which they have no state for`);

  // T40 — and back, without a restart.
  /** @type {any} */
  const restored = await app.post('/credential', { token: key });
  if (restored?.valid !== true) {
    report('T40', 'FAILED', `the real key was refused on the way back in: `
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
    report('T40', 'OK', 'controller and schedule left needs_credential without an app restart: '
      + flowOwners(recovered).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`).join(', '));
  } else {
    const s = await status();
    report('T40', 'FAILED', 'they were still without a key 90s after the key went back in: '
      + flowOwners(s).map(o => `${o.name ?? o.sourceName ?? o.id}=${o.state}`).join(', ')
      + ' — recoverFromCredentialFailure is what should have cleared this');
  }

  // By id, for the same reason as T38 above.
  const flowsAtEnd = await managedFlows(api);
  const lost = flowsBefore.filter(f => !flowsAtEnd.some(n => n.flowId === f.flowId));
  report('-', lost.length === 0 ? 'INFO' : 'FAILED',
    `${flowsAtEnd.length} generated Flow(s) at the end, was ${flowsBefore.length}`
    + (lost.length ? ` — ${lost.length} of them are GONE: ${lost.map(f => f.name).join(', ')}` : ''));
}

// ------------------------------------------------------------------- rejoin

/**
 * T24, T29 and T25 — the two checks that are the real prize, because they are
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
    report('T24', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @returns {Promise<any[]>} */
  const curves = async () => {
    /** @type {any} */
    const diagnostics = await app.get('/diagnostics');
    return /** @type {any[]} */ (diagnostics?.circadian ?? []);
  };

  // Ours only: this command switches a lamp off and on and sets a colour on it
  // by hand, and the lamps behind somebody else's circadian light are theirs.
  const ours = await ourDataIds(api);
  const all = (await curves()).filter(runtime => ours.has(runtimeId(runtime)));
  if (all.length === 0) {
    report('T24', 'SKIPPED', 'no circadian or Curve light built by this pass is running — '
      + NOTHING_OF_OURS);
    return;
  }

  for (const runtime of all) {
    const kind = String(runtime?.kind ?? 'circadian');
    // T29 is the Curve light's line and T24 the circadian one; the check is the
    // same, so `kind` decides which number it reports against.
    const rejoinLine = kind === 'curve' ? 'T29' : 'T24';
    const label = `${kind} "${runtime?.name ?? runtime?.id}"`;

    if (runtime?.enabled === false) {
      report(rejoinLine, 'SKIPPED', `${label} is switched off`);
      continue;
    }

    let targets = /** @type {any[]} */ (runtime?.targets ?? []);
    let candidate = targets.find(t => t?.on === true && t?.canWarm === true);

    if (!candidate) {
      // Name the lamps and wait, rather than skipping a check that only needs a
      // switch flicked. Only the warmth-capable ones are worth naming: a lamp
      // that cannot change colour would not make this check runnable.
      const warmable = targets.filter(t => t?.canWarm === true).map(t => String(t.id));
      const names = /** @type {string[]} */ (runtime?.targetNames ?? [])
        .filter((_, index) => warmable.includes(String(runtime?.targetIds?.[index])));

      if (names.length > 0 && await askForALampOn(names, label)) {
        /** @type {any} */
        const fresh = await app.get('/diagnostics');
        const now = /** @type {any[]} */ (fresh?.circadian ?? [])
          .find(c => runtimeId(c) === runtimeId(runtime));
        targets = /** @type {any[]} */ (now?.targets ?? []);
        candidate = targets.find(t => t?.on === true && t?.canWarm === true);
      }
    }

    if (!candidate) {
      report(rejoinLine, 'SKIPPED', `${label}: no target lamp is both on and able to change `
        + 'warmth right now');
      continue;
    }

    const lampId = String(candidate.id);
    const lampName = /** @type {string} */ (
      runtime.targetNames?.[runtime.targetIds?.indexOf?.(lampId)] ?? lampId);
    note(`${label}: testing against lamp "${lampName}"`);

    await rejoinAfterPowerCycle(api, app, runtimeId(runtime), lampId, lampName, label, rejoinLine);
    // T25 is written once, for the circadian light, but the behaviour belongs to
    // the shared engine — so it runs for a Curve light too and reports against
    // the same number.
    await handOverAndRejoin(api, app, runtimeId(runtime), lampId, lampName, label);
  }
}

/**
 * The lamp goes off and on, and the app must write to it again.
 *
 * @param {any} api
 * @param {any} app
 * @param {string} wantedId
 * @param {string} lampId
 * @param {string} lampName
 * @param {string} label
 * @param {string} line
 */
async function rejoinAfterPowerCycle(api, app, wantedId, lampId, lampName, label, line) {
  const lamp = await api.devices.getDevice({ id: lampId });

  await lamp.setCapabilityValue({ capabilityId: 'onoff', value: false });
  await sleep(4_000);
  const switchedOnAt = Date.now();
  await lamp.setCapabilityValue({ capabilityId: 'onoff', value: true });

  const write = await waitFor(
    () => writeAfter(app, wantedId, lampId, switchedOnAt),
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
    ? Math.abs(wanted - actual) <= LAMP_TOLERANCE
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
 * @param {string} wantedId
 * @param {string} lampId
 * @param {string} lampName
 * @param {string} label
 */
async function handOverAndRejoin(api, app, wantedId, lampId, lampName, label) {
  const lamp = await api.devices.getDevice({ id: lampId });
  const current = Number(await capabilityValue(api, lampId, 'light_temperature'));
  if (!Number.isFinite(current)) {
    report('T25', 'SKIPPED', `${label}: "${lampName}" reports no light_temperature to take over`);
    return;
  }

  /**
   * A SMALL move, not a dramatic one.
   *
   * This used to jump 0.35, on the reasoning that the further it is from the
   * curve's value the less the app could mistake it for its own. On real lamps
   * that backfired: both lamps here refused 0.35 outright while accepting the
   * app's own writes a hundredth away from where they already sat. Homey reports
   * the capability's range as 0..1, but a lamp's physical colour-temperature
   * band is narrower and does not say so — the same lesson as the quantisation
   * above, one step further on.
   *
   * 0.2 is comfortably outside `LAMP_TOLERANCE`, so a value that lands is
   * unmistakably ours, and close enough to stay inside a narrow band. If even
   * that is refused the check says so rather than guessing.
   */
  const BY_HAND_DELTA = 0.2;
  const byHand = current > 0.5
    ? clamp(current - BY_HAND_DELTA, 0, 1)
    : clamp(current + BY_HAND_DELTA, 0, 1);

  /**
   * Let the app finish writing BEFORE taking the lamp over.
   *
   * This runs straight after a power cycle, which is one of the three things
   * that makes a curve write (platform §12) — and those writes are queued
   * through the command scheduler rather than issued inline. Setting a value by
   * hand into that queue means the app's own write can land AFTER it, leaving
   * the lamp on the curve's value and this check reporting "the app wrote over
   * it" when what actually happened is that the harness got in first.
   *
   * So: wait for the writes to stop, then take it over.
   */
  const settled = await waitFor(async () => {
    const first = await writeAfter(app, wantedId, lampId, 0);
    await sleep(6_000);
    const second = await writeAfter(app, wantedId, lampId, 0);
    return first?.at === second?.at ? second : null;
  }, { timeoutMs: 60_000, everyMs: 1_000, what: `${label} to stop writing to "${lampName}"` });

  if (!settled) note(`${label}: still writing after 60s — taking the lamp over anyway`);

  /**
   * The mode goes first here too, for the same reason the app now does it.
   *
   * This stands in for a person changing a lamp's warmth in the Homey app, and
   * the Homey app switches the lamp out of colour mode as part of that. Writing
   * only the temperature reproduces the bug rather than the person: on a lamp
   * left in colour mode it lands nowhere, and the override check then reports
   * that it "would not take" a value nobody actually offered properly.
   */
  await lamp.setCapabilityValue({ capabilityId: 'light_mode', value: 'temperature' })
    .catch(() => { /* a lamp with only one mode has no light_mode and needs no switch */ });
  await lamp.setCapabilityValue({ capabilityId: 'light_temperature', value: byHand });
  note(`${label}: set "${lampName}" to light_temperature=${round(byHand)} by hand`);

  /**
   * And check the hand-set value actually took, before asking whether the app
   * respected it. A lamp that never reached `byHand` makes everything below
   * unanswerable, and blaming the app for it would be a guess.
   */
  /**
   * Poll for the hand-set value, then say WHICH thing went wrong if it never
   * arrives.
   *
   * "It would not take" is two different findings wearing one sentence. If the
   * app wrote to the lamp after the hand-set, the app overwrote a value somebody
   * set by hand — the exact safety property this line exists to check, and a
   * real failure. If nothing wrote and the lamp simply never moved, the lamp or
   * its integration refused, and there is nothing here to judge the app on.
   * Skipping without separating them hides the first inside the second.
   */
  const setAt = Date.now();
  const landed = await waitFor(async () => {
    const held = Number(await capabilityValue(api, lampId, 'light_temperature'));
    return Math.abs(held - byHand) <= LAMP_TOLERANCE ? held : null;
  }, {
    timeoutMs: 15_000, everyMs: 2_000,
    what: `"${lampName}" to report the value set by hand`,
  });

  if (landed === null) {
    const held = Number(await capabilityValue(api, lampId, 'light_temperature'));
    const overwrote = await writeAfter(app, wantedId, lampId, setAt);

    if (overwrote) {
      report('T25', 'FAILED', `${label}: "${lampName}" was set to ${round(byHand)} by hand and `
        + `the app wrote ${overwrote.capability}=${round(overwrote.value)} over it within `
        + `15s — a value somebody set by hand must be left alone`);
    } else {
      report('T25', 'SKIPPED', `${label}: "${lampName}" never reported ${round(byHand)} `
        + `(it holds ${round(held)}) and the app wrote nothing, so the lamp itself refused `
        + 'the value — there is nothing here to judge the app on');
    }
    return;
  }

  // The curve ticks once a minute, so the app needs a tick to notice and another
  // to prove it is leaving the lamp alone.
  const overridden = await waitFor(async () => {
    const target = await targetOf(app, wantedId, lampId);
    return target?.overridden === true ? target : null;
  }, { timeoutMs: 150_000, everyMs: 10_000, what: `${label} to notice the lamp was taken over` });

  if (!overridden) {
    report('T25', 'FAILED', `${label}: "${lampName}" was not marked overridden within 150s — `
      + 'the app may be about to write over a value somebody set by hand');
  } else {
    const stillOurs = Number(await capabilityValue(api, lampId, 'light_temperature'));
    const left = Math.abs(stillOurs - byHand) <= LAMP_TOLERANCE;
    report('T25', left ? 'OK' : 'FAILED',
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
    () => writeAfter(app, wantedId, lampId, switchedOnAt),
    { timeoutMs: 120_000, everyMs: 5_000, what: `${label} to take "${lampName}" back` });

  if (!write) {
    report('T25', 'FAILED', `${label}: "${lampName}" did not rejoin after being switched off `
      + 'and on — it is left overridden, and holding a value this script set. '
      + 'Switch it off and on again by hand.');
    return;
  }

  const target = await targetOf(app, wantedId, lampId);
  report('T25', target?.overridden === false ? 'OK' : 'FAILED',
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
 * @param {string} wantedId
 * @param {string} lampId
 * @param {number} since
 * @returns {Promise<{ capability: string, value: unknown, at: number } | null>}
 */
async function writeAfter(app, wantedId, lampId, since) {
  /** @type {any} */
  const diagnostics = await app.get('/diagnostics');
  const runtime = /** @type {any[]} */ (diagnostics?.circadian ?? [])
    .find(c => runtimeId(c) === wantedId);
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
 * @param {string} wantedId
 * @param {string} lampId
 * @returns {Promise<any>}
 */
async function targetOf(app, wantedId, lampId) {
  /** @type {any} */
  const diagnostics = await app.get('/diagnostics');
  const runtime = /** @type {any[]} */ (diagnostics?.circadian ?? [])
    .find(c => runtimeId(c) === wantedId);
  return /** @type {any[]} */ (runtime?.targets ?? []).find(t => String(t?.id) === lampId) ?? null;
}

/** @param {unknown} value */
function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : String(value);
}

// ------------------------------------------------------------------ restart

/**
 * Everything a restart proves: T1, T4, T31, T32 and T34.
 *
 * The loader check, with something to load. `apps.restartApp` is the same thing
 * as ⋮ → Restart on the settings page, so this is the manual step exactly, and
 * the interesting part is what comes back: every device available, every curve
 * runtime holding its value a minute later.
 *
 * T33 — "press the remote again" — is `bridge`, below.
 *
 * @param {any} api
 */
async function commandRestart(api) {
  const before = await lightkeeperDevices(api);
  if (before.length === 0) {
    report('T32', 'SKIPPED', 'no Lightkeeper device is paired, so a restart proves nothing');
    return;
  }
  /**
   * Deliberately the FULL list, unlike every other command here. A restart is
   * app-wide — there is no per-device restart — so the user's devices go down
   * with ours whatever this pass does, and checking that theirs came back too is
   * free, read-only and a stronger test than checking only ours.
   */
  note(`${before.length} device(s) before the restart: ${before.map(d => d.name).join(', ')}`
    + ` (${before.filter(d => isMarked(d.name)).length} built by this pass)`);

  try {
    await withTimeout(api.apps.restartApp({ id: APP_ID }), 60_000, 'restartApp');
  } catch (error) {
    report('T31', 'FAILED', `the app would not restart: ${messageOf(error)}`);
    return;
  }
  report('T31', 'OK', 'the app was restarted over the API');

  // T1 / T4: the app comes back and its own Web API answers. A settings page
  // that renders is exactly this, with a person reading it.
  const app = await waitFor(async () => {
    try {
      const candidate = await appApi(api);
      await candidate.get('/');
      return candidate;
    } catch {
      return null;
    }
  }, { timeoutMs: 120_000, everyMs: 5_000, what: 'the app to answer its own Web API again' });

  if (!app) {
    report('T1', 'FAILED', 'the app did not answer its Web API within 120s of restarting — '
      + 'it did not come back');
    return;
  }
  report('T1', 'OK', 'the app came back and answers its own Web API, with no error');
  report('T4', 'OK', 'and it does so after a restart, not only from a cold install');

  // T32: all four back, all available.
  const back = await waitFor(async () => {
    const now = await lightkeeperDevices(api);
    return now.length === before.length && now.every(d => d.available) ? now : null;
  }, { timeoutMs: 120_000, everyMs: 5_000, what: 'every device to come back available' });

  if (back) {
    report('T32', 'OK', `all ${back.length} device(s) came back available: `
      + back.map(d => `${d.driver}/${d.name}`).join(', '));
  } else {
    const now = await lightkeeperDevices(api);
    const missing = before.filter(d => !now.some(n => n.dataId === d.dataId));
    const unavailable = now.filter(d => !d.available);

    /**
     * The MESSAGE, not just the count.
     *
     * Homey puts the reason on the device when `onInit` throws, and reporting
     * only "3 unavailable" throws away the one thing that says why — which cost
     * a whole round trip the first time a device failed to initialise here.
     */
    const reasons = [];
    for (const device of unavailable) {
      const live = await api.devices.getDevice({ id: device.homeyId }).catch(() => null);
      reasons.push(`${device.name}: "${live?.unavailableMessage ?? '(no message)'}"`);
    }

    report('T32', 'FAILED', `after 120s: ${now.length} of ${before.length} device(s) back`
      + (missing.length ? `, missing ${missing.map(d => d.name).join(', ')}` : '')
      + (unavailable.length ? `. UNAVAILABLE — ${reasons.join('; ')}` : ''));
  }

  // T34: the curves still hold the right values a minute later. Asked of the app
  // rather than re-derived — the same rule `rejoin` follows.
  /** @type {any} */
  const diagnostics = await app.get('/diagnostics').catch(() => null);
  // Asserted over ours alone. A curve of the user's that was already in
  // needs_repair before the restart would otherwise report T34 FAILED against
  // the app for a configuration this pass never looked at.
  const ourCurves = await ourDataIds(api);
  const curves = /** @type {any[]} */ (diagnostics?.circadian ?? [])
    .filter(runtime => ourCurves.has(runtimeId(runtime)));
  if (curves.length === 0) {
    report('T34', 'SKIPPED', 'no circadian or Curve light built by this pass is running — '
      + NOTHING_OF_OURS);
    return;
  }

  // A tick each, rather than waiting up to a minute for the shared timer.
  await app.post('/curves/tick', {}).catch(() => null);
  await sleep(5_000);

  /** @type {any} */
  const after = await app.get('/diagnostics').catch(() => null);
  const back2 = /** @type {any[]} */ (after?.circadian ?? [])
    .filter((/** @type {any} */ runtime) => ourCurves.has(runtimeId(runtime)));
  const broken = back2.filter(c => c.state !== 'ready' && c.enabled !== false);
  const withoutValue = back2.filter(c => c.enabled !== false && !c.now);

  report('T34', broken.length === 0 && withoutValue.length === 0 ? 'OK' : 'FAILED',
    `${back2.length} curve runtime(s) after the restart: `
    + back2.map(c => `${c.name}=${c.state}`).join(', ')
    + (withoutValue.length ? ` — ${withoutValue.length} hold no current value` : ''));
}

// ------------------------------------------------------------------- bridge

/**
 * Run one generated Flow's action card, as the Flow itself would.
 *
 * Shared by `bridge` (T33) and by `credential` (T37, T39), because those three
 * lines are the same question asked at three moments: is the path from a Flow to
 * a light still live?
 *
 * WHAT THIS IS NOT. It is not T9-T11. A real press arrives as a physical
 * event that goes through the normalizer and the mapping engine before any of
 * this, and a real hold ends with a release event that Zigbee routinely drops —
 * which is the entire reason the ramp hard-stops at 10 seconds. This proves
 * dispatch, attribution, validation and the write path. It cannot prove a radio.
 *
 * The card is ENUMERATED and its uri echoed back, never constructed (platform
 * §3): a built uri returns a 404 that reads like a permission refusal.
 *
 * `skipped` is a third outcome rather than a flavour of `ok: false`, and it
 * exists because of the device split: on a Homey where this pass could not build
 * a controller, "there is nothing of ours to fire" is not the app failing, and
 * reporting T33/T37/T39 as FAILED would be exactly the kind of lie the rest of
 * this file goes out of its way to avoid.
 *
 * @param {any} api
 * @param {any} app
 * @param {Set<string>} ours the data.ids of the controllers this pass built
 * @returns {Promise<{ ok: boolean, skipped?: boolean, detail: string }>}
 */
async function fireBridgeEvent(api, app, ours) {
  /** @type {any} */
  const diagnostics = await app.get('/diagnostics').catch(() => null);
  const controllers = /** @type {any[]} */ (diagnostics?.controllers ?? []);

  const controller = controllers
    .filter(c => ours.has(runtimeId(c)))
    .find(c => /** @type {any[]} */ (c?.mappings ?? []).some(m => m?.inputKey));
  if (!controller) {
    return { ok: false, skipped: true,
      detail: `no controller built by this pass has a mapped gesture — ${NOTHING_OF_OURS}` };
  }
  const mapping = /** @type {any[]} */ (controller.mappings).find(m => m?.inputKey);

  const cards = Object.values(/** @type {any} */ (await api.flow.getFlowCardActions()));
  const card = /** @type {any[]} */ (cards).find(c => {
    const id = String(c?.id ?? '');
    return id.includes(APP_ID) && id.endsWith(':bridge_event');
  });
  if (!card) {
    return { ok: false, detail: 'the bridge_event action card is not on this Homey — '
      + 'an app\'s cards exist only while it is running (platform §3)' };
  }

  const before = /** @type {any} */ (await app.get('/').catch(() => null));
  const writesBefore = before?.recentWrites?.length ?? 0;

  try {
    await withTimeout(api.flow.runFlowCardAction({
      // Both echoed back verbatim from the enumeration.
      id: card.id,
      uri: card.uri,
      args: { controller: runtimeId(controller), event_key: String(mapping.inputKey) },
    }), 30_000, 'runFlowCardAction');
  } catch (error) {
    return { ok: false, detail: `the card refused: ${messageOf(error)}` };
  }

  /**
   * The card returns BEFORE any light moves — the run listener accepts and then
   * fires and forgets — so the return value proves nothing and `recentEvents` is
   * what has to be read.
   */
  const accepted = await waitFor(async () => {
    /** @type {any} */
    const status = await app.get('/').catch(() => null);
    const latest = /** @type {any[]} */ (status?.recentEvents ?? [])
      .find(e => String(e?.eventKey) === String(mapping.inputKey));
    return latest ? { latest, status } : null;
  }, { timeoutMs: 30_000, everyMs: 2_000, what: 'the app to record the event' });

  if (!accepted) {
    return { ok: false, detail: `the card ran but the app recorded no event for `
      + `"${mapping.inputKey}"` };
  }
  if (accepted.latest.accepted !== true) {
    return { ok: false, detail: `the event was REFUSED: ${accepted.latest.reason}` };
  }

  /**
   * The write is awaited SEPARATELY, because the card returns before it happens.
   *
   * `dispatchBridgeEvent` accepts and then fires-and-forgets, so `recentEvents`
   * gains its row immediately while the write is still in flight. Reading both
   * at the same instant reported "accepted, 0 new write(s)" every time — a race
   * in the harness, printed as though the lights had not moved.
   */
  const wrote = await waitFor(async () => {
    /** @type {any} */
    const status = await app.get('/').catch(() => null);
    const count = status?.recentWrites?.length ?? 0;
    return count > writesBefore ? count : null;
  }, {
    timeoutMs: 20_000, everyMs: 2_000,
    what: 'a write to reach the lights',
  });

  const source = controller.source?.name ?? controller.controllerId;
  return {
    ok: true,
    detail: `"${mapping.inputKey}" → ${mapping.function} on "${source}", accepted, `
      + (wrote
        ? `${wrote - writesBefore} write(s) reached the lights`
        : 'but NO write reached a light within 20s — the event was dispatched and '
          + 'nothing moved'),
  };
}

/**
 * T33 — the controller's path from a Flow to a light still works.
 *
 * @param {any} api
 */
async function commandBridge(api) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('T33', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  const result = await fireBridgeEvent(api, app, await ourDataIds(api));
  report('T33', result.skipped ? 'SKIPPED' : result.ok ? 'OK' : 'FAILED', result.detail);
  report('-', 'INFO', 'this proves dispatch, mapping and the write path — NOT the radio. '
    + 'T9-T11 still need a finger on the remote.');
}

// ----------------------------------------------------------------- schedule

/**
 * The schedule lines without waiting on the clock: T13, T14, T15, T17 and T18.
 *
 * Everything here is restored afterwards — the windows it replaces and the name
 * it changes are put back, because this may be somebody's real evening
 * schedule. It still needs `--yes`: it switches their lights.
 *
 * @param {any} api
 */
async function commandSchedule(api) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('T13', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @type {any} */
  const diagnostics = await app.get('/diagnostics');
  /**
   * Ours, not merely the first one running.
   *
   * This command replaces a schedule's windows, renames its device and fires
   * both boundaries at real lamps before putting everything back. A schedule's
   * windows are somebody's real evening, so it no longer retimes one it did not
   * create.
   */
  const ours = await ourDataIds(api);
  const schedule = /** @type {any[]} */ (diagnostics?.schedules ?? [])
    .find(entry => ours.has(runtimeId(entry)));
  if (!schedule) {
    report('T13', 'SKIPPED', `no schedule device built by this pass is running — ${NOTHING_OF_OURS}`);
    return;
  }

  const id = runtimeId(schedule);
  const devices = await ourDevices(api);
  const device = devices.find(d => d.dataId === id);
  if (!device) {
    report('T13', 'FAILED', `schedule "${schedule.name}" is running but no device carries its id`);
    return;
  }

  // Everything that will be put back.
  const originalEntries = /** @type {any[]} */ (schedule.entries ?? []);
  const originalName = device.name;
  note(`schedule "${originalName}": ${originalEntries.length} window(s) will be restored at the end`);

  /**
   * The windows to restore, EXACTLY as they were.
   *
   * Diagnostics render `on` and `off` as clock strings for a human, and the
   * clock strings are lossy: "until 22:00" and "for two hours from 20:00" print
   * the same and are not the same stored thing. So the raw `end` is read rather
   * than reconstructed — a restore that put every duration back as a time would
   * fire at the right minutes and quietly rewrite what the household had typed.
   *
   * A schedule this cannot rebuild exactly is left alone. A partial restore is
   * worse than no test.
   */
  const restorable = originalEntries.every(e => typeof e?.on === 'string' && e?.end);
  if (!restorable) {
    report('T13', 'SKIPPED', 'this schedule\'s windows do not carry their raw `end`, so they '
      + 'cannot be put back exactly — install a build with it before running this');
    return;
  }
  const restore = originalEntries.map(e => ({
    id: e.id,
    onAt: minutesOf(e.on),
    days: e.days === 'every day' ? null : e.days,
    end: e.end,
    ...(e.brightness === undefined ? {} : { brightness: e.brightness }),
    ...(e.temperature === undefined ? {} : { temperature: e.temperature }),
  }));

  try {
    // T15 first, while nothing has been changed: two windows that overlap, of
    // which the later must be dropped and NAMED.
    /** @type {any} */
    const overlap = await app.post(`/schedules/${id}/entries`, {
      entries: [
        { id: 'vh1', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 120 } },
        { id: 'vh2', onAt: 21 * 60, days: null, end: { kind: 'duration', minutes: 30 } },
      ],
    }).catch((/** @type {any} */ error) => ({ error: messageOf(error) }));

    const dropped = /** @type {any[]} */ (overlap?.dropped ?? []);
    const overlapDropped = dropped.filter(d => String(d?.reason ?? '').startsWith('overlaps'));
    report('T15', overlap?.count === 1 && overlapDropped.length === 1 ? 'OK' : 'FAILED',
      overlap?.error
        ? `the entries route refused the pair outright: ${overlap.error}`
        : `${overlap?.count} window(s) kept, ${dropped.length} dropped `
          + `(${dropped.map(d => d.reason).join('; ') || 'none'})`);

    // T13: one window, saved and read back.
    /** @type {any} */
    const saved = await app.post(`/schedules/${id}/entries`, {
      entries: [{ id: 'vh1', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 120 } }],
    });
    /** @type {any} */
    const afterSave = await app.get('/diagnostics');
    const reread = /** @type {any[]} */ (afterSave?.schedules ?? [])
      .find(s => runtimeId(s) === id);
    report('T13', saved?.count === 1 && reread?.entries?.length === 1 ? 'OK' : 'FAILED',
      `saved ${saved?.count} window, the device reports ${reread?.entries?.length} — `
      + `${reread?.entries?.[0]?.on ?? '?'} to ${reread?.entries?.[0]?.off ?? '?'}`);

    // T14: both boundaries, fired now rather than at 20:00.
    /** @type {any} */
    const on = await app.post(`/schedules/${id}/test`, { entryId: 'vh1', boundary: 'on' })
      .catch((/** @type {any} */ error) => ({ error: messageOf(error) }));
    await sleep(3_000);
    /** @type {any} */
    const off = await app.post(`/schedules/${id}/test`, { entryId: 'vh1', boundary: 'off' })
      .catch((/** @type {any} */ error) => ({ error: messageOf(error) }));

    const bothFired = on?.writes > 0 && off?.writes > 0;
    report('T14', bothFired ? 'OK' : 'FAILED',
      on?.error || off?.error
        ? `a boundary was refused: ${on?.error ?? off?.error}`
        : `on: ${on?.writes} write(s) to ${on?.targets} lamp(s); `
          + `off: ${off?.writes} write(s) to ${off?.targets} lamp(s)`);

    // T17: paused and resumed, and the device must stay AVAILABLE both ways —
    // its tile carries the switch that un-pauses it, and an unavailable device
    // cannot be switched.
    const lamp = await api.devices.getDevice({ id: device.homeyId });
    await lamp.setCapabilityValue({ capabilityId: 'onoff', value: false });
    const paused = await waitFor(async () => {
      /** @type {any} */
      const status = await app.get('/');
      const found = /** @type {any[]} */ (status?.schedules ?? []).find(s => s.id === id);
      return found && found.enabled === false ? found : null;
    }, { timeoutMs: 30_000, everyMs: 2_000, what: 'the schedule to report itself paused' });

    const whilePaused = (await lightkeeperDevices(api)).find(d => d.dataId === id);
    await lamp.setCapabilityValue({ capabilityId: 'onoff', value: true });
    const resumed = await waitFor(async () => {
      /** @type {any} */
      const status = await app.get('/');
      const found = /** @type {any[]} */ (status?.schedules ?? []).find(s => s.id === id);
      return found && found.enabled === true ? found : null;
    }, { timeoutMs: 30_000, everyMs: 2_000, what: 'the schedule to come back' });

    report('T17', paused && resumed && whilePaused?.available === true ? 'OK' : 'FAILED',
      `paused=${!!paused}, still available while paused=${whilePaused?.available}, `
      + `resumed=${!!resumed}`
      + (whilePaused?.available === false
        ? ' — an unavailable device cannot be switched back on from its own tile'
        : ''));

    // T18: renamed, and the Flow folder follows.
    const testName = `${originalName} (verify)`;
    await api.devices.updateDevice({ id: device.homeyId, device: { name: testName } });
    /**
     * Two questions, in order, because they have different answers.
     *
     * First: did the APP see the rename at all? A rename through the Homey app
     * calls the device's `onRenamed`; whether one made over the Web API does is
     * not something this repo has established. If the app never learns the new
     * name then nothing downstream can follow it, and that is a limit of the
     * harness rather than a fault in the app — reporting it as "the folder did
     * not follow" would be an accusation the evidence does not support.
     *
     * Only once the app has the new name is the folder's silence a real failure.
     */
    const appSawIt = await waitFor(async () => {
      /** @type {any} */
      const status = await app.get('/').catch(() => null);
      const found = /** @type {any[]} */ (status?.schedules ?? [])
        .find(entry => runtimeId(entry) === id);
      return found?.name === testName ? found : null;
    }, {
      timeoutMs: 45_000, everyMs: 3_000,
      what: 'the app to notice the device was renamed',
    });

    /** @param {number} ms */
    const folderExists = (ms) => waitFor(async () => {
      const folders = Object.values(/** @type {any} */ (await api.flow.getFlowFolders()));
      return /** @type {any[]} */ (folders).some(f => String(f?.name ?? '') === testName)
        ? true : null;
    }, { timeoutMs: ms, everyMs: 3_000, what: `a Flow folder named "${testName}"` });

    /**
     * A folder shared with another device's Flows is not renamed, by design.
     *
     * `renameIfOurs` declines when any Flow in the folder belongs to a different
     * device, because two devices with the same name share one folder and would
     * otherwise rename it back and forth forever. That is the guard working —
     * but from outside it is indistinguishable from a rename that simply did not
     * happen, and reporting it as a failure blames the app for obeying its own
     * rule.
     */
    const inFolder = (await managedFlows(api))
      .filter(flow => flow.folderName === originalName);
    const foreign = inFolder.filter(flow => flow.ownerDataId !== id);

    if (foreign.length > 0) {
      report('T18', 'SKIPPED',
        `the folder "${originalName}" also holds ${foreign.length} Flow(s) belonging to `
        + 'another device, so renameIfOurs declines to rename it — which is the guard '
        + 'working. Sweep the orphans and run this again.');
    } else if (!appSawIt) {
      report('T18', 'SKIPPED',
        `the device was renamed to "${testName}" over the Web API, but the app never `
        + 'reported the new name at all. Rename it in the Homey app instead.');
    } else if (await folderExists(90_000)) {
      report('T18', 'OK', `the folder under Lightkeeper followed the rename to "${testName}"`);
    } else {
      /**
       * The folder did not follow — but WHY has two answers, and the previous
       * version of this check could not tell them apart.
       *
       * Reading the new name back from the app proves only that the name is
       * READABLE: `displayName()` reads the device's live name, so it reports the
       * new one whether or not `onRenamed` ever fired. A Web API rename that
       * never reaches the SDK hook therefore looks identical to a
       * `reconcileFlows` that does not rename folders.
       *
       * Pausing and resuming separates them. That path goes through
       * `updatePlan` -> restart -> `reconcileFlows`, so it renames the folder for
       * its own reasons. If the folder appears NOW, reconciliation works and the
       * rename hook is what never fired — a limit of driving this over the Web
       * API rather than a fault in the app. If it still does not appear,
       * reconciliation genuinely does not move the folder, and that is a bug.
       */
      note('the folder did not follow; pausing and resuming to force a reconcile...');
      const paused = await api.devices.getDevice({ id: device.homeyId });
      await paused.setCapabilityValue({ capabilityId: 'onoff', value: false });
      await sleep(5_000);
      await paused.setCapabilityValue({ capabilityId: 'onoff', value: true });

      if (await folderExists(90_000)) {
        report('T18', 'SKIPPED',
          'renaming over the Web API did not move the Flow folder, but a forced reconcile '
          + 'did — so onRenamed does not fire for a Web API rename, and this line cannot be '
          + 'tested from here. Rename the device in the Homey app and check the folder.');
      } else {
        report('T18', 'FAILED',
          `the app knows the device as "${testName}", and even a forced reconcile did not `
          + 'move its Flow folder — reconcileFlows does not rename the folder');
      }
    }

    await api.devices.updateDevice({ id: device.homeyId, device: { name: originalName } });
  } finally {
    // Put the schedule back, whatever happened above.
    if (restore.length > 0) {
      try {
        await app.post(`/schedules/${id}/entries`, { entries: restore });
        note(`schedule "${originalName}" restored to its ${restore.length} original window(s)`);
      } catch (error) {
        report('-', 'FAILED', `could not restore the original windows: ${messageOf(error)} — `
          + `the schedule is left holding this script's test window. Repair it from the app.`);
      }
    } else {
      note('the schedule had no windows to restore');
    }
  }
}

/**
 * "20:00" as minutes since midnight.
 *
 * @param {string} clock
 */
function minutesOf(clock) {
  const [hours, minutes] = String(clock).split(':').map(Number);
  return (hours % 24) * 60 + (minutes % 60);
}

// ------------------------------------------------------------------ preview

/**
 * T21, T22, T27 and T28 — "Try it now", and what the lamps did about it.
 *
 * The write path end to end: the app is asked to apply a saved curve, then each
 * lamp is read back and compared against what the app SAYS it wrote. As with
 * `rejoin`, nothing here re-derives the curve — that would re-implement the
 * engine the unit suite already covers.
 *
 * @param {any} api
 */
async function commandPreview(api) {
  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('T21', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /** @type {any} */
  const diagnostics = await app.get('/diagnostics');
  // Ours only: this writes the curve to whatever lamps the runtime drives, and
  // the T22 probe switches one of them off and on.
  const ours = await ourDataIds(api);
  const curves = /** @type {any[]} */ (diagnostics?.circadian ?? [])
    .filter(runtime => ours.has(runtimeId(runtime)));
  if (curves.length === 0) {
    report('T21', 'SKIPPED', 'no circadian or Curve light built by this pass is running — '
      + NOTHING_OF_OURS);
    return;
  }

  for (const runtime of curves) {
    const kind = String(runtime?.kind ?? 'circadian');
    const previewLine = kind === 'curve' ? 'T27' : 'T21';
    const label = `${kind} "${runtime?.name ?? runtimeId(runtime)}"`;
    const id = runtimeId(runtime);

    if (runtime?.enabled === false) {
      report(previewLine, 'SKIPPED', `${label} is switched off`);
      continue;
    }

    const since = Date.now();
    /** @type {any} */
    const outcome = await app.post(`/devices/${id}/preview`, {})
      .catch((/** @type {any} */ error) => ({ error: messageOf(error) }));

    if (outcome?.error) {
      report(previewLine, 'FAILED', `${label}: preview was refused: ${outcome.error}`);
      continue;
    }
    /**
     * Writing to NO lamp is the correct answer when no lamp is on.
     *
     * A circadian or Curve light never switches a light on — it writes colour,
     * and only to lights already on (platform §12). So `writes: 0, skipped: 1`
     * against an off lamp is the app obeying its central promise, and calling
     * that a failure is the harness asserting an absolute whose precondition it
     * never checked. Reported SKIPPED with the reason, exactly as `rejoin` does.
     */
    let lampsOn = /** @type {any[]} */ (runtime?.targets ?? []).filter(t => t?.on === true);

    if (outcome?.writes === 0 && lampsOn.length === 0) {
      // Ask rather than skip: with every lamp off there is nothing to write to,
      // and the reader cannot act on that without being told which lamps.
      if (await askForALampOn(/** @type {string[]} */ (runtime?.targetNames ?? []), label)) {
        /** @type {any} */
        const retried = await app.post(`/devices/${id}/preview`, {})
          .catch((/** @type {any} */ error) => ({ error: messageOf(error) }));
        /** @type {any} */
        const fresh = await app.get('/diagnostics');
        const now = /** @type {any[]} */ (fresh?.circadian ?? []).find(c => runtimeId(c) === id);
        lampsOn = /** @type {any[]} */ (now?.targets ?? []).filter(t => t?.on === true);

        if (retried?.writes > 0) {
          report(previewLine, 'OK',
            `${label}: "Try it now" wrote to ${retried.writes} lamp(s), `
            + `skipped ${retried.skipped}`);
          continue;
        }
      }

      report(previewLine, 'SKIPPED',
        `${label}: none of its ${runtime?.targets?.length ?? 0} lamp(s) is on, so there was `
        + 'nothing to write to');
      continue;
    }

    report(previewLine, outcome?.writes > 0 ? 'OK' : 'FAILED',
      `${label}: "Try it now" wrote to ${outcome?.writes} lamp(s), skipped ${outcome?.skipped}`
      + (outcome?.writes === 0
        ? ` — but ${lampsOn.length} lamp(s) ARE on, so it should have written`
        : ''));

    // T28 / T27: what each lamp was written, and whether it took. A lamp that
    // can do colour should have been given hue; one that cannot should have been
    // given the point's warmth instead, so the shape of the day is the same on
    // every lamp.
    /** @type {any} */
    const after = await app.get('/diagnostics');
    const mine = /** @type {any[]} */ (after?.circadian ?? []).find(c => runtimeId(c) === id);
    const writes = /** @type {any[]} */ (mine?.recentWrites ?? [])
      .filter(w => Number(w?.at) >= since && w?.ok !== false && String(w?.capability) !== 'onoff');

    if (writes.length === 0) {
      // Only a contradiction if the preview claimed to have written something.
      report(kind === 'curve' ? 'T28' : 'T21', outcome?.writes > 0 ? 'FAILED' : 'SKIPPED',
        outcome?.writes > 0
          ? `${label}: the preview reported ${outcome.writes} write(s) but the runtime `
            + 'recorded none'
          : `${label}: nothing was written, so there is nothing to read back`);
      continue;
    }

    /** @type {string[]} */
    const mismatches = [];
    /** @type {Set<string>} */
    const capabilities = new Set();
    for (const write of writes) {
      capabilities.add(String(write.capability));
      // An enabler is judged by whether the value it enables landed, not by
      // whether the lamp echoes the enabler back.
      if (ENABLER_CAPABILITIES.has(String(write.capability))) continue;
      const held = await capabilityValue(api, String(write.deviceId), String(write.capability));
      const wanted = Number(write.value);
      const actual = Number(held);
      const matches = Number.isFinite(wanted) && Number.isFinite(actual)
        ? Math.abs(wanted - actual) <= LAMP_TOLERANCE
        : held === write.value;
      if (!matches) {
        mismatches.push(`${write.deviceId} ${write.capability}: wrote ${round(write.value)}, `
          + `holds ${round(held)}`);
      }
    }

    report(kind === 'curve' ? 'T28' : 'T21', mismatches.length === 0 ? 'OK' : 'FAILED',
      `${label}: ${writes.length} write(s) across [${[...capabilities].join(', ')}], `
      + (mismatches.length === 0
        ? 'every lamp holds what it was written'
        : `${mismatches.length} did not take — ${mismatches.join('; ')}`));

    if (kind === 'curve' && capabilities.has('light_hue')) {
      // The colour half of T27: a coloured point reached a colour-capable lamp.
      report('T27', 'OK', `${label}: a colour was written (light_hue), and lamps without `
        + 'colour got warmth instead');
    }

    // T22 — pre-staging, proved on this household's own lamps rather than
    // assumed. Both answers are correct; which one this Homey gives is the
    // result.
    /**
     * Switch a lamp OFF so there is something to pre-stage.
     *
     * `probePreStage` needs a target that is off and colour-capable, and by this
     * point the pass has switched them all on — so this line skipped itself on
     * every run, which is a check that never runs dressed as a check that
     * passes. Turning one off is exactly the state the probe is about; it is put
     * back afterwards whatever happens.
     */
    /** @type {any} */
    const beforeProbe = await app.get('/diagnostics');
    const probeRuntime = /** @type {any[]} */ (beforeProbe?.circadian ?? [])
      .find(c => runtimeId(c) === id);
    const anyOff = /** @type {any[]} */ (probeRuntime?.targets ?? [])
      .some(t => t?.on !== true);

    /** @type {any} */
    let switchedOff = null;
    if (!anyOff) {
      const victim = /** @type {any[]} */ (probeRuntime?.targets ?? [])[0];
      if (victim) {
        switchedOff = await api.devices.getDevice({ id: String(victim.id) }).catch(() => null);
        if (switchedOff) {
          await switchedOff.setCapabilityValue({ capabilityId: 'onoff', value: false })
            .catch(() => { switchedOff = null; });
          // The runtime subscribes to onoff; give it a moment to notice.
          if (switchedOff) await sleep(4_000);
        }
      }
    }

    /** @type {any} */
    const probe = await app.post(`/devices/${id}/prestage-test`, {})
      .catch((/** @type {any} */ error) => ({ error: messageOf(error) }));

    if (switchedOff) {
      await switchedOff.setCapabilityValue({ capabilityId: 'onoff', value: true })
        .catch(() => { /* it was on when we found it; say so rather than fail here */ });
    }

    if (probe?.error) {
      report('T22', 'FAILED', `${label}: the pre-stage probe was refused: ${probe.error}`);
    } else if (probe?.deviceId === null) {
      report('T22', 'SKIPPED', `${label}: no lamp was off and colour-capable to probe `
        + `(${probe?.reason ?? 'no reason given'})`);
    } else {
      /**
       * Three outcomes, all of them results.
       *
       * The lamp stayed off; the lamp came on and was put back; or the
       * integration declined the write outright — a Hue Bridge does the last for
       * a lamp it considers "soft off". Only the first means pre-staging works,
       * and none of the three is a fault in the app.
       */
      const how = probe?.stayedOff
        ? 'it stayed off, so pre-staging works on this Homey'
        : probe?.reason
          ? `the integration refused the write, so pre-staging is not available here `
            + `— it said: ${probe.reason}`
          : `it switched itself on, restored=${probe?.restored} — pre-staging is not `
            + 'available here and the app disables it itself';

      report('T22', 'OK', `${label}: probed "${probe?.name ?? probe?.deviceId}" — ${how}`);
    }
  }
}

// ----------------------------------------------------------------- teardown

/**
 * Deleting the devices this pass built, and checking that only the right Flows
 * go with them: T47 to T52.
 *
 * The most destructive thing in this file, and nothing it deletes comes back.
 * Four guards, all of them load-bearing:
 *
 * - it will only ever delete a device whose `driverId` names THIS app AND whose
 *   name still carries the mark, re-read from the Homey immediately before the
 *   delete. A device the user paired is not in the list, and could not survive
 *   the re-check if it somehow were;
 * - it prints what it is LEAVING ALONE as well as what it is deleting;
 * - it prints the whole list and the Flow total before the first delete;
 * - it is never in `all`, and never runs without `--yes`.
 *
 * The order is the plan's own, and the order matters: the two light-driving
 * types go first BECAUSE they own no Flows, so the total must not move — which
 * is only a meaningful check while there are still Flows for it to fail to move.
 *
 * Every Flow total below is OUR total. The user's own Flow-owning devices stay
 * live throughout and reconcile on their own schedule, so a Homey-wide count is
 * no longer a number this can reason about. What the wider set is good for is
 * the opposite assertion, made by id: nothing of theirs went with ours.
 *
 * @param {any} api
 */
async function commandTeardown(api) {
  const all = await lightkeeperDevices(api);
  const devices = all.filter(device => isMarked(device.name));
  const theirs = all.filter(device => !isMarked(device.name));

  if (devices.length === 0) {
    report('T47', 'SKIPPED', `no ${MARKER} device is paired — this pass built nothing to delete`
      + (theirs.length
        ? `; the ${theirs.length} device(s) you paired yourself are, as always, left alone`
        : ''));
    return;
  }

  const flowsAtStart = await managedFlows(api);
  const ourIds = new Set(devices.map(device => device.dataId));
  const installed = new Set(all.map(device => device.dataId));

  /** The only Flows this run may account for: the ones its own devices own. */
  const ourFlowsAtStart = flowsAtStart.filter(flow => ourIds.has(flow.ownerDataId));

  /**
   * Everything else, BY ID rather than by count.
   *
   * A count delta cannot tell "the user's controller reconciled and added one"
   * from "we deleted one of theirs". An id set can: nothing below may remove a
   * Flow whose id is in here, while a Flow ARRIVING mid-teardown is normal and
   * must not fail a line.
   */
  const foreignAtStart = new Set(
    flowsAtStart.filter(flow => !ourIds.has(flow.ownerDataId)).map(flow => flow.flowId));

  /**
   * Flows that already belonged to no installed device — an abandoned run's
   * litter. Still reported, and still the sweep's job, but no longer
   * load-bearing: T52 is now stated over the devices this run actually deleted,
   * so a stray and a live user Flow are both simply "not ours" and neither needs
   * a baseline to be excused.
   */
  const strays = flowsAtStart.filter(flow => !installed.has(flow.ownerDataId));

  report('T47', 'INFO', `${flowsAtStart.length} generated Flow(s) before any deletion, `
    + `${ourFlowsAtStart.length} of them belonging to devices this pass built`
    + (strays.length
      ? `; ${strays.length} already belonged to no installed device`
      : ''));
  note('about to DELETE, permanently:');
  for (const device of devices) note(`  ${device.driver}/${device.name} (${device.dataId})`);
  if (theirs.length > 0) {
    note(`leaving alone, untouched: ${theirs.map(d => `${d.driver}/${d.name}`).join(', ')}`);
  }

  /** The plan's order: the two that own no Flows first. */
  const ORDER = [
    { driver: 'curve', line: 'T48', ownsFlows: false },
    { driver: 'circadian', line: 'T49', ownsFlows: false },
    { driver: 'schedule', line: 'T50', ownsFlows: true },
    { driver: 'controller', line: 'T51', ownsFlows: true },
  ];

  let previous = ourFlowsAtStart.length;
  /** The ids this run actually deleted, which is what T52 is stated over. */
  /** @type {Set<string>} */
  const deleted = new Set();

  for (const step of ORDER) {
    const mine = devices.filter(d => d.driver === step.driver);
    if (mine.length === 0) {
      report(step.line, 'SKIPPED', `no ${step.driver} device built by this pass to delete`);
      continue;
    }

    for (const device of mine) {
      const ownedBefore = ourFlowsAtStart.filter(f => f.ownerDataId === device.dataId).length;

      /**
       * Re-checked immediately before the delete, against the Homey rather than
       * against the list read at the top, and checked for BOTH properties: it is
       * one of this app's devices, and it still carries this pass's mark.
       *
       * The list above is seconds old, the delete is permanent, and the device
       * on the other side of a mistake here may be the only controller in
       * somebody's house. A rename that lands between the two reads takes the
       * device out of this pass's reach, which is the safe direction.
       */
      const live = await api.devices.getDevice({ id: device.homeyId }).catch(() => null);
      if (!live
        || !String(live?.driverId ?? '').includes(APP_ID)
        || !isMarked(String(live?.name ?? ''))) {
        report(step.line, 'FAILED', `refusing to delete ${device.homeyId}: it is not a device `
          + `this pass created (driver "${live?.driverId ?? 'gone'}", `
          + `name "${live?.name ?? 'gone'}")`);
        continue;
      }

      try {
        await api.devices.deleteDevice({ id: device.homeyId });
      } catch (error) {
        report(step.line, 'FAILED', `could not delete ${step.driver} "${device.name}": `
          + messageOf(error));
        continue;
      }
      deleted.add(device.dataId);

      // Deletion cleans Flows up asynchronously, so this waits for the count to
      // settle rather than reading it immediately.
      const expected = step.ownsFlows ? previous - ownedBefore : previous;
      const settled = await waitFor(async () => {
        const now = await managedFlows(api);
        return now.filter(f => ourIds.has(f.ownerDataId)).length === expected ? now : null;
      }, { timeoutMs: 60_000, everyMs: 3_000, what: `our Flow total to reach ${expected}` });

      const now = settled ?? await managedFlows(api);
      const mineNow = now.filter(f => ourIds.has(f.ownerDataId));

      /** Nothing of anybody else's may have gone with it. */
      const collateral = [...foreignAtStart].filter(id => !now.some(f => f.flowId === id));
      if (collateral.length > 0) {
        report(step.line, 'FAILED', `deleting ${step.driver} "${device.name}" also removed `
          + `${collateral.length} Flow(s) belonging to a device this pass did not create`);
      }

      if (step.ownsFlows) {
        // Only ITS Flows, and nothing else's.
        const survivors = mineNow.filter(f => f.ownerDataId === device.dataId);
        report(step.line,
          mineNow.length === expected && survivors.length === 0 && collateral.length === 0
            ? 'OK' : 'FAILED',
          `deleted ${step.driver} "${device.name}": ${previous} → ${mineNow.length} of our `
          + `Flow(s) (expected ${expected}, it owned ${ownedBefore})`
          + (survivors.length ? `, ${survivors.length} of its own left behind` : ''));
      } else {
        // The whole point of these two device types: nothing appears, nothing
        // disappears (platform §12).
        report(step.line,
          mineNow.length === previous && collateral.length === 0 ? 'OK' : 'FAILED',
          `deleted ${step.driver} "${device.name}": ${previous} → ${mineNow.length} of our `
          + 'Flow(s) — '
          + (mineNow.length === previous
            ? 'unchanged, as a device that generates none should be'
            : 'THE TOTAL MOVED, and this device type owns no Flows'));
      }

      previous = mineNow.length;
    }
  }

  /**
   * T52, stated over the devices this run actually deleted.
   *
   * Not "everything except a pre-existing-orphan baseline is gone", which only
   * made sense while teardown emptied the Homey: the user's own live Flows are
   * now legitimately in the total, and demanding zero would accuse this run of
   * leaving behind Flows it must never have touched in the first place.
   */
  const atEnd = await managedFlows(api);
  const left = atEnd.filter(flow => deleted.has(flow.ownerDataId));
  const collateral = [...foreignAtStart].filter(id => !atEnd.some(f => f.flowId === id));

  report('T52', left.length === 0 ? 'OK' : 'FAILED',
    left.length === 0
      ? 'every Flow belonging to a device this run deleted is gone'
        + (strays.length
          ? `; ${strays.length} pre-existing orphan(s) remain, which are the sweep's job`
          : '')
      : `${left.length} Flow(s) left that this run should have removed: `
        + left.map(f => f.name).join(', '));

  report('T52', collateral.length === 0 ? 'OK' : 'FAILED',
    collateral.length === 0
      ? `${foreignAtStart.size} Flow(s) belonging to devices this pass did not create are all `
        + 'still there'
      : `${collateral.length} Flow(s) belonging to a device this pass did not create are GONE`);

  try {
    const app = await appApi(api);
    /** @type {any} */
    const orphans = await app.get('/orphans');
    const orphanedNow = orphans?.orphans ?? 0;
    /**
     * A DELTA, not an absolute. With the user's own Flow-owning devices still
     * live, a non-zero total is a correct end state; what would be wrong is this
     * run having MADE orphans. `refused` means nothing was live to judge
     * against, so the number is not trustworthy and is reported rather than
     * asserted on.
     */
    report('T52', !orphans?.refused && orphanedNow > strays.length ? 'FAILED' : 'INFO',
      `the app reports ${orphans?.total} generated Flow(s), ${orphanedNow} orphaned `
      + `(${strays.length} were already orphaned before this teardown)`
      + (orphans?.refused ? ` (refused: ${orphans.refused})` : ''));
  } catch (error) {
    report('T52', 'SKIPPED', `could not read /orphans: ${messageOf(error)}`);
  }
}

/**
 * Delete Flows left behind by an earlier run, if the app will allow it.
 *
 * Uses the app's own preview-then-sweep, token and all — the sweep refuses a
 * stale preview on purpose, and going round it would be this script asserting a
 * safety property it had just bypassed.
 *
 * @param {any} app
 */
async function sweepStrays(app) {
  /** @type {any} */
  const preview = await app.get('/orphans').catch(() => null);
  if (!preview || preview.refused || (preview.orphans ?? 0) === 0) return;

  try {
    /** @type {any} */
    const swept = await app.post('/orphans', {
      token: preview.token, flowIds: preview.flowIds,
    });
    note(`swept ${swept?.deleted ?? 0} orphaned Flow(s) left by an earlier run`);
  } catch (error) {
    note(`could not sweep ${preview.orphans} orphaned Flow(s): ${messageOf(error)}`);
  }
}

// --------------------------------------------------------------------- pair

/**
 * Build one of each device type, over the Web API.
 *
 * Proven possible by `pairspike` on 28 August 2026 (platform §14), which is what
 * this is built on: `emitPairingEvent` lands on the same `session.setHandler`
 * the pairing screens talk to, so this drives the real handlers with the real
 * payloads. It is the screens' data path without the screens.
 *
 * Covers the setup half of the pass: T5, T6, T7, T12, T13, T19, T20 and T26.
 *
 * WHAT IT IS NOT. It does not prove the SCREENS — those are
 * `test/unit/pair-view-behaviour.test.ts` and `npm run render:views`. A handler
 * that answers correctly while its view draws nothing would pass here.
 *
 * It skips any driver that already has a device, so running it twice does not
 * litter a Homey with duplicates.
 *
 * @param {any} api
 * @param {string} room only take test lamps from this room, or every room when empty
 */
async function commandPair(api, room) {
  const session = await pairSessions(api);
  if (!session) return;

  /** @type {any} */
  let app;
  try {
    app = await appApi(api);
  } catch (error) {
    report('T7', 'SKIPPED', `the app Web API is out of reach: ${messageOf(error)}`);
    return;
  }

  /**
   * Only the devices this pass built, so a controller the USER paired is not
   * read as "already done". It is not, for the purposes of this pass: every
   * command below refuses to touch it, so a run that skipped on the strength of
   * it would report SKIPPED all the way down and prove nothing.
   */
  const existing = await ourDevices(api);
  const lights = await pickLights(session, room);
  if (!lights) return;

  /** Build order matches the plan's: the key-holding types first. */
  const PLAN = [
    { driver: 'controller', line: 'T7', build: buildController },
    { driver: 'schedule', line: 'T13', build: buildSchedule },
    { driver: 'circadian', line: 'T20', build: buildCircadian },
    { driver: 'curve', line: 'T26', build: buildCurve },
  ];

  for (const step of PLAN) {
    const reusable = existing.find(d => d.driver === step.driver);
    if (reusable) {
      report(step.line, 'SKIPPED', `a ${step.driver} from an earlier run is still here `
        + `("${reusable.name}") — reusing it rather than building a second. `
        + 'Run `teardown --yes` first if you want it rebuilt');
      continue;
    }

    const driverId = session.idOf(step.driver);
    if (!driverId) {
      report(step.line, 'FAILED', `no ${step.driver} driver on this Homey`);
      continue;
    }

    /** @type {any} */
    let open = null;
    try {
      open = await session.open(driverId);
      const built = await step.build(session, open, lights);
      if (!built) continue;

      const dto = withManifest(built, step.driver);
      const device = await session.finish(api, open, dto);
      if (!device) {
        report(step.line, 'FAILED',
          `${step.driver} "${dto.name}" never appeared in getDevices`);
        continue;
      }

      /**
       * A device that EXISTS is not a device that WORKS, and the gap between
       * them is where this check used to live.
       *
       * Homey creates a device `available`, then runs `onInit`; if that throws,
       * it goes unavailable afterwards with the error's message. Reading
       * `available` straight after creation therefore catches the window before
       * init has finished and reports OK for a device that is about to break —
       * which is exactly what happened: three devices reported `available=true`
       * here and were sitting unavailable in the app minutes later, with
       * `Cannot read properties of null (reading 'get')` on their tiles.
       *
       * The honest signal is the app's OWN registry. A runtime appears there
       * only once `start()` has resolved, so waiting for it means waiting for
       * the device to have actually initialised.
       */
      const registered = await waitFor(async () => {
        /** @type {any} */
        const status = await app.get('/').catch(() => null);
        const all = [
          .../** @type {any[]} */ (status?.controllers ?? []),
          .../** @type {any[]} */ (status?.schedules ?? []),
          .../** @type {any[]} */ (status?.circadian ?? []),
        ];
        return all.find(entry => runtimeId(entry) === device.dataId) ?? null;
      }, {
        timeoutMs: 60_000, everyMs: 3_000,
        what: `the app to register a runtime for "${device.name}"`,
      });

      if (!registered) {
        // Re-read, because the message only arrives once init has failed.
        const now = await api.devices.getDevice({ id: device.homeyId }).catch(() => null);
        report(step.line, 'FAILED',
          `${step.driver} "${device.name}" was created but the app never registered a `
          + `runtime for it — it did not initialise. Homey says: `
          + `"${now?.unavailableMessage ?? '(no message)'}"`);
        continue;
      }

      report(step.line, 'OK',
        `built ${step.driver} "${device.name}" — the app reports it ${registered.state}`);

      /**
       * Wait for the Flows before moving on, for the two types that own any.
       *
       * A device appears the moment it is created; its Flows arrive at the first
       * reconcile, which is asynchronous. `full` runs `flows` straight after
       * this, so without the wait that command reads a controller with no Flows
       * yet and reports T8 FAILED — a race in the harness, dressed up as a
       * fault in the app.
       */
      if (device && FLOW_OWNING_DRIVERS.includes(step.driver)) {
        const settled = await waitFor(async () => {
          const flows = await managedFlows(api);
          return flows.some(f => f.ownerDataId === device.dataId) ? flows : null;
        }, {
          timeoutMs: 120_000, everyMs: 5_000,
          what: `${step.driver} "${device.name}" to generate its Flows`,
        });
        if (!settled) {
          report(step.line, 'FAILED', `${step.driver} "${device.name}" generated no Flows `
            + 'within 120s — check the API key is valid (platform §1)');
        }
      }
    } catch (error) {
      report(step.line, 'FAILED', `${step.driver}: ${messageOf(error)}`);
    } finally {
      if (open) await session.close(open);
    }
  }

  /**
   * Clear orphaned Flows from earlier runs, now that devices are live again.
   *
   * `teardown` cannot be relied on to: whether anything Flow-owning is left
   * when it finishes now depends on whether the USER happens to own a controller
   * or a schedule, and the sweep refuses when nothing is live by design — every
   * managed Flow would look orphaned. A sweep that works on one Homey and
   * refuses on the next is not a sweep. So the litter from one run survives into
   * the next, and it is not inert. This script names a schedule after the lamp it picked, so
   * a dead schedule's Flows land in the folder the NEW schedule wants, and
   * `renameIfOurs` then correctly declines to rename a folder holding another
   * device's Flows. A rename check failed for exactly that reason.
   *
   * Swept AFTER the devices are built, which is the one moment in a run when
   * something is live to sweep against.
   */
  await sweepStrays(app);
}

/**
 * The pair-session plumbing, in one place.
 *
 * Driver ids are ENUMERATED, never built — `homey:app:<appId>:<driver>`, and
 * assembling that string by hand is what platform §3 is about.
 *
 * @param {any} api
 */
async function pairSessions(api) {
  const drivers = api.drivers;
  if (!drivers || typeof drivers.createPairSession !== 'function') {
    report('-', 'FAILED', 'this homey-api build exposes no pair-session surface');
    return null;
  }

  const installed = Object.values(/** @type {any} */ (await drivers.getDrivers()));
  /** @type {Map<string, string>} */
  const byShortName = new Map();
  for (const driver of /** @type {any[]} */ (installed)) {
    const id = String(driver?.id ?? '');
    if (!id.includes(APP_ID)) continue;
    byShortName.set(id.split(':').pop() ?? '', id);
  }

  if (byShortName.size === 0) {
    report('-', 'FAILED', `no driver id contains "${APP_ID}" — is the app installed?`);
    return null;
  }

  return {
    /** @param {string} shortName */
    idOf: (shortName) => byShortName.get(shortName) ?? null,

    /** @param {string} driverId @param {string} [deviceId] */
    open: async (driverId, deviceId) => withTimeout(
      drivers.createPairSession({
        pairsession: {
          // 'repair' carries the device it is repairing; 'pair' does not.
          type: deviceId ? 'repair' : 'pair',
          driverId,
          ...(deviceId ? { deviceId } : {}),
        },
      }),
      30_000, `createPairSession for ${driverId}`),

    /** @param {any} open @param {string} event @param {unknown} [data] */
    emit: (open, event, data) => withTimeout(
      drivers.emitPairingEvent({ id: String(open.id), event, data }),
      45_000, `emit "${event}"`),

    /**
     * `createDevice` then `add_device`, then wait for it to actually exist.
     *
     * Both calls, in that order, because staging a device is not adding one —
     * the pairing views carry the same two-step and the same comment.
     *
     * @param {any} client @param {any} open @param {any} dto
     */
    finish: async (client, open, dto) => {
      await withTimeout(
        drivers.createPairSessionDevice({ id: String(open.id), device: dto }),
        30_000, 'createPairSessionDevice');
      await withTimeout(
        drivers.emitPairingEvent({ id: String(open.id), event: 'add_device', data: dto }),
        30_000, 'emit "add_device"').catch(() => undefined);

      return waitFor(async () => {
        const all = await lightkeeperDevices(client);
        return all.find(d => d.dataId === String(dto?.data?.id)) ?? null;
      }, { timeoutMs: 90_000, everyMs: 3_000, what: `"${dto?.name}" to appear` });
    },

    /** @param {any} open */
    close: async (open) => {
      try {
        await drivers.deletePairSession({ id: String(open.id) });
      } catch {
        // A session the Homey has already reaped is not a failure to report.
      }
    },
  };
}

/**
 * Which lamps each device type gets, from one room if one is named.
 *
 * Deliberately ONE lamp each, and different lamps where the Homey has enough of
 * them. A controller, a schedule, a circadian light and a Curve light all
 * pointed at the same lamp is a documented disagreement — the schedule sets a
 * warmth at its boundary and the curve overwrites it within minutes — and a
 * pass that builds that on purpose spends the rest of its run explaining it.
 *
 * Warmth-capable lamps go to the two curve-driven types, which have nothing to
 * write without one.
 *
 * @param {any} session
 * @param {string} room only lamps in this room, or every room when empty
 */
async function pickLights(session, room) {
  const driverId = session.idOf('circadian');
  if (!driverId) {
    report('-', 'FAILED', 'no circadian driver to ask for the light list');
    return null;
  }

  /** @type {any} */
  let open = null;
  try {
    open = await session.open(driverId);
    /** @type {any} */
    const targets = await session.emit(open, 'listTargets');
    const rooms = /** @type {any[]} */ (targets?.rooms ?? []);

    const wanted = room
      ? rooms.filter(candidate => String(candidate?.zoneName ?? '') === room)
      : rooms;

    if (room && wanted.length === 0) {
      report('-', 'FAILED', `no room called "${room}" has lights this app can drive. `
        + `Rooms offered: ${rooms.map(r => r.zoneName).join(', ')}`);
      return null;
    }

    const all = wanted
      .flatMap(candidate => /** @type {any[]} */ (candidate?.lights ?? []))
      .filter(light => light?.available !== false);

    if (all.length === 0) {
      report('-', 'FAILED', room
        ? `"${room}" has no available lights to point anything at`
        : 'this Homey offers no available lights to point anything at');
      return null;
    }
    report('T6', 'OK', `the light picker offered ${rooms.length} room(s); using `
      + `${all.length} light(s) from ${room ? `"${room}"` : 'all of them'}`);

    const warm = all.filter(l => (l?.capabilities ?? []).includes('light_temperature'));
    const rest = all.filter(l => !warm.includes(l));
    // Warmth-capable first, so `circadian` and `curve` get one if any exist.
    const ordered = [...warm, ...rest];

    /** @param {number} index */
    const at = (index) => ordered[Math.min(index, ordered.length - 1)];
    const chosen = {
      circadian: at(0), curve: at(1), schedule: at(2), controller: at(3),
    };
    note('lamps chosen: ' + Object.entries(chosen)
      .map(([kind, light]) => `${kind}=${light.name}`).join(', '));

    if (warm.length === 0) {
      report('-', 'INFO', 'no lamp on this Homey reports light_temperature — the circadian '
        + 'and Curve lights will have nothing to write');
    }
    return chosen;
  } catch (error) {
    report('-', 'FAILED', `could not read the light list: ${messageOf(error)}`);
    return null;
  } finally {
    if (open) await session.close(open);
  }
}

/** @param {any} light */
const targetOfLight = (light) => ({ kind: 'devices', deviceIds: [String(light.id)] });

/**
 * The device DTO, plus everything the driver's manifest declares about it.
 *
 * A pair VIEW sends only `{ name, data, store }` and the platform fills the rest
 * in from the manifest. Over the Web API that is not safe to assume: three
 * devices built this way came up with `Cannot read properties of null (reading
 * 'get')` on their tiles and no runtime in the app, while the same three types
 * paired by hand were fine — and the only thing the three had in common, and the
 * controller did not, was a `capabilitiesOptions` block.
 *
 * `createPairSessionDevice` takes all of these explicitly, so they are sent
 * explicitly. It is the same rule the driver id taught (platform §3, §14): where
 * the manifest already says something exactly, echo it rather than hoping
 * something downstream infers it.
 *
 * Read from `driver.compose.json` rather than `app.json`, because that is the
 * source the manifest is generated FROM — `app.json` is a build artefact and can
 * be a regeneration behind.
 *
 * @param {any} dto the `{ name, data, store }` a driver's `save` returned
 * @param {string} driver short driver name — `circadian`, `schedule`, …
 */
function withManifest(dto, driver) {
  const path = join(here, '..', 'drivers', driver, 'driver.compose.json');
  if (!existsSync(path)) {
    note(`no driver.compose.json for "${driver}" — sending the DTO as the view would`);
    return dto;
  }

  /** @type {any} */
  const manifest = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));

  return {
    ...dto,
    // Only what the endpoint accepts, and only what the manifest actually
    // declares — an explicit `undefined` is not better than an absent field.
    ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
    ...(manifest.capabilitiesOptions
      ? { capabilitiesOptions: manifest.capabilitiesOptions } : {}),
    ...(manifest.class ? { class: manifest.class } : {}),
    ...(manifest.energy ? { energy: manifest.energy } : {}),
  };
}

/**
 * A controller: pick the remote with the most events, map what it offers.
 *
 * @param {any} session @param {any} open @param {any} lights
 */
async function buildController(session, open, lights) {

  /** @type {any} */
  const status = await session.emit(open, 'getCredentialStatus');
  // T12's other half, one screen earlier: a key already stored must not be
  // asked for again.
  report('T5', status?.valid === true ? 'OK' : 'FAILED',
    `the stored key is ${status?.valid ? 'recognised' : `NOT valid (${status?.failure})`} — `
    + 'the setup screen would let a user straight through');

  /** @type {any} */
  const sources = await session.emit(open, 'listSources');
  const candidates = /** @type {any[]} */ (sources?.rooms ?? [])
    .flatMap(room => /** @type {any[]} */ (room?.devices ?? []))
    .filter(d => (d?.eventCount ?? 0) > 0)
    .sort((a, b) => (b.eventCount ?? 0) - (a.eventCount ?? 0));

  if (candidates.length === 0) {
    report('T7', 'SKIPPED', 'no device on this Homey exposes any trigger events, so there '
      + 'is no remote to build a controller from');
    return null;
  }

  /**
   * Try candidates in turn, rather than betting on the first.
   *
   * The two "event counts" are not the same number and the difference is the
   * whole reason this loop exists. `listSources` reports how many candidate
   * CARDS a device has, from `rankSources`; `selectSource` reports how many
   * usable INPUTS survived normalisation. A device can rank top on the first and
   * yield zero of the second — the first run of this command picked a dishwasher
   * with twelve cards and no usable input, then gave up as though the Homey had
   * no remotes at all.
   *
   * There is deliberately no cleverness about which devices "look like" remotes:
   * `lib/pairing/source-list.ts` says why a guess at the top of that list is
   * worse than an honest one, and the same applies here. Ask each in turn and
   * believe the answer.
   */
  const MAX_TRIES = 8;
  /** @type {any} */
  let remote = null;
  /** @type {any} */
  let picked = null;
  /** @type {string[]} */
  const rejected = [];

  for (const candidate of candidates.slice(0, MAX_TRIES)) {
    /** @type {any} */
    const answer = await session.emit(open, 'selectSource', String(candidate.id));
    if (answer?.usable !== false && (answer?.controls?.length ?? 0) > 0) {
      remote = candidate;
      picked = answer;
      break;
    }
    rejected.push(`${candidate.name} (${candidate.eventCount} card(s), no usable input)`);
  }

  if (!remote) {
    report('T7', 'SKIPPED', `none of ${rejected.length} candidate(s) exposes an event this `
      + `app can use: ${rejected.join('; ')}`);
    return null;
  }
  if (rejected.length > 0) note(`skipped: ${rejected.join('; ')}`);
  note(`remote chosen: "${remote.name}" — ${picked.eventCount} usable input(s) across `
    + `${picked.controls.length} control(s)`);

  await session.emit(open, 'selectTargets', targetOfLight(lights.controller));

  /** @type {any} */
  const mapping = await session.emit(open, 'getMapping');
  const offered = /** @type {any[]} */ (mapping?.functions ?? []);
  const inputs = /** @type {any[]} */ (mapping?.controls ?? [])
    .flatMap(control => /** @type {any[]} */ (control?.inputs ?? []));

  if (offered.length === 0 || inputs.length === 0) {
    report('T7', 'FAILED', `the mapping screen offered ${offered.length} function(s) and `
      + `${inputs.length} gesture(s) — nothing to map`);
    return null;
  }
  // T6: the gestures must be THIS remote's, which is what a non-empty list off
  // `selectSource` means — a generic list would not depend on the pick above.
  report('T6', 'OK', `"${remote.name}" offered ${inputs.length} gesture(s) and `
    + `${offered.length} function(s) for these lamps`);

  /**
   * One rule per gesture, which is the app's own rule — so this pairs at most
   * as many functions as the remote has distinct gestures, never reusing one.
   */
  const rules = offered.slice(0, Math.min(3, inputs.length)).map((fn, index) => ({
    id: `__all__-${fn.function}`,
    function: fn.function,
    inputKey: inputs[index].key,
    groupKey: '__all__',
  }));

  /** @type {any} */
  const saved = await session.emit(open, 'setRules', rules);
  report('T7', saved?.count === rules.length ? 'OK' : 'FAILED',
    `${saved?.count} of ${rules.length} rule(s) accepted: `
    + rules.map(r => `${r.function}=${r.inputKey}`).join(', '));

  return dtoFrom(await session.emit(open, 'save', ''));
}

/** @param {any} session @param {any} open @param {any} lights */
async function buildSchedule(session, open, lights) {

  /** @type {any} */
  const status = await session.emit(open, 'getCredentialStatus');
  report('T12', status?.valid === true ? 'OK' : 'FAILED',
    `the schedule's setup screen sees the saved key as valid=${status?.valid} — `
    + 'no retyping');

  await session.emit(open, 'selectTargets', targetOfLight(lights.schedule));
  await session.emit(open, 'getSchedule');

  // A window well away from now, so building the pass does not switch anybody's
  // lights on. `schedule` fires its boundaries deliberately, later.
  /** @type {any} */
  const saved = await session.emit(open, 'setSchedules', [
    { id: 'vh1', onAt: 20 * 60, days: null, end: { kind: 'duration', minutes: 120 } },
  ]);
  report('T13', saved?.count === 1 ? 'OK' : 'FAILED',
    `${saved?.count} window accepted, ${saved?.dropped?.length ?? 0} dropped`);

  return dtoFrom(await session.emit(open, 'save', ''));
}

/** @param {any} session @param {any} open @param {any} lights */
async function buildCircadian(session, open, lights) {

  // T19: no credential handler exists on this driver at all, so a screen cannot
  // ask for a key even by accident (platform §12).
  report('T19', 'OK', 'the circadian driver exposes no credential handler — it goes '
    + 'straight to the light picker');

  await session.emit(open, 'selectTargets', targetOfLight(lights.circadian));

  /** @type {any} */
  const ends = await session.emit(open, 'getEnds');
  report('T20', ends?.warmest && ends?.coolest ? 'OK' : 'FAILED',
    `both ends offered, over a shape of ${ends?.shape?.length ?? 0} point(s)`);

  await session.emit(open, 'setEnds', {
    warmest: ends?.warmest, coolest: ends?.coolest,
    adjustBrightness: false, preStage: false,
  });

  return dtoFrom(await session.emit(open, 'save', ''));
}

/** @param {any} session @param {any} open @param {any} lights */
async function buildCurve(session, open, lights) {

  report('T26', 'OK', 'the Curve driver exposes no credential handler either');

  await session.emit(open, 'selectTargets', targetOfLight(lights.curve));

  /** @type {any} */
  const curve = await session.emit(open, 'getCurve');
  const points = /** @type {any[]} */ (curve?.points ?? []);
  const palette = /** @type {any[]} */ (curve?.palette ?? []);

  if (points.length === 0) {
    report('T26', 'FAILED', 'the curve screen offered no default points');
    return null;
  }

  /**
   * One point is given a COLOUR, because that is the only thing the Curve light
   * adds over the circadian one — and `preview` checks later that a
   * colour-capable lamp actually received it.
   */
  const coloured = points.map((point, index) => ({
    ...point,
    ...(index === 0 && palette[0] ? { color: palette[0].id } : {}),
  }));

  /** @type {any} */
  const saved = await session.emit(open, 'setCurve', {
    points: coloured, adjustBrightness: false, preStage: false,
  });
  report('T26', saved?.count === coloured.length ? 'OK' : 'FAILED',
    `${saved?.count} of ${coloured.length} point(s) accepted`
    + (palette[0] ? `, one carrying the colour "${palette[0].id}"` : ', no palette offered')
    + (saved?.dropped?.length ? ` — dropped: ${saved.dropped.map((/** @type {any} */ d) => d.reason).join('; ')}` : ''));

  return dtoFrom(await session.emit(open, 'save', ''));
}

/**
 * The device DTO out of a `save`, marked as ours, or null with a reason.
 *
 * The one function every device this script creates passes through, which is why
 * the mark goes on HERE rather than in each of the four builders: a fifth driver
 * cannot be added without inheriting it.
 *
 * The name is PREFIXED rather than replaced, and the driver is still asked to
 * derive one (the builders all send an empty name to `save`). Sending a name in
 * would work — every driver does `name || await this.deriveName(state)` — but it
 * would quietly drop lib/pairing/derive-name.ts from what this pass exercises on
 * hardware, which is coverage currently had for free.
 *
 * @param {any} saved
 */
function dtoFrom(saved) {
  if (saved?.updated) return null;
  if (!saved?.created || !saved?.device?.data?.id) {
    report('-', 'FAILED', `save returned no device: ${JSON.stringify(saved).slice(0, 200)}`);
    return null;
  }
  const derived = String(saved.device.name ?? '');
  note(`the driver derived the name "${derived}"; pairing it as "${markName(derived)}"`);
  return { ...saved.device, name: markName(derived) };
}

// ------------------------------------------------------------------- repair

/**
 * T46 — open a repair session on every device type and check its handlers answer.
 *
 * Repair differs from pairing in exactly one way that matters: `onRepair` seeds
 * the session from the device's stored plan, where `onPair` starts empty. So
 * what this checks is that each screen comes back holding the device's OWN
 * values rather than defaults — a repair that silently offered a blank form
 * would lose somebody's mapping the moment they saved.
 *
 * Nothing is saved. The session is opened, read, and closed.
 *
 * @param {any} api
 */
async function commandRepair(api) {
  const session = await pairSessions(api);
  if (!session) return;

  /**
   * Ours only, for two reasons. A repair session on somebody's real device is a
   * write surface opened on a configuration this pass did not make — and the
   * `seeded()` predicates below demand at least one rule and at least one
   * window, so a user's legitimately empty controller would report T46 FAILED
   * against the app for a configuration that is perfectly valid.
   */
  const devices = await ourDevices(api);
  if (devices.length === 0) {
    report('T46', 'SKIPPED', `no device built by this pass to repair — ${NOTHING_OF_OURS}`);
    return;
  }

  /**
   * What each type's screens should hand back, and what proves it is SEEDED
   * rather than blank.
   *
   * @type {Record<string, Array<{ event: string, seeded: (reply: any) => boolean }>>}
   */
  const READS = {
    controller: [
      { event: 'getCredentialStatus', seeded: (r) => r?.present === true },
      { event: 'listTargets', seeded: (r) => r?.current != null },
      { event: 'getMapping', seeded: (r) => (r?.rules?.length ?? 0) > 0 },
    ],
    schedule: [
      { event: 'getCredentialStatus', seeded: (r) => r?.present === true },
      { event: 'listTargets', seeded: (r) => r?.current != null },
      { event: 'getSchedule', seeded: (r) => (r?.entries?.length ?? 0) > 0 },
    ],
    circadian: [
      { event: 'listTargets', seeded: (r) => r?.current != null },
      { event: 'getEnds', seeded: (r) => r?.warmest != null && r?.coolest != null },
    ],
    curve: [
      { event: 'listTargets', seeded: (r) => r?.current != null },
      { event: 'getCurve', seeded: (r) => (r?.points?.length ?? 0) > 0 },
    ],
  };

  for (const device of devices) {
    const driverId = session.idOf(device.driver);
    const reads = /** @type {any} */ (READS)[device.driver];
    if (!driverId || !reads) {
      report('T46', 'SKIPPED', `no repair plan for driver "${device.driver}"`);
      continue;
    }

    /** @type {any} */
    let open = null;
    try {
      open = await session.open(driverId, device.homeyId);

      /** @type {string[]} */
      const blank = [];
      for (const read of reads) {
        const answer = await session.emit(open, read.event);
        if (!read.seeded(answer)) blank.push(read.event);
      }

      report('T46', blank.length === 0 ? 'OK' : 'FAILED',
        `repair ${device.driver} "${device.name}": ${reads.length} screen(s) answered`
        + (blank.length === 0
          ? ', each carrying this device\'s own values'
          : ` — ${blank.join(', ')} came back EMPTY, which would lose this device's setup on save`));
    } catch (error) {
      // The failure this section exists for used to look like this, one layer
      // up: `unknown_error_getting_file` before any screen rendered.
      report('T46', 'FAILED', `repair ${device.driver} "${device.name}": ${messageOf(error)}`);
    } finally {
      if (open) await session.close(open);
    }
  }
}

// ---------------------------------------------------------------- pairspike

/**
 * Can a script drive a PAIRING session over the Web API?
 *
 * This file used to state, and `docs/hardware-test-plan.md` with it, that it
 * "cannot pair devices — Homey's pair sessions are not an API surface". That
 * claim was never sourced, and it is not what ships:
 * `node_modules/homey-api/assets/specifications/HomeyAPIV3Local.json` gives
 * `ManagerDrivers` a full `/pairsession` surface — `createPairSession`,
 * `emitPairingEvent`, `createPairSessionDevice` — which is a client-side mirror
 * of exactly what a pair view calls. `emitPairingEvent({event, data})` is
 * `Homey.emit(event, data)`, and it lands on the same `session.setHandler(event)`
 * in our own driver.
 *
 * If that works, most of the pairing pass stops being a manual job. It is unproven on this
 * firmware and there are real unknowns, so this command exists to settle it
 * rather than to be built on:
 *
 * - does `type` take 'pair'? (and later, 'repair')
 * - does a Personal API Key carry `homey.device`, which the endpoints require?
 * - does a session created outside the mobile app stay alive without heartbeats?
 * - does `createPairSessionDevice` + `add_device` produce a real device?
 *
 * The circadian driver is the subject deliberately: it is the one with no
 * credential screen and no Flows, so a spike that half-works leaves nothing to
 * clean up but one device, which this deletes itself.
 *
 * Whatever this prints, WRITE IT DOWN in docs/homey-platform.md — a negative is
 * worth as much as a positive here, and the current claim is neither.
 *
 * @param {any} api
 */
async function commandPairSpike(api) {
  const drivers = api.drivers;
  if (!drivers || typeof drivers.createPairSession !== 'function') {
    report('-', 'FAILED', 'this homey-api build exposes no createPairSession — '
      + 'the pair-session surface is not there to test');
    return;
  }

  /**
   * The driver id is ENUMERATED, never built.
   *
   * The first version of this command constructed it as `<appId>:circadian` and
   * got `Not Found: Driver with ID com.thomassidor.lightkeeper:circadian` — which
   * reads like the endpoint refusing us and is nothing of the sort. It is the
   * same mistake platform §3 records about flow card URIs, one resource type
   * along: a Homey id has a shape this repo does not get to decide, and the only
   * safe id is the one the Homey just handed over.
   */
  const installed = Object.values(/** @type {any} */ (await drivers.getDrivers()));
  const ours = /** @type {any[]} */ (installed)
    .filter(d => String(d?.id ?? '').includes(APP_ID));

  if (ours.length === 0) {
    report('-', 'FAILED', `no driver id contains "${APP_ID}". `
      + `Ids on this Homey look like: ${/** @type {any[]} */ (installed).slice(0, 3)
        .map(d => d?.id).join(', ')}`);
    return;
  }
  // Recorded whatever happens next: the shape of these ids is the thing this
  // command exists to find out, and it is documented nowhere.
  report('-', 'INFO', `Lightkeeper driver ids: ${ours.map(d => d.id).join(', ')}`);

  const circadian = ours.find(d => String(d.id).endsWith(':circadian'));
  if (!circadian) {
    report('-', 'FAILED', 'no circadian driver among them');
    return;
  }
  const driverId = String(circadian.id);

  // A light to point it at. Anything with onoff will do: nothing here writes to
  // it, and the device is deleted at the end.
  const devices = Object.values(/** @type {any} */ (await api.devices.getDevices()));
  const lamp = /** @type {any[]} */ (devices).find(d =>
    !String(d?.driverId ?? '').includes(APP_ID)
    && Array.isArray(d?.capabilities) && d.capabilities.includes('onoff'));
  if (!lamp) {
    report('-', 'SKIPPED', 'no non-Lightkeeper light with onoff to point a test device at');
    return;
  }

  /** @type {any} */
  let session = null;
  /** @type {string | null} */
  let createdDeviceId = null;

  try {
    session = await withTimeout(
      drivers.createPairSession({ pairsession: { type: 'pair', driverId } }),
      30_000, 'createPairSession');
    const sessionId = String(session?.id ?? '');
    if (!sessionId) {
      report('-', 'FAILED', 'createPairSession returned no id');
      return;
    }
    report('-', 'OK', `createPairSession accepted type "pair" for ${driverId}`);

    /** @param {string} event @param {unknown} [data] */
    const emit = (event, data) => withTimeout(
      drivers.emitPairingEvent({ id: sessionId, event, data }), 30_000, `emit "${event}"`);

    // The one that matters most: does an emit reach OUR handler at all?
    /** @type {any} */
    const targets = await emit('listTargets');
    const rooms = /** @type {any[]} */ (targets?.rooms ?? []);
    const offered = rooms.reduce((sum, room) => sum + (room?.lights?.length ?? 0), 0);
    report('-', rooms.length > 0 ? 'OK' : 'FAILED',
      `emitPairingEvent reaches the driver: listTargets answered with ${offered} light(s) `
      + `in ${rooms.length} room(s)`);
    if (rooms.length === 0) return;

    /** @type {any} */
    const summary = await emit('selectTargets', { kind: 'devices', deviceIds: [String(lamp.id)] });
    report('-', summary?.count === 1 ? 'OK' : 'FAILED',
      `selectTargets validated against the catalogue: count=${summary?.count}`);

    /** @type {any} */
    const ends = await emit('getEnds');
    report('-', ends?.warmest && ends?.coolest ? 'OK' : 'FAILED',
      `getEnds answered with both ends and a shape of ${ends?.shape?.length ?? 0} point(s)`);

    /** @type {any} */
    const set = await emit('setEnds', {
      warmest: ends?.warmest, coolest: ends?.coolest, adjustBrightness: false, preStage: false,
    });
    report('-', Array.isArray(set?.corrected) ? 'OK' : 'FAILED',
      `setEnds round-tripped, corrected ${set?.corrected?.length ?? 0} field(s)`);

    /** @type {any} */
    const saved = await emit('save', markName('pair spike'));
    const dto = saved?.device;
    if (!saved?.created || !dto?.data?.id) {
      report('-', 'FAILED', `save did not return a device DTO: ${JSON.stringify(saved).slice(0, 200)}`);
      return;
    }
    report('-', 'OK', `save built a device DTO with data.id ${dto.data.id}`);

    await withTimeout(
      drivers.createPairSessionDevice({ id: sessionId, device: dto }), 30_000, 'createPairSessionDevice');
    await emit('add_device');
    report('-', 'OK', 'createPairSessionDevice + add_device were accepted');

    // The proof: a real device, from a script, with no phone involved.
    const found = await waitFor(async () => {
      const all = await lightkeeperDevices(api);
      return all.find(d => d.dataId === String(dto.data.id)) ?? null;
    }, { timeoutMs: 60_000, everyMs: 3_000, what: 'the paired device to appear' });

    if (!found) {
      report('-', 'FAILED', 'the device never appeared in getDevices — the session was accepted '
        + 'but nothing was created');
      return;
    }
    createdDeviceId = found.homeyId;
    report('-', found.available ? 'OK' : 'FAILED',
      `PAIRING OVER THE API WORKS: "${found.name}" exists and is `
      + `${found.available ? 'available' : 'UNAVAILABLE'}`);
  } catch (error) {
    // The interesting failure. Print it plainly — this is the whole result.
    report('-', 'FAILED', `the pair-session surface refused: ${messageOf(error)}`);
  } finally {
    // Leave nothing behind, whichever way it went.
    if (createdDeviceId) {
      try {
        await api.devices.deleteDevice({ id: createdDeviceId });
        note('the spike device was deleted');
      } catch (error) {
        report('-', 'FAILED', `could not delete the spike device ${createdDeviceId}: `
          + `${messageOf(error)} — remove it by hand`);
      }
    }
    if (session?.id) {
      try {
        await drivers.deletePairSession({ id: String(session.id) });
      } catch {
        // A session the Homey has already reaped is not a failure to report.
      }
    }
  }
}

// --------------------------------------------------------------------- main

const READ_ONLY = ['spike', 'memory', 'flows', 'redaction'];
const DESTRUCTIVE = [
  'credential', 'rejoin', 'pairspike', 'restart', 'bridge', 'schedule', 'preview',
  'pair', 'repair', 'teardown',
];

/**
 * The whole pass, in the order the plan's own sections run.
 *
 * `teardown` is last because nothing after it would have a device to look at,
 * and `credential` is late because it is the one that leaves the app briefly
 * without a key. `pairspike` is deliberately NOT here: it answers a question
 * about the platform rather than about this release, and it is run once.
 */
const FULL = [
  'spike', 'memory', 'pair', 'flows', 'schedule', 'preview', 'rejoin',
  'restart', 'bridge', 'credential', 'redaction', 'repair', 'teardown',
];

/** Lines no script can reach, printed at the end so a report is complete. */
const STILL_MANUAL = [
  'T3  Add device → Lightkeeper lists four types, with four different pictures',
  'T9  press the mapped button — the lights respond',
  'T10 hold the ramp button — it ramps, and STOPS when you let go, inside 10s',
  'T11 turn the dial — the lights move by a sensible amount, not straight to full',
  'T53 one look at every rendered screen: npm run render:views',
  'T54 anything that read wrong on the device you paired by hand',
];

async function main() {
  const argv = process.argv.slice(2);
  const confirmed = argv.includes('--yes');
  let commands = argv.filter(a => !a.startsWith('--'));

  if (commands.length === 0) commands = ['spike'];
  if (commands.includes('all')) commands = [...READ_ONLY];
  // Whether `credential` was ASKED FOR or merely swept in by `full` changes what
  // a missing second key means — see below.
  const expanded = commands.includes('full');
  if (expanded) commands = [...FULL];

  const unknown = commands.filter(c => ![...READ_ONLY, ...DESTRUCTIVE].includes(c));
  if (unknown.length > 0) {
    console.error(`Unknown command(s): ${unknown.join(', ')}`);
    console.error(`Known: ${[...READ_ONLY, ...DESTRUCTIVE].join(', ')}, all, full`);
    process.exitCode = 2;
    return;
  }

  const needsConfirmation = commands.filter(c => DESTRUCTIVE.includes(c));
  if (needsConfirmation.length > 0 && !confirmed) {
    // Say what each one actually does rather than listing both effects
    // whichever was asked for: "a lamp is switched off and on" is not a
    // warning somebody should have to discard as inapplicable.
    /** @type {Record<string, string>} */
    const EFFECTS = {
      credential: 'credential removes the stored API key and puts it back',
      rejoin: 'rejoin switches one of your lamps off and on, and sets a colour on it by hand',
      pairspike: 'pairspike creates a throwaway circadian light and deletes it again',
      pair: 'pair CREATES one of each Lightkeeper device type on your Homey, its own even if '
        + 'you already have some',
      repair: 'repair opens a repair session on each device and reads its screens. Saves nothing',
      restart: 'restart restarts the Lightkeeper app on your Homey',
      bridge: 'bridge runs one of your generated Flows, which switches lights',
      schedule: 'schedule replaces a schedule\'s windows and fires them (both are restored)',
      preview: 'preview writes the current curve to your lamps, and probes one that is off',
      teardown: 'teardown DELETES the devices this pass built and nothing else. '
        + 'Nothing it deletes comes back',
    };
    const effects = needsConfirmation.map(c => EFFECTS[c] ?? `${c} changes something`);
    console.error(`This changes your Homey: ${effects.join('; ')}. Re-run with --yes.`);
    process.exitCode = 2;
    return;
  }

  const config = await ensureConfig(commands);

  /**
   * A one-key setup cannot run `credential`, and what to do about that depends
   * on how it was asked for.
   *
   * Asked for BY NAME, it throws: somebody who typed `credential` wants the key lines run,
   * and quietly not running it is the worst of both. Swept in by `full`, it is
   * dropped with a SKIPPED line instead — the rest of the pass is still worth
   * having, and "SKIPPED means not tested" is a contract this report already
   * has. Aborting `full` over one command would throw away the other ten.
   *
   * Either way the decision happens before connecting, so nothing is half-done.
   */
  let skipCredential = false;
  if (commands.includes('credential')) {
    if (expanded) {
      try {
        requireTwoKeys(config);
      } catch {
        skipCredential = true;
        commands = commands.filter(command => command !== 'credential');
      }
    } else {
      requireTwoKeys(config);
    }
  }

  console.log(`Lightkeeper hardware verification against ${config.address}`);
  console.log(`Commands: ${commands.join(', ')}\n`);

  const api = await connect(config);

  if (skipCredential) {
    report('T35', 'SKIPPED', 'HOMEY_APP_KEY is not set to a SECOND Personal API Key, so the key '
      + 'lines (T35-T41) were not run. Mint another key in my.homey.app and set HOMEY_APP_KEY to the '
      + 'one the app holds — a key holds a single session (platform §2).');
  }

  /**
   * T59's reading, kept so T60 can be a DELTA rather than a second absolute.
   *
   * Taken early and compared at the end, because the card catalogues are read
   * lazily: an app nothing has asked anything of yet looks thin whatever it
   * does with the answer (platform §15).
   */
  let pssBefore;

  for (const command of commands) {
    console.log(`--- ${command}`);
    if (command === 'spike') await commandSpike(api);
    if (command === 'memory') pssBefore = await commandMemory(api);
    if (command === 'flows') await commandFlows(api);
    // Both keys: the app can only have been near the one it holds, but a report
    // that leaked either would be a report with a live credential in it.
    if (command === 'redaction') await commandRedaction(api, [config.appKey, config.key]);
    if (command === 'credential') await commandCredential(api, config.appKey);
    if (command === 'rejoin') await commandRejoin(api);
    if (command === 'pairspike') await commandPairSpike(api);
    if (command === 'pair') await commandPair(api, config.room);
    if (command === 'repair') await commandRepair(api);
    if (command === 'restart') await commandRestart(api);
    if (command === 'bridge') await commandBridge(api);
    if (command === 'schedule') await commandSchedule(api);
    if (command === 'preview') await commandPreview(api);
    if (command === 'teardown') await commandTeardown(api);
    console.log('');
  }

  if (pssBefore !== undefined && commands.length > 1) {
    console.log('--- memory (again)');
    await reportMemoryDelta(api, pssBefore);
    console.log('');
  }

  disconnectAll(api);

  const failed = results.filter(r => r.status === 'FAILED');
  const passed = results.filter(r => r.status === 'OK');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  console.log(`${passed.length} OK, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const failure of failed) console.log(`  ${failure.line} ${failure.detail}`);
    process.exitCode = 1;
  }

  /**
   * What is left for a person, printed rather than remembered.
   *
   * A report that lists only what a machine checked reads as a complete pass,
   * and the lines below are exactly the ones that are easiest to forget because
   * nothing ever prints them. Only after `full`, where the claim "this is the
   * whole pass" is actually being made.
   */
  if (expanded) {
    console.log('\nStill needs a person:');
    for (const line of STILL_MANUAL) console.log(`  ${line}`);
  }
}

/**
 * The three key failures, told apart — and told to the reader.
 *
 * Homey's own wording for these is three words long and identical in shape,
 * which is exactly the trap `classifyCredentialError()` exists to avoid inside
 * the app (platform §2): `Missing Scopes`, `Session Not Found` and `Missing
 * Session ID in Token` look alike and mean completely different things, with
 * completely different fixes. A script that prints the bare string hands its
 * reader a search engine query instead of an instruction.
 *
 * @param {unknown} error
 * @returns {string}
 */
function explainFailure(error) {
  const message = messageOf(error);

  if (/Missing Scopes/i.test(message)) {
    return `${message}\n\n`
      + 'The key reached the Homey but is not allowed to do this. Its permissions\n'
      + 'are too narrow — this script reads devices and zones, reads and writes\n'
      + 'Flows, and calls the app\'s own API.\n\n'
      + 'Fix: my.homey.app -> this Homey -> Settings -> API Keys -> New API Key,\n'
      + 'and grant it FULL access. A key\'s permissions cannot be widened after it\n'
      + 'is created, so make a new one and put it in scripts/hardware-env.json.';
  }

  if (/Session Not Found/i.test(message)) {
    return `${message}\n\n`
      + 'The key is well-formed but its session is gone. A key holds ONE live\n'
      + 'session, and a second holder takes it over (platform §2) — so this is\n'
      + 'what sharing one key between the app and this script looks like.\n\n'
      + 'Fix: make a new key for the script, keep it out of the app, and put it in\n'
      + 'scripts/hardware-env.json.';
  }

  if (/Missing Session ID in Token/i.test(message)) {
    return `${message}\n\n`
      + 'That is not a whole API key — it looks truncated. A key has three\n'
      + 'colon-separated parts. Copy the whole thing.';
  }

  return message;
}

main().catch(error => {
  // The message may have been near the key, so it is printed rather than the
  // whole error: a stack from homey-api can quote the request back, and this
  // script's own rule is the app's — the key is never printed.
  console.error(`\nverify-hardware failed: ${explainFailure(error)}`);
  process.exitCode = 1;
});
