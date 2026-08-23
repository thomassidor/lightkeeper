# Asset spec

Everything this app ships, as a to-do list. Two device types: `controller` (a remote) and `schedule`
(a timer). **Six originals get created; the nine shipped PNGs are all resizes of them.**

## 1a. Originals — the actual work

| # | File | Kind | Feeds |
|---|---|---|---|
| 1 | `assets/icon.svg` | drawn, 960×960 | ships as-is |
| 2 | `drivers/controller/assets/icon.svg` | drawn, 960×960 | ships as-is |
| 3 | `drivers/schedule/assets/icon.svg` | drawn, 960×960 | ships as-is |
| 4 | `docs/artwork/masters/app-hero-master.png` | photo, ≥1400×1000 | the 3 app images |
| 5 | `docs/artwork/masters/controller-product-master.png` | photo, ≥1100² | the 3 controller images |
| 6 | `docs/artwork/masters/schedule-master.png` | photo, ≥1100² | the 3 schedule images |

Masters live in `docs/`, which is not bundled — they are build inputs, cropped generously so a crop
box can move without a re-shoot. Today there is no #6: the schedule images are a 420×420 crop of #4,
upscaled, which is why a dedicated master is worth having.

## 1b. Shipped files — generated, not drawn

All nine come from `python docs/artwork/export-assets.py` (crop boxes live in that script).

| File | Size | From | Used for | |
|---|---|---|---|---|
| `assets/images/small.png` | 250×175 | #4 | The app's card in store listings | required |
| `assets/images/large.png` | 500×350 | #4 | Banner atop the app's store page | required |
| `assets/images/xlarge.png` | 1000×700 | #4 | The same banner, high-resolution screens | optional |
| `drivers/controller/assets/images/small.png` | 75×75 | #5 | Device rows and lists | required |
| `drivers/controller/assets/images/large.png` | 500×500 | #5 | "Supported devices" grid on the store page | required |
| `drivers/controller/assets/images/xlarge.png` | 1000×1000 | #5 | The same, high-resolution screens | optional |
| `drivers/schedule/assets/images/small.png` | 75×75 | #6 | Device rows and lists | required |
| `drivers/schedule/assets/images/large.png` | 500×500 | #6 | "Supported devices" grid on the store page | required |
| `drivers/schedule/assets/images/xlarge.png` | 1000×1000 | #6 | The same, high-resolution screens | optional |

Plus the three SVGs from 1a, which ship unchanged. PNG or JPG, extension matching the real format,
sizes exact — a wrong one fails `homey app validate`.

Where each icon appears is documented: the brand colour is the backdrop for icons "in e.g. Flows, Add
devices and the App Store". The per-surface column for images is observed from a live Homey and the
public store rather than specified, so treat it as a guide.

## 2. Icons (#1–#3)

Homey uses an icon as an **alpha mask painted one flat colour**, so colour inside the file is thrown
away and only the silhouette and its internal gaps survive.

- Stroke-only line art: `fill="none"`, `stroke-width="40"` on the 960 canvas.
- Transparent background, no gradients, no background shape, no filled illustrations.
- Use the full canvas.
- Recognisable at 32 px — that is where it is judged.
- One per driver, none identical, and no driver reusing the app icon.

## 3. Images (#4–#6)

- Photographic or lifestyle. **A flat shape or icon on a plain background is rejected.**
- The image must reach every edge: no white border, no letterboxing.
- A driver image shows the device that driver supports, ideally on white. `schedule` has no hardware,
  so its subject is the lamp being scheduled.
- No Homey logo, name or hardware in any image.
