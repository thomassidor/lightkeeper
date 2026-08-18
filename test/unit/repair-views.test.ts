import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repair views live in their OWN folder.
 *
 * Homey serves pair views from `drivers/<id>/pair/<viewId>.html` and repair
 * views from `drivers/<id>/repair/<viewId>.html`. The driver declared four
 * repair views with no `repair/` folder behind them, so opening Repair failed
 * with Homey's own `unknown_error_getting_file` before a single Light Link
 * screen rendered — every needs_repair state was a dead end.
 *
 * `homey app validate --level publish` cannot catch this: homey-lib asserts the
 * existence of the PAIR view files only, and `repair` is not even in its app
 * schema. So the check has to live here.
 *
 * The four repair files are exact copies, made by `npm run sync:repair-views`.
 * That duplication cannot be removed — Homey wants real files in both places —
 * so, exactly as with the shared CSS block in pair-view-styles.test.ts, it is
 * made safe instead: drift is a test failure.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DRIVER = join(ROOT, 'drivers', 'controller');

const manifest = JSON.parse(
  readFileSync(join(DRIVER, 'driver.compose.json'), 'utf8'),
) as { pair?: Array<{ id: string }>; repair?: Array<{ id: string }> };

const pairViews = (manifest.pair ?? []).map(view => view.id);
const repairViews = (manifest.repair ?? []).map(view => view.id);

describe('repair views', () => {
  test('the driver declares repair views at all', () => {
    // Repair is where re-attach, remap and flow-edited recovery live. Losing
    // the declaration would silently remove the only way out of needs_repair.
    assert.ok(repairViews.length > 0, 'driver.compose.json declares no repair views');
  });

  test('every declared pair view has a file', () => {
    for (const id of pairViews) {
      const file = join(DRIVER, 'pair', `${id}.html`);
      assert.ok(existsSync(file), `pair view "${id}" is declared but drivers/controller/pair/${id}.html is missing`);
    }
  });

  test('every declared repair view has a file', () => {
    for (const id of repairViews) {
      const file = join(DRIVER, 'repair', `${id}.html`);
      assert.ok(
        existsSync(file),
        `repair view "${id}" is declared but drivers/controller/repair/${id}.html is missing — `
        + 'Homey serves repair views from their own folder, not from pair/, and fails with '
        + '"unknown_error_getting_file" when one is absent. Run: npm run sync:repair-views',
      );
    }
  });

  test('each repair view is identical to its pair sibling', () => {
    for (const id of repairViews) {
      const pair = readFileSync(join(DRIVER, 'pair', `${id}.html`), 'utf8');
      const repair = readFileSync(join(DRIVER, 'repair', `${id}.html`), 'utf8');

      assert.equal(
        repair, pair,
        `repair/${id}.html has drifted from pair/${id}.html — the two are copies `
        + 'because Homey needs a real file in each folder. Run: npm run sync:repair-views',
      );
    }
  });

  test('the repair flow offers the same steps as pairing', () => {
    // Repair reuses all four screens by design: a repair may need a new key, a
    // different remote, different lights or only a remap, and which one is not
    // knowable up front.
    assert.deepEqual(repairViews, pairViews);
  });
});
