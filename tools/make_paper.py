"""Generate a seamless, near-white paper texture tile.

The tile is greyscale and meant to be multiplied over a paper colour in CSS
(background-blend-mode: multiply), so one image serves every tint of paper.
Layers: soft cloudy mottling, mid-scale pulp, short pressed fibres and a
fine tooth. Noise is built in the frequency domain, so it wraps seamlessly.

    python tools/make_paper.py   ->  assets/paper/paper.jpg
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 720
rng = np.random.default_rng(7)


def periodic_noise(size, sigma):
    """Gaussian-filtered white noise, filtered via FFT so it tiles."""
    white = rng.standard_normal((size, size))
    f = np.fft.fftfreq(size)
    fx, fy = np.meshgrid(f, f)
    kernel = np.exp(-(fx ** 2 + fy ** 2) * (2 * math.pi * sigma) ** 2 / 2)
    out = np.real(np.fft.ifft2(np.fft.fft2(white) * kernel))
    return out / (out.std() + 1e-9)


# Darkness map: 0 = white, positive = darker
dark = np.zeros((SIZE, SIZE))
dark += 2.0 * periodic_noise(SIZE, 60)   # cloudy mottling
dark += 1.6 * periodic_noise(SIZE, 10)   # pulp clumps
dark += 1.3 * periodic_noise(SIZE, 2.2)  # small flecks
dark += 3.0 * rng.standard_normal((SIZE, SIZE))  # fine tooth

# Fibres: short soft curves, some darker, some lighter than the sheet
fib = Image.new('L', (SIZE, SIZE), 128)
d = ImageDraw.Draw(fib)
for _ in range(2600):
    x, y = rng.uniform(0, SIZE, 2)
    ang = rng.uniform(0, math.pi)
    length = rng.uniform(6, 34)
    bend = rng.uniform(-0.5, 0.5)
    tone = int(128 + rng.choice([-1, 1], p=[0.7, 0.3]) * rng.uniform(10, 34))
    pts = []
    for i in range(7):
        t = i / 6
        a = ang + bend * (t - 0.5)
        pts.append((x + math.cos(a) * length * (t - 0.5), y + math.sin(a) * length * (t - 0.5)))
    # draw with wrap-around copies so fibres cross the tile edges cleanly
    for ox in (-SIZE, 0, SIZE):
        for oy in (-SIZE, 0, SIZE):
            d.line([(px + ox, py + oy) for px, py in pts], fill=tone, width=1)
fib = fib.filter(ImageFilter.GaussianBlur(0.6))
dark += (128 - np.asarray(fib, dtype=np.float64)) * 0.42

# A few tiny inclusions (specks of pulp)
for _ in range(60):
    cx, cy = rng.integers(0, SIZE, 2)
    r = rng.uniform(0.6, 1.6)
    yy, xx = np.ogrid[:SIZE, :SIZE]
    dx = np.minimum(np.abs(xx - cx), SIZE - np.abs(xx - cx))
    dy = np.minimum(np.abs(yy - cy), SIZE - np.abs(yy - cy))
    dark += 14 * np.exp(-(dx ** 2 + dy ** 2) / (2 * r * r)) * rng.uniform(0.3, 1)

# Map to near-white: mean ~245, never fully white so lighter fibres still read
img = np.clip(246 - dark, 212, 255).astype(np.uint8)

out = os.path.join(os.path.dirname(__file__), '..', 'assets', 'paper')
os.makedirs(out, exist_ok=True)
Image.fromarray(img, 'L').save(os.path.join(out, 'paper.jpg'), quality=86, optimize=True)
print('wrote', os.path.normpath(os.path.join(out, 'paper.jpg')), img.mean().round(1), img.min(), img.max())
