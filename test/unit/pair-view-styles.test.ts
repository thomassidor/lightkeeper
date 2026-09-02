import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pair views are injected into ONE document (see any view's script header), so
 * they cannot share a stylesheet — there is nowhere to serve one from — and every
 * CSS rule has to be scoped to the view's own root id. The consequence is ~150
 * lines of base CSS duplicated once per view, plus a handful of script helpers
 * that cannot be imported either.
 *
 * That duplication cannot be removed, so it is made safe instead: this test
 * compares every copy with the root id normalised away. Without it the first
 * person to fix a colour in one view ships the others disagreeing, which is
 * exactly the drift that left the flow using an off-brand accent in some places
 * and the brand navy in others.
 *
 * Views are DISCOVERED from disk, across every driver, and each root id is read
 * out of the file rather than listed here — a second driver's views were
 * invisible to this test while both were hardcoded, which is the one way the
 * convention could be broken without anything failing.
 *
 * The other tests here enforce the rules that made the base block worth
 * extracting in the first place, and the last describe block does the same job
 * for the shared SCRIPT helpers — which had no guard at all, so they could
 * drift silently while the CSS beside them could not.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DRIVERS = join(ROOT, 'drivers');

const START = '/* ==== shared base:';
const END = '/* ==== end shared base ==== */';

/** Every pair view in the repository, as "<driver>/<file>" -> its root id. */
const VIEWS: Record<string, string> = Object.fromEntries(
  readdirSync(DRIVERS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(driver => {
      const dir = join(DRIVERS, driver.name, 'pair');
      const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.html')) : [];
      return files.map(file => {
        const text = readFileSync(join(dir, file), 'utf8');
        const root = /class="wrap" id="([\w-]+)"/.exec(text)?.[1];
        assert.ok(root, `${driver.name}/${file}: no <div class="wrap" id="…"> root element`);
        return [`${driver.name}/${file}`, root] as const;
      });
    }),
);

function read(view: string): string {
  const [driver, file] = view.split('/');
  return readFileSync(join(DRIVERS, driver, 'pair', file), 'utf8');
}

/** The shared base block, with this view's root id replaced by a placeholder. */
function baseBlock(view: string): string {
  const text = read(view);
  const from = text.indexOf(START);
  const to = text.indexOf(END);

  assert.ok(from !== -1, `${view}: shared base start marker is missing`);
  assert.ok(to > from, `${view}: shared base end marker is missing or misplaced`);

  return text.slice(from, to + END.length)
    .replaceAll(`#${VIEWS[view]}`, '#ROOT');
}

/** Everything in the <style> element, for whole-file colour checks. */
function styleBlock(view: string): string {
  const text = read(view);
  const from = text.indexOf('<style>');
  const to = text.indexOf('</style>');
  assert.ok(from !== -1 && to > from, `${view}: no <style> block`);
  return text.slice(from, to);
}

describe('pair view styles', () => {
  test('every pair view the manifests declare is discovered', () => {
    // A view the test cannot see is a view whose scoping and colours nobody
    // checks. The expected set comes from the driver manifests rather than a
    // number written here: `>= 5` against a repo with seven views meant two
    // could be deleted with nothing failing.
    const declared = readdirSync(DRIVERS, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(driver => {
        const manifest = join(DRIVERS, driver.name, 'driver.compose.json');
        if (!existsSync(manifest)) return [];
        const views = JSON.parse(readFileSync(manifest, 'utf8')).pair ?? [];
        return views.map((view: { id: string }) => `${driver.name}/${view.id}.html`);
      })
      .sort();

    assert.ok(declared.length > 0, 'no driver declares any pair view');
    assert.deepEqual(Object.keys(VIEWS).sort(), declared);
  });

  test('the shared base block is identical in every view', () => {
    const views = Object.keys(VIEWS);
    const reference = baseBlock(views[0]);

    for (const view of views.slice(1)) {
      assert.equal(
        baseBlock(view), reference,
        `${view}'s shared base has drifted from ${views[0]}'s — `
        + 'the block is duplicated because the views share one document, '
        + "so a change has to be made in every file, including the other driver's",
      );
    }
  });

  test('every rule is scoped to the view root', () => {
    for (const [view, root] of Object.entries(VIEWS)) {
      const style = styleBlock(view);

      // Strip comments and @media wrappers, then every remaining selector must
      // name this view's root. An unscoped rule bleeds into the other views of
      // the same session, which is the failure the convention exists to prevent.
      const rules = style
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@media[^{]+\{/g, '')
        .split('}')
        .map(chunk => chunk.split('{')[0].trim())
        .filter(selector => selector.length > 0 && !selector.startsWith('<'));

      for (const selector of rules) {
        assert.ok(
          selector.split(',').every(part => part.trim().startsWith(`#${root}`)),
          `${view}: selector "${selector}" is not scoped to #${root}`,
        );
      }
    }
  });

  test('colours outside the token declarations go through a token', () => {
    // A token is where a colour is CHANGED — one declaration block per view,
    // all of them byte-identical, so a palette edit is one find-and-replace
    // rather than a hunt through five files. A literal past that block is a
    // colour the next edit will miss. The select chevron is the documented
    // exception: it lives inside a data: URI, which cannot read a custom
    // property.
    for (const view of Object.keys(VIEWS)) {
      const style = styleBlock(view)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // the two token declaration blocks, where literals are the point
        .replace(/--lk-[\w-]+:[^;]+;/g, '')
        .replace(/url\("data:[^"]*"\)/g, '');

      const literals = [...style.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)]
        .map(m => m[0])
        // `#cr-wrap` and friends are selectors, not colours
        .filter(value => /^#[0-9a-fA-F]{3,8}$/.test(value) || value.startsWith('rgb'));

      assert.deepEqual(
        literals, [],
        `${view}: hard-coded colour(s) outside the token declarations — `
        + 'add a token instead, or the next palette change will miss it',
      );
    }
  });

  test('no view follows the operating system colour scheme', () => {
    /**
     * Every view carried a `prefers-color-scheme: dark` block restating the
     * whole palette, and it was wrong in a way only hardware could show: Homey
     * paints the pairing sheet ITSELF, in light, whatever the phone is set to.
     * So a phone in dark mode got our dark palette drawn inside Homey's white
     * panel — dark cards, pale text, on white. The media query was asking the
     * OS a question about a surface the OS does not own.
     *
     * Removed rather than inverted: there is no query that reports what colour
     * the container is, so the only honest answer is to match the one panel
     * Homey actually draws.
     */
    for (const view of Object.keys(VIEWS)) {
      assert.ok(
        !styleBlock(view).includes('prefers-color-scheme'),
        `${view}: a colour-scheme media query is back — the pairing sheet is `
        + 'light whatever the phone says, so this renders dark-on-white',
      );
    }
  });
});

/**
 * The same argument as the CSS, for the script.
 *
 * `stabiliseScrollbar` and `emit` are byte-identical in every view and have to
 * be: a pair view is plain browser script in a shared document, so there is no
 * module to import them from. Unlike the CSS they had no guard, so one of them
 * could be fixed in one view and left wrong in the other four — and `emit` is
 * the only path from a view to its driver, so a divergence there is a screen
 * that renders and does nothing.
 *
 * Helpers that legitimately exist in only some views (escapeHtml, which only
 * the list screens need) are compared across the views that DO have them.
 *
 * This guarded three of eight. `node`, `clear`, `pad`, `formatMinutes` and
 * `warmthText` were each duplicated across two to seven views with nothing
 * comparing them — and `warmthText` is the warmth ladder, so the realistic worst
 * case was one device type's screen labelling a 0-1 warmth with a different word
 * than another's. Not a wrong write (the axis direction itself is enforced in
 * `lib/` and covered by circadian-curve.test.ts), but a screen that disagrees
 * with the screen beside it about which end is warm.
 */
describe('pair view script helpers', () => {
  /** A named function or IIFE, from its `function` keyword to its closing brace. */
  function helper(view: string, name: string): string | null {
    const text = read(view);
    const at = text.indexOf(`function ${name}(`);
    if (at === -1) return null;

    let depth = 0;
    for (let i = text.indexOf('{', at); i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(at, i + 1);
      }
    }
    assert.fail(`${view}: ${name}() has unbalanced braces`);
  }

  /**
   * Written out one test per helper rather than generated in a loop, so the
   * count `npm test` reports is the count release-metadata.test.ts can derive
   * from the source — which is what README.md quotes.
   */
  function assertIdentical(name: string): void {
    const copies = Object.keys(VIEWS)
      .map(view => ({ view, body: helper(view, name) }))
      .filter((c): c is { view: string; body: string } => c.body !== null);

    assert.ok(copies.length > 1, `${name}() appears in ${copies.length} view(s)`);

    for (const copy of copies.slice(1)) {
      assert.equal(
        copy.body, copies[0].body,
        `${copy.view}'s ${name}() has drifted from ${copies[0].view}'s — `
        + 'these are copies because a pair view cannot import anything, '
        + "so a fix has to be made in every file, including the other driver's",
      );
    }
  }

  test('stabiliseScrollbar() is identical everywhere it appears', () => {
    assertIdentical('stabiliseScrollbar');
  });

  test('emit() is identical everywhere it appears', () => {
    assertIdentical('emit');
  });

  test('escapeHtml() is identical in the views that have one', () => {
    // Only the list screens need it; those that do must agree.
    assertIdentical('escapeHtml');
  });

  test('node() is identical everywhere it appears', () => {
    assertIdentical('node');
  });

  test('clear() is identical everywhere it appears', () => {
    assertIdentical('clear');
  });

  test('pad() is identical everywhere it appears', () => {
    assertIdentical('pad');
  });

  test('formatMinutes() is identical everywhere it appears', () => {
    assertIdentical('formatMinutes');
  });

  test('warmthText() is identical everywhere it appears', () => {
    // The warmth ladder. Two screens disagreeing about which end is warm is the
    // one drift here a user would actually see.
    assertIdentical('warmthText');
  });

  /**
   * `brightnessText` is deliberately NOT here, and the difference is the reason.
   *
   * The schedule view's takes an `entry` and the curve view's takes a `point`,
   * because that is what each screen holds. The three lines are otherwise the
   * same, but they are two small formatters over differently-named records
   * rather than one helper copied — and forcing byte-identity would make one of
   * the two views name its own data wrongly. A guard is worth having only where
   * the thing it guards is genuinely one thing.
   */

  test('setSummary() is identical everywhere it appears', () => {
    assertIdentical('setSummary');
  });

  test('emit() appears in every view, because it is the only way out', () => {
    for (const view of Object.keys(VIEWS)) {
      assert.ok(helper(view, 'emit'), `${view} has no emit() helper`);
    }
  });
});
