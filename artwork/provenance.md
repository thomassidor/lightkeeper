# Artwork provenance and rights

Every shipped graphic is built from `masters/` by `export-assets.py`. Nothing is hand-edited: an edit
to a shipped file is lost on the next export. What to produce, and why, is in
[`asset-spec.md`](asset-spec.md); how Homey consumes it is in
[`../docs/homey-platform.md`](../docs/homey-platform.md) §10.

## The placeholders are gone, and the publish blocker with them

**The Room-sensing Light shipped with two PLACEHOLDER graphics** on **3 September 2026** for 0.6.0 —
a plain stroked circle for its icon, a flat violet disc for its device image. Both satisfied every
automated check, which was deliberate so the device type could ship, install and be tested, and
neither was finished work. **Both were replaced on 16 September 2026**, which closed the publish
blocker recorded here, in `artwork/asset-spec.md`, in `docs/homey-review-notes.md` and in each
master's own comment.

The icon is *The hood mark* below, and it ships with a recorded reservation. The device image is
`daylight-device-master.png`, further down, and has none.

`test/unit/assets.test.ts`'s `PENDING_ARTWORK` set is still **empty**, and was throughout: that set
excuses an icon from the no-two-identical comparison, and neither placeholder was ever identical to
anything. A placeholder is a *quality* problem, which no test can hold — which is why this section
existed, and why it is kept as a record now rather than deleted.

### The hood mark

`daylight-icon-master.svg` was **supplied as artwork on 16 September 2026** and shipped as given,
replacing the plain stroked circle that stood there from 3 September. Six strokes: a dome-topped form
with two folds inside it, and three parallel diagonals across its lower right. It was delivered under
the name `hood-mark.svg`, carrying `aria-label="Abstract hooded figure with three motion strokes"`.

**Two departures, both deliberate, neither to be quietly repaired.**

**It does not depict what its device type does.** Every other icon in the set does — a remote sending
a signal, a stopwatch, a sun on the horizon, a curve with its points — and `asset-spec.md` records
that the circadian and curve sets were made to show the *same thing* in the icon as in the device
picture, so a device type reads the same on a tile as in a driver list. This one shows neither a
sensor nor a light. It was raised before shipping, with the 24 px render below as the evidence, and
re-supplied unchanged; that is the decision, and it is recorded rather than re-argued. Anyone
redrawing it has an obvious brief to hand: the device render's own face — a curve descending from a
lit dot with a moon to an open dot with a sun — which is what "brightness from the light already in
the room" looks like.

**And it is the least legible of the six at 24 px**, which is the size that rules a driver icon
(§10). The three diagonals are 8 units apart on a 512 canvas and merge into one smear there; the two
folds inside the dome collapse into its outline. `npm run render:icons` draws the comparison. The
other five were each cut down until they survived that box — the curve icon went from thirteen
strokes to five — so the precedent for a redraw is to *remove* strokes, not to thin them.

The C2PA manifest it arrived with — roughly 8 KB of base64 in a `<metadata>` element, larger than
every other master in this folder combined — was stripped when the master was written, not in the
export: `build_icon()` copies inner markup through verbatim, and Homey fetches an icon by MD5 to use
as an alpha mask, so provenance metadata inside one is weight nothing can read. The provenance is
here instead, which is where this folder keeps it for every other master.


### What came before

Every other shipped graphic comes from a master drawn for it. The Colour Curve Light was the last
one outstanding — it split out of the circadian light in 0.5.0 and shipped with that driver's
graphics, which Athom's automated reviewer would have flagged as byte-identical reuse — and it got
`curve-icon-master.svg` and `curve-device-master.png` of its own on **27 August 2026**, before
release.

**If a genuine byte-identical reuse ever happens again**, record it in all three places rather than
one: the target entry in `artwork/export-assets.py`, an entry in `PENDING_ARTWORK`, and here. A test
asserts each pending entry names a real icon target, so the list cannot outlive what it excuses.


## The masters

