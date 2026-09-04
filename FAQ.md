# FAQ

Everything that did not belong on the front page. [README.md](README.md) is the short version;
this is where the answers live.

- [Getting started](#getting-started)
- [Everyday use](#everyday-use)
- [When something is wrong](#when-something-is-wrong)
- [Limits](#limits)
- [Privacy, data and removal](#privacy-data-and-removal)
- [How well tested is this?](#how-well-tested-is-this)

---

## Getting started

### Why does it need a Personal API Key?

**Homey does not let an app create Flows on its own.** An app's own token is refused with
`403 Missing Scopes` on every flow write, and there is no finer-grained permission to ask for —
`homey:manager:api` is the only API permission that exists. A Personal API Key that *you* create
succeeds at the full create/read/delete lifecycle, including from inside the app process.

Since generating Flows is the entire mechanism by which controllers and schedules work, and no app
permission grants it, Lightkeeper has to ask you for a key. There is no way around it, and
[`docs/homey-platform.md` §1](docs/homey-platform.md#1-an-apps-own-token-cannot-write-flows) has the
full evidence including the server-side stack trace.

### Which devices need a key and which don't?

| Device | Key? | Why |
|---|---|---|
| Light controller | **Yes** | It works by generating Flows |
| Light schedule | **Yes** | Same — two Flows per window |
| Circadian light | No | Generates no Flows at all |
| Curve light | No | Same engine, same answer |
| Daylight light | No | Same answer, different job |

Those three watch your lights over the app's own connection and write to them directly, so pairing
them starts straight at the light picker. They also keep working when a key expires.

### What is the key used for, exactly?

**Flow writes only** — creating, updating and deleting Flows and their folders. Reading your devices
and zones, subscribing to capability changes and writing to your lights all go through the app's own
token instead. Those are two separate clients inside the app, deliberately kept apart, and the
separation is what bounds the damage when a key dies: only Flow maintenance stops.

The key is stored on your Homey, never leaves it, is never logged, never returned by the app's own
API, and never included in a diagnostics export.

### Will my remote work?

**"Any remote" means any remote for which Homey exposes something usable** — either a capability
change, or a Flow trigger card bindable to that device. If the owning integration exposes neither,
the input is unobservable through public Homey interfaces and no app can reach it.

The same hardware can expose a different event surface through different pairing paths: a Hue device
offers more through the Philips Hue app than through Matter. **Support is not a property of the model
on the box.** The pairing screen shows a count of the events Homey exposes for each device, so you
can see before you commit.

### Can I use Homey Cloud, or a Homey Pro 2019?

No to both. Homey Cloud does not offer the local Web API access the design depends on, and **Homey
Pro 2019 and earlier cannot mint API Keys at all**, which is what sets the hardware floor at Homey
Pro 2023.

### What is the difference between a circadian light and a Curve light?

The same engine, two ways of asking.

A **circadian light** asks two questions — what your lights should look like at their warmest and at
their coolest — and supplies the shape of the day itself: warmest at 06:00, coolest across the
middle of the day, warmest again from 21:00, flat through the night. That shape is deliberately not
a setting.

A **Curve light** hands you the whole curve: every point, every time, and a colour from a closed
palette instead of a warmth at any point.

Pick a Curve light when you want a specific evening; pick a circadian light when you just want "warm
at night, cool in the day". There is **no way to convert one into the other** — Homey has no
mechanism for changing a device's driver — but adding one is cheap, since neither needs an API key
or writes any Flows.

### What does a Daylight light do that a schedule cannot?

A schedule happens **at a time**. A Daylight light happens **all the time**.

Both can set a brightness from how light the room is — a schedule window can be set to follow the
daylight just as a Daylight light does. The difference is when they look: a window reads it once,
at the moment it comes on, and then leaves the lights where it put them. A Daylight light keeps
looking, and keeps adjusting, for as long as the lights are on.

So: a window that follows the daylight is right for "come on at whatever level the room needs at
seven". A Daylight light is right for "keep this room at a comfortable level all evening as the
light goes".

### Do I need a light sensor for a Daylight light?

No. Without one it uses **how high the sun is**, worked out from your Homey's own location — which
Homey asked you for during setup, so you almost certainly have one. That handles the shape of the
day perfectly well: dark before dawn, bright at noon, dark again after dusk.

What a sensor adds is everything the sun cannot know: your curtains, which way the room faces, and
whether today is overcast. If you have one — and most motion sensors do — it is used in preference,
and the pairing screen shows you what it currently reads so you can set the two lux numbers against
something real rather than guessing.

### Can a light sensor be in the same room as the lights it drives?

Yes, and it is worth knowing what happens when it is: **the sensor measures your lamps as well as
the daylight.** Brighten the lamps and the reading goes up, which asks for dimmer lamps, which lowers
the reading. That is a loop, and left alone a loop like that makes a room pulse.

Lightkeeper damps it. It ignores changes below a threshold you would not see anyway, and it moves in
small steps rather than jumping — so in practice the lights settle after a few adjustments and then
stay put. It does not remove the loop, and it cannot.

The placements that behave, in order:

1. **A sensor facing a window**, or on a sill. It sees far more daylight than lamplight, so your
   lamps barely move the reading.
2. **A sensor in another room** that gets similar light. Nothing you do to these lamps reaches it.
3. **No sensor at all.** The sun cannot be affected by your lamps, and for "dim as the morning comes
   up" it is genuinely enough.

If your lights do keep hunting, unpick the sensor: the sun alone is the reliable answer.

---

## Everyday use

### Where do the generated Flows go? Can I edit them?

Ordinary Flows, each with one internal Lightkeeper action card, filed in a folder of their own:
**Lightkeeper**, and inside it a folder per device named after the device itself. Rename the device
and the folder follows.

- **A controller** gets one Flow per mapped event, triggered by your remote's own trigger card, and
  only for events you actually mapped.
- **A schedule** gets two Flows per window — one at each end — triggered by Homey's own time trigger.

You can look at them, and you can move them. If you **edit** one, Lightkeeper notices and stops
maintaining it rather than overwriting your work: the device marks itself for repair and asks you
what you want.

### Can I move or rename the generated Flows?

Yes. A Flow you filed somewhere yourself stays there — Lightkeeper only ever moves a Flow *out of*
its own Lightkeeper folder, never out of one of yours. A renamed Flow is reused in place; the name is
deliberately not part of how a Flow is recognised.

### What happens if I add a lamp to a room a device points at?

It follows. Zone targets resolve at the moment of use, not at the moment you save, so a lamp added to
a zone is included from then on and a lamp that was offline is picked up again when it returns —
neither needs any reconfiguration.

### Can a schedule and a circadian light share the same lights?

They will disagree. A schedule's warmth is applied at its boundary and then overwritten by the
circadian light within a few minutes. **Use one or the other on a given lamp.**

The same goes for a **Daylight light and anything else that sets brightness** on the same lamp: a
Daylight light adjusts continuously, so it wins, and whatever the other device set is overwritten
within a minute. If you want a schedule's window and the daylight on one lamp, do not add a second
device — set that window to **follow the daylight** instead. That is what the option is for.

One pair that does NOT conflict: a Daylight light and a circadian or Curve light on the same lamp,
where the colour-following device is not also set to change brightness. They are then writing to
different axes — one to the brightness, one to the warmth — and neither undoes the other.

### Why does my light only change colour every few minutes?

Because writing more often would change nothing you can see. `light_temperature` is reported to two
decimals, so a change smaller than 0.01 is a no-op at the lamp; across the steepest part of the
default curve the colour moves about 0.003 a minute, which works out at a write roughly every third
minute. The device checks every 60 seconds and writes when the change has become visible.

### What does the pause switch do?

Stops the device acting, and keeps everything else. A paused schedule keeps its Flows, so resuming is
instant and nothing needs rebuilding — pausing means "do not act", not "throw the setup away". A
paused device stays available in Homey, because the switch that un-pauses it lives on its own tile.

### I changed a light by hand and Lightkeeper left it alone. Why?

That is deliberate. Change a light's colour by hand and the device driving it stands down for that
lamp — it will not take it back on the next tick. **Switch the light off and on again** to hand it
back, because that is the gesture people already have for "put this back how it ought to be". It is
never remembered across a restart.

---

## When something is wrong

Start at **Homey settings → Lightkeeper**. It shows the last remote presses received, whether each
was handled or ignored and why, and every write actually attempted against a light. That distinction
is what makes a silent failure diagnosable at all.

### A press does nothing

This is the one worth knowing how to read, because three different failures look identical from the
sofa. Look at **Recent remote presses**:

- **No row at all** — the generated Flow never fired. The remote's event did not reach Lightkeeper,
  so the problem is upstream of this app.
- **A row marked ignored** — the event arrived and was deliberately not acted on. The row says why.
- **A row marked handled** — Lightkeeper acted. Now look at **Writes to lights**: a write that was
  sent and refused is a target problem; no write at all means the intent never reached the queue.

That distinction is the whole reason those two lists exist.

### No usable events found for my remote

The owning integration exposes neither a capability change nor a bindable trigger card for this
pairing path. Try another official pairing path if the device has one — a Hue remote exposes more
through the Philips Hue app than through Matter. If there is no such path, the device cannot be
observed through Homey's public interfaces and no app can reach it.

### The key does not work

Create a complete new Personal API Key **with Flow permissions**. A key without them validates
ordinary reads but cannot maintain Flows, and the two failures are reported differently — the message
tells you which one you have.

Three failures look alike and mean different things: a key that was pasted incompletely, a valid key
whose session has been invalidated, and a valid session without the Flow permission. Lightkeeper
classifies them so it can send you to the right fix.

**Do not share one key between Lightkeeper and an external script or tool.** A key holds a single
live session, and two holders appear to invalidate one another — the symptom is a key that
"randomly" stops working.

### A Daylight light says it cannot tell how light it is

It has no light sensor reporting and no location to work the sun out from, so it is leaving your
lights alone rather than guessing. Either fix works:

- **Set your Homey's location** — Homey's own Settings → Location. Nothing else is needed; the app
  reads the latitude to work out how high the sun is, and it never leaves the Homey.
- **Or pick a light sensor** in Repair. Most motion sensors have one, and a sensor needs no location
  at all.

Homey settings → Lightkeeper shows which of the two it is: the Daylight lights section leads with
the sun's current height, or says the Homey has not told it where it is.

### A light is unavailable

Bring it and its integration back online. Zone targets resolve at the moment of use, so a light that
comes back is included again without any reconfiguration.

### Brightness keeps changing on its own

Two different answers, depending on which device you have.

**From a remote:** every ramp stops unconditionally after 10 seconds, because release events do get
lost. If your remote exposes no release event, Lightkeeper offers stepping rather than a hold ramp
in the first place.

**From a Daylight light:** it is meant to, as the light in the room changes — but it should settle
and then stay put, not keep moving. If it keeps moving minute after minute, its light sensor is
almost certainly in the same room as the lights it is driving, and is measuring them.
[What to do about that](#can-a-light-sensor-be-in-the-same-room-as-the-lights-it-drives). Homey
settings → Lightkeeper lists every write the app has made, which is the quickest way to tell
"settled" from "hunting".

### A schedule did not fire

Look at the schedule's card in Homey settings → Lightkeeper. It lists every schedule on the device,
whether one is on right now, and **the clock those times are read against** — a Homey in an unexpected
timezone is the most common answer by far.

If the card says paused, the device's switch is off. Otherwise check **Recent remote presses**: a
schedule's boundary arrives there like any other event, with the reason when it was ignored,
including "not one of this schedule's days".

### What does Repair fix?

Open repair on the device (Devices → the device → Repair):

| Situation | What repair does |
|---|---|
| API key expired or revoked | Save a new key. Lights keep working throughout; Flow maintenance resumes once it validates. Nothing you configured is lost. |
| The remote was re-added under a new id | Select the matching remote. One tap keeps every mapping and target. |
| The remote now exposes different events | Remap the affected controls. |
| A generated Flow was edited by hand | Rebuilds it. Lightkeeper never silently overwrites your edit — it asks. |
| A schedule needs different lights or different times | Reopens both of its screens with everything as you left it. |

---

## Limits

Stated plainly, because a limit you find out about later is worse than one you were told.

- **"Any remote" means any remote Homey exposes something usable for**, and the same hardware can
  expose different things through different pairing paths. See
  [Will my remote work?](#will-my-remote-work) above.
- **Controls whose range would expand past 12 Flow variants are declined** rather than filling your
  Flow list with dozens of near-identical rows.
- **Twelve schedules per device**, which is twenty-four generated Flows. Add a second schedule device
  if you need more; the cap exists so your Flow list stays readable.
- **Schedules follow your Homey's own clock**, daylight-saving changes included, because Homey's time
  trigger is what fires them. The settings page shows which timezone that is, next to each device's
  schedules.
- **If the app is not running at the moment a window should end, that off is missed** and the lights
  stay on until the next one. Coming back up *inside* a window does switch them on, because that is
  the case where doing nothing means a dark evening — but a window that already ended is left alone.
  Switching a household's lights off at app start, on the guess that we might once have switched them
  on, is the worse surprise.
- **Times are clock times.** Sunrise and sunset are not offered yet — for schedules or for curves.
- **A circadian or Curve light never switches a light on or off.** It only changes the colour of
  lights that are already on and — if you ask it to — sets the colour of lights that are off so they
  are right the moment they come on.
- **Setting the colour of a light that is off is opt-in**, because on some integrations a colour write
  switches the lamp on. It is provable from the pairing screen against your own lamps before you
  commit, and it disables itself for the whole device the first time a lamp comes on from one.
- **Brightness is never pre-staged**, only colour. A brightness write turns an off lamp on; that is
  measured, not suspected.
- **A circadian light and a schedule pointed at the same lights will disagree.** Use one or the other
  on a given lamp.
- **A circadian light adjusts about once every few minutes**, only when the colour has moved enough to
  be visible, and only while the app is running. It does not catch up on time it was switched off for
  — it simply picks up wherever the day now is.
- **A Curve light's colour is chosen from a closed palette** — candle, amber, peach, rose, lavender,
  ocean, forest, ember — not a colour wheel. Hue and saturation are a two-dimensional choice with one
  good answer per intent, and a name survives being read back a year later where a pair of coordinates
  does not.
- **One colour point colours the segments either side of it.** A colour is never blended into a colour
  temperature, because that would mean inventing a shade nobody chose. "Amber at 21:00" with
  temperature points at 19:00 and 23:00 is amber from 19:00 to 23:00, not an amber instant.
- **Two colours far apart fade through pale, not through the colours in between them.** Amber to
  rose passes through the shades between the two, because there are some. Ember to ocean has none —
  they are opposite sides of the colour wheel — so instead of inventing a purple nobody asked for,
  the lights lose their colour towards the middle of that segment and pick the new one up on the way
  out. It is the same rule as the bullet above, applied to the one case where both ends *are* a
  colour: pale is what any two colours have in common.
- **A Daylight light never switches a light on or off either.** It only dims lights that are already
  on, and brightness is never written to a light that is off — a brightness write turns an off lamp
  on, which is measured rather than suspected.
- **A light sensor in the same room as the lights it drives measures those lights too.** Lightkeeper
  damps the resulting hunting — a threshold below what you would see, and small steps rather than
  jumps — but cannot remove it. [Which placements behave](#can-a-light-sensor-be-in-the-same-room-as-the-lights-it-drives).
- **A Daylight light needs either a light sensor or your Homey's location.** With neither it says so
  and leaves your lights alone rather than guessing.
- **A schedule window that follows the daylight reads it once, when the window starts**, and does not
  follow it afterwards. A schedule happens at a time; add a Daylight light for the other thing.
- **One daylight setup per device.** All the windows, points or ends on one device that follow the
  daylight share the same sensors and the same two brightness ends. If you need two different
  responses, add a second device — the same answer the twelve-window cap gives.
- **Several light sensors are averaged**, not weighted, and not "the brightest wins". The sensors you
  pick are the weighting: do not pick one whose opinion of the room you do not want.
- **The dimmest brightness you can set is 10%.** Below that there is nothing left to send a lamp:
  brightness is stored the way it is perceived rather than the way a lamp is addressed, and under
  about 9% the conversion rounds to zero, which most lamps read as off.

---

## Privacy, data and removal

### Does it phone home?

No. No telemetry, opt-in or otherwise; no cloud; no analytics. Nothing leaves your Homey.
[`docs/privacy.md`](docs/privacy.md) is the full notice.

### What is in a diagnostics export?

Homey settings → Lightkeeper → **Copy for a bug report**. It is generated locally on your Homey and
goes nowhere unless you paste it somewhere.

It deliberately contains **no API key material** — errors are classified before they are logged,
because an error object can echo the token back, and anything key-shaped is scrubbed on its way into
a log line. There is a test that asserts this against the serialised output.

It *does* include your device and zone names, so skim it before posting.

### How do I remove it?

Deleting a controller or a schedule removes only the Flows it can attribute to that device.
Attribution is the device's own id, carried inside the Flow — so nothing that is not demonstrably
ours is touched.

The settings page can also find orphaned Lightkeeper Flows, and **refuses to clean up when no
Lightkeeper device is running**, because in that state every managed Flow looks orphaned and
attribution would be unsafe.

Uninstalling the app removes its settings, including the stored key.

---

## How well tested is this?

Verified end to end on a **Homey Pro 2023 (firmware 13.4.0)** with four remotes across three
transports:

| Remote | Transport | Notable for |
|---|---|---|
| IKEA STYRBAR E2001/E2002 | Zigbee, local | press and long-press on the same control |
| Philips Hue Dimmer v2 | Hue Bridge | four buttons, no hold available at all |
| Philips Hue Tap Dial | Hue Bridge | rotation with a magnitude token |
| IKEA BILRESA | Matter/Thread | scroll wheel, and cards that vanish on restart |

**Schedules** were verified on the same Homey: a window switched three Hue spots on at its start
minute, applied the brightness and warmth it was given, and switched them off again at its end
minute, both boundaries firing within ~20 ms of the clock. Their day handling and midnight-crossing
arithmetic is covered by unit tests rather than by a week of waiting. The trigger card they are built
on is resolved at runtime by enumerating what your Homey actually offers, rather than hardcoding an
id, so it adapts if a firmware update moves it.

**Circadian and Curve lights have not yet run a full day on hardware.** Their curve — including the
segment that wraps midnight — and every rule about when a write is worth making are covered by unit
tests, and the pairing screen's **Try it now** proves the whole write path against your own lamps
before you save.

Over 1200 unit tests, type-clean, validated at `publish` level. The test fixtures are transcribed verbatim
from the four real remotes above, and the expected results are written by hand beside them, so the
tests prove the code rather than the fixture.
