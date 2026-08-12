# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.

Light Link is a Homey Pro app that turns an already-paired remote, switch or dial into a
controller for already-paired lights, by generating and maintaining the Flows underneath.

## Commands

```bash
npm test                       # unit tests via node --test + tsx. No hardware needed.
npm run typecheck              # tsc --noEmit
npm run build                  # tsc, emits to .homeybuild/
npx homey app validate --level publish
npx homey app install          # persistent install on a real Homey
npx homey app run --remote     # live logs, TEMPORARY — see below
```

Run a single test file: `node --import tsx --test test/unit/ramp-engine.test.ts`

## The one thing to know before reading the code

**An app's own token cannot write Flows.** `createFlow` through `HomeyAPI.createAppAPI` — which
authenticates with `homey.api.getOwnerApiToken()` — is refused with `403 Missing Scopes`, thrown
server-side at `SessionLocal.checkScopes`. A user-supplied Personal API Key succeeds, including
from inside the app process.

So the app runs **two API clients**, and this is not incidental:

| Client | Auth | Used for |
|---|---|---|
| `createAppAPI({ homey })` | the app's own token | device and zone reads, capability subscriptions, `setCapabilityValue`, flow **reads** |
| `createLocalAPI({ address, token })` | the user's Personal API Key | flow **writes** only — create, update, delete, folders |

Both live in `lib/homey-api-service.ts`. `address` comes from `homey.api.getLocalUrl()`, which is
`http://127.0.0.1:80` inside the app — no LAN discovery.

The split bounds the blast radius: when the key dies, controllers keep driving lights and only
Flow maintenance degrades. That is a health state (`needs_credential`), not an outage, and it is
distinct from `needs_repair` — repair means remap, this means re-enter a key and keep everything.

**Do not route flow writes through the app client, or reads through the key client.**

## Phase 0 traps

Four findings that are easy to get wrong and expensive to rediscover. Full detail in
[`docs/spike-result.md`](docs/spike-result.md).

1. **Device trigger cards are found by card ID, not by URI.** Device-scoped cards match
   `card.id.startsWith('homey:device:' + deviceId + ':')`. No card carries a `uri` of
   `homey:device:<deviceId>` — the obvious reading matches nothing and makes every remote look
   eventless.
2. **Never construct a card `uri`.** A card's `uri` embeds its own id
   (`homey:flowcardaction:homey:manager:alarms:enable_next`), not `homey:app:<appId>`.
   Constructing one yields `404 Not Found`, which reads like a permission failure. Always
   enumerate the card and echo its `uri` and `id` back verbatim.
3. **`droptoken` is a top-level property of an action**, not an argument. A trigger's own token is
   referenced by its bare id.
4. **Capability echoes arrive duplicated**, and `light_temperature` is normalised 0–1, not mireds.
   `TargetStateCache` dedupes echoes within 1500 ms, or the ramp engine reads a duplicate as an
   external change and cancels the ramp.

Also: **"same owning app" must never be a match route** for trigger cards. It offers Hue
motion-area triggers as buttons on a Hue dial.

## Working on a real Homey

**Use `homey app install` for interactive testing, not `homey app run`.** `run` creates a debug
session and **uninstalls the app when the CLI exits**, taking its app settings with it — including
the stored API key. Pairing against an ended session gives screens that render but do nothing,
because the handlers are gone.

**`--remote` is not optional on `run`.** Since CLI 3.x a bare `homey app run` runs the app in a
local Docker container. `--remote` uploads and runs it on the Homey, which is also the only
faithful context for anything touching app-scoped permissions.

**Never share an API key between the app and an external script.** A key embeds a session id, and
concurrent holders appear to invalidate one another.

## Layout

```
app.ts                          app entry, bridge action listeners, §12 validation on receipt
api.ts                          app Web API consumed by settings/index.html
lib/
  homey-api-service.ts          both API clients, subscription tracking and teardown
  credential-service.ts         the API key: storage, write-validation, failure classification
  device-catalog.ts             devices, zones, owning apps, capability metadata
  source-discovery-service.ts   trigger card discovery, event-surface fingerprints
  inputs/                       input contract, normalizer, magnitude collapse
  mapping/                      mapping engine, supersede gate, behaviour types
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine
  bridge/                       binding compiler, flow bridge manager, reconciler
  runtime/                      controller runtime, manager, health monitor
  profiles/                     profile schema, repository, migrations
drivers/controller/             virtual device, driver, four pairing views
settings/index.html             app settings page
locales/{en,da}.json            all user-facing strings
test/                           unit tests and hand-transcribed fixtures
docs/                           spike findings, implementation plan, store submission notes
```

## Conventions

**Comments explain why.** Module headers give the rationale, and inline comments record which bug
a guard prevents. Match that density — it is the main reason this code is navigable.

**`§n` references are load-bearing.** They point at sections of
`light-link-app-specification.pdf` in the repo root, which is the source of truth for intent.
`docs/spike-result.md` is the source of truth for how Homey actually behaves.

**`any` at Homey API boundaries is deliberate.** `homey-api` ships JavaScript with JSDoc rather
than type declarations. Everything of ours is strict — `strict: true`, `noImplicitOverride: true`.

**Translation belongs to the device layer.** `lib/` has no access to `homey.__`, so anything
user-facing produced there returns a locale key plus tokens via `StateDetail`
(`lib/profiles/controller-profile.ts`), and `drivers/controller/device.ts` resolves it. A string
hardcoded in `lib/` is English-only no matter what the locale files say. `test/unit/locales.test.ts`
enforces the invariant in both directions: no defined key unused, no referenced key undefined.

**Tests use `node --test` with `tsx`.** No framework. Fixtures in
`test/fixtures/reference-devices.ts` are transcribed from four real remotes; the expected
normalised catalogues are authored by hand in the test files, so the tests prove the normalizer
rather than the fixture.

**Never commit captures from a real Homey.** They carry device and zone names, the owner's display
name and Athom user ID, and notification text from existing flows. `/test/fixtures/raw/` is
gitignored. See `test/fixtures/README.md`.

## Safety properties worth preserving

These are load-bearing product guarantees, not implementation details:

- **Ramps hard-stop after 10 seconds.** Not configurable, deliberately not read from settings.
  Release events are routinely dropped on Zigbee and unreliable on Matter/Thread, so a stuck ramp
  is a certainty rather than a risk.
- **Flows that look user-edited are never overwritten.** The controller is marked for repair
  instead.
- **Deleting a controller deletes only the Flows demonstrably created by it.** Attribution is the
  controller id carried in the bridge action's arguments.
- **The orphan sweep refuses to run when no controller is live**, because every managed Flow would
  then look orphaned.
- **The API key is never logged, never returned over the app API, and never included in
  diagnostics.** Errors are classified before logging, because an error object can echo the token.
- **Range expansion is capped at 12 flow variants.** Beyond that the control is declined rather
  than flooding the user's Flow list.

## Built with AI

This app was designed and written end to end with Claude — architecture, implementation, tests and
documentation. A human directed the work, made the product decisions, and verifies behaviour on
real hardware.

Two practical consequences if you are picking this up:

- The specification PDF and `docs/spike-result.md` capture intent and observed platform behaviour
  more completely than the code alone does. Read them before changing anything structural.
- The unusually dense *why*-comments and `§n` cross-references are the durable record of decisions
  that were reasoned through once. Prefer updating them over stripping them.
