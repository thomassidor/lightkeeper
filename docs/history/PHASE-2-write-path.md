# Phase 2 — Write path & target lifecycle

**Goal:** Make "a write happened" mean "a write completed", stop the app from ever overriding an explicit user action, and make target refresh release what it no longer owns. Staged: the completion contract (2.2) is the foundation for 2.3–2.5 — do not reorder.
**Findings:** B2 (+LK-015), B16 (LK-013), B17 (LK-016), B9 (+LK-014), B1 (+LK-036), B8, B3 (+LK-023, D10/LK-068), B24 (LK-038), B27g (LK-058).
**Files:** `lib/outputs/command-scheduler.ts`, `lib/outputs/light-target-adapter.ts`, `lib/outputs/target-state-cache.ts`, `lib/outputs/intent-planner.ts`, all three runtimes, `api.ts` (`getStatus.recentWrites`).
**Invariants:** I2, I6, I9. The scheduler's public shape changes here — every submit call site is in this repo; update them all in the same commits.

---

## Task 2.1 — B2 stage 1: flush-aware `drain()`

- In `CommandScheduler`, store the in-flight flush promise per queue (`queue.activeFlush: Promise<void> | null`). `flush()` sets it for its own run and clears it in `finally`. `drain()` becomes a loop per device: cancel timer → await `activeFlush` if set → `flush()` → repeat until no timer, no pending, no in-flight. A re-entrant `flush()` on a flushing queue returns `activeFlush` instead of `undefined`-fast.
- While here, migrate the class's timer/now injection to `lib/support/timers.ts` (D5 slice) — mechanical, keeps existing test stubs working via `withDefaults`.
- Tests: submit → immediate drain resolves only after a deferred-blocked executor completes, including a write submitted mid-flush (the "guaranteed final write" now provably inside `drain()`); `stop()` during a blocked flush still prevents the post-flush reschedule.

## Task 2.2 — B2 stage 2: the completion contract

- `submit(writes)` returns `SubmitResult { batchId: string; completion: Promise<WriteOutcome[]> }` where `WriteOutcome` is a discriminated union: `succeeded { deviceId, capability, value, ms }`, `failed { deviceId, capability, error: string }` (sanitised message only — I2), `coalesced { deviceId, capability }` (a later value replaced this one before flush), `dropped_capacity { deviceId }`, `cancelled { reason }` (stop before flush).
- Implementation guidance: give each pending map entry the list of batch resolvers waiting on it; when a flush executes/coalesces/fails a capability value, settle the relevant outcomes; `stop()` settles everything outstanding as `cancelled`. Keep `submit` itself synchronous-fast (no awaiting inside).
- Backward compatibility: callers that ignore the return value keep working; TypeScript will not force updates, so grep every `\.submit(` call site (three runtimes) and consciously decide per site in Tasks 2.3–2.5.
- Tests: batch outcomes for plain success, coalesce (two submits, one flush), capacity drop, stop-cancel, executor failure.

## Task 2.3 — B16: commit-on-success cache

- In `LightTargetAdapter.write()`: keep the **echo registration** before dispatch (register the expected echo early so a fast callback is recognised — split `TargetStateCache.noteWrite` into `noteEcho(deviceId, capability, value)` [recentEchoes only] and `commitDesired(deviceId, capability, value)` [desired* fields]). Call `noteEcho` before `setCapabilityValue`, `commitDesired` after it resolves. On rejection: do **not** commit; if a previous desired value existed it stands, else leave undefined; record the failure as today.
- Guard against supersession: if another write to the same device/capability committed while this one was in flight (compare a per-key monotonically increasing write seq captured at dispatch), skip the commit.
- Update `planBrightnessDelta`'s "update desired level only" off-branch: it intentionally commits desired without a write — switch it to `commitDesired` explicitly (behaviour unchanged, now named).
- Tests: failed dim → `currentDim` still returns pre-write value → next relative dim plans from it; failed write followed by an external echo of the *old* value is not misread as external change; in-flight supersession does not clobber the newer commit.

## Task 2.4 — B17: circadian bookkeeping on completion

- In `CircadianRuntime.applyNow()`: replace the immediate `noteWrites(writes)` with consumption of `submit(...).completion` via `fireAndForget`: on each `succeeded` outcome, update `lastWritten` for that device/field with the succeeded value and timestamp; ignore `coalesced` (a newer batch owns it), treat `failed/dropped/cancelled` as not-written (retry stays eligible next tick).
- `verifyStayedOff` moves behind completion too: start the observation window only after the *temperature* write for that device reports `succeeded`, correlated by batchId; keep one keyed probe per device, cancelled by a newer write, target removal (2.5), or stop. The persisted self-disable verdict (`preStageDisabled` → `onPlanChange`) may only be produced by a correlated probe.
- Tests: coalesced-away write does not advance `lastWritten` (next tick rewrites); failed pre-stage write starts no probe; probe correlates to its own write generation and a newer write cancels the older probe; the persisted-verdict path still works end to end (existing circadian tests will guide).

