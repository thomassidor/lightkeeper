# Lightkeeper code review — findings and remediation plan

> ## Execution status — 9 September 2026, released as 0.7.0
>
> This plan has been executed from `b2ebfd3` through to a `0.7.0` release commit. The suite went
> from **1486 tests with 4 failures and 2 hangs** to **1585 tests, all passing**; typecheck,
> typecheck:test, lint, sync:views:check and `validate --level publish` are all clean.
>
> **Every fix below was verified by reverting it and watching its own test fail.** Where a finding
> turned out to be unreachable or mis-stated, that is recorded rather than quietly dropped.
>
> ### Closed
>
> | Finding | Where it landed |
> |---|---|
> | **H-2** subscriptions stranded on a rebuilt read client | S2's `onReadReplacement` (tests still owed — R5) |
> | **H-3** tick runtimes never re-assess health | `reassessIfInputsMoved()` in both `tick()`s, 4 tests |
> | **H-4** health check overwrites a reconcile verdict | `lib/runtime/verdict.ts`, one ranked function, 5 tests |
> | **H-5** power-on report read as an override | S1's `overrideSuppression()` |
> | **H-6** `Number(null)` on the capability axes | `validCapabilityValue()` on BOTH paths, 9 tests |
> | **H-7** per-rule hold ramps the whole set | S2's `ActiveRamp.targetIds` (R3's "make it required" still open) |
> | **H-8** re-attach may pick the other identical remote | `sourcesInUse` + `source.reattachAmbiguous`, 5 tests |
> | **M-0** `apply()` runs no validator | `validated()` via `owner.migrate()`, 2 tests |
> | **M-3** folder root recreated on the delete paths | `load({ createRoot: false })`, 2 tests |
> | **M-4** moved-card forgiveness covered the id only | `forgiveAbsentKeys`, 2 tests |
> | **M-6** `probePreStage` awaits an uncancellable timer | `lifetime.current()` after the wait, 1 test |
> | **M-8** dim-down floor writes `0.01` to a tenths lamp | routed through `litDim()`, 3 tests |
> | **M-9** synchronised mode nudges a lamp already on target | nudge skipped when synchronised, 2 tests |
> | **M-10** newer-schema quarantine says the wrong thing | `MigrationError` + `kind`, 3 tests |
> | **M-11** unbounded range expansion | ceiling checked before the loop, 3 tests |
> | **M-12** boundary validated on the day, not the clock | `boundaryClockMatches()` + reconcile on refusal, 6 tests |
> | **M-13** no sensor membership check | `validateSensorsAgainstCatalog`, 4 tests |
> | **L-1** `isNotFound` matches a 404 inside an id | status is the answer; message anchored, 5 tests |
> | **L-2** `.gitattributes` omits `*.css`/`*.js` | pinned to LF |
> | **L-3** two "minimum brightness" constants | documented in place; key kept (persisted field) |
> | **L-4** timezone closure written three times | `timezoneOf()` in `local-clock.ts`; found a fourth site |
> | **L-6** `findManagedFlows` swallows a transport failure | mirrors `sync()` |
> | **L-7** `network` too broad | `network (?:error|unreachable|…)`, 1 test |
> | **L-8** dead `credentialFailure` annotation | removed |
> | **L-10** bare `Number()` in two sanitisers | type-checked first, 6 tests |
> | **L-18** non-array `args` on a trigger card | `Array.isArray`, 2 tests |
> | **L-19** empty and whitespace names | one `named()` at six sites, 5 tests |
> | **B1.2** the two regressions in S2's tree | `waitForResults` option; the fake now snapshots |
> | **B1.3** `maintain()` polling every 60 s | removed; H-3 is the recovery pass that was wanted |
> | **B3.1–B3.5** the recorder's residuals | idle-flush, `close()` race, CLI error, Clear button, T98–T106 |
> | **T-1** no `npm audit` in CI | `--omit=dev --audit-level=high` |
> | **T-2, T-6, T-7, T-8, 5c** documentation drift | one commit; twelve phrases and three stale claims |
>
> ### Corrected while executing
>
> - **L-5 needed nothing.** R5's generation guard already discards a superseded in-flight connect,
>   which is exactly what the finding asked for.
> - **M-13's dedupe half was unreachable.** `sanitiseResponse()` already drops a repeated sensor and
>   reports it as corrected, which is the better place for it. Written, found dead, removed — and the
>   reasoning is now in the validator's docblock so it does not get added back.
> - **H-4's fix exposed a second bug of the same shape.** A remembered `needs_credential` is the most
>   severe state there is, so a stale copy in the target verdict sat over every later verdict for
>   ever. Both verdicts now forget it on request; it is the only state either of them does.
> - **Two existing schedule tests were wrong, not the fix.** One dispatched an `on` at 10:00 for a
>   22:00 window and one dispatched a midnight-crossing `off` an hour before its own off minute. Both
>   were about the DAY check and keep their point at a clock that matches.
> - **The three streams are one dependency closure.** B0.3's stream-by-stream commit order was not
>   available: S1's diagnostics and S2's `acceptedTargets` are interleaved inside `applyNow` itself.
>   They landed as one commit, verified green in isolation from the index first.
>
> ### Still open, in the order the plan wants them
>
> 1. **Tests owed for S2's implementations:** R2, R4, R5, R6/R7, R9, R10, R12 (§B2). R7's journal is
>    the riskiest and §B2.7 lists its five specific gaps.
> 2. **R3** make `RampEngine.start`'s `targetIds` required — `(ramp.targetIds ?? [])` currently means
>    "unspecified writes nothing", an inverted default.
> 3. **R8** `pendingColor` is now set, deleted and never read. **R12** bump the credential generation
>    on commit rather than at the start of every save, and destroy superseded candidate clients.
> 4. **M-5** the widened capability fingerprint has no test. **M-7** re-verify against the rewritten
>    `luminance-source.ts`. **L-9, L-12, L-13, L-16, L-17, L-20** remain as written.
> 5. **The structural work, untouched:** S-1 … S-15. S-7 and S-8 are now well motivated — H-3, H-5
>    and H-6 were each written twice — and S-8's ranking is half-built already in `verdict.ts`.
> 6. **Hardware.** Nothing below has run on a Homey. T98–T101 (the recorder) cannot be skipped;
>    T102–T106 cover this session's own work. The three questions Part A could not settle from code
>    are still open: Hue's power-on event order, whether `homey-api`'s socket reconnects by itself,
>    and what a `decimals: 1` lamp does with `dim 0.01`.


## Context

**Asked:** a review of the whole app for critical issues and for simplifications that make it easier to
maintain and build on. Analysis only; no code changes were made. CLAUDE.md and `docs/homey-platform.md`
were used as the reference for what is deliberate.

**Baseline reviewed: commit `444c3ed` on `main`** (HEAD when the session began), read from a read-only
snapshot in the session scratchpad. That mattered because the working tree moved under the review:
another session committed about 1300 lines of lifecycle-safety changes on
`codex/review-lifecycle-safety` (`875b06c`, version 0.6.1), merged them to `main` (`b2ebfd3`), and at
the time of writing has a further 21 files uncommitted across the same runtimes. Nothing below is a
review of that work; section 7 re-checks every finding against the committed `main` and says what the
peer's commit already closes.

**Method.** Three read-only surveys (structure and duplication, tests and CI, hotspots), then five area
reviews against the snapshot, then verification of every finding carried into this document by
re-reading the cited lines. Line numbers are against `444c3ed`.

**Test baseline.** `npm test` at HEAD: 1439 tests, 301 suites, all pass in about 14 s. (In the archive
snapshot one subtest fails for the line-ending reason in finding L-2; it passes in the checkout.)

---

## Headline

**The architecture is sound and the safety properties CLAUDE.md lists hold, with eight exceptions
worth fixing.** Every load-bearing mechanism that was traced — the two API clients and key hygiene,
the write queue and its ordering, the ramp hard-stop, the mutexes, the orphan sweep's refusals, the
Flow attribution and edit detection, the transactional device apply, the perceptual floor, the
daylight loop's damping — does what its comments say, and the tests pin it. The findings cluster in
three places where the code stopped short of its own comment:

1. **Health verdicts are not composed.** The controller's health check can replace a "Flow was edited,
   open repair" verdict with "1 of 3 lights unavailable" (H-4), and the two tick-driven runtimes never
   re-ask after start, so a lamp cut at the wall is written to every minute behind a green tile (H-3).
   One ranked verdict function and one re-assess-on-change in `tick()` fix both.
2. **Override detection has two holes written twice.** The settle anchor is deleted at the off edge and
   not re-armed at the on edge (H-5), and `Number(null)` reads a missing level as zero (H-6): the
   first can make a wall-switched lamp stop following the curve, the second can darken a lit room. Each
   is the same code in the circadian and daylight runtimes, which is also the case for sharing that
   code (S-7).
3. **Two lifecycle seams trust a string where they should trust a generation or a set:** the same-key
   handshake guard (H-1) and the read-client rebuild that strands every subscription (H-2, needs
   hardware to confirm which way it fails).

Plus a per-rule hold that ramps the whole room (H-7, unreachable on the four reference remotes) and a
one-tap re-attach that can pick the other identical remote (H-8). The schedule engine came through
clean at this level: every stated semantic held under attack, and it already has the verdict gate the
controller lacks, which is what S-8 generalises.

**On simplification:** the codebase has already done its big lifts (device lifecycle, pair session,
migration runner, runtime registry). What is left is concrete and mostly mechanical: three dead
`setDaylight` copies and a byte-identical 20-line block in five drivers; `circadian-runtime.ts` at
1538 lines and `flow-bridge-manager.ts` at 1019 lines, each splitting along seams already visible in
their structure (S-1, S-5); a ticking-registry wrapper for the two timer-owning managers (S-6); and,
after the override bugs are fixed, one shared target-set core for the two tick runtimes (S-7). The
test suite's main cost is eight hand-rolled rigs where one shared fake Homey would do; the peer
session's new lifecycle test is the natural seed for it.

**Baseline caveat:** this reviews `main` at `444c3ed`. The peer session's merged commit closes one
medium finding (M-2) and rewrote one file (M-7 needs re-verifying); everything else is still present
at the current `main` (section 7). **Part B (9 September) supersedes some statuses:** the uncommitted
tree fixes H-1, H-5 and H-7 and half of H-6, and `LAUNCH_REVIEW.md` adds eight confirmed findings
Part A missed, one of which (R7) overturns a mechanism cleared in section 6. Read B1.4 alongside this
headline.

---

## 1. Critical / high

### H-1 · `getWriteClient()` guards the in-flight handshake on the token string, not the generation
`lib/credential-service.ts:295-322` (the check at `:312`). CONFIRMED by trace; not tested
(`credential-service.test.ts` covers a cleared key, `credential-atomicity.test.ts` covers `revalidate()`).

Scenario: at boot a controller's first reconcile has handshake A in flight for key T. The user re-pastes
the same key T on the settings page. `setCredential()` runs its own handshake B, installs `client = B`,
nulls `connecting` and bumps `generation`. A then resolves; the guard `this.token !== token` is false
because the string is identical, so `:313` overwrites `client = A`. Platform §2's working hypothesis is
that B's handshake invalidated A's session, so every Flow write now goes through a dead client: `401
Session Not Found`, `reportFailure`, every controller and schedule flips to `needs_credential` seconds
after a working key was accepted. It self-heals on the next rebuild, but the property CLAUDE.md states
as "one live handshake per API key" is violated and the loser is the one retained. This is precisely
the symptom the property's own comment describes.

**Fix.** Capture `const generation = this.generation` before the attempt and replace `:312` with
`if (this.superseded(generation, token))` — the helper at `:232` already exists for `revalidate()`.
Test: same-key `setCredential` while a handshake is pending; assert the retained client is B.

### H-2 · A rebuilt read client leaves every subscription on the client that was dropped
`lib/homey-api-service.ts:127-134`, `lib/device-catalog.ts:95-120`, and every
`makeCapabilityInstance` + `api.track()` site. PLAUSIBLE: the outcome depends on whether `homey-api`'s
socket reconnects on its own (its default is `reconnect: true`), which only hardware can settle.

`reportReadFailure()` nulls the read client after a transport failure so the next `read()` rebuilds it.
Nothing re-arms what was subscribed on the old one: the catalogue's `devices.on(...)` watcher, every
lamp's capability subscription, every lux sensor's. Either the old socket reconnects and the app holds
two live clients and two `homey-api` caches per failure, or it does not and from that moment no device
change reaches the catalogue, no power-on edge reaches a circadian light and no lux reading reaches a
Daylight light until the app restarts. The comment at `:114-126` says dropping the cache is safe
"because `read()` de-duplicates the rebuild"; the rebuild is de-duplicated, the re-subscription does not
exist.

**Fix.** Give `HomeyApiService` an `onRebuilt(listener)` hook fired when `read()` installs a client after
a drop; have `DeviceCatalog.watch()` and the adapters re-subscribe through it, and destroy the old client
when dropping it. Add a hardware line to `docs/hardware-test-plan.md` that kills the socket and checks a
lamp toggle still reaches the app.

### H-3 · The two tick-driven runtimes never re-assess health after start, so write failures never reach the tile
`lib/circadian/circadian-runtime.ts:431`, `:1428` and `lib/daylight/daylight-runtime.ts:218`, `:633` are
the only callers of `assessHealth()`; `refreshTargets()` returns early on an unchanged fingerprint
(`:1391`, `:606`); `tick()` (`:616`, `:327`) never asks. CONFIRMED by grep and trace.

