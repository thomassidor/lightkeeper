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
names everything it builds `[verify] …` and only ever touches devices carrying that mark,
re-checking it against the Homey immediately before each permanent delete — so a controller,
schedule, circadian or Colour Curve Light **you** paired is never chosen, never written to and never
deleted. You can run this on the Homey you live with.

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

- [ ] **T3** Devices → Add device → Lightkeeper lists five device types, with five **different**
  pictures. (All five are real as of 16 September 2026 — the Room-sensing Light's placeholder disc
  was the last one, and replacing it closed the publish blocker in `artwork/provenance.md`.) (It
  draws no icon at all from a CLI install — that is normal and resolves on publish.)
- [ ] **T9** Press the mapped button. The lights respond.
- [ ] **T10** Hold the ramp button. It ramps, and **stops when you let go** — and never runs longer than about 10 seconds.
- [ ] **T11** Turn the dial. The lights move by a sensible amount — **not** straight to full.
- [ ] **T53** Run `npm run render:views` and open `.views/index.html`. Every pairing screen, on one page. Anything that looks wrong, say which screen. *13 Sep 2026: all 15 authored screens rendered and compared against the design canvases in `docs/design/`. They still want a human eye on a phone, which is what T112 is.*
- [ ] **T54** Anything you noticed while pairing by hand in step 1 that looked or read wrong.

## 4. This release

**0.6.1 — a general code review, on top of an 0.6.0 pass that is still owed.**

Normally the previous release's lines are deleted here rather than carried, because they have been
run. **These have not**: nothing has been published, and the 0.6.0 block below was only partly
worked through. So both are live, and they are kept apart rather than merged — 0.6.1's three are
specific and take a few minutes, while 0.6.0's is a full pass with a phone.

Nothing in either block can be checked by the script, and that is the point: `verify-hardware.mjs`
drives pair sessions over the Web API (platform §14), so it proves the HANDLERS answer. It cannot
see a screen. Every line here needs a phone.

### 0.6.1 — the switch-on work, and the code review's three

The fixes whose evidence is not in the suite. Everything else is covered by a unit test, and the ones
that could be were run against the old code first to confirm they fail on it.

T138–T141 are the switch-on work and need a room whose lights are OFF to begin with. T140 is the one
that cannot be faked in a test: it asks what YOUR integrations do, and platform §6 measured that the
answer differs between lamps behind one bridge.

- [ ] **T138** Colour on arrival. Add a Colour Curve Light over a room's lamps with the new **Set the
      colour before lights come on** switch left ON (it is the default for a new device), finish
      pairing, and switch the room off. Wait for a tick, then switch it on at the wall. The lamps must
      come on **already** at the curve's colour — no visible change a second or two afterwards. Then
      pair a second one with the switch OFF and repeat: that one must show the old behaviour, coming
      on as it was and correcting itself. The contrast is the assertion; one room alone proves little.
- [ ] **T139** Brightness is still late, and that is correct. On the T138 device, turn **Set
      brightness too** on as well and repeat. The colour must be right on arrival and the brightness
      must NOT be — a brightness write turns an off lamp on, so it can only follow. If brightness is
      also right on arrival, something is pre-staging `dim` and that is a defect, not an improvement.
- [ ] **T140** The test button, on your own lamps. On the curve or day screen, with at least one
      target lamp OFF, press **Test it on my lights**. It must name one of your own lamps and say one
      of three things: it stayed off, it came on (and was put back), or your bridge declined with the
      integration's own sentence. All three are passes — the failure is a raw error string, a silent
      button, or a lamp that comes on and is NOT put back. Press it again with every target lamp ON:
      it must say there is nothing to test rather than doing anything.
- [ ] **T141** A lamp that ignores a write is not read as a person. Needs a lamp that snaps to a
      coarser step than it declares — on the reference Homey the Garage lamps take `dim` in tenths
      while declaring hundredths. Drive one to a level that quantises away (a Room-sensing Light at
      its dark end will), leave it an hour, then read `/diagnostics`: the target must show
      `overridden: false` and an `ignoredWrites` count, and `recentControlEvents` must carry
      `report_ignored` with reason `write_ignored` rather than an `override`. Before this release the
      same lamp reported `overridden: true` and its device stopped writing for four hours at a time.
      Then nudge that lamp by hand in the vendor app to somewhere it has NOT been, and confirm an
      `override` IS raised within a tick — forgiving a stuck lamp must not have cost a real one.

- [ ] **T135** A rejected API key, twice. Paste a key with **read-only** permissions into Homey
      settings → Lightkeeper. It must be refused with "does not have permission to manage Flows",
      the key you already had must keep working, and every device must stay as it was — no tile
      going to "needs credential". Do it a second time, then paste the good key again: both
      rejections used to leave a live connection behind, and the only way to see that from outside
      is that nothing degrades over repeated attempts. Check `/diagnostics` afterwards for the
      credential block reading `present=true valid=true`.
