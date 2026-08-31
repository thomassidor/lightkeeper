# Homey platform reference

**Cited in code as `platform §n`.** Around ninety comments across `lib/`, `app.ts`, `api.ts` and
the tests point here — `(platform §6)` means section 6 of this file. Grep `platform §` to find
every site that depends on something written down below.

This is how Homey actually behaves, as opposed to how it appears to, and it is documented nowhere
else. Every section was established against real hardware: Homey Pro 2023, firmware 13.4.0-13.4.1,
homey-api 3.19.2. Prefer updating a section over stripping it — each one is a decision reasoned
through once, or a platform fact that cost real hardware to establish.

Who this is for: anyone changing this code, human or agent. [`../CLAUDE.md`](../CLAUDE.md) has the
repo's own conventions and working practices and links back here;
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) is the short version.

---

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

**The same rule holds for DRIVER ids, and it caught us a second time.** A driver's id over the Web
API is `homey:app:<appId>:<driverName>` — verified on hardware, 28 August 2026:

```
homey:app:com.thomassidor.lightkeeper:circadian
homey:app:com.thomassidor.lightkeeper:controller
homey:app:com.thomassidor.lightkeeper:curve
homey:app:com.thomassidor.lightkeeper:schedule
```

`scripts/verify-hardware.mjs pairspike` built it as `<appId>:<driverName>` and got
`Not Found: Driver with ID com.thomassidor.lightkeeper:circadian` — which reads like the endpoint
refusing the request, and is nothing of the sort. Enumerate `drivers.getDrivers()` and match; never
assemble the id.

Note the asymmetry that makes this easy to get wrong: a **device**'s `driverId` is not something we
build either, but it is handed to us on every device object, so nothing forces the question. A
**pair session** is the one place a driver id has to be supplied rather than echoed.

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

**`light_mode` gates BOTH of the things it selects, and only one half was ever written.** A lamp in
colour mode ignores a `light_temperature` exactly as a lamp in temperature mode ignores a
`light_hue` — silently, in both directions: the write is accepted, `ok: true` is recorded, and the
lamp keeps its old value. The planner set `light_mode: 'color'` before hue and saturation and set
nothing before temperature, which was invisible until one device wrote both to one lamp. A Curve
light with a coloured point does: the colour put the lamp into colour mode and every later
temperature-only point was discarded by the lamp.

Measured on hardware, 30 August 2026: written 0.430, held 0.870, and the lamp refused a temperature
from *anything* — this app or a direct API write — until its mode changed. With
`light_mode: 'temperature'` written first, the same lamp took 0.800 and held 0.840.

Two consequences, both load-bearing:

- `planTemperature()` mirrors `planColor()`, and `WRITE_ORDER` in the command scheduler puts
  `light_mode` ahead of **both** `light_temperature` and `light_hue`. It used to sit between them,
  so adding the write alone would have been reordered to arrive after the value it enables.
- Anything writing a temperature by hand — a script standing in for a user — has to switch the mode
  too, or it reproduces the bug instead of the person.

**A lamp need not report back the value it was written.** It clamps to its own physical range and
quantises to its own steps, and neither is visible in the capability options Homey reports. Measured
on the same pass: 0.930 written and 0.850 held on a bulb at its warm ceiling; 0.800 written and
0.840 held. So a check that a write "took" has to allow roughly 0.1 — loose enough for quantisation,
far tighter than the 0.44 gap a discarded write leaves.

**Writing to an "off" lamp has THREE outcomes, not two.** Pre-staging asks whether a lamp can be
given a colour while off, and the answers are: it stays off (pre-staging works); it comes on (it does
not, and the app puts it back and disables the option); or **the integration declines the write** —
a Hue Bridge answers `device (light) <id> is "soft off", command (.color_temperature.mirek) may not
have effect`. Measured 30 August 2026 on a Hue lamp, while a second lamp on the same Homey accepted
the write and stayed off, so this is per-lamp rather than per-bridge. The third outcome means what
the second does; `probePreStage()` reports it rather than throwing, because unguarded it reached the
pairing screen as that raw sentence under a button labelled "Test it".

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
sign, a slider's labels, a default, the direction a circadian curve rises in (§12) — must go the
same way.

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
- **A CIRCADIAN light is the one thing here that may use a timer, and §12 says why.** Everything
  above is about a BOUNDARY: something that has to happen at 22:00 whether or not the app was
  running a moment ago. A curve has no boundaries, so none of this applies to it — do not "fix" it
  into Flows.
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

