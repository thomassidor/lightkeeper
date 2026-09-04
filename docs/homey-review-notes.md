# Notes for Homey app review

This app asks for Homey's broadest API permission *and* asks the user to paste a
Personal API Key. Both are unusual, both are load-bearing, and both are the first
things a reviewer will question. The answers are here so they do not have to be
reconstructed each submission.

`homey app validate` says as much itself: *"using the homey:manager:api permission
will require a more thorough review"*.

---

## Why `homey:manager:api`

Lightkeeper has to enumerate source devices, target lights, zones and the Flow
trigger cards that *other apps* own — plus Homey's own time trigger card, which the
schedule device is built on; subscribe to target capability changes; set capability
values on target lights; and read back the Flows it generated. Homey's broad Web API
permission is the only permission that exposes cross-app resources at all.

It is also the only API permission that exists. `homey-lib`'s
`assets/app/permissions.json` lists exactly one, so there is no finer-grained
"may read flow cards" scope being skipped here — asking for less is not an option
the platform offers.

## Why a user-supplied Personal API Key

**The app's own Web API session cannot write Flows.** `createFlow` through
`HomeyAPI.createAppAPI`, authenticated with `homey.api.getOwnerApiToken()`, is
refused server-side:

```
Error: Missing Scopes
    at SessionLocal.checkScopes (file:///app/packages/homey-core/lib/Session.mjs:86:13)
```

Every flow *read* succeeds; every flow *write* is refused. A Personal API Key
created by the user succeeds at the full create/read/delete lifecycle, including
from inside the app process. Since generating Flows is the entire mechanism by
which this app works, and no app permission grants it, the key is unavoidable.

Athom's own position, pointing users at Settings → API Keys: *"Clients using the
Web API with OAuth2 cannot have these scopes for obvious security reasons"*.

**How the key is handled.** Stored in app settings on the user's own Homey. Used
for Flow writes only — never for reads, which go through the app's own session.
Never logged, never returned through the app's Web API, never included in a
diagnostics report. Two mechanisms enforce that and both are covered by
`test/unit/diagnostics-redaction.test.ts`. If the key expires, controllers keep
driving lights, existing schedules keep firing, and only Flow maintenance pauses.

**Why `local` only.** `homey:manager:api` is incompatible with Homey Cloud, and
the design depends on local cross-app Web API access.

**Why Homey Pro 2023 or newer.** Earlier models cannot create Personal API Keys
at all, so the app cannot work on them. That is the real compatibility floor —
the manifest's `>=12.9.0` is a firmware floor on top of it.

## Why schedules use Homey's own time trigger

The app ships five device types and two of them generate Flows. A light schedule compiles to
two Flows per window — one at each end — triggered by **Homey's own time card**,
which the app locates by enumerating the trigger cards this Homey offers and echoing
that card's `id` and `uri` back verbatim. It never constructs a card URI, and it does
not depend on any other app's cards.

Two consequences a reviewer may want to check:

