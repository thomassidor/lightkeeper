#!/usr/bin/env python3
"""Re-export every shipped PNG from the two masters in docs/artwork/masters/.

Run from the repository root:

    python docs/artwork/export-assets.py

Why this exists: the six PNGs Homey ships were originally hand-cropped one at a
time, which meant the crops could not be reproduced and a re-export at a new
size would silently reframe the subject. Everything here is derived from two
numbers per master — a crop box and a size list — so the output is a function of
the masters and this file, and nothing else.

Requires Pillow (`pip install pillow`). Verified against Pillow 12.2.

Homey's required sizes, which are not negotiable:
    app     250x175, 500x350, 1000x700   (10:7)
    driver   75x75,  500x500, 1000x1000  (1:1)
A wrong size fails `homey app validate`.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MASTERS = Path(__file__).resolve().parent / 'masters'

# The hero is 1536x1024 (3:2) and ships at 10:7, so height is the binding
# constraint and the crop takes 37 px off each side. Centred: the composition
# runs corner to corner — hand bottom-left, floor lamp centre, table lamp right
# — and shifting the window drops one of the three lights the image is about.
HERO = {
    'master': 'app-hero-master.png',
    'crop': (37, 0, 1499, 1024),
    'out': ROOT / 'assets' / 'images',
    'sizes': {'small.png': (250, 175), 'large.png': (500, 350), 'xlarge.png': (1000, 700)},
}

# The product shot is a 1254 px square, but the remote inside it occupies only
# x 344-798, y 56-1161 — a tall subject in a square frame, so nearly a third of
# the canvas is dead white. At 75x75 that left the device 27 px wide and sitting
# off-centre to the left.
#
# 1120 is the largest square that still contains the whole device (it needs
# 1105) while dropping every pixel of spare canvas, centred on the subject
# rather than on the frame. Deliberately not tighter: 900-1000 makes the device
# meaningfully bigger but clips the rounded ends, and a device-list thumbnail
# reads better as a complete silhouette than as a confident crop.
#
# One crop for all three sizes, not a special tighter one for the thumbnail —
# the driver images appear side by side in the pairing flow, so they should be
# the same photograph.
CONTROLLER = {
    'master': 'controller-product-master.png',
    'crop': (11, 48, 1131, 1168),
    'out': ROOT / 'drivers' / 'controller' / 'assets' / 'images',
    'sizes': {'small.png': (75, 75), 'large.png': (500, 500), 'xlarge.png': (1000, 1000)},
}


def export(spec: dict) -> None:
    master = MASTERS / spec['master']
    if not master.exists():
        raise SystemExit(f'missing master: {master}')

    with Image.open(master) as image:
        cropped = image.convert('RGB').crop(spec['crop'])

        for name, size in spec['sizes'].items():
            target = spec['out'] / name
            # LANCZOS for the downscale, and optimize=True because these are
            # bundled into the app and the xlarge hero is the largest single
            # file in it.
            cropped.resize(size, Image.LANCZOS).save(target, 'PNG', optimize=True)
            print(f'{target.relative_to(ROOT)}  {size[0]}x{size[1]}  '
                  f'{target.stat().st_size // 1024} KB')


if __name__ == '__main__':
    for spec in (HERO, CONTROLLER):
        export(spec)
