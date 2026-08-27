# Phase 6 — Consolidation, typing & runtime validation

**Goal:** Extract the shared shapes that Phases 1–5 have just made correct, retire the remaining duplication, type the API boundary, and put runtime validation at the two trust boundaries. Deliberately late: extraction captures *fixed* behaviour, and the D3 runner is where the S4 validators plug in.
**Findings:** D1 (LK-056), D3+S4 (LK-067/018/022/035), D5–D8 remainder (LK-066), D9 (LK-069), D11 (LK-071), Q1 (LK-055), Q2 remainder (LK-070), Q4 (LK-057).
**Files:** managers ×3, `lib/support/`, new `lib/time/`, new `lib/validation/`, `lib/mapping/mapping-engine.ts`, `lib/runtime/controller-runtime.ts`, `api.ts`, `lib/profiles/*`, `lib/schedules/*`, `lib/circadian/*`, `settings/index.html`, pairing views (via sync-views), `locales/en.json`.
**Invariants:** all. This phase is refactoring-heavy: every task must land with **zero behavioural diff** except where a validator now *rejects* previously-accepted invalid data (S4 — those cases get tests and locale strings).

---

## Task 6.1 — D1: generic `RuntimeRegistry`

- Create `lib/runtime/runtime-registry.ts`: `class RuntimeRegistry<TRuntime extends { stop(): Promise<void>; refreshTargets(): Promise<void> }>` owning: the Map, `register(id, factory)` with Phase 3.2's start-before-insert semantics, `unregister` (remove-before-stop), `get/all`, the coalesced `onCatalogChange(refreshFn)` (the 500 ms trailing timer — one implementation, cancellable), and `destroyAll` (clear timer → `Promise.allSettled` over stops, logging failures — adopting LK-041's teardown resilience here, once).
- Each of the three managers composes it and keeps only its domain glue: controller `dispatchWithReason` + `normaliseMagnitude`, schedule `timeCard()` memoisation + `onCredentialChange`, circadian ticker + `tickAll`. The `ephemeral()` constructors stay in the managers (they differ meaningfully — `startWithoutFlows` vs `startIdle`).
- Existing manager tests keep passing unmodified where possible; add registry-level tests for the coalescer and `allSettled` teardown (one failing stop doesn't block the rest — new behaviour, small, deliberate, note in commit).

## Task 6.2 — D3 + S4: shared migration runner with a required validator hook

- Create `lib/support/migrations.ts`: `runMigrationChain<T>(raw, current, table, label, validate): MigrationResult<T>` — object check, finite non-negative integer `schemaVersion` (else version 0? **No**: non-numeric → 0 as today for absent, but a *present non-integer* value → throw `label + ' schema version is malformed'`), refuse-newer, step loop with non-advancing/skip detection and a max-steps guard, then **`validate(result)`** which must return the typed value or throw.
- The three migration modules become table + validator + one-line wrapper. Historical steps stay verbatim and immutable in their modules.
- **S4 validators** (`lib/validation/`): hand-written guards (no new dependency — bundle size and the node16 target argue against zod; small explicit functions match repo style): `validateControllerProfile`, `validateSchedulePlan`, `validateCircadianPlan`. Depth: discriminants exhaustive (unknown `LightFunction`/target kind/binding kind → throw), numbers finite and in-range, arrays bounded (mappings ≤ 64, entries ≤ 32, points ≤ 48 — generous caps, documented), ids matching the Phase 1/4 patterns, `managedFlows` entries shaped `{flowId: nonempty string, bindingKey, variantKey, fingerprint, managedVersion, createdAt}`. **Quarantine semantics:** the device base's `loadPlan()` catches validation failure exactly like migration failure today (device unavailable with `state.noConfiguration`-class message + a new `state.invalidConfiguration` key), and — critical — `onDeleted`'s never-registered fallback must **not** call `bridge.removeAll` with references that failed validation (deleting from forged refs is the attack the review names). Filter refs through the shape check before any delete.
- **Pairing DTO validation (S4 second half):** in the three drivers' save/selectTargets/setMapping handlers, run the same validators (or their sub-validators) on incoming payloads before persisting — including LK-035's explicit-device-target rules: dedupe, require membership in the current light-candidate catalogue, require `onoff`, per-rule `groupKey` ⊆ selected targets. Rejections return the reason to the view (existing error plumbing).
- Tests: property-ish fuzz over malformed JSON for each validator (nulls, wrong types, NaN, huge arrays, unknown discriminants) → reject with reasons, never throw uncontrolled; forged managedFlows never reach `removeAll`; valid legacy fixtures pass unchanged; the malformed-version rule.

## Task 6.3 — D8: `lib/time/` and `lib/validation/unit-interval.ts`

- Move `MINUTES_PER_DAY`, `formatMinutes`, `parseMinutes` to `lib/time/wall-clock.ts`; move `local-time.ts` to `lib/time/local-clock.ts` (update the circadian import whose comment already apologises for the location — retire the apology). `schedule-types.ts` and `circadian-types.ts` re-export for compatibility or update all imports (prefer updating imports; it's a closed codebase). `sanitiseUnit` variants → `lib/validation/unit-interval.ts` with feature policy ("0 means unset") kept in the feature modules.
- Tests move with the code; add one cross-check test asserting both features format/parse through the same functions (import-identity assertion).

## Task 6.4 — Q2 remainder: one intent translator; D5 remainder: timers everywhere

- Move `intentForFunction` into `mapping-engine.ts` as `intentForLightFunction(fn, behavior, magnitude = 1)`; `MappingEngine.intentFor` delegates (passing the normalized event magnitude via `stepFor`'s logic folded in); `controller-runtime.ts` imports it for the Test path. Table-driven test: every `LightFunction` × both paths → identical intents (the live-vs-Test equivalence LK-070 wanted). Extract `classifyReconcileError(error, credentialStatus): StateDetail`-style helper used by both reconcilers (the twin catch blocks).
- Migrate remaining timer boilerplate (`RampEngine`, `SupersedeGate`, circadian runtime + manager) to `lib/support/timers.ts` via `withDefaults` — mechanical; existing injected test stubs adapt trivially.

## Task 6.5 — Q1: type `api.ts` and the DTOs

- `api.ts`: type `homey.app` via one `const app = homey.app as LightkeeperApp` per handler (export the app class type from `app.ts` — keep `module.exports` runtime shape (I10); add `export type LightkeeperApp = InstanceType<typeof …>` or declare an interface listing the public members the api uses). All `(r: any)` lambdas disappear.
- Define and export `StatusResponse` / `DiagnosticsResponse` interfaces next to `api.ts`; `diagnostics()` on the three runtimes returns typed shapes instead of `Record<string, unknown>` (define per-runtime diagnostic interfaces in their modules). The settings page's contract is now written down; update the api.ts docblock schemas to reference the types.
- Add minimal structural interfaces for the `homey-api` objects the bridge/catalog normalise (`RawFlow`, `RawFolder`, `RawDevice`, `RawZone`) in a `lib/homey-api-types.ts`, used at the normalisation seams (`toRecord`, `flowFolderInfos`, `DeviceCatalog.refresh`). `any` remains *only* inside `homey-api-service.ts` and those seams; enable `@typescript-eslint/no-explicit-any` as error for `lib/**` excluding the seam files (config-scoped override).

## Task 6.6 — Q4 + D9 + D11

- **Q4:** replace remaining `JSON.stringify` equality: managedFlows compare → field-wise on `(flowId, fingerprint, variantKey)` per ref; catalogue compare in `refreshCatalogue` → a small canonical serialiser with sorted keys or field-wise compare (state which fields are deliberately ignored in a comment); target-id compares already retired by Phase 2.5's fingerprint.
- **D9 (rename slice only — the orthogonal health model is *out of scope*, recorded as future work):** rename the cross-cutting ownership field `controllerId` → `ownerDeviceId` in `ManagedFlowSummary`, `flowFolderInfos`, `liveDeviceIds`, sweep code, and the bridge args? **Stop:** the *flow argument* `controller` is persisted in every installed user's generated Flows — renaming the arg breaks attribution of existing flows. Rename **internal** identifiers only; the wire/persisted names (`args.controller`, profile fields) stay, with a comment at each boundary noting the historical name. `api.ts`'s `liveControllers` response field: keep the key (settings page consumes it), rename the internal function, fix the docblock to say "live Flow owners (controllers and schedules)".
- **D11:** move the credential-failure→locale map and the state→label/class maps into `locales/en.json`-adjacent data consumed by TypeScript (`credentialFailureKey` reads it) and injected into views: since views are materialised by `sync-views.mjs`, extend the script with a token-substitution step (`/*__PRESENTATION_MAPS__*/` marker replaced by the JSON) for `settings/index.html`? — settings is not under sync-views; simplest robust version: one generated `presentation-maps.json` checked in, a unit test asserting the TypeScript map, the settings copy, and each pairing credential view copy are **exhaustive over the union and mutually consistent** (extends the existing mirror test to all copies). Full generation is optional (LK-064 territory); the exhaustiveness test is the requirement.

## Exit criteria

- Managers ≤ ~90 lines of domain glue each; migration engine exists once with validators wired; quarantine semantics tested including the forged-refs delete guard.
- `api.ts` fully typed; `no-explicit-any` clean outside the seam files; live-vs-Test equivalence test green.
- Zero behavioural diffs outside the S4 rejections and the `allSettled` teardown (both tested and noted).
- `DEVIATIONS.md` records D9's health-model deferral and any wire-name constraints found.
