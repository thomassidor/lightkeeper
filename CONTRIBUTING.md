# Contributing

Thanks for taking a look. This is a small app with a specific shape — a few things will save you
time before you change anything.

## Getting set up

```bash
npm install
npm test          # unit tests, no Homey needed
npm run typecheck
```

You need the Homey CLI for anything that touches real hardware:

```bash
npm install -g homey
homey login
```

## Running it on a Homey

**Use `homey app install`, not `homey app run`.**

`homey app run` creates a debug session and **uninstalls the app when the CLI exits**, taking its
app settings with it — including the stored API key. Pairing against a session that has ended
gives screens that render but do nothing, because the handlers are gone. Restart testing needs a
persistent install regardless.

If you do use `run`, `--remote` is not optional: since CLI 3.x a bare `homey app run` runs the app
in a local Docker container, which is not a faithful context for anything touching app-scoped
permissions.

```bash
homey app install              # persistent — use this
homey app run --remote         # live logs, but temporary
homey app validate --level publish
```

**Do not share an API key between the app and an external script.** A key embeds a session ID, and
concurrent holders appear to invalidate one another.

## Before you open a PR

- `npm test` and `npm run typecheck` pass.
- `homey app validate --level publish` passes.
- New user-facing strings exist in `locales/en.json` — never inline in HTML or in `lib/`. The locale
  test enforces this: every defined key must be referenced, every referenced key must be defined.
  The app is English-only for now, but a string hardcoded in HTML or in `lib/` can never be
  translated at all, and `lib/` has no access to `homey.__` — so pass a locale key up through
  `StateDetail` instead. Adding a language later means dropping in `locales/<lang>.json`; the test
  finds it on disk and starts checking key parity and `__token__` placeholders against it
  automatically. `docs/localisation.md` has the rest of the list.

## House rules

**Never commit captures from a real Homey.** A `getDevices` or `getFlows` dump carries device and
zone names, the owner's display name and Athom user ID, and notification text from existing flows.
`/test/fixtures/raw/` is gitignored for this reason. See `test/fixtures/README.md`.

**Comments explain why, not what.** The codebase is dense with rationale — which bug a guard
prevents, which platform quirk forced a design. That is deliberate; please match it.

**`any` on Homey API boundaries is intentional.** `homey-api` ships JavaScript with JSDoc rather
than type declarations. Everything that is ours is strictly typed.

**Two API clients, deliberately separated.** Reads, subscriptions and `setCapabilityValue` go
through the app's own token; flow **writes** go through the user's Personal API Key. See
`CLAUDE.md` for why, and do not route one through the other.

**Pair views are copies on disk, and `npm run sync:views` is what makes them.** Every driver's
`repair/` folder holds byte copies of its `pair/`, and the schedule driver's `credential.html` and
`targets.html` are byte copies of the controller's — Homey needs a real file in each place and will
not follow a reference. Edit the controller's copy of a shared view, then run the script. `npm test`
fails on drift and names it; nothing runs it for you.

**Schedules fire from generated Flows, not from timers.** The SDK has no scheduler, and Homey's own
time trigger already handles DST, clock changes and restarts. The app only decides what a Flow cannot
express — the day of the week, the pause switch, and what "on" means for lights that may not all dim.
Keep it that way: a timer in the app would have to re-derive everything the Flow engine already
guarantees. `CLAUDE.md` §9 has the details.

## Reporting a bug

Homey settings → Lightkeeper → Diagnostics → **Copy for a bug report**. The export is generated
locally and deliberately contains no API key material. Skim it before posting — it does include
your device and zone names.
