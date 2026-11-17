"""Turns a horizontal walk-cycle sprite sheet (white background) into aligned frames.

Usage: python3 tools/walkframes.py <sheet.png> <prefix> assets/characters
Writes <prefix>-1.png … <prefix>-N.png on the shared canvas: same scale for every frame,
lowest foot on the anchor line, head centred on the anchor x (so the body stays steady and the legs move).
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

sheet_path, prefix, out_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
manifest = json.loads((out_dir / 'manifest.json').read_text(encoding='utf-8'))
W, H = manifest['canvas']['width'], manifest['canvas']['height']
AX, AY = manifest['canvas']['anchor']
STAND = manifest['canvas']['standHeight']

img = Image.open(sheet_path).convert('RGB')
a = np.asarray(img).astype(int)
# background = near-white, low-saturation pixels connected to the border
light = (a.min(axis=2) > 232) & ((a.max(axis=2) - a.min(axis=2)) < 18)
lab, _ = ndi.label(light)
edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1]); edge.discard(0)
fg = ~np.isin(lab, list(edge))
fg = ndi.binary_opening(fg, iterations=1)

# split into characters by empty columns
cols = fg.sum(axis=0) > 0
runs, start = [], None
for x, on in enumerate(cols):
    if on and start is None: start = x
    if not on and start is not None:
        if x - start > 40: runs.append((start, x))
        start = None
if start is not None: runs.append((start, len(cols)))
print('frames found:', len(runs), runs)

alpha_full = Image.fromarray((fg * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(0.7))
rgba = img.convert('RGBA'); rgba.putalpha(alpha_full)

frames = []
for x0, x1 in runs:
    sub = fg[:, x0:x1]
    lab2, n = ndi.label(sub)
    sizes = ndi.sum(sub, lab2, range(1, n + 1))
    keep = np.isin(lab2, [i + 1 for i, s in enumerate(sizes) if s > sizes.max() * 0.02])   # drop specks
    ys, xs = np.where(keep)
    top, bottom = ys.min(), ys.max()
    head = keep[top: top + int((bottom - top) * 0.3)]
    hx = np.where(head.any(axis=0))[0]
    head_cx = (hx.min() + hx.max()) / 2
    crop = rgba.crop((x0, 0, x1, img.height))
    m = Image.fromarray((keep * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(0.7))
    crop.putalpha(Image.fromarray(np.minimum(np.asarray(crop.getchannel('A')), np.asarray(m))))
    frames.append((crop, top, bottom, head_cx))

span = max(f[2] for f in frames) - min(f[1] for f in frames)
scale = STAND / span
for i, (crop, top, bottom, head_cx) in enumerate(frames, 1):
    small = crop.resize((round(crop.width * scale), round(crop.height * scale)), Image.LANCZOS)
    canvas = Image.new('RGBA', (W, H))
    canvas.paste(small, (round(AX - head_cx * scale), round(AY - bottom * scale)), small)
    canvas.save(out_dir / f'{prefix}-{i}.png')
    print(f'{prefix}-{i}.png', canvas.getbbox())
