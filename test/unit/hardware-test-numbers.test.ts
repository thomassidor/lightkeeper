import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUTOMATED, RETIRED, planDefinitions, stillManual, automatedTable, reportedLines,
  mentionedLines, byLineNumber, TABLE_START, TABLE_END,
} from '../../scripts/verify/lines.mjs';

/**
 * Three places say what a test-plan number means, and they must agree.
 *
 * - `docs/hardware-test-plan.md` DEFINES the lines a person runs, one checklist
 *   item each: `- [ ] **T24** …`.
 * - `scripts/verify-hardware.mjs` PRINTS numbers, as quoted literals.
 * - `docs/hardware-test-coverage.md` says which command answers which line, and
 *   carries the full table of what the script prints (`AUTOMATED`, rendered).
 *
 * None of that was checked, and all of it had drifted: three numbers were
 * defined twice in the plan with different meanings (T127-T129, a design line
 * and a memory line each), about fifty numbers the script printed were defined
 * nowhere, one number (T79) meant two different things in two commands, the
 * plan cited a line that no longer existed (T88), and the list of what "still
 * needs a person" was six lines long against a plan of sixty. A report line that
 * cannot be looked up is not evidence of anything, and a number reused is a
 * report that means two things.
 *
 * The rule under all of it is CLAUDE.md's: a number is never reused.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

const plan = read('docs/hardware-test-plan.md');
const coverage = read('docs/hardware-test-coverage.md');

/** Every script file that reports lines: the entry point and its modules. */
const scriptSources = [
  read('scripts/verify-hardware.mjs'),
  ...readdirSync(join(ROOT, 'scripts', 'verify'))
    .filter(file => file.endsWith('.mjs'))
    // lines.mjs is the TABLE of numbers, not a reporter of them.
    .filter(file => file !== 'lines.mjs')
    .map(file => read(`scripts/verify/${file}`)),
];
const reported = new Set(scriptSources.flatMap(source => [...reportedLines(source)]));

const defined = planDefinitions(plan);
const definedSet = new Set(defined.map(line => line.line));

describe('test-plan numbers', () => {
  test('no number is defined twice in the plan', () => {
    const seen = new Map<string, number>();
    for (const { line } of defined) seen.set(line, (seen.get(line) ?? 0) + 1);
    const twice = [...seen].filter(([, count]) => count > 1).map(([line]) => line);
    assert.deepEqual(twice, [], `defined more than once: ${twice.join(', ')} — renumber one of each `
      + 'to a number above the highest in use; a number is never reused');
  });

  test('no retired number is defined again, or printed by the script', () => {
    const reused = [...definedSet, ...reported, ...Object.keys(AUTOMATED)]
      .filter(line => line in RETIRED);
    assert.deepEqual([...new Set(reused)], [], 'a retired number came back');
  });

  test('every number the script prints is in the AUTOMATED table, and every entry is printed', () => {
    assert.ok(reported.size > 50, 'the scan found almost nothing — has the report() form changed?');
    const unlisted = [...reported].filter(line => !(line in AUTOMATED)).sort(byLineNumber);
    assert.deepEqual(unlisted, [], `printed by the script but missing from AUTOMATED in `
      + `scripts/verify/lines.mjs: ${unlisted.join(', ')}`);
    const silent = Object.keys(AUTOMATED).filter(line => !reported.has(line)).sort(byLineNumber);
    assert.deepEqual(silent, [], `in AUTOMATED but never printed: ${silent.join(', ')}`);
  });

  test("the coverage doc's table is exactly AUTOMATED", () => {
    const from = coverage.indexOf(TABLE_START);
    const to = coverage.indexOf(TABLE_END);
    assert.ok(from !== -1 && to > from, 'the automated-lines markers are gone from hardware-test-coverage.md');
    const inDoc = coverage.slice(from + TABLE_START.length, to).trim();
    assert.equal(inDoc, automatedTable(),
      'docs/hardware-test-coverage.md has drifted from AUTOMATED — paste the expected text between '
      + 'the automated-lines markers');
  });

  test("every line the coverage doc's command table assigns to a command is printed by it", () => {
    const from = coverage.indexOf('| Command | Test-plan lines | Effect on the Homey |');
    assert.ok(from !== -1, 'the command table is gone');
    const table = coverage.slice(from, coverage.indexOf('\n\n', from));
    for (const row of table.split('\n').slice(2)) {
      const cells = row.split('|').map(cell => cell.trim());
      const command = /`([a-z]+)`/.exec(cells[1] ?? '')?.[1];
      if (!command) continue;
      for (const line of mentionedLines(cells[2] ?? '')) {
        assert.ok(reported.has(line), `the coverage table says ${command} answers ${line}; the script never prints it`);
        const owner = AUTOMATED[line]?.command ?? '';
        assert.ok(owner.split(/,\s*/).includes(command) || (command === 'memory' && owner === 'full'),
          `the coverage table gives ${line} to ${command}; AUTOMATED gives it to ${owner}`);
      }
    }
  });

  test('every number either doc mentions is defined, printed, or retired', () => {
    for (const [name, text] of [['hardware-test-plan.md', plan], ['hardware-test-coverage.md', coverage]] as const) {
      const unknown = [...mentionedLines(text)]
        .filter(line => !definedSet.has(line) && !(line in AUTOMATED) && !(line in RETIRED))
        .sort(byLineNumber);
      assert.deepEqual(unknown, [], `docs/${name} mentions ${unknown.join(', ')}, which nothing defines`);
    }
  });

  test('what the end of `full` hands to a person comes from the plan, and includes the remote', () => {
    const manual = stillManual(plan).map(line => line.line);
    for (const line of ['T3', 'T9', 'T10', 'T11', 'T53', 'T54', 'T179']) {
      assert.ok(manual.includes(line), `${line} needs a person and is missing from stillManual()`);
    }
    // A line the script answers whole is not a person's job; one it answers in
    // part still is, marked.
    const partial = stillManual(plan).find(line => line.line === 'T167');
    assert.equal(partial?.partial, true);
    assert.ok(!manual.includes('T173'), 'T173 is answered whole by `control`');
    for (const line of defined.filter(l => l.checked)) {
      assert.ok(!manual.includes(line.line), `${line.line} is ticked and should not be handed out again`);
    }
  });
});
