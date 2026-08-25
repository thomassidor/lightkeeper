"""Write circadian-device-master.png — a PLACEHOLDER, not a photograph.

Athom's guideline 1.4 rejects a flat mark as a driver image, so what this
produces cannot ship to review. It exists so the circadian driver validates, the
export pipeline runs end to end and the suite stays green while the real
photograph is sourced. See provenance.md, which says the same thing where a
reviewer will actually look.

To finish the job: put a landscape photograph at masters/circadian-device-master.png
instead, re-run export-assets.py, and delete this script along with the
placeholder notes in provenance.md. Nothing else changes — the crop is found by
non-white detection, so a new master reframes itself.

    python docs/artwork/masters/make-circadian-placeholder.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# The other two device masters, so the export's crop maths sees the same shape.
W, H = 1500, 1049
OUT = Path(__file__).resolve().parent / 'circadian-device-master.png'

BRAND = (24, 14, 50)               # #180E32, the manifest's brandColor
WARM = (255, 176, 92)
COOL = (176, 205, 255)


def main() -> None:
    image = Image.new('RGB', (W, H), 'white')
    draw = ImageDraw.Draw(image)

    # A warm core fading to cool at the rim: the one thing the device does.
    cx, cy = W // 2, int(H * 0.52)
    radius = int(H * 0.34)
    for i in range(radius, 0, -1):
        t = 1 - i / radius
        colour = tuple(round(COOL[c] + (WARM[c] - COOL[c]) * t) for c in range(3))
        draw.ellipse([cx - i, cy - i, cx + i, cy + i], fill=colour)

    image = image.filter(ImageFilter.GaussianBlur(18))
    draw = ImageDraw.Draw(image)

    # The driver's own mark, so the placeholder is recognisably this driver's.
    sun = int(radius * 0.42)
    draw.ellipse([cx - sun, cy - sun, cx + sun, cy + sun], outline=BRAND, width=10)
    for step in range(7):
        angle = math.radians(180 - step * 30)
        draw.line(
            [cx + math.cos(angle) * sun * 1.33, cy - math.sin(angle) * sun * 1.33,
             cx + math.cos(angle) * sun * 1.80, cy - math.sin(angle) * sun * 1.80],
            fill=BRAND, width=10,
        )

    image.save(OUT)
    print(f'{OUT.name}  {image.size[0]}x{image.size[1]}  PLACEHOLDER — replace before publishing')


if __name__ == '__main__':
    main()
