# Artwork provenance and rights

Every shipped graphic is built from `masters/` by `export-assets.py`. Nothing is hand-edited: an edit
to a shipped file is lost on the next export. What to produce, and why, is in
[`asset-spec.md`](asset-spec.md); how Homey consumes it is in
[`../docs/homey-platform.md`](../docs/homey-platform.md) §10.

## The Curve light's artwork is a PLACEHOLDER

The Curve light split out of the circadian light in 0.5.0 and ships with its
artwork: `drivers/curve/assets/` is exported from `circadian-icon-master.svg` and
`circadian-device-master.png`, the same two masters the circadian light uses.

That is a real review finding rather than a cosmetic shortcut — Athom's automated
reviewer flags byte-identical icons between drivers as reuse — so it is recorded
in three places rather than tolerated silently:

- `artwork/export-assets.py`, at both target entries, marked PLACEHOLDER;
- `test/unit/assets.test.ts`, as the single entry in `PENDING_ARTWORK`;
- here.

**Definition of done:** draw `curve-icon-master.svg` and `curve-device-master.png`,
point both entries in the export script at them, re-export, and delete the
`PENDING_ARTWORK` entry. The test that asserts every pending entry names a real
icon target is what stops the list outliving what it excuses.


## The masters

| Master | Feeds |
|---|---|
| `logo-mark-master.svg` | `assets/icon.svg`, and the logo tile on the README banner |
| `remote-remote-icon-master.svg` | `drivers/controller/assets/icon.svg` |
| `schedule-icon-master.svg` | `drivers/schedule/assets/icon.svg` |
| `circadian-icon-master.svg` | `drivers/circadian/assets/icon.svg` |
| `app-hero-master.png` 1499×1049 | `assets/images/*` and `readme/banner.png` |
| `remote-device-master.png` 1499×1049 | `drivers/controller/assets/images/*` |
| `schedule-device-master.png` 1500×1049 | `drivers/schedule/assets/images/*` |
| `circadian-device-master.png` 1500×1049 | `drivers/circadian/assets/images/*` — **PLACEHOLDER** |
| `logo-bitmap-original.png` 1071² | nothing ships from it; it is the palette's source of truth |

Supplied by the author on **23 August 2026**, replacing a set generated on 12 August 2026. The
photographs are image-model output from the prompts in
[`asset-spec.md`](asset-spec.md#prompts-for-the-four-photographs), reviewed to exclude logos,
trademarks, brand-recognisable hardware and text — Homey's review checks that store imagery is not
manufacturer photography, so that matters. The prompts live there and are not repeated here; this file
carries the date, the tool and the rights.

## `circadian-device-master.png` is a placeholder and MUST NOT ship

Written on **25 August 2026** by `artwork/masters/make-circadian-placeholder.py` — a warm-to-cool
radial wash with the driver's own sun mark on it. It exists so the driver validates, the export runs
and the suite is green while the real photograph is sourced; **it is not a photograph and Athom's
guideline 1.4 rejects exactly this** ("images that consist of a single flat shape or icon on a plain,
monochrome or transparent background are not approved"), which is why the schedule driver ships a
photograph of a plug-in timer rather than a rasterised stopwatch.

To finish it: put a landscape photograph at that path — a lamp in a room at golden hour reads the
subject best — re-run `python artwork/export-assets.py`, and delete this section along with the
**PLACEHOLDER** note above. Nothing else changes: the crop is found by non-white detection, so a new
master reframes itself.

**The specific model is not recorded.** That is a gap rather than a decision: this file is where a
reviewer or a future maintainer looks, and "an image model" is a weaker answer than a name. Whoever
replaces a master next should write theirs in.

## Icon weight

All four icons ship at `stroke-width` 40 on the 960 canvas, Homey's house weight. Fitted to the
canvas the masters' own strokes are 31 (logo), 22 (stopwatch), 20 (sun) and 14 (remote): four different
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
