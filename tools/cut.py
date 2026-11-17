"""Pass 1: cut each source image out of its background -> raw/NN.png (trimmed RGBA)."""
import sys, glob, os, numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
for f in sorted(glob.glob(src + '/claudepet_chibi_*.png')):
    n = f[-6:-4]
    im = Image.open(f)
    if im.mode == 'RGBA':
        a = np.asarray(im)
        fg = a[..., 3] > 60
        rgb = a[..., :3]
        alpha_src = a[..., 3]
    else:
        rgb = np.asarray(im.convert('RGB'))
        a16 = rgb.astype(int)
        border = np.concatenate([a16[:6].reshape(-1, 3), a16[-6:].reshape(-1, 3), a16[:, :6].reshape(-1, 3), a16[:, -6:].reshape(-1, 3)])
        bg = np.median(border, axis=0)
        dist = np.abs(a16 - bg).max(axis=2)
        H, W = dist.shape
        def flood(mask):
            lab, _ = ndi.label(mask)
            edge = set(lab[0]) | set(lab[-1]) | set(lab[:, 0]) | set(lab[:, -1]); edge.discard(0)
            return np.isin(lab, list(edge))
        bgm = flood(dist < 9)
        # ground shadow: light, low-saturation pixels near the bottom, connected to the background
        sat = a16.max(axis=2) - a16.min(axis=2)
        loose = (dist < 60) & (sat < 34) & (a16.min(axis=2) > 170)
        loose[: int(H * 0.80)] = False
        lab, _ = ndi.label(loose | bgm)
        ids = set(np.unique(lab[bgm])); ids.discard(0)
        bgm = np.isin(lab, list(ids))
        fg = ~bgm
        alpha_src = None
    fg = ndi.binary_opening(fg, iterations=1)
    lab, k = ndi.label(fg)
    sizes = ndi.sum(fg, lab, range(1, k + 1))
    main = 1 + int(np.argmax(sizes))
    keep = lab == main
    dropped = sorted([int(s) for i, s in enumerate(sizes) if i + 1 != main and s > 150], reverse=True)[:6]
    keep = ndi.binary_fill_holes(keep) if False else keep
    alpha = (keep * 255).astype('uint8')
    if alpha_src is not None:
        alpha = np.minimum(alpha, alpha_src)
    else:
        alpha = np.asarray(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.9)))
        alpha = np.where(keep, alpha, 0).astype('uint8')   # feather inward only: no halo
    res = Image.fromarray(np.dstack([rgb, alpha]), 'RGBA')
    res = res.crop(res.getbbox())
    res.save(f'{out}/{n}.png')
    print(n, res.size, 'dropped components:', dropped)
