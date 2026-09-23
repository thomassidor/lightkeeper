/**
 * `npm run build` — which is not ours to rename, and is the ONLY hook we get.
 *
 * The Homey CLI shells out to `npm run build` whenever it detects TypeScript,
 * and it does so LAST in `preprocess()`: app.json is composed, `.homeybuild/` is
 * wiped, the source tree is copied in (honouring `.homeyignore`, minus every
 * `.ts`), production dependencies are copied, and only then does this run, with
 * `tsc` emitting into that same directory. Whatever is in `.homeybuild/` when
 * this script exits is what gets packaged.
 *
 * That matters because the CLI gives us nothing else. `install`, `run`,
 * `validate` and `publish` all call this identically — there is no flag, no env
 * var and no argument that says which one you are in. So the decision cannot be
 * "strip it when publishing"; it has to be **strip it unless somebody asked for
 * it**, or one forgotten flag ships a development tool to households.
 *
 * ## The switch
 *
 * A `.dev-build` file at the repo root. Present, the seven-day evidence recorder
 * is built in; absent, it is removed. It is gitignored, and it is a dotfile so
 * the CLI's own default ignore rules keep it out of the package either way — it
 * cannot be committed and it cannot reach CI.
 *
 *     New-Item .dev-build       # PowerShell  -- turn the recorder on
 *     touch .dev-build          # bash
 *     npx homey app install
 *
 *     Remove-Item .dev-build    # PowerShell  -- and off again
 *     rm .dev-build             # bash
 *
 * A file rather than an environment variable on purpose: this is a Windows
 * repository, `LIGHTKEEPER_DEV=1 npx homey app install` is not a thing
 * PowerShell does, and a switch you must re-type in the right dialect for every
 * command is one you will eventually get wrong. `LIGHTKEEPER_DEV=1` is honoured
 * as well, for CI or a one-off.
 *
 * Because the file is sticky, being ON is announced loudly on every build.
 * Being off is announced quietly — silence about which build you just made is
 * the thing that would eventually ship one by accident.
 *
 * ## What stripping is
 *
 * Four edits to `.homeybuild/`, then a proof. See `lib/support/evidence-feature.ts`
 * for why the feature is shaped so that this is a substitution rather than
 * surgery on generated JavaScript.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, '.homeybuild');

/** The recorder's Web API route names, as declared in `.homeycompose/app.json`. */
export const EVIDENCE_ROUTES = [
  'getEvidence', 'noteEvidence', 'startEvidence', 'stopEvidence', 'clearEvidence', 'readEvidence',
];

/** Compiled modules a launch build must not contain. */
export const EVIDENCE_MODULES = [
  'lib/support/evidence-recorder.js',
  'lib/support/evidence-sampler.js',
  'lib/support/evidence-feature-disabled.js',
];

/** Anything naming the recorder, to prove afterwards that none of it is left. */
const FORBIDDEN = [
  /evidence-recorder/,
  /evidence-sampler/,
  /EvidenceRecorder/,
  /EvidenceSampler/,
  /evidence-feature-disabled/,
];

/** What the settings page calls, and the shortest string that proves it still can. */
export const ROUTE_CALL = "'/evidence";

/**
 * Every top-level entry a packaged Lightkeeper is allowed to have.
 *
 * The CLI copies the repo root into `.homeybuild/` honouring `.homeyignore` and
 * NOTHING ELSE — `.gitignore` is not consulted. So a file that git has been told
 * to forget is still packaged, and the two mechanisms disagreeing is invisible
 * until somebody lists the build. `CODE_REVIEW.md` and `LAUNCH_REVIEW.md` shipped
 * 136 KB to households that way and were caught by accident; a stale `print.pdf`
 * and a `views.zip` of deleted screens were sitting here for the same reason when
 * this check was written, 3.6 MB between them.
 *
 * An allowlist rather than a denylist, because the failure is always a file
 * nobody thought about. Adding a legitimate root means adding it here, which is
 * one line and a moment's thought about whether a household should receive it.
 *
 * `eslint.config.mjs` and `tsconfig.test.json` are here deliberately. They ship,
 * they carry `extends`/`include` paths that are not in the archive, and CLAUDE.md
 * argues at length that this is inert and not worth fixing — nothing on the
 * device reads either. They are listed so this check stays a stray-file guard
 * rather than a reopening of that argument.
 */
