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
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVERS = join(ROOT, 'drivers');

/** Views that live in one driver and are copied into the others. */
export const SHARED_VIEWS = ['credential.html', 'targets.html'];
export const SHARED_SOURCE_DRIVER = 'controller';

let copies = 0;

/**
 * @param {string} from
 * @param {string} to
 * @param {string} label
 */
function copy(from, to, label) {
  const before = existsSync(to) ? readFileSync(to) : null;
  const content = readFileSync(from);
  if (before && before.equals(content)) return;
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
  mkdirSync(repairDir, { recursive: true });

  for (const id of views) {
    copy(
      join(DRIVERS, driverId, 'pair', `${id}.html`),
      join(repairDir, `${id}.html`),
      `${driverId}/repair/${id}.html <- ${driverId}/pair/${id}.html`,
    );
  }
}

console.log(copies === 0 ? 'Views already in sync.' : `Synced ${copies} view file(s).`);

/**
 * @param {string} driverId
 * @returns {{ pair?: { id: string }[]; repair?: { id: string }[] }}
 */
function readManifest(driverId) {
  const path = join(DRIVERS, driverId, 'driver.compose.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}
