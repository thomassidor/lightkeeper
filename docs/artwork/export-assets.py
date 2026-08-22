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

Homey's sizes, and which of them are actually enforced:
    app     250x175, 500x350  required   1000x700   optional  (10:7)
    driver   75x75,  500x500  required   1000x1000  optional  (1:1)
A wrong size fails `homey app validate` — but only for the required two. homey-lib
checks `['small', 'large']` and never looks at xlarge (lib/App/index.js,
_validateImages), and its AI reviewer is told in as many words not to raise a
finding when xlarge is absent. We ship xlarge anyway, for high-resolution screens;
this note is here so nobody re-derives the rule from a comment that overstated it.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MASTERS = Path(__file__).resolve().parent / 'masters'

# The hero is 1536x1024 (3:2) and ships at 10:7, so the crop is 920x644 taken
# from the right-hand side of the frame.
#
# It used to be centred, which kept all three lamps AND the hand holding a
# scroll-wheel remote. That composition predates the schedule driver: it says the
# app is a remote, which is now half the story. This window drops the hand and the
# remote entirely and keeps the tripod floor lamp, the table lamp and the blue-hour
# window, so it reads as lights that came on by themselves — the other half. The
# amber light trails survive as streaks rather than as wires from a device.
#
# Athom's guideline 1.4.2 is why this stays a photograph rather than becoming the
# app mark on a field: "Images that consist of a single flat shape or icon on a
# plain, monochrome or transparent background are not approved."
HERO = {
    'master': 'app-hero-master.png',
    'crop': (616, 224, 1536, 868),
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


# The schedule driver used to ship its own icon, rasterised on white. That was the
# most likely review finding in the app: guideline 1.4 rejects "images with big
# two-dimensional unicolored shapes on a monochrome or transparent background",
# and 1.4.3 asks for "a recognizable picture of the device it supports" and says
# outright "Don't use your app icon as a driver image".
#
# A schedule has no hardware, so the device it supports is the lamp. This is a
# 420x420 window on the right-hand table lamp of the hero master, lit, with the
# blue-hour window behind it — which reads as evening, which is what a schedule is
# for. It shares the hero's photography, so the two driver pictures and the store
# image are visibly one app.
#
# 420 is a compromise, chosen by looking: 270 crops tighter but upscales 3.7x to
# the optional 1000 px size and goes soft; 520 pulls in the floor lamp base and a
# cup, and the lamp stops being the subject.
SCHEDULE = {
    'master': 'app-hero-master.png',
    'crop': (985, 280, 1405, 700),
    'out': ROOT / 'drivers' / 'schedule' / 'assets' / 'images',
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
    for spec in (HERO, CONTROLLER, SCHEDULE):
        export(spec)
