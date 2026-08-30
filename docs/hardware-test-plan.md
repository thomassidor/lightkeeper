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

`room` keeps the test lamps to one room. The pass switches lamps on and off, writes colours to them
and power-cycles one, so without it that happens to whichever lights sort first across the whole
house. Omit it to use every room.

If the file is missing the script asks for the values instead and offers to save them. It hides
keys as you type, but a terminal that mangles that would put a live credential in your scrollback —
so prefer the file.

`full` **builds one of each device type**, tests them, and **deletes every Lightkeeper device** at the end. Run it only on a Homey you can afford to empty.

If it says a device type is already paired, it leaves that one alone — delete it first if you want the script to build it.

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

**0.5.0.** All four device types built from scratch.

- [x] **T55** The **Curve light** is new. Draw a curve, give a point a colour, check the lamps follow — including a lamp that cannot show colour, which should take the warmth instead. *30 Aug 2026: the script's `preview` covered the substance — T27 wrote a colour (`light_hue`) and the lamps without colour took warmth instead; T28 saw 12 writes across `light_saturation`, `light_hue`, `light_mode` and every lamp holding what it was written. Drawing a curve by hand on a phone is still unticked.*
- [x] **T56** The **circadian light** is now two questions rather than a curve. Check its screen reads sensibly. *30 Aug 2026: read from `npm run render:views` — "The two ends of the day", Warmest and Coolest with their anchor times, brightness behind one switch, and the no-Flows note. Reads correctly.*
- [x] **T57** The 0.5.0 migration **cannot** be tested this time — no pre-0.5.0 device is left to migrate. *30 Aug 2026: confirmed, not tested — recorded rather than ticked off.*
- [x] **T58** Two lamp-driving bugs were fixed this release and are worth a look with your own eyes: a Curve light's coloured point no longer stops later warmth points working, and **Test it** on the pre-stage option no longer shows a raw error from your bridge. *30 Aug 2026: both held. T27 wrote a colour and warmth in one pass; T22's refusal came back as a readable sentence naming the bridge's own reason ("soft off"), not a raw error.*
- [x] **T59** **Memory.** `node scripts/verify-hardware.mjs memory`. Measured 30 August 2026 on Homey Pro 2023 / firmware 13.4.1: **12.2 MB** on a freshly installed app that has read no catalogue, and **28.5 MB** after a read-only pass — both inside Homey's 30 MB guideline. Reading a catalogue once still costs floor the runtime never gives back (platform §15), but the 0.5.0 work moved the numbers well below the ~32/~44 MB this line used to predict. The line fails past 50 MB. Report the number either way.
- [x] **T60** The same reading at the end of `full`, as a delta. **Measured 51.1 MB, which trips the 50 MB ceiling — and that is the pass, not the app.** `full` pairs one of each device type over the API and runs fifty checks in a few minutes, and every catalogue parse along the way leaves floor behind (platform §15). Reinstalling and re-measuring immediately gave 12.2 MB, so nothing is being retained. Treat a `full`-run reading as the high-water mark of the pass; T59 on a fresh app is the number that describes a user's Homey. **A ceiling tuned to normal use rather than to this pass is the open item here.**

### Last run — 30 August 2026, Homey Pro 2023, firmware 13.4.1, app 0.5.0

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
screens of **T53** that were not read. T9–T11 need a finger on a real remote, and `full` **deletes
every Lightkeeper device at the end**, so they mean re-pairing a controller first.

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
