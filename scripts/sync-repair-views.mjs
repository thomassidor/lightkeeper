#!/usr/bin/env node
/**
 * Copy each pair view to its repair sibling.
 *
 * Homey serves pair views from `drivers/<id>/pair/<viewId>.html` and repair
 * views from `drivers/<id>/repair/<viewId>.html` — two separate folders, as the
 * CLI's own HomeyCompose shows when it materialises templated views. A driver
 * that declares `repair` views without that second folder validates cleanly at
 * publish level (homey-lib checks the pair files only) and then fails on the
 * device with Homey's own `unknown_error_getting_file`, before any of our
 * screens render.
 *
 * Our four views are identical in both modes: they are self-contained, every
 * rule is scoped to the view's own root id, pair and repair are separate
 * sessions with separate documents, and the one branch that differs
 * (createDevice vs done) is already decided by what `save` returns. So the
 * repair folder is a copy, this script makes it, and
 * test/unit/repair-views.test.ts fails if it has drifted.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = join(ROOT, 'drivers', 'controller');

// Read the view ids from the manifest rather than hardcoding them, so adding a
// fifth view cannot half-land.
const manifest = JSON.parse(readFileSync(join(DRIVER, 'driver.compose.json'), 'utf8'));
const views = (manifest.repair ?? []).map(view => view.id);

if (views.length === 0) {
  console.log('No repair views declared — nothing to sync.');
  process.exit(0);
}

mkdirSync(join(DRIVER, 'repair'), { recursive: true });

for (const id of views) {
  const source = join(DRIVER, 'pair', `${id}.html`);
  const target = join(DRIVER, 'repair', `${id}.html`);
  writeFileSync(target, readFileSync(source));
  console.log(`repair/${id}.html <- pair/${id}.html`);
}

console.log(`Synced ${views.length} repair view(s).`);
