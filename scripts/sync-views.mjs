#!/usr/bin/env node
/**
 * Materialise every pairing view Homey needs as a real file on disk.
 *
 * Two copies happen here, for two different platform reasons.
 *
 * **Shared BLOCKS, inside a view.** Every pair view carries the same ~129-line
 * CSS base and the same `emit()`; four of them carry the same ~470-line daylight
 * card. All views of a pairing session share ONE document, so every rule is
 * scoped to the view's own root id and there is no module loader to reach for —
 * which is why these were authored by hand in all thirteen views, with
 * `test/unit/pair-view-styles.test.ts` asserting they stayed identical. They are
 * now spliced from `views/shared/`, so there is one authored copy and the
 * test guards the splice rather than a human's diligence.
 *
 * `#ROOT` in a shared stylesheet is replaced with the view's own root id, which
 * is exactly the normalisation that test already does in reverse.
 *
 * On-disk duplication is UNCHANGED and has to be: Homey needs a real file per
 * folder and will not follow a reference (platform §8). What changed is that
 * nobody edits it thirteen times.
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
 * Where the one authored copy of each shared block lives.
 *
 * OUTSIDE `drivers/`, and that is not a preference: the CLI treats every
 * directory under `drivers/` as a driver and fails pre-processing with
 * `ENOENT: … drivers/_shared/driver.compose.json` before it validates anything.
 * These are authored fragments spliced at sync time, so nothing on a Homey
 * reads them — `.homeyignore` keeps them out of the archive.
 */
export const SHARED_DIR = join(ROOT, 'views', 'shared');

/**
 * The delimited regions, and the functions, spliced into every pair view.
 *
 * `optional: true` means a view that does not carry the region is left alone
 * rather than failing — only the four device types that store a brightness have
 * a daylight response to configure. The base and `emit()` are NOT optional: a
 * view without either is a broken view, and saying so here is cheaper than
 * finding out on a phone.
 */
/**
 * @typedef {{ source: string; scoped: boolean; optional?: boolean }} SharedBlockBase
 * @typedef {SharedBlockBase & { kind: 'delimited'; start: string; end: string }} DelimitedBlock
 * @typedef {SharedBlockBase & { kind: 'function'; name: string }} FunctionBlock
 * @typedef {DelimitedBlock | FunctionBlock} SharedBlock
 */

/** @type {SharedBlock[]} */
const BLOCKS = [
  {
    source: 'base.css',
    kind: 'delimited',
    start: '/* ==== shared base:',
    end: '/* ==== end shared base ==== */',
    scoped: true,
  },
  { source: 'emit.js', kind: 'function', name: 'emit', scoped: false },
  {
    source: 'daylight-card.css',
    kind: 'delimited',
    start: '/* ==== shared daylight card:',
    end: '/* ==== end shared daylight card ==== */',
    scoped: true,
    optional: true,
  },
  {
    source: 'daylight-card.html',
    kind: 'delimited',
    start: '<!-- ==== shared daylight card',
    end: 'end shared daylight card ==== -->',
    scoped: false,
    optional: true,
  },
  { source: 'daylight-card.js', kind: 'function', name: 'daylightCard', scoped: false, optional: true },
];

/**
 * A view's own root element id, which every scoped rule is prefixed with.
 *
 * Read from the markup rather than tabulated, so adding a view needs no edit
 * here — the same regex `pair-view-styles.test.ts` uses.
 *
 * @param {string} text
 * @returns {string | null}
 */
function rootIdOf(text) {
  const match = /class="wrap" id="([\w-]+)"/.exec(text);
  return match?.[1] ?? null;
}

/**
 * Replace `start`…`end` inclusive. Returns null where the region is absent.
 *
 * @param {string} text
 * @param {string} start
 * @param {string} end
 * @param {string} replacement
 * @returns {string | null}
 */
function spliceDelimited(text, start, end, replacement) {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const to = text.indexOf(end, from);
  if (to === -1) return null;
  return text.slice(0, from) + replacement + text.slice(to + end.length);
}

/**
 * Replace `function <name>(…) { … }`, matched to its closing brace.
 *
 * Brace counting rather than a regex because the bodies contain braces, and the
 * same walk `pair-view-styles.test.ts` uses to extract them.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} replacement
 * @returns {string | null}
 */
function spliceFunction(text, name, replacement) {
  const at = text.indexOf(`function ${name}(`);
  if (at === -1) return null;
  let depth = 0;
  for (let i = text.indexOf('{', at); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(0, at) + replacement + text.slice(i + 1);
    }
  }
  return null;
}

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

  // 0. Shared BLOCKS, into every pair view. FIRST, so that the two copies below
  //    inherit the spliced content rather than needing a second pass.
  const sources = new Map(
    BLOCKS.map(block => [block.source, readFileSync(join(SHARED_DIR, block.source), 'utf8').trimEnd()]),
  );

  for (const driverId of driverIds) {
    const pairDir = join(DRIVERS, driverId, 'pair');
    if (!existsSync(pairDir)) continue;

    for (const file of readdirSync(pairDir).filter(name => name.endsWith('.html')).sort()) {
      const path = join(pairDir, file);
      const before = readFileSync(path, 'utf8');
      const root = rootIdOf(before);
      if (!root) throw new Error(`${driverId}/pair/${file} has no <div class="wrap" id="…"> root`);

      let after = before;
      for (const block of BLOCKS) {
        const body = block.scoped
          ? /** @type {string} */ (sources.get(block.source)).replaceAll('#ROOT', `#${root}`)
          : /** @type {string} */ (sources.get(block.source));

        const next = block.kind === 'delimited'
          ? spliceDelimited(after, block.start, block.end, body)
          : spliceFunction(after, block.name, body);

        if (next === null) {
          if (block.optional) continue;
          throw new Error(
            `${driverId}/pair/${file} is missing the required shared block "${block.source}"`,
          );
        }
        after = next;
      }

      if (after === before) continue;
      const label = `${driverId}/pair/${file} <- views/shared/`;
      if (CHECK_ONLY) {
        drifted.push(label);
        copies += 1;
        continue;
      }
      writeFileSync(path, after);
      copies += 1;
      console.log(label);
    }
  }

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
