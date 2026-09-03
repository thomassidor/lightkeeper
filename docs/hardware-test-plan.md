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

- [ ] **T3** Devices → Add device → Lightkeeper lists four device types, with four **different** pictures. (It draws no icon at all from a CLI install — that is normal and resolves on publish.)
- [ ] **T9** Press the mapped button. The lights respond.
- [ ] **T10** Hold the ramp button. It ramps, and **stops when you let go** — and never runs longer than about 10 seconds.
- [ ] **T11** Turn the dial. The lights move by a sensible amount — **not** straight to full.
- [ ] **T53** Run `npm run render:views` and open `.views/index.html`. Every pairing screen, on one page. Anything that looks wrong, say which screen. *30 Aug 2026: 11 screens rendered; the two new ones (`curve/curve.html`, `circadian/ends.html`) were read and are correct. The other nine still want a human eye.*
- [ ] **T54** Anything you noticed while pairing by hand in step 1 that looked or read wrong.

## 4. This release

*Rewritten each release — what is new or risky this time. Its lines carry on from the highest number used so far, and are retired rather than reused when the next release rewrites this section.*

**0.5.2.** Four fixes to the two light-following device types, three of which only a real lamp can
confirm — the suite proves the arithmetic, but "did the lamp actually change" is not a thing it can
answer. `node scripts/verify-hardware.mjs full --yes` answers none of T71-T75: they need a curve
crossing between a coloured segment and a temperature one, which is a curve the script does not
build. **Set them a few minutes apart and watch the lamp**, rather than waiting on a real day.

T66-T70 were unreleased on top of 0.5.1 and ship with this release, so they carry on below.

- [ ] **T71** *The serious one.* A **Curve light** over a lamp that can do both colour and colour
      temperature. Give it three points a few minutes apart: one with a **colour** (ember), then two
      with a plain **warmth**. That shape puts one segment between two warmth points, which is the
      only way to get a temperature segment at all — a colour at either end holds that colour flat.
      Now watch it cross out of the coloured segment into the temperature one **twice** (edit the
      times, or wait out two cycles). Both times the lamp must go white. Before the fix the first
      crossing worked and the second left it sitting on the colour, because the `light_mode` write
      that makes a temperature land was being dropped — so on a daily curve it worked once and never
      again. Check `/diagnostics` after each crossing: `targets[].lastWritten` must show a `warmth`
      and no `color`.
- [ ] **T72** Same Curve light, on the **dimmest** setting the brightness slider now offers (10%).
      The lamp must be visibly lit, not off and not at its own minimum. Then check `/diagnostics`:
      `lastWritten.dim` must be above 0.00. Before the fix the slider went down to 5%, which became
      `dim` 0.00 — off, on most integrations — and held there for the eight minutes either side of
      the point.
- [ ] **T73** *The migration, and it needs a device that predates this build.* On a Homey still
      running 0.5.1, set a curve point, a schedule window or a circadian end to **5%** brightness and
      save. Then install 0.5.2 over it. Open **Repair**: the card must show **10%**, and saving must
      not change what the lamp does relative to what the card says. The failure this prevents is a
      card displaying 10% while the stored plan still says 5%, which is what a raised slider does on
      its own.
- [ ] **T74** *By eye, and there is no other way to check it.* A Curve light with **ember** at one
      point and **ocean** at the next, a few minutes apart, over a colour lamp. Through the middle of
      that segment the lamp must go **pale** — nearly white — and come out blue. It must NOT pass
      through purple or magenta at full saturation, which is what the old wheel blend did for half
      the segment. Then try **candle to amber**: that one must stay a proper warm colour the whole
      way across, because narrow pairs are the ones the old blend got right and must not have been
      flattened.
- [ ] **T75** `GET /diagnostics` with a Curve light running a coloured curve. Confirm all four of:
      each coloured point in `points[]` carries its `color` (an `ember`, not just a warmth);
      `targets[].lastWritten` carries a `color` while the lamp is on a coloured segment; that same
      object says `dim` and not `brightness`; and `canColor` sits beside `canWarm`. Then switch the
      device's pause switch **off** and read `lastAction` — it must carry a `detail` saying the plan
      is switched off, with a fresh timestamp, rather than the last pass that did something.
- [ ] **T76** Leave a Curve light on an **ember to ocean** segment for ten minutes and count the
      colour writes in `recentWrites`. Expect roughly one every three to seven minutes, not one a
      minute. `COLOR_STEP` went from 0.01 to 0.03 with the new blend precisely because the disc path
      is longer than the arc; if this shows a write most minutes, 0.03 was not enough.
- [x] **T66** *(PASSED 2 Sep 2026 — see the run below.)* Pair a **circadian light** (the two-ended one, not Curve). On its tile, tap the pause
      switch OFF and then ON again. Neither tap may error, and after each one open **app settings**:
      the page must still load and still list the device. Before the fix, either tap threw inside the
      runtime — leaving it stopped but still registered, so the light did nothing until the app
      restarted — and `diagnostics()` then threw for every curve-driven device, which took the whole
      settings page and the bug-report export down with it. Check the app log for a tick failure
      repeating every minute afterwards; there should be none.
- [ ] **T67** Same device: **Repair** it and change *warmest* (or the chosen lights). Save, then
      re-open Repair — it must show what you just set, not the previous values. Then restart the app
      (`npx homey app install` again) and confirm the new curve is still what runs. The repair used
      to take effect on the lights and be written back as the plan it replaced.
- [ ] **T68** A **Curve light** with a coloured point over a lamp that can do colour but **not**
      colour temperature, if the household has one. It must pair and report ready rather than "None
      of its lights can change their warmth", and the pairing screen's pre-stage **Test it** must
      offer that lamp rather than saying every light is already on.
- [ ] **T69** In the light picker, on any device type: pick a zone, then have the pick fail — the
      simplest way is to delete the zone from another client mid-pairing. A red message must appear
      *above* the two tabs, and it must clear again on the next successful tap. It used to fail
      silently, and the message element was hidden in zone mode.
- [ ] **T70** `node scripts/verify-hardware.mjs memory`. Confirm the review's deletions did not move
      the ~44 MB floor (platform §15). T59's 30 MB guideline and 50 MB ceiling still apply.

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