- [ ] **T136** The circadian try-it screen, across two sessions. Add a circadian light, open
      **Try it**, scrub the day so the lamps visibly change, then **close the pairing sheet
      without** pressing "Put them back" — the lamps stay where the preview left them, which is
      expected. Now start a **second** circadian light on a **different** set of lamps, open its
      Try it, scrub, and press "Put them back". Only the second set may move, and it must return to
      how it was. The first set staying put is the pass; the first set changing is the bug this
      line exists for.
- [ ] **T137** A Colour Curve Light and the settings page. With at least one of each device type
      paired, open Homey settings → Lightkeeper: every section must render — the API key box, all
      five device lists, the Flows section and the recent-writes log. One device that cannot
      describe itself used to blank the whole page, so "it loaded at all" is the assertion. Then
      open **Flows → Delete orphaned Flows** and confirm it names a count and a list before
      offering the button, and that pressing it with nothing orphaned offers no button at all.

### 0.6.0 — every pairing screen redrawn, and four engines reshaped under them

- [ ] **T112** Pair one of each of the five device types by hand, end to end, on the phone. Each
      one opens with an intro naming what it will ask, then numbered steps, then a review. Every
      row on the review that carries a chevron jumps back to the step that owns it, and coming
      back forward keeps what you had already chosen. Report any screen whose wording or layout
      reads wrong — this is the only pass in which a person sees them at the size they ship at.
- [ ] **T113** The credential screen's two behaviours, in order. With **no** key stored, add a
      Light Remote: the key screen appears after the intro and before step 1, and refuses to
      go on until a key is accepted. Then add a **second** Light Remote: it must pass straight
      through with no visible flash of the form. This is the whole argument for moving the screen
      to the front, and the flash is the one thing that would undo it.
- [ ] **T114** The circadian day strip, which is the only drag target in the app. A horizontal
      drag on it must move the boundary and **not** scroll the pairing sheet underneath. If the
      sheet moves, the fix is `touch-action: none` on the strip. Check the sunrise and sunset
      marks against the Homey's own sunrise and sunset for today — they must agree to the minute.
      Then step a boundary to each of its ends: it must stop rather than crossing the other zone.
- [ ] **T115** A circadian light with **no** location set on the Homey (Homey settings →
      Location, cleared). The day screen must say it is falling back to fixed times rather than
      drawing marks it cannot place, and the device must still run. Put the location back
      afterwards.
- [ ] **T116** The sensor week, on real Insights data. Add a Room-sensing Light and open a sensor's
      detail screen: the grid must show seven rows with a visible night and day, a scale carrying
      the sensor's own low and high, and a verdict sentence with numbers in it. Do it for a sensor
      you know to be **frozen** as well — it must say so and name the date it stopped. If the grid
      is empty for a sensor that plainly has history, the Insights manager did not connect; the app
      log says so and the screen falls back to the defaults rather than failing.
- [ ] **T117** Press-to-find, on a real remote. Open the controller's listen screen and press a
      button within the thirty seconds: it must hear it and move on. Then open it again and press
      **nothing** — it must give up on its own, say so, and leave "pick from the list instead"
      reachable throughout. Last, try it with a card-only remote (platform §4): it will hear
      nothing, which is correct, and the list escape is the whole reason it is there.
- [ ] **T118** Two overlapping schedule blocks over the same lights. The screen must draw the
      overlap and say the later block wins, and must **not** refuse the second block or block
      Next. Then leave the device running across both boundaries and confirm the lamps do what the
      screen promised.
- [ ] **T119** The two new controller jobs, on real lamps: **a set brightness** and **step through
      warm and cool**. Assign each to a button, use Test on the job screen, then press the real
      button. The brightness job must land on the value you chose, and the temperature job must
      advance one step per press rather than jumping to an end.
- [ ] **T120** "Select all" in a room, on the light picker. Tick every light in one room and
      nothing elsewhere: the review must say the device follows the ROOM. Save it, then add a lamp
      to that room in Homey and confirm the device picks it up with no repair. Untick one light
      instead and the review must say it follows named lights.
- [ ] **T121** The clean slate. Any Lightkeeper device paired before this build must come up
      **unavailable with a message**, not silently broken and not quietly reset — there are no
      migrations in this release on purpose. Delete and re-add it, and confirm the new one works.
- [ ] **T122** **Count the Next buttons.** On every numbered step of every flow there must be
      exactly ONE way forward — Homey's own, at the bottom of the sheet. Scroll each step to the
      end and confirm there is no second full-width button below the content. The two screens that
      DO carry their own are the review (`Add device`) and the key screen (`Save and continue`),
      and on both of those Homey draws none of its own. This is the line the whole pass exists
      for: the duplicate was invisible in every render taken without Homey's chrome around it.
