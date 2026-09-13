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

/**
 * The flags both passes share. `--virtual-time-budget` is the load-bearing one:
 * the views render from a promise, so the budget has to outlast a microtask
 * queue rather than only the parse.
 */
const CHROME_FLAGS = [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--virtual-time-budget=4000',
];

/** The window the measuring pass uses, and the fallback if it says nothing. */
const TALL = 1600;
/**
 * A card is never shorter than a phone. The ceiling is a guard against a
 * runaway layout, not a budget: the tallest screen here measures about 4700px
 * (curve.html, six points and the daylight card), and a cap under that silently
 * cuts the bottom off the longest screen on the sheet — which is the one most
 * worth scrolling to the end of.
 */
const MIN_HEIGHT = 560;
const MAX_HEIGHT = 8000;

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

/**
 * Which driver comes first on the sheet: the two that generate Flows, then the
 * three that do not (platform §12) — the order every document in this repo
 * introduces them in.
 *
 * Sorting the file names instead put `circadian` at the top and split the
 * controller's four screens away from the schedule's three, so the sheet opened
 * halfway through a flow nobody had been shown the start of. A driver missing
 * from this list is appended alphabetically rather than dropped: a new driver
 * still renders, just at the end, until somebody decides where it belongs.
 */
const DRIVER_ORDER = ['controller', 'schedule', 'circadian', 'curve', 'daylight'];

/**
 * Every pair view on disk, in the order a person is actually walked through
 * them. Discovered, never listed.
 *
 * The step order comes from each driver's own `driver.compose.json`, because
 * `pair[].id` IS the order Homey shows the screens in and a view file is named
 * for its step — so re-ordering a pairing flow re-orders this sheet by itself,
 * with nothing here to keep in step. Anything in the folder that no step names
 * is still rendered, after the steps: an unreferenced view is worth SEEING,
 * since being unreferenced is the more interesting thing about it.
 */
function views() {
  /** @param {string} driver */
  const rank = (driver) => {
    const at = DRIVER_ORDER.indexOf(driver);
    return at < 0 ? DRIVER_ORDER.length : at;
  };
  const drivers = readdirSync(DRIVERS)
    .filter(driver => existsSync(join(DRIVERS, driver, 'pair')))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  /** @type {{ driver: string, label: string, file: string, step: number, of: number }[]} */
  const found = [];
  for (const driver of drivers) {
    const dir = join(DRIVERS, driver, 'pair');
    const files = readdirSync(dir).filter(file => file.endsWith('.html')).sort();
    const compose = JSON.parse(
      readFileSync(join(DRIVERS, driver, 'driver.compose.json'), 'utf8'));
    const steps = (compose.pair ?? [])
      .map((/** @type {any} */ step) => `${step.id}.html`)
      .filter((/** @type {string} */ file) => files.includes(file));
    const ordered = [...steps, ...files.filter(file => !steps.includes(file))];
    const label = compose.name?.en ?? driver;

    ordered.forEach((file, index) => {
      found.push({ driver, label, file, step: index + 1, of: ordered.length });
    });
  }
  return found;
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
      // The container pushes events to a view with Homey.on. A stub without it
      // takes the buttons and listen screens down before their first emit, and
      // the render is then a heading over an empty page. (No backticks in here:
      // this whole block is a template literal.)
      on: function () {},
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
      measure();
      if ((passes += 1) > 12) clearInterval(translating);
    }, 150);

    /**
     * How tall this screen actually is, published where a second Chrome run can
     * read it back.
     *
     * Chrome captures the VIEWPORT and nothing else — measured, in both the old
     * and the new headless — so a screen shot at a fixed tall window is padded
     * with white to the bottom of it, and a screen taller than it is silently
     * cut off. Both are fatal to a contact sheet: one buries the next card a
     * page below the fold, the other loses the part nobody has looked at yet.
     * The title is the channel because --dump-dom returns it without the page
     * needing anything the stub does not already have. (No backticks in here:
     * this comment is inside a template literal, and one would end it.)
     */
    function measure() {
      // The BODY's own box, not documentElement.scrollHeight: that one is
      // floored at the viewport, so every short screen measured exactly as tall
      // as the measuring window and nothing was trimmed at all. No view uses a
      // vh unit, so the content box is the whole answer.
      if (!document.body) return;
      var rect = document.body.getBoundingClientRect();
      document.title = 'fit:' + Math.ceil(rect.bottom + (window.scrollY || 0));
    }`;

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

  const chrome = findChrome();
  const strings = locales();
  const all = views();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log(`Rendering ${all.length} view(s) at ${width}px with ${chrome}\n`);

  // Every screen, rendered or not, in flow order — because a screen that did
  // not render is the one most worth noticing, and dropping it from the sheet
  // is how it goes unnoticed. `status` is what the sheet draws in its place.
  const screens = [];
  const missing = [];
  let drawn = '';

  for (const { driver, label, file, step, of } of all) {
    if (driver !== drawn) {
      console.log(`  ${label}  (drivers/${driver}/pair)`);
      drawn = driver;
    }
    const where = `    ${step}/${of}  ${file}`;
    const name = `${driver}-${file.replace(/\.html$/, '')}`;
    const entry = { driver, label, file, step, of, name, status: 'ok' };
    screens.push(entry);

    const replies = /** @type {Record<string, Record<string, unknown>>} */ (RENDER_REPLIES)[file];
    if (!replies) {
      entry.status = 'no fixture';
      missing.push(`${driver}/${file}`);
      console.log(`${where}  SKIPPED — no fixture in scripts/pair-view-fixtures.mjs`);
      continue;
    }

    const source = readFileSync(join(DRIVERS, driver, 'pair', file), 'utf8');
    const temp = join(OUT, `${name}.html`);
    const shot = join(OUT, `${name}.png`);

    writeFileSync(temp, page(source, replies, strings, width), 'utf8');

    // Two passes: one to ask the page how tall it is, one to shoot it at that
    // height. See `measure()` in the stub for why a second run is the only way
    // to get a card that is neither padded with white nor cut off.
    const measured = spawnSync(chrome, [...CHROME_FLAGS,
      `--window-size=${width},${TALL}`,
      '--dump-dom',
      pathToFileURL(temp).href,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const fit = /<title>fit:(\d+)<\/title>/.exec(String(measured.stdout ?? ''));
    const shotHeight = fit
      ? Math.min(Math.max(Number(fit[1]), MIN_HEIGHT), MAX_HEIGHT)
      : TALL;

    const result = spawnSync(chrome, [...CHROME_FLAGS,
      `--window-size=${width},${shotHeight}`,
      `--screenshot=${shot}`,
      pathToFileURL(temp).href,
    ], { stdio: 'ignore' });

    if (result.status !== 0 || !existsSync(shot)) {
      entry.status = `Chrome exited ${result.status}`;
      console.log(`${where}  FAILED — Chrome exited ${result.status}`);
      continue;
    }
    console.log(`${where}  → .views/${name}.png`);
  }

  const rendered = screens.filter(screen => screen.status === 'ok');

  // The sheet itself: one section per driver, screens in the order the driver
  // shows them, each captioned with its step number and its file. A note about
  // "the third one" can then name something, and a reader who has never paired
  // the app is walked through a flow rather than handed thirteen pictures in
  // whatever order the file names fell out.
  const byDriver = [];
  for (const screen of screens) {
    const last = byDriver[byDriver.length - 1];
    if (last && last.driver === screen.driver) last.screens.push(screen);
    else byDriver.push({ driver: screen.driver, label: screen.label, screens: [screen] });
  }

  /** @param {{ name: string, file: string, driver: string, step: number, status: string }} v */
  const card = (v) => {
    const caption = `<figcaption><span class="step">${v.step}</span>`
      + `<span class="file">${v.file}</span>`
      + `<span class="path">drivers/${v.driver}/pair</span></figcaption>`;
    // A screen that did not render keeps its place in the flow and says why.
    // Silently omitting it would leave a gap in the numbering and nothing else.
    if (v.status !== 'ok') {
      return `<figure class="absent">${caption}`
        + `<div class="why">${v.status}</div></figure>`;
    }
    return `<figure>${caption}`
      + `<a class="shot" href="${v.name}.png" title="open the full-size render">`
      + `<img src="${v.name}.png" alt="${v.driver}/${v.file}"></a></figure>`;
  };

  const sections = byDriver.map(group => `<section id="${group.driver}">
