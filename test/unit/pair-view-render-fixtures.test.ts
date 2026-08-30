import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { RENDER_REPLIES } from '../../scripts/pair-view-fixtures.mjs';

/**
 * Every pairing screen has demo data to be RENDERED from.
 *
 * `npm run render:views` is the last of the hardware pass's "eyes on a screen"
 * lines: it draws every view to a PNG so one look at one page replaces a pairing
 * session per driver. A screen with no fixture is silently skipped there — it
 * renders nothing, appears on no contact sheet, and is exactly the screen nobody
 * then looks at.
 *
 * So the fixtures are discovered against the views on disk rather than listed,
 * the same way every other view test in this suite finds its subjects. Adding a
 * driver arms this by itself.
 *
 * This does not run Chrome and does not check what anything looks like. It
 * checks that there is something to look at.
 */

const DRIVERS = join(import.meta.dirname, '..', '..', 'drivers');

/** Every pair view on disk, by FILE name — `targets.html` is one screen, not four. */
function viewFiles(): string[] {
  const found = new Set<string>();
  for (const driver of readdirSync(DRIVERS)) {
    const dir = join(DRIVERS, driver, 'pair');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.html')) found.add(file);
    }
  }
  return [...found].sort();
}

describe('render fixtures', () => {
  const files = viewFiles();

  test('there are views to render, discovered from disk', () => {
    assert.ok(files.length >= 7, `found ${files.length}: ${files.join(', ')}`);
  });

  test('every view has demo data', () => {
    const missing = files.filter(file => !(file in RENDER_REPLIES));
    assert.deepEqual(
      missing, [],
      'a pair view with no entry in scripts/pair-view-fixtures.mjs renders nothing '
      + 'and appears on no contact sheet',
    );
  });

  test('and no demo data is left behind for a view that is gone', () => {
    // The other direction, because a fixture for a deleted screen is a fixture
    // nobody will ever notice is wrong.
    const orphaned = Object.keys(RENDER_REPLIES).filter(file => !files.includes(file));
    assert.deepEqual(orphaned, []);
  });

  test('each fixture answers the call its view makes first', () => {
    /**
     * The same first calls `pair-view-boot.test.ts` declares. Kept in step by
     * assertion rather than by import: that file's replies are deliberately
     * minimal — it proves a view BOOTS — and these are deliberately full, because
     * a screen rendered from empty lists shows nothing worth looking at. Two sets
     * of data for two jobs, with one shared requirement.
     */
    const FIRST_CALL: Record<string, string> = {
      'credential.html': 'getCredentialStatus',
      'source.html': 'listSources',
      'targets.html': 'listTargets',
      'mapping.html': 'getMapping',
      'schedule.html': 'getSchedule',
      'curve.html': 'getCurve',
      'ends.html': 'getEnds',
    };

    for (const file of files) {
      const event = FIRST_CALL[file];
      assert.ok(event, `${file} has no first call declared in this test`);
      assert.ok(
        event in (RENDER_REPLIES as Record<string, Record<string, unknown>>)[file]!,
        `the fixture for ${file} does not answer "${event}", so the screen renders empty`,
      );
    }
  });

  test('the demo data is rich enough to be worth looking at', () => {
    /**
     * The failure this pins is a fixture that technically answers and draws an
     * empty screen — which passes every check above while making the contact
     * sheet useless. So the screens that render LISTS must have list data.
     */
    const replies = RENDER_REPLIES as Record<string, any>;

    assert.ok(replies['curve.html'].getCurve.points.length >= 4,
      'the curve needs enough points to draw a shape');
    assert.ok(
      replies['curve.html'].getCurve.points.some((p: any) => p.color),
      'and at least one coloured point, or the one thing the Curve light adds is not on screen',
    );
    assert.ok(replies['curve.html'].getCurve.palette.length >= 2, 'more than one colour to choose');

    assert.ok(replies['schedule.html'].getSchedule.entries.length >= 2,
      'two windows, so the list is a list');
    assert.ok(
      replies['schedule.html'].getSchedule.entries.some((e: any) => Array.isArray(e.days)),
      'and one with specific days, so the day chips are drawn',
    );

    assert.ok(replies['mapping.html'].getMapping.groups.length >= 2,
      'more than one section, so the collapsed ones are visible');
    assert.ok(replies['mapping.html'].getMapping.rules.length >= 1,
      'and at least one rule already assigned');

    assert.ok(replies['targets.html'].listTargets.rooms.length >= 2, 'lights in two rooms');
    assert.ok(replies['source.html'].listSources.rooms.length >= 1, 'a remote to pick');

    // The key screen is the exception, and deliberately: it only draws itself
    // when there is no working key, so its fixture must NOT have one.
    assert.equal(replies['credential.html'].getCredentialStatus.valid, false,
      'a valid key makes the key screen skip itself, and it renders blank');
  });
});
