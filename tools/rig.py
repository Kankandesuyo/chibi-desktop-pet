"""Splits the side-view poses into a body layer and a leg layer so walking can swing the legs,
and records each pose's hem line (where the skirt ends) for the soft-body deformation.

Usage: python3 tools/rig.py assets/characters
Writes <pose>-body.png / <pose>-leg.png and updates manifest.json (poses.<name>.rig, .hem, "parts").
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
ANCHOR_Y = manifest['canvas']['anchor'][1]
HIDDEN = 44          # how far the leg continues up under the skirt (canvas px)
PAD = 8

def spans(row):
    xs = np.where(row > 100)[0]
    if len(xs) == 0: return []
    out, s, p = [], xs[0], xs[0]
    for x in xs[1:]:
        if x != p + 1: out.append((s, p)); s = x
        p = x
    out.append((s, p))
    return out

ANCHOR_X = manifest['canvas']['anchor'][0]

def foot_spans(row):
    """Opaque spans near the feet (ignores hair tips hanging down at the sides)."""
    return [s for s in spans(row) if s[1] >= ANCHOR_X - 70 and s[0] <= ANCHOR_X + 70]

def find_hem(alpha):
    """First row (from the bottom up) where the skirt starts; below it only boots remain."""
    widths = [sum(e - b + 1 for b, e in foot_spans(alpha[y])) for y in range(alpha.shape[0])]
    bottom = max(y for y, w in enumerate(widths) if w > 0)
    foot_w = max(widths[bottom - 30: bottom])
    for y in range(bottom - 30, 0, -1):
        if widths[y] > foot_w * 1.35: return y + 1, bottom, foot_w
    return bottom - 40, bottom, foot_w

parts = []
for name, spec in manifest['poses'].items():
    img = Image.open(root / spec['file']).convert('RGBA')
    a = np.asarray(img).copy()
    hem, bottom, _ = find_hem(a[..., 3])
    spec['hem'] = int(hem)
    if name not in ('left', 'right'):
        continue
    # boot columns: union of spans in the boots-only rows
    xs = [x for y in range(hem, bottom + 1) for s in foot_spans(a[y, :, 3]) for x in (s[0], s[1])]
    bx0, bx1 = min(xs) - PAD, max(xs) + PAD
    top = hem - HIDDEN
    leg = np.zeros((bottom + 4 - top, bx1 - bx0, 4), dtype=np.uint8)
    real = a[hem:bottom + 4, bx0:bx1]
    leg[hem - top:] = real
    # continue the boot shaft upward (it is hidden under the skirt but shows if the leg swings)
    shaft_row = a[hem + 3, bx0:bx1].copy()
    for y in range(0, hem - top):
        leg[y] = shaft_row
    # keep only the boot itself in the top rows of the visible part (drop slivers of the skirt ruffle)
    sx = [x - bx0 for x in range(bx0, bx1) if a[hem + 3, x, 3] > 100]
    for y in range(hem - top, hem - top + 4):
        leg[y, :min(sx)] = 0
        leg[y, max(sx) + 1:] = 0
    body = a.copy()
    body[hem:, bx0:bx1] = 0
    shaft = [x for x in range(bx0, bx1) if a[hem + 3, x, 3] > 100]
    hip_x = (min(shaft) + max(shaft)) / 2
    Image.fromarray(leg).save(root / f'{name}-leg.png')
    Image.fromarray(body).save(root / f'{name}-body.png')
    spec['rig'] = {'body': f'{name}-body.png', 'leg': f'{name}-leg.png', 'origin': [int(bx0), int(top)], 'hip': [round(hip_x, 1), int(top + 6)]}
    parts += [f'{name}-body.png', f'{name}-leg.png']
    print(name, 'hem', hem, 'boot x', bx0, bx1, 'hip', spec['rig']['hip'])

manifest['parts'] = parts
for name, spec in manifest['poses'].items():
    if name not in ('left', 'right'): print(name, 'hem', spec['hem'])
(root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
