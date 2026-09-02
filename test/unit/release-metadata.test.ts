import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A release is coherent only when every copy of the version agrees and all
 * three changelogs mention it. See CLAUDE.md → "Releasing a version".
 *
 * There are three because they have three audiences: `.homeychangelog.json` is
 * what Homey shows in the store, `CHANGELOG.md` is the full record for anyone
 * reading the repo, and `README.md`'s condensed section is the front page's
 * summary. The README one is the easiest to forget precisely because it is the
 * short one.
 *
 * The version lives in four files because Homey wants it in the manifest and
 * npm wants it in package.json, `app.json` is GENERATED from
 * `.homeycompose/app.json` by the CLI, and npm rewrites package-lock.json only
 * when it is asked to. Bumping one and forgetting another
 * produces an app that installs happily and then reports a version nobody can
 * match to a commit — invisible locally, and impossible to reason about from a
 * user's bug report. So the parity is asserted rather than remembered.
 *
 * The changelog checks exist because the store entry is the only thing a user
 * ever sees about a release, and it is the easiest thing to forget in the same
 * commit as the code.
 */

const ROOT = join(import.meta.dirname, '..', '..');

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const readJson = (file: string) => JSON.parse(read(file));

const composed = readJson('.homeycompose/app.json') as { version: string };
const version = composed.version;

describe('release metadata', () => {
  test('the version is a semver triple', () => {
    assert.match(version, /^\d+\.\d+\.\d+$/, '.homeycompose/app.json version is not x.y.z');
  });

  test('all four copies of the version agree', () => {
    const pkg = readJson('package.json') as { version: string };
    const manifest = readJson('app.json') as { version: string };
    const lock = readJson('package-lock.json') as {
      version: string; packages: Record<string, { version?: string }>;
    };

    assert.equal(
      pkg.version, version,
      'package.json disagrees with .homeycompose/app.json',
    );
    assert.equal(
      manifest.version, version,
      'app.json disagrees with .homeycompose/app.json — app.json is generated, so run '
      + '`npm run validate` and commit the result rather than editing it',
    );
    // npm does not touch the lock on a hand-edited version bump, so this one
    // drifts silently: it sat two releases behind before anything checked it.
    assert.equal(
      lock.version, version,
      'package-lock.json disagrees — run `npm install --package-lock-only`',
    );
    assert.equal(
      lock.packages['']?.version, version,
      "package-lock.json's root package entry disagrees with package.json",
    );
  });

  test('the Homey changelog has an entry for this version', () => {
    const changelog = readJson('.homeychangelog.json') as Record<string, { en?: string }>;
    const entry = changelog[version];

    assert.ok(entry, `.homeychangelog.json has no entry for ${version}`);
    // The { "en": … } object form is what keeps adding a language a sibling key.
    assert.equal(typeof entry.en, 'string', `.homeychangelog.json ${version} has no "en" text`);
    assert.ok(entry.en!.trim().length > 0, `.homeychangelog.json ${version} is empty`);
  });

  test('every Homey changelog entry is one plain paragraph', () => {
    // The store drops this string into a bare <p> with no `white-space: pre-wrap`
    // (unlike README.txt's container, which has it), so every newline collapses to
    // a space and `**bold**` and `- ` bullets are shown literally. 0.5.0 shipped
    // with Added/Changed/Fixed headings and thirteen bullets and rendered as one
    // 1800-character run-on sentence with visible asterisks. Athom say the same
    // thing about the listing text: "any Markdown format is not allowed".
    //
    // Every entry is checked, not just the current one: the store's "View
    // changelog" popup shows all of them.
    const changelog = readJson('.homeychangelog.json') as Record<string, { en?: string }>;

    for (const [release, entry] of Object.entries(changelog)) {
      const text = entry.en ?? '';

      assert.doesNotMatch(
        text, /\n/,
        `.homeychangelog.json ${release}: a newline collapses to a space in the store`,
      );
      assert.doesNotMatch(
        text, /\*\*|(?:^|\s)#/,
        `.homeychangelog.json ${release}: markdown is rendered literally`,
      );
      assert.doesNotMatch(
        text, /(?:^|\s)[-*] /,
        `.homeychangelog.json ${release}: a bullet renders inline, mid-sentence`,
      );
    }
  });

  test('CHANGELOG.md has an entry for this version', () => {
    const changelog = read('CHANGELOG.md');

    assert.ok(
      changelog.includes(`
## ${version}
`),
      `CHANGELOG.md has no "## ${version}" heading`,
    );
  });

  test("the README's condensed changelog names this version", () => {
    // The README carries the current release in a few bullets and one line per
    // older one; CHANGELOG.md carries the detail. A release that bumps the
    // version without touching the README leaves the front page advertising the
    // previous one, which is the same small dishonesty the test count guards.
    const readme = read('README.md');
    const from = readme.indexOf('## Changelog');

    assert.ok(from !== -1, 'README.md has no "## Changelog" section');
    assert.ok(
      readme.slice(from).includes(version),
      `README.md's changelog section does not mention ${version}`,
    );
  });

  /**
   * A FLOOR, not an equality — and the change of shape is the fix.
   *
   * This counted static `test(`/`it(` call sites, which is not what `npm test`
   * runs: two files generate their cases inside a `for` loop
   * (`pair-view-boot.test.ts` over every discovered view,
   * `plan-validation.test.ts` over a table), so each of those call sites expands
   * to many tests. The derived number was 903 while the runner reported 937, and
   * both README.md and FAQ.md quoted the wrong one with this guard green over the
   * top of it.
   *
   * Counting what actually runs would mean running the suite from inside the
   * suite. So the docs claim a floor instead — "over 900" — and this asserts the
   * claim is one the suite can still stand behind. A stale number is the kind of
   * small dishonesty that makes a reader distrust the rest of the file; a number
   * that can only ever be an UNDERSTATEMENT is not stale, it is conservative.
   */
  test('no doc claims more tests than the suite defines', () => {
    const files = readdirSync(join(ROOT, 'test', 'unit')).filter(f => f.endsWith('.test.ts'));
    // Call sites, so this is itself a floor on what the runner reports.
    const defined = files.reduce((sum, file) => {
      const body = readFileSync(join(ROOT, 'test', 'unit', file), 'utf8');
      return sum + (body.match(/(?:^|\s)(?:test|it)\(/g) ?? []).length;
    }, 0);

    let quotedAnywhere = 0;
    for (const doc of ['README.md', 'FAQ.md', 'docs/hardware-test-plan.md']) {
      const quoted = [...read(doc).matchAll(/(\d+) (?:unit )?tests/g)].map(m => Number(m[1]));
      quotedAnywhere += quoted.length;
      for (const count of quoted) {
        assert.ok(
          count <= defined,
          `${doc} claims ${count} tests; only ${defined} are defined`,
        );
        // And not so far under that the claim has stopped meaning anything.
        assert.ok(
          count >= defined - 200,
          `${doc} claims ${count} tests while ${defined} are defined — round it up`,
        );
      }
    }

    assert.ok(quotedAnywhere > 0, 'no doc states a test count any more');
  });
});