`light-target-adapter.ts:183-192` says the failure streak exists so a circadian light does not "go on
writing to that lamp every minute for ever behind a green tile". It does exactly that: a lamp cut at
the wall stays `available: true` (platform §6), the fingerprint never moves, and `unwritableTargets()`
is consulted once, at start, when it is empty. The same gap keeps a Daylight light's "no daylight
source" state (`daylight-runtime.ts:587-593`) from clearing when the household sets the Homey's
location. `assessTargets` reads the in-memory catalogue, so re-asking is not the "tick must not
refresh" round trip §12 forbids. `target-write-health.test.ts` proves adapter → `assessTargets`; no
test drives either runtime's state from a streak.

**Fix.** In each runtime's `tick()`, re-assess when the `unwritableTargets()` set differs from the one
last assessed (and, for daylight, when `currentValue().source` flips). `VisibleState` already dedupes
unchanged verdicts.

### H-4 · The controller's health check overwrites a reconcile verdict with a target-count verdict
`lib/runtime/controller-runtime.ts:216-228`; `lib/runtime/health-monitor.ts:101-110`;
`lib/runtime/visible-state.ts:54-60`. CONFIRMED by trace. `controller-runtime-credential.test.ts`
covers a lost source; nothing combines a reconcile verdict with a partial target set.

`start()` runs `buildRuntime()` (may set `partial`), then `reconcileFlowsNow()` (may set
`needs_repair` with `state.flowEdited`), then `assessHealth()`. The monitor delegates to
`assessTargets()`, which returns `partial` when one lamp is unwritable or unavailable; `:221` returns
early only on `ready`, so `:223` sets `partial`. `VisibleState.set()` adopts whatever it is handed. The
device flips from unavailable ("a Flow was edited, open repair") to available ("1 of 3 lights
unavailable") and the repair prompt is gone. It recurs on every `refreshTargets()` and on a
credential change. One lamp switched off at the wall is enough to trigger it. The comment at
`:201-204` says a health problem "wins over the target-count assessment"; the monitor also PRODUCES
target-count assessments, so it wins over the reconcile verdict too, which the comment did not intend.

**Fix.** Keep the last reconcile verdict as a field (`unsupported` and `staleFlows` already are) and
compose the visible state in one ranked function: reconcile `needs_credential`/`needs_repair` >
monitor `needs_repair` > `partial` > `ready`. Leave `VisibleState` dumb, as its docblock argues.

### H-5 · A lamp's own power-on report is read as a human override, because the settle anchor is deleted at the off edge and not re-armed at the on edge
`lib/circadian/circadian-runtime.ts:544` deletes `lastWritten` on `onoff:false`; `noteOverride`
(`:597-604`) and `noteColorOverride` (`:571-581`) treat "no entry" as "no settle window, no
tolerance". Same shape in `lib/daylight/daylight-runtime.ts:295-296` and `:309-315`. CONFIRMED code
path; the trigger depends on integration behaviour (open question below).

Rising edge → `applyNow('switched on', { force })` → the write is in flight for a few hundred
milliseconds. `lastWritten` is re-created only when the batch completion resolves. A Hue bulb
power-cycled at the wall reports its power-on level and colour temperature alongside `onoff:true`.
If those reports arrive after the `onoff` edge and before our write completes, `noteOverride` finds
no anchor, sets an override, and the lamp is skipped on every tick until the next power cycle. That
defeats §12's headline: "a lamp is the right colour however it was switched on: the wall switch". The
`:541-546` comment explains the deletion in terms of the `hasMoved` gate and never considers that the
same record is the override detector's anchor. No test: `circadian-runtime.test.ts:400-442` and
`daylight-runtime.test.ts:265-308` report only `onoff`.

**Fix.** Re-arm a per-device `touchedAt` at the rising edge (`:521`) and in `noteOutcomes`; consult it
in both `noteOverride`s ahead of `lastWritten`/`committed`. Two lines per runtime plus one test each.
Hardware question to settle first: does the Hue app emit `dim`/`light_temperature` with `onoff:true` on
power-on, and in which order?

### H-6 · `Number(null)` is 0 on the capability axes, and a `null` level makes a Daylight light darken a lit lamp
`lib/circadian/circadian-runtime.ts:568`, `:594`; `lib/daylight/daylight-runtime.ts:306`;
`lib/outputs/target-state-cache.ts:59-63`; `lib/daylight/daylight-runtime.ts:463-467`. CONFIRMED
path, PLAUSIBLE trigger (does any integration report `null` before first report or on going
unreachable?). No test: both harnesses default `dim` to 0.5; `luminance-source.test.ts:270` fires junk
at the lux listener only.

`noteOverride` does `Number(value)` then `isFinite`; `Number(null)` is 0 and finite, so a `null`
report on `light_temperature`/`dim`/`light_hue` reads as "changed by hand (warmth 0)" and the lamp
stands down. `liveValuesOf` casts `value as number | undefined` under a comment that says an absent
value must stay absent, so `dim: null` becomes `actualDim = null`; `aimFor` tests `=== undefined`,
`toPerceptual(null)` → `clamp01` → 0, aim 0.05, `toDevice` 0.0014, `litDim` → **`dim: 0.01` written to
a lit lamp** on the first tick, then a fade back up at 0.05 per tick. This is the exact trap CLAUDE.md
records for lux, one axis over.

**Fix.** One `asFiniteNumber(value): number | null` used by the three `noteOverride`s;
`?? undefined` on the five casts in `liveValuesOf`. Add the junk-value test to both runtime suites.

### H-7 · A hold on a mapping with a per-rule target ramps the controller's whole target set
`lib/runtime/controller-runtime.ts:569-579` vs `:375-378`. CONFIRMED by trace. No test: the ramp
engine is tested in isolation and `mapping-and-state.test.ts:255` tests per-rule rules without a ramp.

`execute()` resolves the rule's own target into `targets` (`:570`) and uses it for the step path
(`:582`), but `ramps.start(controlId, kind, direction)` (`:577`) carries no targets and the tick closure
(`:376`) reads `this.targetIds`. Per-rule targets are real (`mapping-screen.ts:113-117` builds them for
any non-"all" group). So "Up long-press → brighter, kitchen lamp only" moves one lamp on the Test
control and the whole room on the wall. Two attached consequences: the `await` at `:570` sits before
`start()`, so a release arriving in that gap finds no ramp, falls through and is consumed, and the ramp
then runs to the 10 s hard stop; and `:663` stops ramps only when ALL targets vanish, so a ramp whose
single lamp left the plan keeps going on the rest. Exposure caveat: none of the four reference remotes
(platform §7) exposes long-press and release on one control, so the ramp engine is unreachable on them.

**Fix.** Keep the ramp's target spec beside the ramp (`Map<controlId, TargetSpec | null>`, `null` =
inherit so `refreshTargets()` is honoured), set it before `start()` and before any `await`, resolve
it in the tick, and stop a ramp when its own resolved set becomes empty.

### H-8 · One-tap re-attach can offer the OTHER identical remote
`lib/runtime/health-monitor.ts:124-144`, `:226-231`. CONFIRMED by trace; `health-monitor.test.ts`
has no multi-candidate case.

The portable fingerprint is device-agnostic by design (card short ids only), so two STYRBARs or two
BILRESAs always tie and the loop returns whichever `allDevices()` lists first. Nothing excludes a
device that is the live source of another controller. BILRESA is exactly the re-add case §7 describes;
a household with two of them gets controller A offered "Bedroom remote looks like this remote,
re-added. Re-attach in one tap" — remote B, still driving controller B. The name is shown, so an
attentive user can decline, but the copy promises one tap.

**Fix.** Inject `sourcesInUse: () => ReadonlySet<string>` from the controller registry and filter
them out; when more than one candidate survives, return no auto-candidate and a distinct detail
(`source.reattachAmbiguous`) so repair lets the user choose. The unambiguous case keeps its one tap.

---

## 2. Medium

### M-0 · `apply()` runs no validator, so a route can persist a plan the next restart will quarantine
`api.ts:504-522`, `lib/devices/device-lifecycle.ts:309-347`, `lib/schedules/schedule-types.ts:168`.
CONFIRMED by trace. `api-trying.test.ts` tests the sanitiser's drops, not plan-level validity.

`setScheduleEntries` sanitises the entries, spreads them over the raw store value and calls
`applyPlan()`. `DeviceLifecycle.apply()` runs `prepareApply`, registers and persists; the only validator
in the device layer is the one `migrate()` runs at load. So a body with `fromDaylight: true` on a device
whose plan has no `daylight` response is accepted, the runtime starts (it falls back to the stored
brightness), and at the next app restart `validateSchedulePlan` refuses the plan and the device goes
unavailable with "set this device up again". The pairing screen cannot send this because its daylight
card gates the flag; the route has no gate. The spread itself is fine, since `init()` has already
migrated the store by the time the route can run.

**Fix.** Validate in `DeviceLifecycle.apply()` after `prepareApply`, with the same validator the chain
ends in (the `DeviceOwner` already supplies `migrate`; give it `validate` too, or have `migrate` accept a
current-version plan). One line in the route is the narrow fix; the lifecycle is where it covers all
five device types.

### M-1 · `DeviceLifecycle.deleted()` stops the runtime twice and leaves it dispatchable in between
`lib/devices/device-lifecycle.ts:420-441`, `lib/runtime/runtime-registry.ts:94-101`,
`lib/runtime/controller-runtime.ts:705-708`, `lib/schedules/schedule-runtime.ts:776-779`.

`deleted()` calls `runtime.destroy()` (which runs `stop()` and then removes the Flows) and only then
`registry.unregister(id)`, which finds the runtime still in the map, removes it and calls `stop()` a
second time. Between the two calls the stopped runtime is still in the registry, so a bridge event in
that window is dispatched into a runtime whose scheduler is `null`. `stop()` is idempotent enough that
this has not shown up, but the registry's own header states the rule as "remove BEFORE awaiting
stop()", and this path breaks it. The same word also means two things: `DeviceRuntime.destroy()` is
"stop and delete owned Flows", `RuntimeRegistry.destroyAll()` is "stop everything, keep the Flows".
CONFIRMED by reading; no test covers the ordering.

**Fix.** Unregister first (removes and stops), then remove the Flows from the returned reference set;
rename one of the two `destroy` spellings so the delete path and the shutdown path cannot be confused.

### M-2 · `publishState()` and `apply()` persist the store from two different mutex keys — ADDRESSED at `b2ebfd3`, see section 7
`lib/devices/device-lifecycle.ts:309-347` and `:492-538` at the baseline.

Operations run under the `ops` key and verdicts under the `state` key, and both write the plan to the
store. `publishState()` reads `storedPlan()` as its base and then awaits a `setStoreValue`; `apply()`
does the same on the other key. For the two device types whose `planOf()` folds runtime fields onto the
base (circadian, daylight), a verdict that reads the store just before `apply()`'s write lands can
persist the previous plan over the new one. The window is narrow and needs a queued verdict, so this is
PLAUSIBLE rather than confirmed, and it is exactly the shape of bug the file's own header says it exists
to prevent. No test.

**Fix.** Make the verdict's persist go through the same `ops` key as `apply()` (only the availability
call needs the sequence-numbered `state` key), or have `publishState()` skip its persist while an apply
is in flight.

### M-3 · The folder view is loaded with "create the root if absent" on the two delete-only paths
`lib/bridge/flow-folder-manager.ts:111-134`; callers `lib/bridge/flow-bridge-manager.ts:793` and `:829`.
CONFIRMED. `flow-bridge-folders.test.ts` starts every case with the root present.

`load()` conflates reading the folder view with ensuring the root exists. On `removeAll()` and on the
orphan sweep it is called only to find empty device folders to clean up, so a user who deleted the
`Lightkeeper` folder and then deletes their last device gets an empty root recreated by the delete. With
a dead key the same path attempts a folder WRITE from a delete, and `withWriteClient` classifies that
failure app-wide before the folder manager swallows it. **Fix:** `load({ createRoot: false })` on the
delete paths; `cleanUpEmpty` needs the root only as a parent filter.

### M-4 · The "our card moved" forgiveness covers the trigger id, not its argument name
`lib/bridge/flow-bridge-manager.ts:997-1006`, `lib/schedules/schedule-runtime.ts:351`. CONFIRMED trace,
speculative input. `flow-bridge-lifecycle.test.ts:340` moves the id and keeps the argument.

A schedule's fingerprint is `time:<id>:<argument>`. If a firmware renames `cron:time_exactly`'s
argument (platform §9 records Athom reshaping `cron:every` in exactly this way) the fingerprint moves,
`triggerIdMayHaveMoved` skips the id check, and `argsMatch` at `:1006` then fails on the renamed key, so
every schedule Flow reads as user-edited and the schedule is stuck in the very dead end the flag was
added to remove. **Fix:** when `triggerIdMayHaveMoved` is set, forgive argument keys that are absent from
the live args as well, and say so in the `:989-996` comment. Add the test.

### M-5 · The target fingerprint watches three capabilities; a plan is built from six
`lib/outputs/target-snapshot.ts:36` (`WATCHED_CAPABILITIES` = `onoff/dim/light_temperature`) under a
docblock at `:20-22` claiming it covers "everything a plan is actually built from". CONFIRMED;
`write-path-safety.test.ts:231-305` covers none of the three missing ones.

