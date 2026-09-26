# Homey platform reference

**Cited in code as `platform §n`.** Over 150 comments across `lib/`, `app.ts`, `api.ts` and
the tests point here — `(platform §6)` means section 6 of this file. Grep `platform §` to find
every site that depends on something written down below.

This is how Homey actually behaves, as opposed to how it appears to, and it is documented nowhere
else. Every section was established against real hardware: Homey Pro 2023, firmware 13.4.0-13.4.1,
homey-api 3.19.2.

**The reference Homey now runs firmware 13.5.0** (observed 9 September 2026; it was on 13.5.0-rc.4
on 2 September). §17 was established on it outright, and two earlier sections have been re-checked
against it. §9: one row of its card table had gone stale, and the card
this app depends on had not. §6: re-measured across 37 lamps by `scripts/probe-lights.mjs` on 3-4
September 2026, which walked back the mode gate, settled the clamp and put counts on the rest — that
section now carries dates and sample sizes on each claim, and is the model for what re-deriving one
looks like. Everything else here still rests on 13.4.x, so a surprise on a newer firmware is a
reason to re-derive the section rather than to disbelieve it. Prefer updating a section over
stripping it — each one is a decision reasoned through once, or a platform fact that cost real
hardware to establish.

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

`getFlowCardTriggers()` returns ~1700 cards — 1869 on the reference Homey when re-counted on
firmware 13.5.0-rc.4, 2 September 2026. The number is a function of how many apps are
installed, so treat it as an order of magnitude rather than a constant; what it is for is the
cost in §15. Device-scoped cards encode their device in the card
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
nothing before temperature, which was invisible until one device wrote both to one lamp. A Colour
Curve Light with a coloured point does: the colour put the lamp into colour mode and every later
temperature-only point was discarded by the lamp.

Measured on hardware, 30 August 2026: written 0.430, held 0.870, and the lamp refused a temperature
from *anything* — this app or a direct API write — until its mode changed. With
`light_mode: 'temperature'` written first, the same lamp took 0.800 and held 0.840.

**The gate is per-LAMP, not per-integration, and the paragraph above overstated it.**
`scripts/probe-lights.mjs` walked the mode gate across ten Philips Hue bulbs on 3 September 2026
(firmware 13.5.0-rc.4). One gated both axes exactly as described. **Three gated neither** — a
temperature written in colour mode with no mode write landed and held — and a fourth candidate was a
bulb that turned out to be unreachable, so its verdict is void. Same integration, same driver, same
bridge, both behaviours.

**Widened again on 4 September 2026, and the gate is rarer than that.** The same step ran across
another fourteen lamps and **not one of them gated**: every temperature written in colour mode with
no mode write landed. A second run the same afternoon added twelve more, also none gating. So across
the three runs the count is one gating lamp in roughly thirty-six, on one integration.

**But a lamp does not always report the mode it just accepted.** The morning run had every lamp
reporting itself in temperature mode afterwards, and that sentence stood here until the afternoon
one recorded `MODE_NOT_REPORTED` on **two of twelve**: written `light_mode: 'temperature'`, acked
`ok: true`, and still reporting `'color'`. The mode therefore cannot be read back to discover what a
lamp did with it — which is the independent reason a probe-and-remember cannot work (below), and why
`verify-hardware.mjs` keeps `light_mode` in `ENABLER_CAPABILITIES` rather than asserting on its
round trip.

The mode write is also the cheapest and the least informative write this app makes. Across sixteen
lamps and 252 writes its ack sat at a median of **212 ms, range 210-220 ms** — tighter than any
value write on the same lamps (`light_temperature` 278 ms, spread to 492 ms) and unmoved by whether
the bulb could be reached at all: on a lamp where every value write failed, `light_mode` went on
acking in 210 ms. That is the Hue app satisfying it locally without going to the bulb, which is
exactly what `light-target-adapter.ts` depends on when it refuses to let a `light_mode` success
clear a failure streak.

That does not weaken the fix; it is the argument FOR the fix as written. `planColor()` and
`planTemperature()` emit `light_mode` unconditionally, so on a gating lamp it is the difference
between working and silently doing nothing, and on a non-gating one it is a no-op that costs one
write. A per-lamp probe-and-remember would have to be right about which kind each lamp is, and this
is now measured to be a thing one driver does not know about itself.

`MODE_NEEDS_DELAY` never fired on the lamp that does gate: `light_mode` and the value it enables,
written back-to-back with no gap — which is exactly what `runFlush` does — landed. So the open
question `hardware-test-coverage.md` raised by name is answered, on this integration.

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

**Doubted on 3 September, settled on 4 September: the clamp is real, and it is at the ENDS only.**
The 3 September ladders reported `maxDelta: 0` on every axis — `dim`, `light_temperature`,
`light_hue` and `light_saturation` — with all seven rungs distinct and monotone and
`light_temperature` reaching both `0` and `1`, which read as "these lamps report back exactly what
they were written". That conclusion was drawn from the wrong echo. A Hue write produces two (see
below) and the FIRST carries the value that was **requested**. The raw traces of the second
4 September run show `light_temperature` written `0` echoing `0` and then **`0.28`**, and written
`1` echoing `1` and then **`0.87`** — on seven devices, six Philips Hue bulbs and one virtual light
group, both ends on six of them. The correction arrives **332-1391 ms** after the write.

The middle of the axis is exact. 124 intermediate rungs echoed the written value back to the digit;
the four that did not were all on the three Studio devices that the run listed in
`conflicts.overlapping`, which is interference rather than the lamp. So this is endpoint clamping —
a bulb's own mired limits mapped onto Homey's 0-1 — and not quantisation.

**Which makes a clamp separable from a discard after all, from the API alone.** The paragraph above
says the two are indistinguishable, and from a single write they are: "0.930 written, 0.850 held" is
the same picture as this section's own gate example, "written 0.430, held 0.870". They are
distinguishable from a write plus its SETTLED echo. A clamp lands on the lamp's own ceiling and
reports it every time, for any value past it. A discard leaves whatever the lamp was already
holding — which is what the 3 September gate finding actually saw: it read 0.870 for a written
0.500, and 0.870 is the ceiling its own ladder had written a moment earlier, not a clamp of 0.500.

What it means for the two numbers that were calibrated against it:

- `OVERRIDE_TOLERANCE` (0.03, the circadian override band) is safe, but not for the reason
  previously given here. At an endpoint a lamp does NOT report our write back exactly: asking for 1
  and being told 0.87 is a 0.13 discrepancy, four times the band. What keeps that from reading as a
  human reaching for the vendor app is `OVERRIDE_SETTLE_MS` (3000 ms), which discounts any report
  arriving within three seconds of our own write — against a measured worst case of 1391 ms. The
  settle window is load-bearing on every colour-capable Hue lamp in the house, not just on a bridge
  that reports mid-transition.
- `LAMP_TOLERANCE` (0.1 in `scripts/verify-hardware.mjs`, chosen "well above observed quantisation")
  is about right at the ends, where 0.13 is the real gap, and too loose everywhere else, where the
  evidence is now 124 exact echoes. A discarded write of small magnitude in the middle of the axis
  would still pass the hardware pass unnoticed.

**Writing to an "off" lamp has THREE outcomes, not two.** Pre-staging asks whether a lamp can be
given a colour while off, and the answers are: it stays off (pre-staging works); it comes on (it does
not, and the app puts it back and disables the option); or **the integration declines the write** —
a Hue Bridge answers `device (light) <id> is "soft off", command (.color_temperature.mirek) may not
have effect`. Measured 30 August 2026 on a Hue lamp, while a second lamp on the same Homey accepted
the write and stayed off, so this is per-lamp rather than per-bridge. The third outcome means what
the second does; `probePreStage()` reports it rather than throwing, because unguarded it reached the
pairing screen as that raw sentence under a button labelled "Test it".

**Per-lamp is now a count rather than an inference.** 4 September 2026, thirteen colour-capable Hue
bulbs behind one bridge with clean evidence: **four declined and nine staged**, and the split holds
per lamp across both colour axes — a bulb that refuses a temperature refuses a hue. A wider run that
afternoon reached sixteen of them and found **seven declining and nine staging**, so the proportion
is stable and the refusal is common rather than exceptional: expect roughly half a household's Hue
bulbs to decline a colour while off. Every declining
bulb still took the `dim` write in the same step and came on, which is the only thing that separates
"refuses colour while off" from "dead": the two genuinely dead bulbs in that run rejected every axis,
`dim` included. Pre-staging never sends a `dim` to an off lamp, so from inside the app the refusal
alone cannot tell them apart — which is why a refused pre-stage write is excluded from write health
below, and why the runtime stops offering a lamp a colour after three refusals in a row (§12).

**`available` does not track reachability, and there is no field that does.** Measured 3 September
2026: a Hue bulb reported `available: true` for eighteen minutes while **93 of 113 writes to it
failed**. Every value write was rejected; the only capability that acked was `light_mode`, twenty
times, because the Hue app satisfies it locally without going to the bridge. So "the write acked" is
not evidence a lamp is there either, if the write was the enabler rather than the value.

