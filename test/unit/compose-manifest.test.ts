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
