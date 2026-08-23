# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.

Lightkeeper is a Homey Pro app that does two things to already-paired lights, both by generating
and maintaining the Flows underneath: it turns an already-paired remote, switch or dial into a
controller for them, and it puts them on a schedule.

## Commands

```bash
npm test                       # unit tests via node --test + tsx. No hardware needed.
npm run typecheck              # tsc --noEmit, the app only
npm run typecheck:test         # the suite and scripts/, via tsconfig.test.json
npm run validate               # homey app validate --level publish, CLI pinned
npx homey app install          # persistent install on a real Homey
npx homey app run --remote     # live logs, TEMPORARY — see below
npm run sync:views             # pair -> repair, and shared views between drivers. See §8
python docs/artwork/export-assets.py   # re-export every shipped icon, image and the banner
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
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine
  bridge/                       binding compiler, flow bridge manager, reconciler
  runtime/                      controller runtime, manager, health monitor, shared target health
  profiles/                     profile schema, repository, migrations
  schedules/                    types, window maths, local clock, bindings, runtime, manager
  pairing/                      the light picker, shared by both drivers
drivers/controller/             virtual device, driver, four pairing views
  pair/                         the four views, edited here
  repair/                       exact copies of pair/, generated — see §8
drivers/schedule/               virtual device, driver, three pairing views
  pair/                         credential.html and targets.html are COPIES of the
                                controller's; only schedule.html is its own — see §8
  repair/                       exact copies of pair/, generated — see §8
scripts/sync-views.mjs          makes every copy named above; nothing runs it for you
settings/index.html             app settings page
locales/en.json                 all user-facing strings
test/                           unit tests and hand-transcribed fixtures
docs/                           review notes, privacy, localisation, artwork masters (not bundled)
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

**HIGHER IS WARMER on that axis: 0 is the coolest end, 1 the warmest.** This is not a guess and not
a convention we chose — `homey-lib`'s own capability definition
(`assets/capability/capabilities/light_temperature.json`) states it in the hint for its
`temperature` flow action: *"Adjusts the temperature of the light. A higher value means a warmer
color."* It cost a real bug to learn: both the controller's `warmer`/`colder` mapping and the
schedule screen's warmth labels assumed the opposite, so a schedule set to "Warmest" wrote 0 and
lit a room cold white on the first live run. Anything that reasons about this axis — a delta's
sign, a slider's labels, a default — must go the same way.

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

## 8. Repair views live in their own folder, and validation cannot tell you

Homey serves pair views from `drivers/<driverId>/pair/<viewId>.html` and repair views from
`drivers/<driverId>/repair/<viewId>.html`. **Two separate folders.** The CLI's own
`HomeyCompose.js` shows it: the pair branch writes templated views into `.../<driverId>/pair`, the
repair branch into `.../<driverId>/repair`.

Declaring `repair` views in `driver.compose.json` without that second folder is not a validation
error. `homey-lib` asserts the existence of the **pair** view files only
(`_ensureFileExistsCaseSensitive('drivers', <id>, 'pair', '<viewId>.html')`) and has no equivalent
check for repair — `repair` is not even in its app schema, merely tolerated. So the app passes
`homey app validate --level publish`, ships, and then every Repair fails on the device with Homey's
own untranslated

```
Error: unknown_error_getting_file
```

thrown before a single app screen renders. It reads like a corrupt install; it means one HTML file
is in the wrong folder. Repair is where re-attach, remap and flow-edited recovery all live, so this
turns every `needs_repair` state into a dead end.

Our views are identical in both modes — self-contained, each rule scoped to its own root id,
separate sessions with separate documents, and the one branch that differs (`createDevice` vs
`done`) is already decided by what `save` returns. So `repair/` is a copy of `pair/`, made by
`npm run sync:views` and held there by `test/unit/repair-views.test.ts`, which is the only
thing that can catch a missing repair view before hardware does.

**The same applies between drivers.** The API-key screen and the light picker are one screen each,
used by both the controller and the schedule driver, and Homey will not follow a reference: each
driver needs its own real file. So `drivers/schedule/pair/credential.html` and `targets.html` are
copies too, made by the same script and compared by the same test. The credential view stays
driver-agnostic because the **driver** tells it which view comes next (`nextView` on the
`getCredentialStatus` reply) — a view that hardcoded `showView('source')` would silently strand the
schedule flow, since `source` is not one of its screens.

`test/unit/pair-view-styles.test.ts` discovers views from disk across every driver for the same
reason: while it hardcoded `drivers/controller/pair`, a second driver's screens could break the
scoping and colour-token conventions with nothing failing.

## 9. Time comes from the Flow engine, because the SDK has no scheduler

SDK v3 has **no cron manager** — v2's `ManagerCron` is gone, and the full `manager/` list (api, apps,
arp, audio, ble, clock, cloud, dashboards, discovery, drivers, flow, geolocation, i18n, images,
insights, ledring, nfc, notifications, rf, settings, speech-input, speech-output, zigbee, zwave) has
nothing else that fires at a time. There is no sunrise/sunset helper either; `ManagerGeolocation`
offers latitude and longitude and requires `homey:manager:geolocation`, which this app does not
declare.

What the SDK does give, and all a schedule needs:

| Call | Notes |
|---|---|
| `this.homey.clock.getTimezone()` | synchronous, an IANA name, **no permission required** — unlike every geolocation method |
| `this.homey.setTimeout` / `setInterval` | disposal-safe aliases, cleaned up when the Homey instance is destroyed |

`homey-api`'s own clock manager exposes only `getState` under the `homey.system.readonly` scope, so
it needs a scoped token. `this.homey.clock.getTimezone()` is free and is what we use.

**So schedules fire from generated Flows, not from timers.** A light schedule compiles to two Flows
per window — one at each boundary — triggered by Homey's own time card and calling our bridge action.
The Flow engine then owns everything hard: DST, clock corrections, re-arming after a restart, and
surviving an app that was not running a moment ago. The app owns only what a Flow cannot express: the
day-of-week filter, the pause switch, and what "on" means for lights that may not all dim.

Consequences worth not re-deriving:

- **The day filter is deliberately NOT in the Flow.** The Flow fires every day and
  `boundaryDayMatches()` checks the weekday on receipt, in the Homey's own timezone. That keeps a
  day-of-week edit from rewriting Flows, and avoids depending on a day-condition card whose shape we
  cannot enumerate ahead of time.
- **A window belongs to the day it STARTED on.** "23:30 for two hours, Fridays" switches off at 01:30
  on a Saturday, and that off event is Friday's. Matching an off event against the day it arrives on
  silently drops every midnight-crossing schedule. `lib/schedules/schedule-window.ts` is the only
  place that knows this, and `test/unit/schedule-window.test.ts` is why it stays known.
- **Everything about time is a wall-clock minute count, 0–1439** — never a timestamp, never a UTC
  offset. Because the Flow engine fires, the app never has to answer "when is the next 22:00 in
  Europe/Copenhagen", only "is it 22:00 there now". That is what keeps DST out of our code entirely.
- **The card, confirmed on hardware** (Homey Pro 2023, firmware 13.4.0, via the app's own
  diagnostics on 18 August 2026):

  | Card | Arguments |
  |---|---|
  | `homey:manager:cron:time_exactly` | `time` of type `time`. **This is the one we use.** |
  | `homey:manager:cron:time_exactly_day` | `time` of type `time`, plus `day` of type `multiselect` |
  | `homey:manager:cron:every` | `minutes` of type `number` |
  | `homey:manager:energy:dynamic_electricity_price_period_{lowest,highest}_start_between` | `duration`, `unit`, `startTime`, `endTime` |

  The trigger argument's value is the wall-clock string `"HH:MM"`. The uri is
  `homey:flowcardtrigger:` + the id, which is §3's rule and is still never constructed — it is
  echoed back from enumeration. The id now also RANKS in `discoverTimeCard()` (`KNOWN_TIME_CARDS`)
  but never filters, so an unfamiliar card of the right shape still works on a firmware we have not
  seen, and `getDiagnostics` keeps reporting every candidate considered.

- **`time_exactly_day` exists and is deliberately NOT used.** It carries the weekday itself, which
  sounds like exactly what a schedule wants. Two reasons against it, and they are the same two that
  put the day filter in the app in the first place: the day set would then live in the Flow, so every
  day-of-week edit would rewrite Flows (and would have to appear in the variant key, or silently
  not); and its `day` argument is a `multiselect` whose accepted value tokens we cannot enumerate
  ahead of time, which is how you get a Flow that validates and never fires. If it is ever worth
  revisiting, the missing piece is that argument's `values` list from `getFlowCardTriggers()` — read
  it, do not guess it. The energy cards above are the reason the shape match requires the time to be
  the ONLY argument.
- **`Intl` timezone data IS present on the Homey's Node build.** Verified on the same firmware:
  `homey.clock.getTimezone()` returned `Europe/Copenhagen` and `localNow()` resolved it to the right
  weekday and minute (`Sat 20:30`). The fallback in `localNow()` — a fixed `en-US` locale, and
  process-local time if `Intl` throws — stays anyway: it costs nothing and the next firmware is not
  something we get to test in advance.

- **What the first live window actually did** (a 20:25–20:30 schedule over three Hue spots,
  18 August 2026). Worth keeping because it is the only measurement of the whole path, and because
  each line confirms a design decision rather than merely working:

  | Observation | What it confirms |
  |---|---|
  | Both boundary Flows fired **~11–22 ms after the minute** | The Flow engine is punctual enough that no app-side timer would improve on it |
  | On-boundary wrote `onoff` ×3, then `dim` ×3, then `light_temperature` ×3 | The write queue's ordering holds across a composed intent — the level lands on a lit lamp |
  | Every write acked, 304–501 ms each, three devices in parallel and serial per device | Comparable to the ~275 ms single-write figure in §6; nothing in the schedule path adds latency |
  | `active: false` in diagnostics at exactly 20:30 | The off boundary is EXCLUSIVE, as `activeWindowStartDay()` and its tests say |
  | Both events accepted, `lastRejection: null` | The day check passed on receipt, and the bridge arguments round-tripped intact |

## 10. Store assets: what is validated, what is reviewed, and what Homey does to your icon

`docs/asset-spec.md` and `docs/artwork/provenance.md` hold the rest. The four facts worth having here, because
each one was learned by reading `homey-lib` inside the CLI's own package rather than from
anything discoverable in this repo:

- **An icon is a CSS MASK fetched from Athom's CDN by its MD5.** Read off a live Homey's DOM:

  ```html
  <span style="--prop-mask-image: url('https://icons-cdn.athom.com/<md5>.svg');
               --prop-size: 50px; --prop-color: var(--theme-color-white);">
  ```

  `<md5>` is exactly the `iconHash` the CLI writes into the manifest — confirmed by hashing
  `assets/icon.svg` and matching it against the URL the UI requested. Two consequences:

  - **Colour inside an icon is discarded; only alpha survives.** That is the mechanism behind
    `homey-lib`'s *"Icons are rendered white, so choose a darker color that has enough contrast"*,
    and it is why a filled two-colour mark becomes the single solid blob guideline 1.5 warns about.
    All three of our icons are line art at `stroke-width="40"` — the app mark adds one filled
    shape, the logo's sparkle, which is fine: `homey-lib`'s own stock icons mix stroked and filled
    paths. They are generated from the SVG masters by `docs/artwork/export-assets.py`.
  - **A CLI-installed app shows NO icon, ever.** That CDN only holds icons from builds Athom
    published, so `homey app install` leaves the mask pointing at a 404 and the UI draws an empty
    `brandColor` circle. This cost a diagnosis: the SVGs render correctly inline, as a sized
    `<img>`, as an unsized `<img>` and as a CSS mask, and the right bytes were in `.homeybuild` —
    the file was never the problem. **Do not redraw anything chasing a blank icon on a dev
    install.** It resolves on publish, test channel included.
- **The validator checks far less than the guidelines say.** `_validateImages` iterates
  `['small', 'large']` only: **`xlarge` is optional and never checked**, at any level. It never
  opens an SVG — there is no driver-icon existence check and no content validation at all. Every
  other rule (line art, transparent, full canvas, "a recognizable picture of the device") is applied
  by a human or by Athom's AI reviewer, so breaking one costs a review round trip, not a red build.
  `test/unit/assets.test.ts` is what makes those rules fail locally instead.
- **A flat mark is rejected as an app or driver IMAGE.** Guideline 1.4: *"Images that consist of a
  single flat shape or icon on a plain, monochrome or transparent background are not approved."*
  Lifestyle photography is what Athom asks for, in those words — which is why the store image and
  both driver pictures are photographs, and why the schedule driver's picture is a lamp rather than
  its own clock icon.
- **Three things simply do not exist**, so do not spend time looking for them: an icon on a flow
  card (the SDK's `icon` property belongs to argument *autocomplete results*), an icon on
  `capabilitiesOptions` (only app-defined custom capabilities can carry one), and any
  screenshot or promotional asset class. Widget previews are the one asset class we ship nothing
  for, and they are a hard build requirement the moment a widget is added.

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

## Releasing a version

The version lives in **three** places and a release is only coherent when all of them agree:

| File | Role |
|---|---|
| `.homeycompose/app.json` | the source of truth |
| `package.json` | must match it |
| `app.json` | **generated** — never hand-edit; the CLI rewrites it from `.homeycompose/` on every `validate`, `build` and `install` |

Every user-visible change ships a changelog entry, in two places with two different audiences:

| File | Audience |
|---|---|
| `.homeychangelog.json` | what Homey shows in the app store. Keyed by the exact version string. Plain user language — what changed for them, never file names or internals |
| `README.md` → `## Changelog` | the same release, for anyone reading the repo. May say *why*, and may name the mechanism |

