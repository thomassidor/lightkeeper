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
[`../docs/homey-platform.md`](../docs/homey-platform.md) §10.

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

**4. Circadian device** — for `drivers/circadian/assets/images/*`, and currently ALSO
for `drivers/curve/assets/images/*` until that artwork is drawn. The Curve light split out of the
circadian light in 0.5.0 and has no artwork of its own yet; byte-identical driver
images are a review finding, so the pair is recorded in `provenance.md`
and listed in `test/unit/assets.test.ts`'s `PENDING_ARTWORK`. A fifth prompt for the
Curve light — the same device body showing a distinctly coloured light rather than a
warm white — is what closes it. Landscape, 1500×1050 or larger; same crop treatment.

**Delivered 27 August 2026, and it took a different subject to the one specified below.** The brief
asked for a frosted-globe bulb on a base; what ships is the driver's own MARK rendered onto a device
body — a white rounded square carrying the warm-to-cool arc, a lit bulb and the sunrise and sunset
glyphs, on studio white with a soft contact shadow. That is the better answer and is what the
Curve light's fifth prompt should follow: the icon and the picture now show the same thing, so the
device type reads the same in a driver list as it does on a tile, and the arc carries the
warm-to-cool idea more legibly at 75×75 than a gradient across a globe did. **The exact prompt text
was not captured** — recorded as a gap rather than reconstructed, on the same principle that keeps
`provenance.md` from inventing a model name.

The subject brief, for whoever redraws it or draws the Curve light's:

> Device picture for the part of Lightkeeper that makes lights follow the colour of the day — warm
> at dawn, cool through the middle, warm again at night. The object that stands for it is a wall
> device whose face shows the shape of the day.
>
> Product render on a pure white background. One original generic square wall unit with generously
> rounded corners, matte warm-white body, seen three-quarter from the left so the side face reads as
> depth. On its front, an arc rising left to right and back down, gradient from warm amber (around
> #F2A93B) at both feet through cool daylight blue at the apex, with a small glowing marker sitting
> on the descending right-hand limb. Centred below the arc, a warm lit bulb glyph. Below each foot
> of the arc, a small line-art sun glyph — sunrise with an up arrow on the left, sunset with a down
> arrow on the right. Soft even studio light, subtle contact shadow. Whole object with even margin,
> the arc's warm-to-cool shift still readable at 75×75. No text, no numerals, no logos, no branding,
> no resemblance to any real product, no hand, no props, no packaging, no watermark.

Four things in those prompts are deliberate, so nobody "fixes" them:

- **Every device shot is white-ground product imagery**, so the pictures read as one app and all
  satisfy the "device on a white background" rule. Two are photographs and the circadian one is a
  render, because its subject is a virtual device with no physical product to photograph.
- **The warm-to-cool shift is a gradient, not two halves.** Two halves read as a novelty product; a
  gradient reads as a colour temperature moving through the day, which is what the device does. On
  the circadian device that gradient runs along the arc, which holds up at 75×75 where a shift
  across a globe did not.
- **The timer's dial glows but carries no numerals.** The glow says "time" at 75 px where digits would
  turn to mush, and printed numerals in a store image read as clipart.
- **No hand in any frame, including the banner.** A hand on a remote describes only half of what the
  app does — that is exactly what the previous banner got wrong.

These prompts are the record: [`provenance.md`](provenance.md) links here rather than
repeating them, and carries the date, the generator and the rights register. Update both when a
master is replaced.
