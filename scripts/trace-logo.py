# Usage: <python with opencv-python + pillow> scripts/trace-logo.py resources/brand/stitch-logo.png .
#        then: npm run icons
"""Trace the Stitch unicorn logo into SVG paths.

Mark (unicorn) and wordmark are split by colour: the unicorn is saturated, the
wordmark is dark plum. Edges come from a soft coverage estimate so the traced
outline sits on the true 50% boundary. The unicorn keeps its painted colour
field (periwinkle -> peach -> pink) as a tiny embedded image used as a pattern
fill, which reproduces the 2D blend a linear gradient can't.
"""
import base64, io, json, math, os, sys
import cv2
import numpy as np
from PIL import Image

SRC = sys.argv[1]
ROOT = sys.argv[2]  # project root

img = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
h, w, _ = img.shape
border = np.concatenate([img[:10].reshape(-1, 3), img[-10:].reshape(-1, 3), img[:, :10].reshape(-1, 3), img[:, -10:].reshape(-1, 3)])
bg = np.median(border, axis=0)
dist = np.linalg.norm(img - bg, axis=2)
chroma = img.max(axis=2) - img.min(axis=2)

# Classify connected blobs as mark or wordmark.
loose = (dist > 40).astype(np.uint8)
n, labels, stats, _ = cv2.connectedComponentsWithStats(loose, 8)
mark_lab = np.zeros(n, bool)
text_lab = np.zeros(n, bool)
for i in range(1, n):
    if stats[i, cv2.CC_STAT_AREA] < 30:
        continue
    sel = (labels == i) & (dist > 90)
    if not sel.any():
        continue
    c = np.median(chroma[sel])
    if c > 45:
        mark_lab[i] = True
    else:
        text_lab[i] = True
mark_region = mark_lab[labels]
text_region = text_lab[labels]

# Soft coverage: distance from background relative to the local ink strength.
local = cv2.dilate(dist, np.ones((13, 13), np.uint8))
alpha = np.clip(dist / np.maximum(local, 1), 0, 1)
grow = np.ones((5, 5), np.uint8)
mark_alpha = np.where(cv2.dilate(mark_region.astype(np.uint8), grow) > 0, alpha, 0).astype(np.float32)
text_alpha = np.where(cv2.dilate(text_region.astype(np.uint8), grow) > 0, alpha, 0).astype(np.float32)
# Keep blurry halo pixels of one class out of the other.
mark_alpha[text_region] = 0
text_alpha[mark_region] = 0

SCALE = 4


def trace(a, eps):
    m = cv2.resize(a, (w * SCALE, h * SCALE), interpolation=cv2.INTER_CUBIC)
    m = cv2.GaussianBlur(m, (0, 0), SCALE * 0.55)
    m = (m > 0.5).astype(np.uint8) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    ys, xs = np.where(m > 0)
    box = (xs.min() / SCALE, ys.min() / SCALE, (xs.max() + 1) / SCALE, (ys.max() + 1) / SCALE)
    d = ''
    for c in contours:
        if cv2.contourArea(c) < 25 * SCALE * SCALE:
            continue
        pts = cv2.approxPolyDP(c, eps * SCALE, True).reshape(-1, 2) / SCALE
        coords = [f'{x - box[0]:.1f} {y - box[1]:.1f}' for x, y in pts]
        d += 'M' + coords[0] + 'L' + 'L'.join(coords[1:]) + 'Z'
    return d, box, m


mark_d, mb, mark_bin = trace(mark_alpha, 0.35)
text_d, tb, _ = trace(text_alpha, 0.35)
MW, MH = mb[2] - mb[0], mb[3] - mb[1]
TW, TH = tb[2] - tb[0], tb[3] - tb[1]

# Colour field over the mark's box: normalised convolution of the solid interior.
x0, y0, x1, y1 = int(mb[0]), int(mb[1]), int(math.ceil(mb[2])), int(math.ceil(mb[3]))
solid = (mark_region & (alpha > 0.92)).astype(np.uint8)
solid = cv2.erode(solid, np.ones((5, 5), np.uint8))[y0:y1, x0:x1].astype(np.float32)
crop = img[y0:y1, x0:x1]
field = np.zeros_like(crop)
filled = np.zeros(solid.shape, bool)
for sigma in (6, 14, 30, 60, 120):
    num = cv2.GaussianBlur(crop * solid[..., None], (0, 0), sigma)
    den = cv2.GaussianBlur(solid, (0, 0), sigma)
    ok = (den > 1e-3) & ~filled
    field[ok] = num[ok] / den[ok][:, None]
    filled |= ok
