# Deviations from the remediation plan

> **Archive.** This is the completed remediation project that produced most of 0.5.0. All eight
> phases are done — see the status table in [`00-PLAN-MASTER.md`](00-PLAN-MASTER.md). Nothing here
> describes outstanding work. This file is kept for the reasoning: two code comments still cite it
> directly.

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

---

## Phase 2

### 2.7/B9 — evicting an idle queue costs the rate limit, so eviction is lazy

The plan says to evict a scheduler queue "when it has no pending, no timer, no
in-flight flush", checked at the end of `flush()`. Implemented literally, that
**breaks the rate cap**, and the existing suite caught it immediately: an idle
queue's only remaining state is `lastWriteAt`, which is the one thing stopping
the next write to that device going out at once. Dropping it and rebuilding it
means every write is a "first" write.

So eviction is `reclaimIdleQueues()`, called lazily from `queueFor` when the cap
is actually reached, and a queue is evictable only once its rate window has
ALSO passed — the point at which dropping it and rebuilding it are
indistinguishable. On any normal Homey it never runs at all.

### 2.6a/B1 — `desiredOn === false` is the wrong guard, and would have disabled the feature

The plan's guard is: stand down "if `cache.state(deviceId).desiredOn === false`
**or** any `onoff` change was observed after the originating write". The first
half is wrong, and writing the test proved it: `desiredOn === false` is the
STARTING state of every dim-with-`impliesOn`. That is what `impliesOn` means —
the lamp is off and the dim write is expected to light it. Shipping that guard
would have turned the corrective write off entirely on the integrations it
exists for.

Implemented as the timestamp alone, and generalised: `lastOnOffChangeAt` records
when a device's `onoff` last MOVED from any cause — a change observed over the
subscription, or one we committed ourselves. Both alternatives are wrong for
reasons now recorded in the code:

- the desired value is the starting state (above);
- the actual value cannot see it either — off and on again leaves the lamp
  exactly where our write wanted it, while the user has very much spoken.

### 2.5/B3 — targets change because the CATALOGUE changes, not because the plan does

The plan's circadian acceptance test is "after removing light B from the plan's
zone, an external power-on of B must produce zero writes". A plan's target spec
is immutable while a runtime lives; `refreshTargets()` re-resolves that fixed
spec against a catalogue that has moved (a light moved out of a zone, or
deleted). Editing the plan goes through `updatePlan`, which stops and restarts
the runtime and so releases everything anyway — testing that would have proved
nothing.

The acceptance test therefore uses a zone target and mutates the catalogue,
which is the path the bug actually took.

### 2.3/B16 — the write sequence is per (device, capability), not per device

The plan says "a per-key monotonically increasing write seq captured at
dispatch". Made explicit: the key is `deviceId:capability`. A per-device counter
would have `dim` and `light_temperature` writes to one lamp invalidating each
other's commits, which is the normal case for a composed intent (§9's
on-boundary writes `onoff`, then `dim`, then `light_temperature` per device).

### 2.7/B27g — `recentWrites` is a merged log, and one test's premise had to be retired

`api-orphans.test.ts` asserted "with a controller running, its writes win over a
schedule's", which was a faithful test of the documented "FIRST controller only"
behaviour. That behaviour is what B27g removes, so the test is replaced by two:
writes from different runtimes merge newest-first, and each runtime still keeps
its own log for the per-device view in `getDiagnostics`.

### The `unsupported` field landed between a docblock and its method

Phase 1's mechanical insert put `private unsupported` between
`/** Never exposes secrets... */` and the `diagnostics()` it documents, in all
three runtimes. Repaired here while editing the same region.

---

## Phase 3

### 3.1/D2 — the base class is TWO classes, because `homey` does not resolve off-Homey