A lamp that gains or loses `light_hue` or `light_mode` by firmware leaves the fingerprint unchanged, so
`primeCache` never re-runs and `cache.supports(id, 'light_hue')` stays stale: a Curve light keeps
writing warmth to a lamp that now does colour, or a `light_mode` the lamp no longer has. **Fix:** widen
to all five written capabilities plus `light_mode` presence.

### M-6 · `probePreStage` awaits a timer `stop()` cannot cancel
`lib/circadian/circadian-runtime.ts:1319`. CONFIRMED; cost is bounded. Both callers (`api.ts:431`,
`pair-session.ts:378-383`) await the probe before stopping, so only `destroyAll` mid-probe races: one
`refresh` round trip re-creating a cache entry after `cache.clear()`, and possibly an `onoff:false`
restore write from a stopped runtime to the lamp the user's own test lit. **Fix:** check a `stopped`
flag after the wait, or register the handle in `probes`.

### M-7 · `LuminanceSource` mutates its owner map outside the per-sensor lock
`lib/daylight/luminance-source.ts:79-83`, `:92-96` vs the lock at `:86` and the comment at `:175-178`
assuming the lock serialises all mutation. PLAUSIBLE (callers serialise per device today). An owner
released while its own `subscribeNow` is mid-`getDevice` removes the map entry, then `watched.off` is
assigned on an orphan and the tracked subscription leaks until teardown. **Fix:** wrap the drop in
`lock.run(deviceId, …)`.

### M-8 · The dim-down floor writes `0.01` to a lamp whose resolution is tenths
`lib/outputs/intent-planner.ts:222-223`. CONFIRMED arithmetic (run through the real planner:
`decimals: 1`, dim 0.1, delta −0.1 → `dim 0.01`); what the lamp does with it is a hardware question
(§6 only measured `decimals: 2`). By the app's own model a value under the representable step is
darkness, so this violates "a positive brightness is never written as darkness" for tenths lamps.
**Fix:** `Math.max(next, representableStep(id, cache) ?? behavior.minimumBrightness)`, or route through
`litDim`.

### M-9 · Synchronised group mode nudges a lamp already at the group target one step past it
`lib/outputs/intent-planner.ts:212-213`. CONFIRMED (A = 0.13, B = 0.00, +0.1 → A 0.14, B 0.13).
`advanceDim`'s "guaranteed to move" is a per-lamp argument; the group's guarantee is that the group
moves. **Fix:** skip the nudge when `synchronisedValue !== null`.

### M-10 · A plan from a NEWER app version is quarantined with the wrong sentence
`lib/support/migrations.ts:77-83` throws a plain `Error` ("…Update Lightkeeper.");
`lib/devices/device-lifecycle.ts:269-270` maps only `name === 'ValidationError'`, so this falls to the
`missingKey` and the tile says "not configured" while the lifecycle's own comment at `:265-267`
promises a distinct "update Lightkeeper" text. CONFIRMED code ≠ comment; no test. **Fix:** throw a
named `MigrationError` with `kind: 'newer' | 'malformed'` and map `newer` to its own locale key.

### M-11 · A hand-edited legacy profile can hang `onInit`
`lib/profiles/migrations.ts:102-110`: `expandStoredRange([0, 1e9])` builds a 10⁹-element array before
the ceiling is applied. PLAUSIBLE (real v1 profiles were ≤ 12). **Fix:** `if (to - from >
RANGE_EXPANSION_CEILING) return []` — the docblock already argues for the empty-list refusal.

### M-12 · A schedule boundary is validated on receipt against the DAY, never against the clock
`lib/schedules/schedule-runtime.ts:530-561` (`validate()` checks controller id, entry, timezone and
weekday). PLAUSIBLE as a design gap rather than a stated-property violation; day refusal is tested
(`schedule-runtime.test.ts:420`), time never.

A user who retimes the generated on-Flow from 22:00 to 15:00 in the Flow editor gets a lit room at
15:00 with the tile saying `ready`. `hasBeenUserEdited()` would catch the edit, but reconcile runs only
at start, on `updatePlan` and on a credential change; there is no periodic pass. **Fix:** for `on`
require `isActive(entry, clock)` and for `off` require `!isActive(entry, clock)` (both DST-tolerant:
touching windows still pass), and on refusal call `reconcileFlows()` so `flowEdited` appears now rather
than at the next restart.

### M-13 · Sensor ids from a pairing screen are shape-checked but never checked against the catalogue
`lib/pairing/pair-session.ts:229-247`, `drivers/daylight/driver.ts:175-193`;
`lib/validation/pairing-dto.ts:39-69` has `validateTargetAgainstCatalog` for lights and no twin for
sensors, although its header says membership is the point. CONFIRMED absence; the consequence degrades
visibly (the device runs on the sky and lists the sensor unavailable). A scripted pair session
(platform §14) or a stale card can send a lamp id as a sensor. **Fix:** `validateSensorsAgainstCatalog`
(exists, and `capabilities` includes `measure_luminance`), called before `retain` in both `setDaylight`s.

---

## 3. Low

### L-1 · `isNotFound()` matches a `404` embedded in an id, and matches it even when the status says otherwise
`lib/support/homey-errors.ts:62-72`. Two reviewers reached this independently.

After the status check the message test `/(^|\D)404(\D|$)/` runs regardless of whether a status was
present. A hex id containing `404` between two letters (roughly one UUID in three hundred) inside any
error message — a 409, a 423, a 500 — reads as "not found", and the caller treats the delete as already
done and drops the reference while the Flow goes on firing with a live controller id, invisible to the
sweep. The docblock says the predicate is "deliberately NARROW" and "tested on its own"; only the
`statusCode: 404` path is exercised. CONFIRMED by construction.

**Fix.** `const s = statusOf(error); if (s !== null) return s === 404;` then anchor the message fallback
to the platform shape (`/^404\b/`). Add the unit test the header claims exists.

### L-2 · `.gitattributes` omits `*.css` and `*.js`, which `views/shared/` contains
`.gitattributes`, `views/shared/{base.css,daylight-card.css,emit.js,daylight-card.js}`.

The file pins `*.html` to LF and says it is "explicit for the file types this project actually
contains", but the four shared sources the sync script splices into every view fall under `text=auto`.
Reproduced: `git archive` on a Windows machine with `core.autocrlf=true` produced CRLF for the four
sources and LF for every view, and `npm test` then failed the repair-views "no drift" subtest and
`sync:views:check` reported all thirteen views drifted. A fresh Windows clone would see the same before
touching a line, and `npm run sync:views` would splice CRLF into LF views. CONFIRMED.

**Fix.** Add `*.css text eol=lf` and `*.js text eol=lf`.

### L-3 · Two "minimum brightness" constants with near-identical names and different units
`lib/mapping/mapping-types.ts:42,60` (`minimumBrightness`, default 0.01, a DEVICE value),
`lib/outputs/light-intent.ts:74` (`MINIMUM_BRIGHTNESS`, 0.10, a PERCEPTUAL floor).

The planner's comparisons at `lib/outputs/intent-planner.ts:217-223` are in consistent (device) units,
so this is not a bug today (M-8 is about the VALUE, not the units). But 0.01 is not a policy value: it
is the `decimals: 2` representable step wearing a policy name, uncommented, never user-editable, and
coincidentally equal to `toDevice(0.10)` quantised. **Fix:** rename to `minimumDimValue` with a unit
comment (a persisted field, so keep the key or add a trivial migration step) and stop using it at
`:223` per M-8.

### L-4 · The timezone-reading closure exists three times
`app.ts:248-254`, `app.ts:265-271`, `lib/pairing/pair-session.ts:152-158`.

Same try/catch around `homey.clock.getTimezone()`. **Fix:** one `timezoneOf(homey)` helper in
`lib/time/local-clock.ts`, used by all three.

### L-5 · `reportReadFailure()` during an in-flight connect starts a second build
`lib/homey-api-service.ts:129-131` and `:94`. CONFIRMED trace, no test. Nulling `connecting` while an
attempt is running does not stop that attempt installing itself at `:94`; the next `read()` starts a
second one, so a failure storm leaves two clients and an orphaned socket. **Fix:** `if (this.connecting)
return false;` — a rebuild is already under way.

### L-6 · `findManagedFlows()` does not report a transport failure, unlike `sync()`
`lib/bridge/flow-bridge-manager.ts:679-680` vs `:378-384`. CONFIRMED. Count and sweep on a dead socket
fail without triggering the rebuild. **Fix:** mirror `:378-384`.

### L-7 · `network` in the transport-failure regex is too broad
`lib/support/homey-errors.ts:101`. PLAUSIBLE. A statusless `TypeError: … (reading 'networkName')`
from our own code would drop a healthy client. **Fix:** `network (?:error|unreachable)`.

### L-8 · A dead `credentialFailure = 'malformed'` annotation on the no-key error
`lib/credential-service.ts:302`. CONFIRMED. `sanitizedWriteError` re-derives the class from message and
status, so nothing reads it; and "no key stored" is `present: false`, not malformed. Delete it.

### L-9 · `name: a?.name` is typed `string` and may be `undefined`; two fingerprints sort on it
`lib/flow-card-catalogue.ts:215`; `lib/source-discovery-service.ts:314`, `:357`. PLAUSIBLE (manifest
validation makes a nameless argument unlikely). One would make `discover()` throw and a controller fail
to start. **Fix:** `String(a?.name ?? '')`; folds into S-2 below.

### L-10 · Bare `Number()` in two sanitisers, beside type-checked siblings
`lib/daylight/daylight-types.ts:230-235` (`sanitiseLux(false)` → 0 → clamped to 0.1 lux and accepted)
and `lib/validation/unit-interval.ts:17` (warmth `false` → 0, the coolest end). CONFIRMED; only a
hand-edited store or a screen bug reaches it. **Fix:** type-check before `Number`, like `asLux`.

### L-11 · After a colour write voids the warmth record, any later temperature report is an override
`lib/circadian/circadian-runtime.ts:602-603` with `:1077`. PLAUSIBLE (depends on whether a lamp in
colour mode reports a temperature change). Folds into H-5's `touchedAt`, or treat "we never wrote this
axis" as not-an-override.

### L-12 · A `light_mode`-only success creates a `lastWritten` entry with no axis
`lib/circadian/circadian-runtime.ts:1042`. Cosmetic: diagnostics show `lastWritten: { at }`. Guard the
`?? { at }` on the three value capabilities.

### L-13 · Same constant names, different values, different files
`lib/validation/plans.ts:78-79` (`MAX_ENTRIES = 32`, `MAX_POINTS = 48`) vs
`lib/schedules/schedule-types.ts:31` (12) and `lib/circadian/circadian-types.ts:32` (8). Not a bug:
`plans.ts:76` says they are DoS bounds above the product caps, and they are module-private. **Fix:**
rename to `*_HARD_CAP`, import the product constants, add one test asserting hard cap ≥ product cap.
The literal "12 windows, 8 curve points" in that comment will otherwise drift.

### L-14 · `ownerAppId` holds an owner URI
`lib/profiles/controller-profile.ts:54`; compared with `device.ownerUri` at `health-monitor.ts:202`.
Consistent, misnamed. Doc comment; not worth a migration step.

### L-15 · The write-interval floor is measured from flush START
`lib/outputs/command-scheduler.ts:319`. A flush with one ~275 ms write already exceeds
`minWriteIntervalMs`, so the "floor between two writes" `mapping-types.ts:45-50` describes is zero
between flushes; per-device serialisation still holds. Stamp at flush end, or reword the comment.

### L-16 · A "brighter" hold at full brightness writes `dim 1` on every flush for ten seconds
`lib/outputs/intent-planner.ts:227`; `LightTargetAdapter.write` (`:340-378`) has no equals-desired
short-circuit. CONFIRMED, low: ~30 no-op writes plus echoes per hold. **Fix:** after `advanceDim`, skip
when `next === clampDim(current)` and `delta !== 0` — the "end of range still does nothing" case its
docblock names.

### L-17 · `flowsHealthy` is set true BEFORE the schedule's sync resolves
`lib/schedules/schedule-runtime.ts:310` vs `:735-752`. PLAUSIBLE, narrow. A `refreshTargets()` whose
fingerprint changed inside that window calls `assessHealth()`, sees healthy and reports `ready` over a
standing `flowEdited`; corrected when sync returns. No schedule test calls `assessHealth` or
`refreshTargets` directly. **Fix:** compute locally and assign once after the sync; add the direct test.

### L-18 · A non-array `args` on one trigger card takes every schedule to `needs_repair`
`lib/schedules/time-card-discovery.ts:67`: `undefined`/`null` are handled, `args: {}` makes `.map` throw
and `timeCard()` rejects un-memoised. PLAUSIBLE, unlikely. **Fix:** `Array.isArray(raw?.args) ? raw.args : []`.

### L-19 · Empty or whitespace names in name derivation
`lib/pairing/derive-name.ts:48,53`; `pair-session.ts:326`. A lamp named `""` yields `" schedule"`; a
whitespace-only typed name is accepted. CONFIRMED, trivial. **Fix:** `.trim() || fallback`.

