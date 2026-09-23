# What covers what

Background for [`hardware-test-plan.md`](hardware-test-plan.md). Nobody needs this to run the pass; it exists so the next person to change the plan knows what is already covered and what a line is for.

## The three tiers

| Tier | Runs | Covers |
|---|---|---|
| `npm test` | CI, every commit | the logic, the pairing screens, the settings page, every generated artefact |
| `scripts/verify-hardware.mjs` | before a release, against a real Homey | every line that is a state a machine can read |
| A person | before a release | a finger on a remote, and how it all looks |

## The script's commands

Two Personal API Keys, and they must differ: a key holds a single live session and two concurrent holders evict one another (platform §2). `HOMEY_API_KEY` is the script's own; `HOMEY_APP_KEY` is the one the app holds, which `credential` removes and restores. The script refuses to run that command on one key rather than leaving the app with none.

| Command | Test-plan lines | Effect on the Homey |
|---|---|---|
| `spike` | T178 | none. Answers whether the rest can run, and whether the installed build is this checkout's |
| `memory` | T59, T60, T128, T129, T130 | none — read-only |
| `pair` | T5, T6, T7, T12, T13, T19, T20, T26, T77, T78 | builds one of each device type, its own even if you already have some. Reuses a marked one left by an earlier run. **T78 is where the `homey:manager:geolocation` permission is proved** — no unit test can reach it |
| `flows` | T2, T8, T16, T23, T30, T79 | none — read-only |
| `settings` | T137 | none — read-only. What the settings page is built from |
| `redaction` | T42–T45 | none. Searches the diagnostics report for both keys and a slice of each |
| `restart` | T1, T4, T31, T32, T34 | restarts the app |
| `bridge` | T33 | runs one generated Flow's action card |
| `schedule` | T13, T14, T15, T17, T18 | retimes a schedule and fires both boundaries, then restores its windows, name and switch |
| `preview` | T21, T22, T27, T28 | writes the current curve to the lamps, and probes one that is off |
| `rejoin` | T24, T25, T29 | switches a lamp off and on, and sets a colour by hand; puts it back |
| `flowcards` | T147, T149, T150, T151 | runs `set_lights` and `daylight_is_dark` over this pass's own devices, switching up to two lamps in `room` that none of YOUR devices drives; puts them back |
| `credential` | T35–T41 | removes the stored key and puts it back — in a `finally`, and on Ctrl-C |
| `repair` | T46 | opens a repair session per device and reads its screens. Saves nothing |
| `repairsave` | T177 | saves one harmless edit through repair on each of this pass's devices, reads it back, saves the original again |
| `jobs` | T152, T153, T154 | reads a Light Remote's job and source screens through a repair session. Saves nothing |
| `control` | T166–T173 | "Test my lights" on the lamps in `room` (the whole house only with `--house`), and repairs this pass's own curve and circadian devices |
| `teardown` | T47–T52, T80, T180 | deletes only the devices this pass built (`[verify] …`); T180 only ever READS the orphan preview |
| `pairspike` | — | builds one throwaway circadian light over the API and deletes it |

`all` is the read-only five; `full` is the whole pass in order, ending in `teardown`.

**Flags.** `--yes` confirms a command that changes the Homey. `--json <path>` also writes every
result line, the installed and checkout versions, the firmware and the build shape (dev or launch,
from whether the dev-only evidence route answers) to a file — no key and no address in it. `--strict`
makes a `SKIPPED` line fail the exit code, for a dedicated test Homey where "nothing to test against"
is itself the fault. `--house` is the only way `control` reaches beyond `room`.

**What is put back, and when.** Every change the pass makes registers an undo the moment before it
is made (`scripts/verify/undo.mjs`): the app's API key, every lamp switched or set by hand, a
schedule's windows, name and switch, a device's control mode, a repair's edit. Each command runs in
its own `try` — one that throws is reported `FAILED` and the rest still run — and anything it left
registered is put back before the next command starts. Ctrl-C (or SIGTERM) runs every undo still
registered, newest first, then exits non-zero; Ctrl-C a second time exits at once. The one residual
race is a request already in flight when the signal lands.

## Every line the script reports

Fifty-odd of these numbers are not written out as a line in the plan, because the script answers
them whole and there is nothing for a person to do. This is where a report line is looked up. It is
`AUTOMATED` in `scripts/verify/lines.mjs`, rendered by `automatedTable()`, and
`test/unit/hardware-test-numbers.test.ts` fails — printing the table to paste — if the two drift, if
the script prints a number that is not here, or if a number here is never printed. "Part" means the
plan line still needs a person for the rest, which is why the end of `full` lists it with a `*`.

