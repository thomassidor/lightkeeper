/**
 * Every light on a real Homey, pushed until it misbehaves.
 *
 * WHY THIS EXISTS
 *
 * This app adapts to a light on exactly two pieces of evidence: which
 * capabilities it has, and the metadata it declares for them (`min`, `max`,
 * `decimals`). There is no per-vendor strategy anywhere in the output path —
 * nothing in `lib/outputs/` or `lib/circadian/` reads `driverId`, a model or a
 * firmware version. Every behavioural fact underneath that design was
 * established against one Homey and a handful of lamps, and written down in
 * `docs/homey-platform.md` §6 and §12.
 *
 * Several of those facts are thin, and the app has hard thresholds standing on
 * them. `OVERRIDE_TOLERANCE` is 0.03, and a lamp whose report lands further than
 * that from our own write is treated as a human override and DROPPED from its
 * curve until it is power-cycled — while §6 measured real quantisation of ~0.1
 * and `verify-hardware.mjs` allows exactly that. Whether a temperature write
 * turns an off lamp on is recorded as untested. Whether a colour-only lamp
 * exists in this house is unknown, and on an all-temperature curve one would be
 * written nothing, silently, every minute.
 *
 * So this walks the lights and reports FINDINGS: for each one, which assumption
 * it violates, at which `file:line`, with the measurement behind it. It draws no
 * conclusions beyond that — it does not propose a strategy, and it does not say
 * the app is broken.
 *
 * WHAT IT DOES TO YOUR LIGHTS
 *
 * It writes to lamps you paired yourself — there is no way to probe a lamp
 * without writing to it, and unlike `verify-hardware.mjs` it cannot confine
 * itself to devices it created. So: one lamp at a time, snapshot first, restored
 * and VERIFIED before the next lamp is touched; power transitions grouped so a
 * room is never blinked twice; and the configured room as the default scope,
 * with `--all` for the whole house. A lamp goes dark for about twenty seconds
 * during its off-phase.
 *
 * WHAT IT CANNOT ANSWER
 *
 *   - Whether a high `light_temperature` is physically WARMER on a given lamp.
 *     There is no colorimeter here. It can prove the axis is monotone, that the
 *     reported value is not the inverse of the written one, what the effective
 *     range is and how coarse it is — a driver that maps the axis backwards
 *     consistently is invisible to any amount of API traffic. `eyes` asks a
 *     person instead, once per integration.
 *   - Anything about perception: whether the perceptual curve feels linear,
 *     whether `MINIMUM_BRIGHTNESS` looks lit, whether a ramp feels smooth. Only
 *     that values land, are distinct, and that the lamp did not switch itself
 *     off.
 *   - Whether a lamp is physically on. It reads `onoff`; a lamp behind a cut wall
 *     switch reports whatever its integration believes.
 *   - Time-to-light. It measures API ack and echo arrival, which include bridge
 *     and LAN and exclude radio and the bulb's own fade.
 *   - Anything upstream of the write — button events, Flow dispatch, the dropped
 *     release events the ramp's hard stop exists for. `stress` reproduces the
 *     CADENCE the ramp engine produces; it does not run the engine and does not
 *     go through `CommandScheduler`, so a cadence finding is a fact about the
 *     lamp, not proof the app misbehaves. The coalescer may well mask it.
 *   - Whether a quirk is stable (one run is one sample — see `--repeat`), whether
 *     it is per-lamp or per-integration (only a corpus can suggest that; the
 *     report groups by `driverId` and stops there), or WHY: mesh routing,
 *     channel congestion and a bridge queue are one number from here.
 *
 * CONFIGURATION
 *
 * `HOMEY_ADDRESS` and `HOMEY_API_KEY`, or `scripts/hardware-env.json` (gitignored)
 * as `{ "address": "http://192.168.1.23", "key": "...", "room": "Office" }`.
 * `HOMEY_TEST_ROOM` / `room` is the default scope. ONE key, and it must not be
 * the key the app holds — a key holds a single live session (platform §2), so
 * sharing one evicts the app while this runs.
 *
 * The app does not need to be installed. This probes lamps, not Lightkeeper.
 *
 * USAGE
 *
 *   node scripts/probe-lights.mjs                      # inventory, read-only
 *   node scripts/probe-lights.mjs plan --all           # what a full run would do
 *   node scripts/probe-lights.mjs full --yes           # the battery, configured room
 *   node scripts/probe-lights.mjs full --yes --all     # the battery, whole house
 *   node scripts/probe-lights.mjs full --yes --quick --all      # one lamp per driver
 *   node scripts/probe-lights.mjs axes modes --yes --light "Desk lamp"
 *   node scripts/probe-lights.mjs eyes --yes --all     # the one question a machine cannot ask
 *
 * Reports land in `.probe/` (gitignored): the raw one, and a redacted sibling
 * with every device name, zone name, address and wall-clock time removed.
 *
 * EXIT CODES
 *
 * 0 it ran and every restore verified. 1 a restore failed, or the probe itself
 * failed — in either case a person has to look. 2 bad arguments or missing
 * configuration. FINDINGS NEVER FAIL THE RUN: they are the product, not errors.
 * `--fail-on <severity>` for anyone who wants otherwise.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// homey-api ships JS with JSDoc rather than type declarations, so everything it
// returns is `any` here for the same reason it is `any` in the app.
const { HomeyAPI } = /** @type {any} */ (require('homey-api'));

const APP_ID = 'com.thomassidor.lightkeeper';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/**
 * Every capability the app can write (`lib/outputs/intent-planner.ts Capability`), in the
 * order the scheduler sends them (`lib/outputs/command-scheduler.ts WRITE_ORDER`).
 *
 * The order matters to this script twice: it is what `modes` reproduces, and it
 * is the order a restore has to follow.
 */
export const WRITE_ORDER = /** @type {const} */ ([
  'onoff', 'dim', 'light_mode', 'light_temperature', 'light_hue', 'light_saturation',
]);

/** The five the app ever READS. `light_mode`'s value is read nowhere in the app. */
const READABLE = /** @type {const} */ ([
  'onoff', 'dim', 'light_temperature', 'light_hue', 'light_saturation',
]);

/**
 * Capabilities whose round trip is not the app's promise.
 *
 * `light_mode` is written to make a value land, not as a value in itself. A lamp
 * may keep reporting `color` while accepting the temperature that follows —
 * observed on this Homey — and failing on that would report a working write as
 * broken. Copied from `verify-hardware.mjs` for the same reason it exists there.
 */
const ENABLER_CAPABILITIES = new Set(['light_mode']);

/**
 * Every constant a finding is judged against, in one place and echoed into the
 * report.
 *
 * Not a configuration block: these are the app's own numbers, transcribed with
 * the file that owns each one. A report saying "0.080 exceeds 0.03" is only
 * re-readable in six months if it also says which 0.03 that was, and a threshold
 * that moves in the app must move here too or the corpus quietly starts
 * comparing new lamps against old history.
 */
export const THRESHOLDS = {
  /** lib/outputs/light-intent.ts GAMMA — the perceptual curve's exponent. */
  GAMMA: 2.2,
  /** lib/outputs/light-intent.ts MINIMUM_BRIGHTNESS — the floor the brightness sliders start at. */
  MINIMUM_BRIGHTNESS: 0.1,
  /** lib/outputs/target-state-cache.ts ECHO_DEDUPE_MS — how long a duplicate echo stays a duplicate. */
  ECHO_DEDUPE_MS: 1500,
  /** lib/outputs/target-state-cache.ts OVERRIDE_SETTLE_MS — after this, a report is somebody else's. */
  SETTLE_MS: 3000,
  /** lib/outputs/target-state-cache.ts OVERRIDE_TOLERANCE — further than this and the lamp is dropped. */
  OVERRIDE_TOLERANCE: 0.03,
  /** lib/circadian/circadian-runtime.ts COLOR_STEP — the colour deadband, fixed because hue has no decimals. */
  COLOR_STEP: 0.03,
  /** lib/circadian/palette.ts HUE_FLOOR — how close to white the palette will go. */
  HUE_FLOOR: 0.02,
  /** scripts/verify-hardware.mjs LAMP_TOLERANCE — what the hardware pass calls a landed write. */
  LAMP_TOLERANCE: 0.1,
  /** lib/mapping/mapping-types.ts DEFAULT_BEHAVIOR — the scheduler's default floor between flushes. */
  MIN_WRITE_INTERVAL_MS: 200,
  /** lib/outputs/ramp-engine.ts TICK_MS — how often the ramp emits an intent. */
  RAMP_TICK_MS: 100,
  /** lib/outputs/ramp-engine.ts DEFAULT_RATE_PER_SECOND — perceptual units per second. */
  RAMP_RATE_PER_SECOND: 0.6,
  /** lib/outputs/ramp-engine.ts HARD_STOP_MS — and it is not configurable. */
  HARD_STOP_MS: 10_000,
  /** lib/circadian/circadian-runtime.ts PRE_STAGE_CHECK_MS — how long pre-staging waits before believing. */
  PRE_STAGE_CHECK_MS: 1500,
};

/** Thresholds this script owns, rather than transcribes. */
const PROBE = {
  /** A read this slow is worth reporting on its own. */
  SLOW_READ_MS: 1500,
  /** An ack this slow means the write leg is not the fast part. */
  SLOW_ACK_MS: 1000,
  /** Between ladder rungs. Far above the app's cadence: this is the measurement. */
  LADDER_GAP_MS: 2500,
  /** How long a settling read may poll for. */
  SETTLE_WINDOW_MS: 6_000,
  /** How long to listen for unsolicited callbacks before touching a lamp. */
  QUIET_WINDOW_MS: 3_000,
  /** How long to wait for the first echo after a write. */
  ECHO_WINDOW_MS: 5_000,
  /** After the stress step, before the next lamp — a bridge is shared. */
  COOLDOWN_MS: 5_000,
  /** Between lamps. */
  BETWEEN_LIGHTS_MS: 2_000,
  /** A restore is close enough at this, or at the lamp's measured quantisation. */
  RESTORE_TOLERANCE: 0.02,
  /** Per read, per write, per light. */
  READ_TIMEOUT_MS: 8_000,
  WRITE_TIMEOUT_MS: 10_000,
  LIGHT_BUDGET_MS: 6 * 60_000,
  /** How long every outstanding restore gets, in total, when a signal arrives. */
  PANIC_BUDGET_MS: 15_000,
};

// ---------------------------------------------------------------- reporting

/**
 * Steps have statuses; lights have findings. Two layers, deliberately separate.
 *
 * `results` is the step log, and `report()` is `verify-hardware.mjs`'s printer
 * unchanged — so `N OK, N failed, N skipped` still means what it means there,
 * and a step id sits in the column a test-plan line sits in.
 *
 * A finding is not a step outcome. It happens zero-or-many times per lamp, it
 * has to stay a stable key across releases (a quirks table would key on
 * `(driverId, code)`), and it is the PRODUCT of the run rather than an error in
 * it — so it gets its own printer, its own summary and its own namespace.
 *
 * @type {Array<{ line: string, status: string, detail: string }>}
 */
const results = [];

/**
 * One line of the report. `line` is a step id — `P5c` — or `-` for something no
 * step owns.
 *
 * @param {string} line
 * @param {'OK'|'FAILED'|'SKIPPED'|'INFO'} status
 * @param {string} detail
 */
function report(line, status, detail) {
  results.push({ line, status, detail });
  const label = line === '-' ? '    ' : line.padEnd(4);
  console.log(`${label} ${status.padEnd(7)} ${detail}`);
}

/**
 * Progress that is not a result. Kept out of the report.
 *
 * @param {string} message
 */
function note(message) {
  console.log(`          ${message}`);
}

// ----------------------------------------------------------------- findings

/** @typedef {'critical'|'high'|'medium'|'low'|'info'} Severity */

/** In the order a summary should list them. */
const SEVERITIES = /** @type {Severity[]} */ (['critical', 'high', 'medium', 'low', 'info']);

/**
 * Every finding this script can emit, its severity, and the assumption it
 * violates.
 *
 * `assumption` is mandatory and cites `path:line` or `platform §n`, and
 * `test/unit/probe-findings.test.ts` fails if one is missing or unparseable.
 * That is the whole mechanism keeping this output actionable: a finding that
 * cannot name what it breaks is trivia, and a corpus of trivia is worse than no
 * corpus, because somebody will act on it.
 *
 * Severity is a property of the CODE — see `severityOf()` for the one thing that
 * escalates it, which is measured magnitude and nothing else. The ladder:
 *
 *   critical  the app drives this light wrong and cannot notice
 *   high      the app silently degrades or drops this light in a documented mode
 *   medium    a user-visible oddity with a bounded blast radius
 *   low       metadata inconsistency with no current consequence
 *   info      measurement for the corpus, no verdict
 *
 * @type {Record<string, { severity: Severity, title: string, assumption: string }>}
 */
