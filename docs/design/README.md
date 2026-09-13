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

## What was compared, and where it departs

Every screen was rendered with `npm run render:views` and held against these
canvases on 13 September 2026. The renders live in `.views/` (gitignored) and
are regenerated rather than committed — a PNG of a screen goes stale the moment
the screen changes, and the canvas plus the live render is the pair worth
keeping.

Three deliberate departures, all recorded here rather than left to be
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
