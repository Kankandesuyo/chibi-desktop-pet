"""Build blink.png: the idle frame with only the eyes replaced by the closed eyes of pose 14.
Everything outside two small eye ellipses is pixel-identical to idle, so blinking cannot shift the character."""
import sys, json, numpy as np
from PIL import Image, ImageFilter
d = sys.argv[1]
idle = np.asarray(Image.open(f'{d}/idle.png')).astype(float)
closed = np.asarray(Image.open(f'{d}/closed-smile.png')).astype(float)
dx, dy = json.load(open('/tmp/blink_dbg.json'))['offset']
closed = np.roll(closed, (-dy, -dx), axis=(0, 1))          # closed[y+dy, x+dx] -> [y, x]
H, W = idle.shape[:2]
yy, xx = np.mgrid[0:H, 0:W]
def is_hair(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r > 190) & (g > 70) & (g < 185) & (b < 125) & (r - b > 95)
def is_skin(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    return (r > 238) & (g > 208) & (b > 190) & (g < 245)
mask = np.zeros((H, W))
for cx, cy in ((285, 232), (359, 228)):
    mask = np.maximum(mask, (((xx - cx) / 28.0) ** 2 + ((yy - cy) / 20.0) ** 2 <= 1).astype(float))
region = mask > 0
skin_px = idle[region & is_skin(idle)][:, :3]
skin = np.median(skin_px, axis=0)
src = closed.copy()
bad = is_hair(closed) | (closed[..., 3] < 200)
src[bad, :3] = skin; src[..., 3] = 255
from scipy import ndimage as ndi
hair = is_hair(idle)
lab, k = ndi.label(hair)
outside = set(np.unique(lab[hair & ~region])); outside.discard(0)
keep_idle = np.isin(lab, list(outside))                      # only the fringe (hair that continues outside the eye area), not the amber iris
keep_idle = ndi.binary_dilation(keep_idle, iterations=1) & region | keep_idle   # ...plus its outline
mask[keep_idle] = 0
m = np.asarray(Image.fromarray((mask * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(1.2))) / 255.0
m[keep_idle] = 0
out = idle.copy()
out[..., :3] = idle[..., :3] * (1 - m[..., None]) + src[..., :3] * m[..., None]
Image.fromarray(out.astype('uint8'), 'RGBA').save(f'{d}/blink.png', optimize=True)
a = Image.fromarray(idle.astype('uint8')).crop((220, 170, 430, 300)).resize((630, 390), Image.LANCZOS)
b = Image.fromarray(out.astype('uint8')).crop((220, 170, 430, 300)).resize((630, 390), Image.LANCZOS)
s = Image.new('RGB', (1270, 390), (40, 110, 60)); s.paste(a, (0, 0), a); s.paste(b, (640, 0), b); s.save('/tmp/blink_cmp.png')
print('changed pixels', int((np.abs(out - idle).sum(axis=2) > 0).sum()))
