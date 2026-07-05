# CLOBI'S ARENA — Skin Format Reference ("THE NET")

Clobi's Arena uses the Minecraft skin format. Not "inspired by", not "similar
to" — the actual format, 1:1. Any skin PNG that works in Minecraft works here,
and any skin painted in our Studio works in Minecraft. We didn't invent a new
wheel; we bought the same wheel and put a mint lozenge in the glove box.

This document is the user- and tool-facing companion to
`docs/ARCHITECTURE-3D.md` §5.7, which is the binding contract. The runtime
source of truth is `Skins.NET` in `web/js/vox/skins.js`; the generator
`tools/make_skins.py` encodes the identical tables. If these ever disagree,
someone has already broken the build — file a bug, then hide.

---

## 1. The sheet

A skin is a **64×64 PNG** (RGBA). A legacy **64×32** PNG is also accepted and
auto-converted (see §8). The sheet is a *net* — every body part is a box, and
each box is unwrapped flat onto the sheet, cardboard-packaging style.

Two model variants exist:

| model | arms | who |
|-------|------|-----|
| `classic` | 4 px wide | the default (Steve-style) |
| `slim` | 3 px wide | narrower arms (Alex-style) |

Everything else is identical between the two. Both are painted on the same
64×64 sheet; slim simply leaves a 1-px-wide strip of each arm region unused.

### 1.1 Region map — classic

One character = one pixel column, one row = **two** pixel rows. Uppercase =
base layer, lowercase = overlay layer. `.` = unused (must stay alpha 0).

```
    0       1       2       3       4       5       6       7          (x = column*8)
 0  ........HHHHHHHHHHHHHHHH................hhhhhhhhhhhhhhhh........
 2  ........HHHHHHHHHHHHHHHH................hhhhhhhhhhhhhhhh........
 4  ........HHHHHHHHHHHHHHHH................hhhhhhhhhhhhhhhh........
 6  ........HHHHHHHHHHHHHHHH................hhhhhhhhhhhhhhhh........
 8  HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh
10  HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh
12  HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh
14  HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh
16  ....PPPPPPPP........BBBBBBBBBBBBBBBB........RRRRRRRR............
18  ....PPPPPPPP........BBBBBBBBBBBBBBBB........RRRRRRRR............
20  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRRRR........
22  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRRRR........
24  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRRRR........
26  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRRRR........
28  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRRRR........
30  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRRRR........
32  ....pppppppp........jjjjjjjjjjjjjjjj........rrrrrrrr............
34  ....pppppppp........jjjjjjjjjjjjjjjj........rrrrrrrr............
36  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrrrr........
38  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrrrr........
40  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrrrr........
42  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrrrr........
44  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrrrr........
46  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrrrr........
48  ....qqqqqqqq........QQQQQQQQ........LLLLLLLL........llllllll....
50  ....qqqqqqqq........QQQQQQQQ........LLLLLLLL........llllllll....
52  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLLLLllllllllllllllll
54  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLLLLllllllllllllllll
56  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLLLLllllllllllllllll
58  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLLLLllllllllllllllll
60  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLLLLllllllllllllllll
62  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLLLLllllllllllllllll
```

Legend: `H/h` head/hat · `B/j` body/jacket · `R/r` right arm/sleeve ·
`L/l` left arm/sleeve · `P/p` right leg/pants · `Q/q` left leg/pants.

### 1.2 Region map — slim (differences: arms only)

