#!/usr/bin/env python3
"""
Generate the extension icons (16/48/128 px).

Design: a rounded blue tile with a white bookmark ribbon and a small
check mark, hinting at "shared / synced bookmarks". Matches Material 3
"Google Blue" used in the popup (#0b57d0).
"""

from PIL import Image, ImageDraw, ImageFilter
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT_DIR, exist_ok=True)

PRIMARY    = (11, 87, 208, 255)    # M3 Google Blue
PRIMARY_HI = (74, 134, 232, 255)   # lighter top for subtle gradient
RIBBON     = (255, 255, 255, 255)
CHECK      = (11, 87, 208, 255)


def rounded_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size, top, bottom):
    img = Image.new("RGBA", (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def create_icon(size):
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rounded-square background with a soft top->bottom gradient.
    radius = max(2, int(s * 0.22))
    bg = vertical_gradient(s, PRIMARY_HI, PRIMARY)
    bg.putalpha(rounded_rect_mask(s, radius))
    img.alpha_composite(bg)

    d = ImageDraw.Draw(img)

    # White bookmark ribbon (centered, with a V notch at the bottom).
    bm_w = int(s * 0.46)
    bm_h = int(s * 0.62)
    bm_x = (s - bm_w) // 2
    bm_y = int(s * 0.16)
    notch = max(2, int(s * 0.10))

    ribbon = [
        (bm_x,             bm_y),
        (bm_x + bm_w,      bm_y),
        (bm_x + bm_w,      bm_y + bm_h),
        (bm_x + bm_w // 2, bm_y + bm_h - notch),
        (bm_x,             bm_y + bm_h),
    ]

    # Soft drop shadow under the ribbon (skipped at very small sizes).
    if s >= 32:
        shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        offset = max(1, s // 64)
        sd.polygon([(x + offset, y + offset) for (x, y) in ribbon],
                   fill=(0, 0, 0, 70))
        shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(1, s // 48)))
        img.alpha_composite(shadow)

    d.polygon(ribbon, fill=RIBBON)

    # Check mark inside the ribbon — the "synced" hint.
    if s >= 24:
        cw = max(2, int(s * 0.05))
        cx0 = bm_x + int(bm_w * 0.22)
        cy0 = bm_y + int(bm_h * 0.40)
        cx1 = bm_x + int(bm_w * 0.42)
        cy1 = bm_y + int(bm_h * 0.58)
        cx2 = bm_x + int(bm_w * 0.80)
        cy2 = bm_y + int(bm_h * 0.22)
        d.line([(cx0, cy0), (cx1, cy1)], fill=CHECK, width=cw)
        d.line([(cx1, cy1), (cx2, cy2)], fill=CHECK, width=cw)
    else:
        # At 16px a check is illegible — use a single horizontal accent.
        ay = bm_y + bm_h // 2 - 1
        d.line([(bm_x + 2, ay), (bm_x + bm_w - 3, ay)], fill=CHECK, width=2)

    return img


SIZES = {"icon16.png": 16, "icon48.png": 48, "icon128.png": 128}

for filename, size in SIZES.items():
    icon = create_icon(size)
    path = os.path.join(OUT_DIR, filename)
    icon.save(path)
    print(f"\u2713 Created {filename} ({size}x{size})")

print("\nAll icons created successfully!")