- There is **no scheduler in SDK v3** (v2's `ManagerCron` is gone), so the
  alternative would have been in-app timers. Using the Flow engine instead means DST,
  clock changes and restarts are handled by the platform, and every schedule is
  visible and inspectable in the user's own Flow list.
- The **day-of-week filter is not in the Flow**. Each Flow fires daily and the app
  checks the weekday against `homey.clock.getTimezone()` before acting, so changing
  which days a schedule runs on rewrites no Flows. Refusals are recorded, with their
  reason, in the app's own diagnostics.

---

## Why three of the five device types ask for no key at all

A reviewer opening the Add-device list will find five drivers, two of which start
with an API-key screen — **Light controller** and **Light schedule** — and three which
do not: **Circadian light**, **Curve light** and **Daylight light**. That is deliberate
and worth checking against the code, because those three are the place the key is
genuinely unnecessary.

A circadian light and a Curve light both make lights follow the colour temperature of
the day, and they are one engine: the circadian light asks what the lights should look
like at their warmest and coolest and supplies the shape of the day itself, while a
Curve light exposes every point and lets any of them carry a colour from a closed
palette instead of a warmth. A lamp that cannot show a colour is written the point's
warmth instead, so the shape of the day is the same on every lamp.

Neither has boundaries, so neither has anything to schedule and both generate **no
Flows at all**: they subscribe to their target lights' `onoff` and `light_temperature`
(through the app's own token, the same subscription the controller already uses), plus
`light_hue` where a point carries a colour, and write the day's value when a light
comes on and once a minute while it is on. There is no `createFlow` on that path, so
there is nothing a Personal API Key would authorise.

Three consequences a reviewer may want to verify:

- It uses `homey.setInterval` — one interval for every curve-driven device on the Homey
  (both device types share one registry and therefore one timer),
  not one each — rather than the Flow engine. That is the opposite of the schedule
  device's choice above, and the reason is that a curve has no boundary to miss: a
  skipped tick is corrected by the next one. Expressing a smooth curve as Flows would
  mean dozens of them per device in the user's own Flow list.
- **It never switches a light on or off.** It only writes colour, and only to lights
  that are already on — unless the user opts into pre-setting the colour of lights
  that are off, which the pairing screen makes them prove on their own lamps first,
  and which the app disables by itself if a lamp ever comes on from such a write.
- It stands down for any light whose colour someone changes by hand, until that light
  is switched off and on again.

---

## Why `homey:manager:geolocation`, and what it is used for

**New in 0.6.0, and it is one line of arithmetic.** The **Daylight light** sets its
lights' brightness from how much light is already in the room. Where the household
owns a light sensor it reads that; where it does not — which is most households — it
works out **how high the sun is**, and the sun's position needs the Homey's position.

`this.homey.geolocation.getLatitude()` and `getLongitude()` are the only two calls,
they are read at the moment a brightness is computed, and the latitude and longitude
**never leave the Homey**: there is no request, no cloud call and no telemetry
anywhere in the app. What happens to them is the standard NOAA solar-position
algorithm in `lib/daylight/solar-elevation.ts`, which is pure arithmetic with no
dependencies and is unit-tested against values astronomy fixes independently.

Three things a reviewer may want to check:

- **The alternative does not exist.** SDK v3 has no solar helper and no manager will
  answer "how high is the sun". Homey's own `homey:manager:cron:sunrise` and `:sunset`
  are trigger cards — they fire, they do not answer a question — so they cannot supply
  a number to interpolate against. The permission plus ~120 lines of arithmetic is the
  whole of the alternative.
- **It degrades rather than failing.** A Homey that has never been told where it is,
  or a user who declines the permission, gets a Daylight light that reports plainly
  that it cannot tell how light it is and **leaves the lights alone** — and one with a
  light sensor works completely, with no location at all.
- **It reads a sensor and writes nothing to it.** `measure_luminance` is `setable:
  false`, and the app subscribes to it through its own token exactly as it already
  subscribes to a lamp's `onoff`. The sensor is never written to, and deliberately
  cannot be: the capability union the write planner accepts does not contain it.

The Daylight light itself follows the same two rules as the colour-following types
above: it **never switches a light on or off**, only dimming lights that are already
on, and it stands down for any light whose brightness someone changes by hand until
that light is switched off and on again.

## Test script

1. Install on a Homey Pro 2023 or later running firmware 12.9.0 or newer.
2. Open Devices, add Lightkeeper, and follow the API-key instructions.
3. Select an already-paired source and confirm the discovered events.
4. Select individual lights; map on/off and brightness; use **Test** on each row;
   save.
5. Press and turn the physical remote. Confirm the lights actually change, and
   that Settings → Lightkeeper shows the presses and the writes.
6. Repair the controller, switch targets to a zone, save. Add or move a lamp in
   that zone and confirm it is picked up without reconfiguring.
7. Add a **Light schedule**: pick two lights, set one schedule a minute or two
   ahead with a short duration, use **Test on** and **Test off**, then save. Two
   Flows should appear in the Lightkeeper folder at the two times shown on
   screen, and both boundaries should fire on the clock.
8. Move that schedule's on-time. The old pair of Flows must be replaced, not left
   behind firing at the old time.
9. Turn the schedule device's own switch off. Its Flows stay, nothing fires, and
   the device stays available so the switch can be turned back on. Turn it on
   again inside an active window and the lights should come on rather than wait
   for tomorrow.
10. Set a schedule to weekdays only and check a non-matching day: Settings →
    Lightkeeper shows the boundary arriving and being ignored, with the reason.
11. Change a light outside Lightkeeper, then use a relative brightness gesture —
    it should continue from the light's real state, not from a stale one.
12. **Revoke the API key.** Existing mappings must keep controlling lights, while
    the app asks for a new key. Paste a new one: every mapping should survive and
    the controllers should return to ready without a restart.
13. **Hand-edit a generated Flow**, including changing the time on a schedule's
    Flow. Lightkeeper must ask for repair rather than overwrite it.
14. **Delete the controller, and separately a schedule.** Only the Flows
    attributable to that device may be removed. Then check the orphan count in app
    settings: with the other device still running it must not report the survivor's
    Flows as orphans.
15. Add a **Curve light** (no API-key screen). Draw a curve over the day, give one
    point a colour rather than a warmth, and include a lamp that cannot show colour
    — it must take that point's warmth instead. Confirm **no Flows are created**,
    that the lights are right the moment they are switched on, and that the device
    never switches a lamp on or off by itself. A **Circadian light** is the same
    engine with two questions instead of a curve.
16. Add a **Daylight light** (no API-key screen). Confirm **no Flows are created**.
    The second screen leads with what it currently reads: a sun elevation, plus any
    light sensor you pick and what it reads in lux. With a sensor picked, cover it
    with your hand and confirm the lamps ease down over a minute or two rather than
    jumping — and that they then **settle** rather than moving every minute.
    Confirm the device never switches a lamp on or off by itself.
    On a Homey with no location set, confirm it says so plainly and leaves the lights
    alone rather than guessing.
17. Restart the app, then the Homey, and repeat a mapped action.

Steps 12, 13 and 14 are the ones worth the time — they are the app's genuinely
risky behaviours, and each is a deliberate safety property rather than an
accident of implementation.

## Review access

- No vendor cloud account exists, so there is no test account to supply.
- The reviewer creates a Personal API Key on their own review Homey. A key must
  never be committed or sent publicly — it embeds a session id.
- Do not share one key between the app and an external tool at the same time. A
  key holds a single live session and concurrent holders invalidate each other;
  the symptom is a key that "randomly" stops working.

## Known limitations, stated plainly

- **The Daylight light's icon and store image are PLACEHOLDERS in 0.6.0** — a plain
  circle and a flat violet disc. They satisfy every automated check and neither is
  the finished artwork; the record is in `artwork/provenance.md` and
  `artwork/asset-spec.md`, and replacing them is a publish blocker rather than a
  nice-to-have. Flagged here rather than left to be noticed.
- **A light sensor in the same room as the lights it drives measures those lights**,
  which closes a control loop. The app damps it — a deadband below what the eye can
  see, and a slew limit of one small step per minute — and cannot remove it. This is
  stated in the app's own FAQ along with the sensor placements that avoid it, rather
  than being left for a user to discover.
- **What a real `measure_luminance` sensor reports is per-integration and is not
  established.** The two lux thresholds a Daylight light asks for default to 5 and
  500, which is a judgement rather than a measurement; the pairing screen shows the
  chosen sensor's current reading so the user sets them against something real.
- Compatibility follows what the source's owning integration exposes, not the
  model on the box. The same hardware can offer a different event surface through
  a different pairing path — a Hue device exposes more through the Philips Hue app
  than through Matter.
- Controls whose range would expand past 12 Flow variants are declined rather
  than flooding the user's Flow list.
- A ramp always stops after 10 seconds. Not configurable: release events are
  routinely dropped on Zigbee and unreliable on Matter/Thread, so a stuck ramp is
  a certainty rather than a risk.
- Rotary behaviour differs by pairing path. Matter BILRESA exposes stepping with
  no release event, so no hold-ramp is offered for it.
- Circadian lights are clock times only too — the stored anchor is a union with a
  sunrise/sunset variant declared and deliberately refused, because real sun times
  would need `homey:manager:geolocation`, which this app does not request.
- A circadian light and a schedule pointed at the same lights will disagree: the
  schedule sets a warmth at its boundary and the circadian light overwrites it within
  minutes. Stated in the README and FAQ rather than detected.
- Schedules are clock times only; sunrise and sunset are not offered. They follow the
  Homey's own timezone, which the settings page displays next to each schedule.
- Twelve schedules per schedule device — one schedule is one on/off window — which
  is twenty-four generated Flows. Past that the user's Flow list stops being
  readable.
- If the app is not running at the moment a window should end, that off is missed and
  the lights stay on until the next boundary. The app deliberately does not switch a
  household's lights off at start-up on the assumption that it once switched them on;
  it does switch them on when it starts up *inside* a window.
- **Per-transport output latency beyond the Hue Bridge is untested**, because
  every light on the test Homey sits behind that bridge. A `setCapabilityValue`
  to a Hue Bridge light acks in roughly 275 ms; nothing is claimed about Zigbee
  or Matter lights driven directly.

Verified end to end on a Homey Pro 2023 (firmware 13.4.0) against IKEA STYRBAR
(Zigbee, local), Philips Hue Dimmer v2 and Hue Tap Dial (Hue Bridge), and IKEA
BILRESA (Matter/Thread).

The schedule device was verified on the same Homey on 18 August 2026: a 20:25–20:30
window over three Hue spots, both boundaries firing within ~20 ms of the clock, the
on-boundary applying power, brightness and colour temperature in that order, and the
off-boundary switching all three off. The trigger card it builds on resolved to
`homey:manager:cron:time_exactly`, found by shape rather than hardcoded — the app's
diagnostics list every candidate considered, which is what makes an unfamiliar
firmware diagnosable. Day handling and midnight-crossing windows are covered by unit
tests rather than by a week of waiting for the calendar.
