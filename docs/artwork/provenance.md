# Artwork provenance and rights

Every shipped graphic is built from `masters/` by `export-assets.py`. Nothing is hand-edited: an edit
to a shipped file is lost on the next export. What to produce, and why, is in
[`../asset-spec.md`](../asset-spec.md); how Homey consumes it is in
[`../../CLAUDE.md`](../../CLAUDE.md) §10.

## The masters

| Master | Feeds |
|---|---|
| `logo-mark-master.svg` | `assets/icon.svg`, and the logo tile on the README banner |
| `remote-remote-icon-master.svg` | `drivers/controller/assets/icon.svg` |
| `schedule-icon-master.svg` | `drivers/schedule/assets/icon.svg` |
| `app-hero-master.png` 1499×1049 | `assets/images/*` and `readme/banner.png` |
| `remote-device-master.png` 1499×1049 | `drivers/controller/assets/images/*` |
| `schedule-device-master.png` 1500×1049 | `drivers/schedule/assets/images/*` |
| `logo-bitmap-original.png` 1071² | nothing ships from it; it is the palette's source of truth |

Supplied by the author on **23 August 2026**, replacing a set generated on 12 August 2026. The
photographs are image-model output from the prompts in
[`../asset-spec.md`](../asset-spec.md#prompts-for-the-three-photographs), reviewed to exclude logos,
trademarks, brand-recognisable hardware and text — Homey's review checks that store imagery is not
manufacturer photography, so that matters. The prompts live there and are not repeated here; this file
carries the date, the tool and the rights.

**The specific model is not recorded.** That is a gap rather than a decision: this file is where a
reviewer or a future maintainer looks, and "an image model" is a weaker answer than a name. Whoever
replaces a master next should write theirs in.

## Icon weight

All three icons ship at `stroke-width` 40 on the 960 canvas, Homey's house weight. Fitted to the
canvas the masters' own strokes are 31 (logo), 22 (stopwatch) and 14 (remote): three different
weights, and the remote a hairline at the 32 px Homey renders. Judged from a contact sheet at
32/40/56 px, on white and as a white mask on the brand violet — which is how Homey actually draws
them. `export-assets.py --weight drawn` reproduces the masters' own weights if the decision is ever
revisited.

## Palette

`#180E32` is 93% of `logo-bitmap-original.png` and `#CCB0F3` is its mark. Both are read out of that
file by `export-assets.py --palette`, and `test/unit/assets.test.ts` fails if the manifest's
`brandColor` stops agreeing with the script. Every other brand tone in the UI is derived from those
two; the logo carries no mid-tones.

## Rights

- Lightkeeper's source, and the three generated icons: MIT, © Thomas René Sidor. See `../../LICENSE`.
- The masters: authored or generated for this app, no third-party rights claimed. They are not
  photographs of any real product, and no real brand's hardware is depicted.
- **`homey-api` is not MIT.** Its licence permits free use with Homey products but keeps the source
  proprietary to Athom B.V. and disclaims warranty. Bundling it in a Homey app is the permitted use,
  and it does not inherit this repo's licence.
- Homey, IKEA and Philips Hue are referenced nominatively, to say what the app works with. Lightkeeper
  is not affiliated with or endorsed by any of them, and the store imagery stays free of their marks.
