#!/usr/bin/env python3
"""Generate CLOBI CRAFT PWA / TWA app icons.

Draws an isometric voxel "grass block" in the game's own fake-iso palette
(top light, sides progressively darker) on the brand background (#0d0f1a,
the theme-color already used in index.html), plus a chunky pixel border so
the mark reads at small sizes. Produces every size a PWA + iOS + Android TWA
needs, including maskable variants (extra safe-zone padding so Android's
circular/rounded mask never clips the block).

Pure stdlib + Pillow. Run:  python web/tools/gen-icons.py
Output: web/icons/*.png  and  web/favicon.ico

Deterministic (no randomness) so re-runs are byte-reproducible.
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "icons"))
WEB = os.path.normpath(os.path.join(HERE, ".."))
os.makedirs(OUT, exist_ok=True)

BG = (13, 15, 26)            # #0d0f1a  brand background / theme-color
# grass-block palette (matches hud.js FALLBACK_COLORS grass/dirt family)
TOP = (92, 174, 50)         # grass top  #5cae32
TOP_LIT = (120, 205, 70)    # top highlight
LEFT = (120, 86, 46)        # dirt left face (lit)  ~#785c2e
RIGHT = (92, 66, 34)        # dirt right face (shadow)
GRASS_LIP = (60, 120, 34)   # dark grass edge where top meets sides
OUTLINE = (8, 10, 18)       # near-black voxel outline


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw_block(size, pad_frac):
    """Render one icon at `size`px. pad_frac is extra inset for maskable
    safe-zone (0 for normal, ~0.14 for maskable)."""
    # supersample x4 for crisp antialiased diamond edges, then downscale
    ss = 4
    S = size * ss
    img = Image.new("RGBA", (S, S), BG + (255,))
    d = ImageDraw.Draw(img)

    # The block occupies a centered square region after padding.
    inset = pad_frac * S
    # leave a little breathing room even for non-maskable
    inset += 0.10 * S
    x0, y0 = inset, inset
    w = S - 2 * inset
    cx = x0 + w / 2

    # isometric cube geometry inside the [x0,x0+w] box.
    # top face is a diamond; front-left and front-right are parallelograms.
    # Taller side faces + a shallower top diamond read as a solid CUBE rather
    # than a flat pad; the whole thing is vertically centered in the box.
    top_h = w * 0.24          # vertical half-extent of the top diamond
    side_h = w * 0.40         # height of the vertical side faces
    cube_h = 2 * top_h + side_h
    ty = y0 + (w - cube_h) / 2        # top of the diamond, vertically centered
    my = ty + top_h           # middle (widest) line
    by = my + side_h          # bottom of the cube

    left = x0 + w * 0.02
    right = x0 + w - w * 0.02

    # ---- top face (grass) : diamond ----
    top = [(cx, ty), (right, my), (cx, my + top_h), (left, my)]
    d.polygon(top, fill=TOP)
    # top highlight (upper half of the diamond)
    d.polygon([(cx, ty), (right, my), (cx, my)], fill=TOP_LIT)
    d.polygon([(cx, ty), (left, my), (cx, my)], fill=lerp(TOP, TOP_LIT, 0.5))

    # ---- left face (dirt, lit) ----
    left_face = [(left, my), (cx, my + top_h), (cx, by), (left, by - top_h)]
    d.polygon(left_face, fill=LEFT)
    # grass lip band along the top of the left face (the green rind of a
    # grass block over its dirt body) — a distinct GRASS-colored strip.
    lip_h = w * 0.13
    d.polygon([(left, my), (cx, my + top_h),
               (cx, my + top_h + lip_h), (left, my + lip_h)],
              fill=lerp(TOP, LEFT, 0.15))

    # ---- right face (dirt, shadow) ----
    right_face = [(cx, my + top_h), (right, my), (right, by - top_h), (cx, by)]
    d.polygon(right_face, fill=RIGHT)
    d.polygon([(cx, my + top_h), (right, my),
               (right, my + lip_h), (cx, my + top_h + lip_h)],
              fill=lerp(TOP, RIGHT, 0.30))

    # ---- chunky outline around the whole cube silhouette ----
    ow = max(2, int(S * 0.012))
    silhouette = [(cx, ty), (right, my), (right, by - top_h),
                  (cx, by), (left, by - top_h), (left, my)]
    d.line(silhouette + [silhouette[0]], fill=OUTLINE, width=ow, joint="curve")
    # inner seams
    d.line([(left, my), (cx, my + top_h), (right, my)], fill=OUTLINE, width=ow, joint="curve")
    d.line([(cx, my + top_h), (cx, by)], fill=OUTLINE, width=ow, joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    p = os.path.join(OUT, name)
    img.save(p, "PNG")
    print("wrote", os.path.relpath(p, WEB), img.size)


# Standard (transparent-free, full-bleed brand bg) icons
for s in (48, 72, 96, 128, 144, 152, 167, 180, 192, 256, 384, 512):
    save(draw_block(s, 0.0), f"icon-{s}.png")

# Maskable icons (extra safe zone so Android masks don't clip the block)
for s in (192, 512):
    save(draw_block(s, 0.14), f"maskable-{s}.png")

# Apple touch icon (iOS home screen) — 180, no transparency, has bg already
save(draw_block(180, 0.0), "apple-touch-icon.png")

# Favicon .ico (multi-size)
fav = draw_block(64, 0.0)
ico_path = os.path.join(WEB, "favicon.ico")
fav.save(ico_path, sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
print("wrote", os.path.relpath(ico_path, WEB))

print("done.")
