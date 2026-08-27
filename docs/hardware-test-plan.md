# Hardware test plan

**The standing pass, run before every release.** Everything below needs real
hardware. The suite covers the logic (771 tests); this covers what only a Homey
can answer: the loader, the pairing screens, and lights actually changing.

Sections 1–8 do not change between releases. [This release](#this-release) is the
part that does — rewrite it each time with what is new or risky, and leave the
rest alone.

**Before you start:** `npx homey app install`. If it fails with a bare
`× Missing File`, try `--clean`; if `--clean` fails, try without it. Neither is
always right.

Tick each line. Anything unticked is a real result — say which.

---

## This release

*Rewritten each release. Everything below this section is the standing pass.*

**0.5.0.** Two things are new and one is invisible:

- **A fourth device type, the Curve light** — §5 is entirely about it.
- **The circadian light became the simple one**, and an existing one migrates
  (§4). It should keep two of its old curve values and drop the rest.
- **The device layer was rewritten**, so all four device types now load through a
  shared file. If that broke, devices fail to appear rather than misbehaving —
  which is what §1 is looking for.

---

## 1. It installs and every device survives a restart (5 min)

Every device type loads through one shared file, so a loader fault shows up as
devices failing to appear rather than as anything misbehaving. Check them all,
even the ones a release did not touch.

- [ ] The app starts. Settings → Lightkeeper shows no error.
- [ ] Your existing controllers and schedules are all still listed, still available
      (not greyed out), and their tiles look right.
- [ ] **Your existing circadian light is still there and still available.** Open it
      → it should have kept two of its old curve values (see §4).
- [ ] Restart the app (Settings → Apps → Lightkeeper → ⋮ → Restart). Everything
      comes back, still available.

## 2. The remotes still work (5 min)

- [ ] Press a button on each remote you have set up. The lights respond.
- [ ] Hold a button that ramps. It ramps, and stops when you let go.
- [ ] Turn a dial. The lights move by a sensible amount — **not** straight to full.

If you have a remote where one card covers several buttons *and* a direction *and* a
step count, this release fixed it firing on every control at once. If you have one,
say so — otherwise skip it.

## 3. Schedules (10 min, plus one evening)

- [ ] Open a schedule → Repair. Set a window to start **2 minutes from now** and run
      for 3 minutes. Save. Wait. The lights come on, then go off.
- [ ] Add a **second, overlapping** window on the same lights (e.g. now+1 for 10 min
      while the first is still running). **It should refuse to save**, saying the
      windows overlap.
- [ ] Pause the schedule with the switch on its tile, then un-pause it. Nothing
      breaks; the tile stays usable both ways.
- [ ] Rename the schedule. Check Flows → the folder under `Lightkeeper` follows the
      new name.
- [ ] **Overnight, if you have one set up:** a window that crosses midnight still
      switches off at the right time, and its off-Flow in your Flow list now reads
      `Off at 01:30 (starts Fri)` rather than `Off at 01:30, Fri`.

## 4. Circadian light — now the simple one (10 min)

It no longer has a curve editor. It asks two questions and handles the day itself.

- [ ] Open your existing circadian light → Repair. It shows **Warmest** and
      **Coolest**, each with a warmth slider (and brightness, if your lamps dim).
      The values should be the warmest and coolest points from your old curve.
- [ ] Each end says roughly when it applies (`Around 06:00, 21:00` and
      `Around 11:00, 15:00`).
- [ ] Move a slider, press **Try it now**. The lights change immediately.
- [ ] Save. Switch one of its lamps off and on at the wall or in the Homey app.
      **It comes back at the right colour for the time of day.**
- [ ] Change that lamp's colour by hand in the Homey app. Lightkeeper leaves it
      alone from then on. Switch it off and on again → it rejoins.

## 5. Curve light — the new one (15 min)

- [ ] Devices → Add → Lightkeeper → **Curve light**. It should **not** ask for an
      API key. Pick some lights → the curve screen.
- [ ] The chart draws. Add and remove points; the chart follows.
- [ ] **Set one point's Colour to `Amber`** (leave the others on
      *Colour temperature*). That point's dot on the chart turns amber and grows.
- [ ] Press **Try it now**. Your colour-capable lamps go amber. Lamps that cannot do
      colour go to that point's warmth instead — **check both kinds if you have
      them**.
- [ ] Set a *second* point to `Ocean`. Try it now at a time between the two → the
      lamps should be a shade **between** amber and ocean, not one or the other.
- [ ] Save it. Give it a minute, then confirm the lamps hold the right value.
- [ ] Switch a lamp off and on → it comes back correct.
- [ ] Delete the Curve light. **No Flows should appear or disappear in your Flow
      list** — this device type creates none.

## 6. The API key, and what a bad one does (5 min)

- [ ] Settings → Lightkeeper. It says a working key is saved.
- [ ] Paste **nonsense** into the key box and save. It should say the key is not
      usable — **and the line above should still say a working key is saved.** Your
      controllers and schedules stay available.
- [ ] Press a remote button. It still works.

## 7. Settings page (2 min)

- [ ] All four sections render: controllers, schedules, circadian lights, and the
      curve lights among them.
- [ ] **Recent writes** shows entries after you press a remote or run a Test.
- [ ] Each schedule line shows the time and your timezone.
- [ ] Download a diagnostics report. Open it. **Search it for your API key — it must
      not be in there.**

## 8. Repair every device type (5 min)

This is the one that fails loudly if the pairing files are in the wrong place —
`unknown_error_getting_file` before any screen appears.

- [ ] Repair a controller → all four screens open.
- [ ] Repair a schedule → all three open.
- [ ] Repair a circadian light → lights, then the two ends.
- [ ] Repair a Curve light → lights, then the curve.

---

## Known and expected

- **The Curve light uses the circadian light's icon and picture.** Placeholder —
  new artwork is a separate job.
- **Your old circadian curve lost its middle points.** By design; the changelog says
  so. Add a Curve light if you want that curve back.
- **A CLI-installed app shows no icon at all** (platform §10). Not a bug; it
  resolves on publish.

## If something fails

Send me: what you did, what happened, and the diagnostics report from §7. The report
carries the refusal reasons — for a schedule that did not fire, `catchUpRefusals` and
`lastRejection` are the two lines that say why.
