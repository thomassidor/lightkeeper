#!/usr/bin/env node
/**
 * Materialise every pairing view Homey needs as a real file on disk.
 *
 * Two copies happen here, for two different platform reasons.
 *
 * **pair → repair, per driver.** Homey serves pair views from
 * `drivers/<id>/pair/<viewId>.html` and repair views from
 * `drivers/<id>/repair/<viewId>.html` — two separate folders, as the CLI's own
 * HomeyCompose shows when it materialises templated views. A driver that
 * declares `repair` views without that second folder validates cleanly at
 * publish level (homey-lib checks the pair files only) and then fails on the
 * device with Homey's own `unknown_error_getting_file`, before any of our
 * screens render. Our views are identical in both modes: self-contained, every
 * rule scoped to the view's own root id, pair and repair are separate sessions
 * with separate documents, and the one branch that differs (createDevice vs
 * done) is already decided by what `save` returns.
 *
 * **Shared views, between drivers.** The API-key screen and the light picker are
 * the same screens for a remote controller and for a light schedule, and Homey
 * requires a real file per driver — it will not follow a reference. The
 * controller's copies are the originals; every other driver's are copies. The
 * credential view is driver-agnostic because the DRIVER tells it which view comes
 * next (see its `nextView`), not because it guesses.
 *
 * test/unit/repair-views.test.ts fails if any of these copies has drifted, and
 * nothing runs this script for you.
 *
 * `--check` reports what WOULD be copied and exits non-zero instead of writing.
 * That is what CI runs: it detects drift without hiding it, which is the opposite
 * of running the sync there (a CI run that synced would repair the drift in the
 * runner and go green over it, exactly as an unchecked `homey app validate` does
 * to `app.json`).
 *
 * **Nothing happens on import.** Everything below runs from `sync()`, behind an
 * entry-point guard, because it did not: the body was top-level statements, so
 * `test/unit/repair-views.test.ts` — which imports two constants from here — ran
 * the sync IN WRITE MODE before asserting anything. Its own drift assertions
 * could never fail, and CI's `sync:views:check` was defeated by ordering, since
 * `npm test` runs first in the same tree and repairs the drift the later step
 * exists to catch.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVERS = join(ROOT, 'drivers');

/** Views that live in one driver and are copied into the others. */
export const SHARED_VIEWS = ['credential.html', 'targets.html'];
export const SHARED_SOURCE_DRIVER = 'controller';

/**
 * Do the work, or report what it would do.
 *
 * A function rather than top-level statements — see the header for why that is
 * load-bearing rather than tidy.
 *
 * @param {{ check?: boolean }} [options] `check` reports drift without writing.
 * @returns {{ copies: number; drifted: string[] }}
 */
export function sync(options = {}) {
  const CHECK_ONLY = options.check === true;

  let copies = 0;
  /** @type {string[]} What --check found, so the exit can name every file at once. */
  const drifted = [];

  /**
   * @param {string} from
   * @param {string} to
   * @param {string} label
   */
  function copy(from, to, label) {
    const before = existsSync(to) ? readFileSync(to) : null;
    const content = readFileSync(from);
    if (before && before.equals(content)) return;
    if (CHECK_ONLY) {
      drifted.push(label);
      copies += 1;
      return;
    }
    writeFileSync(to, content);
    copies += 1;
    console.log(label);
  }

  const driverIds = readdirSync(DRIVERS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();

  // 1. Shared views, out of the source driver and into every other one.
  for (const driverId of driverIds) {
    if (driverId === SHARED_SOURCE_DRIVER) continue;
    const pairDir = join(DRIVERS, driverId, 'pair');
    if (!existsSync(pairDir)) continue;

    const manifest = readManifest(driverId);
    const declared = new Set((manifest.pair ?? []).map(/** @param {{ id: string }} view */ view => `${view.id}.html`));

    for (const view of SHARED_VIEWS) {
      if (!declared.has(view)) continue;
      copy(
        join(DRIVERS, SHARED_SOURCE_DRIVER, 'pair', view),
        join(pairDir, view),
        `${driverId}/pair/${view} <- ${SHARED_SOURCE_DRIVER}/pair/${view}`,
      );
    }
  }

  // 2. pair → repair, for every driver that declares repair views.
  for (const driverId of driverIds) {
    const manifest = readManifest(driverId);
    // Read the view ids from the manifest rather than hardcoding them, so adding
    // another view cannot half-land.
    const views = (manifest.repair ?? []).map(/** @param {{ id: string }} view */ view => view.id);
    if (views.length === 0) continue;

    const repairDir = join(DRIVERS, driverId, 'repair');
    // Not in --check: creating the folder is a write, and a check writes nothing.
    if (!CHECK_ONLY) mkdirSync(repairDir, { recursive: true });

    for (const id of views) {
      copy(
        join(DRIVERS, driverId, 'pair', `${id}.html`),
        join(repairDir, `${id}.html`),
        `${driverId}/repair/${id}.html <- ${driverId}/pair/${id}.html`,
      );
    }
  }
  return { copies, drifted };
}

/**
 * The entry point, and the only place this module writes, logs or exits.
 *
 * Guarded on being the process's own entry point, so an import cannot sync.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const { copies, drifted } = sync({ check });

  if (check) {
    if (copies === 0) {
      console.log('Views are in sync.');
    } else {
      console.error(`${copies} view file(s) have drifted from their source:`);
      for (const label of drifted) console.error(`  ${label}`);
      console.error('\nRun `npm run sync:views` and commit the result.');
      process.exit(1);
    }
  } else {
    console.log(copies === 0 ? 'Views already in sync.' : `Synced ${copies} view file(s).`);
  }
}

/**
 * @param {string} driverId
 * @returns {{ pair?: { id: string }[]; repair?: { id: string }[] }}
 */
function readManifest(driverId) {
  const path = join(DRIVERS, driverId, 'driver.compose.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}