The wording differs per integration and must not be matched on — Hue answers `The device could not be
reached. Is it powered on?` and the IKEA app answers `Could not reach device. Is it powered on?` for
the same condition. What the app does with this is
`LightTargetAdapter.unwritableTargets()`: count consecutive rejections, message-blind, and feed
`assessTargets()` so a lamp nobody can drive stops reporting as ready.

**With one exception, and it is a caller's flag rather than a message match: a PRE-STAGE write's
failure is not counted.** A colour written to a lamp that is off is refused identically by a soft-off
lamp and by a dead one, per the count above, so the rejection is evidence of nothing — and counted,
it marked four healthy Hue bulbs as "not responding" for as long as the household had them switched
off. The exclusion runs one way only: a pre-stage SUCCESS still clears a streak, because unlike a
`light_mode` ack it reached the bridge and the bridge did not refuse it. It is a flag set by the
runtime (`PlannedWrite.preStage`) rather than a look at the cached `onoff`, because a schedule
turning a window on writes `onoff`, `dim` and `light_temperature` in one batch and the lamp is still
cached as off when the temperature goes out — reading the cache would throw that failure away on the
one path where the lamp really is dead.

One further observation from that lamp, from ONE lamp and therefore not yet a rule: its reported
`light_temperature` and `light_hue` ended the run holding values that only the probe had written, all
of whose writes had been rejected. If a write can fail and still move the reported value, then a
lamp reports back a value the app never committed — `commitDesired()` correctly commits only on
success — and `applyExternalChange()` reads that as a human override, which drops a lamp out of a
curve until it is power-cycled. Worth a targeted re-probe on a lamp made unreachable deliberately.

**Echoes arrive duplicated.** Setting `dim` once produces two identical callbacks. `TargetStateCache`
dedupes within a 1500 ms window, or optimistic desired state fights itself and the ramp engine reads
a duplicate as an external change that cancels the ramp.

Refined 3 September 2026, with exactly ONE subscription per capability — which is the point, because
the app can hold two to one lamp (a controller and a circadian light both subscribe) and that would
explain a doubling all by itself. `ECHO_COUNT` recorded **one or two** echoes per write across
fourteen lamps, first echo 67-421 ms. So the duplication is the platform's rather than the app's, and
it is not reliable: a lamp may echo once. The dedupe is still needed and nothing may depend on a
second echo arriving.

Twenty-seven lamps on 4 September 2026 say the same thing with the proportions filled in: **two
echoes on twenty-two of them and one on five**, first echo 99-444 ms. Duplication is the norm and
not the rule.

**A second run that afternoon says which is which: it is a property of the INTEGRATION, not of the
lamp.** Split by owner, the thirty-one measurements are unanimous within each one — Philips Hue
**two echoes on twenty-four of twenty-four**, first echo 257-271 ms; virtual light groups **one echo
on four of four**, 361-542 ms; IKEA one or two, 63-111 ms. The five singles in the paragraph above
were a mixed bag being averaged. So "one or two" remains the only safe assumption for an integration
nobody here has seen, and the 1500 ms dedupe window is nowhere near the 70 ms that separates a Hue
pair.

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

### A lamp switched on at the wall: what the timings actually are

Measured 16 September 2026, firmware 13.5.0, app 0.6.5, two rooms of five and four lamps each
switched on at the wall. The whole sequence, from one `/diagnostics` capture:

| Moment | Elapsed from the `onoff` report |
|---|---|
| App fires a forced control pass | 0–70 ms |
| First write of the burst acked (`light_mode`) | ~220 ms |
| Last write of the burst acked (`light_hue`/`light_temperature`) | **1.31–1.91 s** |
| Lamps report their own settled state | **4.0 s, 7.5 s, 13 s** — and one at 73 s |

Three things follow, and all three cost a bug to learn.

**An app cannot beat the lamp to it.** The earliest an app hears about a switch-on is the `onoff`
report, and by then the lamp is on and showing whatever it held. Nothing in the SDK announces an
impending power change. Writing the colour ahead of time (§12) is the only mechanism that makes a
lamp come on correct; reacting faster cannot, however fast.

**Per-write ack time rises with concurrency, and the queue is not the bottleneck.** Across five
lamps written in parallel the same `light_hue` write acked at 785, 882, 989, 1080 and 1191 ms —
roughly 100 ms per additional lamp, from the bridge rather than from anything in the app. Writes
already go out on per-device queues (`DeviceQueue` in `command-scheduler.ts`, `minWriteIntervalMs`
paced per device), so there is no serialisation to remove. Do not go looking for one.

**The lamp's own settling arrives well after the writes it is answering.** This is what breaks a
settle window anchored at the power transition: three seconds shuts it at 3.0 s, between our last
write at 1.91 s and the lamp's answer at 4.0 s, and every one of those answers is then read as a
person reaching for the vendor app. The window has to follow the writes. Reports later than that
cannot be handled by any clock — the 73 s one was a lamp sitting on a value it had never left — and
are told apart by comparing against where the lamp was BEFORE the write instead.

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

**A pair view's folder is served as static files, and NOT only its `.html`.** Measured on
hardware, 4 September 2026, firmware 13.5.0-rc.4. The Homey serves a pair view at

```
GET /app/<appId>/drivers/<driverId>/pair/<viewId>.html      200  text/html
```

and it serves siblings in that same folder, with correct MIME types:

| Path under the app | Status | `content-type` |
|---|---|---|
| `drivers/daylight/pair/daylight.html` | 200 | `text/html` |
| `drivers/daylight/pair/daylight.assets/probe.js` | 200 | `application/javascript` |
| `drivers/daylight/pair/probe-sibling.js` | 200 | `application/javascript` |
| `drivers/daylight/pair/probe.css` | 200 | `text/css` |
| `drivers/daylight/repair/daylight.html` | 200 | `text/html` |
| `drivers/daylight/assets/icon.svg`, `assets/icon.svg` | 200 | `image/svg+xml` |
| `settings/index.html` | 200 | `text/html` |

(`daylight.html` was the Room-sensing Light's own screen when this was measured; the 0.6.0 pairing
rewrite replaced it with `sensor.html`, `response.html` and `sensordetail.html`. The paths are left
as they were probed — a measurement rewritten to match today's file list stops being a record of
what was run.)

It is a WHITELIST of directories rather than a static server over the whole app: `app.json`,
`package.json`, `app.js` and `locales/en.json` all return 404, and so does a non-existent file
inside a served folder. The `<viewId>.assets/` shape is the one the CLI's own `HomeyCompose.js`
materialises for a templated view — it copies `<template>/assets` to
`drivers/<id>/pair/<viewId>.assets` and replaces `{{assets}}` in the HTML with that path — so the
convention is Athom's, not ours.

**Why this matters, and what it does NOT yet settle.** Every pair view carries a CSS base and an
`emit()`, and two of them carry the week grid's CSS and `weekGrid()`, all copied — originally by
hand, now by `npm run sync:views` — because the in-code comment said "there is nowhere to put a
stylesheet". There is: the file would be served.
What is still unmeasured is whether a `<script src>` or `<link rel="stylesheet">` inside a view
actually LOADS once the pairing container has injected that view into its shared document, and if
so whether it runs before the view's own inline boot code.

One inference worth recording, because it narrows the question: the views' INLINE `<script>` blocks
do run, and `innerHTML` never executes a script of any kind — so the container is not using plain
`innerHTML`. It must be re-creating script elements from the parsed HTML, which is the standard
workaround, and that mechanism does load an external `src` — asynchronously. So the expected answer
is "it loads, but not before the inline boot", meaning the boot would have to wait on `onload`.
Expected is not measured. **The test is one minute with the Homey app open:** add a
`<script src="daylight.assets/probe.js">` that sets a global and `emit()`s a line back to the
driver, open the Room-sensing Light's pairing screen, and read the app log — a pair view runs in the
CLIENT, so `console.log` never reaches the Homey and the reply has to come back through `emit()`.

**The same applies between drivers.** Four screens are authored once and used by several drivers —
the intro, the light picker, the review and the API-key screen — and Homey will not follow a
reference: each driver needs its own real file. So `drivers/schedule/pair/intro.html`,
`lights.html`, `review.html` and `credential.html` are copies of the controller's, made by the same
script and compared by the same test.

All four stay driver-agnostic the same way: the **driver** supplies the content and the destination
in the reply, never the view. `getIntro` returns the title, the blurb, which hero to draw and the
list of decisions; `getReview` returns the rows and which view each jumps back to; `listTargets`
returns the step index, the step count and `nextView`; and `getCredentialStatus` returns `nextView`
too — `'remote'` for the controller, `'lights'` for the schedule. A view that hardcoded
`showView('remote')` would silently strand the schedule flow, since `remote` is not one of its
screens.

`test/unit/pair-view-styles.test.ts` discovers views from disk across every driver for the same
reason: while it hardcoded `drivers/controller/pair`, a second driver's screens could break the
scoping and colour-token conventions with nothing failing.

## 9. Time comes from the Flow engine, because the SDK has no scheduler