**The checklist, in one commit:**

1. Bump `.homeycompose/app.json` and `package.json` to the same version. Patch for fixes, minor for
   new capability; pre-1.0 means no major bumps for breaking changes, so say it in the changelog
   instead.
2. Add a `.homeychangelog.json` entry under that exact version.
3. Mirror it under `## Changelog` in `README.md`, newest first.
4. Run `npx homey app validate --level publish` — this is what regenerates `app.json`, so it is a
   required step and not just a check. Commit the regenerated `app.json` with the rest.
5. `npm test`. `test/unit/release-metadata.test.ts` fails if the three versions disagree, if either
   changelog is missing the current version, or if `README.md` states a test count that no longer
   matches the suite.

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
- **CI runs Node 22**, to stay near current firmware, and pins the CLI as `homey@4.4.2`. An
  unpinned `npx homey` changes what "publish-level valid" means between two runs of one commit.
- **`compatibility: >=12.9.0`** — the floor we can stand behind, rather than the older `>=12.3.0`
  that was never tested. Note this is a *firmware* floor; the real hardware floor is Homey Pro
  2023 and newer, because earlier models cannot mint an API Key at all (§1).
- **`category: ["tools", "lights"]`.** Apps holding `homey:manager:api` are reviewed as Tools-style
  cross-app functionality — `homey app validate` says so itself: *"using the homey:manager:api
  permission will require a more thorough review"*. `lights` stays second for discoverability.