### L-20 · The shared daylight card's `getDaylight` does not retain its sensors on the way in
`pair-session.ts:214-227` vs `drivers/daylight/driver.ts:121-124`. PLAUSIBLE. The comment at `:200-203`
justifies the difference by "its screen IS the card", which does not cover repairing a quarantined
schedule whose runtime is not running: `now` says sky until the user touches the card. **Fix:** retain in
the shared `getDaylight` when `state.daylight?.sensors.length`.

---

## 4. Simplification plan

### S-1 · Split `flow-bridge-manager.ts` (1019 lines) along three seams the file already has
Every doc comment moves with its function unchanged. The first two cuts are mechanical; the third only
if the sweep is going to grow.

| New file | Moves | Consumers to touch | Lines out |
|---|---|---|---|
| `lib/bridge/flow-edit-detection.ts` | `argsMatch` (:179-194), `hasBeenUserEdited` (:941-1019) | re-export from the manager; the test file is already named for it | ~110 |
| `lib/bridge/flow-attribution.ts` | `LIGHTKEEPER_DEVICE_ID` + `mintDeviceId` (:128-167), `looksGenerated` (:196-226), `ManagedFlowSummary` (:99-126), `ourCardIds`/`ownerDeviceIdOf`/`flowFolderInfos` (:913-939) | `drivers/controller/driver.ts:1` and `lib/pairing/pair-session.ts:6` import `mintDeviceId`; re-export keeps them working | ~150 |
| `lib/bridge/orphan-sweep.ts` | `refusedSweep`, the two result types, `countOrphans`/`sweepOrphans` (:697-800), `orphansAmong`/`previewToken` (:874-911) as a class over `{ findManagedFlows, deleteFlow, folders, log }` | `api.ts:291,308` keep thin delegating methods; `deleteFlow` becomes an injected interface | ~190, medium risk |

The manager lands near 570 lines: types, `bridgeCards`, `reconcile`/`sync`/`compensate`,
`findManagedFlows`, `removeAll`, the two writes.

### S-2 · Type the flow seam that `lib/homey-api-types.ts:17-27` explicitly invites
Add `RawFlow`, `RawFlowCardRef` (`id?`, `uri?`, `args?`, `droptoken?`), `RawFlowFolder`, `RawFlowCard`,
`RawCardArgument`, `RawCardToken`. Consumers: `hasBeenUserEdited`, `looksGenerated`, `ownerDeviceIdOf`,
`flowFolderInfos`, `toRecord`/`readFolders`, `cleanUpEmpty`, `removeAll`, `toDiscoveredCard`. About 45
lines of types, no behaviour change, closes L-9, and turns that header's "they are gone" paragraph into
"here they are and who reads them".

### S-3 · Leave `api.ts` as it is
The four `get(id) ?? throw` preambles would save four lines and do not fit the two-registry
`previewDevice`. `liveDeviceIds()` has to live somewhere a test can import, and `app.ts` cannot be
(platform §13). `appOf`/`deviceOf` are fine.

### S-4 · Small duplications in the spine
`app.ts:249-255` and `:267-273` are one timezone closure written twice (see L-4); `app.ts:162-168`
restates the fan-out comment and repeats the "circadian absent" sentence from `:141-144`;
`flow-folder-manager.ts:73-81` stacks two doc comments of which the first is stale; L-8 above.

### S-5 · Split `circadian-runtime.ts` (1538 lines) into four files, each keeping its rationale
| New file | Moves | Approx. lines |
|---|---|---|
| `lib/circadian/pre-stage-guard.ts` | `PRE_STAGE_*` constants, `preStageDeclines`, `probes`, `writeGeneration`, `arm(writes)`, `onOutcomes()`, `refused()`, `noteDecline`, `verifyStayedOff`, `cancelProbe`, `probePreStage`; the "MARKED wider than ARMED" comment moves with its two loops; `disablePreStage` stays behind a callback | ~430 with comments |
| `lib/circadian/written-record.ts` | `lastWritten`/`lastColorWritten`/`pendingColor`, `noteOutcomes` with both voiding comments, `hasMoved`/`colorHasMoved`/`stepFor`, `COLOR_STEP`, `lastWrittenFor` | ~300 |
| `lib/circadian/circadian-diagnostics.ts` | the two diagnostics interfaces | ~200 |

The runtime lands near 600 lines. Risk medium: the tests drive only the public surface, so they are
the net; the one thing not to touch is the ordering inside `applyNow`.

### S-6 · A `TickingRegistry` for the two tick-driven managers, by composition
`startTicking/stopTicking/tickAll/unregister/get/all/onCatalogChange/destroyAll` are near-identical in
`circadian-runtime-manager.ts:120-169` and `daylight-runtime-manager.ts:141-190`. A wrapper around
`RuntimeRegistry` taking `{ label, tickMs, setInterval, clearInterval }` absorbs them; `register`,
`ephemeral` and `baseDeps` stay per manager, which is exactly the "domain glue" the registry's header
says must stay separate, so that argument survives. One `TICK_MS` with both rationale paragraphs.
About −60 lines; low risk.

### S-7 · A shared target-set core and override tracker for the two tick-driven runtimes
Owns `cache/adapter/resolver/scheduler/snapshot/targetIds/targetNames`; exposes `build`, `refresh →
removed[]`, `submit → completion`, `stop`, `drivable(pred)`, `assessTargets`. The "tick must not
refresh", fingerprint, "zero writes after leaving" and "bookkeeping behind the completion" comments each
land once. An `OverrideTracker` (map + `noteOverride` + power-cycle clear, parameterised by a
`lastTouched(id)` lookup) is where H-5's fix goes once instead of twice. Circadian −250, daylight −200,
new +300. Risk medium-high; do it AFTER H-3, H-5 and H-6 land. Those three bugs are each written twice,
which is the argument for it.

### S-8 · Extract the shared Flow reconciliation and give the verdicts one ranking
`controller-runtime.ts:418-536` and `schedule-runtime.ts:332-400` are the same block (persist if
changed, `userEdited`, `unsupported`, log, `staleReplacements`, `persistFailed` last, then the catch)
in two files. Extract `applySyncResult(result, { persist, setState, log })` RETURNING `{ healthy,
unsupported, staleFlows }` rather than mutating, so the schedule keeps `this.flowsHealthy =
outcome.healthy` and the controller adopts the same gate, which is the fix for H-4. The schedule
already has that gate (every reconcile verdict flips `flowsHealthy`, `schedule-runtime.ts:314-395`);
the controller does not, and this is what makes the invariant structural instead of five hand-placed
assignments. What stays per runtime: the schedule's ~15-line time-card pre-step, the controller's
cold-start skip. About −55 net across the two plus the ranking function; low-medium risk since both
runtimes are fully harnessed; do it together with H-4. Optional pure move: `ControllerDiagnostics` +
`diagnostics()` (~110 lines) to `controller-diagnostics.ts`.

### S-9 · `event-normalizer.ts`: small cuts, and NOT a per-remote table
The four-remote knowledge (platform §7) is already data (regex tables, a role classifier); §7's point
is that nothing is per-remote. Concrete: delete the superseded `//` block at `:139-142` (its `/** */`
rewrite is directly beneath); drop `action !== undefined` at `:158` (non-null since `:116`); pull the
three nested ternaries at `:271-278` into `labelFor()` carrying the "direction has to be VISIBLE"
comment; name `preferred()`'s `/initial/` as `PRESS_DOWN_HINT`, the one place a vendor's card naming
leaks. About −10 lines; nil risk.

### S-10 · `canRamp`'s rotation arm describes a capability the runtime cannot exercise
`lib/outputs/ramp-engine.ts:166-175` accepts `rotate_start` + `rotate_stop`, but `execute()` starts a
ramp only on `long_press` (`controller-runtime.ts:574`) and `collapseSemanticDuplicates` never leaves
both rotation actions on one control. Cut the arm and its test; keep one sentence on `canRamp`:
"rotation is stepping by construction". −4 lines, nil risk. (Alternative: wire `isHoldAction()` at
`:574`, but §7 says dials step.)

