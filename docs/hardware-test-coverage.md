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
| `spike` | — | none. Answers whether the rest can run |
| `memory` | T59, T60 | none — read-only |
| `pair` | T5, T6, T7, T12, T13, T19, T20, T26, T77, T78 | builds one of each device type, its own even if you already have some. Reuses a marked one left by an earlier run. **T78 is where the `homey:manager:geolocation` permission is proved** — no unit test can reach it |
| `flows` | T2, T8, T16, T23, T30, T79 | none — read-only |
| `redaction` | T42–T45 | none. Searches the diagnostics report for both keys and a slice of each |
| `restart` | T1, T4, T31, T32, T34 | restarts the app |
| `bridge` | T33 | runs one generated Flow's action card |
| `schedule` | T13, T14, T15, T17, T18 | retimes a schedule and fires both boundaries, then restores its windows exactly |
| `preview` | T21, T22, T27, T28 | writes the current curve to the lamps, and probes one that is off |
| `rejoin` | T24, T25, T29 | switches a lamp off and on, and sets a colour by hand |
| `credential` | T35–T41 | removes the stored key and puts it back |
| `repair` | T46 | opens a repair session per device and reads its screens. Saves nothing |
| `teardown` | T47–T52, T80 | deletes only the devices this pass built (`[verify] …`) |
| `pairspike` | — | builds one throwaway circadian light over the API and deletes it |

`all` is the read-only four; `full` is the whole pass in order, ending in `teardown`.

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

**`memory` is the only line whose answer is a number rather than a state**, and it is here because
the app was 48 MB against Homey's 30 MB guideline — almost all of it `homey-api` retaining both
flow card catalogues for the life of the client (platform §15). It reads
`ManagerApps.getAppUsage` and `ManagerSystem.getMemoryInfo`, neither of whose response shapes is
described in `homey-api`'s specification, so `pssBytesIn()` searches for a PSS-shaped field and
reports SKIPPED with the keys it saw rather than guessing. T60 re-reads it at the end of `full`,
because the catalogues are read lazily: an app nothing has asked anything of yet looks thin
whatever it does with the answer.

**It fails on a ceiling, not on the guideline.** The app sits around 44 MB once anything has read
the trigger catalogue — one read costs ~12 MB of floor and V8 never returns those pages — against a
30 MB guideline it is deliberately over. So T59 prints the guideline and fails past 50 MB, because a
line that failed on every run is one nobody reads.

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
| `pair-view-behaviour.test.ts` | T15, and the old 2.2, 2.3, 2.6, 4.3, 5.2, 5.3, 5.6 — what each screen refuses and what it draws |
| `settings-page.test.ts` | the old 1.2 and 8.1 — five empty sections rather than five blanks, and five full ones. Plus the sky readout, which is the fastest check that geolocation resolved |
| `pair-view-boot.test.ts` | every view runs and asks the driver for its data |
| `repair-views.test.ts` | the `unknown_error_getting_file` that made Repair a dead end |
| `pairing-sessions.test.ts` | the one-light collapse, the default names, the remote picker |
| `pair-session.test.ts` | the pairing MECHANICS all five drivers share — the handler wrapper logging AND re-throwing, the sensor retain/release ref-count, save-and-name per device type, `nextView` per driver, the credential probe creating a folder and deleting it again, the curve preview's force-and-drain. **None of it was reachable before**: platform §13 means a file containing `extends Homey.Driver` cannot be imported by a test, so the daylight card's three handlers were guaranteed identical across four drivers by a comment. T87-T89 remain for what the SDK decides on the other side of the seam — whether Homey still routes each handler, still accepts the `createDevice` shape, and still finds a repair's device |
| `assets.test.ts` | T3's measurable half: five pictures, five distinct, correct sizes |
| `schedule-window.test.ts`, `schedule-bindings.test.ts` | midnight-crossing windows and their labels |
| `curve-colour.test.ts`, `circadian-curve.test.ts` | the shade between two coloured points |
| `solar-elevation.test.ts` | where the sun is, against values astronomy fixes independently of any implementation — declination at the poles, `90 −` the latitude gap at noon, hemispheric mirroring at an equinox, an hour per 15° of longitude |
| `daylight-runtime.test.ts` | that the daylight loop TERMINATES, and the slew limit's shape. Neither is watchable in less than ten minutes on hardware, which is why T83 and T84 still exist for the parts a real sensor decides |
| `luminance-source.test.ts` | one subscription per sensor however many devices name it, and what makes a reading unusable |
| `api-trying.test.ts` | the seven "try it now" routes the script drives |
| `verify-hardware-safety.test.ts` | the script never prints key material |

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

## What the script still cannot answer

**The daylight feature's three genuine gaps, and each is a different KIND of gap.**

- **A real permission.** `homey:manager:geolocation` either resolves on a Homey or it does not, and
  nothing but a Homey answers that. The script asks in T78 and reports the elevation it got; what it
  cannot do is tell a *plausible* number from a *correct* one, which is why T81 sends a person to
  NOAA's calculator with the same latitude and minute. A sign error survives every unit test in this
  repo, because those assert against invariants rather than against an almanac.
- **A real sensor.** What `measure_luminance` actually reports — its scale, its resolution and how
  often — is per-integration and is established nowhere (platform §16). The script deliberately
  selects NO sensor when it builds its own Daylight light: this pass builds and deletes its own
  devices and must not subscribe to a household's battery-powered motion sensor as a side effect.
  T82 is a person doing it on purpose, and the numbers they report are the only evidence the
  `darkLux` / `brightLux` defaults of 5 and 500 will ever have.
- **A real room, for ten minutes.** `daylight-runtime.test.ts` proves the loop terminates against a
  test double whose readings do exactly what the test says. It cannot prove the deadband is wider
  than the jitter of a particular sensor watching a particular wall, and that is the one number
  this device type lives or dies by. T83 is the measurement; there is no substitute for it and no
  point pretending otherwise.

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

**T66-T70 need a phone, and T66 is the important one.** They came out of the code review, and
`verify-hardware.mjs full` answers none of them:

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
| T55–T60 | The 0.5.0 release lines: the new Curve light, the two-question circadian light, the migration, two lamp-driving fixes, and the two memory readings | Retired when 0.5.1 rewrote **This release**, which is what that section is for. What they found is in the plan's *Last run* record; the memory readings are the ones worth keeping, and platform §15 carries the reasoning |
| T61–T65 | The 0.5.1 release lines: the store description, the changelog rendering as prose, and the flow-card icons in their 24px circles | Retired when 0.5.2 rewrote **This release**. They needed the published listing and no Homey at all; `npm run render:icons` reproduces the icon half locally, and `assets.test.ts` still owns the rules an icon must satisfy |

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
- The Curve light's coloured dot set a `fill` **attribute**, which the view's own stylesheet overrode. Every assertion about the attribute passed while the dot drew in the wrong colour. Only the render showed it, and the fix was to set `style.fill` instead.
- The render is **not** the pairing sheet: Homey draws its own header and scroll container around a view (platform §8), and this shows the view alone.
