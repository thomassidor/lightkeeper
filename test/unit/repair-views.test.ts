import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SHARED_VIEWS, SHARED_SOURCE_DRIVER, sync } from '../../scripts/sync-views.mjs';

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
 *
 * **This file imports the sync script, and that used to run it.** Its body was
 * top-level statements, so importing the two constants below synced the tree in
 * WRITE MODE before a single assertion ran: every check here was vacuous, and
 * CI's `sync:views:check` was defeated by ordering, because `npm test` goes
 * first in the same tree and repairs the drift the later step exists to catch.
 * The script now does nothing on import — `sync({ check: true })` is the only
 * way to ask it anything from here, and it writes nothing.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const DRIVERS = join(ROOT, 'drivers');

interface DriverStep {
  id: string;
  navigation?: { prev?: string; next?: string };
}

interface DriverManifest {
  pair?: DriverStep[];
  repair?: DriverStep[];
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
  test('every driver is discovered', () => {
    // The one hardcoded list in this file, and deliberately so: everything
    // below discovers its subjects, which means an empty `drivers` array would
    // make every other test here pass by having nothing to check. This is the
    // canary for that, not a second source of truth.
    assert.deepEqual(drivers.map(d => d.id).sort(), ['circadian', 'controller', 'curve', 'daylight', 'schedule']);
  });

  /**
   * The script's own answer, in check mode, asked directly.
   *
   * The assertions below compare files by hand, which is the honest way round —
   * but this one is what proves the SCRIPT and this test agree about what a copy
   * is. It is also the assertion that could not exist while importing the module
   * ran the sync: the import repaired any drift, so there was never any left to
   * report.
   */
  test('the sync script itself reports no drift, and writing is not how we ask', () => {
    const { copies, drifted } = sync({ check: true });
    assert.deepEqual(
      drifted, [],
      'views have drifted from their sources. Run: npm run sync:views',
    );
    assert.equal(copies, 0);
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

  /**
   * A view id a driver hands to a screen has to name a view that driver actually
   * declares. `Homey.showView('targets')` on a driver whose step 1 is called
   * `lights` does not throw and does not stay put: it renders an EMPTY sheet,
   * with the header, the Previous arrow and nothing between them.
   *
   * That is not hypothetical. The pairing rewrite renamed the schedule's
   * `targets` view to `lights` and the controller's `source` view to `remote`,
   * and two hardcoded ids were left behind — the schedule's credential screen
   * and the shared view's own fallback. Every household that already had an API
   * key stored got intro -> credential -> blank, because the credential screen
   * skips itself and jumps straight on when a valid key is present.
   *
   * Nothing else can catch it: `validate` never reads a driver's TypeScript, the
   * view files are shared byte-for-byte so they cannot know the answer
   * themselves, and a driver containing `extends Homey.Driver` cannot be
   * imported by a test at all (platform §13). So the ids are read out of the
   * source as text.
   */
  test('every view id a driver names is a view that driver declares', () => {
    // `nextView: 'x'` in a screen payload, `view: 'x'` on a review row — which
    // is where a jump back to a step comes from — and the credential screen's
    // destination, which is a positional argument rather than a field.
    const NAMED = [
      /nextView:\s*'([^']+)'/g,
      /view:\s*'([^']+)'/g,
      /registerCredentialHandlers\([^)]*?,\s*'([^']+)'\s*\)/g,
    ];

    for (const driver of drivers) {
      const source = readFileSync(join(DRIVERS, driver.id, 'driver.ts'), 'utf8');
      const declared = new Set((driver.manifest.pair ?? []).map(view => view.id));

      const named = NAMED.flatMap(pattern => [...source.matchAll(pattern)].map(m => m[1]));
      assert.ok(named.length > 0, `${driver.id}/driver.ts names no view at all — has the payload shape changed?`);

      for (const id of named) {
        assert.ok(
          declared.has(id),
          `${driver.id}/driver.ts sends pairing to the view "${id}", which drivers/${driver.id}/`
          + `driver.compose.json does not declare (it has: ${[...declared].join(', ')}). `
          + 'Homey renders an empty screen for an unknown view id rather than failing.',
        );
      }
    }
  });

  test('every view a driver navigates to by prev or next is declared', () => {
    for (const driver of drivers) {
      for (const flow of ['pair', 'repair'] as const) {
        const steps = driver.manifest[flow] ?? [];
        const declared = new Set(steps.map(view => view.id));

        for (const step of steps) {
          for (const [direction, target] of Object.entries(step.navigation ?? {})) {
            assert.ok(
              declared.has(target),
              `${driver.id}: ${flow} view "${step.id}" navigates ${direction} to "${target}", `
              + 'which is not one of its own views',
            );
          }
        }
      }
    }
  });

  /**
   * The shared credential screen carries a hardcoded destination for the case
   * where a driver does not answer with one. It is the CONTROLLER's next view,
   * because the controller is where that file is authored — and it is only ever
   * reached on a driver that has stopped supplying its own, which is exactly
   * when a stale id would go unnoticed.
   */
  test("the credential view's fallback names a real controller view", () => {
    const view = readFileSync(join(DRIVERS, SHARED_SOURCE_DRIVER, 'pair', 'credential.html'), 'utf8');
    const fallback = /var nextView = '([^']+)'/.exec(view);
    assert.ok(fallback, 'credential.html no longer declares a fallback view');

    const source = drivers.find(d => d.id === SHARED_SOURCE_DRIVER)!;
    assert.ok(
      (source.manifest.pair ?? []).some(step => step.id === fallback[1]),
      `credential.html falls back to the view "${fallback[1]}", which the ${SHARED_SOURCE_DRIVER} `
      + 'driver does not declare',
    );
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
