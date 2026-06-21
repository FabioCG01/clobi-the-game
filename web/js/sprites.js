// sprites.js — procedural 8-bit pixel art for "Tux Smash Royale". Single global:
// Sprites. Pure fillRect art on a virtual pixel grid; NO image asset files.
//
// THE UNIVERSAL CHARACTER
// -----------------------
// One character object is used across BOTH game modes and BOTH body types. It is
// a plain, JSON-serializable bag of indices that travels over the wire and is
// stored in accounts.json (see Go protocol.Character — field names match):
//   {
//     name:      string  display name (cosmetic; not drawn on the sprite itself)
//     bodyType:  'tux' | 'humanoid'   selects the silhouette renderer
//     body:      int  index into PARTS.BODY_COLORS    (primary color)
//     belly:     int  index into PARTS.BELLY_COLORS   (belly / shirt color)
//     feet:      int  index into PARTS.FEET_COLORS    (feet / shoes color)
//     hat:       int  index into PARTS.HATS           (0 = none)
//     eyes:      int  index into PARTS.EYES
//     accessory: int  index into PARTS.ACCESSORIES    (0 = none)
//     cape:      int  index into PARTS.CAPES          (0 = none)
//   }
//
// The SAME shared parts (colors, hat, eyes, accessory, cape) are applied to
// whichever body is selected, so a saved character reads clearly as either a
// penguin or a person.
//
// drawCharacter(ctx, character, x, y, scale, facing):
//   (x, y) is the CENTER of the character in destination (canvas) pixels.
//   `scale` is destination-pixels per sprite-pixel (the art grid is 16 wide).
//   `facing` is +1 (right) or -1 (left); the whole sprite is mirrored for -1.

