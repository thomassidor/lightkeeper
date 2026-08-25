# Artwork brief

**The app.** Lightkeeper does two things to lights you already own: it turns a remote, switch or dial
you already have into a controller for them, and it puts them on a schedule. It writes the Homey Flows
underneath so the user never opens the Flow editor.

**So the photographs are about lit rooms and ordinary objects, not technology.** Warm lamps at dusk in
a calm Scandinavian interior for the app; a remote on white for the controller; a plug-in timer on
white for the schedule. Brand colours are violet `#180E32` and lavender `#CCB0F3` — the dark and the
light of the logo — and the lamplight in the banner is the warmth inside that. No people, no screens,
no visible smart-home hardware, no branding of any kind.

Nothing shipped is drawn or cropped by hand. Every file below is built from a master in
`artwork/masters/` by `artwork/export-assets.py`, and the exact pixel sizes Homey requires are
asserted in `test/unit/assets.test.ts` rather than restated here. What Homey does with an icon, and
which of these rules a validator enforces versus a human reviewer, is in
[`../CLAUDE.md`](../CLAUDE.md) §10.

| File | What it is | Used for |
|---|---|---|
| `assets/icon.svg` | Line-art app mark: open circle with a sparkle | The app's icon inside Homey: app list, the app picker when adding a device, the app's grouping in the Flow editor, app settings |
| `assets/images/{small,large,xlarge}.png` | Photo, one shot at three sizes | The app's card and banner on its App Store page |
| `drivers/controller/assets/icon.svg` | Line-art remote control | This device type's icon when adding a device, and on its tile afterwards |
| `drivers/controller/assets/images/{small,large,xlarge}.png` | Photo of a remote | Device rows, and the "supported devices" grid on the App Store page |
| `drivers/schedule/assets/icon.svg` | Line-art stopwatch | This device type's icon when adding a device, and on its tile afterwards |
| `drivers/schedule/assets/images/{small,large,xlarge}.png` | Photo of a plug-in timer | The same two places |
| `artwork/readme/banner.png` | The hero photograph with the logo on a rounded violet tile | The top of `README.md`. Ships nowhere; built by the same script |

Rules, for whoever draws or generates the next set:

- **Icons** are line art on a transparent, full 960 canvas — no gradients, no background shape. Homey
  paints them as a flat single-colour mask, so colour inside the file is discarded and only the
  silhouette survives. Must read at 32 px. No two identical. Edit the master, never the shipped file:
  an edit to a shipped file is lost on the next export.
- **Images** must be photographic. A flat shape or icon on a plain background is rejected. Colour has
  to reach every edge — no borders, no letterboxing. No Homey logo, name or hardware.
- **`xlarge` is optional** and no validator ever opens it, but ship it: it is what a
  high-resolution screen gets.

## Prompts for the four photographs

The icons come from the SVG masters, so only the photographs need generating. Each prompt carries its
own app context and palette, so one block can be pasted into a generator on its own. Generate larger
than the biggest shipped size and loosely framed, so a crop can be moved later without regenerating;
save into `artwork/masters/` and let `artwork/export-assets.py` cut the shipped sizes — it finds the
subject against its ground, so replacing a master reframes the crop rather than silently
mis-centring it.

**1. App banner** — for `assets/images/*` and the README banner. Generate at 1536×1024 or larger,
3:2, composed for a 10:7 crop.

