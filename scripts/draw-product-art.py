"""Flat illustrations of the sample products, drawn from shapes (no outside images)."""
import math, random, sys
from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1]
S = 2  # supersampling
W, H = 800 * S, 600 * S
BG = (249, 245, 236)
BOARD = (205, 160, 112)
BOARD_D = (178, 132, 88)
PORK = (236, 150, 140)
PORK_D = (214, 112, 106)
FAT = (252, 240, 228)
SKIN = (240, 196, 160)
BEEF = (160, 40, 44)
BEEF_D = (118, 26, 32)
BONE = (246, 238, 220)
BONE_D = (214, 200, 176)
CHICK = (246, 214, 170)
CHICK_D = (226, 176, 120)
ROAST = (206, 124, 58)
ROAST_D = (164, 88, 36)
SALMON = (247, 135, 84)
SALMON_D = (226, 104, 60)
LIVER = (112, 30, 36)
LIVER_L = (150, 50, 54)
NAVY = (9, 29, 45)


def p(*xy):
    return [v * S for v in xy]


def canvas():
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # Soft shadow and a round wooden board.
    sh = Image.new("L", (W, H), 0)
    ImageDraw.Draw(sh).ellipse(p(110, 150, 690, 560), fill=90)
    sh = sh.filter(ImageFilter.GaussianBlur(30 * S))
    im.paste((120, 100, 80), mask=sh)
    d.ellipse(p(100, 110, 700, 530), fill=BOARD_D)
    d.ellipse(p(100, 100, 700, 515), fill=BOARD)
    # Wood grain, kept inside the board.
    grain = Image.new("RGB", (W, H), BOARD)
    g = ImageDraw.Draw(grain)
    for i in range(7):
        y = 150 + i * 55
        g.arc(p(60, y - 30, 740, y + 30), 195, 345, fill=BOARD_D, width=3 * S)
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).ellipse(p(112, 112, 688, 503), fill=255)
    im.paste(grain, mask=mask)
    return im, d


def done(im, name):
    im = im.resize((800, 600), Image.LANCZOS)
    im.save(f"{OUT}/{name}.jpg", quality=84, optimize=True, progressive=True)


def poly(d, pts, fill, outline=None, w=0):
    d.polygon([v * S for xy in pts for v in xy], fill=fill, outline=outline, width=w * S)


def blob(cx, cy, rx, ry, n=40, jitter=0.0, seed=1):
    r = random.Random(seed)
    return [
        (cx + rx * math.cos(t) * (1 + r.uniform(-jitter, jitter)), cy + ry * math.sin(t) * (1 + r.uniform(-jitter, jitter)))
        for t in [2 * math.pi * i / n for i in range(n)]
    ]


def belly():
    im, d = canvas()
    for k, (x, y) in enumerate([(210, 200), (300, 270)]):
        # A slab seen from the side: skin, then fat and meat layers.
        layers = [SKIN, FAT, PORK, FAT, PORK_D, FAT, PORK]
        h = [14, 18, 30, 12, 30, 10, 34]
        yy = y
        for c, t in zip(layers, h):
            d.rounded_rectangle(p(x, yy, x + 300, yy + t + 8), radius=10 * S, fill=c)
            yy += t
        d.rounded_rectangle(p(x, y, x + 300, yy + 8), radius=14 * S, outline=PORK_D, width=3 * S)
    done(im, "pork-belly")


def chop():
    im, d = canvas()
    for i, (cx, cy) in enumerate([(320, 300), (480, 330)]):
        poly(d, blob(cx, cy, 140, 95, jitter=0.03, seed=i), FAT)
        poly(d, blob(cx + 10, cy + 5, 115, 75, jitter=0.04, seed=i + 5), PORK)
        poly(d, blob(cx + 30, cy + 15, 60, 40, jitter=0.05, seed=i + 9), PORK_D)
        # T-bone
        d.rounded_rectangle(p(cx - 100, cy - 12, cx - 20, cy + 6), radius=8 * S, fill=BONE)
        d.ellipse(p(cx - 118, cy - 26, cx - 84, cy + 20), fill=BONE)
    done(im, "pork-chop")


def roast(meat, dark, name, marble=FAT, seed=3):
    im, d = canvas()
    poly(d, blob(400, 310, 220, 130, jitter=0.05, seed=seed), dark)
    poly(d, blob(395, 300, 205, 118, jitter=0.05, seed=seed + 1), meat)
    r = random.Random(seed)
    for _ in range(9):
        x, y = r.uniform(250, 540), r.uniform(220, 380)
        d.arc(p(x - 60, y - 20, x + 60, y + 20), r.uniform(180, 220), r.uniform(320, 360), fill=marble, width=5 * S)
    done(im, name)


