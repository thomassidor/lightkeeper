# Commands

Every command this repository has, in the order you are likely to want them. Nothing here is new —
it is the same set that [`CLAUDE.md`](../CLAUDE.md), [`CONTRIBUTING.md`](../CONTRIBUTING.md) and each
script's own header already document, gathered in one place so you do not have to remember which
file it was in. Where a command has a trap, the trap is next to it and the fuller explanation is
linked.

Run everything from the repository root. First time on a machine: `npm install`.

## The everyday loop

```bash
npm test                       # unit tests: node --test + tsx. No Homey, no network
npm run test:coverage          # the same suite under coverage, with floors — what CI runs.
                               # Fails on a source file no test loads, not just a low number
npm run test:watch             # the same, re-run on save
npm run typecheck              # tsc --noEmit — the app only
npm run typecheck:test         # the suite and scripts/, via tsconfig.test.json
npm run lint                   # eslint, type-checked. eslint.config.mjs says what and why
```

One file, and one test inside it:

```bash
node --import tsx --test test/unit/ramp-engine.test.ts
node --import tsx --test --test-name-pattern="hard stop" test/unit/ramp-engine.test.ts
```

## The gate before a PR

This is [CI](../.github/workflows/ci.yml)'s own order, and the order matters in two places — the
comments in that file say why:

```bash
npm run typecheck
npm run typecheck:test
npm run lint
npm run build                  # tsc, then strip the evidence recorder unless .dev-build exists.
                               # The Homey CLI calls this itself; you rarely run it directly
npm run sync:views:check       # BEFORE the tests. CI never runs the writing version
npm run test:coverage          # the suite, once, with coverage floors
npm run validate               # regenerates app.json as a side effect
git diff --exit-code -- app.json   # so a stale committed manifest cannot pass
node scripts/build.mjs --verify  # the .homeybuild/ validate just left IS a launch build.
                               # Builds nothing; looks at the tree from outside
```

## Pair views

```bash
npm run sync:views             # pair -> repair, and shared views between drivers
npm run sync:views:check       # what sync WOULD copy; writes nothing, exits 1 on drift
```

**Edit `views/shared/` for anything that appears in more than one view** — the CSS base, `emit()`,
or the week grid — then run `sync:views`. Those blocks are spliced into their carriers with `#ROOT`
replaced by each view's own root id, so editing a view directly is overwritten on the next sync.
Two conventions in those source files, both learned by breaking them: the delimited CSS carries no
leading indentation, and a function source starts at `function` with no docblock above it.
`views/shared/` lives outside `drivers/` because the CLI treats every directory in there as a
driver, and `.homeyignore` keeps it out of the app archive.

Four whole views are shared too — `intro.html`, `lights.html`, `review.html` and `credential.html`
— and they are copied from the CONTROLLER into every other driver that declares them. They stay
driver-agnostic because the driver supplies the content and the next view in its reply, never the
view.

