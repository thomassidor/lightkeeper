import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINDINGS,
  summariseFindings,
  THRESHOLDS,
  analyseLadder,
  ladderRungs,
  nearestCyclic,
  noteWriteOutcome,
  parseArgs,
  percentiles,
  quantise,
  redactKeyMaterial,
  redactReport,
  toDevice,
  toPerceptual,
  UNREACHABLE_AFTER,
} from '../../scripts/probe-lights.mjs';

/**
 * The probe's verdict logic, proven without a Homey.
 *
 * `scripts/probe-lights.mjs` writes to real lamps and reports quirks, and every
 * high-severity thing it says is a threshold comparison against one of the pure
 * functions below. None of them should need hardware to be believed, and the
 * ones that decide whether a lamp is "inverted" or "on a different scale" are
 * exactly the claims a reader would most want checked.
 *
 * The other half of this file is the findings TABLE, and that test is the reason
 * the table has an `assumption` field at all. A finding that cannot name what it
 * breaks, at a `file:line` somebody can open, is trivia — and a corpus of trivia
 * is worse than no corpus, because somebody will act on it.
 */

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

/** The probe's own facts about the run rather than about a lamp. */
const SELF_REPORTS = /^(PROBE_|RESTORE_)/;

/**
 * What a citation has to look like: a SYMBOL in app source or in this script's
 * sibling, a platform section, or a test.
 *
 * It used to be `file:line`, and by 4 September 2026 most of the 57 line numbers
 * in the table pointed at a blank line, a closing brace or an unrelated comment
 * — including two the probe cited in findings it produced that day. A line
 * number cannot be checked by anything, so it rots on the next refactor and
 * nobody hears about it; a symbol can be, which is what `cites()` below does.
 */
const CITATION = /((?:lib|scripts)\/[\w./-]+\.(?:ts|mjs) [\w.]+(?:\(\))?|platform §\d+|test\/[\w./-]+)/;

/** Every `path Symbol` pair in a string, with the symbol stripped of `()`. */
function citations(text: string): Array<{ file: string; symbol: string }> {
  // A symbol, not the next word: a call, a Type, or a CONSTANT. Prose runs on
  // after a path often enough — "…and lib/x.ts plans against the declared
  // ones" — that a looser pattern reports the sentence rather than the code.
  const CITED = /((?:lib|scripts)\/[\w./-]+\.(?:ts|mjs)) (\w[\w.]*\(\)|[A-Z][\w.]*)/g;
  return [...text.matchAll(CITED)]
    .map(m => ({ file: m[1], symbol: m[2].replace(/\(\)$/, '').split('.').pop()! }));
}

