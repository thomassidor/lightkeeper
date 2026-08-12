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
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine
  bridge/                       binding compiler, flow bridge manager, reconciler
  runtime/                      controller runtime, manager, health monitor
  profiles/                     profile schema, repository, migrations
drivers/controller/             virtual device, driver, four pairing views
settings/index.html             app settings page
locales/{en,da}.json            all user-facing strings
test/                           unit tests and hand-transcribed fixtures
release-materials/              store assets and submission material (excluded from the app bundle)
```

---

# Homey platform reference

Everything below was established against real hardware: Homey Pro 2023, firmware 13.4.0,
homey-api 3.19.2. It is how Homey actually behaves, as opposed to how it appears to, and it is not
documented anywhere else.

## 1. An app's own token cannot write Flows

This is the single fact that makes the architecture legible.

`createFlow` through `HomeyAPI.createAppAPI` — which authenticates with
`await homey.api.getOwnerApiToken()` — is refused with `403 Missing Scopes`, thrown server-side:

```
Error: Missing Scopes
    at SessionLocal.checkScopes (file:///app/packages/homey-core/lib/Session.mjs:86:13)
    at file:///app/packages/homey-core/lib/ManagerApi.mjs:386:19
```

Every flow **read** succeeds; every flow **write** is refused. A user-minted Personal API Key
succeeds at the full create/read/delete lifecycle, **including from inside the app process**.

Corroborating detail worth not re-deriving:

- `homey:manager:api` is the **only** API permission that exists
  (`homey-lib/assets/app/permissions.json`). There is no finer-grained flow permission to request,
  so this is not a manifest omission.
- The refusal is against the app's *session*, not the account.
- Athom's position on Web API scopes: *"Clients using the Web API with OAuth2 cannot have these
  scopes for obvious security reasons"*, pointing users at Settings → API Keys on Homey Pro 2023
  and newer.
- **Homey Pro 2019 and earlier cannot mint API Keys at all**, which is what sets the app's
  compatibility floor.

### Consequence: two API clients, deliberately separated

| Client | Auth | Used for |
|---|---|---|
| `createAppAPI({ homey })` | the app's own token | device and zone reads, capability subscriptions, `setCapabilityValue`, flow **reads** |
| `createLocalAPI({ address, token })` | the user's Personal API Key | flow **writes** only — create, update, delete, folders |

Both live in `lib/homey-api-service.ts`. `address` comes from `homey.api.getLocalUrl()`, which
returns `http://127.0.0.1:80` inside the app — no LAN discovery needed.

The split bounds the blast radius: when the key dies, controllers keep driving lights and only Flow
maintenance degrades. That is a health state (`needs_credential`), distinct from `needs_repair` —
repair means remap, this means re-enter a key and keep every mapping.

**Do not route flow writes through the app client, or reads through the key client.**

## 2. API key sessions die, routinely

A Homey API Key is `<userId>:<sessionId>:<secret>`. The middle segment is a **session ID**; the key
string is only a reference to it. When that session is invalidated the key stops working although
the string on disk is unchanged.

This was observed twice within hours during development, once about twenty minutes after first use.
Key invalidation is a near-certainty, not an edge case, and `CredentialService` treats it as a
first-class runtime state rather than an error path.

Three failures that look alike and mean completely different things:

| Error | Meaning | Fix |
|---|---|---|
| `401 Missing Session ID in Token` | not a real key — placeholder or truncated paste | paste the whole key |
| `401 Session Not Found` | valid key string, session gone | re-mint |
| `403 Missing Scopes` | valid session, insufficient permission | re-mint with Flow scope |

`classifyCredentialError()` maps these; conflating them sends users to the wrong fix.

**Working hypothesis: one live session per API key.** A second `createLocalAPI` handshake appears
to claim or replace the session, invalidating the first holder. So: **never share a key between the
app and any external tool.** Two holders fight, and the symptom is a key that "randomly" stops
working.

**Validate a key with a WRITE, not a read.** Reads succeed on credentials that cannot write, so a
read-based check gives false confidence. `setCredential` proves the key by creating a flow folder
and immediately deleting it.

## 3. Never construct a flow card URI

The verbatim serialisation of a flow created through the API:

```json
{
  "trigger": {
    "uri": "homey:flowcardtrigger:homey:manager:flow:programmatic_trigger",
    "id": "homey:manager:flow:programmatic_trigger",
    "args": {}
  },
  "actions": [
    {
      "uri": "homey:flowcardaction:homey:manager:alarms:enable_next",
      "id": "homey:manager:alarms:enable_next",
      "args": {}
    }
  ]
}
```

A card's `uri` is a **full resource URI that embeds its own id**, prefixed by card type. It is
**not** `homey:app:<appId>`, which is what the SDK docs' phrasing suggests.

**Rule: never construct a card URI. Enumerate the card and echo its `uri` and `id` back verbatim.**
Getting this wrong produces `404 Not Found: FlowCardAction with ID <x>`, which reads like a
permission refusal.

Also: an app's own cards exist only while that app is running. A 404 may mean "not running", not
"not permitted".

## 4. Device trigger cards are found by card ID, not by URI

`getFlowCardTriggers()` returns ~1700 cards. Device-scoped cards encode their device in the card
**`id`**:

```
homey:device:<deviceId>:<cardName>
```

There is **no card whose `uri` equals `homey:device:<deviceId>`**. Matching on `uri` finds exactly
nothing and makes every remote look eventless.

The discovery rules, in rank order:

1. **`device_scoped`** — `card.id.startsWith('homey:device:' + deviceId + ':')`. This is the real
   route; every reference device resolves through it.
2. **`device_arg`** — an app-level card with a `device`-typed argument whose `filter` matches. Rare.
3. **`device_arg_unfiltered`** — an unfiltered device argument matches every device on the Homey
   and is near worthless; it offered "LG refrigerator error changed" as an input for a Tap Dial.
   Keep it reachable (says never hard-filter) but rank it last.
4. **"Same owning app" must NOT be a match route.** It offered Hue motion-area triggers as buttons
   on a Hue dial. A ranking hint at best.

Device-scoped cards also include system capability cards (`measure_battery_threshold_above`,
`alarm_motion_true`, `*_changed`, `*_duration`). These are state changes, not input events, and the
normalizer separates them — a remote typically exposes about 5 real input cards among ~10
capability ones.

## 5. Token encoding

From a hand-built flow:

```json
{
  "id": "homey:device:<id>:action_upload_file_flow",
  "group": "then",
  "delay": null,
  "duration": null,
  "droptoken": "homey:device:<id>|image-camera-snapshot",
  "args": {}
}
```

- **`droptoken` is a top-level property of the action, not an entry in `args`.**
- Actions carry `group: "then"`, plus nullable `delay` and `duration`.
- **Global token** → `"<ownerUri>|<tokenId>"`.
- **Local token from the flow's own trigger card** → the **bare token id**, e.g. `"steps"`.
- **Token identity is `token.id`, never `token.name`.** Using `name` silently produces broken flows.
- Autocomplete-typed args serialise as the whole selected object (`{id, name, image, …}`), not just
  an id. Dropdown args store the value id.

## 6. Capability behaviour

**Echoes arrive duplicated.** Setting `dim` once produces two identical callbacks. `TargetStateCache`
dedupes within a 1500 ms window, or optimistic desired state fights itself and the ramp engine reads
a duplicate as an external change that cancels the ramp.

**Capability options are not uniform — read them, never assume:**

| Capability | Options as read |
|---|---|
| `onoff` | `{}` — no min/max/step at all |
| `dim` | `{ min: 0, max: 1, units: "%", decimals: 2 }` |
| `light_temperature` | `{ min: 0, max: 1, units: null, decimals: 2 }` |

**`light_temperature` is normalised 0–1**, not mireds or kelvin, so temperature deltas work on the
same normalised axis as brightness. `decimals: 2` implies a meaningful step of 0.01 — a smaller
delta is a no-op and is accumulated rather than written.

A `setCapabilityValue` write to a Hue Bridge light acks in roughly 275 ms. That is the output leg
only; radio time and flow-engine dispatch upstream of the bridge card are not observable from
inside an app.

## 7. Reference device event surfaces

The four remotes the fixtures in `test/fixtures/reference-devices.ts` are transcribed from. Note
how differently they behave — this is why capability is resolved at runtime and never hardcoded.

**IKEA STYRBAR** — `com.ikea.tradfri:remote_control_n2`, class `remote`, Zigbee local

| Card | Meaning |
|---|---|
| `n2_on` / `n2_off` | up / down pressed |
| `n2_dim_up` / `n2_dim_down` | up / down **long** pressed |
| `n2_scene_up` / `n2_scene_down` | right / left pressed |

Fixed cards, no arguments, no tokens. Up and down carry **both** press and long-press — these are
the controls the supersede gate exists for, and grouping `n2_on` with `n2_dim_up` under one
`controlId` is the normalizer's job. Left and right expose press only, so no hold is offered there.

**Hue Dimmer v2** — `nl.philips.hue:dimmerswitch`, Hue Bridge

One card only: `dimmerswitch_button_pressed`, `button` dropdown =
`[on | increase_brightness | decrease_brightness | off]`. **No long-press card exists** through this
integration. Offering hold here would be inventing a gesture.

**Hue Tap Dial** — `nl.philips.hue:tapdial`, Hue Bridge

| Card | Args | Tokens |
|---|---|---|
| `tapdial_button_pressed` | `button` = `[button1…button4]` | — |
| `tapdial_dial_rotation_started` | `rotate_direction` = `[either \| counter_clock_wise \| clock_wise]` | — |
| `tapdial_dial_rotation_stopped` | `rotate_direction` (same) | **`steps:number`** "Steps (1000/turn)" |
| `tapdial_dial_rotation_dimmed` | — | `dim_level:number` "Resulting dim level" |

Magnitude arrives as the `steps` token on rotation **stopped** — after the gesture, at 1000 steps
per turn. That is stepping, not ramping, and it is why `normaliseMagnitude()` scales by the
integration's declared units-per-turn: a small nudge arrives as 151, and multiplying a 0.1 step by
151 slams the lights to full on first touch. `dim_level` is an **absolute** level, not a delta.

**IKEA BILRESA** — `com.ikea.tradfri:matter_bilresa_scroll_wheel`, class `button`, Matter/Thread

| Card | Args |
|---|---|
| `switch_initial_press_multi` | `button` = `[1…9]` |
| `switch_press_multi` | `button` = `[1…9]` |
| `switch_long_press_multi` | `button` = `[3 \| 6 \| 9]` |
| `switch_long_press2_multi` | `button` = `[3 \| 6 \| 9]` |
| `switch_multi_press_multi` | `button` = `[1…9]`, `count` = `[1…18]` |

`switch_multi_press_multi` is 9 × 18 = **162 combinations**, exceeding the expansion ceiling of 12
thirteenfold — this is what the ceiling exists for. `count` reaching 18 is strong evidence it
encodes **wheel detents, not repeated clicks**. Only buttons 3, 6 and 9 support long press,
suggesting 9 logical endpoints map onto 3 physical buttons plus wheel positions.

No release or "stopped" card exists for BILRESA, so no hold-ramp is offered — stepping only.

BILRESA is also the device one-tap re-attach exists for: its cards vanish after a Homey restart
and the device must be re-added under a new id. That is recurring, not exceptional, and making the
user redo the mapping every time would defeat the product.

---

# Working on this codebase

## Running it on a real Homey

**Use `homey app install` for interactive testing, not `homey app run`.** `run` creates a debug
session and **uninstalls the app when the CLI exits**, taking its app settings with it — including
the stored API key. Pairing against an ended session gives screens that render but do nothing,
because the handlers are gone.

**`--remote` is not optional on `run`.** Since CLI 3.x a bare `homey app run` runs the app in a
local Docker container. `--remote` uploads and runs it on the Homey, which is also the only
faithful context for anything touching app-scoped permissions.

## Conventions

**Comments explain why.** Module headers give the rationale, and inline comments record which bug a
guard prevents. Match that density — it is the main reason this code is navigable.

**`any` at Homey API boundaries is deliberate.** `homey-api` ships JavaScript with JSDoc rather than
type declarations. Everything of ours is strict — `strict: true`, `noImplicitOverride: true`.

**Translation belongs to the device layer.** `lib/` has no access to `homey.__`, so anything
user-facing produced there returns a locale key plus tokens via `StateDetail`
(`lib/profiles/controller-profile.ts`), and `drivers/controller/device.ts` resolves it. A string
hardcoded in `lib/` is English-only no matter what the locale files say.
`test/unit/locales.test.ts` enforces the invariant in both directions: no defined key unused, no
referenced key undefined, both languages agreeing on keys and on `__token__` placeholders.

**Pair views share ONE document.** The four views under `drivers/controller/pair/` are injected into
the pairing container's document rather than getting their own iframe. They must not load `homey.js`
themselves, every CSS rule is scoped to the view's root id, and the boot guard lives on the root
element rather than in a global. Each file's header explains this.

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
- **The orphan sweep refuses to run when no controller is live**, because every managed Flow would
  then look orphaned.
- **The API key is never logged, never returned over the app API, and never included in
  diagnostics.** Errors are classified before logging, because an error object can echo the token.
  `test/unit/diagnostics-redaction.test.ts` asserts this against serialised output.
- **Bridge arguments are untrusted.** Generated flow arguments are user-editable, so every incoming
  bridge event is validated against a live controller and an expected binding key before anything
  executes. On malformed or stale input, fail closed — log and ignore, never execute heuristically.
- **Range expansion is capped at 12 flow variants.** Beyond that the control is declined rather than
  flooding the user's Flow list.

## Built with AI

This app was designed and written end to end with Claude — architecture, implementation, tests and
documentation. A human directed the work, made the product decisions, and verified behaviour on
real hardware.

One practical consequence if you are picking this up: the dense *why*-comments, the platform
reference above and the `§n` tags are the durable record of decisions reasoned through once, and of
platform behaviour that took real hardware to establish. Prefer updating them over stripping them.
