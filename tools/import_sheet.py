"""Cuts a grid sheet of poses (white background) into aligned pictures on the pet's shared canvas.

Usage: python3 tools/import_sheet.py <sheet.png> <out dir> <rows>x<cols> <name,name,...> <reference name> [holes.json]
All cells get one scale: the reference cell (a plain standing pose) becomes the standing height. Feet centre goes on
the anchor, lowest pixel on the floor line. Small detached marks (sweat drops, motion lines, Zzz) are dropped — the app
draws its own effects. holes.json lists points inside white background pockets enclosed by hair: {"name": [[x, y], ...]}
in cell pixels. Writes <name>.png and sheet.generated.json (bounds per pose). The sheet itself is not modified.
Sheets that already have a transparent background (an alpha channel) are cut along that alpha instead.
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

sheet_path, out = Path(sys.argv[1]), Path(sys.argv[2])
rows, cols = (int(v) for v in sys.argv[3].split('x'))
names = sys.argv[4].split(',')
ref = sys.argv[5]
HOLES = json.loads(Path(sys.argv[6]).read_text(encoding='utf-8')) if len(sys.argv) > 6 else {}
W, H, AX, AY, STAND = 640, 580, 320, 552, 440

src = Image.open(sheet_path)
HAS_ALPHA = src.mode in ('RGBA', 'LA', 'PA') and (np.asarray(src.convert('RGBA').getchannel('A')) < 16).mean() > 0.1
img = src.convert('RGBA') if HAS_ALPHA else src.convert('RGB')
cw, ch = img.width / cols, img.height / rows


def cut_alpha(cell: Image.Image):
    """Transparent sheet: the figure is what the artist left opaque; stray specks are dropped, soft edges kept."""
    alpha = np.asarray(cell.getchannel('A')).astype(int)
    lab, n = ndi.label(alpha > 128)
    sizes = ndi.sum(np.ones_like(alpha), lab, range(1, n + 1))
    solid = np.isin(lab, [k + 1 for k, s in enumerate(sizes) if s > sizes.max() * 0.03])
    keep = ndi.binary_dilation(solid, iterations=3)                 # the anti-aliased rim around the kept parts
    res = cell.copy()
    res.putalpha(Image.fromarray((alpha * keep).astype('uint8')))
    return res, solid


def cut(i: int, name: str):
    r, c = divmod(i, cols)
    cell = img.crop((round(c * cw), round(r * ch), round((c + 1) * cw), round((r + 1) * ch)))
    if HAS_ALPHA:
        return cut_alpha(cell)
    a = np.asarray(cell).astype(int)
    light = (a.min(axis=2) > 236) & ((a.max(axis=2) - a.min(axis=2)) < 14)
    lab, _ = ndi.label(light)
    edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1]); edge.discard(0)
    solid = ~np.isin(lab, list(edge))
    wlab, _ = ndi.label(light & solid)                       # enclosed light regions: clothing, or leftover background
    for x, y in HOLES.get(name, []):
        near = wlab[max(0, y - 2): y + 3, max(0, x - 2): x + 3]
        ids = [k for k in np.unique(near) if k]
        if not ids: print(f'WARNING: no white pocket at {x},{y} in {name}'); continue
        solid &= ~ndi.binary_dilation(wlab == max(ids, key=lambda k: (near == k).sum()), iterations=2)
    solid = ndi.binary_opening(solid, iterations=1)
    lab2, n = ndi.label(solid)
    sizes = ndi.sum(solid, lab2, range(1, n + 1))
    solid = np.isin(lab2, [k + 1 for k, s in enumerate(sizes) if s > sizes.max() * 0.03])   # the figure (and a hand holding her)
    core = ndi.binary_erosion(solid, iterations=1)
    inner = ndi.binary_erosion(solid, iterations=3)
    idx = ndi.distance_transform_edt(~inner, return_distances=False, return_indices=True)
    rgb = np.asarray(cell).copy()
    fill = rgb[idx[0], idx[1]]
    fix = solid & ~inner & (rgb.min(axis=2) > 200) & (fill.min(axis=2) < 200)
    rgb[fix] = fill[fix]
    res = Image.fromarray(rgb).convert('RGBA')
    res.putalpha(Image.fromarray((core * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(0.8)))
    return res, solid


cells = {n: cut(i, n) for i, n in enumerate(names)}
ys = np.where(cells[ref][1].any(axis=1))[0]
scale = STAND / (ys.max() - ys.min() + 1)
info = {}
for name, (im, solid) in cells.items():
    ys, xs = np.where(solid)
    y1 = ys.max()
    low = np.where(solid[int(y1 - (y1 - ys.min()) * 0.05):].any(axis=0))[0]
    feet = (low.min() + low.max()) / 2
    big = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    ox, oy = round(AX - feet * scale), round(AY - (y1 + 1) * scale)
    # keep the whole figure on the canvas (wide poses are nudged sideways, tall ones down is not allowed)
    ox = min(max(ox, round(-xs.min() * scale) + 2), round(W - (xs.max() + 1) * scale) - 2)
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(big, (ox, oy))
    canvas.save(out / f'{name}.png')
    al = np.asarray(canvas.getchannel('A')) > 40
    by, bx = np.where(al)
    if by.min() <= 0: print(f'WARNING: {name} is cut off at the top')
    info[name] = {'file': f'{name}.png', 'bounds': [int(bx.min()), int(by.min()), int(bx.max() - bx.min() + 1), int(by.max() - by.min() + 1)],
                  'cellToCanvas': [scale, ox, oy]}
(out / 'sheet.generated.json').write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
print('scale %.3f' % scale, {k: v['bounds'] for k, v in info.items()})