describe('the findings table', () => {
  test('every finding names a severity the summary can rank', () => {
    const allowed = new Set(['critical', 'high', 'medium', 'low', 'info']);
    for (const [code, spec] of Object.entries(FINDINGS)) {
      assert.ok(allowed.has(spec.severity), `${code} has severity "${spec.severity}"`);
    }
  });

  test('every finding has a title that reads as a sentence about the lamp', () => {
    for (const [code, spec] of Object.entries(FINDINGS)) {
      assert.ok(spec.title.length > 10, `${code} has a title of ${spec.title.length} characters`);
      assert.ok(!spec.title.endsWith('.'), `${code}'s title should not end in a full stop`);
    }
  });

  test('every finding about a lamp cites the assumption it violates', () => {
    for (const [code, spec] of Object.entries(FINDINGS)) {
      if (SELF_REPORTS.test(code)) continue;
      assert.ok(spec.assumption.length > 40, `${code}'s assumption is too short to be useful`);
      assert.match(
        spec.assumption,
        CITATION,
        `${code} must cite a file:line or a platform section — a finding that cannot name what it `
        + 'breaks is not actionable',
      );
    }
  });

  /**
   * The citation is only worth having if something checks it.
   *
   * Nothing did, so it rotted wholesale: line numbers moved with every refactor
   * and the table went on claiming a `file:line` somebody could open. Symbols
   * move with their code, and this is what makes that true rather than hoped
   * for — it fails the moment a cited function is renamed or removed.
   */
  test('every citation names a file that exists and a symbol still in it', () => {
    for (const [code, spec] of Object.entries(FINDINGS)) {
      for (const { file, symbol } of citations(spec.assumption)) {
        const path = join(REPO_ROOT, file);
        assert.ok(existsSync(path), `${code} cites ${file}, which does not exist`);
        assert.match(
          readFileSync(path, 'utf8'),
          new RegExp(String.raw`\b${symbol}\b`),
          `${code} cites ${symbol} in ${file}, which no longer contains it`,
        );
      }
    }
  });

  test("the probe's own self-reports still explain themselves", () => {
    const selfReports = Object.keys(FINDINGS).filter(code => SELF_REPORTS.test(code));
    assert.ok(selfReports.length > 0, 'there should be findings about the run itself');
    for (const code of selfReports) {
      assert.ok(
        FINDINGS[code].assumption.length > 40,
        `${code} needs an explanation even though it has no file:line`,
      );
    }
  });

  test('codes are prefixed by the axis they belong to', () => {
    const prefixes = ['META_', 'READ_', 'ECHO_', 'OFF_', 'DIM_', 'TEMP_', 'COLOR_', 'MODE_',
      'RATE_', 'EYES_', 'RESTORE_', 'PROBE_'];
    for (const code of Object.keys(FINDINGS)) {
      assert.ok(
        prefixes.some(prefix => code.startsWith(prefix)),
        `${code} has no known prefix — a quirks table would key on (driverId, code), so the `
        + 'namespace has to stay legible',
      );
    }
  });

  test('the thresholds a finding is judged against are the app\'s own numbers', () => {
    // Transcribed rather than imported (the script is .mjs and cannot import the
    // app's TypeScript), so this is the test that catches a drift.
    assert.equal(THRESHOLDS.OVERRIDE_TOLERANCE, 0.03);
    assert.equal(THRESHOLDS.SETTLE_MS, 3000);
    assert.equal(THRESHOLDS.ECHO_DEDUPE_MS, 1500);
    assert.equal(THRESHOLDS.COLOR_STEP, 0.03);
    assert.equal(THRESHOLDS.HUE_FLOOR, 0.02);
    assert.equal(THRESHOLDS.LAMP_TOLERANCE, 0.1);
    assert.equal(THRESHOLDS.MIN_WRITE_INTERVAL_MS, 200);
    assert.equal(THRESHOLDS.HARD_STOP_MS, 10_000);
    assert.equal(THRESHOLDS.PRE_STAGE_CHECK_MS, 1500);
    assert.equal(THRESHOLDS.GAMMA, 2.2);
    assert.equal(THRESHOLDS.MINIMUM_BRIGHTNESS, 0.1);
  });
});

/**
 * The headline numbers, and the reason they are not a length.
 *
 * The script demotes a finding to `inconclusive` when the lamp it came from
 * turned out to be rejecting every write, or to be driven by something else
 * mid-battery — and then counted it anyway, because the flat array held shallow
 * COPIES and only the per-lamp originals were demoted. On the 4 September 2026
 * run that put 14 findings into the totals that the script had itself ruled
 * void, one of them a critical.
 */
describe('what the summary counts', () => {
  const found = (code: string, severity: string, confidence = 'measured') =>
    ({ code, severity, confidence });

  test('a demoted finding is counted on its own, never in the totals', () => {
    const summary = summariseFindings([
      found('OFF_STAGED', 'info'),
      found('MODE_DOES_NOT_GATE', 'info', 'inconclusive'),
      found('RESTORE_FAILED', 'critical', 'inconclusive'),
    ]);

    assert.deepEqual(summary.byCode, { OFF_STAGED: 1 });
    assert.deepEqual(summary.bySeverity, { info: 1 });
    assert.equal(summary.inconclusive, 2,
      'set aside and said out loud, rather than a gap between two numbers');
  });

  test('everything else is counted by both code and severity', () => {
    const summary = summariseFindings([
      found('ECHO_COUNT', 'info'),
      found('ECHO_COUNT', 'info'),
      found('OFF_WRITE_DECLINED', 'medium'),
    ]);

    assert.deepEqual(summary.byCode, { ECHO_COUNT: 2, OFF_WRITE_DECLINED: 1 });
    assert.deepEqual(summary.bySeverity, { info: 2, medium: 1 });
    assert.equal(summary.inconclusive, 0);
  });

  test('a run with nothing to say says nothing', () => {
    assert.deepEqual(summariseFindings([]), { bySeverity: {}, byCode: {}, inconclusive: 0 });
  });
});

