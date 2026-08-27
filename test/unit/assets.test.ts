import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shipped artwork, checked against what Homey actually enforces.
 *
 * Every PNG here is produced by `python docs/artwork/export-assets.py` from a crop
 * box in that script, so a mistake is a number in a file rather than a bad export
 * — and it is invisible until `homey app validate` refuses the app, or until a
 * reviewer does. homey-lib checks the two required sizes exactly
 * (`Invalid image size (WxH)`), the file's magic bytes against its extension, and
 * the app icon's existence. Everything it checks, this checks first.
 *
 * The SVG rules are ours, not the validator's: homey-lib performs NO content
 * validation on icons at all (a grep for `svg` across its lib finds only two
 * existence checks). The rules come from Athom's published guidelines 1.5 and 1.6
 * — transparent, full canvas, no filled illustrations — and from the one line in
 * homey-lib that says what Homey does with the file: "Icons are rendered white, so
 * choose a darker color that has enough contrast." A fill defeats that.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/** lib/App/index.js IMAGE_SIZES, verbatim. */
const IMAGE_SIZES = {
  app: { small: [250, 175], large: [500, 350], xlarge: [1000, 700] },
  driver: { small: [75, 75], large: [500, 500], xlarge: [1000, 1000] },
} as const;

/** homey-lib validates `['small', 'large']` and never looks at xlarge. */
const REQUIRED_KEYS = ['small', 'large'] as const;

interface Manifest {
  images?: Record<string, string>;
  drivers?: Array<{ id: string; images?: Record<string, string> }>;
}

const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')) as Manifest;

/** width and height straight out of the PNG's IHDR, no dependencies. */
function pngSize(path: string): { width: number; height: number; png: boolean } {
  const buffer = readFileSync(path);
  const png = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { png, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function iconTargets(): Array<{ label: string; path: string }> {
  const targets = [{ label: 'app', path: join(ROOT, 'assets', 'icon.svg') }];
  for (const driver of appJson.drivers ?? []) {
    targets.push({
      label: `driver ${driver.id}`,
      path: join(ROOT, 'drivers', driver.id, 'assets', 'icon.svg'),
    });
  }
  return targets;
}

function imageTargets(): Array<{ label: string; key: string; path: string; kind: 'app' | 'driver' }> {
  const targets: Array<{ label: string; key: string; path: string; kind: 'app' | 'driver' }> = [];

  for (const [key, value] of Object.entries(appJson.images ?? {})) {
    targets.push({ label: 'app', key, path: join(ROOT, value), kind: 'app' });
  }
  for (const driver of appJson.drivers ?? []) {
    for (const [key, value] of Object.entries(driver.images ?? {})) {
      targets.push({ label: `driver ${driver.id}`, key, path: join(ROOT, value), kind: 'driver' });
    }
  }
  return targets;
}

describe('shipped images', () => {
  test('every device type and the app declares images at all', () => {
    // Required at publish level: homey-lib throws "The property `images` is
    // required in order to publish an app" and the same per driver.
    assert.ok(appJson.images, 'app.json declares no images');
    const drivers = appJson.drivers ?? [];
    // The exact SET rather than a count: it says which device types exist, so a
    // driver added or removed reads as what it is instead of as an off-by-one.
    assert.deepEqual(
      drivers.map(d => d.id).sort(),
      ['circadian', 'controller', 'curve', 'schedule'],
      'the four device types',
    );
    for (const driver of drivers) {
      assert.ok(driver.images, `driver ${driver.id} declares no images`);
    }
  });

  test('every required size is declared', () => {
    for (const [label, images] of [
      ['app', appJson.images ?? {}] as const,
      ...(appJson.drivers ?? []).map(d => [`driver ${d.id}`, d.images ?? {}] as const),
    ]) {
      for (const key of REQUIRED_KEYS) {
        assert.ok(images[key], `${label} is missing the ${key} image, which is required at publish`);
      }
    }
  });

  test('every declared image exists and is a real PNG', () => {
    for (const target of imageTargets()) {
      assert.ok(existsSync(target.path), `${target.label} ${target.key}: ${target.path} is missing`);
      assert.ok(pngSize(target.path).png, `${target.label} ${target.key}: not a PNG despite the .png path`);
    }
  });

  test('every image is exactly the size Homey requires', () => {
    for (const target of imageTargets()) {
      const expected = IMAGE_SIZES[target.kind][target.key as keyof typeof IMAGE_SIZES['app']];
      assert.ok(expected, `${target.label}: unexpected image key "${target.key}"`);

      const { width, height } = pngSize(target.path);
      assert.deepEqual(
        [width, height], [...expected],
        `${target.label} ${target.key} is ${width}x${height}, Homey requires `
        + `${expected[0]}x${expected[1]} — re-run python docs/artwork/export-assets.py`,
      );
    }
  });

  test('no orphaned images are left in the bundle', () => {
    // A renamed crop that leaves its predecessor behind ships dead weight in an
    // app whose images are already the largest files in it.
    const declared = new Set(imageTargets().map(t => t.path));
    const dirs = [
      join(ROOT, 'assets', 'images'),
      ...(appJson.drivers ?? []).map(d => join(ROOT, 'drivers', d.id, 'assets', 'images')),
    ];

    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        assert.ok(
          declared.has(join(dir, name)),
          `${join(dir, name)} is shipped but no manifest refers to it`,
        );
      }
    }
  });
});