- [ ] **T123** **The curve chart with brightness OFF**, which is the default. Add a Colour Curve
      Light and look at step 2 before touching anything: the point handles must sit inside the
      chart, not over the heading above it, and the `Full` / `Off` captions must be absent — there
      is no axis to label while every bar is full height. Then switch brightness on for one point
      and confirm the gutter appears and the bars take their heights.
- [ ] **T124** **Selected state, on the four screens that have one.** The circadian day, the
      curve, a schedule block and the daylight response each open one card out of a list. On the
      phone, the open card must be visibly bordered in the app's own violet — not the hairline
      every other card has — so that tapping a row in the list below and looking up answers
      "which of these am I editing". Check the schedule timeline too: the block being edited is
      taller and haloed, not merely a darker shade of the same lavender.
- [ ] **T125** **The small type, at the size it ships at.** A CSS shorthand that silently dropped
      was rendering seven controls at 16px regular instead of the 12–14px they are written at, and
      a desk monitor forgives that where a phone does not. Look at: the `−` and `+` on the
      circadian day and curve steppers, the schedule's seven day chips, the HOUR/MINUTE captions,
      both dashed `Add a …` buttons and the two `Remove this …` links. Report anything that reads
      oversized, mis-weighted, or out of proportion with the row it sits in.
- [ ] **T128** **One remote, two different sets of lights.** Pair a Light Remote over three or more
      lamps. Give the top button a job aimed at ALL of them and the bottom button the same job aimed
      at ONE, using the checklist under "To". The buttons list must say which lights each drives —
      "all three" against one row and the lamp's own name against the other — and then press the two
      real buttons: exactly the named lamps may move, and nothing else in the room. Then go back to
      step 2, untick the lamp the bottom button named, and return: that row must have been re-aimed
      to all of them rather than left pointing at a light the device no longer has.
- [ ] **T129** **The colour job, on a lamp that can take a colour.** Assign "Set colour", pick a
      colour, and use Test — the lamp must land on that colour, from colour mode or from white.
      Check the nine tiles on a set of lamps with NO colour support as well: the colour tile must be
      absent rather than present and dead, and on lamps with no warmth the two warmth tiles too. If
      you have a button still set to "step through warm and cool" from an earlier build, open it:
      the tile must be there and selected, and the button must go on working.
- [ ] **T127** **The buttons screen's rows, on the phone and nowhere else.** Open step 3 of a
      Light Remote and look at the gesture names. Each one is plain text over its own second line —
      "Top" above "Pressed" — on the card's white, with no pill, no box and no tint behind it. It
      shipped drawing every name inside the pairing container's own grey button pill, because the
      row called that element `.button` and the container styles `.button` itself. No render can
      show this: a view rendered alone on a white page has none of the container's CSS in the
      document with it. While you are there, check the value on the right — a job in dark ink,
      "Not set" a step lighter — and the second line under each name at its own smaller size. Each
      row opens with a mark: filled on a button that has a job, an empty ring on one that has not,
      and the unset rows must read as quieter than the set ones rather than as warnings. Press a
      real button and watch the row it belongs to: it must be scrolled to AND visibly tinted for
      about a second.

- [ ] **T126** **The colour swatches, on a phone screen in daylight.** Open a Colour Curve Light's
      step 2 and confirm the eight featured colours are eight distinguishable colours — in
      particular that "Neutral white" and "Cool white" do not read as two identical greys. Fold the
      other sixteen out and confirm the same. Then pick one and check the chosen swatch's ring is
      visible on a pale colour as well as on a saturated one.

**0.6.0, the section before that — what a week of real evidence found, and the five fixes that came
out of it.**

Unusually, these lines are not written from first principles: every one of them re-runs a
behaviour that a 3.83-day recording on this same Homey caught getting it wrong — an override that
never expired, 296 of 327 overrides raised by a `dim 0` report a median 29.9 s ahead of the lamp's
own `onoff`, a tolerance that failed at exactly 0.03, and a daylight loop that ran away 95 times
with nothing saying so. That makes T107–T111 the priority of this pass — they are the only proof
that the integrations which produced those findings now behave.

T98–T106 below were partly run on 9 September and the unticked ones are still owed, as are
T91–T97. All of them belong to 0.6.0 too: the intermediate version numbers those lines were
written under were folded away before anything was published. Nothing is renumbered — a test
number is never reused.

- [ ] **T107** The one that matters most. Find a lamp that does not hold what it is sent — the
      recording's did, reverting to its own `dim 0.41` / `light_temperature 0.83` about ninety
      seconds after every write. Point a circadian light at it and leave it on for five hours.
      Within the first two minutes its tile may show the lamp as overridden; **after four hours
      control must resume by itself**, the export must carry an `override_cleared` with
      `reason: 'expired'`, and a write to that lamp must follow on the same pass. If no such lamp
      is to hand, dim one by hand from the Homey app and leave it: the same four hours apply.
      Before the fix this device did nothing for 88 of 93 hours while reporting `ready`.
