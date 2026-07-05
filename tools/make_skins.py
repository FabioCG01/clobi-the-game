#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_skins.py — deterministic generator for Clobi's Arena skin assets.

Generates, from nothing but the Python standard library (hand-rolled PNG
writer on struct+zlib — no Pillow, no deps):

  web/assets/skins/default.png            the "Clobi" default skin (classic model)
  web/assets/skins/template_classic.png   color-coded region map, classic (4 px arms)
  web/assets/skins/template_slim.png      color-coded region map, slim (3 px arms)

plus x8 nearest-neighbor preview PNGs (net view + composed character views)
for visual iteration, written to --preview-dir (default: a folder in the
system temp dir, so a plain run never litters the repo).

THE NET encoded here is the single source of truth from
docs/ARCHITECTURE-3D.md §5.7 — the same box-unwrap rule + net origins that
web/js/vox/skins.js (Skins.NET) exposes at runtime. If you change one, you
change both (better: change neither).

Usage (from the repo root — any cwd actually works, paths are script-relative):

    python tools/make_skins.py [--preview-dir DIR]

Everything is deterministic: same script -> byte-identical PNGs.
"""

import argparse
import colorsys
import os
import struct
import sys
import tempfile
import zlib

# ---- tiny PNG writer (RGBA8, stdlib only) ----------------------------------

def _png_chunk(tag, data):
    """One PNG chunk: length + tag + payload + CRC32(tag+payload)."""
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def png_bytes(width, height, rgba):
    """Encode raw RGBA bytes (len == w*h*4) into a complete PNG file."""
    if len(rgba) != width * height * 4:
        raise ValueError("rgba buffer size mismatch")
    # filter type 0 (None) per scanline — skins are tiny, no need to be clever
    raw = b"".join(
        b"\x00" + bytes(rgba[y * width * 4:(y + 1) * width * 4])
        for y in range(height)
    )
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n" +
            _png_chunk(b"IHDR", ihdr) +
            _png_chunk(b"IDAT", zlib.compress(raw, 9)) +
            _png_chunk(b"IEND", b""))


def write_png(path, canvas):
    with open(path, "wb") as f:
        f.write(png_bytes(canvas.w, canvas.h, canvas.buf))


# ---- canvas (RGBA byte buffer with the two ops we need) ---------------------

class Canvas:
    def __init__(self, w, h):
        self.w = w
        self.h = h
        self.buf = bytearray(w * h * 4)

    def put(self, x, y, rgb, a=255):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 4
            self.buf[i] = rgb[0]
            self.buf[i + 1] = rgb[1]
            self.buf[i + 2] = rgb[2]
            self.buf[i + 3] = a

    def get(self, x, y):
        i = (y * self.w + x) * 4
        return (self.buf[i], self.buf[i + 1], self.buf[i + 2], self.buf[i + 3])

    def blend(self, x, y, rgb, a):
        """src-over composite one pixel (used by the preview composer)."""
        if not (0 <= x < self.w and 0 <= y < self.h) or a == 0:
            return
        if a == 255:
            self.put(x, y, rgb, 255)
            return
        dr, dg, db, da = self.get(x, y)
        sa = a / 255.0
        ra = sa + (da / 255.0) * (1 - sa)
        if ra <= 0:
            return
        out = [
            int(round((rgb[c] * sa + [dr, dg, db][c] * (da / 255.0) * (1 - sa)) / ra))
            for c in range(3)
        ]
        self.put(x, y, tuple(out), int(round(ra * 255)))


# ---- THE NET (ARCHITECTURE-3D.md §5.7 — single source of truth) -------------
#
# Box unwrap rule for a box W×H×D at net origin (U,V):
#   top    = (U+D,     V,   W, D)      bottom = (U+D+W,  V,   W, D)
#   right  = (U,       V+D, D, H)      front  = (U+D,    V+D, W, H)
#   left   = (U+D+W,   V+D, D, H)      back   = (U+D+W+D,V+D, W, H)
# ("right" = the box's own right = viewer's left when facing the front face.)
# Bottom faces are V-flipped when sampled (Minecraft convention).

PART_SIZES = {                      # part -> (W, H, D) in px (classic)
    "head":     (8, 8, 8),
    "body":     (8, 12, 4),
    "rightArm": (4, 12, 4),         # slim: W = 3
    "leftArm":  (4, 12, 4),         # slim: W = 3
    "rightLeg": (4, 12, 4),
    "leftLeg":  (4, 12, 4),
}

NET_ORIGINS = {                     # part -> {layer: (U, V)}
    "head":     {"base": (0, 0),   "overlay": (32, 0)},
    "body":     {"base": (16, 16), "overlay": (16, 32)},
    "rightArm": {"base": (40, 16), "overlay": (40, 32)},
    "leftArm":  {"base": (32, 48), "overlay": (48, 48)},
    "rightLeg": {"base": (0, 16),  "overlay": (0, 32)},
    "leftLeg":  {"base": (16, 48), "overlay": (0, 48)},
}

FACES = ("top", "bottom", "right", "front", "left", "back")

# The six pixels that are transparent on every slim skin but covered by the
# classic right-arm back face — Skins.detectModel checks exactly these.
SLIM_DETECT_PIXELS = ((54, 20), (55, 20), (54, 26), (55, 26), (54, 31), (55, 31))


def box_unwrap(U, V, W, H, D):
    """Apply the §5.7 unwrap rule; returns {face: (x, y, w, h)}."""
    return {
        "top":    (U + D,         V,     W, D),
        "bottom": (U + D + W,     V,     W, D),
        "right":  (U,             V + D, D, H),
        "front":  (U + D,         V + D, W, H),
        "left":   (U + D + W,     V + D, D, H),
        "back":   (U + D + W + D, V + D, W, H),
    }


def build_net(model):
    """{part: {layer: {face: rect}}} for 'classic' or 'slim'."""
    net = {}
    for part, (W, H, D) in PART_SIZES.items():
        if model == "slim" and part in ("rightArm", "leftArm"):
            W = 3
        net[part] = {
            layer: box_unwrap(U, V, W, H, D)
            for layer, (U, V) in NET_ORIGINS[part].items()
        }
    return net


NET = {"classic": build_net("classic"), "slim": build_net("slim")}


# ---- deterministic per-pixel noise ------------------------------------------

def _hash32(x, y, salt=0):
    h = (x * 374761393 + y * 668265263 + salt * 962287441) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return h ^ (h >> 16)


def jitter(x, y, salt, amp):
    """Deterministic luma jitter in [-amp, +amp] (0 when amp == 0)."""
    if amp <= 0:
        return 0
    return (_hash32(x, y, salt) % (2 * amp + 1)) - amp


def clamp8(v):
    return 0 if v < 0 else (255 if v > 255 else int(v))


def shade(rgb, f):
    """Scale a color by factor f (used for edge light/shadow)."""
    return (clamp8(rgb[0] * f), clamp8(rgb[1] * f), clamp8(rgb[2] * f))


def hue_color(hdeg, lightness, sat=0.85):
    r, g, b = colorsys.hls_to_rgb((hdeg % 360) / 360.0, lightness, sat)
    return (clamp8(r * 255), clamp8(g * 255), clamp8(b * 255))


# ---- face painting helpers ---------------------------------------------------
# Light source is top-front-left: top/left edges catch light, bottom/right
# edges fall into shadow. Every fill gets a touch of deterministic noise so
# surfaces read as material, not flat vector fills.

def _edge_factor(u, v, w, h):
    f = 1.0
    if v == 0:
        f *= 1.06
    if v == h - 1:
        f *= 0.86
    if u == 0:
        f *= 1.03
    if u == w - 1:
        f *= 0.93
    return f


def fill_face(cv, rect, rgb, amp=3, salt=0, edges=True, a=255):
    x0, y0, w, h = rect
    for v in range(h):
        for u in range(w):
            c = rgb
            if edges:
                c = shade(c, _edge_factor(u, v, w, h))
            d = jitter(x0 + u, y0 + v, salt, amp)
            cv.put(x0 + u, y0 + v, (clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d)), a)


def pxf(cv, rect, u, v, rgb, a=255):
    """Put one pixel in face-local coordinates."""
    x0, y0, w, h = rect
    if 0 <= u < w and 0 <= v < h:
        cv.put(x0 + u, y0 + v, rgb, a)


def map_face(cv, rect, rows, pal, amps=None, edges=True, salt=0):
    """Paint a face from a char map ('.' = leave untouched / transparent)."""
    x0, y0, w, h = rect
    for v, row in enumerate(rows):
        for u, ch in enumerate(row):
            if ch == ".":
                continue
            c = pal[ch]
            if edges:
                c = shade(c, _edge_factor(u, v, w, h))
            amp = (amps or {}).get(ch, 2)
            d = jitter(x0 + u, y0 + v, salt, amp)
            cv.put(x0 + u, y0 + v,
                   (clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d)), 255)


def mirror_rows(rows):
    return [r[::-1] for r in rows]


# ---- Clobi palette (the distinguished teacher) -------------------------------

P = {
    # skin — warm
    "S": (232, 180, 138),   # skin main
    "s": (201, 148, 104),   # skin shadow
    "F": (243, 200, 160),   # skin highlight (forehead / cheekbone)
    "N": (186, 130,  90),   # nose / deep crease
    # silver hair + beard
    "H": (148, 153, 158),   # hair main
    "h": (116, 121, 126),   # hair dark
    "I": (178, 183, 188),   # hair light strand
    "G": (177, 183, 188),   # beard main (a touch lighter than the hair)
    "g": (141, 147, 152),   # beard shadow
    "V": (207, 212, 216),   # beard light strand
    "M": ( 94,  98, 103),   # mouth shadow inside the beard
    "E": (108, 113, 118),   # eyebrow gray
    # eyes
    "W": (244, 246, 248),   # eye white
    "P": ( 72, 108, 160),   # pupil — steel blue, seen a thousand homeworks
    # white dress shirt
    "T": (243, 243, 238),   # shirt main
    "t": (214, 214, 207),   # shirt shadow / crease
    "U": (255, 255, 252),   # shirt bright (placket, cuffs, collar)
    "u": (170, 170, 163),   # button gray
    # black blazer (never pure black — fabric, not void)
    "K": ( 23,  24,  27),   # blazer main
    "k": ( 12,  13,  15),   # blazer hem / crease
    "Z": ( 46,  49,  55),   # satin lapel edge / shoulder catch-light
    # mint pocket square (Fisherman's Friend tribute)
    "Q": (127, 227, 195),   # mint main
    "q": (172, 241, 220),   # mint light
    # blue jeans
    "J": ( 63,  94, 140),   # denim main
    "j": ( 45,  68, 104),   # denim dark (seams, waist, hem)
    "y": ( 82, 115, 164),   # denim light (knee wear)
    # black shoes
    "X": ( 26,  27,  30),   # shoe upper
    "x": ( 13,  14,  16),   # shoe sole
    "w": ( 52,  55,  60),   # shoe toe shine
    # glasses
    "D": ( 30,  33,  38),   # dark frame
}

# per-char noise amplitude for map faces (default 2)
AMPS = {"H": 5, "h": 5, "I": 4, "G": 5, "g": 4, "V": 3, "S": 3, "s": 3,
        "F": 3, "T": 3, "t": 3, "J": 6, "j": 5, "y": 5, "K": 2, "k": 2}


# ---- Clobi: head -------------------------------------------------------------

HEAD_FRONT = [  # 8×8, top row first — hair, brows, eyes, nose, full beard
    "HHhHHIHH",
    "HFFFFFFH",
    "SEESSEES",
    "SWPSSPWS",
    "sSSNNSSs",
    "GGVGGVGG",
    "gGGMMGGg",
    "ggGGGGgg",
]

HEAD_RIGHT = [  # 8×8; u=7 touches the front face (sideburn side)
    "HHHHHHHH",
    "HHHHHIHH",
    "hHHSSSSH",
    "HSSsSSSG",
    "SSSssSSG",
    "SSSSSSGG",
    "sSSSSGGG",
    "ssGGGGGg",
]

HEAD_BACK = [   # 8×8; hair falls lower at the back, jagged hairline, neck below
    "HHHHIHHH",
    "HHhHHHHH",
    "HHHHHhHH",
    "HHsHHsHH",
    "sSSSSSSs",
    "sSSSSSSs",
    "sSsSSsSs",
    "ssssssss",
]


def paint_head(cv, net):
    f = net["head"]["base"]
    # top: full silver hair with a side parting line at u=2
    fill_face(cv, f["top"], P["H"], amp=5, salt=11)
    for v in range(1, 8):
        pxf(cv, f["top"], 2, v, P["h"])
    for v in range(0, 8, 2):                      # light strands
        pxf(cv, f["top"], 5, v, P["I"])
    # bottom (V-flipped): beard under the chin toward the front, neck behind
    fill_face(cv, f["bottom"], P["g"], amp=3, salt=12, edges=False)
    for v in range(5, 8):
        for u in range(8):
            pxf(cv, f["bottom"], u, v, shade(P["s"], 0.82))
    # front / sides / back from the char maps
    map_face(cv, f["front"], HEAD_FRONT, P, AMPS, salt=13)
    map_face(cv, f["right"], HEAD_RIGHT, P, AMPS, salt=14)
    map_face(cv, f["left"], mirror_rows(HEAD_RIGHT), P, AMPS, salt=15)
    map_face(cv, f["back"], HEAD_BACK, P, AMPS, salt=16)
    # a subtle ear on each side face (2×2, u3-4 v3-4 measured from the back)
    for face, uu in (("right", 3), ("left", 3)):
        r = f[face]
        pxf(cv, r, uu, 3, P["F"]); pxf(cv, r, uu + 1, 3, P["S"])
        pxf(cv, r, uu, 4, P["S"]); pxf(cv, r, uu + 1, 4, P["s"])

    # hat overlay: browline glasses (front) + temple arms (sides). The dark
    # frame is only a top bar sitting on the brow line plus the nose bridge —
    # no bottom rim, so the eyes underneath stay bright and visible.
    o = net["head"]["overlay"]
    fr = o["front"]
    for u in (0, 1, 2, 5, 6, 7):                  # browline top bars
        pxf(cv, fr, u, 2, P["D"])
    pxf(cv, fr, 1, 2, shade(P["D"], 1.6))         # catch-light on the frame
    pxf(cv, fr, 3, 3, P["D"]); pxf(cv, fr, 4, 3, P["D"])  # bridge over the nose
    for u in range(4, 8):                         # right temple arm -> ear
        pxf(cv, o["right"], u, 2, P["D"])
    for u in range(0, 4):                         # left temple arm
        pxf(cv, o["left"], u, 2, P["D"])


# ---- Clobi: body (white shirt base + open black blazer overlay) --------------

JACKET_FRONT = [  # 8×12 — open blazer, satin lapels, mint pocket square
    "KKZ..ZKK",
    "KKZ..ZKK",
    "KZ....ZK",
    "KZ....qK",
    "KZ....QK",
    "KZ....ZK",
    "KZ....ZK",
    "KZ....ZK",
    "KZ....ZK",
    "KKZ..ZKK",
    "KKZ..ZKK",
    "kkZ..Zkk",
]


def paint_body(cv, net):
    f = net["body"]["base"]
    # front: white dress shirt — placket, buttons, collar shadow
    fill_face(cv, f["front"], P["T"], amp=3, salt=21)
    for v in range(12):
        pxf(cv, f["front"], 3, v, P["U"] if v else P["t"])   # placket strip
    pxf(cv, f["front"], 2, 0, P["U"]); pxf(cv, f["front"], 5, 0, P["U"])  # collar pts
    pxf(cv, f["front"], 4, 0, P["t"])                        # under-chin shadow
    for v in (2, 5, 8):
        pxf(cv, f["front"], 4, v, P["u"])                    # buttons
    pxf(cv, f["front"], 6, 3, P["q"]); pxf(cv, f["front"], 6, 4, P["Q"])
    # (mint accent painted on the base too — the jacket overlay repeats it)
    # sides / back: shirt with soft creases
    fill_face(cv, f["right"], P["T"], amp=3, salt=22)
    fill_face(cv, f["left"], P["T"], amp=3, salt=23)
    fill_face(cv, f["back"], P["T"], amp=3, salt=24)
    for v in range(1, 11):
        pxf(cv, f["back"], 3, v, P["t"])                     # back crease
    for u in range(8):
        pxf(cv, f["back"], u, 2, P["t"])                     # yoke seam
    # top: shoulders + a hint of neck skin in the collar hole
    fill_face(cv, f["top"], P["T"], amp=3, salt=25)
    for v in (1, 2):
        pxf(cv, f["top"], 3, v, P["s"]); pxf(cv, f["top"], 4, v, P["s"])
    # bottom: jeans waist seen from below
    fill_face(cv, f["bottom"], P["j"], amp=4, salt=26)

    # jacket overlay
    o = net["body"]["overlay"]
    map_face(cv, o["front"], JACKET_FRONT, P, AMPS, salt=27)
    fill_face(cv, o["right"], P["K"], amp=2, salt=28)
    fill_face(cv, o["left"], P["K"], amp=2, salt=29)
    fill_face(cv, o["back"], P["K"], amp=2, salt=30)
    for u in range(4):                                       # shoulder catch-light
        pxf(cv, o["right"], u, 0, P["Z"]); pxf(cv, o["left"], u, 0, P["Z"])
    for u in range(8):
        pxf(cv, o["back"], u, 0, P["Z"])
    for v in range(8, 12):
        pxf(cv, o["back"], 4, v, P["k"])                     # center vent
    for u in range(8):
        pxf(cv, o["back"], u, 11, P["k"])                    # hem
    fill_face(cv, o["top"], P["K"], amp=2, salt=31)
    for u in range(8):
        pxf(cv, o["top"], u, 3, P["Z"])                      # front shoulder edge
    # o['bottom'] stays transparent — the jacket is open at the hem


# ---- Clobi: arms (shirt sleeve + cuff + hand base; black sleeve overlay) -----

def paint_arm(cv, net, part):
    mirrored = (part == "leftArm")
    f = net[part]["base"]
    W = f["front"][2]
    for face in ("right", "front", "left", "back"):
        r = f[face]
        fw = r[2]
        for v in range(12):
            for u in range(fw):
                if v <= 8:
                    c = P["T"]                              # shirt sleeve
                elif v == 9:
                    c = P["U"]                              # crisp white cuff
                else:
                    c = P["S"] if v == 10 else P["s"]       # hand
                c = shade(c, _edge_factor(u, v, fw, 12))
                d = jitter(r[0] + u, r[1] + v, 41, 3)
                cv.put(r[0] + u, r[1] + v,
                       (clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d)))
    # cuff button + thumb crease on the front face (mirrored for the left arm)
    fr = f["front"]
    pxf(cv, fr, (W - 2) if mirrored else 1, 9, P["u"])
    pxf(cv, fr, 0 if mirrored else W - 1, 10, P["s"])
    fill_face(cv, f["top"], P["T"], amp=3, salt=42)          # shoulder
    fill_face(cv, f["bottom"], P["s"], amp=3, salt=43)       # fist underside

    # sleeve overlay: blazer arm, ends at v=8 so the white cuff peeks out
    o = net[part]["overlay"]
    for face in ("right", "front", "left", "back"):
        r = o[face]
        fw = r[2]
        for v in range(9):
            for u in range(fw):
                c = P["Z"] if v == 0 else (P["k"] if v == 8 else P["K"])
                c = shade(c, _edge_factor(u, v, fw, 12))
                d = jitter(r[0] + u, r[1] + v, 44, 2)
                cv.put(r[0] + u, r[1] + v,
                       (clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d)))
    fill_face(cv, o["top"], P["K"], amp=2, salt=45)
    # o['bottom'] + v 9..11 stay transparent


# ---- Clobi: legs (jeans + black shoes) ----------------------------------------

def paint_leg(cv, net, part):
    mirrored = (part == "leftLeg")
    f = net[part]["base"]
    for face in ("right", "front", "left", "back"):
        r = f[face]
        fw = r[2]
        for v in range(12):
            for u in range(fw):
                if v == 0:
                    c = P["j"]                               # waistband
                elif v <= 8:
                    c = P["J"]                               # denim
                elif v == 9:
                    c = P["j"]                               # hem shadow
                elif v == 10:
                    c = P["X"]                               # shoe upper
                else:
                    c = P["x"]                               # sole
                c = shade(c, _edge_factor(u, v, fw, 12))
                d = jitter(r[0] + u, r[1] + v, 51, 6 if v <= 9 else 2)
                cv.put(r[0] + u, r[1] + v,
                       (clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d)))
    fr = f["front"]
    seam_u = 3 if mirrored else 0                            # outer seam
    for v in range(1, 9):
        pxf(cv, fr, seam_u, v, P["j"])
    for u in (1, 2):                                         # knee wear patch
        pxf(cv, fr, u, 4, P["y"]); pxf(cv, fr, u, 5, P["y"])
    pxf(cv, fr, 2 if mirrored else 1, 10, P["w"])            # toe shine
    # back pocket patch
    bk = f["back"]
    for u in (1, 2):
        pxf(cv, bk, u, 2, P["j"]); pxf(cv, bk, u, 3, P["j"])
    fill_face(cv, f["top"], P["j"], amp=4, salt=52)
    # bottom (V-flipped): sole with tread stripes
    r = f["bottom"]
    for v in range(4):
        for u in range(4):
            c = P["x"] if v % 2 == 0 else (8, 8, 10)
            d = jitter(r[0] + u, r[1] + v, 53, 2)
            cv.put(r[0] + u, r[1] + v,
                   (clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d)))
    # overlay (pants layer) intentionally left fully transparent


# ---- the default skin ----------------------------------------------------------

def paint_default():
    """Clobi — distinguished bearded teacher, black blazer, mint pocket square."""
    cv = Canvas(64, 64)
    net = NET["classic"]
    paint_head(cv, net)
    paint_body(cv, net)
    paint_arm(cv, net, "rightArm")
    paint_arm(cv, net, "leftArm")
    paint_leg(cv, net, "rightLeg")
    paint_leg(cv, net, "leftLeg")
    return cv


# ---- templates ------------------------------------------------------------------
# Distinct saturated hue per part; each face a lightness step (top lightest ->
# bottom darkest); front face marked with a 1 px lighter border; overlay regions
# same hue at alpha 140; unused pixels alpha 0.

PART_HUES = {                    # degrees
    "head": 0,        # red family
    "body": 120,      # green
    "rightArm": 225,  # blue
    "leftArm": 55,    # yellow
    "rightLeg": 305,  # magenta
    "leftLeg": 180,   # cyan
}

FACE_LIGHTNESS = {
    "top": 0.74, "front": 0.62, "left": 0.53,
    "right": 0.46, "back": 0.38, "bottom": 0.28,
}


def paint_template(model):
    cv = Canvas(64, 64)
    net = NET[model]
    for part, layers in net.items():
        hue = PART_HUES[part]
        for layer, faces in layers.items():
            alpha = 255 if layer == "base" else 140
            for face, rect in faces.items():
                col = hue_color(hue, FACE_LIGHTNESS[face])
                fill_face(cv, rect, col, amp=0, edges=False, a=alpha)
                if face == "front":                      # 1 px lighter border
                    lite = hue_color(hue, min(FACE_LIGHTNESS[face] + 0.18, 0.92))
                    x0, y0, w, h = rect
                    for u in range(w):
                        cv.put(x0 + u, y0, lite, alpha)
                        cv.put(x0 + u, y0 + h - 1, lite, alpha)
                    for v in range(h):
                        cv.put(x0, y0 + v, lite, alpha)
                        cv.put(x0 + w - 1, y0 + v, lite, alpha)
    return cv


# ---- validation -------------------------------------------------------------------

def region_pixels(model, layer):
    pts = set()
    for part, layers in NET[model].items():
        for face, (x0, y0, w, h) in layers[layer].items():
            for v in range(h):
                for u in range(w):
                    pts.add((x0 + u, y0 + v))
    return pts


def validate_default(cv):
    """Contract checks: base fully opaque, nothing painted off-net, classic-detect."""
    base = region_pixels("classic", "base")
    over = region_pixels("classic", "overlay")
    for (x, y) in base:
        if cv.get(x, y)[3] != 255:
            raise AssertionError("base pixel not opaque at (%d,%d)" % (x, y))
    for y in range(64):
        for x in range(64):
            if (x, y) not in base and (x, y) not in over and cv.get(x, y)[3] != 0:
                raise AssertionError("stray pixel outside the net at (%d,%d)" % (x, y))
    for (x, y) in SLIM_DETECT_PIXELS:
        if cv.get(x, y)[3] != 255:
            raise AssertionError("default.png must auto-detect as classic")


def validate_template(cv, model):
    base = region_pixels(model, "base")
    over = region_pixels(model, "overlay")
    for (x, y) in base:
        if cv.get(x, y)[3] != 255:
            raise AssertionError("template base pixel not opaque at (%d,%d)" % (x, y))
    for (x, y) in over:
        if cv.get(x, y)[3] != 140:
            raise AssertionError("template overlay alpha != 140 at (%d,%d)" % (x, y))
    if model == "slim":
        for (x, y) in SLIM_DETECT_PIXELS:
            if cv.get(x, y)[3] != 0:
                raise AssertionError("slim template must auto-detect as slim")


# ---- previews (x8 nearest neighbor over a checkerboard) ----------------------------

def upscale_checker(cv, k=8):
    out = Canvas(cv.w * k, cv.h * k)
    for y in range(out.h):
        for x in range(out.w):
            sx, sy = x // k, y // k
            r, g, b, a = cv.get(sx, sy)
            if ((x // 8) + (y // 8)) % 2 == 0:
                bg = (214, 214, 214)
            else:
                bg = (190, 190, 190)
            if a == 255:
                out.put(x, y, (r, g, b))
            elif a == 0:
                out.put(x, y, bg)
            else:
                f = a / 255.0
                out.put(x, y, (clamp8(r * f + bg[0] * (1 - f)),
                               clamp8(g * f + bg[1] * (1 - f)),
                               clamp8(b * f + bg[2] * (1 - f))))
    return out


def _paste_face(dst, dx, dy, src, rect, overlay=False):
    x0, y0, w, h = rect
    for v in range(h):
        for u in range(w):
            r, g, b, a = src.get(x0 + u, y0 + v)
            if overlay:
                dst.blend(dx + u, dy + v, (r, g, b), a)
            elif a:
                dst.put(dx + u, dy + v, (r, g, b), a)


def compose_views(cv, model):
    """Front + back + right-side orthographic composites (base ⊕ overlay)."""
    net = NET[model]
    aw = net["rightArm"]["base"]["front"][2]      # 4 classic, 3 slim
    view_w, view_h, margin = 16, 32, 2
    out = Canvas(margin * 4 + view_w * 2 + 8, view_h + margin * 2)

    def part(view_x, name, face, dx, dy, layer):
        _paste_face(out, view_x + dx, margin + dy, cv,
                    net[name][layer][face], overlay=(layer == "overlay"))

    # front view
    fx = margin
    for layer in ("base", "overlay"):
        part(fx, "rightLeg", "front", 4, 20, layer)
        part(fx, "leftLeg", "front", 8, 20, layer)
        part(fx, "body", "front", 4, 8, layer)
        part(fx, "rightArm", "front", 4 - aw, 8, layer)
        part(fx, "leftArm", "front", 12, 8, layer)
        part(fx, "head", "front", 4, 0, layer)
    # back view
    bx = margin * 2 + view_w
    for layer in ("base", "overlay"):
        part(bx, "leftLeg", "back", 4, 20, layer)
        part(bx, "rightLeg", "back", 8, 20, layer)
        part(bx, "body", "back", 4, 8, layer)
        part(bx, "leftArm", "back", 4 - aw, 8, layer)
        part(bx, "rightArm", "back", 12, 8, layer)
        part(bx, "head", "back", 4, 0, layer)
    # right-side view
    sx = margin * 3 + view_w * 2
    for layer in ("base", "overlay"):
        part(sx, "rightLeg", "right", 2, 20, layer)
        part(sx, "body", "right", 2, 8, layer)
        part(sx, "rightArm", "right", 2, 8, layer)   # arm hangs over the torso
        part(sx, "head", "right", 0, 0, layer)
    return out


# ---- main ---------------------------------------------------------------------------

def main(argv):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description="Generate Clobi's Arena skin assets.")
    ap.add_argument("--preview-dir",
                    default=os.path.join(tempfile.gettempdir(), "clobi_skin_previews"),
                    help="where the x8 preview PNGs go "
                         "(default: <system temp>/clobi_skin_previews — never the repo)")
    args = ap.parse_args(argv)

    out_dir = os.path.join(root, "web", "assets", "skins")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(args.preview_dir, exist_ok=True)

    default = paint_default()
    validate_default(default)
    tpl_classic = paint_template("classic")
    validate_template(tpl_classic, "classic")
    tpl_slim = paint_template("slim")
    validate_template(tpl_slim, "slim")

    outputs = [
        (os.path.join(out_dir, "default.png"), default),
        (os.path.join(out_dir, "template_classic.png"), tpl_classic),
        (os.path.join(out_dir, "template_slim.png"), tpl_slim),
    ]
    for path, cv in outputs:
        write_png(path, cv)
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))

    previews = [
        ("default_preview.png", upscale_checker(default)),          # net view
        ("default_views_preview.png", upscale_checker(compose_views(default, "classic"))),
        ("template_classic_preview.png", upscale_checker(tpl_classic)),
        ("template_slim_preview.png", upscale_checker(tpl_slim)),
    ]
    for name, cv in previews:
        path = os.path.join(args.preview_dir, name)
        write_png(path, cv)
        print("wrote %s" % path)
    print("all skins validated against THE NET (§5.7) — done.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
