"""Pass 2: clean up, normalise scale, place every pose on one shared canvas with a common
feet anchor, build the blink frame, write assets/characters/*.png + manifest.json."""
import sys, os, json, numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
raw, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
CW, CH, AX, AY = 640, 580, 320, 552          # canvas + feet anchor
SA, SB = 440 / 1400, 427 / 1299              # scale for series A (opaque sources) / B (transparent sources)
POSES = {  # name: (source, series, anchor mode)
    'idle': ('01', 'A', 'feet'), 'closed-smile': ('14', 'A', 'feet'), 'wink': ('15', 'A', 'feet'),
    'wave': ('16', 'A', 'feet'), 'jump': ('17', 'A', 'mass'), 'left': ('02', 'A', 'feet'),
    'right': ('12', 'A', 'feet'), 'back': ('13', 'A', 'feet'), 'run-left': ('05', 'B', 'mass'),
    'happy': ('06', 'B', 'feet'), 'struggle': ('07', 'B', 'mass'), 'hang': ('09', 'B', 'mass'),
    'kick': ('11', 'B', 'mass'),
}

def largest(mask):
    lab, k = ndi.label(mask)
    if k == 0: return mask
    sizes = ndi.sum(mask, lab, range(1, k + 1))
    return lab == 1 + int(np.argmax(sizes))

def clean(n, series):
    a = np.asarray(Image.open(f'{raw}/{n}.png')).copy()
    rgb, al = a[..., :3].astype(int), a[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    orange = (r > 190) & (g > 70) & (g < 190) & (b < 130) & (r - b > 90)
    if series == 'A':
        # background trapped between hair strands: near-white, low saturation, ringed by orange hair
        sat = rgb.max(axis=2) - rgb.min(axis=2)
        cand = (al > 0) & (rgb.min(axis=2) > 228) & (sat < 10)
        lab, k = ndi.label(cand)
        for i, sl in enumerate(ndi.find_objects(lab), 1):
            comp = lab[sl] == i
            if comp.sum() < 40: continue
            ring = ndi.binary_dilation(comp, iterations=4) & ~comp
            if orange[sl][ring].mean() > 0.55:
                al[sl][comp] = 0
    else:
        al[al < 150] = 0                       # semi-transparent ground shadows
    if n == '09':                              # baked-in mouse cursor + ring near the hair tip
        box = (slice(0, 215), slice(680, 905))
        al[box][~orange[box]] = 0
    if n == '05':                              # ground streak under the feet
        H = al.shape[0]
        dark = (rgb.max(axis=2) < 150) & (rgb.max(axis=2) - rgb.min(axis=2) < 60)
        zone = np.zeros_like(dark); zone[int(H * .955):] = True
        al[dark & zone] = 0
    keep = largest(ndi.binary_opening(al > 40, iterations=1))
    al[~keep] = 0
    a[..., 3] = al
    im = Image.fromarray(a, 'RGBA')
    return im.crop(im.getbbox())

def place(im, scale, mode):
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    al = np.asarray(im)[..., 3] > 40
    if mode == 'feet':
        rows = al[int(al.shape[0] * .955):]
        cx = np.nonzero(rows.any(axis=0))[0].mean()
    else:
        cx = np.nonzero(al)[1].mean()
    canvas = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    ox, oy = round(AX - cx), AY - im.height
    canvas.alpha_composite(im, (ox, max(oy, 0)))
    return canvas, (ox, oy, im.width, im.height)

manifest = {'version': 1, 'canvas': {'width': CW, 'height': CH, 'anchor': [AX, AY], 'standHeight': 440},
            'fallback': 'idle', 'poses': {}}
placed = {}
for name, (n, series, mode) in POSES.items():
    canvas, box = place(clean(n, series), SA if series == 'A' else SB, mode)
    placed[name] = canvas
    canvas.save(f'{out}/{name}.png', optimize=True)
    manifest['poses'][name] = {'file': f'{name}.png', 'source': f'claudepet_chibi_{n}.png', 'bounds': list(box)}
    print(name, box)

# ---- blink frame: idle with the closed eyes from closed-smile, aligned on the face ----
idle, closed = placed['idle'], placed['closed-smile']
bi = manifest['poses']['idle']['bounds']
fx0, fy0, fx1, fy1 = bi[0] + int(bi[2] * .25), bi[1] + int(bi[3] * .17), bi[0] + int(bi[2] * .75), bi[1] + int(bi[3] * .40)
gi = np.asarray(idle.convert('L')).astype(float); gc = np.asarray(closed.convert('L')).astype(float)
skin = lambda im: (lambda a: (a[..., 0] > 235) & (a[..., 1] > 205) & (a[..., 1] < 240) & (a[..., 2] > 185) & (a[..., 2] < 232))(np.asarray(im).astype(int))
si, sc = skin(idle), skin(closed)
best = None
for dy in range(-24, 25):
    for dx in range(-24, 25):
        ov = (si[fy0:fy1, fx0:fx1] & sc[fy0 + dy:fy1 + dy, fx0 + dx:fx1 + dx]).sum()
        if best is None or ov > best[0]: best = (ov, dx, dy)
_, dx, dy = best
print('blink align offset', dx, dy)
manifest['poses']['blink'] = {'file': 'blink.png', 'source': 'idle + eyes of claudepet_chibi_14.png', 'bounds': bi}
json.dump({'face': [fx0, fy0, fx1, fy1], 'offset': [dx, dy]}, open('/tmp/blink_dbg.json', 'w'))
Image.fromarray(np.asarray(idle)[fy0 - 30:fy1 + 60, fx0 - 60:fx1 + 60]).resize((560, 440)).save('/tmp/face_idle.png')
Image.fromarray(np.asarray(closed)[fy0 + dy - 30:fy1 + dy + 60, fx0 + dx - 60:fx1 + dx + 60]).resize((560, 440)).save('/tmp/face_closed.png')
json.dump(manifest, open('/tmp/manifest_stage1.json', 'w'), indent=1)