- **`npm audit`: four moderate findings, zero high or critical, all accepted.** They are one chain —
  `parseuri` → `engine.io-client` → `socket.io-client` — reached only through `homey-api`, which is
  our single runtime dependency. There is no upstream fix to take, the endpoint being parsed is the
  fixed `http://127.0.0.1:80` from `getLocalUrl()`, and npm's suggested remediation is a downgrade
  of `homey-api` itself. Leave it, and re-check at each dependency bump.
- **`homey-api` is not MIT.** Its LICENSE reads: *may be used freely with Homey products; source
  proprietary to Athom B.V.; no warranty*. Bundling it in a Homey app is exactly the permitted use,
  but it does not inherit this repo's MIT licence and belongs in the rights register as its own line.

## Two device types, one flow lifecycle

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

**`any` at Homey API boundaries is deliberate.** `homey-api` ships JavaScript with JSDoc rather than
type declarations. Everything of ours is strict — `strict: true`, `noImplicitOverride: true`.

**Translation belongs to the device layer.** `lib/` has no access to `homey.__`, so anything
user-facing produced there returns a locale key plus tokens via `StateDetail`
(`lib/profiles/controller-profile.ts`), and `drivers/controller/device.ts` resolves it. A string
hardcoded in `lib/` can never be translated, no matter what the locale files say.
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
than in a global. Each file's header explains this. The `~110`-line shared CSS base is byte-identical
in every view, across both drivers, and `test/unit/pair-view-styles.test.ts` fails on any drift.

