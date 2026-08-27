# Hardware test plan

**The standing pass, run before every release.** Everything below needs real
hardware. The suite covers the logic (771 tests); this covers what only a Homey
can answer: the loader, the pairing screens, and lights actually changing.

**This pass starts from nothing.** No app installed, no devices, no API key — so
it builds all four device types from scratch, in the order they depend on each
other. That puts the screens you otherwise see only once back in scope: the empty
settings page, the key screen with no key behind it, and the first Flow this app
ever writes. About 80 minutes end to end, plus one evening if you set an
overnight window.

Sections 1–10 do not change between releases. [This release](#this-release) is the
part that does — rewrite it each time with what is new or risky, and leave the
rest alone.

**Before you start:** `npx homey app install`. If it fails with a bare
`× Missing File`, try `--clean`; if `--clean` fails, try without it. Neither is
always right.

Then check the slate really is clean: Devices, filtered by the Lightkeeper app,
should be empty. If anything is listed, either remove it or skip §1 and §7 and say
so — both of those test states that only exist before the app has ever been set
up.

Tick each line. Anything unticked is a real result — say which.

---

## This release

*Rewritten each release. Everything below this section is the standing pass.*

**0.5.0, on a clean Homey.** The previous install and every device paired to it
were removed on 27 August 2026, so this is a from-scratch build of all four device
types rather than a check that the old ones survived.

- **A fourth device type, the Curve light** — §5 is entirely about it.
- **The circadian light became the simple one**: two ends of the day, no curve
  editor — §4.
- **The 0.5.0 migration cannot be tested this pass.** It rewrites an existing
  circadian light's stored curve into two ends, and no pre-0.5.0 device is left to
  migrate. The unit tests cover the transform; nothing on hardware does. Say so in
  the report rather than ticking it — testing it now would mean installing 0.4.0,
  pairing a circadian light, and upgrading over the top.
- **The device layer was rewritten**, so all four device types now load through
  one shared file. A fault there shows up as a device that fails to appear or
  fails to pair at all, which is what §1 and every pairing section are looking
  for.
- **Every device type has its own artwork now.** In Devices → Add → Lightkeeper,
  all four should show four *different* pictures — a CLI install draws no icon at
  all (platform §10), so judge the pictures here and the icons after publish.
- **Two things only a clean slate lets you test, so do them this time:** §7's key
  removal and recovery, and §10's deletion checks. Neither is safe to run against
  a household that depends on the app.

---

## 1. It installs, and says honestly that it has nothing (5 min)

- [ ] The app starts. Settings → Apps → Lightkeeper → Configure app. No error.
- [ ] It says **No API key saved yet**, **No controllers yet**, **No schedules
      yet**, **No circadian lights yet** — four empty sections, not four blanks.
- [ ] **Generated Flows** reports **0** generated Flows. If it reports any, the old
      install left Flows behind — say so, they will confuse §10.
- [ ] Devices → Add device → Lightkeeper lists exactly four: **Light controller**,
      **Light schedule**, **Circadian light**, **Curve light**, with four different
      pictures.
- [ ] Restart the app (⋮ → Restart). The settings page comes back the same, still
      with no error.

## 2. The first controller, and the API key with it (15 min)

The controller's first pairing screen is the only place a first-time user meets the
key, and on a clean slate it is doing the real work rather than re-checking a key
that was already there.

**Keep the key in a note.** Homey shows it once, and §7 asks you to remove it and
put it back.

- [ ] my.homey.app → this Homey → Settings → API Keys → New API Key, with the
      **Flow** permissions ticked. Copy it.
- [ ] Devices → Add → Lightkeeper → **Light controller**. The first screen is
      **One-time setup**, with four numbered steps and a key box.
- [ ] Paste **nonsense** (`not-a-key`) and save. It refuses — *"That does not look
      like a complete API key"* — and stays on the screen. Nothing is saved.
- [ ] Paste the real key. *"Key accepted."* → the next screen lists the remotes,
      switches and dials on this Homey.
- [ ] Pick a remote → pick lights → the mapping screen lists that remote's own
      gestures, not a generic list.
- [ ] Try to assign the **same gesture twice**. The second row should not allow it
      — one rule per gesture.
- [ ] Map at least an on/off press, a hold that ramps, and a dial if you have one.
      Save.
- [ ] The device appears, is **available** (not greyed out), and its tile reads
      right.
- [ ] Flows → there is a `Lightkeeper` folder, a subfolder named after this
      controller, and one Flow per mapping. Note how many.
- [ ] Press the mapped button. The lights respond.
- [ ] Hold the ramp button. It ramps, and stops when you let go — and in no case
      runs longer than about 10 seconds.
- [ ] Turn the dial. The lights move by a sensible amount — **not** straight to
      full.

If your remote is one where a single card covers several buttons *and* a direction
*and* a step count, this release fixed it firing on every control at once: it must
move only the control you touched. Say which remote if you have one.

## 3. A schedule, on the key that is already saved (12 min)

Its first screen is the same file as the controller's, so this is also the check
that a saved key is recognised rather than asked for again.

- [ ] Devices → Add → Lightkeeper → **Light schedule**. The setup screen should
      already know the key and let you straight through — no retyping.
- [ ] Pick lights → the schedule screen. Set a window to start **2 minutes from
      now** and run for 3 minutes. Save.
- [ ] Wait. The lights come on, then go off.
- [ ] Add a **second, overlapping** window on the same lights (now+1 for 10 minutes
      while the first is still running). **It should refuse to save**, saying the
      windows overlap.
- [ ] Flows → two Flows for that window, in this schedule's own folder.
- [ ] Pause the schedule with the switch on its tile, then un-pause it. The tile
      stays usable both ways, and the device never goes unavailable.
- [ ] Rename the schedule. Flows → the folder under `Lightkeeper` follows the new
      name.
- [ ] **Overnight, if you set one up:** a window that crosses midnight switches off
      at the right time, and its off-Flow reads `Off at 01:30 (starts Fri)` rather
      than `Off at 01:30, Fri`.

## 4. Circadian light — the simple one (10 min)

Two questions, and it handles the shape of the day itself. It creates no Flows, and
it must never ask for a key.

- [ ] Devices → Add → Lightkeeper → **Circadian light**. It goes **straight to the
      light picker** — no key screen at all.
- [ ] Pick lights → **The two ends of the day**: **Warmest** and **Coolest**, each
      with a warmth slider (and brightness, if your lamps dim).
- [ ] Each end says roughly when it applies (`Around 06:00, 21:00` and
      `Around 11:00, 15:00`).
- [ ] Move a slider, press **Try it now**. The lights change immediately, and it
      reports how many it wrote to.
- [ ] If **Set the colour before the lights come on** is offered, press **Test it**
      with one lamp switched off. Either it reports the lamp stayed off, or it
      reports the lamp switched itself on, switched it back off, and turned the
      option off. Both are correct — say which you got.
- [ ] Save. **No new Flows appear anywhere in your Flow list.**
- [ ] Switch one of its lamps off and on, at the wall or in the Homey app. **It
      comes back at the right colour for the time of day.**
- [ ] Change that lamp's colour by hand in the Homey app. Lightkeeper leaves it
      alone from then on. Switch it off and on again → it rejoins.

## 5. Curve light — the full one (15 min)

- [ ] Devices → Add → Lightkeeper → **Curve light**. It should **not** ask for an
      API key. Pick some lights → **Draw the day**.
- [ ] The chart draws. Add and remove points; the chart follows.
- [ ] **Set one point's Colour to `Amber`** (leave the others on *Colour
      temperature*). That point's dot on the chart turns amber and grows.
