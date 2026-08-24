#!/usr/bin/env python3
"""Generate the DAM BREAK icon set.

    python3 tools/make-icons.py

Writes icons/icon-192.png, icon-512.png, icon-180.png and
icon-maskable-512.png. Requires Pillow (stdlib otherwise); no network, no
fonts, no external assets — the whole motif is polygons.

THE MOTIF: a dam wall with a breach and a burst of water tearing through it.
Read left to right it is the game's entire premise in one frame — impounded
water, a timber-tied concrete face, and the moment that face fails.

WHAT MAKES IT LEGIBLE AT 32 px (the constraint that decided every shape here):
an icon is three masses or it is mud. So the composition is exactly three —
a dark blue BLOCK on the left, a pale vertical WALL in the middle, a bright
WEDGE blasting out to the right — with a hard value break between each pair.
Everything else (the timber ties, the waterline, the spray, the strata) is
detail that enriches 512 px and is allowed to disappear at 32 without changing
what the icon is. That is why the burst is drawn in near-white against the
mid-blue reservoir rather than in the same blue: at small sizes hue collapses
long before value does, and the breach has to stay the brightest thing in the
frame.

Rendered 4x and downsampled with LANCZOS, which is cheaper and sharper here
than any per-edge antialiasing: the shapes are large and flat, so all the
quality is in the edges.

Palette is the game's own (src/config.js CONFIG.render + materials.js).
"""

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

# ---- palette (must match the game) --------------------------------------
BG_TOP = (8, 19, 29)          # CONFIG.render.skyTop
BG_BOT = (20, 44, 62)         # between skyMid and skyLow
GROUND = (44, 55, 41)         # terrainFill
GROUND_DK = (22, 29, 22)      # terrainDeep
GROUND_EDGE = (109, 143, 78)  # terrainEdge

RES_HI = (44, 112, 162)       # impounded water at the surface — DEEP, not bright
RES_LO = (7, 39, 71)          # ... and near-black at depth
WATER_LINE = (165, 226, 255)  # waterSurfaceColor
JET = (53, 167, 255)          # accent — the escaping water, vivid on purpose
FOAM = (226, 244, 255)        # near-white aerated crest + spray
HOLE = (9, 20, 31)            # darker than the sky: a hole, not a stripe

CONCRETE = (150, 163, 175)    # mid grey: the stage, not the light
CONCRETE_MID = (128, 141, 153)  # buttress shading: one step, not a silhouette
CONCRETE_DK = (96, 108, 119)
CONCRETE_HI = (196, 207, 216)
TIMBER = (200, 149, 74)       # materials.js timber
TIMBER_DK = (138, 96, 35)

SS = 4  # supersample factor


# ---- helpers ------------------------------------------------------------

def vgrad(img, box, top, bot):
    """Vertical gradient inside box=(x0,y0,x1,y1), one row at a time."""
    x0, y0, x1, y1 = box
    h = max(1, y1 - y0)
    d = ImageDraw.Draw(img)
    for i in range(h):
        t = i / h
        c = tuple(int(top[k] + (bot[k] - top[k]) * t) for k in range(3))
        d.line([(x0, y0 + i), (x1, y0 + i)], fill=c)


