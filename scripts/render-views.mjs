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
 * THE CHROME IS DRAWN, and it has to be. Homey injects a pairing view into ITS
 * document, inside a sheet with a header and a footer of its own (platform §8).
 * This used to render the view alone on white, and the omission was not neutral:
 * Homey's footer already carries `← Previous` and a blue `Next →` pill for every
 * step whose `navigation` names one, so a render without it could not show that
 * a view drawing its own full-width Next was drawing a SECOND one. Comparing
 * such a render against a design that includes the chrome made the app's own
 * button look like the design's, and the duplicate survived four screens.
 *
 * So the sheet is reproduced here from what a real Homey draws — measured off
 * my.homey.app, metrics in CHROME below — and the buttons come from each
 * driver's own `driver.compose.json`, never from a list kept in step by hand.
 *
 * It is still a reproduction, and two things about it are deliberately NOT the
 * real sheet: the render is as tall as the whole screen rather than cut at the
 * viewport (a contact sheet exists to show the end of the longest screen), and
 * the fold is marked instead, where a phone would stop.
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

import { DRIVER_REPLIES, RENDER_REPLIES } from './pair-view-fixtures.mjs';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = join(here, '..');
const DRIVERS = join(ROOT, 'drivers');
let OUT = join(ROOT, '.views');

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

/**
 * Homey's own pairing sheet, measured off my.homey.app rather than guessed.
 *
 * `gutter` is the one number here that changes how OUR screens are judged: it
 * is the space Homey puts either side of the injected view, on top of the 16px
 * the view's own root already has. Everything else is chrome the app cannot
 * touch and is reproduced only so the view is seen between the two things that
 * actually sit above and below it on a phone.
 *
 * The fold is where a 812pt phone stops, which is the shortest screen anybody
 * pairs on. Above it is what somebody sees without scrolling.
 */