```
    0       1       2       3       4       5       6       7          (x = column*8)
16  ....PPPPPPPP........BBBBBBBBBBBBBBBB........RRRRRR..............
18  ....PPPPPPPP........BBBBBBBBBBBBBBBB........RRRRRR..............
20  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRR..........
22  PPPPPPPPPPPPPPPPBBBBBBBBBBBBBBBBBBBBBBBBRRRRRRRRRRRRRR..........
   (…rows 24–30 identical…)
32  ....pppppppp........jjjjjjjjjjjjjjjj........rrrrrr..............
34  ....pppppppp........jjjjjjjjjjjjjjjj........rrrrrr..............
36  ppppppppppppppppjjjjjjjjjjjjjjjjjjjjjjjjrrrrrrrrrrrrrr..........
   (…rows 38–46 identical…)
48  ....qqqqqqqq........QQQQQQQQ........LLLLLL..........llllll......
50  ....qqqqqqqq........QQQQQQQQ........LLLLLL..........llllll......
52  qqqqqqqqqqqqqqqqQQQQQQQQQQQQQQQQLLLLLLLLLLLLLL..llllllllllllll..
   (…rows 54–62 identical…)
```

Head, body and both legs are byte-for-byte the same as classic; only the four
arm regions shrink from a 4-px to a 3-px strip (same origins).

---

## 2. The box-unwrap rule

Every part is a box of size **W×H×D** pixels, unwrapped at a net origin
**(U,V)** using one universal rule:

```
            +----------------+----------------+
            |      top       |     bottom     |
            |   (U+D, V)     |  (U+D+W, V)    |
            |     W × D      |     W × D      |
+-----------+----------------+----------------+-----------+
|   right   |     front      |      left      |   back    |
| (U, V+D)  |  (U+D, V+D)    | (U+D+W, V+D)   |(U+D+W+D,  |
|   D × H   |     W × H      |     D × H      |  V+D) W×H |
+-----------+----------------+----------------+-----------+
```

As formulas, rectangle = `(x, y, w, h)`:

| face | x | y | w | h |
|------|---|---|---|---|
| top | U+D | V | W | D |
| bottom | U+D+W | V | W | D |
| right | U | V+D | D | H |
| front | U+D | V+D | W | H |
| left | U+D+W | V+D | D | H |
| back | U+D+W+D | V+D | W | H |

**"right" means the box's own right** — the viewer's *left* when looking at
the front face. Yes, this trips up everyone exactly once.

### 2.1 Part sizes and net origins

| part | W×H×D (px) | base origin | overlay origin |
|------|-----------|-------------|----------------|
| head | 8×8×8 | (0,0) | (32,0) |
| body | 8×12×4 | (16,16) | (16,32) |
| rightArm | 4×12×4 *(slim: 3×12×4)* | (40,16) | (40,32) |
| leftArm | 4×12×4 *(slim: 3×12×4)* | (32,48) | (48,48) |
| rightLeg | 4×12×4 | (0,16) | (0,32) |
| leftLeg | 4×12×4 | (16,48) | (0,48) |

---

## 3. Complete UV tables — classic

All rectangles `(x, y, w, h)` in the 64×64 grid.

### 3.1 Base layer

| part | top | bottom | right | front | left | back |
|------|-----|--------|-------|-------|------|------|
| head | (8,0,8,8) | (16,0,8,8) | (0,8,8,8) | (8,8,8,8) | (16,8,8,8) | (24,8,8,8) |
| body | (20,16,8,4) | (28,16,8,4) | (16,20,4,12) | (20,20,8,12) | (28,20,4,12) | (32,20,8,12) |
| rightArm | (44,16,4,4) | (48,16,4,4) | (40,20,4,12) | (44,20,4,12) | (48,20,4,12) | (52,20,4,12) |
| leftArm | (36,48,4,4) | (40,48,4,4) | (32,52,4,12) | (36,52,4,12) | (40,52,4,12) | (44,52,4,12) |
| rightLeg | (4,16,4,4) | (8,16,4,4) | (0,20,4,12) | (4,20,4,12) | (8,20,4,12) | (12,20,4,12) |
| leftLeg | (20,48,4,4) | (24,48,4,4) | (16,52,4,12) | (20,52,4,12) | (24,52,4,12) | (28,52,4,12) |

### 3.2 Overlay layer (hat / jacket / sleeves / pants)