export const FINDINGS = {
  // ---- P1, what the lamp claims about itself

  META_DIM_RANGE_NOT_UNIT: {
    severity: 'critical',
    title: 'dim declares a range that is not 0-1',
    assumption: 'lib/outputs/target-state-cache.ts commitDesired() — commitDesired puts desired dim through '
      + 'clamp01 whatever the lamp declares, so a lamp on a 0-100 scale is written ~0.4% of its '
      + 'range and its cached state is corrupted. lib/outputs/intent-planner.ts clampDim() clamps to the '
      + 'declared range on the way out, so the two disagree.',
  },
  META_TEMP_RANGE_NOT_UNIT: {
    severity: 'critical',
    title: 'light_temperature declares a range that is not 0-1',
    assumption: 'lib/outputs/target-state-cache.ts commitDesired() — as above, and platform §6 records the '
      + 'axis as normalised 0-1 rather than mireds or kelvin.',
  },
  META_HUE_RANGE_DECLARED: {
    severity: 'medium',
    title: 'hue or saturation declares a range that is not 0-1',
    assumption: 'lib/outputs/intent-planner.ts planColor() — planColor writes clamp01(hue) and never '
      + 'clampToRange, unlike dim and light_temperature: the declared range is read into the cache '
      + 'and then dropped. A declared 0-1 is what clamp01 does anyway and is NOT reported — every '
      + 'colour bulb on this Homey declares it, and reporting the sane case buried the real one.',
  },
  META_DECIMALS_COARSE: {
    severity: 'high',
    title: 'a capability declares fewer than 2 decimals',
    assumption: 'lib/outputs/target-state-cache.ts OVERRIDE_TOLERANCE — the circadian temperature deadband IS '
      + 'the lamp\'s own decimals, so at decimals:1 the deadband (0.1) is larger than '
      + 'OVERRIDE_TOLERANCE (0.03): the lamp is written rarely, and dropped from the curve when '
      + 'it is.',
  },
  META_NO_DECIMALS_TEMP: {
    severity: 'medium',
    title: 'light_temperature declares no decimals',
    assumption: 'lib/circadian/circadian-runtime.ts stepFor() — with no declared resolution the write '
      + 'deadband falls back to 0.01, which is a guess rather than the lamp\'s step.',
  },
  META_STEP_DECLARED: {
    severity: 'low',
    title: 'a capability declares a step nothing honours',
    assumption: 'lib/device-catalog.ts CatalogCapability — step is captured and no code path quantises to it, so '
      + 'a lamp with step 0.05 is written values it cannot represent.',
  },
  META_UNITS_UNEXPECTED: {
    severity: 'low',
    title: 'a capability declares units the app never reads',
    assumption: 'lib/device-catalog.ts CatalogCapability — units is captured and consumed nowhere. Harmless '
      + 'alone; next to a non-unit range it is the smell that precedes '
      + 'META_DIM_RANGE_NOT_UNIT.',
  },
  META_SETABLE_FALSE: {
    severity: 'critical',
    title: 'a capability the app writes reports setable: false',
    assumption: 'lib/outputs/light-target-adapter.ts write() — setable is read nowhere in this repo, '
      + 'so the app will write this capability forever and log every rejection.',
  },
  META_GETABLE_FALSE: {
    severity: 'high',
    title: 'a capability the app reads reports getable: false',
    assumption: 'lib/outputs/light-target-adapter.ts refresh() — getable is read nowhere, so refresh() '
      + 'and every override check on this lamp are reading a value it does not promise.',
  },
  META_COLOR_ONLY: {
    severity: 'high',
    title: 'colour-capable with no light_temperature',
    assumption: 'lib/circadian/circadian-runtime.ts planWrites() — on an all-temperature curve this lamp '
      + 'falls into the temperature-only branch, the missing write is skipped, and NOTHING is '
      + 'written to it, silently, on every 60s tick. Only noticed at device level if every '
      + 'target is like this.',
  },
  META_DUAL_MODE_NO_LIGHT_MODE: {
    severity: 'high',
    title: 'both colour and temperature, but no light_mode',
    assumption: 'lib/outputs/intent-planner.ts planTemperature() — the mode write is emitted only where '
      + 'light_mode is supported, so on this lamp the app can never switch mode and platform §6\'s '
      + 'cross-mode discard would be unrecoverable.',
  },
  META_MODE_ENUM_UNEXPECTED: {
    severity: 'medium',
    title: 'light_mode offers values other than color and temperature',
    assumption: 'lib/outputs/intent-planner.ts planTemperature() — the app writes the literals color and '
      + 'temperature. A different spelling means every mode write is ignored or rejected.',
  },
  META_HUE_NO_SAT: {
    severity: 'low',
    title: 'light_hue without light_saturation',
    assumption: 'lib/outputs/intent-planner.ts planColor() — the app tolerates this shape and skips the '
      + 'saturation write. Recorded to establish whether it exists in the wild at all.',
  },
  META_ONOFF_HAS_OPTIONS: {
    severity: 'low',
    title: 'onoff reports capability options',
    assumption: 'platform §6 — the options table records onoff as {}, with no min, max or step.',
  },
  META_NOT_A_LIGHT: {
    severity: 'info',
    title: 'has onoff but is not class light',
    assumption: 'lib/device-catalog.ts lightCandidates() — a light IS a device with onoff, so every socket, fan '
      + 'and kettle in the house is offered in the target picker.',
  },

  // ---- P2, reading it twice

  READ_UNSTABLE: {
    severity: 'medium',
    title: 'a value moved with no write from us',
    assumption: 'lib/circadian/circadian-runtime.ts onCapabilityChange() — a change the app did not write is an '
      + 'external override. Something else is driving this lamp, so every measurement below it '
      + 'would be a lie; the probe stops writing to it.',
  },
  READ_NULL: {
    severity: 'medium',
    title: 'a listed capability reports no value',
    assumption: 'lib/outputs/target-resolver.ts primeCache() — primeCache reads the value straight out of '
      + 'capabilitiesObj, so a null primes undefined and the first plan works from a fallback '
      + 'rather than from the lamp.',
  },
  READ_SLOW: {
    severity: 'low',
    title: 'reading this lamp is slow',
    assumption: 'lib/schedules/schedule-runtime.ts apply() — a schedule refreshes before it acts, so '
      + 'a slow read delays the write it gates.',
  },

  // ---- P3 and P5a, echoes

  ECHO_NONE: {
    severity: 'high',
    title: 'a subscribed capability never called back',
    assumption: 'lib/outputs/light-target-adapter.ts subscribe() — external changes reconcile into desired '
      + 'state through capability instances. With no echoes at all, every reconciliation on this '
      + 'lamp is blind and a wall switch is invisible.',
  },
  ECHO_LATE: {
    severity: 'medium',
    title: 'the echo of our own write arrived after the dedupe window',
    assumption: 'lib/outputs/target-state-cache.ts ECHO_DEDUPE_MS — a duplicate is only a duplicate inside '
      + 'ECHO_DEDUPE_MS (1500ms). Later than that and our own echo reads as somebody else; later '
      + 'than SETTLE_MS (3000ms) and a curve drops the lamp on the strength of it.',
  },
  ECHO_ACK_SLOW: {
    severity: 'medium',
    title: 'setCapabilityValue took a long time to ack',
    assumption: 'platform §6 — a write to a Hue Bridge light acks in roughly 275ms. An ack an '
      + 'order of magnitude slower than that is a queue we cannot see from here.',
  },
  ECHO_CHATTY: {
    severity: 'medium',
    title: 'the lamp reports values nobody asked for',
    assumption: 'lib/outputs/target-state-cache.ts applyExternalChange() — any value different from the last one '
      + 'written is external, which overwrites desired state. A lamp that volunteers values trips '
      + 'that by itself.',
  },
  ECHO_COUNT: {
    severity: 'info',
    title: 'how many echoes one write produced',
    assumption: 'platform §6 — "echoes arrive duplicated. Setting dim once produces two identical '
      + 'callbacks." This probe holds ONE subscription per capability, where the app can hold two, '
      + 'so this is the measurement that can confirm or overturn that note.',
  },

  // ---- P4, writing to an off lamp

  OFF_STAGED: {
    severity: 'info',
    title: 'the lamp took a value while off and stayed off',
    assumption: 'lib/circadian/circadian-runtime.ts verifyStayedOff() — this is the outcome pre-staging needs, '
      + 'and it is opt-in precisely because it cannot be assumed.',
  },
  OFF_DIM_TURNS_ON: {
    severity: 'medium',
    title: 'a dim write turned the lamp on',
    assumption: 'lib/outputs/intent-planner.ts PlannedWrite.impliesOn — this is impliesOn\'s premise, measured on a '
      + 'Hue lamp: the separate onoff write is skipped because dim carries it.',
  },
  OFF_DIM_STAYS_OFF: {
    severity: 'high',
    title: 'a dim write did NOT turn the lamp on',
    assumption: 'lib/outputs/light-target-adapter.ts verifyCameOn() — impliesOn assumes it did, so the 1500ms '
      + 'probe fires and sends a corrective onoff: two writes and a second and a half of delay '
      + 'where the app expected one write.',
  },
  OFF_TEMP_TURNS_ON: {
    severity: 'high',
    title: 'a light_temperature write turned the lamp on',
    assumption: 'platform §12 — recorded there as per-integration and UNTESTED. If it holds, a '
      + 'temperature change can implicitly light a dark room, which is the promise the planner '
      + 'keeps by never sending one to an off lamp.',
  },
  OFF_COLOR_TURNS_ON: {
    severity: 'high',
    title: 'a colour write turned the lamp on',
    assumption: 'lib/circadian/circadian-runtime.ts verifyStayedOff() — verifyStayedOff exists for this, and '
      + 'disables pre-staging for the whole device when it happens.',
  },
  OFF_WRITE_DECLINED: {
    severity: 'medium',
    title: 'the integration refused the write outright',
    assumption: 'platform §6 — the third outcome: a Hue Bridge answers that the light is soft off '
      + 'and the command may not have effect. It means what "it came on" means, and probePreStage '
      + 'reports it rather than throwing.',
  },
  OFF_WRITE_SWALLOWED: {
    severity: 'high',
    title: 'the write was accepted, the lamp stayed off, and nothing landed',
    assumption: 'lib/outputs/light-target-adapter.ts write() — commitDesired runs on ok:true, so the '
      + 'app now believes a value the lamp never took and plans its next relative step from it.',
  },
  OFF_NOOP_ECHOES: {
    severity: 'info',
    title: 'writing a value the lamp already holds still produced an echo',
    assumption: 'lib/outputs/target-state-cache.ts applyExternalChange() — the dedupe covers an exact repeat inside '
      + '1500ms, and nothing else.',
  },

  // ---- P5b/P5c/P5e, the ladders

  DIM_SCALE_MISMATCH: {
    severity: 'critical',
    title: 'dim reports on a different scale from the one it accepts',
    assumption: 'lib/outputs/target-state-cache.ts commitDesired() — desired state is clamp01\'d, so a lamp '
      + 'reporting 50 for a written 0.5 makes every subsequent relative step nonsense.',
  },
  TEMP_SCALE_MISMATCH: {
    severity: 'critical',
    title: 'light_temperature reports on a different scale from the one it accepts',
    assumption: 'lib/outputs/target-state-cache.ts commitDesired() — as above.',
  },
  DIM_REPORT_INVERTED: {
    severity: 'critical',
    title: 'dim reports roughly the inverse of what was written',
    assumption: 'lib/outputs/light-intent.ts applyPerceptualDelta() — advanceDim reads the current device value and '
      + 'adds to it, so an inverted report walks a relative step the wrong way.',
  },
  TEMP_REPORT_INVERTED: {
    severity: 'critical',
    title: 'light_temperature reports roughly the inverse of what was written',
    assumption: 'platform §6 — higher is warmer on this axis, and the whole controller mapping, '
      + 'the schedule labels and the curve\'s direction go that way. An inverted report is the one '
      + 'half of a backwards driver a machine CAN see.',
  },
  DIM_QUANT_OVER_TOLERANCE: {
    severity: 'high',
    title: 'dim quantises by more than OVERRIDE_TOLERANCE',
    assumption: 'lib/outputs/target-state-cache.ts OVERRIDE_TOLERANCE — a report further than 0.03 from our own '
      + 'write, arriving after SETTLE_MS, is treated as a human override and the lamp is dropped '
      + 'from the curve until it is power-cycled.',
  },
  TEMP_QUANT_OVER_TOLERANCE: {
    severity: 'high',
    title: 'light_temperature quantises by more than OVERRIDE_TOLERANCE',
    assumption: 'lib/outputs/target-state-cache.ts OVERRIDE_TOLERANCE — as above. platform §6 measured 0.930 '
      + 'written and 0.850 held on real hardware, which is nearly three times this tolerance, so '
      + 'the two numbers have never agreed.',
  },
  COLOR_QUANT_OVER_STEP: {
    severity: 'high',
    title: 'hue quantises by more than COLOR_STEP',
    assumption: 'lib/circadian/circadian-runtime.ts COLOR_STEP — light_hue carries no decimals in '
      + 'homey-lib, so both the colour write deadband and the override tolerance are FIXED at 0.03 '
      + 'with no per-lamp fallback. A coarser lamp reads each of our writes as a human.',
  },
  DIM_QUANT_OVER_LAMP_TOLERANCE: {
    severity: 'critical',
    title: 'dim quantises by more than the hardware pass allows',
    assumption: 'scripts/verify-hardware.mjs LAMP_TOLERANCE — LAMP_TOLERANCE is 0.1, chosen to be well above '
      + 'observed quantisation and well below a discarded write. Past it, the pass cannot tell a '
      + 'landed write from a thrown-away one on this lamp.',
  },
  TEMP_QUANT_OVER_LAMP_TOLERANCE: {
    severity: 'critical',
    title: 'light_temperature quantises by more than the hardware pass allows',
    assumption: 'scripts/verify-hardware.mjs LAMP_TOLERANCE — as above.',
  },
  DIM_UNDECLARED_FLOOR: {
    severity: 'medium',
    title: 'dim will not go as low as it says it will',
    assumption: 'lib/outputs/intent-planner.ts clampDim() — clampToRange trusts the declared min, so the '
      + 'bottom of every brightness slider on this lamp is a value it silently refuses.',
  },
  DIM_UNDECLARED_CEILING: {
    severity: 'medium',
    title: 'dim will not go as high as it says it will',
    assumption: 'lib/outputs/intent-planner.ts clampDim() — as above, at the other end.',
  },
  TEMP_UNDECLARED_RANGE: {
    severity: 'medium',
    title: 'light_temperature has a narrower effective range than it declares',
    assumption: 'platform §6 — measured: 0.930 written, 0.850 held on a bulb at its warm ceiling. '
      + 'The effective ends are what a curve actually reaches, and '
      + 'lib/circadian/circadian-curve.ts valueAt() plans against the declared ones.',
  },
  DIM_NON_MONOTONIC: {
    severity: 'high',
    title: 'a rising dim ladder did not report rising values',
    assumption: 'lib/outputs/light-intent.ts applyPerceptualDelta() — every relative step assumes the axis is '
      + 'ordered. A ramp on this lamp cannot be reasoned about at all.',
  },
  TEMP_NON_MONOTONIC: {
    severity: 'high',
    title: 'a rising temperature ladder did not report rising values',
    assumption: 'lib/circadian/circadian-curve.ts CurveValue — the curve interpolates along this axis, so '
      + 'a non-monotone one makes every intermediate point unpredictable.',
  },
  DIM_DECIMALS_LIE: {
    severity: 'medium',
    title: 'dim resolves to a different step from the one it declares',
    assumption: 'lib/outputs/light-intent.ts quantise() — quantise() rounds to the declared decimals, so a '
      + 'coarser lamp turns distinct requests into one value and a finer one wastes resolution the '
      + 'app has already thrown away.',
  },
  TEMP_COLLAPSED: {
    severity: 'high',
    title: 'a seven-rung temperature ladder held three or fewer distinct values',
    assumption: 'lib/circadian/circadian-runtime.ts stepFor() — the write gate is the declared '
      + 'resolution, so the app believes it is moving this lamp smoothly while the lamp is moving '
      + 'in visible jumps.',
  },
  DIM_MIN_GOES_DARK: {
    severity: 'high',
    title: 'the app\'s minimum brightness switches this lamp off',
    assumption: 'lib/outputs/light-intent.ts MINIMUM_BRIGHTNESS — MINIMUM_BRIGHTNESS is 0.1 perceptual, and '
      + 'litDim() exists to guarantee a positive request stays lit. On this lamp the value it '
      + 'writes reports the light off.',
  },
  COLOR_HUE_CLAMPED_TO_DECLARED: {
    severity: 'medium',
    title: 'the lamp enforces a hue sub-range',
    assumption: 'lib/outputs/intent-planner.ts planColor() — planColor ignores the declared hue range, so '
      + 'a palette colour outside it is silently replaced by the lamp with something else.',
  },
  COLOR_WRAP_CLAMPED: {
    severity: 'medium',
    title: 'hue near 1.0 was clamped rather than wrapped',
    assumption: 'lib/circadian/palette.ts mixColors() — the palette blends across the colour disc and '
      + 'compares hue the short way round, which assumes the axis is a wheel.',
  },
  COLOR_SAT_FLOOR: {
    severity: 'info',
    title: 'the lamp will not go as unsaturated as asked',
    assumption: 'lib/circadian/palette.ts HUE_FLOOR — HUE_FLOOR keeps the palette off white; where the '
      + 'lamp has its own floor the two interact.',
  },
  COLOR_GAMUT_SNAP: {
    severity: 'info',
    title: 'the reported colour is not the one written',
    assumption: 'lib/circadian/palette.ts mixColors() — a blended palette colour assumes the disc is '
      + 'reachable. Quantified rather than judged: a gamut is a physical fact about the lamp.',
  },

  // ---- P5d, the mode gate

  MODE_GATES_TEMP: {
    severity: 'high',
    title: 'a temperature written without a mode switch was discarded',
    assumption: 'platform §6 — measured: written 0.430, held 0.870, and the lamp refused a '
      + 'temperature from anything until its mode changed. This confirms it on this lamp.',
  },
  MODE_GATES_HUE: {
    severity: 'high',
    title: 'a hue written without a mode switch was discarded',
    assumption: 'platform §6 — the mirror of the same gate, which is why planColor emits '
      + 'light_mode first.',
  },
  MODE_DOES_NOT_GATE: {
    severity: 'info',
    title: 'a value landed with no mode switch at all',
    assumption: 'platform §6 — the discard is stated as universal. Where it does not hold, the '
      + 'mode write is a no-op rather than a fix, which is worth knowing before anything is built '
      + 'on it.',
  },
  MODE_NEEDS_DELAY: {
    severity: 'high',
    title: 'the value landed only when a gap followed the mode write',
    assumption: 'lib/outputs/command-scheduler.ts runFlush() — runFlush awaits light_mode and the value '
      + 'it enables back-to-back with no gap between them. If this lamp needs one, the app\'s '
      + 'flush is too fast for this integration and the value is thrown away.',
  },
  MODE_IMPLICIT_SWITCH: {
    severity: 'medium',
    title: 'writing a value changed the reported mode by itself',
    assumption: 'lib/outputs/target-state-cache.ts applyExternalChange() — light_mode has no desired state, so a '
      + 'mode change is always reported external. Harmless in the app; it is why a restore here '
      + 'has to be mode-aware.',
  },
  MODE_NOT_REPORTED: {
    severity: 'info',
    title: 'the lamp kept reporting the old mode while accepting the new value',
    assumption: 'scripts/verify-hardware.mjs ENABLER_CAPABILITIES — the reason light_mode is an enabler rather than '
      + 'a value: asserting on its round trip reports a working write as broken.',
  },

  // ---- P5g, cadence

  RATE_ERRORS: {
    severity: 'critical',
    title: 'writes failed at the scheduler\'s default cadence',
    assumption: 'lib/mapping/mapping-types.ts DEFAULT_BEHAVIOR — minWriteIntervalMs defaults to 200ms and a ramp '
      + 'sustains that for ten seconds. If this integration cannot take it, every ramp on this lamp '
      + 'is partly dropped.',
  },
  RATE_LATENCY_INFLATION: {
    severity: 'high',
    title: 'ack latency grew through the burst',
    assumption: 'lib/outputs/command-scheduler.ts schedule() — the rate limit is leading-edge and assumes '
      + 'each write completes in time. Growing latency is a queue building somewhere the app cannot '
      + 'see, and the coalescer cannot drain what it does not know about.',
  },
  RATE_FINAL_VALUE_WRONG: {
    severity: 'high',
    title: 'after the burst the lamp did not hold the last value written',
    assumption: 'lib/outputs/command-scheduler.ts submit() — latest-wins is the whole premise of the '
      + 'per-capability coalescer, and lib/outputs/command-scheduler.ts runFlush() guarantees a final '
      + 'write for exactly this reason. On this lamp the guarantee does not reach the glass.',
  },
  RATE_ECHO_MIDFLIGHT: {
    severity: 'high',
    title: 'an intermediate value echoed back far from our latest write',
    assumption: 'lib/outputs/ramp-engine.ts stopAllExcept() — an external change cancels a ramp, and '
      + 'lib/outputs/target-state-cache.ts OVERRIDE_TOLERANCE drops the lamp from a curve. This is precisely the '
      + 'shape of a ramp that cancels itself.',
  },
  RATE_ECHO_STORM: {
    severity: 'medium',
    title: 'the burst produced far more echoes than writes',
    assumption: 'lib/outputs/target-state-cache.ts applyExternalChange() — every echo runs applyExternalChange. Fifty '
      + 'writes at two echoes each is a hundred passes through the dedupe in ten seconds, per lamp.',
  },
  RATE_SLOW_SETTLE: {
    severity: 'medium',
    title: 'the lamp took longer than SETTLE_MS to stop moving',
    assumption: 'lib/outputs/target-state-cache.ts OVERRIDE_SETTLE_MS — after SETTLE_MS a report belongs to '
      + 'somebody else, so a lamp still settling past it accuses a person of its own fade.',
  },

  // ---- eyes, the question a machine cannot ask

  EYES_TEMP_INVERTED: {
    severity: 'critical',
    title: 'a person says a high light_temperature looks COLDER on this lamp',
    assumption: 'platform §6 — higher is warmer, from homey-lib\'s own capability hint. A driver '
      + 'that maps it backwards consistently reports plausibly and lights the room wrong, and no '
      + 'amount of API traffic can see it.',
  },
  EYES_TEMP_CONFIRMED: {
    severity: 'info',
    title: 'a person confirms a high light_temperature looks warmer',
    assumption: 'platform §6 — recorded because the claim is load-bearing and had one witness.',
  },
  EYES_DISAGREE: {
    severity: 'high',
    title: 'two lamps from one integration were answered differently',
    assumption: 'platform §6 — the direction is a property of the axis, not of a bulb. Two answers '
      + 'from one driver means one of them is wrong, or the driver is inconsistent.',
  },

  // ---- the probe talking about itself

  RESTORE_FAILED: {
    severity: 'critical',
    title: 'the lamp was not put back as it was found',
    assumption: 'A fact about the RUN, not the lamp: somebody has to set this light by hand. The '
      + 'summary lists it again for that reason.',
  },
  PROBE_INTERFERENCE: {
    severity: 'medium',
    title: 'something else drove the lamp mid-battery',
    assumption: 'lib/circadian/circadian-runtime.ts onCapabilityChange() — a value we never wrote is an external '
      + 'change. Every later measurement on this lamp would be attributing somebody else\'s write '
      + 'to us, so its battery stops here.',
  },
  PROBE_STEP_FAILED: {
    severity: 'low',
    title: 'a step threw and its conclusions are missing',
    assumption: 'A gap in the evidence, not a quirk. Recorded so a missing finding is never read '
      + 'as a clean result.',
  },
  PROBE_LIGHT_TIMEOUT: {
    severity: 'low',
    title: 'the lamp ran out of its time budget',
    assumption: 'A gap in the evidence, as above. The lamp was restored and the run moved on.',
  },
  PROBE_UNREACHABLE: {
    severity: 'medium',
    title: 'the lamp rejected every write and its answers stopped counting',
    assumption: 'A fact about the LAMP that invalidates facts about the lamp. Every step here '
      + 'reads what a lamp reports to decide what a write did, and a lamp that took no write '
      + 'reports whatever it already held — so a gated axis and a dead radio look identical. '
      + 'Measured: one unreachable Hue bulb produced both criticals and two of three highs in the '
      + 'first full run, and a MODE_DOES_NOT_GATE from a temperature that never left the house.',
  },
  PROBE_UNINSTRUMENTED: {
    severity: 'info',
    title: 'echo findings were skipped because no echo ever arrived',
    assumption: 'lib/outputs/light-target-adapter.ts subscribe() — capability instances are the app\'s only '
      + 'subscription mechanism. If none of them fire from here, the instrumentation is what is '
      + 'broken, and reporting a house of silent lamps would be a fabricated quirk.',
  },
  PROBE_SUSPECT_CACHE: {
    severity: 'critical',
    title: 'no read moved for any lamp all run',
    assumption: 'platform §15 — a getAll fills homey-api\'s per-manager cache for the life of the '
      + 'client, so a get without $cache:false is served a snapshot. That defect once fabricated '
      + 'three hardware quirks that reached the platform reference twice. If this fires, believe '
      + 'nothing else in the report.',
  },
  PROBE_REDACTION_LEAK: {
    severity: 'critical',
    title: 'the redacted report still contained something identifying',
    assumption: 'The redacted file is the shareable one, so it is not written at all when this '
      + 'fires. test/fixtures/README.md is why: a capture carries every device and zone name in '
      + 'the house, the owner display name and notification text from existing flows.',
  },
};

/**
 * @typedef {object} Finding
 * @property {string} code
 * @property {Severity} severity
 * @property {string} step
 * @property {string | null} capability
 * @property {string} observed
 * @property {Record<string, number | string | boolean | null>} numbers
 * @property {number[]} evidence
 * @property {'measured'|'inferred'|'human'|'inconclusive'} confidence
 * @property {string | null} repeats
 * @property {string} [light] The lamp it is about; absent on the run's own.
 */

/**
 * Everything found, flat, so the summary and the report can both read it.
 *
 * The SAME objects that are in each lamp's own `findings`, never copies. It was
 * `{ ...record, light }`, and a shallow copy quietly split the two: `numbers`
 * and `evidence` are objects and stayed shared, so merged samples looked fine,
 * while every SCALAR mutated later was lost — and the only scalar anything
 * mutates is `confidence`. Both demotions write to a lamp's own list (an
 * unreachable lamp in `noteWriteHealth`, a lamp somebody else is driving at the
 * end of the run), so neither reached the array the summary, the printed
 * report and `--fail-on` all read.
 *
 * Measured on the 4 September 2026 run: 14 of 130 findings were demoted per
 * lamp and counted as measured in every total — including one of the two
 * criticals, and three `MODE_DOES_NOT_GATE`, the finding whose whole purpose is
 * to overturn platform §6. The half-fix is still visible in the
 * PROBE_UNINSTRUMENTED demotion, which used to walk both arrays.
 */
/** @type {Array<Finding & { light: string }>} */
const allFindings = [];

/**
 * Record one finding against one lamp, once.
 *
 * Deduplicated on (light, code) with the samples merged into `evidence` and
 * `numbers`, because a seven-rung ladder that mismatches seven times is ONE
 * fact about the lamp. Emitting seven yields four hundred findings in a normal
 * house, which is the same as emitting none: nobody reads them.
 *
 * `needsChange` is the guard against the failure this whole script is most
 * likely to commit. A finding whose evidence is "the value did not move" is
 * indistinguishable from a stale read, and a stale read is exactly what platform
 * §15 does to a `getDevice` after any `getAll` — a defect that has already
 * fabricated three hardware quirks and put them in the platform reference twice.
 * So a no-change finding is downgraded to `inconclusive` unless this run has
 * seen that same capability move on that same lamp at least once.
 *
 * @param {any} light
 * @param {keyof typeof FINDINGS} code
 * @param {{ step: string, capability?: string, observed: string,
 *           numbers?: Record<string, number | string | boolean | null>,
 *           evidence?: number[], confidence?: Finding['confidence'],
 *           needsChange?: boolean, severity?: Severity }} detail
 * @returns {Finding}
 */
function finding(light, code, detail) {
  const spec = FINDINGS[code];
  // A typo in a code would otherwise print a finding with no severity and no
  // assumption — the two things that make it worth printing.
  if (!spec) throw new Error(`probe-lights: unknown finding code "${code}"`);

  let confidence = detail.confidence ?? 'measured';
  if (detail.needsChange && detail.capability && !light.changed?.has(detail.capability)) {
    confidence = 'inconclusive';
  }

  const existing = /** @type {Finding | undefined} */ (
    light.findings.find(/** @param {Finding} f */ (f) => f.code === code));
  if (existing) {
    existing.evidence.push(...(detail.evidence ?? []));
    Object.assign(existing.numbers, detail.numbers ?? {});
    existing.numbers.occurrences = Number(existing.numbers.occurrences ?? 1) + 1;
    return existing;
  }

  /** @type {Finding} */
  const record = {
    code: String(code),
    severity: detail.severity ?? spec.severity,
    step: detail.step,
    capability: detail.capability ?? null,
    observed: detail.observed,
    numbers: { ...(detail.numbers ?? {}) },
    evidence: [...(detail.evidence ?? [])],
    confidence,
    repeats: null,
  };

  record.light = light.ref.id;
  light.findings.push(record);
  allFindings.push(/** @type {Finding & { light: string }} */ (record));

  const flag = confidence === 'inconclusive' ? '?' : ' ';
  // The capability goes in the printed line, not just in the record: half these
  // codes are per-capability, and "listed but reports no value" without saying
  // which value is a line nobody can act on.
  const where = record.capability === null ? '' : `${record.capability}: `;
  console.log(`${detail.step.padEnd(4)} FINDING${flag}${record.severity.padEnd(9)}`
    + `${record.code.padEnd(32)} ${where}${record.observed}`);

  return record;
}

// ------------------------------------------------------------------ asking

/**
 * Read one line from the terminal.
 *
 * Copied from `verify-hardware.mjs` with one change, and the change is the
 * reason it is not just imported: there, Ctrl-C at the prompt calls
 * `process.exit(130)` on the spot, which is harmless when nothing is half-done.
 * Here it would abandon a lamp mid-battery with its snapshot unrestored, so the
 * cancel path is handed out instead of taken.
 *
 * Nothing here is a secret — this script never prompts for a key — so the raw
 * mode is only for reading Ctrl-C rather than for hiding input.
 *
 * @param {string} question
 * @param {() => void} onCancel
 * @returns {Promise<string>}
 */
const askTerminal = (question, onCancel) => new Promise((resolve) => {
  const { stdin, stdout } = process;

  stdout.write(question);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let value = '';

  const restore = () => {
    stdin.removeListener('data', onData);
    stdin.setRawMode?.(false);
    stdin.pause();
  };

  /** @param {string} chunk */
  function onData(chunk) {
    for (const character of chunk) {
      if (character === '\r' || character === '\n') {
        restore();
        stdout.write('\n');
        resolve(value.trim());
        return;
      }

      // Ctrl-C: hand the terminal back, then let the caller put the lamp back.
      if (character === '\u0003') {
        restore();
        stdout.write('\n');
        onCancel();
        resolve('');
        return;
      }

      if (character === '\u007f' || character === '\b') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        continue;
      }

      if (character < ' ') continue;

      value += character;
      stdout.write(character);
    }
  }

  stdin.on('data', onData);
});

// ------------------------------------------------------------ configuration

const CONFIG_FILE = join(here, 'hardware-env.json');

/**
 * The same file and the same environment variables the hardware pass reads, so
 * a machine set up for one is set up for both.
 *
 * `appKey` is read only to compare against `key`: this script needs ONE key, and
 * it must not be the one the app holds. A key holds a single live session
 * (platform §2), so a shared key means this run evicts the app's session and the
 * app's next reconcile evicts ours — which presents as a key that "randomly"
 * stops working.
 *
 * @returns {{ address: string, key: string, appKey: string, room: string }}
 */
function readConfig() {
  /** @type {any} */
  let fromFile = {};
  if (existsSync(CONFIG_FILE)) {
    // The BOM is stripped rather than tolerated: on Windows PowerShell 5.1
    // `Set-Content -Encoding utf8` writes UTF-8 WITH a byte-order mark, which
    // JSON.parse rejects while naming an invisible character.
    fromFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  }

  return {
    address: String(process.env.HOMEY_ADDRESS ?? fromFile.address ?? '').replace(/\/$/, ''),
    key: String(process.env.HOMEY_API_KEY ?? fromFile.key ?? ''),
    appKey: String(process.env.HOMEY_APP_KEY ?? fromFile.appKey ?? ''),
    /**
     * Which room the lamps come from, and here it is the ONLY containment there
     * is.
     *
     * The hardware pass marks the devices it creates `[verify]` and refuses to
     * touch anything else. A lamp cannot be marked: it is somebody's light,
     * paired long before this script existed, and probing it means writing to
     * it. So the room is the whole of the safety story for a default run, and
     * the whole house is `--all` — deliberately typed rather than defaulted.
     */
    room: String(process.env.HOMEY_TEST_ROOM ?? fromFile.room ?? ''),
  };
}

/**
 * Enough to reach the Homey, asking if there is somebody to ask.
 *
 * Simpler than the hardware pass's version because this script needs one key
 * and never a second: there is no `appKey` branch to explain, and nothing here
 * is typed in secret except by inheritance.
 *
 * @returns {Promise<{ address: string, key: string, appKey: string, room: string }>}
 */
async function ensureConfig() {
  const config = readConfig();

  const missing = [];
  if (!config.address) missing.push('address');
  if (!config.key) missing.push('key');
  if (missing.length === 0) return config;

  throw new Error(
    `Missing configuration: ${missing.join(', ')}. Set HOMEY_ADDRESS and HOMEY_API_KEY, or `
    + 'write scripts/hardware-env.json as { "address": "http://192.168.1.23", "key": "...", '
    + '"room": "Office" }. The file is gitignored. Make the key at my.homey.app -> this Homey '
    + '-> Settings -> API Keys, with FULL access, and do NOT reuse the key the app holds.',
  );
}

// --------------------------------------------------------------- connection

/**
 * The same client the app builds: createLocalAPI with the Personal API Key
 * (platform §1).
 *
 * Copied from `verify-hardware.mjs`, and then given one thing it does not need
 * to do. There, a manager that will not connect is degraded and the run carries
 * on, because every check is request/response. Here the `devices` realtime
 * socket is the instrumentation: every echo measurement in this script arrives
 * through it, so whether it came up has to be RECORDED rather than mentioned in
 * passing. A silent house and a dead socket look identical in the output, and
 * only one of them is a finding.
 *
 * @param {{ address: string, key: string }} config
 * @returns {Promise<{ api: any, sockets: Record<string, boolean> }>}
 */
