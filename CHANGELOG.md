# Changelog

Every release, in full. [`README.md`](README.md#changelog) carries the short version — the current
release in a few bullets and one line for each older one; this is where the detail lives.

Newest first. Pre-1.0, so there are no major bumps for breaking changes: a change that would break
something says so in its own entry instead.

## 0.6.0

A fifth device type, and the first thing in this app that reads a sensor rather than only writing
to lights — and then, because none of this had shipped yet, everything that followed it: a full
code review remediated, a week-long recorder built for development use only, and the five defects
that recorder's first real week of evidence found.

*Three later development versions were folded into this entry. Nothing had been published, so
numbering the intermediate states bought nobody anything; the work is in chronological order below,
and the three sections after the first were previously written as 0.6.1, 0.7.0 and 0.7.1. Builds
installed on the reference Homey during that period reported those numbers, which is why the
hardware run records and the evidence archive still name them.*

### Room-sensing Lights, and daylight brightness inside schedules and curves

Added:

- **A Room-sensing Light**: it holds its lights at a brightness that depends on how much light is in
  the room already. Two settings — how bright the lights should be when the room is dark, and when
  it is bright — and which of the two is larger is the user's choice rather than a mode, so the same
  device either takes over as the daylight goes or follows the day. It reads `measure_luminance`
  sensors the household already owns, averaging several, and where there are none it reads **how
  high the sun is**, computed from the Homey's own position. *(The averaging was dropped later in
  this same version — see "Every pairing screen redrawn" below. It reads one sensor.)* With no
  sensor it also asks **when this room gets the most sun** — morning, the middle of the day,
  afternoon, or not at all. The sun's height alone is symmetric about noon, so without that answer a
  room that gets its light at 5pm was treated as though it got it at 7am, and no other setting could
  say otherwise. It is asked as an observation rather than as a compass direction, because somebody
  who lives in a room knows when the light comes in, and because it then absorbs what a bearing
  cannot: an east window with a wall across it gets its sun in the afternoon. "Not at all" is the
  default and behaves exactly as before, and no answer can ever make a room read brighter than the
  sky itself. The question does not appear at all once a sensor is chosen — a sensor measures the
  room, so a model of it would be a guess laid over a measurement. Like the two curve-driven types
  it generates **no Flows** and needs no API key, it only dims lights that are already on, and it
  never switches one on or off — brightness is never written to a light that is off, which is
  measured rather than assumed (platform §12).
