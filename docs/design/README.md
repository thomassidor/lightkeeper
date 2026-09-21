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

1. **A Colour Curve Light pairs with "Set brightness too" switched ON.** The canvas says the default
   is off and the chart is purely a day of colour. A flat chart is a picture of one axis: every bar
   is full height, the Off-to-Full gutter is hidden, and nothing on the first screen shows that the
   second axis exists. The argument is written out at `DEFAULT_POINTS` in
   `lib/circadian/circadian-types.ts`, and the default five points carry a real day — 44% at 06:30
   rising to 94% at 19:00 and falling to 36% at 22:30.

2. **"Which remote?" keeps its search field, its room grouping and its "Show every other device"
   fold.** The canvas draws a flat card of three. The fold is the answer to "my remote is not in the
   list" for a device whose events arrive by a route the app cannot count — rare, real, and
   otherwise a dead end — and search matters in a house with 54 devices.

3. **`curve.html` keeps "Remove this time".** The canvas draws "Add a time" and no way to take one
   away.

4. **`source.html` keeps its "Leave it alone" row.** The canvas lists only the devices. One of the
   two questions has to be answerable with "not this one", because `job.needASource` requires at
   least one of them to be answered with something.

5. **`job.html` keeps "Set a warmth too" under the brightness preset**, and keeps the
   `temperature_cycle` tile for rules that already use it — it is never offered to a new one.

6. **`tryit.html` keeps its per-lamp result list** ("Set" / "Off, left alone"). The canvas ends at
   the two buttons. Reporting which lamps answered is the only evidence the preview gives.

7. **A circadian boundary steps ±150 minutes.** The canvas's prototype clamps asymmetrically
   (−120…+240 in the morning, −240…+120 in the evening). `MAX_OFFSET` and `OFFSET_STEP` in
   `lib/circadian/simple-curve.ts` carry the reasoning for the symmetric range.

**Three things stopped being departures**, because the flows file deleted them rather than omitting
them: "Look again" and "Add a light to Homey" on the no-lights screen, and "Open my.homey.app again"
on the rejected-key screen. All three are gone from the app too.

## Open, not departed

**Pre-staging has no control on any screen, and neither canvas has one either — but that is a question
rather than an answer.** The setting exists, a new device still pairs with it on, and every guard
around it is intact; what is gone is the switch and the "Test it on my lights" button that let a
household prove it against their own lamps, which platform §6 says only their own lamps can prove.
It is behind `SHOW_PRE_STAGE` in `drivers/circadian/pair/day.html` and
`drivers/curve/pair/curve.html` — one line each — pending a decision about where it belongs.