<!-- automated-lines:start -->
| Line | Command | What it asserts | Whole line? |
|---|---|---|---|
| T1 | `restart` | the app comes back after a restart and answers its own Web API | yes |
| T2 | `flows` | census of generated Flows, and how many belong to this pass (INFO) | yes |
| T4 | `restart` | it does so after a restart, not only from a cold install | yes |
| T5 | `pair` | a Light Remote's setup sees the stored key as valid, so a user is let straight through | yes |
| T6 | `pair` | the light picker offers rooms and lamps, and a remote offers its OWN gestures | yes |
| T7 | `pair` | a Light Remote is built over the API: remote chosen, rules accepted, runtime registered | yes |
| T8 | `flows` | each of this pass's Light Remotes owns Flows, and none is switched off | yes |
| T12 | `pair` | a light schedule's setup sees the saved key as valid — no retyping | yes |
| T13 | `pair, schedule` | a schedule block is accepted at pairing, and one window is saved and read back | yes |
| T14 | `schedule` | both of a window's boundaries fire now, and each writes to its lamps | yes |
| T15 | `schedule` | two overlapping blocks are both KEPT and the clash is reported | yes |
| T16 | `flows` | each of this pass's schedules owns Flows, and none is switched off | yes |
| T17 | `schedule` | pausing and resuming a schedule keeps its device available both ways | yes |
| T18 | `schedule` | renaming a schedule moves its Flow folder (SKIPPED where the Web API rename cannot reach onRenamed) | yes |
| T19 | `pair` | the circadian driver exposes no credential handler at all | yes |
| T20 | `pair` | a circadian light is offered three zones, anchored to today's sun | yes |
| T21 | `preview` | a circadian "Try it now" writes, and every lamp holds what it was written | yes |
| T22 | `preview` | the pre-stage probe on an off lamp: stays off, comes on, or is refused — each a result | yes |
| T23 | `flows` | no Flow is attributed to a circadian light | yes |
| T24 | `rejoin` | a circadian lamp switched off and on is written again, and holds the write | yes |
| T25 | `rejoin` | a value set by hand is left alone, and a power cycle ends the override | yes |
| T26 | `pair` | the Colour Curve driver has no credential handler; points with a colour are accepted | yes |
| T27 | `preview` | a Colour Curve "Try it now" writes, and a colour reaches a colour lamp | yes |
| T28 | `preview` | every Colour Curve lamp holds what it was written | yes |
| T29 | `rejoin` | a Colour Curve lamp switched off and on is written again, and holds the write | yes |
| T30 | `flows` | no Flow is attributed to a Colour Curve Light | yes |
| T31 | `restart` | the app restarts over the API | yes |
| T32 | `restart` | every Lightkeeper device comes back available (a sleeping remote excused and named) | yes |
| T33 | `bridge` | a generated Flow's own action card dispatches, maps and writes to a light | yes |
| T34 | `restart` | this pass's curve runtimes are ready and hold a current value after the restart | yes |
| T35 | `credential` | a working API key is saved before the key lines start | yes |
| T36 | `credential` | a nonsense key is refused, and the working key stays and no device degrades | yes |
| T37 | `credential` | with nonsense rejected, a generated Flow still fires | yes |
| T38 | `credential` | removing the key sends Flow owners to needs_credential and deletes no Flow | yes |
| T39 | `credential` | with no key stored at all, a generated Flow still fires | yes |
| T40 | `credential` | the key put back returns every device to ready without a restart | yes |
| T41 | `credential` | circadian and Colour Curve Lights never reach needs_credential | yes |
| T42 | `redaction` | recent remote presses are recorded | yes |
| T43 | `redaction` | recent writes to lights are recorded | yes |
| T44 | `redaction` | every schedule's clock has a resolved timezone | yes |
| T45 | `redaction` | the diagnostics report carries no key material, whole or a 12-character slice | yes |
| T46 | `repair` | every repair screen comes back seeded with the device's own values | yes |
| T47 | `teardown` | Flow census before any deletion (INFO) | yes |
| T48 | `teardown` | deleting a Colour Curve Light moves no Flow | yes |
| T49 | `teardown` | deleting a circadian light moves no Flow | yes |
| T50 | `teardown` | deleting a schedule removes exactly its own Flows | yes |
| T51 | `teardown` | deleting a Light Remote removes exactly its own Flows | yes |
| T52 | `teardown` | nothing of the deleted devices is left, and nothing of yours has gone | yes |
| T59 | `memory` | the app's PSS, against Homey's 30 MB guideline and the 100 MB ceiling | yes |
| T60 | `full` | the same reading at the end of the pass, as a delta | yes |
| T77 | `pair` | a Room-sensing Light is built: no credential handler, its response accepted, runtime registered | yes |
| T78 | `pair` | the geolocation permission resolves: a sun elevation at a location | yes |
| T79 | `flows` | no Flow is attributed to a Room-sensing Light | yes |
| T80 | `teardown` | deleting a Room-sensing Light moves no Flow | yes |
| T128 | `memory` | the machine's free memory and swap, printed beside T59 | yes |
| T129 | `memory` | the app's own heap, per-space split and boot marks | part — the plan line still needs a person |
| T130 | `memory` | the sandbox still refuses /proc/self/statm | yes |
| T137 | `settings` | every running device can describe itself to the settings page, and the orphan preview has its shape | part — the plan line still needs a person |
| T147 | `flowcards` | each engine's published capability rows agree with its /diagnostics `now` | part — the plan line still needs a person |
| T149 | `flowcards` | `set_lights` "switch them on" brings off lamps on at both chosen values | part — the plan line still needs a person |
| T150 | `flowcards` | `set_lights` "only lights already on" leaves a dark lamp dark; a missing source writes nothing | part — the plan line still needs a person |
| T151 | `flowcards` | `daylight_is_dark` answers against the device's own published level | part — the plan line still needs a person |
| T152 | `jobs` | "On – with Lightkeeper" is offered on a button when a source device exists | part — the plan line still needs a person |
| T153 | `jobs` | the colour picker offers only curve-driven devices; the brightness picker adds Room-sensing Lights and schedules | part — the plan line still needs a person |
| T154 | `jobs` | the brightness picker's level is the perceptual one the setup screens use, not the device value | part — the plan line still needs a person |
| T166 | `control` | each review screen offers the right control modes, and a Room-sensing Light refuses "before" | part — the plan line still needs a person |
| T167 | `control` | "Test my lights" answers in time for every lamp and leaves each as it was | part — the plan line still needs a person |
| T168 | `control` | the lamps the test passed are exactly the ones the running device pre-stages | part — the plan line still needs a person |
| T169 | `control` | a device that chose pre-staging before the per-lamp test now pre-stages none of its lamps | part — the plan line still needs a person |
| T170 | `control` | "Don't change lights automatically" saved: a forced pass writes nothing | part — the plan line still needs a person |
| T171 | `control` | what step 3 says about every sensor, and that the thresholds start from the sensor's week | part — the plan line still needs a person |
| T172 | `control` | the curve screen is sent 10 featured and 25 folded colours, each with its own hex | part — the plan line still needs a person |
| T173 | `control` | "Test my lights" leaves no running device thinking a person took a lamp | yes |
| T177 | `repairsave` | a repair that SAVES one harmless edit round-trips on every device type, and is put back | yes |
| T178 | `spike` | the installed app is the version this checkout builds, and which build shape it is | yes |
| T180 | `teardown` | with no Flow-owning device live at all, the orphan sweep refuses rather than sweeping everything | yes |
<!-- automated-lines:end -->

## How the pass knows which devices are its own

Every device the script builds is named `[verify] <the name the driver derived>`, and that name is
the only thing telling them from the ones you paired. Every command selects from the marked ones,
and `teardown` deletes only those — re-reading the name from the Homey immediately before each
permanent delete, so a device that is not ours could not be deleted even if it reached that line.

