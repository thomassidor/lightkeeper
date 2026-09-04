import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `export` means "somebody else uses this".
 *
 * It had stopped meaning that. Seventeen constants and functions in `lib/` were
 * exported with no consumer anywhere — not in `lib/`, not in `app.ts` or
 * `api.ts`, not in a driver, a script, a view or a test. That is not a defect on
 * its own, and it is worth a test for two reasons:
 *
 *  - **It is the signal a reader navigates by.** An exported name says "this is
 *    the module's surface, and changing it is a decision about other files".
 *    Seventeen that were not made every other export less informative.
 *  - **Nothing else can hold the line.** An unused-export lint rule would need
 *    `eslint-plugin-import`, and `eslint.config.mjs` says in its own header why
 *    the rule set is deliberately narrow — it enforces "the small set of
 *    mistakes this codebase has actually made", not hygiene. A source scan is
 *    what this suite already uses for exactly this class of invariant
 *    (`locales.test.ts`, `repair-views.test.ts`, `pair-view-styles.test.ts`).
 *
 * **VALUES only — types are deliberately out of scope.** A type is often the
 * documented shape of an exported function's parameter or return, and a
 * consumer that never names it still depends on it being nameable. "Nobody
 * imports this type" is therefore not evidence of anything, while "nobody
 * imports this function" is.
 *
 * Discovered from disk in both directions, so a new module is covered the moment
 * it exists and a new consumer counts the moment it is written.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Names that are exported ON PURPOSE with no consumer today.
 *
 * Empty, and the intention is that it stays that way: the honest fix for an
 * export nobody uses is to stop exporting it. An entry here needs a reason
 * beside it that survives being read a year later.
 */
const DELIBERATE: Record<string, string> = {};

function filesUnder(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...filesUnder(full, extension));
    } else if (entry.name.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

/** Every `export function|class|const` in lib/, by name. */
function exportedValues(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of filesUnder(join(ROOT, 'lib'), '.ts')) {
    const source = readFileSync(file, 'utf8');
    const pattern = /^export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z0-9_]+)/gm;
    for (const match of source.matchAll(pattern)) {
      const name = match[1]!;
      found.set(name, [...(found.get(name) ?? []), file]);
    }
  }
  return found;
}

/** Everything that could plausibly consume one. */
/**
 * A file's code, with comments stripped.
 *
 * Load-bearing, not tidiness. The check below is a word-boundary regex over
 * file text, so a name MENTIONED in prose counted as a consumer. Five exports
 * were living on that: `optionalString` and `optionalUnitInterval` were called
 * from nowhere at all and were kept alive by one sentence in `plans.ts` naming
 * them, and three more were used only inside their own file while a comment
 * elsewhere made them look imported. A test that a comment can satisfy is not
 * holding the line it claims to.
 *
 * Deliberately crude — block comments and line comments, nothing else. It does
 * not need to parse TypeScript, only to stop prose from voting.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ 	]*\/\/.*$/gm, '');
}

function consumers(): Array<{ path: string; source: string }> {
  const paths = [
    ...filesUnder(join(ROOT, 'lib'), '.ts'),
    ...filesUnder(join(ROOT, 'drivers'), '.ts'),
    ...filesUnder(join(ROOT, 'drivers'), '.html'),
    ...filesUnder(join(ROOT, 'test'), '.ts'),
    ...filesUnder(join(ROOT, 'scripts'), '.mjs'),
    ...filesUnder(join(ROOT, 'settings'), '.html'),
    join(ROOT, 'app.ts'),
    join(ROOT, 'api.ts'),
  ];
  return paths.map(path => ({ path, source: withoutComments(readFileSync(path, 'utf8')) }));
}

describe('the surface lib/ actually exposes', () => {
  const values = exportedValues();
  const files = consumers();

  test('there is something to check', () => {
    // The canary: an empty map would make the test below pass by vacuum.
    assert.ok(values.size > 100, `only found ${values.size} exported values in lib/`);
    assert.ok(files.length > 100, `only found ${files.length} consumer files`);
  });

  test('every exported value in lib/ has a consumer outside its own file', () => {
    const orphans: string[] = [];

    for (const [name, owners] of values) {
      if (name in DELIBERATE) continue;
      const referenced = files.some(file =>
        !owners.includes(file.path) && new RegExp(`\\b${name}\\b`).test(file.source));
      if (!referenced) {
        orphans.push(`${name} (${owners.map(o => relative(ROOT, o)).join(', ')})`);
      }
    }

    assert.deepEqual(
      orphans, [],
      'exported with no consumer anywhere — drop the `export`, or add a reason to '
      + `DELIBERATE in this file:\n  ${orphans.join('\n  ')}`,
    );
  });
});
