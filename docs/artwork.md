# Artwork

Everything shipped is derived from two master images in `artwork/masters/` plus
two hand-authored SVGs. The masters are the only artifacts in this repository that
cannot be regenerated from something else.

## Palette

| Role | Hex | Where |
|---|---|---|
| Brand navy | `#1F3A5F` | manifest `brandColor`, both icons, primary buttons and selection in the UI |
| Link amber | `#F2A93B` | the connection accent — icon link arcs, the lit bulb, the driver icon's wheel |
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

`assets/icon.svg` (app), `drivers/controller/assets/icon.svg` and
`drivers/schedule/assets/icon.svg` are all 960×960, flat vector, transparent, no
gradients.

**They are drawn for ~40 px, which is where Homey actually renders them.** The
first versions were 52 px strokes with interior detail — a screen, button bars, a
lamp stem, eight tick marks around the driver's wheel — and at 40 px every one of
those clusters collapsed into a grey smudge. Solid masses survive the downscale;
hairlines do not.

Two problems only showed up when the marks were actually rasterised, which is why
that step is not optional:

- The app icon's two amber link arcs were struck from the same vertical line with
  radii too close together. Their stroke bands overlapped and the pair rendered as
  a single thick crescent. They are now concentric about a point, with a real gap.
- Splitting the bulb navy-glass/amber-cap detached the cap and the whole thing read
  as a balloon on a stick. The bulb is amber throughout — which also means the mark
  keeps a large bright mass on a dark ground, where navy alone goes muddy.
- The schedule icon began as a clock above a bulb. At 75 px two shapes of equal
  weight read as two unrelated blobs, and the bulb — the shape every other lighting
  app also draws — took the attention. It is now the dial alone, with an amber wedge
  standing for the stretch of the day the lights are on. The wedge is inset inside
  the rim so a navy ring survives all the way round: drawn to the full radius it
  reads as a pie chart, and the hub is what turns a fan into a clock.

To check a change, render both at 32 / 40 / 56 / 80 / 140 px over white and near
black. The 32 px row is the one that decides. Headless Chrome will do it:

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

Regenerates all nine shipped PNGs from the three masters. Requires Pillow. The crop
boxes and the reasoning behind them are in the script — in particular why the
controller crop is 1120 px and not tighter, and why the schedule crop is the same.

Homey's required sizes are not negotiable and a wrong one fails
`homey app validate`:

| | small | large | xlarge |
|---|---|---|---|
| app (10:7) | 250×175 | 500×350 | 1000×700 |
| driver (1:1) | 75×75 | 500×500 | 1000×1000 |

## Provenance

The hero and controller masters were generated on **12 August 2026** with OpenAI
image generation, then resized locally with Pillow. The schedule master is a render
of our own SVG (see below). They are not photographs of any real product,
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

### Schedule mark master — `artwork/masters/schedule-mark-master.png` (1254×1254)

Not generated and not a photograph: it is `drivers/schedule/assets/icon.svg`
rendered on white by headless Chrome, a 1000 px mark centred in a 1254 px square,
then cropped and resized by the export script like the other two.

**The schedule driver ships its mark rather than a product shot on purpose.** The
controller driver depicts a physical remote, because there is one. A schedule is
not a device you can hold, and photographing a stand-in lamp would claim otherwise.
The crop is 1120 — exactly the controller's — so the two driver thumbnails sit at
the same visual scale in the pairing flow.

To regenerate it after editing the SVG:

```bash
# a page with the SVG centred in a 1254x1254 white frame, then:
chrome --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
       --window-size=1254,1254 --screenshot=schedule-mark-master.png file:///path/to/sheet.html
python docs/artwork/export-assets.py
```

### Controller product master — `artwork/masters/controller-product-master.png` (1254×1254)

> Use case: product-mockup. Homey driver product master for the Remote-to-light
> controller. One original generic handheld smart-light controller combining a
> tactile rotary scroll wheel and three programmable buttons. Matte warm-white
> body, charcoal wheel, premium photorealistic catalogue render, centred on a pure
> white square background, recognizable at 75 x 75. No text, logos, trademarks,
> branded-product resemblance, hand, props, packaging or watermark.

Keep the hero's 10:7 crop centred — the composition runs corner to corner and
shifting the window drops one of the three lights the image is about.

**The hero now under-describes the app.** Its composition is a hand turning a
scroll wheel, from when pointing a remote at lights was the whole product; the app
also puts lights on a schedule now. It is not wrong, only partial, and it is
flagged here rather than quietly kept: a re-shoot would want the same room at blue
hour with the lamps already lit and no hand in frame, so the image reads as lights
that came on by themselves.

## Rights

- Lightkeeper source and all three SVGs: MIT, © Thomas René Sidor. See `../LICENSE`.
- The hero and controller masters: AI-generated as recorded above, no third-party
  rights claimed. The schedule master is a render of our own SVG, so it carries the
  same licence as the source.
- **`homey-api` is not MIT.** Its licence permits free use with Homey products but
  keeps the source proprietary to Athom B.V. and disclaims warranty. Bundling it in
  a Homey app is exactly the permitted use, but it does not inherit this repo's
  licence.
- Homey, IKEA and Philips Hue are referenced nominatively, to say what the app
  works with. Lightkeeper is not affiliated with or endorsed by any of them, and no
  brand authorisation is needed for that — but the store imagery must stay free of
  their marks, which is why both prompts above exclude them explicitly.
