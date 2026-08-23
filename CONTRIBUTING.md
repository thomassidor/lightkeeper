# Contributing

Thanks for taking a look. This is a small app with a specific shape, and
[`CLAUDE.md`](CLAUDE.md) is where that shape is written down — the architectural rules, plus a
Homey platform reference established against real hardware and documented nowhere else. Read it
before changing anything. Everything below is the short version.

## Getting set up

```bash
npm install
npm test                 # unit tests, no Homey needed
npm run typecheck        # the app
npm run typecheck:test   # the suite and scripts/
```

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
concurrent holders appear to invalidate one another.

## Before you open a PR

- `npm test`, `npm run typecheck` and `npm run typecheck:test` pass.
- `npm run validate` passes, and the `app.json` it regenerates is committed.
- If you edited a pair view: `npm run sync:views`, and no diff afterwards.
- New user-facing strings are in `locales/en.json` — never inline in HTML, never in `lib/`.

## House rules

**Comments explain why, not what.** The codebase is dense with rationale — which bug a guard
prevents, which platform quirk forced a design. That is deliberate; please match it.

**`any` on Homey API boundaries is intentional.** `homey-api` ships JavaScript with JSDoc rather
than type declarations. Everything that is ours is strictly typed.

**Two API clients, deliberately separated.** Reads, subscriptions and `setCapabilityValue` go
through the app's own token; flow **writes** go through the user's Personal API Key. Do not route
one through the other — [CLAUDE.md §1](CLAUDE.md) is why.

**Strings that reach a user leave `lib/` as a locale key.** `lib/` has no access to `homey.__`, so
it returns a `StateDetail` and the driver layer resolves it. `test/unit/locales.test.ts` enforces it
in both directions; [`docs/localisation.md`](docs/localisation.md) has the rest, including what to do
when a language is added back.

**Pair views are byte copies on disk, and `npm run sync:views` is what makes them.** Homey needs a
real file in each place and will not follow a reference. Edit the controller's copy of a shared view,
then run the script; `npm test` fails on drift. [CLAUDE.md §8](CLAUDE.md) is why, and why
`homey app validate` cannot tell you.

**Schedules fire from generated Flows, not from timers.** The SDK has no scheduler, and Homey's own
time trigger already handles DST, clock changes and restarts. The app decides only what a Flow
cannot express — the day of the week, the pause switch, and what "on" means for lights that may not
all dim. Keep it that way; [CLAUDE.md §9](CLAUDE.md) has the details.

**Never commit captures from a real Homey.** `/test/fixtures/raw/` is gitignored for this reason;
[`test/fixtures/README.md`](test/fixtures/README.md) lists exactly what a `getDevices` or `getFlows`
dump carries.

## Reporting a bug

Homey settings → Lightkeeper → Diagnostics → **Copy for a bug report**. The export is generated
locally and deliberately contains no API key material. Skim it before posting — it does include
your device and zone names.
