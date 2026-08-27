# Lightkeeper

![Lightkeeper](artwork/readme/banner.png)

[![CI](https://github.com/thomassidor/lightkeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/thomassidor/lightkeeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Use any remote to control any lights, put any lights on a timer, and let them follow the colour
of the day — without writing a single Flow.**

A Homey Pro app. You have a remote and you have lights; making one drive the other on Homey means
building a Flow for every button, for every lamp, for every thing you want that button to do. It
works, and it is tedious. Lightkeeper writes those Flows for you and keeps them maintained. Built
end to end with AI, directed and verified on real hardware by a human — [the full story is
below](#built-with-ai).

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [What you can rely on](#what-you-can-rely-on)
- [Good to know](#good-to-know)
- [When something is wrong](#when-something-is-wrong)
- [Privacy](#privacy)
- [Changelog](#changelog)
- [Built with AI](#built-with-ai)
- [Contributing](#contributing)
- [Licence](#licence)

---

## What it does

Four kinds of device, three jobs. Add them the way you add any Homey device:
**Devices → Add → Lightkeeper**.

<table>
<tr>
<td width="160"><img src="drivers/controller/assets/images/large.png" width="140" alt="Light controller"></td>
<td>

### Light controller

Turns a remote, switch or dial you have **already paired** into a controller for lights you choose.
Pick the remote, pick the lights, say what each press, hold or turn should do — on, off, brighter,
dimmer, warmer, colder.

*Needs a Personal API Key.*

</td>
</tr>
<tr>
<td width="160"><img src="drivers/schedule/assets/images/large.png" width="140" alt="Light schedule"></td>
<td>

### Light schedule

Puts lights on a timer. Say when they come on, and whether they go off after a while or at a time
you choose, on the days you choose — optionally at a brightness and warmth you set. Up to twelve
windows per device, and a switch on the tile that pauses the lot.

*Needs a Personal API Key.*

</td>
</tr>
<tr>
<td width="160"><img src="drivers/circadian/assets/images/large.png" width="140" alt="Circadian light"></td>
<td>

### Circadian light

Follows the colour of the day, and asks only two questions: what your lights should look like at
their **warmest** and at their **coolest**. It supplies the shape between them — warm overnight,
cooling through the morning, cool through the middle, warming again from mid-afternoon.

*No API key. Never switches a light on or off.*

</td>
</tr>
<tr>
<td width="160"><img src="drivers/curve/assets/images/large.png" width="140" alt="Curve light"></td>
<td>

### Curve light

The same engine with the whole day open to you: every point, every time, and **a colour instead of
a warmth at any point** — candle, amber, peach, rose, lavender, ocean, forest, ember. A lamp that
cannot show a colour follows the warmth instead, so the day is the same shape on every lamp.

*No API key. Never switches a light on or off.* Pick this one when you want a specific evening;
pick a circadian light when you just want "warm at night, cool in the day".

</td>
</tr>
</table>

> The circadian and Curve lights currently share one placeholder image — the Curve light's own
> artwork is still to be drawn. [`artwork/provenance.md`](artwork/provenance.md) tracks it.

Every one of them has a **Test** button in pairing that drives the real lights immediately, so you
know it works before you save anything. For the first two, Lightkeeper writes the Flows underneath
and keeps them maintained — add a lamp to a room a device points at and it follows; delete the
device and its Flows go with it, and only its Flows. **You never open the Flow editor.**

---

## Requirements

- **Homey Pro 2023 or later.** Homey Pro 2019 and earlier cannot create API Keys.
- **Firmware 12.9.0 or newer.**
- **Homey Cloud is not supported.** The design depends on broad local Web API access.
- **A Personal API Key** — for controllers and schedules only. The two curve-driven device types
  need none. [Why?](FAQ.md#why-does-it-need-a-personal-api-key)

## Getting started

### 1. Install it

From the Homey App Store, or `npx homey app install` from a clone.

### 2. Give it an API key — if you need one

Only if you are adding a **light controller** or a **light schedule**. Skip this for a circadian or
Curve light; pairing those starts straight at the lights.

1. Open [my.homey.app](https://my.homey.app) and pick your Homey
2. Settings → API Keys → New API Key
3. Tick the **Flow** permissions, then create it
4. Copy the key — it is shown only once — and paste it into Lightkeeper when it asks

The key is stored on your Homey and never leaves it. It is never logged, never returned by the
app's own API, and never included in a diagnostics export. It is used for **flow writes only**.

If it later stops working, your controllers keep driving your lights and your schedules keep
firing. Only Flow maintenance pauses, and you are asked for a new key without losing a single
mapping.

### 3. Add your first device

**Devices → Add → Lightkeeper**, then pick a type. Each one is a short sequence of screens:

| Device | The screens |
|---|---|
| Light controller | API key → choose a remote (grouped by room, with a count of the events Homey exposes for each) → choose lights → map each control, with **Test** on every row |
| Light schedule | API key → choose lights → set the windows, with **Test on** and **Test off** |
| Circadian light | Choose lights → set the warmest and coolest ends, with **Try it now** |
| Curve light | Choose lights → build the curve point by point, with **Try it now** |

Homey lets you rename a device afterwards, so there is no name field to fill in.

---

## What you can rely on

These are promises, not implementation details — each one is covered by a named test in
[`test/unit/safety-promises.test.ts`](test/unit/safety-promises.test.ts).

- **A ramp stops after 10 seconds, always.** Not configurable. Release events are routinely dropped
  on Zigbee and unreliable on Matter/Thread, so a light ramping forever is a certainty rather than a
  risk — and it is the worst thing this app could do to you.
- **A Flow you have edited is never overwritten.** The device marks itself for repair and asks.
- **Deleting a device deletes only the Flows it demonstrably created.** Attribution is the device's
  own id, carried inside the Flow.
- **A Flow you filed somewhere yourself stays there.** Lightkeeper tidies its own Flows into the
  device's folder, but only ever out of the Lightkeeper folder — never out of one of yours.
- **Lightkeeper never overrides something you have just done.** Change a light by hand and the
  device driving it stands down for that light until you switch it off and on again.
- **Nothing leaves your Homey.** No telemetry, opt-in or otherwise.

## Good to know

The five limits most likely to matter. [FAQ.md](FAQ.md#limits) has the rest, stated just as plainly.

- **"Any remote" means any remote Homey exposes something usable for.** If the owning integration
  offers neither a capability change nor a bindable trigger card, no app can reach that device.
- **Times are clock times.** Sunrise and sunset are not offered yet, for schedules or for curves.
- **If the app is not running when a window should end, that off is missed** and the lights stay on
  until the next one. A schedule is never switched off retroactively.
- **A schedule and a circadian light pointed at the same lights will disagree.** Use one or the
  other on a given lamp.
- **A circadian light adjusts every few minutes**, only when the colour has moved enough to see, and
  only while the app is running.

## When something is wrong

Homey settings → Lightkeeper shows the last remote presses received, whether each was handled or
ignored **and why**, and every write actually attempted against a light. That distinction — a Flow
that never fired, versus one that fired and was refused, versus an intent that never reached the
queue — is what makes a silent failure diagnosable at all.

**[FAQ.md → When something is wrong](FAQ.md#when-something-is-wrong)** walks through each symptom: a
press that does nothing, a remote with no usable events, a key that will not validate, a schedule
that did not fire, and what Repair fixes.

## Privacy

Nothing leaves your Homey — no telemetry, no cloud, no analytics. The diagnostics export is
generated locally and shared only if you choose to attach it to a bug report, and it deliberately
contains no key material. [`docs/privacy.md`](docs/privacy.md) is the full notice: what the app
reads, what it stores, and for how long.

---

## Changelog

**0.5.0** — the current release:

- **A fourth kind of device: a Curve light** — the circadian engine with the whole day open, and a
  colour from a closed palette available at any point.
- **The circadian light is now the simple one**: two questions, and it supplies the shape of the day
  itself. An existing one keeps its warmest and coolest points.
- **Overlapping schedule windows no longer fight**, and catch-up after a restart is gated on an off
  Flow actually existing.
- **Every screen is light now, in every phone setting** — Homey draws the panel around them light
  regardless of what the phone says.

Earlier releases, one line each:

| | |
|---|---|
| **0.4.0** | Circadian lights: follow the colour of the day, and no API key needed for them |
| **0.3.1** | Generated Flows grouped into a folder per device |
| **0.3.0** | New artwork throughout, a new palette, and a README banner |
| **0.2.2** | Line-art icons, and photographs rather than rasterised marks in the store |
| **0.2.1** | Fixed colour temperature running backwards |
| **0.2.0** | Light schedules, as a second kind of device — and the name Lightkeeper |
| **0.1.1** | Repair opens again; a changelog and an enforced release process |
| **0.1.0** | First release: remotes driving lights, with the Flows written for you |

**[CHANGELOG.md](CHANGELOG.md) has every release in full.**

## Built with AI

This app was designed and written end to end with [Claude](https://claude.com/claude-code) —
architecture, implementation, tests and documentation. A human directed the work, made the product
decisions, and verified the result on real hardware.

That is stated plainly because you deserve to know what you are installing and what you are reading.
If it changes how carefully you want to review the code before trusting it with your home: fair, and
the code is right here.

It has been verified end to end on a Homey Pro 2023 across four remotes and three transports, with
771 unit tests covering the logic — [how well tested is this?](FAQ.md#how-well-tested-is-this) has
the detail, including what has *not* run on hardware yet.

## Contributing

**[CONTRIBUTING.md](CONTRIBUTING.md)** is the developer front door — setup, the house rules, and
what has to pass before a PR. [`CLAUDE.md`](CLAUDE.md) has the architecture and conventions, and
[`docs/homey-platform.md`](docs/homey-platform.md) is a thirteen-section reference on how Homey
actually behaves, established against real hardware and documented nowhere else.
[`docs/README.md`](docs/README.md) indexes everything else.

Bug reports are best accompanied by the diagnostics export from Homey settings → Lightkeeper →
**Copy for a bug report**, which deliberately contains no key material.

## Licence

[MIT](LICENSE) © Thomas René Sidor