describe('the perceptual axis', () => {
  test('a round trip through gamma returns what went in', () => {
    for (const perceptual of [0, 0.1, 0.35, 0.5, 0.9, 1]) {
      assert.ok(Math.abs(toPerceptual(toDevice(perceptual)) - perceptual) < 1e-9);
    }
  });

  test("the app's minimum brightness is a device value quantise() can eat", () => {
    // 0.1 perceptual is 0.0063 in device values, which `decimals: 2` rounds to
    // 0.01 rather than to zero — the whole reason `litDim()` exists.
    const raw = toDevice(THRESHOLDS.MINIMUM_BRIGHTNESS);
    assert.ok(raw > 0 && raw < 0.01, `expected a tiny positive value, got ${raw}`);
    assert.equal(quantise(raw, 2), 0.01);
    assert.equal(quantise(raw, 1), 0);
  });
});

describe('ladder rungs', () => {
  test('rungs are clamped and quantised through the lamp\'s own metadata', () => {
    const rungs = ladderRungs([0, 0.33, 0.5, 1], { min: 0.2, max: 0.8, decimals: 1 });
    assert.deepEqual(rungs, [0.2, 0.3, 0.5, 0.8]);
  });

  test('duplicates collapse, because two rungs at one value measure nothing twice', () => {
    const rungs = ladderRungs([0.01, 0.02, 0.03], { min: 0, max: 1, decimals: 1 });
    assert.deepEqual(rungs, [0]);
  });

  test('a lamp declaring nothing is walked on the full unit axis', () => {
    const rungs = ladderRungs([0, 0.5, 1], { min: null, max: null, decimals: null });
    assert.deepEqual(rungs, [0, 0.5, 1]);
  });
});

describe('what a completed ladder says', () => {
  test('a well-behaved lamp reports nothing worth reporting', () => {
    const analysis = analyseLadder([
      { wrote: 0.1, held: 0.1 }, { wrote: 0.3, held: 0.3 },
      { wrote: 0.5, held: 0.5 }, { wrote: 0.9, held: 0.9 },
    ]);
    assert.equal(analysis.maxDelta, 0);
    assert.equal(analysis.monotone, true);
    assert.equal(analysis.inverted, false);
    assert.equal(analysis.scaleFactor, null);
    assert.equal(analysis.distinct, 4);
  });

  test('quantisation is the largest gap between what was written and what was held', () => {
    // The pair platform §6 actually measured on this Homey: 0.930 written, 0.850
    // held, and 0.800 written, 0.840 held.
    const analysis = analyseLadder([
      { wrote: 0.8, held: 0.84 }, { wrote: 0.93, held: 0.85 },
    ]);
    assert.equal(analysis.maxDelta, 0.08);
    assert.ok(analysis.maxDelta > THRESHOLDS.OVERRIDE_TOLERANCE,
      'this pair is why the 0.03 override tolerance and the 0.1 lamp tolerance disagree');
    assert.ok(analysis.maxDelta < THRESHOLDS.LAMP_TOLERANCE);
  });

  test('a lamp reporting a percentage scale is caught as a scale, not as noise', () => {
    const analysis = analyseLadder([
      { wrote: 0.1, held: 10 }, { wrote: 0.3, held: 30 },
      { wrote: 0.5, held: 50 }, { wrote: 0.9, held: 90 },
    ]);
    assert.equal(analysis.scaleFactor, 100);
  });

  test('one clamped rung is a ceiling and never a scale', () => {
    const analysis = analyseLadder([
      { wrote: 0.1, held: 0.1 }, { wrote: 0.5, held: 0.5 },
      { wrote: 0.9, held: 0.85 }, { wrote: 1, held: 0.85 },
    ]);
    assert.equal(analysis.scaleFactor, null);
    assert.equal(analysis.effectiveMax, 0.85);
  });

  test('inversion is claimed only when the reports track 1 minus the value', () => {
    const inverted = analyseLadder([
      { wrote: 0.1, held: 0.9 }, { wrote: 0.3, held: 0.7 },
      { wrote: 0.5, held: 0.5 }, { wrote: 0.9, held: 0.1 },
    ]);
    assert.equal(inverted.inverted, true);
  });

  test('a lamp that ignores the axis is not called inverted', () => {
    // It reports a constant. That is a different defect, and calling it
    // inversion would send the reader looking for a sign error.
    const stuck = analyseLadder([
      { wrote: 0.1, held: 0.5 }, { wrote: 0.3, held: 0.5 },
      { wrote: 0.5, held: 0.5 }, { wrote: 0.9, held: 0.5 },
    ]);
    assert.equal(stuck.inverted, false);
    assert.equal(stuck.distinct, 1);
  });

  test('monotonicity is judged against the order the rungs were written', () => {
    const dip = analyseLadder([
      { wrote: 0.1, held: 0.1 }, { wrote: 0.3, held: 0.3 },
      { wrote: 0.5, held: 0.15 }, { wrote: 0.9, held: 0.9 },
    ]);
    assert.equal(dip.monotone, false);
  });

  test('a fall inside the override tolerance is not a fall', () => {
    const jitter = analyseLadder([
      { wrote: 0.3, held: 0.30 }, { wrote: 0.5, held: 0.28 },
    ]);
    assert.equal(jitter.monotone, true);
  });

  test('resolution is the smallest real step the lamp showed', () => {
    const analysis = analyseLadder([
      { wrote: 0.1, held: 0.1 }, { wrote: 0.2, held: 0.15 },
      { wrote: 0.3, held: 0.3 },
    ]);
    assert.equal(analysis.resolution, 0.05);
  });

  test('a ladder with nothing readable concludes nothing', () => {
    const analysis = analyseLadder([{ wrote: 0.5, held: null }]);
    assert.equal(analysis.n, 0);
    assert.equal(analysis.maxDelta, null);
    assert.equal(analysis.monotone, null);
  });
});