async function connect(config) {
  note(`connecting to ${config.address}...`);
  const api = await HomeyAPI.createLocalAPI({ address: config.address, token: config.key });

  /** @type {Record<string, boolean>} */
  const sockets = {};
  for (const name of ['devices', 'zones', 'apps']) {
    const manager = api[name];
    if (!manager || typeof manager.connect !== 'function') {
      sockets[name] = false;
      continue;
    }
    try {
      await withTimeout(manager.connect(), 15_000, `connecting manager "${name}"`);
      sockets[name] = true;
    } catch (error) {
      sockets[name] = false;
      note(`manager "${name}" did not connect (${messageOf(error)})`);
    }
  }
  return { api, sockets };
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms, what) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close every realtime socket so the process can exit.
 *
 * Without this the script printed its whole report and then hung forever: a
 * connected manager holds an open socket, and node does not exit while one is
 * alive. Deliberately not `process.exit()` — that truncates buffered stdout on
 * Windows, which would eat the last lines of the very report this exists to
 * produce.
 *
 * @param {any} api
 */
function disconnectAll(api) {
  for (const name of ['devices', 'zones', 'flow', 'apps', 'drivers']) {
    const manager = api?.[name];
    try {
      if (manager && typeof manager.destroy === 'function') manager.destroy();
    } catch {
      // A socket that will not close cannot stop us reporting what we found.
    }
  }
  // The managers are not enough on their own. The client holds the socket
  // SESSION and a map of refresh timers above them, and either keeps node alive
  // by itself — destroying only the managers still hung.
  try {
    if (typeof api?.destroy === 'function') api.destroy();
  } catch {
    // As above.
  }
}

// ------------------------------------------------------------------ helpers

/** @param {unknown} error */
function messageOf(error) {
  return String(/** @type {any} */ (error)?.message ?? error);
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @param {unknown} value */
function round(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : String(value);
}

/**
 * The three key failures, told apart. Homey's own wording for them is three
 * words long and identical in shape (platform §2), and printing the bare string
 * hands the reader a search engine query instead of an instruction.
 *
 * @param {unknown} error
 * @returns {string}
 */
function explainFailure(error) {
  const message = messageOf(error);

  if (/Missing Scopes/i.test(message)) {
    return `${message}\n\n`
      + 'The key reached the Homey but is not allowed to do this. This script reads\n'
      + 'devices and zones and writes capability values.\n\n'
      + 'Fix: my.homey.app -> this Homey -> Settings -> API Keys -> New API Key,\n'
      + 'with FULL access. A key\'s permissions cannot be widened after it is made.';
  }

  if (/Session Not Found/i.test(message)) {
    return `${message}\n\n`
      + 'The key is well-formed but its session is gone. A key holds ONE live\n'
      + 'session and a second holder takes it over (platform §2) — which is what\n'
      + 'sharing the app\'s key with this script looks like.\n\n'
      + 'Fix: make a separate key for this script and keep it out of the app.';
  }

  if (/Missing Session ID in Token/i.test(message)) {
    return `${message}\n\n`
      + 'That is not a whole API key — it looks truncated. A key has three\n'
      + 'colon-separated parts. Copy the whole thing.';
  }

  return message;
}

/**
 * Anything key-shaped, anywhere in a string.
 *
 * Restated from `redactKeyMaterial()` in `lib/credential-service.ts KEY_MATERIAL` rather
 * than imported, because a `.mjs` script cannot import the app's TypeScript.
 * Keep the two in step. The reason it is here at all: an error from homey-api can
 * quote the offending request back, token and all, and this script writes every
 * error it sees into a file.
 *
 * 20+ contiguous hex characters cannot be a Homey id — those are UUIDs, whose
 * longest unbroken hex run is the 12-character final group — so the secret
 * segment can be matched without eating the device ids that make a failure
 * diagnosable.
 */
const KEY_MATERIAL = /[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9a-f]{20,}|[0-9a-f]{20,}/gi;

/** @param {string} text */
export function redactKeyMaterial(text) {
  return String(text).replace(KEY_MATERIAL, '<redacted>');
}

// ------------------------------------------------------------------ reading

/**
 * One lamp's current value for a capability, read fresh.
 *
 * `$cache: false`, and this is the single most important line in the script.
 *
 * A `getAll` writes every item it returns into `homey-api`'s per-manager cache
 * for the life of the client (platform §15), and this script calls `getDevices()`
 * to find the lights — so a plain `getDevice` here would be served that snapshot
 * rather than the lamp, forever. The same defect in `LightTargetAdapter.refresh()`
 * and in the hardware pass produced three "wrote X, holds Y" quirks that were
 * written into the platform reference twice before anyone noticed they were the
 * value from the step before.
 *
 * A probe whose entire output is quirk claims cannot afford that mistake once.
 *
 * @param {any} api
 * @param {string} deviceId
 * @param {string} capability
 * @returns {Promise<number | boolean | string | null>}
 */
async function capabilityValue(api, deviceId, capability) {
  const device = await api.devices.getDevice({ id: deviceId, $cache: false, $updateCache: false });
  const value = device?.capabilitiesObj?.[capability]?.value;
  return value === undefined ? null : value;
}

/**
 * Every readable capability at once, with what the read cost.
 *
 * One fresh `getDevice` for the whole set rather than one per capability: the
 * snapshot is the point (a restore baseline has to be internally consistent),
 * and it is five times fewer round trips.
 *
 * @param {any} api
 * @param {string} deviceId
 * @param {readonly string[]} capabilities
 * @returns {Promise<{ values: Record<string, unknown>, readMs: number, mode: string | null }>}
 */
async function readAll(api, deviceId, capabilities) {
  const started = performance.now();
  const device = await withTimeout(
    api.devices.getDevice({ id: deviceId, $cache: false, $updateCache: false }),
    PROBE.READ_TIMEOUT_MS, `reading ${deviceId}`);
  const readMs = Math.round(performance.now() - started);

  /** @type {Record<string, unknown>} */
  const values = {};
  for (const capability of capabilities) {
    const value = device?.capabilitiesObj?.[capability]?.value;
    values[capability] = value === undefined ? null : value;
  }

  // `light_mode` is read here and nowhere in the app, because a restore has to
  // put the lamp back in the mode it was found in — see `restoreLight`.
  const mode = device?.capabilitiesObj?.light_mode?.value;
  return { values, readMs, mode: mode === undefined ? null : String(mode) };
}

/**
 * The same read, polled, keeping every sample.
 *
 * `capabilityValueSettling` in the hardware pass returns the last value it saw
 * and throws the rest away, which is right for a pass/fail line and wrong here:
 * "never moved" and "moved and came back" are different findings, and the time a
 * lamp took to stop moving is itself the measurement `RATE_SLOW_SETTLE` needs.
 *
 * Stops early once the value is within tolerance of what was wanted, so a
 * well-behaved lamp costs one read rather than six.
 *
 * @param {any} api
 * @param {string} deviceId
 * @param {string} capability
 * @param {unknown} wanted
 * @param {{ windowMs?: number, everyMs?: number, tolerance?: number }} [opts]
 * @returns {Promise<{ value: unknown, trace: Array<{ value: unknown, at: number, readMs: number }>,
 *                     settledMs: number | null }>}
 */
async function observe(api, deviceId, capability, wanted, opts = {}) {
  const windowMs = opts.windowMs ?? PROBE.SETTLE_WINDOW_MS;
  const everyMs = opts.everyMs ?? 1_000;
  const tolerance = opts.tolerance ?? THRESHOLDS.LAMP_TOLERANCE;

  const start = performance.now();
  /** @type {Array<{ value: unknown, at: number, readMs: number }>} */
  const trace = [];
  /** @type {number | null} */
  let settledMs = null;

  for (;;) {
    const readStarted = performance.now();
    const value = await capabilityValue(api, deviceId, capability);
    const at = Math.round(performance.now() - start);
    trace.push({ value, at, readMs: Math.round(performance.now() - readStarted) });

    const want = Number(wanted);
    const got = Number(value);
    const close = Number.isFinite(want) && Number.isFinite(got)
      ? Math.abs(want - got) <= tolerance
      : value === wanted;
    if (close) {
      settledMs = at;
      break;
    }
    if (performance.now() - start >= windowMs) break;
    await sleep(everyMs);
  }

  return { value: trace[trace.length - 1].value, trace, settledMs };
}

// ------------------------------------------------------------------ writing

/**
 * One device object per lamp, kept.
 *
 * `LightTargetAdapter` caches its handles for the same reason this does: a write
 * through a fresh `getDevice` measures a `getDevice` round trip and calls the
 * result an ack latency. Every timing number in this script would be wrong by
 * the cost of a read, and wrong in a way that looks like slow hardware.
 *
 * @param {any} api
 * @param {Map<string, any>} handles
 * @param {string} deviceId
 * @returns {Promise<any>}
 */
async function handleFor(api, handles, deviceId) {
  const existing = handles.get(deviceId);
  if (existing) return existing;
  const device = await withTimeout(
    api.devices.getDevice({ id: deviceId, $cache: false, $updateCache: false }),
    PROBE.READ_TIMEOUT_MS, `fetching ${deviceId}`);
  handles.set(deviceId, device);
  return device;
}

/**
 * Write one capability and say what happened. Never throws.
 *
 * The shape mirrors the app's own `WriteRecord`, so a raw report here can be read
 * next to `GET /diagnostics` `recentWrites` from the same lamp without
 * translating between them.
 *
 * A rejection is a fact about the lamp — the Hue "soft off" refusal is the whole
 * of platform §6's third outcome — so it is captured, redacted and returned,
 * never propagated. A throw here would abandon a snapshot.
 *
 * @param {any} handle
 * @param {string} capability
 * @param {boolean | number | string} value
 * @returns {Promise<{ ok: boolean, ms: number, error: string | null }>}
 */
async function writeCapability(handle, capability, value) {
  const started = performance.now();
  try {
    await withTimeout(
      handle.setCapabilityValue({ capabilityId: capability, value }),
      PROBE.WRITE_TIMEOUT_MS, `writing ${capability}`);
    return { ok: true, ms: Math.round(performance.now() - started), error: null };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: redactKeyMaterial(messageOf(error)),
    };
  }
}

// ------------------------------------------------------------------- echoes

/**
 * Listen to a lamp the way the app listens to it.
 *
 * `device.makeCapabilityInstance` is the app's only subscription mechanism
 * (`lib/outputs/light-target-adapter.ts subscribe()`), so it is the only honest way to
 * measure what the app would see. One instance per capability, and exactly ONE
 * per capability — which matters more than it looks: the app can hold two
 * subscriptions to one lamp (a controller and a circadian light both subscribe),
 * and platform §6 records that "echoes arrive duplicated". If this recorder
 * consistently sees one echo per write, that note is about the app rather than
 * the platform. See `ECHO_COUNT`.
 *
 * @param {any} handle
 * @param {readonly string[]} capabilities
 * @param {(capability: string, value: unknown, at: number) => void} onEcho
 * @returns {{ stop: () => void, failed: string[] }}
 */
function watchCapabilities(handle, capabilities, onEcho) {
  /** @type {Array<{ destroy: () => void }>} */
  const instances = [];
  /** @type {string[]} */
  const failed = [];

  for (const capability of capabilities) {
    if (!(handle?.capabilities ?? []).includes(capability)) continue;
    try {
      const instance = handle.makeCapabilityInstance(capability, (/** @type {unknown} */ value) => {
        // Inside Homey's own event dispatch: a throw here takes the
        // subscription down with it, and a lost subscription is silent.
        try {
          onEcho(capability, value, performance.now());
        } catch { /* a recorder failure is not the lamp's fault */ }
      });
      instances.push(instance);
    } catch {
      failed.push(capability);
    }
  }

  return {
    stop: () => {
      for (const instance of instances) {
        try {
          instance.destroy();
        } catch { /* teardown is best effort */ }
      }
    },
    failed,
  };
}

// ------------------------------------------------- deriving, and only deriving

/**
 * The app's perceptual axis, both ways (`lib/outputs/light-intent.ts GAMMA`).
 *
 * Here so the brightness floor step writes the value the app would write rather
 * than a round number that proves nothing.
 *
 * @param {number} perceptual
 */
export function toDevice(perceptual) {
  return Math.pow(clamp(perceptual, 0, 1), THRESHOLDS.GAMMA);
}

/** @param {number} deviceValue */
export function toPerceptual(deviceValue) {
  return Math.pow(clamp(deviceValue, 0, 1), 1 / THRESHOLDS.GAMMA);
}

/**
 * Round to a capability's declared resolution, as `quantise()` does in the app.
 *
 * @param {number} value
 * @param {number | null | undefined} decimals
 */
export function quantise(value, decimals) {
  if (decimals === null || decimals === undefined || !Number.isFinite(decimals)) return value;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Clamp to a declared range, treating "not declared" as the unit axis.
 *
 * `number(min)` is not enough and the difference is not cosmetic: `Number(null)`
 * is `0`, so a lamp that declares no maximum — which is most of them — would be
 * clamped to a range of zero to zero and written darkness on every rung. Then
 * the ladder would report a lamp that ignores its own axis, and the probe would
 * have invented a quirk out of its own arithmetic.
 *
 * @param {number} value
 * @param {number | null | undefined} min
 * @param {number | null | undefined} max
 */
export function clampToRange(value, min, max) {
  const declared = /** @param {unknown} bound @param {number} fallback */ (bound, fallback) => {
    if (bound === null || bound === undefined) return fallback;
    const number = Number(bound);
    return Number.isFinite(number) ? number : fallback;
  };
  return clamp(value, declared(min, 0), declared(max, 1));
}

/**
 * The rungs a ladder will actually write on this lamp.
 *
 * Clamped and quantised through the lamp's OWN declared metadata, exactly as
 * the planner does before a write — so a mismatch afterwards is the lamp
 * disagreeing with its own declaration, not this script writing something out
 * of range and calling the refusal a quirk. Duplicates collapse, because two
 * rungs at one value measure nothing twice.
 *
 * @param {readonly number[]} values
 * @param {{ min?: number | null, max?: number | null, decimals?: number | null }} options
 * @returns {number[]}
 */
export function ladderRungs(values, options) {
  /** @type {number[]} */
  const rungs = [];
  for (const value of values) {
    const rung = quantise(clampToRange(value, options.min, options.max), options.decimals);
    if (!rungs.includes(rung)) rungs.push(rung);
  }
  return rungs;
}

/**
 * What a completed ladder says about the lamp.
 *
 * Pure, and unit-tested against synthetic traces in
 * `test/unit/probe-findings.test.ts`, because every high-severity finding in the
 * axis family is a threshold comparison against one of these numbers and none of
 * them should need a Homey to prove.
 *
 * `inverted` and `scaleFactor` are the two claims worth stating carefully.
 * Inversion is only claimed when the reports track (1 - written) far better than
 * they track the written value — a lamp that simply ignores the axis reports a
 * constant, which is not inversion. A scale factor is only claimed when every
 * rung is off by roughly the SAME multiple, because one clamped rung is a
 * ceiling and not a scale.
 *
 * @param {Array<{ wrote: number, held: unknown }>} samples
 */
export function analyseLadder(samples) {
  // A null or a boolean is DROPPED, never coerced. `Number(null)` is 0, so a
  // capability that reported no value at all would otherwise arrive here as
  // darkness, and a lamp that answered nothing would be reported as a lamp that
  // answered wrongly — a fabricated quirk out of a missing reading.
  const usable = samples
    .filter(s => typeof s.held === 'number' || (typeof s.held === 'string' && s.held.trim() !== ''))
    .map(s => ({ wrote: Number(s.wrote), held: Number(s.held) }))
    .filter(s => Number.isFinite(s.wrote) && Number.isFinite(s.held));

  if (usable.length === 0) {
    return {
      n: 0, maxDelta: null, distinct: 0, effectiveMin: null, effectiveMax: null,
      monotone: null, inverted: false, scaleFactor: null, resolution: null,
    };
  }

  const deltas = usable.map(s => Math.abs(s.held - s.wrote));
  const maxDelta = Math.max(...deltas);
  const held = usable.map(s => s.held);

  const uniqueHeld = [...new Set(held.map(v => Number(v.toFixed(4))))].sort((a, b) => a - b);
  /** @type {number | null} */
  let resolution = null;
  for (let i = 1; i < uniqueHeld.length; i += 1) {
    const gap = uniqueHeld[i] - uniqueHeld[i - 1];
    if (gap > 0 && (resolution === null || gap < resolution)) resolution = gap;
  }

  // Monotone against the ORDER the rungs were written, not against sorted
  // values: a ladder is walked upwards, and that is the property a ramp needs.
  let monotone = true;
  for (let i = 1; i < usable.length; i += 1) {
    if (usable[i].wrote <= usable[i - 1].wrote) continue;
    if (usable[i].held < usable[i - 1].held - THRESHOLDS.OVERRIDE_TOLERANCE) monotone = false;
  }

  const directError = deltas.reduce((sum, d) => sum + d, 0) / usable.length;
  const invertedError = usable
    .reduce((sum, s) => sum + Math.abs(s.held - (1 - s.wrote)), 0) / usable.length;
  const inverted = usable.length >= 3
    && directError > 0.3
    && invertedError < THRESHOLDS.LAMP_TOLERANCE;

  /** @type {number | null} */
  let scaleFactor = null;
  const ratios = usable
    .filter(s => s.wrote > 0.01 && Number.isFinite(s.held / s.wrote))
    .map(s => s.held / s.wrote);
  if (ratios.length >= 3) {
    const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    const spread = Math.max(...ratios) - Math.min(...ratios);
    // A consistent multiple well away from 1: a scale, not a clamp.
    if ((mean > 5 || mean < 0.2) && spread < Math.abs(mean) * 0.25) {
      scaleFactor = Number(mean.toFixed(2));
    }
  }

  return {
    n: usable.length,
    maxDelta: Number(maxDelta.toFixed(4)),
    distinct: uniqueHeld.length,
    effectiveMin: uniqueHeld[0],
    effectiveMax: uniqueHeld[uniqueHeld.length - 1],
    monotone,
    inverted,
    scaleFactor,
    resolution: resolution === null ? null : Number(resolution.toFixed(4)),
  };
}

/**
 * A latency distribution, which is what the corpus is actually made of.
 *
 * @param {number[]} values
 */
export function percentiles(values) {
  const sorted = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, min: null, p50: null, p90: null, max: null };
  /** @param {number} fraction */
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
  };
}

// ------------------------------------------------------------- the lamp record

/**
 * Everything known about one lamp, and everything done to it.
 *
 * The flat `observations` array is what makes a finding auditable. Every read,
 * write, ack, echo and error gets a sequence number, and a finding carries the
 * numbers it was derived from — so a claim that looks wrong six months from now
 * is re-read out of the trace instead of re-run on hardware, which by then has
 * different firmware.
 *
 * @param {any} device
 * @param {string} zoneName
 */
function newLight(device, zoneName) {
  const name = String(device?.name ?? '');
  return {
    ref: {
      id: String(device?.id ?? ''),
      name,
      zoneId: device?.zone ? String(device.zone) : null,
      zoneName,
      deviceClass: String(device?.class ?? ''),
      virtualClass: device?.virtualClass ? String(device.virtualClass) : null,
      driverId: String(device?.driverId ?? ''),
      ownerUri: String(device?.ownerUri ?? ''),
      ownerName: String(device?.ownerName ?? ''),
      available: device?.available !== false,
      /**
       * A Hue room or zone device fans one write out to several bulbs,
       * aggregates the echoes and has bimodal latency, so its quantisation
       * numbers describe an average of bulbs rather than a bulb. The heuristic
       * will misfire both ways; it downgrades findings rather than suppressing
       * them, which is the honest thing to do with a guess.
       */
      suspectedGroup: /group|zone|room/i.test(String(device?.driverId ?? ''))
        || (zoneName !== '' && zoneName === name),
    },
    /** @type {Record<string, any>} */
    declared: {},
    /** @type {{ at: number, values: Record<string, unknown>, mode: string | null, readMs: number } | null} */
    snapshot: null,
    /** @type {Array<{ id: string, name: string, status: string, ms: number, reason: string | null, derived: any }>} */
    steps: [],
    /** @type {Array<Record<string, unknown>>} */
    observations: [],
    /** @type {Record<string, any>} */
    latency: {},
    /** @type {Finding[]} */
    findings: [],
    /** @type {any} */
    restore: null,
    confounded: false,
    /**
     * Consecutive failed writes, and the demotion they earn.
     *
     * The sibling of `confounded`, added after the first full run: a Hue bulb
     * that was unreachable for the whole eighteen minutes produced BOTH
     * criticals, two of the three highs, and a `MODE_DOES_NOT_GATE` drawn from
     * a temperature write that never left the house. Every step below reads a
     * lamp's REPORTS to decide what it did, and a lamp that took no write at
     * all reports whatever it was already holding — so the conclusions were
     * about nothing.
     */
    failedWrites: 0,
    unreachable: false,
    /** Has anything been written to this lamp at all? A read-only run says no. */
    wrote: false,
    /** When anything was last written to this lamp, whatever the capability. */
    lastWriteAt: -Infinity,
    /** Capabilities this run has actually seen move — see `finding()`. */
    changed: new Set(),
    /** Measured quantisation per capability, which the restore check needs. */
    /** @type {Record<string, number>} */
    quantisation: {},
    /** @type {any} */
    handle: null,
    /** @type {{ stop: () => void, failed: string[] } | null} */
    watcher: null,
    /** @type {Map<string, { value: unknown, at: number }>} */
    lastWrite: new Map(),
    /** @type {Array<{ capability: string, value: unknown, at: number }>} */
    echoes: [],
    seq: 0,
  };
}

/** @typedef {ReturnType<typeof newLight>} Light */

/**
 * Append to the lamp's trace and hand back the sequence number, so a finding can
 * point at it.
 *
 * @param {Light} light
 * @param {'write'|'ack'|'read'|'echo'|'error'|'marker'} kind
 * @param {{ capability?: string | null, value?: unknown, ok?: boolean | null,
 *           ms?: number | null, error?: string | null, note?: string | null }} detail
 * @returns {number}
 */
function observation(light, kind, detail) {
  light.seq += 1;
  light.observations.push({
    seq: light.seq,
    at: Date.now(),
    mono: Math.round(performance.now()),
    kind,
    capability: detail.capability ?? null,
    value: detail.value === undefined ? null : detail.value,
    ok: detail.ok ?? null,
    ms: detail.ms ?? null,
    error: detail.error ?? null,
    note: detail.note ?? null,
  });
  return light.seq;
}

/**
 * Record a write, its ack and its latency in one place.
 *
 * Also stamps `lastWrite`, which is what tells an echo of our own from somebody
 * else's — the distinction the interference detector and every `RATE_*` finding
 * rest on.
 *
 * @param {Light} light
 * @param {string} capability
 * @param {boolean | number | string} value
 * @returns {Promise<{ ok: boolean, ms: number, error: string | null, seq: number }>}
 */
async function write(light, capability, value) {
  // Recorded so a read-only run can prove it wrote nothing, and so a restore
  // knows whether there is anything to put back.
  light.wrote = true;
  // Per-LAMP, not per-capability, and that distinction is load-bearing: see the
  // attribution rule in `startWatching`.
  light.lastWriteAt = performance.now();
  const seq = observation(light, 'write', { capability, value });
  light.lastWrite.set(capability, { value, at: performance.now() });
  const outcome = await writeCapability(light.handle, capability, value);
  observation(light, 'ack', {
    capability, value, ok: outcome.ok, ms: outcome.ms, error: outcome.error,
  });

  const bucket = light.latency[capability]
    ?? (light.latency[capability] = { ack: [], failed: [], firstEcho: [] });
  /**
   * An ack is a write that LANDED. A rejection's duration is time-to-error and
   * belongs in its own bucket.
   *
   * Both went into `ack` at first, which is how the unreachable lamp came to
   * report `latency.dim.ack n=59 p50=267ms` having never taken a write, and how
   * a nine-second timeout on an IKEA outlet was published as
   * `ECHO_ACK_SLOW "acked in 9017ms"`. Time-to-error is worth keeping — it is
   * the difference between a refusal and a timeout — just not under that name.
   */
  if (outcome.ok) bucket.ack.push(outcome.ms);
  else bucket.failed.push(outcome.ms);

  noteWriteHealth(light, outcome.ok);

  return { ...outcome, seq };
}

