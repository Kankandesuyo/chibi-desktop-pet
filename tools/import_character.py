"""Puts a character pack (4 direction views + walk frames, transparent PNGs) on the pet's shared canvas.

Usage: python3 tools/import_character.py <pack dir> assets/characters/<id> [holes.json]
Reads <pack>/manifest.json (views + animations.walk_left.frames). Writes idle/left/right/back.png and
walk-left-N.png / walk-right-N.png, all 640x580 with the feet on the anchor line and the same standing height,
so switching between a still view and a walk frame does not make her jump or change size.
walk-right-N is walk-left-N flipped: a placeholder until real right-facing frames are drawn.
The originals are never modified.
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

pack, out = Path(sys.argv[1]), Path(sys.argv[2])
W, H, AX, AY, STAND = 640, 580, 320, 552, 440
src = json.loads((pack / 'manifest.json').read_text(encoding='utf-8'))
out.mkdir(parents=True, exist_ok=True)
HOLES = json.loads(Path(sys.argv[3]).read_text(encoding='utf-8')) if len(sys.argv) > 3 else {}


def clean(rel: str) -> Image.Image:
    """Largest blobs only, listed background pockets removed, and the hard white-fringed edge pulled in and softened."""
    im = Image.open(pack / rel).convert('RGBA')
    a = np.asarray(im).copy()
    solid = a[..., 3] > 40
    white = solid & (a[..., :3].min(axis=2) >= 250)
    wlab, _ = ndi.label(white)
    for x, y in HOLES.get(rel, []):
        near = wlab[max(0, y - 6): y + 7, max(0, x - 6): x + 7]
        ids = [i for i in np.unique(near) if i]
        if not ids:
            print(f'WARNING: no white pocket at {x},{y} in {rel}')
            continue
        pocket = ndi.binary_dilation(wlab == max(ids, key=lambda i: (near == i).sum()), iterations=2)
        solid &= ~pocket
    lab, n = ndi.label(solid)
    if n > 1:
        sizes = ndi.sum(solid, lab, range(1, n + 1))
        solid = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s > sizes.max() * 0.01])
    core = ndi.binary_erosion(solid, iterations=1)
    # edge pixels are blended with the old white background: take their colour from the nearest inner pixel
    inner = ndi.binary_erosion(solid, iterations=3)
    idx = ndi.distance_transform_edt(~inner, return_distances=False, return_indices=True)
    rgb = a[..., :3][idx[0], idx[1]]
    edge = solid & ~inner
    light = a[..., :3].min(axis=2) > 200                      # only fix edge pixels that really are whitish
    fix = edge & light & (rgb.min(axis=2) < 200)
    a[..., :3][fix] = rgb[fix]
    alpha = Image.fromarray((core * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(0.8))
    res = Image.fromarray(a)
    res.putalpha(alpha)
    return res


def box(im: Image.Image):
    al = np.asarray(im.getchannel('A')) > 40
    ys, xs = np.where(al)
    return al, xs.min(), ys.min(), xs.max(), ys.max()


def centre(al, y0, y1):
    xs = np.where(al[int(y0):int(y1) + 1].any(axis=0))[0]
    return (xs.min() + xs.max()) / 2


def place(im: Image.Image, scale: float, ref_x: float, base_y: float, at_x: float = AX) -> Image.Image:
    """Scale, then put source point (ref_x, base_y) on (at_x, anchor y)."""
    big = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(big, (round(at_x - ref_x * scale), round(AY - base_y * scale)))
    return canvas


def describe(name: str, im: Image.Image, extra: dict) -> dict:
    al, x0, y0, x1, y1 = box(im)
    if x0 <= 0 or x1 >= W - 1 or y0 <= 0:
        print(f'WARNING: {name} touches the canvas edge')
    return {'file': f'{name}.png', 'bounds': [int(x0), int(y0), int(x1 - x0 + 1), int(y1 - y0 + 1)], **extra}


poses = {}
# ---- four still views: one scale for all (they come from one sheet), feet centred on the anchor ----
views = {k: clean(v) for k, v in src['views'].items()}
_, _, fy0, _, fy1 = box(views['front'])
vscale = STAND / (fy1 - fy0 + 1)
for view, name in (('front', 'idle'), ('left', 'left'), ('right', 'right'), ('back', 'back')):
    al, x0, y0, x1, y1 = box(views[view])
    feet = centre(al, y1 - (y1 - y0) * 0.05, y1)
    im = place(views[view], vscale, feet, y1 + 1)
    im.save(out / f'{name}.png')
    poses[name] = describe(name, im, {'source': src['views'][view], 'hem': round(AY - STAND * 0.14)})

# ---- walk frames: one scale, one floor line (keeps the natural bob), head held steady ----
frames = [clean(f) for f in src['animations']['walk_left']['frames']]
boxes = [box(f) for f in frames]
top = min(b[2] for b in boxes); floor = max(b[4] for b in boxes)
wscale = STAND / (floor - top + 1)
heads = [centre(al, y0, y0 + (y1 - y0) * 0.3) for al, x0, y0, x1, y1 in boxes]
feet = [centre(al, y1 - (y1 - y0) * 0.05, y1) for al, x0, y0, x1, y1 in boxes]
lean = float(np.mean([f - h for f, h in zip(feet, heads)]))           # feet sit this far from the head, on average
for i, (f, head) in enumerate(zip(frames, heads), 1):
    left = place(f, wscale, head, floor + 1, AX - lean * wscale)
    left.save(out / f'walk-left-{i}.png')
    poses[f'walk-left-{i}'] = describe(f'walk-left-{i}', left, {'source': src['animations']['walk_left']['frames'][i - 1], 'hem': round(AY - STAND * 0.2)})
    right = left.transpose(Image.FLIP_LEFT_RIGHT)
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    canvas.alpha_composite(right, (2 * AX - W, 0))
    canvas.save(out / f'walk-right-{i}.png')
    poses[f'walk-right-{i}'] = describe(f'walk-right-{i}', canvas, {'source': f'walk-left-{i}.png, flipped (placeholder)', 'mirrored': True, 'hem': round(AY - STAND * 0.2)})

(out / 'poses.generated.json').write_text(json.dumps(poses, ensure_ascii=False, indent=2), encoding='utf-8')
print('view scale %.3f, walk scale %.3f, %d poses' % (vscale, wscale, len(poses)))
