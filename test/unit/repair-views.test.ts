import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SHARED_VIEWS, SHARED_SOURCE_DRIVER } from '../../scripts/sync-views.mjs';

/**
 * Repair views live in their OWN folder, and shared views live in every driver
 * that uses them. Both are copies on disk, and both are invisible to validation.
 *
 * Homey serves pair views from `drivers/<id>/pair/<viewId>.html` and repair views
 * from `drivers/<id>/repair/<viewId>.html`. A driver declared four repair views
 * with no `repair/` folder behind them, so opening Repair failed with Homey's own
 * `unknown_error_getting_file` before a single Lightkeeper screen rendered —
 * every needs_repair state was a dead end. `homey app validate --level publish`
 * cannot catch it: homey-lib asserts the existence of the PAIR view files only,
 * and `repair` is not even in its app schema. So the check has to live here.
 *
 * The same applies to the API-key screen and the light picker, which the schedule
 * driver shares with the controller: Homey will not follow a reference, so each
 * driver needs its own real file.
 *
 * Every copy is made by `npm run sync:views`, nothing runs it for you, and drift
 * is a test failure. Drivers are DISCOVERED here rather than named — a hardcoded
 * driver id is how a second driver's repair folder could go missing without
 * anything failing.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DRIVERS = join(ROOT, 'drivers');

interface DriverManifest {
  pair?: Array<{ id: string }>;
  repair?: Array<{ id: string }>;
}

const drivers = readdirSync(DRIVERS, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => existsSync(join(DRIVERS, name, 'driver.compose.json')))
  .map(name => ({
    id: name,
    manifest: JSON.parse(
      readFileSync(join(DRIVERS, name, 'driver.compose.json'), 'utf8'),
    ) as DriverManifest,
  }));

describe('repair views', () => {
  test('both drivers are discovered', () => {
    // The one hardcoded list in this file, and deliberately so: everything
    // below discovers its subjects, which means an empty `drivers` array would
    // make every other test here pass by having nothing to check. This is the
    // canary for that, not a second source of truth.
    assert.deepEqual(drivers.map(d => d.id).sort(), ['controller', 'schedule']);
  });

  test('every driver declares repair views at all', () => {
    for (const driver of drivers) {
      // Repair is where re-attach, remap, retimed schedules and flow-edited
      // recovery live. Losing the declaration silently removes the only way out
      // of needs_repair.
      assert.ok(
        (driver.manifest.repair ?? []).length > 0,
        `drivers/${driver.id}/driver.compose.json declares no repair views`,
      );
    }
  });

  test('every declared pair view has a file', () => {
    for (const driver of drivers) {
      for (const view of driver.manifest.pair ?? []) {
        assert.ok(
          existsSync(join(DRIVERS, driver.id, 'pair', `${view.id}.html`)),
          `pair view "${view.id}" is declared but drivers/${driver.id}/pair/${view.id}.html is missing`,
        );
      }
    }
  });

  test('every declared repair view has a file', () => {
    for (const driver of drivers) {
      for (const view of driver.manifest.repair ?? []) {
        assert.ok(
          existsSync(join(DRIVERS, driver.id, 'repair', `${view.id}.html`)),
          `repair view "${view.id}" is declared but drivers/${driver.id}/repair/${view.id}.html is `
          + 'missing — Homey serves repair views from their own folder, not from pair/, and fails '
          + 'with "unknown_error_getting_file" when one is absent. Run: npm run sync:views',
        );
      }
    }
  });

  test('each repair view is identical to its pair sibling', () => {
    for (const driver of drivers) {
      for (const view of driver.manifest.repair ?? []) {
        const pair = readFileSync(join(DRIVERS, driver.id, 'pair', `${view.id}.html`), 'utf8');
        const repair = readFileSync(join(DRIVERS, driver.id, 'repair', `${view.id}.html`), 'utf8');

        assert.equal(
          repair, pair,
          `${driver.id}: repair/${view.id}.html has drifted from pair/${view.id}.html — the two are `
          + 'copies because Homey needs a real file in each folder. Run: npm run sync:views',
        );
      }
    }
  });

  test('shared views are identical across drivers', () => {
    for (const driver of drivers) {
      if (driver.id === SHARED_SOURCE_DRIVER) continue;
      const declared = new Set((driver.manifest.pair ?? []).map(view => `${view.id}.html`));

      for (const view of SHARED_VIEWS) {
        if (!declared.has(view)) continue;
        const original = readFileSync(join(DRIVERS, SHARED_SOURCE_DRIVER, 'pair', view), 'utf8');
        const copy = readFileSync(join(DRIVERS, driver.id, 'pair', view), 'utf8');

        assert.equal(
          copy, original,
          `${driver.id}/pair/${view} has drifted from ${SHARED_SOURCE_DRIVER}/pair/${view} — `
          + 'these are the same screen, and the driver tells the credential view which view comes '
          + 'next rather than the file knowing. Run: npm run sync:views',
        );
      }
    }
  });

  test('the repair flow offers the same steps as pairing', () => {
    for (const driver of drivers) {
      // Repair reuses every screen by design: it may need a new key, different
      // lights, a different remote or only a retime, and which one is not
      // knowable up front.
      assert.deepEqual(
        (driver.manifest.repair ?? []).map(v => v.id),
        (driver.manifest.pair ?? []).map(v => v.id),
        `${driver.id}: the repair steps differ from the pairing steps`,
      );
    }
  });
});
