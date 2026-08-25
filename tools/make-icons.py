#!/usr/bin/env python3
"""Generate the DAM BREAK icon set.

    python3 tools/make-icons.py

Writes icons/icon-192.png, icon-512.png, icon-180.png and
icon-maskable-512.png. Requires Pillow (stdlib otherwise); no network, no
fonts, no external assets — the whole motif is polygons.

THE MOTIF (v2, by user request): a FLOOD WAVE breaking over a SMALL TIMBER
DAM. Read left to right it is the moment before impact — a tall curling wall
of water with a foam claw, hanging over a little warm lattice of beams that
is obviously not going to win. David and Goliath, except you built David.

WHAT MAKES IT LEGIBLE AT 24 px: three masses with hard value/hue breaks —
  1. the WAVE: one big cool mass, dark at the base, with the brightest thing
     in the frame (near-white foam) tracing its crest and curl tip;
  2. the TIMBER DAM: a small warm orange grid — hue carries it against the
     blues long after its inner detail collapses;
  3. the GROUND: a dark strip that gives both something to stand on.
Spray droplets, the barrel shadow inside the curl, and the beam outlines are
512-px enrichment that is allowed to vanish at small sizes.

Rendered 4x and downsampled with LANCZOS. Palette is the game's own
(src/config.js CONFIG.render + materials.js).
"""

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

# ---- palette (must match the game) --------------------------------------
BG_TOP = (8, 19, 29)          # CONFIG.render.skyTop
BG_BOT = (24, 50, 70)         # between skyMid and skyLow
GROUND = (44, 55, 41)         # terrainFill
GROUND_DK = (22, 29, 22)      # terrainDeep
GROUND_EDGE = (109, 143, 78)  # terrainEdge

WAVE_LO = (7, 39, 71)         # wave body at the base — near-black blue
WAVE_MID = (28, 111, 180)     # waterMid
WAVE_HI = (73, 168, 224)      # waterShallow — the lit front face
BARREL = (14, 40, 66)         # shadow inside the curl
FOAM = (230, 245, 255)        # aerated crest — the brightest value in frame
SPRAY = (200, 232, 252)

TIMBER = (200, 149, 74)       # materials.js timber
TIMBER_DK = (110, 74, 24)     # beam outline — darker than in-game for punch

SS = 4  # supersample factor


def vgrad(img, box, top, bot):
    """Vertical gradient fill inside box (x0, y0, x1, y1)."""
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = box
    h = max(1, y1 - y0)
    for y in range(y0, y1):
        t = (y - y0) / h
        c = tuple(int(a + (b - a) * t) for a, b in zip(top, bot))
        d.line([(x0, y), (x1, y)], fill=c)