> Store banner for Lightkeeper, a smart-home app that turns a remote you already own into a
> controller for your lights and puts those lights on a schedule — so its imagery is about lit rooms,
> not technology.
>
> Photorealistic editorial interior photograph. A calm Scandinavian living room at blue hour, three
> warm table and floor lamps glowing together as the only light sources, nobody in frame. Warm amber
> lamplight (around #F2A93B) against cool blue dusk light through a window behind — lamplight, not
> brand colour. Warm light pooling on pale plaster and wood. Lamps spread across the frame so the
> composition survives a 10:7 crop, generous margin on all sides. Shallow depth of field, natural
> photography, still readable when scaled to 250×175. No people, no text, no logos, no trademarks, no
> screens or displays, no visible smart-home hardware, no watermark.

**2. Controller device** — for `drivers/controller/assets/images/*`. Landscape, 1500×1050 or larger;
the export finds the object and crops the square.

> Device picture for one half of Lightkeeper, a smart-home app that turns a remote, switch or dial
> you already own into a controller for your lights. This image stands for that device type, so it
> shows the remote itself.
>
> Product photograph on a pure white background. One original generic handheld smart-light remote:
> matte warm-white body, a charcoal rotary scroll wheel near the top, three round buttons below it.
> Three-quarter view angled from the right to give the object dimension, soft even studio light,
> subtle contact shadow. The app's palette is violet #180E32 and lavender #CCB0F3, so keep the object
> neutral — warm white and charcoal — to sit beside them without competing. Whole device with even
> margin, recognizable at 75×75. Photorealistic catalogue render. No text, no logos, no branding,
> no resemblance to any real product, no hand, no props, no packaging, no watermark.

**3. Schedule device** — for `drivers/schedule/assets/images/*`. Landscape, 1500×1050 or larger;
same crop treatment.

> Device picture for the other half of Lightkeeper, a smart-home app that puts lights on a schedule —
> on at dusk, off at bedtime, without anyone touching a switch. The device that stands for it is a
> timer.
>
> Product photograph on a pure white background. One original generic plug-in timer socket: matte
> warm-white body, a round dial face on the front with a glowing warm-amber ring, a pass-through socket
> below, plug pins visible at the side. Three-quarter view angled from the right, soft even studio
> light, subtle contact shadow. The dial glows, so it reads as time rather than as a plain adapter.
> Whole device with even margin, recognizable at 75×75. Photorealistic catalogue render,
> matching the neutral white-ground studio look of the remote in the app's other device picture. No
> numerals, no text, no logos, no branding, no hand, no props, no watermark.

**4. Circadian device** — for `drivers/circadian/assets/images/*`. Landscape, 1500×1050 or larger;
same crop treatment. **This one has not been generated yet** — `masters/circadian-device-master.png`
is a placeholder that guideline 1.4 would reject, and replacing it is the last thing standing between
this device type and a store submission. See [`artwork/provenance.md`](artwork/provenance.md).

> Device picture for the third part of Lightkeeper, a smart-home app that makes lights follow the
> colour of the day — warm at dawn, cool through the middle, warm again at night. The object that
> stands for it is a lamp whose light changes colour.
>
> Product photograph on a pure white background. One original generic frosted-globe smart bulb
> standing upright on a slim matte warm-white base. The globe is lit from within and the colour shifts
> across it: warm amber (around #F2A93B) low on the left, cool daylight white high on the right, a
> smooth gradient between them rather than two halves. Three-quarter view angled from the right, soft
> even studio light, subtle contact shadow. Whole object with even margin, the colour shift still
> readable at 75×75. Photorealistic catalogue render, matching the neutral white-ground studio look of
> the remote and the timer in the app's other device pictures. No text, no numerals, no logos, no
> branding, no resemblance to any real product, no hand, no props, no packaging, no watermark.

Four things in those prompts are deliberate, so nobody "fixes" them:

- **Every device shot is white-ground product photography**, so the pictures read as one app and all
  satisfy the "device on a white background" rule.
- **The bulb's colour shift is a gradient, not two halves.** Two halves read as a novelty bulb; a
  gradient reads as a colour temperature moving through the day, which is what the device does.
- **The timer's dial glows but carries no numerals.** The glow says "time" at 75 px where digits would
  turn to mush, and printed numerals in a store image read as clipart.
- **No hand in any frame, including the banner.** A hand on a remote describes only half of what the
  app does — that is exactly what the previous banner got wrong.

These prompts are the record: [`artwork/provenance.md`](artwork/provenance.md) links here rather than
repeating them, and carries the date, the generator and the rights register. Update both when a
master is replaced.
