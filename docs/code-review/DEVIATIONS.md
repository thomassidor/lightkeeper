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