describe('the palette', () => {
  test('brandColor is the colour the artwork pipeline extracted', () => {
    // #180E32 is 93% of docs/artwork/masters/logo-bitmap-original.png, read out by
    // `export-assets.py --palette`. Tying the manifest to the script's constant is
    // what stops the app's brand colour drifting away from its own logo.
    const script = readFileSync(join(ROOT, 'docs', 'artwork', 'export-assets.py'), 'utf8');
    const declared = /^BRAND = '(#[0-9A-Fa-f]{6})'/m.exec(script)?.[1];
    assert.ok(declared, 'export-assets.py declares no BRAND colour');

    const compose = JSON.parse(
      readFileSync(join(ROOT, '.homeycompose', 'app.json'), 'utf8'),
    ) as { brandColor?: string };

    assert.equal(
      compose.brandColor?.toLowerCase(), declared.toLowerCase(),
      'brandColor and the artwork pipeline disagree about the brand colour',
    );
  });
});

describe('icons', () => {
  test('the app and every driver has one', () => {
    // The app icon is checked by homey-lib at every level. Driver icons are NOT
    // validated at all — the CLI hashes them if present and ships nothing if
    // absent — but review requires them: "Driver icon is required."
    for (const target of iconTargets()) {
      assert.ok(existsSync(target.path), `${target.label}: ${target.path} is missing`);
    }
  });

  test('each is the full 960x960 canvas', () => {
    // Guideline 1.5/1.6: "Always use the full canvas (960x960px) so the icon is
    // displayed properly." Nothing is asserted about width/height: the icon is
    // consumed as a CSS mask sized by the UI, so an intrinsic size is neither
    // required nor forbidden. An earlier version of this test insisted on one,
    // on the strength of a wrong diagnosis — see assets/icon.svg for what the
    // delivery path actually does.
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      assert.match(svg, /viewBox="0 0 960 960"/, `${target.label}: not a 960x960 canvas`);
    }
  });

  test('each is drawn, not painted into a block', () => {
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      const markup = svg.replace(/<!--[\s\S]*?-->/g, '');

      // The masters are line art and set their own stroke weight, so the weight
      // itself is not asserted — only that one is declared, since an icon with no
      // stroke width renders at 1 user unit and vanishes.
      assert.match(markup, /stroke-width="[\d.]+"/, `${target.label}: no stroke width`);

      // Fills are allowed: the logo's sparkle is a filled path, and homey-lib's own
      // stock icons mix `fill="#000"` shapes with stroked ones. What is not allowed
      // is a background — guideline 1.5, "do not use background colours" — which as
      // a mask would swallow the whole canvas into one opaque block.
      const backgrounds = [...markup.matchAll(/<rect[^>]*>/g)]
        .map(match => match[0])
        .filter(rect => /width="9[0-9]{2}"/.test(rect) && /height="9[0-9]{2}"/.test(rect));
      assert.deepEqual(
        backgrounds, [],
        `${target.label}: a full-canvas rect would mask as a solid block`,
      );

      // Colour inside the file is discarded by the mask, so anything non-black is
      // either dead weight or a sign the master's palette leaked through.
      const colours = [...markup.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{3,6})"/g)]
        .map(match => match[1].toLowerCase())
        .filter(value => value !== '#000' && value !== '#000000');
      assert.deepEqual(colours, [], `${target.label}: coloured paint (${colours.join(', ')})`);
    }
  });

  test('each is generated from a master, and says so', () => {
    // A hand-edit here is lost the next time the export script runs, so the file
    // has to name where it came from.
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      assert.match(
        svg, /GENERATED from docs\/artwork\/masters\/[\w.-]+/,
        `${target.label}: does not name the master it came from`,
      );
    }
  });

  test('each says what it draws', () => {
    // <desc> is how the next reader learns what the mark is meant to be without
    // rasterising it, and every one of ours records what the contact sheet taught.
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      assert.match(svg, /<title>[^<]+<\/title>/, `${target.label}: no <title>`);
      assert.match(svg, /<desc>[^<]+<\/desc>/, `${target.label}: no <desc>`);
    }
  });

  /**
   * Icons and images the curve light SHARES with the circadian light, pending its
   * own artwork.
   *
   * The two device types split out of one, and the second shipped with the
   * first's graphics as placeholders. That is a real review finding — Athom's
   * reviewer flags byte-identical icons as reuse — so it is listed here rather
   * than tolerated silently, and the list is what a `git grep` finds when the
   * artwork is drawn.
   *
   * **Removing an entry from this list is the definition of done for that
   * artwork.** Do not add to it.
   */
  const PENDING_ARTWORK = new Set(['driver curve']);

  test('no two icons share a mark, except artwork not yet drawn', () => {
    // The one icon rule the automated reviewer does enforce: reuse is a finding
    // when two SVGs are byte-equivalent. Visual family resemblance is fine.
    // Compared pairwise across every icon rather than between the two drivers
    // that happened to exist when this was written — a third one copied from a
    // second was exactly what that version could not see.
    const seen = new Map<string, string>();
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      const twin = seen.get(svg);
      if (twin !== undefined && PENDING_ARTWORK.has(target.label)) continue;
      assert.equal(twin, undefined, `${target.label} and ${twin} are byte-identical icons`);
      seen.set(svg, target.label);
    }
  });

  /**
   * Every coordinate an exported icon draws at, on the 960 canvas.
   *
   * The exported file carries its own `translate(...) scale(...)`, so the numbers
   * inside it plus that transform are the whole answer — no rasteriser needed.
   * Arc bulges and curve control points are not modelled, which makes this a
   * LOWER bound on the ink: it catches a drawing pushed off the canvas, not a
   * curve that overshoots its endpoints by a few units. The former is the bug
   * this exists for.
   */
  function inkBounds(svg: string): { min: number; max: number } | null {
    const transform = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\)/.exec(svg);
    if (!transform) return null;
    const [, tx, ty, scale] = transform.map(Number);

    const xs: number[] = [];
    const ys: number[] = [];

    for (const [, x, y, w, h] of svg.matchAll(
      /<rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    )) {
      xs.push(Number(x), Number(x) + Number(w));
      ys.push(Number(y), Number(y) + Number(h));
    }
    for (const [, cx, cy, r] of svg.matchAll(
      /<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)"/g,
    )) {
      xs.push(Number(cx) - Number(r), Number(cx) + Number(r));
      ys.push(Number(cy) - Number(r), Number(cy) + Number(r));
    }
    for (const [, data] of svg.matchAll(/ d="([^"]+)"/g)) {
      // Coordinate PAIRS only: an arc's `rx ry rotation large sweep` flags sit
      // between the command and its endpoint, so pairing blindly would read a
      // radius as an x. Taking the last two numbers of each command is enough,
      // and every command in these files ends at a point.
      for (const [, command, numbers] of data!.matchAll(/([MLCAZ])\s*([-\d.\s]*)/gi)) {
        if (command!.toUpperCase() === 'Z') continue;
        const values = numbers!.trim().split(/\s+/).map(Number).filter(Number.isFinite);
        if (values.length < 2) continue;
        xs.push(values[values.length - 2]!);
        ys.push(values[values.length - 1]!);
      }
    }
    if (xs.length === 0) return null;

    const at = (value: number, offset: number) => offset + scale! * value;
    return {
      min: Math.min(Math.min(...xs.map(x => at(x, tx!))), Math.min(...ys.map(y => at(y, ty!)))),
      max: Math.max(Math.max(...xs.map(x => at(x, tx!))), Math.max(...ys.map(y => at(y, ty!)))),
    };
  }

  test('no icon is drawn off the edge of its canvas', () => {
    /**
     * The circadian light's icon shipped clipped: its stored `fit` had been
     * measured against an earlier master and never re-measured, so the y
     * translate put the top of the drawing at −39 on a canvas that starts at 0.
     * The frame's top edge was simply gone.
     *
     * Nothing could see it. The file was generated, byte-identical to its curve
     * copy, valid SVG, and `homey app validate` never opens an icon at all
     * (§10) — the only check was somebody looking at a 32-pixel mask on a phone.
     *
     * Half the stroke is the margin, because a stroke straddles its path.
     */
    const HALF_STROKE = 20;
    for (const target of iconTargets()) {
      const bounds = inkBounds(readFileSync(target.path, 'utf8'));
      assert.ok(bounds, `${target.label}: no transform to measure against`);
      assert.ok(
        bounds.min >= HALF_STROKE,
        `${target.label}: ink starts at ${bounds.min.toFixed(1)}, so ${HALF_STROKE - bounds.min} `
        + 'units of it are off the canvas — re-run export-assets.py --measure',
      );
      assert.ok(
        bounds.max <= 960 - HALF_STROKE,
        `${target.label}: ink ends at ${bounds.max.toFixed(1)}, past the 960 canvas — `
        + 're-run export-assets.py --measure',
      );
    }
  });

  test('and every icon fills the canvas it is given', () => {
    // Guideline 1.5 asks for the full canvas. A drawing that lands inside the
    // bounds but occupies a third of them is the other way to get this wrong,
    // and it looks like a rendering bug rather than a design choice.
    for (const target of iconTargets()) {
      const bounds = inkBounds(readFileSync(target.path, 'utf8'))!;
      const extent = bounds.max - bounds.min;
      assert.ok(
        extent >= 960 * 0.7,
        `${target.label}: the drawing spans ${extent.toFixed(0)} of 960 — too small to read`,
      );
    }
  });

  test('every pending-artwork entry names an icon that exists', () => {
    // So the list cannot outlive the thing it excuses: an entry for an icon that
    // has been drawn, renamed or removed fails here rather than quietly
    // excusing nothing.
    const labels = new Set(iconTargets().map(target => target.label));
    for (const pending of PENDING_ARTWORK) {
      assert.ok(
        labels.has(pending),
        `${pending} is listed as pending artwork but is not an icon target`,
      );
    }
  });
});