- **A schedule window, a circadian end and a curve point can each follow the daylight**, instead of a
  brightness typed in once. *(Removed later in this same version — see "Every pairing screen
  redrawn" below. Following the light in the room is what a Room-sensing Light is for.)* One
  response per device, configured on that device's own screen through a card shared byte-for-byte by
  all four screens that carry it. The brightness that was there stays put as the **fallback** for
  when nothing can tell how light it is — which is the reason the number sits beside the flag rather
  than being replaced by it. A schedule reads the daylight once, at its boundary; a curve re-reads
  it on every tick. That difference is stated on the screen, because the two look identical for the
  first evening.
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
  and a circadian or Colour Curve Light with pre-staging switched on kept sending it once a minute
  for as long as the lamps were off. Each refusal counted against the lamp, so the device eventually
  said its lights were not responding, and on a device whose lamps all behave that way it took
  itself offline. It happened at no predictable moment and cleared itself the next morning, which is
  why it had gone unnoticed. A refused pre-stage write is no longer counted against a lamp: from the
  refusal alone a lamp that is merely off looks exactly like one that is dead, so it says nothing
  either way. Pre-staging also now stops offering a colour to a lamp that has refused three times
  running, and tries again the next time that lamp is switched on. Found by the light probe run of 4
  September 2026, on four of thirteen colour-capable bulbs behind one bridge.

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

- **What a real `measure_luminance` sensor reports is per-integration and not yet established.** The
  two lux thresholds default to 5 and 500, which is a judgement rather than a measurement, and the
  pairing screen shows the chosen sensor's live reading so it is set against something real. T82 in
  the hardware plan is where that evidence comes from.
- **Sunrise and sunset anchors are still refused for curves and schedules**, and are no longer
  *blocked*: the permission is declared and the solar arithmetic is here. What is missing is the last
  step — `resolveAnchor()` wants a minute, and an elevation function gives an angle at an instant —
  plus a decision about what a day with no sunrise means. Half-working would be a curve that silently
  sits at one colour (platform §12).

### Lifecycle, sensor ownership and write cancellation

Fixed:

- Schedules, circadian lights and Colour Curve Lights retain their selected lux sensors for their
  runtime lifetime. Closing pairing no longer changes a saved device's brightness source;
  restarting also acquires the sensors without needing another Daylight device.
- Failed sensor subscriptions no longer expose a permanently cached seed as a live reading.
  Recovery retries start after one second and back off to at most once per minute. Releasing
  the last owner cancels recovery. Successfully subscribed, quiet sensors still do not expire.
- Automatic brightness commands are cancelled when a lamp is switched off or leaves its target
  zone, including commands waiting in an active flush. Eligibility is checked again immediately
  before dispatch. Commands already handed to Homey cannot be recalled.
- A failed runtime start or preview releases acquired listeners and sensor claims. Startup and
  target refresh cannot restore resources after teardown, and late completions cannot re-arm
  implied-on probes or populate the replacement runtime's state.
- Failure to persist an edited configuration restores the previous stored and running plan.
  If recovery also fails, the candidate stays stopped and the device reports unavailable.
  Delayed callbacks from replaced runtimes cannot overwrite the restored plan.

Maintenance:

- Shared startup, teardown and sensor-claim helpers keep ownership rules consistent across the
  four engines. Preview instances have unique ownership IDs.
- Added integration and concurrency regressions over real runtimes, scheduling, adapters,
  sensor ownership and evaluation, with fake Homey boundaries and controlled failures.
- No stored-plan migration or external API change. Hardware checks T91–T97 are documented in
  the hardware test plan and have not been run for this change.

### Health verdicts that compose, and an opt-in recorder

The remediation of a full code review, plus one new opt-in capability. Everything below was
found by reading the code against what its own comments and CLAUDE.md's safety-property list
promised; each fix ships the test its docblock had already claimed existed.

**Health verdicts now compose instead of overwriting each other.**

- A controller learns about its health from two independent places, on two different triggers:
  reconciliation (a Flow was edited, a control would not compile, a reference could not be
  stored) and the lights themselves. Both were written straight to the visible state by
  whichever ran last, and `start()`'s order is buildRuntime → reconcileFlows → assessHealth, so
  the monitor always spoke last. A controller told "a Flow was edited, open repair" had that
  replaced by "1 of 3 lights unavailable" — a different problem, a less actionable one, and
  `partial` also flips the device back to AVAILABLE so the repair prompt disappears from the
  tile. One lamp switched off at the wall was enough, and it recurred on every target refresh
  and every credential change. There is now one ranked verdict function
  (`lib/runtime/verdict.ts`): needs_credential > needs_repair > partial > ready, ties to the
  verdict that names an action. `needs_credential` outranks `needs_repair` because repair WRITES
  Flows (platform §1), so a repair prompt on a dead key sends the user into a flow that cannot
  complete.
- A remembered `needs_credential` is the one state either verdict forgets on request, and it has
  to be both of them — reconciliation classifies a 401/403 that way and the health monitor has
  its own credential branch. Found while writing the test: a stale copy is the most severe state
  there is, so it sat over every later verdict for ever, and the tile went on saying "Lightkeeper
  needs a new API key" against a key that worked.
- The two tick-driven runtimes re-assess when their inputs move. `light-target-adapter.ts` says
  the write-failure streak exists so a runtime does not "go on writing to that lamp every minute for
  ever behind a green tile" — and it did exactly that, because health was assessed at start and on a
  target-set change and nowhere else. A lamp cut at the wall stays `available: true` (platform §6),
  so the fingerprint never moves and the unwritable set was consulted once, when it was empty. A
  Room-sensing Light also re-asks when its daylight SOURCE changes, which is the only thing that
  could ever clear "it cannot tell how light it is" after a household finally gives the Homey a
  location.

**A value that is absent is no longer a value of zero.**

- `Number(null)` is 0 and 0 is pitch dark — the trap CLAUDE.md records for lux, open on all five
  light axes. A live report of `null` became an apparent zero in actual state, and the NEXT
  report then read as "changed by hand, to nothing", so the lamp stood down and stopped following
  its curve until its next power cycle. And `liveValuesOf()` cast a snapshot value straight to
  `number | undefined`: that does not coerce, but it mistypes, and every consumer downstream tests
  `=== undefined` to mean "the lamp never told us" — so a Room-sensing Light counted `null` as a real
  reading, seeded its aim from a perceptual ZERO, and wrote `dim 0.01` to an already-lit lamp
  before fading it back up at 0.05 a tick. One guard now covers both paths.
- A lamp's own power-on report is no longer read as a human override. The settle anchor was
  deleted at the off edge and not re-armed at the on edge, so a bulb power-cycled at the wall that
  reports its level alongside `onoff:true` could be marked as overridden and skipped on every tick
  until its next power cycle — defeating the headline promise that a lamp is the right colour
  however it was switched on.
- Dimming down on a lamp declaring `decimals: 1` no longer writes a value that lamp shows as off.
  The floor defaulted to 0.01, which is the `decimals: 2` representable step wearing a policy
  name; on a tenths lamp it quantises to 0.00 — darkness, written by the one branch whose entire
  purpose is to refuse to write darkness.
- Synchronised group brightness no longer nudges a lamp already on the group target one step past
  it. `advanceDim`'s guarantee that a lamp MOVES is right per lamp and wrong for a group, so the
  one lamp that started in the right place was the one that drifted, on every press.

**Fixed elsewhere.**

- One-tap re-attach no longer offers whichever identical remote came first. The portable
  fingerprint is device-agnostic by design, so two STYRBARs or two BILRESAs tie — and nothing
  excluded a remote another live controller was already listening to. A household with two
  BILRESAs (the re-add case platform §7 exists for) could be told to re-attach onto the one still
  driving another controller. Remotes in use are excluded, and a genuine tie now says so and
  sends the user to repair to choose, instead of promising one tap.
- A save the app could not have loaded back is refused when it is made. The only validator in the
  device layer was the one that runs at load, so a route could persist a plan that the NEXT APP
  RESTART then refused — the device going unavailable saying "set this device up again", days
  later, with nothing to connect it to the action that caused it.
- Deleting a device no longer recreates a `Lightkeeper` folder the user had removed, and no longer
  attempts a folder WRITE from a delete — which, on a dead key, could flip every device to
  "needs a new API key" while tidying up after a removal.
- Sensor ids from a pairing screen are checked against the catalogue, not only for shape. A lamp
  id accepted as a sensor was subscribed to, never reported a lux value, and left the device
  running on the sky for ever while the settings page listed a sensor with no reading.
- A "not found" is no longer inferred from a `404` appearing anywhere in an error message. Homey
  echoes device and flow ids back inside errors, and roughly one UUID in three hundred contains
  `404` between two non-digits — enough for a 409 or a 500 to be read as "already gone", the
  reference dropped, and the Flow left firing where the orphan sweep cannot see it.
- A plan written by a NEWER version of the app now says to update the app, instead of telling
  somebody whose configuration is perfectly intact to set their device up again.
- A hand-edited controller profile with an absurd range no longer hangs device startup: the
  expansion is refused before the array is built, rather than after.
- A "test it now" probe can no longer write to a lamp after its own runtime has stopped.
- Reading the whole Flow list for an orphan count now reports a transport failure, so a dead
  socket does not fail every count and sweep for the rest of the app run.
- `network` as part of a word is no longer read as a network failure, which used to throw away a
  working client on an ordinary `TypeError` from our own code.

**Diagnostics.**

- Per-runtime history of the last 60 control passes and 120 power/override events, with each
  pass's per-target decisions, the sensor inputs behind a daylight pass, and command completion
  outcomes. Kept independently of the short command log, so six lamps cannot erase an hour of
  history in five ticks, and truncation is reported rather than silent.
- Brightness units, snapshot timestamps and API-success semantics are labelled in the export.
- The feedback risk of a lux sensor in the room it drives is explained on all four daylight
  configuration screens, without changing any saved response.

**A seven-day recording, for tracking down something intermittent — and NOT in the app you
install.**

- It is a development tool, and it is built out of a released build entirely: the code, its six
  Web API routes and its settings section are all removed at build time, and the build fails if
  any of it is left. `.dev-build` at the repository root puts it back for a local install. The
  design is in `lib/support/evidence-feature.ts`; the switch is `scripts/build.mjs`. Everything
  below describes what that development build does.

- Off unless started from app settings, stops by itself after seven days, and the deadline
  survives app restarts and reinstalling the same build. Batches are gzipped and AES-256-GCM
  encrypted on the Homey's own storage; every record passes a field stripper and the same key
  redaction the logs use, so an API key cannot reach an archive. Bounded buffers and a 64 MiB
  limit expose loss rather than silently replacing earlier evidence.
- Timestamped observations can be attached from the settings page while it runs, and an archive
  that has stopped can be discarded there. `scripts/evidence.mjs` streams an export to a private
  `.evidence/` directory and analyses it; see `docs/week-long-testing.md`.
- It does not change how often the control loops run. A 60-second maintenance poll that had been
  written alongside it was removed before release: it re-read the ~11.6 MB trigger-card catalogue
  about once a minute for as long as the app ran (platform §15), turning an event-driven app into
  a poller. State-triggered re-assessment does that job instead.

**Repository.**

- CI audits the shipped dependency tree and fails on a new high or critical. CLAUDE.md records
  four accepted moderates and says to re-check at each bump; nothing did.
- `*.css` and `*.js` are pinned to LF. `views/shared/` holds four such files and they are spliced
  byte-for-byte into thirteen LF pair views, so a Windows checkout saw every view as drifted
  before touching a line.
- The manifest's `api` block is now checked against `api.ts`'s exports. It is a name map: a name
  matching nothing gives no build error, no validate error and no test failure — only a 404 when
  somebody presses the button.
- Twelve documentation phrases predating the fourth and fifth device types, two stale claims in
  CLAUDE.md (the version lives in four places, not three; three files carried three different
  wrong line counts) and one safety claim about the hardware script that was true of devices and
  read as one about lamps.

### What a week of real evidence found

Five defects, every one of them found in a single 3.83-day recording from the reference Homey
rather than by reading the code — 58,024 records, nine live devices, and a manifest that said
`dropped: 0` and every tile `ready` while one device had done nothing for 88 of the 93 hours.
The numbers behind each are in the sections below; the full read of that recording was kept as a
document for a while and has since been deleted, its durable findings folded into the code they
justify.

**An override never expired, and one uncooperative lamp muted a device for days.**

- A lamp in the recording accepted every write, acknowledged it, and reverted to its own fixed
  `dim 0.41` / `light_temperature 0.83` ninety seconds later, every single time, whatever it had
  been sent. Nothing distinguishes that from a person, so it was read as one — and an override was
  cleared only by an `onoff` edge, by the target leaving the plan, or by the runtime stopping. The
  "Studio circadian" device therefore stood down for 23.6 h, then 23.1 h, 15.5 h, 15.2 h and 11.0 h
  back to back, lamp on throughout, reporting `ready` throughout.
- `OVERRIDE_EXPIRY_MS` (4 hours, in `lib/outputs/target-state-cache.ts`) is the escape hatch, applied
  lazily by `expireOverrides()` in both runtimes from `applyNow()` and `diagnostics()` — no new timer,
  and nothing reads as overridden after control has resumed. Four hours is a balance rather than a
  discovery: long enough not to fight somebody who dimmed the lamps for an evening, short enough that
  a lamp the app cannot drive costs one evening instead of a week.
- Expiry also drops `committed` / `lastWritten` for that lamp, and that is half the fix rather than
  tidiness. The lamp was moved while the override stood, so an unchanged plan against an unchanged
  *intended* value would have planned nothing, the no-op filter would have dropped it, and the lamp
  would have stayed exactly where it was put — the same silence one layer down.

**Switching a lamp off was read as overriding us, 296 times.**

- The `lamp_off` guard reads the cache's `actualOn`, which only moves when the `onoff` report lands.
  Measured across the recording: this integration reports `dim 0` a **median of 29.9 seconds before**
  the matching `onoff: false` (232 pairs, minimum 29.2 s). In that window the cache still believes the
  lamp is on and the power-settling window has not opened, so the report went straight to
  `noteOverride`. 296 of the 327 overrides in the whole archive were this and nothing else — a false
  badge for thirty seconds each time, and 296 junk entries evicting real history from a 120-entry log.
- A reported `dim` of 0 is now the lamp going off whatever `onoff` has said yet, logged as
  `report_ignored` with `reason: 'dim_zero'`. It needs no clock and no ordering: neither runtime can
  write 0 (`MINIMUM_BRIGHTNESS` is 0.10 perceptual and `litDim()` guarantees a positive brightness is
  never written as darkness), and a person dragging a dimmer to zero switches the lamp off, which
  arrives as `onoff` and clears any override anyway.

**Redaction was destroying records, and `dropped` could not see it.**

- `KEY_MATERIAL`'s `[0-9a-f]{20,}` alternative also matches the decimal expansion of a small number.
  A circadian warmth crossing zero produced `4.829384756102938e-6`, which serialises as
  `0.000004829384756102938` — twenty-one characters — and came out as `{"warmth":0.<redacted>,…}`.
  **93 of 58,024 records in this archive are unparseable for that reason.** The docblock argued only
  that twenty hex characters cannot be a UUID; it never considered a number.
- Invisible, too: the damage happens after `++m.sequence` and the line writes successfully, so
  `dropped` stayed 0 and the settings page, `evidence.mjs status` and the export manifest all reported
  a complete recording.
- Fixed in three places. The pattern requires the run not to follow a decimal point or a digit; the
  two deliberate copies in `scripts/evidence.mjs` and `scripts/probe-lights.mjs` carry the same change
  and the reason; and the recorder now re-parses any line redaction actually changed, counting it in
  `dropped` rather than writing it — so the next such flaw arrives as a number rather than a hole.
  `analyze` reports `malformed` in its interpretation line, and the recording doc says to read it first.

**The 0.03 override tolerance failed at exactly 0.03.**

- `Math.abs(0.83 - 0.86)` is `0.030000000000000027`, so `<= OVERRIDE_TOLERANCE` forgave a bridge three
  hundredths out at one end of the axis and called it a person at the other. The archive has two
  `light_temperature 0.83 vs 0.86` overrides: exactly the rounding the constant exists to absorb,
  which under the bug above meant standing down for good.
- `withinOverrideTolerance()` now owns the comparison for all three sites — daylight brightness,
  circadian temperature/brightness, circadian hue — which also collapses a triplication.

**A daylight feedback loop that ran 95 times, with nothing to show for it but a diagnostics field.**

- Both daylight devices reported `feedbackRisk: 'increasing_sensor_response'` in 100% of samples. The
  kitchen sensor read a median of **1 lux with its lamp off and 680 lux with it on** — it was
  measuring the lamp, not the sky. Every switch-on started a climb: median 5 writes and 225 s to
  settle, worst case 540 s, the response pinned at its own `bright` end in 62.7% of lit samples, and
  all 506 of that device's writes were this. Loop gain was about 3, so the deadband could not damp it
  away; only the response's ceiling bounded it.
- The pairing screen already warned about the configuration, correctly. The device did not. It now
  watches for the loop's signature — we raised the aim, and the reading then rose — and after five
  observations reports `partial` with `state.daylightFeedback`, naming the two remedies. Deliberately
  not "pinned at the bright end": on a sunny afternoon an increasing response sits there legitimately,
  and flagging that would be a false alarm on a well-placed sensor. `feedbackObservations` is in
  diagnostics and in the evidence, so the next recording can be read for it.

**And the memory analysis that was never going to work.**

- `process.memoryUsage()` throws in the app sandbox (platform §17), so every one of the 5,512 health
  samples carries `memory: null` — correctly, since the guard exists to keep the rest of the sample.
  But `scripts/evidence.mjs` still reported `maxRssBytes`, permanently 0 in a shape that looked like a
  measurement, and `docs/week-long-testing.md` promised "memory use", "peak RSS" and advice to watch
  for "growing memory". All four are gone, pointing instead at
  `node scripts/verify-hardware.mjs memory`, which reads the footprint from outside where it exists.

### A whole-house probe run, and the three defects it found in itself

Nothing in the app changed here. A full pass on the reference Homey — `verify-hardware.mjs full`,
then `probe-lights.mjs` over all 55 lamps of 9 integrations — came back with every functional line
passing, and with three faults in the probe itself. They are worth a changelog entry because two of
them left somebody's house changed.

- **A restore could not put two Hue bulbs back.** The probe writes a lamp's snapshot back when it is
  done, and it wrote `dim` first. On a lamp found OFF the snapshot's `dim` is 0 — which a Hue treats
  as soft off, not as a brightness — so every colour and temperature write after it was refused
  outright and the run finished by telling a person to set two lamps by hand. `dim` now goes last
  among the values, where it gates nothing. Replaying the same values in that order restored both
  bulbs exactly, which is the fix's own proof, and `restorePlan()` is lifted out so the order is
  tested without a Homey.
- **It woke a NAS it had already been told it could not switch off.** A Synology DiskStation answered
  the off write with `Device is always-on`, was switched ON one step later for the echo measurement,
  and then refused both writes that would have put it back. The evidence that the change could not be
  undone arrived one write before the damage. A device that refuses to switch off is now never
  switched on — guarded in the one function every write goes through, so a fourth step cannot forget
  it — and the run says so as `PROBE_ONE_WAY_POWER`.
- **Two reporting faults, both of which mislead in the direction of alarm.** A run against a device
  that refused every write published `PROBE_SUSPECT_CACHE` at critical — a finding whose own text says
  to believe nothing else in the report — because it counted lamps that had taken no write as evidence
  that no reading moved. And the headline finding count double-counted run-level findings, printing 4
  over a breakdown of 3. A boolean in the put-these-back list printed as `0.000`.

**The pass also re-based the memory line.** T59 read 68 MB on a freshly installed app where the same
line read 36.6 MB four days earlier, so the 9 September build and the 13 September build were
installed one after the other on that Homey against the same four devices: **67.5 MB and 68.2 MB**.
The app's code is not the difference, and what in the house is was not identified. The ceiling that
fails the line is now 100 MB rather than 50, the line no longer diagnoses a cause it cannot know, and
platform §15 carries the measurements — including the three explanations that were ruled out. The app
is still well over Homey's 30 MB guideline, which is unchanged and known.


### Every pairing screen redrawn, and four engines reshaped to make them honest

The last thing to go into 0.6.0, and the largest. Setting a device up used to put the abstract
control first: two unlabelled sliders standing for a whole day, a function-first grid of every job
crossed with every gesture, two lux numbers with nothing to judge them against, and an API-key chore
before anything of value was visible. Every screen now holds **one control and at most one
sentence**; everything secondary is a row with a chevron; every caveat has left pairing for the
review screen or the device's settings. About seventy per cent of the words on those screens are
gone, and none of them were deleted — they moved.

Each of the five device types is now an unnumbered **intro**, a numbered step per question, and a
**review** that states what will happen before anything is saved. Every row on the review jumps back
to the step that owns it. Fifteen screens are authored where there were eight, four of them shared
by every driver and answered from a payload the driver supplies, so five different flows — three
steps or four, with or without a key — share one file each rather than five near-copies.

**The API key is asked for near the START, not at the end.** The design put it behind the work, on
the reasoning that the key only gates Flow writes at save. That is true and it is the wrong trade: a
user who reaches a four-step review and then cannot produce a key loses everything they just filled
in. It sits after the intro and before step 1, and it skips itself silently when a valid key is
already stored — which is every controller and schedule after the first, since the key is per Homey.

Four engines changed shape, because several of those screens could not be drawn honestly otherwise.

- **A circadian light has three zones, not two ends, and its day follows the real sun.** Morning,
  midday and evening, each with its own warmth and — newly optional — its own brightness. Morning
  ends at sunrise plus an offset and evening begins at sunset plus one, both stepped in quarter
  hours, so the day moves through the year instead of sitting at a fixed clock. `sunTimes()` in
  `lib/daylight/solar-elevation.ts` is the new pure function behind it: the hour-angle solution over
  the same NOAA sequence the elevation already used, answering `null` where no horizon crossing
  exists. That last part is what lifted the `{ kind: 'sun' }` anchor, declared since 0.5.0 and
  refused in three places because a sun anchor accepted by the sanitiser and thrown on by the
  resolver is a curve silently stuck at one colour. All three refusals went together.
  The boundaries are clamped when they are RESOLVED rather than when they are stored: north of about
  60° a short winter day can bring two perfectly reasonable offsets into collision with no edit
  having happened, and clamping the stored value would quietly rewrite what somebody chose. And
  because morning and evening are now independent temperatures either side of midnight, midnight is
  a third ramp rather than a step change.
- **A Room-sensing Light reads ONE sensor, and shows you its week.** Averaging up to eight sounds
  more robust and is not: a cupboard sensor and a windowsill sensor average to a number neither ever
  reported, and the screen could not say whose week the lux range belonged to. The setup screen now
  draws that sensor's own last seven days from Homey's Insights as a 7 × 12 grid, and fills both
  thresholds in from it. This is the fix for a default of 5 → 500 lx that suited exactly one of the
  four sensors in the reference house (platform §16); two of the other three would have sat pinned
  at one end of their range all day and read as "this feature does nothing". The same picture says
  two things it would otherwise take a month to notice — a sensor that barely changes all week, and
  a sensor that has stopped reporting. No new permission was needed: `homey:manager:insights` does
  not exist, `homey:manager:api` covers it, and the app's own token reads a foreign device's log.
  The two solar-elevation thresholds became per-device for the same reason the lux ones already
  were, and `SunPeak`'s `'none'` became `'flat'` — a room with no direct sun still brightens and
  darkens, so it holds the diffuse share rather than nothing.
- **Following the daylight from inside a schedule, a circadian end or a curve point is gone.** It
  put the same sensor picker and lux range on four different screens and gave two device types two
  different daylight behaviours to explain — a schedule sampling at its boundary, a curve following
  on every tick — which looked identical for the first evening. A brightness is a number; a
  brightness that follows the room is a Room-sensing Light. That took `views/shared/daylight-card.*`
  with it, and with it the largest piece of view-splicing machinery in the repo.
- **A schedule's days belong to the schedule, and blocks may overlap.** Seven chips once, above the
  list, instead of seven per block. Overlapping blocks are no longer dropped by the sanitiser: the
  runtime has always resolved them deterministically — the later one wins while they overlap — so
  the screen outlines the region and says so, and Next is never blocked. Deleting a row somebody had
  just drawn was the worse surprise.
- **The controller's grid is inverted.** One row per thing the remote can do, in the order the
  buttons sit, each stating its job in a sentence; "Nothing" is a finished state rather than a
  warning. One rule per gesture is now structural — a row holds one job — as well as enforced in
  `setRules`. Two new jobs arrive with it, both carrying a value: **a set brightness** and **step
  through warm and cool**. Press-to-find is its own bounded screen: thirty seconds, a live "heard
  nothing yet", and "pick from the list instead" always one tap away, because a card-only remote
  cannot be heard at all (platform §4).
- **The palette is twenty-four colours**, eight shown with the rest folding out in place, and the
  default curve is coloured — so the first thing a Colour Curve Light shows is that it does colour.
- **"Select all" in a room stores the ROOM.** Ticking every light in one room and nothing elsewhere
  stores a zone target rather than a device list, so a lamp added to that room next month is picked
  up without re-pairing. Unticking one converts it back, and the review screen states which of the
  two the device ended up with, because the difference is invisible otherwise.

**There are no migrations, and that is deliberate.** Every stored shape here changed, and the one
Homey running this app starts from a clean slate — so all five migration chains were reset to
version 1 with empty step tables rather than extended. A device carrying an older plan comes up
unavailable with a message, which is the signal to delete and re-add it. Nothing has been published,
so nobody else is carrying one.

**Every screen was then rendered and held against the design canvases**, which
is the only check that catches a screen that boots and draws wrongly —
`npm run render:views` draws all 28 to `.views/` and `docs/design/` is what they
were compared with. Ten differences came out of it, and two were defects rather
than polish:

- **Two warmth sliders ran backwards.** The job editor and the schedule block
  placed the knob at the raw `warmth`, where 1 is the WARMEST end (platform §6),
  on a track that now runs candlelight-left to daylight-right — so the handle sat
  over the opposite colour to the one it stood for, captioned "Coolest" at the
  warm end. Nothing had looked wrong while the track was a plain fill, because a
  fill says nothing about which end is which. Both now invert at the same seam
  the circadian day screen already used, and all three read the same way round.
- **The sensor detail screen named its sensor twice**, once as the heading and
  again inside the card directly under it, which reads as two different sensors.

The other eight are the design's own shapes, applied: sliders carry their axis
as a gradient with no fill, so the whole range is visible rather than "this much
of the way along"; a control's title is sentence case with its value on the
right, not a small-caps section label; swatches are four across rather than
eight in a row that fell under the touch minimum; the curve chart carries a
handle per point and an Off-to-Full axis; the week grid is the app's own violet,
stepped into six shades so the pattern is legible; a schedule overlap is an
amber notice with its consequence on a second line, and the region it names is
outlined dashed; the sensor picker's two options are stacked full width with the
chosen sensor's live reading beside the name; and the remote picker says how
many separate presses the Homey can hear from each remote, which is the line the
README has promised since 0.1.0 and the rewrite had dropped.

**And then it was run on a real Homey, twice — Studio and Garage — which found two
more.** Both were in code the rewrite had added, and neither was reachable from
a unit test:

- **Three drivers called catalogue methods that do not exist.**
  `catalog.devices()` and `catalog.getDevice()`; the methods are `allDevices()`
  and `device()`. Six call sites, all of which compiled, passed the suite and
  validated at publish level, because every driver's `private get app()` was
  typed `any` — so `this.app.catalog.anything()` type-checked. On hardware they
  threw the first time a real screen asked, and the Room-sensing Light's sensor
  picker could not list a single sensor. The accessor is now typed
  `LightkeeperApp`, which is what `lib/app-contract.ts` has existed for since
  0.5.0 and what the drivers had never used; typing it caught a second defect on
  the spot, a re-attach that passed a possibly-missing device into discovery and
  would have left a controller with no mappings at all.
- **The hardware pass itself was pointed at three handlers that no longer
  exist**, and one of its assertions had been deliberately reversed by this
  release: it required the later of two overlapping schedule blocks to be
  dropped. Both are now what the screens do.

Two smaller things fell out of the rewrite and are worth recording. **No view assigns `innerHTML`
any more** — the two that built card markup as strings now build nodes, which took `escapeHtml()`
with them and turned "every interpolation is escaped" into the stronger "nothing is interpolated";
the safety test keeps its allowlist machinery with an empty allowlist. And the **warmth ladder was
inverted** in three places: higher `light_temperature` is warmer (platform §6), so a midday warmth
of 0.18 was reading as "Warm" beside a blue swatch. Storage keeps the platform's convention and the
slider reads Candlelight to Daylight, which is the way round the design draws it.

### The screens held against the design again, with Homey's chrome in the picture

The redesign above was checked against the design canvas by rendering every screen on a white page.
That render left out the one thing the app does not draw and cannot change — **the sheet Homey puts
around a pairing view**, with its own header and its own `← Previous` / `Next →` footer — and the
omission was not neutral. Held against a design that included the chrome, an app-drawn full-width
`Next` looked like the design's own, and nine screens shipped drawing a **second Next** below the
fold of a sheet that already had one.

`npm run render:views` now reproduces that sheet, and takes the buttons from each driver's own
`driver.compose.json` rather than from a list kept in step by hand. It also renders each driver's own
`intro`, light picker and review: those three are one FILE and five SCREENS, and keyed by file name
alone the contact sheet had been drawing the circadian intro five times over.

What that turned up, screen by screen:

- **The duplicate `Next` is gone** from the intro, the light picker, the circadian day, the curve,
  the schedule blocks, the remote picker, the buttons screen and both daylight steps. The light
  picker's "N chosen" line now carries what the disabled button used to say. Two screens keep a
  button — the review, which creates the device, and the key screen, which validates the key — and
  both stopped declaring a `navigation.next` so Homey draws none beside it. **On the key screen
  that was a bypass, not just a duplicate**: Homey's own Next walked past an empty field and the
  flow carried on with no key until the review failed to save.
- **`font: 600 12px/1 inherit` is invalid CSS**, and every browser drops the whole declaration —
  `inherit` is a CSS-wide keyword and may not be a component of a shorthand. Seven rules shipped
  with it and rendered at the inherited 16px regular: the day and time steppers, the schedule's day
  chips, both Add buttons, the Remove links. Measured in headless Chrome, then written as longhand.
  `pair-view-styles.test.ts` now fails on the pattern.
- **The curve chart drew its point handles outside itself.** A point at full brightness — which is
  every point while "Set brightness too" is off, the default — was positioned at `bottom: 100%` and
  pulled up by a margin that does nothing to a bottom-anchored box, so the whole row of handles sat
  above the chart and over the heading. Seen on hardware before it was seen anywhere else.
- **Selected things look selected.** The open card on the circadian day, the curve, the schedule
  block and the daylight response now carries the accent border the design draws — all four were
  hairline-bordered like every other card, so on four screens nothing said which of the list below
  was being edited. The schedule's selected block is taller and haloed on its timeline; the day
  chips are filled rather than outlined; a chosen colour swatch is ringed in the accent rather than
  gapped in white; the job editor is seven cards rather than seven radio rows.
- **The rules that were missing.** A `Set … too` switch now always sits under a hairline, the
  schedule's Remove is centred under one, and a list of rows is inset by its card so the line
  between two rows stops short of the card's edge instead of cutting it in half. The intro's
  numbered decisions lost the three rules they had: the design spaces them, and a hairline turned a
  promise about what is coming into a settings list.
- **Colour swatches were washing out.** The palette is stored as Homey's hue and saturation, and a
  near-white is saturation 0.05 — which `hsl()` paints as grey. The two whites rendered as two
  indistinguishable greys on the screen whose whole job is to show that this device does colour.
  Saturation is now lifted off zero for display and lightness falls faster, in the one formula both
  the driver and the curve chart use.
- **Every heading had 4px under it** and the design draws 16, so a title read as a label on the card
  below rather than as the name of the screen. Steppers are bare glyphs rather than outlined boxes,
  an unticked checkbox has a darker edge than a form field, and chevrons are lighter than the text
  beside them.
- **A light in no room, and a room with no sensor, are named.** `lib/` had hardcoded the English
  word `Unassigned` for the first, which the translation rule exists to catch; the view now names it
  and greys it. The sensor picker lists every room rather than only the rooms that have one, because
  which rooms have none is half of what that screen answers.
- Smaller: the pushed job editor commits on every change rather than on a `Done` button Homey's own
  back arrow could bypass; the listening screen says "Heard nothing yet" from the first frame
  instead of after thirty seconds of nothing; the try-it screen's time, label and strip are one card;
  the daylight review's second end carries a swatch.

### The process documents cleared out, and a guard so the build stops shipping strays

The repository had been carrying the record of building the app beside the app: a 1,290-line code
review, a launch review it had already absorbed, the twelve-file remediation archive that produced
0.5.0, the iteration canvas the pairing redesign was argued out in, and 1.4 MB of screenshots of
screens that no longer exist. All of it finished, none of it bundled, and the reader of a `docs/`
index had to decide each time which documents described the app and which described its past.

Deleted — git history keeps every word — after four rescues, because most of the argument in those
documents turned out to be duplicated in the code that it explains, and the rest had to be moved
before it could be dropped:

- **`docs/open-work.md`** is new and is what the code review was still being
  kept for: tests owed for seven launch-review fixes, two one-line defects still present in the
  tree (a `targetIds` that defaults to writing nothing, and a `pendingColor` never read), the
  fifteen structural items, and three questions only hardware can answer. It was on line 66 of
  1,290 and is now the whole file.
- **`docs/decisions.md`** is new and holds the five arguments shipped code
  still cites — why `flow_enum` was not folded into `flow_fixed`, why an app-level `type: "device"`
  argument is declined **and what a fix would need**, why an unevaluable filter key fails closed,
  how `InvalidRangeError` reaches the user, and the two things the remediation deliberately did not
  do. The three code comments that used to point at the deleted archive now carry their own reason.
- **Four invariants moved into `CLAUDE.md`'s safety list**, where the other six already were: a
  credential is validated by a real Flow write and never by a read, folder work never blocks a Flow
  write, nothing survives teardown, and the Test control works before save and without Flows.
- **The design README absorbed the iteration canvas's argument** — the four turns, and the reason
  the day editor ended up with two handles: *"'warmest' is a single value the day passes through
  twice, but a single dot at 21:00 reads as one moment."*

**And one thing that was not tidiness.** `.homeybuild/` was found holding a stale `print.pdf` and a
`views.zip` of screens deleted three commits earlier — 3.6 MB that would have shipped to
households, because the Homey CLI honours `.homeyignore` and does not consult `.gitignore` at all.
That is the same way 136 KB of review documents shipped once before. `scripts/build.mjs` now checks
`.homeybuild/`'s top level against an allowlist and **fails the build** on anything else, naming it
— an allowlist rather than a denylist, because the file that ships is always the one nobody thought
about.


### What the memory number is actually made of

A deep look at the app's footprint against Homey's 30 MB guideline. **The headline is a negative
result, and it is the most useful thing here: the app's own code is not what puts it over.**

The evidence, all gathered on one Homey on 14 September 2026:

- **The 9 September build was reinstalled alongside HEAD and measured the same.** That build's own
  test line recorded 36.6 MB five days earlier; on the same Homey, against the same five devices, it
  read **80.7 / 73.6 / 72.9 MB** where HEAD read **80.1 / 73.9 / 71.4 MB**. Same code, same house,
  five days, twice the number.
- **What had changed was the Homey**: 10.6% free memory (0.20 of 1.85 GB), 459 MB of swap in use,
  312 MB of app memory already swapped out, and a `homey` core process holding 476 MB.
- **Three restarts of one identical build read 71.4, 73.9 and 80.1 MB**, so nothing smaller than
  about 10 MB is measurable here from a single reading. Several single-number comparisons in the
  older records cannot bear the weight they were given.

Added, because none of the above was answerable before:

- **The app can now see its own memory, and `/diagnostics` reports it.** `process.memoryUsage()`
  throws in the app sandbox and `/proc` is not mounted at all, so RSS genuinely cannot be read from
  inside — but `v8.getHeapStatistics()` and the per-space split can, and they are the only signal
  that distinguishes *holding* a parsed catalogue from *having parsed* one, which PSS cannot.
  Three boot marks come with it: the app's JS heap is **15.2 MB with no devices**, of which
  **8.8 MB is spent importing its own modules** before `onInit` runs.
- `process.resourceUsage().maxRSS` is reported but documented as unusable: it read an identical
  105.3 MB across an app restart and two reinstalls, because it is inherited from the app-runner
  parent through `fork()` rather than reset for the app.

Tried and reverted, recorded so nobody spends the day again:

- **Incremental parsing of the flow-card catalogue** — the lever the platform reference had named as
  the only one left. It was built and it worked: byte-exact against `homey-api` across all 1832
  cards, and on a cold process it cut the read from **+16.88 MB of RSS to +0.10 MB**. On hardware it
  changed nothing, because the 11.6 MB payload the reasoning rested on is now **1.0 MB**, and a 1 MB
  parse fits in heap slack that is already there. Reverted rather than kept for a theoretical house.
- Two findings survive it: the card endpoint has **no server-side filter** (nine query shapes tried
  against the live Homey, all returning byte-identical full bodies), and Node's global `fetch` is
  undici, whose lazy initialisation alone costs **+21.24 MB of RSS** against `node:http`'s 6.81 MB.

Fixed, and each of these is real regardless of the number:

- **A whole-Homey device re-parse on every re-subscribe.** `makeCapabilityInstance` asks `homey-api`
  to refresh every device in the house when the device it is called on is more than 2.5 s stale, and
  a device served from cache always is — so every catalogue change, re-attach and client rebuild
  queued a full `getDevices()`. Reading the one device fresh costs a single round trip instead.
- **A sensor's Insights week was being cached forever.** The `insights` manager is connected, so a
  week of lux samples per sensor was retained for the life of the client to draw a pairing screen
  that closes seconds later — and the cached copy meant the screen redrew yesterday's week.
- **A rate-limit map that was never cleared.** `lastLoggedAt` kept an entry per (device, capability)
  that had ever failed a write, for the adapter's whole life.
- **Local artefacts could still ship to households.** `.views/`, `.probe/`, `.designexports/` and
  `views.zip` were gitignored but not ignored by the packager, so rendering the pairing screens and
  then installing would upload them. A test now fails if `.gitignore` grows an entry that
  `.homeyignore` does not account for — the companion to the build-output allowlist above, catching
  the same class of mistake one step earlier.

Two maps that look like the same leak and are not — `targetGenerations` and `writeGeneration` — now
carry the reason they are deliberately never deleted: both are compared against a value captured
earlier, and removing an entry would make a stale closure compare equal to a fresh one.

For scale, every app on that Homey: Spotify 10.5 MB, Circadian Lighting 13.3, CountDown 13.3,
IKEA 21.3, Hue 33.0, Reolink 61.8 — median 27.2 across 32 apps, with Lightkeeper second. A reading
is only meaningful next to that list.

### A control app, and what it proved about the memory number

A second memory pass, starting from nothing and deliberately re-deriving what the first one had
concluded. The method is the finding: **a do-nothing Homey app was installed beside Lightkeeper and
both were measured in the same minute.** An absolute reading on a Homey at 11% free memory is worth
very little — three restarts of one build span 9 MB — but a difference between two apps read seconds
apart survives that, because both are subject to the same machine.

The whole ladder is below; the investigation document it came from has since been deleted, and what
survives it is `docs/homey-platform.md` §15.

- **An empty Homey app — `require('homey')` and an empty `onInit` — costs 27.6 MB of PSS.** Homey's
  guideline is 30 MB.
- Layer by layer on one process: `require('homey-api')` +0.1 MB, the first API client **+8.8 MB**,
  connecting five managers +1.7, reading 1816 flow cards +10.5, reading 119 devices +1.5, and a
  **second API client +0.0**.
- Left idle, that control app settled at 43.5 MB having built two clients and done five bulk reads —
  while Lightkeeper with no devices sat at 44.3 MB. **The app's own code is about 1 MB of the
  difference.**
- The cost is the transport libraries, not Athom's client: `socket.io-client` alone is +13.7 MB of
  RSS to require, `node-fetch` +10.2, and the whole of `homey-api`'s local client +18.1.

Two recorded assumptions did not survive:

- **"V8 never gives the pages back" is a laptop fact, not a Homey one.** PSS was observed *falling*
  11.8 MB on an idle process with nothing freed, and repeat catalogue reads cost +2.3, then +1.2,
  then +0.0 MB. A pressured kernel reclaims. Avoiding a transient peak is worth much less than the
  platform reference assumed, and §15 now says so.
- **Peer apps are not smaller; they are paged out.** Lightkeeper is the only app on that Homey with
  a `pssSwap` of zero, because it is the one being restarted. Spotify reads 10.1 MB resident and
  8.8 MB swapped; on `pssTotal` the median app is ~36 MB and Lightkeeper is second of thirty-two.
  Comparing a freshly restarted app's `pss` with a week-old one's is the easiest mistake here, and
  the first draft of the investigation made it.

Fixed along the way, each because it is right rather than because the number moves:

- **The write client's socket was never closed.** Four sites dropped the reference without calling
  `destroy()`, and a fifth replaced a live client with a new one — so every credential failure,
  every cleared key and every re-minted key left an orphaned socket.io connection open for the life
  of the app, and shutdown tore down only the read client. All five now close the socket first.
- **The `insights` manager is no longer connected at boot.** `connect()` opens realtime
  subscriptions; it does not enable requests — which the app already relied on elsewhere without
  noticing. Its one use is a week of history for a Daylight pairing screen, and there is nothing
  live to subscribe to. Verified on hardware: all four lux sensors still return a full week.
- **One `Intl.DateTimeFormat` per timezone instead of one per call.** Constructing one allocates in
  ICU's native arenas — memory no heap profile can see — and it was being built on both 60-second
  tick paths for the life of the app.

### Two things the light picker got wrong, both seen on a real Homey

Neither of these ever shipped — both are defects in the pairing rewrite above, found by opening the
screen on hardware rather than by any test — so the store changelog and the README's summary of
0.6.0 are unchanged. They are recorded here because the record is what this file is for.

- **The light picker opened with `target.deviceIds is empty` printed across it.** The screen pushes
  its whole selection to the driver on every tap, and the first push is the empty one it opens with
  — which the driver refused as an invalid target and the view showed as a red banner, before the
  user had touched anything. Nothing ticked is a STATE of that screen, not a failed save: the driver
  now answers an empty device list by clearing the session's target and returning nothing. The round
  trip still happens rather than being skipped in the view, because a repair session arrives with a
  target already chosen and unticking the last light has to forget it. A saved target of no lights is
  still refused, by the save handler that always did it ("Choose some lights first"). The count line
  under the list — "Pick at least one light" — is what says so on screen, which is what it was for.
  The view also clears the banner on the next round trip that works: only reloading the screen used
  to, so one failure left a red line over a selection that had since been accepted.
- **A room could be opened and never put away again.** The header of an open room did nothing, so a
  house of 54 lights could only ever get longer as you looked through it. The name and the count are
  now one button that collapses the room, with the same chevron every other row in the app uses,
  turned a quarter when the room is open; `Select all` stays its own button beside it. What the user
  says outranks the ticks: a room opens itself when something in it is chosen, which is what a repair
  session wants, but a room collapsed by hand stays collapsed — otherwise one it had a light ticked
  in would spring straight back open and the header would look broken. Searching still opens
  everything that matches, because a folded room containing the light somebody just typed the name of
  is a search that did nothing.

### A pointer to the Room-sensing Light, wherever a brightness is typed in by hand

Nothing here has shipped either — 0.6.0 is unpublished — so the store changelog and the README's
summary are unchanged again. The store entry already says every setup screen was redrawn, and one
line of help on four of them does not change what the release is.

- **Four screens that ask for a brightness now say what the fifth device type is for.** A schedule
  block, a circadian zone, a curve point and a button's "A set brightness" each take a number that
  then never moves, and the device that makes a brightness follow the room is a separate thing in
  Homey's add-device list that nobody browsing these screens has any reason to have seen. Each of
  them now carries one italic line under its slider: *Want this to follow the room instead? A
  Room-sensing Light sets brightness from how light it already is.* It names the device type as
  Homey lists it, so it is something the reader can go and add rather than a capability they have to
  go hunting for.
- **`.tip` is a new shared primitive**, in `views/shared/base.css` beside the toggle and the slider,
  because a pointer written four times is a pointer that drifts four ways. Deliberately not a `.msg`:
  a message takes a coloured ground and reports something that just happened, and this is an aside
  nobody has to read to finish the screen. The circled `i` in front of it is drawn in CSS rather than
  set as a glyph — a character the phone's font does not carry renders as a box — and it is a
  pseudo-element rather than a child span, so Homey's own `data-i18n` pass can fill the element's
  text without writing the mark away.
- **The schedule screen's render fixture now opens its brightness control.** The other three already
  set theirs on purpose, so `npm run render:views` drew this line on three screens out of four; a
  control that is folded away in every fixture is a control the contact sheet cannot show anything
  about.

### Five investigation documents deleted, and what they were hiding

Five documents in `docs/` were narratives of how a conclusion was reached, not references anybody
consults twice: `week-long-testing.md`, `decisions.md`, `evidence-findings.md`,
`memory-investigation.md` and `open-work.md`. 812 lines, cited from 29 places. Deleted — and
deleting them was the thing that surfaced what follows, because every citation had to be read to be
repaired, and several turned out to be repeating something the code had stopped doing.

Two defects fixed, both carried in `open-work.md` and cited by nothing in code:

- **A ramp could be started with no lights to write to.** `RampEngine.start` took `targetIds`
  optionally and the controller read it as `(ramp.targetIds ?? [])`, so an omitted argument meant
  "write to nothing": a hold that ticked for its full ten seconds, reported itself as a ramp that
  ran, and moved nothing. The one caller always passed an array, which is why it was never seen.
  Required now, copied on the way in so a caller's later mutation cannot retarget a live hold, and
  pinned by two tests.
- **A dead field in the circadian runtime, and three comments explaining the file in terms of a
  method that does not exist.** `pendingColor` was written, deleted at five sites and cleared at
  teardown, and never once read; the hue/saturation pair is really committed from the two outcomes
  of the same batch. The comments called that mechanism `noteColorWritten`, which appears nowhere in
  the repo. Field removed, comments rewritten to describe what the code does.

What the deleted documents knew that nothing else did was folded into the places that depend on it,
rather than into a sixth document:

- **`docs/commands.md` gained the recorder** it had been silently missing while claiming to be every
  command — `scripts/evidence.mjs` in full, the `.dev-build` switch, the archive's limits (seven
  days, 64 MiB, 512 KiB pending, 32 KiB per record, a 15 s flush), why it is encrypted, and
  **read `malformed` first**: a run reporting `dropped: 0` can still have lost records on the way in.