const CHROME = {
  gutter: 16,
  headerHeight: 56,
  footerHeight: 76,
  radius: 14,
  fold: 812,
};

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

  /** @type {{ driver: string, label: string, file: string, step: number, of: number,
               prev: boolean, next: boolean }[]} */
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

    /**
     * Which chrome buttons Homey will draw around this view, which is the one
     * thing about the real sheet a render can know for certain: `navigation`
     * in driver.compose.json IS what the container reads. A view the compose
     * does not name gets neither, because Homey never shows it.
     */
    const nav = new Map((compose.pair ?? []).map((/** @type {any} */ step) =>
      [`${step.id}.html`, step.navigation ?? {}]));

    ordered.forEach((file, index) => {
      const navigation = nav.get(file) ?? {};
      found.push({
        driver, label, file, step: index + 1, of: ordered.length,
        prev: Boolean(navigation.prev), next: Boolean(navigation.next),
      });
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
 *
 * @param {string} lang which `locales/<lang>.json` to read
 */
function locales(lang) {
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
  // Plural groups flatten to `key.one`, `key.other` — exactly the keys
  // views/shared/i18n.js asks the stub for.
  walk(JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8')), '');
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
 * @param {{ app: string, prev: boolean, next: boolean }} chrome
 */
function page(html, replies, strings, width, chrome) {
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
      var tall = Math.ceil(rect.bottom + (window.scrollY || 0));
      // A screen that fits on a phone has no fold to mark, and a dashed line
      // across the white below it would read as one.
      var fold = document.getElementById('lk-fold');
      if (fold) fold.style.display = tall > ${CHROME.fold} ? '' : 'none';
      document.title = 'fit:' + tall;
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

  /**
   * Homey's footer, drawn only where the compose asks for it.
   *
   * The label is `Next` on every step that has one — NOT the verb the design
   * canvas writes on the pill. The canvas puts `Start` on the intro and
   * `Add device` on the review because that is the INTENT of the step; Homey
   * draws the word `Next` regardless, and a render that flattered the canvas
   * here would hide the one place the two genuinely disagree.
   */
  const footer = (chrome.prev || chrome.next)
    ? `<div class="lk-foot">
  ${chrome.prev ? '<span class="lk-prev">&#8592; Previous</span>' : '<span></span>'}
  ${chrome.next ? '<span class="lk-next">Next &#8594;</span>' : ''}
</div>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* ---- Homey's pairing sheet, reproduced -------------------------------
     Everything in this block is the CONTAINER, not the app: it exists so the
     view is judged between the header and the footer it actually sits between.
     Nothing here may leak into the view — the app's own styles are all scoped
     to its root id — so these carry an lk- prefix that no view uses. */
  html, body { margin: 0; padding: 0; background: #eceef2;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "Helvetica Neue", sans-serif; }
  body { width: ${width + CHROME.gutter * 2}px; }
  .lk-sheet { position: relative; background: #ffffff;
    border-radius: ${CHROME.radius}px; overflow: hidden; }
  .lk-head { height: ${CHROME.headerHeight}px; display: flex; align-items: center;
    gap: 12px; padding: 0 22px; box-sizing: border-box; }
  .lk-head .back { font-size: 17px; color: #9aa0a9; }
  .lk-head .title { flex: 1; font-size: 15px; font-weight: 500; color: #6a7180; }
  .lk-head .shut { font-size: 17px; color: #b3b8c0; }
  .lk-body { padding: 0 ${CHROME.gutter}px; }
  .lk-foot { height: ${CHROME.footerHeight}px; display: flex; align-items: center;
    justify-content: space-between; padding: 0 24px; box-sizing: border-box; }
  .lk-prev { font-size: 15px; font-weight: 500; color: #8a9099; }
  .lk-next { font-size: 15px; font-weight: 600; color: #ffffff; padding: 14px 30px;
    border-radius: 999px; background: linear-gradient(100deg, #2f7ef0, #55a8f5); }
  /* Where a phone stops. Drawn over everything, because what it marks is the
     line between the part of a screen somebody sees and the part they have to
     go looking for. */
  .lk-fold { position: absolute; left: 0; right: 0; top: ${CHROME.fold}px;
    border-top: 1px dashed #c2b4e6; pointer-events: none; }
  .lk-fold span { position: absolute; right: 8px; top: -8px; font-size: 9px;
    letter-spacing: .08em; text-transform: uppercase; color: #8d7bc0;
    background: #ffffff; padding: 0 5px; }
</style>
${style}
<script>${stub}</script>
</head><body>
<div class="lk-sheet">
<div class="lk-head"><span class="back">&#8592;</span><span class="title">${chrome.app}</span><span class="shut">&#10005;</span></div>
<div class="lk-body">
${body}
</div>
${footer}
<div class="lk-fold" id="lk-fold"><span>fold</span></div>
</div>
</body></html>`;
}

function main() {
  const argv = process.argv.slice(2);
  const widthAt = argv.indexOf('--width');
  const width = widthAt >= 0 ? Number(argv[widthAt + 1]) : 390;
  /* What a rendered PNG is actually wide, which is the view plus Homey's own
     gutter either side. The contact sheet lays out at this, not at `width`. */
  const shotWidth = width + CHROME.gutter * 2;

  const chrome = findChrome();
  // `--lang de` draws every screen in German, into .views/lang-de/ — for
  // overflow in the long languages and mirroring in Arabic. Default English.
  const langAt = argv.indexOf('--lang');
  const lang = langAt >= 0 ? String(argv[langAt + 1]) : 'en';
  if (!existsSync(join(ROOT, 'locales', `${lang}.json`))) throw new Error(`no locales/${lang}.json`);
  if (lang !== 'en') OUT = join(ROOT, '.views', `lang-${lang}`);
  const strings = locales(lang);
  const all = views();
  /* The word Homey puts in the sheet header is the APP's name, not the
     driver's: a phone pairing a Colour Curve Light still says Lightkeeper. */
  const appName = JSON.parse(
    readFileSync(join(ROOT, '.homeycompose', 'app.json'), 'utf8')).name?.en ?? 'Lightkeeper';

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log(`Rendering ${all.length} view(s) at ${width}px with ${chrome}\n`);

  // Every screen, rendered or not, in flow order — because a screen that did
  // not render is the one most worth noticing, and dropping it from the sheet
  // is how it goes unnoticed. `status` is what the sheet draws in its place.
  const screens = [];
  const missing = [];
  let drawn = '';

  for (const { driver, label, file, step, of, prev, next } of all) {
    if (driver !== drawn) {
      console.log(`  ${label}  (drivers/${driver}/pair)`);
      drawn = driver;
    }
    const where = `    ${step}/${of}  ${file}`;
    const name = `${driver}-${file.replace(/\.html$/, '')}`;
    const entry = { driver, label, file, step, of, name, status: 'ok' };
    screens.push(entry);

    /**
     * The driver's own demo data where there is any, the file's otherwise.
     *
     * `intro.html`, `lights.html` and `review.html` are one file and five
     * screens (platform §8): what a driver answers them with is the entire
     * difference between them. Rendered from the per-file entry alone, the sheet
     * drew the circadian intro five times over and no other device type's was
     * ever on it.
     */
    const byDriver = /** @type {Record<string, Record<string, unknown>>} */ (
      DRIVER_REPLIES)[`${driver}/${file}`];
    const replies = byDriver
      ?? /** @type {Record<string, Record<string, unknown>>} */ (RENDER_REPLIES)[file];
    if (!replies) {
      entry.status = 'no fixture';
      missing.push(`${driver}/${file}`);
      console.log(`${where}  SKIPPED — no fixture in scripts/pair-view-fixtures.mjs`);
      continue;
    }

    const source = readFileSync(join(DRIVERS, driver, 'pair', file), 'utf8');
    const temp = join(OUT, `${name}.html`);
    const shot = join(OUT, `${name}.png`);

    writeFileSync(temp, page(source, replies, strings, width,
      { app: appName, prev, next }), 'utf8');

    // Two passes: one to ask the page how tall it is, one to shoot it at that
    // height. See `measure()` in the stub for why a second run is the only way
    // to get a card that is neither padded with white nor cut off.
    const measured = spawnSync(chrome, [...CHROME_FLAGS,
      `--window-size=${shotWidth},${TALL}`,
      '--dump-dom',
      pathToFileURL(temp).href,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const fit = /<title>fit:(\d+)<\/title>/.exec(String(measured.stdout ?? ''));
    const shotHeight = fit
      ? Math.min(Math.max(Number(fit[1]), MIN_HEIGHT), MAX_HEIGHT)
      : TALL;

    const result = spawnSync(chrome, [...CHROME_FLAGS,
      `--window-size=${shotWidth},${shotHeight}`,
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
  img { display: block; width: ${shotWidth}px; }
  figure.absent { width: ${shotWidth}px; border-style: dashed; }
  .why { padding: 24px 12px; color: #a1a1aa; font-size: 12px; text-align: center; }
</style></head><body>
<header>
<h1>Lightkeeper pairing screens</h1>
<p>Rendered from the shipped files with demo fixtures, grouped by driver and in
the order each driver shows them. What each screen <em>does</em> is checked by
test/unit/pair-view-behaviour.test.ts; this page is only for judging how they
look. Homey's own sheet &mdash; its header, and the <code>&larr; Previous</code> /
<code>Next &rarr;</code> footer it draws from each step's <code>navigation</code>
&mdash; is reproduced around every screen, because what the app draws is only
judgeable against what sits above and below it. The dashed line is the fold on a
812pt phone.</p>
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
