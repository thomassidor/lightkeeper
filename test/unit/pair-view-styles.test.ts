import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The four pair views are injected into ONE document (see any view's script
 * header), so they cannot share a stylesheet — there is nowhere to serve one
 * from — and every CSS rule has to be scoped to the view's own root id. The
 * consequence is ~110 lines of base CSS duplicated four times.
 *
 * That duplication cannot be removed, so it is made safe instead: this test
 * compares the four copies with the root id normalised away. Without it the
 * first person to fix a colour in one view ships three views that disagree,
 * which is exactly the drift that left the flow using an off-brand accent in
 * some places and the brand navy in others.
 *
 * The other tests here enforce the rules that made the base block worth
 * extracting in the first place.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const PAIR = join(ROOT, 'drivers', 'controller', 'pair');

/** view file -> its root element id. */
const VIEWS: Record<string, string> = {
  'credential.html': 'cr-wrap',
  'source.html': 'src-root',
  'targets.html': 'tg-root',
  'mapping.html': 'map-root',
};

const START = '/* ==== shared base: identical in all four pair views ====';
const END = '/* ==== end shared base ==== */';

function read(view: string): string {
  return readFileSync(join(PAIR, view), 'utf8');
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
  test('the shared base block is identical in all four views', () => {
    const views = Object.keys(VIEWS);
    const reference = baseBlock(views[0]!);

    for (const view of views.slice(1)) {
      assert.equal(
        baseBlock(view), reference,
        `${view}'s shared base has drifted from ${views[0]}'s — `
        + 'the block is duplicated because the views share one document, '
        + 'so a change has to be made in all four files',
      );
    }
  });

  test('every rule is scoped to the view root', () => {
    for (const [view, root] of Object.entries(VIEWS)) {
      const style = styleBlock(view);

      // Strip comments and @media wrappers, then every remaining selector must
      // name this view's root. An unscoped rule bleeds into the other three
      // views, which is the failure the scoping convention exists to prevent.
      const rules = style
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@media[^{]+\{/g, '')
        .split('}')
        .map(chunk => chunk.split('{')[0]!.trim())
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
    // A literal past the token blocks is a colour the dark scheme cannot reach,
    // which is how a surface ends up white-on-dark. The select chevron is the
    // documented exception: it lives inside a data: URI, which cannot read a
    // custom property.
    for (const view of Object.keys(VIEWS)) {
      const style = styleBlock(view)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // the two token declaration blocks, where literals are the point
        .replace(/--ll-[\w-]+:[^;]+;/g, '')
        .replace(/url\("data:[^"]*"\)/g, '');

      const literals = [...style.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)]
        .map(m => m[0])
        // `#cr-wrap` and friends are selectors, not colours
        .filter(value => /^#[0-9a-fA-F]{3,8}$/.test(value) || value.startsWith('rgb'));

      assert.deepEqual(
        literals, [],
        `${view}: hard-coded colour(s) outside the token declarations — `
        + 'add a token instead, or the dark scheme cannot restate it',
      );
    }
  });

  test('both colour schemes define the same tokens', () => {
    for (const view of Object.keys(VIEWS)) {
      const base = baseBlock(view);
      const dark = base.slice(base.indexOf('@media (prefers-color-scheme: dark)'));
      const light = base.slice(0, base.indexOf('@media (prefers-color-scheme: dark)'));

      const names = (text: string) =>
        [...new Set([...text.matchAll(/(--ll-[\w-]+)\s*:/g)].map(m => m[1]!))].sort();

      assert.deepEqual(
        names(dark), names(light),
        `${view}: the dark scheme does not restate the same tokens as the light one — `
        + 'a token defined in only one scheme keeps its light value in the dark',
      );
    }
  });
});