SDK v3 has **no cron manager** — v2's `ManagerCron` is gone, and the full `manager/` list (api, apps,
arp, audio, ble, clock, cloud, dashboards, discovery, drivers, flow, geolocation, i18n, images,
insights, ledring, nfc, notifications, rf, settings, speech-input, speech-output, zigbee, zwave) has
nothing else that fires at a time. There is no sunrise/sunset helper in the SDK either;
`ManagerGeolocation` offers latitude and longitude and nothing more, and requires
`homey:manager:geolocation` — which the app now declares, for the daylight device types. That
changes what is possible here and not what is true: a position is still not a time, and §16 is where
the arithmetic that turns one into the other lives.

**But the FLOW ENGINE has sunrise and sunset trigger cards, and that is a different thing.**
Re-checked on firmware 13.5.0-rc.4: `homey:manager:cron:sunrise` and `homey:manager:cron:sunset`
both exist, each taking a single `before` of type `number`. The sentence above was written about the
SDK's managers and read for a long time as though it settled the whole question; it does not.

What that does and does not unblock, because the two device families are not alike:

- **For a SCHEDULE it is genuinely available today.** A schedule fires AT a boundary, and this
  section's whole argument is that the Flow engine should own the hard parts of "when" — so a
  sunset boundary is the same shape as a 22:00 one, needs no new permission, and needs no solar
  maths of ours. It is not implemented; nothing about it is blocked.
- **For a CURVE it is still blocked, and §12 is right.** A curve has a value at EVERY minute, so
  `resolveAnchor()` needs the sunrise *minute* to interpolate against — a number, not an event. A
  trigger card fires; it does not answer "when is sunrise today". So `{ kind: 'sun' }` still wants
  either `homey:manager:geolocation` plus solar maths, or a way to read those cards' resolved times
  that has not been established.

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
- **The card, confirmed on hardware** — first on firmware 13.4.0 via the app's own diagnostics on
  18 August 2026, and **re-checked against firmware 13.5.0-rc.4 on 2 September 2026** by enumerating
  all 1869 trigger cards directly. One row of the original table had gone stale in between, which is
  the reason the re-check is worth recording rather than just the result:

  | Card | Arguments | 13.5.0-rc.4 |
  |---|---|---|
  | `homey:manager:cron:time_exactly` | `time` of type `time`. **This is the one we use.** | unchanged |
  | `homey:manager:cron:time_exactly_day` | `time` of type `time`, plus `day` of type `multiselect` | unchanged |
  | `homey:manager:cron:every` | `minutes` of type `number` | **GONE.** Replaced by `homey:manager:cron:every_nth`, taking `n` of type `number` and `type` of type `dropdown` |
  | `homey:manager:cron:sunrise` / `:sunset` | `before` of type `number` | present — see the note at the top of this section |
  | `homey:manager:energy:dynamic_electricity_price_period_{lowest,highest}_start_between` | `duration`, `unit`, `startTime`, `endTime` | unchanged |

  **The shape match still resolves to exactly one card**, which is the fact that actually matters:
  of all 1869 triggers on that Homey, `homey:manager:cron:time_exactly` is the ONLY one whose
  arguments are a single `time`. So `discoverTimeCard()` is unambiguous on this firmware without
  relying on `KNOWN_TIME_CARDS` to rank it — and the energy cards above are still why the match
  requires the time to be the only argument, since two of them carry `time`-typed arguments and four
  arguments in total.

  A firmware that DID move this card is what
  `hasBeenUserEdited(…, { triggerIdMayHaveMoved })` exists for: the card's identity is a schedule's
  whole fingerprint, and without that flag `sync()` read a moved card as a user edit and could never
  rebuild against the new one.

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
    separate strokes. 0.5.0's fix was fewer, larger elements at the house weight, not a heavier
    line — which is true of a density problem and is NOT the general rule for a blank circle on a
    published listing. See the three causes under the next point.
    `npm run render:icons` reproduces that markup and CSS exactly, at 24, 34, 48 and 144 px of ink,
    and is the only way to see this before publishing. Whether a drawing carries enough ink for the
    box is also measurable rather than a matter of taste — alpha coverage of the 24 px box, with
    homey-lib's own stock icons as the calibration. The measured numbers are in
    `artwork/provenance.md`; ours sit inside the range Homey's own icons occupy.
  - **A CLI-installed app shows NO icon, ever.** That CDN only holds icons from builds Athom
    published, so `homey app install` leaves the mask pointing at a 404 and the UI draws an empty
    `brandColor` circle. This cost a diagnosis: the SVGs render correctly inline, as a sized
    `<img>`, as an unsized `<img>` and as a CSS mask, and the right bytes were in `.homeybuild` —
    the file was never the problem. **Do not redraw anything chasing a blank icon on a dev
    install.** It resolves on publish, test channel included.

    The converse trap is a blank icon on a PUBLISHED listing, and it has **three** causes that look
    identical from the outside: the wrong bytes, a drawing too fine for the box, and a transient in
    the viewer's own browser. Only the first is cheap to rule out — fetch the mask URL out of the
    page's own markup and look at what comes back.
    `apps.homeycdn.net/app/<id>/<build>/<uuid>/drivers/<driver>/assets/icon.svg` returned
    `200 image/svg+xml` with our exact bytes, and the surrounding markup was identical to what IKEA
    Trådfri and Philips Hue get. The build number in that path is worth reading too: it is how you
    tell a page that has not caught up from an icon that has actually failed.

    **What that does not rule out is CORS or the mask itself**, and believing it did cost a redraw.
    `curl` sends no `Origin` and has no cache, so it only ever proves the bytes on the CDN. 0.5.1's
    flow-card circles were still blank after four masters had been redrawn for the 24 px box, and
    the fault was in the browser all along: the Network tab reported a CORS error on the icon
    request, and a hard refresh made every glyph appear and turned the same request into a `200`.
    The icons were correct the whole time, at 40 units, exactly as shipped.

    It lasts for hours because of what that CDN does not send: **no `Cache-Control`, no
    `Access-Control-Allow-Origin` (with or without an `Origin` request header) and no `Vary`.** With
    no `Cache-Control`, Chrome falls back to heuristic freshness — about 10% of the file's age, so
    roughly seven hours for a file published three days earlier — and an entry populated under a
    different request mode (opening the SVG in a tab is enough) can hold a mask blank for that long.
    Nothing in an app can change this; it is Athom's header to fix.

    So diagnose this one in the browser rather than the shell: hard-refresh with the Network tab
    open and watch the icon request. And to tell a hairline apart from a blank, **enlarge `.icon` in
    devtools** — if a bigger box still shows nothing, the drawing is not the variable and no redraw
    will help.
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
| **Circadian light** (`drivers/circadian/`) | three zones of the day | what morning, midday and evening look like |
| **Colour Curve Light** (`drivers/curve/`) | a list of points | every point, every time, and a colour per point |

Neither is a schedule with more rows. A schedule fires AT a time; a curve has a value at EVERY
minute, and that difference decides everything below.

**The split, and why the shape is not a point list.** A five-point editor is a lot of screen for
"warm at night, cool in the day", which is what most people want — so the circadian light asks about
three ZONES and supplies the shape itself. `zonePoints()` in `lib/circadian/simple-curve.ts` derives
six points from them: each zone held flat, with a `ZONE_RAMP` (50 min) ramp either side of each
boundary. Held, not two points, because two would have the curve only ever AT a value for an
instant, cooling all night on its way to midday.

**There are THREE boundaries, and the third is midnight.** Morning ends after sunrise and evening
begins before sunset, which leaves morning and evening as independent temperatures either side of
midnight — so midnight is a step change unless it is ramped like the other two. Cyclic
interpolation makes the third ramp the same rule applied a third time rather than a special case.

**Two of the three are anchored to the SUN, and that is the reason `sunTimes()` exists.** A boundary
stored as "sunrise + 30m" survives the year; one stored as 06:51 is true for a day. The offsets are
stepped in quarter-hours and capped at `MAX_OFFSET` (150 min), and `resolveBoundaries()` clamps at
RESOLVE time rather than at storage: north of about 60° a short winter day can bring a stored pair
of offsets into collision with no edit having taken place, and a clamp applied to the stored value
would quietly rewrite what somebody chose. Where there is no sun to anchor to — a polar day, or a
Homey that has never been told where it is — `FALLBACK_SUNRISE` and `FALLBACK_SUNSET` (06:00 and
21:00) stand in, and the pairing screen says so rather than drawing marks it cannot place.

The shape is still DERIVED on every register rather than stored, so an installed device picks up an
improved shape; the zones and the two offsets are what is stored.

**One registry serves both.** `app.curves` — a single `CircadianRuntimeManager` — because they are
the same runtime, and sharing it is what keeps "ONE `setInterval` for every circadian device on the
Homey" true across two device types rather than two timers over two maps. The circadian device's own
`registry()` is a small adapter that expands its three zones into points on the way in and folds
`enabled` and `preStage` back on the way out; `kind` in each runtime's diagnostics is what tells the
two apart on a settings page and in a bug report.

