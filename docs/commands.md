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
npm run sync:views:check       # BEFORE the tests. CI never runs the writing version
npm test
npm run validate               # regenerates app.json as a side effect
git diff --exit-code -- app.json   # so a stale committed manifest cannot pass
```

## Pair views

```bash
npm run sync:views             # pair -> repair, and shared views between drivers
npm run sync:views:check       # what sync WOULD copy; writes nothing, exits 1 on drift
```

**Edit `views/shared/` for anything that appears in more than one view** — the CSS base, `emit()`,
or the daylight card — then run `sync:views`. Those blocks are spliced into every pair view, with
`#ROOT` replaced by each view's own root id, so editing a view directly is overwritten on the next
sync. `views/shared/` lives outside `drivers/` because the CLI treats every directory in there as a
driver, and `.homeyignore` keeps it out of the app archive.

Edit a view under `drivers/*/pair/`, then run `sync:views` — **nothing runs it for you**, and
`npm test` fails on drift. Edit the *controller's* copy of a shared view, never the schedule's or a
light's. Every `repair/` folder is byte copies of its `pair/` because Homey needs a real file in
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
is 1 if anything failed.

```bash
node scripts/verify-hardware.mjs spike            # can it reach a Homey at all? Default command
node scripts/verify-hardware.mjs memory           # PSS against Homey's 30 MB guideline
node scripts/verify-hardware.mjs flows redaction  # several at once
node scripts/verify-hardware.mjs all              # every read-only command
node scripts/verify-hardware.mjs full --yes       # the whole pass, in the plan's order
```

Read-only, no confirmation needed: `spike`, `memory`, `flows`, `redaction` — this is `all`.

Everything else changes your Homey and needs `--yes`; run without it and the script prints exactly
what each one would do, then refuses.

| Command | What it does |
|---|---|
| `pair` | **creates** one of each of the five device types, its own even if you already have some |
| `schedule` | replaces a schedule's windows and fires them; restores both afterwards |
| `preview` | writes the current curve to your lamps, and probes one that is off |
| `rejoin` | switches one of your lamps off and on, and sets a colour on it by hand |
| `restart` | restarts the Lightkeeper app — every Lightkeeper device is briefly unavailable |
| `bridge` | runs one of your generated Flows, which switches lights |
| `credential` | removes the app's stored API key and puts it back. Needs a **second** key |
| `repair` | opens a repair session on each device and reads its screens. Saves nothing |
| `teardown` | **deletes** the devices this pass built, and nothing else. Not reversible |
| `pairspike` | the one-off probe that proved pairing over the API works ([platform §14](homey-platform.md#14-pair-sessions-are-a-web-api-surface-and-pairing-can-be-scripted)). Never in `full` |

`full` is `spike memory pair flows schedule preview rejoin restart bridge credential redaction repair
teardown`, in that order.

**It only ever touches its own devices.** Everything it builds is named `[verify] …`, every command
selects from the marked ones, and `teardown` re-checks the mark against the Homey immediately before
each permanent delete. A device you paired is never selected, written to or deleted.

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
the remote three ways, look at the contact sheet.

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
version lives in four files and every user-visible change ships three changelog entries. The
commands, in order:

```bash
# 1. edit .homeycompose/app.json, package.json, the three changelogs,
#    and docs/hardware-test-plan.md's "This release" section
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