<h2>${group.label} <span class="count">${group.screens.length} screen${group.screens.length === 1 ? '' : 's'}</span></h2>
<div class="grid">
${group.screens.map(card).join(String.fromCharCode(10))}
</div>
</section>`).join(String.fromCharCode(10));

  const contents = byDriver.map(group =>
    `<a href="#${group.driver}">${group.label}<span>${group.screens.length}</span></a>`).join('');

  const sheet = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lightkeeper pairing screens</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 0 24px 48px; background: #f4f4f5; color: #18181b;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 1; margin: 0 -24px 8px; padding: 20px 24px 12px;
    background: #f4f4f5cc; backdrop-filter: blur(6px); border-bottom: 1px solid #e4e4e7; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  header p { color: #52525b; font-size: 13px; margin: 0 0 12px; max-width: 68ch; }
  .meta { color: #71717a; font-size: 12px; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  nav a { display: inline-flex; align-items: center; gap: 6px; text-decoration: none;
    font-size: 12px; color: #3f3f46; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 999px; padding: 4px 10px; }
  nav a:hover { border-color: #a1a1aa; }
  nav a span { color: #a1a1aa; }
  section { margin: 32px 0 0; scroll-margin-top: 140px; }
  h2 { font-size: 15px; margin: 0 0 12px; display: flex; align-items: baseline; gap: 8px; }
  h2 .count { font-weight: 400; font-size: 12px; color: #71717a; }
  .grid { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  figure { margin: 0; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px;
    overflow: hidden; }
  figcaption { display: flex; align-items: center; gap: 8px; font-size: 12px;
    padding: 8px 12px; color: #3f3f46; border-bottom: 1px solid #e4e4e7; }
  .step { flex: none; width: 18px; height: 18px; border-radius: 50%; background: #18181b;
    color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
  .file { font-weight: 600; }
  .path { margin-left: auto; color: #a1a1aa; font-size: 11px; }
  img { display: block; width: ${width}px; }
  figure.absent { width: ${width}px; border-style: dashed; }
  .why { padding: 24px 12px; color: #a1a1aa; font-size: 12px; text-align: center; }
</style></head><body>
<header>
<h1>Lightkeeper pairing screens</h1>
<p>Rendered from the shipped files with demo fixtures, grouped by driver and in
the order each driver shows them. What each screen <em>does</em> is checked by
test/unit/pair-view-behaviour.test.ts; this page is only for judging how they
look. Homey draws its own header and sheet around these, which is not shown.</p>
<div class="meta">${rendered.length} of ${screens.length} screens · ${width}px wide · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
<nav>${contents}</nav>
</header>
${sections}
</body></html>`;

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