def ham():
    im, d = canvas()
    poly(d, blob(360, 320, 210, 150, jitter=0.03, seed=11), SKIN)
    poly(d, blob(350, 315, 180, 125, jitter=0.03, seed=12), PORK)
    poly(d, [(520, 260), (650, 230), (660, 280), (540, 360)], SKIN)
    d.rounded_rectangle(p(630, 225, 690, 255), radius=14 * S, fill=BONE)
    d.ellipse(p(675, 215, 705, 248), fill=BONE)
    d.ellipse(p(675, 236, 705, 268), fill=BONE)
    for i in range(4):
        d.arc(p(230 + i * 40, 230, 430 + i * 40, 410), 200, 300, fill=FAT, width=5 * S)
    done(im, "pork-ham")


def ribs():
    im, d = canvas()
    d.rounded_rectangle(p(190, 230, 610, 400), radius=50 * S, fill=PORK_D)
    d.rounded_rectangle(p(195, 225, 605, 390), radius=46 * S, fill=PORK)
    for i in range(7):
        x = 225 + i * 55
        d.rounded_rectangle(p(x, 190, x + 22, 430), radius=11 * S, fill=BONE, outline=BONE_D, width=2 * S)
    d.rounded_rectangle(p(195, 285, 605, 330), radius=20 * S, fill=PORK)
    done(im, "pork-ribs")


def cubes(meat, dark, top, name, seed=5):
    im, d = canvas()
    r = random.Random(seed)
    spots = [(260, 260), (380, 230), (500, 270), (300, 360), (430, 350), (550, 370), (370, 440)]
    for x, y in spots:
        s = r.uniform(48, 60)
        poly(d, [(x, y), (x + s, y - s * 0.4), (x + 2 * s, y), (x + s, y + s * 0.4)], top)
        poly(d, [(x, y), (x + s, y + s * 0.4), (x + s, y + s * 1.3), (x, y + s * 0.9)], meat)
        poly(d, [(x + s, y + s * 0.4), (x + 2 * s, y), (x + 2 * s, y + s * 0.9), (x + s, y + s * 1.3)], dark)
    done(im, name)


def ground():
    im, d = canvas()
    poly(d, blob(400, 320, 210, 130, jitter=0.08, seed=21), PORK_D)
    r = random.Random(4)
    for _ in range(900):
        a, rr = r.uniform(0, 2 * math.pi), math.sqrt(r.random())
        x, y = 400 + 195 * rr * math.cos(a), 315 + 118 * rr * math.sin(a)
        c = r.choice([PORK, PORK, FAT, PORK_D])
        s = r.uniform(5, 10)
        d.ellipse(p(x - s, y - s, x + s, y + s), fill=c)
    done(im, "ground-pork")


def bone(d, x1, y1, x2, y2, w=26):
    d.line(p(x1, y1, x2, y2), fill=BONE, width=w * S)
    ang = math.atan2(y2 - y1, x2 - x1) + math.pi / 2
    for x, y in [(x1, y1), (x2, y2)]:
        for sgn in (-1, 1):
            cx, cy = x + sgn * 16 * math.cos(ang), y + sgn * 16 * math.sin(ang)
            d.ellipse(p(cx - 22, cy - 22, cx + 22, cy + 22), fill=BONE, outline=BONE_D, width=2 * S)
    d.line(p(x1, y1, x2, y2), fill=BONE, width=w * S)


def bones():
    im, d = canvas()
    bone(d, 230, 250, 520, 330)
    bone(d, 280, 410, 560, 230)
    for cx, cy in [(300, 330), (480, 400), (560, 300)]:
        poly(d, blob(cx, cy, 40, 26, jitter=0.1, seed=cx), PORK)
    done(im, "pork-bones")


def hock():
    im, d = canvas()
    for i, (cx, cy) in enumerate([(310, 300), (490, 330)]):
        d.ellipse(p(cx - 110, cy - 100, cx + 110, cy + 100), fill=SKIN)
        d.ellipse(p(cx - 92, cy - 82, cx + 92, cy + 82), fill=FAT)
        d.ellipse(p(cx - 78, cy - 70, cx + 78, cy + 70), fill=PORK)
        d.ellipse(p(cx - 28, cy - 26, cx + 28, cy + 26), fill=BONE, outline=BONE_D, width=3 * S)
        d.ellipse(p(cx - 12, cy - 10, cx + 12, cy + 10), fill=(226, 190, 150))
    done(im, "pork-hock")