FW = 72
FH = max(8, round(FW * (y1 - y0) / (x1 - x0)))
small = cv2.resize(field, (FW, FH), interpolation=cv2.INTER_AREA)
small = cv2.GaussianBlur(small, (0, 0), 0.8)
buf = io.BytesIO()
Image.fromarray(np.clip(small, 0, 255).astype(np.uint8)).save(buf, 'PNG', optimize=True)
FIELD = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()

# A linear fallback (top -> bottom) for places that want a plain gradient.
ys, xs = np.where(mark_region & (alpha > 0.92))
proj = ys.astype(np.float32)
lo, hi = proj.min(), proj.max()
stops = []
for i in range(5):
    t = lo + (hi - lo) * i / 4
    sel = img[ys[np.abs(proj - t) < (hi - lo) / 8], xs[np.abs(proj - t) < (hi - lo) / 8]]
    stops.append('#%02x%02x%02x' % tuple(int(round(v)) for v in np.median(sel, axis=0)))

ink_px = img[text_region & (alpha > 0.9)]
INK = '#%02x%02x%02x' % tuple(int(round(v)) for v in np.median(ink_px, axis=0))
GAP = round(tb[0] - mb[2], 1)
DY = round(tb[1] - mb[1], 1)
f1 = lambda v: f'{v:.1f}'

# --- logo-paths.ts --------------------------------------------------------
ts = f'''// Generated from the Stitch logo artwork (resources/brand/stitch-logo.png). Do not edit by hand.
export const MARK = {{ w: {f1(MW)}, h: {f1(MH)}, d: {json.dumps(mark_d)} }}
/** The unicorn's painted colour field, stretched over the mark's box as a pattern fill. */
export const MARK_FILL = {json.dumps(FIELD)}
/** Top-to-bottom fallback stops for plain gradients. */
export const MARK_STOPS = {json.dumps(stops)}
export const WORDMARK = {{ w: {f1(TW)}, h: {f1(TH)}, d: {json.dumps(text_d)}, ink: "{INK}" }}
/** Horizontal gap (negative: the horn overhangs the wordmark) and vertical offset, in mark units. */
export const LOCKUP = {{ gap: {GAP}, dy: {DY} }}
'''
open(os.path.join(ROOT, 'src/renderer/src/components/shell/logo-paths.ts'), 'w', encoding='utf-8').write(ts)


def fill_defs(pid):
    return (f'<pattern id="{pid}" patternUnits="userSpaceOnUse" width="{f1(MW)}" height="{f1(MH)}">'
            f'<image href="{FIELD}" width="{f1(MW)}" height="{f1(MH)}" preserveAspectRatio="none"/></pattern>')


mark_path = f'<path fill="url(#f)" fill-rule="evenodd" d="{mark_d}"/>'
# --- logo-mark.svg ---------------------------------------------------------
open(os.path.join(ROOT, 'resources/logo-mark.svg'), 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f1(MW)} {f1(MH)}"><defs>{fill_defs("f")}</defs>{mark_path}</svg>')
# --- logo-full.svg (lockup, plum wordmark) --------------------------------
full_w = mb[2] - mb[0] + GAP + TW
full_w = max(tb[2], mb[2]) - mb[0]
full_h = max(mb[3], tb[3]) - min(mb[1], tb[1])
open(os.path.join(ROOT, 'resources/logo-full.svg'), 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {f1(full_w)} {f1(full_h)}"><defs>{fill_defs("f")}</defs>{mark_path}'
    f'<path id="wordmark" transform="translate({f1(tb[0] - mb[0])} {f1(tb[1] - mb[1])})" fill="{INK}" fill-rule="evenodd" d="{text_d}"/></svg>')
# --- icon.svg (square, transparent, mark centred with padding) -------------
side = max(MW, MH) / 0.88
open(os.path.join(ROOT, 'resources/icon.svg'), 'w').write(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 {f1(side)} {f1(side)}"><defs>{fill_defs("f")}</defs>'
    f'<g transform="translate({f1((side - MW) / 2)} {f1((side - MH) / 2)})">{mark_path}</g></svg>')

print(json.dumps({'mark': [round(MW, 1), round(MH, 1)], 'text': [round(TW, 1), round(TH, 1)], 'gap': GAP, 'dy': DY, 'ink': INK,
                  'stops': stops, 'field_bytes': len(FIELD), 'mark_d': len(mark_d), 'text_d': len(text_d),
                  'components': int(mark_lab.sum()), 'text_components': int(text_lab.sum())}))
