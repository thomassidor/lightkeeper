/**
 * `npm run test:coverage` — the unit suite under Node's own coverage, with floors.
 *
 * Node's test runner can enforce a threshold by itself (`--test-coverage-lines`),
 * and this script exists because of the two things that threshold cannot see:
 *
 * - **A file no test loads is not in the report at all.** V8 only counts code it
 *   compiled, so a brand-new module with no test lowers nothing — the aggregate
 *   stays at 97% while a whole driver goes untested. That is not hypothetical:
 *   it is how `app.ts`, all five drivers and `lib/pairing/sensor-picker.ts` sat
 *   outside the suite for their whole lives (platform §13 made most of them
 *   unimportable, and nothing noticed the one that was not). So every source
 *   file is enumerated from disk, and one missing from the report fails the run
 *   unless it is listed in TYPE_ONLY with the reason it has no runtime code.
 * - **An aggregate hides a file.** 97% over 30 000 lines is compatible with one
 *   runtime at 40%. So there is a per-file floor as well as a total one.
 *
 * The floors are set a little below what the suite achieves, so they catch a
 * real regression rather than failing on the first refactor that moves a line.
 * Raise them when coverage rises; never lower one to make a change pass.
 *
 *     npm run test:coverage            # report + enforce
 *     npm run test:coverage -- --quiet # enforce, print failures only
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Where the app's own runtime code lives — everything a Homey executes. */
const SOURCES = ['app.ts', 'api.ts', 'lib', 'drivers'];

/** Totals over every file in the report. */
const TOTAL = { lines: 97, branches: 87, functions: 92 };

/** The least any single file may have. */
const PER_FILE = { lines: 85, branches: 65 };

/**
 * Files that are never in the report because they contain no runtime code: they
 * are imported with `import type`, which erases them. Each says so, so that a
 * file acquiring code is a decision to take it off this list and test it.
 */
const TYPE_ONLY = {
  'lib/app-contract.ts': 'the app\'s public surface, written as an interface',
  'lib/homey-api-types.ts': 'shapes homey-api returns, declared for the seams',
  'lib/support/evidence-sink.ts': 'one function signature, deliberately a file of its own',
};

/** @param {string} path @returns {string[]} */
function sourceFiles(path) {
  const full = join(ROOT, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap(entry => sourceFiles(join(path, entry)))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'));
}

const quiet = process.argv.includes('--quiet');
const args = [
  '--import', 'tsx', '--test', '--experimental-test-coverage',
  ...SOURCES.map(source => `--test-coverage-include=${source.endsWith('.ts') ? source : `${source}/**`}`),
  '--test-reporter=tap', 'test/unit/**/*.test.ts',
];
const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
if (run.error) throw run.error;

const out = run.stdout;
const failed = /^# fail (\d+)/m.exec(out);
if (run.status !== 0 && (!failed || failed[1] !== '0')) {
  process.stdout.write(out.split('\n').filter(line => /^not ok|^\s+not ok|^# (tests|pass|fail)/.test(line)).join('\n'));
  console.error('\nThe suite itself failed; coverage was not assessed.');
  process.exit(1);
}

/**
 * The report is a TAP comment table that nests directories by indentation and
 * names files by basename, so paths are rebuilt from a stack of directory rows.
 */
const start = out.indexOf('# start of coverage report');
const end = out.indexOf('# end of coverage report');
if (start === -1 || end === -1) throw new Error('no coverage report in the test output');
const table = out.slice(start, end).split('\n');

/** @typedef {{lines: number, branches: number, functions: number}} Cover */
/** @typedef {keyof Cover} Metric */
/** @type {Map<string, Cover>} */
const files = new Map();
/** @type {Cover | null} */
let totals = null;
const stack = [];
for (const raw of table) {
  const row = /^# (\s*)([^|]+?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/.exec(raw);
  if (!row || row[2] === 'file') continue;
  const [, indent, name, lines, branches, functions] = row;
  const depth = indent.length;
  if (name === 'all files') {
    totals = { lines: Number(lines), branches: Number(branches), functions: Number(functions) };
    continue;
  }
  stack.length = depth;
  if (lines === '') { stack[depth] = name; continue; }
  const path = [...stack.slice(0, depth), name].join('/');
  files.set(path, { lines: Number(lines), branches: Number(branches), functions: Number(functions) });
}
if (!totals) throw new Error('coverage report had no totals row');
const total = /** @type {Cover} */ (totals);

const problems = [];
const expected = SOURCES.flatMap(sourceFiles).map(file => file.split(sep).join('/'));
for (const file of expected) {
  if (files.has(file)) continue;
  if (file in TYPE_ONLY) continue;
  problems.push(`${file}: never loaded by any test (add a test, or TYPE_ONLY if it has no runtime code)`);
}
for (const file of Object.keys(TYPE_ONLY)) {
  if (files.has(file)) problems.push(`${file}: listed as TYPE_ONLY but has runtime code — take it off the list`);
}
for (const [file, cover] of files) {
  for (const [metric, floor] of /** @type {[Metric, number][]} */ (Object.entries(PER_FILE))) {
    if (cover[metric] < floor) problems.push(`${file}: ${metric} ${cover[metric]}% is below the per-file floor of ${floor}%`);
  }
}
for (const [metric, floor] of /** @type {[Metric, number][]} */ (Object.entries(TOTAL))) {
  if (total[metric] < floor) problems.push(`total ${metric} ${total[metric]}% is below ${floor}%`);
}

if (!quiet) {
  process.stdout.write(`${table.join('\n')}\n`);
  console.log(`${files.size} files covered of ${expected.length - Object.keys(TYPE_ONLY).length} expected;`
    + ` totals lines ${total.lines}% / branches ${total.branches}% / functions ${total.functions}%`);
}
if (problems.length > 0) {
  console.error(`\nCoverage floors not met:\n  ${problems.join('\n  ')}`);
  console.error(`\n(floors are in ${relative(ROOT, fileURLToPath(import.meta.url))})`);
  process.exit(1);
}
console.log('Coverage floors met.');