- **`docs/homey-platform.md` §15 gained the only memory number that means anything** — an empty
  Homey app costs 30.6 MB of PSS against a 30 MB guideline, and this app's own code is under 1 MB
  above a control app that has made the same calls — plus the control-app method and its four traps,
  and four strategies recorded as "do not attempt", with the measurement behind each.
- **"V8 never gives the pages back" is no longer stated as current.** It is true on a laptop and
  false on a Homey, where PSS was watched falling on an idle process. `CLAUDE.md` asserted it as the
  live reason for two design choices and only retracted it twenty lines later; §15 said it twice and
  corrected itself in two blockquotes. Both now lead with what holds.
- **Three questions only hardware can answer now sit at the guards written for their worst case** —
  Hue's power-on event order at `PRE_STAGE_CHECK_MS`, whether `homey-api`'s socket reconnects by
  itself at the read-client rebuild, and what a `decimals: 1` lamp does with `dim 0.01` at `litDim`.
  A guard that stands in for an unanswered question should say which question.
- **Two refactors that have been proposed twice are recorded as answered** in `CLAUDE.md`: no base
  class for the four runtime managers, no migration-step factory.

And the stale claims the sweep turned up on the way:

- **The FAQ told users to open a settings section that does not exist in their app.** The week-long
  recorder is stripped from every non-development build; the diagnostics answer now describes only
  what a user actually has.
