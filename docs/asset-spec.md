# Asset spec

Everything a Homey Pro app must ship, for this app's two drivers: `controller` and `schedule`.

## 1. Files

| Path | Size | |
|---|---|---|
| `assets/icon.svg` | 960×960 | required |
| `assets/images/small.png` | 250×175 | required |
| `assets/images/large.png` | 500×350 | required |
| `assets/images/xlarge.png` | 1000×700 | optional |
| `drivers/<id>/assets/icon.svg` | 960×960 | required, one per driver |
| `drivers/<id>/assets/images/small.png` | 75×75 | required |
| `drivers/<id>/assets/images/large.png` | 500×500 | required |
| `drivers/<id>/assets/images/xlarge.png` | 1000×1000 | optional |

Images are PNG or JPG, and the extension must match the real format. Sizes are exact — a wrong one
fails `homey app validate`.

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
