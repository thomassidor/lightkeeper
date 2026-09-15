# The pairing redesign canvas

`Lightkeeper pairing flows.dc.html` is the Claude Design canvas the pairing rewrite was built from:
all five device types, one row each, the happy flow left to right and the special cases to the right
of the divider. It is not bundled into the app — `docs/` never is — and no script reads it. It is
here so the reasoning behind a screen survives the session it was designed in.

Open it in a browser; `support.js` beside it is the canvas runtime and has to stay where it is.

## How it was arrived at

A second canvas held the iteration — four turns and the seven day-editor options — and has been
deleted, because the settled file supersedes it wherever they disagree and the rest is a picture of
paths not taken. `git log --diff-filter=D -- docs/design` finds it. The argument worth keeping:

- **Turn 1** offered two directions on one axis — lead with recognisable presets and hide the
  machinery until asked, or make the setting directly manipulable so you drag the thing you are
  describing.
- **Turn 2** rejected both as still doing three jobs at once: set the thing, teach the model, and
  warn about the edges. One decision per screen; every explanation either becomes the control's own
  behaviour or leaves pairing entirely for the device's settings page, where it is read when it
  matters rather than when somebody is trying to finish.
- **Turn 3** stretched that over the whole circadian driver — an intro and three steps — on the
  test that the skeleton then fits curve, daylight, schedule and controller unchanged.
- **Turn 4** is the one that changed the product. The day handle in turn 3 *"lies by omission:
  'warmest' is a single value the day passes through twice — once before the morning and once after
  the evening — but a single dot at 21:00 reads as one moment."* Seven ways out were drawn; **4g,
  round handles with the times inside their own group**, is what shipped.

The screenshots of the OLD screens that were pasted into the review are not kept, for the same
reason the contact sheet uploaded beside them was not: `npm run render:views` produces the
equivalent for whatever is on disk today, and a picture of a screen that no longer exists is only a
way to be wrong about it.

The plan that turned this into code has been deleted along with the rest of the archive; the
decisions it recorded are in `CHANGELOG.md`'s 0.6.0 entry, and `git log --diff-filter=D --
docs/history` finds the plan itself.

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
canvas on 13 September 2026, and against `.designexports/` on 14 September. The
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
