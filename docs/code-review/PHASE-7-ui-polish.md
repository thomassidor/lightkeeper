# Phase 7 — UI security & polish

**Goal:** Close the webview hardening gap, finish the small verified items, and settle the documentation debts. Low risk; every task independent.
**Findings:** S1, S2, B27f (LK-061), R1 (+LK-059), Q5 (docs slice), LK-064 (decision point, optional).
**Files:** `settings/index.html`, `drivers/*/pair/*.html` (via sync-views), `drivers/*/driver.ts`, `lib/credential-service.ts` (docblock), `CLAUDE.md`, `README.md`, `scripts/sync-views.mjs` (only if 7.5 chosen).
**Invariants:** I2, I8. Reminder: any pair-view edit → `npm run sync:views` → commit regenerated copies.

---

## Task 7.1 — S1: DOM construction in the privileged webviews

- In `settings/index.html`, replace every string-concatenated `innerHTML` assignment (`renderControllers`, `renderSchedules`, `renderCircadian`, the events and writes lists — ~6 sites) with `document.createElement` + `textContent` + `className` construction. Keep `escapeHtml` for the few genuinely-templated spots if any remain; the goal is that no *interpolated* value ever passes through an HTML parser.
- In `drivers/circadian/pair/curve.html` (`pointHtml`, the `dots` build) and any other view found by `grep -n 'innerHTML' drivers/*/pair/*.html`: same conversion where interpolation exists; static-markup `innerHTML` (no interpolated values) may stay.
- **Adversarial rendering test:** extend the existing view-test harness (`pair-view-styles.test.ts` shows the pattern of asserting over the HTML files; for behaviour, add a light JSDOM-free check): simplest robust version without a DOM library — a unit test that loads the view source and asserts `innerHTML` appears only in an allowlisted set of static-markup lines (a structural guard: new interpolated `innerHTML` fails the test). Additionally, if a DOM test is feasible with the current toolchain (no new heavyweight deps — check whether `node:test` + a minimal DOM shim is acceptable; if not, the structural guard suffices), render a controller named `"><img src=x onerror=1>` and assert it lands as text.
- Run `sync:views`, commit copies.

## Task 7.2 — S2: document the key's true perimeter