| part | top | bottom | right | front | left | back |
|------|-----|--------|-------|-------|------|------|
| head (hat) | (40,0,8,8) | (48,0,8,8) | (32,8,8,8) | (40,8,8,8) | (48,8,8,8) | (56,8,8,8) |
| body (jacket) | (20,32,8,4) | (28,32,8,4) | (16,36,4,12) | (20,36,8,12) | (28,36,4,12) | (32,36,8,12) |
| rightArm (sleeve) | (44,32,4,4) | (48,32,4,4) | (40,36,4,12) | (44,36,4,12) | (48,36,4,12) | (52,36,4,12) |
| leftArm (sleeve) | (52,48,4,4) | (56,48,4,4) | (48,52,4,12) | (52,52,4,12) | (56,52,4,12) | (60,52,4,12) |
| rightLeg (pants) | (4,32,4,4) | (8,32,4,4) | (0,36,4,12) | (4,36,4,12) | (8,36,4,12) | (12,36,4,12) |
| leftLeg (pants) | (4,48,4,4) | (8,48,4,4) | (0,52,4,12) | (4,52,4,12) | (8,52,4,12) | (12,52,4,12) |

## 4. Complete UV tables — slim (arms only; everything else as §3)

### 4.1 Base layer

| part | top | bottom | right | front | left | back |
|------|-----|--------|-------|-------|------|------|
| rightArm | (44,16,3,4) | (47,16,3,4) | (40,20,4,12) | (44,20,3,12) | (47,20,4,12) | (51,20,3,12) |
| leftArm | (36,48,3,4) | (39,48,3,4) | (32,52,4,12) | (36,52,3,12) | (39,52,4,12) | (43,52,3,12) |

### 4.2 Overlay layer

| part | top | bottom | right | front | left | back |
|------|-----|--------|-------|-------|------|------|
| rightArm (sleeve) | (44,32,3,4) | (47,32,3,4) | (40,36,4,12) | (44,36,3,12) | (47,36,4,12) | (51,36,3,12) |
| leftArm (sleeve) | (52,48,3,4) | (55,48,3,4) | (48,52,4,12) | (52,52,3,12) | (55,52,4,12) | (59,52,3,12) |

Note how the side faces (`right`/`left`) stay 4 px wide — depth doesn't change
on slim, only the arm's width (front/back/top/bottom strips lose 1 px).

---

## 5. The bottom-face V-flip

**Bottom faces are sampled upside-down** (V-flipped) — Minecraft convention,
inherited here without argument. If you paint text on a bottom face and look
at the model from below, it reads correctly *because* of the flip. Every
renderer and the Studio's picker (`Skins.regionAt`) account for this; you only
need to care when hand-editing pixels in an external editor and wondering why
your shoe sole is mirrored. It isn't. It's V-flipped. There's a difference,
and it has ruined evenings.

## 6. Layers: base and overlay

Each part has two boxes drawn as true 3D geometry:

- **Base layer** — treated as **fully opaque**. Alpha is forced to 1 at render
  time, exactly like Minecraft. This is what makes arbitrary downloaded skins
  render correctly even when their authors left stray alpha in base regions.
- **Overlay layer** (hat, jacket, sleeves, pants) — rendered as a slightly
  **inflated** box with **alpha cutout** (pixel discarded when alpha < 0.5)
  and **backface culling disabled**, so the inside of an open jacket is
  visible.

Inflation per side, in model units (1 unit = 1 px = 1/16 block):

| part | inflation |
|------|-----------|
| head (hat) | **+0.5** |
| all other overlays | **+0.25** |

Practical consequence for artists: overlay pixels are either *there*
(alpha ≥ 128, fully visible) or *not there* (alpha < 128, hole). Don't paint
50 %-alpha lace and expect chiffon.

## 7. Slim auto-detection

A skin is detected as `slim` when **all six** of these pixels have alpha 0:

```
(54,20)  (55,20)  (54,26)  (55,26)  (54,31)  (55,31)
```