### S-11 · Recommend AGAINST a migration-step factory
The `sunPeak` no-op step is byte-identical in `circadian-migrations.ts:123-129` and
`curve-migrations.ts:79-85` (daylight's targets a different field). But every chain header says "add
an entry, never edit one": a shared factory couples three frozen historical steps to one future edit,
which is what the rule forbids. Dedupe the COMMENT by pointing two at the third, and add one shared
test asserting each chain's `sunPeak` step is a behavioural no-op and idempotent.

### S-12 · The four managers: do not lift further than S-6
The remaining duplication is five 3-line delegators × 4 (~60 lines); a base class saves ~40 and
reinstates the hierarchy `runtime-registry.ts:9-13` and `visible-state.ts:17-22` argue against. The
one worth a look is `baseDeps()`: `controller-runtime-manager.ts:125-134` calls itself "the third copy
of that idea" and daylight is the fourth; a shared `pickBaseDeps()` is a 10-line win.

### S-13 · Nothing per tick is worth moving to plan change
`resolvedPoints()`, the point sort, `wantsColour`, `localNow`'s `Intl.DateTimeFormat` construction and
one NOAA pass run once a minute per runtime; a cache would add invalidation state for microseconds.

### S-14 · The driver layer: delete the dead copies, then a branch-free shell plus a testable recipe
Three facts, all CONFIRMED by reading: a `setDaylight` handler is byte-identical in three drivers
(`circadian/driver.ts:190-208`, `curve/driver.ts:185-203`, `schedule/driver.ts:161-179`) AND is
already registered two lines earlier by `registerDaylightCardHandlers()` (`pair-session.ts:229-247`);
the lift was made and the originals never deleted, so the driver copy re-registers the same name with
the same body (57 lines, delete outright). `pairHost()` plus `get app()` is a 20-line block identical
in all five `driver.ts`. The `onInit/onPair/onRepair/bindSession` prologue and the save block repeat
in each.

Proposal in two parts. Into `lib/pairing/` (testable): `bindStandardSession(host, session, {
subtitleKey, credentialNextView?, daylightCard?, save, own })` owning the registration recipe
(`add_device`, targets, the driver's own handlers via `own(handler, state, sessionOwner)`, the card,
save, `releaseOnDisconnect`). Today nothing fails if a sixth driver forgets `releaseOnDisconnect`; a
test on the recipe would. Into `lib/drivers/lightkeeper-driver.ts` (`extends Homey.Driver`,
branch-free, the same precedent as `lightkeeper-device.ts`): `pairHost()`, `get app()`, `onInit`,
`onPair`, `onRepair(session, device)` → `bindSession(session, this.seedFrom(store), device)`,
`timezone()`. Each `driver.ts` keeps its docblock, `SessionState`, `seedFrom`, its own handlers and
`buildPlan`. Drivers −227, shell +50, recipe +50: **−127 net, −184 with the dead copies**;
`schedule/driver.ts` 215 → about 110. Risk medium: five files and the hardware pair pass (release
checklist step 5). The shell has no test by construction (platform §13), so it must stay branch-free.

### S-15 · `schedule-runtime.ts` (854 lines): two pure moves
`ScheduleRuntimeDeps` + `ScheduleDiagnostics` (`:52-178`, −127) to `schedule-runtime-types.ts`,
comments intact; and `planOn`/`brightnessFor`/`planOff` (`:665-727`, −60) as pure functions of
`(entry, targetIds, cache, daylight?, evaluator?, log)` in `schedule-boundary-plan.ts`, testable
without a runtime. With S-8 the class lands near 610 lines: lifecycle, reconcile shell, health,
catch-up, intake, apply, diagnostics. Nil and low risk respectively.

### Noted and not proposed
The four `*ManagerDeps` interfaces and the per-chain `*Migration` type aliases are nominal boilerplate
nobody imports; fold them only when touching those files for other reasons. There are no dead value
exports (`module-surface.test.ts` polices it); 24 exports exist only for tests, which is fine.

---

## 5. Tests, scripts, configuration and documentation

### 5a. Findings that let a regression through or mislead a maintainer

| # | Where | Finding | Fix |
|---|---|---|---|
| T-1 | `.github/workflows/ci.yml` | No `npm audit`. CLAUDE.md records four accepted moderates in the shipped tree and says "re-check at each dependency bump"; nothing does, so a new high in the shipped tree lands green on a dependabot PR. CONFIRMED. | Add `npm audit --omit=dev --audit-level=high` (tolerates the four moderates, fails on new high or critical). |
| T-2 | `CLAUDE.md:145-150`, `:55` vs `scripts/verify-hardware.mjs:15-20` | CLAUDE.md says the hardware script "touches nothing else — a device you paired is never selected, written to or deleted"; the script's own header says `rejoin` and `preview` "write to your lamps" and it has 15 `setCapabilityValue` calls on household lamps (all behind `--yes`, all confined to lamps its own `[verify]` devices target, all restored). The sentence is about Lightkeeper devices but reads as a promise about lamps. CONFIRMED. | Reword to "never creates, renames or deletes a Lightkeeper device it did not build; does switch the lamps its own devices point at, and restores them." |
| T-3 | `test/unit/webview-safety.test.ts:120-134` | The "builders still escape everything" check is a heuristic: it counts `escapeHtml(` calls and asserts more than ten. A new unescaped `' + name + '` in `pointHtml` or `entryHtml` passes. CONFIRMED weak. | Assert every `+ <expr> +` inside the allow-listed builders matches `escapeHtml\(|Math\.round\(|Number\(` or a named numeric local. |
| T-4 | `scripts/sync-views.mjs:249-250`; `pair-view-styles.test.ts:165` | An optional block (the daylight card) whose marker is lost in a carrier is silently skipped: the script has no expected-carrier list and the test asserts only `carriers.length > 1`. PLAUSIBLE (pair-view-behaviour may still catch it). | `carriers: ['daylight','schedule','ends','curve']` on the optional block entries; assert `=== 4`. |
| T-5 | `scripts/sync-views.mjs:151`, `:170` | The splice takes the first marker occurrence; a duplicated marker leaves a second stale copy invisible to `--check` and to the test's extractor. PLAUSIBLE, low. | Assert `indexOf(start, from + 1) === -1`. |
| T-6 | `CLAUDE.md:289` vs `:336`, `CONTRIBUTING.md:138`, `release-metadata.test.ts:42` | "The version lives in **three** places" contradicts "the four versions disagree (`package-lock.json` counts)" thirty lines later. CONFIRMED. | Say four; add the lock file to the table. |
| T-7 | `CLAUDE.md:473-474`; `pair-view-styles.test.ts:8`; `sync-views.mjs:7-8` | "129-line CSS base", "69 lines of CSS, 60 of markup, 339-line `daylightCard()`". Actual: 148 / 80 / 71 / 402. Three places carry the stale figures. CONFIRMED. | Drop the numbers, or point at `wc -l views/shared/*`. |
| T-8 | `package.json:3` | The description names two of five device types. | Reuse README.md's sentence. |

`--check` byte-exactness is CONFIRMED (`Buffer.equals` for copies, string equality for splices), which
is the mechanism behind L-2: a CRLF `views/shared/*.css` spliced into an LF view drifts on line endings
alone. A missing REQUIRED block throws with the file named; a changed root id is followed automatically.

Not findings after checking: `.homeyignore` (the CLI's default rules already exclude dotfiles, `*.ts`
and compose sources; `/test /docs /artwork /scripts /views` are listed); `@types/node ^20` vs Node 22
vs `engines >=20.11` (deliberate, explained in `dependabot.yml`); `validate` on fork PRs (no secrets,
`contents: read`).

### 5b. Recommendations

- **T-9 · One `test/support/fake-homey.ts` (about −115 lines net, low risk).** The three runtime rigs
  each define a `FakeDevice` interface, a `light()` factory, a device handle recording `writes` via
  `setCapabilityValue` and `listeners` via `makeCapabilityInstance`, an `api = { read, track }` cast
  to `HomeyApiService`, a `catalog = { device, devicesInZone, lightsInZone, isOwnDevice }`, and
  `report()`/`isSubscribed()`/`removeFromCatalogue()` (`circadian-runtime.test.ts:23-211`,
  `daylight-runtime.test.ts:41-197`, `schedule-runtime.test.ts:23-92`). About 225 lines that one
  ~110-line `fakeHomey({ devices, refuseWrite?, credential? })` replaces. Reach beyond the five rigs:
  `as unknown as HomeyApiService` in 30 files, `getDevice` fakes in 16. Keep as parameters, not
  unified: circadian's `refuseWrite.when(device)` + `attempts` (the measured Hue soft-off), its
  collected-timer list, schedule's `bridge.sync` fake, daylight's evaluator fakes. For `api.ts`, a
  ~40-line `fakeApp()` skeleton replaces ~60 across `api-orphans` and `api-trying`; api-orphans'
  wrapping of a REAL `FlowBridgeManager` over a fake flow client stays. The peer's new
  `runtime-lifecycle-safety.test.ts` should be the seed, not a third rig.
- **T-10 · Extract `scripts/homey-client.mjs` (about −150 lines in the scripts, −211 with
  `probe-shared-helpers.test.ts` deleted; medium risk, needs one `spike` run).** Shared today:
  `capabilityValue`, `withTimeout`, `disconnectAll`, `sleep`, `clamp` (verify `:855/:546/:572/:636/:685`;
  probe `:1229/:1082/:1108/:1135/:1140`), plus `connect` and `messageOf`. `readConfig`/`ensureConfig`
  stay per script, as the test's own comment argues. `tsconfig.test.json` already type-checks
  `scripts/**/*.mjs`, so the move is compiler-checked. After it, `probe-findings.test.ts`'s twenty pure
  exports belong in a `probe-analysis.mjs`.
- **T-11 · Tests worth writing for the un-imported modules.** `lib/pairing/sensor-picker.ts`
  (`readingOf()` null/NaN/negative-lux guards, the "Unassigned" zone, two sorts — the picker's only
  decisions; `pair-session.test.ts` tests the wrapper, not the payload); the three managers' lifecycle
  (`ScheduleRuntimeManager.timeCard()` single-flight with reset-on-failure, `onCredentialChange`, the
  ticker stopping when the registry empties) which are reachable only through `app.ts` that no test can
  import; `lib/support/same.ts`'s `canonical()` (fifteen lines that decide re-reconciliation). The rest
  are thin or type-only and are exercised through their importers.
- **T-12 · Three tests pin implementation rather than behaviour.** `device-transactions.test.ts:427`
  writes the private `appliedSeq`; `:504` deletes `reconcileFlows` off the runtime to pin duck-typing;
  `schedule-runtime.test.ts:103,110,487,590-591` read `request.mapped/.fingerprint/.existing` through
  `any` although `SyncRequest` is exported. Also `schedule-overlap.test.ts:377-579` and
  `circadian-runtime.test.ts:892` cast `diagnostics() as any` although the fields are declared: casts to
  delete.
- **T-13 · Repo-policing tests: keep all but two as tests.** `module-surface.test.ts` (dead exports) is
  a source scan in `node --test` and belongs in CI as a `knip` step (its header argues against an
  eslint plugin, not against CI); `probe-shared-helpers.test.ts` is deleted by T-10. Every other one
  guards a named shipped bug that neither eslint nor the CLI can see (inline `<script>` in HTML, a
  wrong `#ROOT` substitution, `unknown_error_getting_file` on Repair, the four-file version).

### 5c. Documentation drift

Phrases predating the fourth and fifth device types, all CONFIRMED by grep:

1. `lib/devices/device-lifecycle.ts:10-12` — "The three device types … three copies of one file"
2. `CONTRIBUTING.md:60` — "the four virtual device types"
3. `drivers/controller/device.ts:12`, `drivers/curve/device.ts:9`, `drivers/schedule/device.ts:9` — "the other two device types"
4. `scripts/verify-hardware.mjs:72`, `:130`, `:3909` — "the four device pictures", "the two drivers … and the two that must never" (heads a three-element list), T3 prints "lists four types" in every report
5. `drivers/*/pair/targets.html:181` (ten generated copies) — "One shared file serves all four drivers"; five carry it
6. `scripts/pair-view-fixtures.mjs:112` — "shared by four drivers"
7. `lib/runtime/runtime-registry.ts:6,27`; `test/unit/runtime-registry.test.ts:9,12` — "all three runtime managers"
8. `lib/outputs/target-snapshot.ts:9,114` — "All three runtimes"
9. `docs/hardware-test-plan.md:267` — "all four devices came back available" (`pair` builds five)
10. `docs/homey-platform.md:1046` — "all three drivers that declare a `capabilitiesOptions` block"; four do
11. `lib/daylight/daylight-runtime-manager.ts:14` — "the fifth of these"; four managers exist
12. CLAUDE.md's Layout omits `docs/commands.md`, which `docs/README.md:19` calls "every command in one place"; `docs/README.md:49-50` says "nine phase files … all eight phases"

CLAUDE.md claims checked and found accurate: `escapeHtml()` only in `curve.html`/`schedule.html`; the
26-view count (13 pair + 13 repair, card in 4 + 4); `release-metadata.test.ts`'s four checks;
`docs/README.md`'s index complete both ways.

### 5d. From the survey (1439 tests, 14 s, all green at HEAD)

- **No shared fake Homey.** `test/support/` holds five small seams (a fake DOM harness, fake timers,
  two catalogue helpers, `deferred()`, a failing-nth helper). Every large behaviour test builds its own
  rig inline: `circadian-runtime.test.ts` (~250-line preamble), `api-orphans` (~177), `daylight-runtime`
  (~136), `device-transactions` (~160), `api-trying` (~108), `schedule-runtime` (~99), `pair-session`
  (~88), `flow-bridge-lifecycle` (~80). Two different `homey()` fakes exist for the same `api.ts`.
  `fake-timers.ts` is used by only three files; everything else rolls its own clock.
- **Eleven importable source files have no test importing them**, including three of the four runtime
  managers (`schedule-`, `circadian-`, `daylight-runtime-manager.ts`), `lib/pairing/sensor-picker.ts`
  (the one un-tested pairing decision module), `lib/runtime/visible-state.ts` and
  `lib/runtime/reconcile-failure.ts`.
- **About 13 % of tests police the repo rather than the product** (15 files, 192 tests: locale parity,
  view drift, asset geometry, source scans). Each names a shipped bug in its header; the cost is that the
  suite reads as much like a linter as a test suite.
- **`scripts/verify-hardware.mjs` (4114 lines) and `scripts/probe-lights.mjs` (4790 lines)** are the two
  largest files in the repo, share copied primitives held identical by `probe-shared-helpers.test.ts`,
  and that test's own comment at line 112 names the deferred fix: extract `scripts/homey-client.mjs`.
- **The hardware script's safety model is consistent end to end** (verified: the `[verify]` marker is
  re-checked at every delete, every write-capable command is behind `--yes` with its effects printed,
  `pairspike` is never in `full`, and `probe-lights.mjs` has one write site gated on
  `WRITE_PHASES ∧ --yes` with `--all` typed, never defaulted). Only its description in CLAUDE.md
  overstates it (T-2).

---

## 6. What to leave alone

Verified in this session and worth stating so nobody "tidies" it:

- `stop()` vs `destroy()` on the runtimes: app shutdown (`destroyAll`) keeps every Flow, device deletion
  removes only the device's own. The property holds (see M-1 for the ordering nit, not the property).
- `KeyedMutex` and `SingleFlight` (`lib/support/keyed-mutex.ts`): both correct as written, including
  the trailing re-run's error path and the "whoever asked last" closure.
- `CommandScheduler`: `WRITE_ORDER` with `onoff:false` moved last, leading-edge flush, completion
  promises that always settle (including on `stop()`), bounded `drain()`.
- `CredentialService`: candidate never disturbs the incumbent; generation guard; one handshake per key;
  `getWriteClient` clears its memo on failure.
- `HomeyApiService.read()`: memo cleared on failure; `reportReadFailure` is narrow and is wired at the
  four read sites (bridge manager, device catalog, card catalogue, target adapter). H-2 is about what is
  NOT re-armed after it fires, not about the predicate.
- Reconcile coalescing (`flow-bridge-manager.ts:296-312` with `SingleFlight`), including the
  "whoever asked last" closure: the boot storm and the repair-during-fan-out cases were traced and are
  pinned by `flow-bridge-concurrency.test.ts`.
- The orphan sweep's three refusals, `looksGenerated()` and `LIGHTKEEPER_DEVICE_ID`: hand-typed ids,
  empty `event_key`, a second action, an empty `controller` argument, stale tokens and ids outside the
  preview were all tried; every path is covered by `flow-bridge-sweep`, `api-orphans` and
  `safety-promises`.
- The creation journal and `compensate()` (`:470-668`): partial-pass rollback, reused Flows never
  compensated, a failed compensation keeping the original error. All tested. **Corrected in Part B
  (B1.4):** this holds for the pass's own creations but not for a REPLACEMENT whose old Flow is deleted
  inside the loop — `LAUNCH_REVIEW.md`'s R7 is confirmed, and the S2 tree's `FlowJournal` is the start
  of the fix.
- Key hygiene end to end: acquisition inside `withWriteClient`'s boundary, `sanitizedWriteError`,
  `redactedMessage` on every write-path log line, `diagnostics-redaction.test.ts` on serialised output.
- `bridge-event-intake.ts` and both `dispatchWithReason` implementations: fail closed on either missing
  half, route by key shape, drop non-finite magnitude, re-check catalogue membership and mapping.
- `FlowCardCatalogue`: `NO_CACHE` on every `getAll`, projection inside the fetch, the in-flight promise
  retracted on failure, the by-name card path with enumeration as fallback.
- `LightTargetAdapter.noteWriteHealth` (`:276-318`): the `light_mode` two-way exclusion and the
  `!ok && preStage` one-way exclusion are exactly what §6 measured; `target-write-health.test.ts` pins
  every edge.
- `TargetStateCache.noteEcho`/`commitDesired` with the write sequence (`:280-324`): echo before
  dispatch, commit only on success, the sequence check, all in `write-path-safety.test.ts:113-160`.
- The daylight `aim`/`committed` split (`daylight-runtime.ts:165-194`). The constants' ordering
  (deadband < step) is enforced indirectly: `daylight-runtime.test.ts:432-459` would fail if step ≤
  band. Add a one-line comment on that test naming the invariant rather than exporting the constants.
- `applyNow`'s marked-wider-than-armed pair of loops (`circadian-runtime.ts:755-823`), both halves of
  the §6 pre-stage promise.
- `RampEngine` and the 10 s stop: one `start()` call site, hard stop checked before emit, restart
  resets the clock, idempotent `stop()`, `stopAll` on shutdown and target loss, all pinned by
  `ramp-engine.test.ts:99-180`. H-7 is in the caller, not here.
- `SupersedeGate`: press-then-hold inside the window drops the press and fires the hold once; a hold
  never creates a timer, so nothing leaks.