| Master | Feeds |
|---|---|
| `logo-mark-master.svg` | `assets/icon.svg`, and the logo tile on the README banner |
| `remote-remote-icon-master.svg` | `drivers/controller/assets/icon.svg` |
| `schedule-icon-master.svg` | `drivers/schedule/assets/icon.svg` |
| `circadian-icon-master.svg` | `drivers/circadian/assets/icon.svg` |
| `curve-icon-master.svg` | `drivers/curve/assets/icon.svg` |
| `daylight-icon-master.svg` | `drivers/daylight/assets/icon.svg` |
| `app-hero-master.png` 1499×1049 | `assets/images/*` and `readme/banner.png` |
| `remote-device-master.png` 1499×1049 | `drivers/controller/assets/images/*` |
| `schedule-device-master.png` 1500×1049 | `drivers/schedule/assets/images/*` |
| `circadian-device-master.png` 1499×1049 | `drivers/circadian/assets/images/*` |
| `curve-device-master.png` 1254² | `drivers/curve/assets/images/*` |
| `daylight-device-master.png` 1254² | `drivers/daylight/assets/images/*` |
| `logo-bitmap-original.png` 1071² | nothing ships from it; it is the palette's source of truth |

Supplied by the author on **23 August 2026**, replacing a set generated on 12 August 2026. The
photographs are image-model output from the prompts in
[`asset-spec.md`](asset-spec.md#prompts-for-the-six-images), reviewed to exclude logos,
trademarks, brand-recognisable hardware and text — Homey's review checks that store imagery is not
manufacturer photography, so that matters. The prompts live there and are not repeated here; this file
carries the date, the tool and the rights.

**Name the model when you replace a master.** "An image model" is a weaker answer than a name to a
reviewer or a future maintainer, and this file is where both look. The circadian device master below
is recorded that way; the 23 August set is not, which is a gap in the record rather than a decision.

## `circadian-device-master.png`

Supplied by the author on **27 August 2026**, generated with **ChatGPT's image model** (OpenAI). It
replaces a placeholder written on 25 August 2026 by a script, `make-circadian-placeholder.py` — a
warm-to-cool radial wash with the driver's own sun mark on it, which existed only so the driver
validated and the suite stayed green while real artwork was sourced. That script has been deleted
along with the file it made; nothing else referenced it.

The placeholder had to go because **Athom's guideline 1.4 rejects exactly what it was** ("images that
consist of a single flat shape or icon on a plain, monochrome or transparent background are not
approved") — the same reason the schedule driver ships a photograph of a plug-in timer rather than a
rasterised stopwatch.

What replaced it is a **dimensional render of a device**, not a photograph: a white rounded-square
body carrying the driver's own mark — the warm-to-cool arc, a lit bulb, and the sunrise and sunset
glyphs — lit on studio white with a soft contact shadow. That clears 1.4 (it is a picture of an
object, not a flat shape on a plain ground) and it is what Athom asks a *driver* image to be, "a
recognizable picture of the device". It is worth noting that it is the one device image in the set
that is a render rather than a photograph, because the app's other two are photographs; the subject
here is a virtual device with no physical product to photograph.

It carries no logo, trademark, brand-recognisable hardware or text, which is the same review filter
every other master was checked against. The crop is found by non-white detection, so it reframed
itself on export with no hand-measured box.

`daylight-bulb.svg` arrived in the same delivery and proved byte-identical to the
`circadian-icon-master.svg` already in the tree, so the icon was already correct and nothing changed
there.

## `curve-device-master.png` and `curve-icon-master.svg`

Supplied by the author on **27 August 2026**, generated with **ChatGPT's image model** (OpenAI), in
the same delivery style as the circadian pair above and checked against the same filter: no logo,
trademark, brand-recognisable hardware, or resemblance to a real product.

The device master is **1254 × 1254 — square, where every other device master is landscape**. That is
harmless rather than an oversight: `subject_square()` finds the subject by non-white detection and
centres it on a white square, so the aspect of the master never reaches a shipped file. It is
recorded here so nobody "fixes" it into 1500 × 1050 and reframes the crop for no reason.

**It carries text, and the brief says not to.** The four hour labels — 06:00, 12:00, 18:00, 00:00 —
break the "no text, no numerals" rule that
[`asset-spec.md`](asset-spec.md#prompts-for-the-six-images) applies to every device shot, for a
stated reason: numerals turn to mush at 75 px and printed type in a store image reads as clipart.
Checked at 75 px, both halves of that prediction hold — the labels are illegible — **and the image
still works**, because they degrade into a faint tick row under the curve rather than into visible
broken text, and the curve with its four coloured points carries the whole meaning on its own. Kept
deliberately, not by omission. If Athom's reviewer objects, the fix is a re-render of the same
composition with the labels dropped; nothing else changes.

The icon is a three-point curve over a baseline — a different mark from the circadian light's sun
on the horizon, which is what the two device types needed: one says "the shape of the day is handled
for you", the other says "every point is yours". Both were redrawn in 0.5.1 for the App Store's 24px
box (see **Icon weight** below); before that the curve was four points over a row of hour ticks
inside a rounded-square frame, and the circadian light was a bulb under a daylight arc. Each icon's
canvas fit comes from `--measure`, stored in the script so a normal export needs no browser.

## `daylight-device-master.png`

Supplied by the author on **16 September 2026**, generated with **ChatGPT's image model** (OpenAI) —
same delivery route as the circadian and curve pairs above, and checked against the same filter: no
logo, trademark, brand-recognisable hardware, or resemblance to a real product. It replaced the flat
violet disc that had stood since 3 September and was the last thing holding the publish blocker open.

**1254 × 1254, square**, matching `curve-device-master.png` rather than the landscape masters. Same
note applies: `subject_square()` finds the subject by non-white detection, so a master's aspect never
reaches a shipped file. Nothing to fix.

It is the **third render of the same device family** — the rounded-square wall unit, three-quarter
from the left, on studio white — which is what makes the three engine-driven device types read as one
app in a driver list. What differs is the face, and here it carries the whole idea: a curve
descending from a glowing amber ring to a plain grey one, a crescent moon under the lit end, a sun
under the dim end. Dark room, bright lamp. It also gains a domed sensor lens, which none of the
others has and which is the one honest signal that this device type *reads* something rather than
only writing.

**The subject box includes the drop shadow, and that was checked rather than assumed.** The device's
true right edge is at x≈1075; non-white detection runs out to x=1224 because a soft shadow falls to
the right, so the box is about 17% wider than the object. The resulting crop was rendered and looked
at before the master was committed — the device sits centred with even margins, and the box aspect
(1.08) is within a hundredth of the shipped curve master's (1.09), so the behaviour is in family
rather than new. **If a future master ever crops badly, this is the thing to measure first**: the
threshold is `L < 245`, and a shadow softer than that is invisible to it while a harder one is not.

**It carries no text and no numerals**, so it does not need the exception the curve master takes
above. The moon and sun are line-art glyphs, and at 75 × 75 the lens and the lit amber ring are what
survive — checked, not assumed.

## Icon weight

Every icon is normalised to a house weight rather than its master's own. Fitted to the canvas the
masters' own strokes are 31 (logo), 23 (sun), 22 (stopwatch), 16 (curve) and 14 (remote): five
different weights, and the remote a hairline at the 32 px Homey renders. Judged from a contact
sheet at 32/40/56 px, on white and as a white mask on the brand violet — which is how Homey
actually draws them. `export-assets.py --weight drawn` reproduces the masters' own weights if the
decision is ever revisited.

There is **one** house weight: 40, what all 226 of homey-lib's stock class icons use.

There were two for a while. The four device icons shipped at 34 because they were denser drawings
than a stock class glyph — a stopwatch face with hands and tick marks, a bulb under an arc between
two suns, a curve over a row of hour ticks — and at 40 the gaps inside them closed up into a bulky
blob on a device tile. That reasoning was sound about the tile and wrong about everywhere else. The
App Store draws a driver icon into a **24 px** box (platform §10), where 34 units on a 960 canvas is
a 0.85 px hairline; 0.5.0's listing showed four device icons as smudges inside their brand circles.
Each of the four lost the rounded-square frame around its subject and every element worth less than
a pixel — the circadian icon went from seventeen strokes to five, the curve from thirteen to five
and the stopwatch from eight to four — and went back to 40. The remote stayed at five and was
redrawn twice: at its old 0.34 aspect `mask-size: contain` fitted it by height and left it eight
pixels wide, and once squared up it read as a speaker — a big circle over a small one in a rounded
box is a woofer over a tweeter. Detail inside the box
could not fix that at 24px; two signal arcs off the top-right corner could, because they change
the silhouette rather than its contents. `npm run render:icons` is the contact sheet that decided it, drawn with
homey.app's own markup and CSS at 24, 34, 48 and 144 px of ink.
`export-assets.py --weight drawn` still reproduces the masters' own weights if the decision is ever
revisited.

**What the store never actually confirmed.** That redraw was made against blank flow-card circles on
the published listing, and it was read as proof that the drawings had been too fine. It was not. The
0.5.1 listing showed the same blank circles after the redraw, and the fault turned out to be a
cache/CORS transient in the browser looking at it — a hard refresh brought every glyph back, at 40
units, unchanged (platform §10 records how to tell that apart). So the simplification stands on its
own merits, the weight stays at 40, and the listing is not evidence either way. Judged on the page
today the icons read.

40 stays because it is what homey-lib's 226 stock class icons use — checked in
`node_modules/homey/node_modules/homey-lib/assets/device/icons/*.svg`: same 960 canvas, same 40-unit
outer stroke. At 40 units every mark in ours is exactly 1.00 px in the store's 24 px box, which
sounds alarming written down, so it was measured against the same stock icons rather than argued
about. Alpha coverage of the 24 px box, rasterised with this script's own `rasterise_svg`:

| | coverage at 24 px |
|---|---|
| `assets/icon.svg` | 10.5% |
| `drivers/circadian/assets/icon.svg` | 10.7% |
| `drivers/curve/assets/icon.svg` | 11.5% |
| `drivers/schedule/assets/icon.svg` | 12.6% |
| `drivers/controller/assets/icon.svg` | 16.4% |
| homey-lib `light-bulb.svg` | 10.4% |
| homey-lib `clock.svg` | 22.0% |
| homey-lib `socket.svg` | 23.8% |

All five sit inside the range Homey's own icons occupy, and `light-bulb.svg` — the stock icon a
light shows by default — is lighter than every one of them. So there is no legibility case to
answer at the house weight, and the numbers are the reason rather than an opinion about a contact
sheet. Reproduce them by rasterising each file at 24 and summing the alpha channel; the two
homey-lib entries are the calibration and are what makes the row meaningful.

The one difference worth knowing, if the question ever does come back: those stock icons reach their
coverage with **filled regions and lighter 10–20-unit interiors** — `light-bulb.svg` is one closed
40-unit outline around a filled base, `clock.svg` has a filled pivot — where ours are pure open
line art. Mass, not weight, is the lever. It is untried, and on this evidence it is not needed.

## Palette

`#180E32` is 93% of `logo-bitmap-original.png` and `#CCB0F3` is its mark. Both are read out of that
file by `export-assets.py --palette`, which prints them as `LOGO_GROUND` and `ACCENT`.

**The violet that ships is not the extracted one.** `BRAND` — and so the manifest's `brandColor` and
the UI's `--lk-accent` — is `#2A1958`: the same hue (257°) and saturation (56%) as the ground, with
HSL lightness taken 12.5% → 22%. The reason is `platform §10`: the App Store paints `brandColor` as
the circle behind every app and flow-card icon, and at the extracted value that circle reads as a
black dot, so the one place the brand colour is most visible was the one place it did not look
violet. Perceptual lightness roughly doubles (L\* 6.7 → 14.7) and the white icon mask still sits on
it at 15.3:1, down from 18.3:1. `--palette` prints both values, so the derivation stays traceable to
the file, and `test/unit/assets.test.ts` fails if the manifest's `brandColor` stops agreeing with the
script's `BRAND`.

Every other brand tone in the UI is derived from those two; the logo carries no mid-tones.
`--lk-accent-strong` moved with the accent, from `#2b1a52` to `#3B2279`, keeping the +8.5
lightness-point offset that makes it a distinguishable ink against `--lk-accent-tint`; at the new
accent the old value would have been the accent itself.

## Rights

- Lightkeeper's source, and the three generated icons: MIT, © Thomas René Sidor. See `../../LICENSE`.
- The masters: authored or generated for this app, no third-party rights claimed. They are not
  photographs of any real product, and no real brand's hardware is depicted.
- **`homey-api` is not MIT.** Its licence permits free use with Homey products but keeps the source
  proprietary to Athom B.V. and disclaims warranty. Bundling it in a Homey app is the permitted use,
  and it does not inherit this repo's licence.
- **The five capability icons in `assets/capabilities/` are Athom's**, copied unmodified from the
  capability reference (`athombv.github.io/athom-cloud-driver-reference/icons/`) under Athom's own
  file names — `dim`, `light_temperature`, `light_hue`, `measure_luminance`, `light_mode`. They are
  Homey's stock icons for those capabilities, used in a Homey app for the rows they were drawn for.
  Not MIT, not generated by `export-assets.py`, and not held to the 960-canvas rules in
  `asset-spec.md`, which govern the icons this app draws itself.
- Homey, IKEA and Philips Hue are referenced nominatively, to say what the app works with. Lightkeeper
  is not affiliated with or endorsed by any of them, and the store imagery stays free of their marks.
