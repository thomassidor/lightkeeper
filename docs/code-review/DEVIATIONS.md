# Deviations from the remediation plan

Where the plan and the code disagreed, and what was done instead. Per the
master plan's rule 6: a discrepancy is recorded rather than improvised around.

---

## Phase 0

### 0.3 — `no-unnecessary-type-assertion` is OFF, not on

**Plan:** flat config with `typescript-eslint` type-checked recommended, three
named rules as errors.

**What happened:** the recommended set brings `no-unnecessary-type-assertion`,
which reported 116 sites. Its `--fix` broke the build. Four of the removals were
`Object.values(await client.flow.getFlowCardTriggers()) as any[]` — homey-api's
untyped return makes those `unknown[]`, the assertion widens them to `any[]`,
and the rule read "an assertion to `any`" as "an assertion that changes
nothing". At the one boundary this codebase deliberately uses `any`, the rule is
wrong and its autofix is destructive.

**Decision:** rule off, with that reasoning in `eslint.config.mjs`. The
remaining 112 sites were reverted along with it — a mechanical edit whose
mechanism has been shown to be unsound is not a safe mechanical edit.

### 0.3 — three rules relaxed from the recommended defaults, each for a reason

| Rule | Setting | Why |
|---|---|---|
| `no-misused-promises` | `checksVoidReturn.inheritedMethods: false` | `@types/homey` declares `Device.onRenamed`/`onDeleted` as returning `void`; the SDK genuinely awaits them. The community types are wrong and the async overrides are right. Every other misuse still errors. |
| `switch-exhaustiveness-check` | `considerDefaultExhaustiveForUnions: true` | Two switches (`credentialFailureKey`, `semanticClass`) are total by construction via a deliberate `default:`. The rule still catches a defaultless switch missing a variant, which is the failure it exists for. |
| `require-await` | off | Several methods are `async` because their signature is a contract callers await (`onCatalogChange`, `runIntent`), not because the body currently needs one. Dropping `async` would make adding the first `await` a breaking signature change. |

`no-floating-promises` uses `allowForKnownSafeCalls` for `node:test`'s `test`,
`describe` and `it` — 517 call sites where the RUNNER owns the promise. Nothing
else has an escape hatch: there is no remaining `void <promise>` in the repo.

### 0.4 — the Homey CLI as a devDependency worsens `npm audit`, and that is fine

Moving `homey@4.4.2` out of `npx --yes` and into `devDependencies` takes the
audit from 4 moderate to 17 findings (2 low, 10 moderate, 5 high — `sharp` and
`libvips`). **`npm audit --omit=dev` is unchanged: exactly the four accepted
moderates through `homey-api`.** devDependencies are not bundled into a Homey
app, so nothing new ships. CLAUDE.md's audit note has been amended to say which
tree it is talking about.

The gain is real: `npx --yes homey@4.4.2` pins the CLI but not its transitive
tree, so "publish-level valid" still drifted between two runs of one commit.

### 0.1c — `Timers` members are declared `this: void`

Not in the plan, but required: the interface's members are routinely passed on
as bare functions (a `FakeTimers.setTimeout` handed to a class that still takes
the old piecemeal options), so none may depend on its receiver.
`unbound-method` catches this, correctly.

### 0.5 — test files use `describe` + `test`, never `t.test`

`test/unit/release-metadata.test.ts` counts tests by grepping for `test(` at a
word boundary, and README.md quotes that count. A nested `await t.test(...)`
runs but is not counted, so the two numbers diverge silently. New suites follow
the repo's existing `describe(...)` + `test(...)` shape.

---

## Phase 1

### 1.2 — `homey-api` really does carry a status code, so `isNotFound` reads it first