**A point may carry a COLOUR instead of a colour temperature** (Colour Curve Light only). The
palette is closed (`lib/circadian/palette.ts`) and that is a decision, not a limitation: hue and
saturation are a two-dimensional choice with one good answer per intent, most of the plane is a bad
idea in a living room at 21:00, and a name survives being read back on a settings page a year later
where a pair of coordinates does not. Three rules hold the feature together:

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
  then the curve (or the day); there is no credential screen, `assessHealth()` has no credential
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
- **Pre-staging is ON by default as of 0.6.5, and was opt-in before it, because a colour write can
  switch a lamp ON.** §6 measured that for `dim`
  on Hue. `light_temperature` was measured on 3 September 2026 and does **not**: written to an off
  Hue bulb it was *staged* on three lamps — the lamp took the value and stayed off, which is exactly
  the outcome pre-staging needs — and *declined* as "soft off" on a fourth, §6's third outcome.
  `OFF_TEMP_TURNS_ON` did not fire once. That is four lamps on one integration, so the option stays
  opt-in and self-disabling; what changed is that its premise is now evidence rather than a hope.
  Thirteen lamps on 4 September 2026 give the proportions: **nine staged and four declined**, and
  `OFF_TEMP_TURNS_ON` still did not fire once — so the premise holds for two lamps in three, and the
  third outcome is common rather than exotic.
  So writing to
  lights that are off is provable from the pairing screen against the household's own lamps, and
  self-disabling: `verifyStayedOff()` turns it off for the whole device and persists that the first
  time a lamp comes on from one. It does NOT switch the lamp back off — by then our doing and
  somebody walking in are indistinguishable, and switching off a room a person has just lit is the
  worse failure. The screen's own probe does restore it, because there the user asked.
  **What moved in 0.6.5 is the default for a NEW device, and only that.** The opt-in was argued on
  "a light coming on by itself is worse than a half-second of the wrong white", and the second half
  of that turned out to be wrong: §6's switch-on timings put the colour 1.3–1.9 s behind the lamp,
  on every switch-on, for as long as the device exists — not a half-second, and not once. Against
  that, the exposure is one lamp coming on once before the device disables itself for good. A device
  that already exists is untouched: the store's gate is still `preStage === true`, so an absent or
  false key keeps meaning no, and only `DEFAULT_SIMPLE_PLAN` and the curve driver's session seed
  changed. Worth knowing WHY every device in the field had it off regardless of the default: the
  setting shipped in 0.4 with no control on any screen, so nothing could turn it on until the
  toggle and its test button were added to `curve.html` and `day.html`.
- **A REFUSAL is handled per lamp, and neither opt-in nor self-disabling covers it.** A lamp that
  comes on is a surprise about the INTEGRATION, so `verifyStayedOff()` answers it device-wide and
  persists that. A lamp that refuses is a fact about that LAMP — measured four refusing against nine
  staging on one bridge (§6) — and nothing happens to it at all, so answering it device-wide would
  take pre-staging away from the nine on the evidence of the four. Instead the runtime counts
  refusals per lamp and stops offering that one a colour after three ticks running
  (`PRE_STAGE_DECLINES_BEFORE_SKIP`), clearing the count when the lamp is next switched on. Not
  persisted: the fact costs one write to re-derive and goes stale invisibly when a bulb is replaced
  under the same id. It is reported on the target in diagnostics, because `preStage: true` and a lamp
  nothing is written to otherwise read as a broken runtime.
- **Brightness is never pre-staged.** A `dim` write turns an off lamp on; that is measured, not
  suspected — and measured again on 3 September 2026, where `OFF_DIM_TURNS_ON` fired on **eleven of
  eleven** dimmable lamps, and on 4 September on **twenty-five of twenty-five**; the only lamps that
  did not come on were the two that rejected every write on every axis. `impliesOn` (`lib/outputs/intent-planner.ts`) rests on that, and so does
  the fact that this leg exists at all. The bottom of the axis held up in the same run:
  `MINIMUM_BRIGHTNESS` written as a device `0.01` reported back `0.01` with `onoff: true` on every
  lamp, so `litDim()` is doing what its docblock claims. Pre-staging is a colour-only idea, and `planWrites()` splits its two legs for exactly
  this reason.
- **A circadian light's schema 1 → 2 is where this device type stopped being the curve editor.** The
  step keeps the WARMEST and COOLEST points — the two values the user actually chose, and the two
  the new shape is built to hold — and drops everything between them, because there is nowhere in
  the new plan to put it. That is in the changelog rather than hidden, and a Colour Curve Light is
  where such a curve can be rebuilt. The step runs `sanitiseCurve` first: a plan stored at version 1
  was never validated (the chain ended in a cast until the validators landed), so `points` may be
  anything.
- **There is no migration BETWEEN the two device types**, and there cannot be: Homey has no way to
  change a device's driver. An existing circadian light becomes the simple one; a curve is a new
  device. Adding one is cheap — no API key, no Flows — which is what makes that acceptable.
- **The anchor is a discriminated union from day one, and the second variant is now live.**
  `{ kind: 'clock' }` was all that shipped; `{ kind: 'sun' }` was declared, refused by
  `sanitiseCurve()` and thrown on by `resolveAnchor()`, so anchoring to real sunrise and sunset was
  a new variant rather than a reshape of every stored plan. The last step of the sum arrived with
  `sunTimes()` in `lib/daylight/solar-elevation.ts` — the hour-angle solution over the same NOAA
  sequence, returning `null` where no crossing exists — so all three refusals were lifted together.
  Together is the point: a sun anchor accepted by the sanitiser and thrown on by the resolver is a
  curve that silently sits at one colour, which is why the variant was refused in three places
  rather than one until every one of them could answer. `SUNRISE_ALTITUDE` is −0.833°, not 0 — the
  sun's own radius plus atmospheric refraction, which is what "sunrise" means to everybody who is
  not doing spherical trigonometry.

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

**The shells are testable after all, from the test side.** Nothing about the Homey changed; what
changed is that a test can stand in for the missing module. `test/support/fake-homey.ts` wraps
`Module._resolveFilename` so the bare request `'homey'` resolves to a file exporting recording
`App`/`Driver`/`Device` base classes, and because the suite is compiled to CommonJS by tsx, an entry
point's `import Homey from 'homey'` goes through it. `app.ts`, all five drivers and all five devices
were executed by a test for the first time on 23 September 2026, and five defects came out of code
that every review had read. The split above stays — it is still where the rules belong — but "a
lifecycle nobody tests twice" no longer has to be true of the wiring.

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
2026 across the drivers that declare a `capabilitiesOptions` block — schedule, circadian and
Curve then, and Daylight since — with the controller, which declares none, unaffected throughout. `capabilities` and `class`
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

### The consequence nobody had drawn: a `get` is served from what a `getAll` filled

The rule above is about MEMORY, and it hid a correctness bug for months. A `getAll` writes every
item into `__cache`; a single-item `get` then READS that cache unless it opts out too. So
`getDevices()` — every device on the Homey — silently made every later
`getDevice({ id })` answer with a snapshot rather than with the device.

Established on hardware, 2 September 2026, and it had bitten in two places at once:

- **`LightTargetAdapter.refresh()`**, whose entire job is "refresh cached state from live values",
  primed a lamp's power state from whenever `DeviceCatalog` last read the catalogue. Switch your
  lights on, then pair a circadian light: its runtime reads them as OFF and `applyNow()` skips every
  one, so the light does nothing at all until somebody next toggles a lamp — at which point the
  capability subscription corrects the cache and it starts working. Reproduced directly: the lamps
  were on, a separate client's `getDevice` returned `onoff: true`, and the app reported `on=false`
  for the same device id.
- **`scripts/verify-hardware.mjs`'s `capabilityValue()`**, which is how the hardware pass reads a
  lamp back after a write. This is the one worth remembering, because a stale read is very good at
  impersonating a misbehaving lamp: T25 polls for 15 seconds, and eight reads of one cached value
  agree with each other perfectly, so "the lamp never reported the value" looked like a finding. It
  was written into this reference as Hue-Bridge echo lag on 30 August 2026, and into
  `hardware-test-coverage.md` as lamps that refuse external writes. Both were wrong. With
  `$cache: false` the same six lines pass, including the override property T25 exists for, which had
  never actually run.

So: **anything reading a VALUE that can change under you passes `$cache: false`, `get` or `getAll`.**
`$updateCache: false` is the memory half; `$cache: false` is the correctness half, and they are not
the same question.

### V8 never gives the pages back — on a laptop, and NOT on a Homey

**Read the correction before the measurement, because the measurement is real and its conclusion
does not transfer.** On a Homey, PSS was observed *falling* 11.8 MB on an idle app process, with
nothing freed by the app and no collection requested, and repeat catalogue reads cost +2.3, then
+1.2, then +0.0 MB — each cheaper than the last, because the process is reusing pages it already
has. A pressured kernel reclaims pages. Resident memory is **not** the one-way ratchet the laptop
figures below describe, and **avoiding a transient peak is worth far less than the rest of this
subsection assumes.** Several decisions recorded here rest on that ratchet; treat each as
"reasonable, and no longer the reason".

What follows is what was measured on a laptop, kept because it is true there and because it is the
shape of the argument several comments still cite.

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

### The floor moves with the house, and that was measured

