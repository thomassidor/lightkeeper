# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository. This file holds the
architecture, the conventions and the release process. **The Homey platform reference — how the
platform actually behaves, eighteen numbered sections established against real hardware — lives in
[`docs/homey-platform.md`](docs/homey-platform.md), and the code cites it as `platform §n`.** Read
it before changing anything that talks to Homey; [the map is below](#the-homey-platform-reference-lives-in-docshomey-platformmd).

Documentation for everyone else: [`README.md`](README.md) and [`FAQ.md`](FAQ.md) for users,
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contributors, [`docs/README.md`](docs/README.md) as the
index of everything.

Lightkeeper is a Homey Pro app that does four things to already-paired lights: it turns an
already-paired remote, switch or dial into a controller for them, it puts them on a schedule, it
follows the colour of the day with them, and it sets their brightness from how much light is
already in the room.

**Five device types, four jobs.** The first two — a Light Remote and a light schedule — work by
generating and maintaining the Flows underneath, which is why they need a Personal API Key (platform
§1). The third job has TWO device types, and they are the same engine: a **circadian light** divides
the day into three zones — morning, midday, evening — anchored to the Homey's own sunrise and
sunset, and a **Colour Curve Light** exposes the whole curve — every point, every time, and a colour
from a closed palette instead of a warmth at any point. The fourth job is a **Daylight light**: it
reads ONE `measure_luminance` sensor the household already owns, or the sun's own elevation computed
from the Homey's position (platform §16), and holds its lights at a brightness that depends on how
light it is already. **None of those three generates Flows at all** (platform §12): they watch the
lights themselves and write to them directly, so none needs a key, none has a `needs_credential`
state, and none appears in the orphan sweep's live set.

**Each job belongs to exactly one device type, and that is a change.** Until 0.6.0 a schedule
window, a circadian end and a curve point could each say `fromDaylight` and borrow the fourth job
inline, which put the same sensor picker and lux range on four different pairing screens and gave
two device types two different daylight behaviours to explain. It is gone: a brightness is a
number, and a brightness that follows the room is what a Room-sensing Light is for.

**What the four engines decide is now readable from outside, and the app OFFERS two Flow cards as
well as generating three.** Each engine publishes what it wants the lights to be into read-only
capabilities on its own device — a brightness, a colour temperature, a colour, how light it is
outside — and Homey registers every device capability as a global Flow tag with no further code
(platform §18). So "when motion is detected, dim to «Room-sensing Light: Brightness now»" is a Flow
anybody can build. Beside that sit the two cards in `lib/flow/`: **`set_lights`**, which takes the
colour from one Lightkeeper device and the brightness from another and puts a room where both want
it in ONE ordered write, and **`daylight_is_dark`**, which lets any Flow gate on the darkness
threshold a Room-sensing Light was already tuned to. Neither replaces pre-staging — a Flow only
covers switch-ons that go through it, and pre-staging is what covers the wall switch.

## Commands

```bash
npm test                       # unit tests via node --test + tsx. No hardware needed.
npm run test:coverage          # the same suite under coverage, with floors. What CI runs
npm run typecheck              # tsc --noEmit, the app only
npm run typecheck:test         # the suite and scripts/, via tsconfig.test.json
npm run lint                   # eslint, type-checked. See eslint.config.mjs for what and why
npm run validate               # homey app validate --level publish, CLI from the lockfile
npx homey app install          # persistent install on a real Homey
npx homey app run --remote     # live logs, TEMPORARY — see below
npm run sync:views             # splices views/shared/ into every pair view, then pair -> repair
                               # and shared views between drivers. See platform §8
npm run sync:views:check       # what sync WOULD copy; writes nothing, exits 1 on drift. CI runs it
npm run render:views           # draw every pairing screen, inside Homey's own sheet, to .views/
                               # — needs Chrome, not CI
npm run render:icons           # draw every icon at the App Store's 24px box. Chrome, not CI
python artwork/export-assets.py   # re-export every shipped icon, image and the banner
node scripts/diagnostics.mjs            # what every device is doing right now, digested. Read-only
node scripts/diagnostics.mjs --save     # the same, plus the whole document into temp/
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
  inputs/                       input contract, normalizer, magnitude collapse, and input-label.ts
                                — the stored English gesture label ("Dial — Turn right") read
                                back into the user's language, from the normalizer's own words
  mapping/                      mapping engine, supersede gate, behaviour types
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine,
                                target resolver, target-state cache, and
                                lightkeeper-settings.ts — what two OTHER Lightkeeper devices want
                                the lights to be, shared by the `set_lights` Flow card and by a
                                remote's `lightkeeper_on` button
  bridge/                       binding compiler, flow bridge manager, flow folders
  flow/                         the two Flow cards this app OFFERS, as opposed to the three it
                                generates: what `set_lights` decides (set-lights.ts), what its
                                three pickers offer (flow-arguments.ts), how it reaches the
                                lamps (light-writer.ts, its own resolver, cache and queue
                                because the card may name lights no device owns), and the
                                Room-sensing Light's condition (darkness-condition.ts).
                                app.ts holds the shells only, as it does for the bridge cards
  runtime/                      controller runtime, manager, health monitor, shared target
                                health, and the visible-state holder all four runtimes compose.
                                verdict.ts is the RANKING that composes what reconciliation
                                learned with what the lights say — worst wins, ties to the one
                                that names an action; control-diagnostics.ts is the bounded
                                per-runtime history of control passes and power events.
                                published-values.ts is visible-state.ts's sibling for NUMBERS:
                                what each engine wants the lights to be, gated at the
                                capability's own resolution, on its way to the capability rows
                                and the Flow tags Homey makes of them (platform §18).
                                writes-lights.ts is "Don't change lights automatically": whether
                                an engine device drives its lamps or only publishes. Read it first
  profiles/                     profile schema, migrations
  schedules/                    types, window maths, local clock, bindings, runtime, manager,
                                time-card discovery, migrations. A block carries a palette `color`
                                as of 0.6.5, and its `temperature` is DERIVED from that colour by the
                                sanitiser — the fallback for a lamp that cannot take one, exactly as
                                `warmth` is on a CircadianPoint
  circadian/                    the curve ENGINE, shared by two device types: curve types and
                                cyclic interpolation, the 24-colour palette, the three-zone
                                simple plan and its sun-anchored boundaries, runtime, manager,
                                and one migration chain per store. A circadian light is
                                evaluated by zoneValueAt(): zone to zone, each boundary the
                                halfway point of its blend — not by valueAt() over points
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
                                only thing a driver writes. mapping-screen.ts also holds
                                storedRuleFrom(), the ONE conversion from a validated row to the
                                rule a profile stores — it was two, and only one of them carried
                                the preset.
                                control-choice.ts is "How Lightkeeper controls your lights", the
                                review screen's radio group on the three engine device types:
                                three modes over the two flags the plans already had, the
                                per-lamp pre-stage test, and what repair reads back from it.
                                source-picker.ts is what the two "take it from" screens offer:
                                which devices answer which question, the live swatch or level on
                                each row, and why a level is drawn perceptually when the board
                                publishes a device value.
                                pair-session.ts is the same lift for the MECHANICS: the handler
                                wrapper, the sensor retain/release ref-count, the light picker's
                                two handlers, save-and-name, the credential pair and the curve
                                preview — each of which was the same block in four or five
                                drivers
  support/                      the primitives every layer uses: the per-KEY mutex and the
                                single-flight coalescer, the bounded ring log, the migration-chain
                                runner, the injectable Timers seam, error-shape classification,
                                field-wise equality, fire-and-forget, i18n.ts — `homey.__` made
                                plural-aware, which every driver's `tr()` is — and interpolate.ts — the
                                Transition shapes (Gradual, Balanced, Quick) every engine
                                interpolates with. NOT the queue that gates
                                lamp writes: that is DeviceQueue, inside command-scheduler.ts.
                                KeyedMutex serialises subscribe/unsubscribe, device-lifecycle
                                operations and flow folders instead
    heap-report.ts              what the app can see of its OWN memory from inside the sandbox —
                                v8 heap stats, the per-space split, and three boot marks, every
                                reading behind its own guard. On /diagnostics. The signal PSS
                                cannot give (platform §15, §17)
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
                                event. docs/commands.md has how to run one
    evidence-sampler.ts         what a periodic health sample is made of
  app-contract.ts               what api.ts and the device layer may use of the app
  homey-api-types.ts            the DEVICE and ZONE shapes homey-api returns, at the one
                                seam that normalises them. The flow and card seams read `any`
drivers/controller/             virtual device, driver, and the LONGEST flow: intro, credential,
                                1 remote, 2 lights, 3 buttons, 4 review, plus TWO pushed screens
                                (job, and source pushed from job). It owns the authored copy of
                                all four SHARED views
  pair/                         eight views. intro/lights/review/credential are the shared four,
                                edited HERE and copied into the other drivers by sync:views.
                                source.html is the SECOND pushed screen — one file, two questions,
                                behind the `lightkeeper_on` job's two rows
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
                                sensor. NO credential screen. driver.flow.compose.json is the
                                one per-driver Flow card in the app: "it is dark enough" 
  pair/                         intro, 1 lights, 2 sensor, 3 response, 4 review. Two of its own;
                                the rest are the controller's. A tapped sensor goes straight to
                                response, whose week card says what is wrong with a flat or a
                                quiet one — the detail screen that used to sit between is gone
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
scripts/coverage.mjs            `npm run test:coverage`: the suite under coverage, with per-file and
                                total floors, and a failure for any source file no test loads
scripts/verify/                 the hardware script's importable parts — argument parsing, the
                                interrupt undo stack, the T-line table (lines.mjs, which the docs'
                                table and hardware-test-numbers.test.ts are checked against), and
                                the --json / --strict outcome
scripts/verify-hardware.mjs     most of the hardware pass. Talks to a REAL Homey over its OWN
                                Personal API Key — needs HOMEY_ADDRESS + HOMEY_API_KEY, and
                                HOMEY_APP_KEY for `credential`. TWO keys: one session per key
                                (platform §2). Names everything it builds `[verify] …` and
                                never creates, renames or deletes a Lightkeeper device it did
                                not build. It DOES switch the lamps its own devices point at —
                                fourteen setCapabilityValue calls, all behind `--yes`, all
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
                                Chrome, the same rasteriser artwork/export-assets.py uses.
                                It draws HOMEY'S OWN SHEET around each screen — the header, and
                                the prev/next footer taken from that step's `navigation` — and
                                the three views that are one file and five screens are rendered
                                per DRIVER. Both were omissions that hid real defects: without
                                the chrome a render cannot show that a view draws a second Next,
                                and keyed by file name the sheet drew one driver's intro five
                                times
scripts/render-icons.mjs        every icon at the size the App Store draws it — 24px of ink in a
                                40px circle (platform §10). The contact sheet that catches an icon
                                too fine or too busy to read there
scripts/diagnostics.mjs         one GET of the app's own /diagnostics on a REAL Homey, digested to
                                a page a person can read: state, last pass and the handful of
                                fields a capture has ever turned on — ignored writes, slow writes,
                                overrides, pre-stage backoff, a quiet sensor. `--raw` and `--save`
                                give the unabridged document, which is ~1 MB and mostly identical
                                ticks. Same key and address as the two below. Writes NOTHING to the
                                Homey; `--save` writes to temp/ (gitignored, and a capture)
scripts/evidence.mjs            start | stop | status | export | note | clear | analyze against a
                                REAL Homey's recorder. Needs a Personal API Key; use the SECOND
                                one to export while a run continues (platform §2). Reports to
                                .evidence/ (gitignored)
scripts/pair-view-fixtures.mjs  the demo data those renders use, one entry per view — plus
                                DRIVER_REPLIES, one per driver for the three views that are one
                                FILE and five screens. Its text is resolved from locales/en.json
                                through the same keys the drivers pass, never transcribed
scripts/dump-card-fixtures.mjs  writes test/fixtures/cards/*.json from the hand-transcribed TS
                                fixtures. Run BY HAND, only when those change; the JSON is the
                                committed artefact and card-fixtures.test.ts fails on drift
scripts/hardware-env.json       GITIGNORED. A Homey address and two Personal API Keys, read by
                                verify-hardware.mjs when the env vars are not set
views/shared/                   NOT bundled. The one authored copy of each block that appears
                                in more than one pair view — the CSS base, emit(), i18n() and
                                stabiliseScrollbar() in all 54 (i18n() in the settings page too),
                                the week grid's CSS and weekGrid()
                                in the one daylight screen that draws it, and the Transition card
                                and transitionShape() on the three engine editing screens.
                                `npm run sync:views` splices them in
settings/index.html             app settings page
locales/                        all user-facing strings, one file per language — thirteen, Homey's
                                own list. en.json is the reference; meta.language and
                                meta.direction say which language a file is and which way it reads
.homeycompose/                  the manifest's SOURCE; app.json is generated from it
  capabilities/                 the four READ-ONLY capabilities the engines publish into. Custom
                                because every `dim` and `light_*` in homey-lib is setable, which
                                would draw a slider nothing honours (platform §18). Plus ONE
                                setable enum, `lightkeeper_control`: the review screen's control
                                choice as a picker on the tile. Each names its icon — Athom's
                                own, shipped as files in assets/capabilities/
  flow/actions/                 the three internal bridge cards, plus set_lights — the one card
                                this app offers rather than writes
assets/                         the app's own icon and store images, all generated — except
                                capabilities/, Athom's stock capability icons, copied unmodified
README.txt                      the App Store long description — not README.md. README.<lang>.txt
                                is the same listing in each of the other twelve languages
test/                           unit tests and hand-transcribed fixtures
  support/                      the shared fakes. fake-homey.ts is the SDK stand-in that lets a test
                                load app.ts, a driver or a device (platform §13); fake-homey-api.ts a
                                live homey-api client under the REAL DeviceCatalog; fake-lightkeeper-
                                app.ts the app a driver talks to; fake-timers.ts the one fake clock —
                                fire in due order, including timers armed while advancing;
                                pair-view-harness.ts the hand-rolled DOM the views run in
docs/                           NOT bundled. `docs/README.md` indexes it
  homey-platform.md             the platform reference, cited in code as `platform §n`
  privacy.md                    the privacy notice
  homey-review-notes.md         for Athom's reviewer
  localisation.md               the thirteen languages, how plurals / ordinals / RTL work, what
                                is deliberately English, and the glossary every language uses
  hardware-test-plan.md         the standing pass on a real Homey: what to DO, and how to report
  hardware-test-coverage.md     what covers what — the script, the suite, and the retired lines
  commands.md                   every command in one place, with the trap that goes with each
                                — including the seven-day recorder: how to start one, its limits,
                                and reading `malformed` before believing a timeline
  design/                       TWO canvases and a decision record. The design SYSTEM —
                                five type sizes, four radii, three border roles, two button
                                shapes — and the flows file that applies it to all 34
                                screens. The README says what they are the authority on,
                                where the two disagree (the flows file wins), the nine
                                places the app departs on purpose, and that nothing is open.
                                `npm run render:views` draws the artefact to put beside it
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

Eighteen numbered sections on how Homey actually behaves — every one established against real
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
| [18](docs/homey-platform.md#18-a-device-capability-is-a-flow-tag-and-a-custom-one-is-the-only-read-only-number) | A device capability IS a Flow tag; a custom one is the only read-only number, and a driver's capability list never reaches a device already paired |

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

**The app is documented as early access, and that is a promise to keep rather than a hedge.**
`README.md`, `README.txt` (the store listing), `FAQ.md` ("Is this finished?"), `CHANGELOG.md`,
`CONTRIBUTING.md` and `docs/README.md` all say that this is a 0.x app in early development and that
an update can change or break a setup somebody already made. So a change that reshapes a stored
shape is allowed — but it ships with a migration wherever one is possible, and it is named in plain
user language in the changelog, because there are no major bumps before 1.0 and the entry is the
only warning anybody gets.

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
2. Add a `.homeychangelog.json` entry under that exact version — **in all thirteen languages**
   (`manifest-locales.test.ts` fails otherwise).
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
7. Re-read `README.txt` if anything about what the app *is* changed — and then every
   `README.<lang>.txt`, which is the same listing in the other twelve languages.
8. `npm test`. `test/unit/release-metadata.test.ts` fails if the four versions disagree
   (`package-lock.json` counts), if any of the three changelogs is missing the current version, or if
   `README.md`, `FAQ.md` or `docs/hardware-test-plan.md` states a test count that no longer matches
   the suite.
   `test/unit/compose-manifest.test.ts` fails if `app.json` has drifted from `.homeycompose/` —
   which `validate` would otherwise repair silently in step 6.

`.homeychangelog.json` keeps the `{ "en": … }` object form for the same reason every other
user-facing string does: each language is a sibling key (see the localisation note below).

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
  `typescript-eslint@8.69.0` already declares `eslint ^10.0.0` in its peers — unlike the TypeScript
  major that arrived in the same dependabot PR, which its peer range forbids outright.
- **A `typescript` major is gated by `typescript-eslint`, not by us.** `typescript-eslint@8.69.0`
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

(The other three — a circadian light, a Colour Curve Light and a Room-sensing Light — generate no
Flows at all and appear nowhere below. See platform §12.)

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

## Two refactors that have been proposed and answered

Both were considered properly during the 9 September structural review and declined. They read as
obvious tidying, which is why they keep coming back:

- **Do not lift the four runtime managers into a shared base class.** They tick alike and differ
  everywhere that matters — what a pass plans, what counts as an override, what health means. A
  common parent buys shared plumbing and pays for it with four subclasses that each override most of
  it. `TickingRegistry` by composition is the shape that was endorsed instead, if the duplication
  ever justifies the work.
- **Do not build a migration-step factory.** The five migration chains look like one pattern and are
  not: each step is a one-off transformation of a stored shape, written once and then frozen, and a
  factory would make the frozen thing harder to read for no second caller. `runMigrationChain()` in
  `lib/support/` is already the only shared part there is.

## Conventions

**Comments explain why.** Module headers give the rationale, and inline comments record which bug a
guard prevents. Match that density — it is the main reason this code is navigable.

**Every pairing screen is on a ratified design system, and two tests enforce it.** Five type sizes
(20 / 16 / 15 / 13 / 11, plus 32 for two display numerals), four radii (8 / 12 / 16 / pill, with 50%
for round marks and 2px for chart bars), and three border roles that do not overlap: `--lk-edge`
draws every card and control BOX, `--lk-line` is only ever a 1px divider inside one, `--lk-box` is
only the 22px checkbox and radio. Disabled is a colour change, never an opacity change. Success is a
dot, never a ground — there is no green banner. `docs/design/` holds the canvases and the departures.

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
- **A file containing `extends Homey.Device` cannot be imported by a test — unless the test imports
  `test/support/fake-homey.ts` first.** `require('homey')` resolves to the CLI in `node_modules`,
  whose main executes the CLI; the SDK module exists only on a Homey. `@types/homey` supplies the
  types, so `tsc` is happy and any test that imports such a file dies with `Class extends value
  undefined`. That is why the device layer is split: `lib/devices/device-lifecycle.ts` holds every
  rule and takes its host as an argument, and `lib/devices/lightkeeper-device.ts` is the
  `Homey.Device` shell that forwards five entry points. The split stays — rules still belong in
  `lib/` — but the shells are no longer untestable: `fake-homey.ts` wraps `Module._resolveFilename`
  so `'homey'` resolves to three recording base classes, and `app.ts`, every `driver.ts` and every
  `device.ts` now run under the suite (`app-entry`, `driver-*`, `devices`, `pair-view-contract`).
  Running them for the first time found five real defects, which is the argument for keeping it so.
  Load an entry point with `require()` after the fake's import, never `import`.

**`any` at Homey API boundaries is deliberate.** `homey-api` ships JavaScript with JSDoc rather than
type declarations. Everything of ours is strict — `strict: true`, `noImplicitOverride: true`.

**Translation belongs to the device layer.** `lib/` has no access to `homey.__`, so anything
user-facing produced there returns a locale key plus tokens — `StateDetail` in
`lib/profiles/controller-profile.ts`, `labelKey` on a `PaletteColor` — and the driver or device layer
resolves it. A string hardcoded in `lib/` can never be translated, no matter what the locale files
say. `DeviceOwner.translate()` is that boundary for the device layer; a driver calls its own
`this.tr()`, and a view or the settings page calls `lk.t()` — never `homey.__` / `Homey.__` directly,
because both wrappers add the plural step below and a direct call skips it.
`test/unit/locales.test.ts` enforces the invariant in both directions: no defined key unused, no
referenced key undefined.

**The app ships in all thirteen languages Homey supports, and every copy change ships in all
thirteen.** en, nl, de, fr, it, sv, no, es, da, ru, pl, ko, ar — `test/support/languages.ts`, which
is Homey's own list. **When you add or change a user-facing string, you translate it in the same
change**: the key in all thirteen `locales/<lang>.json`, the language in every `{ "en": … }` object
you touched in a manifest, and the current version's `.homeychangelog.json` entry in all thirteen.
Translate it yourself — it is part of writing the string, not a follow-up — using the glossary in
[`docs/localisation.md`](docs/localisation.md) so a term stays the same term on every screen. Nothing
is left in English "for now": `locales.test.ts` fails on a key missing from any language, and
`manifest-locales.test.ts` on a manifest object, a `README.<lang>.txt` or a changelog entry missing
one.

Four rules make a translation possible at all, and the tests enforce the ones they can see:

- **Counted strings are plural groups** — `{ "one": "__count__ light", "other": "__count__ lights" }` —
  and the count is always the `count` token. `lib/support/i18n.ts` and `views/shared/i18n.js` pick
  the form with `Intl.PluralRules`, and `locales.test.ts` requires each language to supply exactly
  the categories `Intl` says it has (Polish four, Arabic six, Korean one). Never write `(s)`; never
  choose a key with `count === 1 ? …`.
- **Never build a sentence from translated fragments**, and never `.toLowerCase()` one. Word order
  belongs to the translator: a phrase with a variable in it is one key with a token.
- **Numbers, percentages, lists and dates go through the helpers** — `lk.percent`, `lk.list`,
  `lk.ordinal`, `lk.dateTime` in a view; `tr('unit.percent', …)` in a driver — because the space
  before `%`, the comma and the ordinal suffix are all the language's.
- **Text flow uses logical CSS** (`text-align: start`, `padding-inline-end`), so Arabic mirrors;
  every view sets its root's `dir` from `meta.direction`.

Deliberately English, and documented as such in `docs/localisation.md`: logs and diagnostics,
generated Flow names (renaming a Flow reads as the user's edit), a remote's STORED gesture label —
`lib/inputs/input-label.ts` translates it on its way to a screen — and the "could not reach Homey"
banner, which fires exactly when there is no translator. `npm run render:views -- --lang de` draws
every screen in one language, which is how to check a long German label or the Arabic layout.

**Pair views share ONE document.** The views under `drivers/*/pair/` are injected into the pairing
container's document rather than getting their own iframe. They must not load `homey.js` themselves,
every CSS rule is scoped to the view's root id, and the boot guard lives on the root element rather
than in a global. Each file's header explains this.

**The shared blocks are GENERATED, and `views/shared/` is where they are authored.** The CSS base,
`emit()`, `i18n()` and `stabiliseScrollbar()` appear in every view file (and `i18n()` in the settings
page, which is the one non-view the splicer writes); the week grid — its own CSS and
`weekGrid()` — appears in the one daylight screen that draws a sensor's history, the response
step (it had a second carrier until the sensor detail screen was folded into it); the Transition
card — `transition.css` and `transitionCard()` — and `transitionShape()` appear on the three engine
editing steps. `transitionShape()` is `shape()` in `lib/support/interpolate.ts` written again for a
view, and `pair-view-zone-copy.test.ts` runs the two against each other, along with the day
screen's own copy of `zoneValueAt()` — the copy that once went linear where the engine eased.
(`wc -l views/shared/*` for the sizes: they are quoted nowhere, deliberately, because three places
once carried three stale numbers.) All of it used to be authored by hand in every copy, under an
in-file instruction to "edit this block in all files, or in none of them", with
`test/unit/pair-view-styles.test.ts` asserting they stayed identical. `npm run sync:views` now
splices them from
`views/shared/{base.css,emit.js,i18n.js,stabilise-scrollbar.js,week-grid.css,week-grid.js,transition.css,`
`transition-card.js,transition-shape.js}`, substituting
each view's own root id for `#ROOT` — the same normalisation that test does in reverse.
**Edit the source, never the view.** `npm run sync:views:check` fails in CI until they agree.

Two conventions the splicer imposes on those source files, both learned by breaking them: the
delimited **CSS** source carries no leading indentation (the splicer indents it into place, and a
source that arrives pre-indented drifts from its copies by exactly that), and a **function** source
starts at `function` with no docblock above it — put the docblock INSIDE the function, as
`stabilise-scrollbar.js` and `emit.js` do.

The second one is worse than "the two files then differ", which is what this used to say. The
splicer matches from the `function` keyword, so a docblock above it is never *replaced*: it is
**prepended again on every sync**, and `sync:views:check` cannot see it because every carrier
accumulates identically and so never drifts from any other. Four stale copies of the week grid's
docblock reached the shipped archive that way, each contradicting the real one inside the function.
`test/unit/pair-view-styles.test.ts` now fails if any spliced helper has a comment block above it.

`views/shared/` sits OUTSIDE `drivers/` because the CLI treats every directory under `drivers/` as a
driver and fails pre-processing with `ENOENT: … driver.compose.json`; `.homeyignore` keeps it out of
the archive, since nothing on a Homey reads it.

On-disk duplication is unchanged and has to be — Homey needs a real file per folder and will not
follow a reference (platform §8). What changed is that a human edits one file instead of 54.
A real `<link>`/`<script src>` may yet be possible: the Homey does serve a sibling file next to a
pair view (measured, platform §8). What is unmeasured is whether an injected view's own external
reference loads once the pairing container has placed it in the shared document.

**`stabiliseScrollbar()` is in every view because the scroller is not ours.** It reserves the
scrollbar's gutter on the pairing container's scrolling element, which outlives each screen — so
whichever view boots first decides whether the width is one number for the flow or two. It lived in
the credential screen alone, which made the two device types that have one stable from step 1 and
the three without one stable nowhere: unfolding the sensor list took the scrollbar's width off the
usable width and the heading above it moved from one line to two, under the tap that unfolded it.
`pair-view-styles.test.ts` asserts every view has it, not just that the copies agree.

The remaining shared helpers — `node()`, `clear()`, `pad()` — are byte-identical **wherever they
appear**, which is not everywhere: a view that draws no list needs no `clear()`. The test asserts
that weaker, correct property rather than demanding all of them in all of them.

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
hero?, control? }` from `getReview`, and `lib/pairing/flow-screens.ts` is where both are built.
`control` is "How Lightkeeper controls your lights", sent by the three engine device types only;
it took the place of the closing sentence every review used to end on. That is what
lets five different flows — three steps or four, with or without a credential screen — share one
file each rather than five near-copies.

**Every source file is loaded by a test, and CI enforces it.** `npm run test:coverage`
(`scripts/coverage.mjs`) runs the suite under Node's own coverage and fails on three things a plain
`--test-coverage-lines` cannot see: a source file NO test loads (V8 leaves it out of the report, so it
can never lower an aggregate — which is how `app.ts` and all five drivers went untested), a single
file under the per-file floor, and the totals. The floors sit just under what the suite achieves;
raise them as coverage rises and never lower one to land a change. A type-only file goes on its
`TYPE_ONLY` list with the reason.

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
- **Nothing survives teardown.** No timer, subscription, ramp or queued write outlives the runtime
  that owns it. Every one of them holds a reference to a device that may already be deleted, and a
  write that lands after teardown is a write nothing is left to attribute, cancel or report.
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
  refuse a colour temperature and vice versa — silently, reporting the write as accepted (platform
  §6) — so `planColor()` and `planTemperature()` each emit `light_mode` ahead of the value it
  enables, and `WRITE_ORDER` keeps that order through the queue. Gating lamps are rare, one in
  roughly thirty-six measured across three probe runs, and that is the case FOR writing the mode
  unconditionally rather than against it: it costs one 212 ms ack on the lamps that do not gate, and
  §6 measured that a lamp cannot be asked which kind it is. The consequence for anything filtering
  planned writes: **decide per DEVICE, never per write.** A `light_mode` value is a string, so a
  numeric deadband applied to it compares `NaN` and silently drops the mode write while letting the
  value through — which is exactly how a Colour Curve Light came to sit on the colour it last held.
  The colour leg has always decided per device; the temperature leg now does too.
- **Flows that look user-edited are never overwritten.** The controller is marked for repair instead.
- **Folder work never blocks a Flow write.** Every `FlowFolderManager` method catches its own
  failure and degrades to "no folder". A folder is presentation only and is never evidence of
  ownership — attribution is the controller id in the bridge action's arguments (below), so a Flow
  outside its folder is still ours and a Flow inside one is not ours because of it.
- **An override always ends.** `OVERRIDE_EXPIRY_MS` (4 h) is the second way out, beside the `onoff`
  edge, and it exists because the `onoff` gesture assumes a PERSON raised the override. A lamp that
  accepts a write, acks it and reverts to its own values a minute later raises one just as well —
  measured, and the device it belonged to did nothing for 88 of 93 recorded hours while reporting
  `ready`. `expireOverrides()` also drops `committed`/`lastWritten` for that lamp: without it the
  override lapses, the plan is unchanged, the no-op filter drops the write, and the lamp stays where
  it was put. Both halves ship together or neither does anything.
  **The deadline runs from the FIRST report, never the latest.** `noteOverride` used to restamp
  `record.at` on every arriving report, so the one thing that ends an override could be postponed
  indefinitely by the one thing that cannot stop reporting — a stuck lamp. Measured: four lamps
  reporting a value we never wrote, once a minute, each report renewing the four hours meant to
  release them. The history event keeps its real arrival time; only the deadline is anchored.
- **A lamp that ignored our write is not a person, and is told apart by where it ENDED UP.**
  `ineffectiveWrite()` in the target-state cache. The override rules ask "is the report far from what
  we asked for" and answer yes identically for somebody reaching for the vendor app and for a lamp
  that acked a write and did nothing — opposite situations, and standing down is right for one of
  them. A person moves the lamp somewhere new; a lamp that ignored us is still exactly where it was
  before we wrote, which `preWrite` snapshots at dispatch. Measured on the reference Homey: four
  lamps sent `light_temperature` 0.82 reported 0.87, and four sent `dim` 0.05 reported 0.10 — both
  gaps 0.05, outside `OVERRIDE_TOLERANCE`, each standing its device down for four hours at a time.
  **Not a widened tolerance**, deliberately: 0.03 sits above `light_temperature`'s own 0.01
  resolution (platform §6) and raising it to swallow 0.05 forgives a real nudge on every well-behaved
  lamp in the house. An unchanged value is forgiven at any distance and nothing else is forgiven at
  all. A write that demonstrably LANDED clears the snapshot, so somebody who later moves the lamp back
  near where it started is still read as a person. The cost of being wrong is bounded and the right
  way round — we keep driving rather than stand down — and `ignoredCount` is what stops that being
  silent: it is on every target in diagnostics, because a lamp nothing can move must not read as a
  runtime with nothing to do.
- **The power-settle window follows the WRITES, not the transition.** Same 3 s as everything else,
  but `finishWrite` pushes it out while it is open. A power transition makes the runtime fire a forced
  pass, so the writes it provokes go out inside the window and the lamp's answer necessarily arrives
  after it: measured, the burst's last ack at 1.91 s and the lamps' own settled reports from 4.0 s, so
  a window anchored at the transition shut at 3.0 s — between our write and its answer, the one place
  it must not shut. It is NOT lengthened instead: somebody who switches a light on and immediately
  dims it is doing exactly what the override machinery exists to honour. Bounded because only an
  already-open window is extended.
- **A report on a lamp that is OFF is never an override, on any axis.** Either edge of `onoff`
  clears an override, so one raised on an off lamp protects nothing and only costs that lamp its
  pre-staging and a slot in the event log. It was `dim` only until a house-wide "Test my lights"
  (23 September 2026) sent a colour to three off Studio spots and the household's own Studio curve,
  which drives them, filed all three as a person within 200 ms — the same thing Repair does to the
  device being repaired, and two devices pre-staging shared lamps do to each other. `lamp_off` in
  `circadian-runtime.ts`; T173 is its hardware line.
- **A reported `dim` of 0 is never an override.** Neither curve-driven nor daylight-driven writes can
  produce a 0 (`MINIMUM_BRIGHTNESS` plus `litDim()`), so a reported 0 is always the lamp's own. The
  `actualOn` guard was not enough because an integration can report `dim 0` a median of **29.9 s**
  before its own `onoff: false` — 296 of 327 overrides in a real week were exactly that, each one a
  false badge and a junk entry evicting real history from a 120-entry log.
  **That guard is a value test, and a lamp that fades out through a NONZERO level walks past it.**
  A day-long capture a year later: five lamps in one room, all five of its overrides a `dim` report
  29.0-29.9 s before that lamp's own `onoff: false` — the same phenomenon, reported as 0.07, 0.08,
  0.11. `FADE_OUT_MIN_MS`..`FADE_OUT_GRACE_MS` (20-60 s) is the answer — a BAND, because the ceiling
  alone was shipped first and filed five human dim-then-switch-off gestures (0.5-2.1 s from override
  to off) as fading lamps, which is this same error pointing the other way. It deliberately changes
  no behaviour: the
  override is still raised, because the evidence arrives half a minute later and holding judgement
  for it would mean driving a lamp against somebody who had just dimmed it down. Only the RECORD is
  corrected — `override_cleared` says `power_fade_out`, and `fadeOutOverrides` counts it per target.
- **The first thing a lamp says after coming on is the lamp, not a person.** `POWER_RESTORE_MS`
  (15 s) in the target-state cache, one report per capability per power-on edge. The power-settle
  window above cannot cover this on its own: its length is coupled to OUR write burst, because
  `finishWrite` extends only an already-open window, so a pass with little to write leaves it
  shutting early. Measured: four lamps on one bridge came on together, reported the levels they had
  been left at 4.4 s later and within 0.4 s of each other, 80 ms after the window had shut — and the
  Room-sensing Light driving them stood all four down for the entire 29 minutes they were on.
  **Not a longer `OVERRIDE_SETTLE_MS`**, for the reason that constant's own docblock gives: a longer
  window forgives everything for longer, and somebody who switches a light on and then dims it is
  doing exactly what the override machinery exists to honour. The allowance is spent by the first
  report whether or not it needed spending — a restore landing inside the settle window consumes it
  there — so it can never be saved up and handed to a person arriving later.
- **The control-event log must not fill with the app's own voice.** `BoundedLog.addRepeat()` and
  `ControlHistory.ignored()`: a run of identical `report_ignored` entries is one row carrying
  `count` and `lastAt`, and `at` stays the first occurrence. It scans a window of recent rows rather
  than the newest alone, because the repeats interleave — five lamps in a room echo one write each,
  in turn, and a newest-only test would match none of them. The same argument retires the per-report
  `override` row: one override is one row, and a lamp restating it bumps `repeats` on the
  `OverrideRecord` instead. Measured before: one curve device dropped 341 events in 4.8 h with 108
  of its 120 slots holding `write_pending`, and one daylight device spent 28 of 32 slots re-logging
  four overrides. The 120 slots are the only place an exception surfaces, and `scripts/diagnostics.mjs`
  reads them — which is why its `countBy()` sums `count` rather than rows.
- **A tolerance is compared with an epsilon, never with a bare `<=`.** `withinOverrideTolerance()`
  exists because `Math.abs(0.83 - 0.86)` is `0.030000000000000027`: the same three hundredths was
  forgiven at one end of the axis and prosecuted at the other, which under the rule above meant
  standing down for good.
- **Deleting a controller deletes only the Flows demonstrably created by it.** Attribution is the
  controller id carried in the bridge action's arguments.
- **The orphan sweep refuses to run when no Flow-owning Lightkeeper device is live**, because every
  managed Flow would then look orphaned. The live set is the union of the controller and schedule
  registries PLUS every installed device of those two drivers — see `liveDeviceIds()` below for why
  that is load-bearing rather than tidy. A circadian or Colour Curve Light is deliberately absent:
  neither owns a Flow, so counting them would only inflate the count and stop the refusal firing.
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
  What those two call sites were designed against was a measurement — 31.9 MB before the app had
  read a catalogue, 43.9 MB immediately after — read as a ~12 MB floor raised *permanently*, on the
  grounds that V8 never returns the pages. **That premise is retired** (see below, and §15): on a
  Homey PSS was observed falling on an idle process, and repeat reads cost +2.3, then +1.2, then
  +0.0 MB. Avoiding a transient peak is worth much less than it looked. Both call sites stay as
  they are — asking for three cards by name is simply cheaper than enumerating, whatever the pages
  do afterwards — but **do not derive a new decision from the ratchet**, because it is not there.
  **Do not reach for incremental parsing on the strength of that number: it was tried, and §15
  records what happened.** A streaming reader was built, verified byte-exact against `homey-api`
  across all 1832 cards, and measured on hardware — where it changed nothing, because this house's
  catalogue is 1.0 MB rather than the 11.6 MB the figure above came from, and a 1 MB parse fits in
  heap slack. It was reverted. Read §15's "Where it stops, and what was established by trying"
  before spending a day on the same idea.
  `node scripts/verify-hardware.mjs memory` checks the number — T59 reports the 30 MB guideline and
  fails past a 100 MB ceiling. That line is a smoke check for a new bulk read, not a retention test:
  RSS cannot tell holding a catalogue from having parsed one. **The signal that can is the app's own
  `heapUsed`, which `/diagnostics` now carries** along with the per-space split and three boot marks
  (§17) — 15.2 MB of heap with no devices, 8.8 MB of it spent importing the app's own modules before
  `onInit` runs.
  **And the guideline itself is not reachable by any app.** A do-nothing Homey app — `require('homey')`
  and an empty `onInit` — was installed beside Lightkeeper on 15 September 2026 and measured in the
  same minute: **30.6 MB of PSS**. Lightkeeper's own code accounts for **under 1 MB** above a control
  app that has made the same API calls; the biggest app-attributable item is `socket.io-client`
  inside `homey-api`, at ~13.7 MB of RSS to require. §15's "What an empty app costs" has the whole
  ladder, the control-app method and its four traps, and the assumptions it overturns — including
  that "V8 never gives the pages back" is a laptop fact, not a Homey one, and that the two-client
  design (§1) costs +0.0 MB. **Read it before optimising anything for memory**, and report this
  app's footprint as its margin over a control app rather than as an absolute.
  **The floor moves with the house rather than with this app's code.** Established twice: two builds
  four days apart measuring the same (67.5 / 68.2 MB, 13 September 2026), and then properly, by
  installing the unmodified 9 September build — whose own line recorded 36.6 MB — alongside HEAD on
  14 September and getting **the same ~75 MB from both**. That Homey was at 10.6% free memory with
  459 MB of swap in use. **Compare a reading only with one from the same house on the same day**,
  take three (one build restarted three times read 71.4, 73.9 and 80.1 MB), and reinstall before
  believing a high one.
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
- **A credential is validated by a real Flow WRITE, never by a read.** A read succeeds on a key
  that cannot write Flows at all (platform §1), so a read-probed key is accepted at pairing and then
  fails at the first thing the device exists to do. The token-changed guard in `getWriteClient` is
  the other half and stays with it.
- **A recovered key returns controllers to ready without a restart.** `needs_credential` is the one
  state a health re-check may leave downward (`recoverFromCredentialFailure`), because it asserts
  the runtime was sound and only the key was not. Without it, "mint a new key and paste it in" ends
  with every device still unavailable, which reads as the new key being bad too.
- **The Test control works before save, and without Flows.** `startWithoutFlows` and the ephemeral
  runtimes behind it are what let somebody press a button on the pairing screen and watch the lamp
  answer, which is the only evidence they get that the thing they are configuring works. It is easy
  to break from either end — a refactor that assumes a registered runtime, or one that assumes
  Flows exist — so it is stated here rather than left to the tests.
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
- **Pre-staging is chosen on the review screen and then proven PER LAMP — and choosing it is not
  enough.** "How Lightkeeper controls your lights" offers "Set lights before they turn on" on the two
  curve-driven types, and it is stored as `preStage: true` plus `preStageLights`: the lamps the
  review screen's test ("Test my {n} lights", `probePreStageAll()`) watched stay off while given a
  colour. `preStagesLamp()` in `lib/circadian/circadian-types.ts` is the one rule — BOTH, always.
  Chosen and not tested pre-stages nothing, which is the design's "until the test has run, the
  device behaves as option 1", and it is also exactly what every device paired before this change
  with `preStage: true` now reads as: no migration, and those devices stopped pre-staging until
  somebody runs the test in repair. Three gates, and conflating any two is the risk:
  `DEFAULT_SIMPLE_PLAN.preStage` (and the curve driver's session seed) is now `false` for a NEW device
  — the second reversal of that default, argued at `DEFAULT_SIMPLE_PLAN`; `preStage === true` in
  `lib/validation/plans.ts` is still the STORE's gate, where an absent key must keep meaning "no";
  and `preStageLights` is sanitised forgivingly, because a malformed entry can only ever mean a lamp
  that is not pre-staged. `verifyStayedOff()` is now per lamp as well: a lamp seen coming on from a
  pre-stage write is struck off `preStageLights`, persisted, and the choice and every other lamp are
  left alone — one integration switching a lamp on is no evidence about another. It still does not
  switch that lamp back off (platform §12).
  **The test switches lamps that are ON off to test them**, then puts each back — onoff first, then
  the brightness and the one colour axis the test wrote. That is what "each light blinks once" on the
  screen means, and it is new behaviour on hardware: testing only the lamps that happen to be off
  would leave an evening household with nothing to pre-stage. It runs the lamps in PARALLEL, because
  each is two waits long and a pair view's `emit()` gives up at 20 s. `probePreStage()` (one lamp,
  already off) is kept for the `testPreStage` API route.
  `SHOW_PRE_STAGE` and the hidden switch it guarded are gone from `day.html` and `curve.html`, and so
  is the "Keep these lights up to date" switch beside them: both answers now live in one radio group
  on the last screen. See `lib/pairing/control-choice.ts`.
- **A device paired before `writesLights` keeps writing: the gate is `!== false`.** The three engine
  types can be set to only PUBLISH — "Don't change lights automatically" on the review screen, which
  computes and publishes their values and writes to no lamp — so a
  remote's *On – with Lightkeeper* button can read them without a second writer on the same bulbs.
  That was measured, not imagined: one press became three devices and ~30 writes to five lamps. The
  flag is opt-OUT and stored only when false, which is the reverse of `preStage` one line above it in
  every validator; copying `preStage === true` would silently stop every existing device in every
  house. `lib/runtime/writes-lights.ts` holds the one rule, and the gate sits in `applyNow` AFTER
  `publishValues()` — on a Room-sensing Light also before the aim bookkeeping, or the slew walks
  towards a level nothing writes. A publish-only device subscribes to no lamp, because `noteOverride`
  files every report it has no write to compare with as an override. `preview` is the only way past
  the gate, and it is its own option because the switched-on pass is forced too.
- **A Room-sensing Light never switches a lamp on or off, and has no pre-stage option at all.** A
  `dim` write turns an off lamp on — measured, not suspected — so pre-staging is a colour-only idea
  and a brightness-only device type has nothing to pre-stage. It writes to lamps that are already
  on. So its review screen offers TWO of the three ways to control lights, and `setControl` refuses
  the third rather than trusting the screen (platform §14) — the design drew all three, and the
  third would have failed its test on every lamp there is. That is the same promise the two curve-driven types make (platform §12), with one fewer
  setting to get wrong.
- **A Room-sensing Light that cannot tell how light it is falls back to a number, never to
  darkness.** `source: 'none'` is real — a Homey never told where it is, a flat battery in the one
  sensor — and the response's own stored ends are what it holds at. A room that went dark because a
  sensor did would be the worse surprise, and it is why `MINIMUM_BRIGHTNESS` is applied in the
  sanitiser rather than at the write.
- **A Room-sensing Light reads exactly ONE sensor.** It used to mean up to eight, and their mean,
  which sounds more robust and is not: a sensor in a cupboard and a sensor on a windowsill average
  to a number neither of them ever reported, and the pairing screen could not say which one the
  response's lux range belonged to. One sensor makes the range judgeable — the screen draws that
  sensor's own last week behind the two thresholds — and makes a frozen sensor visible instead of
  diluted.
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
- **The `set_lights` card writes to a lamp that is off only when "switch them on" was chosen.**
  Enforced on the TARGETS (`eligibleTargets`), never on the writes, because the write that would
  break it is a `dim` — which carries no `onoff` and turns the lamp on anyway (platform §12). A lamp
  whose state is unknown counts as off, and the pass refreshes live values first for the same reason
  `ScheduleRuntime.apply()` does: the catalogue is cached, so a lamp switched off by hand a minute
  ago can still read as on. There is deliberately no third "leave the switch alone" option — it
  would be the same behaviour under a name that promised something it could not do.
- **A Flow card whose source device is gone writes nothing at all.** `planSetLights` refuses the
  whole pass and names the id. Half a set of settings — the right brightness in last week's colour —
  is what an untrusted Flow argument can produce and nothing would report. Same rule as the bridge
  cards: fail closed, log, never execute heuristically.
- **"It is dark enough" is false when the device cannot tell how light it is**, never true. The
  condition almost always guards switching lights on, and the two ways to be wrong are a room that
  stays dark and a room that lights itself in daylight, repeatedly, with nothing explaining why.
  False is the same answer the device itself gives in that state.
- **A capability that cannot be added never stops a device running.** A driver's capability array
  reaches only devices paired after the change (platform §18), so `reconcileCapabilities()` adds the
  missing ones on every init — each call in its own try/catch. A tile missing a row is cosmetic; a
  device that refused to start over one has stopped doing its job.
- **A published value is gated at the capability's own resolution.** `ValueBoard` rounds to
  `PUBLISHED_DECIMALS` before deciding anything moved, which is the same argument the curve's write
  gate rests on: the curve moves about 0.003 a minute, and an ungated board would write sixty
  indistinguishable points an hour into a user's Insights and wake the device layer sixty times to do
  it. `test/unit/compose-manifest.test.ts` ties that constant to what the manifests declare.

## Built with AI

This app was designed and written end to end with Claude — architecture, implementation, tests and
documentation. A human directed the work, made the product decisions, and verified behaviour on
real hardware.

One practical consequence if you are picking this up: the dense *why*-comments,
`docs/homey-platform.md` and the `platform §n` tags that cite it are the durable record of
decisions reasoned through once, and of platform behaviour that took real hardware to establish.
Prefer updating them over stripping them.