def draw_motif(img, S, sq=1.0):
    """Draw the whole motif over the whole SxS image in unit coordinates.

    Unit space: x right 0..1, y DOWN 0..1 (image convention, not the game's
    y-up world — this is a picture, not a simulation).

    `sq` squashes the composition vertically toward the centre, for the maskable
    variant. It is a SQUASH and not an inset because every band in here bleeds
    off both sides of the frame on purpose: shrinking the motif into a smaller
    box instead just draws the bleed's cut ends, which is a hard-edged rectangle
    floating in the middle of the icon — exactly what the first maskable build
    produced. Squashing keeps the bands full width and pulls the parts that
    matter inside Android's safe circle.
    """
    bx, by = 0, 0
    d = ImageDraw.Draw(img)

    def V(v):
        return 0.5 + (v - 0.5) * sq

    def P(u, v):
        return (bx + u * S, by + V(v) * S)

    def poly(pts, fill):
        d.polygon([P(u, v) for u, v in pts], fill=fill)

    def circ(u, v, r, fill):
        cx, cy = P(u, v)
        rr = r * S
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=fill)

    # ---- COMPOSITION ---------------------------------------------------
    # Seen from DOWNSTREAM, which is the only view where a breach can be the
    # centre of the picture. Two earlier side-view attempts failed for the same
    # reason: in profile, a hole in the bottom of the wall deletes the wall's
    # silhouette, so the icon became a small block sitting on a blue rectangle.
    # Head-on, the wall spans the frame as one horizontal mass and the breach is
    # a jagged wedge torn clean through its middle — symmetric, dead centre, and
    # the brightest thing in the frame. Three masses: dark water band on top,
    # pale wall across, bright burst down the middle.
    CREST, BASE = 0.322, 0.858

    # ---- 1. sky --------------------------------------------------------
    vgrad(img, (0, 0, int(S), int(S)), BG_TOP, BG_BOT)

    # ---- 2. the impounded water, seen over the crest -------------------
    # Bright at the surface, dark toward the crest: a band with a value ramp in
    # it reads as water, a band without one reads as a UI element.
    # A generous band, not a stripe: the reservoir is the reason the dam exists,
    # so it gets real area. The sky is reduced to the sliver that keeps the
    # waterline from touching the frame edge.
    vgrad(img, (0, int(V(0.132) * S), int(S), int(V(CREST) * S)), RES_HI, RES_LO)
    poly([(0, 0.132), (1, 0.132), (1, 0.153), (0, 0.153)], WATER_LINE)

    # ---- 3. the apron the flood lands on -------------------------------
    poly([(0, 0.884), (1, 0.884), (1, 1), (0, 1)], GROUND_DK)

    # ---- 4. the wall (mass two) ----------------------------------------
    # Every band of the wall runs off BOTH edges of the frame, and the outer
    # flanks are vertical rather than battered. Both of those are corrections:
    # battered outer flanks plus vertical buttress shading turned the two sides
    # of the breach into a matching pair of barrels, and once the eye sees two
    # objects the dam is gone. Bled, flat-topped bands read instead as one wall
    # that happens to continue past the picture — which is what a dam does.
    poly([(-0.05, CREST), (1.05, CREST), (1.05, BASE), (-0.05, BASE)], CONCRETE)
    # a horizontal value break low on the wall: thickness, without verticals
    poly([(-0.05, 0.700), (1.05, 0.700), (1.05, BASE), (-0.05, BASE)], CONCRETE_MID)
    # crest cap
    poly([(-0.05, CREST), (1.05, CREST), (1.05, CREST + 0.044), (-0.05, CREST + 0.044)],
         CONCRETE_HI)
    # one timber tie across the face — the game's material, and the only warm
    # colour in the frame. The breach tears straight through it.
    poly([(-0.05, 0.508), (1.05, 0.508), (1.05, 0.546), (-0.05, 0.546)], TIMBER)
    poly([(-0.05, 0.546), (1.05, 0.546), (1.05, 0.564), (-0.05, 0.564)], TIMBER_DK)
    # base shadow, so the wall sits on the apron instead of floating
    poly([(-0.05, BASE - 0.026), (1.05, BASE - 0.026), (1.05, BASE), (-0.05, BASE)],
         CONCRETE_DK)

    # ---- 5. the breach (mass three) ------------------------------------
    # Widening upward without exception, because that is how a dam fails: the
    # crest goes first and the notch eats downward and outward. Torn concrete is
    # left as a thin dark rim, then blue, then a near-white core — thin, and in
    # that order, so "broken" is legible without the rim ever competing with the
    # burst for the eye.
    L = [(0.268, CREST), (0.316, 0.420), (0.300, 0.505), (0.344, 0.600),
         (0.330, 0.700), (0.366, 0.800), (0.356, BASE + 0.030)]
    Rt = [(0.732, CREST), (0.684, 0.422), (0.700, 0.507), (0.656, 0.602),
          (0.670, 0.702), (0.634, 0.802), (0.644, BASE + 0.030)]
    inset = lambda pts, dx: [(u + dx, v) for u, v in pts]
    poly(L + Rt[::-1], HOLE)
    poly(inset(L, 0.024) + inset(Rt, -0.024)[::-1], JET)
    poly(inset(L, 0.062) + inset(Rt, -0.062)[::-1], FOAM)

    # ---- 6. what it does when it lands ---------------------------------
    # A WIDE, FLAT sheet running off both edges of the frame, rising only where
    # the fall lands. Accent blue with just a bright crest line: painting the
    # apron white too would have merged it with the falling water into one pale
    # mass across the whole bottom third.
    poly([(-0.05, 0.916), (0.18, 0.894), (0.36, 0.862), (0.50, 0.850),
          (0.64, 0.862), (0.82, 0.894), (1.05, 0.916), (1.05, 1.0), (-0.05, 1.0)], JET)
    poly([(-0.05, 0.916), (0.18, 0.894), (0.36, 0.862), (0.50, 0.850),
          (0.64, 0.862), (0.82, 0.894), (1.05, 0.916), (1.05, 0.940),
          (0.82, 0.918), (0.64, 0.886), (0.50, 0.874), (0.36, 0.886),
          (0.18, 0.918), (-0.05, 0.940)], FOAM)
    # Spray, and only at the impact. An earlier pass scattered it up the wall
    # either side of the notch, where four evenly placed white dots on a flat
    # grey band stop reading as water and start reading as bolt heads.
    for u, v, r in ((0.322, 0.846, 0.026), (0.678, 0.854, 0.022),
                    (0.228, 0.892, 0.017), (0.772, 0.898, 0.015)):
        circ(u, v, r, FOAM)


# ---- rendering ----------------------------------------------------------

def render(size, sq=1.0):
    """One icon, rendered 4x and downsampled."""
    big = size * SS
    img = Image.new("RGB", (big, big), BG_TOP)
    draw_motif(img, big, sq)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("icon-512.png", 512, 1.0),
        ("icon-192.png", 192, 1.0),
        ("icon-180.png", 180, 1.0),
        # Maskable: Android may crop to a circle inscribed in the inner 80%, so
        # the composition is squashed to 74% of its height about the centre. The
        # crest, the timber tie, the breach and the splash then all sit inside
        # the safe circle, while every band still runs edge to edge.
        ("icon-maskable-512.png", 512, 0.74),
    ]
    for name, size, sq in jobs:
        path = os.path.join(OUT, name)
        render(size, sq).save(path, optimize=True)
        print("wrote", os.path.relpath(path, ROOT), f"{size}x{size}")


if __name__ == "__main__":
    main()
