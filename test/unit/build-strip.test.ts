import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EVIDENCE_MODULES, EVIDENCE_ROUTES, ROUTE_CALL, strip, verifyNoStrays, verifyStripped,
} from '../../scripts/build.mjs';

/**
 * The launch-build strip, run against a tree rather than read as text.
 *
 * `scripts/build.mjs` proves its own work from inside the build — but until it
 * could be imported, that proof had no test of its own, and nothing had ever
 * fed it a tree it ought to REFUSE. A verifier that has only ever been shown
 * passing inputs is indistinguishable from one that always passes, and this one
 * is the only thing between a development tool and every household's Homey.
 *
 * The tree is synthetic apart from `settings/index.html`, which is the REAL
 * page: its dev-only markers are the one input the strip depends on that a
 * person edits by hand, and a test on a transcribed copy would go on passing
 * after somebody deleted them.
 */

const root = join(import.meta.dirname, '..', '..');

function write(build: string, path: string, text: string): void {
  mkdirSync(dirname(join(build, path)), { recursive: true });
  writeFileSync(join(build, path), text);
}

/** A `.homeybuild/` shaped like a dev build: recorder in, routes declared. */
function devTree(): string {
  const build = mkdtempSync(join(tmpdir(), 'lk-build-'));
  write(build, 'app.js', "const feature = require('./lib/support/evidence-feature');\n");
  write(build, 'lib/support/evidence-feature.js', "require('./evidence-recorder'); require('./evidence-sampler');\n");
  write(build, 'lib/support/evidence-feature-disabled.js', 'exports.evidenceRoutes = () => ({});\n');
  write(build, 'lib/support/evidence-recorder.js', 'class EvidenceRecorder {}\n');
  write(build, 'lib/support/evidence-sampler.js', 'class EvidenceSampler {}\n');
  const api: Record<string, object> = { getStatus: { method: 'GET', path: '/' } };
  for (const route of EVIDENCE_ROUTES) api[route] = { method: 'GET', path: `/evidence/${route}` };
  write(build, 'app.json', JSON.stringify({ id: 'x', api }));
  mkdirSync(join(build, 'settings'), { recursive: true });
  cpSync(join(root, 'settings/index.html'), join(build, 'settings/index.html'));
  return build;
}

function withTree(body: (build: string) => void): void {
  const build = devTree();
  try { body(build); } finally { rmSync(build, { recursive: true, force: true }); }
}

describe('the launch-build strip', () => {
  test('turns a dev tree into a launch tree, and the proof accepts it', () => {
    withTree(build => {
      strip(build);

      for (const module of EVIDENCE_MODULES) assert.ok(!existsSync(join(build, module)), `${module} survived`);
      // The feature module is now the twin, under the feature's own name.
      assert.equal(
        readFileSync(join(build, 'lib/support/evidence-feature.js'), 'utf8'),
        'exports.evidenceRoutes = () => ({});\n',
      );
      const api = JSON.parse(readFileSync(join(build, 'app.json'), 'utf8')).api;
      assert.deepEqual(Object.keys(api), ['getStatus'], 'a non-recorder route must be left alone');
      const html = readFileSync(join(build, 'settings/index.html'), 'utf8');
      assert.ok(!html.includes(ROUTE_CALL), 'the settings page still calls the recorder');
      assert.ok(!html.includes('dev-only: evidence recorder'));
      assert.doesNotThrow(() => verifyStripped(build));
    });
  });

  test('the real settings page still carries both pairs of markers the strip removes it by', () => {
    // The page is the one input edited by hand. Without both pairs, strip()
    // either throws at build time or — for a half-deleted pair — leaves half the
    // feature in place for verifyStripped() to catch. Either way it is found
    // here first, not by the CLI.
    const html = readFileSync(join(root, 'settings/index.html'), 'utf8');
    for (const marker of [
      '<!-- ==== dev-only: evidence recorder', '<!-- ==== end dev-only: evidence recorder ==== -->',
      '/* ==== dev-only: evidence recorder', '/* ==== end dev-only: evidence recorder ==== */',
    ]) assert.ok(html.includes(marker), `settings/index.html lost ${marker}`);
    assert.ok(html.includes(ROUTE_CALL), 'the page no longer calls the recorder — is the strip still needed?');
  });

  test('is idempotent: stripping a stripped tree changes nothing and still passes', () => {
    // A bare `npm run build` runs against whatever the last packaging run left.
    withTree(build => {
      strip(build);
      const before = readFileSync(join(build, 'settings/index.html'), 'utf8');
      // The twin is gone after the first run, so re-create what tsc would emit.
      write(build, 'lib/support/evidence-feature-disabled.js', 'exports.evidenceRoutes = () => ({});\n');
      strip(build);
      assert.equal(readFileSync(join(build, 'settings/index.html'), 'utf8'), before);
    });
  });

  test('refuses a settings page that calls the recorder but has lost its markers', () => {
    withTree(build => {
      write(build, 'settings/index.html', `<script>Homey.api('GET', ${ROUTE_CALL}/status')</script>`);
      assert.throws(() => strip(build), /no dev-only markers/);
    });
  });

  test('refuses a page whose closing marker was deleted', () => {
    withTree(build => {
      const html = readFileSync(join(build, 'settings/index.html'), 'utf8')
        .replace('<!-- ==== end dev-only: evidence recorder ==== -->', '');
      write(build, 'settings/index.html', html);
      assert.throws(() => strip(build), /closing marker not found/);
    });
  });
});

describe('the proof refuses what it exists to refuse', () => {
  test('any compiled file still naming the recorder', () => {
    withTree(build => {
      strip(build);
      write(build, 'drivers/curve/device.js', "require('../../lib/support/evidence-recorder');\n");
      assert.throws(() => verifyStripped(build), /drivers[\\/]curve[\\/]device\.js still matches/);
    });
  });

  test('a manifest still declaring a recorder route', () => {
    withTree(build => {
      strip(build);
      write(build, 'app.json', JSON.stringify({ api: { [EVIDENCE_ROUTES[0]]: {} } }));
      assert.throws(() => verifyStripped(build), new RegExp(`app.json still declares ${EVIDENCE_ROUTES[0]}`));
    });
  });

  test('a settings page still calling the routes', () => {
    withTree(build => {
      strip(build);
      write(build, 'settings/index.html', `<p>${ROUTE_CALL}</p>`);
      assert.throws(() => verifyStripped(build), /settings\/index.html still calls/);
    });
  });

  test('an untouched dev tree, which is the whole point', () => {
    withTree(build => assert.throws(() => verifyStripped(build), /still references the evidence recorder/));
  });

  test('a stray top-level file, on any build', () => {
    withTree(build => {
      write(build, 'CODE_REVIEW.md', '# not for households');
      write(build, '.dev-build', '');
      assert.throws(() => verifyNoStrays(build), /1 unexpected top-level entry[\s\S]*CODE_REVIEW\.md/);
      rmSync(join(build, 'CODE_REVIEW.md'));
      assert.doesNotThrow(() => verifyNoStrays(build), 'a dotfile is the CLI\'s to exclude, not a stray');
    });
  });
});
