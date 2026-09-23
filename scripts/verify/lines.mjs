/**
 * Every test-plan line the hardware script reports, what each one means, and
 * which plan lines are therefore still a person's job.
 *
 * Three sources used to disagree about the numbers, and nothing noticed:
 *
 * - `docs/hardware-test-plan.md` defines the MANUAL lines, and did not define
 *   about fifty of the numbers the script prints — T1, T5-T8, T12-T52 and
 *   T77-T80 existed only as string literals in `verify-hardware.mjs`, so a
 *   report reading `T31 OK` could not be looked up anywhere;
 * - `STILL_MANUAL` in the script was a hand-kept list of six lines while the
 *   plan held sixty, so the end of `full` told a person their job was six lines
 *   long;
 * - three numbers were defined twice in the plan with two meanings each.
 *
 * So this is the one list of what the script reports, `AUTOMATED`. The plan
 * stays the list of what a person does. `stillManual()` is the difference —
 * computed from the plan's own checklist at run time, never transcribed — and
 * `test/unit/hardware-test-numbers.test.ts` holds all three together: no number
 * defined twice, every number the script prints either here or in the plan, and
 * the table in `docs/hardware-test-coverage.md` identical to `automatedTable()`.
 *
 * `partial: true` means the script answers only the machine-readable half and
 * the plan line still needs a person — which is why it stays in `stillManual()`.
 */

/**
 * @typedef {{ command: string, meaning: string, partial?: boolean }} AutomatedLine
 */