**Edit a pair view, then run `npm run sync:views`.** Every `repair/` folder holds byte copies of its
`pair/`, and the schedule driver's `credential.html` and `targets.html` are byte copies of the
controller's, because Homey needs a real file in each place (§8). Edit the controller's copy of a
shared view, never the schedule's. `npm test` fails on drift and names the script; nothing runs it
for you.

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
  Two mechanisms hold it up, and both are load-bearing: `withWriteClient` re-throws a
  `sanitizedWriteError()` rather than the original — the only place in the app where an error has
  been near the key — and `redactKeyMaterial()` scrubs anything key-shaped from a message on its way
  into a log line or a device's unavailable text. An unclassifiable platform error keeps its own
  wording (redacted), because `404 Not Found: FlowCardAction with ID <x>` is the message that costs
  hours and replacing it with "could not reach Homey" sends the next reader elsewhere.
- **One live handshake per API key.** `getWriteClient()` memoises the in-flight attempt. A key holds
  a single session (§2), so two concurrent `createLocalAPI` calls fight over it — and at boot the
  app's own revalidation races every controller's first reconcile. Symptom if this is removed: a key
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
  README rather than hidden.
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

One practical consequence if you are picking this up: the dense *why*-comments, the platform
reference above and the `§n` tags are the durable record of decisions reasoned through once, and of
platform behaviour that took real hardware to establish. Prefer updating them over stripping them.
