/**
 * Render every pairing screen to a PNG, and a contact sheet to look at them on.
 *
 * The hardware pass used to ask a person to open nine screens on a phone and
 * judge them — T6, T12, T13, T19, T20, T26 and the aesthetic half of T3.
 * What those lines are really asking is "does this look right", and that is the
 * one question a machine genuinely cannot answer. It can, though, put every
 * screen on one page so answering it takes a minute instead of a pairing session
 * per driver.
 *
 * WHAT THIS IS NOT. It is not a check. Nothing here passes or fails, nothing
 * runs in CI, and a screen's RULES — what it refuses, what it draws for given
 * data — are covered by `test/unit/pair-view-behaviour.test.ts`, which does fail.
 * This is a contact sheet.
 *
 * Headless Chrome is the house rasteriser: `artwork/export-assets.py` already
 * shells out to it the same way, with the same candidate list. Nothing is
 * installed for this.
 *
 * WHAT IT CANNOT SHOW. Homey injects a pairing view into ITS document, with its
 * own header, sheet chrome and scroll container around it (platform §8). This
 * renders the view alone on a white ground, which is the right approximation —
 * every screen the app draws is light and deliberately does not ask the OS — but
 * it is an approximation. Spacing against Homey's own chrome is not in here.
 *
 * USAGE
 *
 *   npm run render:views
 *   node scripts/render-views.mjs --width 430 --open
 *
 * Output goes to `.views/`, which is gitignored: a rendered screen carries
 * whatever the fixtures say, and the rule about never committing anything that
 * looks like a capture from a real Homey is easier to keep if the directory can
 * never be added by accident.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { RENDER_REPLIES } from './pair-view-fixtures.mjs';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = join(here, '..');
const DRIVERS = join(ROOT, 'drivers');
const OUT = join(ROOT, '.views');

/** Same list as artwork/export-assets.py, for the same reason. */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ['chrome', 'google-chrome', 'chromium']) {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name],
      { encoding: 'utf8' });
    const first = String(found.stdout ?? '').split(/\r?\n/)[0]?.trim();
    if (found.status === 0 && first) return first;
  }
  throw new Error(
    'Headless Chrome is needed to render the views and was not found. Install '
    + 'Chrome, or read the screens\' rules from test/unit/pair-view-behaviour.test.ts '
    + 'instead — that is where what they DO is checked.',
  );
}

/** Every pair view on disk, as `{ driver, file }`. Discovered, never listed. */
function views() {
  const found = [];
  for (const driver of readdirSync(DRIVERS)) {
    const dir = join(DRIVERS, driver, 'pair');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.html')) found.push({ driver, file });
    }
  }
  return found.sort((a, b) => `${a.driver}/${a.file}`.localeCompare(`${b.driver}/${b.file}`));
}

/**
 * The locale strings, resolved the way the pairing container resolves them.
 *
 * Rendering with the raw keys would produce a page covered in `circadian.point`,
 * which is not a page anybody can judge. Tokens are substituted the same way
 * Homey's own `__` does — `__token__` — so a missing token shows up as the
 * marker rather than as a plausible blank.
 */
function locales() {
  /** @type {Map<string, string>} */
  const flat = new Map();
  /** @param {any} node @param {string} prefix */
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, path);
      else flat.set(path, String(value));
    }
  };
  walk(JSON.parse(readFileSync(join(ROOT, 'locales', 'en.json'), 'utf8')), '');
  return Object.fromEntries(flat);
}

/**
 * One view, wrapped in a document with a stub `Homey` in front of it.
 *
 * The stub is defined BEFORE the view's own script, because every view polls
 * `window.Homey` and boots the moment it appears — which is the same path the
 * device takes, and the reason a view rendered without it would sit there
 * showing its static markup and nothing else.
 *
 * @param {string} html
 * @param {Record<string, unknown>} replies
 * @param {Record<string, string>} strings
 * @param {number} width
 */
