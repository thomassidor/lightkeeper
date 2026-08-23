# Asset spec

**The app.** Lightkeeper does two things to lights you already own: it turns a remote, switch or dial
you already have into a controller for them, and it puts them on a schedule. It writes the Homey Flows
underneath so the user never opens the Flow editor.

**So the photographs are about lit rooms, not technology.** Warm lamps at dusk in a calm Scandinavian
interior; deep blue-hour shadows; a hand on a small unbranded remote for the controller, and lamps
glowing with nobody in frame for the schedule. Brand colours are navy `#1F3A5F` and amber `#F2A93B`,
which the light in the photographs should sit inside. No screens, no phones, no visible technology, no
branding of any kind.

Twelve files. Generate each one at exactly the size given, at exactly the path given.

| File | Size | What it is | Used for |
|---|---|---|---|
| `assets/icon.svg` | 960×960 | Line-art app icon | The app's icon inside Homey: app list, the app picker when adding a device, Flow cards, app settings |
| `assets/images/small.png` | 250×175 | Photo | The app's card in App Store listings |
| `assets/images/large.png` | 500×350 | Photo, same shot | Banner at the top of the app's App Store page |
| `assets/images/xlarge.png` | 1000×700 | Photo, same shot | The same banner on high-resolution screens (optional file) |
| `drivers/controller/assets/icon.svg` | 960×960 | Line-art remote control | This device type's icon when adding a device, and on its tile afterwards |
| `drivers/controller/assets/images/small.png` | 75×75 | Photo of a remote | Device rows and lists |
| `drivers/controller/assets/images/large.png` | 500×500 | Photo, same shot | The "supported devices" grid on the App Store page |
| `drivers/controller/assets/images/xlarge.png` | 1000×1000 | Photo, same shot | The same grid on high-resolution screens (optional file) |
| `drivers/schedule/assets/icon.svg` | 960×960 | Line-art clock | This device type's icon when adding a device, and on its tile afterwards |
| `drivers/schedule/assets/images/small.png` | 75×75 | Photo of a lamp | Device rows and lists |
| `drivers/schedule/assets/images/large.png` | 500×500 | Photo, same shot | The "supported devices" grid on the App Store page |
| `drivers/schedule/assets/images/xlarge.png` | 1000×1000 | Photo, same shot | The same grid on high-resolution screens (optional file) |

Rules:

- **Icons** are stroke-only line art: `fill="none"`, `stroke-width="40"`, transparent, full 960 canvas,
  no gradients or background shape. Homey paints them as a flat single-colour mask, so colour inside
  the file is discarded. Must read at 32 px. No two identical.
- **Images** must be photographic. A flat shape or icon on a plain background is rejected. Colour has
  to reach every edge — no borders, no letterboxing. No Homey logo, name or hardware.
- Sizes are exact; a wrong one fails `homey app validate`. PNG or JPG, extension matching the format.

## Prompts for the three photographs

The icons are not generated — they are drawn as line art in the style `logo.svg` already sets, which
also fixes the palette. Only the photographs below need generating. Make each one larger than its
largest shipped size and loosely framed, so a crop can be moved later without regenerating; save into
`docs/artwork/masters/` and let `docs/artwork/export-assets.py` cut the shipped sizes.

**1. App banner** — for `assets/images/*`. Generate at 1536×1024 or larger, 3:2, composed for a 10:7 crop.

> Photorealistic editorial interior photograph. A calm Scandinavian living room at blue hour, deep
> navy shadows, three warm table and floor lamps glowing together as the only light sources. Nobody in
> frame. Warm amber light pooling on pale plaster and wood; cool blue dusk light through a window
> behind. Lamps spread across the frame so the composition survives a 10:7 crop, generous margin on
> all sides. Shallow depth of field, natural photography, readable when scaled to 250×175. No people,
> no text, no logos, no trademarks, no screens or displays, no visible smart-home hardware, no
> watermark.

**2. Controller device** — for `drivers/controller/assets/images/*`. Generate at 1254×1254 or larger, square.

> Product photograph on a pure white background. One original generic handheld smart-light remote:
> matte warm-white body, a charcoal rotary scroll wheel near the top, three round buttons below it.
> Three-quarter view angled from the right to give the object dimension, soft even studio light, subtle
> contact shadow. Whole device centred with even margin, recognizable at 75×75. Photorealistic
> catalogue render. No text, no logos, no branding, no resemblance to any real product, no hand, no
> props, no packaging, no watermark.

**3. Schedule device** — for `drivers/schedule/assets/images/*`. Generate at 1254×1254 or larger, square.

> Product photograph on a pure white background. One original generic table lamp, switched on: opal
> glass or matte ceramic dome shade glowing warm amber, slim stem, simple round base. Three-quarter
> view angled from the right, soft even studio light, subtle contact shadow. The lamp is clearly lit
> and emitting warm light. Whole lamp centred with even margin, recognizable at 75×75. Photorealistic
> catalogue render. No clock, no numerals, no text, no logos, no branding, no hand, no props, no
> watermark.

Three things in those prompts are deliberate, so nobody "fixes" them:

- **The lamp is a white-ground product shot, not a room scene**, so it matches the controller's photo
  language and the two device pictures read as one app. It also satisfies the "device on a white
  background" rule that the currently shipped crop bends.
- **No clock in the lamp shot.** The icon carries the time idea; a clock in the photo reads as clipart,
  which Athom rejects.
- **No hand in any frame, including the banner.** A hand on a remote describes only half of what the
  app does — that is exactly what the previous banner got wrong.

Record any prompt you actually use in `artwork.md` under Provenance, with the date and the generator —
the licence register depends on it.
