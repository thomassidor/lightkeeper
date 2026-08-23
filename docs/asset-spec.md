# Asset spec

Everything a Homey Pro app must ship, for this app's two drivers: `controller` and `schedule`.

## 1. Files

| Path | Size | Used for | |
|---|---|---|---|
| `assets/icon.svg` | 960×960 | The app's icon everywhere inside Homey: app list, the app picker when adding a device, Flow cards, app settings | required |
| `assets/images/small.png` | 250×175 | The app's card in App Store listings and category pages | required |
| `assets/images/large.png` | 500×350 | The banner at the top of the app's App Store page | required |
| `assets/images/xlarge.png` | 1000×700 | The same banner on large or high-resolution screens | optional |
| `drivers/<id>/assets/icon.svg` | 960×960 | That device type's icon when adding a device, and on the device tile afterwards | required, one per driver |
| `drivers/<id>/assets/images/small.png` | 75×75 | Device rows and lists | required |
| `drivers/<id>/assets/images/large.png` | 500×500 | The "supported devices" grid on the App Store page | required |
| `drivers/<id>/assets/images/xlarge.png` | 1000×1000 | The same, on high-resolution screens | optional |

Images are PNG or JPG, and the extension must match the real format. Sizes are exact — a wrong one
fails `homey app validate`.

Athom documents only that images appear "prominently on the App Store page"; the surface-by-surface
column above is from observing a live Homey and the public store, so treat it as a good guide rather
than a contract. Icons are the documented case: the brand colour is the backdrop for them "in e.g.
Flows, Add devices and the App Store".

## 2. Icons (SVG)

Homey uses an icon as an **alpha mask painted one flat colour**, so colour inside the file is thrown
away and only the silhouette and its internal gaps survive.

- Stroke-only line art: `fill="none"`, `stroke-width="40"` on the 960 canvas.
- Transparent background, no gradients, no background shape, no filled illustrations.
- Use the full canvas.
- Recognisable at 32 px — that is where it is judged.
- One per driver, none identical.

## 3. Images (PNG/JPG)

- Photographic or lifestyle. **A flat shape or icon on a plain background is rejected.**
- The image must reach every edge: no white border, no letterboxing.
- A driver image shows the device that driver supports, ideally on white.
- No Homey logo, name or hardware in any image.