- [ ] **T108** Switch a lamp belonging to a Room-sensing Light off, from the Homey app or at the
      wall, and leave the device alone for a minute. The tile must **not** show it as overridden at
      any point, and the export must carry `report_ignored` with `reason: 'dim_zero'` rather than an
      `override`. Repeat on each integration you own: the defect was an integration reporting `dim
      0` a median of 29.9 s ahead of its own `onoff: false`, so the ordering is the thing under test
      and it differs per bridge.
- [ ] **T109** Start a recording and leave a circadian light running across the point where its
      warmth crosses zero — the far end of the coolest anchor. Export, and confirm the analysis
      reports **`malformed: 0`**. This is the only end-to-end check on the redaction fix; the
      recording that found it had 93 unreadable records and `dropped: 0`. While the archive is
      open, re-confirm T100's redaction search: both keys' leading characters still absent.
- [ ] **T110** A Room-sensing Light whose sensor sits in the same room as its lamps, configured with
      the bright end higher than the dark end. Switch its lamps on and watch for ten minutes. The
      device must move to **partial** with the "brightening their own sensor" message once the
      climb has been observed five times, and `feedbackObservations` must be non-zero in the
      export. Then move the sensor where it cannot see those lamps, repair the device, and confirm
      it stays `ready` — the false-alarm half is as important as the detection.
- [ ] **T111** `node scripts/evidence.mjs analyze` on any archive must no longer report
      `maxRssBytes`. Read the footprint with `node scripts/verify-hardware.mjs memory` instead and
      confirm it is the number the app-profiling dashboard shows, against the 30 MB guideline.

**T98–T101 are the recorder's smoke test, and it is the one thing in this list that cannot be
skipped.** Everything the recorder promises rests on two assumptions no unit test can reach: that
`/userdata` and `homey.settings` BOTH survive a plain `homey app install`, and that the archive is
not readable without the key. If either is wrong, a household runs for a week and has nothing, or
has something it should not.

- [x] **T98** `npx homey app install`, then `node scripts/verify-hardware.mjs memory` for a
      baseline reading. Press **Start seven-day recording** in app settings. After sixty seconds
      `node scripts/evidence.mjs status` reports `recording`, at least three records, `bytes`
      above zero and a `lastFlushAt`. The settings page does not poll, so press **Refresh
      recording status** rather than waiting for the number to move on its own.
- [x] **T99** Restart the app — or reinstall the SAME build, which is the case that matters.
      `status` reports the same `id` and the same `endsAt`, with a grown record count. Then
      `export` and confirm the archive carries **`app_boot` with a fresh `bootId` under the same
      `runId`**, and `recoveredTailBytes: 0`. This is the only proof that `/userdata` AND settings
      both survive a plain install, which the whole feature assumes. **A `--clean` install is
      expected to lose the run; do not use one here.**
      *Corrected 9 September: this line originally asked for `app_shutdown` followed by `app_boot`.
      `app_shutdown` never arrives — `onUninit`'s `await` does not finish on this platform
      (§17) — so the boot record written on the way UP is what proves the survival, and a
      teardown record must not be load-bearing.*
- [x] **T100** `node scripts/evidence.mjs note "smoke"`, then `export` while recording continues.
      `analyze` reports one observation. Search the export for the leading characters of BOTH keys
      and for every device and zone name you recognise: all must be absent, and there should be no
      20-plus-character hex run anywhere. Fetch
      `http://<homey>/app/<id>/userdata/lightkeeper-evidence/<id>.enc` unauthenticated and confirm
      what comes back is the `{iv, tag, data}` envelope and nothing legible.
      *Corrected 9 September on two counts. The repo's second key is deliberately `homey.flow`-scoped
      — it exists to test the app's own Flow credential — so it cannot reach the app Web API at all
      and returns `Missing Scopes`; exporting with a second GENERAL key remains untested. And the
      file IS served unauthenticated (200, not a 401): §17 has the measurement. That makes the
      cipher load-bearing rather than defence in depth, which is why the check is now "nothing
      legible" rather than "it is ciphertext".*
- [x] **T101** `verify-hardware.mjs memory` again after ten minutes of recording: the delta must
      be under 3 MB. Then `stop`, `clear <id>`, and `status` reports `idle` — and confirm the `.enc`
      file is gone from `/userdata` (the unauthenticated URL above should 404). Do the same from the
      settings page's **Discard archive** button and confirm **Start** becomes available again.
      *The settings-page half is still owed: only the CLI path was exercised.*
