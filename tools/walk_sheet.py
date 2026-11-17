"""Cut a transparent walk-cycle sprite sheet (frames in one row) into frames on the pet's shared canvas.

    python tools/walk_sheet.py <sheet> <character folder> <prefix> <standing reference pose> [--dry]

Every frame gets the same scale (the sheet's typical figure height becomes the height of the standing
reference picture), the lowest foot goes on the floor line, and the head is put on the same column in
every frame, so the body stays steady and only the legs move. Writes <prefix>-1.png … <prefix>-N.png and
prints the bounds and foot spread of each frame.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

sheet_path, folder, prefix, ref = sys.argv[1], Path(sys.argv[2]), sys.argv[3], sys.argv[4]
dry = '--dry' in sys.argv
manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
W, H = manifest['canvas']['width'], manifest['canvas']['height']
FLOOR = 550                                   # row of the lowest foot pixel in the existing pictures


def alpha_box(a):
    ys, xs = np.where(a > 60)
    return xs.min(), ys.min(), xs.max(), ys.max()


def head_x(a):
    """Centre column of the head: the widest part of the top 45 % of the figure, ignoring the thin ahoge."""
    x0, y0, x1, y1 = alpha_box(a)
    h = y1 - y0
    band = a[y0 + int(h * 0.18): y0 + int(h * 0.45)] > 60
    cols = np.where(band.sum(0) > band.shape[0] * 0.5)[0]
    return (cols.min() + cols.max()) / 2


ref_img = np.asarray(Image.open(folder / f'{ref}.png').convert('RGBA'))
rx0, ry0, rx1, ry1 = alpha_box(ref_img[..., 3])
ref_h, ref_head = ry1 - ry0, head_x(ref_img[..., 3])

sheet = Image.open(sheet_path).convert('RGBA')
arr = np.asarray(sheet)
labels, count = ndi.label(arr[..., 3] > 40)
sizes = ndi.sum(arr[..., 3] > 40, labels, range(1, count + 1))
boxes = ndi.find_objects(labels)
figures = sorted((boxes[i] for i, s in enumerate(sizes) if s > 3000), key=lambda sl: sl[1].start)
scale = ref_h / float(np.median([sl[0].stop - sl[0].start for sl in figures]))
print(f'{len(figures)} frames, scale {scale:.3f}, reference height {ref_h}, head column {ref_head:.0f}')

out = {}
for n, sl in enumerate(figures, 1):
    cell = sheet.crop((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop))
    # keep only this figure (a neighbour's hair tip can poke into the box)
    own = labels[sl] == np.bincount(labels[sl][labels[sl] > 0]).argmax()
    px = np.asarray(cell).copy(); px[~own] = 0
    cell = Image.fromarray(px, 'RGBA')
    cell = cell.resize((round(cell.width * scale), round(cell.height * scale)), Image.LANCZOS)
    a = np.asarray(cell)[..., 3]
    # the sheet's alpha tops out just under 255: stretch it so solid parts are solid
    fixed = np.asarray(cell).astype(np.float32)
    fixed[..., 3] = np.clip(fixed[..., 3] * (255.0 / max(1, a.max())), 0, 255)
    cell = Image.fromarray(fixed.astype(np.uint8), 'RGBA')
    a = np.asarray(cell)[..., 3]
    bx0, by0, bx1, by1 = alpha_box(a)
    dx = round(ref_head - head_x(a))
    dy = FLOOR - by1
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(cell, (dx, dy)) if dx >= 0 and dy >= 0 else canvas.paste(cell, (dx, dy), cell)
    ca = np.asarray(canvas)[..., 3]
    x0, y0, x1, y1 = alpha_box(ca)
    feet = np.where((ca[FLOOR - 22: FLOOR + 1] > 60).any(0))[0]
    name = f'{prefix}-{n}'
    out[name] = {'bounds': [int(x0), int(y0), int(x1 - x0 + 1), int(y1 - y0 + 1)], 'feet': [int(feet.min()), int(feet.max())]}
    print(f'  {name}: bounds {out[name]["bounds"]} feet x {feet.min()}–{feet.max()} (spread {feet.max() - feet.min()})')
    if not dry:
        canvas.save(folder / f'{name}.png', optimize=True)
(Path(sheet_path).parent / f'{prefix}.generated.json').write_text(json.dumps(out, indent=1), encoding='utf-8') if not dry else None