**The name rather than a file on the laptop.** A run-state file would be a second source of truth
that can disagree with the first in both directions: delete the file and the marked devices become
litter `teardown` refuses to remove; delete a device by hand and the file names something that is
not there. The Homey already knows what exists, on the machine that owns it, readable by a
`schedule` run in a separate process an hour after the `pair` that built it. It is also visible —
you can see in the Homey app which devices are the pass's, which is worth a lot for a script whose
whole promise is that it left yours alone.

**It is a prefix**, because T18 renames a schedule to `<name> (verify)` and back: a suffix marker
would be destroyed by the very test that has to survive it.

**Renaming one of ours strips the mark**, and the pass then stops touching it *and* stops deleting
it — which is what renaming a device says. The cost is that the next `pair` builds a duplicate; the
recovery is to delete the unmarked leftover by hand.

A flag inside the device's `store` was considered as a second, rename-proof mark and declined: it is
unverified whether the Web API returns `store` at all, and it would put a foreign key inside a plan
blob the app migrates.

**What still cannot be scoped to a device** — the app-wide API key that `credential` removes and
restores, the whole-app `restart`, and the lamps themselves, which are shared with whatever your own
devices drive. `docs/hardware-test-plan.md` states all three where a person will read them before
running the pass.

**Read `memory`'s output from the bottom up, not the top.** T59's PSS is the least trustworthy
number the pass produces: on 14 September 2026 the unmodified 9 September build was reinstalled
beside HEAD on one Homey and measured the same, and three restarts of one build spanned 71.4–80.1 MB
(platform §15). So the command now prints T128 — the machine's free memory and swap — and T129, the
app's own `heapUsed`, per-space split and three boot marks read off `GET /diagnostics`. **T129 is the
only one of the three that can distinguish holding a parsed catalogue from having parsed one**, which
is the regression T59 was wrongly expected to catch. T130 asserts that the sandbox still refuses
`/proc/self/statm`; if it ever answers, §17 is wrong and the app can measure its own RSS.

**`memory` is the only line whose answer is a number rather than a state**, and it is here because
the app was 48 MB against Homey's 30 MB guideline — almost all of it `homey-api` retaining both
flow card catalogues for the life of the client (platform §15). It reads
`ManagerApps.getAppUsage` and `ManagerSystem.getMemoryInfo`, neither of whose response shapes is
described in `homey-api`'s specification, so `pssBytesIn()` searches for a PSS-shaped field and
reports SKIPPED with the keys it saw rather than guessing. T60 re-reads it at the end of `full`,
because the catalogues are read lazily: an app nothing has asked anything of yet looks thin
whatever it does with the answer.

**It fails on a ceiling, not on the guideline.** One catalogue read costs ~12 MB of floor and V8
never returns those pages, and the app is deliberately over the 30 MB guideline. So T59 prints the
guideline and fails past **100 MB**, because a line that failed on every run is one nobody reads.

