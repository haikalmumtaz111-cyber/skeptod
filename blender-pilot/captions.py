#!/usr/bin/env python3
"""Overlay the caption cards on rendered frames and encode the final mp4.

  python3 captions.py --frames frames --out out/pilot.mp4          # full encode
  python3 captions.py --frames preview --stills preview_cap         # just write captioned stills
"""
import argparse
import glob
import os
import re
import subprocess

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "fonts", "PlusJakartaSans-SemiBold.ttf")
W, H, FPS, N = 1080, 1920, 30, 450
CAPTIONS = [
    (0.0, 0.9, "kalau kamu"),
    (0.9, 1.9, "kalau kamu ratain tanah"),
    (1.9, 2.5, "kamu"),
    (2.5, 4.4, "kamu udah punya jalan"),
    (4.6, 5.3, "tapi baru"),
    (5.3, 6.3, "dilewatin truk"),
    (6.3, 7.4, "tanahnya ambles"),
    (7.4, 8.0, "soalnya"),
    (8.0, 8.9, "satu sumbu truk"),
    (8.9, 10.2, "nanggung beban 8 ton"),
    (10.2, 10.8, "jadi"),
    (10.8, 11.8, "tanahnya"),
    (11.8, 13.2, "kamu lapis"),
    (13.2, 15.0, "batu pecah"),
]
Y_FRAC = 0.65
SIZE = 76


def caption_for(f):
    for a, b, txt in CAPTIONS:
        if round(a * FPS) <= f < round(b * FPS):
            return txt
    return None


_cache = {}


def card(txt):
    if txt in _cache:
        return _cache[txt]
    font = ImageFont.truetype(FONT, SIZE)
    cx, cy = W // 2, int(round(H * Y_FRAC))
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).text((cx, cy + 5), txt, font=font, fill=255, anchor="mm")
    soft = sh.filter(ImageFilter.GaussianBlur(11)).point(lambda v: int(v * 0.62))
    tight = sh.filter(ImageFilter.GaussianBlur(3)).point(lambda v: int(v * 0.40))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    black = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    layer = Image.composite(black, layer, soft)
    layer = Image.alpha_composite(layer, Image.composite(black, Image.new("RGBA", (W, H), (0, 0, 0, 0)), tight))
    ImageDraw.Draw(layer).text((cx, cy), txt, font=font, fill=(255, 255, 255, 255), anchor="mm")
    bbox = ImageDraw.Draw(layer).textbbox((cx, cy), txt, font=font, anchor="mm")
    assert bbox[0] > 40 and bbox[2] < W - 40, ("caption too wide", txt, bbox)
    _cache[txt] = layer
    return layer


def load(path):
    im = Image.open(path).convert("RGBA")
    if im.size != (W, H):
        im = im.resize((W, H), Image.LANCZOS)
    return im


def compose(path, f):
    im = load(path)
    txt = caption_for(f)
    if txt:
        im = Image.alpha_composite(im, card(txt))
    return im.convert("RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", default="frames")
    ap.add_argument("--out", default="out/pilot.mp4")
    ap.add_argument("--stills", default=None)
    a = ap.parse_args()
    src = os.path.join(HERE, a.frames)
    if a.stills:
        dst = os.path.join(HERE, a.stills)
        os.makedirs(dst, exist_ok=True)
        for p in sorted(glob.glob(os.path.join(src, "f_*.png"))):
            f = int(re.search(r"f_(\d+)", p).group(1))
            compose(p, f).resize((540, 960), Image.LANCZOS).save(os.path.join(dst, "c_%04d.jpg" % f), quality=88)
        return
    missing = [f for f in range(N) if not os.path.exists(os.path.join(src, "f_%04d.png" % f))]
    assert not missing, "missing frames: %s" % missing[:20]
    out = os.path.join(HERE, a.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
           "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
           "-pix_fmt", "yuv420p", "-r", str(FPS), "-frames:v", str(N), "-movflags", "+faststart", out]
    pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in range(N):
        pr.stdin.write(compose(os.path.join(src, "f_%04d.png" % f), f).tobytes())
    pr.stdin.close()
    assert pr.wait() == 0
    print("wrote", out)


if __name__ == "__main__":
    main()