/** @type {Readonly<Record<string, AutomatedLine>>} */
export const AUTOMATED = Object.freeze({
  T1: { command: 'restart', meaning: 'the app comes back after a restart and answers its own Web API' },
  T2: { command: 'flows', meaning: 'census of generated Flows, and how many belong to this pass (INFO)' },
  T4: { command: 'restart', meaning: 'it does so after a restart, not only from a cold install' },
  T5: { command: 'pair', meaning: "a Light Remote's setup sees the stored key as valid, so a user is let straight through" },
  T6: { command: 'pair', meaning: 'the light picker offers rooms and lamps, and a remote offers its OWN gestures' },
  T7: { command: 'pair', meaning: 'a Light Remote is built over the API: remote chosen, rules accepted, runtime registered' },
  T8: { command: 'flows', meaning: "each of this pass's Light Remotes owns Flows, and none is switched off" },
  T12: { command: 'pair', meaning: "a light schedule's setup sees the saved key as valid — no retyping" },
  T13: { command: 'pair, schedule', meaning: 'a schedule block is accepted at pairing, and one window is saved and read back' },
  T14: { command: 'schedule', meaning: "both of a window's boundaries fire now, and each writes to its lamps" },
  T15: { command: 'schedule', meaning: 'two overlapping blocks are both KEPT and the clash is reported' },
  T16: { command: 'flows', meaning: "each of this pass's schedules owns Flows, and none is switched off" },
  T17: { command: 'schedule', meaning: 'pausing and resuming a schedule keeps its device available both ways' },
  T18: { command: 'schedule', meaning: "renaming a schedule moves its Flow folder (SKIPPED where the Web API rename cannot reach onRenamed)" },
  T19: { command: 'pair', meaning: 'the circadian driver exposes no credential handler at all' },
  T20: { command: 'pair', meaning: "a circadian light is offered three zones, anchored to today's sun" },
  T21: { command: 'preview', meaning: 'a circadian "Try it now" writes, and every lamp holds what it was written' },
  T22: { command: 'preview', meaning: "the pre-stage probe on an off lamp: stays off, comes on, or is refused — each a result" },
  T23: { command: 'flows', meaning: 'no Flow is attributed to a circadian light' },
  T24: { command: 'rejoin', meaning: 'a circadian lamp switched off and on is written again, and holds the write' },
  T25: { command: 'rejoin', meaning: 'a value set by hand is left alone, and a power cycle ends the override' },
  T26: { command: 'pair', meaning: 'the Colour Curve driver has no credential handler; points with a colour are accepted' },
  T27: { command: 'preview', meaning: 'a Colour Curve "Try it now" writes, and a colour reaches a colour lamp' },
  T28: { command: 'preview', meaning: "every Colour Curve lamp holds what it was written" },
  T29: { command: 'rejoin', meaning: 'a Colour Curve lamp switched off and on is written again, and holds the write' },
  T30: { command: 'flows', meaning: 'no Flow is attributed to a Colour Curve Light' },
  T31: { command: 'restart', meaning: 'the app restarts over the API' },
  T32: { command: 'restart', meaning: 'every Lightkeeper device comes back available (a sleeping remote excused and named)' },
  T33: { command: 'bridge', meaning: "a generated Flow's own action card dispatches, maps and writes to a light" },
  T34: { command: 'restart', meaning: "this pass's curve runtimes are ready and hold a current value after the restart" },
  T35: { command: 'credential', meaning: 'a working API key is saved before the key lines start' },
  T36: { command: 'credential', meaning: 'a nonsense key is refused, and the working key stays and no device degrades' },
  T37: { command: 'credential', meaning: 'with nonsense rejected, a generated Flow still fires' },
  T38: { command: 'credential', meaning: 'removing the key sends Flow owners to needs_credential and deletes no Flow' },
  T39: { command: 'credential', meaning: 'with no key stored at all, a generated Flow still fires' },
  T40: { command: 'credential', meaning: 'the key put back returns every device to ready without a restart' },
  T41: { command: 'credential', meaning: 'circadian and Colour Curve Lights never reach needs_credential' },
  T42: { command: 'redaction', meaning: 'recent remote presses are recorded' },
  T43: { command: 'redaction', meaning: 'recent writes to lights are recorded' },
  T44: { command: 'redaction', meaning: "every schedule's clock has a resolved timezone" },
  T45: { command: 'redaction', meaning: 'the diagnostics report carries no key material, whole or a 12-character slice' },
  T46: { command: 'repair', meaning: "every repair screen comes back seeded with the device's own values" },
  T47: { command: 'teardown', meaning: 'Flow census before any deletion (INFO)' },
  T48: { command: 'teardown', meaning: 'deleting a Colour Curve Light moves no Flow' },
  T49: { command: 'teardown', meaning: 'deleting a circadian light moves no Flow' },
  T50: { command: 'teardown', meaning: 'deleting a schedule removes exactly its own Flows' },
  T51: { command: 'teardown', meaning: 'deleting a Light Remote removes exactly its own Flows' },
  T52: { command: 'teardown', meaning: 'nothing of the deleted devices is left, and nothing of yours has gone' },
  T59: { command: 'memory', meaning: "the app's PSS, against Homey's 30 MB guideline and the 100 MB ceiling" },
  T60: { command: 'full', meaning: 'the same reading at the end of the pass, as a delta' },
  T77: { command: 'pair', meaning: 'a Room-sensing Light is built: no credential handler, its response accepted, runtime registered' },
  T78: { command: 'pair', meaning: 'the geolocation permission resolves: a sun elevation at a location' },
  T79: { command: 'flows', meaning: 'no Flow is attributed to a Room-sensing Light' },
  T80: { command: 'teardown', meaning: 'deleting a Room-sensing Light moves no Flow' },
  T128: { command: 'memory', meaning: "the machine's free memory and swap, printed beside T59" },
  T129: { command: 'memory', meaning: "the app's own heap, per-space split and boot marks", partial: true },
  T130: { command: 'memory', meaning: 'the sandbox still refuses /proc/self/statm' },
  T137: { command: 'settings', meaning: 'every running device can describe itself to the settings page, and the orphan preview has its shape', partial: true },
  T147: { command: 'flowcards', meaning: "each engine's published capability rows agree with its /diagnostics `now`", partial: true },
  T149: { command: 'flowcards', meaning: '`set_lights` "switch them on" brings off lamps on at both chosen values', partial: true },
  T150: { command: 'flowcards', meaning: '`set_lights` "only lights already on" leaves a dark lamp dark; a missing source writes nothing', partial: true },
  T151: { command: 'flowcards', meaning: "`daylight_is_dark` answers against the device's own published level", partial: true },
  T152: { command: 'jobs', meaning: '"On – with Lightkeeper" is offered on a button when a source device exists', partial: true },
  T153: { command: 'jobs', meaning: 'the colour picker offers only curve-driven devices; the brightness picker adds Room-sensing Lights and schedules', partial: true },
  T154: { command: 'jobs', meaning: "the brightness picker's level is the perceptual one the setup screens use, not the device value", partial: true },
  T166: { command: 'control', meaning: 'each review screen offers the right control modes, and a Room-sensing Light refuses "before"', partial: true },
  T167: { command: 'control', meaning: '"Test my lights" answers in time for every lamp and leaves each as it was', partial: true },
  T168: { command: 'control', meaning: 'the lamps the test passed are exactly the ones the running device pre-stages', partial: true },
  T169: { command: 'control', meaning: 'a device that chose pre-staging before the per-lamp test now pre-stages none of its lamps', partial: true },
  T170: { command: 'control', meaning: '"Don\'t change lights automatically" saved: a forced pass writes nothing', partial: true },
  T171: { command: 'control', meaning: "what step 3 says about every sensor, and that the thresholds start from the sensor's week", partial: true },
  T172: { command: 'control', meaning: 'the curve screen is sent 10 featured and 25 folded colours, each with its own hex', partial: true },
  T173: { command: 'control', meaning: '"Test my lights" leaves no running device thinking a person took a lamp' },
  T177: { command: 'repairsave', meaning: 'a repair that SAVES one harmless edit round-trips on every device type, and is put back' },
  T178: { command: 'spike', meaning: 'the installed app is the version this checkout builds, and which build shape it is' },
  T180: { command: 'teardown', meaning: 'with no Flow-owning device live at all, the orphan sweep refuses rather than sweeping everything' },
});

