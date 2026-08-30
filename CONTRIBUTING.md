# Contributing

Thanks for taking a look. This is a small app with a specific shape, and two files hold that shape:

- **[`CLAUDE.md`](CLAUDE.md)** — the architecture, the conventions, and how to release. Read it
  before changing anything.
- **[`docs/homey-platform.md`](docs/homey-platform.md)** — fifteen numbered sections on how Homey
  *actually* behaves, every one established against real hardware and documented nowhere else. The
  code cites it as `platform §n`.

Everything below is the short version. [`docs/README.md`](docs/README.md) indexes the rest.

## Getting set up

```bash
npm install
npm test                 # unit tests, no Homey needed
npm run typecheck        # the app
npm run typecheck:test   # the suite and scripts/
npm run lint             # eslint, type-checked
npm run sync:views       # after editing any pair view — nothing runs it for you
npm run render:views     # draw every pairing screen to .views/ and look at them. Needs Chrome
```

**`render:views` is not a check.** It renders each screen with demo data so you can see what you
changed; what a screen REFUSES and what it DRAWS is `test/unit/pair-view-behaviour.test.ts`, which
fails. Both are worth having: a `fill` attribute that a stylesheet quietly overrode passed every
assertion in the suite and drew the wrong thing, and only a picture showed it.

For anything that touches real hardware you need the Homey CLI:

```bash
npm install -g homey
homey login
homey app install        # persistent — use this, not `homey app run`
npm run validate         # homey app validate --level publish, CLI pinned
```

**Use `homey app install`, not `homey app run`.** `run` creates a debug session and uninstalls the
app when the CLI exits, taking its app settings with it — including the stored API key. Pairing
against an ended session gives screens that render and do nothing. If you do use `run`, `--remote`
is not optional. See [CLAUDE.md → Running it on a real Homey](CLAUDE.md#running-it-on-a-real-homey),
which also has the `Missing File` / `--clean` trap.

**Do not share an API key between the app and an external script.** A key embeds a session id, and
concurrent holders appear to invalidate one another
([platform §2](docs/homey-platform.md#2-api-key-sessions-die-routinely)). So the hardware script
takes TWO: `HOMEY_API_KEY` is its own, `HOMEY_APP_KEY` is the one the app holds and that
`credential` removes and restores. It refuses to run that command on one key rather than leaving
the app with none.

## The layout

```
app.ts  api.ts        app entry, and the Web API the settings page calls
lib/                  everything with no Homey device attached: discovery, inputs,
                      mapping, outputs, the flow bridge, every runtime, schedules,
                      the circadian curve
drivers/              the four virtual device types and their pairing views
settings/  locales/   the app settings page, and every user-facing string
test/                 unit tests and fixtures transcribed from real hardware
docs/                 the platform reference, privacy, review notes, localisation
artwork/              every graphic's source, and the script that exports them
```

[CLAUDE.md → Layout](CLAUDE.md#layout) has the full file-by-file tree.

## Before you open a PR

- `npm test`, `npm run typecheck` and `npm run typecheck:test` pass.
- `npm run lint` passes.
- `npm run validate` passes, and the `app.json` it regenerates is committed.
- If you edited a pair view: `npm run sync:views`, and no diff afterwards.
- New user-facing strings are in `locales/en.json` — never inline in HTML, never in `lib/`.
- If it is user-visible, it has a changelog entry — see [Releasing](#releasing) below.

## House rules

**Comments explain why, not what.** The codebase is dense with rationale — which bug a guard
prevents, which platform quirk forced a design. That is deliberate; please match it. Where a
platform constraint is involved, cite it: `(platform §6)`.

**`any` on Homey API boundaries is intentional.** `homey-api` ships JavaScript with JSDoc rather
than type declarations. Everything that is ours is strictly typed.

**Two API clients, deliberately separated.** Reads, subscriptions and `setCapabilityValue` go
through the app's own token; flow **writes** go through the user's Personal API Key. Do not route
one through the other — [platform §1](docs/homey-platform.md#1-an-apps-own-token-cannot-write-flows)
is why.

**Strings that reach a user leave `lib/` as a locale key.** `lib/` has no access to `homey.__`, so
it returns a `StateDetail` and the driver layer resolves it. `test/unit/locales.test.ts` enforces it
in both directions; [`docs/localisation.md`](docs/localisation.md) has the rest, including what to do
when a language is added back.

**Pair views are byte copies on disk, and `npm run sync:views` is what makes them.** Homey needs a
real file in each place and will not follow a reference. Edit the controller's copy of a shared view,
then run the script; `npm test` fails on drift.
[platform §8](docs/homey-platform.md#8-repair-views-live-in-their-own-folder-and-validation-cannot-tell-you)
is why, and why `homey app validate` cannot tell you.

**Schedules fire from generated Flows, not from timers.** The SDK has no scheduler, and Homey's own
time trigger already handles DST, clock changes and restarts. The app decides only what a Flow
cannot express — the day of the week, the pause switch, and what "on" means for lights that may not
all dim. Keep it that way;
[platform §9](docs/homey-platform.md#9-time-comes-from-the-flow-engine-because-the-sdk-has-no-scheduler)
has the details.

**Every screen the app draws is light, and does not ask the OS.** Homey paints the pairing sheet and
the settings frame itself and paints them light whatever the phone says, so a
`prefers-color-scheme` block draws our dark cards inside Homey's white panel. The colour tokens stay;
the media query must not come back, and a test fails if it does.

**Never commit captures from a real Homey.** `/test/fixtures/raw/` is gitignored for this reason;
[`test/fixtures/README.md`](test/fixtures/README.md) lists exactly what a `getDevices` or `getFlows`
dump carries.

## Testing

Fixtures in `test/fixtures/reference-devices.ts` are transcribed verbatim from four real remotes, and
the expected results are written by hand beside them so the tests prove the normalizer rather than
the fixture. No framework — `node --test` with `tsx`.

Run one file: `node --import tsx --test test/unit/ramp-engine.test.ts`

Anything a real Homey has to answer lives in
[`docs/hardware-test-plan.md`](docs/hardware-test-plan.md), which is run before every release —
mostly by `node scripts/verify-hardware.mjs full --yes`. What is left for a person is the first
page of that file: mint the keys, press the remote three ways, look at the contact sheet.

The pairing SCREENS are tested off-hardware, through a hand-rolled DOM in
`test/support/pair-view-harness.ts` that runs each view's real script. Deliberately not jsdom — the
header of that file says why, and what it does not do.

## Releasing

The version lives in four files and every user-visible change ships **three** changelog entries,
because they have three audiences:

| File | Audience |
|---|---|
| `.homeychangelog.json` | what Homey shows in the app store |
| [`CHANGELOG.md`](CHANGELOG.md) | the full record, for anyone reading the repo |
| [`README.md`](README.md#changelog) | the condensed front-page summary |

`test/unit/release-metadata.test.ts` fails if any of them is missing the current version, or if the
four copies of the version number disagree. The full checklist — including that `npm run validate`
is what regenerates `app.json`, so it is a required step and not just a check — is in
[CLAUDE.md → Releasing a version](CLAUDE.md#releasing-a-version).

## Reporting a bug

Homey settings → Lightkeeper → Diagnostics → **Copy for a bug report**. The export is generated
locally and deliberately contains no API key material. Skim it before posting — it does include
your device and zone names.