- **Four pair views claimed "every `innerHTML` site in the app escapes correctly."** There are no
  `innerHTML` sites; that was the point of the rewrite that removed them.
- `CONTRIBUTING.md` said sixteen platform sections where there are seventeen; `CLAUDE.md` said a
  shared view block is edited in one file instead of thirteen, where it is 56; the contact sheet's
  note said thirteen pair views where there are fifteen; two `typescript-eslint` pins named 8.68.0
  against a lockfile on 8.69.0; the hardware script was credited with fifteen `setCapabilityValue`
  calls and has fourteen; and `docs/design/README.md` opened with a superseded draft saying **one**
  thing departs from the canvas, forty lines above the list of six.

### Three device types renamed

- **"Light controller" is now "Light Remote", "Curve light" is now "Colour Curve Light", and
  "Daylight light" is now "Room-sensing Light".** Nothing about what any of them does changed — the
  driver ids, stored plans, generated Flows and mappings are untouched, so an already-paired device
  keeps working and keeps whatever name its owner gave it. A device added from now on gets the new
  type name in the Add-device list and on its pairing screens. "Circadian light" and "Light
  schedule" are unchanged. Entries for 0.5.2 and earlier keep the names those releases actually
  shipped under.
- **The word "controller" leaves every string a user reads.** The settings page's section is now
  **Light Remotes** rather than **Controllers**, and the tile text a device shows when something is
  wrong stopped naming a device type it might not be: `state.needsRepair`, `state.disabled` and
  `state.noTargets` are reached by all five device types through the shared device layer, so a
  paused schedule and a Room-sensing Light were both being told they were a controller. They now say
  "this device". The three that really are the remote's own — no configuration, the source gone, and
  the re-attach offer — name the Light Remote or the physical remote, whichever they mean.