/**
 * Numbers that were used once and are gone, so they are never used again —
 * CLAUDE.md's rule, and the one `hardware-test-numbers.test.ts` enforces by
 * refusing a retired number anywhere in the plan's checklist or in `AUTOMATED`.
 * A number mentioned in either doc must be defined, automated, or here.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const RETIRED = Object.freeze({
  ...range(55, 58, 'the 0.5.0 release lines, retired when 0.5.1 rewrote "This release"'),
  ...range(61, 65, 'the 0.5.1 release lines: the store listing and the flow-card icons'),
  ...range(66, 76, 'the 0.5.1 code-review and 0.5.2 fix lines, retired with their release sections'),
  ...range(81, 90, 'the pre-0.6.0 daylight and pairing-SDK lines, retired by the 0.6.0 rewrite'),
  T117: 'a 0.6.0 pairing line removed before it was ever run',
  T138: 'colour on arrival through the old switch — replaced by T166-T168',
  T140: 'the old one-lamp pre-stage test — replaced by T167',
});

/**
 * @param {number} from @param {number} to @param {string} why
 * @returns {Record<string, string>}
 */
function range(from, to, why) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let n = from; n <= to; n += 1) out[`T${n}`] = why;
  return out;
}

/**
 * @typedef {{ line: string, checked: boolean, title: string }} PlanLine
 */

/**
 * Every checklist line the plan DEFINES, in document order.
 *
 * A definition is a checklist item that opens with its bold number —
 * `- [ ] **T24** …` or `- [x] **T98** …`. A number mentioned in prose ("T24 and
 * T29 are asking…") is a reference, not a definition, and is ignored.
 *
 * @param {string} markdown
 * @returns {PlanLine[]}
 */
export function planDefinitions(markdown) {
  /** @type {PlanLine[]} */
  const found = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const pattern = /^\s*- \[( |x|X)\] \*\*(T\d+)\*\*[ \t]*(.*)$/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index] ?? '');
    if (!match) continue;
    // An item wraps onto indented lines; the title may run onto them.
    let text = String(match[3] ?? '');
    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = lines[next] ?? '';
      if (!/^\s+\S/.test(continuation) || /^\s*- \[/.test(continuation)) break;
      text += ` ${continuation.trim()}`;
    }
    found.push({
      line: String(match[2]),
      checked: String(match[1]).toLowerCase() === 'x',
      title: titleOf(text),
    });
  }
  return found;
}

/**
 * A plan line's first sentence, short enough for one terminal line.
 *
 * @param {string} text the rest of the checklist line after its number
 */
export function titleOf(text) {
  const plain = text.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.*?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 90 ? `${sentence.slice(0, 87).trimEnd()}...` : sentence;
}

/**
 * The plan's lines a person still has to do: every UNCHECKED definition the
 * script does not answer, or answers only in part.
 *
 * A ticked line is left out — it was run, and the plan's run record says when.
 *
 * @param {string} markdown the plan
 * @param {Readonly<Record<string, AutomatedLine>>} [automated]
 * @returns {Array<PlanLine & { partial: boolean }>}
 */
export function stillManual(markdown, automated = AUTOMATED) {
  return planDefinitions(markdown)
    .filter(line => !line.checked)
    .filter(line => !automated[line.line] || automated[line.line]?.partial === true)
    .map(line => ({ ...line, partial: automated[line.line]?.partial === true }));
}

/** Numeric order, so T9 sorts before T10. */
/** @param {string} a @param {string} b */
export function byLineNumber(a, b) {
  return Number(a.slice(1)) - Number(b.slice(1));
}

/**
 * `AUTOMATED` as the markdown table `docs/hardware-test-coverage.md` carries
 * between its `automated-lines` markers. The test compares the two, so a line
 * added here and not there fails with this exact text to paste.
 *
 * @param {Readonly<Record<string, AutomatedLine>>} [automated]
 */
export function automatedTable(automated = AUTOMATED) {
  const rows = Object.keys(automated).sort(byLineNumber).map((line) => {
    const entry = /** @type {AutomatedLine} */ (automated[line]);
    return `| ${line} | \`${entry.command}\` | ${entry.meaning.replace(/\|/g, '\\|')} | ${entry.partial ? 'part — the plan line still needs a person' : 'yes'} |`;
  });
  return ['| Line | Command | What it asserts | Whole line? |', '|---|---|---|---|', ...rows].join('\n');
}

/** The markers the table sits between in the coverage doc. */
export const TABLE_START = '<!-- automated-lines:start -->';
export const TABLE_END = '<!-- automated-lines:end -->';

/**
 * Every `Tn` a document MENTIONS, ranges expanded — `T42–T45` and `T9-T11`
 * both — so a reference to a number nothing defines can be caught.
 *
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function mentionedLines(markdown) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const match of markdown.matchAll(/\bT(\d+)(?:\s*(?:-|–|&ndash;)\s*T?(\d+))?/g)) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    // A range longer than this is prose ("T1 to T200") rather than a list.
    for (let n = from; n <= to && n - from < 60; n += 1) found.add(`T${n}`);
  }
  return found;
}

/**
 * Every quoted `'Tn'` in a script's CODE — comments stripped, so a docblock
 * mentioning a line is not mistaken for reporting it.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function reportedLines(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return new Set([...code.matchAll(/'(T\d+)'/g)].map(match => String(match[1])));
}