- In `lib/credential-service.ts`'s header docblock, amend the "never returned over the app API" paragraph: the key is stored in `homey.settings` and is therefore readable by the app's own settings webview via `Homey.get`; the settings page must never execute untrusted markup (cross-reference Task 7.1's structural guard). Add one line to `settings/index.html` near its top comment stating the same, and a defensive convention: the settings JS never calls `Homey.get('flowWriteApiKey')` — add that string to the 7.1 structural-guard test as a forbidden token in view sources.

## Task 7.3 — B27f: `crypto.randomUUID()` device ids

- In all three `drivers/*/driver.ts` save handlers, replace `` `lk-xxx-${Date.now()}-${Math.round(Math.random()*1e6)}` `` with `` `lk-xxx-${crypto.randomUUID()}` `` (`node:crypto` is available on the Homey runtime; import at top). **Coordinate with Phase 1.7c's generated-id pattern:** update the shared exported regex to accept both the legacy shape and the UUID shape (legacy devices persist forever — the pattern must match both). Tests: new ids match the pattern; the Phase 1 `looksGenerated` gate accepts flows carrying either id shape.

## Task 7.4 — R1 + Q5: documentation debts

- Add a short "Module system" note to `CLAUDE.md`: Homey entry points must use `module.exports` (I10); `export default` breaks the loader; `lib/` is plain ESM-syntax TS.
- Sweep the four review-identified prose-vs-code contradictions and confirm each is now *true and tested* (B12→replacement, B4→attribution, B8→temperature, B27b→sanitiser policy), updating README/comment wording where the fix changed the promise's phrasing. The `safety-promises.test.ts` entries from Phases 1/2/4 are the enforcement; this task is the prose pass.
- Where a comment narrates an *incident* rather than an invariant and the incident is already captured in `CLAUDE.md`, trim to the invariant + `§n` reference (light touch — the review calls the comments a strength; only trim clear duplicates, do not bulk-edit).

## Task 7.5 — LK-064 decision point (OPTIONAL — human decides)

- **Question for the human:** should pair/repair views be generated from build-time fragments (shared CSS/JS/markup templates → materialised self-contained HTML), replacing today's whole-file copying? Recommendation from the review: *not yet* — the current sync-views + drift-test mechanism holds; adopt fragments only when the shared blocks inside the *source* views start drifting.
- If declined: add the cheap half anyway — `sync:views --check` mode (exit non-zero on any would-be copy) and run it in CI (this does **not** contradict the workflow's existing "don't run sync in CI" comment: check-mode detects drift without hiding it; update the comment accordingly).
- If accepted: scope it as its own mini-plan (generator script, fragment directory, deterministic output, CI check), and fold Task 6.6's presentation-map injection into the generator.

## Exit criteria

- No interpolated `innerHTML` in any webview; structural guard test green; sync-views clean.
- Device-id generation UUID-based with backward-compatible attribution.
- Perimeter documented; prose-vs-code contradictions resolved; LK-064 decision recorded in `DEVIATIONS.md`.

---

# Appendix — cross-phase test inventory (for final sign-off)

At full completion, these named regression tests must exist and pass (the phases define them; this is the checklist):

| Test | Phase |
|---|---|
| Fingerprint replacement leaves exactly one live Flow | 1.3 |
| Nth-create failure leaves zero untracked Flows | 1.4 |
| N→0 mappings removes all owned Flows and empty folder | 1.5 |
| Two overlapping reconciles: one folder, one Flow per key | 1.6 |
| Hand-built bridge-card Flow is never deleted | 1.7 |
| Failed-init device's Flows survive the sweep | 1.7 |
| Stale sweep token refuses | 1.7 |
| Disabled / condition-added generated Flow reads as edited; rename/move does not | 1.8 |
| Unsupported mapping blocks save and repairs at runtime | 1.8 |
| Drain waits for in-flight flush and mid-flush writes | 2.1 |
| Batch outcomes: success/coalesced/failed/dropped/cancelled | 2.2 |
| Failed write does not commit desired state; next delta plans from truth | 2.3 |
| Coalesced/failed circadian write does not advance `lastWritten`; probe correlates to its write | 2.4 |
| Removed circadian target receives zero writes on external power-on | 2.5 |
| Same-ID capability change re-primes; availability flip re-assesses | 2.5 |
| External off within probe window → no corrective on-write | 2.6 |
| Temperature delta never writes to an off light | 2.6 |
| >64 historical device ids remain schedulable; capacity drop observable | 2.7 |
| Failed start not dispatchable; old store/runtime restored | 3.2 |
| Late state callback cannot flip unavailable→available | 3.2 |
| Persistence rejection → repair state, no silent commit | 3.3 |
| Bad new credential leaves good old one active; races generation-guarded | 3.4 |
| Acquisition error redacted and classified | 3.5 |
| Transport failure invalidates read client; app error does not | 3.6 |
| Overlap matrix (pairwise/3-way/midnight/day-sets) deterministic | 4.1 |
| Catch-up refuses on unhealthy flows / missing off ref / unresolved tz | 4.2 |
| Non-array `days` drops the entry | 4.4 |
| Colon-bearing schedule id regenerated; flows replaced | 4.4 |
| Selector+direction+magnitude: every compiled variant carries all three | 5.1 |
| Sparse/decimal ranges compile exact values | 5.2 |
| Old-shape profile migrates and compiles identically (non-range) | 5.1 |
| Validators reject fuzzed persisted data; forged refs never reach delete | 6.2 |
| Live-vs-Test intent equivalence for every LightFunction | 6.4 |
| Presentation maps exhaustive and consistent across all copies | 6.6 |
| No interpolated `innerHTML` in views (structural guard) | 7.1 |
| Safety-promises file covers: sweep, replacement, temperature, catch-up, rename-reuse | 0.5/1/2/4 |
