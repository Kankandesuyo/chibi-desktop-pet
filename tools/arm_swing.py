"""Give a one-step walk loop a steady, natural arm swing.

    python tools/arm_swing.py <folder with cut frames> <prefix> <frame order, e.g. 8,1,2,4,3,5,6,7> <out folder> <out prefix> <facing: left|right>

The drawn frames show one step, and the hand sits in a slightly different place in every frame, which plays
back as jitter. An arm swings once per TWO steps, so the loop is written out twice (2 x N frames) and in each
copy the near arm is turned about the shoulder: first the hand is brought to the same resting spot in every
frame, then moved along one smooth forward-and-back swing over the two steps. Only a narrow strip around the
arm is bent; legs, head and everything else are the original pixels.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SWING = 11          # px the hand travels to each side of rest
ARM_LEN = 85        # shoulder is this far above the hand
CORE, EDGE = 16, 52  # full effect within CORE px of the arm, none beyond EDGE


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def find_hand(a):
    r, g, b, al = (a[..., i].astype(int) for i in range(4))
    skin = (r > 235) & (g > 200) & (g < 245) & (b > 180) & (b < 238) & (r - b > 12) & (al > 200)
    skin[:330] = False
    skin[470:] = False                       # below the face, above the legs
    labels, count = ndi.label(skin)
    sizes = ndi.sum(skin, labels, range(1, count + 1))
    ys, xs = np.where(labels == int(np.argmax(sizes)) + 1)
    return float(xs.mean()), float(ys.mean())


def turn_arm(img, hand, move):
    """Shift the hand sideways by `move` px, fading to nothing at the shoulder and away from the arm."""
    src = np.asarray(img).astype(np.float32)
    h, w = src.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    hx, hy = hand

    def shift(x, y):
        along = smooth((y - (hy - ARM_LEN)) / ARM_LEN) * (1 - smooth((y - (hy + 16)) / 26))
        across = 1 - smooth((np.abs(x - hx) - CORE) / (EDGE - CORE))
        return move * along * across

    sx = xs.copy()
    for _ in range(14):                      # invert the forward shift
        sx = xs - shift(sx, ys)
    x0 = np.clip(np.floor(sx).astype(int), 0, w - 2)
    f = (sx - x0)[..., None]
    rows = ys.astype(int)
    a0, a1 = src[rows, x0, 3:4] / 255, src[rows, x0 + 1, 3:4] / 255
    rgb = src[rows, x0, :3] * a0 * (1 - f) + src[rows, x0 + 1, :3] * a1 * f
    alpha = a0 * (1 - f) + a1 * f
    out = np.concatenate([np.where(alpha > 0, rgb / np.maximum(alpha, 1e-6), 0), alpha * 255], axis=2)
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), 'RGBA')


def main(src_dir, prefix, order, out_dir, out_prefix, facing):
    src_dir, out_dir = Path(src_dir), Path(out_dir)
    frames = [Image.open(src_dir / f'{prefix}-{n}.png').convert('RGBA') for n in order]
    hands = [find_hand(np.asarray(f)) for f in frames]
    rest = float(np.median([h[0] for h in hands]))
    forward = -1 if facing == 'left' else 1
    total = 2 * len(frames)
    print(f'{prefix}: hands were at x {[round(h[0]) for h in hands]}, resting spot {rest:.0f}')
    after = []
    for k in range(total):
        i = k % len(frames)
        # k = 0 is a "feet apart" frame: the arm is at one end of its swing there and passes the body
        # while the feet are together.
        target = rest + forward * SWING * np.cos(2 * np.pi * k / total)
        out = turn_arm(frames[i], hands[i], target - hands[i][0])
        out.save(out_dir / f'{out_prefix}-{k + 1:02d}.png', optimize=True)
        after.append(round(find_hand(np.asarray(out))[0]))
    print(f'  written {total} frames, hands now at x {after}')


if __name__ == '__main__':
    a = sys.argv
    main(a[1], a[2], [int(v) for v in a[3].split(',')], a[4], a[5], a[6])
