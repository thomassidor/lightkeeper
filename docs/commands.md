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
| `pair` | **creates** one of each of the four device types, its own even if you already have some |
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
