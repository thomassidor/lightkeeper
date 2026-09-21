# Changelog

Every release, in full. [`README.md`](README.md#changelog) carries the short version — the current
release in a few bullets and one line for each older one; this is where the detail lives.

Newest first. **Lightkeeper is in early development**, and pre-1.0 there are no major bumps for
breaking changes: a change that would break something says so in its own entry instead. Read the
entry before updating — a device may need Homey's **Repair** run on it, or in the worst case
deleting and adding again. [`FAQ.md` → Is this finished?](FAQ.md#is-this-finished) has the longer
answer.

## 0.6.5

### The setup screens, redrawn against the design

Every pairing screen in all five device types has been put beside the design canvas and brought into
line with it — [`docs/design/`](docs/design/README.md) carries the canvas and the eight places the
app deliberately still differs. Most of it is colour and spacing that nobody would name but everybody
would feel: one muted grey where there were three, a chevron that clears the 3:1 a UI mark owes, one
recessed grey instead of two, a 12px corner on every inset panel. Six things are more than that.

**A schedule block is given a colour now, not a warmth.** It offered a Candlelight-to-Daylight
slider; it offers the same closed set of colours a Colour Curve Light does, eight shown and sixteen
behind "Show more colours". A lamp that cannot take a colour is not left out — it gets the colour
temperature that goes with whichever swatch was chosen, so a block does the same thing to every lamp
in the room rather than one thing to the colour bulbs and nothing to the rest. A schedule now also
publishes the colour it is holding, so it can be read in a Flow and in Insights the way the other
device types already could.

**Two blocks that overlap can be merged from the screen that warns about them.** The warning already
said what would happen — the later block wins while they overlap, and nothing breaks. It now offers
to make them one block, or to leave them exactly as they are. Next was never blocked and still is
not.

**A schedule's last screen shows the day it just described**, with its blocks on it, including one
that crosses midnight. It was the only device type whose review had no picture, on the one device
type whose whole configuration is a picture.

**Following the sun now shows where the sun is.** With no light sensor picked, the brightness screen
drew four shapes to choose between and then nothing at all about today. It now carries a card saying
when this room gets its light, where the sun is right now on the day's own range, and what the lamps
will do as it arrives — the same job the sensor's week does when there is a sensor.

**"No lights yet" is a screen rather than a message.** Opening Lightkeeper on a Homey with no lights
paired showed one grey line. It now says what is missing, offers to look again, offers to go and add
one, and offers to close.

**An API key that Homey accepts but will not build Flows with is explained properly.** The screen
keeps the key on view, masked, so the next attempt is not a guess about which one was pasted — and it
says the thing that saves that attempt: permissions cannot be added to a key after it is made.

### Setting the colour before lights come on is hidden for now

The switch that appeared on the circadian and Colour Curve setup screens in this release is not
drawn any more, while where it belongs is settled. **Nothing about the behaviour changes**: a newly
added device still sets the colour in advance, a device added before this release still does not,
and a light that ever comes on by itself from it still turns the whole thing off for that device and
never tries again. What is gone for the moment is the switch and the button that tried it on your own
lamps.


### A light switched on, or switched off, is no longer mistaken for a person

Two more of these, found by reading a day of diagnostics out of a house running six Lightkeeper
devices. Both are the same mistake the entries below describe — a lamp doing something ordinary,
read as somebody taking its light over by hand — in the two places nothing was watching for it.

**A light that comes back on tells you what it came back on at**, and that used to be read as
somebody moving it. A lamp switched on comes up at whatever level it was last showing, and says so a
few seconds later; the app already made allowance for that, but the allowance was as long as its own
work happened to take, and a pass with little to do left it too short. Seen in the Garage: four
lamps came on together, reported their old levels four seconds later, and all four were set aside as
overridden — so the Room-sensing Light driving them did nothing at all for the twenty-nine minutes
they were on. The first thing a light says after coming on is now read as the light, not as a
person. Anyone who switches a light on and *then* dims it is still recognised, because that is the
second thing it says.

**A light that fades out as it switches off** reports itself part-way down on the way, about half a
minute before it reports itself off. A reading of exactly nothing was already understood as a light
going off; one that fades through a tenth was not, so every switch-off in one room left a false
"someone took this over" behind it for the last half minute of its life. Those are now recorded as
what they were. Nothing about how lights are driven changes here — the reading still stands the
light down for that half minute, deliberately, because the proof that it was switching off arrives
afterwards and waiting for it would mean fighting somebody who really had just dimmed a lamp.

**And the app's own record of all this no longer fills up with its own voice.** Everything set
aside — including the routine echo of a change the app itself had just made — took a line in a log
that holds the last hundred and twenty. One device was losing three hundred and forty of them every
five hours, and nine in ten of those lines were an echo. A run of identical entries is now one line
that says how many, and a light repeating an override it has already raised counts against that
override instead of taking a new line each time. The same history now reaches back days rather than
hours, which is what makes any of the above visible the next time.

### A remote button that turns the lights on the way the rest of the house already knows

A Light Remote's buttons could do nine things, and every one of them was self-contained: on, off,
brighter, a set brightness, a set colour. None of them could say *come on the way the house already
knows it should look right now* — which is precisely what a circadian light, a Colour Curve Light, a
schedule and a Room-sensing Light each work out every minute.

There is a tenth job now: **On – with Lightkeeper**. Choose which of your other Lightkeeper devices
the button takes its colour and warmth from, and which one it takes its brightness from, and the
press reads both at the moment it happens. A button set up in February goes on being right in June,
because it stores which setup to follow rather than the numbers that setup happened to be showing.

Two pickers sit behind the card, and each row shows what that setup is producing **right now** — a
swatch for a colour, a bar and a percentage for a brightness — because a house with three curves in
it is told apart by what each one is doing, not by the names they were given months ago.

A switch on the same card makes a second press turn the lights off again, so one button is a whole
light switch. It is on to begin with, and it follows the same rule the existing **On and off** job
does: if any of the lights is on, they all go off.

The values reach the lamps in a single change rather than three visible steps, exactly as the
`Set lights the Lightkeeper way` Flow card does — it is the same machinery, reached from a button
instead of from a Flow. And if the setup a button follows is deleted, the button still turns the
lights on; it simply cannot say what colour.

The job is offered only once you own at least one circadian light, Colour Curve Light, schedule or
Room-sensing Light — there is nothing to follow before that.

### A lamp that takes its time is no longer mistaken for a person

Some lamps do not jump to a new colour temperature or brightness — they fade to it, and a few of them
fade for far longer than anything visible from the app would suggest. Watched on a real Homey: four
lamps in one room accepted a warmth, acknowledged it, and then spent ninety minutes drifting towards
it a hundredth at a time.

Every one of those intermediate readings looked, to the app, like somebody had reached for the
vendor's own app and moved the lamp — so it stood down and left that room alone, which is exactly
what it should do when a person takes over, and exactly the wrong thing here. The room was released
only when the lights were switched off at the wall.

The app now recognises a lamp that is on its way. A reading closer to what was asked for than
anything since it was asked — arriving gradually, a step at a time — is that write landing late, and
the lights stay under the schedule's control while it finishes. Somebody genuinely taking a light
over still gets it: a light moved the other way, moved past what was asked for, or set somewhere else
in one go all read as a person, as they did before.

### A Light Remote with a colour button no longer arrives broken

A Light Remote whose buttons included **Set colour** paired cleanly and was then unavailable before
anybody had touched it, saying only that its stored configuration could not be read. Nothing named
the button that caused it, and nothing on any screen had refused it: the colour job was offered
wherever the chosen lamps could show one, and accepted all the way to the store.

The store was never at fault. The check that reads a configuration back on every start carried a
hand-written list of the jobs it would accept, and `Set colour` had been added to the screens, to the
engine and to the save path without ever being added to that list — so the first read after pairing
refused the device's own configuration. The list is complete now, and a test fails if a job is ever
offered that cannot be stored.

**Nothing was lost.** A device quarantined this way is left exactly as it was saved, deliberately, so
a Light Remote that has been sitting unavailable comes back with every button intact as soon as this
version is installed. Nothing needs to be set up again.

A second version of the same fault was closed beside it, one release ahead of anybody meeting it: of
the two ways a button's job reaches the store, only one carried the value the job was set to. The
screens use the other one, so no device was affected — both now go through a single shared step.

### Press-to-find is gone

The remote picker's *"Or press a button to find it"*, the screen it opened, and the live indicator on
the buttons screen that jumped to the row a real press landed on have all been removed. The shortcut
did not work reliably enough to be the thing to reach for, and the list it was a shortcut past is the
path that always works — some remotes speak only through Flow cards and can never be heard at all, so
the list could never have been replaced by it.

Choosing a remote is unchanged: it is still grouped by room, still searchable, and still carries how
many separate presses Homey has heard from each device, which is the same evidence pressing a button
was there to give.

### What each device wants your lights to be, readable from your own Flows

Four device types spend all day working out exactly what a light ought to be — a colour temperature
from the curve, a colour from the palette, a brightness from how light the room already is, a
brightness and a white from the schedule window that is running. None of it left the app. It was on
the settings page and in a diagnostics export, and nowhere a Flow could reach.

It is now four read-only rows on each device's own tile, and Homey turns every device capability into
a Flow tag on its own, so they are in the tag picker with no further setup. *When motion is detected →
dim the hall to «Hall daylight: Brightness now»* is a Flow anybody can build, and it stays right as
the day moves. They go into Insights too.

**The brightness is what a lamp is sent, not what the slider says.** Those are different numbers:
brightness is stored the way it is perceived and sent the way a lamp is addressed, so 55% on the
setup screen is 26% to the lamp. The tag carries the second one, deliberately, because the whole
point is that dropping it into Homey's own *Dim to* gives the light Lightkeeper itself would give. A
paused device still answers — pausing stops it touching your lights, not describing what it wants.

**Set lights the Lightkeeper way** is the card beside them, and it does the one thing the tags
cannot. Three Homey cards are three writes, so a lamp comes on as it was, changes colour, then
changes level. This is one: a room or a light, a device to take the colour from, a device to take the
brightness from — two different devices is the point — and whether to switch them on. It never
switches a lamp on unless you asked it to: choose *only lights already on* and a lamp that is off is
left alone entirely, because there is no way to set a lamp's brightness without switching it on. A
card whose source device has been deleted writes nothing at all rather than half the settings.

**It is dark enough** is a condition on a Room-sensing Light, which has already decided how light the
room is from its own sensor or from the sun. Any Flow can now ask it, instead of keeping a second lux
threshold in step with the one you tuned on a screen showing that sensor's own week. If it cannot
tell how light it is, the condition is never true.

None of this replaces setting the colour of lights that are off. A Flow only covers the switch-ons
that go through that Flow; that setting is what covers the wall switch and the lamp's own app.

Under it: four custom capabilities, because every brightness and colour capability Homey ships is
writable and would have drawn a slider nothing honours; a value gate at the capability's own
resolution, so a curve moving 0.003 a minute does not write sixty indistinguishable points an hour
into Insights; and a capability sync at device start, because a driver's capability list only ever
reaches devices paired after the change — everything already installed would otherwise have shown
nothing. All of it is written up as section 18 of the platform reference.

### The review

A general review of the whole app for bugs, at every severity, ranked — and the eleven things it
found. The suite, the two type-checks, the linter and the view-sync check were all green before it
and stayed green through it, so none of this was visible to anything already running. Every fix
ships with the test that would have caught it, and the ones that could be were run against the old
code first to confirm they fail on it.

This release also answers a report from a real household: lights coming on in their old colour and
being corrected a second later. That turned out to be true, by design, and to be hiding something
worse underneath it.

### Lights come on already right, instead of correcting themselves a second later

A circadian light and a Colour Curve Light can only react to a lamp once it reports itself on, and by
then it is on and somebody is looking at it. Measured on the reference Homey, five lamps on one wall
switch: the app reacts within 70 ms, and the colour lands 1.3 to 1.9 s later. Every light in the
house visibly changed colour after it came on, every time.

Setting the colour in advance is the fix and has existed since 0.4 — the plan carried the setting,
both drivers answered a `testPreStage` handler, the runtime had the probe and the self-disable, and
the FAQ promised it was "provable from the pairing screen against your own lamps before you commit".
**No screen ever drew a control for it.** A setting nobody can reach is off, and every one of these
devices had it off.

Both setup screens now carry it, with the test the FAQ promised: it picks one of your own lights that
is off, sends it a colour, and tells you what happened — it stayed off, it came on, or your bridge
declined. Which of those you get depends on your own integrations and nothing else can answer it.

It is **on by default for newly added devices**, which is a reversal. It was opt-in because a colour
sent to an off lamp switches it on through some integrations, and a light coming on by itself is a
worse failure than a moment of the wrong white. That is still true; what was wrong was the idea that
opting out cost only a moment. It cost every switch-on, permanently. The protection is unchanged and
does not depend on anyone opting in: 1.5 s after the first such write the app checks whether the lamp
came on and, if it did, turns the whole thing off for that device for good. The exposure is one lamp
coming on once, on an integration that does this. **Devices you already have are not changed** — they
were set up under the old promise, and the setting stays exactly where you left it.

Brightness is still never set in advance, because a brightness write turns an off lamp on. Only the
colour is, and the screens now say so.

### A lamp that ignores us is no longer mistaken for a person

The worse thing underneath. When a lamp reports a value far from the one we asked for, that was read
as somebody reaching for the vendor app, and the device stood down for four hours. A lamp that
accepts a write, acknowledges it and then does nothing looks exactly the same — and is the opposite
situation, where standing down is precisely wrong.

What tells them apart is where the lamp ended up. A person moves it somewhere new; a lamp that
ignored us is still exactly where it was before we wrote. The app now remembers that, and a report of
an unchanged value is recorded as a write the lamp did not act on rather than as a person. It is not
a widened tolerance: an unchanged value is forgiven at any distance, and nothing else is forgiven at
all, so a real nudge is still honoured immediately. A write that demonstrably landed clears the
record, so somebody who moves a lamp back near where it started is still a person.

In the capture this came from, four lamps in one room were sent a colour temperature of 0.82,
reported 0.87 — which they had never left — and stood their device down; four more were sent a
brightness of 0.05 and reported 0.10. Both gaps are 0.05, comfortably outside the tolerance, so
nothing could ever have forgiven them.

Two smaller faults on the same path:

- **The settle window shut while the writes it caused were still in flight.** A lamp being switched
  on makes the app write to it, so the lamp's answer necessarily arrives after the transition — but
  the window that says "this is still us" was anchored at the transition and closed three seconds
  later, between our write and its answer. It now follows the writes instead. It is not simply made
  longer: somebody who switches a light on and immediately dims it is doing exactly what the override
  machinery exists to honour.
- **The four-hour release never arrived.** Every fresh report restamped the deadline, so a lamp that
  kept talking pushed it out indefinitely — which is exactly what a stuck lamp does. The deadline now
  runs from the first report.

A lamp that genuinely cannot be driven is no longer silently written to for ever, either: the count
of writes it has ignored is on each target in diagnostics.

### The switch-on delay itself was measured, and left alone

Worth recording because it looks like the obvious thing to fix and is not. The remaining 1.3–1.9 s is
the bridge's own acknowledgement time — 213 ms to 1191 ms per write, rising as more lamps answer at
once. Writes already go out per device and in parallel, so there is no queue to shorten. The one
write that could be dropped is `light_mode`, and dropping it on the switch-on pass is the worst place
to do it: the lamp has just restored its own state, which is precisely when the mode may be wrong and
the colour would be silently discarded. Setting the colour in advance is the fix; shaving the
correction is not.

### A Colour Curve Light could stop for good, and take the settings page with it

A point that followed sunrise or sunset was accepted when saved and could never be evaluated. The
circadian light's sun-following runs through its zones' BOUNDARIES — `resolveBoundaries()` reads
today's sunrise and `zonePoints()` emits clock anchors from it — and a point's anchor is a different
mechanism entirely, which nothing supplies a curve runtime with the day's sun times for. So
`resolveAnchor()` threw on every tick, the manager caught it per device, and the light silently
stopped changing anything: "looks configured, does nothing", which is the failure this app exists to
prevent.

Both `CircadianAnchor`'s own docblock and `resolveAnchor`'s already claimed the sanitiser refused
these. It did not, and neither did the store's validator, whose comment had been updated as though
the zones' sun-following made point anchors work too. Both gates refuse it now and all three
comments say what is true. The throw stays, so a future half-wiring fails loudly instead.

The second half is worse. `getStatus` called `runtime.diagnostics()` straight inside four `.map()`s,
so one throwing device made `GET /` fail and the settings page rendered NOTHING — no other device,
no API key box, no Flow cleanup, no recent-writes log, on the one screen somebody opens when
something is wrong. A device that cannot describe itself is now left off the page instead of
replacing it: the id and state a fallback card could carry truthfully are already on the device's own
tile in Homey, so an absence invents nothing, and the log line names which device and why.

### The Flow cleanup could delete without being asked

`POST /orphans` with no `token`/`flowIds` in the body fell through to an UNAPPROVED sweep — the
manager skips both the stale-preview check and the approved-id intersection when `approved` is
undefined, so it deleted every orphan it found. The comment justified it as not breaking an older
settings page. There is no older page, because nothing has been published, so it protected nobody
while leaving the app's one bulk-delete callable with no approval at all, over a surface anybody
holding a Personal API Key can reach (platform §14). `countOrphans` already stated the rule it
broke: the user approved a specific set, not a number.

`liveDeviceIds` had the same shape of hole. It logged a driver that would not enumerate and carried
on, under a comment saying such a driver "must not silently SHRINK the protected set" — but a log
does not stop it, and with the controllers live the "nothing is running" guard does not fire. Every
schedule device without a registered runtime would have read as unattributable, and the preview,
computed from the same shrunken set, would have agreed with the mistake rather than caught it. Both
now refuse, in words that match the reason: "no device is running" sends you to look at your
devices, "I could not read my own driver" tells you to wait and reload.

### Six things a day of real diagnostics showed, that no test could

A `/diagnostics` capture from the reference Homey after nearly a day of uptime — six devices,
fourteen lamps, everything reporting healthy. Nothing in it was broken, which is the point: what it
showed was guards that cannot reach their own threshold, a bounded log spending itself on one
expected failure, and a fact being re-derived from scratch every two minutes.

- **A room can now tell you its lights are chasing their own sensor, before it is certain.** A
  Room-sensing Light whose sensor sits in the room it lights can push itself brighter and brighter,
  and Lightkeeper already watched for the signature — but it only said anything after seeing it five
  times, and it was seeing it about twice a day. Worse, the count was thrown away whenever the
  device was edited at all, even for a rename, and on every app restart. It now survives anything
  that did not change the response itself, and the settings page shows both the standing risk and
  the running count instead of nothing until the fifth.
- **A light that refuses to be set up in advance is no longer asked forever.** Some lights decline a
  colour while they are switched off — harmlessly, but every time. Lightkeeper stopped asking after
  three tries and then started again the moment the light came on, which is sensible in a room
  somebody enters twice an evening and pointless in one on a motion sensor: in a room switching every
  two minutes that was hundreds of refused writes a day, half of that device's entire traffic. After
  three switch-ons in a row where it refused everything, it is now left alone and tried again the
  next day. One success clears it immediately.
- **A light sensor that stops reporting now says so.** Its readings are still used — deliberately,
  because a quiet sensor in a still room is telling the truth — but after half a day of silence the
  device says on its tile that the sensor has stopped and its lights are being held where they are.
  That warning existed only during setup, which is the one moment the sensor is working by
  definition.
- **The failure list is no longer filled with the one failure that is expected.** Both affected
  devices were at 50 of 50 entries, every single one a light declining a colour while off — so
  anything genuinely new was pushed out within minutes. That refusal has its own place in
  diagnostics, and keeps it; the list is free again for something that matters.
- **Diagnostics no longer quotes a brightness it stopped following.** A device set up not to touch
  brightness still reported one, frozen at whatever it was when the app started — nearly a day stale
  in the capture, and contradicting the device standing next to it.
- **Diagnostics now shows memory over time, not just now.** One reading cannot tell a settled app
  from a slowly growing one, which is the only question worth asking about it, and answering it used
  to need two captures hours apart by hand. A day of readings is now always in the report.

### The other nine

- **"Put them back" could put the wrong lights back.** Trying a circadian light's colours out scrubs
  through the day on real lamps, and remembers how they were so it can restore them. That memory
  was kept on the driver rather than on the setup session, so closing the screen without pressing
  "Put them back" left it behind: the next time you set one up, that button restored the PREVIOUS
  session's lights to their old values and left the ones you had just been scrubbing where they
  were.
- **A sensor's week could name the wrong days.** The grid that shows a sensor's last seven days is
  the evidence behind the two brightness thresholds, and around a clock change its day labels were
  off by one — for a week ending just after the spring change, Sunday was missing and every earlier
  row was named as the day before it.
- **A Light Remote named with spaces had no name.** A name of nothing but spaces was saved as
  given, producing a tile that appears to be unnamed. It falls back to the derived name now, as
  every other device type already did.
- **A rejected API key left a connection open.** A key with the wrong permissions connects fine and
  only fails when Lightkeeper tries to write a Flow, so every retry leaked one connection for as
  long as the app ran. Two such paths, both closed. Trying a key and having it rejected also no
  longer interrupts the check running against the key you already had.
- **A schedule reconciled its Flows on every refusal.** Paused schedules still fire their Flows, by
  design, and every one of those refusals triggered a full re-read and comparison of every Flow the
  device owns — twice a day, forever, for a device asked to do nothing. Only the one refusal that
  means a Flow was edited does that now.
- **A deleted device left a record behind.** Every Light Remote and schedule ever added wrote a
  bookkeeping entry that nothing ever removed, so they accumulated for the life of the Homey.
- **One unusual Flow card could break remote discovery.** A trigger card with an unnamed argument
  made the whole scan fail rather than just that card — which is the remote picker, the health
  check and the Flow reconcile, for every device on the Homey.
- **Four stale copies of a comment were shipping inside two sensor screens**, each contradicting the
  real one. The splicer prepends rather than replaces anything written above a shared function, and
  the check that compares those copies could not see it because every carrier had accumulated
  identically. There is now a check that can, over all three spliced helpers.
- **Four more were closed although none can happen today**, because each is one edit away and three
  of them fail silently rather than loudly: a write queue that an empty pass could strand for good, a
  remote-listening screen whose subscriptions could outlive it being closed, a lamp that could be
  switched on at zero brightness in the non-default synchronised group mode, and a schedule route
  that could take a device offline instead of refusing.


## 0.6.0

A fifth device type, a rewritten setup flow, and three device types renamed. Nothing in this release
had been published, so the notes below describe what 0.6.0 **ends up** doing rather than the order it
was built in.

### Room-sensing Lights, a fifth device type

- **It holds its lights at a brightness that depends on how much light is in the room already.** Two
  settings — how bright the lights should be when the room is dark, and when it is bright — and which
  of the two is larger is the user's choice rather than a mode, so the same device either takes over
  as the daylight goes or follows the day.
- **It reads ONE `measure_luminance` sensor** the household already owns. Averaging several sounds
  more robust and is not: a cupboard sensor and a windowsill sensor average to a number neither ever
  reported, and the screen could not say whose week the lux range belonged to.
- **Where there is no sensor it reads how high the sun is**, computed from the Homey's own position.
  `homey:manager:geolocation` is declared for exactly that, read at the moment a brightness is
  computed, and the latitude never leaves the Homey. The arithmetic is the standard NOAA
  solar-position algorithm in `lib/daylight/solar-elevation.ts` — pure, no dependencies, asserted
  against values astronomy fixes independently of any implementation. SDK v3 has no solar helper and
  Homey's own sunrise cards fire rather than answer (platform §16).
- **The setup screen draws that sensor's own last seven days** from Homey's Insights as a 7 × 12 grid
  and fills both lux thresholds in from it. A default of 5 → 500 lx suited exactly one of the four
  sensors in the reference house; two of the other three would have sat pinned at one end all day and
  read as "this feature does nothing". The same picture says two things it would otherwise take a
  month to notice — a sensor that barely changes all week, and one that has stopped reporting. No new
  permission: `homey:manager:insights` does not exist, and `homey:manager:api` covers it.
- **With no sensor it asks when the room gets the most sun** — morning, the middle of the day,
  afternoon, or not at all. The sun's height alone is symmetric about noon, so without that answer a
  room that gets its light at 5pm was treated as though it got it at 7am. It is asked as an
  observation rather than a compass direction, because somebody who lives in a room knows when the
  light comes in, and because it absorbs what a bearing cannot: an east window with a wall across it
  gets its sun in the afternoon. "Not at all" is the default and still brightens and darkens with the
  day, taking the diffuse share flat. The question disappears once a sensor is chosen.
- **A sky readout on the settings page**: the sun's current elevation, and every watched sensor with
  its reading **and that reading's age**. The age is the only thing that can reveal a sensor which has
  stopped, because a reading is deliberately never treated as stale.
- Like the two curve-driven types it generates **no Flows** and needs no API key, it only dims lights
  that are already on, and it never switches one on or off — brightness is never written to a light
  that is off, which is measured rather than assumed (platform §12).

Two decisions worth reading before changing anything here:

- **The daylight loop terminates, and two constants are what make it.** A light sensor in the room
  whose lamps it drives measures those lamps, so this is a closed loop, and an undamped closed loop
  hunts — a room that pulses once a minute for as long as the app runs. A deadband makes it settle
  and a slew limit makes any residual movement a fade. The app damps that loop and does not remove
  it; the FAQ names the sensor placements that avoid it altogether.
- **The slew is measured from what we aim at, never from what the lamp reports.** Slewing from the
  lamp's own level looks more honest and stalls: on a lamp whose `dim` moves in tenths, every
  perceptual aim from 0.10 to about 0.45 quantises to the same value, so an aim that only advanced on
  a successful write would never leave the floor while the room went dark around it.

**A device that watches its own feedback loop.** A Room-sensing Light counts the loop's signature —
we raised the aim, and the reading then rose — and after five observations reports `partial` with
`state.daylightFeedback`, naming the two remedies. Deliberately not "pinned at the bright end": on a
sunny afternoon an increasing response sits there legitimately, and flagging that would be a false
alarm on a well-placed sensor.

### Every setup screen redrawn

Setting a device up used to put the abstract control first: two unlabelled sliders standing for a
whole day, a function-first grid of every job crossed with every gesture, two lux numbers with nothing
to judge them against, and an API-key chore before anything of value was visible. Every screen now
holds **one control and at most one sentence**; everything secondary is a row with a chevron; every
caveat has left pairing for the review screen or the device's settings. About seventy per cent of the
words on those screens are gone, and none of them were deleted — they moved.

- Each of the five device types is an unnumbered **intro**, a numbered step per question, and a
  **review** that states what will happen before anything is saved. Every row on the review jumps back
  to the step that owns it. Fifteen screens are authored where there were eight, four of them shared
  by every driver and answered from a payload the driver supplies, so five different flows — three
  steps or four, with or without a key — share one file each rather than five near-copies.
- **The API key is asked for near the START, not at the end.** A user who reaches a four-step review
  and then cannot produce a key loses everything they just filled in. It sits after the intro and
  before step 1, and skips itself silently when a valid key is already stored — which is every Light
  Remote and schedule after the first, since the key is per Homey.
- **"Select all" in a room stores the ROOM.** Ticking every light in one room and nothing elsewhere
  stores a zone target rather than a device list, so a lamp added to that room next month is picked up
  without re-pairing. Unticking one converts it back, and the review states which of the two the
  device ended up with, because the difference is invisible otherwise.
- **The light picker collapses again.** A room's name and count are one button with the same chevron
  every other row uses. A room opens itself when something in it is chosen, but a room collapsed by
  hand stays collapsed; searching opens everything that matches.
- **The sensor picker draws every sensor**, none behind a tap. Rooms with no sensor stay one line each
  saying so — "this room has none" is half the answer to where the reading should come from.
- **No view assigns `innerHTML`.** The two that built card markup as strings now build nodes, which
  took `escapeHtml()` with them and turned "every interpolation is escaped" into the stronger "nothing
  is interpolated".
- **Every screen is light.** Each view used to carry a `prefers-color-scheme: dark` block restating
  the palette, so a phone in dark mode got dark cards inside Homey's white panel. There is no query
  that reports the container's own colour, so the views match the one panel Homey actually draws.

### Four engines reshaped under those screens

- **A circadian light has three zones, not two ends, and its day follows the real sun.** Morning,
  midday and evening, each with its own warmth and — newly optional — its own brightness. Morning ends
  at sunrise plus an offset and evening begins at sunset plus one, both stepped in quarter hours, so
  the day moves through the year instead of sitting at a fixed clock. `sunTimes()` is the new pure
  function behind it, answering `null` where no horizon crossing exists — which is what lifted the
  `{ kind: 'sun' }` anchor that had been declared since 0.5.0 and refused in three places. Boundaries
  are clamped when they are RESOLVED rather than when stored: north of about 60° a short winter day
  can bring two reasonable offsets into collision with no edit having happened. Midnight is a third
  ramp rather than a step change, because morning and evening are now independent temperatures either
  side of it.
- **A schedule's days belong to the schedule, and blocks may overlap.** Seven chips once, above the
  list, instead of seven per block. Overlapping blocks are no longer dropped by the sanitiser: the
  runtime has always resolved them deterministically — the later one wins while they overlap — so the
  screen outlines the region and says so, and Next is never blocked. Deleting a row somebody had just
  drawn was the worse surprise.
- **A Light Remote is one row per button**, in the order the buttons sit, each stating its job in a
  sentence and opening with a mark: filled where the button has a job, an empty ring where it has
  none. The two differ in fill rather than colour, so the list answers "what have I still not set" at
  a glance and to a colour-blind reader. "Not set" is a finished state, not a warning. One rule per
  gesture is now structural — a row holds one job — as well as enforced in `setRules`.
- **Each button drives its own lights.** `MappingRule.target` had carried a per-rule target since it
  was written, and nothing could set one — so the top button could dim the floor lamp only if the
  whole device was about the floor lamp. A row now reads `Top · Long press` over `Brighter · Floor
  lamp`. "All of them" is stored as inherit, never as a list of today's lights, so it goes on
  following a room that gains a lamp; narrowing the lights on step 2 re-aims any button that named a
  lamp dropped, and the runtime writes outside the device's own selection under no circumstances.
- **The job editor is a nine-tile grid, and the grid is the grouping.** Power, brightness and colour
  across; up, down and "set a value" down each column, so every column reads the same way in all three
  rows and no group headings are needed. Each tile carries a picture of its effect rather than a
  number, and the value appears only under the tile that has been chosen. "Do nothing" sits below the
  grid, full width: the absence of a job rather than a tenth kind of one.
- **Two new jobs: a set brightness, and a colour** — one colour from the same closed palette a Colour
  Curve Light chooses from, stored by name rather than as two numbers, and offered only where a lamp
  can take one. **"Step through warm and cool" is not offered**: the grid's third column sets a value,
  and for the colour row that value is a colour. It existed briefly during this release's development;
  a button assigned to it goes on working and keeps its tile while it is the one selected, because
  retired is not deleted.
- **Press-to-find is its own bounded screen**: thirty seconds, a live "heard nothing yet", and "pick
  from the list instead" always one tap away, because a card-only remote cannot be heard at all
  (platform §4).
- **The remote picker draws two lists**: what Homey can hear a gesture from, and — behind one row —
  everything else. There is no reliable way to tell a remote from anything else exposing trigger
  cards, and the screen does not have to; it has to hide what CANNOT work. Nothing is filtered away.
  `eventCount` now means what the screen says: it applies the same gesture test `normalizeCards` does
  ("Turned on" is not a press) and counts the second strong route as well (platform §4), where before
  every bulb, plug and speaker in the house scored two. Lightkeeper's own devices are gone from it.
- **The palette is twenty-four colours**, eight shown with the rest folding out in place, and the
  default curve is coloured — so the first thing a Colour Curve Light shows is that it does colour.
  The curve chart blends between them, because the engine always did: it drew five bands where the
  lights fade through every shade. A new Colour Curve Light pairs with brightness switched on and five
  default points carrying one, and switching brightness off no longer forgets what the points held.

**Following the daylight from inside a schedule, a circadian end or a curve point is not part of this
release.** It put the same sensor picker and lux range on four different screens and gave two device
types two different daylight behaviours to explain — a schedule sampling at its boundary, a curve
following on every tick — which looked identical for the first evening. A brightness is a number; a
brightness that follows the room is what a Room-sensing Light is for. Four screens that ask for a
brightness carry one line saying so.

**There are no migrations, and that is deliberate.** Every stored shape here changed, and the one
Homey running this app starts from a clean slate — so all five migration chains were reset to version
1 with empty step tables rather than extended. A device carrying an older plan comes up unavailable
with a message, which is the signal to delete and re-add it. Nothing has been published, so nobody
else is carrying one.

### Three device types renamed

- **"Light controller" is now "Light Remote", "Curve light" is now "Colour Curve Light", and
  "Daylight light" is now "Room-sensing Light".** Nothing about what any of them does changed — the
  driver ids, stored plans, generated Flows and mappings are untouched, so an already-paired device
  keeps working and keeps whatever name its owner gave it. "Circadian light" and "Light schedule" are
  unchanged. Entries for 0.5.2 and earlier keep the names those releases actually shipped under.
- **The word "controller" leaves every string a user reads.** The settings page's section is **Light
  Remotes**, and the tile text a device shows when something is wrong stopped naming a device type it
  might not be: `state.needsRepair`, `state.disabled` and `state.noTargets` are reached by all five
  device types, so a paused schedule and a Room-sensing Light were both being told they were a
  controller. They say "this device" now. The three that really are the remote's own name it.

### Health, overrides and lights that stop answering

- **Health verdicts compose instead of overwriting each other.** A device learns about its health from
  two independent places on two different triggers — reconciliation, and the lights themselves — and
  both were written straight to the visible state by whichever ran last. A device told "a Flow was
  edited, open repair" had that replaced by "1 of 3 lights unavailable": a different problem, a less
  actionable one, and `partial` also flips the device back to available so the repair prompt
  disappears from the tile. One lamp switched off at the wall was enough. There is now one ranked
  verdict (`lib/runtime/verdict.ts`): needs_credential > needs_repair > partial > ready, ties to the
  verdict that names an action. `needs_credential` outranks `needs_repair` because repair WRITES Flows
  (platform §1), so a repair prompt on a dead key sends the user into a flow that cannot complete.
- **A remembered `needs_credential` is forgotten on request by both verdicts.** A stale copy is the
  most severe state there is, so it sat over every later verdict for ever, and the tile went on saying
  "Lightkeeper needs a new API key" against a key that worked.
- **A lamp that stops accepting writes surfaces within a minute or two.** The write-failure streak
  exists so a runtime does not go on writing to a lamp for ever behind a green tile — and it did
  exactly that, because health was assessed at start and on a target-set change and nowhere else. A
  lamp cut at the wall stays `available: true` (platform §6), so the fingerprint never moved and the
  unwritable set was consulted once, when it was empty.
- **A light whose lamps were switched off could report itself as broken.** Some Philips Hue bulbs
  refuse a colour sent while they are off — the bridge answers "soft off" — and a circadian or Colour
  Curve Light with pre-staging on kept sending it once a minute for as long as the lamps were off.
  Each refusal counted against the lamp, so the device eventually said its lights were not responding,
  and where all its lamps behave that way it took itself offline. A refused pre-stage write is no
  longer counted: from the refusal alone a lamp that is merely off looks exactly like one that is
  dead. Pre-staging also stops offering a colour to a lamp that has refused three times running, and
  tries again the next time that lamp is switched on. Found on four of thirteen colour-capable bulbs
  behind one bridge.
- **An override expires after four hours.** A lamp that accepts every write, acknowledges it and
  reverts to its own values ninety seconds later is indistinguishable from a person, so it was read as
  one — and an override was cleared only by an `onoff` edge, by the target leaving the plan, or by the
  runtime stopping. One device stood down for 23.6 h, then 23.1 h, 15.5 h, 15.2 h and 11.0 h back to
  back, lamp on throughout, reporting `ready` throughout. Four hours is a balance: long enough not to
  fight somebody who dimmed the lamps for an evening, short enough that a lamp the app cannot drive
  costs one evening instead of a week. Expiry also drops `committed`/`lastWritten` for that lamp —
  without it the plan is unchanged, the no-op filter drops the write, and the lamp stays where it was
  put. Both halves ship together or neither does anything.
- **Switching a lamp off is no longer read as overriding us.** The `lamp_off` guard reads `actualOn`,
  which only moves when the `onoff` report lands, and one integration reports `dim 0` a median of
  **29.9 seconds before** the matching `onoff: false`. In that window the report went straight to
  `noteOverride`: 296 of 327 overrides in a recorded week were this and nothing else, each a false
  badge and a junk entry evicting real history from a 120-entry log. A reported `dim` of 0 is now the
  lamp going off whatever `onoff` has said yet — neither runtime can write 0, so a reported 0 is
  always the lamp's own.
- **A tolerance is compared with an epsilon, never a bare `<=`.** `Math.abs(0.83 - 0.86)` is
  `0.030000000000000027`, so the same three hundredths was forgiven at one end of the axis and
  prosecuted at the other — which, under the expiry bug above, meant standing down for good.
  `withinOverrideTolerance()` owns the comparison for all three sites.

### A value that is absent is no longer a value of zero

- **`Number(null)` is 0 and 0 is pitch dark**, open on all five light axes. A live report of `null`
  became an apparent zero in actual state, and the NEXT report read as "changed by hand, to nothing",
  so the lamp stood down and stopped following its curve until its next power cycle. `liveValuesOf()`
  also cast a snapshot value straight to `number | undefined`, which mistypes rather than coerces — so
  a Room-sensing Light counted `null` as a real reading, seeded its aim from a perceptual zero and
  wrote `dim 0.01` to an already-lit lamp before fading it back up at 0.05 a tick. One guard covers
  both paths.
- **A lamp's own power-on report is no longer read as a human override.** The settle anchor was
  deleted at the off edge and not re-armed at the on edge, so a bulb power-cycled at the wall could be
  marked overridden and skipped on every tick until its next power cycle — defeating the headline
  promise that a lamp is the right colour however it was switched on.
- **Dimming down on a lamp declaring `decimals: 1` no longer writes a value that lamp shows as off.**
  The floor defaulted to 0.01, the `decimals: 2` representable step wearing a policy name; on a tenths
  lamp it quantises to 0.00 — darkness, written by the one branch whose purpose is to refuse it.
- **Synchronised group brightness no longer nudges a lamp already on the group target one step past
  it.** `advanceDim`'s guarantee that a lamp MOVES is right per lamp and wrong for a group, so the one
  lamp that started in the right place was the one that drifted, on every press.

### Other fixes

- **One-tap re-attach no longer offers whichever identical remote came first.** The portable
  fingerprint is device-agnostic by design, so two STYRBARs tie — and nothing excluded a remote
  another live controller was already listening to. Remotes in use are excluded, and a genuine tie now
  says so and sends the user to repair to choose.
- **A save the app could not have loaded back is refused when it is made.** The only validator in the
  device layer ran at load, so a route could persist a plan the next restart refused — the device
  going unavailable saying "set this device up again", days later, with nothing to connect it to.
- **Deleting a device no longer recreates a `Lightkeeper` folder the user had removed**, and no longer
  attempts a folder WRITE from a delete — which, on a dead key, could flip every device to "needs a
  new API key" while tidying up.
- **Sensor ids from a pairing screen are checked against the catalogue**, not only for shape. A lamp
  id accepted as a sensor was subscribed to, never reported a lux value, and left the device running
  on the sky for ever.
- **A "not found" is no longer inferred from `404` appearing anywhere in an error message.** Homey
  echoes ids back inside errors, and roughly one UUID in three hundred contains `404` between two
  non-digits — enough for a 409 or a 500 to be read as "already gone" and the Flow left firing where
  the orphan sweep cannot see it.
- **A plan written by a NEWER version now says to update the app**, instead of telling somebody whose
  configuration is intact to set their device up again.
- **The write client's socket is closed.** Four sites dropped the reference without calling
  `destroy()` and a fifth replaced a live client, so every credential failure, cleared key and
  re-minted key left an orphaned socket open for the life of the app.
- **A whole-Homey device re-parse on every re-subscribe is gone.** `makeCapabilityInstance` asks
  `homey-api` to refresh every device in the house when the device it is called on is more than 2.5 s
  stale, and a device served from cache always is — so every catalogue change, re-attach and client
  rebuild queued a full `getDevices()`.
- **A sensor's Insights week is no longer cached forever**, and the `insights` manager is not
  connected at boot: `connect()` opens realtime subscriptions and there is nothing live to subscribe
  to. The cached copy had meant the pairing screen redrew yesterday's week.
- Smaller: a hand-edited profile with an absurd range no longer hangs startup; a "test it now" probe
  cannot write after its own runtime has stopped; an orphan count reports a transport failure rather
  than failing every sweep for the rest of the run; `network` as part of a word is no longer read as a
  network failure; a rate-limit map that was never cleared is; and one `Intl.DateTimeFormat` per
  timezone instead of one per call.

### Diagnostics

- **Per-runtime history of the last 60 control passes and 120 power/override events**, with each
  pass's per-target decisions, the sensor inputs behind a daylight pass, and command completion
  outcomes. Kept independently of the short command log, so six lamps cannot erase an hour of history
  in five ticks, and truncation is reported rather than silent.
- **The app can see its own memory.** `process.memoryUsage()` throws in the app sandbox and `/proc` is
  not mounted (platform §17), but `v8.getHeapStatistics()` and the per-space split can be read — and
  they are the only signal that distinguishes *holding* a parsed catalogue from *having parsed* one,
  which PSS cannot. Three boot marks come with it: the app's JS heap is **15.2 MB with no devices**,
  of which **8.8 MB is spent importing its own modules** before `onInit` runs.
- Brightness units, snapshot timestamps and API-success semantics are labelled in the export.

**What the memory work established, since it changes how the number should be read.** A do-nothing
Homey app — `require('homey')` and an empty `onInit` — costs **27.6 MB of PSS** against Homey's 30 MB
guideline, and Lightkeeper's own code is about **1 MB** above a control app that has made the same
calls. The cost is the transport libraries: `socket.io-client` alone is +13.7 MB of RSS to require.
Two recorded assumptions did not survive: "V8 never gives the pages back" is a laptop fact and not a
Homey one — PSS was watched *falling* on an idle process — and peer apps are not smaller but paged
out. The whole ladder, its method and its traps are in platform §15; report this app's footprint as
its margin over a control app rather than as an absolute.

### Repository and tooling

- **A seven-day evidence recorder, built OUT of the app you install.** It is a development tool: the
  code, its six Web API routes and its settings section are removed at build time, and the build fails
  if any of it is left. `.dev-build` at the repository root puts it back for a local install.
- **`scripts/build.mjs` fails the build on a stray in `.homeybuild/`.** It was found holding a stale
  `print.pdf` and a `views.zip` of deleted screens — 3.6 MB that would have shipped to households,
  because the Homey CLI honours `.homeyignore` and does not consult `.gitignore` at all. An allowlist
  rather than a denylist, because the file that ships is always the one nobody thought about. A test
  also fails if `.gitignore` grows an entry `.homeyignore` does not account for.
- **`npm run render:views` draws Homey's own sheet** around each screen — its header and its
  `← Previous` / `Next →` footer — and renders each driver's own intro, light picker and review
  separately. Both were omissions that hid real defects: without the chrome, nine screens had shipped
  drawing a **second Next** below a sheet that already had one, and on the key screen that was a
  bypass rather than a duplicate, since Homey's own Next walked past an empty field.
- **`npm run sync:views` splices the shared blocks** from `views/shared/` into all 56 pair and repair
  views, rather than each being hand-maintained under an instruction to "edit this block in all files,
  or in none of them".
- **CI audits the shipped dependency tree** and fails on a new high or critical. The manifest's `api`
  block is checked against `api.ts`'s exports — a name matching nothing gave no build error, no
  validate error and no test failure, only a 404 when somebody pressed the button.
- **`docs/homey-platform.md` is the platform reference**, seventeen numbered sections cited from over
  150 places as `platform §n`. Five investigation documents that narrated how conclusions were reached
  were deleted, their durable findings folded into the code and the reference that depend on them.

### The Room-sensing Light's artwork

- **Its icon and device image were placeholders** — a plain stroked circle and a flat violet disc,
  both of which satisfied every automated check and neither of which was finished work. Both were
  replaced, which closed the last publish blocker.
- The device image is a render of the same rounded-square wall unit as the circadian and Colour Curve
  Lights, so the three engine-driven device types read as one app in a driver list, and its face
  carries what this one does: a curve descending from a glowing amber ring to a plain grey one, a moon
  under the lit end and a sun under the dim end. Dark room, bright lamp. It also gains a domed sensor
  lens the others have no use for — the one signal that this device type reads something rather than
  only writing.
- **The icon is the one graphic in the app that does not depict what its device type does**, and the
  one that reads worst at the 24px the App Store draws a driver icon into. It was supplied as artwork
  and shipped as given; `artwork/provenance.md`'s *The hood mark* carries the reasoning and the brief
  for whoever redraws it. About 8 KB of C2PA metadata arrived with it and was stripped in the master,
  because Homey uses an icon as a flat alpha mask fetched by MD5 and nothing on the device can read an
  embedded manifest.
- **Two other icons were stale.** Renaming three device types updated the titles in
  `artwork/export-assets.py` but never re-ran it, so the shipped files still said "Light controller"
  and "Curve light" in their `<title>`. Nothing renders that element, which is why it went unnoticed.

## 0.5.2

Four fixes, all found by reading one diagnostics export from a Homey that had been running for an
hour. Three of them are only visible on a real lamp, which is why nothing in the suite had caught
them.

Fixed:

- **A Curve light could keep the colour it last held instead of going back to white.** A lamp
  sitting in colour mode can refuse a colour temperature outright (platform §6 — measured on one
  lamp then, and since counted at roughly one in thirty-six), so switching axes needs a `light_mode`
  write to land first — and `planTemperature` emits exactly that, ahead of the
  temperature. The circadian runtime's "has the curve moved far enough to be worth a write" gate ran
  per write, and handed the mode write it compared the string `'temperature'`: `Math.abs('temperature'
  - previous)` is `NaN`, `NaN >= step` is false, so the mode write was dropped whenever a warmth had
  ever been recorded for that lamp. The first crossing from a coloured segment into a temperature one
  therefore worked and every later one did not, which on a curve that repeats daily means it worked
  once and never again. The gate now decides per DEVICE and takes all of that lamp's writes or none —
  the shape the colour leg already used. A successful colour write also voids the warmth we remember,
  mirroring the way a temperature write already voided the remembered colour: without it the next
  temperature segment compared against a value the lamp had physically left, and a daily curve
  repeats its warmths exactly.
- **The dimmest brightness setting meant off.** Brightness is stored perceptually and written in
  device values through γ = 2.2, and `dim` reports two decimals — so 5% became `0.05^2.2` = 0.0014,
  quantised to `dim` 0.00. Anything below 9% did the same, and 5% was the lowest position every
  brightness slider offered. On a curve it held there for the eight minutes either side of the point.
  Three changes: the sliders start at 10%, a migration lifts any stored value below that (without
  which a stored 5% would load into the new slider *displaying* 10% while the plan still said 5%),
  and `litDim` in the intent planner writes one representable step rather than zero whenever
  quantisation would eat a positive request. That last one is the same argument `advanceDim` already
  made for relative steps, one axis over.
- **A blend between two distant palette colours went through hues nobody chose.** `mixColors` took
  the short way round the hue wheel, which is right for adjacent warm pairs and wrong for wide ones:
  ember (hue 0.02) to ocean (0.55) is 0.53 of a turn, flipped to −0.47, so it ran backwards through
  rose, magenta, purple and violet at a saturation that never dropped below 0.7 — half of an
  hour-long segment was purple. 14 of the 28 palette pairs are more than a quarter-turn apart. No arc
  fixes it, because two hues half a wheel apart have nothing between them either way round, so the
  blend is now a straight line across the colour DISC: hue and saturation are polar coordinates, and
  a straight line between two points of a disc dips towards the pale middle for a wide pair while
  barely moving for a narrow one. Amber still blends through orange to rose. `COLOR_STEP` rises from
  0.01 to 0.03 to go with it — the disc path is genuinely longer than the arc, so at 0.01 the same
  segment cost 95 writes instead of 42, against the "one write per light every few minutes" the
  runtime promises; 0.03 restores it, and is still finer than the eye on a wall.
- **A bug report can describe a Curve light's colour.** The diagnostics carried `warmth` for every
  point and dropped `color`, which is the field that actually drives a colour-capable lamp — so a
  coloured point was indistinguishable from a temperature point at the same warmth, and it was the
  one field the first fix above would have needed from a user's report. `targets[].lastWritten` now
  carries the colour too (it recorded a timestamp for hue and saturation writes and no value, which
  read as "nothing written" on a lamp that had just been sent three), its `brightness` field is
  called `dim` because that is what it holds — the device value, 0.02 where the curve says 0.156 —
  and a `canColor` sits beside `canWarm` so a colour-only lamp no longer looks like one nothing can
  be done with. `lastAction` records the colour and the palette names it was between, and a pass that
  does nothing now says why instead of leaving the previous pass standing with a timestamp an hour
  old.

## 0.5.1

Nothing about how the app works changed. This is the App Store listing, which three separate things
were getting wrong.

Changed:

- **The store description is a third of its old length and no longer opens with a backstory.** It
  had grown to 562 words across six paragraphs, the first of which was about buying remotes from
  IKEA. Athom's own guideline for the listing body is *"one to two paragraphs tops"*, and the store
  clamps it to ten lines on desktop and five on mobile behind a "read more" — so everything past the
  first paragraph was being read by almost nobody, and the first paragraph was not about the app. It
  now says what the app does, that light controllers and schedules need a Personal API Key and the
  two curve-driven device types do not, and that nothing leaves your Homey.
- **The store tagline is a one-liner again.** It was *"Dozens of Flows, or one app. Point any remote
  at any lights, put those lights on a timer, and let them follow the colour of the day"* — two
  sentences, 133 characters, listing the same three jobs the description opens with, and leading on
  a piece of Homey jargon. It is now *"Easy control for the lights you already have"*, which says
  what the app is for and answers the first question a browser has: no, you do not need to buy
  anything.
- **The changelog is plain prose, every entry, not just this one.** `.homeychangelog.json` went into
  the store as Markdown — `Added` / `Changed` / `Fixed` headings, thirteen bullets, `**bold**` — and
  the store drops that string into a bare `<p>` with no `white-space: pre-wrap`. Every newline
  collapsed to a space and the asterisks were shown literally, so 0.5.0's release notes rendered as
  one 1800-character run-on sentence. (README.txt's container *does* have `pre-wrap`, which is why
  the description's paragraphs survived and the changelog's did not — the difference is not
  documented anywhere.) `test/unit/release-metadata.test.ts` now fails on a newline, a `**` or a
  bullet in any entry.

Fixed:

- **The four device icons are legible at the size the App Store actually draws them.** They were
  showing as near-empty circles on the listing. The cause was not the CDN, CORS or the mask
  technique — the mask URL served `200 image/svg+xml` with the right bytes, inside markup identical
  to what IKEA Trådfri and Philips Hue get. It was the drawing: a flow card's icon is a 40 px circle
  with 8 px of padding, so a 960-unit canvas is rendered into **24 px**, where a 34-unit stroke is
  0.85 px. Each of the four hung its subject inside a rounded-square frame that took two thirds of
  the canvas, and the circadian icon carried seventeen separate strokes. Fewer and larger elements
  fixed it, at the house stroke weight rather than a heavier one: the circadian icon is five
  strokes now instead of seventeen, the curve five instead of thirteen, and the stopwatch four
  instead of eight. The remote kept its five and was reproportioned instead — its old 0.34 aspect
  made `mask-size: contain` fit it by height and leave it eight pixels wide. The app icon was
  already fine and is unchanged. Recorded as `platform §10`.
- **Two of the four say something different now**, which the size work exposed rather than caused.
  The circadian icon was a bulb under an arc, which read at 24px and meant nothing; it is a rayed
  sun on the horizon, which is what the device is about. The remote had a large circle over a small
  one inside a rounded box, which is a woofer over a tweeter; it now sends a signal. Two arcs off
  the top-right corner are the fix, and the reason is worth keeping: they sit OUTSIDE the
  silhouette, so they survive the size that eats interior detail. Giving the dial a pointer and
  the button a rocker split had fixed the speaker read at 144px and changed nothing at 24.
- `npm run render:icons` is new: it draws every icon at 24, 34, 48 and 144 px of ink using
  homey.app's own markup and CSS, which is the only way to see this before publishing. A contact
  sheet, not a check — `test/unit/assets.test.ts` is still what an icon has to pass.

## 0.5.0

Added:

- **A fourth kind of device: a Curve light.** It is the circadian engine with the whole day open —
  every point, every time, and **a colour instead of a warmth at any point**, from a closed palette
  (candle, amber, peach, rose, lavender, ocean, forest, ember). A lamp that cannot show a colour is
  written the point's warmth instead, so the shape of the day is the same on every lamp.
- Colour writes go out as `light_mode`, then `light_hue`, then `light_saturation`, in that order —
  a lamp sitting in temperature mode ignores a hue it is given, silently.
- Six routes on the app's own Web API that drive a *saved* device the way a pairing screen's
  **Test** button drives an unsaved one — preview a curve, probe pre-staging, tick every curve,
  fire a schedule boundary, replace a schedule's windows, run one mapped controller function. They
  are session-authenticated like every other route, add no new UI, and each wraps a method a pair
  session already calls. `scripts/verify-hardware.mjs` uses them to answer the last lines of the
  hardware pass that needed a person watching a lamp.

Changed:

- **The circadian light is now the simple one.** It asks what your lights should look like at their
  warmest and at their coolest, and supplies the shape between them itself: warm overnight, cooling
  through the morning, held cool through the middle of the day, warming again from mid-afternoon.
  The shape is deliberately not a setting — once the times are editable it is the Curve light with
  fewer fields, and the two device types stop being different products.
- **An existing circadian light keeps its warmest and coolest points and drops the ones between**
  (schema 1 → 2). Nothing stops working and nothing needs pairing again. A curve you want back is a
  Curve light away.
- One registry serves both, so there is still exactly one 60-second timer for every curve-driven
  device on the Homey.
- **A copy pass over every screen, read as somebody meeting the app for the first time.** The
  warm/cool axis is called *warmth* everywhere — the light-support row said "colour temperature",
  the curve's no-colour option said the same, and the controller offered "Colder" against a
  Cool/Coolest scale. The `targets` view is one file shared by all four drivers and was the only
  screen without a subtitle, so it never said which lights it was asking for; the driver now
  supplies that line. The credential screen is shared by the controller and the schedule and
  described "your remote" to both. `state.noCurve` called a Curve light a circadian one, and so did
  the settings section that lists them — `api.ts` reads one registry for both types. Four strings
  named internals at the user (`pair/listSources`, "the intent never reached the queue"), and four
  more were hardcoded English inside the views where every sibling string went through a locale key.

Fixed — schedules:

- **Overlapping windows no longer fight.** Two schedules over the same lights used to go dark when
  the first ended, while the second still believed the lights were on. A clashing window is now
  refused at save (a week is treated as a circle, so Friday 23:30 + 2h against Saturday 00:30 + 1h
  is caught), and a plan saved by an earlier version has its off boundary suppressed while another
  window is still running — re-applying that window's own brightness and warmth.
- **Catch-up after a restart is gated.** It switches lights on only when the plan is enabled, the
  Flows are trustworthy, the timezone resolved, AND a reference to *that entry's* off Flow exists —
  its whole licence rests on something being scheduled to switch them off again. Refusals are
  recorded in diagnostics rather than only logged.
- A schedule refuses to fire at all when Homey's timezone cannot be read, instead of guessing the
  day. A circadian or Curve light still degrades gracefully on the same fallback.
- A `days` value that is not a list drops the row instead of silently meaning *every day*.
- Schedule row ids are server-generated and shape-checked, so nothing can break the Flow argument
  they are embedded in.
- An overnight off Flow's name now says which day the window started on.

Fixed — remotes:

- **A card with a button, a direction and a step count now compiles one Flow per combination.**
  It used to produce one Flow per step with neither the button nor the direction set, so every
  variant fired on every control of the remote.
- A range stores the card's exact values rather than two endpoints: a dropdown offering 1 and 3 is
  two Flows and no invented 2, and decimal steps work at all.
- A card whose device filter names a truncated app id, or a filter key Lightkeeper cannot evaluate,
  is no longer offered for the wrong device — and says why it was declined.
- Two gestures that would share one binding key are reported instead of one silently vanishing.
- Homey's time trigger card is chosen only when the choice is unambiguous; a tie is refused and
  both candidates are named.
- **Mapping a remote to a single light shows one section, not two.** “All lights” and that lamp's
  own section were the same lamp listed twice, the second offering per-lamp overrides that had
  nothing to override. The one section left is named after the lamp, and now hides any function
  that lamp cannot perform.

Fixed — everywhere:

- **The app uses less memory on your Homey.** It was reading the full list of every Flow card on the
  Homey — around 1700 of them, each carrying its text in every language it was translated into — in
  three separate places, and keeping all of it for as long as the app ran. It now reads that list in
  one place, keeps only the handful of details it actually uses, and lets the rest go. Two of the
  three reads are gone entirely: the three cards Lightkeeper needs of its own are asked for by name,
  and opening the settings page no longer triggers a read at all. The reasoning, and what it would
  take to go further, is written up as `platform §15`.

- **Every screen is light now, in every phone setting.** The pairing and settings screens followed
  the phone's dark mode, but Homey draws the panel around them and draws it light regardless — so a
  phone set to dark got dark cards and pale text on a white sheet. The dark palette is gone rather
  than corrected: there is no way to ask what colour the panel is.
- The two-ends screen no longer shows a brightness slider for each end while *Follow brightness too*
  is switched off. The sliders appear when you switch it on, which is when they do anything.
- Entering a new API key that turns out to be bad no longer marks the working key as broken, and a
  key check still in flight cannot publish its verdict after the key has been replaced.
- Saving a device whose runtime fails to start now restores the previous setup instead of leaving a
  half-saved one, and a device's status can no longer be flipped back to healthy by a stale update.
- What Lightkeeper learns about its own Flows is now written to disk before the save is treated as
  done; a failure reports repair rather than success.
- A dropped connection to Homey is now recognised and the client rebuilt, instead of every later
  read failing identically until the app restarts.
- Persisted configuration is validated on load. A device whose stored setup cannot be read says so
  and leaves the data alone, rather than quietly starting with defaults.
- Nothing in the settings page or the pairing screens builds HTML out of names that came from other
  apps any more.

## 0.4.0

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

## 0.3.1

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

## 0.3.0

Changed:

- **New artwork throughout, and a new palette to go with it.** The app's mark is the logo — an open
  circle with a sparkle — and the two device icons are a remote and a stopwatch drawn in the same
  hand. The brand colour is now the logo's own violet `#180E32`, with its lavender `#CCB0F3` as the
  accent, and every screen the app draws follows: the settings page and all seven pairing views take
  the violet in light mode and the lavender in dark. Both hexes are read out of the logo bitmap by
  `artwork/export-assets.py --palette`, and a test fails if the manifest ever disagrees with it.
- **The store image and both device pictures are new photographs.** An evening room with two lamps
  lit for the app, a remote for the controller, and — at last — a real device for the schedule: a
  plug-in timer with a glowing dial, instead of a lamp standing in for hardware it does not have.
- **The icons are generated now, not hand-drawn twice.** `export-assets.py` builds all three from the
  SVG masters in `artwork/masters/`: it centres each drawing on Homey's 960 canvas, normalises
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

## 0.2.2

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

## 0.2.1

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

## 0.2.0

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

## 0.1.1

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

- **A changelog, and a release process that is enforced rather than remembered.** This file and
  `.homeychangelog.json` now record each release, and a test fails if the version, either changelog,
  or the test count the README quotes fall out of step.

## 0.1.0

First release. Paired remotes, switches, buttons and rotary dials driving on/off, brightness and
colour temperature across individual lights or zones, with the Flows underneath created and
maintained automatically. Local connection, Homey Pro 2023 and later.
