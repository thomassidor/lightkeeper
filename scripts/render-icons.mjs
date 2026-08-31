/**
 * Draw every shipped icon at the size the App Store actually draws it, and a
 * contact sheet to judge them on.
 *
 * WHY THIS EXISTS. Lightkeeper 0.5.0 shipped with flow-card icons that read as
 * empty circles on the store listing. Nothing was broken: the CDN served the
 * right bytes, the mask URL resolved, and the markup around it was byte-for-byte
 * what IKEA and Philips Hue get. The icons were simply drawn too fine for the
 * box. Read off homey.app's own stylesheet:
 *
 *   .app-flowcards .flowcards-inner .flowcard .icon {
 *     width: 40px; height: 40px; padding: 8px; border-radius: 100%;
 *     background: <brandColor>;
 *   }
 *   .icon-inner {
 *     width: 100%; height: 100%; background: white;
 *     mask-size: contain; mask-repeat: no-repeat; mask-position: center center;
 *   }
 *
 * 40px less 8px of padding on each side is a 24x24 MASK BOX. A 960-unit canvas
 * rendered into 24px scales by 0.025, so a 34-unit stroke lands at 0.85px and
 * antialiases to a grey wash. See platform section 10.
 *
 * WHAT THIS IS NOT. It is not a check. Nothing here passes or fails and nothing
 * runs in CI — an icon's RULES (960 canvas, a declared stroke width, no
 * full-canvas rect, black paint only, ink filling the canvas) are covered by
 * test/unit/assets.test.ts, which does fail. This is a contact sheet, the same
 * as scripts/render-views.mjs, and for the same reason: "does this read" is the
 * one question a machine cannot answer.
 *
 * Headless Chrome is the house rasteriser, the same candidate list that
 * artwork/export-assets.py and scripts/render-views.mjs already use. Nothing is
 * installed for this.
 *
 * USAGE
 *
 *   npm run render:icons
 *   node scripts/render-icons.mjs --open
 *   node scripts/render-icons.mjs --reference <url-to-a-published-icon.svg>
 *
 * --reference puts somebody else's published icon in the sheet beside ours, as
 * calibration: an icon known to read at 24px is worth more than an opinion about
 * ours. Any driver icon off apps.homeycdn.net will do.
 *
 * Output goes to .views/icons/, which is gitignored.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = join(here, '..');
const OUT = join(ROOT, '.views', 'icons');

/** The store paints the icon white on the app's brandColor. Both come from the manifest. */
const BRAND = JSON.parse(
  readFileSync(join(ROOT, '.homeycompose', 'app.json'), 'utf8'),
).brandColor ?? '#180E32';

/**
 * The box sizes worth looking at, and what each one is.
 *
 * 40 is the store's flow card and the tightest place an icon ever appears; 56 is
 * its "Supported devices" row; 80 is roughly the 50px --prop-size read off a
 * live Homey's DOM (platform section 10), doubled for the tile. 240 is not a
 * real size — it is the drawing itself, so a fault can be told apart from a
 * rasterising artefact.
 */
const BOXES = [
  { px: 40, label: '40px — store flow card (24px of ink)' },
  { px: 56, label: '56px — store device row' },
  { px: 80, label: '80px — roughly a Homey tile' },
  { px: 240, label: '240px — the drawing itself, not a real size' },
];

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
    'Headless Chrome is needed to rasterise the icons and was not found. Install '
    + 'Chrome, or read what an icon must SATISFY from test/unit/assets.test.ts '
    + 'instead — that is where the rules are checked.',
  );
}

/**
 * Every shipped icon: the app mark, then one per driver, read out of the
 * manifest rather than listed, so a new driver appears here the day it exists.
 */
function icons() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
  const found = [{ label: 'app — assets/icon.svg', path: join(ROOT, 'assets', 'icon.svg') }];

  for (const driver of manifest.drivers ?? []) {
    const path = join(ROOT, 'drivers', driver.id, 'assets', 'icon.svg');
    if (existsSync(path)) {
      found.push({ label: `${driver.id} — drivers/${driver.id}/assets/icon.svg`, path });
    }
  }
  return found;
}

/**
 * An SVG becomes a mask the way the store makes one: a data URI, no network.
 *
 * @param {string} svg
 */
function mask(svg) {
  // Single quotes, because this lands inside a double-quoted style attribute:
  // url("…") closes the attribute and the mask silently becomes nothing, which
  // looks exactly like the bug this script exists to investigate.
  return `url('data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}')`;
}

/**
 * One icon's row: the same markup the store emits, at every box size.
 *
 * The mask longhands are repeated with the -webkit- prefix exactly as
 * homey.app's inline style does, so nothing here is more generous than the page
 * being reproduced. Padding is kept at the store's ratio (8 of 40) rather than
 * fixed, so the ink box scales with the row.
 *
 * @param {{ label: string, svg: string }} entry
 */
