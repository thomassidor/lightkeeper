# Phase 0 spike — result

**Status: complete.** These findings are settled and the app is built on them. This document is the
record of how Homey actually behaves, as opposed to how it appears to — several of the findings
below cost hours to establish and are not documented anywhere else.

The `spike/` probe app that produced this evidence has since been removed from the repository; the
tool paths referenced below are historical. What it established is here.

Homey: Homey Pro 2023 (platform `local`, platformVersion 2), firmware 13.4.0
Homey CLI: 3.7.15 · homey-api: 3.19.2 · Node (dev machine): 22.12.0
Run date: 8 August 2026

---

## The blocking question

> May an app holding `homey:manager:api` create and delete Flows through the Web API?

**RESOLVED: an app's OWN token cannot write flows. A user's Personal API Key CAN — including from
inside the app process. The §6 managed flow bridge is viable, with one added setup step.**

| Question | Answer | Evidence |
|---|---|---|
| Can the app's own token (`getOwnerApiToken`) write flows? | **No** — 403 `Missing Scopes` | run 1 |
| Is flow-write scope grantable to a user API key at all? | **Yes** | run 3, off-Homey |
| Can that key write flows from *inside the app process*? | **Yes** | run 4, step 0b |

### Evidence — run 4, in-app with a Personal API Key, 2026-08-08T19:13Z

`HomeyAPI.createLocalAPI({ address: 'http://127.0.0.1:80', token })` from inside the running app:

| Call | Result |
|---|---|
| `getFlows` | OK — 30 |
| `createFlow` | **OK** |
| `deleteFlow` | **OK** |

Note the address: `homey.api.getLocalUrl()` returns `http://127.0.0.1:80` inside the app, so no LAN
address discovery is needed.

### Architectural consequence — TWO API CLIENTS

| Client | Auth | Used for |
|---|---|---|
| `createAppAPI({ homey })` | app's own token | device/zone reads, capability subscriptions, `setCapabilityValue` |
| `createLocalAPI({ address, token })` | user's Personal API Key | **flow writes only** — create, update, delete |

Keeping them separate bounds the blast radius: if the key is revoked or expires, controllers keep
running and driving lights; only flow reconciliation degrades, which surfaces as a health state
rather than an outage.

### Consequences for the product

1. **Setup gains a step not in the specification.** The user must mint a Personal API Key
   (my.homey.app → Settings → API Keys, with Flow permissions) and give it to the app once. This
   needs designing into §8 — it is the first thing a new user hits, and it is the least pleasant
   part of the whole flow. AC-06 still holds: no flow is ever hand-authored.
2. **A credential is now stored on the Homey.** §12 obligations apply: never log it, never transmit
   it, redact it from diagnostics and profile exports. It also must not appear in the §9.5 export.
3. **New failure mode: invalid or revoked key.** Needs its own controller health state distinct
   from "event surface changed", with a targeted repair action (re-enter key) rather than a
   full remap.
4. **App Store review.** `homey:manager:api` already triggers a heavier review; asking the user for
   an API key on top will need explaining in submission materials. Worth confirming with Athom that
   this pattern is acceptable before building on it.
5. **Homey Pro 2019 and earlier cannot mint API Keys** (Athom: *"only on the newer generation"*).
   The compatibility boundary in §2.1 must say so plainly.

### Evidence — run 3, off-Homey Node process with a Personal API Key, 2026-08-08

`spike/tools/check-flow-write.mjs`, 114-character key minted with Flow permissions:

| Call | Result |
|---|---|
| `flow.getFlowCardTriggers` | OK — 1734 |
| `flow.getFlowCardActions` | OK — 1128 |
| `flow.getFlows` | OK — 30 |
| `flow.createFlowFolder` | **OK** |
| `flow.createFlow` | **OK** |
| `flow.deleteFlow` | OK |
| `flow.deleteFlowFolder` | OK |

So the full create/read/delete lifecycle works with a user-scoped key. `Missing Scopes` is a
property of the app's own token, not of the account or the endpoint.

### CRITICAL — flow card URI format

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

A card's `uri` is a **full resource URI that embeds its own id**, prefixed by card type
(`homey:flowcardtrigger:` / `homey:flowcardaction:`). It is **not** `homey:app:<appId>`, which is
what the SDK docs' phrasing suggests and what the spike originally assumed.