### The fold-out colours on the curve screen drew as hairlines

- **"Show more colours" opened a rainbow strip instead of sixteen swatches.** The fold-out grid is
  `class="swatches more"` and the button that opens it was `class="more"`, so the view's own
  `#cv-root .more { display: flex }` — written for the button, and sitting later in the file than
  the shared base's `#cv-root .swatches { display: grid }` at equal specificity — won the cascade and
  applied to the grid as well. The sixteen colours were laid out as one flex row and squeezed to
  **2px wide** (measured in headless Chrome, against 36 x 28 now), which read as a deliberate
  spectrum bar rather than as a broken control: the eight-column grid was still declared, and still
  applied to nothing. The button is `.morelink`, and the comment above the rule says why it may not
  go back. Only the Colour Curve Light's screen draws that grid, and no other view carries the
  colliding class.

### The curve screen's chart, and the day a new one starts with

- **The chart blends its colours now, because the engine always did.** A coloured segment fades from
  one palette colour to the next — `mixColors()`, across the disc rather than round the rim — but
  the pairing chart held each colour flat and snapped at the halfway mark, on the argument that a
  blended hue is no palette entry and a screen should not draw a colour nobody could have chosen.
  That is the wrong question: the chart's job is to show what the ROOM will do, and the room is
  blended. It drew five bands where the lights fade through every shade between them. The view
  carries a hand-copied duplicate of that maths — it repaints on every edit and cannot ask the
  driver — so the new test compares all twenty-four bars against the engine itself rather than
  against remembered values, which is the only thing that fails when the copy drifts.
- **The handles are gone from the chart.** A dot per point with the selected one filled, on the
  argument that the chart is the only place the shape is visible. At 390px the five of them sat on
  top of the bars they were drawn from, and a point at full brightness had to be tucked back inside
  the top edge to stop it hanging over the heading. The bars are the shape, the dashed line says
  which point is open, and the card under it names that point.
- **A new Colour Curve Light pairs with brightness switched on, and the five default points carry
  one**: 44% at 06:30, 80% at 09:00, 64% at 14:00, 94% at 19:00, 36% at 22:30. A flat day of colour
  is a picture of one axis — every bar full height, the Off-to-Full gutter hidden, nothing on the
  screen saying the second axis exists. A dim dawn rising to a bright evening and falling back to a
  low violet night is the shape a curve is for. Repairing an existing device is unchanged: it reads
  the stored plan, so a curve saved without brightness keeps none rather than having five values
  invented for it.
- **Switching brightness off no longer forgets what the points held.** It is all-or-nothing by
  design — the engine interpolates brightness only where both ends carry one — but switching it off
  cleared all five values and switching it back on wrote a flat 80%, so one accidental tap destroyed
  the shape with no way back inside the session.


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
