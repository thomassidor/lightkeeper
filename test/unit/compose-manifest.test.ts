import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `app.json` is GENERATED from `.homeycompose/` and must never be hand-edited.
 *
 * The trap this test exists for: `homey app validate` is what regenerates it,
 * so a stale committed manifest is silently repaired by the very command you
 * would reach for to check it — locally and in CI both. The build goes green,
 * the commit ships a manifest that disagrees with its own sources, and the next
 * person to run validate gets an unexplained diff.
 *
 * So the comparison happens here, where nothing can quietly fix it first. It is
 * a SUBSET check by design: every compose source must appear verbatim in
 * app.json. Extra fields in app.json are the CLI's business (`_comment`, the
 * `id` it stamps onto each driver), and `homey app validate` is what judges
 * those.
 */

const ROOT = join(import.meta.dirname, '..', '..');

const readJson = (...parts: string[]) =>
  JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));

const manifest = readJson('app.json') as Record<string, any>;

describe('app.json is generated from .homeycompose/', () => {
  test('every app-level field matches its compose source', () => {
    const composed = readJson('.homeycompose', 'app.json') as Record<string, unknown>;

    for (const [key, value] of Object.entries(composed)) {
      assert.deepEqual(
        manifest[key], value,
        `app.json "${key}" disagrees with .homeycompose/app.json — app.json is `
        + 'generated, so run `npm run validate` and commit the result',
      );
    }
  });

  test('the flow actions match the files in .homeycompose/flow/actions/', () => {
    const dir = join(ROOT, '.homeycompose', 'flow', 'actions');
    const ids = readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .sort();

    const actions = (manifest.flow?.actions ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(
      actions.map(a => String(a.id)).sort(), ids,
      'app.json\'s flow actions are not the files in .homeycompose/flow/actions/',
    );

    for (const id of ids) {
      const source = readJson('.homeycompose', 'flow', 'actions', `${id}.json`);
      const generated = actions.find(a => a.id === id);
      // The CLI stamps the id on from the filename; everything else is verbatim.
      assert.deepEqual(generated, { ...source, id }, `flow action "${id}" drifted`);
    }
  });

  /**
   * The bridge cards are hidden from the Flow editor's card picker.
   *
   * `deprecated` is a real flowCard property — homey-lib's own app schema
   * declares it (`definitions.flowCard.properties.deprecated`, `enum: [true]`),
   * which is why this validates at publish level. What it buys: these cards are
   * ours to write and nobody else's to add by hand, and a Flow somebody built
   * around one carries a Lightkeeper device id it does not belong to. The
   * sweep already refuses to DELETE such a Flow (looksGenerated); this stops it
   * being made in the first place.
   *
   * Pinned by a test because removing it is a one-character edit that nothing
   * else would notice, and because "deprecated" reads, wrongly, like something
   * on its way out.
   */
  test('all three bridge cards are hidden from the Flow editor', () => {
    const actions = (manifest.flow as any)?.actions as Array<Record<string, unknown>>;
    for (const id of ['bridge_event', 'bridge_numeric_event', 'bridge_token_event']) {
      assert.equal(
        actions.find(a => a.id === id)?.deprecated, true,
        `${id} must stay hidden from the card picker`,
      );
    }
  });

  test('every driver matches its driver.compose.json', () => {
    // Discovered from disk, not listed here: a third driver must not be able to
    // ship with an unchecked manifest.
    const driverIds = readdirSync(join(ROOT, 'drivers'), { withFileTypes: true })
      .filter(e => e.isDirectory()
        && existsSync(join(ROOT, 'drivers', e.name, 'driver.compose.json')))
      .map(e => e.name)
      .sort();

    const drivers = (manifest.drivers ?? []) as Array<Record<string, unknown>>;
    assert.deepEqual(
      drivers.map(d => String(d.id)).sort(), driverIds,
      'app.json\'s drivers are not the folders under drivers/',
    );

    for (const id of driverIds) {
      const source = readJson('drivers', id, 'driver.compose.json');
      const generated = drivers.find(d => d.id === id);
      assert.deepEqual(generated, { ...source, id }, `driver "${id}" drifted`);
    }
  });
});

/**
 * Every route the manifest declares is a function `api.ts` actually exports.
 *
 * The manifest's `api` block is a NAME MAP: Homey routes `GET /evidence` to
 * whatever `module.exports.getEvidence` happens to be, and a name that matches
 * nothing produces no build error, no validate error and no test failure —
 * only a 404 at the moment somebody presses a button in the settings page.
 * The reverse is just as quiet: an exported handler with no manifest entry is
 * unreachable and looks, from the code, exactly like a working feature.
 *
 * Nothing checked this until the recorder added six routes at once, which is
 * six chances to typo a name that only a Homey would ever tell you about.
 *
 * Read as SOURCE rather than imported: `api.ts` imports the app contract and
 * the whole `lib/` tree behind it, and this file is about names.
 */
describe('the app API surface', () => {
  const source = readFileSync(join(ROOT, 'api.ts'), 'utf8');

  /**
   * `  async name(` or `  name(` at the top level of `module.exports = {`, plus
   * anything reached through a spread.
   *
   * The recorder's six routes are not written out in `api.ts` at all: they come
   * from `...evidenceRoutes(appOf)`, so that a launch build can drop them by
   * returning none rather than by deleting them from generated JavaScript
   * (`lib/support/evidence-feature.ts`). A source scan that only knew about
   * literal properties would call all six missing.
   *
   * Each spread is followed to the module that defines it and scanned the same
   * way, which keeps this test honest about the one thing it is for — a route
   * declared in the manifest with no handler behind it is a 404 at the moment
   * somebody presses the button.
   */
  const handlersIn = (text: string) =>
    [...text.matchAll(/^ {2,4}(?:async )?([a-zA-Z][a-zA-Z0-9_]*)\s*\(/gm)].map(m => m[1]!);

  /**
   * Every handler name `module.exports` ends up carrying, spreads followed.
   *
   * A function rather than a constant, and called from inside each test, because
   * an assertion that throws out here fails the SUITE without being counted:
   * `node --test` reported `fail 0` on a broken file while this was module-level
   * code. Anything that can throw belongs in a test.
   *
   * Following the spreads is the point. The recorder's six routes are not written
   * out in `api.ts` at all — they arrive as `...evidenceRoutes(appOf)` so that a
   * launch build can drop them by returning none, rather than by deleting them
   * from generated JavaScript (`lib/support/evidence-feature.ts`). A scan that
   * only knew about literal properties would call all six missing.
   */
  const handlerNames = () => {
    const names = new Set(handlersIn(source));
    for (const [, fn] of source.matchAll(/^ {2}\.\.\.([a-zA-Z][a-zA-Z0-9_]*)\(/gm)) {
      const line = source.split(/\r?\n/).find(text =>
        text.startsWith('import ') && text.includes(fn) && text.includes(' from '));
      assert.ok(line, `api.ts spreads ${fn}() but does not import it`);
      const from = /from '([^']+)'/.exec(line);
      assert.ok(from, `cannot read a module path out of: ${line}`);
      for (const name of handlersIn(readFileSync(join(ROOT, `${from[1]!}.ts`), 'utf8'))) names.add(name);
    }
    return names;
  };

  const routes = () => {
    const composed = readJson('.homeycompose', 'app.json') as { api?: Record<string, unknown> };
    return Object.keys(composed.api ?? {});
  };

  test('the api block is not empty, or this whole test is vacuous', () => {
    assert.ok(routes().length > 10, `only ${routes().length} routes found`);
    const exported = handlerNames();
    assert.ok(exported.size > 10, `only ${exported.size} handlers parsed out of api.ts`);
  });

  test('every declared route names a handler api.ts exports', () => {
    const exported = handlerNames();
    const missing = routes().filter(name => !exported.has(name));
    assert.deepEqual(
      missing, [],
      'declared in .homeycompose/app.json\'s "api" block but not exported by api.ts — '
      + 'these are a 404 at the moment a user presses the button',
    );
  });

  test('and app.json carries the same block, since it is generated', () => {
    const generated = (manifest.api ?? {}) as Record<string, unknown>;
    const composed = (readJson('.homeycompose', 'app.json').api ?? {}) as Record<string, unknown>;
    assert.deepEqual(generated, composed, 'run `npm run validate` and commit app.json');
  });

  test('every route declares a method and a path', () => {
    const composed = (readJson('.homeycompose', 'app.json').api ?? {}) as Record<string, any>;
    for (const [name, route] of Object.entries(composed)) {
      assert.ok(
        ['GET', 'POST', 'PUT', 'DELETE'].includes(String(route?.method)),
        `route "${name}" has method "${route?.method}"`,
      );
      assert.ok(String(route?.path ?? '').startsWith('/'), `route "${name}" has path "${route?.path}"`);
    }
  });
});