Edit a view under `drivers/*/pair/`, then run `sync:views` — **nothing runs it for you**, and
`npm test` fails on drift. Edit the *controller's* copy of a shared view, never another driver's. Every `repair/` folder is byte copies of its `pair/` because Homey needs a real file in
each place and will not follow a reference
([platform §8](homey-platform.md#8-repair-views-live-in-their-own-folder-and-validation-cannot-tell-you)).

## Looking at what the app draws

Neither of these is a check. Nothing passes or fails, nothing runs in CI — the screens' and icons'
*rules* are `test/unit/pair-view-behaviour.test.ts` and `test/unit/assets.test.ts`, which do fail.
These are contact sheets, for the one question a machine cannot answer.

```bash
npm run render:views                                   # every pairing screen -> .views/
node scripts/render-views.mjs --width 430 --open       # a phone width, and open the sheet
npm run render:icons                                   # every icon at the App Store's 24px box
node scripts/render-icons.mjs --open
node scripts/render-icons.mjs --reference <url-to-a-published-icon.svg>
```

`.views/index.html` is grouped by driver and, within a driver, follows the order that driver's own
`driver.compose.json` puts its `pair` steps in — so the sheet reads as five flows from step 1 rather
than as fifteen files in whatever order their names sorted. Each card is captured at its screen's
own height, which is why a long screen is long and a short one is not padded with white.

**Homey's own sheet is drawn around every screen**, and that is the point rather than decoration:
the container supplies a header and a `← Previous` / `Next →` footer for every step whose
`navigation` names one, so a render on a bare white page cannot show that a view is drawing a
SECOND Next below the fold — which is exactly what nine of them were doing. The buttons come from
each driver's own compose, never from a list here. The dashed line across a long screen is the fold
on an 812pt phone.

`intro.html`, `lights.html` and `review.html` are one file and five screens (platform §8), so each
is rendered per driver from `DRIVER_REPLIES` in `scripts/pair-view-fixtures.mjs`. Keyed by file name
alone the sheet drew the circadian intro five times and no other device type's was ever on it.

Both need headless Chrome — the house rasteriser, nothing to install — and write to `.views/`
(`.views/icons/` for icons), which is gitignored. 24px of ink in a 40px circle is
[platform §10](homey-platform.md#10-store-assets-what-is-validated-what-is-reviewed-and-what-homey-does-to-your-icon),
and why `render:icons` exists at all.

## Artwork

```bash
python artwork/export-assets.py                 # every shipped icon, image and the banner
python artwork/export-assets.py --skip-banner   # everything Chrome is not needed for
python artwork/export-assets.py --palette       # the brand hexes, read off the logo bitmap
python artwork/export-assets.py --measure       # recompute the icon fit numbers (needs Chrome)
python artwork/export-assets.py --weight drawn  # report the masters' own stroke weights
```

Needs Pillow. Nothing shipped is hand-edited: a change to a file under `assets/` or
`drivers/*/assets/` is lost on the next export. [`artwork/asset-spec.md`](../artwork/asset-spec.md)
is the brief.

## Test fixtures

```bash
node scripts/dump-card-fixtures.mjs   # test/fixtures/cards/*.json from the TS fixtures
```

By hand, and only when the hand-transcribed TS fixtures change. The JSON is the committed artefact
and `test/unit/card-fixtures.test.ts` fails on drift.

## On a real Homey

```bash
npm install -g homey           # the CLI, globally, for install/run/login
homey login
npx homey app install          # persistent install — use THIS for interactive testing
npm run validate               # homey app validate --level publish, CLI pinned via the lockfile
npx homey app run --remote     # live logs, TEMPORARY. See the two traps below
```

**Use `install`, not `run`.** `run` creates a debug session and **uninstalls the app when the CLI
exits**, taking the app's settings with it — including the stored API key. Pairing against an ended
session gives screens that render and do nothing.

**`--remote` is not optional on `run`.** Since CLI 3.x a bare `homey app run` runs the app in a local
Docker container; `--remote` uploads and runs it on the Homey, which is the only faithful context for
anything touching app-scoped permissions.

**`× Missing File` on install is a transient server-side refusal — retry the same command.** Do not
reach for `--clean`: three occurrences on the same Homey, and two of the recoveries did not involve
it. [CLAUDE.md → Running it on a real Homey](../CLAUDE.md#running-it-on-a-real-homey) has the table
and what was ruled out.

**`npm run validate` is the only local command that regenerates `app.json`**, so it is a required
release step and not just a check. `app.json` is generated from `.homeycompose/` — never hand-edit
it.

**Do not delete `package.json`'s `build` script.** Nothing in this repo calls it, but the Homey CLI
shells out to `npm run build` itself whenever it detects TypeScript, so removing it fails `validate`,
`install` and `run` alike with `Missing script: "build"` reported as
`× Typescript compilation failed`.

## The hardware pass

`node scripts/verify-hardware.mjs <command…>` answers most of
[`docs/hardware-test-plan.md`](hardware-test-plan.md) against a real Homey.
[`hardware-test-coverage.md`](hardware-test-coverage.md) says what covers what. Output is one line
per test-plan line in the plan's own `Tn OK` form, so it pastes straight into a report; the exit code
is 1 if anything failed. Every number it prints is looked up in
[`hardware-test-coverage.md` → Every line the script reports](hardware-test-coverage.md#every-line-the-script-reports).

```bash
node scripts/verify-hardware.mjs spike            # can it reach a Homey at all? Default command
node scripts/verify-hardware.mjs memory           # PSS, the machine's free memory and swap,
                                                 # and the app's own heap with three boot marks
node scripts/verify-hardware.mjs flows redaction  # several at once
node scripts/verify-hardware.mjs all              # every read-only command
node scripts/verify-hardware.mjs full --yes       # the whole pass, in the plan's order
node scripts/verify-hardware.mjs full --yes --json temp/verify.json  # and a JSON record
node scripts/verify-hardware.mjs full --yes --strict   # a SKIPPED line fails the run too
node scripts/verify-hardware.mjs control --yes --house # "Test my lights" on the whole house
```

Read-only, no confirmation needed: `spike`, `memory`, `flows`, `redaction`, `settings` — this is
`all`.

| Flag | What it does |
|---|---|
| `--yes` | confirms a command that changes the Homey |
| `--json <path>` | also writes every result line, the installed and checkout versions, the firmware and the build shape (dev or launch) to a file. No key and no address in it — but device and room names, as the terminal report has them, so it is a capture: keep it under the gitignored `temp/`. Written even when the run is interrupted, marked so |
| `--strict` | a `SKIPPED` line fails the exit code too — for a dedicated test Homey, where "nothing to test against" is itself the fault. On a household Homey a skip is usually the house, so it is off by default |
| `--house` | lets `control` test every lamp in the house, room by room and then all at once. Without it `control` tests the lamps in `room` only, and with no `room` set it refuses rather than guessing |

Everything else changes your Homey and needs `--yes`; run without it and the script prints exactly
what each one would do, then refuses.

| Command | What it does |
|---|---|
| `pair` | **creates** one of each of the five device types, its own even if you already have some |
| `flowcards` | runs the `set_lights` action and the `daylight_is_dark` condition over this pass's own devices, switching up to two lamps in `room` that none of your own devices drives; puts them back |
| `repairsave` | **saves** one small edit through repair on each device this pass built, reads it back from a fresh repair session, and saves the original again |
| `jobs` | reads a Light Remote's "On – with Lightkeeper" job and its two source pickers through a repair session. Saves nothing |
| `control` | the review screen's control choice and "Test my lights" — each tested lamp blinks once and is put back. In `room` only, unless `--house`; repairs this pass's own curve and circadian devices |
| `schedule` | replaces a schedule's windows and fires them; restores both afterwards |
| `preview` | writes the current curve to your lamps, and probes one that is off |
| `rejoin` | switches one of your lamps off and on, and sets a colour on it by hand |
| `restart` | restarts the Lightkeeper app — every Lightkeeper device is briefly unavailable |
| `bridge` | runs one of your generated Flows, which switches lights |
| `credential` | removes the app's stored API key and puts it back. Needs a **second** key |
| `repair` | opens a repair session on each device and reads its screens. Saves nothing |
| `teardown` | **deletes** the devices this pass built, and nothing else. Not reversible. Then only READS the orphan preview, for T180 |
| `pairspike` | the one-off probe that proved pairing over the API works ([platform §14](homey-platform.md#14-pair-sessions-are-a-web-api-surface-and-pairing-can-be-scripted)). Never in `full` |

`full` is `spike memory pair flows settings schedule preview rejoin flowcards restart bridge
credential redaction repair repairsave jobs control teardown`, in that order. `spike` goes first
because it is also T178: whether the installed app is the version this checkout builds, and whether
it is a dev or a launch build — every line after it is about the installed build, not this code. At
the end, `full` prints every unticked plan line it did not answer (`*` where it answered part), read
from `docs/hardware-test-plan.md` itself.

**Ctrl-C puts back what the pass changed, then exits.** Every change — the app's API key, a lamp
switched or set by hand, a schedule's windows, name and switch, a device's control mode, a repair's
edit — registers an undo before it is made, and an interrupt runs all of them, newest first. Press it
twice to skip that. A command that throws is reported `FAILED`, its leftovers are put back, and the
next command still runs — so one timeout no longer ends a pass before `teardown`.

**The trap on `memory`: the PSS number is the least reliable thing the pass prints.** Three restarts
of one identical build read 71.4, 73.9 and 80.1 MB, and an unmodified build from five days earlier
measured the same as HEAD on the same Homey — so take **three readings, restarting between each**,
read it on a freshly installed app, and only ever compare it with a reading from the same house on
the same day. `T128` prints the machine's free memory and swap for exactly this reason; under about
15% free, the number says more about the Homey than about the app. **`T129` — the app's own
`heapUsed` and its per-space split — is the reading that can actually catch a regression**, because
PSS cannot tell holding a parsed catalogue from having parsed one. See
[platform §15](homey-platform.md#15-homey-api-caches-every-getall-result-forever).

**It only ever touches its own devices.** Everything it builds is named `[verify] …`, every command
selects from the marked ones, and `teardown` re-checks the mark against the Homey immediately before
each permanent delete. A device you paired is never selected, written to or deleted.

**The trap on `control`: it switches lamps that are ON off, to test them.** That is what the review
screen's own test does, and it is why the command stays in `room`. It used to blink every colour lamp
in the house; now the whole house takes `--house`, typed.

### Configuration

Either environment variables:

```bash
HOMEY_ADDRESS=http://192.168.1.23
HOMEY_API_KEY=<this script's own key>
HOMEY_APP_KEY=<the key the app holds>     # only `credential` needs it
HOMEY_TEST_ROOM=<a zone name>             # containment for the lamp writes. Worth setting
```

…or `scripts/hardware-env.json` — `{ "address": …, "key": …, "appKey": …, "room": … }` — which is
**gitignored**, because a Personal API Key is a credential and nothing from a real Homey gets
committed.

**Two keys, and they must be different.** A key holds a single live session and concurrent holders
evict one another ([platform §2](homey-platform.md#2-api-key-sessions-die-routinely)), which is why
the app's key and the script's key are separate. `credential` is where that goes from likely to
certain: it removes the app's key over a connection authenticated with the key it is removing, so it
refuses rather than half-finishing. Asked for by name it throws; swept in by `full` it is dropped
with a `SKIPPED` line. The script's key needs **full** access, and a key's permissions cannot be
widened after it is created.

### What no script can reach

A finger on a remote (T9-T11), and eyes on a screen (T3, T53, T54). The first page of
[`hardware-test-plan.md`](hardware-test-plan.md) is what is left for a person: mint the keys, press
the remote three ways, look at the contact sheet. The upgrade path (T179) is a person's too, on a
dedicated test Homey — the plan line has the procedure, and
[`hardware-test-coverage.md`](hardware-test-coverage.md#what-the-script-still-cannot-answer) says why
it is not a command.

## Reading the app's diagnostics

`node scripts/diagnostics.mjs` fetches the app's own `/diagnostics` from a real Homey and prints a
digest — one block per device, then a list of anything worth a second look. It is read-only: one GET,
nothing written to the Homey. Address and key come from `HOMEY_ADDRESS` + `HOMEY_API_KEY` or
`scripts/hardware-env.json`, exactly as `evidence.mjs` and `verify-hardware.mjs` do.

```bash
node scripts/diagnostics.mjs                     # the digest
node scripts/diagnostics.mjs --raw               # the whole document to stdout
node scripts/diagnostics.mjs --save              # whole document into temp/, digest to stdout
node scripts/diagnostics.mjs --save report.json  # …or to a path you name
```

**The digest is the default on purpose.** The raw document from a six-device house is around a
megabyte: sixty recorded actions and up to a hundred and twenty control events per runtime, nearly
all of them identical ticks. The digest keeps the fields that a real capture has ever turned on —
a lamp's `ignoredWrites` and `approachingWrites`, an override and how old it is, a pre-stage backoff
and when it lifts, a sensor that has gone quiet, a device that is not `ready`, a credential that has
stopped working. If none of them are set it says so in one line.

**The trap:** what `--save` writes is a capture from a real Homey — device names, zone names, the
owner's display name — so `temp/` is gitignored for the same reason `/test/fixtures/raw/` is. Do not
move one out of there without reading it first.

Counters reset when the app restarts, which `npm run build`, `homey app install` and a Homey reboot
all do. A dump taken a minute after an install says nothing about the night before it.

## Recording a week at home

`node scripts/evidence.mjs <command…>` drives the opt-in evidence recorder on a real Homey:
`start`, `stop`, `status`, `export`, `note`, `clear`, `analyze`. It records control decisions,
sensor and light reports, write results, once-a-minute health samples and observations you type,
as an encrypted archive in the app's own `/userdata`.

**None of it is in the launch app.** A normal build strips the code, the six Web API routes and the
settings section, so there is nothing to start. Create a `.dev-build` file at the repo root before
installing to get a build that has it:

```powershell
New-Item .dev-build          # bash: touch .dev-build
npx homey app install        # prints a DEV BUILD banner
```

Delete it and install again to go back. It is gitignored and sticky, every build says which kind it
made, `scripts/build.mjs` is the switch, and `lib/support/evidence-feature.ts` explains the design.
Install persistently — a `homey app run` session is not suitable for an unattended week.

Start and stop from Homey → Lightkeeper → app settings. The page does not poll: a saved-record
count that has not moved on a page you left open means nothing until you press **Refresh recording
status**.

```powershell
node scripts/evidence.mjs status
node scripts/evidence.mjs export
node scripts/evidence.mjs analyze .evidence/<recording-file>.ndjson.gz
node scripts/evidence.mjs note "Kitchen lamp kept getting brighter after I turned it on"
node scripts/evidence.mjs stop
node scripts/evidence.mjs clear <recording-id-from-status>
```

It takes the same connection configuration as the hardware pass — `HOMEY_ADDRESS` plus
`HOMEY_API_KEY`, or the gitignored `scripts/hardware-env.json`. **Use the SECOND Personal API Key,
not the one the app holds:** a key carries one session
([platform §2](homey-platform.md#2-api-key-sessions-die-routinely)), so exporting over the app's own
key interrupts the run you are exporting. Exporting while a run continues is fine — the export fixes
an endpoint before reading, so it is a consistent prefix — and an existing destination file is never
overwritten. Archives land in the gitignored `.evidence/`, carry device and room names, and go
nowhere on their own.

**Read `malformed` first.** It counts records in the archive that will not parse, and it is the one
number the recorder itself cannot see: a run reporting `dropped: 0` and `error: null` still lost 93
of 58,024 records, because redaction was mangling them on the way in. Any non-zero `malformed` means
the timeline is incomplete whatever the manifest claims.

The limits, none of which the settings page states:

| | |
|---|---|
| a run ends | after seven days, on a manual stop, on a storage error, or at **64 MiB** of archive |
| pending buffer | 512 KiB; a record over **32 KiB**, or past that buffer, is counted as dropped |
| flush | compressed, encrypted and written every **15 s** — a power loss takes the unflushed tail, and restart recovery discards any uncommitted tail and records its size |
| a full archive | is kept, never rotated away. Starting a new run refuses to overwrite it; `clear` is explicit |

**Memory is not in an archive.** `process.memoryUsage()` throws inside the app sandbox
([platform §17](homey-platform.md#17-the-app-sandbox-no-rss-and-onuninit-does-not-finish)), so every
sample carries `memory: null`. Read the footprint from outside with
`node scripts/verify-hardware.mjs memory`.

The archive is encrypted because `/userdata` is served without authentication (§17): each compressed
batch is AES-256-GCM, the random key lives in app settings, and downloads go through the
authenticated app API. Neither the key nor any API credential is ever part of an export.

## Probing the lights

`node scripts/probe-lights.mjs <command…>` walks the lights on a real Homey and reports which of
them break the assumptions the output path is built on — each finding naming the assumption, its
`file:line`, and the measurement behind it. It is not a pass, nothing here gates a release, and it
runs in no CI: the app's own rules are the unit suite, which does fail. This produces evidence,
which is what a per-vendor strategy table would have to be designed from.

```bash
node scripts/probe-lights.mjs                          # inventory of the configured room. Default
node scripts/probe-lights.mjs plan --all               # what a full run would do. Writes NOTHING
node scripts/probe-lights.mjs inventory --all          # every light's declared metadata, read-only
node scripts/probe-lights.mjs full --yes               # the battery, configured room
node scripts/probe-lights.mjs full --yes --all         # the battery, whole house. Slow
node scripts/probe-lights.mjs full --yes --quick --all # one lamp per integration
node scripts/probe-lights.mjs axes modes --yes --light "Desk lamp"
node scripts/probe-lights.mjs eyes --yes --all         # the one question a machine cannot ask
```

Read-only, no confirmation needed: `inventory` and `plan`. The write phases are `echo`, `offphase`,
`axes`, `modes`, `stress` and `eyes`; `full` is all of them except `eyes`. Run a write phase without
`--yes` and it prints, one sentence each, what every phase would do to the household, then refuses.

Selection: `--zone <name>`, `--light <name|id>`, `--driver <substring>` (all repeatable),
`--all`. Scope: `--quick`, `--sample N`, `--stress-all`. Also `--max-minutes N` (default 45),
`--repeat N`, `--stop-on-error`, `--json <path>`, `--redacted <path>`, `--no-json`,
`--fail-on <severity>`.

**It writes to lamps you paired yourself, and it cannot do otherwise.** The hardware pass confines
itself to devices it created and named `[verify] …`; a lamp is somebody's light, it cannot be
marked, and probing it means writing to it. So the containment here is different in kind: one lamp
at a time, read first and restored afterwards with the restore **verified** capability by
capability, at most one lamp ever mid-battery, and a failed restore reprinted at the end as a list
of lights to set by hand.

**The default scope is `HOMEY_TEST_ROOM`, and `--all` is deliberately typed rather than defaulted.**
A corpus wants the whole house — one Hue bulb tells you about Hue, not about the Ikea driver in the
hall — but a new destructive script should not reach a child's bedroom by accident. House-wide runs
outside 08:00-22:00 print a warning and carry on; a guard you have to defeat every evening becomes a
`--force` that lives in your shell history.

**Each lamp goes dark for about twenty seconds** while `offphase` asks what it does with a value
written while off — platform §6's three outcomes, and a fourth nobody had looked for. Power is
transitioned once per lamp and restored the moment that phase ends.

**`inventory` is the dry run, and the mode worth running on somebody else's Homey.** No `--yes`, no
writes at all, and it already produces every metadata finding: declared ranges the app would
mis-clamp, a resolution coarser than the circadian override tolerance, `setable: false` on something
the app writes, a colour-only lamp that an all-temperature curve writes nothing to.

**A lamp that rejects three writes in a row is demoted and its battery stops.** `PROBE_UNREACHABLE`,
the sibling of `PROBE_INTERFERENCE`: every step here reads what a lamp *reports* to decide what a
write did, and a lamp that took no write reports whatever it was already holding — so a gated axis
and a bulb switched off at the wall look identical. Findings already emitted for that lamp are marked
`inconclusive`, and rejected writes are kept out of the ack latencies (their durations go to
`latency.<capability>.failed`, which is time-to-error and worth its own number). The first full run
is why: one unreachable Hue bulb produced both criticals and two of the three highs.

**A device that refuses to be switched off is never switched on.** `PROBE_ONE_WAY_POWER`, and it is
the only finding here about the RUN rather than about a lamp. A Synology NAS answered the off write
with `Device is always-on`, was switched on one step later for the echo measurement, and then refused
both writes that would have put it back — a one-way change to somebody's house, with the evidence
that it could not be undone arriving one write earlier. The guard lives in the single function every
write goes through, so a new step cannot forget it.

**The restore writes brightness LAST.** On a lamp found off the snapshot's `dim` is 0, and a Hue
treats a `dim` of 0 as soft off: written first, it made the bridge refuse every colour and
temperature write behind it, and two bulbs ended a run in the wrong colour. The axis that can gate
the others goes after them.

**A stopped run says so, in the report.** `stopped` names the reason and how far it got, each lamp
carries `probed`, and the per-integration rollup counts probed lamps rather than selected ones. A
run cancelled after fifteen of fifty-four used to roll up as "Philips Hue: 35 lamp(s)".

**The per-driver cadence slot goes to a lamp that actually measured something.** `stress` runs once
per integration, because a bridge is shared. It used to claim the slot before running, so the first
lamp on a driver took it whatever became of it — and lamps are walked in id order.

**Every code a run produced is explained in the report itself**, under `findingsCatalogue`: the
severity, the headline and the assumption with its `file:line`. Anything `high` or worse also prints
its assumption in the summary. That text used to live only in this script's source.

**Findings never fail the run.** They are the product, not errors. Exit 1 means a restore failed or
the probe itself did — in either case a person has to look. `--fail-on <severity>` if you want
otherwise.

**Reports go to `.probe/`, which is gitignored, and there are two of them.** The raw one names your
devices and rooms; the `.redacted.json` sibling pseudonymises every id and strips every name,
address and wall-clock time while keeping all the physics, and is the one to share. Ids are
pseudonymised rather than deleted, consistently, because the trace has to stay followable — the same
reason [`test/fixtures/README.md`](../test/fixtures/README.md) gives. If anything identifying
survives the scrub, the redacted file is **not written** and the run says so.

Configuration is the hardware pass's, above — the same `scripts/hardware-env.json` and the same
environment variables — with one difference: this needs **one** key, and it warns loudly if that key
is the one the app holds, because a key holds a single live session
([platform §2](homey-platform.md#2-api-key-sessions-die-routinely)).

It also asks the app, best-effort, which lamps a live circadian, Curve or schedule device is driving
right now, and names them. Our writes look like a human override to those devices, and a curve drops
an overridden lamp until it is power-cycled. It tells you and changes nothing: a script that
silently switches off your lighting automation to get a cleaner number is worse than the number is
good.

### What the probe cannot answer

**Whether a high `light_temperature` is physically warmer.** There is no colorimeter. It can prove
the axis is monotone, that the reported value is not the inverse of the written one, what the
effective range is and how coarse it is — but a driver that maps the axis backwards *consistently*
is invisible to any amount of API traffic, so `eyes` asks a person, once per integration.

Nor anything about perception, nor whether a lamp is physically on, nor time-to-light, nor anything
upstream of the write. `stress` reproduces the scheduler's cadence; it does not run the scheduler, so
a `RATE_` finding is a fact about the lamp and not proof the app misbehaves — the coalescer may well
mask it. And one run is one sample: `--repeat N` exists for that. The full list is in the script's
own header and in every report, under `cannotAnswer`.

## Releasing

The full checklist is [CLAUDE.md → Releasing a version](../CLAUDE.md#releasing-a-version) — the
version lives in four files and every user-visible change ships three changelog entries. **The
version number itself only moves when somebody asks for it**; a changelog entry goes under the
version that is already there. The commands, in order:

```bash
# 1. edit the three changelogs, and docs/hardware-test-plan.md's "This release"
#    section. .homeycompose/app.json and package.json ONLY if a bump was asked for
npm run validate                              # regenerates app.json — required, not a check
npm test                                      # release-metadata + compose-manifest catch the drift
node scripts/verify-hardware.mjs full --yes   # the pass, on real hardware
npx homey app publish
```

`npm run validate` before `npm test`: `validate` is what rewrites `app.json`, and
`test/unit/compose-manifest.test.ts` is what fails if it has drifted from `.homeycompose/`.
`test/unit/release-metadata.test.ts` fails if the four version numbers disagree
(`package-lock.json` counts), if any changelog is missing the current version, or if a stated test
count no longer matches the suite.

`homey app publish` uploads `README.txt` as the App Store long description — not `README.md`. No test
touches it, so re-read it on any release that changes how the app is positioned.

## Auditing dependencies

```bash
npm audit --omit=dev
```

`--omit=dev` is the meaningful run: devDependencies are not bundled into a Homey app, and the pinned
CLI brings a large tool tree that never reaches one. The shipped tree's four accepted moderate
findings, and why each pin is what it is, are in
[CLAUDE.md → Pinned versions](../CLAUDE.md#pinned-versions-and-why-each-one-is-pinned).