/**
 * How many failed writes in a row before this lamp's answers stop counting.
 *
 * Deliberately small. This is not the app's "is the lamp working" question,
 * where a false positive marks a user's device — it is "can anything measured
 * here be trusted", and the answer after three consecutive rejections is no.
 * The battery costs about seventy seconds a lamp, and spending it on a bulb
 * that is powered off at the wall buys a page of fabricated quirks.
 */
export const UNREACHABLE_AFTER = 3;

/**
 * The streak arithmetic, with nothing in it to mock.
 *
 * Separated from the side effects below so the one number that decides whether
 * a lamp's answers count can be checked without a Homey — the same split every
 * other verdict in this file has (`analyseLadder`, `nearestCyclic`).
 *
 * @param {{ failedWrites: number, unreachable: boolean }} state
 * @param {boolean} ok
 * @returns {{ failedWrites: number, unreachable: boolean }}
 */
export function noteWriteOutcome(state, ok) {
  if (ok) return { failedWrites: 0, unreachable: state.unreachable };
  const failedWrites = state.failedWrites + 1;
  return { failedWrites, unreachable: state.unreachable || failedWrites >= UNREACHABLE_AFTER };
}

/**
 * `light_mode` is excluded, and that exclusion came from the hardware.
 *
 * On the unreachable reference lamp it was the ONLY capability that acked —
 * twenty times out of 113 writes — because the Hue app satisfies it locally
 * without going to the bridge. Let a `light_mode` ack clear the streak and the
 * demotion never fires on precisely the lamp it exists for.
 *
 * @param {Light} light
 * @param {boolean} ok
 */
function noteWriteHealth(light, ok) {
  const before = light.unreachable;
  const after = noteWriteOutcome(light, ok);
  light.failedWrites = after.failedWrites;
  light.unreachable = after.unreachable;
  if (before || !after.unreachable) return;

  finding(light, 'PROBE_UNREACHABLE', {
    step: '-',
    observed: `${light.failedWrites} consecutive writes were rejected`,
    numbers: { failedWrites: light.failedWrites },
  });

  /**
   * Everything already concluded about this lamp was concluded from writes
   * that did not land. Same move `PROBE_UNINSTRUMENTED` makes at the end of a
   * run, for the same reason: a finding that rested on silence is not a
   * finding.
   */
  for (const found of light.findings) {
    if (found.code === 'PROBE_UNREACHABLE') continue;
    found.confidence = 'inconclusive';
  }
}

/**
 * Start listening, and decide as each echo arrives whether it was ours.
 *
 * The verdict is the app's, deliberately: same value inside `ECHO_DEDUPE_MS` is a
 * duplicate; anything else is external (`lib/outputs/target-state-cache.ts applyExternalChange()`).
 * What this adds is the interference check the app has no reason to make — a
 * value we never wrote, arriving after the settle window, means somebody or
 * something else is driving this lamp, and every measurement after that point
 * would be attributing their write to us.
 *
 * @param {Light} light
 * @param {(capability: string) => void} onInterference
 */
function startWatching(light, onInterference) {
  light.watcher = watchCapabilities(light.handle, READABLE, (capability, value, at) => {
    light.echoes.push({ capability, value, at });

    const last = light.lastWrite.get(capability);
    const sinceWrite = last ? at - last.at : Infinity;
    const wanted = Number(last?.value);
    const got = Number(value);
    const far = Number.isFinite(wanted) && Number.isFinite(got)
      ? Math.abs(wanted - got) > THRESHOLDS.OVERRIDE_TOLERANCE
      : last?.value !== value;

    if (last && got !== wanted) light.changed.add(capability);
    if (!last) light.changed.add(capability);

    /**
     * Attribution is per LAMP, and the per-capability version was wrong.
     *
     * A `dim` write turns a Hue lamp on — that is the whole of `impliesOn`
     * (`lib/outputs/intent-planner.ts PlannedWrite.impliesOn`) — so the `onoff: true` that follows
     * is OURS, arriving on a capability we did not write. Judged per capability
     * it looked like a value nobody sent, and the probe declared interference
     * against itself on the first lamp it touched, marked it confounded, and
     * skipped its own battery. The lamp was behaving exactly as documented.
     *
     * So: an echo is only unattributed if nothing at all was written to this
     * lamp inside the settle window. Somebody in the room still trips it,
     * because the probe pauses between steps for longer than that.
     */
    const sinceAnyWrite = at - light.lastWriteAt;
    const unattributed = far && sinceWrite > THRESHOLDS.SETTLE_MS
      && sinceAnyWrite > THRESHOLDS.SETTLE_MS;

    observation(light, 'echo', {
      capability,
      value,
      ms: Number.isFinite(sinceWrite) ? Math.round(sinceWrite) : null,
      note: unattributed ? 'unattributed' : null,
    });

    if (unattributed) onInterference(capability);
  });

  if (light.watcher.failed.length > 0) {
    note(`could not subscribe to ${light.watcher.failed.join(', ')}`);
  }
}

/**
 * Every echo for one capability since a moment, in arrival order.
 *
 * @param {Light} light
 * @param {string} capability
 * @param {number} since
 */
function echoesSince(light, capability, since) {
  return light.echoes.filter(e => e.capability === capability && e.at >= since);
}

// ------------------------------------------------------- snapshot and restore

/**
 * Read the lamp twice, and keep the first read as the baseline.
 *
 * Twice, because the second read answers a question the first cannot: is
 * anything ELSE driving this lamp. A lamp that moves on its own — a Hue routine,
 * Adaptive Lighting, somebody in the room — would have every later measurement
 * attributed to us, so it is demoted to read-only rather than probed and
 * misreported.
 *
 * @param {any} api
 * @param {Light} light
 */
async function snapshotLight(api, light) {
  const first = await readAll(api, light.ref.id, READABLE);
  observation(light, 'read', { ms: first.readMs, note: 'snapshot' });

  await sleep(PROBE.LADDER_GAP_MS);

  const second = await readAll(api, light.ref.id, READABLE);
  observation(light, 'read', { ms: second.readMs, note: 'stability' });

  light.snapshot = {
    at: Date.now(),
    values: first.values,
    mode: first.mode,
    readMs: first.readMs,
  };

  // Only the capabilities the lamp actually has. Reading the whole readable set
  // and reporting the absent ones as READ_NULL fired on every lamp for every
  // capability it does not have — fifty lamps of noise, and it would have buried
  // the real case: a capability the lamp DOES list and has no value for.
  const present = (light.handle?.capabilities ?? Object.keys(light.declared));
  for (const capability of READABLE) {
    if (!present.includes(capability)) continue;
    const before = first.values[capability];
    const after = second.values[capability];
    if (before === null) {
      finding(light, 'READ_NULL', {
        step: 'P2', capability,
        observed: `listed but reports no value`,
      });
      continue;
    }
    const drift = Math.abs(Number(after) - Number(before));
    const moved = Number.isFinite(drift) ? drift > THRESHOLDS.OVERRIDE_TOLERANCE : after !== before;
    if (moved) {
      light.changed.add(capability);
      finding(light, 'READ_UNSTABLE', {
        step: 'P2', capability,
        observed: `${round(before)} then ${round(after)} with no write from us`,
        numbers: { before: Number(before), after: Number(after), gapMs: PROBE.LADDER_GAP_MS },
      });
    }
  }

  const slowest = Math.max(first.readMs, second.readMs);
  if (slowest > PROBE.SLOW_READ_MS) {
    finding(light, 'READ_SLOW', {
      step: 'P2',
      observed: `a fresh read took ${slowest}ms`,
      numbers: { readMs: slowest, threshold: PROBE.SLOW_READ_MS },
    });
  }

  return light.snapshot;
}

/**
 * Put the lamp back, in an order that survives the mode gate, and check.
 *
 * Three rules, each of them a bug this would otherwise have:
 *
 *   - MODE LAST OF THE THREE. Writing a hue puts the lamp in colour mode and a
 *     temperature puts it back (platform §6), so restoring the values in
 *     `WRITE_ORDER` would leave a lamp that was found in temperature mode sitting
 *     in colour. The axis the snapshot did NOT use goes first, then the mode,
 *     then the axis it did — so the last thing written is the one that has to
 *     stick.
 *   - POWER FIRST IF IT WAS ON, LAST IF IT WAS OFF. On a lit lamp the values land
 *     visibly and correctly; on a dark one, `onoff: false` goes at the very end,
 *     as the scheduler does with an off write, or every value write on the way
 *     there switches it back on.
 *   - TOLERANCE FROM THE LAMP. A lamp with an undeclared floor cannot return to
 *     a snapshot below that floor, and reporting that as a failed restore would
 *     send somebody to a light that is exactly where they left it. So the check
 *     allows whatever quantisation this run measured, and never less than 0.02.
 *
 * @param {any} api
 * @param {Light} light
 */
async function restoreLight(api, light) {
  if (!light.snapshot || !light.handle) return null;
  /**
   * A read-only run has nothing to put back, and must not pretend otherwise.
   *
   * Without this, `inventory` — the mode whose whole promise is that it writes
   * nothing — wrote the snapshot back to every lamp in the house on the way out,
   * six writes each. Harmless in effect and a broken promise in fact, which is
   * worse: the mode exists to be run on somebody else's Homey.
   */
  if (!light.wrote) return null;
  const snapshot = light.snapshot;
  const wasOn = snapshot.values.onoff === true;

  /** @type {Array<{ capability: string, value: boolean | number | string }>} */
  const plan = [];
  if (wasOn) plan.push({ capability: 'onoff', value: true });

  const usedColour = snapshot.mode === 'color';
  /** @type {string[]} */
  const colourFirst = ['light_hue', 'light_saturation'];
  const order = usedColour
    ? ['light_temperature', 'light_mode', ...colourFirst]
    : [...colourFirst, 'light_mode', 'light_temperature'];

  for (const capability of ['dim', ...order]) {
    if (capability === 'light_mode') {
      if (snapshot.mode !== null && (light.handle.capabilities ?? []).includes('light_mode')) {
        plan.push({ capability, value: snapshot.mode });
      }
      continue;
    }
    const value = snapshot.values[capability];
    if (value === null || value === undefined) continue;
    plan.push({ capability, value: Number(value) });
  }

  if (!wasOn) plan.push({ capability: 'onoff', value: false });

  /** @type {Array<{ capability: string, ok: boolean, error: string | null }>} */
  const attempted = [];
  for (const step of plan) {
    const outcome = await write(light, step.capability, step.value);
    attempted.push({ capability: step.capability, ok: outcome.ok, error: outcome.error });
  }

  await sleep(PROBE.LADDER_GAP_MS);
  const after = await readAll(api, light.ref.id, READABLE);
  observation(light, 'read', { ms: after.readMs, note: 'restore check' });

  /** @type {Record<string, { wanted: unknown, got: unknown, ok: boolean }>} */
  const verified = {};
  let complete = true;
  for (const capability of READABLE) {
    const wanted = snapshot.values[capability];
    if (wanted === null || wanted === undefined) continue;
    const got = after.values[capability];
    const tolerance = Math.max(PROBE.RESTORE_TOLERANCE, light.quantisation[capability] ?? 0);
    const ok = typeof wanted === 'boolean'
      ? got === wanted
      : Math.abs(Number(got) - Number(wanted)) <= tolerance;
    verified[capability] = { wanted, got, ok };
    if (!ok) complete = false;
  }

  light.restore = { attempted, verified, complete, mode: snapshot.mode };

  if (!complete) {
    const missed = Object.entries(verified).filter(([, v]) => !v.ok)
      .map(([capability, v]) => `${capability} ${round(v.wanted)} -> ${round(v.got)}`);
    finding(light, 'RESTORE_FAILED', {
      step: 'P6',
      observed: missed.join('; '),
      numbers: { capabilities: missed.length },
    });
  } else {
    report('P6', 'OK', `${light.ref.name}: restored (${plan.length} writes, verified)`);
  }

  return light.restore;
}

// ------------------------------------------------------- finding the lights

/**
 * The capability-option keys the app reads, and the two it stores and ignores.
 *
 * `step` and `units` are in this list precisely BECAUSE nothing consumes them
 * (`lib/device-catalog.ts CatalogCapability`): a lamp that declares either is telling the app
 * something the app is not listening to, which is a finding rather than noise.
 */
const OPTION_KEYS = ['min', 'max', 'step', 'decimals', 'units'];

/**
 * The six the app touches, and the boundary of what this script judges.
 *
 * A light on a real Homey carries far more than these — a Hue bulb has a
 * migration button, a Shelly socket has voltage, current and RSSI — and every
 * one of them has metadata worth a finding if you are not careful. None of it
 * is about light.
 */
const LIGHT_CAPABILITIES = /** @type {Set<string>} */ (new Set([...WRITE_ORDER, ...READABLE]));

/**
 * Every light on the Homey, exactly as the app defines one.
 *
 * A light is a device with `onoff` (`lib/device-catalog.ts lightCandidates()`) — not a device
 * of class `light` — which is why the target picker offers sockets and kettles,
 * and why this counts them.
 *
 * This is the ONE `getAll` in the script, and it fills `homey-api`'s per-manager
 * cache for the life of the client (platform §15). That is fine for what is read
 * here, all of which is static, and it is exactly why every value read goes
 * through `capabilityValue`/`readAll` with `$cache: false`.
 *
 * @param {any} api
 */
async function collectLights(api) {
  /**
   * The owning app's NAME, resolved the way `DeviceCatalog.appNameFor` resolves
   * it (`lib/device-catalog.ts appNameFor()`).
   *
   * A device does not carry one — only `ownerUri` — so reading `device.ownerName`
   * gave an empty string for every lamp in the house and the per-integration
   * rollup, which is the product of this script, was a list of driver ids.
   * Static data, so filling the apps cache costs nothing that matters.
   *
   * @type {Map<string, string>}
   */
  const appNames = new Map();
  try {
    const apps = await withTimeout(api.apps.getApps(), 20_000, 'reading apps');
    for (const app of Object.values(/** @type {any} */ (apps))) {
      const entry = /** @type {any} */ (app);
      if (entry?.id) appNames.set(`homey:app:${entry.id}`, String(entry?.name ?? entry.id));
    }
  } catch (error) {
    note(`could not read the app list (${messageOf(error)}) — integrations will show as uris`);
  }

  /** @param {string | null} ownerUri */
  const appNameFor = (ownerUri) => {
    if (!ownerUri) return 'Homey';
    return appNames.get(ownerUri) ?? ownerUri.replace(/^homey:app:/, '');
  };

  /** @type {Record<string, string>} */
  const zoneNames = {};
  try {
    const zones = await withTimeout(api.zones.getZones(), 15_000, 'reading zones');
    for (const zone of Object.values(/** @type {any} */ (zones))) {
      zoneNames[String(/** @type {any} */ (zone).id)] = String(/** @type {any} */ (zone).name ?? '');
    }
  } catch (error) {
    note(`could not read zones (${messageOf(error)}) — rooms will be blank`);
  }

  const devices = await withTimeout(api.devices.getDevices(), 30_000, 'reading devices');
  const all = Object.values(/** @type {any} */ (devices));

  /** @type {Light[]} */
  const lights = [];
  for (const device of /** @type {any[]} */ (all)) {
    const capabilities = device?.capabilities ?? [];
    if (!capabilities.includes('onoff')) continue;
    // A Lightkeeper device has onoff too, and probing our own virtual devices
    // would measure this app rather than a lamp.
    if (String(device?.driverId ?? '').includes(APP_ID)) continue;
    const light = newLight(device, zoneNames[String(device?.zone ?? '')] ?? '');
    light.ref.ownerName = appNameFor(light.ref.ownerUri || null);
    lights.push(light);
  }

  return { lights, deviceCount: all.length };
}

/**
 * Which of them this run will touch.
 *
 * The default is the configured room and nothing else. A lamp cannot be marked
 * the way `verify-hardware.mjs` marks the devices it creates — it is somebody's
 * light — so the room is the only containment that exists, and the whole house
 * has to be asked for rather than arrived at.
 *
 * @param {Light[]} lights
 * @param {{ zones: string[], names: string[], driver: string | null, all: boolean,
 *           room: string, quick: boolean, sample: number | null }} selection
 */
function selectLights(lights, selection) {
  const explicit = selection.zones.length > 0 || selection.names.length > 0
    || selection.driver !== null;

  let chosen = lights;

  if (selection.zones.length > 0) {
    const wanted = selection.zones.map(z => z.toLowerCase());
    chosen = chosen.filter(l => wanted.includes(l.ref.zoneName.toLowerCase()));
  }
  if (selection.names.length > 0) {
    const wanted = selection.names.map(n => n.toLowerCase());
    chosen = chosen.filter(l => wanted.includes(l.ref.name.toLowerCase())
      || wanted.includes(l.ref.id.toLowerCase()));
  }
  if (selection.driver !== null) {
    const wanted = selection.driver.toLowerCase();
    chosen = chosen.filter(l => l.ref.driverId.toLowerCase().includes(wanted)
      || l.ref.ownerUri.toLowerCase().includes(wanted));
  }
  if (!explicit && !selection.all && selection.room) {
    const room = selection.room.toLowerCase();
    chosen = chosen.filter(l => l.ref.zoneName.toLowerCase() === room);
  }

  // One lamp per integration is the shape a corpus wants first: a second Hue
  // bulb says almost nothing a first one did not.
  if (selection.quick || selection.sample !== null) {
    const perDriver = selection.sample ?? 1;
    /** @type {Map<string, number>} */
    const taken = new Map();
    chosen = chosen.filter(l => {
      const seen = taken.get(l.ref.driverId) ?? 0;
      if (seen >= perDriver) return false;
      taken.set(l.ref.driverId, seen + 1);
      return true;
    });
  }

  return chosen;
}

// ------------------------------------------------- P1: what the lamp claims

/**
 * Everything the lamp says about itself, including the parts the app throws
 * away.
 *
 * Nothing is written here, and it is the step worth running on somebody else's
 * Homey: it needs no confirmation, disturbs nothing, and already produces the
 * whole metadata family of findings.
 *
 * @param {Light} light
 * @param {any} device
 */
function stepMetadata(light, device) {
  const capabilities = /** @type {string[]} */ (device?.capabilities ?? []);
  const obj = device?.capabilitiesObj ?? {};

  for (const capability of capabilities) {
    const entry = obj[capability] ?? {};
    /** @type {Record<string, unknown>} */
    const declared = {};
    // Captured verbatim, unknown keys included: a key homey-lib grows next year
    // is exactly what a probe should notice, and a whitelist would hide it.
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'value' || key === 'lastUpdated') continue;
      declared[key] = value;
    }
    light.declared[capability] = declared;
  }

  /** @param {string} capability @param {string} key */
  const option = (capability, key) => {
    const value = light.declared[capability]?.[key];
    return value === undefined || value === null ? null : value;
  };

  const has = /** @param {string} capability */ (capability) => capabilities.includes(capability);

  // ---- ranges. dim and light_temperature are clamped to the DECLARED range on
  // the way out and to 0-1 on the way into desired state, so the two disagree
  // the moment a lamp declares anything else.
  for (const [capability, code] of /** @type {Array<[string, keyof typeof FINDINGS]>} */ ([
    ['dim', 'META_DIM_RANGE_NOT_UNIT'],
    ['light_temperature', 'META_TEMP_RANGE_NOT_UNIT'],
  ])) {
    if (!has(capability)) continue;
    const min = option(capability, 'min');
    const max = option(capability, 'max');
    if ((min !== null && Number(min) !== 0) || (max !== null && Number(max) !== 1)) {
      finding(light, code, {
        step: 'P1', capability,
        observed: `declares min ${String(min)}, max ${String(max)}`,
        numbers: { min: Number(min), max: Number(max) },
      });
    }
  }

  for (const capability of ['light_hue', 'light_saturation']) {
    if (!has(capability)) continue;
    const min = option(capability, 'min');
    const max = option(capability, 'max');
    // A declared 0-1 is exactly what clamp01 does, so it costs nothing and is
    // not a finding. Only a range the app would have to honour and does not.
    const unit = (min === null || Number(min) === 0) && (max === null || Number(max) === 1);
    if (!unit) {
      finding(light, 'META_HUE_RANGE_DECLARED', {
        step: 'P1', capability,
        observed: `declares min ${String(min)}, max ${String(max)} — planColor clamps to 0-1 `
          + 'and ignores both',
        numbers: { min: Number(min), max: Number(max) },
      });
    }
  }

  // ---- resolution. The circadian temperature deadband IS this number.
  for (const capability of ['dim', 'light_temperature']) {
    if (!has(capability)) continue;
    const decimals = option(capability, 'decimals');
    if (decimals !== null && Number(decimals) < 2) {
      finding(light, 'META_DECIMALS_COARSE', {
        step: 'P1', capability,
        observed: `declares decimals ${String(decimals)}, so the write deadband is `
          + `${Math.pow(10, -Number(decimals))} against an override tolerance of `
          + `${THRESHOLDS.OVERRIDE_TOLERANCE}`,
        numbers: { decimals: Number(decimals), overrideTolerance: THRESHOLDS.OVERRIDE_TOLERANCE },
      });
    }
    if (decimals === null && capability === 'light_temperature') {
      finding(light, 'META_NO_DECIMALS_TEMP', {
        step: 'P1', capability,
        observed: 'declares no decimals, so the deadband falls back to 0.01',
      });
    }
  }

  /**
   * The two options nothing reads — on the capabilities the app actually
   * touches, and no others.
   *
   * A real Homey answers this loop with `measure_current` in amps, a
   * `fan_speed` with a step of 5 and a `button.migrate_v3` that is not gettable.
   * All true, none of it about a light, and four findings per socket is how a
   * report becomes unreadable. The app only ever reads or writes the six.
   */
  for (const capability of capabilities) {
    if (!LIGHT_CAPABILITIES.has(capability)) continue;
    const step = option(capability, 'step');
    if (step !== null) {
      finding(light, 'META_STEP_DECLARED', {
        step: 'P1', capability,
        observed: `declares step ${String(step)}, which nothing quantises to`,
        numbers: { step: Number(step) },
      });
    }
    const units = option(capability, 'units');
    const expected = capability === 'dim' ? ['%'] : [];
    if (units !== null && !expected.includes(String(units))) {
      finding(light, 'META_UNITS_UNEXPECTED', {
        step: 'P1', capability,
        observed: `declares units "${String(units)}"`,
      });
    }
  }

  // ---- getable and setable, read nowhere in the repo.
  for (const capability of WRITE_ORDER) {
    if (!has(capability)) continue;
    if (light.declared[capability]?.setable === false) {
      finding(light, 'META_SETABLE_FALSE', {
        step: 'P1', capability,
        observed: 'the app writes this capability and the lamp says it cannot be set',
      });
    }
  }
  for (const capability of READABLE) {
    if (!has(capability)) continue;
    if (light.declared[capability]?.getable === false) {
      finding(light, 'META_GETABLE_FALSE', {
        step: 'P1', capability,
        observed: 'the app reads this capability and the lamp says it cannot be got',
      });
    }
  }

  // ---- the shape of the lamp. Colour capability is light_hue, NOT light_mode:
  // homey-lib pairs hue with saturation on every colour light, while light_mode
  // exists only where there is also a temperature to switch to (platform §12).
  if (has('light_hue') && !has('light_temperature')) {
    finding(light, 'META_COLOR_ONLY', {
      step: 'P1',
      observed: 'colour but no colour temperature — an all-temperature curve writes nothing here',
    });
  }
  if (has('light_hue') && has('light_temperature') && !has('light_mode')) {
    finding(light, 'META_DUAL_MODE_NO_LIGHT_MODE', {
      step: 'P1',
      observed: 'both axes and no light_mode, so the app can never switch mode',
    });
  }
  if (has('light_hue') && !has('light_saturation')) {
    finding(light, 'META_HUE_NO_SAT', {
      step: 'P1',
      observed: 'hue without saturation',
    });
  }
  if (has('light_mode')) {
    const values = light.declared.light_mode?.values;
    const ids = Array.isArray(values)
      ? values.map((/** @type {any} */ v) => String(v?.id ?? v))
      : null;
    if (ids && !(ids.includes('color') && ids.includes('temperature'))) {
      finding(light, 'META_MODE_ENUM_UNEXPECTED', {
        step: 'P1', capability: 'light_mode',
        observed: `offers ${ids.join(', ')} — the app writes color and temperature`,
      });
    }
  }
  if (has('onoff')) {
    const declaredOptions = OPTION_KEYS.filter(key => option('onoff', key) !== null);
    if (declaredOptions.length > 0) {
      finding(light, 'META_ONOFF_HAS_OPTIONS', {
        step: 'P1', capability: 'onoff',
        observed: `declares ${declaredOptions.join(', ')}; platform §6 records onoff as {}`,
      });
    }
  }
  if (light.ref.deviceClass !== 'light') {
    finding(light, 'META_NOT_A_LIGHT', {
      step: 'P1',
      observed: `class "${light.ref.deviceClass}" — offered as a light because it has onoff`,
    });
  }

  const summary = [
    has('dim') ? 'dim' : null,
    has('light_temperature') ? 'temp' : null,
    has('light_hue') ? 'colour' : null,
    has('light_mode') ? 'mode' : null,
  ].filter(Boolean).join('+') || 'onoff only';
  report('P1', 'OK', `${light.ref.name}: ${summary}`);
  return { summary, capabilities };
}

