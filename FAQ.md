# FAQ

Everything that did not belong on the front page. [README.md](README.md) is the short version;
this is where the answers live.

> [!WARNING]
> **Early access.** Lightkeeper is in early development, and an update can change or break a setup
> you have already made — see [Is this finished?](#is-this-finished) below.

- [Getting started](#getting-started)
- [Everyday use](#everyday-use)
- [When something is wrong](#when-something-is-wrong)
- [Limits](#limits)
- [Privacy, data and removal](#privacy-data-and-removal)
- [How well tested is this?](#how-well-tested-is-this)

---

## Getting started

### Is this finished?

**No — it is in early development, and you should expect updates to break things.** Lightkeeper is a
0.x app. What is here works and is covered by tests, and the four remotes, the schedules and the
write path have all been verified on a real Homey Pro ([how well tested is this?](#how-well-tested-is-this)),
but the app is still being shaped and nothing about its stored settings is frozen yet.

In practice that means an update can:

- **change what a device stores**, so a device you already added may need Homey's **Repair** run on
  it, or in the worst case deleting and adding again;
- **rename, move or drop a setting**, so a choice you made on a setup screen may not survive;
- **change what a setup screen asks**, so the path you remember is not the path you get.

Migrations are written wherever a stored setting can be carried forward, and they have carried every
release so far — but they are written per change, not guaranteed in advance. Every change that
affects an existing device is stated in [CHANGELOG.md](CHANGELOG.md) and in what Homey shows you
when it updates the app, so read that before updating rather than after.

There are no major version bumps before 1.0, so a breaking change arrives as an ordinary-looking
minor or patch version. The version number is not the warning; the changelog entry is.

### Why does it need a Personal API Key?

**Homey does not let an app create Flows on its own.** An app's own token is refused with
`403 Missing Scopes` on every flow write, and there is no finer-grained permission to ask for —
`homey:manager:api` is the only API permission that exists. A Personal API Key that *you* create
succeeds at the full create/read/delete lifecycle, including from inside the app process.

Since generating Flows is the entire mechanism by which Light Remotes and schedules work, and no app
permission grants it, Lightkeeper has to ask you for a key. There is no way around it, and
[`docs/homey-platform.md` §1](docs/homey-platform.md#1-an-apps-own-token-cannot-write-flows) has the
full evidence including the server-side stack trace.

### Which devices need a key and which don't?

| Device | Key? | Why |
|---|---|---|
| Light Remote | **Yes** | It works by generating Flows |
| Light schedule | **Yes** | Same — two Flows per window |
| Circadian light | No | Generates no Flows at all |
| Colour Curve Light | No | Same engine, same answer |
| Room-sensing Light | No | Same answer, different job |

Those three watch your lights over the app's own connection and write to them directly, so setting
one up never asks for a key at all. They also keep working when a key expires.

For the two that do need one, Lightkeeper asks near the start — after the screen explaining what the
device does, before the first question it will save. That is deliberate: a key asked for at the end
is a key that can cost you everything you just filled in.

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

### What is the difference between a circadian light and a Colour Curve Light?

The same engine, two ways of asking.

A **circadian light** asks about three parts of the day — morning, midday and evening — and supplies
the shape itself: each part held steady, fading from one into the next, and round again across
midnight. Morning ends a little after sunrise and evening starts a little before sunset, both worked
out from your Homey's own location, so the day moves with the real one through the year. You choose
those two offsets; the shape between them is deliberately not a setting.

A **Colour Curve Light** hands you the whole curve: every point, every time, and a colour from a
closed palette instead of a warmth at any point.

Pick a Colour Curve Light when you want a specific evening; pick a circadian light when you just
want "warm at night, cool in the day". There is **no way to convert one into the other** — Homey has
no mechanism for changing a device's driver — but adding one is cheap, since neither needs an API
key or writes any Flows.

### What does a Room-sensing Light do that a schedule cannot?

A schedule happens **at a time**. A Room-sensing Light happens **all the time**.

A schedule block comes on at seven at whatever brightness you set, and leaves the lights there. A
Room-sensing Light keeps looking at how light the room is, and keeps adjusting, for as long as the
lights are on. If you want "keep this room at a comfortable level all evening as the light goes",
that is the Room-sensing Light; a schedule cannot do it, and setting one up to try produces a room
that is right at seven and wrong at nine.

### Do I need a light sensor for a Room-sensing Light?

No. Without one it uses **how high the sun is**, worked out from your Homey's own location — which
Homey asked you for during setup, so you almost certainly have one. That handles the shape of the
day perfectly well: dark before dawn, bright at noon, dark again after dusk.

What a sensor adds is everything the sun cannot know: your curtains, which way the room faces, and
whether today is overcast. If you have one — and most motion sensors do — pick it, and the setup
screen draws **that sensor's own last week** as a grid of light and dark, with the two lux numbers
filled in from what it actually recorded. That matters more than it sounds: a sensor in a hallway
may never pass 30 lx while one on a kitchen windowsill passes 1200, and a single pair of default
numbers cannot be right for both.

The same screen tells you two things it would otherwise take a month to notice — a sensor that
barely changes all week, and a sensor that stopped reporting.

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

If you set the bright end higher than the dark end, the response runs in the other direction:
more measured light asks for brighter lamps. A sensor that sees those lamps can then make them
keep increasing their own brightness until they reach whatever you set the bright end to. The setup
screen flags the combination, and **the device itself will say so on its tile once it has actually
watched the lights doing it** — the message names the same two remedies: use a sensor away from the
controlled lamps, or lower the bright end. The rate limit slows this feedback; it does not establish
how much of the reading is daylight.

This is worth taking seriously rather than reading past. In a recorded week on a real Homey, a
kitchen sensor read 1 lux with its lamp off and 680 lux with it on, and the lamp climbed to the
bright end within four to nine minutes of every switch-on, ninety-five times over.

---

## Everyday use

### Where do the generated Flows go? Can I edit them?

Ordinary Flows, each with one internal Lightkeeper action card, filed in a folder of their own:
**Lightkeeper**, and inside it a folder per device named after the device itself. Rename the device
and the folder follows.

- **A Light Remote** gets one Flow per mapped event, triggered by your remote's own trigger card,
  and only for events you actually mapped.
- **A schedule** gets two Flows per window — one at each end — triggered by Homey's own time trigger.

You can look at them, and you can move them. If you **edit** one, Lightkeeper notices and stops
maintaining it rather than overwriting your work: the device marks itself for repair and asks you
what you want.

### Can I use Lightkeeper's devices in my own Flows?

Yes, in three ways, and you never have to use any of them.

**As tags.** Every circadian light, Colour Curve Light, light schedule and Room-sensing Light shows
what it wants your lights to be right now on its own tile — a brightness, a colour temperature, the
name of the colour, how light it is outside. All of those are in the Flow editor's tag picker, so
*dim the hall to «Hall daylight: Brightness now»* works. They are in Insights too.

**A card that does the lot at once.** *Set lights the Lightkeeper way* takes a room or a light, a
device to take the colour from, a device to take the brightness from, and whether to switch the
lights on. Two different devices is the point: a Room-sensing Light can set the level while a
Circadian Light sets the white, and it all happens in one go rather than as three visible steps.

**A condition.** *It is dark enough* asks a Room-sensing Light, using the thresholds you already set
up on it rather than a lux number you would have to keep in step.

A remote button can do the same composing without a Flow at all — see
[*What does "On – with Lightkeeper" on a remote button do?*](#what-does-on--with-lightkeeper-on-a-remote-button-do).

### Will the brightness tag give me the same light my Lightkeeper device gives?

Yes — that is why it is the number it is. The brightness tag is what Lightkeeper actually sends a
lamp, so dropping it into Homey's own *Dim to* card puts the lamp exactly where Lightkeeper would
put it.

It will not match the percentage on the setup screen, and it is not meant to. Lightkeeper stores
brightness the way it is *perceived* and sends it the way a lamp is *addressed*, and those are
different numbers: a lamp set to 55% on the slider is sent 26%. The setup screens speak the first
language and your Flows speak the second.

### What does "On – with Lightkeeper" on a remote button do?

It turns your lights on the way the rest of your house already knows they should look. You choose
which of your other Lightkeeper devices the button takes the colour and warmth from, and which one
it takes the brightness from — a circadian light for the white and a Room-sensing Light for the
level is the usual pair — and it reads both **at the moment you press**, not when you set it up. A
button configured in February is still right in June.

The two pickers show what each setup is producing right now, a swatch or a level, because a house
with three curves in it is told apart by what each one is doing rather than by what you called it.

*Press again to turn off* is a switch on the same screen, on to begin with. With it on, one button is
a whole light switch: if any of its lights is on, the press turns them all off; otherwise they come
on with the values. It is the same rule the *On and off* job follows.

It is not the same as pointing the lights at that device. The button reads the setup once, on the
press — it does not keep following it afterwards. Following a colour through the evening is what a
circadian light or a Colour Curve Light is for, and there is nothing to stop a button and a device
driving the same lamps.

If the setup a button follows is deleted, the button still turns the lights on. It simply cannot say
what colour, so they come on as they were.

The job only appears once you own at least one circadian light, Colour Curve Light, light schedule or
Room-sensing Light. Before that there is nothing for it to follow.

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

The same goes for a **Room-sensing Light and anything else that sets brightness** on the same lamp:
a Room-sensing Light adjusts continuously, so it wins, and whatever the other device set is
overwritten within a minute. A schedule block that switches the lamp ON is fine — the Room-sensing
Light takes the brightness from there — but a block that also sets a brightness is a block whose
brightness lasts about a minute.

One pair that does NOT conflict: a Room-sensing Light and a circadian or Colour Curve Light on the
same lamp, where the colour-following device is not also set to change brightness. They are then
writing to different axes — one to the brightness, one to the warmth — and neither undoes the other.

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

It also lapses on its own after **four hours**, which is the shorter answer to a different question:
some lights quietly go back to their own settings a minute or two after being changed, and
Lightkeeper cannot always tell that apart from you reaching for a dimmer. Left to itself that made one
light mute its whole device for days at a time. If four hours is too soon for you, switching the light
off and on again is still the instant way to say either thing.

One case it *can* tell apart, since 0.6.5: a light that accepts an instruction, acknowledges it and
then sits exactly where it already was has not been changed by anybody — it ignored us. That is
recorded as an instruction the light did not act on, and the device carries on driving it rather than
standing down. Only an *unchanged* value is read this way, so a real change of yours is still honoured
straight away, however small.

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

### A Room-sensing Light says it cannot tell how light it is

It has no light sensor reporting and no location to work the sun out from, so it is leaving your
lights alone rather than guessing. Either fix works:

- **Set your Homey's location** — Homey's own Settings → Location. Nothing else is needed; the app
  reads the latitude to work out how high the sun is, and it never leaves the Homey.
- **Or pick a light sensor** in Repair. Most motion sensors have one, and a sensor needs no location
  at all.

Homey settings → Lightkeeper shows which of the two it is: the Room-sensing Lights section leads
with the sun's current height, or says the Homey has not told it where it is.

### A light is unavailable

Bring it and its integration back online. Zone targets resolve at the moment of use, so a light that
comes back is included again without any reconfiguration.

### Brightness keeps changing on its own

Two different answers, depending on which device you have.

**From a remote:** every ramp stops unconditionally after 10 seconds, because release events do get
lost. If your remote exposes no release event, Lightkeeper offers stepping rather than a hold ramp
in the first place.

**From a Room-sensing Light:** it is meant to, as the light in the room changes — but it should
settle and then stay put, not keep moving. If it keeps moving minute after minute, its light sensor
is almost certainly in the same room as the lights it is driving, and is measuring them. [What to do
about that](#can-a-light-sensor-be-in-the-same-room-as-the-lights-it-drives). Homey settings →
Lightkeeper lists every write the app has made, which is the quickest way to tell "settled" from
"hunting".

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

- **It is early access, and an update can break a setup you already made.** See
  [Is this finished?](#is-this-finished) — there is no compatibility promise before 1.0.
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
- **A circadian or Colour Curve Light never switches a light on or off.** It only changes the colour
  of lights that are already on and — if you ask it to — sets the colour of lights that are off so
  they are right the moment they come on.
- **Setting the colour of a light that is off is on for new devices, and there is currently no
  switch for it.** Without it a light comes on as it was and changes a second or two later, which is
  what it did for every release up to 0.6.0. Devices added before 0.6.5 keep whatever they were set
  up with; devices added since do it. The switch and the button that tried it on your own lamps
  appeared in 0.6.5 and are hidden again while where they belong is settled — the behaviour is
  unchanged either way, and it still disables itself for the whole device the first time a lamp comes
  on from one, because on some integrations a colour write switches the lamp on.
- **Brightness is never pre-staged**, only colour. A brightness write turns an off lamp on; that is
  measured, not suspected.
- **A circadian light and a schedule pointed at the same lights will disagree.** Use one or the other
  on a given lamp.
- **A circadian light adjusts about once every few minutes**, only when the colour has moved enough to
  be visible, and only while the app is running. It does not catch up on time it was switched off for
  — it simply picks up wherever the day now is.
- **A Colour Curve Light's colour is chosen from a closed palette** — candle, amber, peach, rose,
  lavender, ocean, forest, ember — not a colour wheel. Hue and saturation are a two-dimensional
  choice with one good answer per intent, and a name survives being read back a year later where a
  pair of coordinates does not.
- **One colour point colours the segments either side of it.** A colour is never blended into a colour
  temperature, because that would mean inventing a shade nobody chose. "Amber at 21:00" with
  temperature points at 19:00 and 23:00 is amber from 19:00 to 23:00, not an amber instant.
- **Two colours far apart fade through pale, not through the colours in between them.** Amber to
  rose passes through the shades between the two, because there are some. Ember to ocean has none —
  they are opposite sides of the colour wheel — so instead of inventing a purple nobody asked for,
  the lights lose their colour towards the middle of that segment and pick the new one up on the way
  out. It is the same rule as the bullet above, applied to the one case where both ends *are* a
  colour: pale is what any two colours have in common.
- **A Room-sensing Light never switches a light on or off either.** It only dims lights that are
  already on, and brightness is never written to a light that is off — a brightness write turns an
  off lamp on, which is measured rather than suspected.
- **A light sensor in the same room as the lights it drives measures those lights too.** Lightkeeper
  damps the resulting hunting — a threshold below what you would see, and small steps rather than
  jumps — but cannot remove it. [Which placements behave](#can-a-light-sensor-be-in-the-same-room-as-the-lights-it-drives).
- **A Room-sensing Light needs either a light sensor or your Homey's location.** With neither it
  says so and leaves your lights alone rather than guessing.
- **A schedule block sets a brightness, it does not follow one.** Following the light in the room is
  what a Room-sensing Light is for, and a schedule and a Room-sensing Light on the same lamp is a
  supported pair as long as the block does not also set a brightness.
- **A Room-sensing Light reads one light sensor.** Not several averaged: two sensors in different
  parts of a room average to a number neither of them reported, and the week you are shown while
  choosing would then belong to nothing. If you want two rooms handled differently, that is two
  devices.
- **Two schedule blocks may overlap, and the later one wins** while they do. The setup screen
  outlines the overlap and says so rather than refusing to let you draw it.
- **The brightness tag is what a lamp is sent, not what the slider says.** They are different
  numbers on purpose — see [the question above](#will-the-brightness-tag-give-me-the-same-light-my-lightkeeper-device-gives).
- **A paused device still says what it would do.** Pausing stops it touching your lights; it does not
  stop it answering. A Flow borrowing a paused device's colour still gets today's colour.
- **A schedule's brightness and colour tags are empty between windows**, and so is a circadian
  light's brightness unless you asked it to set one. Empty means "this device is not asking for
  anything right now", and a card given nothing writes nothing.
- **The Lightkeeper card only switches lights on if you ask it to.** Choosing *only lights already
  on* leaves a lamp that is off completely alone — there is no way to set a lamp's brightness without
  switching it on, so the honest choice is not to write to it.
- **A card whose source device has been deleted does nothing at all**, and says so in the app's
  diagnostics. It will not write half the settings.
- **"It is dark enough" is never true when the device cannot tell how light it is** — no sensor
  reporting and no location for the sun. It leaves your lights alone rather than guessing.
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

For circadian, Colour Curve and Room-sensing Lights, the export retains the latest 60 control passes
and 120 power, override and ignored-report events per runtime. Each pass lists every target's
decision and, when it submitted commands, their eventual outcomes. Daylight passes include the
sensor readings used at that time. An override includes when it was detected, which capability
changed, its reported value and the expected value; “external” can mean another automation as well
as a person. Power changes that resume control are recorded too.

The export labels perceptual brightness separately from device dim values. `writes` counts
planned capability commands; an API success is not a physical measurement of the lamp. Current
snapshots have `sampledAt`, while historical passes retain their own timestamps. Histories are
bounded, newest first, and lost on app restart; retention metadata shows how many entries were
dropped. The top-level `recentEvents` contains bridge Flow intake only.

### How do I remove it?

Deleting a Light Remote or a schedule removes only the Flows it can attribute to that device.
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

**Circadian and Colour Curve Lights have not yet run a full day on hardware.** Their curve —
including the segment that wraps midnight — and every rule about when a write is worth making are
covered by unit tests, and the pairing screen's **Try it now** proves the whole write path against
your own lamps before you save.

Over 1700 unit tests, type-clean, validated at `publish` level. The test fixtures are transcribed verbatim
from the four real remotes above, and the expected results are written by hand beside them, so the
tests prove the code rather than the fixture.
