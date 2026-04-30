#!/usr/bin/env python3
"""Generate LinguaStart app icons + Play Store assets."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
STORE = os.path.join(ROOT, 'store')
os.makedirs(STORE, exist_ok=True)

# Brand colors
BG = (8, 18, 8)        # near-black green-tinted
G = (0, 255, 65)       # bright green glow
G2 = (0, 200, 50)
DARK = (3, 10, 3)


def load_font(size):
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def make_icon(size: int, foreground_only: bool = False) -> Image.Image:
    """Square icon: glowing globe + 'L' monogram."""
    pad = 0 if foreground_only else 0
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if not foreground_only:
        # rounded rect background
        r = int(size * 0.22)
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=BG + (255,))
        # subtle inner glow
        glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.rounded_rectangle((int(size * 0.05), int(size * 0.05), int(size * 0.95), int(size * 0.95)),
                             radius=int(r * 0.85), outline=G + (90,), width=max(2, size // 64))
        glow = glow.filter(ImageFilter.GaussianBlur(size * 0.04))
        img = Image.alpha_composite(img, glow)
        d = ImageDraw.Draw(img)

    # central 'L' monogram with arabic-influenced extension
    cx, cy = size // 2, size // 2
    stroke = max(4, size // 14)

    # Big "L" shape: vertical bar + horizontal bottom
    L_w = int(size * 0.42)
    L_h = int(size * 0.52)
    x0 = cx - L_w // 2
    y0 = cy - L_h // 2
    # shadow / outer glow for L
    glow_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow_layer)
    gd.rounded_rectangle((x0, y0, x0 + stroke, y0 + L_h), radius=stroke // 2, fill=G + (255,))
    gd.rounded_rectangle((x0, y0 + L_h - stroke, x0 + L_w, y0 + L_h), radius=stroke // 2, fill=G + (255,))
    # Arabic accent: a small dot above
    dot_r = int(size * 0.05)
    gd.ellipse((cx + L_w // 4 - dot_r, y0 - dot_r * 2, cx + L_w // 4 + dot_r, y0), fill=G + (255,))
    blurred = glow_layer.filter(ImageFilter.GaussianBlur(size * 0.025))
    img = Image.alpha_composite(img, blurred)

    # crisp foreground
    fg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fg)
    fd.rounded_rectangle((x0, y0, x0 + stroke, y0 + L_h), radius=stroke // 2, fill=G + (255,))
    fd.rounded_rectangle((x0, y0 + L_h - stroke, x0 + L_w, y0 + L_h), radius=stroke // 2, fill=G + (255,))
    fd.ellipse((cx + L_w // 4 - dot_r, y0 - dot_r * 2, cx + L_w // 4 + dot_r, y0), fill=G + (255,))
    img = Image.alpha_composite(img, fg)

    return img


def make_round_icon(size: int) -> Image.Image:
    base = make_icon(size)
    mask = Image.new('L', (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


# Sizes per density
DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}


def main():
    for d, s in DENSITIES.items():
        folder = os.path.join(RES, f'mipmap-{d}')
        os.makedirs(folder, exist_ok=True)
        make_icon(s).save(os.path.join(folder, 'ic_launcher.png'))
        make_round_icon(s).save(os.path.join(folder, 'ic_launcher_round.png'))
        # foreground for adaptive
        fg = make_icon(int(s * 1.5), foreground_only=True)
        fg.save(os.path.join(folder, 'ic_launcher_foreground.png'))
        print(f"{d}: {s}px")

    # Play Store: 512x512 high-res icon
    make_icon(512).save(os.path.join(STORE, 'icon-512.png'))
    print("store/icon-512.png")

    # Feature graphic 1024x500
    fg = Image.new('RGBA', (1024, 500), BG + (255,))
    fd = ImageDraw.Draw(fg)
    # gradient-ish background
    for y in range(500):
        a = int(40 * (1 - y / 500))
        fd.line([(0, y), (1024, y)], fill=(0, 80, 20, a))
    icon = make_icon(280)
    fg.paste(icon, (60, 110), icon)
    f_title = load_font(72)
    f_sub = load_font(28)
    fd.text((400, 160), 'LinguaStart', font=f_title, fill=(220, 255, 220))
    fd.text((400, 250), 'Английский · Арабский · С нуля', font=f_sub, fill=(120, 200, 130))
    fd.text((400, 290), 'Уроки · Аудио · AI · Серии', font=f_sub, fill=(120, 200, 130))
    # accent corner
    fd.rectangle((1010, 0, 1024, 500), fill=G)
    fg.save(os.path.join(STORE, 'feature-graphic-1024x500.png'))
    print("store/feature-graphic-1024x500.png")


if __name__ == '__main__':
    main()
