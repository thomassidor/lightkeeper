# Lightkeeper Remediation — Implementation Plan (Master)

**Input:** Consolidated code review of `thomassidor/lightkeeper` @ `main`, 2026-08-26, v0.4.0 (two independent reviews, cross-verified against source; all finding IDs below — B*, Q*, D*, S*, R*, LK-* — refer to that document).
**Executor:** Claude Code, working phase by phase. Read this file fully before any phase. Load exactly one `PHASE-N-*.md` per working session.
**Baseline verified:** 411 tests / 100 suites, 0 failures (Node 20, `tsx`).

---

## How to work this plan

1. **One phase per session/branch.** Each phase file is self-contained: goal, findings addressed, ordered tasks, tests to write, exit criteria. Do tasks in the listed order — several later tasks depend on earlier ones inside the same phase.
2. **Tests first or alongside, never after.** Every task lists its regression tests. A task is not done until its tests exist and pass. Where a task fixes a bug, write the failing test *first* and confirm it fails on the current code.
3. **Run the full verification protocol** (below) before declaring any task complete, and again at phase end.
4. **Small commits, one task per commit** where practical, message format: `phase-N: <task-id> <summary> (fixes B12)`.
5. **When a task says VERIFY-ON-HARDWARE**, implement it behind the smallest possible surface, mark it in the phase's exit notes, and list exactly what the human must confirm on a real Homey Pro. Do not silently assume platform behaviour.
6. **If reality disagrees with this plan** (an API doesn't exist, a described code path reads differently), stop that task, record the discrepancy in `docs/code-review/DEVIATIONS.md`, and continue with the next independent task. Do not improvise around a misunderstood platform constraint — this codebase's history shows those cost the most.
7. **Update the status table** at the bottom of this file as phases complete.

## Verification protocol (run after every task; all must pass)

```bash
npm run typecheck
npm run typecheck:test
npm test
npm run validate                      # regenerates app.json at publish level
git diff --exit-code -- app.json      # manifest must stay in sync with .homeycompose/
```

If a task touches any file under `drivers/*/pair/`, also run `npm run sync:views` and commit the regenerated copies (repair views and shared views are committed artifacts; `test/unit/repair-views.test.ts` gates drift).

## Invariants that must never regress (from the review's ✅ findings)

These are the codebase's proven strengths. Any diff that weakens one is wrong even if tests pass:

- **I1 — Fail-closed dispatch.** Every bridge event is validated against a live runtime, its catalogue, and an actual mapping before anything executes; refusals carry recorded reasons. Never accept on heuristics.
- **I2 — Secret hygiene.** The API key is never logged, never returned over the app API, never in diagnostics. `sanitizedWriteError` / `redactKeyMaterial` stay on every write-error path. Do not "simplify" `withWriteClient` to `throw error`.
- **I3 — Destructive-op caution.** Nothing owned by the user is ever deleted on a heuristic. Count-before-delete stays. The zero-live-owners refusal stays (it gets *stronger* in Phase 1, never weaker).
- **I4 — Write-probed credentials.** Credential validation performs a real Flow WRITE (reads succeed on keys that cannot write). Single-flight handshake and the token-changed guard in `getWriteClient` stay.
- **I5 — Folder work never blocks a Flow write.** FlowFolderManager methods keep catching their own failures and degrading to "no folder". Folders remain presentation-only — never evidence of ownership.
- **I6 — Nothing survives teardown.** No timer, subscription, ramp, or queued write outlives its runtime. The ramp hard-stop (10 s, not configurable) is untouchable.
- **I7 — Paused ≠ unavailable** for schedule and circadian devices (the tile carries the un-pause switch). Controller `disabled` = unavailable stays as-is until Phase 6 makes the distinction explicit in types.
- **I8 — User edits are respected.** A generated Flow the user renamed or moved is reused in place; folder placement is never compared in edit detection. (Phase 1 *adds* fields to edit detection; it must not start comparing name/folder.)
- **I9 — The Test control works before save** and without Flows (`startWithoutFlows` / ephemeral runtimes). Keep it working through every refactor.
- **I10 — Homey entry points use `module.exports`** (app.ts, api.ts, every driver.ts/device.ts). `export default` breaks the loader.

## Codebase conventions to follow

- New shared code goes in `lib/support/` (create it), `lib/time/` (Phase 6), `lib/devices/` (Phase 3). Pure logic stays I/O-free and unit-tested like the existing planner/window modules.
- Comments explain *why*, in the repo's existing voice; reference `CLAUDE.md §n` where a platform constraint is involved. Do not delete existing why-comments when moving code — move them with it.
- Tests: `node:test` via tsx, in `test/unit/`, following the existing fixture style in `test/fixtures/`. Injectable timers/now already exist on most classes — use them; Phase 0 adds shared helpers.
- TypeScript config for shipped code is deliberately `@tsconfig/node16` — do not upgrade the base (the emitted JS is what was hardware-verified). Raise strictness in `tsconfig.test.json` only.

## Phase map and dependency order

| Phase | Theme | Findings | Depends on | Risk |
|-------|-------|----------|------------|------|
| 0 | Foundations: lint, test kit, support primitives, CI hardening | Q3, S3, parts of B10/D5/D6 | — | Low |
| 1 | Generated-Flow lifecycle (the destructive cluster) | B12, B13, B14, B22, B4, B5+D4, B7, B21, Q6, B27a | 0 | **High-value, medium risk** |
| 2 | Write path & target lifecycle | B2, B16, B17, B9, B1, B8, B3+D10, B24, B27g | 0 | Medium |
| 3 | Device/runtime transactions & credential atomicity | D2 (extraction), B23, B26, B15, B25, B6, B10 (sweep) | 0 | Medium; one VERIFY-ON-HARDWARE |
| 4 | Schedule semantics | B18, B19, B27b, B27c, B27d, B27e | 1 (uses journaled sync), 0 | Medium |
| 5 | Binding model & discovery fixtures | B20, LK-007/029/030/031/047 verification | 0 | Medium |
| 6 | Consolidation, typing, validation | D1, D3+S4, D5–D9, D11, Q1, Q2, Q4, Q5 | 1–5 (extracts what they stabilised) | Low-medium |
| 7 | UI security & polish | S1, S2, B27f, R1, LK-064 (optional), docs | 0 | Low |

Phases 1, 2, 3 are independent of each other and may be done in any order after Phase 0 (1 first is recommended — highest user-facing risk). Phase 4 needs Phase 1's journaled sync. Phase 6 deliberately comes late: it extracts shared shapes from code the earlier phases have just made correct, so the extraction captures the *fixed* behaviour.

## What is deliberately NOT in this plan

- Rewriting the three-runtime architecture, the managers-as-domain-owners split, or the sync-views mechanism (all assessed as correct).
- The second review's full app-level generated-resource registry with per-Flow nonces (its patterns A/B). Phase 1 implements the scoped version (installed-device liveness + template-match attribution + creation journal) that delivers most of the safety. The registry remains a documented future option in `docs/code-review/DEVIATIONS.md` if Phase 1's approach proves insufficient on hardware.
- LK-064 (build-time view fragments): optional, parked in Phase 7 as a decision point, not a task.
- Separate migration version counters, per-feature managers: keep, by design.

## Status

| Phase | Status | Branch / PR | Notes |
|-------|--------|-------------|-------|
| 0 | **done** | main | Lint clean (0 errors), CI SHA-pinned, `lib/support/` + `test/support/` in place with 22 tests, `safety-promises.test.ts` seeded with 6. 439 tests. One deviation: `no-unnecessary-type-assertion` is OFF — its `--fix` broke the build at the homey-api `any` boundary. See DEVIATIONS.md. |
| 1 | **done** | main | All 8 tasks. 506 tests. Two findings worth reading in DEVIATIONS.md: 1.3's stated scenario was already correct (the real bug is a same-variant fingerprint change), and single-flight only works because each pass re-reads its stored references — the concurrency suite carries an explicit counter-example. **1.7a needs a 3-point hardware pass before release** — checklist in DEVIATIONS.md. |
| 2 | **done** | main | All 7 tasks. 557 tests. Two plan corrections found by writing the tests first, both in DEVIATIONS.md: the plan's `desiredOn === false` guard for B1 would have disabled the implied-on correction entirely (it is the STARTING state), and B9's queue eviction as specified breaks the rate cap. Scheduler `submit()` now returns a completion — every call site updated. |
| 3 | not started | | |
| 4 | not started | | |
| 5 | not started | | |
| 6 | not started | | |
| 7 | not started | | |
