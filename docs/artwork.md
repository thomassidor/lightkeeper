# Artwork

Everything shipped is derived from two master images in `artwork/masters/` plus
three hand-authored SVGs. The masters are the only artifacts in this repository
that cannot be regenerated from something else.

**Read [What Athom enforces, and what it reviews](#what-athom-enforces-and-what-it-reviews)
before changing anything here.** Three of the four decisions on this page were
originally made against a guess at the rules and had to be redone.

## Palette

| Role | Hex | Where |
|---|---|---|
| Brand navy | `#1F3A5F` | manifest `brandColor`, both icons, primary buttons and selection in the UI |
| Link amber | `#F2A93B` | the accent in the UI: selection, the dial's wedge on the schedule screen, warm detail. **No longer in the icons** — see below |
| Light amber | `#FFD27A` | illuminated detail, currently unused |
| White | `#FFFFFF` | ink on navy |

White on navy is about 11.4:1, so the primary button is comfortably accessible.

**The UI uses this palette too, and did not always.** The pairing flow originally
ran on a generic `#2f6fed` blue for every interactive state — a colour that
appeared nowhere else the user had seen, in the app or in the store listing. Both
the settings page and the four pair views now take navy as the accent, declared as
CSS custom properties. In dark mode the accent has to invert: `#1F3A5F` is too dark
to carry white text on a dark ground, so the dark scheme lightens the accent to
`#6FA0D8` and darkens the ink on top of it.

## Icons

`assets/icon.svg` (app, a lighthouse), `drivers/controller/assets/icon.svg` (a
handheld remote) and `drivers/schedule/assets/icon.svg` (a clock) are all
960×960, **stroke-only line art**: `stroke="#000"`, `fill="none"`,
`stroke-width="40"`, `stroke-linejoin="round"`, transparent, and `viewBox` with no
`width`/`height`.

**That is Homey's own house style, not a preference.** Every one of the 226 stock
class icons `homey-lib` ships (`assets/device/icons/`) is exactly that. Guideline
1.5 forbids the alternative in as many words: *"do not use images, filled
illustrations, gradients, or background colours in your app icon. Submitting a
filled image or illustration as an icon will cause it to appear as a solid shape,
which is not recognisable at small sizes and will not be approved."*

**And there is a mechanical reason underneath the guideline.** `homey-lib` raises
this when a `brandColor` is too bright: *"Icons are rendered white, so choose a
darker color that has enough contrast."* Homey recolours the icon in several
surfaces. A two-colour filled mark — navy body, amber detail — becomes one
undifferentiated white silhouette there, losing exactly the figure/ground
separation the drawing was built on. **So the contact sheet has three rows now, and
the white-on-`brandColor` row is the one that matters most.**

Everything below was found by rasterising rather than by reading the SVG, which is
why that step is not optional:

- The app icon's two amber link arcs (in the filled era) were struck from the same
  vertical line with radii too close together. Their stroke bands overlapped and
  the pair rendered as one thick crescent.
- Splitting a bulb navy-glass/amber-cap detached the cap and the whole thing read
  as a balloon on a stick.
- The schedule icon began as a clock above a bulb: at 75 px, two shapes of equal
  weight read as two unrelated blobs, and the bulb — the shape every other lighting
  app draws — took the attention.
- Its second attempt was a dial with an amber wedge for the on-stretch of the day.
  Redrawn as line art the wedge became an inner arc, which closed against the two
  hands and made the whole mark read as a leaf. Pushed outside the rim instead, the
  same arc read as a wifi indicator. It is now a plain clock: nothing to
  misinterpret, and unmistakably not the remote beside it in the add-device list.
- The lighthouse without its beams reads as a pepper grinder at 32 px. The beams
  are load-bearing, and so is the ground line under the tower — without it the
  tower floats.

To check a change, render every mark at 32 / 40 / 56 / 80 / 140 px in three rows:
black on white, **white on `#1F3A5F`**, and black on near-black. The 32 px row
decides. Headless Chrome will do it:

```bash
chrome --headless=new --disable-gpu --screenshot=out.png \
       --force-device-scale-factor=2 --window-size=560,700 file:///path/to/sheet.html
```

Note that headless Chrome reports `prefers-color-scheme: dark` by default and
ignores `--force-prefers-color-scheme`, so a page that needs a specific scheme has
to force it in the CSS rather than ask the browser.

## Re-exporting the PNGs

```bash
python docs/artwork/export-assets.py
```

Regenerates all nine shipped PNGs from the two masters. Requires Pillow. The crop
boxes and the reasoning behind them are in the script — in particular why the
controller crop is 1120 px and not tighter, and why the schedule driver's window on
the hero is 420 px and not 270 or 520.

The icons are **not** in that pipeline: they ship as SVG, so the only tool they need
is the contact sheet above.

| | small | large | xlarge |
|---|---|---|---|
| app (10:7) | 250×175 | 500×350 | 1000×700 |
| driver (1:1) | 75×75 | 500×500 | 1000×1000 |

**Small and large are required; xlarge is optional.** This page used to say all
three were mandatory. `homey-lib`'s `_validateImages` iterates `['small', 'large']`
and never looks at xlarge, its schema marks `xlarge` optional, and its AI reviewer
is instructed not to raise a finding when xlarge is absent. We ship it anyway, for
high-resolution screens — but that is a quality choice, and the three xlarge files
are 1.8 MB of the app package if they are ever worth dropping.

`test/unit/assets.test.ts` checks presence, PNG magic bytes and exact dimensions
for every declared image, plus the line-art invariants for every icon, so a wrong
crop fails locally rather than at submission.

## Provenance

The hero and controller masters were generated on **12 August 2026** with OpenAI
image generation, then cropped and resized locally with Pillow. They are the only
two masters: the schedule driver's picture is a window on the hero, and the icons
ship as SVG. They are not photographs of any real product,
and were reviewed to exclude logos, trademarks, brand-recognisable hardware and
text. Homey's review does check that store imagery is not manufacturer
photography, so this matters.

All three SVG icons are original vector work, not generated.

### App hero master — `artwork/masters/app-hero-master.png` (1536×1024)

> Use case: photorealistic-natural. Homey App Store hero for Lightkeeper. A
> premium, believable Scandinavian living room at blue hour, deep navy ambient
> shadows and three warm lamps glowing together. In the foreground a hand
> naturally turns a small unbranded circular scroll-wheel remote; extremely subtle
> warm curved trails connect the gesture to the lamps. Editorial interior
> photography, photorealistic, 3:2 landscape composed for a 10:7 crop, readable at
> 250 x 175. No text, logos, trademarks, Homey or IKEA branding, screens or
> watermarks.

### The schedule driver's picture — a window on the hero, not a mark

There is no third master. The schedule driver's three PNGs are a 420×420 crop of
the hero master, centred on the right-hand table lamp with the blue-hour window
behind it.

**It shipped as the rasterised icon once, and that was the app's most likely review
finding.** The argument for it was honest — a schedule is not a device you can hold
— but it argues with a written rule rather than following it. Guideline 1.4 rejects
*"images with big two-dimensional unicolored shapes on a monochrome or transparent
background"*, and 1.4.3 asks for *"a recognizable picture of the device it
supports"* and says plainly *"Don't use your app icon as a driver image."*

So the device it supports is the lamp. What that trades away is the same
guideline's *"should have a white background"*: this picture is a dark room. That is
the deliberate choice — of the two rules we cannot satisfy at once, the flat-shape
one is the one the reviewer checklist states as a rejection and the white ground is
the one it states as a preference (*"white or transparent"*). It also means the two
driver pictures and the store image are visibly the same photography.

### Controller product master — `artwork/masters/controller-product-master.png` (1254×1254)

> Use case: product-mockup. Homey driver product master for the Remote-to-light
> controller. One original generic handheld smart-light controller combining a
> tactile rotary scroll wheel and three programmable buttons. Matte warm-white
> body, charcoal wheel, premium photorealistic catalogue render, centred on a pure
> white square background, recognizable at 75 x 75. No text, logos, trademarks,
> branded-product resemblance, hand, props, packaging or watermark.

**The hero's crop moved, and the reason is worth keeping.** It used to be centred,
which kept all three lamps and the hand turning the scroll wheel. That composition
predates the schedule driver: it says the app is a remote, which is half the story.
The crop is now a 920×644 window on the right of the frame — floor lamp, table
lamp, blue-hour window, no hand and no remote — so it reads as lights that came on
by themselves. The prompt above still describes the whole generated frame, hand
included; the shipped image is a window on it.

This is also why the hero is still a photograph rather than the app mark on a navy
field, which is what a graphics refresh naturally reaches for: guideline 1.4.2
rejects it — *"Images that consist of a single flat shape or icon on a plain,
monochrome or transparent background are not approved. For example, a black shape
on a white background will look flat and unappealing in the Homey App Store, rather
than inviting."* Lifestyle photography is what Athom asks for, in those words.

## What Athom enforces, and what it reviews

Two different gates, and confusing them is how this page ended up wrong three times
at once. Sources: `homey-lib/lib/App/index.js` for the validator,
`homey-lib/lib/AIReviewer/data/guidelines.md` and `checklist.md` for the review, and
Athom's published guidelines at
<https://apps.developer.homey.app/app-store/guidelines>.

**The validator (`homey app validate --level publish`) checks, and only checks:**

| Check | Where |
|---|---|
| `images.small` and `images.large` exist, case-sensitively, at exact pixel sizes | `_validateImages`, app and every driver |
| the file's magic bytes match its declared extension (`.png`/`.jpg`/`.jpeg`) | same |
| `assets/icon.svg` exists — at every level, not just publish | `_ensureFileExistsCaseSensitive` |
| `brandColor` is present and has brightness ≤ 184 | `isValidBrandColor` |

It never opens an SVG. There is **no** driver-icon existence check, no canvas or
`viewBox` check, no fill or stroke check, no file-size limit, and no `xlarge` check
of any kind. Everything else on this page is a rule a human or Athom's AI reviewer
applies, which means it costs a review round trip rather than a failed build.

**Things that do not exist, so we do not chase them:** flow cards cannot carry an
icon (the `icon` property in the SDK types belongs to *argument autocomplete
results*, and our cards take plain text and number arguments); `capabilitiesOptions`
cannot carry one either — only app-defined **custom** capabilities can, and our
schedule's switch is the standard `onoff`; there is no per-device icon override in
the manifest, and no screenshot or promotional asset class at all.

**The one asset class we ship nothing for:** widget previews. If a dashboard widget
is ever added, `widgets/<id>/preview-light.png` and `preview-dark.png` are a hard
build requirement — the build reads both and rethrows if either is missing — square,
at least 512 px, transparent, no text, simple shapes.

## Rights

- Lightkeeper source and all three SVGs: MIT, © Thomas René Sidor. See `../LICENSE`.
- The hero and controller masters: AI-generated as recorded above, no third-party
  rights claimed. Both are used for more than one shipped image now — the hero
  carries both the store image and the schedule driver's picture.
- **`homey-api` is not MIT.** Its licence permits free use with Homey products but
  keeps the source proprietary to Athom B.V. and disclaims warranty. Bundling it in
  a Homey app is exactly the permitted use, but it does not inherit this repo's
  licence.
- Homey, IKEA and Philips Hue are referenced nominatively, to say what the app
  works with. Lightkeeper is not affiliated with or endorsed by any of them, and no
  brand authorisation is needed for that — but the store imagery must stay free of
  their marks, which is why both prompts above exclude them explicitly.
