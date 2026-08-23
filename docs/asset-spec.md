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
