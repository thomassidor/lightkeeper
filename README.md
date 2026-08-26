# Lightkeeper

![Lightkeeper](docs/artwork/readme/banner.png)

[![CI](https://github.com/thomassidor/lightkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/thomassidor/lightkeeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Use any remote to control any lights, put any lights on a timer, and let them follow the colour
of the day — without writing a single Flow.**

A Homey Pro app.

---

## The problem

I recently bought three scroll wheel remotes from IKEA. Three remotes, three lights each, three things I
wanted each remote to do — 27 Flows to build by hand. Half an hour of clicking, maybe an hour. I
couldn't be bothered, so I spent a couple of days building this instead. Or rather, I had AI build
it.

The general version: you have a remote — an IKEA STYRBAR, a Hue Dimmer, a rotary dial — and you have
lights. Making one control the other on Homey means opening the Flow editor and building a Flow for
every button, for every light, for every thing you want that button to do. Turn on. Turn off.
Brighter. Dimmer. Then again for the next lamp.

It works, and it is tedious.

Schedules are the same story told with a clock. Lights on when it gets dark, off at bedtime,
weekdays only — that is two Flows per window, one of them at a time you worked out by hand, and
every change means finding both again.

## What Lightkeeper does

Three kinds of device.

**A controller.** Pick a remote. Pick the lights. Say which button does what. Save.

**A schedule.** Pick the lights. Say when they come on, and whether they go off after a while or at
a set time. Add as many schedules as you need. Save.

**A circadian light.** Pick the lights. Set how warm they should be through the day — warm at dawn,
cool in the middle, warm again at night. They are set the moment they come on, and keep following
the curve while they are on. It never switches anything on or off.

For the first two, Lightkeeper writes the Flows for you, keeps them in a folder of their own — one
per device, inside a Lightkeeper folder — and maintains them as things change. If you add a lamp to
a room a device points at, it follows. If you delete the device, its Flows go with it — and only its
Flows.

A circadian light writes no Flows at all, so it needs no API key: it watches your lights and adjusts
them directly.

You never open the Flow editor.

## Built with AI

This app was designed and written end to end with [Claude](https://claude.com/claude-code) —
architecture, implementation, tests and documentation. A human directed the work, made the product
decisions, and verified the result on real hardware.

That is stated plainly here because you deserve to know what you are installing and what you are
reading. If it changes how carefully you want to review the code before trusting it with your
home: fair, and the code is right here.

---

## Requirements

- **Homey Pro 2023 or later.** Homey Pro 2019 and earlier cannot create API Keys, which this app
  needs — see below.
- **Firmware 12.9.0 or newer.**
- **Homey Cloud is not supported.** The design depends on broad local Web API access.

## Setup

### 1. Give Lightkeeper an API key

**Homey does not let an app create Flows on its own.** An app's own token is refused with
`403 Missing Scopes` on every flow write. A Personal API Key that you create succeeds. Since
generating Flows is the entire mechanism by which this app works, and no app permission grants it,
Lightkeeper asks you for a key.

1. Open [my.homey.app](https://my.homey.app) and pick your Homey
2. Settings → API Keys → New API Key
3. Tick the **Flow** permissions, then create it
4. Copy the key — it is shown only once — and paste it into Lightkeeper

The key is stored on your Homey and never leaves it. It is never logged, never returned by the
app's own API, and never included in the diagnostics export. It is used for **flow writes only**.

If the key later stops working, your controllers keep driving your lights and your existing
schedules keep firing. Only Flow maintenance pauses, and you are asked for a new key without losing
a single mapping.

### 2. Add a controller

Devices → Add → Lightkeeper → **Light controller**. Then:

- **Choose a remote** — grouped by room, with a count of the events Homey exposes for each
- **Choose lights** — individually, or a whole zone
- **Map the controls** — assign a lighting function to each button, hold or turn. Every row has a
  **Test** button that drives the real lights immediately, before you save anything

Homey lets you rename the device afterwards, so there is no name field to fill in.

### 3. Add a schedule

Devices → Add → Lightkeeper → **Light schedule**. Then:

- **Choose lights** — the same picker, individually or a whole zone
- **Set the times** — for each schedule: an on-time, the days it runs, and either a duration or an
  off-time. Optionally a brightness and a warmth, offered only if the lights you chose support them
- **Test on** and **Test off** drive the real lights immediately, before you save anything

Up to twelve schedules on one device. The device's own switch pauses the whole thing without losing
anything — useful when you are away, or when you would rather it left the room alone tonight.

### 4. Add a circadian light

Devices → Add → Lightkeeper → **Circadian light**. **No API key is needed for this one** — it
creates no Flows, so pairing starts straight at the lights.

- **Choose lights** — the same picker
- **Follow the day** — a curve of up to eight points, each a time and a warmth, drawn as you edit
  it. It starts on a sensible default: warm at 06:00, cool through the day, warmest at 23:00
- **Try it now** sets your lights to today's current warmth immediately, before you save anything
- Optionally **follow brightness too**, and optionally **set the colour before the lights come on**
  so there is no visible correction when they are switched on — with a **Test it** button, because
  some lights switch themselves on when their colour is set

Its own switch pauses it, like a schedule's. Change a light's colour by hand and it will leave that
light alone until you switch it off and on again.

---

## How it works

### Two API clients, deliberately separated

| Client | Authenticated as | Responsible for |
|---|---|---|
| App API | the app's own token | reading devices and zones, subscribing to capability changes, writing to your lights |
| Local API | your Personal API Key | creating, updating and deleting Flows |

The separation bounds the damage when a key expires: only Flow maintenance stops. Your remotes
keep working.

### What it writes

Ordinary Flows, each with one internal Lightkeeper action card, filed in a folder of their own:
**Lightkeeper**, and inside it a folder per device named after the device itself. Rename the
device and the folder follows.

- **A controller** gets one Flow per mapped event, triggered by your remote's own trigger card, and
  only for events you actually mapped.
- **A schedule** gets two Flows per window — one at each end — triggered by Homey's own time
  trigger. The days it runs are deliberately not in the Flow: it fires every day and the app checks
  the day against your Homey's clock, so changing weekdays to weekends rewrites nothing.

Idempotent either way, so reconfiguring reuses Flows rather than duplicating them. Move a schedule
from 22:00 to 23:00 and the old pair is replaced, rather than left behind firing at the old time.

### Safety properties

- **A ramp stops after 10 seconds, always.** Not configurable. Release events are routinely
  dropped on Zigbee and unreliable on Matter/Thread, so a stuck ramp is a certainty, not a risk —
  and a light ramping forever is the worst thing this app could do to you.
- **A Flow you have edited by hand is never overwritten.** The device marks itself for repair
  instead — including a schedule whose time you changed in the Flow editor rather than in the app.
- **Deleting a device deletes only the Flows it demonstrably created.**
- **The orphan cleanup refuses to run when nothing is loaded**, because every Flow would
  look orphaned in that state.
- **A schedule never switches your lights off retroactively.** If the app was down when a window
  should have ended, the lights are left alone — see the limits below. Coming back up *inside* a
  window does switch them on, because that is the case where doing nothing means a dark evening.
- **Pausing a schedule keeps its Flows.** Pausing means "do not act", not "throw the setup away", so
  resuming is instant.
- **A Flow you filed somewhere yourself stays there.** Lightkeeper tidies its own Flows into the
  device's folder, but only ever out of the Lightkeeper folder — never out of one of yours.
- **Nothing leaves your Homey.** No telemetry, opt-in or otherwise. The diagnostics export is
  generated locally and shared only if you choose to attach it to a report.

### Diagnostics

Homey settings → Lightkeeper shows the last remote presses received, whether each was handled or
ignored and why, and every write actually attempted against a light. That distinction — a Flow
that never fired, versus one that fired and was refused, versus an intent that never reached the
queue — is what makes a silent failure diagnosable at all.

---

## Limits, stated plainly

**"Any remote" means any remote for which Homey exposes something usable** — either a capability
change, or a flow trigger card bindable to that device. If the owning integration exposes neither,
the input is unobservable through public Homey interfaces and no app can reach it.

The same hardware can expose a different event surface through different pairing paths: a Hue
device offers more through the Philips Hue app than through Matter. So support is not a property
of the model on the box.

Controls whose range would expand past 12 Flow variants are declined rather than filling your Flow
list.

**Schedules follow your Homey's own clock**, daylight-saving changes included, because Homey's time
trigger is what fires them. The settings page shows which timezone that is, next to each device's
schedules.

**Twelve schedules per device**, which is twenty-four generated Flows. Add a second schedule device
if you need more; the cap exists so your Flow list stays readable.

**If the app is not running at the moment a window should end, that off is missed** and the lights
stay on until the next one.

**Times are clock times.** Sunrise and sunset are not offered yet — for schedules or for circadian
lights.

**A circadian light never switches a light on or off.** It only changes the colour of lights that
are already on, and — if you ask it to — sets the colour of lights that are off so they are right
the moment they come on.

**A circadian light and a schedule pointed at the same lights will disagree.** A schedule's warmth
is applied at its boundary and then overwritten by the circadian light within a few minutes. Use one
or the other on a given light.

**A circadian light adjusts about once every few minutes**, only when the colour has moved enough to
be visible, and only while the app is running. It does not catch up on time it was switched off
for — it simply picks up wherever the day now is.

---

## When something is wrong

**A press does nothing.** This is the one worth knowing how to read, because three
different failures look identical from the sofa. Open Homey settings → Lightkeeper and
look at **Recent remote presses**:

- **No row at all** — the generated Flow never fired. The remote's event did not reach
  Lightkeeper, so the problem is upstream of this app.
- **A row marked ignored** — the event arrived and was deliberately not acted on. The
  row says why.
- **A row marked handled** — Lightkeeper acted. Now look at **Writes to lights**: a
  write that was sent and refused is a target problem; no write at all means the
  intent never reached the queue.

That distinction is the whole reason those two lists exist.

**No usable events found for my remote.** The owning integration exposes neither a
capability change nor a bindable trigger card for this pairing path. Try another
official pairing path if the device has one — a Hue remote exposes more through the
Philips Hue app than through Matter. If there is no such path, the device cannot be
observed through Homey's public interfaces and no app can reach it.

**The key does not work.** Create a complete new Personal API Key *with Flow
permissions*. A key without them validates ordinary reads but cannot maintain Flows,
and the two failures are reported differently — the message tells you which one you
have.

**A light is unavailable.** Bring it and its integration back online. Zone targets
resolve at the moment of use, so a light that comes back is included again without
any reconfiguration.

**Brightness keeps changing on its own.** Every ramp stops unconditionally after 10
seconds, because release events do get lost. If your remote exposes no release event,
Lightkeeper offers stepping rather than a hold ramp in the first place.

**A schedule did not fire.** Look at the schedule's card in Homey settings → Lightkeeper.
It lists every schedule on it, whether one is on right now, and the clock those times are read
against — a Homey in an unexpected timezone is the most common answer by far. If the card
says paused, the device's switch is off. Otherwise check **Recent remote presses**: a
schedule's boundary arrives there like any other event, with the reason when it was
ignored, including "not one of this schedule's days".

### Repair, and what it fixes

Open repair on the controller (Devices → the controller → Repair):

| Situation | What repair does |
|---|---|
| API key expired or revoked | Save a new key. Lights keep working throughout; Flow maintenance resumes once it validates. Nothing you configured is lost. |
| The remote was re-added under a new id | Select the matching remote. One tap keeps every mapping and target. |
| The remote now exposes different events | Remap the affected controls. |
| A generated Flow was edited by hand | Rebuilds it. Lightkeeper never silently overwrites your edit — it asks. |
| A schedule needs different lights or different times | Reopens both of its screens with everything as you left it. |

### Removing it

Deleting a controller or a schedule removes only the Flows it can attribute to that device. The
settings page can also find orphaned Lightkeeper Flows, and refuses to clean up when no Lightkeeper
device is running — in that state every managed Flow looks orphaned and attribution
would be unsafe. Uninstalling the app removes its settings, including the stored key.

---

## Tested on

Verified end to end on a Homey Pro 2023 (firmware 13.4.0) with four remotes across three
transports:

| Remote | Transport | Notable for |
|---|---|---|
| IKEA STYRBAR E2001/E2002 | Zigbee, local | press and long-press on the same control |
| Philips Hue Dimmer v2 | Hue Bridge | four buttons, no hold available at all |
| Philips Hue Tap Dial | Hue Bridge | rotation with a magnitude token |
| IKEA BILRESA | Matter/Thread | scroll wheel, and cards that vanish on restart |

Circadian lights have not yet run a full day on hardware. Their curve — including the segment that
wraps midnight — and every rule about when a write is worth making are covered by unit tests, and the
pairing screen's **Try it now** proves the whole write path against your own lamps before you save.

Schedules were verified on the same Homey: a window switched three Hue spots on at its start minute,
applied the brightness and warmth it was given, and switched them off again at its end minute, both
boundaries firing within ~20 ms of the clock. Their day handling and midnight-crossing arithmetic is
covered by unit tests rather than by a week of waiting. The trigger card they are built on is
resolved at runtime by enumerating what your Homey actually offers, rather than hardcoding an id, so
it adapts if a firmware update moves it.

629 unit tests, type-clean, validated at `publish` level.

---

## Development

```bash
npm install
npm test                          # 629 unit tests, no hardware needed
npm run typecheck                 # the app
npm run typecheck:test            # the suite and scripts/
npm run sync:views                # after editing any pair view — nothing runs it for you
npm run validate                  # homey app validate --level publish
npx homey app install             # persistent install — use this for anything interactive
```

Three things that cost an afternoon each if you learn them the hard way, all explained in
[CLAUDE.md](CLAUDE.md#working-on-this-codebase): use `homey app install` rather than `homey app run`,
because `run` uninstalls the app when the CLI exits and takes the stored API key with it; never share
one API key between the app and an external script; and edit a pair view in
`drivers/controller/pair/` and then run `npm run sync:views`, because every `repair/` folder holds
byte copies that Homey needs as real files.

**A release writes the changelog twice.** `.homeychangelog.json` is what Homey shows in the store;
[Changelog](#changelog) below is the same release for anyone reading the repo. Both go in the commit
that bumps the version, and `test/unit/release-metadata.test.ts` fails if either is missing it. Full
checklist in [CLAUDE.md](CLAUDE.md#releasing-a-version).

### Layout

```
app.ts  api.ts        app entry, and the Web API the settings page calls
lib/                  everything with no Homey device attached: discovery, inputs,
                      mapping, outputs, the flow bridge, every runtime, schedules,
                      the circadian curve
drivers/              the three virtual device types and their pairing views
settings/  locales/   the app settings page, and every user-facing string
test/                 unit tests and fixtures transcribed from real hardware
docs/                 review notes, privacy, localisation, artwork (not bundled)
```

**Read [`CLAUDE.md`](CLAUDE.md) before changing anything.** It has the full file-by-file tree, the
architectural rules, and a Homey platform reference — how flow card URIs are really shaped, how
device trigger cards are actually discovered, how tokens are encoded, why API keys expire — all
established against real hardware and documented nowhere else.

### Testing philosophy

Fixtures in `test/fixtures/reference-devices.ts` are transcribed verbatim from four real remotes, and
the expected results are written by hand beside them so the tests prove the normalizer rather than
the fixture. Captures from a real home are never committed —
[`test/fixtures/README.md`](test/fixtures/README.md) has both arguments in full.

### Reference

- [`docs/privacy.md`](docs/privacy.md) — what the app reads, stores and never transmits
- [`docs/homey-review-notes.md`](docs/homey-review-notes.md) — why `homey:manager:api` and a
  Personal API Key are both unavoidable, plus what is still untested
- [`docs/localisation.md`](docs/localisation.md) — the app is English-only; how to add a language
- [`docs/asset-spec.md`](docs/asset-spec.md) — the artwork brief: every graphic the app ships, what it is for, and the prompts the photographs came from
- [`docs/artwork/provenance.md`](docs/artwork/provenance.md) — where the artwork came from, the palette's source, and the rights register

---

## Changelog

### 0.4.0

Added:

- **A third kind of device: a circadian light.** Pick your lights, set how warm they should be
  through the day, and they follow it — set the moment they come on, and adjusted while they stay
  on. It never switches a light on or off.
- **It needs no API key.** A circadian light creates no Flows at all, so pairing starts at the
  lights. It also means it keeps working when a key expires.
- The curve is drawn on screen as you edit it, up to eight points, and **Try it now** applies it to
  your real lights before you save anything.
- Optionally follows brightness as well as warmth, and optionally **sets the colour before the
  lights come on** so there is no visible correction — with a test button, because some lights
  switch themselves on when their colour is set. If that happens in normal use, the option turns
  itself off.
- Change a light's colour by hand and the circadian light leaves it alone until you switch that
  light off and on again.

### 0.3.1

Changed:

- **Generated Flows are grouped per device.** The single flat `Lightkeeper` folder now holds one
  folder per Lightkeeper device, named after the device, so it is obvious at a glance which Flows a
  controller or a schedule produced. Renaming the device renames its folder; deleting the device
  takes the folder with it once it is empty.
- **Existing Flows move themselves.** The next time a device reconciles, its Flows are moved out of
  the flat folder into their own — but only from the Lightkeeper folder. A Flow you had dragged into
  a folder of your own stays where you put it, which is why the move is safe to do unasked.
- Folder work still never blocks a Flow write: a Homey that refuses a folder call gets its Flows
  anyway, unfiled.
- **A simpler name for the other device type.** "Remote-to-light controller" is now
  **Light controller**. The old name described the wiring rather than naming the device, and
  was the longest label in the Add-device list. The driver id did not move, so paired devices,
  their mappings and their generated Flows are untouched.
- **The shared Flow cards stopped calling everything a controller.** All three internal bridge
  cards are used by schedules too, and the orphan sweep's live set is the union of both
  registries — so "no controller is running right now" was wrong the moment a schedule existed.
  Those titles, hints and the settings copy say "Lightkeeper device" now. The cards' argument
  name is untouched: it is the wire format every generated Flow already carries.

### 0.3.0

Changed:

- **New artwork throughout, and a new palette to go with it.** The app's mark is the logo — an open
  circle with a sparkle — and the two device icons are a remote and a stopwatch drawn in the same
  hand. The brand colour is now the logo's own violet `#180E32`, with its lavender `#CCB0F3` as the
  accent, and every screen the app draws follows: the settings page and all seven pairing views take
  the violet in light mode and the lavender in dark. Both hexes are read out of the logo bitmap by
  `docs/artwork/export-assets.py --palette`, and a test fails if the manifest ever disagrees with it.
- **The store image and both device pictures are new photographs.** An evening room with two lamps
  lit for the app, a remote for the controller, and — at last — a real device for the schedule: a
  plug-in timer with a glowing dial, instead of a lamp standing in for hardware it does not have.
- **The icons are generated now, not hand-drawn twice.** `export-assets.py` builds all three from the
  SVG masters in `docs/artwork/masters/`: it centres each drawing on Homey's 960 canvas, normalises
  the paint so the mask reads, and stamps the file with the master it came from. The device pictures
  are cropped by finding the object against its white ground, so replacing a master reframes the crop
  instead of silently mis-centring it. No hand-measured crop boxes remain.
- **The README has a banner** — the hero photograph with the logo on a rounded violet tile, built by
  the same script.

Fixed:

- **A pairing screen could hang forever.** `emit()` is the only path from a pair view to its driver,
  and if Homey never called back the promise never settled: the screen sat there with no message and
  no way forward but cancelling. The mapping view already had a 20-second timeout; the other four
  views did not, and nothing compared them. It is in all of them now, and
  `test/unit/pair-view-styles.test.ts` compares the shared script helpers as well as the shared CSS.
- **"No usable events found" now says what was turned down.** A trigger card that matches a device
  only through an unfiltered `device` argument accepts every device on the Homey — it once offered
  "LG refrigerator error changed" as an input for a Tap Dial — so it must never reach the picker. But
  discarding those matches silently left the one screen that reports nothing with nothing to report.
  They are recorded as declined, with the reason, and reach the diagnostics export.

Changed, under the hood:

- **About 200 lines that nothing reached are gone**, including two whole modules and a per-row tuning
  struct no screen ever set. The health monitor stopped keeping its own copy of the target check that
  `lib/runtime/target-health.ts` was extracted to own — and whose docblock already claimed the move
  had happened. The input key no longer travels inside a field documented as the event's own value.
- **CI can now fail on things it used to repair.** `homey app validate` regenerates `app.json`, so a
  stale committed manifest was being fixed in the runner and passing; the suite and `scripts/` were
  never type-checked at all, which was ~5,200 lines. Both are checked now, and turning the second one
  on found four real errors.

### 0.2.2

Changed:

- **All three icons are line art now.** A lighthouse for the app — the old mark drew a remote
  beaming at a bulb, which was the previous name made literal — plus the remote and the clock
  redrawn to match. This is not a taste change: `homey-lib` renders icons **white** on the brand
  colour in several surfaces (its own words: *"Icons are rendered white, so choose a darker color
  that has enough contrast"*), where a filled two-colour mark collapses into one silhouette. Athom's
  guideline 1.5 forbids filled illustrations outright, and every one of the 226 stock class icons
  Homey ships is stroke-only at `stroke-width: 40`. Ours now are too.
- **The store image drops the hand and the remote.** Same photograph, new window on it: two lamps
  lit and a blue-hour window, so it reads as lights that came on by themselves rather than as a
  remote being pressed. The old crop predated schedules and described half the app.
- **The schedule device shows a lamp instead of its own icon.** Rasterising the icon onto white was
  the app's most likely review finding — guideline 1.4 rejects *"images with big two-dimensional
  unicolored shapes on a monochrome or transparent background"* and 1.4.3 asks for *"a recognizable
  picture of the device it supports"*. A schedule has no hardware, so the device is the lamp.
- **`test/unit/assets.test.ts`** now checks every shipped image for presence, real PNG bytes and
  exact dimensions, and every icon for the line-art invariants — the class of mistake that is
  otherwise invisible until submission, and the artwork docs gained the distinction between what the
  validator enforces and what a reviewer applies, with citations.

Worth knowing if you install this over the CLI rather than from the store: **the app will show no
icon at all.** Homey renders an icon as a CSS mask fetched from `icons-cdn.athom.com` by the file's
MD5, and that CDN only holds icons from published builds — so a development install leaves an empty
brand-colour circle where the icon belongs. Nothing is wrong; it appears once the app is published.
The mechanism is written up in [CLAUDE.md](CLAUDE.md) §10.

### 0.2.1

Fixed:

- **Colour temperature ran backwards.** `light_temperature` is normalised 0–1 and **higher is
  warmer** — that is `homey-lib`'s own capability hint, and both the controller's `warmer`/`colder`
  mapping and the schedule screen's warmth labels assumed the opposite. A schedule set to "Warmest"
  wrote 0 and lit a room cold white on the first live run; a remote's "warmer" button made lights
  colder. Both directions are now fixed, the axis is documented in
  [CLAUDE.md](CLAUDE.md) §6 with the evidence, and a test pins the two code paths that produce
  temperature intents against each other, since them disagreeing is the shape this bug took.
  A schedule saved before this update keeps the number it was given, so its warmth may now read
  differently on screen — open it and check it says what you meant.

### 0.2.0

Added:

- **Light schedules, as a second kind of device.** Pick lights, then set one or more windows: an
  on-time, the days it runs, and either a duration or an off-time — plus an optional brightness and
  warmth. Two generated Flows per window, triggered by Homey's own time trigger, reconciled through
  the same machinery the remote controllers use. The day filter deliberately lives in the app rather
  than in the Flow, so changing which days a schedule runs on rewrites nothing.
- **A pause switch on each schedule device.** Pausing stops it acting and keeps its Flows, so
  resuming is instant. Resuming inside a window that has already started switches the lights on
  rather than waiting for tomorrow — the same catch-up that runs after an app restart.
- **A new name.** "Light Link" described pointing one thing at another, which is now half of what
  the app does. Nothing is carried over from the old name because nothing had shipped under it.

Changed:

- **Hand-edited Flows are detected in more cases.** The check now compares the trigger's arguments as
  well as its card and our own action, so a schedule whose time you changed in the Flow editor is
  respected instead of being silently ignored — the device asks to be repaired.
- **The orphan cleanup counts both kinds of device as live.** Without that, the first cleanup after
  this release would have found every schedule's Flows unattributable and deleted them.

### 0.1.1

Fixed:

- **Repair now opens.** It failed with an internal file error before any screen appeared, so a
  controller that needed repair had no way to be fixed. Homey serves repair views from their own
  folder, and `homey app validate` does not check that they exist.
- **A reassigned button says so where you are looking.** Giving a button a job another button
  already had now shows a note next to both controls. The notice used to sit at the bottom of the
  screen, below every light — where nobody saw it, while the control that lost its job quietly went
  back to "Not assigned".
- **App settings show the API key status in colour.** Green when a working key is saved, amber when
  none is saved yet, red when a saved key has stopped working. Previously every message on that page
  rendered the same flat grey, success and failure alike.

Added:

- **A changelog, and a release process that is enforced rather than remembered.** This section and
  `.homeychangelog.json` now record each release, and a test fails if the version, either changelog,
  or the test count this README quotes fall out of step.

### 0.1.0

First release. Paired remotes, switches, buttons and rotary dials driving on/off, brightness and
colour temperature across individual lights or zones, with the Flows underneath created and
maintained automatically. Local connection, Homey Pro 2023 and later.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports are best accompanied by the diagnostics export
from Homey settings → Lightkeeper → **Copy for a bug report**, which deliberately contains no key
material.

## Licence

[MIT](LICENSE) © Thomas René Sidor
