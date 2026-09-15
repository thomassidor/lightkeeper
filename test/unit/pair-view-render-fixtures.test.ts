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
      // Shared by every driver.
      'intro.html': 'getIntro',
      'lights.html': 'listTargets',
      'review.html': 'getReview',
      'credential.html': 'getCredentialStatus',
      // Circadian.
      'day.html': 'getDay',
      'tryit.html': 'getPreview',
      // Curve.
      'curve.html': 'getCurve',
      // Daylight.
      'sensor.html': 'listSensors',
      'response.html': 'getResponse',
      'sensordetail.html': 'getSensorDetail',
      // Schedule.
      'blocks.html': 'getSchedule',
      // Controller. `remote.html` asks `checkReattach` first, but its failure is
      // swallowed — "this is not a repair session" is the ordinary answer — so
      // the call that has to be answered for the screen to draw is this one.
      'remote.html': 'listSources',
      'buttons.html': 'getButtons',
      'job.html': 'getGesture',
      'listen.html': 'startListening',
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
     * sheet useless. So the screens that render LISTS must have list data, and
     * the ones whose whole point is a picture must have something to draw.
     */
    const replies = RENDER_REPLIES as Record<string, any>;

    // The light picker, which four drivers share.
    assert.ok(replies['lights.html'].listTargets.rooms.length >= 3,
      'enough rooms that some are folded, because the fold is half the screen');
    assert.ok(
      replies['lights.html'].listTargets.rooms[0].lights.some((l: any) => l.isLight === false),
      'and one candidate that is not a light, or the marker is never drawn',
    );

    // The circadian day: three zones and two boundaries, or there is no day.
    const day = replies['day.html'].getDay;
    assert.ok(day.zones.morning && day.zones.midday && day.zones.evening, 'three zones');
    assert.ok(day.boundaries.fromSun, 'anchored to a real sun, so the marks are drawn');
    assert.ok(day.adjustBrightness, 'brightness on, so the slider is drawn as well as the switch');

    // The curve: a shape, and a colour on it.
    assert.ok(replies['curve.html'].getCurve.points.length >= 4,
      'the curve needs enough points to draw a shape');
    assert.ok(
      replies['curve.html'].getCurve.points.some((p: any) => p.color),
      'and at least one coloured point, or the one thing the Colour Curve Light adds '
      + 'is not on screen',
    );
    assert.ok(
      replies['curve.html'].getCurve.palette.length
        > replies['curve.html'].getCurve.featuredColors,
      'more colours than are featured, or "Show more colours" has nothing behind it',
    );

    // The schedule: more than one block, a restricted day set, and a conflict.
    const schedule = replies['blocks.html'].getSchedule;
    assert.ok(schedule.entries.length >= 2, 'two blocks, so the list is a list');
    assert.ok(Array.isArray(schedule.days), 'a restricted day set, so the chips differ');
    assert.ok(schedule.overlaps.length >= 1,
      'and an overlap, because the outlined conflict is drawn nowhere else');

    // The daylight screens: sensors in two rooms, a dead one, and a real week.
    assert.ok(replies['sensor.html'].listSensors.rooms.length >= 2, 'sensors in two rooms');
    assert.ok(
      replies['sensor.html'].listSensors.rooms
        .some((r: any) => r.sensors.some((x: any) => x.available === false)),
      'and one that is not responding, which is shown greyed rather than hidden',
    );
    const week = replies['response.html'].getResponse.week;
    assert.ok(week.cells.length === 7, 'seven days');
    assert.ok(
      week.cells.some((row: any[]) => row.some(cell => cell === null)),
      'with a gap in it, or the hatched cell — the whole point of the grid — is never drawn',
    );

    // The controller: rows with jobs and rows without, and the job that carries
    // a value.
    assert.ok(replies['buttons.html'].getButtons.gestures.length >= 3, 'several gestures');
    assert.ok(
      replies['buttons.html'].getButtons.gestures
        .some((g: any) => !(g.key in replies['buttons.html'].getButtons.jobs)),
      'and one with no job, because "Nothing" is a finished state worth drawing',
    );
    assert.ok(replies['job.html'].getGesture.needsPreset,
      'the job editor opens on the one job that carries a value, or its controls never draw');
  });
});