The plan said to inspect the error shape before hardcoding. It is
`APIError extends Error` with a numeric `statusCode` taken off the HTTP
response (`node_modules/homey-api/lib/APIError.js`, thrown from
`HomeyAPIV3.js`), and the message is the server's own text — `404 Not Found:
FlowCardAction with ID <x>` being the one CLAUDE.md §3 records.

`sanitizedWriteError()`, which every write error crosses on its way to us,
carries `statusCode` forward deliberately. So `lib/support/homey-errors.ts`
reads the status first and matches the message only as a fallback for errors
that arrive from somewhere else with only their text intact. Both routes are
tested.

### 1.3 — the plan's example scenario was already correct; the real bug is narrower

The plan describes B12 as "a schedule retimed from 22:00 to 23:00 keeps its old
Flow". That specific case was **already handled**: the time lives in the variant
key (CLAUDE.md's own note on `variantKey` says exactly why), so retiming makes
the old key un-wanted and the abandonment loop removes it.

The bug is the case where the variant key does **not** move and only the
fingerprint does — a re-paired remote, or any event-surface change under an
unchanged binding. The key stays wanted, so the abandonment loop's
`if (wanted.has(key)) continue;` skips it, while the new flow's reference
overwrites the old one in the profile. Live flow, no reference, invisible.

Both routes are now pinned by tests, and the test file says which is which so
the distinction is not lost again.

### 1.6 — single-flight alone is not enough; the caller must re-read its state

Writing the test made this explicit and it is worth recording. `SingleFlight`
guarantees the two passes do not interleave, but a second pass that was handed
`existing` captured **before** the first pass ran still creates duplicates. What
makes it work is that `reconcileFlowsNow()` reads `this.profile.managedFlows`
at the top of each pass — so serialising the passes is what makes the second
one's read fresh.

`flow-bridge-concurrency.test.ts` therefore models the device store, and carries
an explicit counter-example ("without serialisation the same two passes WOULD
duplicate") so the guarantee is not mistaken for something the surrounding code
would give anyway.

### 1.7a — done, and it is the one thing in this phase that needs hardware

`deprecated` is a real, schema-validated flow-card property: homey-lib's app
schema declares it at `definitions.flowCard.properties.deprecated`
(`{ type: boolean, enum: [true] }`). All three bridge cards now carry it,
`app.json` regenerates with it, and `npm run validate --level publish` passes.
`test/unit/compose-manifest.test.ts` pins it.

**HARDWARE CHECKLIST — required before releasing this change.** The whole app
depends on (c):

1. The three bridge cards no longer appear in the Flow editor's action picker.
2. An existing generated Flow still fires — press a mapped button, watch the
   lights.
3. **`createFlow` through the API-key client still creates a Flow using a
   deprecated card id.** Add a schedule window and confirm two Flows appear.

If (3) fails, revert the `"deprecated": true` line in all three files under
`.homeycompose/flow/actions/`, drop the compose-manifest test that pins it, and
re-run `npm run validate`. Nothing else depends on it: the sub-tasks that make
attribution *provable* (1.7b, 1.7c) stand alone, and they are the stronger of
the two guarantees — this one only makes the card harder to reach by hand.

### 1.7c — the preview token is not a security boundary, and does not pretend to be

`previewToken()` is a djb2 hash of (sorted candidate ids, sorted live set). It
defends against a set that moved between the count and the click, not against a
constructed collision — the same user is on both ends of the round trip. The
approval carries the explicit `flowIds` as well, and the sweep deletes only the
intersection, so an id that was never shown is never deleted whatever the hash
says.

### 1.8b — the preflight's decision moved to `lib/`, its sentence stayed in the driver

The plan put the whole preflight in the driver's save handler. Half of it had to
move: a driver module cannot be unit-tested (importing it pulls in `homey`), and
a message built in `lib/` can never be translated — CLAUDE.md's own convention.

So `findUncompilableBindings()` in the flow binding compiler decides and returns
the declined inputs with no prose, and `ControllerDriver.preflightBindings()`
turns that into `mapping.unsupportedControl`. Tested at the lib boundary, plus a
test that the locale template still carries both the control name and the fix.

### Existing test fixtures needed real-shaped device ids

`looksGenerated` requires a flow's `controller` argument to match
`/^lk-(ctrl|sched|circ)-\d+-\d+$/`, which is the point: an id a person could
type into the argument field is not proof the flow was generated. Three existing
suites used placeholders (`'ctrl-1'`, `'alive'`, `'ctrl-vanished'`) and went
green by deleting nothing at all. They now use real-shaped ids, with a comment
saying why.