describe('hue is a wheel', () => {
  test('0.98 written and 0.01 held is a small error, not a huge one', () => {
    assert.ok(Math.abs(nearestCyclic(0.01, 0.98) - 0.98) < 0.04);
  });

  test('a lamp that clamps instead of wrapping still reads as far away', () => {
    assert.ok(Math.abs(nearestCyclic(0.6, 0.98) - 0.98) > THRESHOLDS.LAMP_TOLERANCE);
  });

  test('the short way round is used even across zero in both directions', () => {
    assert.ok(Math.abs(nearestCyclic(0.99, 0.02) - 0.02) < 0.04);
  });
});

describe('latency distributions', () => {
  test('an empty set reports nothing rather than zero', () => {
    assert.deepEqual(percentiles([]), { n: 0, min: null, p50: null, p90: null, max: null });
  });

  test('percentiles come out of the sorted set', () => {
    const stats = percentiles([500, 100, 200, 300, 400]);
    assert.equal(stats.n, 5);
    assert.equal(stats.min, 100);
    assert.equal(stats.max, 500);
    assert.equal(stats.p50, 300);
  });
});

describe('key material never reaches the report', () => {
  test('a whole key collapses to one redaction', () => {
    const key = '11111111-2222-3333-4444-555555555555:'
      + '66666666-7777-8888-9999-aaaaaaaaaaaa:'
      + 'bbbbbbbbbbbbbbbbbbbbbbbb';
    assert.equal(redactKeyMaterial(`token=${key} rest`), 'token=<redacted> rest');
  });

  test('a device id survives, because it is what makes a failure diagnosable', () => {
    const id = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
    assert.equal(redactKeyMaterial(`device ${id} refused`), `device ${id} refused`);
  });
});