**Re-measured 13 September 2026 on the same Homey, now on firmware 13.5.0 with 32 apps and 123
devices: a freshly installed app with four Lightkeeper devices sits at 68 MB, not 44.** Nine devices
boot at 79 MB and settle near 98 once a controller and a schedule have reconciled.

The obvious suspect was this app, and it was A/B'd rather than assumed. The 9 September build
(`09e120a`) and the 13 September build were installed one after the other on that Homey, against the
same four devices, each measured after a restart: **67.5 MB and 68.2 MB**. Identical within noise —
so the doubling since the **36.6 MB** the same line recorded on 9 September is not in the app's code.

Three things were ruled out on the way and are worth not re-deriving:

| checked | measured |
|---|---|
| a steady leak | none: no per-tick growth at all, at either size. Both rise in STEPS over the first hour and then hold — nine devices 79 → 90 → 91.5 → 97 → 98 MB, four devices 68 → 75 — each step followed by minutes of a number that does not move at all. Measured at the settled level, four devices went **75.1 → 76.1 MB across fifteen idle minutes**, in two steps of half a megabyte. The steps shrink; whether they stop, over days, was not measured |
| retention coming back | three consecutive catalogue-reading passes moved it 90.0 → 90.2 MB |
| the diagnostics report paying for itself | ten `/diagnostics` calls cost nothing; ten `/` calls cost 0.6 MB |

What environmental thing moved was **not** identified. The card catalogues are every installed app's
cards, and the honest statement is that this house's grew — 1832 trigger cards and 1174 action cards
on 13 September, 1.3 MB and 0.8 MB of JSON respectively. Note that those payloads are far smaller
than the 11.6 MB above, which was measured against a payload carrying every translation; the floor a
parse leaves behind is not the payload's size.

The consequence for the pass: T59's ceiling is **100 MB**, and it is not a budget — see the constant's
own docblock in `scripts/verify-hardware.mjs`. **Compare a reading only with another reading from the
same house**, and reinstall before believing a high one.

### What an empty app costs, which is the only number that makes the others mean anything

Everything above measures this app against itself. On 15 September 2026 a second pass measured it
against **a do-nothing app installed beside it on the same Homey and read in the same minute** —
`app.json` with an `api` block, `app.js` extending `Homey.App`, one route reporting
`v8.getHeapStatistics()`, about forty lines.

**An empty Homey app costs 30.6 MB of PSS. Homey's guideline is 30 MB.** Lightkeeper's own code —
every cache, every runtime, every subscription — accounts for **under 1 MB** above that control app
once the control app has made the same API calls: idle, the control app settled at 43.5 MB having
created two clients and done five bulk reads, while Lightkeeper with no devices sat at 44.3 MB in
the same minute.

Three things fall out of that, and each retires an argument made above:

- **The guideline is not reachable by any app**, so it is not a target to be read off `pss`. The
  measurable target is *marginal cost over a control app measured at the same time*.
- **The two-client design (§1) is free.** A second `HomeyAPIV3Local` — its own `SocketSession`,
  `SubscriptionRegistry`, `DiscoveryManager` and manager set — cost **+0.0 MB**. The library's
  modules are already loaded; a second instance is a handful of objects.
- **The cost is the transport libraries, not Athom's client.** On a cold process:
  `socket.io-client` alone is +2.78 MB of heap and **+13.75 MB of RSS**; `node-fetch` alone +2.30 /
  +10.17 MB; the `HomeyAPIV3Local` require that pulls both, +4.01 / +18.09 MB. And `HomeyAPIV3`
  declares only **nine** manager classes, not the fifty the specification lists — the "50 managers
  per client" concern is unfounded.

The catalogue read is likewise **not a permanent 12 MB floor**: the cost measured there is growing a
small heap to fit a parse, not the size of the catalogue. Lightkeeper's heap is already ~13 MB by
the end of `onInit`, so the same read lands in slack it already has — which is exactly why the
streaming reader described in the next subsection measured neutral on hardware.

**Four things are therefore settled as "do not attempt", with the reason:**

| | why not |
|---|---|
| Hand-roll the socket.io v2 protocol over `ws` | ~5-8 MB addressable, and **high** risk: every capability subscription in the app rides that transport, against an undocumented Athom subscription protocol |
| Replace `homey-api` with raw HTTP | the transport dependencies stay either way; the saving is Athom's thin client layer, and realtime subscriptions still need socket.io |
| Stream the flow-card catalogue | already tried and reverted — see the next subsection |
| Stop retaining `DeviceCatalog`'s device/zone maps | measured **negative**: re-parsing is dearer than holding, by about 5 MB |

**Rebuilding the control app is the durable part of this, and the recipe has four traps in it:**

- Read PSS from outside with `apps.getAppUsage({ id })` — the numbers are under `mem`, not at the
  top level — and **always read the control app and the real app in the same pass**.
- **Always read `pssSwap` beside `pss`.** An app with a large `pssSwap` has been paged out and its
  `pss` is not its footprint; an app with `pssSwap: 0` was restarted recently and is fully resident.
  This is the easiest mistake here, and the first version of this investigation made it.
- Read `system.getMemoryInfo()` first: below about 15% free, nothing else means anything.
- Install it from a short path — the CLI fails with an `ENOENT` on its own app directory when the
  path is long — and uninstall it afterwards, because on a Homey at 11% free a second app is not a
  free observer.

Lightkeeper's own `GET /diagnostics` carries `heap` — `heapUsed`, the per-space split and three boot
marks (§17) — which is what makes the app side of this comparable without a second install.

### Where it stops, and what was established by trying

**The app is substantially over Homey's 30 MB guideline, and as of 14 September 2026 that is known
not to be a property of this app's code.** The lever this section used to name — never materialising
the card response, scanning it incrementally instead — was built, shipped to hardware and measured.
It is worth writing down what happened, because the result is the opposite of what the reasoning
above predicts, and the reasoning was not wrong so much as out of date.

**1. There is no server-side filter, and that is now verified rather than assumed.**
`HomeyAPIV3Local.json` declares `parameters: {}` for `getFlowCardTriggers`, `getFlowCardActions` and
`getDevices`. Nine query shapes were tried against the live endpoint anyway — `uri`, `id`,
`deviceId`, `filter`, `ownerUri`, `$filter`, `fields`, `$select`, `select` — and **all nine returned
byte-identical full bodies** (200, 1816 items, 1,003,381 bytes). There is no filtered read to find.

**2. Streaming works, and was byte-exact.** A scanner that finds top-level element boundaries and
hands each one to `JSON.parse` separately produced **1832 of 1832 cards with zero field mismatches**
against `homey-api`'s own result. On a cold process it cut the read from **+16.88 MB of RSS to
+0.10 MB**.

Two traps inside that, both worth keeping even though the change was reverted:

- **The raw endpoint returns a JSON ARRAY, and carries no `uri` field at all.** `homey-api` returns
  an object keyed by id, and `Item`'s constructor synthesises `uri` as `homey:<itemId>:<id>` and
  defines it as an own property. Verified reproducible from `id` for all 1832 cards. Note what that
  means for §3: **every `card.uri` this app has ever used was constructed by the client library**,
  not returned by the Homey. `FlowCardTrigger` even overrides `uri` with a deprecation getter
  returning `undefined`; the value survives only because the constructor's own property shadows it.
- **The HTTP client costs more than the parse.** Node's global `fetch` is undici, initialised lazily,
  and that initialisation alone cost **+21.24 MB of RSS** — more than the materialising read it was
  meant to replace. `node:http` cost **+6.81 MB** for the same body.

**3. And on real hardware it changed nothing, because the premise had expired.** The 11.6 MB payload
this section is built on is not what the reference Homey returns any more: it is **1.0 MB** for 1816
trigger cards. A 1 MB parse fits inside the slack of a heap that is already 20 MB, so there are no
new pages to keep. Measured, five devices, three restarts each:

| build | readings | mean |
|---|---|---|
| materialising, through `homey-api` | 72.8 / 80.1 / 73.9 / 71.4 MB | ~74.5 MB |
| streaming, `node:http` + incremental scan | 74.5 / 80.1 / 73.9 / 71.4 MB | ~75.0 MB |

**4. The measurement noise is larger than anything left to win.** Three restarts of ONE identical
build read **71.4, 73.9 and 80.1 MB**. Nothing below about 10 MB is measurable on this Homey from a
single reading, which retires a lot of single-number comparisons recorded above.

**5. The floor is the machine, and this was A/B'd the hard way.** The 9 September build `09e120a` —
whose own test line recorded **36.6 MB** — was checked out into a worktree, built and installed on
the same Homey on 14 September, against the same five devices: **80.7 / 73.6 / 72.9 MB**. Identical
to HEAD. The same code, the same house, five days apart, doubled.

What moved is the Homey itself. `system.getMemoryInfo` on 14 September:

| | |
|---|---|
| total | 1.85 GB |
| free | **0.20 GB — 10.6%** |
| swap in use | **459 MB** |
| 32 apps' PSS, summed | 900 MB, of which **312 MB already swapped out** |
| `homey` core alone | 476 MB |

Under that pressure PSS is partly an artefact of what the kernel has reclaimed, which is also the
best available explanation for the ±9 MB band in point 4.

