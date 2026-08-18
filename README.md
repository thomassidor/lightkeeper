# Light Link

[![CI](https://github.com/thomassidor/lightlink/actions/workflows/ci.yml/badge.svg)](https://github.com/thomassidor/lightlink/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Use any remote to control any lights — without writing a single Flow.**

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

## What Light Link does

Pick a remote. Pick the lights. Say which button does what. Save.

Light Link writes the Flows for you, keeps them in a folder of their own, and maintains them as
things change. If you add a lamp to a room the controller points at, it follows. If you delete the
controller, its Flows go with it — and only its Flows.

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

### 1. Give Light Link an API key

**Homey does not let an app create Flows on its own.** An app's own token is refused with
`403 Missing Scopes` on every flow write. A Personal API Key that you create succeeds. Since
generating Flows is the entire mechanism by which this app works, and no app permission grants it,
Light Link asks you for a key.

1. Open [my.homey.app](https://my.homey.app) and pick your Homey
2. Settings → API Keys → New API Key
3. Tick the **Flow** permissions, then create it
4. Copy the key — it is shown only once — and paste it into Light Link

The key is stored on your Homey and never leaves it. It is never logged, never returned by the
app's own API, and never included in the diagnostics export. It is used for **flow writes only**.

If the key later stops working, your controllers keep driving your lights. Only Flow maintenance
pauses, and you are asked for a new key without losing a single mapping.

### 2. Add a controller

Devices → Add → Light Link → Controller. Then:

- **Choose a remote** — grouped by room, with a count of the events Homey exposes for each
- **Choose lights** — individually, or a whole zone
- **Map the controls** — assign a lighting function to each button, hold or turn. Every row has a
  **Test** button that drives the real lights immediately, before you save anything

Homey lets you rename the device afterwards, so there is no name field to fill in.

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

Ordinary Flows, one per mapped event, each with your remote's trigger card and a single internal
Light Link action card, in a folder called **Light Link**. Created only for events you actually
mapped. Idempotent, so reconfiguring reuses Flows rather than duplicating them.

### Safety properties

- **A ramp stops after 10 seconds, always.** Not configurable. Release events are routinely
  dropped on Zigbee and unreliable on Matter/Thread, so a stuck ramp is a certainty, not a risk —
  and a light ramping forever is the worst thing this app could do to you.
- **A Flow you have edited by hand is never overwritten.** The controller marks itself for repair
  instead.
- **Deleting a controller deletes only the Flows it demonstrably created.**
- **The orphan cleanup refuses to run when no controller is loaded**, because every Flow would
  look orphaned in that state.
- **Nothing leaves your Homey.** No telemetry, opt-in or otherwise. The diagnostics export is
  generated locally and shared only if you choose to attach it to a report.

### Diagnostics

Homey settings → Light Link shows the last remote presses received, whether each was handled or
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

---

## When something is wrong

**A press does nothing.** This is the one worth knowing how to read, because three
different failures look identical from the sofa. Open Homey settings → Light Link and
look at **Recent remote presses**:

- **No row at all** — the generated Flow never fired. The remote's event did not reach
  Light Link, so the problem is upstream of this app.
- **A row marked ignored** — the event arrived and was deliberately not acted on. The
  row says why.
- **A row marked handled** — Light Link acted. Now look at **Writes to lights**: a
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
Light Link offers stepping rather than a hold ramp in the first place.

### Repair, and what it fixes

Open repair on the controller (Devices → the controller → Repair):

| Situation | What repair does |
|---|---|
| API key expired or revoked | Save a new key. Lights keep working throughout; Flow maintenance resumes once it validates. Nothing you configured is lost. |
| The remote was re-added under a new id | Select the matching remote. One tap keeps every mapping and target. |
| The remote now exposes different events | Remap the affected controls. |
| A generated Flow was edited by hand | Rebuilds it. Light Link never silently overwrites your edit — it asks. |

### Removing it

Deleting a controller removes only the Flows it can attribute to that controller. The
settings page can also find orphaned Light Link Flows, and refuses to clean up when no
controller is running — in that state every managed Flow looks orphaned and attribution
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

220 unit tests, type-clean, validated at `publish` level.

---

## Development

```bash
npm install
npm test                          # 220 unit tests, no hardware needed
npm run typecheck
npx homey app install             # persistent install — use this for anything interactive
npx homey app validate --level publish
```

**Use `homey app install` for interactive testing, not `homey app run`.** `run` creates a debug
session and **uninstalls the app when the CLI exits**, taking its app settings with it — including
the stored API key. Pairing against a session that has ended gives screens that render but do
nothing, because the handlers are gone.

**`--remote` is not optional on `run`.** Since CLI 3.x a bare `homey app run` runs the app in a
local Docker container; `--remote` runs it on the Homey, which is the only faithful context for
anything touching app-scoped permissions.

**Do not share an API key between the app and an external script.** A key embeds a session id, and
concurrent holders appear to invalidate one another.

**A release writes the changelog twice.** `.homeychangelog.json` is what Homey shows in the store;
[Changelog](#changelog) below is the same release for anyone reading the repo. Both go in the commit
that bumps the version, and `test/unit/release-metadata.test.ts` fails if either is missing it. Full
checklist in [CLAUDE.md](CLAUDE.md#releasing-a-version).

### Layout

```
app.ts                          app entry, bridge action listeners, validation on receipt
api.ts                          app Web API consumed by the settings page
lib/
  homey-api-service.ts          both API clients, subscription teardown
  credential-service.ts         the API key: storage, validation, failure classification
  device-catalog.ts             devices, zones, owning apps, capability metadata
  source-discovery-service.ts   trigger card discovery and event-surface fingerprints
  inputs/                       input contract, normalizer, magnitude collapse
  mapping/                      mapping engine, supersede gate, types
  outputs/                      intents, perceptual curve, planner, scheduler, ramp engine
  bridge/                       binding compiler, flow bridge manager, reconciler
  runtime/                      controller runtime, manager, health monitor
  profiles/                     profile schema, repository, migrations
drivers/controller/             virtual device, driver, four pairing views
test/                           unit tests and fixtures transcribed from real hardware
docs/                           review notes, privacy, localisation, artwork (not bundled)
```

**Read [`CLAUDE.md`](CLAUDE.md) before changing anything.** It carries the architectural rules and a
Homey platform reference — how flow card URIs are really shaped, how device trigger cards are
actually discovered, how tokens are encoded, why API keys expire — established against real
hardware and documented nowhere else.

### Testing philosophy

Fixtures in `test/fixtures/reference-devices.ts` are transcribed verbatim from four real remotes.
The raw capture data is kept separate from the expected normalised catalogue, so the tests prove
the normalizer rather than the fixture — a fixture that also encoded the expectation would pass
against a normalizer that did nothing.

Captures from a real home are never committed; see [`test/fixtures/README.md`](test/fixtures/README.md).

### Reference

- [`docs/privacy.md`](docs/privacy.md) — what the app reads, stores and never transmits
- [`docs/homey-review-notes.md`](docs/homey-review-notes.md) — why `homey:manager:api` and a
  Personal API Key are both unavoidable, plus what is still untested
- [`docs/localisation.md`](docs/localisation.md) — the app is English-only; how to add a language
- [`docs/artwork.md`](docs/artwork.md) — palette, icon rules, and how to re-export the store images

---

## Changelog

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
from Homey settings → Light Link → **Copy for a bug report**, which deliberately contains no key
material.

## Licence

[MIT](LICENSE) © Thomas René Sidor
