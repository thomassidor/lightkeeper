import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The hardware script handles TWO live Personal API Keys, and prints neither.
 *
 * The app has `diagnostics-redaction.test.ts` holding up the same promise from
 * the inside. Nothing held it up on the outside, and the outside is where the
 * keys are in plain text: `scripts/hardware-env.json` is a file on a laptop, and
 * the script's output is pasted into release reports by design — its whole
 * output format exists so it can be.
 *
 * This reads the script as text rather than running it. Running it needs a
 * Homey; the property being checked is a property of the source, and a source
 * check is the one that fails in CI rather than on the evening of a release.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'verify-hardware.mjs');
const source = readFileSync(SCRIPT, 'utf8');

/** Every line, numbered, so a failure names the line rather than the file. */
const lines = source.split(/\r?\n/).map((text, index) => ({ text, number: index + 1 }));

/** A line that is only a comment cannot print anything. */
function isComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

describe('verify-hardware never prints key material', () => {
  test('no console call names a key', () => {
    /**
     * The names the keys travel under. `config.key` and `config.appKey` are the
     * loaded values; `token:` is the property `createLocalAPI` takes them in.
     *
     * `key` alone is deliberately NOT in this list — the script has a
     * `bindingKey`, an `eventKey` and a `variantKey`, none of which are secret,
     * and a rule that cries wolf on those is a rule that gets deleted.
     */
    const NAMES = /\bconfig\.(key|appKey)\b|\bHOMEY_(API|APP)_KEY\b/;

    const offenders = lines
      .filter(line => !isComment(line.text))
      .filter(line => /\bconsole\.(log|error|warn|info|debug)\b/.test(line.text))
      .filter(line => NAMES.test(line.text))
      .map(line => `${line.number}: ${line.text.trim()}`);

    assert.deepEqual(
      offenders, [],
      'a console call on the same line as a key — the script prints its report '
      + 'straight into release notes, so a key on that path is a key in a document',
    );
  });

  test('the reporter is never handed a key', () => {
    // `report()` and `note()` are the two things whose output IS the report.
    const offenders = lines
      .filter(line => !isComment(line.text))
      .filter(line => /\b(report|note)\(/.test(line.text))
      .filter(line => /\bconfig\.(key|appKey)\b/.test(line.text))
      .map(line => `${line.number}: ${line.text.trim()}`);

    assert.deepEqual(offenders, [], 'a key passed to the reporter');
  });

  test('the top-level catch prints a message, never the error', () => {
    /**
     * The regression this pins: a stack from homey-api can quote the failing
     * request back, headers included. Only a NARROWED string may be printed.
     *
     * Which narrowing is not the point — this test has already broken once by
     * naming `messageOf(error)` specifically and then meeting `explainFailure(error)`,
     * which wraps it. What matters is that the raw error never reaches the
     * console, so that is what is checked.
     */
    const tail = source.slice(source.lastIndexOf('main().catch'));

    // Every accepted narrowing, removed; whatever is left must not be `error`.
    const narrowed = tail
      .replace(/messageOf\(error\)/g, 'SAFE')
      .replace(/explainFailure\(error\)/g, 'SAFE');

    assert.ok(/console\.error\([^)]*SAFE/.test(narrowed),
      'the catch no longer prints a narrowed message — what does it print?');
    assert.ok(
      !/console\.(error|log)\([^)]*error/.test(narrowed),
      'the catch prints the error object itself, which can carry the request',
    );

    // And any narrowing it uses is itself built on messageOf, never on the
    // error's own stack or its properties.
    if (tail.includes('explainFailure(error)')) {
      const fn = source.slice(source.indexOf('function explainFailure('));
      // Up to its last statement — enough of the body to judge, no escapes needed.
      const body = fn.slice(0, fn.indexOf('return message;'));
      assert.ok(body.includes('messageOf(error)'),
        'explainFailure should narrow through messageOf');
      assert.ok(!body.includes('error.stack'),
        'explainFailure reads the stack, which can quote the request back');
    }
  });

  test('a key typed at the prompt is never echoed', () => {
    /**
     * A credential HAS leaked here, so this test is not hypothetical.
     *
     * The first version masked readline's echo by overriding its private
     * `_writeToOutput`. It passed a piped test and failed on a real Windows
     * terminal: the prompt vanished, the pasted key was printed in full, and it
     * went into the scrollback and from there into a bug report.
     *
     * What replaced it cannot echo by construction — raw mode, and exactly one
     * `stdout.write` of typed input, guarded by `if (!secret)`. That guard is
     * what this pins.
     */
    assert.ok(source.includes('stdin.setRawMode'), 'the prompt no longer uses raw mode');
    // Code only: the comment above `ask()` names `_writeToOutput` to explain why
    // it is gone, and a rule that trips over its own explanation gets deleted.
    assert.deepEqual(
      lines.filter(line => !isComment(line.text))
        .filter(line => line.text.includes('_writeToOutput'))
        .map(line => `${line.number}: ${line.text.trim()}`),
      [],
      'readline echo-muting is back — it does not hold on a real terminal',
    );

    /**
     * Every echo of typed input is guarded by `!secret`.
     *
     * Matched on `stdout.write(character)` alone rather than on the backspace
     * sequence too: `'\b \b'` in the source needs escaping twice to survive
     * into a regex literal, and a pattern that quietly fails to match is exactly
     * how a guard test comes to guard nothing.
     */
    const echoes = lines
      .filter(line => !isComment(line.text))
      .filter(line => /stdout\.write\(character\)/.test(line.text));

    assert.ok(echoes.length > 0, 'the echo path is gone — has the prompt been rewritten?');
    assert.deepEqual(
      echoes.filter(line => !/if \(!secret\)/.test(line.text))
        .map(line => `${line.number}: ${line.text.trim()}`),
      [],
      'typed input is echoed without checking whether it is a secret',
    );

    // And a terminal that cannot hide input must refuse, never fall back.
    assert.ok(
      /if \(secret && typeof stdin\.setRawMode !== 'function'\)/.test(source),
      'a terminal without raw mode no longer refuses — it would echo the key',
    );
  });

  test('the terminal is handed back even if a prompt throws', () => {
    // Raw mode left on looks like a broken shell: no echo, no line editing,
    // Ctrl-C inert.
    const tail = source.slice(source.indexOf('async function ensureConfig'));
    assert.ok(/finally \{[\s\S]{0,400}?setRawMode\?\.\(false\)/.test(tail),
      'nothing restores raw mode when the prompt throws');
  });

  test('the saved config file is written for the owner only', () => {
    // It holds two live credentials, in a directory whose other contents are
    // committed and shared.
    assert.ok(/mode: 0o600/.test(source), 'hardware-env.json is written world-readable');
  });

  test('both keys are searched for in the diagnostics report', () => {
    // T45 is the line this script exists to answer by machine. Searching only
    // the script's own key would pass while the app leaked the one it holds.
    assert.ok(
      source.includes('commandRedaction(api, [config.appKey, config.key])'),
      'redaction should be given both keys',
    );
  });

  test('the two-key refusal is wired to the command that needs it', () => {
    /**
     * The PROPERTY, not the line that currently expresses it.
     *
     * An earlier version of this test pinned one exact `if (...) requireTwoKeys`
     * statement, and duly failed the moment that statement was restructured into
     * something equivalent. A guard test that breaks on a refactor of the thing
     * it guards teaches its reader to edit the test until it passes, which is
     * the opposite of what it is for.
     *
     * What has to stay true: the guard exists, it is CALLED (an unreferenced one
     * is a comment), and it is called before `connect()` — a run that discovers
     * the problem after connecting has already started doing things.
     */
    assert.ok(source.includes('function requireTwoKeys('), 'requireTwoKeys is defined');

    const called = source.indexOf('requireTwoKeys(config)');
    assert.ok(called > 0, 'requireTwoKeys is never called');

    const connects = source.indexOf('await connect(config)');
    assert.ok(connects > 0, 'the script no longer connects the way this test expects');
    assert.ok(called < connects,
      'the two-key check must run BEFORE connecting, so a one-key setup is turned away '
      + 'rather than turned away halfway through');

    // And it is reached only on the command that needs it, rather than gating
    // every read-only run behind a second key nobody else needs.
    assert.ok(source.includes("commands.includes('credential')"),
      'the check should be scoped to the credential command');
  });
});

describe('verify-hardware reads a runtime id the way the app writes one', () => {
  /**
   * `GET /` summaries call it `id`; `GET /diagnostics` runtimes call it
   * `controllerId`. Matching diagnostics on `.id` compiles, runs, and silently
   * never matches — which is what made T24, T25 and T29 report FAILED after
   * their full timeouts on every run this script has ever had.
   */
  test('no diagnostics lookup matches on a bare .id', () => {
    const offenders = lines
      .filter(line => !isComment(line.text))
      .filter(line => /\.find\(c =>/.test(line.text))
      .filter(line => /String\(c\?\.id\)/.test(line.text))
      .map(line => `${line.number}: ${line.text.trim()}`);

    assert.deepEqual(
      offenders, [],
      'a circadian diagnostics entry has controllerId and no id — use runtimeId()',
    );
  });

  test('the normaliser accepts both spellings', () => {
    assert.ok(
      /function runtimeId\(entry\) \{\s*return String\(entry\?\.controllerId \?\? entry\?\.id \?\? ''\);/
        .test(source),
      'runtimeId should fall back from controllerId to id',
    );
  });
});

describe('verify-hardware deletes only the devices it created', () => {
  /**
   * The pass runs against a Homey somebody lives with. Every command selects
   * from the devices it built itself, and it recognises them by a marker on the
   * name — so a device that is never marked is a device teardown will never
   * delete, and a delete that never checks the marker is one that can take a
   * controller the user paired.
   *
   * Read as text, like everything else here: running it needs a Homey, and this
   * is the check that fails in CI rather than on somebody's evening.
   */

  /** One function's source, from its declaration to the next top-level one. */
  function bodyOf(declaration: string): string {
    const from = source.indexOf(declaration);
    assert.ok(from > 0, `${declaration} is gone`);
    const rest = source.slice(from + declaration.length);
    const to = rest.indexOf('\nasync function ');
    return rest.slice(0, to === -1 ? undefined : to);
  }

  test('every device it pairs is marked', () => {
    assert.ok(/^const MARKER = /m.test(source), 'the marker is gone');
    assert.match(
      bodyOf('function dtoFrom(saved)'), /markName\(/,
      'dtoFrom no longer marks the name it returns — it is the one function every '
      + 'device this script creates passes through, and an unmarked device is one '
      + 'teardown will never delete and every other command will ignore',
    );
  });

  test('the delete is guarded by the mark, re-read from the Homey', () => {
    const teardown = bodyOf('async function commandTeardown(api)');
    const del = teardown.indexOf('deleteDevice(');
    assert.ok(del > 0, 'teardown no longer deletes anything');
    assert.ok(
      teardown.lastIndexOf('isMarked(', del) > 0,
      'nothing checks the mark before the permanent delete',
    );
    assert.ok(
      teardown.indexOf('getDevice(') > 0 && teardown.indexOf('getDevice(') < del,
      'the guard trusts a list read seconds earlier rather than asking the Homey',
    );
  });

  test('teardown selects from the marked devices, not from every one', () => {
    assert.match(
      bodyOf('async function commandTeardown(api)'), /isMarked\(device\.name\)/,
      'teardown no longer filters to the devices this pass built',
    );
  });

  test('nothing else in the file deletes a device', () => {
    /**
     * Two call sites, and only two: teardown, and pairspike cleaning up the one
     * throwaway device it just made. Brittle on purpose — a third is precisely
     * the failure this marker exists to prevent, so whoever adds one should have
     * to read a test that says why.
     */
    const offenders = lines
      .filter(line => !isComment(line.text))
      .filter(line => /deleteDevice\(/.test(line.text))
      .map(line => `${line.number}: ${line.text.trim()}`);

    assert.equal(
      offenders.length, 2,
      `deleteDevice call sites: ${offenders.join(' | ')}`,
    );
  });
});
