# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository. This file holds the
architecture, the conventions and the release process. **The Homey platform reference — how the
platform actually behaves, seventeen numbered sections established against real hardware — lives in
[`docs/homey-platform.md`](docs/homey-platform.md), and the code cites it as `platform §n`.** Read
it before changing anything that talks to Homey; [the map is below](#the-homey-platform-reference-lives-in-docshomey-platformmd).

Documentation for everyone else: [`README.md`](README.md) and [`FAQ.md`](FAQ.md) for users,
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contributors, [`docs/README.md`](docs/README.md) as the
index of everything.

Lightkeeper is a Homey Pro app that does four things to already-paired lights: it turns an
already-paired remote, switch or dial into a controller for them, it puts them on a schedule, it
follows the colour of the day with them, and it sets their brightness from how much light is
already in the room.

**Five device types, four jobs.** The first two — a light controller and a light schedule — work
by generating and maintaining the Flows underneath, which is why they need a Personal API Key
(platform §1). The third job has TWO device types, and they are the same engine: a **circadian
light** divides the day into three zones — morning, midday, evening — anchored to the Homey's own
sunrise and sunset, and a **Curve light** exposes the whole curve — every point, every time, and a
colour from a closed palette instead of a warmth at any point. The fourth job is a **Daylight
light**: it reads ONE `measure_luminance` sensor the household already owns, or the sun's own
elevation computed from the Homey's position (platform §16), and holds its lights at a brightness
that depends on how light it is already. **None of those three generates Flows at all**
(platform §12): they watch the lights themselves and write to them directly, so none needs a
key, none has a `needs_credential` state, and none appears in the orphan sweep's live set.

**Each job belongs to exactly one device type, and that is a change.** Until 0.6.0 a schedule
window, a circadian end and a curve point could each say `fromDaylight` and borrow the fourth job
inline, which put the same sensor picker and lux range on four different pairing screens and gave
two device types two different daylight behaviours to explain. It is gone: a brightness is a
number, and a brightness that follows the room is what a Daylight light is for.

## Commands

```bash
npm test                       # unit tests via node --test + tsx. No hardware needed.
npm run typecheck              # tsc --noEmit, the app only
npm run typecheck:test         # the suite and scripts/, via tsconfig.test.json
npm run lint                   # eslint, type-checked. See eslint.config.mjs for what and why
npm run validate               # homey app validate --level publish, CLI from the lockfile
npx homey app install          # persistent install on a real Homey
npx homey app run --remote     # live logs, TEMPORARY — see below
npm run sync:views             # splices views/shared/ into every pair view, then pair -> repair
                               # and shared views between drivers. See platform §8
npm run sync:views:check       # what sync WOULD copy; writes nothing, exits 1 on drift. CI runs it
npm run render:views           # draw every pairing screen to .views/ — needs Chrome, not CI
npm run render:icons           # draw every icon at the App Store's 24px box. Chrome, not CI
python artwork/export-assets.py   # re-export every shipped icon, image and the banner
node scripts/evidence.mjs status        # is a seven-day recording running, and how big?
node scripts/evidence.mjs export        # pull the archive down and decrypt it locally
node scripts/verify-hardware.mjs spike       # can the script reach a real Homey at all?
node scripts/verify-hardware.mjs memory      # PSS against Homey's 30 MB guideline. Read-only
node scripts/verify-hardware.mjs full --yes  # MOST of the hardware pass — NEEDS a real Homey.
                                             # Builds and deletes its OWN devices only
node scripts/probe-lights.mjs plan --all     # what a probe run WOULD do. Writes nothing
node scripts/probe-lights.mjs inventory --all   # every light's declared metadata. Read-only
node scripts/probe-lights.mjs full --yes --all  # the quirks battery, on YOUR OWN lamps. Slow
```

[`docs/commands.md`](docs/commands.md) is the same set written out for a human to look things up in
— every flag each script takes, the hardware pass command by command, and the trap that goes with
each one.

**`package.json`'s `build` script is not ours to remove, and it is no longer just `tsc`.** It looks
unused — nothing in this repo calls it — but the Homey CLI shells out to `npm run build` itself
whenever it detects TypeScript, so deleting it fails `validate`, `install` and `run` alike with
`Missing script: "build"` reported as `× Typescript compilation failed`, which names neither the
script nor npm.

Being the CLI's only hook is exactly why `scripts/build.mjs` sits behind it now. **The seven-day
evidence recorder is a development tool and is built OUT of the launch app**: `install`, `run`,
`validate` and `publish` all call `npm run build` identically, so there is no way to strip on
publish alone — the default has to be stripped, and the recorder is opted back in.

```bash
New-Item .dev-build      # or `touch .dev-build`. Gitignored, sticky, announced loudly
npx homey app install    # -> the recorder is built in
Remove-Item .dev-build
npx homey app install    # -> launch shape: no recorder, no routes, no settings section
```

A launch build replaces the compiled `evidence-feature.js` with its disabled twin, deletes
`evidence-recorder.js` and `evidence-sampler.js`, strips the settings page's delimited section and
removes the six routes from the packaged `app.json` — then PROVES it, failing the build if anything
still names the recorder. `lib/support/evidence-feature.ts` is the one module `app.ts` and `api.ts`
may name, and its header is where the design is written down.

Run a single test file: `node --import tsx --test test/unit/ramp-engine.test.ts`

## Layout

```
app.ts                          app entry, bridge action listeners, validation on receipt
api.ts                          app Web API: what settings/index.html renders, plus seven
                                "try it now" routes over the runtimes
lib/
  homey-api-service.ts          both API clients, subscription tracking and teardown
  credential-service.ts         the API key: storage, write-validation, failure classification
  device-catalog.ts             devices, zones, owning apps, capability metadata
  flow-card-catalogue.ts        the ONE reader of the flow card catalogues, and the ONE place
                                that knows homey-api retains every getAll result (platform §15)
  source-discovery-service.ts   trigger card discovery, event-surface fingerprints
  inputs/                       input contract, normalizer, magnitude collapse
  mapping/                      mapping engine, supersede gate, behaviour types
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine,
                                target resolver, target-state cache
  bridge/                       binding compiler, flow bridge manager, flow folders
  runtime/                      controller runtime, manager, health monitor, shared target
                                health, and the visible-state holder all four runtimes compose.
                                verdict.ts is the RANKING that composes what reconciliation
                                learned with what the lights say — worst wins, ties to the one
                                that names an action; control-diagnostics.ts is the bounded
                                per-runtime history of control passes and power events
  profiles/                     profile schema, migrations
  schedules/                    types, window maths, local clock, bindings, runtime, manager,
                                time-card discovery, migrations
  circadian/                    the curve ENGINE, shared by two device types: curve types and
                                cyclic interpolation, the 24-colour palette, the three-zone
                                simple plan and its sun-anchored boundaries, runtime, manager,
                                and one migration chain per store
  daylight/                     the brightness-from-the-room engine: NOAA solar elevation AND
                                sunrise/sunset times (pure, no Homey imports), the response and
                                its two ramps, the app-level ref-counted sensor subscription, the
                                evaluator, runtime, manager, migration chain. sensor-history.ts
                                buckets a sensor's Insights week into the 7 x 12 grid the pairing
                                screens draw — pure apart from the one reader that fetches it
  devices/                      the device layer: DeviceLifecycle (plain, testable) and
                                LightkeeperDevice (the Homey.Device shell) — see platform §13
  time/                         wall-clock minutes and the Homey's local clock
  validation/                   guards, the four plan validators, pairing DTO checks
  pairing/                      the light picker, the SENSOR picker, the remote picker, the
                                buttons screen's rows and the default device names — every
                                pairing DECISION, lifted out of driver.ts so it can be tested
                                (platform §13). flow-screens.ts answers the two views every
                                driver shares — the intro and the review — from a payload the
                                driver supplies, so the step count and the review rows are the
                                only thing a driver writes. press-listener.ts is press-to-find:
                                a bounded live subscription on every remote in the house.
                                pair-session.ts is the same lift for the MECHANICS: the handler
                                wrapper, the sensor retain/release ref-count, the light picker's
                                two handlers, save-and-name, the credential pair and the curve
                                preview — each of which was the same block in four or five
                                drivers
  support/                      the primitives every layer uses: the per-KEY mutex and the
                                single-flight coalescer, the bounded ring log, the migration-chain
                                runner, the injectable Timers seam, error-shape classification,
                                field-wise equality, fire-and-forget. NOT the queue that gates
                                lamp writes: that is DeviceQueue, inside command-scheduler.ts.
                                KeyedMutex serialises subscribe/unsubscribe, device-lifecycle
                                operations and flow folders instead
    evidence-sink.ts            the ONE seam between anything producing evidence and whatever
                                consumes it. A file of its own so a runtime depends on a
                                signature, never on the recorder that implements it today
    evidence-feature.ts         THE WHOLE RECORDER, as one module — the only one app.ts or
                                api.ts may name, routes included. Read its header first
    evidence-feature-disabled.ts  its twin, and what a LAUNCH build actually ships: same
                                exports, no recorder. scripts/build.mjs substitutes it
    evidence-recorder.ts        opt-in seven-day recording: gzip + AES-256-GCM batches appended
                                to /userdata, the key in homey.settings, every record stripped
                                and redacted on the way in. OFF costs one object literal per
                                event. See docs/week-long-testing.md
    evidence-sampler.ts         what a periodic health sample is made of
  app-contract.ts               what api.ts and the device layer may use of the app
  homey-api-types.ts            the DEVICE and ZONE shapes homey-api returns, at the one
                                seam that normalises them. The flow and card seams read `any`
drivers/controller/             virtual device, driver, and the LONGEST flow: intro, credential,
                                1 remote, 2 lights, 3 buttons, 4 review, plus two pushed screens
                                (job, listen). It owns the authored copy of all four SHARED views
  pair/                         eight views. intro/lights/review/credential are the shared four,
                                edited HERE and copied into the other drivers by sync:views
  repair/                       exact copies of pair/, generated — see platform §8
drivers/circadian/              three zones of the day, anchored to the sun. NO credential screen
  pair/                         intro, 1 lights, 2 day, 3 review, plus the pushed tryit. day.html
                                and tryit.html are its own; the rest are the controller's
  repair/                       exact copies of pair/, generated — see platform §8
drivers/curve/                  the FULL one: every point, and a colour per point. NO credential
                                screen
  pair/                         intro, 1 lights, 2 curve, 3 review. curve.html is its own
  repair/                       exact copies of pair/, generated — see platform §8
drivers/daylight/               brightness from the room, and the ONLY device type that reads a
                                sensor. NO credential screen
  pair/                         intro, 1 lights, 2 sensor, 3 response, 4 review, plus the pushed
                                sensordetail. Three of its own; the rest are the controller's
  repair/                       exact copies of pair/, generated — see platform §8
drivers/schedule/               virtual device, driver. Needs the key, so it has the credential
                                screen
  pair/                         intro, credential, 1 lights, 2 blocks, 3 review. Only blocks.html
                                is its own — see platform §8
  repair/                       exact copies of pair/, generated — see platform §8
scripts/build.mjs               `npm run build`, which the Homey CLI calls for install, run,
                                validate AND publish alike. Runs tsc, then — unless `.dev-build`
                                exists — strips the evidence recorder out of .homeybuild and
                                verifies none of it is left. The switch, and the only hook there is
scripts/sync-views.mjs          makes every copy named above; nothing runs it for you
scripts/verify-hardware.mjs     most of the hardware pass. Talks to a REAL Homey over its OWN
                                Personal API Key — needs HOMEY_ADDRESS + HOMEY_API_KEY, and
                                HOMEY_APP_KEY for `credential`. TWO keys: one session per key
                                (platform §2). Names everything it builds `[verify] …` and
                                never creates, renames or deletes a Lightkeeper device it did
                                not build. It DOES switch the lamps its own devices point at —
                                fifteen setCapabilityValue calls, all behind `--yes`, all
                                restored — so read that as a promise about DEVICES, not lamps
scripts/probe-lights.mjs        every light on a REAL Homey, pushed until it misbehaves. Reports
                                findings — each naming the assumption it breaks and its file:line —
                                so a per-vendor strategy table could be designed from evidence
                                rather than from one Homey. NOT a pass: nothing gates a release,
                                nothing runs in CI. Needs ONE key, and it writes to lamps you
                                paired: one at a time, snapshot first, restore verified. Default
                                scope is HOMEY_TEST_ROOM; --all is typed, never defaulted. Reports
                                to .probe/ (gitignored), raw plus a redacted sibling
scripts/render-views.mjs        every pairing screen to a PNG, plus a contact sheet. Headless
                                Chrome, the same rasteriser artwork/export-assets.py uses
scripts/render-icons.mjs        every icon at the size the App Store draws it — 24px of ink in a
                                40px circle (platform §10). The contact sheet that catches an icon
                                too fine or too busy to read there
scripts/evidence.mjs            start | stop | status | export | note | clear | analyze against a
                                REAL Homey's recorder. Needs a Personal API Key; use the SECOND
                                one to export while a run continues (platform §2). Reports to
                                .evidence/ (gitignored)
scripts/pair-view-fixtures.mjs  the demo data those renders use, one entry per view
scripts/dump-card-fixtures.mjs  writes test/fixtures/cards/*.json from the hand-transcribed TS
                                fixtures. Run BY HAND, only when those change; the JSON is the
                                committed artefact and card-fixtures.test.ts fails on drift
scripts/hardware-env.json       GITIGNORED. A Homey address and two Personal API Keys, read by
                                verify-hardware.mjs when the env vars are not set
views/shared/                   NOT bundled. The one authored copy of each block that appears
                                in more than one pair view — the CSS base and emit() in all 56,
                                the week grid's CSS and weekGrid() in the two daylight screens
                                that draw it. `npm run sync:views` splices them in
settings/index.html             app settings page
locales/en.json                 all user-facing strings
.homeycompose/                  the manifest's SOURCE; app.json is generated from it
assets/                         the app's own icon and store images, all generated
README.txt                      the App Store long description — not README.md
test/                           unit tests and hand-transcribed fixtures
docs/                           NOT bundled. `docs/README.md` indexes it
  homey-platform.md             the platform reference, cited in code as `platform §n`
  privacy.md                    the privacy notice
  homey-review-notes.md         for Athom's reviewer
  localisation.md               English-only on purpose; how to add a language back
  hardware-test-plan.md         the standing pass on a real Homey: what to DO, and how to report
  hardware-test-coverage.md     what covers what — the script, the suite, and the retired lines
  commands.md                   every command in one place, with the trap that goes with each
  evidence-findings.md          WHAT ONE REAL RECORDING FOUND: six defects with the numbers
                                behind each, and the two things that only looked like defects
  week-long-testing.md          the opt-in seven-day recorder: what it captures, what it does
                                NOT, and how to read an archive back
  history/                      ARCHIVE: the completed 0.5.0 remediation project
artwork/                        NOT bundled. Every graphic's source, and its own two docs
  masters/                      every graphic's source
  export-assets.py              builds every shipped icon and image from those
  asset-spec.md                 the brief: what to draw, at what size, and why
  provenance.md                 where it came from, the rights register, the recorded gaps
README.md  FAQ.md  CHANGELOG.md  CONTRIBUTING.md
                                the four end-user / contributor documents, none bundled
```

---

# The Homey platform reference lives in `docs/homey-platform.md`

Seventeen numbered sections on how Homey actually behaves — every one established against real
hardware (Homey Pro 2023, firmware 13.4.0, homey-api 3.19.2) and documented nowhere else. **Read it
before changing anything that talks to Homey.** It used to be the middle of this file; it moved out
so that a human developer could find it under a name that says what it is.

**Code cites it as `platform §n`.** Over 150 comments across `lib/`, `app.ts`, `api.ts` and the
tests carry one — `(platform §6)` means section 6 of that file. Keep writing them that way, and grep
`platform §` to find everything that depends on a given fact.

| § | What it settles |
|---|---|
| [1](docs/homey-platform.md#1-an-apps-own-token-cannot-write-flows) | An app's own token cannot write Flows — hence the Personal API Key and the two separated clients |
| [2](docs/homey-platform.md#2-api-key-sessions-die-routinely) | API key sessions die routinely; the three 401/403 failures mean different things |
| [3](docs/homey-platform.md#3-never-construct-a-flow-card-uri) | Never construct a flow card URI — enumerate and echo it back |
| [4](docs/homey-platform.md#4-device-trigger-cards-are-found-by-card-id-not-by-uri) | Device trigger cards are found by card **id**, not by URI |
| [5](docs/homey-platform.md#5-token-encoding) | Token encoding: `droptoken` is top-level, identity is `token.id` |
| [6](docs/homey-platform.md#6-capability-behaviour) | Capability behaviour — duplicated echoes, and **higher `light_temperature` is warmer** |
| [7](docs/homey-platform.md#7-reference-device-event-surfaces) | The four reference remotes and how differently they behave |
| [8](docs/homey-platform.md#8-repair-views-live-in-their-own-folder-and-validation-cannot-tell-you) | Repair views need their own folder, and `validate` cannot tell you |
| [9](docs/homey-platform.md#9-time-comes-from-the-flow-engine-because-the-sdk-has-no-scheduler) | Time comes from the Flow engine, because SDK v3 has no scheduler |
| [10](docs/homey-platform.md#10-store-assets-what-is-validated-what-is-reviewed-and-what-homey-does-to-your-icon) | Store assets: an icon is a CSS mask, and the validator checks far less than the guidelines |
| [11](docs/homey-platform.md#11-flow-folders-nest-and-every-lookup-must-key-on-name-parent) | Flow folders nest; every lookup must key on (name, parent) |
| [12](docs/homey-platform.md#12-a-circadian-light-generates-no-flows-and-that-is-the-whole-design) | A circadian light generates no Flows, and that is the whole design |
| [13](docs/homey-platform.md#13-requirehomey-only-resolves-on-a-homey-and-that-shapes-the-device-layer) | `require('homey')` only resolves ON a Homey — why the device layer is split in two |
| [14](docs/homey-platform.md#14-pair-sessions-are-a-web-api-surface-and-pairing-can-be-scripted) | Pair sessions ARE a Web API surface — pairing and repair can be scripted |
| [15](docs/homey-platform.md#15-homey-api-caches-every-getall-result-forever) | `homey-api` caches every `getAll` result forever — which is where 30 MB of a 48 MB footprint went |
| [16](docs/homey-platform.md#16-geolocation-and-the-sun-the-sdk-will-not-compute-for-you) | Geolocation, and the sun the SDK will not compute for you — plus why a lux sensor must not go through the light seams |
| [17](docs/homey-platform.md#17-the-app-sandbox-no-rss-and-onuninit-does-not-finish) | The app sandbox: `process.memoryUsage()` throws, `onUninit`'s `await` never finishes, and `/userdata` is served without authentication |

# Working on this codebase

## Running it on a real Homey

**Use `homey app install` for interactive testing, not `homey app run`.** `run` creates a debug
session and **uninstalls the app when the CLI exits**, taking its app settings with it — including
the stored API key. Pairing against an ended session gives screens that render but do nothing,
because the handlers are gone.

**`--remote` is not optional on `run`.** Since CLI 3.x a bare `homey app run` runs the app in a
local Docker container. `--remote` uploads and runs it on the Homey, which is also the only
faithful context for anything touching app-scoped permissions.

**`Missing File` on install is a transient server-side refusal. RETRY IT, plainly.** The whole error
is:

```
× Missing File
```

It names nothing, arrives after every local step has passed, and comes from the Homey — the string
appears nowhere in `node_modules/homey/` or `node_modules/homey-lib/`, which is checkable in one
grep and worth doing before believing anything else about it.

Three observations on the same Homey, and the third is the one to act on:

| When | What was run | Outcome |
|---|---|---|
| 0.4.0, ~24 Aug 2026 | plain `install` failed; `install --clean` | succeeded |
| 0.4.0, 25 Aug 2026 | `install --clean` failed; plain `install` | succeeded |
| 0.5.1, 2 Sep 2026 | plain `install` failed; **plain `install`** | succeeded |

So `--clean` is not the variable. Two of the three recoveries did not involve it, and in the middle
row it was the thing that failed. **Retry the same command; do not reach for `--clean`.**

The third occurrence was investigated properly rather than shrugged at, and what it ruled out is
more useful than what it found:

- The build tree was verified coherent BEFORE retrying — every `lib/*.ts` compiled with none missing
  and none stale, `app.js`/`api.js`/`app.json` present, every driver's two entry points, pair and
  repair view counts matching per driver, and all fifteen `app.json` asset paths present. **Checked
  case-exactly**, against real directory listings: `fs.existsSync` and Python's `os.path.exists` are
  case-INSENSITIVE on Windows, so a check built on them proves nothing about a Linux Homey. No
  mismatch, and no two files differing only by case.
- The strongest structural candidate was **affirmatively excluded**, not merely doubted. The archive
  really does ship `tsconfig.test.json` (and `eslint.config.mjs`, and dev-only `package.json`
  scripts) carrying references to `test/`, `scripts/` and a `tsconfig.json` that are not in it —
  because the CLI's ignore list is the literal name `tsconfig.json`, not a `tsconfig*` glob. But the
  byte-identical file was in the 0.4.0 tree that installed successfully in the table above, ten
  packed `node_modules` tsconfigs carry the same class of dangling `extends`, and nothing on the
  device reads a tsconfig at all. It is inert: worth knowing, not worth fixing, and **not** a remedy
  to try against a live Homey.

`preprocess()` wipes `.homeybuild` on every run regardless, so `--clean` was never what makes the
build fresh: it is passed through to `devkit.runApp` as a flag about the app's data ON the Homey.
That is the real reason to leave it alone — a clean install is the one that can take the stored API
key with it, and a plain install demonstrably does not: the 2 September retry came back with
`credential: present=true valid=true` intact.

## Releasing a version

**Never bump the version unless you were explicitly asked to.** Not as the tidy end of a change, not
because a fix "feels like a patch", not because this file's checklist below exists. Land the work,
write the changelog under the version that is already there, and say that a bump is available if
wanted. Nothing here has been published yet, so a bump buys nobody anything and costs an entry
somebody later has to merge away: 0.6.1, 0.7.0 and 0.7.1 were all created, documented in three
changelogs each, and then folded back into 0.6.0 by hand. **"Add a changelog entry" is not "bump the
version"** — the entry goes under the current version.

When a bump IS asked for, everything below applies.

The version lives in **four** places and a release is only coherent when all of them agree —
`release-metadata.test.ts` fails if any disagrees:

| File | Role |
|---|---|
| `.homeycompose/app.json` | the source of truth |
| `package.json` | must match it |
| `package-lock.json` | must match it too, in BOTH the top-level `version` and the `""` package entry. `npm install` updates it; a hand-edited `package.json` alone leaves it behind |
| `app.json` | **generated** — never hand-edit; the CLI rewrites it from `.homeycompose/` on every `validate`, `build` and `install` |

Every user-visible change ships a changelog entry, in **three** places with three different
audiences. Three is deliberate rather than sloppy: the store entry, the full record and the front
page's summary are read by different people looking for different depths.

| File | Audience | Depth |
|---|---|---|
| `.homeychangelog.json` | what Homey shows in the app store. Keyed by the exact version string | plain user language — what changed for them, never file names or internals |
| `CHANGELOG.md` | anyone reading the repo | the full entry. May say *why*, and may name the mechanism |
| `README.md` → `## Changelog` | the front page | the CURRENT release in about four bullets, plus one line for the release just dropped off the top. Nothing more — this section going long is what made the old README unreadable |

And one file that is not a changelog but drifts like one: **`README.txt` is the App Store long
description**, which `homey app publish` uploads as the listing body (`README.<lang>.txt` per
language). It is not `README.md`, no test touches it, and nothing else in the repo references it — so
re-read it on every release that changes how the app is positioned, or the store says something the
repo stopped saying.

**The checklist, in one commit:**

1. Bump `.homeycompose/app.json` and `package.json` to the same version — **only when the bump was
   asked for**; see above. Patch for fixes, minor for new capability; pre-1.0 means no major bumps
   for breaking changes, so say it in the changelog instead.
2. Add a `.homeychangelog.json` entry under that exact version.
3. Add the full entry to `CHANGELOG.md` as `## <version>`, newest first.
4. Condense it into `README.md`'s `## Changelog`: the new release in about four bullets, and the
   previous one demoted to a single line in the table below it.
5. Update the **This release** section of `docs/hardware-test-plan.md` — what is new or risky this
   time, as things to do — and run that pass on hardware.
   `node scripts/verify-hardware.mjs full --yes` answers most of it;
   [`docs/hardware-test-coverage.md`](docs/hardware-test-coverage.md) says what covers what.
   Test lines are numbered `T1`, `T2`, … and **a number is never reused**: the release lines you
   write here carry on from the highest one already used, and last release's are deleted rather
   than renumbered. `hardware-test-coverage.md` keeps the map back to the old `section.line` scheme.
   **If dependabot has a `homey-api` bump open, this is the step that decides it** — either take it
   with this pass and move the pin (`package.json`, the two mentions in this file, the header of
   `docs/homey-platform.md`, and `ci.yml`'s comment), or say on the PR why not. Green CI is not
   evidence for that one dependency; hardware is.
6. Run `npm run validate` — this is what regenerates `app.json`, so it is a required step and not
   just a check. Commit the regenerated `app.json` with the rest.
7. Re-read `README.txt` if anything about what the app *is* changed.
8. `npm test`. `test/unit/release-metadata.test.ts` fails if the four versions disagree
   (`package-lock.json` counts), if any of the three changelogs is missing the current version, or if
   `README.md`, `FAQ.md` or `docs/hardware-test-plan.md` states a test count that no longer matches
   the suite.
   `test/unit/compose-manifest.test.ts` fails if `app.json` has drifted from `.homeycompose/` —
   which `validate` would otherwise repair silently in step 6.

`.homeychangelog.json` keeps the `{ "en": … }` object form for the same reason every other
user-facing string does: adding a language stays a sibling key (see the localisation note below).

## Pinned versions, and why each one is pinned

Everything here is pinned to what was actually verified on hardware. Changing any of it means
re-running the hardware pass list, not just re-running CI.

**The firmware is the one thing in this list nobody pins, and it moves on its own.** The reference
Homey was on 13.4.0-13.4.1 when everything below was verified, and was observed on **13.5.0-rc.4** on
2 September 2026 — so the pins did not change and their justification quietly aged. That is not a
reason to repin anything; it is a reason to re-derive a platform fact when it surprises you rather
than trusting the note. §9 has been re-checked against 13.5.0-rc.4 and one row of its card table had
gone stale (`cron:every` is now `cron:every_nth`, with a different shape); the card this app actually
depends on, `cron:time_exactly`, is unchanged and is still the only card matching the shape match.
Nothing else in the reference has been re-checked.

- **`homey-api` is pinned exactly at `3.19.2`** — no caret. This is the version verified on
  Homey Pro 2023, firmware 13.4.0 (and still installing and connecting fine on 13.5.0-rc.4). Its `engines.node` says `>=24`, which npm only *warns* about
  (`EBADENGINE`); the package runs fine on the Node the Homey actually has and on Node 22 locally.
  A review recommended downgrading to `3.17.3` purely on the strength of that field — **do not**,
  on that evidence alone: it swaps a version proven on real hardware for one that never has been.
- **CI runs Node 22**, to stay near current firmware. The CLI is a devDependency at exactly
  `homey@4.4.3` and `validate` runs it from the lockfile: an unpinned `npx homey` changes what
  "publish-level valid" means between two runs of one commit, and even a pinned `npx homey@4.4.3`
  leaves the CLI's own transitive tree free to move.
- **`eslint` is at `^10`, and its Node floor is stricter than the app's own.** It declares
  `^20.19.0 || ^22.13.0 || >=24`, so a local 22.12 gets an `EBADENGINE` warning on install (eslint
  10.9.1 then ran clean on 22.12 anyway — the warning is npm's, not a refusal). `package.json`'s
  `engines.node: >=20.11` describes the app running on a Homey and does not cover the linter; CI's
  `node-version: 22` resolves to current 22.x and satisfies the floor. The bump was takeable because
  `typescript-eslint@8.68.0` already declares `eslint ^10.0.0` in its peers — unlike the TypeScript
  major that arrived in the same dependabot PR, which its peer range forbids outright.
- **A `typescript` major is gated by `typescript-eslint`, not by us.** `typescript-eslint@8.68.0`
  declares `typescript >=4.8.4 <6.1.0`, so TypeScript 7 cannot be installed beside it at all:
  `npm ci` fails on the peer conflict before a single file is compiled, which is what took
  dependabot's grouped PR #4 red. `.github/dependabot.yml` ignores typescript majors for that
  reason, and the signal to lift it is typescript-eslint's own next major saying it supports one.
- **`compatibility: >=12.9.0`** — the floor we can stand behind, rather than the older `>=12.3.0`
  that was never tested. Note this is a *firmware* floor; the real hardware floor is Homey Pro
  2023 and newer, because earlier models cannot mint an API Key at all (platform §1).
- **`category: ["tools", "lights"]`.** Apps holding `homey:manager:api` are reviewed as Tools-style
  cross-app functionality — `homey app validate` says so itself: *"using the homey:manager:api
  permission will require a more thorough review"*. `lights` stays second for discoverability.
- **`npm audit --omit=dev`: four moderate findings, zero high or critical, all accepted.** The
  `--omit=dev` matters: devDependencies are not bundled into a Homey app, and the pinned
  `homey` CLI brings a large tool tree of its own (17 findings, 5 of them high, through `sharp`
  and `libvips`) that never reaches a Homey. The four below are the SHIPPED tree, and they are
  one chain —
  `parseuri` → `engine.io-client` → `socket.io-client` — reached only through `homey-api`, which is
  our single runtime dependency. There is no upstream fix to take, the endpoint being parsed is the
  fixed `http://127.0.0.1:80` from `getLocalUrl()`, and npm's suggested remediation is a downgrade
  of `homey-api` itself. Leave it, and re-check at each dependency bump.
- **`homey-api` is not MIT.** Its LICENSE reads: *may be used freely with Homey products; source
  proprietary to Athom B.V.; no warranty*. Bundling it in a Homey app is exactly the permitted use,
  but it does not inherit this repo's MIT licence and belongs in the rights register as its own line.

## Two of the five device types share one flow lifecycle

(The other three — a circadian light, a Curve light and a Daylight light — generate no Flows at all
and appear nowhere below. See platform §12.)

`FlowBridgeManager` takes `BindableInput` — `{ key, label, binding, variantKey? }` — not
`SelectableInput`. A schedule has no physical control, no action and no magnitude, but it does have a
key, a label and a `flow_fixed` binding, so both device types share one implementation of
idempotency, attribution, user-edit detection, orphan sweeping and deletion. `SelectableInput`
satisfies the narrower type structurally, so no controller call site changed.

Two traps in that shared path, both now covered by tests:

- **Anything that can change inside a trigger's ARGUMENTS while the binding key stays the same must
  appear in the variant key.** Reuse is keyed on (controller, binding key, variant key) plus the
  fingerprint, and a reused Flow's trigger is never rewritten — so a schedule retimed from 22:00 to
  23:00 kept its old Flow and went on firing at 22:00 while every screen said otherwise. Schedule
  bindings therefore carry `variantKey: 'at:HH:MM'`.
- **`hasBeenUserEdited()` compares trigger arguments too.** Without it, a user who changed the time in
  the Flow editor left the trigger card and our action arguments untouched, so the app read the Flow as
  its own and ignored the edit. It only compares keys we generated: Homey may echo back more than it
  was given, and a superset is not an edit.

## Conventions

**Comments explain why.** Module headers give the rationale, and inline comments record which bug a
guard prevents. Match that density — it is the main reason this code is navigable.

**Every Homey entry point uses `module.exports`.** `app.ts`, `api.ts` and every `driver.ts` and
`device.ts` are loaded by the Homey runtime with `require()`, and it reads the module's export
directly — `export default` produces `{ default: … }`, which the loader does not unwrap, and the app
simply does not start. `lib/` is ordinary ESM-syntax TypeScript and exports normally; the boundary is
exactly the files Homey loads by convention rather than by import.

Two consequences that look like awkwardness and are not:

- **There is no class type to import from `app.ts`.** `lib/app-contract.ts` writes the app's public
  surface down by hand instead, and `app.ts` assigns its class to that type before exporting it — so
  removing a member the contract promises fails at compile time rather than as `undefined` inside a
  settings-page handler.
- **A file containing `extends Homey.Device` cannot be imported by a test.** `require('homey')`
  resolves to the CLI in `node_modules`, whose main executes the CLI; the SDK module exists only on a
  Homey. `@types/homey` supplies the types, so `tsc` is happy and any test that imports such a file
  dies with `Class extends value undefined`. That is why the device layer is split:
  `lib/devices/device-lifecycle.ts` holds every rule and takes its host as an argument, and
  `lib/devices/lightkeeper-device.ts` is the `Homey.Device` shell that forwards five entry points.

**`any` at Homey API boundaries is deliberate.** `homey-api` ships JavaScript with JSDoc rather than
type declarations. Everything of ours is strict — `strict: true`, `noImplicitOverride: true`.

**Translation belongs to the device layer.** `lib/` has no access to `homey.__`, so anything
user-facing produced there returns a locale key plus tokens — `StateDetail` in
`lib/profiles/controller-profile.ts`, `labelKey` on a `PaletteColor` — and the driver or device layer
resolves it. A string hardcoded in `lib/` can never be translated, no matter what the locale files
say. `DeviceOwner.translate()` is that boundary for the device layer; a driver calls `homey.__`
directly.
`test/unit/locales.test.ts` enforces the invariant in both directions: no defined key unused, no
referenced key undefined.

**The app ships English only, and the machinery to change that is intact.** Danish was removed
(0.1.0) because maintaining two languages doubled the cost of every copy change before anyone had
asked for the second one. What was *not* removed: the `StateDetail` key-passing above, every
`data-i18n` attribute, and the `{ "en": … }` object form of every manifest field — so adding a
language is a sibling key, never a reshape. `locales.test.ts` discovers `locales/*.json` from disk
rather than importing a second language by name, so its key-parity and `__token__` checks re-arm by
themselves the moment a file is added. See `docs/localisation.md` for the full re-add list and the
English–Danish glossary kept from the removed translation.

**Pair views share ONE document.** The views under `drivers/*/pair/` are injected into the pairing
container's document rather than getting their own iframe. They must not load `homey.js` themselves,
every CSS rule is scoped to the view's root id, and the boot guard lives on the root element rather
than in a global. Each file's header explains this.

**The shared blocks are GENERATED, and `views/shared/` is where they are authored.** The CSS base
and `emit()` appear in every view file; the week grid — its own CSS and `weekGrid()` — appears in
the two daylight screens that draw a sensor's history. (`wc -l views/shared/*` for the sizes: they
are quoted nowhere, deliberately, because three places once carried three stale numbers.) All of it
used to be authored by hand in every copy, under an in-file instruction to "edit this block in all
files, or in none of them", with `test/unit/pair-view-styles.test.ts` asserting they stayed
identical. `npm run sync:views` now splices them from
`views/shared/{base.css,emit.js,week-grid.css,week-grid.js}`, substituting each view's own root id
for `#ROOT` — the same normalisation that test does in reverse.
**Edit the source, never the view.** `npm run sync:views:check` fails in CI until they agree.

Two conventions the splicer imposes on those source files, both learned by breaking them: the
delimited **CSS** source carries no leading indentation (the splicer indents it into place, and a
source that arrives pre-indented drifts from its copies by exactly that), and a **function** source
starts at `function` with no docblock above it (the splicer matches the function, so a docblock
outside it is not copied and the two files then differ).

`views/shared/` sits OUTSIDE `drivers/` because the CLI treats every directory under `drivers/` as a
driver and fails pre-processing with `ENOENT: … driver.compose.json`; `.homeyignore` keeps it out of
the archive, since nothing on a Homey reads it.

On-disk duplication is unchanged and has to be — Homey needs a real file per folder and will not
follow a reference (platform §8). What changed is that a human edits one file instead of thirteen.
A real `<link>`/`<script src>` may yet be possible: the Homey does serve a sibling file next to a
pair view (measured, platform §8). What is unmeasured is whether an injected view's own external
reference loads once the pairing container has placed it in the shared document.

The other shared helpers — `stabiliseScrollbar()`, `node()`, `clear()`, `pad()` — are
byte-identical **wherever they appear**, which is not everywhere: a view that draws no list needs
no `clear()`. The test asserts that weaker, correct property rather than demanding all of them in
all of them.

Both tests discover views from disk, so a new driver's screens are covered the moment they exist.

**No view assigns `innerHTML`, and that is a stronger guarantee than the one it replaces.** Two
used to: the old schedule screen built a window's card as a string and the old curve screen built a
point's, so every interpolated value had to go through `escapeHtml()` and the safety test carried an
allowlist of the two. The rewrite builds nodes everywhere, which took the last `innerHTML` in the
app and `escapeHtml()` with it. `test/unit/webview-safety.test.ts` keeps the allowlist machinery
with an EMPTY allowlist — "not this way" said out loud is clearer than an absence — and fails if any
view defines `escapeHtml` again, since a copy left behind would mean a screen had gone back to
building markup.

**Every screen the app draws is LIGHT, and does not ask the OS.** Homey paints the pairing sheet
and the settings frame itself, and paints them light whatever the phone's colour scheme says. Every
view used to carry a `@media (prefers-color-scheme: dark)` block restating the whole palette, so a
phone in dark mode got our dark cards and pale text drawn inside Homey's white panel — the media
query was asking the OS about a surface the OS does not own. There is no query that reports the
container's own colour, so the honest answer is to match the one panel Homey actually draws. The
colour TOKENS stay, because they are what makes a palette change one edit rather than five;
`test/unit/pair-view-styles.test.ts` fails if a scheme query reappears in any view.

**Edit a pair view, then run `npm run sync:views`.** Every `repair/` folder holds byte copies of its
`pair/`, and four views — `intro.html`, `lights.html`, `review.html` and `credential.html` — are
byte copies of the CONTROLLER's, in every driver that declares them, because Homey needs a real file
in each place (platform §8). Edit the controller's copy of a shared view, never another driver's.
`npm test` fails on drift and names the script; nothing runs it for you.

Three of those four are answered by a payload rather than by shared code: a driver returns
`{ title, blurb, hero, decisions[], nextView }` from `getIntro` and `{ stepIndex, stepCount, rows[],
promise }` from `getReview`, and `lib/pairing/flow-screens.ts` is where both are built. That is what
lets five different flows — three steps or four, with or without a credential screen — share one
file each rather than five near-copies.

**Tests use `node --test` with `tsx`.** No framework. Fixtures in
`test/fixtures/reference-devices.ts` are transcribed from the four remotes above; the expected
normalised catalogues are authored by hand in the test files, so the tests prove the normalizer
rather than the fixture.

**Never commit captures from a real Homey.** They carry device and zone names, the owner's display
name and Athom user ID, and notification text from existing flows. `/test/fixtures/raw/` is
gitignored. See `test/fixtures/README.md`.

## Safety properties worth preserving

Load-bearing product guarantees, not implementation details:

- **Ramps hard-stop after 10 seconds.** Not configurable, deliberately not read from settings.
  Release events are routinely dropped on Zigbee and unreliable on Matter/Thread, so a stuck ramp is
  a certainty rather than a risk.
- **A positive brightness is never written as darkness.** Brightness is stored perceptually and
  written in device values through γ = 2.2, so the bottom of the axis is where quantisation bites:
  5% becomes `dim` 0.0014, which `decimals: 2` rounds to 0.00. `MINIMUM_BRIGHTNESS` (0.10) is the
  floor the three brightness sliders start at and the three migration chains that store a
  brightness lift stored plans to (the controller profile has none);
  `litDim()` in the intent planner is the safety net under both, writing one representable step
  wherever rounding would eat a positive request. Zero still means zero — only a request for light
  is kept as light. `advanceDim()` is the same guarantee for relative steps, and its docblock carries
  the longer argument.
- **A lamp is never sent a value the mode it is in makes it ignore.** Some lamps in colour mode
  refuse a colour temperature and vice versa — silently, reporting the write as accepted
  (platform §6) — so `planColor()` and `planTemperature()` each emit `light_mode` ahead of the value
  it enables, and `WRITE_ORDER` keeps that order through the queue. Gating lamps are rare, one in
  roughly thirty-six measured across three probe runs, and that is the case FOR writing the mode
  unconditionally rather than against it: it costs one 212 ms ack on the lamps that do not gate, and
  §6 measured that a lamp cannot be asked which kind it is. The consequence for anything filtering
  planned writes: **decide per DEVICE, never per write.** A `light_mode` value is a string, so a numeric
  deadband applied to it compares `NaN` and silently drops the mode write while letting the value
  through — which is exactly how a Curve light came to sit on the colour it last held. The colour leg
  has always decided per device; the temperature leg now does too.
- **Flows that look user-edited are never overwritten.** The controller is marked for repair instead.
- **An override always ends.** `OVERRIDE_EXPIRY_MS` (4 h) is the second way out, beside the `onoff`
  edge, and it exists because the `onoff` gesture assumes a PERSON raised the override. A lamp that
  accepts a write, acks it and reverts to its own values a minute later raises one just as well —
  measured, and the device it belonged to did nothing for 88 of 93 recorded hours while reporting
  `ready`. `expireOverrides()` also drops `committed`/`lastWritten` for that lamp: without it the
  override lapses, the plan is unchanged, the no-op filter drops the write, and the lamp stays where
  it was put. Both halves ship together or neither does anything.
- **A reported `dim` of 0 is never an override.** Neither curve-driven nor daylight-driven writes can
  produce a 0 (`MINIMUM_BRIGHTNESS` plus `litDim()`), so a reported 0 is always the lamp's own. The
  `actualOn` guard was not enough because an integration can report `dim 0` a median of **29.9 s**
  before its own `onoff: false` — 296 of 327 overrides in a real week were exactly that, each one a
  false badge and a junk entry evicting real history from a 120-entry log.
- **A tolerance is compared with an epsilon, never with a bare `<=`.** `withinOverrideTolerance()`
  exists because `Math.abs(0.83 - 0.86)` is `0.030000000000000027`: the same three hundredths was
  forgiven at one end of the axis and prosecuted at the other, which under the rule above meant
  standing down for good.
- **Deleting a controller deletes only the Flows demonstrably created by it.** Attribution is the
  controller id carried in the bridge action's arguments.
- **The orphan sweep refuses to run when no Flow-owning Lightkeeper device is live**, because every
  managed Flow would then look orphaned. The live set is the union of the controller and schedule
  registries PLUS every installed device of those two drivers — see `liveDeviceIds()` below for why
  that is load-bearing rather than tidy. A circadian or Curve light is deliberately absent: neither
  owns a Flow, so counting them would only inflate the count and stop the refusal firing.
- **A flow card catalogue is read, projected and dropped — never retained.** `homey-api` caches
  every `getAll` result for the life of the client (platform §15), and the two card catalogues are
  ~11.6 MB each on a real Homey: retaining them was 30 MB of a 48 MB footprint, against Homey's
  30 MB guideline. Every `getAll` call site passes `NO_CACHE` from `lib/flow-card-catalogue.ts`, and
  the cards are projected to the handful of fields the app reads before the raw array goes out of
  scope. The single-flight promise and 60 s TTL in `FlowCardCatalogue` are not an optimisation:
  they replace the cache that was given up, because `findReattachCandidate()` calls `discover()`
  once per plausible device in a loop. `FlowBridgeManager.bridgeCards()` goes further and reads no
  catalogue at all: it asks for its three cards by name and echoes back what the Homey returns,
  which still honours platform §3 because nothing is assembled and then trusted. Enumeration
  survives as the fallback.
  Measured on hardware: one catalogue read costs **~12 MB of floor, permanently** (31.9 MB before
  the app had read one, 43.9 MB immediately after), because V8 never returns the pages. So NOT
  retaining and never reading cost the same unless the read is avoided altogether — which is why
  `bridgeCards()` asks for its three cards by name and `getDiagnostics` peeks at the time card
  rather than looking it up. Getting under 30 would mean parsing that response incrementally instead
  of through `homey-api`. `node scripts/verify-hardware.mjs memory` checks it —
  T59 reports the 30 MB guideline and fails past a 100 MB ceiling. That line is a smoke check for a
  new bulk read, not a retention test: RSS cannot tell holding a catalogue from having parsed one.
  **The floor moves with the house rather than with this app's code**, which was established by
  installing two builds four days apart on one Homey and measuring both (67.5 MB and 68.2 MB against
  the same four devices, 13 September 2026) — so compare a reading only with one from the same house,
  and reinstall before believing a high one.
- **The API key is never logged, never returned over the app API, and never included in
  diagnostics.** Errors are classified before logging, because an error object can echo the token.
  `test/unit/diagnostics-redaction.test.ts` asserts this against serialised output.
  Two mechanisms hold it up, and both are load-bearing: `withWriteClient` re-throws a
  `sanitizedWriteError()` rather than the original — the only place in the app where an error has
  been near the key — and `redactKeyMaterial()` scrubs anything key-shaped from a message on its way
  into a log line or a device's unavailable text. An unclassifiable platform error keeps its own
  wording (redacted), because `404 Not Found: FlowCardAction with ID <x>` is the message that costs
  hours and replacing it with "could not reach Homey" sends the next reader elsewhere.
- **One live handshake per API key.** `getWriteClient()` memoises the in-flight attempt. A key holds
  a single session (platform §2), so two concurrent `createLocalAPI` calls fight over it — and at
  boot the app's own revalidation races every controller's first reconcile. Symptom if this is removed: a key
  that was just accepted "randomly" stops working minutes later.
- **A recovered key returns controllers to ready without a restart.** `needs_credential` is the one
  state a health re-check may leave downward (`recoverFromCredentialFailure`), because it asserts
  the runtime was sound and only the key was not. Without it, "mint a new key and paste it in" ends
  with every device still unavailable, which reads as the new key being bad too.
- **Managed Flow references are only carried forward while the source device is unchanged.**
  `carryForwardFlows()`. A flow's trigger embeds the source device id, so after a re-attach (or a
  repair that picks a different remote) the old references describe flows that can never fire —
  kept, they read as user-edited, and the new remote gets no flows at all. They are deleted
  explicitly, because the orphan sweep cannot see them: their controller id is still live.
- **One rule per gesture.** Enforced in `setRules` and by `dedupeByInputKey()`, and now STRUCTURAL
  in the buttons screen as well: it draws one row per thing the remote can do and a row holds one
  job, so there is no arrangement of taps that assigns a gesture twice. `MappingEngine.resolve()`
  takes the first match, so a gesture assigned twice leaves a row that looks configured and does
  nothing — the exact failure this app exists to prevent. The two checks stay because the screen is
  not the only way in: `setRules` is a pair-session handler and pair sessions are a scriptable Web
  API surface (platform §14).
- **Bridge arguments are untrusted.** Generated flow arguments are user-editable, so every incoming
  bridge event is validated against a live controller and an expected binding key before anything
  executes. On malformed or stale input, fail closed — log and ignore, never execute heuristically.
- **Range expansion is capped at 12 flow variants.** Beyond that the control is declined rather than
  flooding the user's Flow list. A schedule device is capped at 12 windows for the same reason: two
  Flows each, so 24 rows in the user's list.
- **The orphan sweep's "live" set is the UNION of both registries** (`liveDeviceIds()` in `api.ts`).
  `findManagedFlows()` groups by the device id in a Flow's bridge arguments and cannot tell which
  registry that id belongs to, so a sweep that knew only about controllers would find every schedule's
  Flows unattributable and delete them — and the "refuse when nothing is running" guard would not have
  caught it, because with one controller running the set is not empty.
- **A schedule is never switched off retroactively.** Catch-up on start applies a window that
  CONTAINS now, because the alternative is a dark evening after a restart at 22:01. It deliberately
  does not act on a window that already ended: switching a household's lights off at app start, on
  the guess that we might once have switched them on, is the worse surprise. Stated as a limit in the
  README and the FAQ rather than hidden.
- **Pausing a schedule keeps its Flows and does not mark the device unavailable.** The controller
  marks a disabled controller unavailable, which is harmless there; a paused schedule's tile carries
  the switch that un-pauses it, and an unavailable device cannot be switched. So `'disabled'` keeps a
  schedule device available and lives in the capability value instead.
- **A schedule runtime's health verdict never overrides reconciliation's.** `assessHealth()` only
  looks at targets, so it returns early while `flowsHealthy` is false — otherwise it reported 'ready'
  straight over the top of "no time trigger card on this Homey", and the schedule looked well and
  never fired.
- **The daylight loop terminates, and two constants are what make it.** A `measure_luminance` sensor
  in the room whose lamps it drives reads those lamps as well as the sky, so this is a closed loop —
  and an undamped closed loop hunts: a room that visibly pulses once a minute for as long as the app
  runs. `DAYLIGHT_DEADBAND` (0.02 perceptual) is what makes it SETTLE, because inside the band there
  is no next write to provoke the next reading. `MAX_STEP_PER_TICK` (0.05) is a slew limit, so any
  residual movement is a fade rather than a flash. **They must stay in that order** — the step
  strictly larger than the band — or a target just outside the band is approached in increments that
  never leave it, and the lamp creeps and stalls. The app damps this loop; it does not remove it, and
  the FAQ says so and names the sensor placements that avoid it.
- **A loop that has been WATCHED running away is said out loud.** `feedbackRisk` is a statement about
  the configuration and belongs on the pairing screen; it cannot say whether the loop ran. In a
  recorded week it ran 95 times — sensor reading a median of 1 lux with the lamp off and 680 with it
  on, response pinned at its own `bright` end in 62.7% of lit samples, loop gain about 3 — and the
  only place that appeared was a diagnostics field. The runtime now counts the loop's signature (we
  raised the aim, the reading then rose) and after five observations reports `partial` with
  `state.daylightFeedback`. Deliberately NOT "pinned at the bright end": a sunny afternoon puts an
  increasing response there legitimately, and that would be a false alarm on a well-placed sensor.
- **The slew is measured from the AIM, never from the lamp's reported level.** Slewing from what the
  lamp says looks more honest and stalls: `dim` on a lamp declaring `decimals: 1` moves in tenths, so
  through γ = 2.2 every perceptual aim from 0.10 to about 0.45 quantises to the same 0.1. Those
  writes are genuine no-ops and are rightly dropped — but an aim that only advanced on a successful
  write would never leave 0.10 while the room went dark around it. So `aim` advances every pass and
  `committed` is success-gated, and the two are separate maps for exactly that reason.
- **A lamp that refuses a colour while it is off is not a lamp in ill health, and is never counted
  as one.** Roughly half the Hue bulbs behind one bridge decline a pre-stage write as "soft off"
  every time — four of thirteen on the first count, seven of sixteen on a wider run the same day; a
  dead lamp refuses identically, and pre-staging never sends the `dim` write that would tell the two
  apart. So `PlannedWrite.preStage` excludes that FAILURE from `unwritableTargets()` —
  one way only, because a pre-stage success reached the bridge and is real evidence — and the
  circadian runtime stops offering that one lamp a colour after three refusals running, clearing the
  count when it is next switched on. Without the first half, healthy lamps reported themselves as not
  responding all night; without the second, we asked six hundred times a night and never listened.
  Both halves ship together: suppression alone would freeze the streak at exactly the tripping value
  and remove the only writes that could clear it.
- **A Daylight light never switches a lamp on or off, and has no pre-stage option at all.** A `dim`
  write turns an off lamp on — measured, not suspected — so pre-staging is a colour-only idea and a
  brightness-only device type has nothing to pre-stage. It writes to lamps that are already on. That
  is the same promise the two curve-driven types make (platform §12), with one fewer setting to get
  wrong.
- **A Daylight light that cannot tell how light it is falls back to a number, never to darkness.**
  `source: 'none'` is real — a Homey never told where it is, a flat battery in the one sensor — and
  the response's own stored ends are what it holds at. A room that went dark because a sensor did
  would be the worse surprise, and it is why `MINIMUM_BRIGHTNESS` is applied in the sanitiser rather
  than at the write.
- **A Daylight light reads exactly ONE sensor.** It used to mean up to eight, and their mean, which
  sounds more robust and is not: a sensor in a cupboard and a sensor on a windowsill average to a
  number neither of them ever reported, and the pairing screen could not say which one the response's
  lux range belonged to. One sensor makes the range judgeable — the screen draws that sensor's own
  last week behind the two thresholds — and makes a frozen sensor visible instead of diluted.
- **A lux sensor never reaches the light seams.** `measure_luminance` is `setable: false` and
  declares no `min`/`max` (platform §16), and the `Capability` union in the intent planner is the set
  of things this app WRITES. `lib/daylight/luminance-source.ts` subscribes to it directly, with the
  same `makeCapabilityInstance` + `api.track()` teardown pattern, ref-counted so five devices naming
  one sensor cost one subscription. Widening `Capability` would put a read-only sensor in the write
  path. The one sensor read that does NOT go through it is the Insights week — history rather than a
  live value — and `lib/daylight/sensor-history.ts` is the only place that asks for it, on the
  eslint seam allowlist for the same reason every other Homey seam is.
- **`Number(null)` is 0, and 0 lux is pitch dark.** A sensor whose integration reports `null` on a
  flat battery would drive a whole room to the dark end of its response with a number it never sent.
  So every lux and every latitude goes through an explicit guard rather than a bare coercion — found
  by the test that fires every junk value at a live listener, and the reason `0, 0` is refused as a
  location as well.
- **A sensor reading is never treated as stale.** Many Zigbee sensors report only on change, so a
  quiet sensor in a stable room is telling the truth, and a timeout would fall back to the sky
  precisely then. Unusable means gone, unavailable, or never having reported a finite number. A
  FROZEN sensor is made visible instead: every reading's age is on the settings page and in
  diagnostics, which is the only thing that can reveal one.

## Built with AI

This app was designed and written end to end with Claude — architecture, implementation, tests and
documentation. A human directed the work, made the product decisions, and verified behaviour on
real hardware.

One practical consequence if you are picking this up: the dense *why*-comments,
`docs/homey-platform.md` and the `platform §n` tags that cite it are the durable record of
decisions reasoned through once, and of platform behaviour that took real hardware to establish.
Prefer updating them over stripping them.
