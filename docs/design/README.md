# The design canvas, and where the app departs from it

[`Lightkeeper pairing flows.dc.html`](Lightkeeper%20pairing%20flows.dc.html) is a Claude Design
canvas: thirty-four screens at 390px, covering all five device types plus the credential gate, with
the happy path on one row and the special cases on a second. `support.js` is its runtime — open the
HTML file in a browser and it renders.

**It is the durable visual reference, and the shipped views are compared against it screen by
screen.** `npm run render:views` draws every pair view inside Homey's own sheet to `.views/`, which
is the artefact to put beside this canvas.

It is not a spec. It is a drawing made before the code existed, and in seven places the code knows
something the drawing does not. Those seven are below, with the reason, so that the next person to
put the two side by side does not spend an afternoon re-deciding them.

## What the canvas is the authority on

Everything not listed below: the colour tokens, the type ladder, every radius and gutter, the step
dots, the row shape, the card shape, the numbered intro rows, the swatch grids, the week grid, the
day strip, the nine job tiles, and all the copy. When a view and the canvas disagree about one of
those, the view is wrong.

## Where the app departs from it, on purpose

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

## Open, not departed

**Pre-staging has no control on any screen, and the canvas has none either — but that is a question
rather than an answer.** The setting exists, a new device still pairs with it on, and every guard
around it is intact; what is gone is the switch and the "Test it on my lights" button that let a
household prove it against their own lamps, which platform §6 says only their own lamps can prove.
It is behind `SHOW_PRE_STAGE` in `drivers/circadian/pair/day.html` and
`drivers/curve/pair/curve.html` — one line each — pending a decision about where it belongs.