- The dedupe chain from normaliser to `resolve()`: no path found where a duplicated gesture survives.
- `local-clock.ts`: weekday and minute come from one `formatToParts` call, so they cannot disagree
  across midnight; it never converts a wall time to an instant, so the "DST stays out" claim holds for
  the reader too.
- `solar-elevation.ts` and `daylight-response.ts` as pure modules with textbook-anchored tests.
- All five migration steps: version-gated, spread-after-default, non-throwing on junk.
- **The schedule semantics hold under attack.** A 23:30-for-two-hours Friday window arriving Saturday
  01:30 is accepted (`crossesMidnight` → previous weekday); an `end` past 24 h is impossible on all
  three write paths; two windows touching at 22:00 leave the room on in either arrival order; DST is
  wall-clock throughout; catch-up applies only a containing window, latest-started first, and refuses
  without a trusted off Flow, on an unresolved zone, while paused, or with untrustworthy Flows, each
  refusal in diagnostics and each tested. Every reconcile verdict flips `flowsHealthy`, so the schedule
  does NOT have the controller's H-4.
- Time-card discovery: the ranking cannot let an unknown same-shape card win (7 vs at most 3), ties
  are refused, and `variantKey` carries the only trigger-side variable.
- Pairing mechanics: `validateTargetAgainstCatalog` does membership and dedupe; `dedupeByInputKey`
  first-wins; the ephemeral preview runtimes are stopped in `finally` including on the throwing path.
- The `platform §n` comments and the safety-property list in CLAUDE.md. They are the reason this review
  could tell deliberate from accidental.

---

## 7. What the peer session's work already covers

While this review ran, the other session committed `875b06c` ("Fix runtime lifecycle, sensor ownership
and write cancellation", version 0.6.1: sensor retain for the runtime lifetime, sensor subscription
recovery with back-off, cancelling queued brightness writes when a lamp goes off or leaves its zone,
releasing resources on a failed start, restoring the previous plan when a persist fails, and shared
start/teardown helpers in `lib/runtime/runtime-resources.ts`) and merged it to `main` as `b2ebfd3`.
A further 21 files are uncommitted on top of that (api.ts, the four daylight-carrying pair views and
their repair copies, `lib/app-contract.ts`, `circadian-runtime.ts`, `daylight-runtime.ts`,
`light-target-adapter.ts`, `target-state-cache.ts`, `bounded-log.ts`, `locales/en.json`, a new
`lib/runtime/control-diagnostics.ts` with its test). That set is in flight and was not analysed.

Every finding above was re-checked against the COMMITTED `main` (`b2ebfd3`) by reading the blobs, not
the working copy:

| Finding | At `b2ebfd3` |
|---|---|
| H-1 same-key handshake guard | present (`credential-service.ts:312` unchanged) |
| H-2 subscriptions stranded on a rebuilt read client | present (no re-arm hook exists) |
| H-3 tick runtimes never re-assess health | present (callers unchanged: circadian `:440`, `:1468`; daylight `:225`, `:666`) |
| H-4 controller health overwrites reconcile verdict | present (`controller-runtime.ts:225-232` unchanged) |
| H-5 power-on report read as override | present (`lastWritten.delete` at `:571`, no re-arm at the on edge) |
| H-6 `Number(null)` on the capability axes | present (`:595`, `:621`; daylight `:330`; `liveValuesOf` casts unchanged) |
| H-7 per-rule hold ramps the whole set | present (`:393`, `:598`) |
| H-8 re-attach may pick the other identical remote | present (`health-monitor.ts` untouched) |
| M-0 `apply()` runs no validator | present |
| M-1 `deleted()` stops twice, dispatchable in between | present (`:444-445`) |
| **M-2 two-key persist race** | **addressed.** `875b06c` adds an `applying` flag that suppresses verdicts during an apply, a `planGeneration` gate on every verdict, and a `store` mutex key for the plan writes. The window this finding describes is closed; drop it. |
| M-3 folder root recreated on delete paths | present (`:793`, `:829`) |
| M-4 moved-card forgiveness covers id only | present |
| M-5 fingerprint watches three of six capabilities | present |
| M-6 `probePreStage` bare timer | present (`:1351`) |
| **M-7 luminance owner map outside the lock** | **re-verify.** `luminance-source.ts` was largely rewritten by `875b06c` (recovery with back-off, `SensorClaim`); the finding was made against the old file. |
| M-8, M-9 planner floor and synchronised nudge | present (`intent-planner.ts:212`, `:223`) |
| M-10 newer-schema quarantine text | present (`:271` still maps only `ValidationError`) |
| M-11 unbounded range expansion | present |
| M-12 boundary validated on day, not clock | present (`schedule-runtime.ts:554-577`) |
| M-13 no sensor membership check | present (`pair-session.ts`, `pairing-dto.ts` untouched) |
| L-1 `isNotFound` regex, L-2 `.gitattributes` | present (neither file touched) |
| L-17 `flowsHealthy = true` before sync resolves | present (`:334`) |
| Simplifications S-1 … S-15 | unchanged in substance; `runtime-resources.ts` now holds a `startRuntime`/`cleanupResources`/`RuntimeLifetime`/`SensorClaim` set that S-6 and S-7 should build on rather than beside |

Two things follow. First, the peer's `runtime-lifecycle-safety.test.ts` (233 lines) and its "fake Homey
boundaries" are the beginning of exactly the shared test rig T-9 in section 5 asks for; that proposal
should extend it rather than add a third rig. Second, the uncommitted files overlap H-3, H-5, H-6, L-4
and M-5 by file (`circadian-runtime.ts`, `daylight-runtime.ts`, `light-target-adapter.ts`,
`target-state-cache.ts`, `api.ts`), so those fixes should be sequenced with whoever holds that working
copy.

---

## 8. Suggested order of work

Each step is a commit or two, ships its own test, and leaves the suite green. Steps 1 to 3 are the
correctness work; 4 onwards is the simplification work and should not start until 1 to 3 have landed,
because S-7 and S-8 are shaped by the fixes in 2 and 3.

1. **One-liners with a test each (half a day).** H-1 (generation guard), L-1 (`isNotFound`), L-2
   (`.gitattributes`), M-6 (`stopped` flag in `probePreStage`), M-10 (`MigrationError` kind), M-11
   (range ceiling before expansion), L-5, L-6, L-8, the three dead `setDaylight` copies and the
   duplicated timezone closure (L-4). Of these, only M-6 (the two runtimes) and L-4 (`app.ts`) touch a
   file the peer's uncommitted set holds; sequence those two.