describe('the redacted report', () => {
  /** A report shaped like the real one, with a house in it. */
  const raw = {
    schema: 1,
    startedAt: '2026-09-03T19:30:00.000Z',
    finishedAt: '2026-09-03T19:45:00.000Z',
    homey: { address: 'http://192.168.5.16', softwareVersion: '13.5.0-rc.4', id: 'homey-abc' },
    environment: { node: 'v22.12.0', tz: 'Europe/Copenhagen', localTime: 'Thu Sep 03 2026 21:30' },
    lights: [
      {
        ref: {
          id: 'device-1', name: "Marie-Louise's Side", zoneId: 'zone-1', zoneName: 'Bedroom',
          driverId: 'homey:app:nl.philips.hue:bulb', ownerName: 'Philips Hue',
          ownerUri: 'homey:app:nl.philips.hue', deviceClass: 'light',
        },
        declared: { dim: { min: 0, max: 1, decimals: 2, title: 'Dim' } },
        observations: [
          { seq: 1, at: 1788500000000, kind: 'write', capability: 'dim', value: 0.5 },
          {
            seq: 2, at: 1788500001000, kind: 'error', capability: 'dim', value: null,
            error: 'device (light) device-1 in Bedroom is "soft off"',
          },
        ],
        findings: [{ code: 'DIM_QUANT_OVER_TOLERANCE', severity: 'high', numbers: { maxDelta: 0.08 } }],
        restore: { complete: true },
      },
    ],
    summary: { byDriver: { 'homey:app:nl.philips.hue:bulb': { ownerName: 'Philips Hue', lights: 1 } } },
  };

  test('names, the address and the timezone are gone', () => {
    const { redacted } = redactReport(raw);
    const serialised = JSON.stringify(redacted);
    assert.ok(!serialised.includes('Marie-Louise'));
    assert.ok(!serialised.includes('Bedroom'));
    assert.ok(!serialised.includes('192.168.5.16'));
    assert.ok(!serialised.includes('Europe/Copenhagen'));
  });

  test('ids are pseudonymised consistently rather than deleted', () => {
    const { redacted } = redactReport(raw);
    assert.equal(redacted.lights[0].ref.id, 'light-01');
    // The same id inside a captured platform error becomes the same alias, or
    // the trace stops being followable — test/fixtures/README.md says why ids
    // are load-bearing.
    assert.match(redacted.lights[0].observations[1].error, /light-01/);
    assert.ok(!redacted.lights[0].observations[1].error.includes('device-1'));
  });

  test('the evidence is kept in full', () => {
    const { redacted } = redactReport(raw);
    assert.equal(redacted.lights[0].ref.driverId, 'homey:app:nl.philips.hue:bulb');
    assert.equal(redacted.lights[0].ref.ownerName, 'Philips Hue');
    assert.equal(redacted.lights[0].declared.dim.decimals, 2);
    assert.equal(redacted.lights[0].findings[0].numbers.maxDelta, 0.08);
    assert.equal(redacted.homey.softwareVersion, '13.5.0-rc.4');
  });

  test('wall-clock times become offsets into the run', () => {
    const { redacted } = redactReport(raw);
    // A duration is evidence; the hour somebody was at home is not.
    assert.equal(redacted.startedAt, '2026-09-03');
    assert.ok(redacted.lights[0].observations[0].at < 1e12);
    assert.equal(
      redacted.lights[0].observations[1].at - redacted.lights[0].observations[0].at,
      1000,
    );
  });

  test('a leak is reported rather than written', () => {
    const { leaks } = redactReport(raw);
    assert.deepEqual(leaks, []);
  });
});

describe('the command line', () => {
  test('a bare invocation is read-only', () => {
    const parsed = parseArgs([]);
    assert.deepEqual(parsed.commands, []);
  });

  test('repeatable value flags collect every occurrence', () => {
    const parsed = parseArgs(['axes', '--zone', 'Office', '--zone', 'Kitchen', '--yes']);
    assert.deepEqual(parsed.commands, ['axes']);
    assert.deepEqual(parsed.options['--zone'], ['Office', 'Kitchen']);
    assert.ok(parsed.switches.has('--yes'));
  });

  test('a value flag with no value is refused rather than guessed at', () => {
    assert.throws(() => parseArgs(['--zone']), /--zone needs a value/);
    assert.throws(() => parseArgs(['--zone', '--yes']), /--zone needs a value/);
  });

  test('an unknown flag is refused, so a typo never silently widens the run', () => {
    assert.throws(() => parseArgs(['--evertything']), /unknown flag/);
  });

  test('a lamp named like a flag value still parses', () => {
    const parsed = parseArgs(['--light', 'Spot 1 | Activity room']);
    assert.deepEqual(parsed.options['--light'], ['Spot 1 | Activity room']);
  });
});