def liver():
    im, d = canvas()
    poly(d, blob(330, 300, 160, 110, jitter=0.06, seed=31), LIVER)
    poly(d, blob(480, 340, 140, 95, jitter=0.06, seed=32), LIVER)
    for cx, cy in [(300, 270), (470, 310)]:
        d.arc(p(cx - 80, cy - 50, cx + 80, cy + 50), 200, 300, fill=LIVER_L, width=10 * S)
    done(im, "pork-liver")


def shank():
    im, d = canvas()
    for i, (cx, cy, r) in enumerate([(300, 290, 120), (500, 340, 105)]):
        poly(d, blob(cx, cy, r + 14, r * 0.9 + 14, jitter=0.04, seed=40 + i), FAT)
        poly(d, blob(cx, cy, r, r * 0.9, jitter=0.05, seed=42 + i), BEEF)
        for k in range(4):
            a = k * math.pi / 2 + 0.4
            d.line(p(cx, cy, cx + r * 0.8 * math.cos(a), cy + r * 0.7 * math.sin(a)), fill=BEEF_D, width=5 * S)
        d.ellipse(p(cx - 38, cy - 36, cx + 38, cy + 36), fill=BONE, outline=BONE_D, width=3 * S)
        d.ellipse(p(cx - 22, cy - 20, cx + 22, cy + 20), fill=(214, 160, 110))
    done(im, "beef-shank")


def whole_chicken():
    im, d = canvas()
    # Raw whole chicken: body, two drumsticks, wing tips.
    poly(d, blob(400, 310, 170, 125, jitter=0.03, seed=51), CHICK_D)
    poly(d, blob(395, 300, 158, 112, jitter=0.03, seed=52), CHICK)
    for sgn in (-1, 1):
        cx = 400 + sgn * 120
        poly(d, blob(cx, 395, 55, 70, jitter=0.03, seed=53 + sgn), CHICK)
        d.rounded_rectangle(p(cx - 12 + sgn * 10, 440, cx + 12 + sgn * 10, 485), radius=10 * S, fill=BONE)
    d.arc(p(300, 230, 500, 360), 200, 340, fill=CHICK_D, width=6 * S)
    done(im, "whole-chicken")


def thigh():
    im, d = canvas()
    for i, (cx, cy) in enumerate([(320, 300), (480, 330)]):
        poly(d, blob(cx, cy, 110, 85, jitter=0.07, seed=60 + i), CHICK_D)
        poly(d, blob(cx - 5, cy - 6, 98, 74, jitter=0.07, seed=62 + i), CHICK)
        d.arc(p(cx - 70, cy - 40, cx + 70, cy + 40), 200, 330, fill=(250, 228, 196), width=8 * S)
    done(im, "chicken-thigh")


def salmon_steak():
    im, d = canvas()
    for i, (cx, cy) in enumerate([(310, 300), (490, 330)]):
        poly(d, blob(cx, cy, 120, 100, jitter=0.03, seed=70 + i), (200, 200, 200))
        poly(d, blob(cx, cy, 110, 92, jitter=0.03, seed=72 + i), SALMON)
        for k in range(5):
            d.arc(p(cx - 120 + k * 12, cy - 90, cx + 20 + k * 12, cy + 90), 290, 70, fill=FAT, width=4 * S)
        poly(d, [(cx - 12, cy - 5), (cx + 12, cy - 5), (cx + 4, cy + 95), (cx - 4, cy + 95)], BG)
        d.ellipse(p(cx - 10, cy - 14, cx + 10, cy + 6), fill=BONE)
    done(im, "salmon-steak")


def salmon_belly():
    im, d = canvas()
    for i in range(4):
        y = 210 + i * 62
        poly(d, [(200, y), (590, y - 10), (610, y + 22), (590, y + 50), (200, y + 44)], SALMON_D if i % 2 else SALMON)
        poly(d, [(200, y + 30), (600, y + 24), (595, y + 44), (200, y + 44)], (200, 196, 190))
        for k in range(7):
            x = 230 + k * 52
            d.line(p(x, y + 4, x + 18, y + 28), fill=FAT, width=4 * S)
    done(im, "salmon-belly")


belly()
chop()
roast(PORK, PORK_D, "pork-shoulder", seed=3)
ham()
ribs()
cubes(PORK, PORK_D, FAT, "pork-cubes", seed=5)
ground()
bones()
hock()
liver()
cubes(BEEF, BEEF_D, (190, 70, 70), "beef-cubes", seed=6)
shank()
whole_chicken()
thigh()
salmon_steak()
salmon_belly()