// ------------------------------------------- P3: is the lamp already talking

/**
 * Listen before touching anything.
 *
 * A lamp that volunteers values trips the app's own "different value means
 * external" rule by itself, with nobody in the room. It is also the only warning
 * available that a measurement is about to be contaminated.
 *
 * @param {Light} light
 */
async function stepQuietWindow(light) {
  const from = performance.now();
  await sleep(PROBE.QUIET_WINDOW_MS);
  const unsolicited = light.echoes.filter(e => e.at >= from);

  if (unsolicited.length > 0) {
    const capabilities = [...new Set(unsolicited.map(e => e.capability))];
    finding(light, 'ECHO_CHATTY', {
      step: 'P3',
      observed: `${unsolicited.length} callback(s) in ${PROBE.QUIET_WINDOW_MS}ms with no write: `
        + capabilities.join(', '),
      numbers: { callbacks: unsolicited.length, windowMs: PROBE.QUIET_WINDOW_MS },
    });
    return { quiet: false, unsolicited: unsolicited.length };
  }

  report('P3', 'OK', `${light.ref.name}: quiet for ${PROBE.QUIET_WINDOW_MS}ms`);
  return { quiet: true, unsolicited: 0 };
}

// ------------------------------------------------------- P4: writing to the dark

/** Does this error mean the integration declined the write, rather than failed it? */
const DECLINED = /soft off|may not have effect|not.*reachable|unreachable|offline/i;

/**
 * What a lamp does with a value it is given while switched off.
 *
 * Platform §6 records three outcomes and the app leans on all three: pre-staging
 * needs "stays off and takes it", `impliesOn` is built on "a dim write turns it
 * on", and `probePreStage` exists because a Hue Bridge answers "soft off" and
 * declines. This step separates them, per axis, and adds the fourth that nobody
 * had looked for: accepted, stayed off, and nothing landed — which is the worst
 * of the four, because `commitDesired` runs on `ok: true` and the app now plans
 * from a value the lamp never took.
 *
 * The lamp must already be off, and each axis re-confirms that with a fresh read
 * rather than trusting the axis before it — one that turned the lamp on would
 * otherwise make every axis after it meaningless.
 *
 * @param {any} api
 * @param {Light} light
 */
async function stepOffPhase(api, light) {
  const has = /** @param {string} c */ (c) => (light.handle.capabilities ?? []).includes(c);

  /** @type {Array<{ capability: string, value: number, mode: string | null, onCode: keyof typeof FINDINGS }>} */
  const axes = [];
  if (has('dim')) {
    axes.push({ capability: 'dim', value: 0.5, mode: null, onCode: 'OFF_DIM_TURNS_ON' });
  }
  if (has('light_temperature')) {
    axes.push({
      capability: 'light_temperature', value: 0.5,
      mode: has('light_mode') ? 'temperature' : null,
      onCode: 'OFF_TEMP_TURNS_ON',
    });
  }
  if (has('light_hue')) {
    axes.push({
      capability: 'light_hue', value: 0.6,
      mode: has('light_mode') ? 'color' : null,
      onCode: 'OFF_COLOR_TURNS_ON',
    });
  }

  /** @type {any[]} */
  const outcomes = [];

  for (const axis of axes) {
    /**
     * Darkness is re-established per axis, not assumed.
     *
     * The first version skipped an axis when the lamp was already back on, which
     * sounds careful and threw away the two interesting measurements: a Hue lamp
     * comes on for the FIRST axis (`dim` implies on), so temperature and colour
     * were never once asked the question this step exists to ask. Switching it
     * back off costs two seconds and is the same transition the step already
     * makes.
     */
    let stillOff = await capabilityValue(api, light.ref.id, 'onoff');
    if (stillOff === true) {
      note(`the lamp came back on — switching it off again for ${axis.capability}`);
      await write(light, 'onoff', false);
      await sleep(THRESHOLDS.SETTLE_MS);
      stillOff = await capabilityValue(api, light.ref.id, 'onoff');
    }
    if (stillOff === true) {
      report('P4', 'SKIPPED', `${axis.capability}: the lamp will not stay off`);
      outcomes.push({ capability: axis.capability, outcome: 'would not stay off' });
      continue;
    }

    // The mode write is an enabler, never judged: a lamp may keep reporting the
    // old mode while accepting the value that follows.
    if (axis.mode !== null) await write(light, 'light_mode', axis.mode);

    const written = await write(light, axis.capability, axis.value);

    await sleep(THRESHOLDS.PRE_STAGE_CHECK_MS);
    const early = await readAll(api, light.ref.id, ['onoff', axis.capability]);
    await sleep(THRESHOLDS.SETTLE_MS - THRESHOLDS.PRE_STAGE_CHECK_MS);
    const late = await readAll(api, light.ref.id, ['onoff', axis.capability]);

    const cameOn = early.values.onoff === true || late.values.onoff === true;
    const held = Number(late.values[axis.capability]);
    const landed = Number.isFinite(held)
      && Math.abs(held - axis.value) <= THRESHOLDS.LAMP_TOLERANCE;

    /** @type {string} */
    let verdict;
    if (!written.ok && DECLINED.test(written.error ?? '')) {
      verdict = 'declined';
      finding(light, 'OFF_WRITE_DECLINED', {
        step: 'P4', capability: axis.capability,
        observed: written.error ?? 'the integration refused the write',
        evidence: [written.seq],
      });
    } else if (!written.ok) {
      verdict = 'failed';
      finding(light, 'OFF_WRITE_DECLINED', {
        step: 'P4', capability: axis.capability,
        observed: `the write failed: ${written.error ?? 'no message'}`,
        evidence: [written.seq],
      });
    } else if (cameOn) {
      verdict = 'came on';
      finding(light, axis.onCode, {
        step: 'P4', capability: axis.capability,
        observed: `written ${round(axis.value)} while off and the lamp came on `
          + `${early.values.onoff === true ? 'within' : 'after'} `
          + `${THRESHOLDS.PRE_STAGE_CHECK_MS}ms`,
        evidence: [written.seq],
      });
    } else if (landed) {
      verdict = 'staged';
      finding(light, 'OFF_STAGED', {
        step: 'P4', capability: axis.capability,
        observed: `took ${round(held)} while off and stayed off`,
        evidence: [written.seq],
      });
      if (axis.capability === 'dim') {
        finding(light, 'OFF_DIM_STAYS_OFF', {
          step: 'P4', capability: 'dim',
          observed: 'a dim write did not turn the lamp on, so impliesOn will send a second write',
          evidence: [written.seq],
        });
      }
    } else {
      verdict = 'swallowed';
      finding(light, 'OFF_WRITE_SWALLOWED', {
        step: 'P4', capability: axis.capability,
        observed: `accepted ${round(axis.value)}, stayed off, holds ${round(held)}`,
        numbers: { wrote: axis.value, held },
        evidence: [written.seq],
        needsChange: true,
      });
      if (axis.capability === 'dim') {
        finding(light, 'OFF_DIM_STAYS_OFF', {
          step: 'P4', capability: 'dim',
          observed: 'a dim write did not turn the lamp on',
          evidence: [written.seq],
        });
      }
    }

    outcomes.push({ capability: axis.capability, outcome: verdict, wrote: axis.value, held });
    report('P4', 'OK', `${axis.capability} while off: ${verdict}`);
  }

  // Does a write the lamp cannot act on still echo? The app's dedupe only covers
  // an exact repeat inside 1500ms, so a lamp that answers a no-op is one more
  // pass through applyExternalChange for nothing.
  const from = performance.now();
  await write(light, 'onoff', false);
  await sleep(THRESHOLDS.ECHO_DEDUPE_MS);
  const noopEchoes = echoesSince(light, 'onoff', from);
  if (noopEchoes.length > 0) {
    finding(light, 'OFF_NOOP_ECHOES', {
      step: 'P4', capability: 'onoff',
      observed: `${noopEchoes.length} echo(es) for an onoff write the lamp already satisfied`,
      numbers: { echoes: noopEchoes.length },
    });
  }

  return { axes: outcomes, noopEchoes: noopEchoes.length };
}

// ------------------------------------------------------- P5a: the echo shape

/**
 * How this lamp answers a change, and how fast.
 *
 * Measured on a value that actually CHANGES. An idempotent write is the wrong
 * instrument: a lamp that correctly says nothing when nothing changed would be
 * recorded as never echoing, which is a fabricated quirk of exactly the kind
 * this script exists to avoid producing.
 *
 * @param {any} api
 * @param {Light} light
 */
async function stepEchoShape(api, light) {
  const has = /** @param {string} c */ (c) => (light.handle.capabilities ?? []).includes(c);
  const capability = has('dim') ? 'dim' : 'onoff';

  const current = await capabilityValue(api, light.ref.id, capability);
  /** @type {boolean | number} */
  let target;
  if (capability === 'dim') {
    const now = Number.isFinite(Number(current)) ? Number(current) : 0.5;
    target = now > 0.5 ? Math.max(0.1, now - 0.25) : Math.min(1, now + 0.25);
  } else {
    target = current !== true;
  }

  const from = performance.now();
  const written = await write(light, capability, target);
  await sleep(PROBE.ECHO_WINDOW_MS);
  const echoes = echoesSince(light, capability, from);

  /**
   * Both findings below are about a write that LANDED, and neither used to
   * check.
   *
   * On an IKEA outlet that rejected all four of its writes after a nine-second
   * timeout, this step published `ECHO_ACK_SLOW "acked in 9017ms"` — which is a
   * timeout, not an ack — and then `ECHO_NONE` at HIGH severity for "a value
   * that changed", which had not changed, because the write failed. The
   * docblock above warns against "a fabricated quirk of exactly the kind this
   * script exists to avoid producing", and then this produced two.
   */
  if (!written.ok) {
    report('P5a', 'SKIPPED', `the ${capability} write was rejected, so its echo proves nothing: `
      + `${written.error}`);
    return { capability, echoes: echoes.length, firstEchoMs: null, wrote: false };
  }

  if (written.ms > PROBE.SLOW_ACK_MS) {
    finding(light, 'ECHO_ACK_SLOW', {
      step: 'P5a', capability,
      observed: `setCapabilityValue acked in ${written.ms}ms`,
      numbers: { ackMs: written.ms, threshold: PROBE.SLOW_ACK_MS },
      evidence: [written.seq],
    });
  }

  if (echoes.length === 0) {
    finding(light, 'ECHO_NONE', {
      step: 'P5a', capability,
      observed: `no callback in ${PROBE.ECHO_WINDOW_MS}ms after a value that changed`,
      evidence: [written.seq],
    });
    return { capability, echoes: 0, firstEchoMs: null };
  }

  const firstEchoMs = Math.round(echoes[0].at - from);
  const bucket = light.latency[capability]
    ?? (light.latency[capability] = { ack: [], failed: [], firstEcho: [] });
  bucket.firstEcho.push(firstEchoMs);

  if (firstEchoMs > THRESHOLDS.SETTLE_MS) {
    finding(light, 'ECHO_LATE', {
      step: 'P5a', capability,
      observed: `first echo after ${firstEchoMs}ms, past SETTLE_MS — a curve would read our own `
        + 'write as a human override',
      numbers: { firstEchoMs, settleMs: THRESHOLDS.SETTLE_MS },
      severity: 'high',
      evidence: [written.seq],
    });
  } else if (firstEchoMs > THRESHOLDS.ECHO_DEDUPE_MS) {
    finding(light, 'ECHO_LATE', {
      step: 'P5a', capability,
      observed: `first echo after ${firstEchoMs}ms, past the ${THRESHOLDS.ECHO_DEDUPE_MS}ms `
        + 'dedupe window',
      numbers: { firstEchoMs, dedupeMs: THRESHOLDS.ECHO_DEDUPE_MS },
      evidence: [written.seq],
    });
  }

  finding(light, 'ECHO_COUNT', {
    step: 'P5a', capability,
    observed: `${echoes.length} echo(es) for one write, first at ${firstEchoMs}ms`,
    numbers: { echoes: echoes.length, firstEchoMs },
    evidence: [written.seq],
  });

  report('P5a', 'OK', `${capability}: ack ${written.ms}ms, ${echoes.length} echo(es), `
    + `first at ${firstEchoMs}ms`);
  return { capability, echoes: echoes.length, firstEchoMs };
}

// ----------------------------------------------------------- P5b/c/e: ladders

/** Which finding each axis reports the same defect under. */
const LADDER_CODES = /** @type {const} */ ({
  dim: {
    scale: 'DIM_SCALE_MISMATCH', inverted: 'DIM_REPORT_INVERTED',
    quant: 'DIM_QUANT_OVER_TOLERANCE', quantHard: 'DIM_QUANT_OVER_LAMP_TOLERANCE',
    monotone: 'DIM_NON_MONOTONIC',
  },
  light_temperature: {
    scale: 'TEMP_SCALE_MISMATCH', inverted: 'TEMP_REPORT_INVERTED',
    quant: 'TEMP_QUANT_OVER_TOLERANCE', quantHard: 'TEMP_QUANT_OVER_LAMP_TOLERANCE',
    monotone: 'TEMP_NON_MONOTONIC',
  },
  light_hue: {
    quant: 'COLOR_QUANT_OVER_STEP',
  },
});

/**
 * Hue is a wheel: 0.98 and 0.01 are close.
 *
 * The palette compares hue the short way round for the same reason
 * (`lib/circadian/palette.ts normaliseHue()`), so a linear delta here would report every
 * wrap as a huge error and bury the one case that matters — a lamp that CLAMPS
 * instead of wrapping.
 *
 * @param {number} held
 * @param {number} wrote
 */
export function nearestCyclic(held, wrote) {
  const candidates = [held - 1, held, held + 1];
  return candidates.reduce((best, c) =>
    Math.abs(c - wrote) < Math.abs(best - wrote) ? c : best, candidates[0]);
}

/**
 * Walk one axis up through the values the lamp says it can take.
 *
 * The rungs are clamped and quantised through the lamp's OWN declared metadata
 * first, exactly as the planner does — so anything left over afterwards is the
 * lamp disagreeing with its own declaration, rather than this script writing
 * something out of range and calling the refusal a quirk.
 *
 * One rung every 2.5s, which is deliberately far slower than anything the app
 * does. This is the measurement; `stress` is the stress.
 *
 * @param {any} api
 * @param {Light} light
 * @param {{ capability: 'dim'|'light_temperature'|'light_hue'|'light_saturation',
 *           values: readonly number[], mode: string | null, step: string, cyclic?: boolean }} spec
 */
async function runLadder(api, light, spec) {
  const options = light.declared[spec.capability] ?? {};
  const rungs = ladderRungs(spec.values, {
    min: options.min ?? null, max: options.max ?? null, decimals: options.decimals ?? null,
  });

  /** @type {Array<{ wrote: number, held: unknown, settledMs: number | null, seq: number }>} */
  const samples = [];

  for (const rung of rungs) {
    // The ladder already skips a rung whose write was rejected, which is why
    // it reported an honest `n: 0` on the unreachable lamp while the steps
    // around it were inventing verdicts. Stopping outright once the demotion
    // fires just saves the remaining rungs.
    if (light.confounded || light.unreachable) break;
    if (spec.mode !== null) await write(light, 'light_mode', spec.mode);
    const written = await write(light, spec.capability, rung);
    if (!written.ok) {
      observation(light, 'error', {
        capability: spec.capability, value: rung, error: written.error,
      });
      continue;
    }
    const settled = await observe(api, light.ref.id, spec.capability, rung);
    const held = spec.cyclic && Number.isFinite(Number(settled.value))
      ? nearestCyclic(Number(settled.value), rung)
      : settled.value;
    /**
     * "Changed" means the READING moved, not that it disagreed with us.
     *
     * The first version added to `changed` when the held value differed from the
     * value written — which is backwards. A perfectly obedient lamp reports
     * exactly what it was sent on every rung, so it never counted as having
     * moved, and two things that depend on this went wrong: a no-change finding
     * was downgraded to inconclusive on the most trustworthy lamp in the house,
     * and `PROBE_SUSPECT_CACHE` — the check that catches a stale read
     * (platform §15) — would have fired on a run where every read was live and
     * correct.
     */
    const previous = samples[samples.length - 1];
    if (previous !== undefined && Number(previous.held) !== Number(held)) {
      light.changed.add(spec.capability);
    }
    samples.push({ wrote: rung, held, settledMs: settled.settledMs, seq: written.seq });
    await sleep(PROBE.LADDER_GAP_MS);
  }

  const analysis = analyseLadder(samples);
  if (analysis.maxDelta !== null) light.quantisation[spec.capability] = analysis.maxDelta;

  const codes = /** @type {any} */ (LADDER_CODES)[spec.capability] ?? {};
  const evidence = samples.map(s => s.seq);
  const deltaThreshold = spec.capability === 'light_hue'
    ? THRESHOLDS.COLOR_STEP
    : THRESHOLDS.OVERRIDE_TOLERANCE;

  if (analysis.scaleFactor !== null && codes.scale) {
    finding(light, codes.scale, {
      step: spec.step, capability: spec.capability,
      observed: `reports about ${analysis.scaleFactor}x what it is written `
        + `(wrote ${round(samples[0]?.wrote)}, held ${round(samples[0]?.held)})`,
      numbers: { scaleFactor: analysis.scaleFactor, samples: analysis.n },
      evidence,
    });
  } else if (analysis.inverted && codes.inverted) {
    finding(light, codes.inverted, {
      step: spec.step, capability: spec.capability,
      observed: `reports roughly 1 minus the value written across ${analysis.n} rungs`,
      numbers: { samples: analysis.n },
      evidence,
    });
  } else if (analysis.maxDelta !== null && analysis.maxDelta > deltaThreshold) {
    const hard = analysis.maxDelta > THRESHOLDS.LAMP_TOLERANCE && codes.quantHard;
    finding(light, hard ? codes.quantHard : codes.quant, {
      step: spec.step, capability: spec.capability,
      observed: `max delta ${analysis.maxDelta} over ${analysis.n} rungs, against a threshold of `
        + `${deltaThreshold}`,
      numbers: {
        maxDelta: analysis.maxDelta, threshold: deltaThreshold, samples: analysis.n,
        effectiveMin: analysis.effectiveMin, effectiveMax: analysis.effectiveMax,
      },
      evidence,
      confidence: light.ref.suspectedGroup ? 'inconclusive' : 'measured',
    });
  }

  if (analysis.monotone === false && codes.monotone) {
    finding(light, codes.monotone, {
      step: spec.step, capability: spec.capability,
      observed: `a rising ladder reported a fall of more than ${THRESHOLDS.OVERRIDE_TOLERANCE}`,
      numbers: { samples: analysis.n },
      evidence,
    });
  }

  report(spec.step, 'OK', `${spec.capability}: ${analysis.n} rungs, ${analysis.distinct} distinct, `
    + `held ${round(analysis.effectiveMin)}-${round(analysis.effectiveMax)}, `
    + `max delta ${analysis.maxDelta}`);

  return { rungs, samples, analysis };
}

/** The rungs. Seven is enough to see a shape and few enough to sit through. */
const DIM_LADDER = [0.03, 0.10, 0.33, 0.50, 0.67, 0.93, 1.00];
const TEMP_LADDER = [0.00, 0.15, 0.35, 0.50, 0.70, 0.85, 1.00];
const HUE_LADDER = [0.00, 0.02, 0.25, 0.50, 0.75, 0.98];
const SAT_LADDER = [0.05, 0.30, 0.60, 1.00];

/**
 * The three value axes, in the order that hands each step its precondition.
 *
 * `dim` first because it is the quietest. Then temperature, which leaves the lamp
 * in temperature mode — which is what `modes` needs to test the gate in the
 * interesting direction. Colour last, because it leaves the lamp somewhere a
 * person would notice, and the restore is next.
 *
 * `dim: 0` is deliberately not a rung: many lamps read it as off, and a power
 * change in the middle of a brightness ladder confounds everything after it.
 *
 * @param {any} api
 * @param {Light} light
 */