The plan says "create `lib/devices/lightkeeper-device.ts`: `abstract class
LightkeeperDevice<TPlan> extends Homey.Device`". That was written, and then could
not be tested: `require('homey')` resolves to the CLI in `node_modules` (whose
main executes the CLI), and the SDK module exists only on a Homey. `@types/homey`
supplies the types, so `tsc` is happy — but any test that imports a file
containing `extends Homey.Device` dies with `Class extends value undefined`.

Which is exactly why the three device files had no tests at all, and why every
ordering bug in this phase's findings survived to be found by review.

So the extraction is:

- `lib/devices/device-lifecycle.ts` — `DeviceLifecycle<TPlan, TRuntime>`, a plain
  class taking a `DeviceOwner` (the SDK slice it uses plus the per-type hooks).
  Every rule this phase adds lives here.
- `lib/devices/lightkeeper-device.ts` — `LightkeeperDevice extends Homey.Device
  implements DeviceOwner`, holding a `DeviceLifecycle` and forwarding the five SDK
  entry points. Nothing in it branches.

`Homey.Device` satisfies the SDK half of `DeviceOwner` structurally, so the shell
adds only the two members the SDK spells differently: `translate()` for
`homey.__` and `removeFlows()` for `app.bridge.removeAll`. `test/unit/device-
transactions.test.ts` (18 tests) is what the single-class version could not have.

### 3.1 — one hook, not two

The plan named `beforeRegister(previous, next)` for the controller's obsolete-flow
deletion, alonga merge step. Splitting them meant the controller computing
`carryForwardFlows()` in the merge and needing its `obsolete` list in the hook
afterwards — i.e. stashing it on the instance between two calls inside one
mutex-held operation. `prepareApply(previous, incoming): Promise<TPlan>` is the
single hook instead: it returns what to register and does whatever must happen
first, in one place, with the ordering comment attached to the ordering.

### 3.2 — a sequence number, not just an ordered queue

"A late state callback cannot flip an unavailable device to available" does not
follow from serialising the verdicts: the stale one is still *in* the queue and
would be applied, just later. So each verdict takes a monotonic number at the
moment it is issued and is dropped if a higher one has already been applied. The
apply's own publish is issued last and therefore always wins. Both orders are
tested, to show it is order and not severity that decides.

### 3.3 — the persist failure is reported at the END of the reconcile

A `return` on persistence failure would have skipped the user-edited and
unsupported-mapping verdicts that come after it. `setState` is last-write-wins, so
the flag is set and applied after them, with the comment saying why.

### 3.6 — `isTransportFailure()` refuses anything carrying a status

The plan asked for a classifier "on classified transport errors (connection
reset/refused/timeout)". Written as: **any** numeric HTTP status at all means the
transport worked, whatever that status says, so it is never a transport failure.
Only a total absence of one plus a connection-shaped message or Node error code
counts. Without the status check, `404 Not Found: connection closed` — a Homey
message quoting a flow name — would tear down a working socket.

No disconnect event on the read client was used: `homey-api`'s client is built by
`createAppAPI` and the phase's brief says "inspect at runtime in a test", which
cannot be done off-hardware. Report-on-failure covers the same ground from the
call sites (`DeviceCatalog.refresh`, `FlowBridgeManager.sync`,
`LightTargetAdapter.deviceHandle`) and needs no platform assumption.

---

## Phase 4

### 4.1a — overlap is a WEEKLY question, and the plan's day-set framing hides that

"Two entries overlap when their `[onAt, onAt+windowLengthMinutes)` intervals
intersect on any shared day" misses the case that matters most: "Friday 23:30 for
two hours" and "Saturday 00:30 for one hour" share NO day and overlap completely.
So `entriesOverlap` lays each entry out as one arc per start day on a
10 080-minute circle (the week) and asks whether any pair of arcs intersects.
The circular test needs no midnight or Sunday-night special case, and a sanitised
window is at most 1439 minutes, so neither arc can swallow the other.

`MINUTES_PER_WEEK` is computed per call, not as a module constant:
`schedule-types.ts` now imports `entriesOverlap`, and this file already imported
`MINUTES_PER_DAY` from there, so a top-level `7 * MINUTES_PER_DAY` is evaluated
mid-cycle and throws `Cannot access 'MINUTES_PER_DAY' before initialization`. The
comment at the constant says so.

### 4.1a — one test fixture's premise was retired

`schedule-window.test.ts`'s "caps the set, so the Flow list stays readable" built
fifteen rows all at `07:00`, which under the new rule all overlap — so one
survived and the cap never came into play. The fixture is now staggered an hour
apart, with a comment saying which rule is under test. The assertion is unchanged.

### 4.1b — the Test control is exempt from overlap suppression

Not in the plan, but required by I9: `testEntry` exists so the user can prove a
boundary does what they expect, before save. Suppressing its off write because
another window happens to be running would make the Test lie about the thing it
was built to demonstrate. The suppression is keyed on the internal `note`, and
catch-up is unaffected because it only ever plans an `on`.

### 4.2 — the off-boundary proof is per ENTRY, and refusals are per entry too

`hasTrustedOffBoundary` looks for a reference whose `bindingKey` is exactly
`sched:<thisEntry>:off`. A different entry's off reference does not stand in for
it — that is asserted in `safety-promises.test.ts`, because it is the mistake a
"do we have any off Flows" check would make.

The two whole-runtime refusals (unresolved timezone, untrustworthy Flows) are
recorded under entry id `*`: they are not about one entry, and inventing a
per-entry row for each would fill the cap of 10 with duplicates on a plan with
twelve windows.

### 4.3 — `localNow` keeps its signature

The plan describes `localNowResolved` as gaining an "out-param-style variant".
Implemented the other way round: `localNowResolved` holds the logic and
`localNow` is a one-line wrapper returning `.clock`. Every existing caller and
test is untouched, and there is one copy of the ICU handling rather than two.

### 4.5 — the overnight off label drops the verb

`Off at 01:00 (starts Fri)` rather than `Off at 01:00, Sat`. The shifted-day form
would be accurate about when the Flow fires and wrong about what the user
selected — they chose Friday, and every other screen in the app says Friday. The
parenthetical is the only form that is true in both directions.

### 4.4 — the pairing screen did NOT already render drop reasons

The plan says "the pairing screen already renders drop reasons". It renders a
COUNT: `schedule.droppedSome` — "__count__ schedule(s) are incomplete. Check the
times and try again." That sentence is wrong for an overlap, where every row is
complete and the times are exactly what the user meant. So there is a second key,
`schedule.droppedOverlap`, and the view picks it when any drop reason begins with
`overlaps`. The reasons themselves stay English strings built in `lib/` (which has
no `homey.__`), which is why the discrimination happens in the view.

---

## Phase 5

### 5.1 — `flow_enum` was NOT folded into `flow_fixed`

The plan prefers the fold, "keeping `variantKey` semantics identical:
`enum:<value>`". Those two are not simultaneously satisfiable. After the fold the
enum value sits in `fixedArgs` alongside any selector and direction, and nothing
distinguishes which entry was "the enum" — so the compiler cannot rebuild
`enum:<value>`. The alternatives were a variant key derived from a hash of
`fixedArgs` (not the stated key, and it churns every installed controller's Flows,
since reuse is keyed on the variant key) or storing a redundant `variantKey`
inside the binding (one more field than the kind it removes).

So there are still five kinds. `fixedArgs` is on all of them, which is the actual
finding: `bindingFor()` built the selector/direction object and then handed it to
three of four kinds. `flow_range` got the magnitude argument alone, so a card with
a selector AND a direction AND an enumerated step compiled to one Flow per step,
none naming the button or the direction — every variant fired on every control.
`binding-shape.test.ts` asserts twelve distinct triggers where there were three.

An enum binding's `fixedArgs` is `{}` and its value lives in the variant: the
compiler merges the two, so putting the selector in both would set it twice.

### 5.2 — the ceiling now counts values, and a corrupted range refuses

`numericRangeOf` becomes `numericValuesOf`, and `flow_range.values` is the card's
exact sorted, de-duplicated set. Two consequences worth stating:

- The ceiling counts `values.length`, so {1, 1000} is two Flows rather than a
  thousand. Previously the SPAN was compared against the ceiling, which declined
  a two-detent control as if it needed a thousand variants.
- The old count-up loop between two NaN endpoints was not an error, it was an
  empty loop — the control silently compiled to nothing. Hence
  `InvalidRangeError`, surfaced through the same `unsupported` path the ceiling
  refusal uses, so the device reports repair and names the control.

The migration derives `values` from the stored endpoints rather than from the live
card, because a migration must be a pure function of what is on disk. Contiguous
integer ranges therefore produce identical `range:<value>` variant keys and no
Flow churns; the next discovery pass corrects a sparse set and the fingerprint
notices it moved.

### 5.3 — LK-007 is CONFIRMED, and deliberately left declining

An app-level card with a filtered `type: "device"` argument IS matched to the
device (route `device_arg`) and then declined, because `classifyArgument` returns
`unsupported` for any non-dropdown type. The plan's fix — pre-bind the device
argument into `fixedArgs` — is now trivial mechanically. The blocker is the VALUE:
a `device` argument's accepted serialisation is not something we can enumerate
ahead of time. CLAUDE.md §5 already records that autocomplete arguments serialise
as the whole selected object rather than an id, and §9's `time_exactly_day` is the
standing example of what guessing an argument shape costs — a Flow that validates
and never fires, which is the single worst failure this app has.

Repo law is not to guess a platform shape. So the decline stands, and what changed
is that it now NAMES the type — `argument "device" is of type "device", which this
app cannot enumerate into events` — instead of the undifferentiated "is not
enumerable". Every reference device resolves through `device_scoped`, so nothing
shipped depends on this route.

**What a fix needs:** one `getFlowCardTriggers()` capture of such a card, plus one
hand-built Flow through the Web API setting that argument, to read back how the
value serialises. Until then, do not implement it.

### 5.3/LK-031 — failing closed contradicts an existing comment, on purpose

`deviceMatchesFilter`'s old default branch said unknown keys "are ignored rather
than treated as a mismatch: failing closed here would silently hide usable cards."
That reasoning is now inverted, and the new comment says why: ignoring a
restriction we cannot evaluate reads as "the filter does not restrict on that",
which is the opposite of what a filter is. The concern the old comment protected —
a silently absent card — is met by REPORTING the decline with the key named, which
`discover()` now returns in `rejected`. `device_scoped` does not go through a
filter at all, so no reference device is affected.

### 5.3/LK-029 — v2 is computed alongside, and adopted only on save

Both hashes are computed on every discovery. `surfaceMoved()` compares v2 only
when the profile carries one; profiles saved before it existed keep v1 semantics.
Every save and repair writes a v2, so the upgrade is one-way and silent. Widening
v1 in place would have marked every device on every Homey `needs_repair` on the
upgrade — a mass false alarm about a surface that had not moved.

v2 adds: the card's full id and uri, argument `filter`, `min`/`max`/`step`, token
TITLES (the Tap Dial's "Steps (1000/turn)" is the scale, so relabelling it to
"(500/turn)" is the same shape and a different remote), and `NORMALIZER_VERSION`.

### 5.3 — the fixture corpus is `reconstructed`, and says so

`test/fixtures/cards/*.json` are generated from `reference-devices.ts` by
`scripts/dump-card-fixtures.mjs`, and each carries `"provenance":
"reconstructed"`. `card-fixtures.test.ts` fails if the JSON and the TS drift, and
asserts no file carries a real device id.

**This is a hardware gap, not a completed task.** The transcription was faithful
to what mattered for normalisation, and v2 now hashes things nobody was looking at
when it was made — argument filters, numeric bounds, token titles. The corpus is
good enough to test the normalizer and not good enough to settle a question about
the platform. Replacement recipe: `test/fixtures/cards/README.md`.

---

## Phase 6

### 6.1 — `RuntimeRegistry` is composed, and it found a drift

The extraction is as planned. It also surfaced one: the circadian manager started
its ticker BETWEEN the insert and the start, so a register that then threw left a
60-second timer running over an empty map. The ticker now starts after the
register resolves, and `unregister` stops it when the map empties.

`destroyAll` moved to `Promise.allSettled` — new behaviour, deliberately. A
sequential loop meant one runtime whose `stop()` rejected abandoned every runtime
behind it in the map, leaving their subscriptions and timers alive for the rest of
the process's life. On shutdown that is the whole point of the call.

### 6.2 — the validators changed behaviour, as S4 predicted, and four fixtures were partial plans

Every migration chain now ends in a validator rather than a cast. Four test
fixtures had been passing partial objects — `{ schemaVersion: 1, points: [] }`,
`{ schemaVersion: CURRENT, mappings: [] }` — which the cast accepted and the
runtime then failed on at its first target resolve, with nothing anywhere saying
which field was wrong. Those fixtures are now complete, and each has a sibling
test asserting the partial form IS rejected, naming the field.

Three deliberate departures from the plan's wording:

- **Error paths are rooted at TYPE names** (`SchedulePlan.entries[0].onAt`), not
  at `schedule.` / `circadian.`. `locales.test.ts` scans the source for string
  literals shaped like `<localeGroup>.<key>`, and both of those ARE locale groups —
  so a path rooted at either read as a locale key that does not exist. The type
  name also reads better in the log line the message actually lands in.
- **`validManagedFlowRefs()` filters and never throws**, alongside the throwing
  `validateManagedFlows`. The delete path that uses it runs precisely when no plan
  could be loaded — including when validation rejected one — so throwing there
  would skip the cleanup and leak every OTHER reference's Flow. Filtering degrades
  to "delete fewer things", which is the right direction.
- **`rawFlowRefs()` reads the STORE, not a validated plan.** Same reason: the
  never-registered delete path is the quarantine case. The lifecycle shape-checks
  the result before any delete, and `device-transactions.test.ts` asserts a forged
  reference never reaches it.

The runner adds a `MAX_STEPS` guard the plan did not ask for. The non-advancing
check catches a step that fails to move the version; it does not catch a TABLE
that advances in a cycle (1 → 2 → 1), which would spin forever inside a device's
`onInit` and take the app down.

`state.invalidConfiguration` is the new quarantine message: a version this build
cannot understand means "update Lightkeeper", while a plan whose shape is wrong
means "set this device up again", and they needed different text.

### 6.2 — pairing DTOs are checked against the CATALOGUE, not just for shape

`selectTargets` in all three drivers now runs
`validateTargetAgainstCatalog`: every device exists, is a light candidate
(`onoff`, matching `lightCandidates()`), and appears once. `setRules` on the
controller checks `groupKey` against the lights already chosen and `function`
against what those lights actually support. Both reject a payload that would save
as a row which can never move anything — the failure this app exists to prevent.

### 6.3 — `localNow` keeps its name and moves house

`lib/schedules/local-time.ts` → `lib/time/local-clock.ts` (a `git mv`, so the
history follows). `MINUTES_PER_DAY`, `formatMinutes` and `parseMinutes` moved to
`lib/time/wall-clock.ts` and are RE-EXPORTED from both feature modules rather than
having every import rewritten: they are part of each feature's stated contract
("everything about time here is a wall-clock minute count"), and the re-export is
where that sentence lives. `support-primitives.test.ts` asserts import identity,
so the re-export cannot quietly become a second copy.

`sanitiseUnit` → `lib/validation/unit-interval.ts`, with the "0 means unset"
policy left in the feature that owns it — the two features disagree about zero and
both are right.

### 6.4 — one intent translator, and the equivalence is now asserted

`intentForLightFunction` in `mapping-engine.ts` is the only copy;
`intentForFunction` in the controller runtime is a one-line delegate kept because
the Test path imports it by that name. `mapping-and-state.test.ts` asserts both
paths produce identical intents for every `LightFunction` — the Test control's
entire purpose is to prove a row does what the user expects, so a Test that
translates differently from the live path is worse than no Test.

The timer migration is PARTIAL by design: the public options stay piecemeal
(`setTimeout`, `clearTimeout`, `now` as separate fields) because every test stubs
them individually and `test/support/fake-timers.ts` was built compatible with that
shape on purpose. What is shared is the FALLBACK, which four classes each had
their own drifting copy of.

That change caught a real bug in the making: `private readonly timers =
withDefaults(this.deps)` as a field initialiser runs BEFORE the parameter property
`deps` is assigned, so every injected clock would have been silently ignored. It
is assigned in the constructor body now, with the comment saying why.

### 6.5 — `app.ts` keeps `module.exports`, and now proves the contract

`LightkeeperApp` in `lib/app-contract.ts` is the app's public surface written by
hand, because a Homey entry point using `export default` is not loaded at all
(I10) and there is therefore no class type to import. `app.ts` assigns its class
to a `new (...args) => LightkeeperApp` before exporting it, so removing or
renaming a member the contract promises fails at compile time rather than as
`undefined` inside a settings-page handler. The class expression keeps its own
name so logs and stack traces still say `LightkeeperApp`.

The three `diagnostics()` methods return typed shapes. `CircadianDiagnostics`
deliberately has NO `credential` field, and its test now asserts the key is absent
from the type rather than merely undefined at runtime.

`no-explicit-any` is an error for `lib/**` with eleven seam files listed and each
one's reason given. The rest of the unsafe-* family stays off: those fire on every
USE of a value that crossed a seam, which is most of the app, whereas this one
fires where the word is written — which is where the decision is being made.

### 6.6 — D9's rename is internal only, and the wire names are commented

`ManagedFlowSummary.controllerId` → `ownerDeviceId`, and the same in
`FlowFolderInfo` and `controllerIdOf` → `ownerDeviceIdOf`. The flow ARGUMENT stays
`args.controller` and `OrphanPreview.liveControllers` keeps its key: the argument
is persisted in every generated Flow on every installed Homey, and the response
key is consumed by the settings page. Both boundaries carry a comment saying the
name is historical.

D9's orthogonal health model is NOT done and is not planned: `ControllerState`
conflates "is it configured", "can it reach its lights" and "can it maintain its
Flows" into one enum, and splitting it touches every device, runtime, view and
locale key. Deferred as future work, recorded here rather than left implied.

`JSON.stringify` equality is retired into `lib/support/same.ts`. It was never an
equality test — key ORDER decides the answer, and every one of these comparisons
gates a persist, where a false "changed" emits `device.update`, invalidates the
catalogue and lands back in `onCatalogChange`. `sameManagedFlows` and
`sameCatalogue` are field-wise and each says which fields it ignores and why;
`canonical()` is the sorted-key serialiser used where the value genuinely is an
open-ended union (a binding's `fixedArgs`).

`presentation-maps.test.ts` is D11's requirement: it DISCOVERS every copy of the
credential-failure map from disk — settings page plus every driver's pair and
repair credential view — and asserts each is exhaustive over `CredentialFailure`,
that none handles anything the app cannot report, and that the copies agree with
each other. Full generation (LK-064 territory) is not done; the exhaustiveness
test was the requirement.

---

## Phase 7

### 7.1 — the settings page has NO `innerHTML` and no `escapeHtml`, and two views keep both

The settings page and the four screens that render third-party strings — the light
picker (shared by all three drivers) and the source picker — are fully converted to
`document.createElement` + `textContent`, through a shared `node()` / `clear()`
helper pair. `escapeHtml()` is GONE from the settings page: it existed to make
concatenation safe, and there is no concatenation left to make safe.

Two views still assign `innerHTML`, allowlisted by name in
`webview-safety.test.ts` with the argument written out there:
`schedule.html`'s `entryHtml` and `curve.html`'s `pointHtml`. Both build a FORM —
selects, range inputs, checkboxes — from our own `Homey.__()` strings, integers,
and an id that Phase 4 made server-generated and constrained to
`ENTRY_ID_SHAPE`. There is no third-party string in either: no device name, no
zone name, no error text. Converting them means rewriting `timeSelects`,
`durationSelects` and `options` as well, in two screens that cannot be exercised
without hardware, to remove a risk that is provably absent. The test asserts the
allowance's own preconditions — that those files still escape what they
interpolate, and that a hostile id cannot match `ENTRY_ID_SHAPE`.

The two SVG builds (`mapping.html`'s chevron, `curve.html`'s dots) were static
markup and would have been safe as `innerHTML`. They are `createElementNS` now
anyway, because the rule is easier to hold with no exceptions than with four —
and `createElement('svg')` produces an HTML element of that name, which renders
as nothing, so the namespace had to be explicit either way.

No DOM-shim test was added. The structural guard is the stronger check here: a
rendering test proves one hostile string lands as text, while the guard proves
there is no parser for any string to reach.

### 7.2 — the perimeter is documented at both ends, and the key's NAME is a forbidden token

`lib/credential-service.ts`'s header now says plainly that "never returned over
the app API" bounds what leaves deliberately, and that the accidental route is
bounded by the webviews — the key is in `homey.settings`, so a settings webview
can read it with `Homey.get`, which is the SDK's design and not something the app
can prevent.

`webview-safety.test.ts` forbids the string `flowWriteApiKey` in any privileged
view. That is stricter than the plan asked (which named the `Homey.get` call) and
simpler: a webview never needs the token, so it never needs the name. The settings
page's own comment had to be reworded because the test caught it quoting the key.
It also asserts `api.ts` mentions neither the setting nor `getWriteClient`.

### 7.3 — the legacy id shape is PERMANENT, not deprecated

`mintDeviceId(kind)` uses `crypto.randomUUID()`, and `LIGHTKEEPER_DEVICE_ID`
matches both shapes. The old `lk-<kind>-<timestamp>-<random>` form can never be
retired: a device id is baked into the `controller` argument of every Flow that
device owns and into the device's own `data`, neither of which can be rewritten.
A pattern that stopped matching it would make every existing device's Flows
unattributable, which the sweep reads as ORPHANED. The regex comment says so, and
`flow-bridge-sweep.test.ts` asserts both shapes plus a set of near-misses.

The collision this fixes is not cosmetic: two devices created in the same
millisecond could share an id, and the id is what attributes a Flow — so each
could delete the other's Flows.

### 7.4 — the module-system note, and what it explains

`CLAUDE.md`'s conventions now carry the `module.exports` rule (I10) with the two
consequences that look like awkwardness and are not: there is no class type to
import from `app.ts` (hence `lib/app-contract.ts`), and a file containing
`extends Homey.Device` cannot be imported by a test at all (hence the
`device-lifecycle` / `lightkeeper-device` split). Both were already true and
neither was written down.

### 7.5 — LK-064 DECLINED, and the cheap half taken

Build-time view fragments are not adopted. The review's own recommendation was
"not yet", and this phase is evidence for it rather than against: every shared
block edited here — `node()`, `clear()`, the `escapeHtml` removal — was applied to
the source view and propagated by `sync:views`, and the drift tests caught the one
file that fell out of step (a stray `git checkout` reverted `targets.html` after
its copies had been written; `sync:views:check` named all three copies and the
command to fix them).

The cheap half is in: `npm run sync:views:check` reports what WOULD be copied,
writes nothing, and exits non-zero. CI runs it. That does not contradict the
workflow's existing "sync is deliberately NOT run here" comment — the comment is
extended rather than replaced, because the distinction is the whole point: a CI
run that SYNCED would repair the drift in the runner and go green over it, exactly
as an unchecked `homey app validate` does to `app.json`.

---

## Phase 8

### 8.1 — the curve engine is SHARED, not copied

The task says "copy the current implementation to a new device called Curve
controller". Copied literally that is `lib/circadian/` twice — two runtimes, two
managers, two write paths, two tickers — and every fix from Phases 2, 3 and 6
would then have to be made twice or silently would not be.

What is actually duplicated is the DRIVER and the DEVICE (`drivers/curve/`), which
is where the two differ: the store key, the pairing screen, the plan shape. The
engine is one copy, and both device types register into ONE
`CircadianRuntimeManager` (`app.curves`). That is not tidiness — it is what keeps
§12's stated property true: "ONE `homey.setInterval` for every circadian device on
the Homey". Two managers would be two timers over two maps.

The circadian device's `registry()` is a small adapter that expands its two ends
into points on the way in and folds `enabled` and `preStage` back on the way out.
Only those two fields can move at runtime; everything else in the expanded plan is
derived, so reading it back would be reading back a constant. `kind` on the
runtime's diagnostics is what distinguishes the two on a settings page.

Names: the manager is `app.curves` because a curve is what both device types run.
`liveDeviceIds()` in `api.ts` still excludes both, for the reason §12 gives.

### 8.3 — the SHAPE is four points, and is deliberately not a setting

"Just set temperature and brightness when it's at its warmest and it's coldest"
leaves the times to us. Two points — coolest at midday, warmest at midnight — is
the obvious reading and is wrong: the curve would only ever be AT either of them
for an instant, and would spend the night cooling on its way to daylight.

`SIMPLE_SHAPE` is four: warmest at 06:00, coolest at 11:00 AND 15:00, warmest
again at 21:00. Each end is HELD, so the whole night is flat (21:00 round to 06:00
is warmest at both ends — cyclic interpolation makes that true with no special
case) and so is the middle of the day.

It is a constant, derived on every register rather than stored. Two consequences,
both deliberate: an installed device picks up an improved shape, and the moment
the times become editable this device type IS the curve controller with fewer
fields — at which point they stop being different products. Somebody who wants
their own times has one.

### 8.3 — schema 1 → 2 loses the middle of an existing curve, and says so

There is no migration BETWEEN device types and there cannot be: Homey has no way
to change a device's driver. So an existing circadian light becomes the simple
one, keeping its warmest and coolest points — the two values the user actually
chose, and the two the new shape holds — and dropping everything between them.
That is in `.homeychangelog.json` and `README.md` in the user's own words rather
than hidden, and a Curve light is where such a curve can be rebuilt.

The step runs `sanitiseCurve` first, because a plan stored at version 1 was never
validated (the chain ended in a cast until Phase 6) and `points` may be anything
at all — including a string, which `endsFromPoints` would otherwise read `warmth`
off.

### 8.2 — a colour is never blended with a colour temperature

The task says a point may be "either a temperature or a colour from a predefined
palette". Three decisions follow that the task does not settle, and each is the
same judgement: do not invent a colour for somebody's living room.

- **`warmth` stays REQUIRED on a coloured point.** It is what a lamp with no colour
  capability is written to instead, and what the neighbouring temperature segments
  interpolate towards. Without it, the SHAPE of the curve would depend on which of
  the household's lamps happen to do colour.
- **A segment with a colour at only ONE end holds that colour flat.** Blending
  towards the temperature end means fading "amber" into "4000 K", which is a shade
  nobody chose. The consequence is stated in the code, in CLAUDE.md and in a test
  because a user notices it: one coloured point colours the two segments either
  side of it, so "amber at 21:00" between temperature points at 19:00 and 23:00 is
  amber from 19:00 to 23:00.
- **Hue blends the SHORT way round the wheel.** Rose (0.96) to peach (0.04) is 0.08
  forward through red, not 0.92 backward through green.

The palette is closed, and that is also a decision rather than a limitation: hue
and saturation are a two-dimensional choice with one good answer per intent, most
of the plane is a bad idea in a living room at 21:00, and a NAME survives being
read back on a settings page a year later where a pair of coordinates does not.
Removing a colour from `PALETTE` is not safe — a stored plan names it, and the
sanitiser drops a point whose colour it cannot resolve, which would silently
delete a point from somebody's curve. Deprecate by leaving it in place.

### 8.2 — the write path widened, deliberately, rather than being bypassed

`Capability` gained `light_mode`, `light_hue` and `light_saturation`, and the cache,
the planner, the scheduler and the adapter all widened with it. The alternative —
a side channel that writes colour without going through the cache — was rejected:
Hue echoes duplicate for EVERY capability (§6), so a colour write needs the same
echo dedupe as any other, and the write log is what answers "did anything reach a
light".

Three points where the widening is not mechanical:

- **`light_mode` is written FIRST**, and only where the lamp has one. A lamp sitting
  in temperature mode ignores a hue it is given — not an error, just no visible
  effect, which is the worst failure this app can produce. `WRITE_ORDER` puts mode
  ahead of hue for the same reason it puts `onoff` ahead of `dim`.
- **The capability tested for is `light_hue`, NOT `light_mode`.** `homey-lib` pairs
  hue and saturation on every colour-capable light; `light_mode` exists only where
  there is also a temperature mode to switch out of. Testing for it would skip a
  colour-only lamp that can do exactly what was asked.
- **`light_mode` has no desired state.** It is a string with no arithmetic behind
  it, so it is tracked only through the echo dedupe. `desiredOf()` was extracted
  from a nested ternary at the same time: with three capabilities, `else` meant
  `light_temperature`, so a fourth would have compared a hue against a colour
  temperature and quietly decided they matched.

The colour write gate is a FIXED 0.01 of the wheel rather than the capability's own
resolution, because `light_hue` carries no `decimals` in `homey-lib` — there is no
declared step below which a write is provably a no-op. Documented at the constant.

### 8.2 — an external colour change is detected on the hue axis

§12 promises "an external colour change stands the device down for that light". A
lamp in a coloured segment is one whose colour a person changes on the HUE axis, so
`subscribeAll` now adds `light_hue` — but only when a point actually declares a
colour, because subscribing every target to a capability the plan never writes is a
callback per lamp per change for nothing.

### 8.1 — the artwork is a PLACEHOLDER, recorded in three places

"Graphics will be added later, so don't generate it" — but `homey app validate
--level publish` requires `images` per driver (§10: `_validateImages` iterates
`['small', 'large']`), and without them `install` fails too. So the curve driver
ships the circadian light's artwork.

Byte-identical driver icons are a review finding, so the pair is recorded rather
than tolerated silently: `PENDING_ARTWORK` in `assets.test.ts` (with a sibling test
asserting every entry still names a real icon target, so the list cannot outlive
what it excuses), both target entries in `export-assets.py`, and
`artwork/provenance.md`. Removing those entries is the definition of done.

### Locale keys are shared between the two screens

`circadian.*` is the feature's namespace and both screens draw from it — the warmth
words, the brightness label, the pre-staging copy, the preview strings. Only what
genuinely differs is new: `circadian.ends*` and `circadian.end_*` for the simple
screen, `curve.title`/`curve.subtitle` for the full one, and `palette.*` for the
colour names. Duplicating twenty-nine identical strings under a second prefix would
be two names for one sentence.

One thing the locales test forces: **a key must appear as a string LITERAL.**
`'circadian.end_' + end` is a key the scanner cannot see, so an unused or missing
translation would pass silently. The ends screen carries an explicit
`{ key, label }` pair per end instead, and the comment explaining it had to be
reworded because the scanner read the example inside it.

---

## Post-8 — two defects the hardware install found, and the tests that now catch them

Both were in code Phase 8 added, and both are the same shape: something that was
GENERATED rather than written, checked by everything except the one thing that
mattered.

### The two-ends screen never ran

`ends.html` was generated by lifting the shared blocks out of an existing view and
authoring a new body around them. The lift took `stabiliseScrollbar()` verbatim —
which is correct, it must be byte-identical — but the body was given its own boot
preamble: `var root` and a `data-booted` attribute, where every other view uses
`__root` and `dataset.llBooted`. `stabiliseScrollbar()` reads `__root` by name, so
the view threw `ReferenceError: __root is not defined` before it ever reached
`emit('getEnds')`.

The result on the device: the screen rendered its static markup — heading,
checkboxes, buttons — and then nothing. No cards, no summary, and no error either,
because the `.catch` was never reached.

Two further divergences the same generation introduced: the view was a bare IIFE
reading a global `Homey`, with none of the `__lkBootXx` / `window.onHomeyReady` /
`waitForHomey` dispatch every other view has (the container fires `onHomeyReady`
once at ITS page load, long before a view's script exists, so the poller is what
actually starts a view); and it used `.head`, `.title`, `.foot` and `.btn primary`,
none of which exist — `.btn-primary` is the class, and a card's furniture
(`.card`, `.rowhead`, `.field`, `.label`, `.slider`, `.check`, `.help`, `.acts`,
`.result`) is carried per view, not in the shared base.

**Every check that existed passed.** The file was byte-identical to its repair
copy, its shared helpers matched the other views', every locale key resolved, and
it parsed. Nothing EXECUTED it.

So `test/support/pair-view-harness.ts` runs a view's script against a DOM small
enough to live in one file — `getElementById`, `createElement`, `appendChild`,
`addEventListener`, `dataset`, `style`, `textContent`, and a `window.Homey` that
makes the poller fire. `test/unit/pair-view-boot.test.ts` then asserts, for every
view discovered on disk, that it runs without throwing and reaches its first
`emit()`; that the ends screen renders both cards, both sliders per end, the
brightness row only where the lights dim, and pushes a moved slider back; and that
no view uses a class its own stylesheet never defines.

Not jsdom: the DOM these views touch is a dozen methods, and a real dependency for
it would be the only heavyweight one in a repo whose entire test story is
`node:test` with no framework.

### The circadian icon was drawn off the top of its canvas

`export-assets.py` stores each icon's `fit` — a scale and a translate — as numbers
produced by `--measure`, which rasterises the master and reads its alpha bounding
box. They are stored rather than recomputed so a normal export needs no browser and
is byte-reproducible.

The circadian entry's stored fit was `(2.6927, -209.3, -335.9)`. Re-running
`--measure` gives `(3.1208, -318.9, -318.9)` — and the master's ink is a SQUARE
(a 277×277 rect centred in a 512 viewBox), so the two translates must be equal.
The stored pair was not, which put the drawing's top edge at −39.5 on a canvas that
starts at 0: the top of the frame was simply gone, and 214 units of empty space sat
below it. Only this icon's fit was stale; the other three still match what
`--measure` reports.

Nothing could see it either. `homey app validate` never opens an icon (§10), the
file is generated and byte-identical to its curve copy, and it is valid SVG. The
only check was a person looking at a 32-pixel mask.

`assets.test.ts` now transforms every coordinate in an exported icon by that
icon's own transform and asserts the result lands inside the canvas with half a
stroke to spare, and that the drawing spans at least 70% of it — the other way to
get a fit wrong. No rasteriser needed: the exported file carries its own
transform. Verified against the old numbers, where it reports
`driver circadian: ink starts at -19.5, so 39.5 units of it are off the canvas`.

Arc bulges and Bézier control points are not modelled, so it is a lower bound on
the ink — it catches a drawing pushed off the canvas, which is the bug, not a curve
overshooting its endpoints by a few units.

The exported `<desc>` was wrong too — "A rayed sun above two horizon lines" for a
drawing that is a lightbulb under a daylight arc between a sunrise and a sunset.
It is the accessibility text, and it now matches the master's own `aria-label`.
