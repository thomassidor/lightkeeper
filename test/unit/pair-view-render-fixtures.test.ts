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
      // Schedule.
      'blocks.html': 'getSchedule',
      // Controller. `remote.html` asks `checkReattach` first, but its failure is
      // swallowed — "this is not a repair session" is the ordinary answer — so
      // the call that has to be answered for the screen to draw is this one.
      'remote.html': 'listSources',
      'buttons.html': 'getButtons',
      'job.html': 'getGesture',
      'source.html': 'getSource',
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
      replies['curve.html'].getCurve.layout.more.length > 0,
      'colours behind "Show more colours", or the fold-out has nothing behind it',
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

    // The remote picker: both lists, or the render shows a screen that has
    // nothing to fold and the row nobody would otherwise see is never drawn.
    const sources = replies['remote.html'].listSources;
    assert.ok(sources.rooms.length >= 2, 'candidates in more than one room');
    assert.ok(sources.otherCount > 0 && sources.others.length > 0,
      'and a folded remainder, because on a real house that is most of it');
    assert.ok(
      sources.rooms.every((r: any) => r.sources.every((s: any) => s.eventCount > 0)),
      'nothing silent in the first list, or the fixture draws a screen the driver cannot send',
    );

    // The controller: rows with jobs and rows without, and the job that carries
    // a value.
    assert.ok(replies['buttons.html'].getButtons.gestures.length >= 3, 'several gestures');
    assert.ok(
      replies['buttons.html'].getButtons.gestures
        .some((g: any) => !(g.key in replies['buttons.html'].getButtons.jobs)),
      'and one with no job, because "Nothing" is a finished state worth drawing',
    );
    // The job editor: a job that carries a value, so the editor under the grid
    // draws, and a light subset, so the checklist is not nine ticks and a
    // question nobody can see the point of.
    const gesture = replies['job.html'].getGesture;
    assert.equal(
      gesture.jobs.filter((job: any) => job.preset !== 'lightkeeper').length, 9,
      'nine tiles, or the grid is not a grid',
    );
    assert.ok(gesture.jobs.some((job: any) => job.preset === 'lightkeeper'),
      'and the composed job, which is drawn as the card above the grid rather than in it');
    assert.ok(gesture.sourceNames?.colour && gesture.sourceNames?.brightness,
      'with both of its rows answered, or the card renders half-filled');
    assert.ok(gesture.jobs.every((job: any) => job.id !== null),
      'do nothing is the tile below the grid, so it must not be in the grid itself');
    assert.notEqual(gesture.presetKind, 'none',
      'the editor opens on a job that carries a value, or its controls never draw');
    assert.ok(gesture.layout.more.length > 0,
      'colours behind the fold, or the fold-out has nothing behind it');
    assert.ok(gesture.lights.length >= 3, 'enough lights that a subset is visibly a subset');
    assert.ok(
      gesture.chosenLights && gesture.chosenLights.length < gesture.lights.length,
      'and a subset chosen, because per-button lights is the thing this screen gained',
    );

    /**
     * The source picker: the BRIGHTNESS question, because it is the richer of
     * the two — a bar and a percentage on every row against one swatch — and
     * because a row at each end of the axis is what shows the bar is a bar.
     */
    const source = replies['source.html'].getSource;
    assert.ok(source.sources.length >= 4, 'enough setups that the list is a list');
    assert.equal(source.sources[0].id, 'none',
      '"leave it alone" is the first row, where the Flow card also puts it');
    assert.ok(source.sources.some((row: any) => row.subtitle),
      'and a subtitle, or the line that says which room a setup lives in never draws');
    const levels = source.sources.map((row: any) => row.level).filter((l: any) => l !== undefined);
    assert.ok(Math.max(...levels) - Math.min(...levels) > 0.5,
      'levels far enough apart that the bars are visibly different lengths');
    assert.ok(source.chosen !== 'none',
      'something chosen, or the ticked state — the thing this screen is for — is never drawn');
  });
});
