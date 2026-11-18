"""Turns the Pinterest picks into web images + pen-stroke data.

For each drawing:
  1. crop / clean it, resize, save to assets/art/<id>.jpg
  2. trace its edges into single-pass polylines (pen strokes)
  3. order the strokes like an artist would (long contours first, then
     detail, each pass chained by nearest neighbour to keep the pen moving)
  4. write assets/strokes/<id>.js  ->  window.SKETCH_DATA['<id>'] = {...}
     (a .js file rather than JSON so the site also works from file://)

Run:  python tools/build_assets.py
"""
import json, os, sys
import numpy as np
import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'pinterest-picks')
ART = os.path.join(ROOT, 'assets', 'art')
STK = os.path.join(ROOT, 'assets', 'strokes')

MAX_SIDE = 1400        # exported image size (long side)
TRACE_SIDE = 900       # resolution used for edge tracing
POINT_BUDGET = 26000   # max polyline points per drawing

# id, source file, crop (x0,y0,x1,y1) in source px or None, inpaint boxes, canny tuning
JOBS = [
    ('castle',     '26_978c59ae.jpg', (140, 95, 1300, 1742), [], 1.0),
    ('lighthouse', '68_0888217b.jpg', (18, 14, 1424, 1690), [(40, 40, 200, 200)], 1.0),
    ('cottage',    '12_09454337.jpg', None, [], 1.0),
    ('cumulus',    '17_6f61f3c5.jpg', None, [], 1.0),
    ('staircase',  '30_2594d9c7.jpg', None, [], 1.0),
    ('tiger',      '67_5726ed77.jpg', None, [], 1.0),
    ('mountain',   '05_e1eabda9.jpg', (0, 0, 683, 975), [], 1.0),
    ('duck',       '06_261031c6.jpg', (40, 20, 1290, 1770), [], 1.0),
    ('knight',     '40_fdb2a18a.jpg', None, [], 0.8),
    ('elder',      '54_15455e8e.jpg', None, [], 0.8),
]


def load(job):
    _id, fname, crop, holes, _ = job
    img = cv2.imread(os.path.join(SRC, fname), cv2.IMREAD_COLOR)
    if img is None:
        sys.exit(f'missing {fname}')
    for (x0, y0, x1, y1) in holes:            # remove UI overlays from screenshots
        mask = np.zeros(img.shape[:2], np.uint8)
        mask[y0:y1, x0:x1] = 255
        img = cv2.inpaint(img, mask, 9, cv2.INPAINT_TELEA)
    if crop:
        x0, y0, x1, y1 = crop
        img = img[y0:y1, x0:x1]
    return img


def resize_long(img, side):
    h, w = img.shape[:2]
    s = side / max(h, w)
    if s >= 1:
        return img, 1.0
    return cv2.resize(img, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA), s


def edge_map(gray, sens):
    g = cv2.bilateralFilter(gray, 7, 40, 7)
    med = float(np.median(g))
    lo = int(max(10, (0.55 / sens) * med * 0.5))
    hi = int(min(255, (1.1 / sens) * med * 0.75))
    e = cv2.Canny(g, lo, hi, L2gradient=True)
    return e


def single_pass_paths(edges):
    """findContours walks a 1-px curve there-and-back; split into one-way runs."""
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    seen = np.zeros(edges.shape, bool)
    paths = []
    for c in contours:
        pts = c[:, 0, :]
        run = []
        for x, y in pts:
            if seen[y, x]:
                if len(run) > 1:
                    paths.append(np.array(run, np.float32))
                run = []
                continue
            seen[y, x] = True
            run.append((x, y))
        if len(run) > 1:
            paths.append(np.array(run, np.float32))
    return paths


def simplify(p, eps=0.9):
    a = cv2.approxPolyDP(p.reshape(-1, 1, 2), eps, False)[:, 0, :]
    return a


def plen(p):
    d = np.diff(p, axis=0)
    return float(np.sqrt((d ** 2).sum(1)).sum())