`artwork/asset-spec.md` and `artwork/provenance.md` hold the rest. The four facts worth having here, because
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
    All five of our icons are line art RENDERING at 40 units on the 960 canvas — the authored
    attribute is that divided by the fit scale, so grepping for `stroke-width="40"` finds nothing.
    The app mark adds one filled shape, the logo's sparkle, which is fine: `homey-lib`'s own stock icons mix stroked and filled
    paths. They are generated from the SVG masters by `artwork/export-assets.py`.
  - **The App Store draws a driver icon into a 24 px box, and that is the size to draw for.** Read
    off `homey.app/css/pages/app.*.css`: a flow card's `.icon` is `width: 40px; height: 40px;
    padding: 8px; border-radius: 100%` filled with `brandColor`, and the `.icon-inner` inside it is
    `background: white` with `mask-size: contain`. 40 less 8 a side is **24×24 of ink** — the
    tightest place an icon ever appears, and less than half the 50 px `--prop-size` above. On a 960
    canvas that is a scale of 0.025, so a 34-unit stroke lands at 0.85 px and washes out. 0.5.0
    shipped four device icons that were unreadable there: each hung its subject inside a
    rounded-square frame that ate two thirds of the canvas, and the circadian one carried seventeen
    separate strokes. The fix was fewer, larger elements at the house weight, not a heavier line.
    `npm run render:icons` reproduces that markup and CSS exactly, at 24, 34, 48 and 144 px of ink,
    and is the only way to see this before publishing.
  - **A CLI-installed app shows NO icon, ever.** That CDN only holds icons from builds Athom
    published, so `homey app install` leaves the mask pointing at a 404 and the UI draws an empty
    `brandColor` circle. This cost a diagnosis: the SVGs render correctly inline, as a sized
    `<img>`, as an unsized `<img>` and as a CSS mask, and the right bytes were in `.homeybuild` —
    the file was never the problem. **Do not redraw anything chasing a blank icon on a dev
    install.** It resolves on publish, test channel included.

    The converse trap is a blank icon on a PUBLISHED listing, which is a different fault and worth
    telling apart: fetch the mask URL out of the page's own markup and look at what comes back.
    `apps.homeycdn.net/app/<id>/<build>/<uuid>/drivers/<driver>/assets/icon.svg` returned
    `200 image/svg+xml` with our exact bytes, and the surrounding markup was identical to what IKEA
    Trådfri and Philips Hue get — which ruled out the CDN, CORS and the mask technique in one
    command and left the drawing itself, at 24 px, as the only variable.
- **The validator checks far less than the guidelines say.** `_validateImages` iterates
  `['small', 'large']` only: **`xlarge` is optional and never checked**, at any level. It never
  opens an SVG — there is no driver-icon existence check and no content validation at all. Every
  other rule (line art, transparent, full canvas, "a recognizable picture of the device") is applied
  by a human or by Athom's AI reviewer, so breaking one costs a review round trip, not a red build.
  `test/unit/assets.test.ts` is what makes those rules fail locally instead.
- **A flat mark is rejected as an app or driver IMAGE.** Guideline 1.4: *"Images that consist of a
  single flat shape or icon on a plain, monochrome or transparent background are not approved."*
  Lifestyle photography is what Athom asks for, in those words — which is why the store image and
  both driver pictures are photographs, and why the schedule driver's picture is a photograph of a
  plug-in timer rather than a rasterised icon.
- **Three things simply do not exist**, so do not spend time looking for them: an icon on a flow
  card (the SDK's `icon` property belongs to argument *autocomplete results*), an icon on
  `capabilitiesOptions` (only app-defined custom capabilities can carry one), and any
  screenshot or promotional asset class. Widget previews are the one asset class we ship nothing
  for, and they are a hard build requirement the moment a widget is added.

## 11. Flow folders nest, and every lookup must key on (name, parent)

Generated flows are filed one folder per Lightkeeper device, inside the app's own folder:
`Lightkeeper/<device name>/`. `lib/bridge/flow-folder-manager.ts` owns all of it, so
`FlowBridgeManager` stays about flows.

- **Nesting is real.** `FlowFolder` is `{ id, name, parent: string | null }`, and both
  `createFlowFolder` and `updateFlowFolder` accept `parent`
  (`homey-api/assets/specifications/HomeyAPIV3Local.json`, `managers.ManagerFlow`). `getFlowFolders()`
  returns a map keyed by id, hence the `Object.values()`. A flow points at exactly ONE folder
  (`flow.folder`), so there is no "in two places" to reason about.
- **Match on name AND parent, never name alone.** The old code found the app folder with
  `folders.find(f => f.name === 'Lightkeeper')`. With children in the tree that picks up a device
  folder a user happened to name Lightkeeper, and nests everything inside one device. The root is
  `name === MANAGED_FOLDER_NAME && parent === null`; a device folder is `parent === root`.
- **`createFlow` is the only writer of `flow.folder`, and a reused flow is never rewritten.** So
  moving flows that already exist takes an explicit `updateFlow({ id, flow: { folder } })` — which is
  how installs predating per-device folders migrate themselves.
- **Only ever move a flow OUT OF OUR OWN root.** A flow whose folder is something else was put there
  by the user, and `README.md` promises it stays, under "What you can rely on".
  `hasBeenUserEdited()` deliberately compares neither `name` nor `folder`, so nothing else would
  notice — a moved flow is reused IN PLACE, which is the distinction that makes the migration safe.
- **A device's folder is resolved from its own live flows first**, and only then by name. That is why
  nothing persists a folder id: after a rename the flows still sit in the folder we made, it merely
  carries the old name, so `renameIfOurs()` renames the folder instead of moving every flow. The
  rename is refused when the folder holds anything that is not this device's — two devices sharing a
  name would otherwise rename it back and forth on every reconcile, forever.
- **Never cache a folder id across reconciles.** The previous `folderId` field was set once for the
  app's lifetime; deleting the folder on the Homey left every later `createFlow` writing to a dead id.
  The view is read once per `sync()`, alongside the flow read that already happens.
- **Folder work never blocks a flow write.** Every method catches its own failure and degrades to "no
  folder" / "no change". `test/unit/flow-bridge-folders.test.ts` asserts a Homey that refuses every
  folder call still gets its flows, and `test/unit/flow-bridge-sweep.test.ts`'s client stub has no
  folder methods at all, which is the same contract from the other side.
- **The empty `Lightkeeper` folder is left behind on purpose.** Device folders are deleted once
  emptied; the root is the anchor the next device resolves against.

---

## 12. A circadian light generates no Flows, and that is the whole design

Two device types follow the colour temperature of the day — warm at dawn, cool through the middle,
warm again at night — and they are ONE engine:

| Device type | Stores | Asks for |
|---|---|---|
| **Circadian light** (`drivers/circadian/`) | two ends of the day | what warmest and coolest look like |
| **Curve light** (`drivers/curve/`) | a list of points | every point, every time, and a colour per point |

Neither is a schedule with more rows. A schedule fires AT a time; a curve has a value at EVERY
minute, and that difference decides everything below.

**The split, and why the shape is not a setting.** A five-point editor is a lot of screen for "warm
at night, cool in the day", which is what most people want — so the circadian light asks two
questions and supplies the shape itself (`SIMPLE_SHAPE` in `lib/circadian/simple-curve.ts`: warmest
at 06:00, coolest at 11:00 and 15:00, warmest again at 21:00). Four points, not two, so each end is
HELD: two points would have the curve only ever AT one of them for an instant, cooling all night on
its way to midday. The segment from 21:00 round to 06:00 is warmest at both ends, so the whole night
is flat — which cyclic interpolation makes true with no special case.

The shape is a CONSTANT, derived on every register rather than stored. Two consequences, both
deliberate: an installed device picks up an improved shape, and the moment the times become editable
this device type is the Curve light with fewer fields. Somebody who wants their own times has one.

**One registry serves both.** `app.curves` — a single `CircadianRuntimeManager` — because they are
the same runtime, and sharing it is what keeps "ONE `setInterval` for every circadian device on the
Homey" true across two device types rather than two timers over two maps. The circadian device's own
`registry()` is a small adapter that expands its two ends into points on the way in and folds
`enabled` and `preStage` back on the way out; `kind` in each runtime's diagnostics is what tells the
two apart on a settings page and in a bug report.

**A point may carry a COLOUR instead of a colour temperature** (Curve light only). The palette is
closed (`lib/circadian/palette.ts`) and that is a decision, not a limitation: hue and saturation are
a two-dimensional choice with one good answer per intent, most of the plane is a bad idea in a living
room at 21:00, and a name survives being read back on a settings page a year later where a pair of
coordinates does not. Three rules hold the feature together:

- **`warmth` stays required even on a coloured point.** It is what a lamp with no colour capability
  is written to instead, and what the neighbouring temperature segments interpolate towards — so the
  SHAPE of the curve does not depend on which of the household's lamps can do colour.
- **A colour is never blended with a colour temperature.** Both ends coloured blends, hue the short
  way round the wheel. One end coloured HOLDS that colour flat across the whole segment. Fading
  "amber" into "4000 K" means inventing a shade nobody chose. The consequence, stated because a user
  notices it: ONE coloured point colours the two segments either side of it — "amber at 21:00" with
  temperature points at 19:00 and 23:00 is amber from 19:00 to 23:00, not an amber instant.
- **`light_mode` is written before hue and saturation.** A lamp sitting in temperature mode ignores a
  hue it is given — not an error, just no visible effect, which is the worst failure this app can
  produce. `WRITE_ORDER` in the scheduler puts mode ahead of hue for the same reason it puts `onoff`
  ahead of `dim`. The capability tested for is `light_hue`, NOT `light_mode`: `homey-lib` pairs hue
  and saturation on every colour-capable light, while `light_mode` exists only on a lamp that also
  has a temperature mode to switch out of, so testing for it would skip a colour-only lamp that can
  do exactly what was asked.

**A colour override is detected on the hue axis.** `subscribeAll` adds `light_hue` to the
subscription only when a point actually declares a colour — a lamp in a coloured segment is one whose
colour a person changes on that axis, not the temperature one, so without it taking such a lamp over
by hand went unnoticed and the next tick took it back.

- **It uses a timer, and §9 does not forbid it.** §9 is about boundaries — a 22:00 event has to fire
  at 22:00 across DST, restarts and an app that was not running a moment ago, which only the Flow
  engine can promise. A curve has nothing to miss: a skipped tick is corrected by the next one and a
  restart just resumes. So `CircadianRuntimeManager` holds ONE `homey.setInterval` for every
  curve-driven device on the Homey (60 s) — both device types, one timer — and compiling ninety-six
  Flows to approximate a smooth curve would be worse in every direction, including putting these
  device types back behind an API key.
- **Which is the real prize: no Flows means no Personal API Key.** Pairing is the light picker and
  then the curve (or the two ends); there is no credential screen, `assessHealth()` has no credential
  leg, `app.ts` does not notify either on a credential change, and `liveDeviceIds()` in `api.ts`
  deliberately excludes BOTH — neither kind of id can appear in a Flow's bridge arguments, so
  counting them would only inflate the sweep's "live" count and stop its "nothing is running"
  refusal from firing.
- **Three things cause a write, and the first is the feature.** The rising edge of a target's
  `onoff` — over the capability subscription the app already holds — is what makes a lamp the right
  colour however it was switched on: the wall switch, the vendor app, another Flow. That write
  deliberately SKIPS the "has the curve moved" gate, because the lamp has just restored whatever
  colour it was last at. The other two are the tick and any change of plan or targets.
- **`LightTargetAdapter.subscribe()` now hands on the cache's verdict.** `applyExternalChange()`
  always knew whether a change was genuinely external or the echo of our own write, and always threw
  the answer away. The optional third argument is that answer — and because echoes arrive duplicated
  (§6), it is also what makes one power-on produce one write rather than two.
- **The tick must not refresh.** Live values arrive over the subscriptions, so re-reading every
  target every minute would add a round trip per light per minute to an app that otherwise only talks
  to Homey when something happens. `ScheduleRuntime.apply()` does the opposite, correctly: it fires
  twice a day off a cache that may be hours stale.
- **The write gate is the capability's own resolution.** Across the steepest default segment the
  curve moves about 0.003 a minute and `light_temperature` reports `decimals: 2` (§6), so a write
  goes out roughly every third tick. Ticking faster changes nothing; the gate is what sets the rate.
  **Colour has its own gate and a fixed threshold**, because `light_hue` carries no `decimals` in
  `homey-lib`: there is no declared resolution below which a hue write is provably a no-op. 0.01 of a
  turn is about 3.6° — finer than the eye on a wall, coarse enough that a two-hour blend costs a
  handful of writes rather than a hundred and twenty. Hue is compared the SHORT way round, for the
  same reason it is blended that way.
- **An external colour change stands the device down for that light.** Over a 0.03 tolerance — above
  a bridge's rounding, far below a deliberate change — and outside a 3 s settle window after our own
  write. Cleared by either edge of `onoff`, because "switch it off and on again" is the gesture
  people already have for putting a light back to how it ought to be. Never persisted: a restart is a
  clean slate, which is the right bias for a feature whose job is to be correct by default.
- **Pre-staging is opt-in because a colour write can switch a lamp ON.** §6 measured that for `dim`
  on Hue; whether `light_temperature` does the same is per-integration and untested. So writing to
  lights that are off is off by default, provable from the pairing screen against the household's own
  lamps, and self-disabling: `verifyStayedOff()` turns it off for the whole device and persists that
  the first time a lamp comes on from one. It does NOT switch the lamp back off — by then our doing
  and somebody walking in are indistinguishable, and switching off a room a person has just lit is
  the worse failure. The screen's own probe does restore it, because there the user asked.
- **Brightness is never pre-staged.** A `dim` write turns an off lamp on; that is measured, not
  suspected. Pre-staging is a colour-only idea, and `planWrites()` splits its two legs for exactly
  this reason.
- **A circadian light's schema 1 → 2 is where this device type stopped being the curve editor.** The
  step keeps the WARMEST and COOLEST points — the two values the user actually chose, and the two the
  new shape is built to hold — and drops everything between them, because there is nowhere in the new
  plan to put it. That is in the changelog rather than hidden, and a Curve light is where such a curve
  can be rebuilt. The step runs `sanitiseCurve` first: a plan stored at version 1 was never
  validated (the chain ended in a cast until the validators landed), so `points` may be anything.
- **There is no migration BETWEEN the two device types**, and there cannot be: Homey has no way to
  change a device's driver. An existing circadian light becomes the simple one; a curve is a new
  device. Adding one is cheap — no API key, no Flows — which is what makes that acceptable.
- **The anchor is a discriminated union from day one.** `{ kind: 'clock' }` is all that ships;
  `{ kind: 'sun' }` is declared, refused by `sanitiseCurve()` and thrown on by `resolveAnchor()`, so
  anchoring to real sunrise and sunset later is a new variant rather than a reshape of every stored
  plan. What it needs is `homey:manager:geolocation` — which this app does not declare — and solar
  maths the SDK does not provide (§9).

---

## 13. `require('homey')` only resolves ON a Homey, and that shapes the device layer

The `homey` package in `node_modules` is the **CLI**, not the SDK: its `main` is `bin/homey.js`, so
`require('homey')` outside a Homey either runs the CLI or hands back something with no `Device` on
it. The SDK module exists only in the app's runtime on the device.

`@types/homey` supplies the types, so `tsc` is perfectly happy — and any test that imports a file
containing `extends Homey.Device` dies with

```
TypeError: Class extends value undefined is not a constructor or null
```

That is not a detail about testing. It is the reason the three device files had no tests at all, and
therefore the reason every ordering bug in them survived to be found by review: a lifecycle whose
only test harness is a real Homey Pro is a lifecycle nobody tests twice.

So the device layer is split, and the split is load-bearing:

| File | What it is |
|---|---|
| `lib/devices/device-lifecycle.ts` | `DeviceLifecycle<TPlan, TRuntime>` — a plain class taking its host as an argument. Every rule lives here: the transactional apply, the rollback, the per-device FIFO, the sequenced availability verdicts, load-and-migrate, quarantine, the delete gate. |
| `lib/devices/lightkeeper-device.ts` | `LightkeeperDevice extends Homey.Device implements DeviceOwner` — holds a `DeviceLifecycle` and forwards five SDK entry points. Nothing in it branches. |

`Homey.Device` satisfies the SDK half of `DeviceOwner` structurally, so the shell adds only the two
members the SDK spells differently: `translate()` for `homey.__` and `removeFlows()` for
`app.bridge.removeAll`. `test/unit/device-transactions.test.ts` is what the single-class version
could not have had.

The same constraint explains `lib/app-contract.ts`. `app.ts` must stay `module.exports = <class>` —
a Homey entry point using `export default` is not loaded at all — so there is no class type for
`api.ts` to import. The contract is that type written by hand, and `app.ts` assigns its class to it
before exporting, so removing a member the contract promises fails at compile time rather than as
`undefined` inside a settings-page handler.

Two ordering rules the lifecycle owns, both of which cost a real bug:

- **A verdict carries a sequence number.** Serialising the availability updates is not enough: a
  stale verdict is still IN the queue and would be applied, just later. Each one takes a monotonic
  number when it is issued and is dropped if a higher one has already been applied, so a register's
  callback landing after the apply that superseded it cannot flip an unavailable device to available.
- **An apply persists only after `register()` resolves**, and the managers insert into their maps
  only after `start()` resolves. A runtime whose start threw is half-built — no scheduler, possibly
  no subscriptions — and a bridge event arriving in that window would be dispatched into it.

## 14. Pair sessions ARE a Web API surface, and pairing can be scripted

**Established on hardware, 28 August 2026** — Homey Pro 2023, firmware 13.4.1, homey-api 3.19.2.

This repository asserted the opposite for months. `docs/hardware-test-plan.md` and
`scripts/verify-hardware.mjs` both said *"it cannot pair devices — Homey's pair sessions are not an
API surface"*, and neither cited anything. It is not what ships.

`ManagerDrivers` in `HomeyAPIV3Local` exposes the whole `/pairsession` surface, all of it
`private: false` under scope `homey.device`:

```
createPairSession({ pairsession: { type, driverId, deviceId?, zoneId? } })
emitPairingEvent({ id, event, data? })
emitPairingCallback({ id, callbackId, data? })
emitPairingHeartbeat({ id })
createPairSessionDevice({ id, device: { name?, data, store?, settings?, … } })
deletePairSessionDevice({ id })
deletePairSession({ id })
getPairSession({ id })
```

**It is a client-side mirror of the pair-view API.** `emitPairingEvent({event, data})` is what
`Homey.emit(event, data)` does inside a view, and it lands on the same `session.setHandler(event)`
in the driver. `createPairSessionDevice({id, device})` is `Homey.createDevice(dto)`, and its body
accepts `store` — which is where every Lightkeeper plan lives.

Verified end to end against the circadian driver: session created with `type: 'pair'`,
`listTargets` answered with 54 lights in 15 rooms, `selectTargets` validated against the catalogue,
`getEnds` and `setEnds` round-tripped, `save` returned a device DTO, `createPairSessionDevice` plus
`add_device` were accepted, and the device appeared in `getDevices` **available**. A Personal API
Key is sufficient; no app-side permission is involved.

Two consequences:

- `scripts/verify-hardware.mjs pair` builds one of each device type without a phone, and `repair`
  opens a repair session per device (`type: 'repair'` plus `deviceId`) to check each screen comes
  back seeded from the stored plan rather than blank.
- What stays manual is genuinely visual: whether the SCREENS draw correctly. The handlers can be
  right while a view renders nothing, which is the bug `pair-view-boot.test.ts` was written about.

**A device DTO must carry the manifest's own fields.** A pair view sends only
`{ name, data, store }` and the platform fills the rest in from the driver manifest. Over the Web
API it does not: a device created through `createPairSessionDevice` without the manifest's
`capabilitiesOptions` comes up **unavailable** with

```
Cannot read properties of null (reading 'get')
```

and no runtime registered, while the same driver paired by hand is fine. Established 30 August
2026 across all three drivers that declare a `capabilitiesOptions` block — schedule, circadian and
Curve — with the controller, which declares none, unaffected throughout. `capabilities` and `class`
ARE applied from the manifest on this path, which is what makes the omission so hard to see.

Send `capabilities`, `capabilitiesOptions`, `class` and `energy` explicitly; the endpoint accepts
all four. `withManifest()` in `scripts/verify-hardware.mjs` reads them from `driver.compose.json`.

**A device that EXISTS is not a device that WORKS.** Homey creates it `available` and runs `onInit`
afterwards, marking it unavailable only once init throws — so reading `available` straight after
creation reports success for a device that is about to break. Wait for the app's own registry
instead: a runtime appears there only after `start()` has resolved.

**The driver id is `homey:app:<appId>:<driverName>`** — see §3. Building it as
`<appId>:<driverName>` returns `Not Found: Driver with ID …`, which reads like the endpoint
refusing the request and is nothing of the sort. That mistake cost the first two runs of this probe.

`node scripts/verify-hardware.mjs pairspike --yes` is the probe, kept so the claim can be re-checked
on a future firmware rather than trusted from this note.

---

## 15. `homey-api` caches every `getAll` result forever

This is a memory fact, and it accounted for most of a 48 MB footprint against Homey's 30 MB
guideline.

`homey-api` builds one `__cache` per manager and writes every item returned by a `getAll` operation
into it, for the life of the client. From `lib/HomeyAPI/HomeyAPIV3/Manager.js`, in `__request`:

```js
case 'getAll': {
  const items = {};
  for (let props of Object.values(result)) {
    props = ItemClass.transformGet(props);
    …
    if (this.isConnected() && $updateCache === true) {
      this.__cache[ItemClass.ID][props.id] = items[props.id];
    }
  }
  if (this.isConnected() && $updateCache === true) {
    this.__cacheAllComplete[ItemClass.ID] = true;
  }
  return items;
}
```

Two conditions, both of which we satisfy by default. `isConnected()` is true because
`HomeyApiService.read()` calls `connect()` on `devices`, `zones`, `flow` and `flowtoken` — which it
must (§1, and `Flow.isBroken` refuses to run without flow + flowtoken connected). `$updateCache`
defaults to `true`.

**Which operations are `getAll` is a property of the specification, not of the name.** From
`assets/specifications/HomeyAPIV3Local.json`:

```
getFlows            {"type":"getAll","item":"Flow"}
getFlowFolders      {"type":"getAll","item":"FlowFolder"}
getFlowCardTriggers {"type":"getAll","item":"FlowCardTrigger"}
getFlowCardActions  {"type":"getAll","item":"FlowCardAction"}
getDevices          {"type":"getAll","item":"Device"}
```

### What it costs

The two card catalogues are the expensive ones, because they are every card of every installed app,
each carrying `title`, `titleFormatted` and `hint` in every language the integration was translated
into, plus `iconObj` and `color`. §4 records `getFlowCardTriggers()` returning **~1700 cards**.

Measured against a 1700-card payload of that shape:

| | |
|---|---|
| the payload | 11.6 MB of JSON |
| retained once parsed | 16.8 MB of heap |
| projected to the fields we read | 1.1 MB of heap |

The app read both catalogues — triggers on the first health assess, actions at the first reconcile —
used them for a handful of string comparisons, and then held roughly **30 MB** for the rest of its
run.

### The opt-out, and it takes both flags

```js
client.flow.getFlowCardTriggers({ $cache: false, $updateCache: false })
```

`$cache: false` alone only skips the cache *read*; the response is still written. `$updateCache:
false` is the half that matters. This is `homey-api`'s own intended knob, not a private hook — it
uses exactly this pair internally in `ManagerDevices.scheduleRefresh()`.

One consequence to design around: with `$updateCache: false`, `__cacheAllComplete` is never set, so
every later `getAll` is a real round trip. For flows and folders that is correct anyway (they must
reflect current state). For the card catalogues it is not free, because
`HealthMonitor.findReattachCandidate()` calls `discover()` once per plausible device in a loop — so
`lib/flow-card-catalogue.ts` replaces the discarded cache with a single-flight promise and a 60 s
TTL over a compact projection.

**Rule: a new `getAll` call site either passes `NO_CACHE` from `lib/flow-card-catalogue.ts`, or
carries a comment saying what it is retaining and why.**

### Not retaining is only half of it: V8 never gives the pages back

Measured on Node 22, parsing one 1700-card payload and then dropping every reference to it:

```
idle           rss  28.9 MB   heap  3.3 MB
peak           rss 101.6 MB   heap 59.4 MB
after 8x gc()  rss 112.5 MB   heap  4.3 MB
```

The heap empties — the garbage really is collected — and **RSS never comes back down**. V8 keeps the
pages it grew into, so a transient allocation raises the process's floor permanently. Forcing a
collection does not help, and there is no public Node API that asks V8 to release the pool.

The practical consequence is sharper than it first looks: **on a Homey, the app's PSS is set by the
largest single thing it has ever parsed, and NOT retaining that thing does not get the pages back.**
Retaining a parsed catalogue and merely peaking on it cost the same RSS. Retention only wins you
something if the pages would otherwise be released, and they are not.

Measured on hardware, 30 August 2026, the same app minutes apart:

| | |
|---|---|
| before it had read any catalogue | **31.9 MB** |
| immediately after ONE trigger-catalogue read | **43.9 MB** |

One read, ~12 MB of floor, permanently. So the honest accounting for this work is *the app now reads
ONE catalogue where it read two, and holds neither* — 48 MB down to ~44 MB in the same state — and
the 31.9 MB figure is what an app looks like before anything has asked it a question, not a steady
state. **So a read that can be avoided entirely is worth far more than one
that is merely dropped afterwards, and avoiding it is the only lever that moves the number.** Two
places were fixed on exactly that reasoning:

- `FlowBridgeManager.bridgeCards()` wants three cards. Asking for them by name costs a few hundred
  bytes; enumerating cost ~12 MB of floor.
- `getDiagnostics` used to call `ScheduleRuntimeManager.timeCard()`, so opening the settings page or
  exporting a bug report read every trigger card on the Homey — on an installation that had no
  schedule and no use for the answer. It peeks at the memoised result now. **A report must not
  change the thing it is reporting on**, and this one raised the floor by 12 MB to tell you a
  card id.

### Where it stops, and what would move it

**The app sits at ~44 MB once anything has read the trigger catalogue, against Homey's 30 MB
guideline, and stopping there was a decision rather than an oversight.** `SourceDiscoveryService.discover()` genuinely needs every trigger card — the Web API
offers no server-side filter, and device-scoped cards are matched on card id (§4) — and it runs at
every boot for every controller. One such read sets the floor.

Getting under 30 means never materialising that response: fetching it over plain HTTP with the same
local URL and app token `createAppAPI` uses, and scanning it incrementally so each card is parsed,
projected and dropped one at a time. That would put the peak at roughly the projection (~1.2 MB) and
the app somewhere near 20 MB. It is the only lever left: there is nothing else of this size to stop
holding, because nothing of this size is being held.

Written down so the next person does not re-derive it. If the footprint has to come down further,
that is the lever, and it is the only one left: there is nothing else of this size to stop holding.

`scripts/verify-hardware.mjs` encodes the outcome rather than the guideline — T59 reports the 30 MB
guideline and FAILS only past a 50 MB ceiling, because a line that failed on every run is a line
nobody reads.

Know what that line cannot do. It is a smoke check for a second bulk read appearing, and **not** a
regression test for retention: holding a parsed catalogue and merely having parsed one cost the same
RSS, so the number cannot separate them. The signal that CAN is the app's own `heapUsed` measured
after a read — a few MB when the catalogue is let go, ~17 MB higher when it is not. The app does not
expose it today; exposing it on `/diagnostics` is what to do if this ever has to be a real test.

### A smaller one, in the same family

`require('homey-api')` eagerly loads 218 modules — the whole Athom Cloud tree, every class of which
loads its OpenAPI specification as a *static class field*, so the JSON is parsed at import time
whether or not anything calls it. `require('homey-api/lib/HomeyAPI/HomeyAPI')` loads five, and
`createAppAPI` / `createLocalAPI` require the local V3 client themselves on first use. Worth 0.5 MB
of heap and 0.7 MB of RSS.

### Reading the number back

`GET /api/manager/apps/app/:id/usage` (`ManagerApps.getAppUsage`) is what
[the app-profiling tool](https://tools.developer.homey.app/tools/app-profiling) reports, and
`GET /api/manager/system/memory` (`ManagerSystem.getMemoryInfo`) gives the per-app breakdown around
it. `node scripts/verify-hardware.mjs memory` reads both — T59 and T60.
