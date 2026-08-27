# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository. This file holds the
architecture, the conventions and the release process. **The Homey platform reference — how the
platform actually behaves, thirteen numbered sections established against real hardware — lives in
[`docs/homey-platform.md`](docs/homey-platform.md), and the code cites it as `platform §n`.** Read
it before changing anything that talks to Homey; [the map is below](#the-homey-platform-reference-lives-in-docshomey-platformmd).

Documentation for everyone else: [`README.md`](README.md) and [`FAQ.md`](FAQ.md) for users,
[`CONTRIBUTING.md`](CONTRIBUTING.md) for contributors, [`docs/README.md`](docs/README.md) as the
index of everything.

Lightkeeper is a Homey Pro app that does three things to already-paired lights: it turns an
already-paired remote, switch or dial into a controller for them, it puts them on a schedule, and it
follows the colour of the day with them.

**Four device types, three jobs.** The first two — a light controller and a light schedule — work
by generating and maintaining the Flows underneath, which is why they need a Personal API Key
(platform §1). The third job has TWO device types, and they are the same engine: a **circadian
light** asks what the lights should look like at their warmest and coolest and supplies the shape
of the day itself, and a **Curve light** exposes the whole curve — every point, every time, and a
colour from a closed palette instead of a warmth at any point. **Neither generates Flows at all**
(platform §12): they watch the lights themselves and write to them directly, so neither needs a
key, neither has a `needs_credential` state, and neither appears in the orphan sweep's live set.

## Commands

```bash
npm test                       # unit tests via node --test + tsx. No hardware needed.
npm run typecheck              # tsc --noEmit, the app only
npm run typecheck:test         # the suite and scripts/, via tsconfig.test.json
npm run lint                   # eslint, type-checked. See eslint.config.mjs for what and why
npm run validate               # homey app validate --level publish, CLI from the lockfile
npx homey app install          # persistent install on a real Homey
npx homey app run --remote     # live logs, TEMPORARY — see below
npm run sync:views             # pair -> repair, and shared views between drivers. See platform §8
npm run sync:views:check       # what sync WOULD copy; writes nothing, exits 1 on drift. CI runs it
python artwork/export-assets.py   # re-export every shipped icon, image and the banner
node scripts/verify-hardware.mjs spike   # the scripted half of the hardware pass — NEEDS a real Homey
```

**`package.json`'s `build` script is not ours to remove.** It looks unused — nothing in this repo
calls it — but the Homey CLI shells out to `npm run build` itself whenever it detects TypeScript,
so deleting it fails `validate`, `install` and `run` alike with `Missing script: "build"` reported
as `× Typescript compilation failed`, which names neither the script nor npm.

Run a single test file: `node --import tsx --test test/unit/ramp-engine.test.ts`

## Layout

```
app.ts                          app entry, bridge action listeners, validation on receipt
api.ts                          app Web API consumed by settings/index.html
lib/
  homey-api-service.ts          both API clients, subscription tracking and teardown
  credential-service.ts         the API key: storage, write-validation, failure classification
  device-catalog.ts             devices, zones, owning apps, capability metadata
  source-discovery-service.ts   trigger card discovery, event-surface fingerprints
  inputs/                       input contract, normalizer, magnitude collapse
  mapping/                      mapping engine, supersede gate, behaviour types
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine,
                                target resolver, target-state cache
  bridge/                       binding compiler, flow bridge manager, flow folders
  runtime/                      controller runtime, manager, health monitor, shared target health
  profiles/                     profile schema, migrations
  schedules/                    types, window maths, local clock, bindings, runtime, manager,
                                time-card discovery, migrations
  circadian/                    the curve ENGINE, shared by two device types: curve types and
                                cyclic interpolation, the palette, the two-ended simple plan,
                                runtime, manager, and one migration chain per store
  devices/                      the device layer: DeviceLifecycle (plain, testable) and
                                LightkeeperDevice (the Homey.Device shell) — see platform §13
  time/                         wall-clock minutes and the Homey's local clock
  validation/                   guards, the three plan validators, pairing DTO checks
  pairing/                      the light picker, shared by every driver
app-contract.ts                 what api.ts and the device layer may use of the app
homey-api-types.ts              the shapes homey-api returns, at the normalisation seams
drivers/controller/             virtual device, driver, four pairing views
  pair/                         the four views, edited here
  repair/                       exact copies of pair/, generated — see platform §8
drivers/circadian/              the SIMPLE one: two ends of the day. NO credential screen
  pair/                         targets.html is a COPY of the controller's; ends.html is its own
  repair/                       exact copies of pair/, generated — see platform §8
drivers/curve/                  the FULL one: every point, and a colour per point. NO credential
                                screen. Placeholder artwork — see assets.test.ts
  pair/                         targets.html is a COPY of the controller's; curve.html is its own
  repair/                       exact copies of pair/, generated — see platform §8
drivers/schedule/               virtual device, driver, three pairing views
  pair/                         credential.html and targets.html are COPIES of the
                                controller's; only schedule.html is its own — see platform §8
  repair/                       exact copies of pair/, generated — see platform §8
scripts/sync-views.mjs          makes every copy named above; nothing runs it for you
scripts/verify-hardware.mjs     the scripted half of the hardware pass. Talks to a REAL Homey over
                                the user's own API key; needs HOMEY_ADDRESS + HOMEY_API_KEY
settings/index.html             app settings page
locales/en.json                 all user-facing strings
.homeycompose/                  the manifest's SOURCE; app.json is generated from it
assets/                         the app's own icon and store images, all generated
README.txt                      the App Store long description — not README.md
test/                           unit tests and hand-transcribed fixtures
docs/                           NOT bundled. `docs/README.md` indexes it
  homey-platform.md             the platform reference — §1-13, cited in code as `platform §n`
  privacy.md                    the privacy notice
  homey-review-notes.md         for Athom's reviewer
  localisation.md               English-only on purpose; how to add a language back
  hardware-test-plan.md         the standing pass on a real Homey, run before every release
  history/                      ARCHIVE: the completed 0.5.0 remediation project
artwork/                        NOT bundled. Every graphic's source, and its own two docs
  masters/                      every graphic's source
  export-assets.py              builds every shipped icon and image from those
  asset-spec.md                 the brief: what to draw, at what size, and why
  provenance.md                 where it came from, the rights register, what is placeholder
README.md  FAQ.md  CHANGELOG.md  CONTRIBUTING.md
                                the four end-user / contributor documents, none bundled
```

---

# The Homey platform reference lives in `docs/homey-platform.md`

Thirteen numbered sections on how Homey actually behaves — every one established against real
hardware (Homey Pro 2023, firmware 13.4.0, homey-api 3.19.2) and documented nowhere else. **Read it
before changing anything that talks to Homey.** It used to be the middle of this file; it moved out
so that a human developer could find it under a name that says what it is.

**Code cites it as `platform §n`.** Around ninety comments across `lib/`, `app.ts`, `api.ts` and the
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

# Working on this codebase

## Running it on a real Homey

**Use `homey app install` for interactive testing, not `homey app run`.** `run` creates a debug
session and **uninstalls the app when the CLI exits**, taking its app settings with it — including
the stored API key. Pairing against an ended session gives screens that render but do nothing,
because the handlers are gone.

**`--remote` is not optional on `run`.** Since CLI 3.x a bare `homey app run` runs the app in a
local Docker container. `--remote` uploads and runs it on the Homey, which is also the only
faithful context for anything touching app-scoped permissions.

**`Missing File` on install means a stale `.homeybuild`, not a missing file.** Observed: `homey app
install` failed with a bare server-side

```
× Missing File
```

after every local check had passed — validation clean, and every path referenced by `app.json`
present in the build. The same tree installed on the first try with `homey app install --clean`. The
build directory is reused between runs, and a `validate` beforehand leaves one that `install` can
disagree with. The error names nothing and comes from the Homey, so it reads like a corrupt package;
reach for `--clean` before investigating anything else.

**But `--clean` can also be the CAUSE of it.** Observed on 25 August 2026, installing 0.4.0 on the
same Homey: `install --clean` failed with the same bare `× Missing File`, and the identical tree
installed on the next attempt with a plain `install`. One trial each way, so this is a counter-example
rather than a rule — but if `--clean` fails, try without it before believing anything about the tree.
`preprocess()` wipes `.homeybuild` on every run regardless, so `--clean` is not what makes the build
fresh: it is passed through to `devkit.runApp` as a flag about the app's data ON the Homey. Which is
the other reason not to reach for it casually — a clean install is the one that can take the stored
API key with it.

## Releasing a version

The version lives in **three** places and a release is only coherent when all of them agree:

| File | Role |
|---|---|
| `.homeycompose/app.json` | the source of truth |
| `package.json` | must match it |
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

1. Bump `.homeycompose/app.json` and `package.json` to the same version. Patch for fixes, minor for
   new capability; pre-1.0 means no major bumps for breaking changes, so say it in the changelog
   instead.
2. Add a `.homeychangelog.json` entry under that exact version.
3. Add the full entry to `CHANGELOG.md` as `## <version>`, newest first.
4. Condense it into `README.md`'s `## Changelog`: the new release in about four bullets, and the
   previous one demoted to a single line in the table below it.
5. Update the **This release** section of `docs/hardware-test-plan.md` — what is new or risky this
   time — and run that pass on hardware. `node scripts/verify-hardware.mjs all` answers the lines
   that are a readable state rather than a lamp somebody has to watch; the plan says which.
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

- **`homey-api` is pinned exactly at `3.19.2`** — no caret. This is the version verified on
  Homey Pro 2023, firmware 13.4.0. Its `engines.node` says `>=24`, which npm only *warns* about
  (`EBADENGINE`); the package runs fine on the Node the Homey actually has and on Node 22 locally.
  A review recommended downgrading to `3.17.3` purely on the strength of that field — **do not**,
  on that evidence alone: it swaps a version proven on real hardware for one that never has been.
- **CI runs Node 22**, to stay near current firmware. The CLI is a devDependency at exactly
  `homey@4.4.2` and `validate` runs it from the lockfile: an unpinned `npx homey` changes what
  "publish-level valid" means between two runs of one commit, and even a pinned `npx homey@4.4.2`
  leaves the CLI's own transitive tree free to move.
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

## Two of the four device types share one flow lifecycle

(The other two — a circadian light and a Curve light — generate no Flows at all and appear nowhere
below. See platform §12.)

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
than in a global. Each file's header explains this. The ~150-line shared CSS base is byte-identical
in every view, across every driver, and so are the `emit()`, `stabiliseScrollbar()` and
`escapeHtml()` helpers beside it. `test/unit/pair-view-styles.test.ts` fails on any drift in either
— it compared only the CSS until `emit()` was found carrying a timeout in one view and not the
others. Both tests discover views from disk, so a new driver's screens are covered the moment they
exist.

**Every screen the app draws is LIGHT, and does not ask the OS.** Homey paints the pairing sheet
and the settings frame itself, and paints them light whatever the phone's colour scheme says. Every
view used to carry a `@media (prefers-color-scheme: dark)` block restating the whole palette, so a
phone in dark mode got our dark cards and pale text drawn inside Homey's white panel — the media
query was asking the OS about a surface the OS does not own. There is no query that reports the
container's own colour, so the honest answer is to match the one panel Homey actually draws. The
colour TOKENS stay, because they are what makes a palette change one edit rather than five;
`test/unit/pair-view-styles.test.ts` fails if a scheme query reappears in any view.

**Edit a pair view, then run `npm run sync:views`.** Every `repair/` folder holds byte copies of its
`pair/`, and the schedule driver's `credential.html` and `targets.html` are byte copies of the
controller's, because Homey needs a real file in each place (platform §8). Edit the controller's
copy of a shared view, never the schedule's. `npm test` fails on drift and names the script;
nothing runs it for you.

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
- **Flows that look user-edited are never overwritten.** The controller is marked for repair instead.
- **Deleting a controller deletes only the Flows demonstrably created by it.** Attribution is the
  controller id carried in the bridge action's arguments.
- **The orphan sweep refuses to run when no Flow-owning Lightkeeper device is live**, because every
  managed Flow would then look orphaned. The live set is the union of the controller and schedule
  registries PLUS every installed device of those two drivers — see `liveDeviceIds()` below for why
  that is load-bearing rather than tidy. A circadian or Curve light is deliberately absent: neither
  owns a Flow, so counting them would only inflate the count and stop the refusal firing.
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
- **One rule per gesture.** Enforced in the mapping view, in `setRules`, and by `dedupeByInputKey()`.
  `MappingEngine.resolve()` takes the first match, so a gesture assigned twice leaves a row that
  looks configured and does nothing — the exact failure this app exists to prevent.
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

## Built with AI

This app was designed and written end to end with Claude — architecture, implementation, tests and
documentation. A human directed the work, made the product decisions, and verified behaviour on
real hardware.

One practical consequence if you are picking this up: the dense *why*-comments,
`docs/homey-platform.md` and the `platform §n` tags that cite it are the durable record of
decisions reasoned through once, and of platform behaviour that took real hardware to establish.
Prefer updating them over stripping them.
