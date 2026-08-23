import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A release is coherent only when every copy of the version agrees and both
 * changelogs mention it. See CLAUDE.md → "Releasing a version".
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
    assert.equal(typeof entry!.en, 'string', `.homeychangelog.json ${version} has no "en" text`);
    assert.ok(entry!.en!.trim().length > 0, `.homeychangelog.json ${version} is empty`);
  });

  test('the README changelog has an entry for this version', () => {
    const readme = read('README.md');
    const from = readme.indexOf('## Changelog');

    assert.ok(from !== -1, 'README.md has no "## Changelog" section');
    assert.ok(
      readme.slice(from).includes(`### ${version}`),
      `README.md's changelog has no "### ${version}" heading`,
    );
  });

  test('the README states the real test count', () => {
    // Two places quote it, and a stale number is the kind of small dishonesty
    // that makes a reader distrust the rest of the file.
    const files = readdirSync(join(ROOT, 'test', 'unit')).filter(f => f.endsWith('.test.ts'));
    const total = files.reduce((sum, file) => {
      const body = readFileSync(join(ROOT, 'test', 'unit', file), 'utf8');
      return sum + (body.match(/(?:^|\s)(?:test|it)\(/g) ?? []).length;
    }, 0);

    const readme = read('README.md');
    const quoted = [...readme.matchAll(/(\d+) unit tests/g)].map(m => Number(m[1]));

    assert.ok(quoted.length > 0, 'README.md no longer states a test count');
    for (const count of quoted) {
      assert.equal(
        count, total,
        `README.md says ${count} unit tests, the suite defines ${total}`,
      );
    }
  });
});
