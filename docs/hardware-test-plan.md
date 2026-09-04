# Hardware test plan

What to do before a release, on a real Homey. About 15 minutes plus the script's run.

**Every line is numbered `T1`, `T2`, … and a number is never reused.** They are not in sections any more, so a line keeps its number when the pass around it changes. Old reports written against the previous `section.line` numbering are still readable — the mapping is in [`hardware-test-coverage.md`](hardware-test-coverage.md#the-old-numbering).

## 1. Set up

1. **Mint two Personal API Keys.** my.homey.app → this Homey → Settings → API Keys → New API Key.
   - One for the **app** — paste it into Homey settings → Lightkeeper.
   - One for the **script**, with **full access** — it reads devices and zones, reads and writes Flows, and calls the app's own API. A key's permissions cannot be widened later.
   - They must be different: a key holds a single session, and two holders evict each other.
2. **Install:** `npx homey app install`. On a bare `× Missing File`, try `--clean`; if `--clean` fails, try without it. Neither is always right.
3. **Pair one device by hand** — any type. The script builds the rest, but nothing else puts a real pairing sheet in front of you. Note anything that looks or reads wrong.

## 2. Run the script

```bash
node scripts/verify-hardware.mjs spike       # first — can it reach the Homey?
node scripts/verify-hardware.mjs memory      # the footprint, on its own — read-only
node scripts/verify-hardware.mjs full --yes  # then — the rest of the pass
```

**Safest: write the config file yourself**, in an editor, so no key is ever typed at a terminal
prompt. Create `scripts/hardware-env.json` (gitignored):

```json
{
  "address": "http://192.168.1.23",
  "key": "the key you made for the script",
  "appKey": "the key the app holds — omit this line to skip T35-T41",
  "room": "Studio"
}
```

`room` keeps the test lamps to one room, and is the one containment worth setting. The pass switches
lamps on and off, writes colours to them and power-cycles one, so without it that happens to
whichever lights sort first across the whole house — including lamps your own Lightkeeper devices
drive. Omit it to use every room.

If the file is missing the script asks for the values instead and offers to save them. It hides
keys as you type, but a terminal that mangles that would put a live credential in your scrollback —
so prefer the file.

`full` **builds one of each device type**, tests those, and **deletes them again** at the end. It
names everything it builds `[verify] …` and only ever touches devices carrying that mark, re-checking
it against the Homey immediately before each permanent delete — so a controller, schedule, circadian
or Curve light **you** paired is never chosen, never written to and never deleted. You can run this
on the Homey you live with.

Three things it still does to the whole Homey, because they cannot be scoped to one device:

- `credential` removes the app's stored API key and puts it back, and there is one key for the whole
  app. Every controller and schedule on the Homey — yours too — goes to "needs credential" for up to
  a minute and then recovers. Nothing is deleted.
- `restart` restarts the app, so every Lightkeeper device is briefly unavailable.
- The lamps are shared. Set `room`.

If it says a device type from an earlier run is still there, it reuses that one rather than building
a second — run `teardown --yes` first if you want it rebuilt. A device of yours never counts: the
pass builds its own alongside it.

**Paste its whole output into the report.** Every line is numbered. `OK` and `SKIPPED` need nothing from you; `SKIPPED` means that line was **not** tested.

## 3. Check these yourself

The script cannot do these. Report each by its number.

- [ ] **T3** Devices → Add device → Lightkeeper lists five device types, with five **different** pictures. (The Daylight light's is a PLACEHOLDER for this release — a flat violet disc, and a publish blocker recorded in `artwork/provenance.md`.) (It draws no icon at all from a CLI install — that is normal and resolves on publish.)
- [ ] **T9** Press the mapped button. The lights respond.
- [ ] **T10** Hold the ramp button. It ramps, and **stops when you let go** — and never runs longer than about 10 seconds.
- [ ] **T11** Turn the dial. The lights move by a sensible amount — **not** straight to full.
- [ ] **T53** Run `npm run render:views` and open `.views/index.html`. Every pairing screen, on one page. Anything that looks wrong, say which screen. *30 Aug 2026: 11 screens rendered; the two new ones (`curve/curve.html`, `circadian/ends.html`) were read and are correct. The other nine still want a human eye.*
- [ ] **T54** Anything you noticed while pairing by hand in step 1 that looked or read wrong.

## 4. This release

*Rewritten each release — what is new or risky this time. Its lines carry on from the highest number used so far, and are retired rather than reused when the next release rewrites this section.*

**0.6.0 — a fifth device type, and the first thing in this app that reads a sensor.** Most of it is
provable without a Homey and is: the solar arithmetic is asserted against values astronomy fixes
independently, the two anti-hunting dampers are pinned by unit tests, and the sanitisers and
validators have their own. What no test can settle is the lines below, and the reason is nearly
always the same — they depend on a real permission, a real sensor, ten minutes of a real room, or a
pair session, which is a live Web API surface rather than something a suite can call (platform §14).

`node scripts/verify-hardware.mjs full --yes` answers **T77-T80** on its own. **T81-T89 need you.**

- [ ] **T81** *The permission, and it is the first thing to check.* Homey settings → Lightkeeper.
      The **Daylight lights** section now leads with a sky readout. Confirm it names a **plausible
      sun elevation for the hour** rather than "This Homey has not said where it is".
      Cross-check the number against [NOAA's own
      calculator](https://gml.noaa.gov/grad/solcalc/) for your latitude and the current minute — a
      sign error or a UTC slip produces a number that looks entirely reasonable and is wrong, and
      this is the only place it shows.
- [ ] **T82** *Needs a real `measure_luminance` device, and there is no substitute.* Pair a
      **Daylight light** by hand and pick a light sensor — most motion sensors have one. Confirm the
      pairing screen shows that sensor's **current reading in lux and its age**, and that "So your
      lights would be" says **from the sensors** rather than from the sun. Then cover the sensor with
      your hand for a minute and confirm the reading follows.
      *What this is really checking:* that `measure_luminance` arrives over the capability
      subscription at all, and on what scale. Nothing establishes that but a real sensor
      (platform §16). Note the numbers you see — the `darkLux` and `brightLux` defaults of 5 and 500
      are a judgement, not a measurement, and this is the evidence that would change them.
- [ ] **T83** *The one that needs ten minutes of a real room, and the one this device type lives or
      dies by.* Point a Daylight light at the lamps **in the same room as its sensor** — the
      configuration the FAQ warns about, and the one people will try first. Switch the lamps on and
      watch **Homey settings → Lightkeeper → writes** for ten minutes.
      **Confirm the writes STOP.** A handful while it settles is right; one every minute for ten
      minutes is the closed loop hunting, and it means the deadband is too narrow for real sensor
      jitter. If it hunts, report the numbers rather than adjusting anything: `DAYLIGHT_DEADBAND` and
      `MAX_STEP_PER_TICK` in `lib/daylight/daylight-runtime.ts` are sized against a guess about
      sensor noise, and this is the measurement.
- [ ] **T84** *By eye.* Cover the sensor from T82 by hand while the lamps are on. The lamps should
      **ease** to their new level over a minute or two rather than jumping. Then uncover it and
      confirm they ease back. A jump means the slew limit is not being applied; no movement at all
      means the change never crossed the deadband, which is a different answer and worth saying.
- [ ] **T85** *The add-on, on the device type where it is easiest to see.* Give a **schedule** a
      window a couple of minutes out, tick **Set the brightness**, and choose **Follow the
      daylight**. Confirm the screen shows the boundary caveat, then let the window fire and confirm
      the lamps come on at the level the card's readout predicted rather than at the slider's number.
      Then switch the Homey's location off (Homey settings → Location) if you can, and confirm the
      next firing falls back to the slider — that fallback is the whole reason the number is kept
      beside the flag, and it is untested on hardware.
- [ ] **T86** *The one the light probe found, and it needs a lamp that refuses.* From the 4 September
      2026 probe run, four of thirteen colour-capable Hue bulbs refuse a colour written to them while
      they are off — the report names them, and `OFF_WRITE_DECLINED` with "soft off" is how to find
      the ones in your own house. Give a **circadian light** one of those lamps, switch **pre-staging
      on**, and leave the lamp switched off for ten minutes with the curve ticking. Then read the
      settings page: the device must still be **ready** rather than "1 of 1 lights are not
      responding", and its target must carry `preStageDeclined` with the bridge's own sentence.
      Confirm in the diagnostics' recent writes that it stopped trying after **three** attempts
      rather than one a minute. Then switch the lamp on and off again and confirm it is retried once
      more. Before this release the device reported not-responding and, where every lamp behaved this
      way, took itself offline — at no predictable moment, because a circadian light only re-assesses
      its health when a target's availability moves or the app restarts.

**The pairing screens now share their mechanics, and that is what T87-T89 are for.** Every driver's
handler wrapper, light picker, daylight card, save-and-name, credential pair and curve preview moved
into `lib/pairing/pair-session.ts`, and a unit suite now covers them — where before there was none
at all, because platform §13 means a file containing `extends Homey.Driver` cannot be imported by a
test. What those tests cannot reach is the SDK on the other side of the seam: whether Homey still
routes each handler, whether `createDevice` still accepts the shape, and whether a repair still
finds its device. Three lines, and they are cheap — pair and repair each device type once.

**T87 and T88 are now mostly answered by `pair` and `repair`**, which build one of each of the
five device types and open a repair session on each. Run 4 September 2026 (see the log below): both
came back clean. What the script does NOT cover is marked below — a repair that SAVES, and survival
of an app restart.

- [ ] **T87** *Pair all five, once each.* A controller, a schedule, a circadian light, a Curve light
      and a Daylight light. For each, confirm three things that now come from ONE place and would all
      be wrong together if a parameter were: the **default name** offered on the last screen reads
      like its device type ("Kitchen circadian", "Hall schedule") rather than another type's word;
      the light picker's subtitle names **that** device type; and the device **survives a restart of
      the app** with its configuration intact. That last one is the store-key check and the only one
      that matters — the key a driver saves under is also the key its migration chain reads, so a
      wrong one produces a device that pairs happily and comes back empty.
      Also confirm the credential screen still goes to **the remote picker for a controller** and
      **straight to the lights for a schedule**: the view is a byte-for-byte copy shared between the
      two (platform §8), so `nextView` is the driver's answer and the two are now one line apart.
- [ ] **T88** *Repair all five, once each — and SAVE.* Device → Maintenance → Repair, change
      something small, save. Confirm it reports success and that **no second device appears** — the
      repair path is one `if (device)` inside the shared save handler, and getting it wrong leaves
      the household with two devices doing the same job. Then confirm the change actually took, on
      the settings page.
      The script's `repair` command reads every repair screen and **saves nothing**, so it proves
      the screens answer with the right device's values and nothing about the save. This line is the
      save.
- [ ] **T89** *The sensor claim, which is the one thing here that leaks if it is wrong.* A pairing
      screen retains its chosen lux sensors so the card can show what they read, and releases them
      on `disconnect` however the screen closes. Open a **Daylight light** pairing, choose a sensor,
      confirm it appears in **Homey settings → Lightkeeper → Daylight lights** as a watched sensor
      with a reading age — then **cancel the pairing** and confirm it disappears from that list
      again. Repeat with the daylight card inside a **schedule** window, which reaches the same
      ref-count by a different screen. Then pair a Daylight light properly and confirm its sensor
      **stays** watched: the count is per owner, so a session releasing its claim must never take a
      live device's subscription with it. Get this wrong and an abandoned pairing leaves a
      subscription on somebody's battery-powered motion sensor for as long as the app runs, which is
      invisible from every screen except that list.

### Last run — 4 September 2026, Homey Pro 2023, firmware 13.5.0-rc.4, app 0.6.0 + the simplification pass

`node scripts/verify-hardware.mjs full --yes`: **71 OK, 1 failed, 0 skipped**, then **23 OK, 0
failed** for a second `pair repair` after the failure was fixed, and **7 OK** for `teardown`. The
two devices the pass did not create were untouched throughout and running at the end.

**The one failure was in the harness, not the app.** T77 reported that a Daylight light "was created
but the app never registered a runtime for it — it did not initialise". It had initialised perfectly.
The check searched `controllers`, `schedules` and `circadian` in the status response and omitted
`daylight`, which is its own key — so a Daylight light could only ever fail it. Fixed in
`scripts/verify-hardware.mjs`; T77 passes and reads "built daylight … the app reports it ready".
Worth remembering as a shape: a green pass is only as honest as the list the check looks in.

**What this run established about the simplification work.** All five device types pair and all five
repair with the shared pairing-session module (B1/B2) and the spliced views (C2b). Every default
name came back as its own device type's — "Music Desk Lamp schedule", "Computer Desk Lamp curve",
"Spot L | Studio daylight" — which is the `naming` parameter, the id prefix and the store key all
arriving correctly from one place. And the two pre-existing devices survived the
`MigrationResult.value` → `.plan` rename, which was the single most consequential change in the
whole pass and the one no test could settle.

**Memory, and a number not to chase.** T59/T60 read **56.3 MB PSS** after two full passes in one app
lifetime — past the 50 MB ceiling. After `restart`: **34.8 MB**, which is the documented steady
state (over Homey's 30 MB guideline, inside the 50 we accepted). So running the pass twice
back-to-back inflates PSS by ~20 MB of high-water that a restart returns; that is churn, not a leak,
and T59 should be read after a restart rather than after a marathon.

**Platform §8 gained a measurement.** Probing the app's own HTTP surface established that the Homey
serves files beside a pair view — `pair/<viewId>.assets/probe.js` as `application/javascript`, a
bare `pair/probe.css` as `text/css` — while refusing `app.json`, `app.js` and `locales/en.json`. It
is a directory whitelist, not a static server. That contradicts the in-code comment that said a
shared stylesheet had "nowhere to put one", and it is why C2b's splice is a stepping stone rather
than the end state. Still unmeasured, and needing the Homey app rather than the API: whether an
injected view's own external reference loads once the pairing container has placed the view in its
shared document. §8 carries the one-minute test.

Still needing a person: T3, T9-T11, T53, T54, and the save half of T88 above.


### Last run — 2 September 2026, Homey Pro 2023, firmware 13.5.0-rc.4, app 0.5.1 + the code-review pass

`node scripts/verify-hardware.mjs full --yes`: **53 OK, 0 failed, 4 skipped.** Then `pair`, a
targeted T66 probe, and `teardown` — which left 0 Lightkeeper devices and 0 generated Flows, and
touched none of the household's own.

**T66 PASSED**, and it is the line this pass was added for. The script cannot reach it, so it was
driven directly: set the circadian light's `onoff` to false and then true, the way the tile does,
reading `GET /` and `GET /diagnostics` around each tap.

- both taps were accepted, neither threw
- the device reported `enabled=false state=disabled`, then `enabled=true state=ready`
- `/` and `/diagnostics` answered before, between and after, listing 2 curve devices each time
- `POST /curves/tick` afterwards returned `{"ticked":2}` — both curve runtimes alive and ticking

Before the fix every one of those would have failed: the tap threw inside `subscribeAll()`, the
runtime was left stopped but still registered, and `diagnostics()` then threw for every curve-driven
device, taking the settings page and the bug-report export down with it.

What else the run confirmed that this release changed:

- **T17** the schedule's pause switch: `paused=true, still available while paused=true, resumed=true`
  — the same `setEnabled` path as T66, on the device type whose plan shape always matched, so the
  `planForRuntime` hook did not break the case that worked.
- **T33** `"n2_on|press" → toggle`, accepted, 1 write reached the lights — the extracted
  `intakeBridgeEvent` running end to end on hardware.
- **T18** the Flow folder followed a device rename, which exercises the folder lock's re-read.
- **T32/T34** all four devices came back available after a restart, both curve runtimes `ready`.
- **T40** controller and schedule left `needs_credential` without a restart once the key came back.
- **T45** 6523 characters of diagnostics, no key material — on a payload that now carries
  `staleReplacements`.
- **T46** every driver's repair screens answered with that device's own values, circadian included.
- **T59/T60** 28.7 MB PSS on a fresh install with no devices; 45.1 MB after the pass (+10.2 MB), over
  the 30 MB guideline and inside the 50 MB accepted — consistent with platform §15's ~44 MB, so the
  review's deletions moved nothing.

**The 4 skips were closed the same day, and closing them found two bugs.** T21, T24, T27 and T29
reported `none of its lamp(s) is on, so there was nothing to write to` — and needing a person to
flick a switch was the first problem. `askForALampOn` prompted, and returned false with no TTY, so
an unattended run skipped rather than asked. `switchALampOn` now switches a target lamp on itself,
names it in the report and puts it back; with every studio lamp OFF the same four lines run.

Then they failed, and the read-back was reading `homey-api`'s cache — `capabilityValue()` did not
pass `$cache: false`, so it returned the value from before the write. That is why the 30 August pass
recorded T21/T24 as a Hue Bridge echoing late and `hardware-test-coverage.md` recorded T25 as lamps
refusing external writes: both were a stale client-side read, and T25's fifteen-second poll made it
look conclusive. **The app had the same defect in `LightTargetAdapter.refresh()`**, which is a real
user-facing bug — see platform §15.

With both fixed: `pair preview rejoin teardown` with every lamp off gives **32 OK, 0 failed, 0
skipped**, and a full pass gives **0 skipped**. T25 passes for the first time in any recorded run —
"marked overridden and still holds 0.350" — which is the "a value set by hand is left alone"
property.

**T70 answered, with a caveat worth keeping.** 31.8 MB PSS on a fresh install once devices are
paired, against 28.7 MB with none — so the review's deletions moved nothing. The caveat is a change
made and then reverted on the strength of this number: opting `DeviceCatalog`'s two `getAll` sites
out of the cache cost 5.2 MB of floor, because nothing cached means every invalidation re-parses
every device and V8 never gives the pages back (§15). A mid-pass T59 of 60.3 MB was also seen, after
many pair/teardown cycles in one app lifetime; it fell to 46 MB across the pass, because the pass
restarts the app. Treat T59 as meaningful only on a freshly installed app.

Still needing a person, unchanged: **T3**, **T9**, **T10**, **T11**, **T53**, **T54** — and from this
release's own lines, **T67** (a repair that SAVES an edit; T46 only proves the screens are seeded,
not that a save round-trips), **T68** (needs a colour-only lamp) and **T69** (needs a zone deleted
mid-pairing).

### Last run — 30 August 2026, Homey Pro 2023, firmware 13.4.1, app 0.5.0

*The 0.5.0 lines T55&ndash;T60 were retired with this section when 0.5.1 rewrote it; what they found is recorded below and in `docs/hardware-test-coverage.md`.*

`node scripts/verify-hardware.mjs full --yes`: **50 OK, 3 failed, 5 skipped.** All three failures
were investigated and none is a defect in the app.

- **T21 and T24 failed, and the writes had in fact landed.** Both said a `light_temperature` write
  to a Hue lamp "did not take" — written 1.000, lamp holding 0.850. Reading the same lamp back
  afterwards showed `light_temperature: 1` — exactly what the app wrote. The two **T25 SKIPPED**
  lines have the same shape: the hand-set 0.650 the script said was "never reported" was sitting on
  the lamp when it was read again. **A Hue Bridge lamp can echo a new value back to Homey later than
  this script waits for it**, so a read-back immediately after a write can report the previous
  value. The app is fine; the script's read-back window is the thing to widen. Until it is, treat a
  T21/T24/T25 failure as unproven rather than failed, and confirm by reading the lamp again.
- **T60 tripped the 50 MB ceiling at 51.1 MB**, addressed in that line above: it is the pass's own
  high-water mark, not retention. A reinstall and immediate re-measure gave 12.2 MB.

Still outstanding, and each needs a person: **T3**, **T9**, **T10**, **T11**, **T54**, and the nine
screens of **T53** that were not read. T9–T11 need a finger on a real remote — but a controller you
paired by hand now **survives** `full`, which deletes only the devices it built itself, so they no
longer mean re-pairing one first.

## 5. How to report

One line per number, in the order above:

```
T24 OK
T46 failed: Repair on the schedule showed unknown_error_getting_file
T55 OK — Hue spots took the amber, the kitchen strip went warm instead
```

For anything that failed, add:

1. What you did.
2. What happened instead.
3. **The diagnostics report**: Homey settings → Lightkeeper → **Show diagnostics** → **Copy for a bug report**. It contains no API key. It does contain your device and zone names.

For a schedule that did not fire, the two lines worth quoting from that report are `catchUpRefusals` and `lastRejection` — they say why.

---

Background — what the script covers, what the test suite covers instead, and why some old lines were retired — is in [`hardware-test-coverage.md`](hardware-test-coverage.md). You do not need it to run the pass.
