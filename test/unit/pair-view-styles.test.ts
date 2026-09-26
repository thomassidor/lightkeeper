import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pair views are injected into ONE document (see any view's script header), so
 * every CSS rule has to be scoped to the view's own root id and Homey will not
 * follow a reference between them. The consequence is a base CSS block, an
 * `emit()`, and — on four views — a whole daylight card, present once per view
 * file. (No line counts here: three places once carried three stale ones.
 * `wc -l views/shared/*` is the answer, and it stays right.)
 *
 * **Those blocks are now GENERATED**, spliced from `views/shared/` by
 * `npm run sync:views`, so `npm run sync:views:check` is what catches a view
 * that has drifted from its source. This test is still worth its keep, and for a
 * different reason than when it was written: it asserts the PROPERTY the splice
 * is supposed to produce — every copy identical once the root id is normalised
 * away — rather than trusting the script that produces it. A splice with the
 * substitution wrong would pass `--check` (source and output would agree) and
 * fail here.
 *
 * Before the splice existed this was the only guard, and the drift it caught was
 * real: the flow used an off-brand accent in some views and the brand navy in
 * others.
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

/**
 * The SECOND delimited block, and the reason there is one.
 *
 * A daylight response is one configuration per device, and four of the five
 * device types can hold one — so the same sensor picker, lux range, two ends and
 * live readout appear on four screens. There is nowhere to put a stylesheet (see
 * the header), so it is four copies, policed exactly as the base above is.
 *
 * Unlike the base, it is NOT in every view: a controller stores no brightness
 * and has no daylight card. So the test over it asserts identity across the
 * views that have it, and that there is more than one of them.
 */
const CARD_START = '/* ==== shared week grid:';
const CARD_END = '/* ==== end shared week grid ==== */';

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

/**
 * The shared daylight-card block, normalised the same way, or null where the
 * view does not carry one.
 *
 * Null rather than a failure, because not carrying it is legitimate: only the
 * two daylight screens draw a sensor's week.
 */
function cardBlock(view: string): string | null {
  const text = read(view);
  const from = text.indexOf(CARD_START);
  if (from === -1) return null;

  const to = text.indexOf(CARD_END);
  assert.ok(to > from, `${view}: shared week-grid end marker is missing or misplaced`);

  return text.slice(from, to + CARD_END.length)
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

  test('the shared week-grid block is identical wherever it appears', () => {
    /**
     * The same argument as the base block above, one level down.
     *
     * The daylight CARD used to be the block here — the "follow the daylight"
     * section spliced into four screens. It went with `fromDaylight`: brightness
     * from the room is what a Room-sensing Light is for, and offering it on four
     * device types meant four screens carrying the same 250 lines.
     *
     * What is spliced now is the sensor's-week grid, on the one screen that
     * draws it: the response screen, where it is the evidence for the two lux
     * numbers. It had a second carrier — the detail screen a sensor row pushed —
     * until the 2026-09-23 design folded that screen into this one, so "several"
     * became "at least one": the block is still spliced, and a second carrier
     * appearing again must still match the first. `sync:views:check` is what
     * holds the one copy to its source.
     */
    const carriers = Object.keys(VIEWS).filter(view => cardBlock(view) !== null);

    assert.ok(
      carriers.length >= 1,
      'expected the response screen to carry the week grid, and no view does',
    );

    const reference = cardBlock(carriers[0]);
    for (const view of carriers.slice(1)) {
      assert.equal(
        cardBlock(view), reference,
        `${view}'s week-grid CSS has drifted from ${carriers[0]}'s — `
        + 'the block is duplicated because the views share one document, '
        + 'so a change has to be made in every file that has it',
      );
    }
  });

  test('no view redefines a class the shared base already styles', () => {
    /**
     * Scoping protects one VIEW from another. Inside a view, only the name does
     * — and this bit twice in one afternoon.
     *
     * The shared base styles `.day` as the day STRIP: 104px tall, positioned,
     * with its own overflow. The schedule's weekday chips and the week grid's
     * row labels both called themselves `.day`, inherited all of it, and
     * rendered as 104px blocks that pushed their own rows sideways. Both looked
     * fine in the markup and wrong only in a render.
     *
     * So a view may ADD classes freely and may not redefine one the base owns.
     */
    const base = baseBlock(Object.keys(VIEWS)[0]!);
    const owned = new Set(
      [...base.matchAll(/#ROOT\s+\.([\w-]+)/g)].map(match => match[1]!),
    );

    for (const [view, root] of Object.entries(VIEWS)) {
      const style = styleBlock(view);
      const own = style.slice(style.indexOf('end shared base'));
      const redefined = [...own.matchAll(new RegExp(`#${root}\s+\.([\w-]+)`, 'g'))]
        .map(match => match[1]!)
        .filter(name => owned.has(name));

      assert.deepEqual(
        [...new Set(redefined)], [],
        `${view} redefines ${[...new Set(redefined)].join(', ')}, which the shared base owns — `
        + "pick a name of its own, or the base's rules come with it",
      );
    }
  });

  test('no view takes a class name the pairing container itself styles', () => {
    /**
     * Scoping protects one view from another; it does not protect a view from
     * the CONTAINER. A pair view is injected into the pairing container's own
     * document, so a class name is shared with whatever that document already
     * styles under it — and the container's stylesheet is not in this repo, so
     * the only evidence about it is what a real Homey draws.
     *
     * `button` is the one name there IS evidence for. The buttons screen called
     * each gesture's name `.button`, and on hardware every one of them came out
     * inside the container's grey pill with its own padding and its own ink,
     * while the local render — one view alone on a white page — drew the design.
     * A render cannot show this class of defect at all, which is why it is
     * written down here instead.
     *
     * The list is one name long on purpose: a longer one would be guesswork
     * about a stylesheet nobody here has read. Add to it when hardware shows
     * another, never before.
     */
    const TAKEN = ['button'];

    for (const view of Object.keys(VIEWS)) {
      const text = read(view);
      const assigned = [
        // class="…" in the markup
        ...[...text.matchAll(/class="([^"]+)"/g)].map(match => match[1]!),
        // node(tag, 'classes', …) in the script — the only other way one is set
        ...[...text.matchAll(/node\('[a-z]+', '([^']+)'/g)].map(match => match[1]!),
      ].flatMap(value => value.split(/\s+/));

      for (const name of TAKEN) {
        assert.ok(
          !assigned.includes(name),
          `${view} takes the class name \`${name}\`, which the pairing container `
          + 'styles itself — the container wins on everything our rule does not declare',
        );
      }
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
        /**
         * `@keyframes` cannot be scoped, and pretending otherwise would be
         * wrong rather than strict: the name lives in the document, not under a
         * selector. So the rule for one is that its NAME carries the view's own
         * prefix — which is the actual failure mode, two views defining
         * different animations called `pulse` in one shared document.
         */
        if (selector.startsWith('@keyframes')) {
          const name = selector.slice('@keyframes'.length).trim();
          const prefix = root.split('-')[0];
          assert.ok(
            name.startsWith(prefix),
            `${view}: @keyframes "${name}" must start with "${prefix}" — `
            + 'keyframe names are global to the shared document',
          );
          continue;
        }
        // Percentage stops inside a keyframe block are not selectors either.
        if (/^\d+%$/.test(selector) || selector === 'from' || selector === 'to') continue;

        assert.ok(
          selector.split(',').every(part => part.trim().startsWith(`#${root}`)),
          `${view}: selector "${selector}" is not scoped to #${root}`,
        );
      }
    }
  });

  test('every type size is one of the five the design system allows', () => {
    /**
     * Five sizes, and the system is explicit that there is no sixth: 20 for a
     * screen title, 16 for group headings and every button, 15 for row titles
     * and body, 13 for metadata, 11 for the eyebrow and the chart axes.
     *
     * 32 is the one addition, and it is not a sixth step: it is the display
     * numeral on two screens — the try-it clock and the room-sensing hero —
     * which the canvas draws at 32 and nothing else uses.
     *
     * What this replaces is 12.5, 13.5 and 14.5, which between them accounted
     * for 65 declarations. Nothing told them apart at a glance and every new
     * screen had to guess which of the three it wanted, so they had started to
     * be picked by whichever neighbouring rule was copied first.
     */
    const ALLOWED_SIZES = new Set(['11', '13', '15', '16', '20', '32']);

    for (const view of Object.keys(VIEWS)) {
      const bad = [...styleBlock(view).matchAll(/font-size:\s*([0-9.]+)px/g)]
        .map(match => match[1]!)
        .filter(size => !ALLOWED_SIZES.has(size));

      assert.deepEqual(
        [...new Set(bad)], [],
        `${view}: font-size(s) outside the scale — 20/16/15/13/11, plus 32 for `
        + 'the two display numerals',
      );
    }
  });

  test('every radius is one of the four the design system allows', () => {
    /**
     * A doubling scale: 8 for controls and swatches, 12 for fills, banners and
     * buttons, 16 for cards and screens, and a pill for the wizard CTA and the
     * progress pips.
     *
     * Two exceptions, both non-interactive: 50% for radio marks and numbered
     * medallions, and 2px on chart bars — including the `2px 2px 0 0` form a
     * bar drawn from the bottom up takes.
     *
     * The old 6, 7, 9, 10, 11 and 14 are all folded in. 14 was the card radius
     * on all 24 cards, which is why this one is worth a test rather than a
     * find-and-replace: a card added later would have copied it.
     */
    const ALLOWED_RADII = new Set(['8', '12', '16', '999', '2', '50%']);

    for (const view of Object.keys(VIEWS)) {
      // A compound value is one corner each — a chart bar, or a block that
      // runs off the edge of a timeline — so every corner is checked on its own.
      const bad = [...styleBlock(view).matchAll(/border-radius:\s*([^;}]+)/g)]
        .flatMap(match => match[1]!.trim().split(/\s+/))
        .map(value => value.replace(/px$/, ''))
        .filter(value => value !== '0')
        .filter(value => !ALLOWED_RADII.has(value));

      assert.deepEqual(
        [...new Set(bad)], [],
        `${view}: border-radius outside the scale — 8, 12, 16 or a pill, with `
        + '50% for round marks and 2px for chart bars',
      );
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

  test('every token a view uses is a token the base defines', () => {
    /**
     * An undefined custom property is not an error anywhere: the declaration is
     * simply dropped and the element renders with no background, no colour, no
     * shadow — which on a 30x12px chip is an icon that is not there.
     *
     * That shipped. The "cooler" tile asked for `--lk-cooler-ramp` through a
     * name one letter different from the one the base declares, passed the
     * colour-literal check above (it IS a token) and drew nothing at all. Every
     * other check in this file is about what a view says; this one is about
     * whether the base answers.
     */
    const base = baseBlock(Object.keys(VIEWS)[0]!);
    const defined = new Set(
      [...base.matchAll(/(--lk-[\w-]+)\s*:/g)].map(match => match[1]!),
    );

    for (const view of Object.keys(VIEWS)) {
      const used = new Set(
        [...read(view).matchAll(/var\((--lk-[\w-]+)/g)].map(match => match[1]!),
      );
      const missing = [...used].filter(token => !defined.has(token));

      assert.deepEqual(
        missing, [],
        `${view} uses ${missing.join(', ')}, which the shared base does not define — `
        + 'the declaration is dropped in silence and the element draws nothing',
      );
    }
  });

  test('no font shorthand ends in `inherit`, because that declaration is dropped', () => {
    /**
     * `font: 600 12px/1 inherit` looks like "this size, this weight, the font
     * we already have". It is INVALID: `inherit` is a CSS-wide keyword and may
     * only be an entire value, never a component of a shorthand — so the
     * browser throws the whole declaration away and the element renders at
     * whatever it inherited, 16px and regular.
     *
     * It shipped in seven places and nobody saw it, because every one of them
     * was a control small enough that "a bit big" read as a design choice: the
     * stepper glyphs, the day chips, the Add buttons. Measured in headless
     * Chrome, `font: 600 12px/1 inherit` computes to 16px/400.
     *
     * Bare `font: inherit` is fine and is used by every button in these views —
     * that one IS the whole value.
     */
    for (const view of Object.keys(VIEWS)) {
      const bad = [...styleBlock(view).matchAll(/font:\s*[^;]*\S\s+inherit\s*;/g)]
        .map(match => match[0].replace(/\s+/g, ' '));

      assert.deepEqual(
        bad, [],
        `${view}: a font shorthand with \`inherit\` as a component is dropped `
        + 'entirely — write the longhand properties instead',
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
 * module to import them from. Both are spliced from `views/shared/` now, so this
 * guards the splice rather than a human's diligence — and still earns its keep,
 * because nothing runs `sync:views` for you. Unlike the CSS they had no guard, so one of them
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
  function assertIdentical(name: string, atLeast = 2): void {
    const copies = Object.keys(VIEWS)
      .map(view => ({ view, body: helper(view, name) }))
      .filter((c): c is { view: string; body: string } => c.body !== null);

    assert.ok(copies.length >= atLeast, `${name}() appears in ${copies.length} view(s)`);

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

  /**
   * And it appears EVERYWHERE, which the test above cannot say on its own.
   *
   * The scrolling element belongs to the pairing container, not to a view, so it
   * outlives every screen in the session: whichever view boots first decides
   * whether the gutter is reserved for the whole flow. While this lived in the
   * credential screen alone, the two device types that have one were stable from
   * step 1 and the three without it were stable nowhere — so unfolding the sensor
   * list took 15px off the usable width and the heading above it moved from one
   * line to two, under the tap that unfolded it.
   *
   * A floor of one view would have passed that entire time, which is why this is
   * "all of them" rather than "more than one".
   */
  test('every view reserves the scrollbar gutter', () => {
    for (const view of Object.keys(VIEWS)) {
      assert.ok(
        helper(view, 'stabiliseScrollbar') !== null,
        `${view} does not stabilise the scrollbar — one view that skips it leaves `
        + "the whole flow's width free to change when a list unfolds",
      );
    }
  });

  test('emit() is identical everywhere it appears', () => {
    assertIdentical('emit');
  });

  test('no view builds markup from a string any more', () => {
    /**
     * `escapeHtml` used to be load-bearing in exactly two views: the schedule
     * screen and the curve screen each built a card's markup as a string and
     * assigned it with `innerHTML`, so every interpolated value had to go
     * through it.
     *
     * Both were rewritten as nodes in the pairing redesign, and with them the
     * last `innerHTML` in the app. So the guard that matters is no longer
     * "escapeHtml agrees everywhere" but "there is nothing for it to guard" —
     * which is a stronger property and a cheaper one to keep.
     */
    for (const view of Object.keys(VIEWS)) {
      assert.equal(
        read(view).includes('escapeHtml'), false,
        `${view} still has escapeHtml — has a view gone back to building markup?`,
      );
    }
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

  test('clock() is identical everywhere it appears', () => {
    // The minute-to-"HH:MM" formatter, on the four screens that show a time.
    // It was called `formatMinutes` on one of them and `clock` on the other
    // three, which is exactly the drift this whole file exists to catch — two
    // names for one function is how two implementations start.
    assertIdentical('clock');
  });

  test('weekGrid() is identical everywhere it appears', () => {
    // Spliced from views/shared/week-grid.js into the screen that draws a
    // sensor's week — ONE since the detail screen went, so one copy is enough
    // here; a second must still match it.
    assertIdentical('weekGrid', 1);
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


  test('every view carrying the week grid has what it closes over', () => {
    // `weekGrid` uses `node` and `Homey` without declaring them, which is what
    // lets its body be byte-identical on two screens with nothing else in
    // common — and is also the dependency that would otherwise fail at runtime
    // on one screen only.
    for (const view of Object.keys(VIEWS)) {
      if (!helper(view, 'weekGrid')) continue;
      assert.ok(helper(view, 'node'), `${view} carries the week grid but has no node()`);
      assert.ok(helper(view, 'emit'), `${view} carries the week grid but has no emit()`);
    }
  });

  test('emit() appears in every view, because it is the only way out', () => {
    for (const view of Object.keys(VIEWS)) {
      assert.ok(helper(view, 'emit'), `${view} has no emit() helper`);
    }
  });

  test('i18n() is identical everywhere it appears', () => {
    assertIdentical('i18n');
  });

  /**
   * Every screen translates through `lk`, and reads in its language's direction.
   *
   * `lk.t` is `Homey.__` plus the plural step (views/shared/i18n.js), so a view
   * that called `Homey.__` directly would render a counted string as its key —
   * silently, in exactly the languages nobody here reads. And `dir` has to be on
   * the root because the screens share one document and only the root is ours.
   */
  test('every view translates through i18n() and sets its direction', () => {
    for (const view of Object.keys(VIEWS)) {
      const text = read(view);
      assert.ok(helper(view, 'i18n'), `${view} has no i18n() helper`);
      assert.match(text, /var lk = i18n\(Homey\);\s*__root\.dir = lk\.dir;/, `${view} does not set its root's dir`);
      const direct = text.split('\n').filter(line => /Homey\.__\(/.test(line) && !/^\s*(\*|\/\/)/.test(line));
      assert.deepEqual(direct, [], `${view} calls Homey.__ directly — use lk.t, which picks plural forms`);
    }
  });

  test('the settings page carries the same i18n() as the views', () => {
    const page = readFileSync(join(ROOT, 'settings', 'index.html'), 'utf8');
    const first = Object.keys(VIEWS)[0]!;
    const extract = (text: string) => {
      const at = text.indexOf('function i18n(');
      let depth = 0;
      for (let i = text.indexOf('{', at); i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1);
      }
      return '';
    };
    assert.equal(extract(page), extract(read(first)), 'run npm run sync:views');
  });

  /**
   * A spliced function carries no docblock ABOVE it, in any carrier.
   *
   * `spliceFunction` in scripts/sync-views.mjs matches from the `function`
   * keyword to its closing brace, so anything above that point is outside the
   * region it replaces. When a shared source had its own docblock above
   * `function`, every `npm run sync:views` therefore PREPENDED another copy
   * instead of replacing one — and `sync:views:check` could not see it, because
   * all the carriers accumulated identically and so never drifted from each
   * other. Four copies of a stale week-grid docblock reached the shipped archive
   * that way, each contradicting the real one inside the function.
   *
   * `stabiliseScrollbar()` is the example to copy: its docblock is inside. This
   * asserts the convention CLAUDE.md states at the only place it can be checked
   * — the carriers — and over every spliced helper, so a fifth shared source
   * cannot reintroduce it.
   */
  test('no spliced helper has a docblock above it, which is how copies accumulate', () => {
    for (const view of Object.keys(VIEWS)) {
      const text = read(view);
      for (const name of ['emit', 'weekGrid', 'stabiliseScrollbar', 'i18n']) {
        const at = text.indexOf(`function ${name}(`);
        if (at === -1) continue;

        assert.ok(
          !text.slice(0, at).trimEnd().endsWith('*/'),
          `${view}: ${name}() is preceded by a comment block. `
          + 'scripts/sync-views.mjs splices from the `function` keyword, so a docblock above it '
          + 'is never replaced — it is prepended again on every sync. Put it inside the function, '
          + 'in views/shared/.',
        );
      }
    }
  });
});
