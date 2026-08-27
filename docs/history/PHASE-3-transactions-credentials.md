# Phase 3 — Device/runtime transactions & credential atomicity

**Goal:** Make lifecycle transitions (register, apply, pause, repair) ordered and rollback-safe, persistence durable where correctness depends on it, and credential state linearizable. The D2 base-class extraction comes **first** so the transaction work is written once, not three times.
**Findings:** D2 (device base extraction), B23 (LK-017/040), B26 (LK-050), B15 (LK-011/012), B25 (LK-010), B6, B10 (final sweep).
**Files:** new `lib/devices/lightkeeper-device.ts`, all three `drivers/*/device.ts`, all three managers, `lib/credential-service.ts`, `lib/homey-api-service.ts`, `app.ts`.
**Invariants:** I2, I4, I7, I9, I10.

---

## Task 3.1 — D2: extract the device base class (VERIFY-ON-HARDWARE)

- Create `lib/devices/lightkeeper-device.ts`: `abstract class LightkeeperDevice<TPlan> extends Homey.Device` parameterised by (constructor-abstract or protected getters): `storeKey: string`, `migrate(raw): {plan, migrated, fromVersion}`, `registry()` (the app manager), `missingKey: string` (locale for no-config), and hooks `availabilityFor(state)` (default: `disabled` → unavailable; schedule/circadian override to available — I7) and `beforeRegister(previous, next)` (controller overrides for `carryForwardFlows` + obsolete-flow deletion).
- Base owns: id getter, `loadPlan()` (load-migrate; persistence of the migrated value becomes **awaited** here — first slice of B26), `describe()` (verbatim from the three copies, keep its comment), `onRuntimeState()` (generic switch using `availabilityFor`), `register()`, the pause-switch machinery (`onoff` listener + `setEnabled`) for the two switchable types via an opt-in `withPauseSwitch` flag, `onUninit`, and the shared parts of `onDeleted` (runtime destroy/unregister; fall back to `bridge.removeAll(storedRefs)` when never registered — circadian passes empty).
- Each concrete `device.ts` shrinks to its data + real differences (`onRenamed` on controller and schedule; circadian's no-flow delete). Every existing comment that encodes a decision (paused-while-unavailable init fix, "restart must not un-pause", persist-on-state-change) moves into the base **once**.
- Compile target check: the base imports `Homey` from `'homey'`; the concrete classes remain `module.exports = class X extends LightkeeperDevice` (I10). Confirm `tsc` emits it into `.homeybuild` resolvable from the driver files.
- **VERIFY-ON-HARDWARE:** all three device types init, pause/resume, rename, repair, and delete correctly on a real Homey Pro after this refactor (the loader indirection is the risk).
- Tests: the existing device behaviours are mostly hardware-level; add unit tests for the base's pure parts (`describe` resolution order, availability mapping per state per subclass flag, migrated-write awaited). Behavioural parity is otherwise guarded by the hardware checklist.

## Task 3.2 — B23: transactional register / apply / availability

Now implemented once, in the base + managers:

- **Managers:** `register()` constructs and `await runtime.start()` **before** inserting into the map (a failed start never becomes dispatchable); `unregister` removes from the map **before** awaiting `stop()` (no dispatch into a stopping runtime). Apply to all three managers (they are still three files until Phase 6 — make the change identically; Phase 6's D1 extraction will then capture the fixed shape).
- **Register returns the authoritative initial state:** runtime `start()` already drives `setState`; additionally expose `runtime.currentState` + last detail after start, and have the base's `applyPlan/applyProfile` end with `this.applyRuntimeState(state, detail)` **instead of** unconditional `setAvailable()` — the race between the `void` callback and the trailing `setAvailable` disappears because the final word is the returned state.
- **Rollback on failed apply:** in the base's apply: persist the candidate store only after `register()` resolves; on register/start failure, restore the previous store value, attempt `register(previous)`, and set unavailable with the (sanitised) failure text if that also fails. Controller's `beforeRegister` obsolete-flow deletion stays *before* the new register (its ordering comment explains why) but after candidate validation.
- **Per-device operation queue:** wrap apply/setEnabled/onRenamed/state-persist in a `KeyedMutex.run(deviceId, ...)` owned by the base, so pause-spam, repair saves, and rename reconciles serialize (LK-040).
- Tests: failed `start()` → not in dispatch map, old store intact, old runtime restored; state callback landing "late" cannot flip an unavailable device to available; interleaved setEnabled calls apply in order (deferred promises).

## Task 3.3 — B26: awaited persistence where correctness depends on it

- Change `onProfileChange`/`onPlanChange` dep types to `(p) => Promise<void>`; the base implements them as awaited `setStoreValue`. In both `reconcileFlows()` implementations, **await** the persistence of new `managedFlows` before treating the reconcile as committed; on persistence failure, log, set `needs_repair` with a `state.persistFailed` locale key, and (Phase 1's journal makes this safe) leave the created flows in place — the next reconcile will adopt-or-recreate against the journal's compensation rules. The circadian pre-stage verdict persist is likewise awaited.
- Tests: persistence rejection → repair state, no silent "committed"; migrated-store write awaited (from 3.1).

## Task 3.4 — B15: atomic credential replacement + generations

In `lib/credential-service.ts`:

- **Isolated candidate validation:** `setCredential` builds and validates the candidate client in local variables (it already does); on failure return a **candidate-scoped** status object (same `CredentialStatus` shape, but do *not* assign `this.status`, do not fire `onStatusChange`, do not touch `this.client`). The active credential's status remains whatever it was. Callers (api.ts handler, pairing handlers) already just return the result — verify none rely on the global mutation (the settings page re-reads via `getStatus` on next poll; adjust `settings/index.html` to render the returned candidate status directly, which it effectively does).
- **Generation guard:** add `private generation = 0`, incremented by successful `setCredential` and by `clearCredential`. `revalidate()` captures the generation (and token) at entry and discards its result — no status publish, no client mutation — if either changed by completion time. `getWriteClient`'s existing token-changed guard stays (I4).
- **Client hygiene on real failure:** `reportFailure` (real write failures) keeps its current behaviour — that path was correct.
- Tests: bad-new-over-good-old → active status still valid, writes still succeed, candidate result says malformed/rejected; revalidate(old) completing after set(new) publishes nothing; clear-during-set cannot resurrect; the existing credential-service suite continues to pass.

## Task 3.5 — B25: acquisition inside the boundary

- In `HomeyApiService.withWriteClient`, move `const api = await this.write()` **inside** the `try`, so acquisition failures hit `reportFailure` + `sanitizedWriteError` like operation failures. Preserve the load-bearing comment; extend it to say acquisition is covered.
- Test: `createWriteClient` rejects with a message embedding a syntactically valid key → thrown error message contains `<redacted>`, `credentialFailure` classified, status updated.

## Task 3.6 — B6: read-client invalidation

- Add `HomeyApiService.reportReadFailure(error)`: on classified transport errors (connection reset/refused/timeout — use `isNotFound`-style helper siblings in `lib/support/homey-errors.ts`; do **not** invalidate on 4xx application errors), clear `readApi` so the next `read()` rebuilds (the `connecting` dedupe already makes that safe). Wire it in the highest-leverage callers: `DeviceCatalog.refresh`, `FlowBridgeManager.sync`'s reads, `LightTargetAdapter.deviceHandle` (which already deletes its own handle — add the report). If `homey-api` exposes a disconnect event on the client (inspect at runtime in a test), prefer subscribing to it and note which path was used in the code comment.
- While in `DeviceCatalog`: add the in-flight refresh dedupe (B11 first half — share one refresh promise) and invalidate `appNames` in `watch()`'s invalidator (B11 second half).
- Tests: transport-classified failure → next read rebuilds; app error → cached client kept; two concurrent `allDevices()` on a cold cache perform one fetch.

## Task 3.7 — B10 final sweep

- With lint's `no-floating-promises` as errors since Phase 0, grep for remaining `fireAndForget` sites whose failure should actually *gate* their caller (the review's examples: device persistence inside state callbacks — now awaited via 3.2/3.3). Convert any such site to awaited; leave genuinely fire-and-forget sites (`execute`, ramp ticks, catalog fan-out) as labeled `fireAndForget`.

## Exit criteria

- Hardware checklist emitted for 3.1 (init/pause/rename/repair/delete × 3 device types) and for any 3.6 event-based path.
- Credential race tests green; acquisition-redaction test green; no unconditional `setAvailable()` after apply remains.
- All three `device.ts` files ≤ ~60 lines of feature-specific code; `describe()` exists exactly once in the repo.
