# Phase 4 — Schedule semantics

**Goal:** Make schedules deterministic under overlap, safe under degraded Flow health, and honest about time. Depends on Phase 1 (journaled sync, `isNotFound`) and Phase 0.
**Findings:** B18 (LK-020), B19 (LK-021), B27b (LK-043), B27c (LK-044), B27d (LK-046), B27e (LK-062).
**Files:** `lib/schedules/schedule-runtime.ts`, `lib/schedules/schedule-types.ts`, `lib/schedules/schedule-bindings.ts`, `lib/schedules/local-time.ts`, `drivers/schedule/driver.ts`, `drivers/schedule/pair/schedule.html` (+ sync-views), `locales/en.json`.
**Invariants:** I1, I7. The DST design decision (never convert wall-clock to instants; the Flow engine owns firing) is untouchable — every task below stays in wall-clock minutes.

---

## Task 4.1 — B18: overlap policy = reject at save, recompute at boundary

Two layers, both needed (saved plans may already contain overlaps):

**4.1a Save-time rejection.** In `schedule-types.ts`'s sanitiser: after entries are built, detect pairwise overlap per device (two entries overlap when their `[onAt, onAt+windowLengthMinutes)` intervals intersect on any shared day, midnight-wrap-aware — reuse `activeWindowStartDay` math; write a pure `entriesOverlap(a, b): boolean` with its own tests: same-day, cross-midnight×same-day, cross-midnight×next-day, disjoint day sets). Overlapping entries → drop the later one with reason `overlaps schedule "<id>"`; the pairing screen already renders drop reasons. Locale key + view string via sync-views.

**4.1b Boundary recomputation for legacy/edited state.** In `ScheduleRuntime.apply()` for `boundary === 'off'`: before planning off, compute whether any *other* enabled entry is currently active (`isActive(entry, clock)` over `plan.entries` minus the firing one). If yes: skip the power-off, record `lastAction.note = 'kept on — schedule "<id>" still active'`, and (if the still-active entry defines brightness/temperature) re-apply that entry's `planOn` so the room lands on the surviving window's values. `catchUp()` becomes deterministic the same way: compute the set of active entries, apply only the **latest-started** one (derive from `elapsed` in `activeWindowStartDay` — smallest elapsed wins), never sequentially.
- Tests (the review's matrix): 17:00–23:00 + 20:00–01:00 → 23:00 off is suppressed, 01:00 off darkens; restart inside both windows applies the later-started entry regardless of array order; three-way overlap; cross-midnight + restricted days.

## Task 4.2 — B19: health-gated catch-up

- `catchUp()` refuses unless: `plan.enabled`, `this.flowsHealthy`, and `plan.managedFlows` contains a reference whose `bindingKey` parses to `(entry.id, 'off')` for the entry being caught up (the off boundary provably exists), and the timezone resolved (see 4.3). On refusal, log a specific reason and store it in a new diagnostics field `catchUpRefusals: [{entryId, reason, at}]` (BoundedLog, cap 10).
- Tests: each failure mode (unhealthy flows, missing off ref, dead credential having failed reconcile, unresolved timezone) with "now" inside a window → zero writes + recorded refusal; healthy path unchanged.
- Add to `safety-promises.test.ts`: "catch-up never switches lights on without a trusted off boundary".

## Task 4.3 — B27d: the timezone fallback becomes visible and schedule-blocking

- `localNow` keeps its fallback (circadian may degrade gracefully) but gains an out-param-style variant: `localNowResolved(timezone, nowMs): { clock: LocalClock; resolved: boolean }` (`resolved=false` on fallback). Schedule runtime: when `resolved === false`, boundary validation refuses with reason `'timezone unresolved — Homey clock and app clock may disagree'`, `assessHealth` reports `needs_repair` with locale key `state.noTimezone`, and catch-up refuses (4.2). Circadian: unchanged behaviour, but `diagnostics().timezone` already shows `'process-local'` — add `timezoneResolved: boolean` for clarity.
- Rationale comment to carry over: generated Flows fire on Homey's clock; day-validation on a *different* clock around midnight refuses legitimate boundaries — an hour-out schedule is acceptable for circadian, a wrong-day refusal is not acceptable for schedules.
- Tests: unresolved tz → boundary refused with the reason, health repairs; resolved path untouched (existing schedule-window tests stay green).

## Task 4.4 — B27b + B27c: fail-closed sanitiser inputs

- **`sanitiseDays` (B27b):** only `null`/`undefined` mean "every day". Any other non-array → the *entry is dropped* with reason `'days is not a list'` (plumb a tagged return: `IsoWeekday[] | null | 'invalid'`; the caller already has the drop mechanism). Arrays keep current behaviour (invalid members filtered, 7 days collapses to null).
- **Entry IDs (B27c):** server-generated only. In the pairing save path, ignore client-sent `id` for *new* entries and assign `s<crypto.randomUUID().slice(0,8)>`; for entries round-tripping through repair (existing ids), enforce `/^[A-Za-z0-9_-]{1,32}$/` — a violating id gets a fresh one (and, because the binding key changes, Phase 1's replacement machinery cleanly swaps the flows). Assert no `:` can survive into `sched:<id>:<boundary>`.
- Tests: string/object/boolean days → dropped with reason; colon-bearing id regenerated and old flows replaced (integration-style against fake bridge); round-trip of a valid existing id unchanged.

## Task 4.5 — B27e: overnight off-Flow labels

- In `schedule-bindings.ts` `boundaryLabel` (or wherever the off flow's name is composed): when `crossesMidnight(entry)`, label the off boundary with the *shifted* day set (`previousWeekday` inverse — i.e. each day +1) or the explicit form `"off 01:30 (starts Fri)"` — pick whichever reads better against the existing name format and keep it stable (name changes churn `hasBeenUserEdited`? — **No**: names are never compared (I8), and reused flows are not renamed; only newly created/replaced flows get the new label. State this in the commit message.)
- Test: Friday 23:30 + 2h → off label names Saturday/next-day, on label unchanged; non-crossing entries unchanged.

## Exit criteria

- Overlap matrix green; catch-up gate green with all refusal modes; timezone-unresolved behaviour split correctly between schedule (blocking) and circadian (degraded).
- `sync-views` clean; new locale keys present in `locales/en.json` and rendered in the schedule pairing view.
- Safety-promises file grown by the catch-up promise.