export const EXPECTED_ROOTS = new Set([
  'LICENSE', 'README.txt',
  'api.js', 'app.js', 'app.json',
  'assets', 'drivers', 'lib', 'locales', 'settings',
  'node_modules', 'package.json', 'package-lock.json',
  'eslint.config.mjs', 'tsconfig.test.json',
]);

/**
 * Fail the build on anything at the root of `.homeybuild/` that is not expected.
 *
 * Runs for dev and launch builds alike: a stray file is not a recorder problem,
 * and the build that ships is not distinguishable from the build that does not
 * (see the header). Dotfiles are skipped — the CLI's own default rules keep them
 * out of the package, and `.dev-build` is deliberately one of them.
 */
export function verifyNoStrays(build = BUILD) {
  if (!existsSync(build)) return;
  const strays = readdirSync(build)
    .filter(entry => !entry.startsWith('.') && !EXPECTED_ROOTS.has(entry));
  if (strays.length > 0) {
    const label = strays.length === 1 ? 'entry' : 'entries';
    throw new Error(
      `.homeybuild/ contains ${strays.length} unexpected top-level ${label}, which would ship to`
      + ` households:\n  ${strays.join('\n  ')}\n`
      + 'Delete it, add it to .homeyignore, or add it to EXPECTED_ROOTS in scripts/build.mjs.',
    );
  }
}