function row({ label, svg }) {
  const cells = BOXES.map(box => {
    const pad = Math.round(box.px * 0.2);
    return '<div class="cell">'
      + `<div class="icon" style="width:${box.px}px;height:${box.px}px;`
      + `padding:${pad}px;background:${BRAND}">`
      + `<div class="icon-inner" style="-webkit-mask-image:${mask(svg)};`
      + `mask-image:${mask(svg)}"></div></div>`
      + `<span class="size">${box.px - 2 * pad}px ink</span>`
      + '</div>';
  }).join('');

  return `<section><h2>${label}</h2><div class="row">${cells}</div></section>`;
}

/** @param {{ label: string, svg: string }[]} entries */
function page(entries) {
  const heads = BOXES.map(box => `<div class="head">${box.label}</div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Lightkeeper icons at store size</title>
<style>
  body { margin: 0; padding: 24px; background: #f4f4f5;
         font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #18181b; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.intro { color: #52525b; font-size: 13px; margin: 0 0 20px; max-width: 78ch; line-height: 1.5; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: #3f3f46; }
  section { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px;
            padding: 16px; margin-bottom: 16px; }
  .row, .heads { display: flex; gap: 24px; align-items: flex-end; }
  .heads { margin: 0 0 8px; padding: 0 16px; }
  .head { font-size: 11px; color: #71717a; width: 260px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 260px; }
  .icon { box-sizing: border-box; border-radius: 100%; flex-shrink: 0; }
  .icon-inner { display: block; width: 100%; height: 100%; background: #fff;
                -webkit-mask-size: contain; -webkit-mask-repeat: no-repeat;
                -webkit-mask-position: center center;
                mask-size: contain; mask-repeat: no-repeat; mask-position: center center; }
  .size { font-size: 10px; color: #a1a1aa; }
</style></head><body>
<h1>Lightkeeper icons, drawn the way the App Store draws them</h1>
<p class="intro">White ink masked onto a ${BRAND} circle, mask-size:contain, straight off
homey.app&rsquo;s own stylesheet. The leftmost column is the flow-card icon on the store listing and
the only size that matters for the bug this exists for: a 960 canvas rendered into 24px, where a
34-unit stroke is 0.85px. The rightmost column is the same file at ten times that, so a drawing
fault can be told apart from a rasterising one. Nothing here passes or fails &mdash;
test/unit/assets.test.ts is what checks an icon.</p>
<div class="heads">${heads}</div>
${entries.map(row).join('\n')}
</body></html>`;
}

/** @param {string} url */
async function reference(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`reference icon: HTTP ${response.status} for ${url}`);
  return { label: `reference — ${url.split('/app/')[1] ?? url}`, svg: await response.text() };
}

async function main() {
  const argv = process.argv.slice(2);
  const referenceAt = argv.indexOf('--reference');

  const chrome = findChrome();
  const entries = icons().map(icon => ({
    label: icon.label,
    svg: readFileSync(icon.path, 'utf8'),
  }));

  if (referenceAt >= 0) {
    const url = argv[referenceAt + 1];
    if (!url) throw new Error('--reference needs a URL to a published icon.svg');
    entries.push(await reference(url));
    console.log(`Reference icon fetched from ${url}`);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const html = join(OUT, 'index.html');
  writeFileSync(html, page(entries), 'utf8');

  // Two device scale factors, because they answer different questions. 1x is
  // what a plain screen shows and is the honest test of a hairline; 2x is what
  // most phones and laptops show, where the same hairline gets two device pixels
  // and can look acceptable while 1x does not.
  for (const scale of [1, 2]) {
    const shot = join(OUT, `icons-${scale}x.png`);
    const result = spawnSync(chrome, [
      '--headless', '--disable-gpu', '--hide-scrollbars',
      `--force-device-scale-factor=${scale}`,
      `--window-size=1220,${240 + entries.length * 350}`,
      '--virtual-time-budget=2000',
      `--screenshot=${shot}`,
      pathToFileURL(html).href,
    ], { stdio: 'ignore' });

    if (result.status !== 0 || !existsSync(shot)) {
      console.log(`  ${scale}x  FAILED — Chrome exited ${result.status}`);
      continue;
    }
    console.log(`  ${scale}x  → ${shot}`);
  }

  console.log(`\n${entries.length} icon(s) at ${BOXES.length} sizes. Open ${html}`);
  console.log('The 40px column is the store. If an icon is not legible there, it is not legible.');

  if (argv.includes('--open')) {
    const opener = process.platform === 'win32' ? 'explorer'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [html], { stdio: 'ignore' });
  }
}

main().catch(error => {
  console.error(String(error?.message ?? error));
  process.exit(1);
});
