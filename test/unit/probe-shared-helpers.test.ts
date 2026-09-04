import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two hardware scripts, one set of primitives, and no shared module yet.
 *
 * `scripts/probe-lights.mjs` copies a handful of functions out of
 * `scripts/verify-hardware.mjs` rather than paraphrasing them, and this is what
 * keeps the copies copies. The house already answers duplication this way — the
 * pair views are byte copies held by `pair-view-styles.test.ts` — and here the
 * stakes are higher than tidiness.
 *
 * `capabilityValue` is the reason. A `getAll` writes every item it returns into
 * `homey-api`'s per-manager cache for the life of the client (platform §15), so
 * a `getDevice` without `$cache: false` is served a snapshot forever. That
 * defect produced three "wrote X, holds Y" quirks that went into
 * `docs/homey-platform.md` twice before anyone noticed they were the value from
 * the step before. A probe whose entire output is quirk claims cannot afford it,
 * and a second script re-deriving the discipline from memory is exactly how it
 * comes back.
 *
 * The test compares BODIES, not docblocks: each script explains the helper in
 * its own terms, and the prose is allowed to differ. If a fix lands in one file
 * and not the other, this fails and names the function.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const PROBE = readFileSync(join(ROOT, 'scripts', 'probe-lights.mjs'), 'utf8');
const VERIFY = readFileSync(join(ROOT, 'scripts', 'verify-hardware.mjs'), 'utf8');

/**
 * The helpers that must not drift, and why each one is on the list.
 *
 * Deliberately short. `readConfig`, `ensureConfig` and `connect` are NOT here:
 * the probe needs one key rather than two and records socket status the pass has
 * no use for, so those genuinely differ and pinning them would force a false
 * equivalence.
 */
const SHARED = [
  // The §15 read discipline. The whole reason this file exists.
  'capabilityValue',
  // A bounded await, and the reason a run from a laptop cannot hang forever.
  'withTimeout',
  // Closing the client, or the process prints its report and never exits.
  'disconnectAll',
  'sleep',
  'clamp',
];

/** Source with comments removed, for counting things that must be real code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A top-level function's body, by name, brace-matched.
 *
 * A regex cannot count braces, and these bodies contain nested functions and
 * braces inside template strings, so the closing brace is found by walking.
 *
 * The parameter list is walked first, and not skipped to the next `{`: a default
 * argument is a brace too, and `runStep(light, id, name, fn, opts = {})` handed
 * an earlier version of this helper a body of `{}` that compared equal to
 * nothing and passed.
 */
function bodyOf(source: string, name: string): string {
  const signature = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const start = source.search(signature);
  assert.notEqual(start, -1, `${name} was not found as a top-level function`);

  // Past the parameter list, brace defaults and all.
  let parens = 0;
  let cursor = source.indexOf('(', start);
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') parens += 1;
    if (source[cursor] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }

  const open = source.indexOf('{', cursor);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source
          .slice(open, index + 1)
          // Comments are each script's own explanation of the helper; the code
          // is what has to match.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }
  throw new Error(`${name} has no closing brace`);
}

describe('the primitives both hardware scripts share', () => {
  for (const name of SHARED) {
    test(`${name} has not drifted between the two scripts`, () => {
      assert.equal(
        bodyOf(PROBE, name),
        bodyOf(VERIFY, name),
        `${name} differs between scripts/probe-lights.mjs and scripts/verify-hardware.mjs. `
        + 'Copy the fix into both, or extract scripts/homey-client.mjs and delete this test.',
      );
    });
  }

  test('both scripts read a changing value with the cache opted out', () => {
    // Stated separately from the body comparison, because this is the property
    // and the comparison is only the mechanism. If the helper is ever renamed,
    // this is the test that still says what mattered.
    for (const [label, source] of [['probe-lights', PROBE], ['verify-hardware', VERIFY]] as const) {
      assert.match(
        bodyOf(source, 'capabilityValue'),
        /\$cache: false/,
        `${label} must read live values with $cache: false (platform §15)`,
      );
      assert.match(bodyOf(source, 'capabilityValue'), /\$updateCache: false/);
    }
  });

  test('the probe reads every live value through that one helper', () => {
    // A second `getDevice` for a value, added later and without the flags,
    // would reintroduce the defect while this file went on passing.
    const reads = [...code(PROBE).matchAll(/getDevice\(\{[^}]*\}/g)].map(match => match[0]);
    assert.ok(reads.length > 0, 'the probe should fetch devices');
    for (const read of reads) {
      assert.match(
        read,
        /\$cache: false/,
        `every getDevice in probe-lights.mjs must opt out of the cache: ${read}`,
      );
    }
  });

  test('the probe has exactly one getAll, and it is for static metadata', () => {
    const getAlls = [...code(PROBE).matchAll(/getDevices\(/g)];
    assert.equal(
      getAlls.length,
      1,
      'a second getDevices() would fill the cache again for reasons the comment does not cover',
    );
  });
});

describe('the probe never prints key material', () => {
  /**
   * The same promise `verify-hardware-safety.test.ts` holds up for the other
   * script, checked here for the shape this one has: the probe writes every
   * error it sees into a FILE, so the redaction matters on the way in rather
   * than only on the way to the terminal.
   */
  const lines = PROBE.split(/\r?\n/).map((text, index) => ({ text, number: index + 1 }));

  const isComment = (text: string) => {
    const trimmed = text.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  };

  test('no console call names a key', () => {
    const names = /config\.key|config\.appKey|HOMEY_API_KEY|HOMEY_APP_KEY|token:/;
    for (const line of lines) {
      if (isComment(line.text)) continue;
      if (!/console\.(log|error|warn|info)/.test(line.text)) continue;
      assert.doesNotMatch(
        line.text,
        names,
        `scripts/probe-lights.mjs:${line.number} prints something key-shaped`,
      );
    }
  });

  test('report() and note() are never handed a key', () => {
    const names = /config\.key|config\.appKey|HOMEY_API_KEY|HOMEY_APP_KEY/;
    for (const line of lines) {
      if (isComment(line.text)) continue;
      if (!/\b(report|note)\(/.test(line.text)) continue;
      assert.doesNotMatch(line.text, names, `scripts/probe-lights.mjs:${line.number}`);
    }
  });

  test('the top-level catch prints a message and never the error', () => {
    assert.match(PROBE, /console\.error\(`\\nprobe-lights failed: \$\{explainFailure\(error\)\}`\)/);
    // A bare error object is what would carry a key: a homey-api stack can quote
    // the request back.
    for (const line of lines) {
      if (isComment(line.text)) continue;
      assert.doesNotMatch(
        line.text,
        /console\.(log|error|warn)\(\s*error\s*[),]/,
        `scripts/probe-lights.mjs:${line.number} prints an error object`,
      );
    }
  });

  test('every captured platform error is redacted before it is stored', () => {
    // A homey-api error can quote the request back, token and all, and this
    // script keeps errors in the report file.
    assert.match(bodyOf(PROBE, 'writeCapability'), /redactKeyMaterial\(messageOf\(error\)\)/);
    assert.match(bodyOf(PROBE, 'runStep'), /redactKeyMaterial\(messageOf\(error\)\)/);
  });
});