async function stepAxes(api, light) {
  const has = /** @param {string} c */ (c) => (light.handle.capabilities ?? []).includes(c);
  /** @type {Record<string, any>} */
  const derived = {};

  if (has('dim')) {
    const dim = await runLadder(api, light, {
      capability: 'dim', values: DIM_LADDER, mode: null, step: 'P5b',
    });
    derived.dim = dim.analysis;

    const options = light.declared.dim ?? {};
    // Through clampToRange rather than Number(), for the reason its docblock
    // gives: an undeclared bound is not a bound of zero.
    const declaredMin = clampToRange(0, options.min ?? null, options.max ?? null);
    const declaredMax = clampToRange(1, options.min ?? null, options.max ?? null);
    const lowestRung = Math.min(...dim.rungs);
    const highestRung = Math.max(...dim.rungs);

    if (dim.analysis.effectiveMin !== null
      && dim.analysis.effectiveMin > lowestRung + THRESHOLDS.OVERRIDE_TOLERANCE) {
      finding(light, 'DIM_UNDECLARED_FLOOR', {
        step: 'P5b', capability: 'dim',
        observed: `asked for ${round(lowestRung)} (declared min ${declaredMin}) and never went `
          + `below ${round(dim.analysis.effectiveMin)}`,
        numbers: { declaredMin, effectiveMin: dim.analysis.effectiveMin },
      });
    }
    if (dim.analysis.effectiveMax !== null
      && dim.analysis.effectiveMax < highestRung - THRESHOLDS.OVERRIDE_TOLERANCE) {
      finding(light, 'DIM_UNDECLARED_CEILING', {
        step: 'P5b', capability: 'dim',
        observed: `asked for ${round(highestRung)} (declared max ${declaredMax}) and never went `
          + `above ${round(dim.analysis.effectiveMax)}`,
        numbers: { declaredMax, effectiveMax: dim.analysis.effectiveMax },
      });
    }

    /**
     * A declared resolution can only be caught being too COARSE, and only
     * against the ladder's own spacing.
     *
     * This ladder's rungs are 0.07 apart at their closest, so the smallest gap
     * between distinct held values is 0.07 on a lamp that reports every rung
     * back perfectly — and comparing that against a declared step of 0.01
     * reported "declares decimals 2 and resolves to 0.07" on the best-behaved
     * lamp on the Homey. The measurement simply is not available at this
     * spacing: proving a lamp resolves to 0.01 would need rungs 0.01 apart.
     *
     * What IS available is the opposite: a lamp that collapsed rungs the ladder
     * kept distinct is coarser than it claims, and that is worth reporting
     * because `quantise()` rounds to the declared step and the app then believes
     * it moved the lamp.
     */
    const decimals = Number(options.decimals);
    const gaps = dim.rungs.slice(1).map((rung, i) => rung - dim.rungs[i]);
    const closestRungs = gaps.length > 0 ? Math.min(...gaps) : null;
    if (Number.isFinite(decimals) && dim.analysis.resolution !== null && closestRungs !== null
      && dim.analysis.resolution > closestRungs * 1.5) {
      finding(light, 'DIM_DECIMALS_LIE', {
        step: 'P5b', capability: 'dim',
        observed: `declares decimals ${decimals} (step ${Math.pow(10, -decimals)}), and rungs `
          + `${round(closestRungs)} apart collapsed to steps of ${dim.analysis.resolution}`,
        numbers: {
          declaredStep: Math.pow(10, -decimals),
          measured: dim.analysis.resolution,
          closestRungs,
        },
      });
    }
  }

  if (has('light_temperature')) {
    const temp = await runLadder(api, light, {
      capability: 'light_temperature', values: TEMP_LADDER,
      mode: has('light_mode') ? 'temperature' : null, step: 'P5c',
    });
    derived.light_temperature = temp.analysis;

    const lowestRung = Math.min(...temp.rungs);
    const highestRung = Math.max(...temp.rungs);
    const narrowLow = temp.analysis.effectiveMin !== null
      && temp.analysis.effectiveMin > lowestRung + THRESHOLDS.OVERRIDE_TOLERANCE;
    const narrowHigh = temp.analysis.effectiveMax !== null
      && temp.analysis.effectiveMax < highestRung - THRESHOLDS.OVERRIDE_TOLERANCE;
    if (narrowLow || narrowHigh) {
      finding(light, 'TEMP_UNDECLARED_RANGE', {
        step: 'P5c', capability: 'light_temperature',
        observed: `asked ${round(lowestRung)}-${round(highestRung)}, held `
          + `${round(temp.analysis.effectiveMin)}-${round(temp.analysis.effectiveMax)}`,
        numbers: {
          effectiveMin: temp.analysis.effectiveMin, effectiveMax: temp.analysis.effectiveMax,
        },
      });
    }
    if (temp.analysis.n >= 5 && temp.analysis.distinct <= 3) {
      finding(light, 'TEMP_COLLAPSED', {
        step: 'P5c', capability: 'light_temperature',
        observed: `${temp.analysis.n} rungs held only ${temp.analysis.distinct} distinct values`,
        numbers: { rungs: temp.analysis.n, distinct: temp.analysis.distinct },
      });
    }
  }

  return derived;
}

/**
 * The colour axes, which have to run after the mode step.
 *
 * Separate from `stepAxes` because a colour write puts the lamp in colour mode
 * and the mode step needs it in the other one first (platform §6). Saturation is
 * pinned at 0.8 through the hue ladder so the two are measured one at a time.
 *
 * @param {any} api
 * @param {Light} light
 */
async function stepColour(api, light) {
  const has = /** @param {string} c */ (c) => (light.handle.capabilities ?? []).includes(c);
  if (!has('light_hue')) return null;

  if (has('light_mode')) await write(light, 'light_mode', 'color');
  if (has('light_saturation')) await write(light, 'light_saturation', 0.8);
  await sleep(PROBE.LADDER_GAP_MS);

  const hue = await runLadder(api, light, {
    capability: 'light_hue', values: HUE_LADDER,
    mode: has('light_mode') ? 'color' : null, step: 'P5e', cyclic: true,
  });

  /**
   * A hue sub-range only matters where the lamp declares one and the app would
   * have walked outside it.
   *
   * The earlier condition fired whenever a declared range existed at all, which
   * on a Hue bulb is 0-1 — so it reported "declares 0-1 and held 0.000-0.980"
   * as a clamp, on a lamp that had honoured every rung. The finding is about
   * `planColor` ignoring a range it should honour, so there has to be a range
   * worth honouring first.
   */
  const options = light.declared.light_hue ?? {};
  const declaredMin = options.min === undefined || options.min === null ? 0 : Number(options.min);
  const declaredMax = options.max === undefined || options.max === null ? 1 : Number(options.max);
  const nonUnit = declaredMin !== 0 || declaredMax !== 1;
  if (nonUnit && hue.analysis.effectiveMin !== null) {
    finding(light, 'COLOR_HUE_CLAMPED_TO_DECLARED', {
      step: 'P5e', capability: 'light_hue',
      observed: `declares ${declaredMin}-${declaredMax} and held `
        + `${round(hue.analysis.effectiveMin)}-${round(hue.analysis.effectiveMax)}; planColor `
        + 'clamps to 0-1 and ignores the declaration',
      numbers: { declaredMin, declaredMax },
    });
  }

  // The top rung is 0.98. A wheel reports it as 0.98 or as something just below
  // zero; a lamp that CLAMPS reports something visibly lower and loses the whole
  // magenta end of the palette.
  const top = hue.samples.find(s => s.wrote === Math.max(...hue.rungs));
  if (top && Number.isFinite(Number(top.held))) {
    const held = Number(top.held);
    const distance = Math.abs(nearestCyclic(held, top.wrote) - top.wrote);
    if (distance > THRESHOLDS.LAMP_TOLERANCE) {
      finding(light, 'COLOR_WRAP_CLAMPED', {
        step: 'P5e', capability: 'light_hue',
        observed: `wrote ${round(top.wrote)} near the top of the wheel and held ${round(held)}`,
        numbers: { wrote: top.wrote, held, distance: Number(distance.toFixed(4)) },
        evidence: [top.seq],
      });
    }
  }

  if (hue.analysis.maxDelta !== null && hue.analysis.maxDelta > THRESHOLDS.HUE_FLOOR) {
    finding(light, 'COLOR_GAMUT_SNAP', {
      step: 'P5e', capability: 'light_hue',
      observed: `reported hue sits up to ${hue.analysis.maxDelta} from the hue written`,
      numbers: { maxDelta: hue.analysis.maxDelta },
    });
  }

  /** @type {any} */
  let sat = null;
  if (has('light_saturation')) {
    sat = await runLadder(api, light, {
      capability: 'light_saturation', values: SAT_LADDER, mode: null, step: 'P5e',
    });
    const lowestRung = Math.min(...sat.rungs);
    if (sat.analysis.effectiveMin !== null
      && sat.analysis.effectiveMin > lowestRung + THRESHOLDS.OVERRIDE_TOLERANCE) {
      finding(light, 'COLOR_SAT_FLOOR', {
        step: 'P5e', capability: 'light_saturation',
        observed: `asked for ${round(lowestRung)} and never went below `
          + `${round(sat.analysis.effectiveMin)}`,
        numbers: { effectiveMin: sat.analysis.effectiveMin },
      });
    }
  }

  return { hue: hue.analysis, saturation: sat?.analysis ?? null };
}

// -------------------------------------------------- P5f: the brightness floor

/**
 * The exact value the app writes for its own minimum brightness.
 *
 * `MINIMUM_BRIGHTNESS` is 0.1 PERCEPTUAL, which through γ=2.2 is a device value
 * of about 0.0063 — and `litDim()` exists to promise that a positive request for
 * light stays light. Whether it does is a fact about the lamp: a machine cannot
 * say whether 0.0063 LOOKS lit, but it can say whether the lamp answered by
 * switching itself off.
 *
 * @param {any} api
 * @param {Light} light
 */
async function stepBrightnessFloor(api, light) {
  if (!(light.handle.capabilities ?? []).includes('dim')) return null;

  const options = light.declared.dim ?? {};
  const raw = toDevice(THRESHOLDS.MINIMUM_BRIGHTNESS);
  const value = quantise(clampToRange(raw, options.min ?? null, options.max ?? null),
    options.decimals ?? null);

  await write(light, 'onoff', true);
  await sleep(PROBE.LADDER_GAP_MS);
  const written = await write(light, 'dim', value);
  await sleep(THRESHOLDS.SETTLE_MS);
  const after = await readAll(api, light.ref.id, ['onoff', 'dim']);

  const wentDark = after.values.onoff !== true || Number(after.values.dim) === 0;
  // Reported back on the perceptual axis as well, because that is the axis the
  // sliders and the stored plans are on: a lamp that quantised 0.0063 up to 0.01
  // is at 0.14 perceptual, not at 0.10, and the difference is what the user set.
  const heldPerceptual = toPerceptual(Number(after.values.dim));

  if (wentDark) {
    finding(light, 'DIM_MIN_GOES_DARK', {
      step: 'P5f', capability: 'dim',
      observed: `wrote ${round(value)} (perceptual ${THRESHOLDS.MINIMUM_BRIGHTNESS} through gamma `
        + `${THRESHOLDS.GAMMA}) and the lamp reports onoff ${String(after.values.onoff)}, dim `
        + `${round(after.values.dim)}`,
      numbers: { wrote: value, heldDim: Number(after.values.dim) },
      evidence: [written.seq],
    });
  } else {
    report('P5f', 'OK', `minimum brightness ${round(value)}: still on, holds `
      + `${round(after.values.dim)} (perceptual ${round(heldPerceptual)})`);
  }

  return {
    wrote: value,
    onoff: after.values.onoff,
    dim: after.values.dim,
    heldPerceptual: Number.isFinite(heldPerceptual) ? Number(heldPerceptual.toFixed(3)) : null,
  };
}

// ------------------------------------------------------------- P5d: the gate

/**
 * The mode gate, and the one question in this script that can indict the app.
 *
 * Platform §6 established that a lamp in the wrong `light_mode` silently
 * discards the value the other mode owns, and the fix was to emit `light_mode`
 * ahead of it. What was never checked is whether emitting it back-to-back is
 * ENOUGH: `runFlush` awaits the two writes with nothing between them
 * (`lib/outputs/command-scheduler.ts runFlush()`), and if an integration needs the mode
 * to settle first then the value is thrown away exactly as before, with the fix
 * in place and looking correct.
 *
 * So: reproduce the flush, and only if it fails, find the smallest gap that
 * works. That number is a measurement, not a recommendation.
 *
 * @param {any} api
 * @param {Light} light
 */
async function stepModes(api, light) {
  const has = /** @param {string} c */ (c) => (light.handle.capabilities ?? []).includes(c);
  if (!has('light_mode') || !has('light_temperature') || !has('light_hue')) return null;

  const landed = /** @param {unknown} held @param {number} wanted */ (held, wanted) =>
    Number.isFinite(Number(held)) && Math.abs(Number(held) - wanted) <= THRESHOLDS.LAMP_TOLERANCE;

  // 1. Put the lamp firmly in colour mode, so a temperature has a gate to fail.
  await write(light, 'light_mode', 'color');
  await write(light, 'light_hue', 0.6);
  if (has('light_saturation')) await write(light, 'light_saturation', 0.8);
  await sleep(THRESHOLDS.SETTLE_MS);

  // 2. A temperature with NO mode write. This is the bug as it was found.
  const bare = await write(light, 'light_temperature', 0.5);
  const afterBare = await observe(api, light.ref.id, 'light_temperature', 0.5);

  /**
   * A REJECTED write and a DISCARDED one are the same picture from here: in
   * both, the lamp goes on reporting the value it already held.
   *
   * On the unreachable reference lamp the bare write failed and the lamp
   * happened to be sitting at 0.5 already, so `landed()` said yes and this step
   * published `MODE_DOES_NOT_GATE` — an INFO finding whose whole point is that
   * it can overturn platform §6. It was drawn from a temperature that never
   * left the house.
   */
  if (!bare.ok) {
    report('P5d', 'SKIPPED', `the bare temperature write was rejected, so the gate cannot be `
      + `judged: ${bare.error}`);
    return { gatesTemperature: null, smallestGapMs: null, gatesHue: null, wrote: false };
  }

  const gated = !landed(afterBare.value, 0.5);

  /** @type {any} */
  const derived = { gatesTemperature: gated, smallestGapMs: null, gatesHue: null };

  if (gated) {
    finding(light, 'MODE_GATES_TEMP', {
      step: 'P5d', capability: 'light_temperature',
      observed: `wrote 0.500 in colour mode and the lamp holds ${round(afterBare.value)}`,
      numbers: { wrote: 0.5, held: Number(afterBare.value) },
      evidence: [bare.seq],
    });

    // 3. Now with the mode, at the app's own cadence: no gap at all.
    /** @type {Array<number>} */
    const gaps = [0, 500, 1500];
    for (const gap of gaps) {
      await write(light, 'light_mode', 'color');
      await write(light, 'light_hue', 0.6);
      await sleep(THRESHOLDS.SETTLE_MS);

      await write(light, 'light_mode', 'temperature');
      if (gap > 0) await sleep(gap);
      const attempt = await write(light, 'light_temperature', 0.5);
      const settled = await observe(api, light.ref.id, 'light_temperature', 0.5);

      if (landed(settled.value, 0.5)) {
        derived.smallestGapMs = gap;
        if (gap > 0) {
          finding(light, 'MODE_NEEDS_DELAY', {
            step: 'P5d', capability: 'light_temperature',
            observed: `the temperature landed only with a ${gap}ms gap after the light_mode `
              + 'write; the scheduler leaves none',
            numbers: { gapMs: gap, schedulerGapMs: 0 },
            evidence: [attempt.seq],
          });
        } else {
          report('P5d', 'OK', 'light_mode then light_temperature back-to-back: landed');
        }
        break;
      }
    }

    if (derived.smallestGapMs === null) {
      report('P5d', 'FAILED', 'the temperature never landed, with or without a gap — this lamp '
        + 'cannot be driven on both axes');
    }
  } else {
    finding(light, 'MODE_DOES_NOT_GATE', {
      step: 'P5d', capability: 'light_temperature',
      observed: 'a temperature landed with the lamp in colour mode and no mode write',
      evidence: [bare.seq],
      needsChange: true,
    });
  }

  // 4. The mirror. The lamp is in temperature mode now if step 3 succeeded.
  await write(light, 'light_mode', 'temperature');
  await write(light, 'light_temperature', 0.5);
  await sleep(THRESHOLDS.SETTLE_MS);
  const bareHue = await write(light, 'light_hue', 0.3);
  const afterHue = await observe(api, light.ref.id, 'light_hue', 0.3);
  // Same reasoning as the temperature leg above: a rejection is not a discard.
  derived.gatesHue = bareHue.ok ? !landed(afterHue.value, 0.3) : null;
  if (derived.gatesHue) {
    finding(light, 'MODE_GATES_HUE', {
      step: 'P5d', capability: 'light_hue',
      observed: `wrote 0.300 in temperature mode and the lamp holds ${round(afterHue.value)}`,
      numbers: { wrote: 0.3, held: Number(afterHue.value) },
      evidence: [bareHue.seq],
    });
  }

  // 5. Did that bare hue write move the reported mode by itself? This is why a
  // restore has to be mode-aware rather than value-ordered.
  const reported = await capabilityValue(api, light.ref.id, 'light_mode');
  if (reported === 'color') {
    finding(light, 'MODE_IMPLICIT_SWITCH', {
      step: 'P5d', capability: 'light_mode',
      observed: 'a hue write with no mode write left the lamp reporting colour mode',
    });
  }

  // 6. And the enabler case: mode written, value landed, mode still says the old
  // thing. Not a failure — the reason light_mode is never asserted on.
  await write(light, 'light_mode', 'temperature');
  await sleep(THRESHOLDS.SETTLE_MS);
  const modeAfter = await capabilityValue(api, light.ref.id, 'light_mode');
  if (modeAfter !== 'temperature' && ENABLER_CAPABILITIES.has('light_mode')) {
    finding(light, 'MODE_NOT_REPORTED', {
      step: 'P5d', capability: 'light_mode',
      observed: `written "temperature" and reports "${String(modeAfter)}"`,
    });
  }
  derived.reportedMode = modeAfter;

  return derived;
}

// ---------------------------------------------------------- P5g: the cadence

/**
 * The scheduler's real output rate, sustained for as long as a ramp can last.
 *
 * One `dim` write every `minWriteIntervalMs` (200ms) for `HARD_STOP_MS` (10s) is
 * about fifty writes, which is what a held button produces after the coalescer
 * has collapsed the ramp engine's ten intents a second.
 *
 * The TRAJECTORY is a sawtooth rather than a single sweep, and that is a
 * deliberate departure worth being honest about: at 0.6 perceptual per second a
 * real ramp crosses the whole axis in under two seconds, so ten seconds of it is
 * ten seconds of writes at the end stop. Sweeping up and down keeps the value
 * moving for the whole window, which is what actually loads an integration. The
 * cadence and the velocity are the app's; the shape is not.
 *
 * @param {any} api
 * @param {Light} light
 * @param {number} [intervalMs]
 * @param {number} [durationMs]
 */
async function burst(api, light, intervalMs = THRESHOLDS.MIN_WRITE_INTERVAL_MS,
  durationMs = THRESHOLDS.HARD_STOP_MS) {
  const options = light.declared.dim ?? {};
  const perWrite = THRESHOLDS.RAMP_RATE_PER_SECOND * (intervalMs / 1000);

  const from = performance.now();
  /** @type {number[]} */
  const acks = [];
  /** @type {string[]} */
  const errors = [];
  let perceptual = 0.15;
  let rising = true;
  /** @type {number} */
  let lastValue = 0;

  while (performance.now() - from < durationMs) {
    // A lamp that died mid-burst is not worth the remaining ten seconds, and
    // the retries below would spend thirty more on it.
    if (light.unreachable) break;
    perceptual += rising ? perWrite : -perWrite;
    if (perceptual >= 1) { perceptual = 1; rising = false; }
    if (perceptual <= 0.1) { perceptual = 0.1; rising = true; }

    lastValue = quantise(clampToRange(toDevice(perceptual), options.min ?? null,
      options.max ?? null), options.decimals ?? null);
    const outcome = await write(light, 'dim', lastValue);
    // Landed writes only — `ackFirst`/`ackLast` are compared to each other to
    // find a queue building, and a burst of nine-second timeouts mixed in
    // measures the timeout rather than the lamp. See write().
    if (outcome.ok) acks.push(outcome.ms);
    if (!outcome.ok && outcome.error) errors.push(outcome.error);

    const spent = outcome.ms;
    if (spent < intervalMs) await sleep(intervalMs - spent);
  }

  const echoes = echoesSince(light, 'dim', from);
  const settled = await observe(api, light.ref.id, 'dim', lastValue, { windowMs: 8_000 });

  return { from, intervalMs, writes: acks.length, acks, errors, echoes, lastValue, settled };
}

/**
 * @param {any} api
 * @param {Light} light
 */
async function stepStress(api, light) {
  if (!(light.handle.capabilities ?? []).includes('dim')) return null;

  await write(light, 'onoff', true);
  await sleep(PROBE.LADDER_GAP_MS);

  const run = await burst(api, light);
  const first = percentiles(run.acks.slice(0, 10));
  const last = percentiles(run.acks.slice(-10));
  let clean = true;

  /**
   * A PARTIAL failure rate at the scheduler's cadence is the finding. All of
   * them failing is a lamp that is not there, and saying "writes failed at the
   * scheduler's default cadence" about it indicts the cadence for the radio.
   *
   * That is exactly what the first full run published as its headline critical:
   * 37 of 37 at 200ms, on a bulb that had already rejected 76 writes in the
   * phases before it. `PROBE_UNREACHABLE` owns that case now — and, because it
   * fires from write() after three, this step will not normally be reached on
   * such a lamp at all. The guard stays for the lamp that dies mid-burst.
   */
  if (run.errors.length > 0 && run.errors.length === run.writes) {
    clean = false;
    report('P5g', 'SKIPPED', `every one of ${run.writes} writes was rejected — a reachability `
      + `fact, not a cadence one: ${run.errors[0]}`);
  } else if (run.errors.length > 0) {
    clean = false;
    finding(light, 'RATE_ERRORS', {
      step: 'P5g', capability: 'dim',
      observed: `${run.errors.length} of ${run.writes} writes failed at `
        + `${run.intervalMs}ms: ${run.errors[0]}`,
      numbers: { failed: run.errors.length, writes: run.writes, intervalMs: run.intervalMs },
    });
  }

  if (first.p50 !== null && last.p50 !== null && last.p50 > first.p50 * 3 && last.p50 > 200) {
    clean = false;
    finding(light, 'RATE_LATENCY_INFLATION', {
      step: 'P5g', capability: 'dim',
      observed: `ack p50 went from ${first.p50}ms over the first ten writes to ${last.p50}ms over `
        + 'the last ten',
      numbers: { firstP50: first.p50, lastP50: last.p50, writes: run.writes },
    });
  }

  const tolerance = Math.max(THRESHOLDS.LAMP_TOLERANCE, light.quantisation.dim ?? 0);
  const finalDelta = Math.abs(Number(run.settled.value) - run.lastValue);
  if (Number.isFinite(finalDelta) && finalDelta > tolerance) {
    clean = false;
    finding(light, 'RATE_FINAL_VALUE_WRONG', {
      step: 'P5g', capability: 'dim',
      observed: `last write ${round(run.lastValue)}, lamp settled at `
        + `${round(run.settled.value)} after the burst`,
      numbers: { lastWrite: run.lastValue, settled: Number(run.settled.value), tolerance },
    });
  }

  if (run.settled.settledMs !== null && run.settled.settledMs > THRESHOLDS.SETTLE_MS) {
    clean = false;
    finding(light, 'RATE_SLOW_SETTLE', {
      step: 'P5g', capability: 'dim',
      observed: `took ${run.settled.settledMs}ms after the last write to reach it`,
      numbers: { settledMs: run.settled.settledMs, settleMs: THRESHOLDS.SETTLE_MS },
    });
  }

  const ratio = run.writes > 0 ? run.echoes.length / run.writes : 0;
  if (ratio > 2.5) {
    finding(light, 'RATE_ECHO_STORM', {
      step: 'P5g', capability: 'dim',
      observed: `${run.echoes.length} echoes for ${run.writes} writes (${ratio.toFixed(1)} each)`,
      numbers: { echoes: run.echoes.length, writes: run.writes },
    });
  }

  // An echo carrying an intermediate value, far from our latest write and late
  // enough to be outside the dedupe window, is how a ramp cancels itself.
  const stale = light.observations.filter(o => o.kind === 'echo'
    && o.capability === 'dim'
    && o.note === 'unattributed'
    && Number(o.mono) >= Math.round(run.from));
  if (stale.length > 0) {
    clean = false;
    finding(light, 'RATE_ECHO_MIDFLIGHT', {
      step: 'P5g', capability: 'dim',
      observed: `${stale.length} echo(es) during the burst were further than `
        + `${THRESHOLDS.OVERRIDE_TOLERANCE} from our latest write and later than `
        + `${THRESHOLDS.SETTLE_MS}ms after it`,
      numbers: { echoes: stale.length },
      evidence: stale.map(o => Number(o.seq)),
    });
  }

  report('P5g', 'OK', `${run.writes} writes at ${run.intervalMs}ms: ack p50 ${first.p50}ms -> `
    + `${last.p50}ms, ${run.echoes.length} echoes, settled ${round(run.settled.value)}`);

  /** @type {number | null} */
  let smallestClean = clean ? run.intervalMs : null;
  if (!clean) {
    // Three seconds is enough to see the same failure again, and short enough to
    // try twice. The number reported is a measurement of this integration, not
    // a proposal for the app.
    for (const intervalMs of [400, 1000]) {
      await sleep(PROBE.COOLDOWN_MS);
      const retry = await burst(api, light, intervalMs, 3_000);
      const retryLast = percentiles(retry.acks.slice(-5));
      const retryDelta = Math.abs(Number(retry.settled.value) - retry.lastValue);
      const ok = retry.errors.length === 0
        && (!Number.isFinite(retryDelta) || retryDelta <= tolerance)
        && (retryLast.p50 === null || retryLast.p50 < 3 * (first.p50 ?? retryLast.p50));
      report('P5g', 'INFO', `retried at ${intervalMs}ms: ${ok ? 'clean' : 'still not clean'}`);
      if (ok) {
        smallestClean = intervalMs;
        break;
      }
    }
  }

  return {
    intervalMs: run.intervalMs,
    writes: run.writes,
    errors: run.errors.length,
    ackFirst: first,
    ackLast: last,
    echoes: run.echoes.length,
    settled: Number(run.settled.value),
    settledMs: run.settled.settledMs,
    smallestCleanIntervalMs: smallestClean,
  };
}

