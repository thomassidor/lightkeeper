# Changelog

Every release, in full. [`README.md`](README.md#changelog) carries the short version — the current
release in a few bullets and one line for each older one; this is where the detail lives.

Newest first. Pre-1.0, so there are no major bumps for breaking changes: a change that would break
something says so in its own entry instead.

## 0.6.0

A fifth device type, and the first thing in this app that reads a sensor rather than only writing to
lights.

Added:

- **A Daylight light**: it holds its lights at a brightness that depends on how much light is in the
  room already. Two settings — how bright the lights should be when the room is dark, and when it is
  bright — and which of the two is larger is the user's choice rather than a mode, so the same device
  either takes over as the daylight goes or follows the day. It reads `measure_luminance` sensors the
  household already owns, averaging several, and where there are none it reads **how high the sun
  is**, computed from the Homey's own position.
  With no sensor it also asks **when this room gets the most sun** — morning, the middle of the day,
  afternoon, or not at all. The sun's height alone is symmetric about noon, so without that answer a
  room that gets its light at 5pm was treated as though it got it at 7am, and no other setting could
  say otherwise. It is asked as an observation rather than as a compass direction, because somebody
  who lives in a room knows when the light comes in, and because it then absorbs what a bearing
  cannot: an east window with a wall across it gets its sun in the afternoon. "Not at all" is the
  default and behaves exactly as before, and no answer can ever make a room read brighter than the
  sky itself. The question does not appear at all once a sensor is chosen — a sensor measures the
  room, so a model of it would be a guess laid over a measurement.
  Like the two curve-driven types it generates **no Flows** and needs no API key, it only dims lights
  that are already on, and it never switches one on or off — brightness is never written to a light
  that is off, which is measured rather than assumed (platform §12).
- **A schedule window, a circadian end and a curve point can each follow the daylight**, instead of a
  brightness typed in once. One response per device, configured on that device's own screen through a
  card shared byte-for-byte by all four screens that carry it. The brightness that was there stays
  put as the **fallback** for when nothing can tell how light it is — which is the reason the number
  sits beside the flag rather than being replaced by it.
  A schedule reads the daylight once, at its boundary; a curve re-reads it on every tick. That
  difference is stated on the screen, because the two look identical for the first evening.
- **`homey:manager:geolocation`**, and it is used for exactly one thing: the sun's position needs the
  Homey's position. Two synchronous accessors, read at the moment a brightness is computed, and the
  latitude never leaves the Homey. The arithmetic is the standard NOAA solar-position algorithm in
  `lib/daylight/solar-elevation.ts` — pure, no dependencies, and asserted against values astronomy
  fixes independently of any implementation (declination at the poles, `90 −` the latitude gap at
  noon, hemispheric mirroring at an equinox, an hour per 15° of longitude). SDK v3 has no solar
  helper and Homey's own sunrise cards fire rather than answer, so this is the whole of the
  alternative (platform §16).
- **A sky readout on the settings page**, above the per-device cards: the sun's current elevation and
  every watched sensor with its reading **and that reading's age**. It is the fastest check that the
  permission resolved, and the age is the only thing that can reveal a sensor which has stopped —
  because a reading is deliberately never treated as stale.

Fixed:

- **A light whose lamps were switched off could report itself as broken.** Some Philips Hue bulbs
  refuse a colour sent to them while they are off — the bridge answers that the lamp is "soft off" —
  and a circadian or Curve light with pre-staging switched on kept sending it once a minute for as
  long as the lamps were off. Each refusal counted against the lamp, so the device eventually said
  its lights were not responding, and on a device whose lamps all behave that way it took itself
  offline. It happened at no predictable moment and cleared itself the next morning, which is why it
  had gone unnoticed. A refused pre-stage write is no longer counted against a lamp: from the refusal
  alone a lamp that is merely off looks exactly like one that is dead, so it says nothing either way.
  Pre-staging also now stops offering a colour to a lamp that has refused three times running, and
  tries again the next time that lamp is switched on. Found by the light probe run of 4 September
  2026, on four of thirteen colour-capable bulbs behind one bridge.

Two decisions worth reading before changing anything here:

- **The daylight loop terminates, and two constants are what make it.** A light sensor in the room
  whose lamps it drives measures those lamps, so this is a closed loop, and an undamped closed loop
  hunts — a room that pulses once a minute for as long as the app runs. A deadband makes it settle
  (inside the band there is no next write to provoke the next reading) and a slew limit makes any
  residual movement a fade. The app damps that loop and does not remove it; the FAQ says so plainly
  and names the sensor placements that avoid it altogether.
- **The slew is measured from what we aim at, never from what the lamp reports.** Slewing from the
  lamp's own level looks more honest and stalls: on a lamp whose `dim` moves in tenths, every
  perceptual aim from 0.10 to about 0.45 quantises to the same value, so an aim that only advanced on
  a successful write would never leave the floor while the room went dark around it.

Known:

- **The Daylight light's icon and store image are placeholders** — a plain circle and a flat violet
  disc. Both satisfy every automated check and neither is finished work; replacing them is a blocker
  before publishing, recorded in `artwork/provenance.md`, `artwork/asset-spec.md` and
  `docs/homey-review-notes.md`.
- **What a real `measure_luminance` sensor reports is per-integration and not yet established.** The
  two lux thresholds default to 5 and 500, which is a judgement rather than a measurement, and the
  pairing screen shows the chosen sensor's live reading so it is set against something real. T82 in
  the hardware plan is where that evidence comes from.
- **Sunrise and sunset anchors are still refused for curves and schedules**, and are no longer
  *blocked*: the permission is declared and the solar arithmetic is here. What is missing is the last
  step — `resolveAnchor()` wants a minute, and an elevation function gives an angle at an instant —
  plus a decision about what a day with no sunrise means. Half-working would be a curve that silently
  sits at one colour (platform §12).

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