def qbez(p0, p1, p2, n=24):
    """Sample a quadratic bezier as n points (inclusive of ends)."""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def draw_motif(img, S, sq=1.0):
    """Draw the motif onto img (size S). sq < 1 shrinks toward centre
    (used for the maskable safe zone)."""
    d = ImageDraw.Draw(img)
    cx = cy = S / 2

    def P(u, v):
        return (cx + (u - 0.5) * S * sq, cy + (v - 0.5) * S * sq)

    def poly(pts, fill):
        d.polygon([P(u, v) for (u, v) in pts], fill=fill)

    def circ(u, v, r, fill):
        x, y = P(u, v)
        rr = r * S * sq
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=fill)

    def beam(u0, v0, u1, v1, w):
        """A timber beam: dark outline under a warm core."""
        a, b = P(u0, v0), P(u1, v1)
        d.line([a, b], fill=TIMBER_DK, width=int(w * S * sq * 1.45))
        d.line([a, b], fill=TIMBER, width=int(w * S * sq))

    # ---- ground: a dark shelf, sloping slightly down to the right --------
    g_l, g_r = 0.80, 0.86     # ground surface v at left / right edge
    poly([(0, g_l), (1, g_r), (1, 1), (0, 1)], GROUND)
    poly([(0, g_l + 0.10), (1, g_r + 0.10), (1, 1), (0, 1)], GROUND_DK)
    d.line([P(0, g_l), P(1, g_r)], fill=GROUND_EDGE, width=max(2, int(0.012 * S * sq)))

    # ---- the wave silhouette ---------------------------------------------
    # Back rises from the left edge, crest hooks forward over the dam, the
    # curl tip hangs at (0.66, 0.30), and the front face falls concave to the
    # ground just short of the dam.
    sil = []
    sil += qbez((0.0, 0.62), (0.10, 0.50), (0.16, 0.36))      # back slope up
    sil += qbez((0.16, 0.36), (0.26, 0.10), (0.46, 0.09))     # to the peak
    sil += qbez((0.46, 0.09), (0.64, 0.09), (0.71, 0.24))     # hook forward
    sil += qbez((0.71, 0.24), (0.73, 0.34), (0.62, 0.37))     # curl tip turns under
    sil += qbez((0.62, 0.37), (0.49, 0.41), (0.50, 0.52))     # barrel hollow
    sil += qbez((0.50, 0.52), (0.56, 0.66), (0.62, 0.815))    # front face to ground
    sil += [(0.0, 0.81), (0.0, 0.62)]
    # body: paint in three value bands, clipped by redrawing the silhouette
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).polygon([P(u, v) for (u, v) in sil], fill=255)
    body = Image.new("RGB", img.size, WAVE_LO)
    vgrad(body, (0, int(0.05 * S), int(S), int(0.85 * S)), WAVE_HI, WAVE_LO)
    img.paste(body, (0, 0), mask)

    # barrel shadow inside the curl (gives the hook its roll)
    circ(0.52, 0.33, 0.115, BARREL)

    # ---- foam: crest ribbon + curl claw -----------------------------------
    crest = qbez((0.18, 0.34), (0.28, 0.08), (0.46, 0.075)) + \
            qbez((0.46, 0.075), (0.65, 0.075), (0.715, 0.25)) + \
            qbez((0.715, 0.25), (0.735, 0.35), (0.605, 0.385))
    w_foam = max(3, int(0.045 * S * sq))
    d.line([P(u, v) for (u, v) in crest], fill=FOAM, width=w_foam, joint="curve")
    # claw blobs at the tip, stepping toward the dam
    circ(0.605, 0.385, 0.032, FOAM)
    circ(0.665, 0.43, 0.026, FOAM)
    circ(0.715, 0.48, 0.021, FOAM)
    # spray above the crest
    circ(0.55, 0.045, 0.017, SPRAY)
    circ(0.66, 0.10, 0.014, SPRAY)
    circ(0.72, 0.19, 0.012, SPRAY)
    # foam wash at the wave's foot
    circ(0.60, 0.79, 0.030, FOAM)
    circ(0.655, 0.805, 0.024, FOAM)

    # ---- the small timber dam ---------------------------------------------
    # Two bays, two rows, one brace — deliberately tiny under the curl.
    x0, x1, x2 = 0.72, 0.815, 0.91          # column u positions
    top, bot = 0.545, 0.86                 # crest v .. ground v
    mid = (top + bot) / 2
    w = 0.034
    beam(x0, bot, x0, top, w)               # columns
    beam(x1, bot + 0.005, x1, top, w)
    beam(x2, bot + 0.012, x2, top, w)
    beam(x0, mid, x2, mid + 0.008, w * 0.9) # mid rung
    beam(x0, top, x2, top, w * 0.9)         # crest rung
    beam(x0, bot, x1, mid, w * 0.8)         # braces
    beam(x1, mid, x2, top, w * 0.8)


def render(size, sq=1.0):
    S = size * SS
    img = Image.new("RGB", (S, S))
    vgrad(img, (0, 0, S, S), BG_TOP, BG_BOT)
    draw_motif(img, S, sq)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size, name in ((512, "icon-512.png"), (192, "icon-192.png"), (180, "icon-180.png")):
        render(size).save(os.path.join(OUT, name))
        print("wrote", name)
    # maskable: same motif shrunk into the 80% safe zone
    render(512, sq=0.78).save(os.path.join(OUT, "icon-maskable-512.png"))
    print("wrote icon-maskable-512.png")


if __name__ == "__main__":
    main()