**Rule for the binding compiler: never construct a card URI. Enumerate the card and echo its
`uri` and `id` back verbatim.** Getting this wrong produces `404 Not Found: FlowCardAction with
ID <x>`, which reads like a permission refusal and cost an hour here. Also note that an app's own
cards exist only while that app is running — a 404 may mean "not running", not "not permitted".

Useful zero-argument cards for test fixtures, confirmed present on firmware 13.4.0:
`homey:manager:flow:programmatic_trigger` (trigger) and `homey:manager:alarms:enable_next` (action).

### Evidence — run 1, debug session, 2026-08-08T18:55Z

Every flow **read** succeeded; every flow **write** was refused.

| Endpoint | Result |
|---|---|
| `flow.getFlows` | ok — 30 flows |
| `flow.getFlowCardTriggers` | ok — 1734 cards |
| `flow.getFlowFolders` | ok — 7 folders |
| `flowtoken.getFlowTokens` | ok — 732 tokens |
| `flow.createFlowFolder` | **403 `Missing Scopes`** |
| `flow.createFlow` | **403 `Missing Scopes`** (observed separately as step 4) |

Server-side stack, i.e. the Homey refusing rather than the client library:

```
Error: Missing Scopes
    at SessionLocal.checkScopes (file:///app/packages/homey-core/lib/Session.mjs:86:13)
    at file:///app/packages/homey-core/lib/ManagerApi.mjs:386:19
```

**Discount the `hasScope` block in the raw output.** `HomeyAPIV3.hasScope()` returns `true`
unconditionally when no session object is present, and none was exposed
(`"session": "no session object exposed"`). All nine `true` values are that default, not evidence.

### Corroborating evidence

- `homey:manager:api` is the **only** API permission that exists
  (`homey-lib/assets/app/permissions.json`). There is no finer-grained flow permission to request,
  so this is not a manifest omission.
- `HomeyAPI.createAppAPI` authenticates with `await homey.api.getOwnerApiToken()`. The refusal is
  therefore against the app's session, not against the account.
- Community reports describe the same refusal for `triggerFlow` from app context despite holding
  `homey:manager:api` — "apps don't have permission to trigger flows like this" — with the
  suggestion that the SDK documentation overstates what apps may reach.
- Athom (Emile) on Web API scopes: *"Clients using the Web API with OAuth2 cannot have these scopes
  for obvious security reasons"*, pointing users instead at **Settings → API Keys** on Homey Pro
  2023 and newer.

---

## Chosen approach

**§3.2 rung 1, API-key variant — confirmed working, not merely plausible.** The app holds a
user-supplied Personal API Key and performs flow writes through `createLocalAPI` from app context.
Rung 2 (guided manual mode) is not needed and should not be built.

The mapping model, engine, targets and UI are unaffected (§3.2 anticipated this), so Phase 1's core
stands as planned. What changes is the bridge's authentication and the first-run experience.

### Observed within the same session: API key sessions die

Roughly twenty minutes after the working run above, the **same 114-character key** — unchanged on
disk — began returning `401 Session Not Found` from both the off-Homey script and the app.

A Homey API Key embeds a **session ID**; the key string is only a reference. If that session is
deleted or invalidated, the key stops working even though nothing about the string changed. Note
the three distinct failures this produces, which are easy to confuse:

| Error | Meaning |
|---|---|
| `401 Missing Session ID in Token` | not a real key (placeholder, truncated paste) |
| `401 Session Not Found` | valid key string, but its session is gone — re-mint |
| `403 Missing Scopes` | valid session, insufficient permission |

**This moves key invalidation from a theoretical edge case to a near-certainty**, and it is the
single biggest risk the API-key architecture carries. Phase 1 must treat it as routine: detect 401
on any flow write, mark the controller with a dedicated health state, prompt for a new key, and
resume without touching the mappings. Controllers must keep driving lights throughout, since device
control uses the app API and is unaffected.

**Recurrence, 9 August.** A second key died the same way, within hours. It had been used
concurrently by two holders: the installed app (which revalidates at startup) and an off-Homey
diagnostic script. Both used `createLocalAPI` with the same key.

