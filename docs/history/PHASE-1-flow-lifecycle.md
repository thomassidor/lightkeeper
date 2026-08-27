# Phase 1 — Generated-Flow lifecycle (the destructive cluster)

**Goal:** Make Flow creation, replacement, cleanup, and attribution correct under failure, concurrency, and user interference. This phase carries the highest user-facing risk in the review: duplicated automation and deletion of user-owned Flows.
**Findings:** B12 (LK-001), B13 (LK-002), B14 (LK-006), B22 (LK-003), B4 (+LK-004/005/034), B5+D4 (LK-032), B7 (LK-005), B21 (LK-025), Q6 (LK-024), B27a (LK-028).
**Files:** `lib/bridge/flow-bridge-manager.ts`, `lib/bridge/flow-folder-manager.ts`, `lib/credential-service.ts`, `app.ts`, `api.ts`, `drivers/controller/driver.ts`, `drivers/schedule/driver.ts`, both runtimes' `reconcileFlows`, `settings/index.html` (sweep flow only).
**Invariants in play:** I1, I2, I3, I5, I8. Task order matters — 1.1 → 1.8.

---

## Task 1.1 — D4/B5: single-source the credential write-probe, with `try/finally`

The closure `createFlowFolder({name:'Lightkeeper (checking permissions)'})` + `deleteFlowFolder` is copy-pasted in `app.ts:~162`, `api.ts:~136`, `drivers/controller/driver.ts:~105`, `drivers/schedule/driver.ts:~86`.

- Add to `lib/credential-service.ts`: `export async function flowWriteProbe(client: any): Promise<void>` — create the probe folder, capture its id, and delete it in a `finally` (best-effort: a failed delete is logged via a passed-in log fn but does not change the probe verdict; a failed **create** is the verdict). Name the folder with the existing string (it is user-visible; keep it stable).
- Optionally sweep stale probe folders: at the top of the probe, list root-level folders named exactly the probe string and best-effort delete them (self-healing for past leaks).
- Replace all four call sites with `flowWriteProbe`.
- Tests: probe deletes on success; probe deletes (attempts) on validator failure after create; a create-rejects case classifies without leaking; four call sites gone (grep test acceptable).

## Task 1.2 — B27a: idempotent deletes

`FlowBridgeManager.deleteFlow()` returns `false` on *any* error, counting an already-deleted Flow as a failed delete.

- Classify not-found (404 / message-match per what `homey-api` actually throws — inspect its error shape at runtime in a test before hardcoding) as **success**: the desired end state exists. Keep genuine auth/connectivity/unknown errors as `false`. Put the status extraction in one small helper (`lib/support/homey-errors.ts`, `isNotFound(error)`), because Phase 4 reuses it.
- Tests: not-found → true, no failure log; 403 → false.

## Task 1.3 — B12: fingerprint mismatch = explicit replacement