function page(html, replies, strings, width) {
  const stub = `
    var STRINGS = ${JSON.stringify(strings)};
    var REPLIES = ${JSON.stringify(replies)};
    window.Homey = {
      __: function (key, tokens) {
        var text = STRINGS[key];
        if (text === undefined) return key;
        Object.keys(tokens || {}).forEach(function (name) {
          text = text.split('__' + name + '__').join(String(tokens[name]));
        });
        return text;
      },
      ready: function () {},
      emit: function (event) {
        return Object.prototype.hasOwnProperty.call(REPLIES, event)
          ? Promise.resolve(REPLIES[event])
          : Promise.reject(new Error('no fixture for "' + event + '"'));
      },
      showView: function () {},
      done: function () {},
      createDevice: function (device) { return Promise.resolve(device); },
    };

    /**
     * The container translates [data-i18n] for the view. This has to as well.
     *
     * Only curve.html resolves its own; every other view leaves its static text
     * empty in the markup and relies on Homey's pairing container to fill it in
     * on load. Without that, a render shows the parts the SCRIPT writes and
     * loses every heading, label, checkbox caption and button — which is most of
     * the words on the screen, and exactly the half a contact sheet exists to
     * judge.
     *
     * Re-run on a short interval rather than once: a view fills its list after
     * an emit() resolves, and anything it adds carrying data-i18n arrives after
     * the first pass. Cheap, and it stops before the screenshot is taken.
     */
    function translateStatic() {
      document.querySelectorAll('[data-i18n]').forEach(function (el) {
        var key = el.getAttribute('data-i18n');
        if (key) el.textContent = window.Homey.__(key);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
        var key = el.getAttribute('data-i18n-placeholder');
        if (key) el.placeholder = window.Homey.__(key);
      });
    }
    var passes = 0;
    var translating = setInterval(function () {
      translateStatic();
      if ((passes += 1) > 12) clearInterval(translating);
    }, 150);`;

  /**
   * The view's own `<style>`, and then its markup and script — both verbatim.
   *
   * The style block is load-bearing and easy to lose: it sits ABOVE
   * `<div class="wrap">` in every file, so slicing from the wrap alone produces
   * a page that renders every string correctly and looks nothing like the
   * screen. Which is the one failure mode a contact sheet cannot have, since
   * looking is the entire job.
   */
  const styleStart = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>');
  if (styleStart < 0 || styleEnd < 0) throw new Error('the view has no <style> block');
  const style = html.slice(styleStart, styleEnd + '</style>'.length);

  const body = html.slice(html.indexOf('<div class="wrap"'));

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* Homey's own pairing sheet, approximated: white, light, and this wide. */
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body { width: ${width}px; }
</style>
${style}
<script>${stub}</script>
</head><body>
${body}
</body></html>`;
}

function main() {
  const argv = process.argv.slice(2);
  const widthAt = argv.indexOf('--width');
  const width = widthAt >= 0 ? Number(argv[widthAt + 1]) : 390;
  const height = 1600;

  const chrome = findChrome();
  const strings = locales();
  const all = views();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log(`Rendering ${all.length} view(s) at ${width}px with ${chrome}\n`);

  const rendered = [];
  const missing = [];

  for (const { driver, file } of all) {
    const replies = /** @type {Record<string, Record<string, unknown>>} */ (RENDER_REPLIES)[file];
    if (!replies) {
      missing.push(`${driver}/${file}`);
      console.log(`  ${driver}/${file}  SKIPPED — no fixture in scripts/pair-view-fixtures.mjs`);
      continue;
    }

    const name = `${driver}-${file.replace(/\.html$/, '')}`;
    const source = readFileSync(join(DRIVERS, driver, 'pair', file), 'utf8');
    const temp = join(OUT, `${name}.html`);
    const shot = join(OUT, `${name}.png`);

    writeFileSync(temp, page(source, replies, strings, width), 'utf8');

    const result = spawnSync(chrome, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${width},${height}`,
      // The views render from a promise, so the budget has to outlast a
      // microtask queue rather than only the parse.
      '--virtual-time-budget=4000',
      `--screenshot=${shot}`,
      pathToFileURL(temp).href,
    ], { stdio: 'ignore' });

    if (result.status !== 0 || !existsSync(shot)) {
      console.log(`  ${driver}/${file}  FAILED — Chrome exited ${result.status}`);
      continue;
    }
    rendered.push({ driver, file, name });
    console.log(`  ${driver}/${file}  → .views/${name}.png`);
  }

  // The sheet itself. One page, every screen, captioned with the file it came
  // from so a note about "the third one" can name something.
  const sheet = `<!doctype html><html><head><meta charset="utf-8">
<title>Lightkeeper pairing screens</title>
<style>
  body { margin: 0; padding: 24px; background: #f4f4f5; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: #52525b; font-size: 13px; margin: 0 0 24px; max-width: 60ch; }
  .grid { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  figure { margin: 0; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; overflow: hidden; }
  figcaption { font-size: 12px; padding: 8px 12px; color: #3f3f46; border-bottom: 1px solid #e4e4e7; }
  img { display: block; width: ${width}px; }
</style></head><body>
<h1>Lightkeeper pairing screens</h1>
<p>Rendered from the shipped files with demo fixtures. What each screen
<em>does</em> is checked by test/unit/pair-view-behaviour.test.ts; this page is
only for judging how they look. Homey draws its own header and sheet around
these, which is not shown.</p>
<div class="grid">
${rendered.map(v => `<figure>`
    + `<figcaption><a href="${v.name}.png">${v.driver}/${v.file}</a></figcaption>`
    + `<a class="shot" href="${v.name}.png">`
    + `<img src="${v.name}.png" alt="${v.driver}/${v.file}"></a></figure>`).join(String.fromCharCode(10))}
</div></body></html>`;

  const sheetPath = join(OUT, 'index.html');
  writeFileSync(sheetPath, sheet, 'utf8');

  console.log(`\n${rendered.length} rendered. Open ${sheetPath}`);
  if (missing.length > 0) {
    // Named rather than counted: an unrendered screen is one nobody looks at.
    console.log(`\nNo fixture for: ${missing.join(', ')}`);
    console.log('Add one to scripts/pair-view-fixtures.mjs — '
      + 'test/unit/pair-view-render-fixtures.test.ts fails until you do.');
  }

  if (argv.includes('--open')) {
    const opener = process.platform === 'win32' ? 'explorer'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [sheetPath], { stdio: 'ignore' });
  }
}

main();