var Sprites = (function () {
  'use strict';

  // ---- Palette catalogs ----------------------------------------------------
  // Index 0 of each color list is the classic-Tux default. The catalogs are
  // generous so randomized bots (server picks indices up to 5/3/2) always land
  // on a valid, good-looking entry.

  var BODY_COLORS = [
    '#11131c', // 0 classic black (Tux)
    '#1b2a4a', // 1 midnight blue
    '#3a1d4a', // 2 royal purple
    '#143a2a', // 3 forest green
    '#4a1320', // 4 dark crimson
    '#2b2b2b', // 5 charcoal
    '#103a44', // 6 deep teal
    '#3a2a10'  // 7 dark bronze
  ];

  var BELLY_COLORS = [
    '#fdfdfd', // 0 classic white
    '#7ff9e0', // 1 minty cyan (Fisherman's)
    '#ffe7b0', // 2 cream
    '#ffd0e0', // 3 pale pink
    '#cfe9ff', // 4 ice blue
    '#d8ffcf', // 5 mint green
    '#fff27f', // 6 lemon
    '#e8e8f0'  // 7 silver
  ];

  var FEET_COLORS = [
    '#ff9e2c', // 0 classic penguin orange
    '#ffcf3c', // 1 gold
    '#ff5a3c', // 2 coral red
    '#ff7fd0', // 3 hot pink
    '#7ff9e0', // 4 minty
    '#9cff5a', // 5 lime
    '#ffffff', // 6 white
    '#b06a2c'  // 7 brown
  ];

  // Hats: name + geometry kind. kind 'none' draws nothing. c1/c2 are the two
  // chunky colors; extra fields tweak per-kind details.
  var HATS = [
    { name: 'None',       kind: 'none' },
    { name: 'Vim Cap',    kind: 'cap',    c1: '#1b7a3a', c2: '#0f4a24', logo: '#cfe9ff' },
    { name: 'Wizard',     kind: 'wizard', c1: '#3a1d4a', c2: '#7ff9e0', star: '#fff27f' },
    { name: 'Tux Crown',  kind: 'crown',  c1: '#ffcf3c', c2: '#ff9e2c', gem: '#ff5a3c' },
    { name: 'Beanie',     kind: 'beanie', c1: '#ff5a3c', c2: '#fdfdfd' },
    { name: 'Tophat',     kind: 'tophat', c1: '#11131c', c2: '#7ff9e0' },
    { name: 'Headphones', kind: 'phones', c1: '#2b2b2b', c2: '#ff9e2c' },
    { name: 'Halo',       kind: 'halo',   c1: '#fff27f', c2: '#ffcf3c' }
  ];

  // Eyes: name + style flag.
  var EYES = [
    { name: 'Classic',  kind: 'classic' }, // two dot eyes
    { name: 'Angry',    kind: 'angry' },
    { name: 'Sleepy',   kind: 'sleepy' },
    { name: 'Shades',   kind: 'shades' },   // 8-bit sunglasses
    { name: 'Cyclops',  kind: 'cyclops' },
    { name: 'Sparkle',  kind: 'sparkle' }
  ];

  // Accessories: name + kind. kind 'none' draws nothing. Drawn over the body.
  var ACCESSORIES = [
    { name: 'None',          kind: 'none' },
    { name: 'Bowtie',        kind: 'bowtie',   c1: '#ff5a3c' },
    { name: 'Fisherman\'s',  kind: 'fish',     c1: '#7ff9e0', c2: '#11131c' }, // menthol tin held to chest
    { name: 'Scarf',         kind: 'scarf',    c1: '#ff9e2c' },
    { name: 'Necklace',      kind: 'necklace', c1: '#fff27f' },
    { name: 'Badge',         kind: 'badge',    c1: '#9cff5a' }
  ];

  // Capes: name + kind. kind 'none' draws nothing. Drawn behind the body.
  var CAPES = [
    { name: 'None',   kind: 'none' },
    { name: 'Hero',   kind: 'cape', c1: '#ff5a3c', c2: '#b3331f' },
    { name: 'Mint',   kind: 'cape', c1: '#7ff9e0', c2: '#3fb59c' },
    { name: 'Royal',  kind: 'cape', c1: '#3a1d4a', c2: '#7a52a0' },
    { name: 'Gold',   kind: 'cape', c1: '#ffcf3c', c2: '#b3870f' }
  ];

  var PARTS = {
    BODY_COLORS: BODY_COLORS,
    BELLY_COLORS: BELLY_COLORS,
    FEET_COLORS: FEET_COLORS,
    HATS: HATS,
    EYES: EYES,
    ACCESSORIES: ACCESSORIES,
    CAPES: CAPES
  };

  // ---- Character factories -------------------------------------------------

  function defaultCharacter() {
    return {
      name: '',
      bodyType: 'tux',
      body: 0,   // classic black
      belly: 0,  // white
      feet: 0,   // orange
      hat: 0,    // none
      eyes: 0,   // classic
      accessory: 0,
      cape: 0
    };
  }

  function randInt(n) { return Math.floor(Math.random() * n); }

  function randomCharacter() {
    return {
      name: '',
      bodyType: (Math.random() < 0.5 ? 'tux' : 'humanoid'),
      body: randInt(BODY_COLORS.length),
      belly: randInt(BELLY_COLORS.length),
      feet: randInt(FEET_COLORS.length),
      hat: randInt(HATS.length),
      eyes: randInt(EYES.length),
      accessory: randInt(ACCESSORIES.length),
      cape: randInt(CAPES.length)
    };
  }

  // sanitize coerces an arbitrary/partial character into a fully valid one so the
  // renderer never indexes out of range (bot characters, old saves, etc.).
  function sanitize(c) {
    var d = defaultCharacter();
    if (!c || typeof c !== 'object') { return d; }
    function pick(v, len, def) {
      v = (v | 0);
      if (v < 0 || v >= len) { return def; }
      return v;
    }
    return {
      name: (typeof c.name === 'string') ? c.name : '',
      bodyType: (c.bodyType === 'humanoid') ? 'humanoid' : 'tux',
      body: pick(c.body, BODY_COLORS.length, d.body),
      belly: pick(c.belly, BELLY_COLORS.length, d.belly),
      feet: pick(c.feet, FEET_COLORS.length, d.feet),
      hat: pick(c.hat, HATS.length, d.hat),
      eyes: pick(c.eyes, EYES.length, d.eyes),
      accessory: pick(c.accessory, ACCESSORIES.length, d.accessory),
      cape: pick(c.cape, CAPES.length, d.cape)
    };
  }

  // ---- Low-level pixel helpers --------------------------------------------
  //
  // The art is authored on a virtual 16x16-ish grid. We draw each "pixel" as a
  // filled rectangle. A small drawing context (P) carries the mapping from grid
  // coordinates to canvas pixels, with horizontal mirroring baked in so every
  // module can author art facing right.

  // makePen builds a pixel pen. cx,cy = canvas center; s = canvas px per grid px;
  // gw = grid width (used to mirror around the grid center); flip = -1 mirrors.
  function makePen(ctx, cx, cy, s, gw, gh, flip) {
    var halfW = gw / 2;
    var halfH = gh / 2;
    return {
      ctx: ctx,
      s: s,
      // px draws a single grid cell at (gx,gy) sized (w,h) grid cells.
      px: function (gx, gy, w, h, color) {
        if (!color) { return; }
        w = (w === undefined ? 1 : w);
        h = (h === undefined ? 1 : h);
        var lx = gx;
        if (flip < 0) { lx = gw - (gx + w); }
        var X = cx + (lx - halfW) * s;
        var Y = cy + (gy - halfH) * s;
        ctx.fillStyle = color;
        // +1 device px overdraw kills hairline seams between adjacent cells.
        ctx.fillRect(Math.round(X), Math.round(Y),
          Math.ceil(w * s) + 1, Math.ceil(h * s) + 1);
      }
    };
  }

  // ---- Public entry: dispatch on body type --------------------------------

  function drawCharacter(ctx, character, x, y, scale, facing) {
    var c = sanitize(character);
    var flip = (facing < 0) ? -1 : 1;
    if (c.bodyType === 'humanoid') {
      drawHumanoid(ctx, c, x, y, scale, flip);
    } else {
      drawTux(ctx, c, x, y, scale, flip);
    }
  }

  // =========================================================================
  // TUX — the 8-bit penguin. Grid is 16 wide x 18 tall. The classic egg body,
  // white belly oval, flippers, orange feet + beak.
  // =========================================================================
  function drawTux(ctx, c, cx, cy, scale, flip) {
    var bodyCol = BODY_COLORS[c.body];
    var bellyCol = BELLY_COLORS[c.belly];
    var feetCol = FEET_COLORS[c.feet];
    var GW = 16, GH = 18;
    // `scale` is destination px per sprite pixel of a ~16px reference; map the
    // 16-wide grid to that so size matches across body types.
    var s = scale;
    var P = makePen(ctx, cx, cy, s, GW, GH, flip);

    // Cape (behind everything).
    drawCape(P, c, GW, GH, 'tux');

    // ---- Body silhouette (rounded egg) ----
    // Row-by-row spans of the black body. Coordinates are grid cells.
    var body = [
      [6, 2, 4],   // y=2 head top
      [5, 3, 6],
      [4, 4, 8],
      [4, 5, 8],
      [3, 6, 10],
      [3, 7, 10],
      [3, 8, 10],
      [3, 9, 10],
      [3, 10, 10],
      [4, 11, 8],
      [4, 12, 8],
      [5, 13, 6]
    ];
    for (var i = 0; i < body.length; i++) {
      P.px(body[i][0], body[i][1], body[i][2], 1, bodyCol);
    }

    // ---- Belly (white oval inset) ----
    var belly = [
      [6, 6, 4],
      [5, 7, 6],
      [5, 8, 6],
      [5, 9, 6],
      [5, 10, 6],
      [6, 11, 4],
      [6, 12, 4]
    ];
    for (var b = 0; b < belly.length; b++) {
      P.px(belly[b][0], belly[b][1], belly[b][2], 1, bellyCol);
    }

    // ---- Flippers (body color, sticking out the sides) ----
    P.px(2, 7, 1, 4, bodyCol);  // left flipper
    P.px(13, 7, 1, 4, bodyCol); // right flipper

    // ---- Feet (orange) ----
    P.px(4, 14, 3, 1, feetCol);
    P.px(9, 14, 3, 1, feetCol);
    P.px(4, 15, 4, 1, feetCol);
    P.px(8, 15, 4, 1, feetCol);

    // ---- Beak (orange) ----
    P.px(7, 5, 2, 1, feetCol);
    P.px(7, 6, 2, 1, feetCol);

    // ---- Eyes ----
    // White backing patches around grid columns 6 and 9, row 4.
    drawEyes(P, c, { lx: 6, rx: 9, ey: 4, sep: 3 });

    // ---- Accessory (in front of the belly) ----
    drawAccessory(P, c, GW, GH, 'tux');

    // ---- Hat (top of head ~ rows 0-3, centered over x=8) ----
    drawHat(P, c, { topY: 0, headTop: 2, cx: 8, headW: 8 }, 'tux');
  }

  // =========================================================================
  // HUMANOID — an 8-bit person. Grid 16 wide x 18 tall: head, torso (shirt =
  // belly color), arms, legs, and shoes (feet color). `body` color tints hair
  // + sleeves/shorts so the shared palette still reads clearly.
  // =========================================================================
  function drawHumanoid(ctx, c, cx, cy, scale, flip) {
    var hairCol = BODY_COLORS[c.body];
    var shirtCol = BELLY_COLORS[c.belly];
    var shoeCol = FEET_COLORS[c.feet];
    var skinCol = '#f3c69a';
    var pantsCol = mix(hairCol, '#000000', 0.15); // slightly darker trousers
    var GW = 16, GH = 18;
    var s = scale;
    var P = makePen(ctx, cx, cy, s, GW, GH, flip);

    // Cape (behind everything).
    drawCape(P, c, GW, GH, 'humanoid');

    // ---- Head (skin) rows 2-5, centered ----
    P.px(6, 2, 4, 1, skinCol);
    P.px(5, 3, 6, 1, skinCol);
    P.px(5, 4, 6, 1, skinCol);
    P.px(5, 5, 6, 1, skinCol);
    // Neck.
    P.px(7, 6, 2, 1, skinCol);

    // ---- Hair (body color) — cap over the top + side fringe ----
    P.px(5, 1, 6, 1, hairCol);
    P.px(5, 2, 1, 1, hairCol);
    P.px(10, 2, 1, 1, hairCol);
    P.px(4, 2, 1, 2, hairCol); // left sideburn
    P.px(11, 2, 1, 2, hairCol); // right sideburn

    // ---- Torso / shirt (belly color) rows 7-11 ----
    P.px(5, 7, 6, 1, shirtCol);
    P.px(4, 8, 8, 1, shirtCol);
    P.px(4, 9, 8, 1, shirtCol);
    P.px(4, 10, 8, 1, shirtCol);
    P.px(5, 11, 6, 1, shirtCol);

    // ---- Arms (skin hands + body-color sleeves) ----
    P.px(3, 7, 1, 3, hairCol); // left sleeve
    P.px(12, 7, 1, 3, hairCol); // right sleeve
    P.px(3, 10, 1, 1, skinCol); // left hand
    P.px(12, 10, 1, 1, skinCol); // right hand

    // ---- Legs (pants) rows 12-14 ----
    P.px(5, 12, 2, 1, pantsCol);
    P.px(9, 12, 2, 1, pantsCol);
    P.px(5, 13, 2, 1, pantsCol);
    P.px(9, 13, 2, 1, pantsCol);
    P.px(5, 14, 2, 1, pantsCol);
    P.px(9, 14, 2, 1, pantsCol);

    // ---- Shoes (feet color) row 15 ----
    P.px(4, 15, 3, 1, shoeCol);
    P.px(9, 15, 3, 1, shoeCol);

    // ---- Eyes (row 4 on the face) ----
    drawEyes(P, c, { lx: 6, rx: 9, ey: 4, sep: 3 });

    // ---- Accessory (over the shirt) ----
    drawAccessory(P, c, GW, GH, 'humanoid');

    // ---- Hat (over the hair, head top ~ row 1-2) ----
    drawHat(P, c, { topY: -1, headTop: 1, cx: 8, headW: 7 }, 'humanoid');
  }

  // ---- Shared part renderers ----------------------------------------------

  // drawEyes places the eyes at the face row. `g` gives left/right eye columns,
  // eye row, and separation. Works for both bodies because positions match.
  function drawEyes(P, c, g) {
    var e = EYES[c.eyes] || EYES[0];
    var white = '#ffffff';
    var dark = '#11131c';
    switch (e.kind) {
      case 'angry':
        // Slanted brows + dot pupils.
        P.px(g.lx - 1, g.ey - 1, 2, 1, dark);
        P.px(g.rx, g.ey - 1, 2, 1, dark);
        P.px(g.lx, g.ey, 1, 1, white);
        P.px(g.rx, g.ey, 1, 1, white);
        P.px(g.lx, g.ey, 1, 1, dark);
        P.px(g.rx, g.ey, 1, 1, dark);
        break;
      case 'sleepy':
        // Half-lidded: a flat line.
        P.px(g.lx - 1, g.ey, 2, 1, dark);
        P.px(g.rx, g.ey, 2, 1, dark);
        break;
      case 'shades':
        // 8-bit sunglasses bar.
        P.px(g.lx - 1, g.ey - 1, 6, 1, dark);
        P.px(g.lx - 1, g.ey, 2, 1, dark);
        P.px(g.rx, g.ey, 2, 1, dark);
        // Glint.
        P.px(g.lx, g.ey - 1, 1, 1, '#7ff9e0');
        break;
      case 'cyclops':
        // One big central eye.
        P.px(7, g.ey - 1, 2, 3, white);
        P.px(7, g.ey, 2, 1, dark);
        break;
      case 'sparkle':
        // Bright eyes with a highlight.
        P.px(g.lx, g.ey, 1, 1, white);
        P.px(g.rx, g.ey, 1, 1, white);
        P.px(g.lx, g.ey, 1, 1, '#7ff9e0');
        P.px(g.rx, g.ey, 1, 1, '#7ff9e0');
        break;
      case 'classic':
      default:
        // Two white patches with dark pupils.
        P.px(g.lx, g.ey - 1, 1, 2, white);
        P.px(g.rx, g.ey - 1, 1, 2, white);
        P.px(g.lx, g.ey, 1, 1, dark);
        P.px(g.rx, g.ey, 1, 1, dark);
        break;
    }
  }

  // drawHat renders the chosen hat centered over the head. `h` provides topY (top
  // grid row to start), headTop (where the skull begins), cx (head center col),
  // headW (head width in cells).
  function drawHat(P, c, h, bodyType) {
    var hat = HATS[c.hat] || HATS[0];
    if (hat.kind === 'none') { return; }
    var left = h.cx - Math.floor(h.headW / 2);
    var w = h.headW;
    switch (hat.kind) {
      case 'cap':
        // Brim + dome + tiny logo.
        P.px(left, h.headTop, w, 1, hat.c1);
        P.px(left + 1, h.headTop - 1, w - 2, 1, hat.c1);
        P.px(left - 1, h.headTop + 1, w + 2, 1, hat.c2); // brim
        P.px(h.cx, h.headTop, 1, 1, hat.logo); // logo pixel
        break;
      case 'wizard':
        // Tall cone with a star.
        P.px(h.cx, h.headTop - 4, 1, 1, hat.c1);
        P.px(h.cx, h.headTop - 3, 2, 1, hat.c1);
        P.px(h.cx - 1, h.headTop - 2, 3, 1, hat.c1);
        P.px(left, h.headTop, w, 1, hat.c2); // mint brim
        P.px(left + 1, h.headTop - 1, w - 2, 1, hat.c1);
        P.px(h.cx, h.headTop - 3, 1, 1, hat.star); // star
        break;
      case 'crown':
        P.px(left + 1, h.headTop, w - 2, 1, hat.c1);
        P.px(left + 1, h.headTop - 1, 1, 1, hat.c1);
        P.px(h.cx, h.headTop - 1, 1, 1, hat.c1);
        P.px(left + w - 2, h.headTop - 1, 1, 1, hat.c1);
        P.px(h.cx, h.headTop, 1, 1, hat.gem); // center gem
        break;
      case 'beanie':
        P.px(left, h.headTop, w, 1, hat.c1);
        P.px(left + 1, h.headTop - 1, w - 2, 1, hat.c1);
        P.px(left, h.headTop + 1, w, 1, hat.c2); // fold band
        P.px(h.cx, h.headTop - 2, 1, 1, hat.c2); // pom
        break;
      case 'tophat':
        P.px(left, h.headTop + 1, w, 1, hat.c1); // brim
        P.px(left + 2, h.headTop - 3, w - 4, 4, hat.c1); // stack
        P.px(left + 2, h.headTop - 1, w - 4, 1, hat.c2); // mint band
        break;
      case 'phones':
        // Headphone band over the head + ear cups on the sides.
        P.px(left, h.headTop - 1, w, 1, hat.c1);
        P.px(left - 1, h.headTop + 1, 1, 2, hat.c2); // left cup
        P.px(left + w, h.headTop + 1, 1, 2, hat.c2); // right cup
        break;
      case 'halo':
        // Floating ring above.
        P.px(left + 1, h.headTop - 3, w - 2, 1, hat.c1);
        P.px(left, h.headTop - 3, 1, 1, hat.c2);
        P.px(left + w - 1, h.headTop - 3, 1, 1, hat.c2);
        break;
      default:
        break;
    }
  }

  // drawAccessory renders the chosen accessory over the chest/torso.
  function drawAccessory(P, c, GW, GH, bodyType) {
    var a = ACCESSORIES[c.accessory] || ACCESSORIES[0];
    if (a.kind === 'none') { return; }
    var chestY = (bodyType === 'humanoid') ? 7 : 7;
    switch (a.kind) {
      case 'bowtie':
        P.px(7, 6, 1, 1, a.c1);
        P.px(8, 6, 1, 1, a.c1);
        P.px(6, 6, 1, 1, a.c1);
        P.px(9, 6, 1, 1, a.c1);
        break;
      case 'fish':
        // Fisherman's Friend menthol tin held to the chest.
        P.px(7, chestY + 1, 3, 2, a.c1);
        P.px(7, chestY + 1, 3, 1, '#ffffff'); // label highlight
        P.px(8, chestY + 2, 1, 1, a.c2); // dark text mark
        break;
      case 'scarf':
        P.px(5, 6, 6, 1, a.c1);
        P.px(6, 7, 1, 2, a.c1); // hanging end
        break;
      case 'necklace':
        P.px(6, 6, 4, 1, a.c1);
        P.px(8, 7, 1, 1, a.c1); // pendant
        break;
      case 'badge':
        P.px(5, chestY + 1, 1, 1, a.c1);
        P.px(5, chestY, 1, 1, '#ffffff');
        break;
      default:
        break;
    }
  }

  // drawCape renders a flowing cape BEHIND the body. Anchored at the shoulders,
  // flaring down and slightly back (toward the mirrored side).
  function drawCape(P, c, GW, GH, bodyType) {
    var cp = CAPES[c.cape] || CAPES[0];
    if (cp.kind === 'none') { return; }
    // Cape billows to the LEFT in art space (the trailing edge). Because the pen
    // mirrors on facing, it naturally trails behind whichever way we face.
    var topY = (bodyType === 'humanoid') ? 7 : 6;
    P.px(2, topY, 3, 1, cp.c1);
    P.px(1, topY + 1, 4, 1, cp.c1);
    P.px(1, topY + 2, 4, 1, cp.c2);
    P.px(0, topY + 3, 4, 1, cp.c1);
    P.px(0, topY + 4, 4, 1, cp.c2);
    P.px(1, topY + 5, 3, 1, cp.c1);
    P.px(2, topY + 6, 2, 1, cp.c2);
  }

  // ---- color utility -------------------------------------------------------
  // mix blends two #rrggbb colors by t in [0,1] (0 => a, 1 => b).
  function mix(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    var r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
    var g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
    var bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function hexToRgb(h) {
    if (h[0] === '#') { h = h.slice(1); }
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  return {
    PARTS: PARTS,
    defaultCharacter: defaultCharacter,
    randomCharacter: randomCharacter,
    sanitize: sanitize,
    drawCharacter: drawCharacter
  };
})();

window.Sprites = Sprites;
