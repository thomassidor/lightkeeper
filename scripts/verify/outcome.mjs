/**
 * What a hardware run amounts to: its exit code, and the JSON a CI job or a
 * release report can read instead of scraping the terminal.
 *
 * Pure, and separate from the script so the two decisions that matter — which
 * statuses fail a run, and what the file may contain — can be tested without a
 * Homey.
 *
 * THE FILE CARRIES NO CREDENTIAL AND NO ADDRESS. It is built from the report
 * lines, which `test/unit/verify-hardware-safety.test.ts` already holds free of
 * key material, plus a handful of facts about the build. It DOES carry device
 * and room names, exactly as the terminal report does, so it is a capture from
 * a real Homey and belongs under the gitignored `temp/` — never committed
 * (test/fixtures/README.md).
 */

/**
 * @typedef {{ line: string, status: string, detail: string }} ResultLine
 * @typedef {{ installed: string | null, checkout: string | null, build: 'dev' | 'launch' | 'unknown', firmware: string | null }} BuildFacts
 */

/**
 * @param {readonly ResultLine[]} results
 * @param {{ strict: boolean }} options
 * @returns {{ ok: number, failed: number, skipped: number, info: number, exitCode: 0 | 1, failing: ResultLine[] }}
 */
export function summarise(results, options) {
  const count = (/** @type {string} */ status) => results.filter(r => r.status === status).length;
  // Strict is for a run whose SKIPPED lines are themselves the problem — CI on a
  // dedicated test Homey, where "nothing to test against" means the setup
  // broke. On a household Homey a skip is usually the house, and the default
  // keeps treating it as "not tested" rather than as a failure.
  const failing = results.filter(r => r.status === 'FAILED'
    || (options.strict && r.status === 'SKIPPED'));
  return {
    ok: count('OK'),
    failed: count('FAILED'),
    skipped: count('SKIPPED'),
    info: count('INFO'),
    exitCode: failing.length > 0 ? 1 : 0,
    failing,
  };
}

/**
 * The JSON document `--json <path>` writes.
 *
 * @param {{
 *   results: readonly ResultLine[],
 *   commands: readonly string[],
 *   startedAt: number,
 *   finishedAt: number,
 *   strict: boolean,
 *   interrupted?: boolean,
 *   build: BuildFacts,
 *   stillManual?: ReadonlyArray<{ line: string, title: string, partial: boolean }>,
 * }} run
 */
export function jsonReport(run) {
  const summary = summarise(run.results, { strict: run.strict });
  return {
    script: 'verify-hardware',
    schema: 1,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: new Date(run.finishedAt).toISOString(),
    commands: [...run.commands],
    strict: run.strict,
    interrupted: run.interrupted === true,
    app: {
      installedVersion: run.build.installed,
      checkoutVersion: run.build.checkout,
      versionsMatch: run.build.installed !== null && run.build.installed === run.build.checkout,
      build: run.build.build,
    },
    firmware: run.build.firmware,
    summary: {
      ok: summary.ok, failed: summary.failed, skipped: summary.skipped, info: summary.info,
      exitCode: summary.exitCode,
    },
    results: run.results.map(r => ({ line: r.line, status: r.status, detail: r.detail })),
    ...(run.stillManual ? { stillManual: run.stillManual.map(l => ({ ...l })) } : {}),
  };
}

/**
 * What the installed build is, from whether its evidence route answers.
 *
 * A launch build has the six evidence routes REMOVED from its manifest
 * (`scripts/build.mjs`), so `GET /evidence` there is Homey's own "Cannot GET"
 * page — which `messageOf()` turns into "the installed app has no GET …". A dev
 * build answers. Anything else is unknown, and said so rather than guessed.
 *
 * @param {{ answered: boolean, message?: string }} probe
 * @returns {'dev' | 'launch' | 'unknown'}
 */
export function buildShapeFrom(probe) {
  if (probe.answered) return 'dev';
  if (/(has no|Cannot) GET \S*\/evidence\b/i.test(probe.message ?? '')) return 'launch';
  return 'unknown';
}
