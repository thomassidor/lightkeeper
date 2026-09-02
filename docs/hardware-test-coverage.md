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
| `pair` | T5, T6, T7, T12, T13, T19, T20, T26 | builds one of each device type, its own even if you already have some. Reuses a marked one left by an earlier run |
| `flows` | T2, T8, T16, T23, T30 | none — read-only |
| `redaction` | T42–T45 | none. Searches the diagnostics report for both keys and a slice of each |
| `restart` | T1, T4, T31, T32, T34 | restarts the app |
| `bridge` | T33 | runs one generated Flow's action card |
| `schedule` | T13, T14, T15, T17, T18 | retimes a schedule and fires both boundaries, then restores its windows exactly |
| `preview` | T21, T22, T27, T28 | writes the current curve to the lamps, and probes one that is off |
| `rejoin` | T24, T25, T29 | switches a lamp off and on, and sets a colour by hand |
| `credential` | T35–T41 | removes the stored key and puts it back |
| `repair` | T46 | opens a repair session per device and reads its screens. Saves nothing |
| `teardown` | T47–T52 | deletes only the devices this pass built (`[verify] …`) |
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
| `settings-page.test.ts` | the old 1.2 and 8.1 — four empty sections rather than four blanks, and four full ones |
| `pair-view-boot.test.ts` | every view runs and asks the driver for its data |
| `repair-views.test.ts` | the `unknown_error_getting_file` that made Repair a dead end |
| `pairing-sessions.test.ts` | the one-light collapse, the default names, the remote picker |
| `assets.test.ts` | T3's measurable half: four pictures, four distinct, correct sizes |
| `schedule-window.test.ts`, `schedule-bindings.test.ts` | midnight-crossing windows and their labels |
| `curve-colour.test.ts`, `circadian-curve.test.ts` | the shade between two coloured points |
| `api-trying.test.ts` | the six "try it now" routes the script drives |
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

**T25 — "a value set by hand is left alone" — depends on having a lamp that accepts one.**
Both Studio lamps refuse an external `light_temperature` write while accepting the app's own: the
app writes 0.96 and the lamp holds 0.95, but a direct write of 0.75 to the same lamp does not move
it, and the check confirms the app wrote nothing in the window. So the property cannot be exercised
there — a user changing the warmth by hand in the Homey app would hit the same refusal.

The check reports this as SKIPPED with that reasoning rather than as a pass or a failure, and
separates it from the case that WOULD be a failure: if the app writes over a hand-set value inside
15 seconds, it says so and fails. The override behaviour itself is covered by
`circadian-runtime.test.ts`.

To exercise it on hardware, point the pass at a room whose lamps take an external temperature write
— `room` in `scripts/hardware-env.json`.

**T9-T11 need a finger on a remote**, and always will. `bridge` proves dispatch, mapping,
attribution and the write path by running the generated Flow's own action card; it cannot produce
the physical release event that the 10-second ramp stop exists for.

**T3 and T53-T54 need eyes.** `assets.test.ts` proves four distinct pictures at the right sizes;
whether they look right is not a machine's question.

**T61-T65 need the published listing**, and no Homey at all. They are read off homey.app after a
publish to the test channel, because the store is what they are about: the description's length and
clamping, the changelog rendering as prose, and the flow-card icons inside their 24px circles
(platform §10). `npm run render:icons` answers the substance of T63 locally — it draws every icon at
that size with the store's own markup and CSS — but it is a reproduction, and T64 exists to check
the reproduction against the real thing. `assets.test.ts` still owns the rules an icon must satisfy;
neither script nor sheet passes or fails.

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

## Retired lines

Kept here so an old report that says `3.8 OK` is still readable, and so nobody re-adds them. The numbers are not reused.

| Line | Was | Why it went |
|---|---|---|
| 3.8 | An overnight midnight-crossing window switches off at the right time, and its Flow reads `Off at 01:30 (starts Fri)` | `schedule-bindings.test.ts` asserts that exact string, and `schedule-window.test.ts` covers the arithmetic. The only residue was "Homey's cron card fires on the minute", measured at ~11–22 ms and recorded in `homey-review-notes.md`. It cost an evening and taught nothing |
| 5.5 | Two coloured points, checked for a shade between them | `curve-colour.test.ts` covers the interpolation. The hardware residue — a lamp accepting the hue — is T27 |
| 9.2–9.4 | Repair each of the four device types | The failure it names — `unknown_error_getting_file` — is `repair-views.test.ts`. Whether each screen comes back seeded from the stored plan is the `repair` command, which covers all four under T46 |
| T55–T60 | The 0.5.0 release lines: the new Curve light, the two-question circadian light, the migration, two lamp-driving fixes, and the two memory readings | Retired when 0.5.1 rewrote **This release**, which is what that section is for. What they found is in the plan's *Last run* record; the memory readings are the ones worth keeping, and platform §15 carries the reasoning |

## Two things a picture caught that a test could not

Worth knowing before deciding a rendered screen is a luxury.

- **`npm run render:views`** draws every pairing screen with demo data (`scripts/pair-view-fixtures.mjs`) using headless Chrome, the same rasteriser `artwork/export-assets.py` uses. Output goes to `.views/`, gitignored.
- The Curve light's coloured dot set a `fill` **attribute**, which the view's own stylesheet overrode. Every assertion about the attribute passed while the dot drew in the wrong colour. Only the render showed it, and the fix was to set `style.fill` instead.
- The render is **not** the pairing sheet: Homey draws its own header and scroll container around a view (platform §8), and this shows the view alone.