- [ ] **T102** Cut one lamp of a three-lamp circadian or Room-sensing Light at the wall and leave
      it. Within a few minutes the tile must stop saying everything is well and report the lamp.
      Switch it back on: the tile returns to normal within two ticks. This is the failure streak
      finally reaching the device, and the wall switch is the only way to produce it — a lamp cut at
      the wall stays `available: true` (platform §6), so nothing else changes.
- [ ] **T103** With a controller whose Flows are healthy, edit one generated Flow in the Flow
      editor so it reads as user-edited, then switch one of its lamps off at the wall. The tile
      must say "open repair" and KEEP saying it — not swap to a lamp count, and not become
      available again. Then remove the API key: the tile must change to the credential message.
      Paste a working key back: the repair prompt must return, not `ready`.
- [x] **T104** In a room containing a dimmable bulb, a lamp on a smart plug, an ordinary switched
      socket and a non-light appliance that happens to have `onoff`, run the light picker. It must
      offer the first two and not the last two. **This reverses an earlier deliberate decision
      that `onoff` was the whole rule, so confirm the new behaviour is what is wanted before
      relying on it.**
- [ ] **T105** Map a single control to Hold → Brighter and nothing else. Press and hold, then
      release. The ramp must start on the hold and STOP on the release — not run to the ten-second
      hard stop. Then give that mapping a per-light target and repeat: only that lamp may move.
- [ ] **T106** With a circadian light and a Room-sensing Light both running, kill the Homey's socket
      (pull its network briefly, or restart the router). Once it is back, toggle a lamp at the
      wall and change a lux sensor's reading. Both must reach the app without restarting it, and
      `getDiagnostics` must not show two clients' worth of subscriptions.

- [ ] **T91** Configure a schedule, a circadian light and a Colour Curve Light with a lux sensor,
      without a standalone Room-sensing Light using it. Close pairing completely, change the
      sensor's reading, and verify the curve devices follow it and the schedule uses it at its next
      boundary. Restart Lightkeeper and repeat. The source should remain the sensor, not the sky or
      fallback.
- [ ] **T92** Configure two devices with the same sensor. Pause/resume and remove one device;
      the remaining device must continue receiving readings. Open two previews and close one;
      the other must continue. Close both and confirm no unowned sensor remains watched.
- [ ] **T93** On a test setup with a controllable temporary API failure, interrupt sensor
      subscription during startup. Restore connectivity and confirm recovery within one minute
      without a restart. A sensor that failed to subscribe must not be used as a frozen input.
- [ ] **T94** With a lit lamp following daylight or a curve, request a brightness update and
      immediately switch the lamp off. Repeat across the household's integrations. Commands not
      yet dispatched must be cancelled. Note integration echo delays: a command already sent to
      Homey cannot be recalled, and an unreported off event cannot yet be observed by the app.
- [ ] **T95** Move a lamp out of a controlled zone while changes are pending. Confirm no further
      commands are sent after removal is processed, and switching the lamp on does not trigger
      the old device. Re-add it and confirm normal control resumes.
- [ ] **T96** Using a disposable test device and controlled startup failure, fail startup after
      subscriptions are acquired. Confirm the failed device has no active listeners or sensor
      claims and does not respond to power events. Repair successfully and confirm one response.
- [ ] **T97** Using a disposable test device and injected storage failure, save changed settings.
      Confirm failure restores the previous configuration, including after restart. Repeat with
      first setup and failed recovery: no candidate should keep controlling lights. Do not fill
      or damage the Homey's actual storage to induce this failure.

**And the memory work, which changed what T59 and T60 mean.**

