import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

/**
 * `.gitignore` and `.homeyignore` answer two different questions and are edited
 * at different times, which is exactly how they drift.
 *
 * Everything the CLI does not recognise goes into the archive that is uploaded
 * to a household. Three things were found shipping that way: 136 KB of internal
 * review documents (caught by `scripts/build.mjs`'s own verifier, of all
 * things), a 1.9 MB `print.pdf` somebody had dropped in the root, and a 1.7 MB
 * `views.zip`. `npm run render:views` and `scripts/probe-lights.mjs` both write
 * megabytes into the working tree as a matter of routine, and a probe report is
 * a capture from a real Homey — every light and room by name — which makes this
 * a privacy rule as well as a size one.
 *
 * So: anything gitignored because it is a LOCAL ARTEFACT must also be ignored by
 * the packager. The exceptions below are the entries where that reasoning does
 * not apply, each with the reason it does not.
 */

/** Gitignore entries that must NOT be in `.homeyignore`, and why. */
const NOT_PACKAGING_CONCERNS: Record<string, string> = {
  '/node_modules/': 'the shipped dependency tree — homey-api is the app runtime',
  '/.homeybuild/': 'the build output itself; the CLI never packs its own target',
  '/env.json': 'consumed by the CLI before packing',
  '/test/fixtures/raw/': 'under /test, which is already ignored wholesale',
  '/scripts/hardware-env.json': 'under /scripts, which is already ignored wholesale',
  '.claude/settings.local.json': 'editor/tooling config, not an artefact of this app',
  '.vscode/': 'editor config',
  '.idea/': 'editor config',
  '.obsidian/': 'editor config',
  '.DS_Store': 'OS noise, and not a path the packager would grow a rule for',
  'Thumbs.db': 'OS noise',
  '__pycache__/': 'artwork tooling only, and never in the app tree',
  '*.log': 'a glob rather than a path; the packager matches literal paths',
};

function lines(file: string): string[] {
  return readFileSync(join(root, file), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

/**
 * One spelling for a path, so the two files can be compared at all.
 *
 * They disagree on leading and trailing slashes as a matter of habit —
 * `.gitignore` writes `.dev-build` and `/.probe/` in the same file — and a
 * comparison that treated those as different paths would pass while the thing
 * it is checking for was true.
 */
function normalise(entry: string): string {
  return entry.replace(/^[/]+/, '').replace(/[/]+$/, '');
}

describe('what actually ships to a household', () => {
  test('every local artefact .gitignore knows about is also kept out of the archive', () => {
    const packaged = new Set(lines('.homeyignore').map(normalise));

    const unaccounted = lines('.gitignore')
      .filter(entry => !(entry in NOT_PACKAGING_CONCERNS))
      .filter(entry => !packaged.has(normalise(entry)));

    assert.deepEqual(
      unaccounted, [],
      'these are gitignored but would be PACKED into the app uploaded to a household. '
      + 'Add each to .homeyignore, or to NOT_PACKAGING_CONCERNS in this file with the '
      + 'reason it is not a packaging concern:\n  ' + unaccounted.join('\n  '),
    );
  });

  test('the exception list has no entries .gitignore has stopped carrying', () => {
    // A stale exception is how the next real one gets waved through.
    const gitignored = new Set(lines('.gitignore'));
    const stale = Object.keys(NOT_PACKAGING_CONCERNS).filter(entry => !gitignored.has(entry));
    assert.deepEqual(stale, [], `no longer in .gitignore: ${stale.join(', ')}`);
  });
});
