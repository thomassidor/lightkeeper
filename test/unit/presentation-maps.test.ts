import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { credentialFailureKey, type CredentialFailure } from '../../lib/credential-service';
import type { ControllerState } from '../../lib/profiles/controller-profile';

/**
 * Every hand-written copy of a machine-readable value's presentation.
 *
 * There are four such maps and none of them can import from `lib/`: the settings
 * page and every pairing view are plain browser script served into a webview.
 * They are therefore copies, and the only thing that can keep a copy honest is a
 * test that finds them on disk and compares them all — which is what this is.
 *
 * The existing single-copy check lives in `credential-service.test.ts`; this
 * widens it to every copy, and to the state map as well. The failure it prevents:
 * adding a fifth `CredentialFailure` or a sixth `ControllerState` updates one
 * copy, and the others fall back to raw English from `lib/` — or, in the state
 * map's case, to the enum member itself, underscore and all, in the one place a
 * user looks to find out what is wrong.
 */

const ROOT = join(import.meta.dirname, '..', '..');

const FAILURES: readonly CredentialFailure[] = [
  'malformed', 'session_expired', 'insufficient_scope', 'unknown',
];

const STATES: readonly ControllerState[] = [
  'ready', 'partial', 'needs_repair', 'needs_credential', 'disabled',
];

/** Where a copy of the failure map lives, and how it spells `Homey.__`. */
interface Copy {
  label: string;
  source: string;
}

function credentialViews(): Copy[] {
  // Discovered from disk, not listed: a new driver's credential screen is
  // covered the moment it exists, which is the same reason the pair-view style
  // tests discover theirs.
  const found: Copy[] = [];
  for (const driver of readdirSync(join(ROOT, 'drivers'))) {
    for (const mode of ['pair', 'repair']) {
      const path = join(ROOT, 'drivers', driver, mode, 'credential.html');
      if (!existsSync(path)) continue;
      found.push({ label: `drivers/${driver}/${mode}/credential.html`, source: readFileSync(path, 'utf8') });
    }
  }
  return found;
}

function allCopies(): Copy[] {
  return [
    { label: 'settings/index.html', source: readFileSync(join(ROOT, 'settings', 'index.html'), 'utf8') },
    ...credentialViews(),
  ];
}

/** `case 'x': return Homey.__('a.b')` / `HomeyRef.__('a.b')`, in either spelling. */
function failureMapOf(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/case '([a-z_]+)': return (?:HomeyRef|Homey)\.__\('([\w.]+)'\)/g)]
      .map(match => [match[1]!, match[2]!]),
  );
}

describe('the credential failure map, in every copy of it', () => {
  const copies = allCopies();

  test('there is more than one copy, so this test has something to do', () => {
    // If this ever drops to one, the views have stopped mirroring the map and
    // something else has gone wrong.
    assert.ok(copies.length >= 3, `found ${copies.length} copies`);
  });

  test('every copy translates every failure the app can report', () => {
    for (const copy of copies) {
      const mirrored = failureMapOf(copy.source);
      for (const failure of FAILURES) {
        assert.equal(
          mirrored.get(failure), credentialFailureKey(failure),
          `${copy.label} does not translate "${failure}" the way credentialFailureKey() does`,
        );
      }
    }
  });

  test('and no copy translates anything the app cannot report', () => {
    for (const copy of copies) {
      for (const failure of failureMapOf(copy.source).keys()) {
        assert.ok(
          (FAILURES as readonly string[]).includes(failure),
          `${copy.label} handles "${failure}", which is not a CredentialFailure`,
        );
      }
    }
  });

  test('the copies agree with each other, not merely with the app', () => {
    // Byte-comparing the whole file is repair-views.test.ts's job. This is the
    // narrower claim: whatever each copy says about a failure, they all say the
    // same thing.
    const [first, ...rest] = copies;
    const reference = failureMapOf(first!.source);
    for (const copy of rest) {
      assert.deepEqual(
        [...failureMapOf(copy.source).entries()].sort(),
        [...reference.entries()].sort(),
        `${copy.label} disagrees with ${first!.label}`,
      );
    }
  });
});

describe('the controller state map', () => {
  const page = readFileSync(join(ROOT, 'settings', 'index.html'), 'utf8');

  /** `case 'ready': return t('stateReady')` */
  const mapped = new Map(
    [...page.matchAll(/case '([a-z_]+)': return t\('(\w+)'\)/g)].map(m => [m[1]!, m[2]!]),
  );

  test('every state the app can report has a label', () => {
    for (const state of STATES) {
      assert.ok(
        mapped.has(state),
        `settings/index.html has no label for state "${state}" — it would render `
        + 'the enum member, underscore and all',
      );
    }
  });

  test('and no label exists for a state the app cannot report', () => {
    for (const state of mapped.keys()) {
      assert.ok(
        (STATES as readonly string[]).includes(state),
        `settings/index.html labels "${state}", which is not a ControllerState`,
      );
    }
  });

  test('every label it names is a defined locale key', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'locales', 'en.json'), 'utf8')) as {
      settings: Record<string, unknown>;
    };
    for (const key of mapped.values()) {
      assert.ok(key in en.settings, `settings.${key} is used but not defined`);
    }
  });
});