**The ceiling was 50 until 13 September 2026, and what moved it is worth knowing.** The same line
read 36.6 MB on a fresh install on 9 September and 68 MB on 13 September — so the 9 September build
and the 13 September build were installed one after the other on that Homey against the same four
devices, and measured 67.5 MB and 68.2 MB. The app's code is not the difference; the house is, and
which part of it was not identified ([platform §15](homey-platform.md#15-homey-api-caches-every-getall-result-forever)
has the table, and the three things that were ruled out). **A reading is comparable only with
another reading from the same house**, which is the real limit on this line.

Be clear about its reach: it is a smoke check for a second bulk read appearing, **not** a regression
test for retention. Holding a parsed catalogue and merely having parsed one cost the same RSS, so
the number cannot tell them apart. The sharp signal is the app's own `heapUsed` after a read, which
the app does not expose today — [platform §15](homey-platform.md#15-homey-api-caches-every-getall-result-forever)
says what to add if that is ever needed.

**Running a generated Flow is not pressing a remote.** `bridge` calls the Flow's own action card, which proves dispatch, mapping, attribution and the write path. It bypasses the physical *release* event, and a dropped release is the entire reason the ramp hard-stops at 10 seconds — so it can never stand in for T9–T11. It is honest for T33, T37 and T39, where the only question is whether the Flow path is still live.

**Pairing over the API works** — proven on hardware 28 August 2026 and written up as [platform §14](homey-platform.md#14-pair-sessions-are-a-web-api-surface-and-pairing-can-be-scripted). `emitPairingEvent` lands on the same `session.setHandler` a pairing view talks to, so `pair` and `repair` drive the real handlers with the real payloads. `pairspike` is kept as the one-off probe, so the claim can be re-checked on a future firmware rather than trusted from a note.

Three things the Web API does not do for you, each of which cost a run:

- **A driver id must be enumerated, not built** — `homey:app:<appId>:<driverName>`. Assembling it returns `Not Found: Driver with ID …`, which reads like a permission refusal (platform §3).
- **A device DTO must carry the manifest's own fields.** A pair view sends `{name, data, store}` and lets the platform fill in the rest; over the Web API `capabilitiesOptions` is not filled in, and a device created without it comes up unavailable with `Cannot read properties of null (reading 'get')` and no runtime. `withManifest()` reads them from `driver.compose.json` and sends them explicitly.
- **A device that exists is not a device that works.** Homey creates it available and runs `onInit` afterwards, so reading `available` straight after creation catches the window before init has failed. The script waits for the app to register a *runtime*, which only happens once `start()` resolves.

This covers the pairing HANDLERS, not the pairing SCREENS. A handler can answer correctly while its view draws nothing — which is the bug `pair-view-boot.test.ts` was written about — so one device is still paired by hand each pass, and `render:views` covers the rest.

Two ids that must be enumerated rather than built, both of which cost a run: a flow card's `uri` (platform §3) and a driver's id, which is `homey:app:<appId>:<driverName>`. Assembling either returns a `Not Found` that reads like a permission refusal.

## What the suite covers instead

These were hardware steps. They are tests now, and they fail. Where a line survives in the plan it is named by its number; the rest were retired as they were taken over, and their old numbers are in [the old numbering](#the-old-numbering) below.

| Test | What it took over |
|---|---|
| `pair-view-behaviour.test.ts` | T15, and the old 2.2, 2.3, 2.6, 4.3, 5.2, 5.3, 5.6 — what each screen refuses and what it draws. **Rewritten for 0.6.0**: the screens it covered are mostly gone, and several of the behaviours it asserted were deliberately reversed — a schedule now REPORTS an overlap rather than refusing it, and one rule per gesture is structural rather than checked. What survives is re-pointed: the key screen, the light picker, and one block each for the day, curve, blocks, sensor, response, review and buttons screens |
| `settings-page.test.ts` | the old 1.2 and 8.1 — five empty sections rather than five blanks, and five full ones. Plus the sky readout, which is the fastest check that geolocation resolved |
| `pair-view-boot.test.ts` | every view runs and asks the driver for its data |
| `repair-views.test.ts` | the `unknown_error_getting_file` that made Repair a dead end |
| `pairing-sessions.test.ts` | the one-light collapse, the default names, the remote picker |
| `pair-session.test.ts` | the pairing MECHANICS all five drivers share — the handler wrapper logging AND re-throwing, the sensor retain/release ref-count, save-and-name per device type, `nextView` per driver, the credential probe creating a folder and deleting it again, the curve preview's force-and-drain. **None of it was reachable before**: platform §13 means a file containing `extends Homey.Driver` cannot be imported by a test, so the pairing mechanics five drivers share were guaranteed identical by a comment. What the SDK decides on the other side of the seam — whether Homey still routes each handler, still accepts the `createDevice` shape, and still finds a repair's device — was T87–T89, retired with 0.6.0; `pair`, `repair` and `repairsave` now answer it on every pass (T7, T46, T177) |
| `assets.test.ts` | T3's measurable half: five pictures, five distinct, correct sizes |
| `schedule-window.test.ts`, `schedule-bindings.test.ts` | midnight-crossing windows and their labels |
| `curve-colour.test.ts`, `circadian-curve.test.ts` | the shade between two coloured points |
| `solar-elevation.test.ts` | where the sun is, against values astronomy fixes independently of any implementation — declination at the poles, `90 −` the latitude gap at noon, hemispheric mirroring at an equinox, an hour per 15° of longitude |
| `sensor-history.test.ts` | the week grid's arithmetic — seven days of buckets from a raw Insights series, the four verdicts and the order they are decided in, and the two roundings. The dark end rounds UP and the bright end down, because snapping the dark threshold down deletes the margin it exists to carry |
| `daylight-runtime.test.ts` | that the daylight loop TERMINATES, and the slew limit's shape. Neither is watchable in less than ten minutes on hardware; the lines that watched it on a real sensor (T83, T84) were retired with 0.6.0, and T110 is the one that now asks a room |
| `luminance-source.test.ts` | one subscription per sensor however many devices name it, and what makes a reading unusable |
| `api-trying.test.ts` | the seven "try it now" routes the script drives |
| `verify-hardware-safety.test.ts` | the script never prints key material, and every lamp it switches on is put back in a `finally` |
| `verify-hardware-logic.test.ts` | the script's own decisions, run rather than read: the lamp chooser and group overlaps, the memory verdict, what a lamp's restore writes and in which order, the undo stack and the interrupt, the argument parser, the JSON report, the `control` room scope, and every pure check behind `flowcards`, `jobs`, `settings`, `repairsave` and T180 |
| `hardware-test-numbers.test.ts` | the three sources of test-plan numbers agree: none defined twice in the plan, none retired and reused, every number the script prints in the table above, every number the docs mention defined, automated or retired |

The screens are run rather than read: `test/support/pair-view-harness.ts` executes each view's real script against a hand-rolled DOM. Deliberately not jsdom — that file's header says why, and what it does not do.

## The old numbering

The plan used to number every line `section.line` — 7.4 was the fourth line of §7 — so a line's number moved whenever the sections around it were rewritten. It is a flat `T1`, `T2`, … now, and a number is never reused. This table is here so a report written against the old scheme is still readable.

| Old | New |
|---|---|
| 1.1 | T1 |
| 1.3, 1.4, 1.5 | T2, T3, T4 |
| 2.4, 2.5, 2.7, 2.9 | T5, T6, T7, T8 |
| 2.10–2.12 | T9–T11 |
| 3.1–3.7 | T12–T18 |
| 4.1, 4.2 | T19, T20 |
| 4.4–4.8 | T21–T25 |
| 5.1, 5.4, 5.7, 5.8, 5.9 | T26, T27, T28, T29, T30 |
| 6.1–6.4 | T31–T34 |
| 7.1–7.7 | T35–T41 |
| 8.2–8.5 | T42–T45 |
| 9.1 | T46 |
| 10.1–10.6 | T47–T52 |
| 11.1, 11.2 | T53, T54 |
| 12.1–12.3 | T55–T57 |

Every other old number — 1.2, 2.1, 2.2, 2.3, 2.6, 2.8, 3.8, 4.3, 5.2, 5.3, 5.5, 5.6, 8.1, 9.2–9.4 — was already gone before the renumber and never got a `T`. Most were taken over by the suite, in the table above; the rest are below.

## A green pass is only as honest as the list its check looks in

On 4 September 2026 T77 failed with "the app never registered a runtime for it — it did not
initialise" for a Room-sensing Light that had initialised perfectly. The check polled the app's own
status response and searched `controllers`, `schedules` and `circadian` — omitting `daylight`, which
is its own key because a Room-sensing Light is not folded in with the curve-driven types the way a
Colour Curve Light is. The line could only ever fail.

It is recorded here rather than only in the fix because the failure mode is general and this pass
has fifteen-odd checks shaped the same way: a check that enumerates a union will go on passing when
something is added to the union and not to the check — and, as here, will report the app broken when
the app is fine. The honest signal the comment above `waitFor` describes (wait for the app's OWN
registry, not for `available`) was right; the list under it was incomplete.

## Three ways this pass blamed the app for the house — 22 September 2026

Four runs in one morning failed between one and two lines each, on an app that turned out to be
behaving exactly as documented every time. They are gathered here because the shape repeats: **an
assertion written against one lamp, one device or one moment, run in a real house where none of
those is exclusive.** All three are fixed in `verify-hardware.mjs`, and each fix carries its own
evidence in a docblock.

**A Homey light GROUP is invisible overlap.** `Cieling Lamp (Studio)` is a group of Spot C, L and R;
`Cieling Lamp (Garage)` is a group of Ceiling 1 and Ceiling 2. A group is an ordinary device with its
own id, its own capabilities and its own row in `getDevices()`, and **nothing on it or on its members
says they are the same bulbs** — the membership is in the group's `settings.deviceIds` and a caller
that does not go and read it sees unrelated lights. `pickLights()` picked by index, so it handed the
group to the circadian light and a member to the Colour Curve Light, and two devices this pass built
then wrote different colours to one bulb for the whole run. The read-back is where it surfaced —
T24 and T29 report "it did not take" — and the hue is what identifies it: `light_saturation` 0.512
written **at hue 0.11**, 0.400 read **at hue 0.36**. A value this pass never sent came from somewhere,
and a slow lamp does not invent one. `lampOverlaps()` is the fix, and it feeds both the chooser and
the "already driven by a device you paired" check, which had the same blind spot from the other end:
a group whose members are driven never appeared in anyone's `targetIds`.

**A value set by hand inside the restore window belongs to the lamp.** T25 stands in for a person and
runs straight after the power cycle T24 and T29 need, which put its hand-set **14.0 s** after the
lamp came on — inside `POWER_RESTORE_MS` (15 s), the allowance the app reserves for a lamp restating
what it was left at. `/diagnostics` said so in as many words: `report_ignored … light_temperature 0.51
reason power_restore`. The allowance is spent by whichever report lands first, and a Hue bulb reports
only on change, so no second report came and no override was ever raised. It was intermittent for
the reason races are — whether the settle wait above it happened to clear 15 s decided the verdict.
The allowance is new in 0.6.5, which is why the 2 September note above records T25 passing.
`HAND_SET_AFTER_POWER_ON_MS` waits it out, and this is the second time a T25 failure has turned out
to be the script rather than the lamps.

**A sleeping remote is a correct `needs_repair`, not a device that failed to start.** All three
BILRESA scroll wheels dropped to `available: false` — *"Device is not responding"* — part way through
the morning. T32 asserts every Lightkeeper device is available after a restart and T38 asserts every
Flow owner reaches `needs_credential`; a controller whose remote is gone breaks both **by being
right**, because `needs_repair` outranks `needs_credential` (worst wins, `lib/runtime/verdict.ts`)
and an unavailable source makes an unavailable controller. `controllersWithASleepingRemote()` excuses
exactly that case and names the remote, and only when the source device still EXISTS — a deleted
remote is a different situation wearing the same state, and this is not the line that should be quiet
about it.

**What none of this fixes.** Every lamp in Studio and Garage is driven by a device the owner paired,
and each room holds only three lamps that do not share bulbs with each other — so T24 and T29 are
asking whether a lamp holds a value two devices are writing. The pass now says that in an INFO line
before it starts rather than leaving it to be rediscovered from a failure. The only way to make those
two lines unconditional in this house is to switch the owner's own devices off for the length of a
run.

## What the script still cannot answer

**Pre-staging and the switch-on timings (T139, T141, T167–T169), because the answer is per-household.**
`control` runs T167–T169's test and read-backs on the lamps in `room` — and on the whole house only
with `--house`, because the test switches lamps that are ON off to ask them, and it used to do that
to every colour lamp in the house while the plan called `room` the containment. What it cannot do is
say what the answers MEAN for a household, which is the paragraph below.

Platform §6 measured three outcomes for a colour written to an off lamp — it stays off, it comes on,
or the bridge declines — and which one a given lamp gives is a fact about that integration and that
bulb, not about this app. Nine staged and four declined behind ONE Hue Bridge on 4 September 2026, so
a household's own lamps disagree with each other and no script run on one Homey generalises. T167 is
a person pressing the review screen's own per-lamp test, which is the only instrument there is — and
the list it stores is what decides which lamps are ever pre-staged. (T138 and T140 are retired: the
switch and one-lamp test they pressed are gone.)

The timings are the same kind of gap from the other end. The suite proves that a report arriving
after a power transition is classified correctly, against an injected clock that does exactly what
the test says; it cannot prove that a real bridge's settled report lands where the window still
covers it. T168 and T141 are that measurement. T141 in particular needs a lamp that snaps to a
coarser step than it declares — no test double will discover one, because the discovery IS that the
declaration was wrong.

**The cadences that only a house has (T142–T145), because the gap is TIME rather than behaviour.**

Four lines from the 17 September 2026 diagnostics capture, and what they have in common is that the
suite already asserts every one of them — with an injected clock, in milliseconds. What it cannot
manufacture is the rate at which a real household supplies the input.

The pre-stage backoff (T142, T143) needs a room that switches every couple of minutes, which is what
made the old per-off-period bound worth so little; a test can produce three off-periods in one
`await`, and can say nothing about whether the rooms people actually have do that. The feedback
count (T144) is the same in the opposite direction: it accrues about twice a day, so the five it
needs is two and a half days of a real room, and a test that advances a fake clock proves the
arithmetic rather than the reachability. T145 is a battery, and there is no double for a battery.

Each of these was a guard that passed every test and could not fire in the field. That is the class
of defect this whole section exists for, and it is why the capture is worth taking again.

**The Flow surface (T146–T151) — the script now reaches the cards, not the editor.**

`flowcards` runs `set_lights` through `runFlowCardAction` and `daylight_is_dark` through
`runFlowCardCondition`, enumerated and echoed back exactly as `bridge` runs a generated Flow's card,
and checks each engine's capability rows against its own `/diagnostics` `now` (T147). It points the
card only at lamps in `room` that none of YOUR devices drives — `set_lights` would read as a person to
such a device and stand it down — so a room where every lamp is spoken for gets a `SKIPPED` saying so.
What remains a person's is below, and it splits into two different reasons.

**Three are about Homey, not about this app.** (`flowcards` shows the end state of T149 and T150's
switch; the Flow editor, the tag list and "one visible change" are still eyes.) That a capability becomes a Flow tag with no further
code is Athom's behaviour (platform §18), and nothing in this repo can demonstrate it — T147 and
T148 are what confirm the tags exist, are grouped under the right device, and carry the number the
FAQ promises. T149 is the same again for the ordering: the suite proves one submit produces one
burst with `onoff` ahead of `dim`, and only a room can show that this reads as a single change
rather than three. The script drives pair sessions over the Web API; it has no Flow editor.

**One is about upgrade, and it is the only line here that cannot be recovered later.** T146 needs a
Homey that already holds the four device types from a build BEFORE this one, because a driver's
capability list reaches nothing already paired. Re-pair those devices and the evidence is gone until
the next release, so this is the line to run first and the one to run on a real installation rather
than a fresh one. The suite covers the reconciliation itself — adding, removing, and surviving a
failure — against a fake owner; what it cannot supply is a device Homey actually built last month.

T150 and T151 are the two safety promises, and both are asserted in the suite. They are here anyway
because each is a claim about something NOT happening — a dark lamp staying dark, a condition
staying false — and the failure mode is a household noticing before anybody else does.

**The daylight feature's three genuine gaps, and each is a different KIND of gap.**

- **A real permission.** `homey:manager:geolocation` either resolves on a Homey or it does not, and
  nothing but a Homey answers that. The script asks in T78 and reports the elevation it got; what it
  cannot do is tell a *plausible* number from a *correct* one. The line that sent a person to NOAA's
  calculator with the same latitude and minute was T81, retired with 0.6.0, and nothing has replaced
  it — T162's sun card is the nearest a pass now comes. A sign error survives every unit test in this
  repo, because those assert against invariants rather than against an almanac.
- **A real sensor.** What `measure_luminance` actually reports — its scale, its resolution and how
  often — is per-integration and is established nowhere (platform §16). The script deliberately
  selects NO sensor when it builds its own Room-sensing Light: this pass builds and deletes its own
  devices and must not subscribe to a household's battery-powered motion sensor as a side effect.
  A person doing it on purpose was T82 (retired with 0.6.0; T171 now reads what step 3 says about
  every sensor in the house), and the numbers such a person reports are the only evidence the
  `darkLux` / `brightLux` defaults of 5 and 500 will ever have.
- **A real room, for ten minutes.** `daylight-runtime.test.ts` proves the loop terminates against a
  test double whose readings do exactly what the test says. It cannot prove the deadband is wider
  than the jitter of a particular sensor watching a particular wall, and that is the one number
  this device type lives or dies by. That measurement was T83, retired with 0.6.0; T110 asks the
  nearest question a pass still asks, and there is no substitute for either.

**The orphan sweep's refusal (T180) is only ever READ, never provoked.** The sweep refuses when no
Flow-owning device is live, because every generated Flow then looks orphaned and a sweep would delete
them all. Provoking that state means deleting or disabling the household's own controllers and
schedules, which this pass never does. So `teardown` reads the preview at the one moment the state
may arise by itself — after it has deleted its own devices, on a Homey whose owner has no Flow-owning
device — and asserts the refusal there; anywhere else T180 is `SKIPPED` and says why. It never POSTs
the sweep. The refusal's logic is `flow-bridge-sweep.test.ts` and `api-orphans.test.ts`.

**The upgrade path (T179) is a manual line on a dedicated Homey, and not a command.** It was
designed as one — install a previous build from a temporary worktree, pair, install HEAD, assert —
and declined for three reasons, each sufficient: there are **no release tags** to install from, so
"previous" would be a guess this script makes about somebody's history; `homey app install` runs on
the CLI's own `homey login` session, not on the Personal API Keys this script holds, so the script
would be driving a second credential it has no business with; and the first half installs an OLDER
build over stored plans, which quarantines every device whose plan is newer (T121) — a command that
can do that to the Homey somebody lives with should not exist, and one gated behind a flag is one
flag away from it. The plan line has the procedure.

**T25 — RESOLVED on 2 September 2026, and the earlier explanation here was wrong.**

This section used to say that both Studio lamps refuse an external `light_temperature` write, so the
property could not be exercised and the line reported SKIPPED. The 30 August pass reached the same
conclusion about T21 and T24 by a different route, blaming a Hue Bridge for echoing values back
later than the script waits.

Neither was the cause. **The script was reading its own cache.** `capabilityValue()` called
`getDevice({ id })` with no `$cache: false`, and a `getAll` writes every item it returns into
`homey-api`'s per-manager cache for the life of the client (platform §15) — which this script
populates by enumerating devices. So the read-back was served the value from before the write, every
time. T25 polling for 15 seconds made that look conclusive rather than stale: eight reads of one
cached value agree with each other perfectly.

The tell, in hindsight: a lamp the script said "never reported 0.480" was sitting at exactly 0.480
when read a minute later over a client that had opted out.

With `$cache: false` on that read, all of T21, T24, T25, T27, T28 and T29 pass — including the
override property T25 is about, which had never once actually run. The same defect existed in the
app's own `LightTargetAdapter.refresh()` and is fixed there too; it is worth knowing that a
client-side cache can imitate hardware misbehaviour convincingly enough to be written into a
platform reference twice.

**The lamps were never the problem, so `room` in `scripts/hardware-env.json` does not need choosing
for this.**

**T9-T11 need a finger on a remote**, and always will. `bridge` proves dispatch, mapping,
attribution and the write path by running the generated Flow's own action card; it cannot produce
the physical release event that the 10-second ramp stop exists for.

**T3 and T53-T54 need eyes.** `assets.test.ts` proves four distinct pictures at the right sizes;
whether they look right is not a machine's question.

**T66–T76 are retired numbers**, kept here for the reasoning rather than as lines to run: their
release sections were rewritten away, and CLAUDE.md's rule is that a number is never reused.
T67's gap — a repair that SAVES — is now `repairsave` (T177).

**T66-T70 needed a phone, and T66 was the important one.** They came out of the code review, and
`verify-hardware.mjs full` answered none of them:

- **T66-T67 drive a device TILE.** The pause switch is a capability listener on a class that
  `extends Homey.Device`, and Repair is a pair session seeded from a stored plan; the script pairs
  devices and reads state, it does not tap switches. Both bugs behind those lines were in exactly
  that gap — `setEnabled` handing a runtime the wrong plan shape, and `planOf` folding onto the
  store instead of onto the plan being saved — and both are now covered by
  `device-transactions.test.ts` and `circadian-types.test.ts` at the logic level. What hardware adds
  is the wiring: that the tile's switch reaches `setEnabled` and that a repair reaches `applyPlan`.
- **T68 needs a colour-only lamp** — one with `light_hue` and no `light_temperature`. Whether the
  household has one is not something a script can arrange, and `circadian-runtime.test.ts` covers
  the verdict itself with a fake device.
- **T69 needs a zone deleted mid-pairing**, from another client. The failure path is covered by
  `pair-view-behaviour.test.ts` ("a refused selectTargets is reported, not swallowed"); what
  hardware adds is that a real rejection takes that path.
- **T70 is `memory`**, which the script does answer — it is listed with the others because it is the
  review's own regression check rather than a release line.

**T71-T76 need a lamp, and T74 needs eyes.** They are the 0.5.2 fixes, and
`verify-hardware.mjs full` answers none of them:

- **T71-T72 and T75-T76 need a curve that CROSSES** between a coloured segment and a temperature
  one, which takes three points arranged so that one segment has a colour at neither end. The script
  builds a curve to pair a device, not a curve shaped to cross; and the bug behind T71 only appears
  on the *second* crossing, so a single pass could not have caught it however the curve was shaped.
  `circadian-runtime.test.ts` covers all four at the logic level — the mode write surviving a second
  crossing, the dim floor, the voided warmth, and every diagnostics field. What hardware adds is the
  half the suite cannot fake: that a lamp told to leave colour mode actually leaves it.
- **T73 needs a device that predates the build**, so it cannot be arranged on a Homey that has only
  ever run 0.5.2. The migration itself is covered in all three chains
  (`curve-colour.test.ts`, `schedule-bindings.test.ts`, `circadian-types.test.ts`); what hardware
  adds is that a repair screen loads the lifted value rather than displaying one number and saving
  another.
- **T74 is the one no test can replace**, and it is worth saying why given what is in the retired
  table below. Line 5.5 was retired on the grounds that "`curve-colour.test.ts` covers the
  interpolation" — which was true of the arithmetic and not of the choice it rests on. The all-pairs
  test asserted that a blended hue stays on the wheel; nothing asserted which way round the wheel it
  went, so ember fading to ocean through magenta and purple passed the suite for as long as it
  existed. The new tests pin the property (a wide pair loses its saturation in the middle, a narrow
  one keeps it), but whether the result looks right in a room is still a person's question.

## Retired lines

Kept here so an old report that says `3.8 OK` is still readable, and so nobody re-adds them. The numbers are not reused.

| Line | Was | Why it went |
|---|---|---|
| 3.8 | An overnight midnight-crossing window switches off at the right time, and its Flow reads `Off at 01:30 (starts Fri)` | `schedule-bindings.test.ts` asserts that exact string, and `schedule-window.test.ts` covers the arithmetic. The only residue was "Homey's cron card fires on the minute", measured at ~11–22 ms and recorded in `homey-review-notes.md`. It cost an evening and taught nothing |
| 5.5 | Two coloured points, checked for a shade between them | `curve-colour.test.ts` covers the interpolation. The hardware residue — a lamp accepting the hue — is T27 |
| 9.2–9.4 | Repair each of the five device types | The failure it names — `unknown_error_getting_file` — is `repair-views.test.ts`. Whether each screen comes back seeded from the stored plan is the `repair` command, which covers all four under T46 |
| T55–T58 | The 0.5.0 release lines: the new Colour Curve Light, the two-question circadian light, the migration, two lamp-driving fixes | Retired when 0.5.1 rewrote **This release**, which is what that section is for. What they found is in the plan's *Last run* record. **T59 and T60, the two memory readings from the same release, were NOT retired** — `memory` reports them on every pass, and platform §15 carries the reasoning |
| T61–T65 | The 0.5.1 release lines: the store description, the changelog rendering as prose, and the flow-card icons in their 24px circles | Retired when 0.5.2 rewrote **This release**. They needed the published listing and no Homey at all; `npm run render:icons` reproduces the icon half locally, and `assets.test.ts` still owns the rules an icon must satisfy |
| T66–T76 | The 0.5.1 code-review lines and the 0.5.2 fix lines | Retired with their release sections; the reasoning is kept under *What the script still cannot answer* |
| T81–T90 | The pre-0.6.0 daylight and pairing-SDK lines | Retired by the 0.6.0 rewrite, which reset every screen and engine they described |
| T117 | A 0.6.0 pairing line | Removed before it was ever run |
| T138, T140 | Colour on arrival through the old switch, and the old one-lamp pre-stage test | Both controls moved to the review screen; T166–T168 replace them |
| T127–T129 (first meanings) | Three 0.6.0 design lines, each defined a second time by the memory block | The design lines were renumbered **T174, T175, T176** (in that order: one remote two sets of lights, the colour job, the buttons screen's rows). T127–T129 are the memory lines. `T128`/`T129` in any report from `verify-hardware.mjs` always meant the memory ones |

## The light probe, which is not part of the pass

**`node scripts/probe-lights.mjs`** walks the lights on a real Homey and reports which of them break
the assumptions the output path is built on. It carries **no test-plan lines and never will**: a `Tn`
is release-scoped and asked once, and a probe finding happens zero-or-many times per lamp and has to
stay a stable key across releases. It gates nothing, runs in no CI, and its findings never fail the
run — the app's own rules are the unit suite, which does fail. Full commands and traps are in
[`commands.md`](commands.md#probing-the-lights).

What it is for is the thing this table cannot express: every behavioural fact in
[`homey-platform.md`](homey-platform.md) §6 and §12 was established against **one** Homey and a
handful of lamps, and the app adapts to a light on nothing but capability presence and declared
metadata. The probe measures the same facts across every light in a house — so `OVERRIDE_TOLERANCE`
being 0.03 while §6 measured quantisation of 0.1 stops being a puzzle and becomes a count.

Two of its findings were named here because they could correct this documentation rather than just
describe a lamp. The first full run answered both, on 3 September 2026:

- **`MODE_NEEDS_DELAY` — answered, no.** §6 established that a lamp in the wrong `light_mode`
  discards the other axis, and the fix emits `light_mode` first. Nobody had checked whether emitting
  it *back-to-back* is enough, since `runFlush` leaves no gap at all. On the one lamp that does gate,
  it is: the value landed with no gap. What the same run found instead is bigger — **the gate is
  per-lamp**, present on one Hue bulb and absent on three others behind the same bridge, so §6 had
  been stating one lamp's behaviour as the platform's.
- **`ECHO_COUNT` — answered, the platform's.** §6 records that echoes arrive duplicated, and
  `ECHO_DEDUPE_MS` exists because of it. The app can hold two subscriptions to one lamp (a controller
  and a circadian light both subscribe) while the probe holds exactly one — and with one, echoes
  still arrived in ones AND twos. So the note is about the platform, and the further fact is that the
  doubling is not reliable: nothing may depend on a second echo.

And one it found that nobody had thought to look for: **a lamp can report `available: true` while
rejecting every write**, for eighteen minutes, with only its `light_mode` writes acking. That is an
app finding rather than a lamp one, and it is now `LightTargetAdapter.unwritableTargets()` feeding
`assessTargets()`. It also cost this run most of its own value — see below.

**What the run cost, and what was fixed because of it.** Both criticals and two of the three highs in
that first report were artefacts: four steps drew conclusions from writes that had been *rejected*,
so a nine-second timeout published as `ECHO_ACK_SLOW "acked in 9017ms"`, a failed write published
`ECHO_NONE` at high severity, and a lamp that accepted no temperature at all published
`MODE_DOES_NOT_GATE` — the finding whose whole purpose is to overturn §6. The per-driver cadence slot
went to the same dead lamp, so the run produced **no** cadence evidence for a working Hue bulb.
`PROBE_UNREACHABLE` now demotes such a lamp the way `PROBE_INTERFERENCE` demotes a driven one, its
earlier findings are marked inconclusive, rejected writes are kept out of the ack latencies, and the
cadence slot is claimed only once something was actually measured. The general rule the script had
already written down for itself and then broken: **a lamp that took no write reports whatever it was
already holding, so a gated axis and a dead radio look identical.**

**The second full run, 4 September 2026 — 33 lamps, and it found a bug in the app and one in
itself.** Most of it is confirmation and that is the result: every ladder came back `maxDelta: 0`,
monotone and not inverted on all four axes, quantisation 0 everywhere, no `RATE_*` finding, nothing
above medium. What it settled beyond that:

- **A lamp that refuses a colour while off was being counted against its own health.** Four of
  thirteen Hue bulbs behind one bridge decline a pre-stage write as "soft off" every time; a curve
  retries a failed write by design, so the refusal arrived once a minute for as long as the lamp was
  switched off and `unwritableTargets()` eventually reported four healthy lamps as not responding.
  Fixed both ways: the failure no longer counts (§6), and the runtime stops offering that lamp a
  colour after three refusals (§12).
- **The probe's own summary was counting findings it had already ruled void.** `finding()` pushed a
  shallow COPY into the flat array, so the two demotions — an unreachable lamp's earlier findings, and
  every finding from a lamp something else was driving — reached the per-lamp list and not the totals.
  14 of that run's 130 findings were demoted and counted anyway, one of them a critical. The array now
  holds the same objects, and `byCode`, `bySeverity`, the printed summary, the per-integration table
  and `--fail-on` all count measured findings only, with the demoted ones on their own line.
- **The `file:line` citations had rotted wholesale**, which is what a finding's whole value rests on:
  most of the 57 pointed at a blank line, a closing brace or unrelated code, including two the run
  cited in findings it produced. They now name a SYMBOL, and `probe-findings.test.ts` fails if a cited
  file is missing or no longer contains what is cited — which caught a constant moving between two
  modules within an hour of being written.

Output goes to `.probe/`, gitignored, as a raw report and a redacted sibling. The raw one is a
capture from a real Homey and falls under the same rule as `test/fixtures/raw/`; the redacted one
pseudonymises every id and strips every name, address and wall-clock time, and is not written at all
if anything identifying survives the scrub.

What it cannot answer is in the script's header and in every report under `cannotAnswer`. The
headline is that no script can tell whether a high `light_temperature` is physically **warmer** — a
driver that maps the axis backwards consistently reports plausibly and lights the room wrong — which
is why `probe-lights eyes` asks a person, once per integration, and records the answer as such.

Its own logic is covered by the suite rather than by hardware: `probe-findings.test.ts` proves the
verdict arithmetic against synthetic traces and fails if a finding does not cite the assumption it
violates, and `probe-shared-helpers.test.ts` holds the helpers it copied from `verify-hardware.mjs`
identical once each file's own comments are stripped — `capabilityValue` above all, because a
`getDevice` without `$cache: false` is served
a snapshot ([platform §15](homey-platform.md#15-homey-api-caches-every-getall-result-forever)) and
that defect has already fabricated three hardware quirks. The same file holds the key-material
promise for this script that `verify-hardware-safety.test.ts` holds for the other one, in the shape
this one needs: the probe writes every error it sees into a file, so the redaction has to happen on
the way in.

## Two things a picture caught that a test could not

Worth knowing before deciding a rendered screen is a luxury.

- **`npm run render:views`** draws every pairing screen with demo data (`scripts/pair-view-fixtures.mjs`) using headless Chrome, the same rasteriser `artwork/export-assets.py` uses. Output goes to `.views/`, gitignored.
- The Colour Curve Light's coloured dot set a `fill` **attribute**, which the view's own stylesheet
  overrode. Every assertion about the attribute passed while the dot drew in the wrong colour. Only
  the render showed it, and the fix was to set `style.fill` instead.
- The render is **not** the pairing sheet: Homey draws its own header and scroll container around a view (platform §8), and this shows the view alone.


## Lifecycle and sensor recovery (T91–T97)

T91–T97 are pending hardware checks; none was run during implementation. The previous release's
T81–T90 numbers remain retired — the paragraphs above that discuss T81–T84 and T87–T89 say so where
they do, and keep only the reasoning. The saved hardware observations are in the test plan's run
history.

| Checks | Automated evidence | Hardware evidence still needed |
|---|---|---|
| T91–T92 | Runtime integration tests use real sensor ownership and evaluation through pairing disconnect, restart and concurrent previews. | Sensor reports and SDK pairing/disconnect behavior on a Homey. |
| T93 | Sensor recovery tests advance backoff, replace the stale seed and cancel retries on last release. | Recovery against real connection failures. |
| T94–T95 | Scheduler and runtime tests cancel queued and captured writes, including off during handle acquisition and zone removal. | Integration-specific dispatch and echo timing. |
| T96 | Runtime tests fail after acquisition and delay refresh across stop; adapter tests reject late listeners and completions. | SDK resource behavior under a controlled startup failure. |
| T97 | Device transaction tests inject commit/rollback failures and delayed callbacks. | Store failures on a disposable, instrumented test device. |
