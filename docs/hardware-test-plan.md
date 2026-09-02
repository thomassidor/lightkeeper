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

**0.5.1.** The App Store listing only — no app behaviour changed, so this release's lines are read
off the published listing rather than off a Homey. Publish to the test channel first; none of these
can be answered from a CLI install, because the store page is the thing under test.

- [ ] **T61** Open the listing and read the description. It should be two short paragraphs, no "read more" needed for the point of the app, and no Markdown characters visible. Athom's guideline is *"one to two paragraphs tops"*.
- [ ] **T62** The **What's new** section. One paragraph of ordinary prose — no `**`, no dashes starting a line, no `Added` / `Changed` / `Fixed` headings, nothing running together mid-word. Then open **View changelog** and check every older entry the same way; they were all flattened, not just this one.
- [ ] **T63** The **Flow cards** section. Each card's icon is a white drawing inside a violet circle and you can tell the four device types apart from it: a rayed sun on the horizon, a curve over a baseline, a remote sending a signal, a stopwatch. If any is an empty or smudged circle, say which — and grab the mask URL from the page's markup and `curl` it, because a blank icon on a published listing and a blank icon on a dev install are different faults (platform §10).
- [ ] **T64** `npm run render:icons` locally, then open `.views/icons/index.html` and compare its 40px column against what the store actually drew. They should agree. If they do not, the harness is reproducing the store wrongly and that is the thing to fix.
- [ ] **T65** On a phone, in the Homey app: Devices → Add device → Lightkeeper, and the four device tiles. The icons got simpler this release, so check the redraw did not cost anything at tile size either — this is where they used to be judged.

**Unreleased, on top of 0.5.1: the code review pass.** No version bump, so these are not a release's
lines — they are the ones the review's own fixes need a real Homey to confirm, and the first is the
serious one. `node scripts/verify-hardware.mjs full --yes` answers none of them: the pause switch is
a capability listener on a `Homey.Device`, and the script pairs devices rather than driving their
tiles.

- [ ] **T66** Pair a **circadian light** (the two-ended one, not Curve). On its tile, tap the pause
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