- [ ] Press **Try it now**. Your colour-capable lamps go amber. Lamps that cannot
      do colour go to that point's warmth instead — **check both kinds if you have
      them**.
- [ ] Set a *second* point to `Ocean`. Try it now at a time between the two → the
      lamps should be a shade **between** amber and ocean, not one or the other.
- [ ] Try to add more than 8 points. It should stop you and say so.
- [ ] Save it. Give it a minute, then confirm the lamps hold the right value.
- [ ] Switch a lamp off and on → it comes back correct.
- [ ] **No Flows appeared for this device either** — the total in Flows is the same
      as it was after §3.

## 6. All four survive a restart (3 min)

Now that one of each exists, this is the loader check with something to load.

- [ ] Settings → Apps → Lightkeeper → ⋮ → **Restart**.
- [ ] All four devices come back, all **available**, tiles intact.
- [ ] Press the remote button again. It still works.
- [ ] The circadian and Curve lights still hold the right values a minute later.

## 7. The API key: a bad one, and losing it (8 min)

The second half only makes sense on a slate you can afford to break, so run it this
time.

- [ ] Settings → Lightkeeper. It says **a working API key is saved**.
- [ ] Paste **nonsense** into the key box and save. It should say the key is not
      usable — **and the line above should still say a working key is saved.** Your
      controller and schedule stay available.
