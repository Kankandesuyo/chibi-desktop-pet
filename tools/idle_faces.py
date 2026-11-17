"""Build the idle face variants of the DeepSeek character from pictures that already exist.

    python tools/idle_faces.py assets/characters/deepseek

    idle.png        eyes open,   mouth open    (the original, untouched)
    idle-shut.png   eyes open,   mouth closed
    blink.png       eyes closed, mouth open
    blink-shut.png  eyes closed, mouth closed

Only the eyes and the mouth change: the open eyes / open mouth of idle.png are painted over with her skin
colour and the closed eyelids / closed smile are carried over from closed-smile.png (same head, same place).
Everything outside those small patches stays pixel-identical to idle.png, so nothing shifts when she blinks.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

# Canvas pixels in idle.png: (centre x, centre y, radius x, radius y)
EYES = [(289, 259, 28, 19), (347, 257, 28, 19)]
MOUTH = (321, 286, 20, 13)
# Where the closed lids / the closed smile sit in closed-smile.png: (x0, y0, x1, y1)
LIDS = [(264, 258, 306, 280), (330, 254, 374, 278)]
SMILE = (306, 281, 336, 295)
SKIN_AT = (322, 270)            # a plain skin pixel in both pictures (between nose and mouth)


def rgb(img):
    return np.asarray(img.convert('RGBA')).astype(np.float32)


def ellipse(shape, cx, cy, rx, ry):
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1


def hairlike(a):
    """Blue-violet hair (not the near-black lashes, not skin)."""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = (r + g + b) / 3
    return (b - r > 14) & (lum > 75) & (r < 236)


def feather(mask, px=1.6):
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(px))).astype(np.float32) / 255


def wipe(idle, patches, skin):
    """Paint the patches with skin, but leave real hair (strands that continue outside the patch) alone."""
    region = np.zeros(idle.shape[:2], bool)
    for p in patches:
        region |= ellipse(idle.shape, *p)
    hair = hairlike(idle)
    labels, _ = ndi.label(hair)
    grown = ndi.binary_dilation(region, iterations=3)
    keep_ids = set(np.unique(labels[hair & ~grown])) - {0}
    real_hair = np.isin(labels, list(keep_ids))
    paint = feather(region & ~real_hair)
    paint[real_hair] = 0
    out = idle.copy()
    out[..., :3] = idle[..., :3] * (1 - paint[..., None]) + skin * paint[..., None]
    return out, real_hair


def carry(dst, src, boxes, skin_dst, skin_src, blocked):
    """Copy what is drawn on the skin inside the boxes (lids, smile line) as a difference from plain skin."""
    out = dst.copy()
    for x0, y0, x1, y1 in boxes:
        s = src[y0:y1, x0:x1, :3]
        ink = ~hairlike(src[y0:y1, x0:x1]) & (src[y0:y1, x0:x1, 3] > 200)
        ink &= ~blocked[y0:y1, x0:x1]
        delta = np.where(ink[..., None], s - skin_src, 0)
        # fade the box edge so the patch has no outline
        edge = np.zeros(ink.shape, np.float32); edge[2:-2, 2:-2] = 1
        delta *= feather(edge, 1.5)[..., None]
        out[y0:y1, x0:x1, :3] = np.clip(out[y0:y1, x0:x1, :3] + delta, 0, 255)
    return out


def main(folder):
    folder = Path(folder)
    idle = rgb(Image.open(folder / 'idle.png'))
    closed = rgb(Image.open(folder / 'closed-smile.png'))
    sx, sy = SKIN_AT
    skin_idle = np.median(idle[sy - 3:sy + 4, sx - 3:sx + 4, :3].reshape(-1, 3), axis=0)
    skin_closed = np.median(closed[sy - 3:sy + 4, sx - 3:sx + 4, :3].reshape(-1, 3), axis=0)
    print('skin', skin_idle.round(), skin_closed.round())

    def save(name, arr):
        Image.fromarray(np.clip(arr + 0.5, 0, 255).astype(np.uint8), 'RGBA').save(folder / name, optimize=True)
        changed = np.abs(arr - idle).max(2) > 2
        ys, xs = np.where(changed)
        print(f'{name}: {int(changed.sum())} px differ from idle, inside x {xs.min()}–{xs.max()} y {ys.min()}–{ys.max()}')

    no_eyes, hair_e = wipe(idle, EYES, skin_idle)
    blink = carry(no_eyes, closed, LIDS, skin_idle, skin_closed, hair_e)
    no_mouth, hair_m = wipe(idle, [MOUTH], skin_idle)
    shut = carry(no_mouth, closed, [SMILE], skin_idle, skin_closed, hair_m)
    both, hair_b = wipe(blink, [MOUTH], skin_idle)
    both = carry(both, closed, [SMILE], skin_idle, skin_closed, hair_b)
    save('idle-shut.png', shut)
    save('blink.png', blink)
    save('blink-shut.png', both)


if __name__ == '__main__':
    main(sys.argv[1])