**So the honest statement is: this app's own JS heap is 15.2 MB with no devices and 18.1 MB with
five (§17 has the split), against an RSS of 74 MB. The remaining ~59 MB is not JS objects, is not
readable from inside, and did not change when the app's code changed.** Getting under 30 MB on this
Homey is not something this app can do by holding less.

Two things that ARE worth doing, and were:

- Every peer app on the same Homey, for scale: Spotify **10.5 MB**, Circadian Lighting 13.3, CountDown
  13.3, IKEA 21.3, Hue 33.0, Reolink 61.8 — median 27.2. Lightkeeper was second of thirty-two. A
  reading is only interesting next to that list, and `verify-hardware.mjs memory` should be read with
  it.
- The deep `homey-api` require is worth ~11 MB (above), and over half the app's heap at boot is its
  own module graph (§17). Those are the only two levers measured to matter, and the first is already
  taken.

`scripts/verify-hardware.mjs` encodes the outcome rather than the guideline — T59 reports the 30 MB
guideline and FAILS only past a 100 MB ceiling, because a line that failed on every run is a line
nobody reads.

Know what that line cannot do. It is a smoke check for a second bulk read appearing, and **not** a
regression test for retention: holding a parsed catalogue and merely having parsed one cost the same
RSS, so the number cannot separate them. The signal that CAN is the app's own `heapUsed` after a
read — and **that is now on `/diagnostics`** (§17), which is what makes a retention regression
detectable at all.

### A smaller one, in the same family

`require('homey-api')` eagerly loads 218 modules — the whole Athom Cloud tree, every class of which
loads its OpenAPI specification as a *static class field*, so the JSON is parsed at import time
whether or not anything calls it. `require('homey-api/lib/HomeyAPI/HomeyAPI')` loads five, and
`createAppAPI` / `createLocalAPI` require the local V3 client themselves on first use.

**Re-measured 14 September 2026 on a cold process, and it is worth far more than first recorded.**
The original note said 0.5 MB of heap and 0.7 MB of RSS:

| | heap | RSS |
|---|---|---|
| `require('homey-api/lib/HomeyAPI/HomeyAPI')` — the deep path we use | −0.8 MB | **+1.1 MB** |
| `require('homey-api')` — the package root | +3.1 MB | **+12.0 MB** |

So the deep path is worth **~11 MB of RSS**, not 0.7, and it is one of the largest single savings in
the app. The "do not tidy this back to the package root" note on it is load-bearing.

### Reading the number back

