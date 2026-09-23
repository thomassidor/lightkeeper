# The design system, the flows, and where the app departs from them

Two Claude Design canvases. Open either in a browser and it renders; `support.js` is their runtime.

- **[`Lightkeeper design system.dc.html`](Lightkeeper%20design%20system.dc.html)** is the rulebook.
  Five type sizes, four radii, three border roles, two button shapes, and live specimens of every
  recurring component at the size it ships. Its own first line is the governing one: *"Anything not on
  this page is not in the system."*
- **[`Lightkeeper pairing flows.dc.html`](Lightkeeper%20pairing%20flows.dc.html)** is that system
  applied: thirty-four screens at 390px, all five device types plus the credential gate, happy path on
  one row and the special cases on a second.

**They are the durable visual reference, and the shipped views are compared against them screen by
screen.** `npm run render:views` draws every pair view inside Homey's own sheet to `.views/`, which is
the artefact to put beside the flows file.

## What they are the authority on

Everything not listed below. The type scale (20 / 16 / 15 / 13 / 11, plus 32 for the two display
numerals), the four radii (8, 12, 16, pill — with 50% for round marks and 2px for chart bars), the
three border roles, the four inks, the three surfaces, the button shapes, the status colours, the
swatch grids, the heatmap, the day strip, and all the copy. When a view and the canvases disagree about
one of those, the view is wrong — and two tests in `pair-view-styles.test.ts` now say so for the type
scale and the radii, so it fails rather than drifts.

## Where the system page and the flows file disagree

The flows file wins. It is the shipping artefact, and the system page says everything on it *"is in use
in the flows file"*. Three known conflicts:

1. **`700` is legal on the numbered medallion and the checkbox tick.** The system says 700 is screen
   titles only, while its own specimens draw both of those at 13/700.
2. **The hatch keeps `#f7f8fa`.** The system says there is no third surface; the missing-reading cell
   in the flows file is drawn with one.
3. **Card gaps follow the flows file's per-screen values**, not the system's blanket 7px / 10px.

One warning on the system page is about the canvas rather than the code: `font: 600 13px/1.2 inherit`
is invalid and silently computes to 16px/400, *"live in 89 places"*. That was the canvas's own markup —
this repo hit the same bug in seven places, fixed it, and has guarded it ever since.

## Where the app departs from them, on purpose

1. **"Which remote?" keeps its search field, its room grouping and its "Show every other device"
   fold.** The canvas draws a flat card of three. The fold is the answer to "my remote is not in the
   list" for a device whose events arrive by a route the app cannot count — rare, real, and
   otherwise a dead end — and search matters in a house with 54 devices.

2. **`curve.html` keeps "Remove this time".** The canvas draws "Add a time" and no way to take one
   away.

3. **`source.html` keeps its "Leave it alone" row.** The canvas lists only the devices. One of the
   two questions has to be answerable with "not this one", because `job.needASource` requires at
   least one of them to be answered with something.

4. **`job.html` keeps "Set a warmth too" under the brightness preset**, and keeps the
   `temperature_cycle` tile for rules that already use it — it is never offered to a new one.

5. **`tryit.html` keeps its per-lamp result list** ("Set" / "Off, left alone"). The canvas ends at
   the two buttons. Reporting which lamps answered is the only evidence the preview gives.

6. **A circadian boundary steps ±150 minutes.** The canvas's prototype clamps asymmetrically
   (−120…+240 in the morning, −240…+120 in the evening). `MAX_OFFSET` and `OFFSET_STEP` in
   `lib/circadian/simple-curve.ts` carry the reasoning for the symmetric range.

7. **A Room-sensing Light's last screen offers two of the three ways to control lights.** The
   2026-09-23 handoff draws "Set lights before they turn on" there too. It writes brightness and
   nothing else, and a brightness sent to an off lamp switches it on — so that option's test would
   fail on every lamp there is. `lib/pairing/control-choice.ts` has the argument, and its first
   answer is reworded for brightness ("at their previous brightness").

8. **The flat and quiet sensor blocks say what the week shows, not what the handoff's sample said.**
   "1 to 4 lx, and only when the door opens" is the mockup's own cupboard; the app cannot know about
   a door, so it says "{low} to {high} lx — nothing to act on". The quiet block's "until Saturday
   lunchtime" is "until Sat 12:40" — the grid's own weekday label and a clock time, both checkable
   against the hatched cells.

9. **The open room's tinted header is `--lk-accent-tint` (#f3eefc), not the handoff's #F4F2FA.** The
   handoff says it adds no tokens, and the tint is the nearest one there is; the divider under it is
   the tint's own line, because a grey hairline on the tint reads as dirty.

**Four things stopped being departures.** Three because the flows file deleted them rather than
omitting them: "Look again" and "Add a light to Homey" on the no-lights screen, and "Open my.homey.app
again" on the rejected-key screen — all three are gone from the app too. And a Colour Curve Light
pairing with "Set brightness too" switched ON, which the canvas used to draw off: the 2026-09-23
handoff makes on the default for every "Set brightness too" there is.

## Open, not departed

Nothing, as of the 2026-09-23 handoff. The one question that was here — pre-staging had no control on
any screen, and neither canvas had one — is answered: it is the second option of *How Lightkeeper
controls your lights* on the last screen, with a per-lamp test. `SHOW_PRE_STAGE` and the hidden
switch it guarded are gone.