These columns belong to the classic right-arm **back** face `(52,20,4,12)` but
lie outside every slim region — a classic skin covers them (base = opaque), a
slim skin cannot. The UI always offers a manual override, because the world
contains skins made at 3 a.m. with the wrong template.

## 8. Legacy 64×32 skins

Ancient 64×32 skins (the top half of the modern sheet, no overlay below the
hat, no left limbs) are converted on import:

1. Copy the whole 64×32 image into the top half of a blank 64×64 canvas.
2. Synthesize the left limbs by mirroring the right ones — per-face horizontal
   flip, with the `right` and `left` faces swapped:
   - rightLeg `(0,16)` → leftLeg `(16,48)`
   - rightArm `(40,16)` → leftArm `(32,48)`
3. All overlay regions below y=32 stay transparent.

The result is a normal classic 64×64 skin. Your 2010 self is welcome.

## 9. Plug and play

**Any Minecraft skin PNG just works.** Download one from any skin site, drag
it into the Wardrobe (or the Studio), and it renders with both layers, correct
model auto-detection, the lot. Exporting works the same way in reverse: the
PNG the Studio saves is a valid Minecraft skin. No conversion tools, no
format lock-in, no excuses.

Server-side, published skins are validated as: real PNG, exactly 64×64 or
64×32, decoded size ≤ 32 KiB, model ∈ {classic, slim}.

## 10. Making skins: the Studio and remix lineage

The in-game **Skin Studio** shows the flat net (this document, but clickable)
next to a live 3D turntable — paint a pixel, watch it appear on the model
within a frame. Tools: pen, eraser, fill, eyedropper, line, mirror mode
(paints the mirrored limb simultaneously), HSV+alpha picker, 1–3 px brush,
undo/redo, zoom/pan, per-layer editing (base paints opaque; overlay paints
with alpha). Hovering the net names the region under the cursor via
`Skins.regionAt(x, y, model)` — the same tables as §3/§4.

The color-coded **templates** (`template_classic.png`, `template_slim.png`)
are downloadable in-Studio: one saturated hue per part (head red, body green,
right arm blue, left arm yellow, right leg magenta, left leg cyan), one
lightness step per face (top lightest → bottom darkest), front faces marked
with a 1-px lighter border, overlay regions at alpha 140. Open one in any
pixel editor and you always know where you are.

Publishing a skin to the **marketplace** is free — everything is free, the
economy is compliments. Every published skin carries **remix lineage**: hit
*Remix* on any marketplace skin and the Studio opens with a copy plus a
banner crediting the original; publish your version and the chain of
attribution rides along (`remixOf`). Skins are community-moderated with
reports, vouches, and the occasional stern look.

## 11. The default skin: "Clobi"

The default skin is a tribute: a distinguished bearded teacher in a black
blazer worn open over a white shirt — the penguin-tuxedo homage, one Linux
mascot to another. Silver hair and beard, browline glasses on the hat layer,
a mint pocket square (Fisherman's Friend green, for reasons alumni will
understand), blue jeans, black shoes. Classic model. Both layers used the
way they're meant to be: shirt, hands and jeans on the base; blazer, sleeves
and glasses on the overlay, so the white cuffs peek out below the sleeve hems.

All three PNGs are generated deterministically by `tools/make_skins.py`
(Python 3, standard library only — the PNG writer is hand-rolled on
`struct` + `zlib`):

```
python tools/make_skins.py
```

writes `web/assets/skins/default.png`, `template_classic.png`,
`template_slim.png`, and x8 preview sheets for eyeballing.

---

## Appendix A — default.png as a data URL

The complete generated `web/assets/skins/default.png`, base64-encoded, for
embedding, testing, or admiring in hex:

```
data:image/png;base64,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
```

*(Generated by `tools/make_skins.py`; byte-identical on every run. If you
re-generate after changing the art, re-embed — this appendix does not update
itself, much as we've asked it to.)*
