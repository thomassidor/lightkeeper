# Phase 5 — Binding model & discovery fixtures

**Goal:** One canonical binding shape that cannot lose constraints, exact range values, and a recorded-fixture corpus that converts the unverified discovery cluster into tests. Independent of Phases 1–4 (touches normalizer/compiler + one migration).
**Findings:** B20 (LK-008/009 — verified), LK-007/029/030/031/047 (plausible, unverified — verify here).
**Files:** `lib/inputs/event-normalizer.ts`, `lib/inputs/selectable-input.ts`, `lib/inputs/magnitude-collapser.ts`, `lib/bridge/flow-binding-compiler.ts`, `lib/profiles/migrations.ts` (schema bump), `lib/source-discovery-service.ts`, `test/fixtures/`.
**Invariants:** I1. **Migration rule (repo law): add an entry, never edit one.** The binding-shape change is a controller-profile schema bump (v→v+1).

---

## Task 5.1 — B20a: canonical `fixedArgs` on every binding

- In `selectable-input.ts`, reshape `LogicalSourceBinding`: every kind carries `fixedArgs: Record<string, unknown>` (rename of today's `args`, now present on **all** kinds); `flow_enum` keeps `argument/value` *on top of* fixedArgs (or is folded into `flow_fixed` with the enum value inside fixedArgs — prefer the fold: fewer kinds, and the compiler's `flow_enum` branch already just builds `{[argument]: value}`; keep `variantKey` semantics identical: `enum:<value>`); `flow_range` gains `fixedArgs` and (5.2) `values`.
- `bindingFor()` in the normalizer: the already-built `args` object (selector+direction) flows into **every** return, including `flow_range` — this is the actual bug fix.
- `compileBinding`/`compileRange`: `buildFlow` merges `fixedArgs` with the variant-specific argument in exactly one place.
- **Schema migration:** bump `CURRENT_SCHEMA_VERSION` in `lib/profiles/migrations.ts`; the new step maps stored bindings to the new shape (`args`→`fixedArgs`, absent→`{}`; if `flow_enum` is folded, rewrite kind). Binding data lives inside the persisted catalogue — confirm exact storage shape from `controller-profile.ts` before writing the step, and test the step against a fixture captured from the *old* shape.
- Regression tests (fail-first on 5.1's fixture): a card with selector + direction + enum-magnitude compiles so that **every** variant carries all three arguments; token bindings unchanged; fixed bindings unchanged; migrated old profiles compile identically for non-range kinds.

## Task 5.2 — B20b: exact enumerated values, not `[min,max]`

- `numericRangeOf` → `numericValuesOf(arg): number[] | null`: the exact finite unique sorted numeric ids (null if any non-finite). The ceiling check counts `values.length`. `flow_range` stores `values: number[]`; `compileRange` iterates them (`variantKey: \`range:${value}\``, stable for contiguous integer sets — the common case migrates without flow churn; sparse sets legitimately produce a different flow set, which Phase 1's replacement machinery handles). Validate at compile: empty/non-finite → `RangeExpansionTooLargeError`-style refusal (new `InvalidRangeError`, surfaced through the same `unsupported` path Q6 wired).
- Tests: sparse `{1,3}` → exactly two flows, no invented `2`; decimals `{0.5, 1.0}` → two flows with exact values; duplicates/unordered normalised; corrupted persisted values refuse, not loop.

## Task 5.3 — Recorded card-schema fixture corpus + verification of the unverified cluster

- Create `test/fixtures/cards/` with JSON captures of real trigger-card schemas for the four reference devices (IKEA STYRBAR, Hue Dimmer v2, Hue Tap Dial, IKEA BILRESA — the repo's hardware baseline; capture format: the exact objects `getFlowCardTriggers` returns, secrets none). If real captures aren't available in-session, build them from the shapes the existing tests already encode and mark each fixture `"provenance": "reconstructed"` — the human replaces them with real captures (**VERIFY-ON-HARDWARE**: run a provided capture snippet and commit the JSON).
- **LK-007 verification:** add a fixture representing an app-level trigger card with a filtered `type:"device"` argument. Write the test asserting a usable selectable input is produced. It will likely fail (verified: `classifyArgument` returns `unsupported` for non-dropdown). If it fails: implement the fix — discovery resolves the matching device argument, pre-binds it into `fixedArgs` (5.1 makes this trivial), and removes it from the dimension list before normalization. If it passes, record in `DEVIATIONS.md` that LK-007 was a false positive.
- **LK-030/031/047 hardening (small, test-gated):** `deviceMatchesFilter` — exact normalized `driver_uri` match instead of `startsWith`, unknown restrictive filter keys → declined route with diagnostic (fail closed); selectable-input `keyFor` — detect true key collisions post-dedupe and push them to `rejected` with reason `key collision` instead of silent first-wins; time-card discovery — refuse on score ties (return `card: null` with both candidates listed; the existing `state.noTimeCard` path handles it). Each behind a fixture test; skip any where the current code already behaves correctly (record which in `DEVIATIONS.md`).
- **LK-029 (fingerprint completeness):** *decision, not blind implementation* — widening the fingerprint invalidates every installed controller's surface check (mass `needs_repair` on upgrade). Implement as a **versioned** fingerprint: new `fingerprintV2` computed alongside; `HealthMonitor` compares v2 only when the stored profile carries v2 (new saves/repairs write it); old profiles keep v1 semantics until repaired. Include: full card id+uri, argument filters, numeric bounds, token scale, and a `NORMALIZER_VERSION` const. Document the rollout in the code.

## Exit criteria

- Fail-first tests for 5.1/5.2 confirmed failing on pre-phase code, now green; migration step tested against old-shape fixtures; `npm run validate` green.
- Fixture corpus committed with provenance flags; hardware capture checklist emitted.
- `DEVIATIONS.md` records the verdict on each formerly-unverified LK item (confirmed-and-fixed / false-positive / deferred-with-reason).