## Task 2.5 — B3 + D10: target snapshot & real release

- Add `lib/outputs/target-snapshot.ts`: `resolveSnapshot(resolver, cache, spec)` → `{ ids: string[]; names: string[]; devices: ResolvedDevice[]; fingerprint: string }` where `fingerprint` hashes per-device `(id, available, capability options for onoff/dim/light_temperature)` — so a same-ID re-pair or availability flip changes it even when the id list doesn't.
- Rewrite all three runtimes' `refreshTargets()` on the snapshot: compare fingerprints (not `JSON.stringify(ids)`); on change, diff old→new ids; for **removed** ids: `adapter.unsubscribe(id)`, clear cache state for the id (add `TargetStateCache.forget(deviceId)`), cancel that device's pending adapter probes (add `LightTargetAdapter.cancelPending(deviceId)` — pendingChecks becomes a per-device map), stop any ramp targeting it is N/A (ramps are per-control, but `stopAll('target_unavailable')` when the set becomes empty), and drop the cached device handle; for added/changed ids: prime, `adapter.refresh`, subscribe. After refresh, controllers call `assessHealth()` (schedule/circadian call their own) so recovery/degradation is visible without restart.
- The circadian case is the acceptance bar: after removing light B from the plan's zone, an external power-on of B must produce **zero** writes.
- Tests: removal releases subscription/cache/probes and stops writes (circadian); same-ID capability-range change re-primes and re-clamps; availability flip re-runs health; unchanged snapshot is a no-op (no churn — Q4 partially retired here for target compares).

## Task 2.6 — B1 + B8: the app never overrides the user

**2.6a `verifyCameOn` (B1):**
- Guard: before writing the corrective `onoff:true`, stand down if `cache.state(deviceId).desiredOn === false` **or** any `onoff` change (either direction) was observed for the device after the originating write's timestamp (track `lastOnOffObservedAt` per device in the cache — set in `applyExternalChange`).
- Route the corrective write through the **scheduler** (the runtime's, passed into the adapter as an executor callback — simplest: adapter exposes `onImpliedOnFallback(deviceId)` and the runtime wires it to `runIntentNow({type:'power',value:true},[deviceId])`), so it inherits ordering, rate, outcomes, and `noteEcho/commitDesired`. Keyed one-per-device; cancelled by 2.5's `cancelPending`.
- Regression test (write first, fails today): dim-with-impliesOn → external off inside the window → probe fires → **no** on-write.

**2.6b temperature policy (B8):** in `planTemperatureDelta`, skip targets whose `currentOn(deviceId) === false` with skip reason `'off — temperature never turns a light on'` (the simple policy; matches the docblock verbatim). Circadian pre-stage is unaffected (it writes to off lights deliberately, via its own path and probe). Tests: off target skipped for temp delta; on targets unchanged; add the promise to `safety-promises.test.ts` ("a temperature change never implicitly turns a light on").

## Task 2.7 — B9 + B24 + B27g: capacity honesty, detail-change notifications, app-level write log

- **B9:** in `CommandScheduler`, evict a queue when it has no pending, no timer, no in-flight flush (check at the end of `flush()` and in `drain()`); the 64 cap now bounds *concurrent* devices. When `queueFor` still returns null, settle the batch outcomes as `dropped_capacity` and call `onError(deviceId, capability, new Error('scheduler at capacity'))` once per device per burst. Test: cycle 100 ids through an idle scheduler; all schedulable; forced-cap drop is observable.
- **B24:** in all three runtimes' `setState`, compare `(state, detailKey, detailTokens-JSON, detailText)` — notify when any differs; keep a `stateRevision` counter in diagnostics. Test: same-state/different-detail fires the callback once.
- **B27g:** add one app-level `BoundedLog` (cap 50) of write outcomes: the adapter takes an optional `onWriteResult` sink; `app.ts` wires all runtimes' adapters to one shared log via deps (thread through the managers' `baseDeps`). `api.ts` `getStatus.recentWrites` reads the shared log (globally time-ordered, all devices) instead of `all()[0]`. Keep per-runtime `recentWrites` in `diagnostics()` unchanged. Test: writes from two runtimes interleave in the shared log; settings payload shape documented in the api.ts docblock updated.

## Exit criteria

- Completion contract in place and consumed by cache commit, circadian bookkeeping, and capacity reporting; Test/Preview (`runIntentNow`, `testEntry`, circadian `drain`) provably resolve after writes complete (I9 checked manually via existing pairing tests).
- B1 and B8 regression tests green (both fail on pre-phase code — confirm before fixing).
- Target removal releases everything; the circadian ex-target acceptance test green.
- `safety-promises.test.ts` grown by the two promises above.