2. **Verdict composition (one to two days).** H-4 first: keep the reconcile verdict as a field and rank
   in one function; then H-3: re-assess in `tick()` on a change of the unwritable set or the daylight
   source. Then S-8 (extract the controller's flow sync) since it touches the same lines. Hardware line:
   cut one lamp at the wall, edit one Flow, confirm the tile says repair and stays saying it.
3. **Override detection and the null guards (one day).** H-6 (`asFiniteNumber`, `liveValuesOf`) is safe
   to land immediately. H-5 needs the hardware question answered first (does the Hue app report
   `dim`/`light_temperature` with `onoff:true` on power-on, and in which order); land the `touchedAt`
   anchor either way, since it is correct under both answers. M-5 (widen the fingerprint) and M-8/M-9
   (planner floor and synchronised nudge) go here too. Then H-7 (ramp target spec) and H-8
   (`sourcesInUse` filter, ambiguous-candidate detail) as two separate commits with their own tests.
4. **M-0 in the lifecycle.** Give `DeviceOwner` a `validate` (or make each chain's validator reachable)
   and call it in `apply()` after `prepareApply`. Covers all five device types and closes the route.
   H-2 is a design change (rebuild hook plus re-subscribe) and needs the hardware answer about socket
   reconnection first; schedule it as its own piece with a `hardware-test-plan.md` line.
5. **Structural splits, in this order:** the dead `setDaylight` copies (part of step 1), S-6 (ticking
   registry, low risk), S-15 and S-1's first two cuts (pure moves out of the schedule runtime and the
   bridge manager), S-5 (pre-stage guard and written record out of `circadian-runtime.ts`), S-14 (the
   driver shell and recipe, which needs the hardware pair pass so it belongs in a release), then S-7
   (the shared target-set core and override tracker, which by now has three fixed bugs as its
   motivation). S-2 (type the flow seam) rides along with S-1. S-9, S-10, S-12 are small and can go
   anywhere. M-12 and M-13 are one commit each and fit here or in step 3.
6. **Tests, scripts and docs (section 5).** T-1 (`npm audit` in CI) and T-3 (tighten the escape
   check) first, since each closes a gap CI would otherwise let through. Then T-9 (one shared fake
   Homey, seeded from the peer's `runtime-lifecycle-safety.test.ts`) before S-7, so the two runtimes'
   tests are on one rig when their shared core lands. T-10 (`homey-client.mjs`) with a `spike` run. The
   documentation drift in 5c and T-2/T-6/T-7/T-8 are a single doc-only commit.

## 9. Verification

For every step: `npm test`, `npm run typecheck`, `npm run typecheck:test`, `npm run lint`,
`npm run sync:views:check`, and `npm run validate` before a release commit. Anything in steps 2 to 5
touches a runtime or a write path, so the release that carries it runs `node scripts/verify-hardware.mjs
full --yes` on the reference Homey per CLAUDE.md's checklist, plus the three hardware questions this
review could not settle from code: power-on capability event order on Hue (H-5), whether `homey-api`'s
socket reconnects on its own after a transport failure (H-2), and what a `decimals: 1` lamp does with
`dim 0.01` (M-8). Each finding above names the unit test it needs; the test count assertions in
`release-metadata.test.ts` will need the new totals.

---
---

# Part B — Additions, 9 September: the launch review and two unfinished implementations

Everything in Part A reviewed the committed `main`. Since then the working tree has filled with the
uncommitted output of three other agent sessions, two of which stopped mid-way when their credits ran
out. This part reviews that work, folds `LAUNCH_REVIEW.md` into the plan, and says how to finish and
land each stream. Nothing here was changed; the tree was read as it stood on 9 September.

## B0. State of the working tree

HEAD is `b2ebfd3` on `main`. Uncommitted: 59 modified files (+1195/−400) and 10 new files (1138 lines).
They belong to THREE streams, none committed, none complete:

| Stream | What it is | Files (representative) | State |
|---|---|---|---|
| **S1 · Diagnostics history and override fixes** | Per-runtime bounded history of control passes and power/override events (`lib/runtime/control-diagnostics.ts`, new), the fix for Part A's H-5 and most of H-6, diagnostics semantics labels, and a "feedback risk" warning on the four daylight screens | `control-diagnostics.ts` + test, `circadian-runtime.ts` (+147), `daylight-runtime.ts` (+114), `target-state-cache.ts` (+65), `bounded-log.ts`, `api.ts`/`app-contract.ts` (diagnostics fields), the four daylight-carrying views + `views/shared/daylight-card.js`, `settings/index.html`, `locales/en.json`, two runtime tests (+86) | Code and tests present; suite green for it |
| **S2 · Launch-review hardening** | Partial implementation of `LAUNCH_REVIEW.md`'s R1–R12 | `homey-api-service.ts` (+34), `device-catalog.ts`, `pair-session.ts`, `controller-runtime.ts`, `controller-runtime-manager.ts`, `ramp-engine.ts`, `credential-service.ts` (+16), `light-target-adapter.ts` (part of +67), `flow-bridge-manager.ts` (+108), `app.ts` (`maintain()` loop), two new stubs `lib/outputs/test-outcome.ts`, `lib/outputs/write-coordinator.ts` | Code only, **no new tests**; two genuine test failures trace here (B0.2) |
| **S3 · Evidence recorder** | Opt-in seven-day encrypted recording on Homey with export and analysis | `lib/support/evidence-recorder.ts` (260, new), `evidence-sampler.ts` (41), `scripts/evidence.mjs` (143), `test/unit/evidence-recorder.test.ts` (209), `docs/week-long-testing.md` (101), wiring in `app.ts`/`api.ts`/`app-contract.ts`/`settings/index.html`/`locales`, six routes in `.homeycompose/app.json`, `docs/privacy.md`, `.gitignore`, `.homeyignore`, `CHANGELOG.md`/`FAQ.md` | Feature complete against its own document; finalisation and a Homey smoke test outstanding (B3) |

Cross-stream coupling: S1's `ControlHistory` takes an `EvidenceSink` whose TYPE is exported from S3's
`evidence-recorder.ts`, and three S1/S3 files import it. So S1 cannot be committed without S3's type,
or S1 must define `type EvidenceSink = (type: string, data: unknown) => void` itself (one line; do that,
it removes the dependency in the wrong direction).

**B0.1 · Checks on the tree as it stands.** `npm run typecheck`, `typecheck:test`, `lint` and
`sync:views:check` all pass. `npm test`: **1486 tests, 1480 pass, 4 fail, 2 cancelled** (the two
cancellations are hangs).

**B0.2 · Attribution of the six.**
- `pair-view-styles.test.ts` ×3 ("`stabiliseScrollbar()`/`node()`/`clear()` identical everywhere"):
  a LINE-ENDING artefact, not a logic change. The agent behind S2 wrote CRLF into 28 tracked files
  (git warns "CRLF will be replaced by LF" on each, including every `targets.html`, `app.ts` and most of
  `lib/`), so a helper in `circadian/targets.html` no longer byte-matches the same helper in
  `ends.html`. `.gitattributes` normalises on commit, but the working copy has to be renormalised before
  any test result on it means anything: `git add --renormalize .` (stages LF content) followed by
  `git stash && git stash pop` (re-checks the files out as LF). This is Part A's L-2 biting a third time,
  and the reason to land L-2's one-line `.gitattributes` fix first.
- `flow-bridge-concurrency.test.ts` ×1 ("adoption avoids duplicates when the second read sees an
  unpersisted Flow", expected 2, actual 1): S2's `flow-bridge-manager.ts` edits (R6/R7). Diagnosis in
  B1.
- `runtime-lifecycle-safety.test.ts` ×2 (hangs: "a power-off during asynchronous handle acquisition
  prevents dispatch", "cleanup continues after failures and preserves the startup error"): this test
  was committed green in `875b06c`; S2's adapter or API-service edits broke it. Diagnosis in B1.

**B0.3 · Landing order.** Do not commit the tree as one blob. S1 first (self-contained, tested, and it
closes two Part A high findings), S3 second (complete, tested, needs its smoke test), S2 last and in
pieces (least finished, no tests, two regressions, one design decision to reverse — B1.3). Renormalise
line endings as the very first step.

## B1. `LAUNCH_REVIEW.md` — the twelve findings, cross-referenced and verified

`LAUNCH_REVIEW.md` (202 lines, another agent, written against `b2ebfd3` plus the then-uncommitted tree)
lists seven P1 and five P2 findings and recommends fixing the P1s before a public launch. Every one of
the twelve was re-verified against the COMMITTED `b2ebfd3` by reading the blobs: **all twelve are
CONFIRMED.** Eight of them Part A did not find (R1, R2, R4, R6, R7, R8, R9, R10), and R7 contradicts a
mechanism Part A cleared; the corrections are in B1.4. The other four are Part A's H-7 (R3), H-2 (R5),
H-3 + H-4 (R11) and a sibling of H-1 (R12).

**B1.1 · The table.** "Working tree" is the state of S2's uncommitted implementation.

| R | P | Part A | Baseline | Working tree | Test? | Remaining |
|---|---|---|---|---|---|---|
| R1 · a room includes appliances | P1 | new | CONFIRMED: `lightsInZone()` (`device-catalog.ts:184`) filters on `onoff` only | FIXED: `DeviceCatalog.isLightClass(d)` added to the zone predicate | yes (`device-catalog-lights.test.ts:93` flipped) | Why-comment on `lightsInZone` (the docblock above `lightCandidates` still says "onoff is the whole rule"); check README/FAQ for the old room rule. **This reverses a deliberate design decision — confirm it is wanted.** |
| R2 · a hold mapping has no release path | P1 | new | CONFIRMED: `canRamp()` checks the catalogue; reconcile builds Flows for mapped keys only; dispatch rejects unmapped release | FIXED, no test: `heldControls` adds release/rotate_stop of mapped holds to `mapped`; manager accepts `isStopDependency` | no | Extract one `stopDependenciesOf(catalogue, mappedKeys)` beside `canRamp` (the predicate is duplicated in `controller-runtime.ts:462` and `controller-runtime-manager.ts:188`). Test: Hold→Brighter only → sync request includes the release key, `dispatchWithReason(release)` accepted, `isRamping` false after. |
| R3 · per-light hold ramps everything | P1 | **H-7** | CONFIRMED | FIXED, no test: `ActiveRamp.targetIds?` carried, tick intersects with current targets | no | Make `targetIds` REQUIRED in `RampEngine.start`: `(ramp.targetIds ?? [])` means "unspecified = write nothing", an inverted default. Test per Part A H-7. |
| R4 · clearing the selection keeps the old one | P1 | new | CONFIRMED: validate-before-assign at `pair-session.ts:179`, view swallows the rejection | PARTIAL: `state.target = undefined` before validation plus a `selectionRevision` guard (all ten `targets.html` copies consistent). Missing: the empty case now shows `targets.loadFailed` ("Check that Homey is reachable"), nothing blocks Next, `buildPlan()`'s handling of `undefined` unverified per driver | no | Add `targets.noneSelected`; a `requireTarget(state)` used by save and preview handlers; tests: select A, deselect, save rejects; two overlapping selections with the first resolving late → second wins. `npm run sync:views` after editing the controller copy. |
| R5 · rebuilt read client strands subscribers | P1 | **H-2** | CONFIRMED | FIXED, no test: `onReadReplacement` listeners; catalogue, adapter (`resume()`) and luminance rebind; old client destroyed; superseded in-flight connect discarded (this also closes Part A's L-5) | no | Tests: service (read → `reportReadFailure(ECONNRESET)` → read → listener fired once, old client destroyed), catalogue (`device.create` on the replacement invalidates), adapter (handles cleared and re-subscribed), counts back to baseline after two cycles. Document that the generation bump cancels in-flight writes on the dead client. Hardware: Part A's H-2 line. |
| R6 · failed replacement delete → untracked duplicate | P1 | new | CONFIRMED: `:548-560` pushes to `staleReplacements` but not to `references`; the old Flow goes live and unreferenced, invisible to the sweep | PARTIAL: a `FlowJournal { references, cleanup, staged }` persisted in `homey.settings` (passed in from `app.ts:196`), pending cleanup retried each pass, controller reports `state.flowCleanup` | no | See R7. |
| R7 · rollback removes working automation | P1 | new; **contradicts Part A §6** | CONFIRMED: create at `:531`, delete old at `:548` inside the loop, `compensate()` at `:625` deletes the replacement too | PARTIAL: deletes deferred until the whole set is created and journalled. Gaps: journal never cleared in `removeAll` (settings accumulate per deleted device); `this.journals` is a shared mutable object per owner, so two unserialised `sync()` calls can delete each other's `staged` Flows; any undeletable staged id fails the whole reconcile; the new "adopt unreferenced template" scan is untested; the retimed-schedule why-comment was deleted; the schedule runtime does not surface `flowCleanup` | no | New `flow-bridge-journal.test.ts`: fail the superseded delete → next pass retries and reports; fail the 2nd of 2 creates → A and B still live, no duplicates; a new manager over the same store converges after "restart"; `removeAll` clears the journal. Restore the deleted comment. Decide the journal's home (device store vs `homey.settings`). |
| R8 · saturation failure recorded as success | P2 | new | CONFIRMED: `noteColorWritten()` commits the pair on hue success | FIXED, no test: looks up the saturation outcome in the same batch, drops `lastColorWritten` otherwise so `colorHasMoved()` retries. `pendingColor` is now dead (set, deleted, never read) | no | Remove `pendingColor` and its docblock. Test: reject saturation once → next tick re-attempts without a curve change; interleave two batches. |
| R9 · 65 targets → the 65th dropped | P2 | new | CONFIRMED: `DEFAULT_MAX_QUEUED_DEVICES = 64` vs `MAX_TARGET_DEVICES = 256`, zones uncapped; Part A's own read of `queueFor()` agrees | PARTIAL: default raised to 256; `TargetResolver.resolve` throws above 256 with an English string in `lib/` (translation convention) and on runtime refresh rather than at pairing; `WriteCoordinator` (shared semaphore of 8) added; `dropped_capacity` still discarded | no | Move the cap to `validateTargetAgainstCatalog` and the zone summary with a locale key; log `dropped_capacity`. Tests: 256 succeed and the 257th is dropped; a zone over 256 is refused at pairing. |
| R10 · setup tests report planned commands as lit lights | P2 | new | CONFIRMED: `runIntent` returns `writes.length`; schedule and pair-session preview likewise | FIXED, no test, for all four runtimes via `acceptedTargets()`. Issues: English error text in `lib/`; the wait is keyed on `reason === 'preview'` — **this is what hangs the two lifecycle tests** (B1.2); the summary is one number plus a throw | no | Replace the reason-string switch with an explicit `{ waitForResults: true }` from `previewNow`; return `{ accepted, failed, cancelled }` and translate in the device layer. Test `test-outcome`: 3 writes / 1 lamp / 1 failed → error; all fail → error. |
| R11 · health depends on unrelated target changes | P2 | **H-3, H-4** | CONFIRMED | PARTIAL: `assessHealth()` now runs on an unchanged fingerprint and adopts `ready` when `scheduler && !flowProblem`; `flowProblem` set from the sync result; `HealthMonitor` adds `source.available`. **H-4 is still open**: `flowProblem` is one boolean and a `partial` verdict still overwrites `flowEdited`. Write-failure streaks still do not trigger re-assessment (H-3 for the tick runtimes). A periodic pass exists — as `maintain()` in `app.ts`, see B1.3 | no | Part A's H-4 ranked verdict function and H-3 re-assess-on-change; move the periodic pass into the manager on the registry's `Timers`, bounded and cheap (B1.3). Tests: delete only the remote → `needs_repair`; unwritable target recovers → `ready`; `flowEdited` survives target recovery. |
| R12 · an in-flight save undoes Remove key | P2 | sibling of **H-1** | CONFIRMED | FIXED, no test: `++this.generation` at save START compared after validation; `revision` threaded through `withWriteClient`; Part A's H-1 guard (`superseded(generation, token)` in `getWriteClient`) is in the same hunk. **Concern:** bumping at the start of EVERY save, including one about to be rejected, supersedes the active key's in-flight handshake — contradicting the `:246` docblock ("a rejected candidate… nothing else moves"). Superseded candidate clients are not destroyed (platform §2) | no | Snapshot the generation at invocation and bump only on commit; `client.destroy?.()` for superseded candidates. Tests in `credential-atomicity.test.ts`: clear during validation stays cleared; a later save wins; a late old-client result is ignored; a REJECTED candidate does not disturb an in-flight handshake for the incumbent. |

**B1.2 · The two genuine test failures, diagnosed.**
- `flow-bridge-concurrency` "adoption avoids duplicates…": the new adoption scan in `sync()`
  (`flow-bridge-manager.ts:578-583`) reads the harness's SHARED mutable `live` object, so the second
  pass sees the first pass's creation and adopts it; the agent renamed the test but left
  `assert.equal(…, 2)` — a half-edit. Adoption itself is defensible (the committed comment near
  `controller-runtime.ts:492` already claimed "adopt-or-recreate", which did not exist), but the
  shared in-memory `journals` entry makes unserialised passes actively harmful. Restore the original
  title and assertion, make the fake snapshot its return (`{ ...live }`), and add a separate adoption
  test with `existing: []` and a pre-existing live template.
- `runtime-lifecycle-safety` test 13 (and 14 as collateral): `DaylightRuntime.applyNow('preview', …)`
  (`daylight-runtime.ts:499-501`) now awaits `scheduler.drain()` and the batch completion because the
  reason string is `'preview'`; the write's device handle awaits the test's gate, which the test releases
  only after `applyNow` returns. Deadlock. The R10 fix (an explicit `waitForResults` option) leaves the
  test passing unchanged.

**B1.3 · A design decision to reverse: `maintain()` in `app.ts`.** S2 added a 60-second interval
(`app.ts:351-376`) that, for every runtime, calls `api.read()`, `refreshTargets()` and `assessHealth()`,
and for every controller and schedule `reconcileFlows()`. Costs, verified against the code: a
controller's `assessHealth()` → `HealthMonitor.assess()` → `discovery.discover(source)` → the trigger-
card catalogue, whose TTL is 60 s, so the ~11.6 MB catalogue (platform §15) is re-fetched and re-parsed
about once a minute for as long as the app runs; each `reconcileFlows()` is a `getFlows(NO_CACHE)` of
the whole Flow list plus a folder read, per device per minute. That turns an event-driven app into a
poller and undoes §15's reasoning ("the app otherwise only talks to Homey when something happens"). It
also lives in `app.ts`, which no test can import (platform §13), and it is the loop the evidence
recorder's document promises does not exist (B3.6). Keep the idea — a bounded recovery pass is what R11
asks for — but: put it in the managers on the registry's `Timers`; trigger it from state (a recorded
`flowProblem`, a failed subscription, a dropped read client) rather than the clock; if a clock is wanted
at all, make it hourly and exclude `discover()`; never re-read the card catalogue on a timer.

**B1.4 · Corrections to Part A.** Part A's section 6 cleared "the creation journal and `compensate()`
… partial-pass rollback, reused Flows never compensated". R7 shows that clearance was too narrow: the
journal protects THIS pass's creations, but the old Flow of a replacement is deleted inside the loop,
so compensation removes the replacement of a Flow that is already gone. Part A also did not test a
room's membership rule (R1), the release-event dependency of a hold (R2), the empty-selection path (R4),
the saturation half of a colour write (R8), the scheduler's device cap against the picker's (R9) or the
preview count contract (R10). Statuses that change: H-1 and H-7 are fixed in S2 (no tests); H-2 is
fixed in S2 (no tests, hardware still owed); H-5 is fixed in S1 with tests; H-6 is half fixed in S1;
H-3 and H-4 remain open; L-5 is closed by R5's edit.

**B1.5 · The review's maintainability items, against what exists.** (1) a shared target boundary —
started as `WriteCoordinator`; pairing-time conflict detection between Lightkeeper devices is
genuinely new and worth doing. (2) reconciliation as a state machine — started as `FlowJournal`;
Part A's S-1 split is the place it should live. (3) unified command outcomes — `WriteOutcome[]`,
the `WriteRecord` sink and `unwritableTargets()` exist; a device-level summary type is the new piece
(R10). (4) cross-boundary tests — `runtime-lifecycle-safety.test.ts` is already the pattern for the
tick runtimes; nothing calls `dispatchWithReason` from a test, so configuration → compilation →
dispatch is genuinely uncovered. (5) a typed shell — `lib/app-contract.ts` exists; `lightkeeper-device.ts:64
get app(): any` remains. (6) shorter comments — Part A disagrees in general (the density is what made
this review possible) and agrees in particular: comments that claim a safeguard the code lacks
(R4, R8) must go or become true. Of the compatibility bullets: the capability fingerprint (Part A's
M-5) is widened in the S2 tree, untested; the circadian clock now fails closed like schedules
(`localNowResolved`), untested; the privacy notice still says "four" device types at `docs/privacy.md:49`
despite S3's edits to the same file.

## B2. Finishing S2 — the launch-review implementation

In this order, each its own commit with its own test:
1. Renormalise line endings (B0.2) and land Part A's L-2.
2. Unbreak the two regressions (B1.2): the `waitForResults` option; restore the concurrency test and
   add the adoption test.
3. Remove `maintain()` from `app.ts` (B1.3) and re-add the bounded recovery pass in the managers.
4. R1 comment and design confirmation; R3 required `targetIds`; R8 dead `pendingColor`; R12 generation
   at commit plus candidate disposal. Tests for each. Small, mechanical.
5. R2 `stopDependenciesOf()` and its test; R4 `requireTarget` + `targets.noneSelected` + tests +
   `sync:views`.
6. R5 tests (service, catalogue, adapter) and the hardware line.
7. R6/R7: journal home decision, `removeAll` clears it, per-owner serialisation, undeletable staged ids
   tolerated, the deleted why-comment restored, `flow-bridge-journal.test.ts`. This is the riskiest
   piece; consider doing it together with Part A's S-1 split so the journal has a file of its own.
8. R9 cap at pairing with a locale key; R10 typed outcome summary translated in the device layer.
9. R11 together with Part A's H-3/H-4.
10. Restore comment density across the hunks; `WriteCoordinator` header saying its value is
    cross-runtime only; decide whether `test-outcome.ts` is a seam or folds into the adapter.
11. Hardware pass (`verify-hardware.mjs full --yes`) — every step above touches a runtime or a write path.

## B3. Finishing S3 — the evidence recorder

**What exists, verified.** One NDJSON record shape `{ schema, runId, bootId, sequence, recordedAt,
type, data }`; every record passes a field stripper (`^(apiKey|key|token|secret|authorization|password)$`)
and `redactKeyMaterial()`; sixteen record types are emitted from the shared write sink, the two tick
runtimes' `ControlHistory`, the lux service, bridge intake, the sampler and the recorder itself.
Storage is `/userdata/lightkeeper-evidence/<uuid>.enc`, created `wx 0o600`, each ≤48 KiB batch gzip →
AES-256-GCM with a random key held in `homey.settings['evidenceRecordingV1']`, flushed every 15 s
from `app.ts` with `fsync` before the committed length is saved. Limits (512 KiB pending, 32 KiB
record, 64 MiB archive), the seven-day deadline across restarts, tail truncation on restart, six
authenticated API routes (declared and implemented, names match), settings-page Start/Stop/Refresh/
observation, and `scripts/evidence.mjs start|stop|status|export|note|clear|analyze` are all present.
Cost when OFF: one object literal per event and one `status()` per 15 s; no `await` was added to any
hot path. Memory when ON is bounded below about 2 MiB. Nine recorder tests plus the settings-page test
cover the claims in `docs/week-long-testing.md`; every line of that document holds except two noted
below. Key hygiene holds end to end (the archive key would itself be caught by the 20-hex redactor).

**B3.1 · Code fixes (all small).**
1. `lib/support/evidence-recorder.ts:6` imports `redactKeyMaterial` from `../credential-service`;
   `homey-errors.ts:122-124` says `support/` must not depend on a service module. Import from
   `./homey-errors`.
2. Idle flush saves the manifest every 15 s even when nothing changed (`:186`): about 40,000
   `homey.settings.set` calls per week for a no-op. Save only when `bytes` or `state` changed.
3. `close()` (`:209-212`) can lose the `app_shutdown` record if a flush is mid-flight: `await
   this.flushing; await this.flush()`.
4. `scripts/evidence.mjs:142` `main().catch` swallows the real error; print
   `redactKeyMaterial(message)` so a 404 (route missing), a 401 or an `EEXIST` is distinguishable
   during the smoke test.
5. Optional: take a `timers?: Partial<Timers>` dep so a test can drive the 15 s/60 s cadence; today
   the interval lives in `app.ts`, which no test can import.

**B3.2 · Settings page.** Add a Clear button enabled when state is not `idle`/`recording` (today only
`evidence.mjs clear` can reset an `error`/`full`/`complete` archive), with a `settings.evidenceClear`
locale key; auto-refresh status every 30 s while the page is open, or reword the doc's "check that the
count increases after a minute" (line 8) to say "press Refresh".

**B3.3 · Tests to add.** A route-parity test (every `api` name in `.homeycompose/app.json` is an
export of `api.ts`; nothing checks this today and the six new routes are the first to depend on it);
`api.ts` `noteEvidence` validation (state check, trim, 1000-character limit) through the existing
`appOf` mocking pattern; `read()` on a corrupted frame; the `close()` race; one `analyzeEvidence`
fixture with two boot ids asserting the across-boot gap exceeds the within-boot gap.

**B3.4 · Homey smoke test — the one thing that cannot be skipped.** Add as T98–T101 in
`docs/hardware-test-plan.md` and map them in `hardware-test-coverage.md`:
- T98 · `npx homey app install`; `node scripts/verify-hardware.mjs memory` for a baseline; Start in
  settings; after 60 s `evidence.mjs status` shows `recording`, records ≥ 3, bytes > 0, `lastFlushAt`.
- T99 · Restart the app (or reinstall the same build); `status` shows the same `id`/`endsAt` and a grown
  record count; `export` and confirm `app_shutdown` then `app_boot` with two `bootId`s and
  `recoveredTailBytes: 0`. This is the only proof that `/userdata` AND settings both survive a plain
  install, which the document assumes.
- T100 · `evidence.mjs note "smoke"`, `export` with the SECOND API key while recording continues;
  `analyze` shows one observation; `grep -c` the export for the app key's first 8 hex → 0; fetch
  `http://<homey>/app/<id>/userdata/lightkeeper-evidence/<id>.enc` unauthenticated and confirm it is
  ciphertext.
- T101 · `verify-hardware.mjs memory` after 10 min recording: delta < 3 MB. Then `stop`, `clear <id>`,
  `status` → `idle`.

**B3.5 · Docs.** CLAUDE.md Layout table (`lib/support/evidence-*.ts`, `scripts/evidence.mjs`,
`docs/week-long-testing.md`, `.evidence/`); a `commands.md` section for `evidence.mjs` (each subcommand,
the second-key trap, "a plain `install` keeps the deadline"); one sentence in `week-long-testing.md` on
the key's trust level (it sits in `homey.settings` beside the API key, readable from the settings
webview exactly as the API key is) and on the `/userdata`-plus-settings survival assumption;
`privacy.md` is already updated.

**B3.6 · Interaction with S2.** The document promises the recorder "does not change how frequently the
control loops run" (line 31-33). S2's `maintain()` loop (B1.3) polls every 60 s; if it ships in the
same build the week's evidence describes a polling app, not the released one. Either land the
recorder before S2's loop, or record the loop's cadence in `health_sample`.

**B3.7 · Release.** New capability → `0.7.0` in `.homeycompose/app.json` and `package.json`;
`.homeychangelog.json["0.7.0"]` in plain language; split `CHANGELOG.md`'s "Unreleased" block into
`## 0.7.0` with the recorder bullets separated from S1's; README `## Changelog` four bullets; `npm run
validate`; `npm test` once the S2 failures are resolved or S2 is stashed. Nothing in the feature is
over-built for a one-week home test; the Clear button and per-sensor analysis stats can wait.

## B4. Finishing S1 — diagnostics history and the override fixes

**What it does, verified.** `TargetStateCache.validCapabilityValue()` rejects non-boolean `onoff`,
non-`color|temperature` `light_mode` and any non-finite or out-of-range number before it can poison
actual or desired state (Part A's H-6, the report half). `overrideSuppression(deviceId, capability)`
returns `write_pending`, `power_settling` (a power TRANSITION within `OVERRIDE_SETTLE_MS`) or
`write_settling`, and both `noteOverride`s consult it before `lastWritten`/`committed` — exactly the
"re-arm at the rising edge" Part A's H-5 asks for, with two tests ("power restoration cannot create an
override before its write completes", "power-on restoration does not pause control before the first
write lands"). `ControlHistory` keeps 60 actions and 120 events per runtime in `BoundedLog`s with an
optional sink, and `DIAGNOSTIC_SEMANTICS` labels units and success semantics in the export.

**B4.1 · Residuals.**
- H-6's second half is untouched: `liveValuesOf()` still casts `value as number | undefined`
  (`target-state-cache.ts:59-63`), so a `null` in a CATALOGUE snapshot still primes `actualDim = null`,
  and `aimFor` still tests `=== undefined` (`daylight-runtime.ts:544`). Whether `primeCache` now routes
  through `validCapabilityValue()` decides it; if not, `?? undefined` on the five casts plus the
  junk-value test for the daylight aim.
- `ControlHistory` memory scales with targets × runtimes: each of 60 actions can carry a
  `targets: TargetDecision[]` and an `outcomes: WriteOutcome[]` for every lamp. Bounded, but on a
  30-lamp Curve light that is tens of KB per runtime; state the bound in the class header and measure
  it in T101.
- The three `pair-view-styles` failures are line endings (B0.2), not the daylight-screen edits;
  `sync:views:check` passes.
- Decouple from S3: define `EvidenceSink` locally in `control-diagnostics.ts` (one line) rather than
  importing the type from `support/evidence-recorder.ts`.

**B4.2 · Steps.** Renormalise line endings → run the two runtime test files and `pair-view-styles`
→ add the `aimFor` null test → update Part A's H-5 (closed) and H-6 (half closed) → commit S1 as its
own change with its CHANGELOG bullets ("Ignore invalid capability reports…", "Export per-target
decisions…", "Label brightness units…", "Explain the feedback risk…").

## B5. Order of work, combined

This replaces Part A's section 8 as the sequence; Part A's steps keep their content and slot in where
shown. Each numbered item is one or a few commits, each with its tests, suite green after each.

1. **Stabilise the tree (hours).** `git add --renormalize . && git stash && git stash pop`; land L-2
   (`.gitattributes`); confirm `pair-view-styles` passes. Define `EvidenceSink` locally in
   `control-diagnostics.ts` so S1 does not import a type from S3.
2. **Commit S1** (B4): add the `aimFor` null test; commit with its four CHANGELOG bullets. Closes H-5,
   half of H-6.
3. **Finish and commit S3** (B3.1–B3.5); run the Homey smoke test T98–T101; commit. If the recorder is
   wanted for a home week NOW, cut `0.7.0` here (B3.7) with S1 + S3 and a hardware pass, and let S2
   follow in `0.7.1`; the recorder then records the event-driven app, which is what the document
   promises.
4. **S2, unbroken first** (B2.1–B2.3): the two regressions and the removal of `maintain()`.
5. **S2 small fixes with tests** (B2.4–B2.6) together with Part A step 1's one-liners (H-1 is already
   in R12's hunk; L-1, M-6, M-10, M-11, L-8, the dead `setDaylight` copies, L-4).
6. **Verdict composition** = Part A step 2 + R11 (B2.9): H-4's ranking, H-3's re-assess-on-change,
   the bounded recovery pass in the managers, S-8.
7. **Override detection residuals and null guards** = Part A step 3 minus what S1 closed: the
   `liveValuesOf` casts, M-5 (already widened in S2's tree — add the test), M-8/M-9, H-8.
8. **Flow reconciliation** = R6/R7 (B2.7) with Part A's S-1 split; M-0 in the lifecycle (Part A step 4);
   M-3, M-4.
9. **R9/R10** (B2.8) and R4.
10. **Structural splits** = Part A step 5 (S-6, S-15, S-5, S-14, then S-7 on top of the fixed override
    tracker that S1 now provides in the cache).
11. **Tests, scripts, docs** = Part A step 6, plus B1.5's dispatch-path integration test and the shared
    fake Homey seeded from `runtime-lifecycle-safety.test.ts` and S3's recorder tests.
12. **Release** after each of 3, 6 and 8: version, three changelogs, README section, `validate`,
    hardware pass per CLAUDE.md's checklist, plus the hardware questions Part A lists (H-5's power-on
    event order is now moot for the code but still worth measuring once for the platform reference).

## B6. Verification additions

To Part A's section 9: the suite must be green on a renormalised tree before any S2 judgement;
`npm audit --omit=dev --audit-level=high` (T-1) added to CI before the first release here; T98–T101
for the recorder; for S2, one hardware line each for R1 (a room with a bulb, a lamp plug, an ordinary
socket and an appliance selects the first two), R2 (Hold→Brighter only; press and release; ramp ticks
stop), R3 (per-light hold moves one lamp), R5 (kill the socket; toggle a lamp; the app sees it), and a
memory reading before and after any periodic pass that survives B1.3.