/** @param {string} directory @returns {Generator<string>} */
function* filesUnder(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

/**
 * Remove one delimited block, by its opening marker's stable prefix.
 *
 * @param {string} text @param {string} open @param {string} close @param {string} label
 * @returns {string}
 */
function stripBlock(text, open, close, label) {
  const start = text.indexOf(open);
  if (start === -1) throw new Error(`${label}: opening marker not found`);
  const end = text.indexOf(close, start);
  if (end === -1) throw new Error(`${label}: closing marker not found`);
  return text.slice(0, start) + text.slice(end + close.length);
}

/**
 * The copied artefacts — the settings page and the manifest — may legitimately
 * be absent or already stripped.
 *
 * The CLI always calls this with a freshly copied `.homeybuild/`, but a
 * developer can run `npm run build` on its own against whatever the last
 * packaging run left behind. Then the settings page is either missing or a copy
 * that has already had its section removed, and failing on that would make a
 * bare `npm run build` an error for no reason.
 *
 * What is NOT tolerated is a page that still carries the feature and has no
 * markers to remove it by. That means somebody edited the block boundaries out
 * of `settings/index.html`, and it is the one case where carrying on would ship
 * the recorder.
 *
 * @param {string} build
 */
function stripCopied(build) {
  const settings = join(build, 'settings/index.html');
  if (existsSync(settings)) {
    let html = readFileSync(settings, 'utf8');
    if (html.includes('<!-- ==== dev-only: evidence recorder')) {
      html = stripBlock(html, '<!-- ==== dev-only: evidence recorder',
        '<!-- ==== end dev-only: evidence recorder ==== -->', 'settings markup');
      html = stripBlock(html, '/* ==== dev-only: evidence recorder',
        '/* ==== end dev-only: evidence recorder ==== */', 'settings script');
      writeFileSync(settings, html);
    } else if (html.includes(ROUTE_CALL)) {
      throw new Error('settings/index.html carries the recorder but has no dev-only markers to strip it by');
    }
  }

  const manifestPath = join(build, 'app.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const route of EVIDENCE_ROUTES) delete manifest.api?.[route];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/**
 * The proof, and the reason this script fails rather than warns.
 *
 * A substitution that half-worked leaves a `require('./evidence-recorder')`
 * pointing at a file this script has just deleted: an app that compiles,
 * packages and validates, and then throws MODULE_NOT_FOUND at `onInit` on a
 * household's Homey. Three separate things are checked because each could be
 * missed on its own — the compiled modules, the settings page, and the manifest
 * that advertises the routes.
 */
export function verifyStripped(build = BUILD) {
  const offenders = [];

  for (const path of filesUnder(build)) {
    // Code and markup only. A document that merely NAMES the recorder is not a
    // dangling require, and nothing that ships should be prose anyway.
    if (!/\.(js|json|html|css)$/.test(path)) continue;
    const text = readFileSync(path, 'utf8');
    const hit = FORBIDDEN.find(pattern => pattern.test(text));
    if (hit) offenders.push(`${relative(build, path)} still matches ${hit}`);
  }

  const settings = join(build, 'settings/index.html');
  if (existsSync(settings) && readFileSync(settings, 'utf8').includes(ROUTE_CALL)) {
    offenders.push('settings/index.html still calls the recorder routes');
  }

  const manifestPath = join(build, 'app.json');
  if (existsSync(manifestPath)) {
    const api = JSON.parse(readFileSync(manifestPath, 'utf8')).api ?? {};
    const left = EVIDENCE_ROUTES.filter(route => route in api);
    if (left.length > 0) offenders.push(`app.json still declares ${left.join(', ')}`);
  }

  if (offenders.length > 0) {
    throw new Error(`launch build still references the evidence recorder:\n  ${offenders.join('\n  ')}`);
  }
}

export function strip(build = BUILD) {
  // 1. The feature module becomes its twin, under the twin's own name.
  copyFileSync(
    join(build, 'lib/support/evidence-feature-disabled.js'),
    join(build, 'lib/support/evidence-feature.js'),
  );

  // 2. The recorder, the sampler and the now-copied twin go entirely.
  for (const module of EVIDENCE_MODULES) rmSync(join(build, module), { force: true });

  // 3 and 4. The settings page and the manifest, where they were copied in.
  stripCopied(build);

  verifyStripped(build);
}

/**
 * `tsc` through its own entry point, not through `npx`.
 *
 * Node 22 refuses to `spawnSync` a `.cmd` without a shell (EINVAL), which is
 * what `npx tsc` resolves to on Windows — and this is a Windows repository. The
 * package's own bin script runs on any platform, needs no shell, and skips npx's
 * resolution entirely.
 */
function build() {
  const devBuild = existsSync(join(ROOT, '.dev-build')) || process.env.LIGHTKEEPER_DEV === '1';

  execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc')], { cwd: ROOT, stdio: 'inherit' });

  verifyNoStrays();

  if (devBuild) {
    console.log('');
    console.log('  ############################################################');
    console.log('  ##  DEV BUILD - the seven-day evidence recorder IS built in');
    console.log('  ##  Delete .dev-build before publishing.');
    console.log('  ############################################################');
    console.log('');
  } else {
    strip();
    console.log('Launch build: evidence recorder stripped (create .dev-build to keep it).');
  }
}

/**
 * `--verify`: check the `.homeybuild/` the last packaging run left, building
 * nothing.
 *
 * The strip proves itself from INSIDE the build, which is the half that stops a
 * broken launch build shipping. This is the half that lets something OUTSIDE it
 * look: CI runs `validate` — which runs this script without `.dev-build` — and
 * then this, so a strip that silently stopped running at all (a guard inverted,
 * the call deleted) fails the run instead of going green over a recorder.
 */
function verifyExisting() {
  if (!existsSync(BUILD)) throw new Error('.homeybuild/ does not exist — run `npm run validate` first');
  verifyNoStrays();
  for (const module of EVIDENCE_MODULES) {
    if (existsSync(join(BUILD, module))) throw new Error(`.homeybuild/ still contains ${module}`);
  }
  verifyStripped();
  console.log('.homeybuild/ is a launch build: no evidence recorder, no stray roots.');
}

// Importable, for test/unit/build-strip.test.ts: the work runs only when this
// file IS the entry point — the same guard sync-views.mjs needed, for the same
// reason (a test importing a script must not perform it).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--verify')) verifyExisting();
  else build();
}