// -------------------------------------------------------- P5i: asking a person

/**
 * The only sound answer to "is a high light_temperature actually warmer here".
 *
 * A driver that maps the axis backwards CONSISTENTLY — writes 1, lamp goes cold,
 * reports 1 — is invisible from an API, and platform §6's claim that higher is
 * warmer is load-bearing for the controller mapping, the schedule labels and the
 * direction a curve rises in. So the machine sets the two ends and a person says
 * which was which.
 *
 * Asked once per integration, because the direction is a property of the driver
 * rather than of a bulb, and answering it sixty times is how a prompt gets
 * dismissed without being read.
 *
 * @param {Light} light
 * @param {() => void} onCancel
 */
async function stepEyes(light, onCancel) {
  const has = /** @param {string} c */ (c) => (light.handle.capabilities ?? []).includes(c);
  if (!has('light_temperature')) return null;

  await write(light, 'onoff', true);
  if (has('light_mode')) await write(light, 'light_mode', 'temperature');
  if (has('dim')) await write(light, 'dim', 0.8);

  await write(light, 'light_temperature', 1);
  await sleep(THRESHOLDS.SETTLE_MS);
  console.log('');
  console.log(`  "${light.ref.name}" has just been written light_temperature 1.0, which this app`);
  console.log('  believes is the WARMEST end of the axis (platform §6).');
  const answer = (await askTerminal('  Does it look warm/orange rather than cold/blue? [y/n] ',
    onCancel)).toLowerCase();

  if (answer === '') return { asked: true, answer: null };

  const warm = answer.startsWith('y');
  if (!warm) {
    finding(light, 'EYES_TEMP_INVERTED', {
      step: 'P5i', capability: 'light_temperature',
      observed: 'a person says light_temperature 1.0 looks cold on this lamp',
      confidence: 'human',
    });
  } else {
    finding(light, 'EYES_TEMP_CONFIRMED', {
      step: 'P5i', capability: 'light_temperature',
      observed: 'a person confirms light_temperature 1.0 looks warm',
      confidence: 'human',
    });
  }

  return { asked: true, answer: warm ? 'warm' : 'cold' };
}

// ------------------------------------------------- run-level, not lamp-level

/**
 * A stand-in lamp for facts about the RUN.
 *
 * Three of the findings are about the probe rather than about a light —
 * uninstrumented echoes, a suspected stale cache, a redaction leak — and they
 * belong in the same list with the same severities, because the whole point of
 * `PROBE_SUSPECT_CACHE` is that it outranks everything printed above it.
 */
const RUN = newLight({ id: 'run', name: 'the run', class: 'light' }, '');

// --------------------------------------------------- one lamp, start to finish

/**
 * Run one step, and let the lamp survive it failing.
 *
 * A step that throws is a gap in the evidence, not a quirk, and it is recorded
 * as one — because a missing finding read as a clean result is the quietest way
 * for this script to mislead. `requires` is checked against a FRESH read rather
 * than against what the previous step believes it left behind.
 *
 * @template T
 * @param {Light} light
 * @param {string} id
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @param {{ requires?: () => Promise<string | null> }} [opts]
 * @returns {Promise<T | null>}
 */
async function runStep(light, id, name, fn, opts = {}) {
  if (light.confounded) {
    light.steps.push({ id, name, status: 'SKIPPED', ms: 0, reason: 'the lamp is confounded', derived: null });
    report(id, 'SKIPPED', `${name}: something else is driving this lamp`);
    return null;
  }

  if (light.unreachable) {
    light.steps.push({ id, name, status: 'SKIPPED', ms: 0, reason: 'the lamp is unreachable', derived: null });
    report(id, 'SKIPPED', `${name}: the lamp is rejecting every write`);
    return null;
  }

  if (opts.requires) {
    const unmet = await opts.requires();
    if (unmet !== null) {
      light.steps.push({ id, name, status: 'SKIPPED', ms: 0, reason: unmet, derived: null });
      report(id, 'SKIPPED', `${name}: ${unmet}`);
      return null;
    }
  }

  const started = performance.now();
  try {
    const derived = await fn();
    light.steps.push({
      id, name, status: 'OK', ms: Math.round(performance.now() - started), reason: null, derived,
    });
    return derived;
  } catch (error) {
    const message = redactKeyMaterial(messageOf(error));
    light.steps.push({
      id, name, status: 'FAILED', ms: Math.round(performance.now() - started),
      reason: message, derived: null,
    });
    observation(light, 'error', { error: message, note: id });
    report(id, 'FAILED', `${name}: ${message}`);
    finding(light, 'PROBE_STEP_FAILED', {
      step: id,
      observed: `${name} threw: ${message}`,
    });
    return null;
  }
}

/**
 * One lamp: snapshot, battery, restore, in that order and with the restore
 * guaranteed.
 *
 * The power state is transitioned ONCE. A lamp found on does its on-phase first
 * and is taken dark once, at the end, for the twenty seconds the off-phase
 * needs; a lamp found off does the off-phase first and comes on once. The
 * alternative — running the steps in the order they were written — blinks a room
 * four times and tells whoever is in it nothing about why.
 *
 * @param {{ api: any, handles: Map<string, any>, phases: Set<string>,
 *           openLights: Set<Light>, onCancel: () => void, eyesAsked: Map<string, string>,
 *           stressed: Set<string>, stressAll: boolean }} ctx
 * @param {Light} light
 * @param {number} index
 * @param {number} total
 */
async function probeLight(ctx, light, index, total) {
  const { api } = ctx;
  console.log('');
  console.log(`--- light ${index}/${total}  ${light.ref.name}  `
    + `(${light.ref.ownerName || light.ref.driverId}${light.ref.zoneName ? `, ${light.ref.zoneName}` : ''})`);

  if (!light.ref.available) {
    report('-', 'SKIPPED', `${light.ref.name}: the Homey reports it unavailable`);
    return;
  }

  light.handle = await handleFor(api, ctx.handles, light.ref.id);
  await runStep(light, 'P1', 'metadata', async () => stepMetadata(light, light.handle));

  startWatching(light, (capability) => {
    /**
     * The same callback means two different things, and only one of them is
     * interference.
     *
     * On a run that writes, a value we never sent means somebody or something
     * else is driving this lamp, and every measurement after it would attribute
     * their write to us — so the battery stops. On a read-only run there is no
     * measurement to protect: the lamp is simply chatty, which is worth
     * recording and no reason to stop. Reporting the second as the first marked
     * half a house of Hue bulbs "confounded" during an inventory that had
     * written nothing at all.
     */
    if (ctx.phases.size === 0) {
      finding(light, 'ECHO_CHATTY', {
        step: 'P2', capability,
        observed: 'reported a value with no write from us',
      });
      return;
    }
    if (light.confounded) return;
    light.confounded = true;
    finding(light, 'PROBE_INTERFERENCE', {
      step: '-', capability,
      observed: `a value we never wrote arrived more than ${THRESHOLDS.SETTLE_MS}ms after our `
        + 'last write',
    });
  });

  const deadline = performance.now() + PROBE.LIGHT_BUDGET_MS;
  /** The one `requires` every step shares: has this lamp had its six minutes? */
  const overBudget = async () => (performance.now() > deadline
    ? 'the lamp ran out of its time budget'
    : null);

  try {
    await runStep(light, 'P2', 'snapshot', () => snapshotLight(api, light));
    if (!light.snapshot) return;

    // Read-only from here unless a write phase was asked for.
    if (ctx.phases.size === 0) return;

    ctx.openLights.add(light);

    await runStep(light, 'P3', 'quiet window', () => stepQuietWindow(light));

    const wasOn = light.snapshot.values.onoff === true;

    /** Everything that needs the lamp lit. */
    const onPhase = async () => {
      if (ctx.phases.has('echo')) {
        await runStep(light, 'P5a', 'echo shape', () => stepEchoShape(api, light),
          { requires: overBudget });
      }
      if (ctx.phases.has('axes')) {
        await runStep(light, 'P5b', 'value axes', () => stepAxes(api, light),
          { requires: overBudget });
      }
      if (ctx.phases.has('modes')) {
        await runStep(light, 'P5d', 'the mode gate', () => stepModes(api, light),
          { requires: overBudget });
      }
      if (ctx.phases.has('axes')) {
        await runStep(light, 'P5e', 'colour', () => stepColour(api, light),
          { requires: overBudget });
        await runStep(light, 'P5f', 'brightness floor', () => stepBrightnessFloor(api, light),
          { requires: overBudget });
      }
      if (ctx.phases.has('stress')) {
        const shared = !ctx.stressAll && ctx.stressed.has(light.ref.driverId);
        if (shared) {
          report('P5g', 'SKIPPED', 'another lamp on this driver was already stressed — a bridge '
            + 'is shared (--stress-all to do them all)');
        } else {
          const measured = await runStep(light, 'P5g', 'cadence', () => stepStress(api, light),
            { requires: overBudget });
          /**
           * Claimed on the way OUT, not the way in.
           *
           * `stressed.add()` used to run before the step, so the first lamp on
           * a driver took its only cadence slot whatever became of it. Lamps
           * are walked in id order, the first Hue bulb in the house happened to
           * be one that was powered off at the wall, and the first full run
           * therefore produced a critical about the scheduler's cadence and NO
           * cadence measurement for a working Hue bulb at all — which is the
           * one thing this phase exists for.
           *
           * runStep() already returns null for a step that was skipped or
           * threw, so this reads "did we actually measure something".
           */
          // `stepStress` returns an object even when the burst went badly, so
          // the demotion is checked too: a lamp that died mid-burst measured
          // nothing about the cadence and must not spend its driver's slot.
          if (measured !== null && !light.unreachable) ctx.stressed.add(light.ref.driverId);
          await sleep(PROBE.COOLDOWN_MS);
        }
      }
      if (ctx.phases.has('eyes')) {
        const already = ctx.eyesAsked.get(light.ref.driverId);
        if (already === undefined) {
          const answer = await runStep(light, 'P5i', 'a person looks',
            () => stepEyes(light, ctx.onCancel), { requires: overBudget });
          if (answer?.answer) ctx.eyesAsked.set(light.ref.driverId, answer.answer);
        } else {
          report('P5i', 'INFO', `taking "${already}" from another lamp on this driver`);
        }
      }
    };

    /** Everything that needs the lamp dark. */
    const offPhase = async () => {
      if (!ctx.phases.has('offphase')) return;
      await runStep(light, 'P4', 'writing to the dark', async () => {
        const current = await capabilityValue(api, light.ref.id, 'onoff');
        if (current === true) {
          note(`switching "${light.ref.name}" off for about 20 seconds`);
          await write(light, 'onoff', false);
          await sleep(THRESHOLDS.SETTLE_MS);
        }
        return stepOffPhase(api, light);
      }, { requires: overBudget });
    };

    if (wasOn) {
      await onPhase();
      await offPhase();
    } else {
      await offPhase();
      if (ctx.phases.size > 1 || !ctx.phases.has('offphase')) {
        await write(light, 'onoff', true);
        await sleep(THRESHOLDS.SETTLE_MS);
        await onPhase();
      }
    }
  } finally {
    // Every exit path, including a throw and a budget overrun.
    try {
      await restoreLight(api, light);
    } catch (error) {
      report('P6', 'FAILED', `${light.ref.name}: restore threw: `
        + redactKeyMaterial(messageOf(error)));
      finding(light, 'RESTORE_FAILED', {
        step: 'P6',
        observed: `the restore itself failed: ${redactKeyMaterial(messageOf(error))}`,
      });
    }
    ctx.openLights.delete(light);
    light.watcher?.stop();
    light.watcher = null;
  }
}

// ------------------------------------------------------------ global steps

/**
 * Which of the selected lamps a live Lightkeeper device is driving right now.
 *
 * Two reasons, and the second is the one nobody would guess. Probing such a lamp
 * confounds the measurement, obviously. But our writes also look like a human
 * override TO THAT DEVICE, and a circadian or Curve light responds by dropping
 * the lamp from its curve until it is power-cycled — so the probe can quietly
 * break the user's lighting until they notice a lamp that stopped following the
 * day.
 *
 * It reports and does not act. A script that silently switches off somebody's
 * lighting automation to get a cleaner number is worse than the number is good.
 *
 * @param {any} api
 * @param {Light[]} lights
 */
async function scanForConflicts(api, lights) {
  /** @type {Set<string>} */
  const driven = new Set();
  try {
    const app = await withTimeout(api.apps.getApp({ id: APP_ID }), 15_000, 'finding the app');
    const diagnostics = await withTimeout(app.get({ path: '/diagnostics' }), 20_000,
      'reading app diagnostics');
    // Every family, including 'daylight': this set is what stops the probe
    // pushing a lamp the app is currently holding, and a Daylight light holds a
    // lamp's brightness continuously — which is exactly the sort of thing the
    // probe would otherwise fight for the length of a run.
    for (const family of ['controllers', 'schedules', 'circadian', 'daylight']) {
      for (const runtime of /** @type {any[]} */ (diagnostics?.[family] ?? [])) {
        for (const target of /** @type {any[]} */ (runtime?.targets ?? [])) {
          if (target?.id) driven.add(String(target.id));
        }
      }
    }
  } catch (error) {
    report('G4', 'INFO', `could not ask the app what it is driving (${messageOf(error)}) — `
      + 'that is fine, it need not be installed');
    return { driven: [], overlapping: [] };
  }

  const overlapping = lights.filter(l => driven.has(l.ref.id));
  if (overlapping.length === 0) {
    report('G4', 'OK', `${driven.size} lamp(s) driven by Lightkeeper, none of them selected`);
  } else {
    report('G4', 'INFO', `${overlapping.length} selected lamp(s) are driven by a live Lightkeeper `
      + 'device right now');
    for (const light of overlapping) note(`  ${light.ref.name}`);
    note('Our writes will read as a human override to those devices, and a circadian or Curve');
    note('light drops an overridden lamp until it is power-cycled. Either disable those devices');
    note('for the run, or power-cycle the lamps afterwards. Nothing is disabled for you.');
  }

  return { driven: [...driven], overlapping: overlapping.map(l => l.ref.id) };
}

/**
 * What a run would do, in the order it would do it, before anything is written.
 *
 * @param {Light[]} lights
 * @param {Set<string>} phases
 * @param {{ all: boolean, room: string, zones: string[], names: string[], driver: string | null }} scope
 */
function printPlan(lights, phases, scope) {
  const perLight = phases.size === 0 ? 0.2 : 0.6 + phases.size * 0.5;
  const minutes = Math.ceil(lights.length * perLight);

  console.log('');
  console.log(`${lights.length} light(s), ${phases.size === 0 ? 'read-only' : [...phases].join(' + ')}`);
  console.log(`roughly ${minutes} minute(s), one lamp at a time`);

  // The scope that was actually applied, not the one in the config file. An
  // earlier version printed the configured room while probing a lamp named on
  // the command line, which is the opposite of reassuring.
  const explicit = [
    ...scope.zones.map(zone => `--zone "${zone}"`),
    ...scope.names.map(name => `--light "${name}"`),
    ...(scope.driver === null ? [] : [`--driver "${scope.driver}"`]),
  ];
  if (explicit.length > 0) {
    console.log(`scope: ${explicit.join(', ')}`);
  } else if (scope.all) {
    console.log('scope: THE WHOLE HOUSE');
  } else if (scope.room !== '') {
    console.log(`scope: only "${scope.room}" — pass --all for the whole house`);
  } else {
    console.log('scope: every light (no room configured, and no --zone given)');
  }
  console.log('');

  /** @type {Map<string, Light[]>} */
  const byDriver = new Map();
  for (const light of lights) {
    const list = byDriver.get(light.ref.driverId) ?? [];
    list.push(light);
    byDriver.set(light.ref.driverId, list);
  }
  for (const [driverId, list] of byDriver) {
    console.log(`  ${list[0].ref.ownerName || driverId} — ${list.length} lamp(s)`);
    for (const light of list) {
      const group = light.ref.suspectedGroup ? '  [looks like a group]' : '';
      console.log(`      ${light.ref.name}`
        + `${light.ref.zoneName ? ` (${light.ref.zoneName})` : ''}${group}`);
    }
  }

  if (phases.has('offphase')) {
    console.log('');
    console.log('Each lamp goes DARK for about twenty seconds while its off-phase runs.');
  }
  console.log('');
}

// ------------------------------------------------------------------ the report

const REPORT_DIR = join(here, '..', '.probe');

/**
 * The headline counts, from MEASURED findings only.
 *
 * A finding this script has itself ruled void — from a lamp that rejected every
 * write, or one a live Lightkeeper device was driving — is not a finding, and
 * counting it is how the first full run reported both of its criticals from a
 * single dead bulb. The demoted ones are not hidden: they stay in the report,
 * they stay on their lamp, and they are counted here on their own so a reader
 * can see what was set aside rather than finding a gap between two numbers.
 *
 * Pure and exported because this is the rule that has already gone wrong once,
 * and it is the one thing in the summary that a test can hold without a Homey.
 *
 * @param {Array<{ code: string, severity: string, confidence: string }>} findings
 * @returns {{ bySeverity: Record<string, number>, byCode: Record<string, number>,
 *             inconclusive: number }}
 */
export function summariseFindings(findings) {
  /** @type {Record<string, number>} */
  const bySeverity = {};
  /** @type {Record<string, number>} */
  const byCode = {};
  let inconclusive = 0;
  for (const found of findings) {
    if (found.confidence === 'inconclusive') { inconclusive += 1; continue; }
    bySeverity[found.severity] = (bySeverity[found.severity] ?? 0) + 1;
    byCode[found.code] = (byCode[found.code] ?? 0) + 1;
  }
  return { bySeverity, byCode, inconclusive };
}

/**
 * Everything the run saw, in one object.
 *
 * Written after EACH LAMP rather than at the end, because a house-wide run is an
 * hour and a half and a killed run should still have its evidence. That is
 * cheaper and more honest than a `--resume` flag nobody would trust.
 *
 * @param {{ config: any, commands: string[], phases: Set<string>, options: any,
 *           sockets: Record<string, boolean>, homey: any, lights: Light[],
 *           startedAt: number, conflicts: any, repeat: number,
 *           stopped?: { reason: string, after: number, of: number,
 *                       maxMinutes?: number } | null }} state
 */
function buildReport(state) {
  /**
   * Two denominators, because one of them was a lie.
   *
   * `lights` counted every SELECTED lamp, probed or not, so a run that stopped
   * after fifteen of fifty-four still rolled up as "Philips Hue: 35 lamp(s)"
   * for codes drawn from ten of them. A rate per integration is the whole
   * purpose of this table and it was reading four times too good.
   */
  /** @type {Record<string, any>} */
  const byDriver = {};
  for (const light of state.lights) {
    const bucket = byDriver[light.ref.driverId] ?? (byDriver[light.ref.driverId] = {
      ownerName: light.ref.ownerName, selected: 0, lights: 0, codes: {},
    });
    bucket.selected += 1;
    if (light.snapshot !== null) bucket.lights += 1;
    for (const found of light.findings) {
      // Measured only, exactly as the two totals below. This table is the shape
      // a per-vendor quirks table would be built from, and a quirk attributed
      // to an integration on the strength of a dead bulb is the worst row it
      // could carry.
      if (found.confidence === 'inconclusive') continue;
      bucket.codes[found.code] = (bucket.codes[found.code] ?? 0) + 1;
    }
  }

  const { bySeverity, byCode, inconclusive } = summariseFindings(allFindings);

  const totalEchoes = state.lights.reduce((sum, l) => sum + l.echoes.length, 0);
  const everChanged = state.lights.some(l => l.changed.size > 0);

  return {
    schema: 1,
    tool: 'probe-lights',
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - state.startedAt,
    homey: {
      address: state.config.address,
      softwareVersion: state.homey?.version ?? null,
      id: state.homey?.id ?? null,
    },
    config: {
      commands: state.commands,
      phases: [...state.phases],
      selection: state.options.selection,
      repeat: state.repeat,
      thresholds: THRESHOLDS,
      probeThresholds: PROBE,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localTime: new Date(state.startedAt).toString(),
    },
    instrumentation: {
      socketsConnected: state.sockets,
      echoesObserved: totalEchoes,
      echoCalibration: totalEchoes > 0 ? 'ok' : 'no echo arrived all run',
      anyValueObservedToChange: everChanged,
    },
    conflicts: state.conflicts,
    /**
     * Why the run ended, in the artefact rather than only on the console.
     *
     * The first full run stopped after fifteen of fifty-four lamps. The console
     * said so; the JSON recorded nothing, so the other thirty-nine carried an
     * empty `steps` array with no reason and a reader could not tell "probed
     * and clean" from "never touched". A report shared a month later is all
     * anybody has.
     */
    stopped: state.stopped ?? null,
    lights: state.lights.map(light => ({
      ref: light.ref,
      declared: light.declared,
      snapshot: light.snapshot,
      steps: light.steps,
      observations: light.observations,
      latency: Object.fromEntries(Object.entries(light.latency).map(([capability, bucket]) => [
        capability,
        {
          ack: percentiles(/** @type {any} */ (bucket).ack),
          // Time-to-error, kept apart from the acks — see write().
          failed: percentiles(/** @type {any} */ (bucket).failed ?? []),
          firstEcho: percentiles(/** @type {any} */ (bucket).firstEcho),
        },
      ])),
      quantisation: light.quantisation,
      findings: light.findings,
      restore: light.restore,
      confounded: light.confounded,
      unreachable: light.unreachable,
      /** Never reached, as against reached and found clean. See `stopped`. */
      probed: light.snapshot !== null,
    })),
    findings: allFindings,
    runFindings: RUN.findings,
    /**
     * Every code this run produced, with the title and the assumption it
     * violates — including the `file:line`.
     *
     * The catalogue lived only in the source, so the shareable artefact carried
     * a bare `MODE_GATES_TEMP` and a reader had to have this script open to
     * learn what it meant. Keyed by the codes that actually fired rather than
     * repeated per finding: fifty-seven findings, fourteen codes.
     */
    findingsCatalogue: Object.fromEntries(
      [...new Set([...allFindings, ...RUN.findings].map(f => f.code))]
        .sort()
        .map(code => [code, {
          severity: FINDINGS[code]?.severity ?? null,
          /**
           * `headline`, not `title`, and the name matters: `title` is in the
           * redactor's DROP set, because a capability `title` is user-visible
           * text that can be renamed per device. A catalogue keyed the obvious
           * way would have been silently stripped from the one report anybody
           * shares.
           */
          headline: FINDINGS[code]?.title ?? null,
          assumption: FINDINGS[code]?.assumption ?? null,
        }]),
    ),
    summary: {
      /** Selected, which is not the same as looked at — see `probed`. */
      lights: state.lights.length,
      probed: state.lights.filter(l => l.snapshot !== null).length,
      confounded: state.lights.filter(l => l.confounded).length,
      unreachable: state.lights.filter(l => l.unreachable).length,
      restoresFailed: state.lights.filter(l => l.restore && !l.restore.complete).length,
      bySeverity,
      byCode,
      /** Demoted, and excluded from the two counts above. */
      inconclusive,
      byDriver,
    },
    cannotAnswer: CANNOT_ANSWER,
  };
}

/**
 * The standing limits, in the report as well as in the docblock.
 *
 * In the file because the file is what somebody reads in a year, and a
 * measurement without its limits is how "the probe said so" becomes an
 * argument.
 */
