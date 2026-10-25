# Changelog

Every release in full; [`README.md`](README.md#changelog) has the short version. Newest first.

**From 1.0, the version number is the warning.** A minor or patch update keeps every device you
already added working as you set it up. Anything that would need Homey's **Repair**, deleting and
adding a device again, or losing a setting you chose arrives only as a new major version, and its
entry here says exactly what. [More in the FAQ](FAQ.md#is-this-finished).

## 1.0.0

**Lightkeeper leaves early access.** Nothing needs redoing. Apart from the fixes and the hardening
below — none of which changes how a device you set up behaves — 1.0.0 runs what 0.6.6 ran. What
changes is the promise.

Until now every release could reshape what a device stores, and the changelog entry was the only
warning — there were no major bumps before 1.0, so a breaking change looked like any other minor or
patch. From 1.0 the app follows semantic versioning:

- **A minor or patch update** keeps every device you already added working as you set it up. A
  stored setting may still be migrated to a new shape, but silently and completely — no Repair, no
  re-adding, nothing you chose lost.
- **A major update** is the only kind that may need any of those. It still ships with a migration
  wherever one is possible, and says in its entry here and in what Homey shows you exactly which
  devices are affected and what to do.

New features and redrawn setup screens still arrive in minor versions; what they may not do is break
a setup you already made.

**Every brightness is Homey's own number, and the *Brightness scale* setting is gone.** 0.6.6 offered
two meanings for a stored brightness and defaulted to *Natural*, a perceptual scale of the app's own
(`dim = p^2.2`): 50% looked half as bright, and read 22% in Homey's slider beside it. That was a
scale invented for a problem Homey already has a number for. Now a curve point, a schedule block, a
Room-sensing Light's two ends, a remote's *Set brightness* and the published *Brightness now* are
all Homey's `dim` — 50% here is 50% there — and the floor is 1% rather than 10%.

- **Nothing you set up changes how it looks.** Each device type's migration chain gains one step
  that converts a plan stored on the natural scale to the number it was already being sent as
  (`carryBrightness()`, floored at 1% so a night setting stays lit), so a curve point that said 74%
  says 52% and the lamp does not move. A plan saved under *Same as Homey* already held `dim` values
  and is only re-stamped; the retired setting is read once per device to tell the two apart.
- **A new device starts where one always has.** The defaults were chosen on the natural scale and
  are converted to the nearest 5%: a new Colour Curve Light's day is 15 / 60 / 35 / 85 / 10%, a
  circadian light's zones 25 / 80 / 15%, a Room-sensing Light's ends 80% and 5%.
- **Movement keeps its curve.** A remote's step, a hold ramp and a Room-sensing Light's fade still
  move along γ = 2.2 — equal `dim` steps flash at the dark end — and none of them shows a number.
- The settings page's section, its six strings in thirteen languages, the
  `POST /brightness-scale` route and `semantics.brightnessScale` in diagnostics are gone;
  `semantics.brightness` says `dim_0_1`.

Four fixes:

- **Removing a device no longer leaves your other devices asking for a new API key.** After a
  device's Flows were deleted, Lightkeeper removed its now-empty Flow folder — and a Homey that
  refused that folder delete with "Missing Scopes" had the refusal read as a verdict on the whole
  key. Every Light Remote and schedule then sat in "needs a new key" until the app restarted, with
  nothing wrong with the key. A folder is presentation only, so folder writes no longer decide
  whether the key works in either direction; a refused Flow write still does, exactly as before.
- **"Test my lights" puts a light back in the mode it found it in.** The test sends each light the
  colour or warmth pre-staging would, and that write switches a light's `light_mode` first
  (platform §6). Putting it back restored only the axis the test wrote, so a lamp found at warm white
  and tested with a coloured curve came back on in colour mode, showing whatever hue it last had. It
  now restores the mode, then only the axis that mode shows — the rule the circadian screen's
  "Stop preview" already followed, and one shared table (`AXES_FOR_MODE`) serves both.
- **"Test my lights" waits for a light to finish switching on before putting it back.** Found on the
  25 October hardware pass: three Tuya bulbs that keep a warmth written while they are off apply it a
  few hundred milliseconds *after* acking the switch-on, on top of the restore sent straight behind
  it — so the test left them at its own warmth, and these are exactly the lights it passes. Measured
  on one of them, a warmth sent 0 or 300 ms after the ack was lost every time and 600 ms or later
  always landed; the restore now waits a second (`RESTORE_SETTLE_MS`), once, for every light at once.
- **A light Homey marks unavailable is no longer sent a change every minute.** Homey refuses such a
  write itself, in about 10 ms, so a Room-sensing Light driving an offline garden lamp logged 388
  refusals in a morning and pushed every real write out of its history. The curve-driven types and
  the Room-sensing Light now pass over it, and write to it the moment Homey says it is back.

Hardening, from a security audit. Pair sessions and the app API are a scriptable surface
(platform §14), so a stored setting is not proof of anything:

- **A Flow is deleted only when the live Flow itself names the device deleting it.** A Flow id
  stored with a device, or in the app's Flow journal, is no longer trusted on its own: a forged one
  could have made the app delete any Flow in the house with the stored key. A Flow list that cannot
  be read deletes nothing — so a device removed at that moment leaves its Flows for *Remove orphaned
  Flows* to offer later — and a Flow somebody re-pointed at another device is no longer deleted with
  the original.
- **Remove orphaned Flows leaves alone a Flow somebody added a condition to**, such as a customised
  copy of a generated Flow; it is reported as unmanaged.
- **Two devices can no longer share one device id.** The second is marked unavailable instead of
  silently taking over the first's lights and Flows. Every device id this app has ever created keeps
  working.
- **The Test control** (pairing screen and app API) refuses a job name that is not a light function,
  and only ever touches the controller's own lights, at most 256 of them — saying so in the Homey's
  language when it refuses.
- **A stored schedule never runs more than twelve blocks** — a plan holding more keeps its first
  twelve instead of generating extra Flows — and every list a screen or a stored plan can carry is
  bounded, including the lamps a pre-stage test proved.
- **Every settings and pairing screen is checked for every HTML-injection route**, not only
  `innerHTML`, and the credential screen's "could not reach Homey" banner is built from text nodes.

Less background work, from a performance audit:

- **The read client no longer subscribes to Homey's Flow and Flow-tag event streams**, which it never
  read. The write client keeps them until a credential pass on hardware says otherwise.
- **A device or zone change no longer re-reads every installed app's name**; names are asked for only
  when a device from an unknown app appears. The sensor service gathers a burst of device changes
  into one re-read, and the trigger-card list is let go when its minute is up.
- **Starting or re-targeting a circadian, Colour Curve or Room-sensing Light reads each lamp once**
  instead of twice, and subscribes to its lamps several at a time. A missing remote is searched for
  once per health check, not twice.
- **Motion in a room no longer makes Lightkeeper re-read anything.** Homey reports every change in a
  zone's motion state as a zone update — for the zone and every zone above it, 176 an hour in a quiet
  house — and each one used to rebuild the device list and, behind it, re-read the whole list of
  Flow trigger cards. A zone update now counts only when the zone's name or place changed, and a
  remote's buttons are re-read only when something about that remote changed, or once an hour.
  Measured on the reference Homey, the zone half took device-list rebuilds from 94 an hour to 20 and
  full card reads from 24 to 13; the remote half is what is meant to take the 13 down to about one.
- **Stopping cancels every timer at once.** Each device cancels its ramps, held presses, pre-stage
  checks and sensor retries before its asynchronous cleanup, and app shutdown starts every teardown
  together instead of waiting on the evidence recorder first (platform §17: an `await` there may never
  finish).
- **`/diagnostics` keeps more useful history and counts more.** Identical idle passes are one row
  with a count, so the last pass that changed a light is no longer pushed out within the hour; and
  how often the device catalogue changes and the card lists are read is counted, which
  `scripts/diagnostics.mjs` prints per hour.

Under the hood, and none of it in the app a Homey runs:

- **A test audit.** Every safety property in `CLAUDE.md` was mutation-tested — the guard deleted, to
  see whether any test noticed — and the ones nothing pinned now are: teardown for every device type
  (the controller's whole `stop()` could be deleted with the suite green), dispatch on the real
  managers, override expiry, the fade-out band, folder failures, key redaction at every log site.
  Each runtime's write queue now runs on the clock a test injects. Both daylight-saving days are
  tested on Copenhagen's zone. A test that hangs now fails after 30 s, and the coverage gate refuses a
  cancelled test instead of passing over it. The coverage floors are raised, with a per-file
  functions floor beside them; the suite is past 2500 tests.

- **Development tools updated** — eslint 10.13, typescript-eslint 8.72, tsx 4.23.15 and the Homey
  CLI 4.6.1, plus `actions/setup-node` 7.1.0 in CI.
- **`homey-api`, the app's one runtime dependency, moves from 3.19.2 to 3.21.0**, taken with a full
  hardware pass on firmware 13.5.3 on 25 October 2026: 122 OK, 0 failed, the same as 3.19.2 that
  morning. What changed for this app is the shape of a non-JSON error (its text moves from `error`
  to `message`; nothing here reads the former) and reconnect handlers that can no longer throw. Its
  new `jsonwebtoken` dependency is never loaded on the local path the app uses.
- **Two vulnerable packages replaced inside the Homey CLI's own tree** with npm `overrides`: `tmp`
  to 0.2.7, and `image-size` to 0.6.2 — a step back on purpose, to the release before the parser
  with the bug existed. `CLAUDE.md` says why the forward fix (2.x) would silently switch off
  `validate`'s image checks.
- **A code review's tidy-up.** All five drivers now extend one `LightkeeperDriver` shell instead of
  carrying the same translator, pair-session host and typed app five times; the override record
  that anchors the four-hour deadline and folds repeats is one function rather than three pasted
  copies; the review screen and the running device read the sun through one `sunAnchorContext`,
  whose cache now rolls over at local midnight rather than UTC and which reads that day's sun at
  local noon — the cache's first ask after midnight is still yesterday in UTC east of Greenwich.
  `GET /sensors/:id/history`, an app Web API route nothing called, is gone, along with the unused
  `writesLightsFrom`, and twenty-one doc comments that had drifted off the code they describe are
  back on it. A Flow the app refuses to delete because it is another device's is no longer counted
  as deleted, and removing a device no longer logs "its Flows cleaned up" when they were not.
- **Five test-tooling fixes.** A daylight driver test failed from mid-October to late February,
  because Copenhagen's sun never reaches the 25° bright end then; it now runs at 40°N. On Node
  24 the coverage script lost `lib/outputs/test-outcome.ts` to the runner's default test-file
  exclusion, which now matches `test-*.ts`. `verify-hardware.mjs` excused any colour that moved on
  a lamp a running device drives as "that device doing its job" — including a Room-sensing Light,
  which writes only `dim`, and that hid the restore failure above; it now excuses only an axis the
  owner can write. `probe-lights.mjs --driver` is repeatable as documented, where it used to keep
  the first and ignore the rest. And `diagnostics.mjs` names the window boundary a schedule last
  fired instead of printing "undefined". `lib/validation/guards.ts`, covered only through the
  validators that call it, had slipped under its per-file coverage floor and failed
  `npm run test:coverage` on a clean checkout; it has a test of its own now.

## 0.6.6

Nothing needs redoing: existing devices get the new settings automatically. **Two visible changes:**
circadian lights now blend smoothly between parts of the day — existing ones are set to *Quick*, the
closest to the old behaviour — and a remote's *Set brightness* button comes out dimmer than before,
because it now uses the same brightness scale as everything else: 60% used to be sent as 60% and is
now sent as about 33%. Raise the button's level, or choose *Same as Homey* (below).

### New

- **Control and Transition in the device's Settings.** How a circadian, Colour Curve or Room-sensing
  Light controls your lights, and its Transition, can now be changed from the device's gear icon
  instead of Repair. Settings and setup are the same setting.
- **Transition: Gradual, Balanced or Quick.** Sets how a value moves between two points — evenly,
  mostly in the middle (the default), or nearly all at once. On the editing step and the review of
  all three engine device types.
- **Every language Homey speaks.** Dutch, German, French, Italian, Swedish, Norwegian, Spanish,
  Danish, Russian, Polish, Korean and Arabic, with each language's own plurals and number formats,
  and right-to-left in Arabic. Logs and generated Flow names stay in English.
- **Icons on every value a device shows**, Homey's own.
- **Brightness scale, in the app's settings.** *Natural* (the default, and how it has always been)
  spreads every slider the way the eye sees light, so 50% looks half as bright — and Homey's own
  slider shows 22% for it. *Same as Homey* sends the number as it was set, so 50% here is 50% there.
  Percentages already set keep their numbers and change what they mean; curves and Room-sensing
  Lights follow within a minute, schedules at their next block. Under *Same as Homey* the lowest
  setting, 10%, really is 10%, which is brighter than the natural scale's 10%. Steps and holds on a
  remote feel the same on either scale.

### Changed

- **Circadian lights blend zone to zone**, with the boundary you set as the halfway point, instead
  of holding each part flat and blending only near the boundary.
- **Colour Curve and Room-sensing Lights look the same as before** — they are set to *Balanced*,
  within 0.016 of the old easing.
- **"Set lights before they turn on" still needs the light test.** A device with no tested lights
  now says so on its page, and behaves as *after* until the test is run from Repair.
- **Counts read as numbers**: "All 3 lights", "1 light is not responding".
- **A remote's *Set brightness* button uses the same scale as every other slider.** It used to send
  its percentage straight to the lamp, so a button at 60% and a schedule at 60% gave two different
  levels. On the natural scale the button is now dimmer; on *Same as Homey* it is unchanged.

### Fixed

- **A switched-off device no longer reports lights as overridden.** It stopped watching its lights
  while paused, so changes made with another app no longer filled its history.

### Under the hood

- `shape(transition, t)` in `lib/support/interpolate.ts` replaces the raised-cosine `ease()`: linear,
  or a normalised logistic with k = 6 (Balanced) or 16 (Quick). Each of the three plan chains gains
  step 1 → 2.
- A circadian runtime evaluates `zoneValueAt()`; `ZONE_RAMP` is gone, its clamp kept as
  `MIN_ZONE_MINUTES`.
- `control` and `transition` are driver settings templated in `.homeycompose/drivers/settings/`,
  applied through `DeviceLifecycle.applySettings()`. The short-lived `lightkeeper_control` picker
  capability is removed from any device that gained it.
- `views/shared/` gains the Transition card and `transition-shape.js`;
  `pair-view-zone-copy.test.ts` runs the view copies against the engine.
- Capability icons are Athom's own, in `assets/capabilities/` (platform §10, §18).
- `BrightnessScale` in `lib/outputs/light-intent.ts`: `toDevice` and `toPerceptual` take the scale as
  a required argument (γ 2.2 or 1); `applyPerceptualDelta` stays on 2.2 under both. Every runtime
  reads it through an optional `brightnessScale` getter, absent meaning natural; the app reads
  `homey.settings` on every call. `POST /brightness-scale` stores it, `GET /` returns it, and
  `/diagnostics`' `semantics` names it. `preset_absolute` is converted in
  `ControllerRuntime.runIntents`, the one submit path a live press and the Test control share.

## 0.6.5

**Read this before updating** if you have a circadian light or a Colour Curve Light that set the
colour of lights before they came on: it stops doing so until you run the new light test once from
**Repair** (below). Until then it changes its lights as they come on, as every device did before.
Nothing else needs redoing.

### New

- **Choose how a device controls your lights.** The last setup screen of a circadian light, a Colour
  Curve Light and a Room-sensing Light asks one question, with three answers:
  - **Change lights after they turn on** — what every device has always done, and the default.
  - **Set lights before they turn on** — lights come on already the right colour instead of changing
    a second or two later. A quick test, **Test my lights**, blinks each light once and lists which
    ones stayed off while being set; only those are ever set in advance. If a light later comes on by
    itself from it, that one light is taken off the list for good.
  - **Don't change lights automatically** — the device works out its values for a remote button or
    your own Flows and leaves the lights alone.

  A Room-sensing Light offers the first and the last only: it sets brightness, and brightness cannot
  be set on a light that is off without switching it on. Run **Repair** to change the answer later.
  This replaces the *Keep these lights up to date* switch; a device keeps the answer it had.
- **A remote button that turns the lights on the way the rest of the house knows they should look.**
  A tenth job, **On – with Lightkeeper**: pick which of your other Lightkeeper devices the button takes
  its colour from and which one it takes its brightness from, and it reads both at the moment you
  press — so a button set up in February is still right in June. Each choice shows what that device is
  producing right now, and warns if the device is also driving the same lights (a Homey device group
  counts as the lights inside it). A switch on the same card makes a second press turn the lights off.
  Everything lands in one change, and if the device it follows is deleted, the button still turns the
  lights on.
- **What each device wants your lights to be, readable from your own Flows.** Every device now shows
  read-only rows for the brightness, colour temperature and colour it wants — and a Room-sensing Light
  how light it is outside — which Homey offers as Flow tags and records in Insights. The brightness is
  the value a lamp is actually sent, so it drops straight into Homey's own *Dim to* card.
- **A Flow card, *Set lights the Lightkeeper way*,** sets a room or a light from two devices at once —
  colour from one, brightness from another — in a single change rather than three visible steps. It
  switches lights on only if you ask it to, and writes nothing if a device it names has been deleted.
- **A Flow condition, *It is dark enough*,** on a Room-sensing Light, using the thresholds you already
  set up. It is never true when the device cannot tell how light it is.

### Changed

- **The setup screens have been redrawn** across all five device types and the settings page, on one
  design system. Cards have a visible edge again; disabled buttons change colour instead of fading to
  an unreadable label; a busy button says so on its face (*Adding…*, *Saving…*); success is a small
  green dot rather than a green panel; a folded room in the light picker shows "0 of 9".
- **A new colour picker**: five across, ten colours to start from — whites from candlelight to bright
  white, and one of each colour — and twenty-five more behind *Show more colours*. Eleven colours are
  new; existing ones keep their names but may look slightly different. *Moss* can no longer be picked,
  though anything already set to it keeps working.
- **A schedule block gets a colour instead of a warmth**, from the same colours. Lights that cannot do
  colour get the matching warmth, so a block does the same thing to every light in the room. Two
  overlapping blocks can be merged from the warning about them, and a schedule's last screen shows the
  day with its blocks on it.
- **"Set brightness too" starts switched on** for new circadian lights, Colour Curve Lights and
  schedule blocks.
- **A Colour Curve Light's last screen** shows the brightness range its points ask for.
- **Room-sensing Light setup is shorter.** Tapping a sensor chooses it and goes straight to the
  brightness screen, which says there if the sensor barely changes or has stopped reporting. With no
  sensor, that screen shows where the sun is today and what the lamps will do as it arrives.
- **Every setup ends on its own Add device button**, and a circadian light's *Put them back* is now
  **Stop preview**.
- **A Homey with no lights** gets a screen explaining it rather than one grey line, and an API key
  that Homey accepts but will not build Flows with stays on screen, masked, with the reason: a key's
  permissions cannot be changed after it is made.
- **Press-to-find is gone** — *"Or press a button to find it"* in the remote list, the screen it
  opened and the indicator on the buttons screen. It was never reliable, and some remotes cannot be
  heard at all. Picking a remote from the list is unchanged.
- **A light that refuses a colour while it is off** is left alone after three switch-ons in a row and
  tried again the next day, instead of being asked hundreds of times a day in a room on a motion
  sensor.
- **A light sensor that stops reporting** now says so on the device after half a day of silence.
- **A Room-sensing Light whose lights push its own sensor brighter** remembers what it has seen across
  restarts and edits, and the settings page shows the count so far.

### Fixed

- **Lights were left alone for hours when nobody had touched them.** Lightkeeper stands down when
  somebody changes a light by hand, and it mistook four ordinary things for that: a light that
  accepts an instruction and ignores it, a light that fades slowly to a new setting, a light reporting
  its old level just after being switched on, and a light fading out as it switches off. In one room
  that meant the lights went unattended for a whole evening while everything reported itself healthy.
  The four-hour release could also be postponed indefinitely by a light that kept reporting. A person
  switching a light on and then dimming it is still recognised.
- **A Light Remote with a *Set colour* button** was unavailable as soon as it was added. Its setup was
  stored correctly all along; any remote stuck this way comes back with every button intact.
- **A Colour Curve Light with a point following sunrise or sunset** stopped changing anything, and
  left the settings page blank. Such points are refused now, and one device that cannot describe
  itself no longer takes the settings page down.
- **Deleting leftover Flows** from the settings page could run without the list being approved first,
  or while Lightkeeper could not read its own devices. It refuses in both cases now.
- **A remote event with no number in it** no longer moves the lights a step.
- **Changing a Light Remote's remote and then having the save fail** no longer loses the old remote's
  Flows.
- **Stopping a circadian light's preview** no longer leaves a warm-white light in colour mode, and
  closing the screen without stopping it no longer makes the next setup restore the wrong lights.
- **Repairing a Room-sensing Light** keeps sensor thresholds you deliberately left at their defaults.
- **A sensor's week** named the wrong days for any week containing a clock change.
- **A Light Remote named with only spaces** got no name at all.
- **A rejected API key** left a connection open on every attempt, and trying one interrupted the check
  on the key you already had.
- **A paused schedule** re-checked all of its Flows twice a day; deleting a Light Remote or schedule
  left a record behind; and one unusual Flow card from another app could stop remote discovery
  entirely.
- **Diagnostics**: the failure list is no longer filled by one expected failure, a device no longer
  reports a brightness it stopped following, memory is reported over time, and Lightkeeper's own log
  no longer fills with routine entries, so a bug report reaches back days rather than hours.
- **Every error a setup screen can show** now goes through the translation files.

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
