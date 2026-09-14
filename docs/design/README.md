# The pairing redesign canvases

Two Claude Design canvases, the source of the pairing rewrite. Neither is bundled into the app —
`docs/` never is — and neither is read by any script. They are here so the reasoning behind a screen
survives the session it was designed in.

Open either `.dc.html` in a browser; `support.js` beside them is the canvas runtime and has to stay
where it is.

| File | What it is |
|---|---|
| `Lightkeeper pairing flows.dc.html` | **The settled design.** All five device types, one row each: the happy flow left to right, then the special cases to the right of the divider. This is what was built |
| `Lightkeeper pairing redesign.dc.html` | The iteration archive — turns 1 to 4, every direction that was tried and rejected, and the seven day-editor options that turn 4 chose between. Read it for *why*, not for *what* |

The settled file supersedes the archive wherever they disagree, and the archive says so itself at
the top.

**One thing in the shipped app deliberately departs from both.** The canvases move the Personal API
Key screen to the end of the controller and schedule flows, on the grounds that the key only gates
Flow *writes* at save. It ships early instead — after the intro, before step 1 — because somebody
who reaches a four-step review and then cannot produce a key loses everything they just set up. The
chore costs a returning user nothing, since the key is per-Homey and `credential.html` skips itself
when a stored one is valid.

`uploads/` holds the three screenshots of the OLD screens that were pasted into the review. The
contact sheet of the old views that was also uploaded is not kept — `npm run render:views` produces
the equivalent for whatever is on disk today.

The plan that turned these into code is [`../history/pairing-redesign-plan.md`](../history/pairing-redesign-plan.md).

## `.designexports/`, and what a re-export changed

`.designexports/` (gitignored, same reason as `.views/`) holds PNG exports of
the canvas taken on 14 September 2026, **with Homey's own chrome switched on** —
the sheet header and the `← Previous` / `Next →` footer the container draws. That
is the difference that mattered: the artboards in the `.dc.html` files here each
end with a full-width dark primary button, and the re-export has none, because
with the chrome drawn it is obvious that Homey already supplies one.

So the app dropped its own `Start` / `Next` from every step whose
`driver.compose.json` declares a `navigation.next` — nine screens, each of which
had been drawing a second Next below the fold.

Two screens keep a button of their own, and both stopped declaring a `next` so
that Homey draws none beside it. They are the two that DO something rather than
collect something: `review.html` creates the device, and `credential.html`
validates the key against the Homey before anything moves on. The key screen's
`next` was worse than a duplicate — Homey's own button walked straight past an
empty field, and the flow carried on keyless until the review failed to save.

`scripts/render-views.mjs` now reproduces that chrome for the same reason, from
each driver's own compose. A render without it cannot show a duplicate, which is
how this survived the first pass.

## What was compared, and where it departs

Every screen was rendered with `npm run render:views` and held against these
canvases on 13 September 2026, and against `.designexports/` on 14 September. The
renders live in `.views/` (gitignored) and are regenerated rather than committed
— a PNG of a screen goes stale the moment the screen changes, and the canvas plus
the live render is the pair worth keeping.

Six deliberate departures, all recorded here rather than left to be
rediscovered as bugs:

- **The API-key screen comes near the START, not at the end.** The canvas puts it
  behind the work, on the reasoning that the key only gates Flow writes at save.
  That is true and it is the wrong trade: somebody who reaches a four-step review
  and cannot produce a key loses everything they just filled in.
- **The light picker keeps a one-line subtitle** under its heading, which the
  canvas does not draw. It is the only thing that distinguishes an identical
  screen across five device types, and the canvas's own rule allows one sentence.
- **The remote picker groups by room.** The canvas draws one flat list; the light
  picker and the sensor picker both group, and a house with 54 lights has enough
  remotes to want the same treatment.
- **The light picker keeps its "N chosen" line.** The canvas has no such line,
  and while the app drew its own Next it did not need one — the button was
  disabled and that said it. With the button gone, nothing else on the screen
  reports an empty selection, and Homey's own Next cannot be blocked.
- **A schedule block's colour is a warmth slider, not swatches.** The canvas
  folds the curve's palette out under "Set colour too". A schedule block stores a
  colour TEMPERATURE — its own list rows in the same canvas say "20%, warmest" —
  so the swatches would be a picker for a value the device does not hold.
- **A frozen sensor does not take the response screen over.** The canvas replaces
  the whole screen with the warning and three ways out. The app shows the same
  warning above the same controls: the sensor may well start reporting again, and
  a screen that refuses to let somebody finish is a worse answer than one that
  tells them what is wrong.