- [ ] Press the remote button. It still works.
- [ ] Press **Remove key**. The controller and schedule go to **Needs API key**.
      Their Flows are **still in your Flow list** — losing the key must not delete
      anything.
- [ ] Press the remote button. It still works: the Flows are still there, only
      unmaintained.
- [ ] Paste the real key back in and save. Within moments, and **without restarting
      the app**, the controller and schedule return to **Ready**.
- [ ] The circadian and Curve lights were untouched throughout — no *Needs API
      key*, no unavailability.

## 8. Settings page and diagnostics (5 min)

- [ ] All four sections now list something: controllers, schedules, and the
      circadian and Curve lights together in the circadian section.
- [ ] **Recent remote presses** shows entries after you press a button.
- [ ] **Writes to lights** shows entries after a press or a **Try it now**.
- [ ] Each schedule line shows its window and your Homey's clock and timezone.
- [ ] **Show diagnostics**, then **Copy for a bug report**. Paste it somewhere and
      **search it for your API key — it must not be in there.** Search for a
      distinctive dozen characters of the key, not the whole thing.

## 9. Repair every device type (5 min)

This is the one that fails loudly if the pairing files are in the wrong place —
`unknown_error_getting_file` before any screen appears.

- [ ] Repair a controller → all four screens open.
- [ ] Repair a schedule → all three open.
- [ ] Repair the circadian light → lights, then the two ends.
- [ ] Repair the Curve light → lights, then the curve.

## 10. Deleting them again (5 min)

Also only honest on a clean slate: nothing here is recoverable.

- [ ] Note the total in **Generated Flows**.
- [ ] Delete the **Curve light**. **No Flow appears or disappears** — this device
      type creates none. Same total.
- [ ] Delete the **circadian light**. Same again: same total.
- [ ] Delete the **schedule**. Its two Flows and its folder go with it, and nothing
      else does.
- [ ] Delete the **controller**. Its Flows and its folder go too, and the total
      drops to **0**.
- [ ] **Generated Flows** now reports 0 generated Flows and offers nothing to
      delete. No Lightkeeper Flow is left anywhere in your Flow list.

---

## Known and expected

- **The 0.5.0 circadian migration is unverified on hardware.** See [This
  release](#this-release) — there was no old device left to migrate.
- **A CLI-installed app shows no icon at all** (platform §10). Not a bug; it
  resolves on publish.
- **A schedule window that already ended is not applied at startup.** Restarting at
  22:01 into a window that ran 20:00–22:00 leaves your lights alone, on purpose.

## If something fails

Send me: what you did, what happened, and the diagnostics report from §8. The
report carries the refusal reasons — for a schedule that did not fire,
`catchUpRefusals` and `lastRejection` are the two lines that say why.