**Working hypothesis: one live session per API key.** A key embeds a session id; a second
`createLocalAPI` handshake appears to claim or replace that session, invalidating the first holder.
If true, the practical rules are:

- Never share a key between the app and any external tool. Diagnostics must use their own key.
- Two Homey apps holding the same key would fight; documentation must warn against reuse.
- This is testable directly: hold a session in one process, open a second with the same key, and see
  whether the first starts failing. Worth doing before relying on the key architecture in anger.

Alternative explanations not yet excluded: an idle timeout, a Homey restart, or the key being
regenerated. The answer decides whether re-auth is rare or routine, and therefore how prominent the
re-entry path must be in the UI.

Open questions this leaves for Phase 1:

- **Key rotation and revocation.** Now known to be a live problem, not a hypothetical. A dedicated
  health state plus a re-entry prompt — it must not silently stop reconciling, and it must not
  force a remap, since the bindings remain valid.
- **Is the key stable across app updates and Homey restarts?** It lives in app settings, so it
  should be. Verify during §11.4 lifecycle testing.
- **Does Athom consider this acceptable for App Store distribution?** Worth asking before Phase 3.
  It does not block local development or personal use.

---

## CRITICAL — how device trigger cards are actually discovered

`getFlowCardTriggers()` returns 1734 cards. Device-scoped cards **encode their device in the card
`id`**, not in a `uri`:

```
homey:device:<deviceId>:<cardName>
```

There is **no card whose `uri` equals `homey:device:<deviceId>`** — matching on `uri`, which is the
obvious reading of §5.1, finds exactly nothing and makes a Tap Dial look like it has no buttons.

**The discovery rule (§5.1.3), corrected:**

1. `device_scoped` — `card.id.startsWith('homey:device:' + deviceId + ':')`. This is the real route;
   every reference device resolves through it.
2. `device_arg` — an app-level card with a `device`-typed argument whose `filter` matches. Rare in
   practice.
3. An **unfiltered** device argument matches every device on the Homey and is therefore near
   worthless — it offered "LG refrigerator error changed" as an input for a Tap Dial. Keep it
   reachable (§8.1 says never hard-filter) but rank it last.
4. **"Same owner app" must NOT be a match route.** It offered Hue motion-area triggers as buttons on
   a Hue dial. At best a ranking hint.

Device-scoped cards also include system capability cards (`measure_battery_threshold_above`,
`alarm_motion_true`, `*_changed`, `*_duration`). These are state changes, not input events, and the
normalizer must separate them — a remote typically exposes 5 real input cards among ~10 capability
ones.

## CRITICAL — flow serialisation and token encoding

From an existing hand-built flow on this Homey (§3.1 criterion 3, answered):

```json
{
  "id": "homey:device:dddb9b44-…:action_upload_file_flow",
  "group": "then",
  "delay": null,
  "duration": null,
  "droptoken": "homey:device:b214989f-…|image-camera-snapshot",
  "args": {}
}
```

- An action's `uri` is always `homey:flowcardaction:` + its `id`; triggers likewise use
  `homey:flowcardtrigger:`. Some stored actions omit `uri` entirely, so it appears optional on write
  — but always echo back what enumeration returned rather than deriving it.
- Actions carry `group: "then"`, plus nullable `delay` and `duration`.
- **`droptoken` is a top-level property of the action, not an entry in `args`.**
- Token reference forms, confirmed by `homey-api`'s `Flow.isBroken` (*"local & global Token IDs, for
  example `[ 'foo', 'homey:x:y|abc' ]`"*):
  - **global token** → `"<ownerUri>|<tokenId>"`, e.g. `homey:device:<id>|image-camera-snapshot`
  - **local token from the flow's own trigger card** → the **bare token id**, e.g. `"steps"`
- Token identity is `token.id`, **not** `token.name` — the spike's first guess used `name` and would
  have silently produced broken flows.
- Autocomplete-typed args serialise as the whole selected object (`{id, name, image, …}`), not just
  an id. Dropdown args store the value id.

## Reference-device event surfaces (§3.1 criterion 2 — PASS)

All four resolved. Compare against §2.3's expectations — two diverge.

**IKEA STYRBAR** — `com.ikea.tradfri:remote_control_n2`, class `remote`