/**
 * A lamp that takes no writes, and why its answers had to stop counting.
 *
 * From the first full run: one Hue bulb was unreachable for all eighteen
 * minutes — 93 of 113 writes rejected — and produced BOTH criticals, two of the
 * three highs, and a `MODE_DOES_NOT_GATE` drawn from a temperature write that
 * never left the house. Every step here reads what a lamp REPORTS to decide
 * what a write did, and a lamp that took no write reports whatever it was
 * already holding, so a gated axis and a dead radio look identical.
 */
describe('the unreachable demotion', () => {
  const fresh = () => ({ failedWrites: 0, unreachable: false });

  test('one failure is not a verdict', () => {
    const after = noteWriteOutcome(fresh(), false);
    assert.equal(after.failedWrites, 1);
    assert.equal(after.unreachable, false);
  });

  test('three consecutive rejections demote the lamp', () => {
    let state = fresh();
    for (let i = 0; i < UNREACHABLE_AFTER; i += 1) state = noteWriteOutcome(state, false);
    assert.equal(state.unreachable, true);
  });

  test('a success in between resets the count', () => {
    let state = fresh();
    state = noteWriteOutcome(state, false);
    state = noteWriteOutcome(state, false);
    state = noteWriteOutcome(state, true);
    state = noteWriteOutcome(state, false);
    state = noteWriteOutcome(state, false);
    // Two, then two: a flaky lamp is not an absent one.
    assert.equal(state.failedWrites, 2);
    assert.equal(state.unreachable, false);
  });

  test('the demotion is one-way inside a battery', () => {
    let state = fresh();
    for (let i = 0; i < UNREACHABLE_AFTER; i += 1) state = noteWriteOutcome(state, false);
    state = noteWriteOutcome(state, true);
    // The count clears so the log stops repeating, but the lamp's earlier
    // measurements were taken while it was gone. Un-demoting mid-battery would
    // republish exactly the conclusions this exists to withdraw.
    assert.equal(state.failedWrites, 0);
    assert.equal(state.unreachable, true);
  });

  test('the threshold is low, because this is not the app\'s question', () => {
    // `LightTargetAdapter.UNWRITABLE_AFTER_WRITES` needs a five-minute floor
    // too, because a false positive there marks a user's device. Here a false
    // positive costs seventy seconds of probing, and a false NEGATIVE costs a
    // page of fabricated quirks.
    assert.ok(UNREACHABLE_AFTER <= 3, 'cheap to be wrong, expensive to be slow');
  });
});

describe('the report describes its own coverage', () => {
  test("a finding's assumption survives redaction, which `title` would not", () => {
    const raw = {
      schema: 1,
      startedAt: '2026-09-03T19:30:00.000Z',
      homey: { address: 'http://192.168.5.16' },
      lights: [{
        ref: { id: 'device-1', name: 'Hallway', zoneId: 'zone-1', zoneName: 'Hall' },
        observations: [], findings: [], restore: { complete: true },
      }],
      findingsCatalogue: {
        MODE_GATES_TEMP: {
          severity: 'high',
          headline: FINDINGS.MODE_GATES_TEMP.title,
          assumption: FINDINGS.MODE_GATES_TEMP.assumption,
        },
      },
      summary: { byDriver: {} },
    };

    const { redacted } = redactReport(raw);
    // `title` is in the redactor's DROP set — a capability title is renameable
    // user text — so the catalogue names the field `headline` instead. Getting
    // this wrong strips the meaning out of the only report anybody shares.
    assert.equal(redacted.findingsCatalogue.MODE_GATES_TEMP.headline,
      FINDINGS.MODE_GATES_TEMP.title);
    assert.match(redacted.findingsCatalogue.MODE_GATES_TEMP.assumption, /platform §6/);
  });

  test('every code in the table could be catalogued', () => {
    // The report emits a catalogue entry per code it produced. A code with no
    // title or no assumption would publish nulls into the shareable artefact.
    for (const [code, spec] of Object.entries(FINDINGS)) {
      assert.ok(spec.title, `${code} has no title to publish`);
      assert.ok(spec.assumption, `${code} has no assumption to publish`);
    }
  });
});