Read [§15's "Where it stops, and what was established by trying"](homey-platform.md#15-homey-api-caches-every-getall-result-forever)
before running these. The short version: on 14 September 2026 the unmodified 9 September build was
reinstalled beside HEAD on the same Homey and measured the same, so **T59's number is a property of
the machine rather than of this app**, and three restarts of one build spanned 71.4–80.1 MB.

- [ ] **T127** Take T59 **three times**, restarting the app between each, and report all three.
      A single reading cannot distinguish a 5 MB regression from noise on this hardware. Report the
      spread, not the best one.
- [ ] **T128** Before believing any of them, read the machine: `system.getMemoryInfo`'s `free` and
      `swap`, and the `types` map. A Homey with 10.6% free memory and 459 MB of swap in use — which
      is what the reference Homey was on 14 September — reports app PSS that reflects what the
      kernel has reclaimed as much as what the app holds. If `free` is under about 15%, say so
      alongside the number or it will be read as a regression later.
- [ ] **T129** `GET /diagnostics` now carries `heap`. Confirm it answers, and record `heapUsed`,
      the `spaces` split and the three `marks`. Expected on a freshly restarted app with no
      devices: `modules-loaded` ≈ 8.8 MB, `onInit-end` ≈ 12.8 MB, settled ≈ 15.2 MB, with
      `old_space` the largest space. **This is the only reading that can tell retention from a
      parse**, so a jump in `old_space` between two builds is a real finding where a jump in PSS
      is not.
- [ ] **T130** Confirm `heap.unavailable` still names exactly the two readings the sandbox refuses
      — `/proc/self/statm` with `ENOENT`, and nothing else. If `rss` starts answering, a firmware
      has mounted `/proc` and §17 needs rewriting. Ignore `maxRss`: it is inherited from the
      app-runner parent and reads identically across restarts and reinstalls.
- [ ] **T131** Pair a Room-sensing Light and open its sensor screen twice, a minute apart, on a
      sensor whose lux has changed in between. The week behind the thresholds must redraw with the
      newer reading — the Insights read now opts out of `homey-api`'s cache, which was both a
      retention leak and a stale screen.
- [ ] **T132** With a controller or Colour Curve Light running, force a re-subscribe (rename a zone,
      or add and remove a light from the target set) and confirm the lights keep responding. The
      subscribe path now reads its device uncached so that `homey-api` does not queue a whole-Homey
      device refresh behind every re-subscribe; a regression here shows as lights that stop
      following after a catalogue change.
- [ ] **T133** Run `npm run render:views` and then `npx homey app install`. The archive must not
      grow by the size of `.views/`. Report the archive size the CLI prints — it was 11.6 MB with
      826 files on 14 September.
- [ ] **T134** The three renamed device types, on a Homey that already has devices of each paired
      under the OLD names. **Devices → Add → Lightkeeper** must list **Light Remote**, **Colour
      Curve Light** and **Room-sensing Light** beside the unchanged **Circadian light** and **Light
      schedule**. The already-paired devices must keep the names their owner gave them, stay
      available, and keep driving their lights — the rename touches no driver id, no store key and
      no Flow, so a device that goes unavailable here means something else moved with it. Check the
      app's settings page too: the first section is headed **Light Remotes**, and a device that is
      mid-repair says "this device needs repair" rather than naming a type it is not.

### Last run — 13 September 2026 (evening), firmware 13.5.0, app 0.6.0 + the pairing rewrite

Run **twice**, in **Studio** and then in **Garage**, because the pass takes its test lamps from one
room and the two rooms have different integrations behind them. Both runs: **72 OK, 1 failed,
0 skipped.**

**The one failure is the clean slate, and it is the designed behaviour** — T121, confirmed on
hardware. 0.6.0 resets all five migration chains rather than extending them, so the four devices
this Homey already had come up unavailable with *"This device was set up by a newer version of
Lightkeeper"*. `runMigrationChain` refuses a plan whose `schemaVersion` is newer than it can read
and `DeviceLifecycle` quarantines on that, which is exactly what a stored plan from before the
rewrite should do. They need deleting and re-adding by hand; nothing else recovers them, and
nothing about them is broken in a way a fix would help.

**The pass found two real defects, and neither was reachable any other way.**

- **`catalog.devices()` and `catalog.getDevice()` are not methods.** They are `allDevices()` and
  `device()`. Six call sites across three drivers, all added by the pairing rewrite, all invisible
  to `tsc`, to the suite and to `validate` — because every driver's `private get app()` was typed
  `any`, so `this.app.catalog.anything()` compiled. On hardware they threw the moment a real screen
  asked: the Room-sensing Light's sensor picker could not list a single sensor. Fixed, and the
  accessor is now typed `LightkeeperApp` — `lib/app-contract.ts` was written for exactly this and
  the drivers had never used it. Typing it immediately caught a second one: `applyReattach` passed a
  possibly-`undefined` device into `discover()`, which would have re-attached a controller to an
  empty event surface and left it with no mappings.
- **Two warmth sliders ran backwards** — found in the render comparison rather than here, but it is
  the same class: the job editor and the schedule block placed the knob at the raw `warmth`, where
  1 is the warmest end (platform §6), on a track that runs candlelight-left to daylight-right.

**Three lines in the script itself were stale**, which is what a pass that drives pair sessions over
the Web API is for (platform §14): `getEnds`/`setEnds` became `getDay`/`setDay`, `getDaylight`
became `getResponse` with `sensor` rather than `sensors`, and **T15 asserted the opposite of the
new behaviour** — it required the later of an overlapping pair to be dropped, and 0.6.0 deliberately
keeps both and reports the clash. A bare array also does not survive `emitPairingEvent` intact (it
arrives as an object with numeric keys), so the schedule builder now sends `{ entries, days }`, the
shape the screen sends. `POST /schedules/:id/entries` gained `days` and `overlaps` to match.

**T60: 84.2 MB in Studio, 82.5 MB in Garage**, against the 100 MB ceiling and Homey's 30 MB
guideline. In range of the 80.8 / 90.1 MB readings from this same house earlier the same day —
compare a reading only with one from the same house.

Still owed, and all of them need a person on a phone: T3, T9–T11, T54, and the new
T112–T126 in [This release](#4-this-release). T122–T126 were added after that run — they came out
of holding every screen against a re-export of the design canvas WITH Homey's own chrome in the
picture, which is the one thing `render:views` had never drawn.

### Last run — 13 September 2026, Homey Pro 2023, firmware 13.5.0, app 0.6.0

`full --yes`: **72 OK, 2 failed, 0 skipped**, plus a whole-house `probe-lights.mjs` run. Both
failures were T59 and T60, and both are the memory reading — **every functional line passed**,
including the two the rejoin checks exist for (a lamp taken over by hand and given back on a power
cycle, on both a circadian and a Colour Curve Light), the credential removal and recovery, and a
teardown that left the four devices of this Homey's own untouched.

**T59/T60: the footprint doubled, and it is not this app's code.** 71.8 MB at the start of the pass
and 90.1 MB at the end, against a 50 MB ceiling — where the same line read 36.6 MB on a fresh install
four days earlier. So it was A/B'd rather than explained: the 9 September build (`09e120a`) and the
13 September build were installed one after the other, against the same four devices, each measured
after a restart. **67.5 MB and 68.2 MB.** Identical within noise. A steady leak was ruled out (no per-tick
growth at either size: both rise in steps over the first hour and then hold — four devices settled
at 75.1 MB and moved 1.0 MB across fifteen idle minutes), retention coming back was ruled out (three catalogue-reading passes moved it
0.2 MB), and `/diagnostics` was ruled out (ten calls cost nothing). What in the house moved was **not**
identified. The ceiling is now 100 MB and the line says what it can and cannot know; platform §15 has
the tables. **The app remains substantially over Homey's 30 MB guideline — that is unchanged, known,
and the lever for it is still incremental parsing.**

**The light probe ran over the whole house — 55 lamps across 9 integrations — and found nothing the
app gets wrong.** 20 lamps confirm `impliesOn` (a `dim` write turns an off lamp on), 8 pre-stage
successfully, and **no lamp in 55 gated a value behind `light_mode`** — consistent with the 1-in-36
rate that argued for writing the mode unconditionally. Every finding maps to an assumption already
documented and holding.

**It found three defects in the probe itself, all fixed here.**

- **A restore that could not put two Hue bulbs back.** `dim` was written first, and on a lamp found
  OFF the snapshot's `dim` is 0 — which a Hue treats as soft off, so every colour and temperature
  write after it was refused (`command (.color.xy) may not have effect`) and the run ended telling a
  person to set two lamps by hand. `dim` now goes last among the values. Replaying the same values in
  that order restored both bulbs exactly, which is the fix's own proof; `restorePlan()` is lifted out
  and unit-tested.
- **It woke a Synology NAS it had already been told it could not switch off.** The device answered the
  probe's off write with `Device is always-on`, was switched ON for the echo step, and then refused
  both writes that would have put it back. A device that refuses to be switched off is now never
  switched on — guarded in `write()`, where a fourth step cannot forget it — and says so as
  `PROBE_ONE_WAY_POWER`. **The NAS is still on; the Homey integration cannot switch it off, so that
  is a person's call rather than a script's.**
- **Two reporting faults.** A one-lamp run against a device that refused every write published
  `PROBE_SUSPECT_CACHE` at critical — whose own text says to believe nothing else in the report —
  because its population counted lamps that had taken no write. And the headline count double-counted
  run-level findings, showing 4 over a breakdown of 3.

**T53 was rendered — all 13 screens, at each screen's own height.** The daylight card and the curve
screen were read and are correct. The other eleven still want an eye.

**Still needs a person.** T3, T9, T10, T11, T54 as ever, and this release's physical lines T102, T103,
T105, T106 — plus T107–T111, which are the recorder-backed ones and were not run: the recorder is
built out of a launch build, and what is installed on this Homey is a launch build.

### Last run — 9 September 2026, Homey Pro 2023, firmware 13.5.0, app 0.7.0

*The build reported `0.7.0`; that work is part of 0.6.0 now. The number is left as the build
actually reported it, because a run record that does not match the archive it produced is worse
than one that needs this footnote.*

`full --yes`: **69 OK, 1 failed, 1 skipped**, plus `restart --yes` (4 OK) and the recorder lines
T98–T101 by hand. The skip was T34 in a SEPARATE `restart` run, after `full`'s teardown had already
removed the devices it built; T34 itself passed inside `full`.

**Two defects found, both fixed in this release, and neither reachable from a unit test.**

- **`process.memoryUsage()` throws in the app sandbox** (§17). It was called bare inside the object
  literal handed to `record()`, and a literal is evaluated in full before the call — so one throwing
  property took the whole health sample with it and the `catch` wrote a `sampling_error` in its
  place, once per sample, for the life of the recording. The first archive this feature ever produced
  contained **eight identical errors and zero health samples**, and the analysis reported
  `maxRssBytes: 0` because there had never been a reading to take a maximum of. Guarded; the boot
  after the fix produced a health sample with `memory: null` and every other field intact. This is
  precisely the class of bug the week-long recorder exists to surface, and it surfaced its own.
- **`onUninit`'s asynchronous work does not complete** (§17), so `app_shutdown` never reaches the
  archive. `recording_stopped` — same `record()`, same `flush()`, same `fsync` — arrives reliably,
  because it runs inside a request the platform waits for; that is the discriminator. Moving the call
  from the last line of `onUninit` to the first changed nothing. T99 was rewritten around `app_boot`,
  which is written on the way UP where there is no grace window to run out of.

**T60 failed at 63 MB PSS (+25.1 MB) and is the documented churn, not a leak.** The same line read
51.1 MB in 0.5.x and 56.3 MB after two passes in 0.6.0. A reinstall and re-measure gave **38.5 MB with
the recorder running** against **36.6 MB on the fresh install with none** — so the recorder itself
costs **+1.9 MB**, inside T101's 3 MB budget, and the 25 MB is the high-water mark of many
pair/teardown cycles in one app lifetime. Read T59 on a freshly installed app, as the 0.5.1 note
already said.

**T99 passed on the case that matters.** A plain `npx homey app install` of the same build kept the
run's `id`, `startedAt` and `endsAt` — 604800000 ms to the millisecond — with the record count growing
across it and `dropped: 0`. So `/userdata` and `homey.settings` both survive a plain install, which no
unit test could establish and the whole feature assumes. Three boots and one reinstall produced one
`runId`, four `bootId`s and a strictly monotonic sequence 1–353.

**T100's key hygiene is clean, and its threat model changed.** Zero occurrences of either Personal API
Key at 8, 16 and 32 characters, zero 20-plus hex runs anywhere in 152 KB of decompressed evidence, and
**five `<redacted>` markers** — so the redactor fired on real data rather than merely being present.
Against the raw served file: none of nine device and zone names, nor the household name, appears; all
26 frames are exactly `{iv, tag, data}`; the ciphertext is 41% printable against ~36% for random.
But the file **is** served without authentication (§17), so the cipher is load-bearing.

**T104 is answered, and it settles the R1 question the plan asked to confirm.** The class rule excludes
**18 of 58** `onoff` devices on this Homey, and every exclusion is right: a dishwasher, an air purifier,
a Synology NAS, a freezer, an air-conditioner, seven plain sockets, and Lightkeeper's own four
`class=service` devices. The one that settles it is **`Thomas's Tab A9+` — `class: other`, and it has
`dim`** — a tablet that "onoff is the whole rule" would have offered as a dimmable light, so a curve
pointed at that room would have been setting a tablet's screen brightness. The reversal is correct.

**Also observed, incidentally.** T21 shows `light_mode` written alongside `light_temperature`, which
is the per-device mode decision holding on real lamps. The analysis of the pass's own evidence reported
42 succeeded writes, 12 **cancelled** — the write cancellation working — 4 overrides and 0
malformed records. And `credential: valid=false` in the first health sample after a boot is correct
rather than alarming: `revalidateCredential()` is fire-and-forget at start, so the opening sample can
precede it, and the archive showing that is useful.

**Still needs a person.** T3, T9, T10, T11, T54 as ever, plus this release's own physical lines:
**T102** (cut a lamp at the wall and watch the tile stop saying all is well), **T103** (edit a Flow by
hand AND switch a lamp off — the verdict-composition case), **T105** (hold a button; the ramp must stop
on release), **T106** (kill the socket; a lamp toggle must still reach the app). T53 was rendered — all
13 screens — but the images still want an eye on them; the daylight screen was read and is correct,
including the feedback notice properly hidden on a decreasing response. T101's settings-page half
(**Discard archive**) was not exercised, only the CLI path.

### Last run — 4 September 2026, Homey Pro 2023, firmware 13.5.0-rc.4, app 0.6.0 + the simplification pass

`node scripts/verify-hardware.mjs full --yes`: **71 OK, 1 failed, 0 skipped**, then **23 OK, 0
failed** for a second `pair repair` after the failure was fixed, and **7 OK** for `teardown`. The
two devices the pass did not create were untouched throughout and running at the end.

**The one failure was in the harness, not the app.** T77 reported that a Room-sensing Light "was
created but the app never registered a runtime for it — it did not initialise". It had initialised
perfectly. The check searched `controllers`, `schedules` and `circadian` in the status response and
omitted `daylight`, which is its own key — so a Room-sensing Light could only ever fail it. Fixed in
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