| Card | Meaning |
|---|---|
| `n2_on` / `n2_off` | up / down pressed |
| `n2_dim_up` / `n2_dim_down` | up / down **long** pressed |
| `n2_scene_up` / `n2_scene_down` | right / left pressed |

Fixed cards, no arguments, no tokens. Up and down carry **both** press and long-press — these are
the controls the §7.6 supersede gate exists for, and grouping `n2_on` with `n2_dim_up` under one
`controlId` is the normalizer's job. Left and right expose press only, so no hold may be offered
there (§5.5).

**Hue Dimmer v2** — `nl.philips.hue:dimmerswitch`

One card only: `dimmerswitch_button_pressed`, `button` dropdown = `[on | increase_brightness |
decrease_brightness | off]`. **No long-press card exists.** §2.3 expected "four controls with press
and long-press"; through this integration there is no hold at all. Exactly the §2.4 pairing-path
sensitivity the spec warns about — and confirmation that offering hold here would be inventing a
gesture (§5.5).

**Hue Tap Dial** — `nl.philips.hue:tapdial`

| Card | Args | Tokens |
|---|---|---|
| `tapdial_button_pressed` | `button` = `[button1…button4]` | — |
| `tapdial_dial_rotation_started` | `rotate_direction` = `[either \| counter_clock_wise \| clock_wise]` | — |
| `tapdial_dial_rotation_stopped` | `rotate_direction` (same) | **`steps:number`** "Steps (1000/turn)" |
| `tapdial_dial_rotation_dimmed` | — | `dim_level:number` "Resulting dim level" |

The reference implementation, as §2.3 said. No long-press — do not offer it. Magnitude arrives as
the `steps` token on rotation **stopped**, i.e. after the gesture, at 1000 steps per turn: stepping,
not ramping. `dim_level` is an **absolute** level, mapping to `brightness_absolute`, not a delta.

**IKEA BILRESA** — `com.ikea.tradfri:matter_bilresa_scroll_wheel`, class `button`

| Card | Args |
|---|---|
| `switch_initial_press_multi` | `button` = `[1…9]` |
| `switch_press_multi` | `button` = `[1…9]` |
| `switch_long_press_multi` | `button` = `[3 \| 6 \| 9]` |
| `switch_long_press2_multi` | `button` = `[3 \| 6 \| 9]` |
| `switch_multi_press_multi` | `button` = `[1…9]`, `count` = `[1…18]` |

This is §5.4's warning made concrete. `switch_multi_press_multi` is 9 × 18 = **162 combinations**;
expanded naively the picker is nonsense and the expansion ceiling of 12 is exceeded 13-fold. Note
`count` here reaches 18, far beyond plausible click counts — strong evidence it encodes **wheel
detents, not repeated clicks**, precisely as §5.4 predicts. Only buttons 3, 6 and 9 support long
press, suggesting 9 logical endpoints map onto 3 physical buttons plus wheel positions. Semantics
must be resolved at runtime (§2.3), never hardcoded.

No release or "stopped" card exists for BILRESA — so no hold-ramp may be offered; stepping only.

## Exit criteria (§3.1)

| # | Criterion | Result | Notes |
|---|---|---|---|
| 1 | In-app `HomeyAPI` instance, enumerate devices | **PASS** | 118 devices, 20 zones |
| 2 | Enumerate trigger cards, resolve against a source device | **PASS** | all four reference devices; `device_scoped` is the route |
| 3 | Create a flow calling a bridge action card, then delete it | **PASS** | only with a user API key; app token refused |
| 4 | Forward a numeric trigger token through the numeric bridge card | **PASS (encoding known)** | `droptoken` = bare token id for trigger-local tokens; end-to-end firing not yet observed |
| 5 | Control a light via `setCapabilityValue`, observe the echo | **PASS** | write acked ~275 ms; echo observed, and duplicated |
| 6 | Measure press-to-light latency per transport | **NOT RUN** | requires physical button presses |

---

## Flow serialisation, as observed

Paste the verbatim JSON of a **hand-built** flow from step 3. This is the reference for everything
the binding compiler writes.

```json

```

### Trigger object shape

```json

```

### Action object shape

```json

```

### Token encoding

The card manifest addresses a dropped token as `[[droptoken]]` in `titleFormatted`, and the value
arrives at the run listener as `args.droptoken` — this much is confirmed by the CLI validator.
What remains to be established here is how the *flow* references the token it drops in:

- Encoding that survived write + read-back without the flow reporting broken: `…`
- Encodings that failed: `…`
- Did the value actually arrive when the physical remote was pressed? `…`

---

## Trigger-card discovery per reference device

Which of the three match routes actually found the cards, per device. If `uri_is_this_device`
never fires, the discovery service can drop it; if `device_arg` dominates, filter parsing is
load-bearing and needs the unit tests §11.1 asks for.

| Device | Pairing path | Cards matched | Match route(s) | Tokens seen | Notes |
|---|---|---|---|---|---|
| IKEA STYRBAR E2001/E2002 | Zigbee local | | | | short-press-before-hold quirk observed? |
| Hue Dimmer v2 RWL022 | Hue Bridge | | | | release emitted for every control? |
| Hue Tap Dial RDM002 | Hue Bridge | | | | button as dropdown argument? |
| IKEA BILRESA | Matter/Thread | | | | count field = detents or clicks? |

The BILRESA row is the one to read carefully: §5.4 warns that a Matter `count` field usually means
wheel detents, not repeated clicks, and misreading it produces a nonsense picker and a jumping
dimmer.

---

## Light control (§3.1 criterion 5 — PASS)

`Ceiling 1 | Garage` (`nl.philips.hue:bulb`), state restored afterwards.

| Write | Ack |
|---|---|
| `onoff = true` | 275 ms |
| `dim = 0.42` | 271 ms |

Round-trip is consistent with §7.9's Hue Bridge budget (< 450 ms) for the output leg alone.

**Capability echoes arrive duplicated.** Setting `dim` once produced two `dim = 0.42` callbacks, and
the restore produced two `dim = 0.41`. §7.5's optimistic desired state must therefore dedupe echoes
by (capability, value, timestamp window) or it will fight itself — and the ramp engine must not
treat a duplicate echo as an external change that cancels a ramp.

**Capability options, as read (§7.1 — do not assume uniform):**

| Capability | Options |
|---|---|
| `onoff` | `{}` — no min/max/step at all |
| `dim` | `{ min: 0, max: 1, units: "%", decimals: 2 }` |
| `light_temperature` | `{ min: 0, max: 1, units: null, decimals: 2 }` |

`light_temperature` is **normalised 0–1**, not mireds or kelvin, so temperature deltas work on the
same normalised axis as brightness. `decimals: 2` implies a meaningful step of 0.01 — a delta
smaller than that is a no-op and should be accumulated rather than written.

### Transport coverage limitation

Every light on this Homey is behind the **Hue Bridge** (34 `nl.philips.hue:bulb`, plus 5 virtual
groups). There is no Zigbee-local or Matter light available, so the output leg cannot be compared
across transports here.

This does not block §7.9: the variable in that table is the **remote's** transport, not the light's.
Press-to-light for STYRBAR (Zigbee local), Hue Dimmer / Tap Dial (Hue Bridge) and BILRESA
(Matter/Thread) all drive the same Hue lights, so differences are attributable to the input leg —
which is the point. It does mean per-transport *output* behaviour stays untested until a
non-Hue light exists.

## Latency

**These are bridge-receipt → light-write-ack figures, not press-to-light.** Radio time and
flow-engine dispatch upstream of the bridge card are not observable from inside an app. Use them
to compare transports and as a regression baseline; do not read them as a verdict against §7.9.

| Transport | Device | Samples | Median | p90 | Max | §7.9 target (press-to-light) |
|---|---|---|---|---|---|---|
| Zigbee local | STYRBAR | | | | | < 200 ms |
| Hue Bridge | Dimmer / Tap Dial | | | | | < 450 ms |
| Matter/Thread | BILRESA | | | | | < 600 ms, unreliable |

Dropped events observed during fast input: `…`

---

## Decisions this run settles for Phase 1

- Numeric bridge card shape: one card or two (fixed-value arg vs droptoken)? `…`
- Controller argument: opaque text ID (with §12 validation on receipt) confirmed workable? `…`
- Range expansion: does creating ~12 flow variants in one go complete in acceptable time? `…`
- Managed folder: did `createFlowFolder` work from app context? `…`

## Anything that contradicts the specification

`…`