const CANNOT_ANSWER = [
  'Whether a high light_temperature is physically WARMER on a lamp. No colorimeter. Only that '
  + 'the axis is monotone, is not inverted in its REPORTS, and how coarse it is. The `eyes` '
  + 'command asks a person instead.',
  'Anything about perception: whether the perceptual curve feels linear, whether MINIMUM_BRIGHTNESS '
  + 'looks lit, whether a ramp feels smooth.',
  'Whether a lamp is physically on. It reads onoff, and a lamp behind a cut wall switch reports '
  + 'whatever its integration believes.',
  'Time-to-light. Ack and echo timings include bridge and LAN and exclude radio and the bulb fade.',
  'Anything upstream of the write: button events, Flow dispatch, dropped release events. The '
  + 'cadence step reproduces the scheduler rate; it does not run the scheduler, so a RATE_ finding '
  + 'is a fact about the lamp and not proof the app misbehaves.',
  'Whether the app is correct. A finding names an assumption and a file:line, and proposes nothing.',
  'Whether a quirk is stable (one run is one sample), whether it is per-lamp or per-integration '
  + '(the rollup groups by driverId and stops there), or why (routing, congestion and a bridge '
  + 'queue are one number from here).',
];

/**
 * The same report with the house taken out of it.
 *
 * Keep the physics, drop the house. Ids and zones are PSEUDONYMISED rather than
 * deleted, consistently across every field — `test/fixtures/README.md` is
 * explicit that ids are load-bearing and have to stay internally consistent when
 * names are replaced, or the trace stops being followable. Names, the address,
 * the timezone and every wall-clock time go: a duration is evidence, but the
 * hour somebody was at home is not.
 *
 * `driverId` and `ownerName` stay in full. `com.philips.hue` is the key a quirks
 * table would be built on, and it says nothing about who lives here.
 *
 * @param {any} raw
 */
export function redactReport(raw) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  /** @type {Map<string, string>} */
  const zones = new Map();
  /** @type {Array<[string, string]>} */
  const names = [];

  raw.lights.forEach((/** @type {any} */ light, /** @type {number} */ index) => {
    const alias = `light-${String(index + 1).padStart(2, '0')}`;
    ids.set(light.ref.id, alias);
    if (light.ref.name) names.push([light.ref.name, alias]);
    if (light.ref.zoneId && !zones.has(light.ref.zoneId)) {
      zones.set(light.ref.zoneId, `zone-${String.fromCharCode(65 + zones.size)}`);
    }
  });
  for (const [zoneId, alias] of zones) {
    ids.set(zoneId, alias);
  }
  raw.lights.forEach((/** @type {any} */ light) => {
    if (light.ref.zoneName) names.push([light.ref.zoneName, zones.get(light.ref.zoneId) ?? 'zone']);
  });
  // Longest first, so "Kitchen ceiling" is replaced before "Kitchen".
  names.sort((a, b) => b[0].length - a[0].length);

  const start = Date.parse(raw.startedAt);

  /**
   * Keys whose value identifies the house rather than the hardware.
   *
   * `ownerUri` and `driverId` are deliberately NOT here: `homey:app:nl.philips.hue`
   * is the key a quirks table would be built on and says nothing about who lives
   * here. `title` is: a capability title is translated and can be renamed per
   * device.
   */
  const DROP = new Set(['name', 'zoneName', 'address', 'localTime', 'tz', 'title', 'desc',
    'titleTrue', 'titleFalse']);

  /** @param {string} text */
  const scrub = (text) => {
    let out = String(text);
    for (const [name, alias] of names) {
      if (name.length < 3) continue;
      out = out.split(name).join(alias);
    }
    for (const [id, alias] of ids) {
      out = out.split(id).join(alias);
    }
    return redactKeyMaterial(out);
  };

  /**
   * @param {unknown} value
   * @param {string | null} key
   * @returns {unknown}
   */
  const walk = (value, key) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return scrub(value);
    if (typeof value === 'number') {
      // An absolute timestamp becomes a millisecond offset into the run.
      if (key === 'at' && value > 1e12) return Math.round(value - start);
      return value;
    }
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(item => walk(item, key));
    if (typeof value === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (DROP.has(childKey)) continue;
        out[childKey] = walk(childValue, childKey);
      }
      return out;
    }
    return value;
  };

  const redacted = /** @type {any} */ (walk(raw, null));
  redacted.startedAt = new Date(start).toISOString().slice(0, 10);
  redacted.finishedAt = null;
  redacted.redaction = { pseudonyms: ids.size, namesScrubbed: names.length };

  /**
   * Look for it on purpose.
   *
   * Borrowed from the hardware pass's redaction check: the only trustworthy test
   * of a scrubber is to search the output for the things it was meant to remove.
   * A leak means the file is NOT written — the redacted sibling is the shareable
   * one, and a shareable file that leaks is worse than no file.
   */
  const serialised = JSON.stringify(redacted);
  /** @type {string[]} */
  const leaks = [];
  for (const [name] of names) {
    if (name.length >= 3 && serialised.includes(name)) leaks.push(`name "${name}"`);
  }
  for (const id of ids.keys()) {
    if (serialised.includes(id)) leaks.push(`id ${id}`);
  }
  if (raw.homey?.address && serialised.includes(raw.homey.address)) leaks.push('the Homey address');

  return { redacted, leaks };
}

/**
 * @param {any} raw
 * @param {{ json: string | null, redacted: string | null, none: boolean }} paths
 */
function writeReports(raw, paths) {
  if (paths.none) return { raw: null, redacted: null, leaks: [] };

  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = raw.startedAt.replace(/[:.]/g, '-');
  const rawPath = paths.json ?? join(REPORT_DIR, `probe-${stamp}.json`);
  writeFileSync(rawPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const { redacted, leaks } = redactReport(raw);
  const redactedPath = paths.redacted ?? rawPath.replace(/\.json$/, '.redacted.json');
  if (leaks.length === 0) {
    writeFileSync(redactedPath, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
  }

  return { raw: rawPath, redacted: leaks.length === 0 ? redactedPath : null, leaks };
}

// ---------------------------------------------------------------- the summary

/**
 * @param {Light[]} lights
 * @param {any} raw
 */
function printSummary(lights, raw) {
  console.log('');
  const passed = results.filter(r => r.status === 'OK');
  const failed = results.filter(r => r.status === 'FAILED');
  const skipped = results.filter(r => r.status === 'SKIPPED');
  console.log(`${passed.length} OK, ${failed.length} failed, ${skipped.length} skipped`);

  const demoted = raw.summary.inconclusive ?? 0;
  const total = allFindings.length + RUN.findings.length - demoted;
  console.log(`${total} finding(s) across ${raw.summary.probed} lamp(s)`);
  for (const severity of SEVERITIES) {
    const count = raw.summary.bySeverity[severity] ?? 0;
    if (count > 0) console.log(`  ${severity.padEnd(9)} ${count}`);
  }
  // Said out loud rather than left as a gap between two numbers: somebody
  // comparing this run against the last one needs to know the difference is
  // lamps that were ruled out, not lamps that behaved.
  if (demoted > 0) {
    console.log(`  ${'(ruled out)'.padEnd(9)} ${demoted} inconclusive, from lamps that rejected `
      + 'every write or that something else was driving');
  }

  const codes = Object.entries(raw.summary.byCode).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (codes.length > 0) {
    console.log('');
    console.log('By code:');
    for (const [code, count] of codes) {
      console.log(`  ${String(count).padStart(3)}  ${code.padEnd(32)} ${FINDINGS[code]?.title ?? ''}`);
    }
  }

  /**
   * The assumption, printed for the severities somebody is going to act on.
   *
   * It was in the findings table and nowhere a reader could see it, so the
   * `file:line` that makes a finding actionable was the one part that never
   * left the source.
   */
  const serious = [...allFindings, ...RUN.findings]
    .filter(f => f.confidence !== 'inconclusive')
    .filter(f => SEVERITIES.indexOf(f.severity) <= SEVERITIES.indexOf('high'));
  if (serious.length > 0) {
    console.log('');
    console.log('What the serious ones are about:');
    for (const code of [...new Set(serious.map(f => f.code))]) {
      console.log(`  ${code}`);
      console.log(`    ${FINDINGS[code]?.assumption ?? '(no assumption recorded)'}`);
    }
  }

  const drivers = Object.entries(raw.summary.byDriver);
  if (drivers.length > 0) {
    console.log('');
    console.log('By integration — the shape a quirks table would be built from:');
    for (const [driverId, bucket] of drivers) {
      const detail = Object.entries(/** @type {any} */ (bucket).codes)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .map(([code, count]) => `${count}x ${code}`)
        .join(', ');
      const probedHere = /** @type {any} */ (bucket).lights;
      const selectedHere = /** @type {any} */ (bucket).selected;
      const scope = probedHere === selectedHere
        ? `${probedHere} lamp(s)`
        : `${probedHere} of ${selectedHere} lamp(s) probed`;
      console.log(`  ${/** @type {any} */ (bucket).ownerName || driverId} `
        + `(${scope}): ${detail || 'nothing'}`);
    }
  }

  const broken = lights.filter(l => l.restore && !l.restore.complete);
  if (broken.length > 0) {
    console.log('');
    console.log('PUT THESE BACK BY HAND — the probe could not:');
    for (const light of broken) {
      const missed = Object.entries(light.restore.verified)
        .filter(([, v]) => !(/** @type {any} */ (v).ok))
        .map(([capability, v]) => `${capability} should be ${round(/** @type {any} */ (v).wanted)}`)
        .join(', ');
      // A lamp that rejected every write could not be put back BECAUSE it is
      // not there. Same list, different errand: check the power, not the app.
      const why = light.unreachable ? ' (it rejected every write — check its power)' : '';
      console.log(`  ${light.ref.name}: ${missed}${why}`);
    }
  }

  if (failed.length > 0) {
    console.log('');
    console.log('Failed:');
    for (const result of failed) console.log(`  ${result.line} ${result.detail}`);
  }
}

// -------------------------------------------------------------------- the CLI

const READ_ONLY = ['inventory', 'plan'];
const WRITE_PHASES = ['echo', 'offphase', 'axes', 'modes', 'stress', 'eyes'];
/** `full` is everything that does not need a person in the room. */
const FULL = ['echo', 'offphase', 'axes', 'modes', 'stress'];

/** What each write phase does to the household, in one sentence each. */
const EFFECTS = {
  echo: 'changes one lamp\'s brightness by a quarter and reads it back',
  offphase: 'switches each lamp OFF for about twenty seconds and writes to it while it is dark',
  axes: 'walks each lamp through brightness, colour temperature and colour',
  modes: 'switches each lamp between colour and temperature mode several times',
  stress: 'sends about fifty brightness writes in ten seconds, once per integration',
  eyes: 'sets the warm end of the axis and asks you what you see',
};

const VALUE_FLAGS = new Set(['--zone', '--light', '--driver', '--sample', '--json', '--redacted',
  '--max-minutes', '--fail-on', '--repeat']);
const SWITCHES = new Set(['--yes', '--all', '--quick', '--stress-all', '--no-json',
  '--stop-on-error']);

/**
 * Hand-rolled, like every other script here.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const commands = [];
  /** @type {Record<string, string[]>} */
  const options = {};
  /** @type {Set<string>} */
  const switches = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      commands.push(token);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${token} needs a value`);
      }
      (options[token] ??= []).push(value);
      index += 1;
      continue;
    }
    if (!SWITCHES.has(token)) throw new Error(`unknown flag ${token}`);
    switches.add(token);
  }

  return { commands, options, switches };
}

async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`probe-lights: ${messageOf(error)}`);
    console.error(`Flags: ${[...VALUE_FLAGS, ...SWITCHES].sort().join(' ')}`);
    process.exitCode = 2;
    return;
  }

  let commands = parsed.commands.length === 0 ? ['inventory'] : parsed.commands;
  if (commands.includes('full')) commands = [...FULL];

  const known = [...READ_ONLY, ...WRITE_PHASES, 'full'];
  const unknown = commands.filter(command => !known.includes(command));
  if (unknown.length > 0) {
    console.error(`probe-lights: unknown command(s) ${unknown.join(', ')}`);
    console.error(`Known: ${[...READ_ONLY, ...WRITE_PHASES, 'full'].join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const phases = new Set(commands.filter(command => WRITE_PHASES.includes(command)));

  // The same gate the hardware pass uses, and for a stronger reason: that script
  // only ever mutates devices it created, and this one writes to lamps somebody
  // else paired.
  if (phases.size > 0 && !parsed.switches.has('--yes')) {
    console.error('This writes to lights in your house. Pass --yes when you have read what it does:');
    for (const phase of phases) {
      console.error(`  ${phase.padEnd(9)} ${/** @type {any} */ (EFFECTS)[phase]}`);
    }
    console.error('');
    console.error('Every lamp is read first and put back afterwards, one lamp at a time, and the');
    console.error('restore is verified. Run `plan` first to see exactly which lamps and for how long.');
    process.exitCode = 2;
    return;
  }

  /** @type {any} */
  let config;
  try {
    config = await ensureConfig();
  } catch (error) {
    console.error(`probe-lights: ${messageOf(error)}`);
    process.exitCode = 2;
    return;
  }

  const startedAt = Date.now();
  console.log(`Lightkeeper light probe against ${config.address}`);
  console.log(`Commands: ${commands.join(', ')}`);
  if (config.appKey && config.appKey === config.key) {
    console.log('');
    console.log('WARNING: the key configured for this script is the same one the app holds. A key');
    console.log('holds ONE live session (platform §2), so this run and the app will evict each');
    console.log('other. Make a second key before trusting anything below.');
  }
  console.log('');

  const repeat = Number(parsed.options['--repeat']?.[0] ?? 1);
  const maxMinutes = Number(parsed.options['--max-minutes']?.[0] ?? 45);
  /**
   * `room` is the DEFAULT scope, so it is only part of the selection when
   * nothing overrode it.
   *
   * The first full run recorded `all: true` and `room: "Studio"` together and a
   * reader had to know the precedence rules to tell which one applied. A report
   * that describes a scope it did not use is worse than one that describes
   * none.
   */
  const explicitScope = parsed.switches.has('--all')
    || (parsed.options['--zone'] ?? []).length > 0
    || (parsed.options['--light'] ?? []).length > 0
    || parsed.options['--driver'] !== undefined;

  const selection = {
    zones: parsed.options['--zone'] ?? [],
    names: parsed.options['--light'] ?? [],
    driver: parsed.options['--driver']?.[0] ?? null,
    all: parsed.switches.has('--all'),
    room: explicitScope ? null : config.room,
    quick: parsed.switches.has('--quick'),
    sample: parsed.options['--sample'] ? Number(parsed.options['--sample'][0]) : null,
  };

  const { api, sockets } = await connect(config);

  /** @type {Light[]} */
  let chosen = [];
  /** @type {any} */
  let conflicts = { driven: [], overlapping: [] };
  /** Why the lamp loop ended, if it ended early. Read by buildReport(). */
  /** @type {{ reason: string, after: number, of: number, maxMinutes?: number } | null} */
  let stopped = null;
  /** @type {any} */
  let raw = null;

  /** @type {Set<Light>} */
  const openLights = new Set();
  let stopRequested = false;
  let interrupts = 0;

  /**
   * Put back whatever is open, then go.
   *
   * A first interrupt asks the loop to stop after the lamp it is on, whose own
   * `finally` restores it — which is the clean path. A second one is somebody
   * who means it: the open lamps get one bounded attempt and then the process
   * leaves, saying plainly that a light may be left disturbed.
   *
   * @param {string} signal
   */
  const panic = async (signal) => {
    interrupts += 1;
    if (interrupts === 1) {
      stopRequested = true;
      console.log('');
      console.log(`${signal} — finishing this lamp and putting it back. Ctrl-C again to stop now.`);
      return;
    }
    console.log('');
    console.log(`${signal} again — restoring ${openLights.size} open lamp(s) and leaving.`);
    try {
      await withTimeout(
        Promise.all([...openLights].map(light => restoreLight(api, light))),
        PROBE.PANIC_BUDGET_MS, 'restoring open lamps');
    } catch {
      console.log('Could not finish restoring. These lights may be left as the probe had them:');
      for (const light of openLights) console.log(`  ${light.ref.name}`);
    }
    disconnectAll(api);
    process.exit(130);
  };

  process.on('SIGINT', () => { void panic('SIGINT'); });
  process.on('SIGTERM', () => { void panic('SIGTERM'); });

  try {
    report('G1', 'OK', `connected; sockets: ${Object.entries(sockets)
      .map(([name, up]) => `${name} ${up ? 'up' : 'DOWN'}`).join(', ')}`);
    if (!sockets.devices) {
      report('G1', 'INFO', 'the devices socket is down, so no echo will arrive and every ECHO_ '
        + 'finding will be reported as inconclusive');
    }
    note(`Homey software version ${api.version ?? '(not reported)'}`);

    const { lights, deviceCount } = await collectLights(api);
    const notLights = lights.filter(l => l.ref.deviceClass !== 'light').length;
    report('G2', 'OK', `${lights.length} light(s) of ${deviceCount} device(s); ${notLights} `
      + 'of them are not class light and are offered as lights anyway');

    chosen = selectLights(lights, selection);
    if (chosen.length === 0) {
      report('G2', 'SKIPPED', 'nothing selected. Check --zone/--light/--driver, or the configured '
        + 'room, or pass --all');
      return;
    }

    conflicts = await scanForConflicts(api, chosen);
    printPlan(chosen, phases, selection);

    if (commands.includes('plan')) {
      report('G5', 'OK', 'plan only — nothing was read from a lamp and nothing was written');
      return;
    }

    const hour = new Date().getHours();
    if (phases.size > 0 && selection.all && (hour < 8 || hour >= 22)) {
      console.log(`It is ${hour}:00 and this is a house-wide write run. Carrying on — but that is`);
      console.log('bedrooms as well as the kitchen. Ctrl-C now if that is not what you meant.');
      console.log('');
    }

    const ctx = {
      api,
      handles: new Map(),
      phases,
      openLights,
      onCancel: () => { stopRequested = true; },
      eyesAsked: new Map(),
      stressed: new Set(),
      stressAll: parsed.switches.has('--stress-all'),
    };

    const budgetEnds = startedAt + maxMinutes * 60_000;

    for (let index = 0; index < chosen.length; index += 1) {
      if (stopRequested) {
        report('-', 'SKIPPED', `stopped after ${index} of ${chosen.length} lamp(s)`);
        stopped = { reason: 'cancelled', after: index, of: chosen.length };
        break;
      }
      if (Date.now() > budgetEnds) {
        report('-', 'SKIPPED', `out of time after ${index} of ${chosen.length} lamp(s) `
          + `(--max-minutes ${maxMinutes})`);
        stopped = { reason: 'out of time', after: index, of: chosen.length, maxMinutes };
        break;
      }

      const light = chosen[index];
      for (let pass = 1; pass <= repeat; pass += 1) {
        if (repeat > 1) note(`pass ${pass} of ${repeat}`);
        await probeLight(ctx, light, index + 1, chosen.length);
        if (stopRequested) break;
      }

      if (light.restore && !light.restore.complete && parsed.switches.has('--stop-on-error')) {
        report('-', 'FAILED', 'stopping: a restore failed and --stop-on-error was given');
        stopped = { reason: 'a restore failed (--stop-on-error)', after: index + 1, of: chosen.length };
        break;
      }

      // Written after each lamp, so a killed run keeps its evidence.
      raw = buildReport({
        config, commands, phases, options: { selection }, sockets,
        homey: api, lights: chosen.slice(0, index + 1), startedAt, conflicts, repeat, stopped,
      });
      writeReports(raw, {
        json: parsed.options['--json']?.[0] ?? null,
        redacted: parsed.options['--redacted']?.[0] ?? null,
        none: parsed.switches.has('--no-json'),
      });

      if (index < chosen.length - 1) await sleep(PROBE.BETWEEN_LIGHTS_MS);
    }
  } finally {
    // Bounded, and before the summary: a hung socket must not eat the report.
    disconnectAll(api);
  }

  // ---- what the run says about itself, which outranks everything above it.

  const probed = chosen.filter(l => l.snapshot !== null);

  /**
   * G4 already NAMES the lamps a live Lightkeeper device is driving, and then
   * every finding from them was published at full confidence.
   *
   * In the first full run one of the three was probed and produced five,
   * including a `MODE_DOES_NOT_GATE` — a finding whose whole point is that it
   * can overturn platform §6. A circadian light writing to that lamp on its own
   * minute tick is indistinguishable, from here, from the lamp deciding
   * something for itself. The script deliberately does not switch anybody's
   * automation off to get a cleaner number, so the honest move is to say the
   * number is dirty.
   */
  const overlapping = new Set(conflicts.overlapping ?? []);
  for (const light of probed) {
    if (!overlapping.has(light.ref.id)) continue;
    for (const found of light.findings) found.confidence = 'inconclusive';
  }

  const totalEchoes = probed.reduce((sum, l) => sum + l.echoes.length, 0);
  if (phases.size > 0 && probed.length > 0 && totalEchoes === 0) {
    finding(RUN, 'PROBE_UNINSTRUMENTED', {
      step: 'G3',
      observed: `no capability instance fired for any of ${probed.length} lamp(s) all run`,
      numbers: { lights: probed.length },
    });
    // And every claim that rested on silence stops being a claim. One loop:
    // `allFindings` holds the same objects the lamps do, which is what this
    // used to walk two arrays to work around.
    for (const found of allFindings) {
      if (found.code === 'ECHO_NONE') found.confidence = 'inconclusive';
    }
  }

  if (phases.size > 0 && probed.length > 0 && probed.every(l => l.changed.size === 0)) {
    finding(RUN, 'PROBE_SUSPECT_CACHE', {
      step: 'G3',
      observed: `no read moved on any of ${probed.length} lamp(s) despite writing to all of them`,
      numbers: { lights: probed.length },
    });
  }

  for (const found of [...allFindings, ...RUN.findings]) {
    found.repeats = `${Number(found.numbers.occurrences ?? 1)}/${repeat}`;
  }

  raw = buildReport({
    config, commands, phases, options: { selection }, sockets,
    homey: api, lights: chosen, startedAt, conflicts, repeat, stopped,
  });
  const written = writeReports(raw, {
    json: parsed.options['--json']?.[0] ?? null,
    redacted: parsed.options['--redacted']?.[0] ?? null,
    none: parsed.switches.has('--no-json'),
  });

  if (written.leaks.length > 0) {
    finding(RUN, 'PROBE_REDACTION_LEAK', {
      step: 'G3',
      observed: `${written.leaks.join(', ')} survived redaction, so the redacted file was not `
        + 'written',
    });
  }

  printSummary(chosen, raw);

  if (written.raw) {
    console.log('');
    console.log(`Raw report:      ${written.raw}`);
    console.log(`Redacted report: ${written.redacted ?? '(not written — see PROBE_REDACTION_LEAK)'}`);
    console.log('Both are gitignored. The raw one names your devices and rooms; the redacted one');
    console.log('is the one to share.');
  }

  // Findings are the product, not errors. Only the probe's own failures and a
  // lamp left in the wrong state are worth a non-zero exit.
  const restoresFailed = chosen.some(l => l.restore && !l.restore.complete);
  const stepsFailed = results.some(r => r.status === 'FAILED');
  const failOn = parsed.options['--fail-on']?.[0] ?? null;
  // Measured only, for the reason buildReport gives: a finding the script has
  // itself ruled void must not fail somebody's run.
  const overFailOn = failOn !== null && allFindings.some(f =>
    f.confidence !== 'inconclusive'
    && SEVERITIES.indexOf(f.severity) <= SEVERITIES.indexOf(/** @type {Severity} */ (failOn)));

  if (restoresFailed || stepsFailed || overFailOn) process.exitCode = 1;
}

/**
 * Guarded on being the process's own entry point, so a test can import the
 * findings table and the pure helpers without probing the house.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // The message may have been near the key, so the message is printed and
    // never the error: a stack from homey-api can quote the request back.
    console.error(`\nprobe-lights failed: ${explainFailure(error)}`);
    process.exitCode = 1;
  });
}

