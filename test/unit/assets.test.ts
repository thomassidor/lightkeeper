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
  test('both device types and the app declare images at all', () => {
    // Required at publish level: homey-lib throws "The property `images` is
    // required in order to publish an app" and the same per driver.
    assert.ok(appJson.images, 'app.json declares no images');
    const drivers = appJson.drivers ?? [];
    assert.equal(drivers.length, 2, 'expected the controller and the schedule');
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

describe('icons', () => {
  test('the app and every driver has one', () => {
    // The app icon is checked by homey-lib at every level. Driver icons are NOT
    // validated at all — the CLI hashes them if present and ships nothing if
    // absent — but review requires them: "Driver icon is required."
    for (const target of iconTargets()) {
      assert.ok(existsSync(target.path), `${target.label}: ${target.path} is missing`);
    }
  });

  test('each is the full 960x960 canvas, with no intrinsic size', () => {
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      assert.match(svg, /viewBox="0 0 960 960"/, `${target.label}: not a 960x960 canvas`);
      // Guideline 1.5/1.6: "Always use the full canvas". homey-lib's own 226 stock
      // class icons declare viewBox only; width/height pins an intrinsic size.
      assert.doesNotMatch(
        svg.slice(0, svg.indexOf('>') + 1), /\swidth="|\sheight="/,
        `${target.label}: the root <svg> declares width/height; stock icons declare viewBox only`,
      );
    }
  });

  test('each is line art: stroked, never filled', () => {
    for (const target of iconTargets()) {
      const svg = readFileSync(target.path, 'utf8');
      const markup = svg.replace(/<!--[\s\S]*?-->/g, '');

      assert.match(markup, /stroke="#000"/, `${target.label}: no stroke colour`);
      assert.match(markup, /stroke-width="40"/, `${target.label}: not the house stroke width`);
      assert.match(markup, /fill="none"/, `${target.label}: fill is not disabled`);

      // A colour fill is what guideline 1.5 rejects, and what collapses into one
      // undifferentiated shape wherever Homey renders the icon white.
      const fills = [...markup.matchAll(/fill="([^"]*)"/g)]
        .map(match => match[1]!)
        .filter(value => value !== 'none');
      assert.deepEqual(
        fills, [],
        `${target.label}: filled shapes (${fills.join(', ')}) — icons must be stroke-only`,
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

  test('the two drivers do not share a mark', () => {
    // The one icon rule the automated reviewer does enforce: reuse is a finding
    // when two SVGs are byte-equivalent. Visual family resemblance is fine.
    const [, controller, schedule] = iconTargets();
    assert.notEqual(
      readFileSync(controller!.path, 'utf8'),
      readFileSync(schedule!.path, 'utf8'),
      'the two driver icons are byte-identical',
    );
  });
});
