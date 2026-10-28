"""Renders the extension icons (a green calendar with a check mark) as PNGs using only the stdlib.

Usage: python3 tools/make_icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor per axis

GREEN = (46, 125, 50)
DARK = (27, 94, 32)
WHITE = (255, 255, 255)


def rounded_rect(x, y, x0, y0, x1, y1, r):
    """True if (x, y) is inside the rounded rectangle (coordinates on a 0..1 canvas)."""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def near_segment(x, y, ax, ay, bx, by, w):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    px, py = ax + t * dx, ay + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= (w / 2) ** 2


def color_at(x, y):
    """Color (RGB) at a point on the 0..1 canvas, or None for transparent. Later layers win."""
    c = None
    if rounded_rect(x, y, 0.06, 0.14, 0.94, 0.94, 0.14):
        c = GREEN
        if y < 0.36:
            c = DARK
    for rx in (0.28, 0.72):
        if rounded_rect(x, y, rx - 0.05, 0.04, rx + 0.05, 0.26, 0.05):
            c = DARK
    if near_segment(x, y, 0.30, 0.62, 0.45, 0.77, 0.12) or near_segment(x, y, 0.45, 0.77, 0.72, 0.48, 0.12):
        c = WHITE
    return c


def render(size):
    n = size * SS
    rows = []
    for py in range(size):
        row = bytearray([0])  # filter type: none
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    c = color_at((px * SS + sx + 0.5) / n, (py * SS + sy + 0.5) / n)
                    if c:
                        r += c[0]
                        g += c[1]
                        b += c[2]
                        a += 1
            if a:
                row += bytes((r // a, g // a, b // a, round(255 * a / (SS * SS))))
            else:
                row += bytes(4)
        rows.append(bytes(row))
    return png(size, size, b''.join(rows))


def png(w, h, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        with open(os.path.join(OUT, f'icon{s}.png'), 'wb') as f:
            f.write(render(s))
    print('wrote', ', '.join(f'icon{s}.png' for s in SIZES))