`GET /api/manager/apps/app/:id/usage` (`ManagerApps.getAppUsage`) is what
[the app-profiling tool](https://tools.developer.homey.app/tools/app-profiling) reports, and
`GET /api/manager/system/memory` (`ManagerSystem.getMemoryInfo`) gives the per-app breakdown around
it. `node scripts/verify-hardware.mjs memory` reads both — T59 and T60.

Three things about those two that cost time to work out:

- **`getAppUsage` answers `{ mem, cpu }`, and the numbers are under `mem`** — `{ rss, pss, pssSwap,
  sharedClean, sharedDirty, pssTotal, sharedTotal }`. There is no top-level `pss`, which is why
  `pssBytesIn()` searches rather than reading a field.
- **`getMemoryInfo` answers `{ total, free, swap, types }`**, and `types` is keyed
  `homey:app:<id>` for every app plus `homey`, `video`, `matterd`, `zigbeed` and friends. It is the
  fastest way to see the whole machine at once, and the only way to see that the app you are
  measuring is competing with a core process using 476 MB.
- **Read `free` and `swap` before believing any app's number.** On a Homey with 10.6% free memory and
  459 MB of swap in use, PSS reflects what the kernel has reclaimed as much as what the app holds.

The app's own `heapUsed`, the per-space split and the boot marks come from `GET /diagnostics` on the
app's own Web API instead — see §17. That is the reading that can tell retention from a parse, which
PSS cannot.

---

## 16. Geolocation, and the sun the SDK will not compute for you

The daylight device types need to know how high the sun is. Nothing on the platform will tell them,
and the shape of what IS available is what forced the design in `lib/daylight/`.

**`this.homey.geolocation` gives a position and nothing else.** Four synchronous accessors —
`getLatitude()`, `getLongitude()`, `getAccuracy()` (metres) and `getMode()` (`'auto'` or
`'manual'`) — plus a `location` event. All four require the `homey:manager:geolocation` permission,
which this app now declares alongside `homey:manager:api`. Synchronous matters: the value can be
read inside a tick with no round trip, which is why `app.ts` can hand `lib/` a plain
`location: () => Location | null` closure of exactly the same shape as the `timezone` one, and why
`lib/daylight/` needs no async seam for it.

*Read off `node_modules/@types/homey/manager/geolocation.d.ts` and the manager list in §9. Verified
on hardware: the permission resolves and the accessors return the Homey's own position — see
`docs/hardware-test-plan.md`.*

**No manager answers "when is sunrise", and §9 already covers why the trigger cards do not help.**
`homey:manager:cron:sunrise` and `:sunset` exist and fire; they do not answer a question, so they
cannot supply a number to interpolate against. There is no solar helper anywhere in the SDK and no
`sunrise` string anywhere in `homey-api`. So the arithmetic is ours:
`lib/daylight/solar-elevation.ts` is the standard NOAA solar-position algorithm, pure, ~120 lines,
and asserted against values astronomy fixes independently of any implementation (declination at the
poles, `90 −` the latitude gap at noon, hemispheric mirroring at an equinox, an hour per 15° of
longitude).

**A second permission is a paragraph for the reviewer, not a new category.** The app is already
reviewed as Tools-style for `homey:manager:api` — `homey app validate` says so itself. What the
review notes have to say about this one is short: the sun's position needs the Homey's position,
nothing computes it for us, and the latitude never leaves the Homey. See
[`homey-review-notes.md`](homey-review-notes.md).

**`0, 0` is what an unset location reads as.** It is also a real place, in the Gulf of Guinea, and on
a Homey in somebody's house the first is overwhelmingly more likely. `usableLocation()` in
`lib/daylight/daylight-types.ts` refuses it, along with out-of-range and non-finite values, because
the cost of guessing is a confident sun elevation for a point in the ocean dimming a room in
Denmark by it. Refusing yields `source: 'none'`, which falls back to the brightness the user set by
hand.

### `measure_luminance` is the only lux capability, and it declares no range

`homey-lib`'s definition (`assets/capability/capabilities/measure_luminance.json`) is
`type: number`, `units: lx`, `decimals: 2`, `getable: true`, **`setable: false`**,
`uiComponent: sensor`, with a `measure_luminance_changed` trigger. There is no
`measure_illuminance`, no solar capability, and no UV-to-lux anything. Two consequences:

- **It carries no `min` and no `max`**, unlike `dim` and `light_temperature`. So
  `TargetResolver.primeCache()`'s `min ?? 0 / max ?? 1` defaults would silently describe a lux
  sensor as a 0–1 axis, and `TargetStateCache.supports()` returns `false` for it anyway because it
  is not in `TargetCapabilities`. A sensor therefore must NOT be read through the light seams. It is
  not a widening that was skipped for effort: the `Capability` union in `lib/outputs/intent-planner.ts`
  is the set of things this app WRITES, and putting a read-only sensor into it would put a sensor in
  the write path. `lib/daylight/luminance-source.ts` subscribes to it directly instead, with the
  same `makeCapabilityInstance` + `api.track()` teardown pattern `LightTargetAdapter` uses.
- **A reading is never treated as stale.** Many Zigbee sensors report only on change, so a quiet
  sensor in a stable room is correct rather than broken, and a timeout would fall back to the sky
  precisely when the sensor was telling the truth. Unusable means the device is gone, `available`
  is false, or it has never reported a finite number. A frozen sensor is instead made visible: the
  age of every reading is on the settings page and in diagnostics.

*Capability definition read from the pinned `homey` CLI's bundled `homey-lib`. What real sensors
actually report — scale, resolution and reporting interval, which are per-integration and where the
`darkLux` / `brightLux` defaults of 5 and 500 will be judged — is what
`node scripts/probe-lights.mjs inventory --all` is for, and is not yet established.*

### What a real house's lux sensors actually report

Measured 4 September 2026 from Homey's own Insights history — four
`measure_luminance` sensors in one house, 288 samples each over 24 h (Insights
serves 5-minute buckets at `last24Hours`; coarser resolutions bucket-AVERAGE, and
`last31Days` returns ~4 points a day, which flattens exactly the peaks a response
has to span). `insights.getLogEntries({ id, resolution })` returns
`{ values: [{ t, v }] }`.

| Sensor | min | p50 | p95 | max | distinct values / 288 | last reported |
|---|---|---|---|---|---|---|
| Kitchen motion | 1 | 174 | 1278 | 1289 | 194 | 2 min ago |
| Activity room (Hue) | 1 | 4.2 | 64.5 | 164 | 172 | 2 min ago |
| Utility room (Hue) | 1 | 1 | 1 | 1 | **1** | **52.6 days ago** |
| Studio motion | 73.55 | 73.55 | 73.55 | 73.55 | **1** | **58.9 days ago** |

Two things follow, and both matter more than the numbers.

**Half the sensors in this house are FROZEN, and Homey reports them as
`available: true` with a finite value.** They are indistinguishable from a
genuinely constant room by anything except the reading's age. This is the case
the app's rule was written for — "a sensor reading is never treated as stale,
because many Zigbee sensors report only on change, so a quiet sensor in a stable
room is telling the truth" — and it is now measured rather than hypothesised:
the rule is right, and the age display is the only thing standing between a user
and a Room-sensing Light that holds one brightness forever. Worse, the frozen Studio
sensor is in the room whose lamps this household actually automates.

**`brightLux = 500` suits a kitchen and almost nothing else.** Of the two LIVE
sensors, one reaches 1278 lx and the other tops out at 164 with a p95 of 64.5.
A response spanning 5 → 500 in the second room would sit near its dark end all
day, hold the lamps near full, and read as "this feature does nothing". The
defaults are one household's evidence, so they are recorded here rather than
changed on the strength of it — but the shape of the answer is that a global
`brightLux` cannot be right for both a south-facing kitchen and an interior
room, and the sensor's own history is available at pairing time.

### Insights answers the APP's own token, and a sensor's own week is the fix for 5/500

**Established on hardware, 13 September 2026** — Homey Pro 2023, firmware 13.5.0-rc.4,
homey-api 3.19.2.

The section above ends by saying the sensor's own history is available at pairing time. It is, and
from inside the app: `insights.getLogEntries({ id, resolution })` succeeds on the **app-token**
client, for a device the app does not own. That is not obvious from §1 — the app token is refused
for flow WRITES — but it is consistent with it, because every read succeeds and this is a read.

Three things worth not re-deriving:

- **There is no permission to add.** `homey-lib/assets/app/permissions.json` lists thirteen
  permissions and `homey:manager:insights` is not among them; `homey:manager:api` is the only API
  permission that exists, and Lightkeeper already declares it. So reading Insights widens the
  App Store review surface by exactly nothing.
- **The manager must be connected first.** `insights` is not in the default connect list; it is
  added to `READ_MANAGERS` in `lib/homey-api-service.ts`. `connectManagers` treats a manager that
  will not connect as degraded rather than fatal, and `readSensorWeek` answers `null` rather than
  throwing, so a firmware that refuses this loses the week and keeps the app.
- **The log id is `homey:device:<deviceId>:measure_luminance`**, and `resolution: 'last7Days'`
  returns buckets fine enough to average into two-hour cells — 82 of 84 cells were covered for all
  four sensors below, the two gaps being the rest of the current day.

**What the four sensors in the reference house actually want.** Read through the app, 13 September
2026, as `darkLux → brightLux` derived from each sensor's own week:

| Sensor | night | middle of the day | derived span | the shipped default |
|---|---|---|---|---|
| Hue motion, Utility room | 1 lx | 31 lx | **2 → 20** | 5 → 500 |
| Hue motion, Activity room | 1 lx | 41 lx | **2 → 50** | 5 → 500 |
| Motion sensor, Kitchen | 1 lx | 271 lx | **2 → 200** | 5 → 500 |
| Motion sensor, Studio | 1 lx | 454 lx | **2 → 500** | 5 → 500 |

Only one of the four wants anything like 500, and it is the only one the default would have served.
A response spanning 5 → 500 in the Utility room sits near its dark end all day and holds the lamps
near full — the failure §16 predicted from a 24-hour sample, now measured across a week on four
sensors at once. **This is the argument for pre-filling both thresholds from the sensor rather than
from a constant**, and it is why the pairing screen draws the week rather than asserting the numbers.

One incidental correction to the table in the previous subsection: the Utility room and Studio
sensors were recorded there as FROZEN, last reporting 52.6 and 58.9 days earlier. Both report
normally now, so that reading was of two sensors that have since been replaced or re-paired — the
frozen-sensor rule it motivated is unaffected, but the specific sensors are no longer examples of it.

## 17. The app sandbox: no RSS, and `onUninit` does not finish

Two things an app cannot do inside its own process, both established on **firmware 13.5.0** on
9 September 2026 while reading back the first evidence archive the recorder ever produced. Neither
is discoverable from a unit test, because both work everywhere a test runs.

### `process.memoryUsage()` throws

Every call raises:

```
ENOENT: no such file or directory, uv_resident_set_memory
```

The sandbox does not expose the `/proc` entry libuv reads for RSS, and Node surfaces that as a plain
`ENOENT` — not as a permission error, and not as anything whose name suggests memory. `process.uptime()`
and `process.version` are both fine, so the failure is specific to the resident-set read rather than
to `process` as a whole.

**The trap is not the throw, it is where the throw lands.** It was called bare inside an object
literal:

```ts
this.evidence.record('health_sample', {
  ...this.evidenceContext(),
  memory: process.memoryUsage(),   // throws
  sensors: this.luminance.watched(),
  credential: this.credentials.getStatus(),
});
```

A literal is evaluated in full before the call it is an argument to, so one throwing property took
the entire sample with it — the timezone, the sensor ages, the credential status, none of which had
anything to do with memory. The surrounding `catch` then wrote a `sampling_error` in its place, once
per sample, for the life of the recording: **the first archive contained 8 identical errors and zero
health samples**, and the analysis reported `maxRssBytes: 0` because there had never been a reading
to take a maximum of.

Measured before and after the guard, on the same Homey and the same archive:

| Boot | Build | `health_sample` | `sampling_error` |
|---|---|---|---|
| `c511a268` | before | 0 | 2 |
| `8922d700` | before | 0 | 2 |
| `07737152` | before | 0 | 4 |
| `637025a9` | after | **1** | **0** |

So: **wrap it, and never put a platform call bare inside a literal you are handing to something
else.** The app's own footprint is readable from OUTSIDE — `apps.getAppUsage`'s `pss` field, which is
what `scripts/verify-hardware.mjs memory` reads — so nothing that mattered is lost; it simply cannot
be read from in here.

#### What CAN be read from in here, established 14 September 2026

The conclusion above was right about RSS and wrong about memory in general. `lib/support/heap-report.ts`
is the result, and `/diagnostics` now carries it — which is what §15 had asked for and left undone.

| call | verdict on firmware 13.5.0 |
|---|---|
| `process.memoryUsage()` | throws `ENOENT … uv_resident_set_memory` |
| `/proc/self/statm`, read directly | throws `ENOENT: no such file or directory` |
| `v8.getHeapStatistics()` | **works** — `used_heap_size`, `total_heap_size`, `heap_size_limit`, `external_memory`, `malloced_memory` |
| `v8.getHeapSpaceStatistics()` | **works** — the per-space split, which is what tells retention from a parse |
| `process.resourceUsage()` | **answers**, and its `maxRSS` is a lie — see below |
| `process.uptime()` | works |

Two things follow.

**`/proc` is not mounted for an app at all.** The failure is not libuv's reader being unusual; the
file is not there. So RSS genuinely cannot be read from inside, by any route, and the outside reading
is the only one. Do not go looking again.

**`process.resourceUsage().maxRSS` must not be reported as this app's high-water mark.** It read
**105.3 MB** identically across an app restart AND two reinstalls — three different process
lifetimes, to the 0.1 MB. `maxRSS` survives `fork()` and is reset only by `exec()`, so a Homey that
forks its app workers from a long-lived parent hands every one of them the parent's high-water mark.
It is the app-runner's number, not the app's.

What IS attributable is the JS heap, and `markPhase()` in `heap-report.ts` records it at three named
points so the floor can be split. Measured on a freshly restarted app with no devices:

| mark | `heapUsed` |
|---|---|
| `modules-loaded` — every import done, before any app logic | **8.8 MB** |
| `onInit-start` | 8.9 MB |
| `onInit-end` | 12.8 MB |
| settled, no devices | 15.2 MB |
| settled, five devices | 18.1 MB |

So **well over half the app's JS heap is spent importing its own modules**, before a line of its
logic runs — and the whole heap is 15 MB against an RSS of 74 MB. The gap is not JS objects, and
`heap_size_limit` says V8 is working to a **73.4 MB** cap, nowhere near reached. Anything hunting the
footprint should start from those two facts rather than from the app's caches.

### `onUninit`'s asynchronous work does not complete

An `app_shutdown` record written from `onUninit` **never reaches the archive**, across three app
restarts and one reinstall of the same build. The same archive recorded 444 records, three
`app_boot`s and one `recording_stopped` in the same period.

The discriminator is that last one. `recording_stopped` is written by the same `record()` and flushed
by the same `flush()` — gzip, AES-256-GCM, append, `fsync`, save the manifest — and it arrives
reliably, because it runs inside an API request that the platform waits for. So the buffer, the
cipher, the write and the manifest save are all sound; what does not happen is `onUninit` getting far
enough to use them.

Moving the call from the LAST line of `onUninit` to the FIRST — ahead of four `destroyAll()`s and two
`destroy()`s — changed nothing, which points at `onUninit` not being awaited (or not being invoked at
all) rather than at running out of grace part-way down.

Two consequences worth carrying:

- **Anything that must survive a restart has to be written on the way UP, not on the way down.** The
  recorder's boot boundary comes from `app_boot` plus a fresh `bootId` under the same `runId`, both
  written during `onInit`, and that is what `hardware-test-plan.md`'s T99 checks. A teardown record is
  a nice-to-have and must never be load-bearing.
- **It does not follow that `onUninit` is useless.** Its synchronous work — clearing intervals and
  timeouts — plausibly still runs, and the SDK's own timers are disposal-safe regardless. What cannot
  be relied on is an `await` inside it reaching its end.

### And `/userdata` is served without authentication

Related, and measured at the same time. The archive file is reachable over plain HTTP on the LAN with
no credentials at all:

```
GET http://<homey>/app/com.thomassidor.lightkeeper/userdata/lightkeeper-evidence/<id>.enc
  -> 200, 53774 bytes
```

This is the same surface §8 measured when it established that the Homey serves files beside a pair
view. `GET /userdata/...` without the `/app/<id>` prefix is a 404, and the app's own Web API is a 401,
so it is specifically the app's `/userdata` tree that is public.

What came back was checked against every sensitive string this Homey actually contains — nine device
and zone names, the household name, and the leading twelve characters of both Personal API Keys:
**no plaintext leaked**, all 26 frames were exactly `{iv, tag, data}`, and the ciphertext measured 41%
printable against ~36% for random bytes.

So the encryption on that file is **load-bearing, not defence in depth**. The key lives in
`homey.settings`, which does require authentication — but anyone on the network can take the file, and
whether they can read it depends entirely on the cipher. Any future feature that writes to `/userdata`
inherits this and must assume its files are public.

---

## 18. A device capability is a Flow tag, and a custom one is the only read-only number

Established 17 September 2026, against `homey@4.4.3`'s bundled `homey-lib` and Athom's SDK
documentation, while making the four engines' arithmetic usable from somebody else's Flow.

**Every capability on every device is already a global Flow token.** Athom's own words: *"By default
a device's capability are registered as global tokens."* So a value put on a Lightkeeper device is,
with no further code, a tag in the Flow editor's picker — droppable into Homey's built-in "Dim to",
"Set a temperature", a Logic card or a notification. That is the whole reason this app publishes
capabilities at all rather than inventing a token API: `homey.flow.createToken()` exists and would
have produced a flat list of app-wide tags with no device to group them under.

**A `.homeycompose/capabilities/<id>.json` is the only way to publish a read-only number.** Every
`dim` and `light_*` capability in `homey-lib` is `setable: true` — checked one by one — and there is
no generic `measure_number` or read-only percentage. The consequences of borrowing `dim` instead:

- Homey draws a **draggable slider**, and a driver with no `registerCapabilityListener` behind it
  rejects the write the user just made.
- Homey **auto-generates Flow cards** from the capability's own `$flow` block in `homey-lib` — `dim`
  carries a "Dim to" action and a "The dim level changed" trigger — so the card picker would offer a
  "Dim to" on a virtual device that cannot dim.
- The device starts **looking like a lamp** to everything else in the house, including other apps'
  light pickers.

A custom capability has none of that: it generates no Flow cards at all, which is a cost as well
(there is no automatic "changed" trigger; one has to be authored), and it renders as whatever
`uiComponent` says.

**A `units` string is appended verbatim.** For a `uiComponent: "sensor"` row Homey prints the value
and then the units, so `units: "%"` on a 0..1 number reads `0.26 %`. `dim` gets away with declaring
both because Homey's own frontend special-cases it. A value meant to be dropped into "Dim to" has to
stay on the 0..1 axis — that is what the built-in card takes — so the honest choice is to keep the
axis and drop the units, and say what the number is in the title.

**One custom capability is a control, and it is an enum.** `lightkeeper_control` (0.6.6) is
`type: enum`, `setable: true`, `uiComponent: picker`, with a `registerCapabilityListener` behind it on
the three engine device types — the tile's copy of the review screen's "How Lightkeeper controls your
lights". An enum has none of the slider problem above: there is no system capability it could be
mistaken for, and its values are the app's own. A Room-sensing Light narrows it to two through
`capabilitiesOptions.<id>.values`; `homey-lib` validates that key only for `target_power_mode`, so
`validate` accepting it says nothing about the phone drawing two, which is what T183 checks. The
device layer refuses the third value regardless.

**A custom capability's icon is a file, and Homey's own are borrowable as files only.** `icon` takes
an app path and `validate` checks it exists case-exactly (`lib/App/index.js`); there is no way to
name a system capability's icon, and `capabilitiesOptions` has none (§10). Athom's capability
reference serves every system icon at
`athombv.github.io/athom-cloud-driver-reference/icons/<capability id>.svg` — 64×64, single-colour,
which is what a mask wants — and `assets/capabilities/` ships five of them unmodified.

**`titleShort` needs `compatibility >=13.2.1`**, which is above this app's floor of `>=12.9.0`. It
fails `validate` at publish level with `capabilities.<id>.titleShort requires a compatibility of at
least >=13.2.1` — one of the few places the validator is stricter than the schema.

### A driver's `capabilities` array applies at PAIRING and never again

The list in `driver.compose.json` is what a device is built with. Changing it in a release does
nothing to a device the user already owns: no capability appears, none disappears, and there is no
warning anywhere. `Device.addCapability()` / `removeCapability()` / `hasCapability()` are the only
way, and they have to run on every init — so a device layer that adds a capability needs a
reconciliation step, and it needs to survive one failing, because a tile missing a row is worth far
less than a device that refused to start.

### The compose paths, and what the CLI does to them

`node_modules/homey/lib/HomeyCompose.js` documents the full set. The three that matter here:

| Path | What it produces |
|---|---|
| `.homeycompose/capabilities/<id>.json` | one entry in `app.json`'s top-level `capabilities`, keyed by the filename |
| `.homeycompose/flow/<triggers\|conditions\|actions>/<id>.json` | an app-level card, id from the filename |
| `drivers/<id>/driver.flow.compose.json` | `{ triggers, conditions, actions }`, each an ARRAY of cards that each need their own `id` |

A driver-composed card lands in the **app-level** `flow` block, not on the driver — the app schema
has no `flow` property on a driver at all. On the way the CLI `unshift`s
`{ type: 'device', name: 'device', filter: 'driver_id=<driver>' }` onto the card's `args`, and
`removeDollarPropertiesRecursive()` strips every `$`-prefixed key (`$flow`, `$extends`, `$filter`,
`$id`, `$deviceName`) before `app.json` is written. That last one is why a driver entry in `app.json`
is still exactly its `driver.compose.json` plus an `id`.

Card ids are **global**, so two drivers declaring the same `id` collide silently in one array. Name
them for the driver.

**`[[device]]` is refused in a device-scoped card's `titleFormatted`.** The device is implied and
Homey renders it itself; writing the placeholder fails validate with
`Invalid [[device]] in flow.conditions['<id>'].titleFormatted.en.titleFormatted`. It is refused
whether the device argument was added by the CLI or declared by hand. Older apps on the same Homey
do ship it — `com.mi.flora`'s conditions read `The plant [[device]] !{{has not|has}} …` — so this is
a rule the validator gained after they were published, not a rule about what the runtime accepts.

### A device-scoped card is registered per DEVICE, and looking for it under the app finds nothing

Measured 17 September 2026, and it cost four reinstalls and a bisect of a card that was working the
whole time. A card with a `device` argument does **not** appear under `homey:app:<appId>:<cardId>`.
Homey scopes it to each matching device and registers one card per device instance:

```
homey:app:com.thomassidor.lightkeeper:set_lights              <- no device arg, app-scoped
homey:device:85b5c52b-…:daylight_is_dark                      <- device arg, one per device
homey:device:a9000f3c-…:daylight_is_dark
homey:device:bdc19572-…:daylight_is_dark
```

Three consequences, and the second is what makes this expensive to diagnose:

- **`ownerUri` is the DEVICE**, not the app. Filtering `GET /api/manager/flow/flowcardcondition/`
  by an app id returns nothing for such a card, however healthy it is.
- **Creating a Flow with the app-scoped URI fails with a message that reads like the card does not
  exist**: `404 Not Found: FlowCardCondition with ID homey:app:<appId>:<cardId>`. That is the
  message a missing card gives too, so the obvious reading of it is wrong.
- **The `device` argument is consumed by the scoping** and is gone from the registered card's `args`,
  which is left holding only the card's own arguments.

The app side is unchanged by any of this: `homey.flow.getConditionCard('<cardId>')` takes the bare
id, and the run listener receives the chosen device as `args.device`. Only the READ side differs.

What this looks like when it really has failed, for next time: the card is absent from a listing
keyed on `homey:device:*:<cardId>` as well, and `onInit` still completes — `getConditionCard` reads
the app's OWN manifest, so it succeeds whatever the Homey's index holds, and is no evidence either
way.

### What an action card can hand back, and where it cannot

Any card may declare `tokens`, and an action's run listener returning an object fills them — but
Athom's documentation is explicit that such a card *"won't display in standard Flows, only in
Advanced Flow mode."* So returning tokens is not a substitute for publishing capabilities: the
capability route works in an ordinary Flow, and the token route does not.
