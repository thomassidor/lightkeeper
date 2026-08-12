# Notes for Homey app review

This app asks for Homey's broadest API permission *and* asks the user to paste a
Personal API Key. Both are unusual, both are load-bearing, and both are the first
things a reviewer will question. The answers are here so they do not have to be
reconstructed each submission.

`homey app validate` says as much itself: *"using the homey:manager:api permission
will require a more thorough review"*.

---

## Why `homey:manager:api`

Light Link has to enumerate source devices, target lights, zones and the Flow
trigger cards that *other apps* own; subscribe to target capability changes; set
capability values on target lights; and read back the Flows it generated. Homey's
broad Web API permission is the only permission that exposes cross-app resources
at all.

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
driving lights and only Flow maintenance pauses.

**Why `local` only.** `homey:manager:api` is incompatible with Homey Cloud, and
the design depends on local cross-app Web API access.

**Why Homey Pro 2023 or newer.** Earlier models cannot create Personal API Keys
at all, so the app cannot work on them. That is the real compatibility floor —
the manifest's `>=12.9.0` is a firmware floor on top of it.

---

## Test script

1. Install on a Homey Pro 2023 or later running firmware 12.9.0 or newer.
2. Open Devices, add Light Link, and follow the API-key instructions.
3. Select an already-paired source and confirm the discovered events.
4. Select individual lights; map on/off and brightness; use **Test** on each row;
   save.
5. Press and turn the physical remote. Confirm the lights actually change, and
   that Settings → Light Link shows the presses and the writes.
6. Repair the controller, switch targets to a zone, save. Add or move a lamp in
   that zone and confirm it is picked up without reconfiguring.
7. Change a light outside Light Link, then use a relative brightness gesture —
   it should continue from the light's real state, not from a stale one.
8. **Revoke the API key.** Existing mappings must keep controlling lights, while
   the app asks for a new key. Paste a new one: every mapping should survive and
   the controllers should return to ready without a restart.
9. **Hand-edit a generated Flow.** Light Link must ask for repair rather than
   overwrite it.
10. **Delete the controller.** Only the Flows attributable to that controller may
    be removed.
11. Restart the app, then the Homey, and repeat a mapped action.

Steps 8, 9 and 10 are the ones worth the time — they are the app's genuinely
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
- **Per-transport output latency beyond the Hue Bridge is untested**, because
  every light on the test Homey sits behind that bridge. A `setCapabilityValue`
  to a Hue Bridge light acks in roughly 275 ms; nothing is claimed about Zigbee
  or Matter lights driven directly.

Verified end to end on a Homey Pro 2023 (firmware 13.4.0) against IKEA STYRBAR
(Zigbee, local), Philips Hue Dimmer v2 and Hue Tap Dial (Hue Bridge), and IKEA
BILRESA (Matter/Thread).
