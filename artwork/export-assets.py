#!/usr/bin/env python3
"""Build every shipped graphic from the masters in artwork/masters/.

    python artwork/export-assets.py                # icons + images + banner
    python artwork/export-assets.py --palette      # the brand hexes, from the logo
    python artwork/export-assets.py --measure      # recompute the icon fits
    python artwork/export-assets.py --weight drawn # the masters' own stroke weights
    python artwork/export-assets.py --skip-banner  # everything Chrome is not needed for

Why this exists: the shipped assets were once hand-cropped one at a time, which
meant a crop could not be reproduced and a re-export at a new size would silently
reframe the subject. Everything here is a function of the masters and this file.

    masters/logo-mark-master.svg          -> assets/icon.svg
    masters/remote-remote-icon-master.svg -> drivers/controller/assets/icon.svg
    masters/schedule-icon-master.svg      -> drivers/schedule/assets/icon.svg
    masters/circadian-icon-master.svg     -> drivers/circadian/assets/icon.svg
    masters/curve-icon-master.svg         -> drivers/curve/assets/icon.svg
    masters/app-hero-master.png           -> assets/images/*          + the README banner
    masters/remote-device-master.png      -> drivers/controller/assets/images/*
    masters/schedule-device-master.png    -> drivers/schedule/assets/images/*
    masters/circadian-device-master.png   -> drivers/circadian/assets/images/*
    masters/curve-device-master.png       -> drivers/curve/assets/images/*

    masters/logo-bitmap-original.png      -> nothing; it is the palette's source

Homey's sizes, and which of them are actually enforced:
    app     250x175, 500x350  required   1000x700   optional  (10:7)
    driver   75x75,  500x500  required   1000x1000  optional  (1:1)
homey-lib checks `['small', 'large']` only (lib/App/index.js, _validateImages) and
never looks at xlarge. We ship xlarge anyway, for high-resolution screens.

Requires Pillow. The two Chrome-dependent paths (--measure, and the banner's logo
tile) use headless Chrome, the house rasteriser: see artwork/provenance.md.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import shutil
import subprocess
import tempfile
from collections import Counter

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
MASTERS = pathlib.Path(__file__).resolve().parent / 'masters'
README_ART = pathlib.Path(__file__).resolve().parent / 'readme'

CANVAS = 960                       # Homey's icon canvas, guideline 1.5

# Every icon is normalised to this, which is what all 226 of homey-lib's stock
# class icons use. Fitted to the canvas, the masters' own strokes land at 31, 22
# and 14 units — so "as drawn" is three different weights, and the remote at 14 is
# a hairline that all but vanishes at the 32 px Homey renders. `--weight drawn`
# still emits the masters' own weights, for comparison.
HOUSE_STROKE = 40.0

# Extracted from masters/logo-bitmap-original.png — run --palette to re-derive.
BRAND = '#180E32'                  # the logo's ground: 93% of its pixels
ACCENT = '#CCB0F3'                 # the mark itself

# ----------------------------------------------------------------------- icons

# `fit` centres the drawing and scales it to fill 92% of the 960 canvas: an SVG's
# viewBox says nothing about where the ink actually is, and guideline 1.5 asks for
# the full canvas. The numbers come from --measure, which rasterises the master and
# reads the alpha bounding box; they are stored rather than recomputed so a normal
# run needs no browser and produces byte-identical output every time.
ICONS = [
    {
        'master': 'logo-mark-master.svg',
        'out': ROOT / 'assets' / 'icon.svg',
        'title': 'Lightkeeper',
        'desc': 'An open circle with a four-pointed sparkle.',
        'fit': (1.1871, -150.9, -102.9),
        'stroke': 26.0,
    },
    {
        'master': 'remote-remote-icon-master.svg',
        'out': ROOT / 'drivers' / 'controller' / 'assets' / 'icon.svg',
        'title': 'Light controller',
        'desc': 'A handheld remote with a rotary wheel above two buttons.',
        'fit': (2.1079, -59.6, -60.7),
        'stroke': 6.7,
    },
    {
        'master': 'schedule-icon-master.svg',
        'out': ROOT / 'drivers' / 'schedule' / 'assets' / 'icon.svg',
        'title': 'Light schedule',
        'desc': 'A stopwatch.',
        'fit': (3.0298, -295.6, -267.6),
        'stroke': 7.3,
    },
    {
        'master': 'circadian-icon-master.svg',
        'out': ROOT / 'drivers' / 'circadian' / 'assets' / 'icon.svg',
        'title': 'Circadian light',
        'desc': 'A lightbulb below a daylight arc, between a sunrise and a sunset.',
        'fit': (3.1208, -318.9, -318.9),
        'stroke': 7.3,
    },
    {
        'master': 'curve-icon-master.svg',
        'out': ROOT / 'drivers' / 'curve' / 'assets' / 'icon.svg',
        'title': 'Curve light',
        'desc': 'A four-point curve over a row of hour ticks.',
        'fit': (3.0247, -294.3, -294.3),
        'stroke': 5.3,
    },
]

# ---------------------------------------------------------------------- images

HERO = {
    'master': 'app-hero-master.png',
    'out': ROOT / 'assets' / 'images',
    'sizes': {'small.png': (250, 175), 'large.png': (500, 350), 'xlarge.png': (1000, 700)},
    'aspect': 10 / 7,
}

# The two device masters are landscape shots of one object on white, and Homey
# wants a square. Rather than a hand-measured crop box, the subject's bounding box
# is found by non-white detection and centred on a white square — so replacing a
# master reframes the crop automatically instead of silently mis-centring it.
DEVICES = [
    {
        'master': 'remote-device-master.png',
        'out': ROOT / 'drivers' / 'controller' / 'assets' / 'images',
    },
    {
        'master': 'schedule-device-master.png',
        'out': ROOT / 'drivers' / 'schedule' / 'assets' / 'images',
    },
    {
        'master': 'circadian-device-master.png',
        'out': ROOT / 'drivers' / 'circadian' / 'assets' / 'images',
    },
    {
        'master': 'curve-device-master.png',
        'out': ROOT / 'drivers' / 'curve' / 'assets' / 'images',
    },
]
DEVICE_SIZES = {'small.png': (75, 75), 'large.png': (500, 500), 'xlarge.png': (1000, 1000)}
DEVICE_MARGIN = 0.10               # of the subject's longest side, on every side

BANNER = {
    'master': 'app-hero-master.png',
    'out': README_ART / 'banner.png',
    'size': (1600, 560),
    'tile_fraction': 0.42,         # tile side, as a fraction of banner height
    'inset_fraction': 0.07,        # tile inset from the left and bottom edges
    'radius_fraction': 0.22,       # corner radius, as a fraction of the tile side
    'mark_fraction': 0.60,         # the mark's size inside the tile
}

CHROME_CANDIDATES = [
    r'C:/Program Files/Google/Chrome/Application/chrome.exe',
    r'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
]


def find_chrome() -> str:
    for candidate in CHROME_CANDIDATES:
        if pathlib.Path(candidate).exists():
            return candidate
    found = shutil.which('chrome') or shutil.which('google-chrome') or shutil.which('chromium')
    if found:
        return found
    raise SystemExit('Headless Chrome is needed for this step and was not found. '
                     'Install Chrome, or pass --skip-banner (and do not pass --measure).')


def rasterise_svg(svg: str, size: int, colour: str) -> Image.Image:
    """Render SVG markup to a transparent PNG of `size` square, ink in `colour`."""
    chrome = find_chrome()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        page = tmp_path / 'page.html'
        shot = tmp_path / 'shot.png'
        page.write_text(
            '<!doctype html><meta charset="utf-8">'
            '<style>html,body{margin:0;background:transparent}'
            f'#b{{width:{size}px;height:{size}px}}'
            f'#b svg{{width:100%;height:100%;color:{colour}}}</style>'
            f'<div id="b">{svg}</div>', encoding='utf-8')
        subprocess.run([chrome, '--headless', '--disable-gpu', '--hide-scrollbars',
                        '--default-background-color=00000000', '--force-device-scale-factor=1',
                        f'--window-size={size},{size}', '--virtual-time-budget=2000',
                        f'--screenshot={shot}', page.resolve().as_uri()],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with Image.open(shot) as im:
            return im.convert('RGBA').copy()


def root_tag(svg: str) -> str:
    return svg[svg.index('<svg'): svg.index('>', svg.index('<svg')) + 1]


def inner_markup(svg: str) -> str:
    start = svg.index('>', svg.index('<svg')) + 1
    return svg[start: svg.rindex('</svg>')].strip()


def attribute(tag: str, name: str) -> str | None:
    match = re.search(rf'\b{name}="([^"]*)"', tag)
    return match.group(1) if match else None


def build_icon(spec: dict, weight: str) -> str:
    """A master SVG becomes a 960x960 icon: centred, fitted, and mask-safe."""
    svg = (MASTERS / spec['master']).read_text(encoding='utf-8')
    scale, tx, ty = spec['fit']
    root = root_tag(svg)

    # Rendered stroke width, in 960-canvas units.
    rendered = HOUSE_STROKE if weight == 'homey' else spec['stroke'] * scale
    # Inside the transform, strokes are scaled too, so undo that.
    authored = rendered / scale

    # Carry the master's own paint attributes, with currentColor resolved: Homey
    # uses the file as an alpha mask painted one flat colour, so colour inside it
    # is discarded and only alpha matters — but it has to BE opaque to count.
    carried = []
    for name in ('fill', 'stroke', 'fill-rule', 'stroke-linecap', 'stroke-linejoin'):
        value = attribute(root, name)
        if value is None:
            continue
        carried.append(f'{name}="{"#000" if value == "currentColor" else value}"')

    inner = inner_markup(svg).replace('currentColor', '#000')
    # Any stroke-width authored on a child would override the group's.
    inner = re.sub(r'stroke-width="[\d.]+"', f'stroke-width="{authored:.2f}"', inner)
    inner = '\n    '.join(line.strip() for line in inner.splitlines() if line.strip())

    paint = ' '.join(carried)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}" \
width="{CANVAS}" height="{CANVAS}">
  <title>{spec['title']}</title>
  <desc>{spec['desc']}</desc>

  <!-- GENERATED from artwork/masters/{spec['master']} by
       artwork/export-assets.py. Edit the master, then re-run the script;
       an edit here is lost on the next export.

       Homey renders an icon as a CSS mask painted one flat colour, fetched from
       icons-cdn.athom.com by this file's MD5, so colour inside it is discarded
       and only the silhouette survives. It also means a CLI-installed app shows
       no icon at all — that CDN only holds published builds. See CLAUDE.md §10.

       The transform centres the master's drawing and scales it to fill the
       canvas, which guideline 1.5 asks for; stroke widths are pre-divided by the
       scale so they render at {rendered:.0f} units on this 960 canvas. -->
  <g transform="translate({tx:.1f} {ty:.1f}) scale({scale:.4f})" {paint} \
stroke-width="{authored:.2f}">
    {inner}
  </g>
</svg>
'''


def export_icons(weight: str) -> None:
    for spec in ICONS:
        markup = build_icon(spec, weight)
        spec['out'].parent.mkdir(parents=True, exist_ok=True)
        spec['out'].write_text(markup, encoding='utf-8', newline='\n')
        rendered = HOUSE_STROKE if weight == 'homey' else spec['stroke'] * spec['fit'][0]
        print(f'{spec["out"].relative_to(ROOT)}  stroke {rendered:.0f}/960  ({weight})')


def measure_icons() -> None:
    """Recompute the `fit` numbers above, after a master changes."""
    print('# paste into ICONS above')
    for spec in ICONS:
        svg = (MASTERS / spec['master']).read_text(encoding='utf-8')
        units = float(re.search(r'viewBox="0 0 ([\d.]+)', svg).group(1))
        image = rasterise_svg(svg, 1024, '#000')
        box = image.getchannel('A').getbbox()
        if box is None:
            raise SystemExit(f'{spec["master"]}: no ink found')

        per_unit = 1024 / units
        x0, y0, x1, y1 = (value / per_unit for value in box)
        width, height = x1 - x0, y1 - y0
        scale = CANVAS * 0.92 / max(width, height)
        print(f"    # {spec['master']}: ink {width:.0f}x{height:.0f} of {units:.0f}\n"
              f"    'fit': ({scale:.4f}, {CANVAS / 2 - scale * (x0 + width / 2):.1f}, "
              f"{CANVAS / 2 - scale * (y0 + height / 2):.1f}),")


# ---------------------------------------------------------------------- photos

def aspect_crop(image: Image.Image, aspect: float) -> Image.Image:
    """Largest centred crop of the given aspect ratio."""
    width, height = image.size
    if width / height > aspect:
        new_width = round(height * aspect)
        left = (width - new_width) // 2
        return image.crop((left, 0, left + new_width, height))
    new_height = round(width / aspect)
    top = (height - new_height) // 2
    return image.crop((0, top, width, top + new_height))


def subject_square(image: Image.Image, margin: float) -> Image.Image:
    """The object on the white ground, centred on a white square."""
    grey = image.convert('L')
    # Anything darker than near-white is subject. The masters are studio white, so
    # this is a clean split rather than a guess.
    mask = grey.point(lambda value: 255 if value < 245 else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit('no subject found against the white ground')

    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    side = round(max(width, height) * (1 + 2 * margin))

    square = Image.new('RGB', (side, side), 'white')
    subject = image.crop(box)
    square.paste(subject, ((side - width) // 2, (side - height) // 2))
    return square


def export_images() -> None:
    with Image.open(MASTERS / HERO['master']) as master:
        cropped = aspect_crop(master.convert('RGB'), HERO['aspect'])
        for name, size in HERO['sizes'].items():
            target = HERO['out'] / name
            cropped.resize(size, Image.LANCZOS).save(target, 'PNG', optimize=True)
            print(f'{target.relative_to(ROOT)}  {size[0]}x{size[1]}  '
                  f'{target.stat().st_size // 1024} KB')

    for spec in DEVICES:
        with Image.open(MASTERS / spec['master']) as master:
            square = subject_square(master.convert('RGB'), DEVICE_MARGIN)
            for name, size in DEVICE_SIZES.items():
                target = spec['out'] / name
                square.resize(size, Image.LANCZOS).save(target, 'PNG', optimize=True)
                print(f'{target.relative_to(ROOT)}  {size[0]}x{size[1]}  '
                      f'{target.stat().st_size // 1024} KB')


def export_banner() -> None:
    """The README header: the hero, with the logo mark on a rounded brand tile."""
    width, height = BANNER['size']
    with Image.open(MASTERS / BANNER['master']) as master:
        banner = aspect_crop(master.convert('RGB'), width / height).resize(
            (width, height), Image.LANCZOS)

    side = round(height * BANNER['tile_fraction'])
    inset = round(height * BANNER['inset_fraction'])
    radius = round(side * BANNER['radius_fraction'])

    tile = Image.new('RGBA', (side, side), BRAND)
    rounded = Image.new('L', (side, side), 0)
    ImageDraw.Draw(rounded).rounded_rectangle((0, 0, side - 1, side - 1), radius, fill=255)
    tile.putalpha(rounded)

    mark_size = round(side * BANNER['mark_fraction'])
    mark = rasterise_svg((MASTERS / 'logo-mark-master.svg').read_text(encoding='utf-8'),
                         mark_size, ACCENT)
    tile.alpha_composite(mark, ((side - mark_size) // 2, (side - mark_size) // 2))

    banner.paste(tile, (inset, height - side - inset), tile)
    BANNER['out'].parent.mkdir(parents=True, exist_ok=True)
    banner.save(BANNER['out'], 'PNG', optimize=True)
    print(f'{BANNER["out"].relative_to(ROOT)}  {width}x{height}  '
          f'{BANNER["out"].stat().st_size // 1024} KB')


# --------------------------------------------------------------------- palette

def print_palette() -> None:
    """Where BRAND and ACCENT come from, so the docs stay traceable to the file."""
    with Image.open(MASTERS / 'logo-bitmap-original.png') as image:
        pixels = list(image.convert('RGBA').getdata())

    opaque = [p for p in pixels if p[3] > 200]
    clusters = Counter(((r // 16) * 16, (g // 16) * 16, (b // 16) * 16) for r, g, b, _ in opaque)
    exact = Counter((r, g, b) for r, g, b, _ in opaque)

    print(f'logo-bitmap-original.png: {image.size[0]}x{image.size[1]}, '
          f'{len(opaque)} opaque px, {len(exact)} distinct colours\n')
    print('dominant clusters:')
    for (r, g, b), count in clusters.most_common(6):
        print(f'  #{r:02X}{g:02X}{b:02X}  {100 * count / len(opaque):5.1f}%')
    print('\nmost common exact colours:')
    for (r, g, b), count in exact.most_common(4):
        print(f'  #{r:02X}{g:02X}{b:02X}  {100 * count / len(opaque):5.1f}%')
    print(f'\nin use: BRAND {BRAND} (the ground), ACCENT {ACCENT} (the mark)')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--palette', action='store_true', help='print the logo bitmap\'s colours')
    parser.add_argument('--measure', action='store_true', help='recompute the icon fit numbers')
    parser.add_argument('--weight', choices=('drawn', 'homey'), default='homey',
                        help="icon stroke weight: Homey's 40 (default), or as drawn in the master")
    parser.add_argument('--skip-banner', action='store_true', help='skip the Chrome-dependent banner')
    args = parser.parse_args()

    if args.palette:
        print_palette()
        return
    if args.measure:
        measure_icons()
        return

    export_icons(args.weight)
    export_images()
    if not args.skip_banner:
        export_banner()


if __name__ == '__main__':
    main()