In `sync()`: when `existing && live`, not user-edited, and `existing.fingerprint !== request.fingerprint`, the code currently creates a new Flow and never deletes `existing.flowId` (the abandonment loop's `if (wanted.has(key)) continue;` skips it).

- Change the branch: create the replacement first, then explicitly `deleteFlow(existing.flowId)` (idempotent per 1.2), count it in `result.deleted`, and add its folder to `abandoned`. If the delete fails (non-404), log both Flow ids and push a new field `result.staleReplacements: string[]` so callers can surface a degraded state instead of silently proceeding.
- Regression test (write it first; it must fail on current code): stored ref under fingerprint A with a live identical Flow; sync under fingerprint B; assert exactly one live Flow, `created===1`, `deleted===1`.
- Second test: replacement delete fails (inject via 0.2c) → both flows live, `staleReplacements` names the old id.

## Task 1.4 — B13: creation journal + compensation

`sync()` creates sequentially; a mid-pass failure discards `result.references`, leaving live untracked Flows that duplicate on retry.

- Maintain `const createdThisPass: string[]` — push every `createFlow` result id immediately. Wrap the create/reuse loop so that on **any** throw, a compensation block best-effort deletes every id in `createdThisPass` (idempotent deletes make retry safe), logs what it could not remove, then rethrows the original (sanitised — I2) error.
- Do **not** compensate flows that were *reused* — only this pass's creations.
- Tests (using `failNth`): fail the 2nd of 3 creates → zero net new Flows on the fake client; fail the folder `placeExisting` step after creates → creations compensated; happy path unchanged.

## Task 1.5 — B14: empty desired set reconciles to empty

Both `reconcileFlows()` implementations early-return when nothing is mapped (`if (mapped.length === 0) return;` in `controller-runtime.ts`; `if (this.plan.entries.length === 0) return;` in `schedule-runtime.ts`).

- Remove the early returns **when `managedFlows.length > 0`**: call `bridge.sync` with `mapped: []`, which must delete every existing reference and commit `managedFlows: []` (verify `sync()` handles an empty `wanted` correctly — the abandonment loop already does the work; ensure no device folder is created for an empty set: skip `resolveForDevice` when `request.mapped.length === 0`, falling back to per-flow folder info for cleanup).
- Keep the early return when there is nothing mapped **and** nothing stored (the common cold-start case must not pay a folder read).
- Tests: N mappings → 0 removes all N flows, empties `managedFlows`, deletes the emptied device folder; 0 → 0 performs no bridge call.

## Task 1.6 — B22: single-flight reconciliation + root-folder mutex + deferred credential fan-out

Three verified race sources: overlapping `reconcileFlows` per runtime (boot vs. credential fan-out), `FlowFolderManager.load()`'s read-then-create of the root folder, and `reportSuccess()` firing `onStatusChange` mid-reconcile.

- **Per-runtime single-flight:** wrap the body of both `reconcileFlows()` methods in `SingleFlight.coalesce(this.controllerId, ...)` (from 0.1d) using one shared instance per manager (inject via deps). Latest-state semantics: a request arriving mid-run schedules exactly one re-run.
- **Root-folder mutex:** wrap the "find or create root" section of `FlowFolderManager.load()` in a single app-wide `KeyedMutex.run('flow-root', ...)` (one instance on the FlowBridgeManager, passed to the folder manager). Device-folder creation in `resolveForDevice` goes under `KeyedMutex.run(\`folder:\${deviceName}\`, ...)`.
- **Deferred fan-out:** in `app.ts`'s `onStatusChange`, replace the direct `void this.controllers?.onCredentialChange()` calls with `fireAndForget(queueMicrotask→...)` **debounced by ~250 ms** (a tiny trailing-edge debounce using the manager-style timer pattern), so the status flip caused by a reconcile's own first write does not fan out while that reconcile runs. Combined with single-flight this makes the boot storm converge.
- Tests (deferred promises): two overlapping syncs for one controller yield one folder and one flow per key and the later desired state wins; concurrent `load()` creates one root; a status flip during a reconcile results in exactly one trailing re-reconcile.

## Task 1.7 — B4 + B7: safe attribution, installed-device liveness, token-bound sweep

Three coordinated changes; keep I3 front of mind — this task must only make deletion *harder*.

**1.7a Hide the bridge cards from the editor.** In `.homeycompose/` flow action sources for `bridge_event`, `bridge_numeric_event`, `bridge_token_event`, add `"deprecated": true`. Run `npm run validate` and confirm `app.json` regenerates with the flag; confirm existing generated Flows still validate. **VERIFY-ON-HARDWARE:** deprecated cards (a) disappear from the Flow editor palette, (b) keep firing in existing Flows, (c) can still be created via the API-key client (`createFlow` with a deprecated card id). If (c) fails on hardware, revert this sub-task and record in `DEVIATIONS.md` — the remaining sub-tasks still stand on their own.

**1.7b Liveness from installed devices, not registered runtimes.** In `api.ts`, replace `liveDeviceIds(app)`'s runtime-map source with the union of runtime ids **and** every installed Lightkeeper device's `getData().id` across the controller and schedule drivers (`this.homey.drivers.getDriver('controller').getDevices()` etc. — resolve the exact SDK call from `@types/homey`; it exists on Driver). A device that failed to register (bad migration) still protects its Flows. Keep circadian devices excluded (they own no Flows — the existing comment explains why; move that comment along).
- Also apply the same set inside `sweepOrphans` (it recomputes; both paths must use the new function).

**1.7c "Provably generated" gate + preview token.**
- In `FlowBridgeManager`, add `looksGenerated(flow, cards): boolean`: the flow has exactly one action, that action is one of our cards, its `controller` arg is a well-formed Lightkeeper device id (`/^lk-(ctrl|sched)-\d+-\d+$/` — matches the drivers' generator; keep in one exported const), and its `event_key` arg is non-empty. `findManagedFlows` gains a `generated: boolean` per entry; **sweep deletes only `generated === true` entries**; the rest are returned in a new `unmanaged` bucket ("found, left alone").
- `countOrphans` returns the exact candidate `flowIds` plus `token` = a stable hash (sorted ids + live-set hash). `sweepOrphans` takes `{ token, flowIds }`, recomputes, and deletes only the intersection of (approved ids) ∩ (still-orphaned, still-generated now); a token mismatch returns `refused: 'stale_preview'` with fresh counts. Update `settings/index.html`'s sweep flow to pass the token and render the refusal string (add locale keys to `locales/en.json`).
- Tests: a hand-built flow using a bridge card with a garbage controller arg is counted `unmanaged`, never deleted; a device that never registered keeps its flows; stale token refuses; sweep with one live + one failed-init device deletes nothing belonging to either.
- Add the safety promise to `safety-promises.test.ts`: "the sweep never deletes a flow that does not match the generated template".

## Task 1.8 — B21 + Q6: honest edit detection and surfaced `unsupported`

**1.8a** In `hasBeenUserEdited`: also return `true` when `live.enabled === false`, or when `(live.conditions ?? []).length > 0`. Do **not** start comparing name or folder (I8 — placeExisting depends on it; the function's own comment explains). One test per newly compared field, plus one asserting rename/move still read as untouched.

**1.8b** In both `reconcileFlows()`: when `result.unsupported.length > 0`, set `needs_repair` (controller) / `flowsHealthy = false` + `needs_repair` (schedule) with a new locale key `state.unsupportedMapping` carrying the binding labels, and include `unsupported` in `diagnostics()`. In the controller pairing driver, preflight: run `compileBinding` per mapped input at save time inside the existing save handler and reject the save with the reason (the compiler is pure — no client needed; cards can be faked from the stored catalogue refs since only ids/uris are used). Tests: a range-over-ceiling mapping blocks save with the reason; an existing profile that becomes unsupported at reconcile lands in `needs_repair` naming the control.

## Exit criteria

- All Task tests pass; full protocol green; `sync-views` clean if settings/locales touched.
- Fault matrix demonstrably covered: Nth-create failure, replacement-delete failure, overlapping reconciles, empty-set transition, stale sweep token, unmanaged-flow protection.
- Hardware checklist emitted for 1.7a (three bullets above).
- `safety-promises.test.ts` grown by the sweep promise and the replacement promise ("a changed binding leaves exactly one live flow").