def chain(paths):
    """Greedy nearest-neighbour ordering; may reverse paths to start at the near end."""
    if not paths:
        return []
    starts = np.array([p[0] for p in paths])
    ends = np.array([p[-1] for p in paths])
    used = np.zeros(len(paths), bool)
    # begin with the top-most-left stroke
    i = int(np.argmin(starts[:, 1] * 2 + starts[:, 0]))
    order = [(i, False)]
    used[i] = True
    cur = ends[i]
    for _ in range(len(paths) - 1):
        ds = ((starts - cur) ** 2).sum(1)
        de = ((ends - cur) ** 2).sum(1)
        ds[used] = np.inf
        de[used] = np.inf
        js, je = int(np.argmin(ds)), int(np.argmin(de))
        if ds[js] <= de[je]:
            order.append((js, False)); used[js] = True; cur = ends[js]
        else:
            order.append((je, True)); used[je] = True; cur = starts[je]
    return [paths[k][::-1] if rev else paths[k] for k, rev in order]


def build(job):
    _id, _, _, _, sens = job
    img = load(job)
    out, _ = resize_long(img, MAX_SIDE)
    H, W = out.shape[:2]
    cv2.imwrite(os.path.join(ART, f'{_id}.jpg'), out, [cv2.IMWRITE_JPEG_QUALITY, 86,
                                                       cv2.IMWRITE_JPEG_PROGRESSIVE, 1])

    # pass 0: light construction sketch from a blurred, low-res version
    tiny, _ = resize_long(img, 320)
    tg = cv2.GaussianBlur(cv2.cvtColor(tiny, cv2.COLOR_BGR2GRAY), (0, 0), 2.2)
    otsu, _ = cv2.threshold(tg, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    te = cv2.Canny(tg, otsu * 0.25, otsu * 0.6, L2gradient=True)
    sketch = [simplify(p, 0.7) for p in single_pass_paths(te)]
    sketch = [p for p in sketch if len(p) >= 2 and plen(p) >= 12]
    sketch.sort(key=plen, reverse=True)
    budget, sk = 0, []
    for p in sketch:
        if budget + len(p) > 2600:
            break
        sk.append(p); budget += len(p)
    sk = chain(sk)
    tscale = W / tiny.shape[1]

    small, s = resize_long(img, TRACE_SIDE)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    edges = edge_map(gray, sens)
    paths = [simplify(p) for p in single_pass_paths(edges)]
    paths = [p for p in paths if len(p) >= 2 and plen(p) >= 7]
    paths.sort(key=plen, reverse=True)

    # stay inside the point budget, dropping the tiniest specks first
    total, kept = 0, []
    for p in paths:
        if total + len(p) > POINT_BUDGET:
            break
        kept.append(p); total += len(p)

    # pass 1: the long "construction" contours, pass 2: everything else
    lens = np.array([plen(p) for p in kept])
    cut = np.searchsorted(np.cumsum(lens), lens.sum() * 0.38)
    passes = [chain(kept[:cut + 1]), chain(kept[cut + 1:])]

    def enc(paths, scale):
        res = []
        for p in paths:
            q = np.round(p * scale).astype(int)
            flat = [int(q[0, 0]), int(q[0, 1])]
            for k in range(1, len(q)):                   # delta-encode
                flat += [int(q[k, 0] - q[k - 1, 0]), int(q[k, 1] - q[k - 1, 1])]
            res.append(flat)
        return res

    scale = W / small.shape[1]
    strokes = enc(passes[0], scale) + enc(passes[1], scale)
    payload = {'w': W, 'h': H, 'sketch': enc(sk, tscale),
               'firstPass': len(passes[0]), 'strokes': strokes}
    js = f"(window.SKETCH_DATA=window.SKETCH_DATA||{{}})['{_id}']=" + \
         json.dumps(payload, separators=(',', ':')) + ';\n'
    with open(os.path.join(STK, f'{_id}.js'), 'w') as f:
        f.write(js)
    print(f'{_id:11s} {W}x{H}  sketch={len(sk):4d} strokes={len(strokes):5d}  points={total:6d}  '
          f'data={len(js)/1024:.0f}KB')


if __name__ == '__main__':
    only = sys.argv[1:]
    for job in JOBS:
        if not only or job[0] in only:
            build(job)
