// blocks.js — voxel block registry + procedural 16×16 px texture atlas.
//
// Single global: Blocks.
//
// The registry pins the 34 stable block ids from Part I's architecture
// contract §4 (0 = air … 33 = lozenge) PLUS the Part III (ARCHITECTURE-
// COMBAT.md §3) expansion ids 34-61 (redstone/lapis/emerald/ancient-debris
// ores, granite/diorite/andesite stone variants, clay/terracotta, mossy
// cobble, ice/packed ice, cactus/melon/pumpkin/mushrooms/vine, 6 more wool
// colors, and 4 decorative deep-cave/novelty blocks) PLUS id 62 (`flowing_
// water`, contract §13a's liquid-flow fix — registered here on behalf of a
// sibling agent's world.js, which needed this id but has no public hook
// into this file's registry; see the add() call for id 62 for the full
// cross-agent coordination note). Ids are stable and never renumbered — new
// ids only ever append. Every def carries the full flag set the mesher,
// physics and HUD need:
//   def = { id, key, name, i18nKey, solid, opaque, liquid, cross, cutout,
//           translucent, hardness, emissive, placeable, drops,
//           tiles: {top, side, bottom} }
// UI name lookup: I18n.t(def.i18nKey, def.name) — i18nKey = 'vox.block.<key>'.
//
// The texture atlas is drawn 100% procedurally on a 256×256 offscreen canvas
// (16×16 tiles of 16×16 px, hand-crafted pixel patterns + deterministic
// per-pixel hash noise — no external images, ever). Blocks.buildAtlas(gl)
// uploads it NEAREST/NEAREST without mips and returns half-texel-inset tile
// UVs so neighbouring tiles never bleed. 63 tiles now used of the 256-slot
// (16×16 tile) grid — ATLAS_TILES stays 16, there was already headroom.
//
// Depends on: nothing (I18n is optional and guarded — only Blocks.nameOf
// touches it; consumers normally call I18n.t(def.i18nKey, def.name) directly).

var Blocks = (function () {

  // ---- atlas constants ----
  var ATLAS_TILES = 16;              // tiles per atlas row/column
  var TILE = 16;                     // px per tile edge
  var ATLAS_PX = ATLAS_TILES * TILE; // 256

  // ---- deterministic per-pixel hash noise ----
  // Integer avalanche keyed by (tile, x, y, salt); same art on every machine.
  function rand(tile, x, y, salt) {
    var h = Math.imul(tile, 0x9E3779B1) ^ Math.imul(x, 0x85EBCA6B) ^
            Math.imul(y, 0xC2B2AE35) ^ Math.imul(salt, 0x27D4EB2F);
    h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
    h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  // ---- tiny color helpers ----
  function sh(col, f) { // scaled copy; Uint8ClampedArray clamps on write
    return [col[0] * f, col[1] * f, col[2] * f];
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t];
  }

  // ---- atlas tile index map ----
  var T = {
    GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, COBBLE: 4, BEDROCK: 5,
    LOG_SIDE: 6, LOG_TOP: 7, PLANKS: 8, LEAVES: 9, SAND: 10, GRAVEL: 11,
    WATER: 12, GLASS: 13, BRICK: 14, BOOKSHELF: 15, GLOWSTONE: 16,
    COAL_ORE: 17, IRON_ORE: 18, GOLD_ORE: 19, DIAMOND_ORE: 20,
    SNOW_TOP: 21, SNOW_SIDE: 22,
    WOOL_WHITE: 23, WOOL_RED: 24, WOOL_GREEN: 25, WOOL_BLUE: 26,
    WOOL_YELLOW: 27, WOOL_BLACK: 28,
    FLOWER_RED: 29, FLOWER_YELLOW: 30, TALLGRASS: 31,
    SANDSTONE_TOP: 32, SANDSTONE_SIDE: 33, OBSIDIAN: 34,
    TUX_FACE: 35, TUX_TOP: 36, LOZENGE: 37,

    // -- Part III additions (§3): new ids 34-61, new tiles 38+ --
    REDSTONE_ORE: 38, LAPIS_ORE: 39, EMERALD_ORE: 40, ANCIENT_DEBRIS: 41,
    GRANITE: 42, DIORITE: 43, ANDESITE: 44,
    CLAY: 45, TERRACOTTA: 46, MOSSY_COBBLE: 47,
    ICE: 48, PACKED_ICE: 49,
    CACTUS_TOP: 50, CACTUS_SIDE: 51,
    MELON_TOP: 52, MELON_SIDE: 53,
    PUMPKIN_TOP: 54, PUMPKIN_SIDE: 55,
    MUSHROOM_RED_TOP: 56, MUSHROOM_RED_SIDE: 57,
    MUSHROOM_BROWN_TOP: 58, MUSHROOM_BROWN_SIDE: 59,
    VINE: 60,
    WOOL_ORANGE: 61, WOOL_PURPLE: 62, WOOL_CYAN: 63,
    WOOL_PINK: 64, WOOL_GRAY: 65, WOOL_LIGHTGRAY: 66,
    TNT_LOZENGE: 67, END_STONE: 68, BASALT: 69, QUARTZ_BLOCK: 70,

    // -- §13a liquid-flow fix: flowing_water is block id 62 (next free id
    // after this section's own top, 61 = quartz_block) -- see the big
    // integration note in world.js (owned by a sibling agent in this build
    // wave) for why the id landed here; this IS that coordination landing. --
    FLOWING_WATER: 71
  };

  // ================================================================
  // ---- tile painters --------------------------------------------
  // Each painter gets put(x,y,[r,g,b],a=255) in tile-local 0..15 coords
  // and R(x,y,salt) -> deterministic [0,1). Unwritten pixels stay alpha 0.
  // ================================================================

  // -- generic three-shade speckle (dirt, sand, snow, ...) --
  function speckle(base, dark, light, dLo, lHi, jitter) {
    return function (put, R) {
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        var r = R(x, y, 1);
        var col = base;
        if (r < dLo) col = dark; else if (r > lHi) col = light;
        var f = 1 + (R(x, y, 2) - 0.5) * 2 * jitter;
        put(x, y, sh(col, f));
      }
    };
  }

  // -- string-map painter for hand-drawn tiles --
  // legend: char -> {c:[r,g,b], a?:alpha, j?:jitter}. '.' or missing = skip.
  function mapPainter(rows, legend, baseJitter) {
    return function (put, R) {
      for (var y = 0; y < 16; y++) {
        var row = rows[y];
        for (var x = 0; x < 16; x++) {
          var e = legend[row.charAt(x)];
          if (!e) continue;
          var j = (e.j === undefined) ? (baseJitter || 0.05) : e.j;
          var f = 1 + (R(x, y, 3) - 0.5) * 2 * j;
          put(x, y, sh(e.c, f), e.a === undefined ? 255 : e.a);
        }
      }
    };
  }

  // -- terrain painters --
  function paintGrassTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var r = R(x, y, 1);
      var col = [88, 201, 62];                       // vibrant lawn green
      if (r < 0.22) col = [70, 168, 50];
      else if (r > 0.86) col = [111, 216, 74];
      var f = 1 + (R(x, y, 2) - 0.5) * 0.12;
      put(x, y, sh(col, f));
      if (R(x, y, 7) > 0.95) put(x, y, [156, 236, 108]); // sunlit blade tips
    }
  }

  function paintDirt(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var r = R(x, y, 1);
      var col = [155, 107, 68];
      if (r < 0.2) col = [124, 82, 48];
      else if (r > 0.86) col = [185, 137, 92];
      var f = 1 + (R(x, y, 2) - 0.5) * 0.14;
      put(x, y, sh(col, f));
      if (R(x, y, 5) > 0.965) put(x, y, [143, 133, 120]); // tiny pebbles
    }
  }

  function paintGrassSide(put, R) {
    paintDirt(put, R);
    // ragged grass cap hanging over the dirt
    for (var x = 0; x < 16; x++) {
      var depth = 2;
      if (R(x, 0, 21) > 0.3) depth = 3;
      if (R(x, 0, 22) > 0.75) depth = 4;
      for (var y = 0; y < depth; y++) {
        var col = (R(x, y, 23) < 0.25) ? [62, 148, 48] : [76, 178, 56];
        put(x, y, sh(col, 1 + (R(x, y, 24) - 0.5) * 0.12));
      }
    }
  }

  function paintStone(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 2, y >> 2, 11) + (R(x, y, 12) - 0.5) * 0.25; // soft blotches
      var col = [139, 142, 148];
      if (q < 0.33) col = [126, 129, 135];
      else if (q > 0.75) col = [152, 155, 160];
      var f = 1 + (R(x, y, 13) - 0.5) * 0.08;
      put(x, y, sh(col, f));
      if (R(x, y, 14) > 0.97) put(x, y, [106, 109, 115]); // hairline cracks
    }
  }

  function paintCobble(put, R) {
    // seamless 4×4-cell torus Voronoi -> rounded stones with dark mortar
    var CS = 4, G = 4, px = [], py = [];
    var cx, cy;
    for (cy = 0; cy < G; cy++) for (cx = 0; cx < G; cx++) {
      px[cy * G + cx] = 0.5 + R(cx, cy, 61) * 3;   // local pos inside cell
      py[cy * G + cx] = 0.5 + R(cx, cy, 62) * 3;
    }
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var pcx = (x / CS) | 0, pcy = (y / CS) | 0;
      var d1 = 1e9, d2 = 1e9, own = 0;
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        var gx = ((pcx + ox) % G + G) % G, gy = ((pcy + oy) % G + G) % G;
        var sx = (pcx + ox) * CS + px[gy * G + gx];
        var sy = (pcy + oy) * CS + py[gy * G + gx];
        var dd = (x + 0.5 - sx) * (x + 0.5 - sx) + (y + 0.5 - sy) * (y + 0.5 - sy);
        if (dd < d1) { d2 = d1; d1 = dd; own = gy * G + gx; }
        else if (dd < d2) { d2 = dd; }
      }
      if (Math.sqrt(d2) - Math.sqrt(d1) < 0.9) {
        put(x, y, sh([85, 87, 92], 1 + (R(x, y, 63) - 0.5) * 0.16)); // mortar
      } else {
        var s = 0.84 + R(own & 3, own >> 2, 64) * 0.28;              // per-stone shade
        put(x, y, sh([148, 151, 157], s * (1 + (R(x, y, 65) - 0.5) * 0.1)));
      }
    }
  }

  function paintBedrock(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 1, y >> 1, 9);
      var col = [102, 102, 110];
      if (q < 0.25) col = [38, 38, 43];
      else if (q < 0.5) col = [58, 58, 65];
      else if (q < 0.78) col = [78, 78, 86];
      var f = 1 + (R(x, y, 10) - 0.5) * 0.16;
      put(x, y, sh(col, f));
      if (R(x, y, 11) < 0.05) put(x, y, [26, 26, 30]); // black pits
    }
  }

  function paintLogSide(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var stag = (y & 4) ? 1 : 0;                 // stagger every 4 rows
      var p = (x + stag) % 4;
      var col = [122, 83, 48];                    // bark base
      if (p === 0) col = [94, 62, 32];            // groove
      else if (p === 2) col = [139, 98, 56];      // ridge highlight
      var f = 1 + (R(x, y, 55) - 0.5) * 0.14;
      put(x, y, sh(col, f));
      if (R(x, y, 56) < 0.015) put(x, y, [74, 48, 22]); // knots
    }
  }

  function paintLogTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      var col;
      if (d > 6.5) col = [110, 74, 40];                              // bark rim
      else if (d < 1.5) col = [138, 98, 56];                         // heartwood
      else col = (Math.floor(d) & 1) ? [168, 127, 76] : [201, 164, 107]; // rings
      var f = 1 + (R(x, y, 57) - 0.5) * 0.1;
      put(x, y, sh(col, f));
    }
  }

  function paintPlanks(put, R) {
    var joints = [12, 4, 9, 1];                    // staggered board ends
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var band = y >> 2;
      var col = [200, 145, 88];
      if ((y & 3) === 3 || x === joints[band]) col = [126, 90, 51];  // seams
      else if (R((x + band * 3) >> 1, y, 31) < 0.14) col = [179, 127, 73]; // grain
      else if (R(x, y, 32) > 0.93) col = [222, 168, 106];            // shine
      put(x, y, sh(col, 1 + (R(x, y, 33) - 0.5) * 0.08));
    }
    // nail dots near each board end
    for (var b = 0; b < 4; b++) {
      put((joints[b] + 2) & 15, b * 4 + 1, [107, 74, 38]);
      put((joints[b] + 14) & 15, b * 4 + 2, [107, 74, 38]);
    }
  }

  function paintLeaves(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      if (R(x, y, 41) < 0.16) continue;            // cutout holes (alpha 0)
      var r = R(x, y, 42);
      var col = [63, 158, 44];
      if (r < 0.3) col = [46, 122, 34];
      else if (r > 0.82) col = [88, 194, 60];
      var f = 1 + (R(x, y, 43) - 0.5) * 0.12;
      put(x, y, sh(col, f));
      if (R(x, y, 44) > 0.96) put(x, y, [124, 224, 90]); // glinting leaves
    }
  }

  function paintWater(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var w = Math.sin((y + Math.sin(x * 0.7) * 1.5) * 1.2);
      var col = [62, 111, 216];
      if (w > 0.55) col = [92, 140, 236];          // crest highlights
      else if (w < -0.55) col = [49, 88, 184];     // troughs
      var f = 1 + (R(x, y, 45) - 0.5) * 0.06;
      put(x, y, sh(col, f));
      if (R(x, y, 46) > 0.97) put(x, y, [168, 204, 250]); // sparkle
    }
  }

  // -- flowing_water (id 62, §13a liquid-flow fix): same water palette, but
  // a higher-frequency, two-axis wave interference + extra jitter/sparkle
  // reads as visibly more agitated/turbulent than calm source water, per
  // the contract's "same tile art tinted slightly more turbulent" note. --
  function paintFlowingWater(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var w = Math.sin((y * 1.6 + Math.sin(x * 1.3) * 2.4) * 1.7) * 0.6 +
              Math.sin((x * 1.4 - y * 0.5) * 1.9) * 0.4;             // choppier interference
      var col = [62, 111, 216];
      if (w > 0.45) col = [100, 150, 244];         // brighter, more frequent crests
      else if (w < -0.45) col = [44, 80, 172];      // deeper troughs
      var f = 1 + (R(x, y, 145) - 0.5) * 0.10;      // wider jitter than still water
      put(x, y, sh(col, f));
      if (R(x, y, 146) > 0.93) put(x, y, [176, 210, 252]); // more frequent sparkle/foam
    }
  }

  function paintGlass(put, R) {
    var x, y;
    for (y = 0; y < 16; y++) for (x = 0; x < 16; x++) {
      if (x === 0 || x === 15 || y === 0 || y === 15) {
        var corner = (x === 0 || x === 15) && (y === 0 || y === 15);
        var col = corner ? [185, 206, 218] : [217, 233, 241];
        put(x, y, sh(col, 1 + (R(x, y, 47) - 0.5) * 0.06));
      }
      // interior stays alpha 0 -> cutout discard
    }
    // opaque diagonal sparkle streaks
    var sp = [[2, 5], [3, 4], [4, 3], [5, 2], [11, 13], [12, 12], [13, 11]];
    for (var i = 0; i < sp.length; i++) put(sp[i][0], sp[i][1], [244, 251, 254]);
  }

  function paintBrick(put, R) {
    var reds = [[166, 68, 56], [181, 79, 60], [158, 62, 51]];
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var band = y >> 2;
      var off = (band & 1) * 4;
      if ((y & 3) === 3 || ((x + off) & 7) === 7) {
        put(x, y, sh([207, 197, 184], 1 + (R(x, y, 48) - 0.5) * 0.08)); // mortar
      } else {
        var cell = ((x + off) >> 3) + band * 3;
        var col = reds[(R(cell, band, 49) * 3) | 0];
        var f = 1 + (R(x, y, 50) - 0.5) * 0.1;
        if (R(x, y, 51) < 0.06) f *= 0.82;         // fired flecks
        put(x, y, sh(col, f));
      }
    }
  }

  function paintBookshelf(put, R) {
    var x, y, i;
    // wooden frame rows + shelf board
    function woodRow(y, base) {
      for (var x = 0; x < 16; x++) {
        put(x, y, sh(base, 1 + (R(x, y, 52) - 0.5) * 0.1));
      }
    }
    woodRow(0, [185, 135, 86]); woodRow(1, [171, 122, 76]);
    woodRow(7, [192, 139, 82]); woodRow(8, [122, 83, 48]);
    woodRow(14, [171, 122, 76]); woodRow(15, [151, 106, 64]);
    // book spines (deterministic widths/colors, dark gaps)
    var spines = [
      [178, 58, 58], [58, 98, 176], [58, 160, 90], [201, 160, 58],
      [122, 74, 160], [201, 106, 58], [232, 224, 208]
    ];
    function bookRow(yTop, salt) {
      var x = 0;
      while (x < 16) {
        if (R(x, yTop, salt) < 0.13) {             // slim dark gap
          for (var yy = yTop; yy <= yTop + 4; yy++) put(x, yy, [26, 20, 14]);
          x += 1; continue;
        }
        var w = 2 + ((R(x, yTop, salt + 1) * 2) | 0);
        if (x + w > 16) w = 16 - x;
        var col = spines[(R(x, yTop, salt + 2) * spines.length) | 0];
        for (var xi = 0; xi < w; xi++) {
          var f = (xi === w - 1) ? 0.72 : (xi === 0 ? 1.08 : 1.0);
          for (var y2 = yTop; y2 <= yTop + 4; y2++) {
            put(x + xi, y2, sh(col, f * (0.95 + R(x + xi, y2, salt + 3) * 0.1)));
          }
        }
        if (R(x, yTop, salt + 4) > 0.5) {          // gold title band
          for (xi = 0; xi < w; xi++) put(x + xi, yTop + 1, [232, 205, 120]);
        }
        x += w;
      }
    }
    bookRow(2, 71);
    bookRow(9, 81);
    // the one wide vim book on the lower shelf, with a tiny white :wq
    for (y = 9; y <= 13; y++) for (x = 4; x <= 13; x++) {
      var f2 = (x === 13) ? 0.7 : (x === 4 ? 1.12 : 1.0);
      put(x, y, sh([46, 52, 64], f2 * (0.95 + R(x, y, 91) * 0.1)));
    }
    var wq = [
      [5, 10], [5, 12],                            // :
      [7, 10], [7, 11], [7, 12], [8, 12], [9, 10], [9, 11], [9, 12], // w
      [11, 10], [12, 10], [11, 11], [12, 11], [12, 12], [12, 13]     // q
    ];
    for (i = 0; i < wq.length; i++) put(wq[i][0], wq[i][1], [232, 232, 232]);
  }

  function paintGlowstone(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 2, y >> 2, 7) * 0.7 + R(x >> 1, y >> 1, 8) * 0.3;
      var col = [235, 178, 68];
      if (q < 0.25) col = [192, 138, 46];          // amber mottling
      else if (q > 0.85) col = [255, 240, 166];    // hot cores
      else if (q > 0.6) col = [251, 217, 106];
      var f = 1 + (R(x, y, 15) - 0.5) * 0.1;
      put(x, y, sh(col, f));
      if (R(x, y, 16) > 0.965) put(x, y, [255, 251, 226]); // sparks
    }
  }

  // -- ores: stone base + colored nugget clusters (first px = highlight) --
  var ORE_CLUSTERS = [
    [[2, 3], [3, 3], [2, 4], [3, 4]],
    [[10, 2], [11, 2], [11, 3]],
    [[6, 7], [7, 7], [6, 8], [7, 8], [8, 8]],
    [[12, 10], [13, 10], [12, 11], [13, 11]],
    [[3, 12], [4, 12], [4, 13]],
    [[8, 13], [9, 13]]
  ];
  function orePainter(base, hi) {
    return function (put, R) {
      paintStone(put, R);
      for (var c = 0; c < ORE_CLUSTERS.length; c++) {
        var cl = ORE_CLUSTERS[c];
        for (var i = 0; i < cl.length; i++) {
          var col = (i === 0) ? hi : base;
          put(cl[i][0], cl[i][1], sh(col, 1 + (R(cl[i][0], cl[i][1], 18) - 0.5) * 0.12));
        }
      }
    };
  }

  function paintSnowSide(put, R) {
    paintDirt(put, R);
    for (var x = 0; x < 16; x++) {
      var depth = 2;
      if (R(x, 0, 25) > 0.35) depth = 3;
      if (R(x, 0, 26) > 0.8) depth = 4;
      for (var y = 0; y < depth; y++) {
        var r = R(x, y, 27);
        var col = (r < 0.25) ? [230, 238, 247] : (r > 0.8 ? [255, 255, 255] : [243, 248, 252]);
        put(x, y, sh(col, 1 + (R(x, y, 28) - 0.5) * 0.04));
      }
    }
  }

  function woolPainter(base) {
    return function (put, R) {
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        var u = x & 3, v = y & 3;
        var f = 1;
        if (u === 0 || v === 0) f = 0.85;          // woven grid shadow
        else if (u === 2 && v === 2) f = 1.12;     // thread highlight
        if (R(x, y, 19) > 0.93) f *= 1.1;          // fluff
        f *= 0.95 + R(x, y, 20) * 0.1;
        put(x, y, sh(base, f));
      }
    };
  }

  // -- cross-quad plants (transparent background) --
  var FLOWER_ROWS = [
    "................",
    "......PpP.......",
    ".....PpppP......",
    ".....ppypp......",
    ".....PpppP......",
    "......PpP.......",
    ".......g........",
    ".......g........",
    ".......gl.......",
    "......lg........",
    ".......g........",
    ".......g........",
    ".......g........",
    ".......g........",
    ".......g........",
    ".......G........"
  ];
  function flowerLegend(petal, petalDark, center) {
    return {
      p: { c: petal, j: 0.1 },
      P: { c: petalDark, j: 0.1 },
      y: { c: center, j: 0.08 },
      g: { c: [62, 138, 42], j: 0.1 },
      G: { c: [47, 107, 32], j: 0.1 },
      l: { c: [79, 168, 52], j: 0.1 }
    };
  }

  function paintTallgrass(put, R) {
    // deterministic blades: [x, height, topLean]
    var blades = [
      [1, 6, -1], [3, 10, 1], [5, 7, -1], [7, 12, 1],
      [9, 8, -1], [11, 11, 1], [13, 6, 1], [14, 9, -1]
    ];
    for (var b = 0; b < blades.length; b++) {
      var bx = blades[b][0], bh = blades[b][1], lean = blades[b][2];
      for (var k = 0; k < bh; k++) {
        var y = 15 - k;
        var xx = (k >= bh * 0.6) ? bx + lean : bx;
        if (xx < 0 || xx > 15) continue;
        var col = mix([46, 106, 32], [104, 196, 66], k / bh);
        put(xx, y, sh(col, 1 + (R(xx, y, 29) - 0.5) * 0.16));
      }
    }
  }

  function paintSandstoneTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      if (x === 0 || x === 15 || y === 0 || y === 15) {
        put(x, y, sh([216, 196, 136], 1 + (R(x, y, 66) - 0.5) * 0.08));
        continue;
      }
      var r = R(x, y, 67);
      var col = [237, 220, 164];
      if (r < 0.2) col = [222, 203, 140];
      else if (r > 0.88) col = [246, 235, 192];
      put(x, y, sh(col, 1 + (R(x, y, 68) - 0.5) * 0.06));
    }
  }

  function paintSandstoneSide(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var col;
      if (y <= 1) col = [242, 228, 178];           // smooth cap band
      else if (y === 2) col = [228, 210, 152];
      else if (y === 3 || y === 12) col = [201, 178, 116]; // carved lines
      else if (y <= 11) {
        col = (R(x >> 2, (y - 4) >> 2, 71) > 0.7) ? [218, 195, 134] : [233, 215, 158];
        if (R(x, 0, 72) > 0.93 && (y & 1)) col = [205, 182, 121];   // fissures
      } else col = [224, 204, 148];
      put(x, y, sh(col, 1 + (R(x, y, 73) - 0.5) * 0.08));
    }
  }

  function paintObsidian(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 2, y >> 2, 5);
      var col = [26, 18, 32];
      if (q > 0.88) col = [71, 43, 94];            // violet veins
      else if (q > 0.62) col = [46, 30, 62];
      else if (q < 0.15) col = [14, 10, 20];
      var f = 1 + (R(x, y, 6) - 0.5) * 0.12;
      put(x, y, sh(col, f));
      if (R(x, y, 34) > 0.968) put(x, y, [122, 78, 168]); // glassy sheen
    }
  }

  // -- brand blocks --
  var TUX_ROWS = [
    "kkkkkkkkkkkkkkkk",
    "kkkkkkkkkkkkkkkk",
    "kkkeeekkkkeeekkk",
    "kkkepekkkkepekkk",
    "kkkeeekkkkeeekkk",
    "kkkkkooooookkkkk",
    "kkkkkkOOOOkkkkkk",
    "kkkkwwwwwwwwkkkk",
    "kkkwwwwwwwwwwkkk",
    "kkkwwwwwwwwwwkkk",
    "kkwwwwwwwwwwwwkk",
    "kkwwwwwwwwwwwwkk",
    "kkwwwwwwwwwwwwkk",
    "kkkwwwwwwwwwwkkk",
    "kkkkwwwwwwwwkkkk",
    "kkkkkkkkkkkkkkkk"
  ];
  var TUX_LEGEND = {
    k: { c: [22, 22, 28], j: 0.14 },
    e: { c: [242, 242, 242], j: 0.03 },
    p: { c: [16, 16, 20], j: 0.05 },
    o: { c: [245, 166, 35], j: 0.08 },
    O: { c: [208, 126, 18], j: 0.08 },
    w: { c: [239, 242, 244], j: 0.05 }
  };

  function paintTuxTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var col;
      if (x === 0 || x === 15 || y === 0 || y === 15) col = [15, 15, 19];
      else col = (R(x >> 2, y >> 2, 3) > 0.7) ? [35, 35, 43] : [23, 23, 29];
      put(x, y, sh(col, 1 + (R(x, y, 4) - 0.5) * 0.16));
    }
  }

  function paintLozenge(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var dx = (x - 7.5) / 6.8, dy = (y - 7.5) / 4.6;
      var d = dx * dx + dy * dy;
      var col;
      if (d > 1) {                                  // porcelain-white ground
        col = (R(x, y, 35) > 0.9) ? [234, 246, 240] : [248, 251, 250];
      } else if (d > 0.78) col = [158, 216, 192];   // lozenge rim
      else if (d > 0.4) col = [198, 238, 221];
      else if (d < 0.12) col = [242, 252, 248];     // glossy center
      else col = [226, 248, 238];
      if ((y === 7 || y === 8) && d < 0.5) col = sh(col, 0.94); // score line
      put(x, y, sh(col, 1 + (R(x, y, 36) - 0.5) * 0.06));
    }
  }

  // ================================================================
  // ---- Part III tile painters (contract §3, new ids 34-61) -------
  // Same procedural hand-drawn-in-code style + palette philosophy as
  // the block above: speckle/blotch bases, deterministic hash jitter,
  // half-texel-inset UVs (handled globally by tileUV(), unchanged).
  // ================================================================

  // -- redstone/lapis/emerald/ancient-debris ore: reuse the ore cluster
  //    layout but on top of a stone base painted fresh (own salts so the
  //    blotch pattern differs slightly from the vanilla-tier ores). --
  function orePainterAlt(base, hi, saltOff) {
    return function (put, R) {
      paintStone(put, function (x, y, salt) { return R(x, y, salt + saltOff); });
      for (var c = 0; c < ORE_CLUSTERS.length; c++) {
        var cl = ORE_CLUSTERS[c];
        for (var i = 0; i < cl.length; i++) {
          var col = (i === 0) ? hi : base;
          put(cl[i][0], cl[i][1], sh(col, 1 + (R(cl[i][0], cl[i][1], 18 + saltOff) - 0.5) * 0.12));
        }
      }
    };
  }

  // ancient debris: darker, sparser stone base (deep-cave feel) + a couple
  // of warm bronze fleck clusters rather than a bright gem cluster.
  function paintAncientDebris(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 2, y >> 2, 201) + (R(x, y, 202) - 0.5) * 0.25;
      var col = [58, 48, 46];
      if (q < 0.33) col = [44, 36, 35];
      else if (q > 0.75) col = [70, 58, 55];
      put(x, y, sh(col, 1 + (R(x, y, 203) - 0.5) * 0.08));
    }
    var clusters = [[3, 3], [4, 4], [11, 3], [12, 4], [4, 11], [11, 12], [12, 11]];
    for (var c = 0; c < clusters.length; c++) {
      var cx2 = clusters[c][0], cy2 = clusters[c][1];
      put(cx2, cy2, sh([168, 118, 74], 1 + (R(cx2, cy2, 204) - 0.5) * 0.15));
    }
  }

  // -- granite/diorite/andesite: stone-family blotch base recolored per
  //    variant, plus a scatter of contrasting mineral flecks. --
  function stoneVariantPainter(base, dark, light, fleck, saltOff) {
    return function (put, R) {
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        var q = R(x >> 1, y >> 1, 210 + saltOff) + (R(x, y, 211 + saltOff) - 0.5) * 0.3;
        var col = base;
        if (q < 0.32) col = dark;
        else if (q > 0.72) col = light;
        var f = 1 + (R(x, y, 212 + saltOff) - 0.5) * 0.1;
        put(x, y, sh(col, f));
        if (R(x, y, 213 + saltOff) > 0.9) put(x, y, sh(fleck, 0.9 + R(x, y, 214 + saltOff) * 0.2));
      }
    };
  }

  // -- clay: cool pale-gray-blue, tight speckle --
  function paintClay(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var r = R(x, y, 220);
      var col = [163, 173, 186];
      if (r < 0.25) col = [147, 158, 172];
      else if (r > 0.85) col = [181, 190, 201];
      put(x, y, sh(col, 1 + (R(x, y, 221) - 0.5) * 0.07));
    }
  }

  // -- terracotta: warm baked-clay orange with darker mortar-like flecks --
  function paintTerracotta(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 1, y >> 1, 222);
      var col = [178, 103, 73];
      if (q < 0.3) col = [156, 86, 60];
      else if (q > 0.75) col = [196, 122, 89];
      var f = 1 + (R(x, y, 223) - 0.5) * 0.1;
      put(x, y, sh(col, f));
      if (R(x, y, 224) > 0.965) put(x, y, [122, 66, 46]); // fired specks
    }
  }

  // -- mossy cobble: the existing cobble pattern with patches of moss green
  //    painted into the mortar seams and onto some stones. --
  function paintMossyCobble(put, R) {
    paintCobble(put, R);
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var m = R(x >> 1, y >> 1, 230);
      if (m > 0.62) {
        var moss = mix([69, 128, 48], [98, 168, 62], R(x, y, 231));
        put(x, y, sh(moss, 1 + (R(x, y, 232) - 0.5) * 0.14));
      }
    }
  }

  // -- ice: pale translucent-blue with faint crack fracture lines --
  function paintIce(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var r = R(x, y, 240);
      var col = [178, 220, 244];
      if (r < 0.25) col = [156, 202, 232];
      else if (r > 0.85) col = [206, 236, 251];
      put(x, y, sh(col, 1 + (R(x, y, 241) - 0.5) * 0.06), 235); // slightly translucent look
    }
    // faint diagonal fracture streaks
    var lines = [[2, 1, 5], [9, 3, 6], [4, 9, 5], [11, 10, 4]];
    for (var l = 0; l < lines.length; l++) {
      var lx = lines[l][0], ly = lines[l][1], ln = lines[l][2];
      for (var k = 0; k < ln; k++) {
        var xx = lx + k, yy = ly + ((k * 3) >> 2);
        if (xx > 15 || yy > 15) break;
        put(xx, yy, sh([225, 245, 253], 0.95), 235);
      }
    }
  }

  // -- packed ice: opaque, denser variant (brighter, no translucency) --
  function paintPackedIce(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 1, y >> 1, 245);
      var col = [191, 226, 247];
      if (q < 0.3) col = [170, 210, 238];
      else if (q > 0.75) col = [214, 238, 252];
      put(x, y, sh(col, 1 + (R(x, y, 246) - 0.5) * 0.07));
      if (R(x, y, 247) > 0.95) put(x, y, [232, 247, 255]); // glinting facets
    }
  }

  // -- cactus: waxy green body with vertical rib shading + spine dots --
  function paintCactusSide(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var rib = Math.abs(((x + 2) % 5) - 2);            // 0 at rib center
      var col = [59, 140, 62];
      if (rib === 0) col = [46, 116, 50];               // rib groove
      else if (rib >= 2) col = [77, 168, 76];           // rib crest highlight
      var f = 1 + (R(x, y, 250) - 0.5) * 0.08;
      put(x, y, sh(col, f));
      if (rib === 2 && (y & 3) === 1) put(x, y, [214, 224, 176]); // spines
    }
  }
  function paintCactusTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var dx = x - 7.5, dy = y - 7.5;
      var d = Math.sqrt(dx * dx + dy * dy);
      var col;
      if (d > 7.2) col = [46, 116, 50];
      else if (d > 5.8) col = [59, 140, 62];
      else col = [82, 172, 78];
      put(x, y, sh(col, 1 + (R(x, y, 251) - 0.5) * 0.07));
    }
  }

  // -- melon: green rind with pale racing stripes on the side, mottled
  //    yellow-green flesh top (cut face look, matches Minecraft's read) --
  function paintMelonSide(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var band = ((x + 1) >> 1) & 1;
      var col = band ? [58, 140, 46] : [78, 172, 58];
      var f = 1 + (R(x, y, 255) - 0.5) * 0.08;
      put(x, y, sh(col, f));
      if (R(x, y, 256) > 0.96) put(x, y, [140, 214, 96]); // speckle
    }
  }
  function paintMelonTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 1, y >> 1, 257);
      var col = [96, 186, 68];
      if (q < 0.3) col = [78, 166, 54];
      else if (q > 0.75) col = [118, 206, 84];
      put(x, y, sh(col, 1 + (R(x, y, 258) - 0.5) * 0.07));
    }
  }

  // -- pumpkin: orange ribbed rind (side) + stem-and-rind top --
  function paintPumpkinSide(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var rib = Math.abs(((x + 2) % 4) - 2);
      var col = [219, 122, 32];
      if (rib === 0) col = [186, 98, 22];                // groove
      else if (rib >= 1.5) col = [237, 148, 52];         // ridge highlight
      var f = 1 + (R(x, y, 260) - 0.5) * 0.08;
      put(x, y, sh(col, f));
    }
  }
  function paintPumpkinTop(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var dx = x - 7.5, dy = y - 7.5;
      var d = Math.sqrt(dx * dx + dy * dy);
      var col;
      if (d > 6.5) col = [186, 98, 22];
      else if (x >= 6 && x <= 9 && y >= 2 && y <= 9) col = [111, 82, 40]; // stem
      else col = [219, 122, 32];
      put(x, y, sh(col, 1 + (R(x, y, 261) - 0.5) * 0.08));
    }
  }

  // -- mushroom blocks: spotty cap top, pore-textured underside/side --
  function mushroomTopPainter(base, dark, spot) {
    return function (put, R) {
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        var f = 1 + (R(x, y, 265) - 0.5) * 0.08;
        put(x, y, sh(base, f));
      }
      var spots = [[3, 3], [9, 2], [12, 6], [2, 9], [7, 8], [11, 12], [4, 13], [13, 13]];
      for (var i = 0; i < spots.length; i++) {
        var sx = spots[i][0], sy = spots[i][1];
        put(sx, sy, sh(spot, 1 + (R(sx, sy, 266) - 0.5) * 0.1));
        put((sx + 1) & 15, sy, sh(dark, 0.9));
      }
    };
  }
  function mushroomSidePainter(base) {
    return function (put, R) {
      for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
        var q = R(x >> 1, y >> 1, 270);
        var f = (q > 0.6) ? 0.85 : 1.0;                  // pore dimples
        put(x, y, sh(base, f * (1 + (R(x, y, 271) - 0.5) * 0.08)));
      }
    };
  }

  // -- vine: sparse hanging cutout, deep leafy green with gaps to alpha 0 --
  function paintVine(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var strand = (x + ((y * 3) >> 2)) % 5;
      if (strand > 1 && R(x, y, 275) > 0.35) continue;   // gaps -> cutout
      var col = [42, 108, 40];
      if (R(x, y, 276) > 0.8) col = [58, 138, 50];
      put(x, y, sh(col, 1 + (R(x, y, 277) - 0.5) * 0.12));
    }
  }

  // -- tnt lozenge: mint-and-red diagonal stripes (decorative, no explosion) --
  function paintTntLozenge(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var stripe = ((x + y) >> 1) & 1;
      var col = stripe ? [214, 62, 58] : [214, 240, 226];
      var f = 1 + (R(x, y, 280) - 0.5) * 0.06;
      put(x, y, sh(col, f));
    }
    // thin white lozenge outline band top/bottom (echoes T.LOZENGE branding)
    for (var x2 = 0; x2 < 16; x2++) {
      put(x2, 1, [248, 251, 250]);
      put(x2, 14, [248, 251, 250]);
    }
  }

  // -- sunset stone (reskinned end stone): pale gold-tan pitted rock --
  function paintEndStone(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 1, y >> 1, 285);
      var col = [223, 210, 164];
      if (q < 0.28) col = [206, 190, 142];
      else if (q > 0.75) col = [236, 226, 188];
      var f = 1 + (R(x, y, 286) - 0.5) * 0.08;
      put(x, y, sh(col, f));
      if (R(x, y, 287) < 0.04) put(x, y, [178, 162, 116]); // pits
    }
  }

  // -- basalt: dark banded volcanic rock, vertical striations --
  function paintBasalt(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var band = Math.abs(((x + 1) % 6) - 3);
      var col = [66, 65, 70];
      if (band === 0) col = [50, 49, 54];
      else if (band >= 2) col = [80, 79, 85];
      var f = 1 + (R(x, y, 290) - 0.5) * 0.1;
      put(x, y, sh(col, f));
      if (R(x, y, 291) > 0.97) put(x, y, [110, 108, 116]); // mineral glints
    }
  }

  // -- quartz block: bright clean white with faint vertical vein lines --
  function paintQuartzBlock(put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var col = [235, 232, 224];
      if (((x + 3) % 8) === 0) col = [219, 215, 205];    // subtle seam lines
      var f = 1 + (R(x, y, 295) - 0.5) * 0.05;
      put(x, y, sh(col, f));
      if (R(x, y, 296) > 0.94) put(x, y, [248, 246, 240]); // sheen fleck
    }
  }

  // ---- painter table (tile index -> painter fn) ----
  var PAINTERS = {};
  PAINTERS[T.GRASS_TOP] = paintGrassTop;
  PAINTERS[T.GRASS_SIDE] = paintGrassSide;
  PAINTERS[T.DIRT] = paintDirt;
  PAINTERS[T.STONE] = paintStone;
  PAINTERS[T.COBBLE] = paintCobble;
  PAINTERS[T.BEDROCK] = paintBedrock;
  PAINTERS[T.LOG_SIDE] = paintLogSide;
  PAINTERS[T.LOG_TOP] = paintLogTop;
  PAINTERS[T.PLANKS] = paintPlanks;
  PAINTERS[T.LEAVES] = paintLeaves;
  PAINTERS[T.SAND] = speckle([235, 220, 166], [217, 194, 134], [247, 236, 198], 0.22, 0.86, 0.08);
  PAINTERS[T.GRAVEL] = function (put, R) {
    for (var y = 0; y < 16; y++) for (var x = 0; x < 16; x++) {
      var q = R(x >> 1, y >> 1, 17);
      var col = [156, 148, 142];
      if (q < 0.22) col = [110, 102, 99];
      else if (q < 0.45) col = [125, 117, 113];
      else if (q < 0.75) col = [139, 131, 126];
      var f = 1 + (R(x, y, 30) - 0.5) * 0.12;
      put(x, y, sh(col, f));
      if (R(x, y, 37) < 0.07) put(x, y, [87, 80, 78]);       // crevices
      else if (R(x, y, 38) > 0.96) put(x, y, [176, 168, 160]); // quartz glints
    }
  };
  PAINTERS[T.WATER] = paintWater;
  PAINTERS[T.GLASS] = paintGlass;
  PAINTERS[T.BRICK] = paintBrick;
  PAINTERS[T.BOOKSHELF] = paintBookshelf;
  PAINTERS[T.GLOWSTONE] = paintGlowstone;
  PAINTERS[T.COAL_ORE] = orePainter([51, 51, 59], [74, 74, 85]);
  PAINTERS[T.IRON_ORE] = orePainter([216, 165, 131], [238, 199, 166]);
  PAINTERS[T.GOLD_ORE] = orePainter([245, 206, 66], [252, 232, 138]);
  PAINTERS[T.DIAMOND_ORE] = orePainter([82, 232, 216], [175, 248, 240]);
  PAINTERS[T.SNOW_TOP] = speckle([243, 248, 252], [230, 238, 247], [255, 255, 255], 0.25, 0.8, 0.04);
  PAINTERS[T.SNOW_SIDE] = paintSnowSide;
  PAINTERS[T.WOOL_WHITE] = woolPainter([233, 233, 235]);
  PAINTERS[T.WOOL_RED] = woolPainter([198, 72, 72]);
  PAINTERS[T.WOOL_GREEN] = woolPainter([74, 168, 62]);
  PAINTERS[T.WOOL_BLUE] = woolPainter([70, 102, 200]);
  PAINTERS[T.WOOL_YELLOW] = woolPainter([229, 200, 60]);
  PAINTERS[T.WOOL_BLACK] = woolPainter([42, 42, 49]);
  PAINTERS[T.FLOWER_RED] = mapPainter(FLOWER_ROWS,
    flowerLegend([216, 56, 62], [168, 40, 48], [245, 208, 64]));
  PAINTERS[T.FLOWER_YELLOW] = mapPainter(FLOWER_ROWS,
    flowerLegend([240, 200, 56], [200, 156, 40], [184, 120, 40]));
  PAINTERS[T.TALLGRASS] = paintTallgrass;
  PAINTERS[T.SANDSTONE_TOP] = paintSandstoneTop;
  PAINTERS[T.SANDSTONE_SIDE] = paintSandstoneSide;
  PAINTERS[T.OBSIDIAN] = paintObsidian;
  PAINTERS[T.TUX_FACE] = mapPainter(TUX_ROWS, TUX_LEGEND);
  PAINTERS[T.TUX_TOP] = paintTuxTop;
  PAINTERS[T.LOZENGE] = paintLozenge;

  // -- Part III additions --
  PAINTERS[T.REDSTONE_ORE] = orePainterAlt([120, 22, 18], [214, 46, 34], 300);
  PAINTERS[T.LAPIS_ORE] = orePainterAlt([32, 58, 148], [66, 108, 224], 320);
  PAINTERS[T.EMERALD_ORE] = orePainterAlt([26, 138, 84], [64, 214, 138], 340);
  PAINTERS[T.ANCIENT_DEBRIS] = paintAncientDebris;
  PAINTERS[T.GRANITE] = stoneVariantPainter([149, 103, 88], [124, 80, 66], [178, 132, 112], [214, 168, 132], 0);
  PAINTERS[T.DIORITE] = stoneVariantPainter([206, 206, 210], [180, 180, 186], [232, 232, 236], [150, 150, 158], 20);
  PAINTERS[T.ANDESITE] = stoneVariantPainter([132, 133, 138], [110, 111, 116], [154, 155, 160], [96, 97, 102], 40);
  PAINTERS[T.CLAY] = paintClay;
  PAINTERS[T.TERRACOTTA] = paintTerracotta;
  PAINTERS[T.MOSSY_COBBLE] = paintMossyCobble;
  PAINTERS[T.ICE] = paintIce;
  PAINTERS[T.PACKED_ICE] = paintPackedIce;
  PAINTERS[T.CACTUS_TOP] = paintCactusTop;
  PAINTERS[T.CACTUS_SIDE] = paintCactusSide;
  PAINTERS[T.MELON_TOP] = paintMelonTop;
  PAINTERS[T.MELON_SIDE] = paintMelonSide;
  PAINTERS[T.PUMPKIN_TOP] = paintPumpkinTop;
  PAINTERS[T.PUMPKIN_SIDE] = paintPumpkinSide;
  PAINTERS[T.MUSHROOM_RED_TOP] = mushroomTopPainter([196, 62, 56], [158, 44, 40], [238, 232, 222]);
  PAINTERS[T.MUSHROOM_RED_SIDE] = mushroomSidePainter([224, 220, 208]);
  PAINTERS[T.MUSHROOM_BROWN_TOP] = mushroomTopPainter([150, 108, 78], [122, 86, 60], [180, 158, 132]);
  PAINTERS[T.MUSHROOM_BROWN_SIDE] = mushroomSidePainter([224, 220, 208]);
  PAINTERS[T.VINE] = paintVine;
  PAINTERS[T.WOOL_ORANGE] = woolPainter([224, 138, 52]);
  PAINTERS[T.WOOL_PURPLE] = woolPainter([132, 68, 178]);
  PAINTERS[T.WOOL_CYAN] = woolPainter([56, 172, 178]);
  PAINTERS[T.WOOL_PINK] = woolPainter([232, 154, 186]);
  PAINTERS[T.WOOL_GRAY] = woolPainter([88, 90, 96]);
  PAINTERS[T.WOOL_LIGHTGRAY] = woolPainter([164, 168, 172]);
  PAINTERS[T.TNT_LOZENGE] = paintTntLozenge;
  PAINTERS[T.END_STONE] = paintEndStone;
  PAINTERS[T.BASALT] = paintBasalt;
  PAINTERS[T.QUARTZ_BLOCK] = paintQuartzBlock;
  PAINTERS[T.FLOWING_WATER] = paintFlowingWater;

  // ================================================================
  // ---- atlas canvas + GL upload ----------------------------------
  // ================================================================

  var _canvas = null;

  function atlasCanvas() {
    if (_canvas) return _canvas;
    var cv = document.createElement('canvas');
    cv.width = ATLAS_PX; cv.height = ATLAS_PX;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(ATLAS_PX, ATLAS_PX);
    var d = img.data;
    for (var tileStr in PAINTERS) {
      if (!Object.prototype.hasOwnProperty.call(PAINTERS, tileStr)) continue;
      var tile = tileStr | 0;
      var ox = (tile % ATLAS_TILES) * TILE;
      var oy = ((tile / ATLAS_TILES) | 0) * TILE;
      (function (tile, ox, oy) {
        function put(x, y, col, a) {
          if (x < 0 || x > 15 || y < 0 || y > 15) return;
          var o = ((oy + y) * ATLAS_PX + ox + x) * 4;
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2];
          d[o + 3] = (a === undefined) ? 255 : a;
        }
        function R(x, y, salt) { return rand(tile, x, y, salt | 0); }
        PAINTERS[tile](put, R);
      })(tile, ox, oy);
    }
    ctx.putImageData(img, 0, 0);
    _canvas = cv;
    return cv;
  }

  // Half-texel-inset UV rect for a tile -> [u0, v0, u1, v1]. The inset keeps
  // NEAREST sampling from ever bleeding a neighbouring tile at quad edges.
  function tileUV(i) {
    var tx = i % ATLAS_TILES;
    var ty = (i / ATLAS_TILES) | 0;
    var half = 0.5 / ATLAS_PX;
    return [
      (tx * TILE) / ATLAS_PX + half,
      (ty * TILE) / ATLAS_PX + half,
      ((tx + 1) * TILE) / ATLAS_PX - half,
      ((ty + 1) * TILE) / ATLAS_PX - half
    ];
  }

  function buildAtlas(gl) {
    var cv = atlasCanvas();
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex: tex, tileUV: tileUV };
  }

  // ================================================================
  // ---- block registry --------------------------------------------
  // ================================================================

  var DEFS = [];
  var BY_KEY = Object.create(null);

  // add(): fills contract defaults — solid/opaque true, placeable true,
  // drops = self — so entries only spell out what deviates.
  function add(o) {
    var tiles = o.tiles;
    if (typeof tiles === 'number') tiles = { top: tiles, side: tiles, bottom: tiles };
    var d = {
      id: o.id,
      key: o.key,
      name: o.name,
      i18nKey: 'vox.block.' + o.key,
      solid: o.solid !== false,
      opaque: o.opaque !== false,
      liquid: !!o.liquid,
      cross: !!o.cross,
      cutout: !!o.cutout,
      translucent: !!o.translucent,
      hardness: (o.hardness === undefined) ? 1 : o.hardness,
      emissive: o.emissive || 0,
      placeable: o.placeable !== false,
      drops: (o.drops === undefined) ? o.id : o.drops,
      tiles: tiles
    };
    DEFS[d.id] = d;
    BY_KEY[d.key] = d;
  }

  // The full §4 table. Ids are stable Uint8 values — never reorder.
  add({ id: 0, key: 'air', name: 'Air', solid: false, opaque: false, hardness: 0, placeable: false, drops: 0, tiles: 0 });
  add({ id: 1, key: 'grass', name: 'Grass Block', hardness: 0.9, drops: 2, tiles: { top: T.GRASS_TOP, side: T.GRASS_SIDE, bottom: T.DIRT } });
  add({ id: 2, key: 'dirt', name: 'Dirt', hardness: 0.75, tiles: T.DIRT });
  add({ id: 3, key: 'stone', name: 'Stone', hardness: 2.5, drops: 4, tiles: T.STONE });
  add({ id: 4, key: 'cobble', name: 'Cobblestone', hardness: 3.0, tiles: T.COBBLE });
  add({ id: 5, key: 'bedrock', name: 'Bedrock', hardness: Infinity, placeable: false, tiles: T.BEDROCK });
  add({ id: 6, key: 'log', name: 'Tux Log', hardness: 1.5, tiles: { top: T.LOG_TOP, side: T.LOG_SIDE, bottom: T.LOG_TOP } });
  add({ id: 7, key: 'planks', name: 'Planks', hardness: 1.5, tiles: T.PLANKS });
  add({ id: 8, key: 'leaves', name: 'Leaves', opaque: false, cutout: true, hardness: 0.3, tiles: T.LEAVES });
  add({ id: 9, key: 'sand', name: 'Sand', hardness: 0.75, tiles: T.SAND });
  add({ id: 10, key: 'gravel', name: 'Gravel', hardness: 0.9, tiles: T.GRAVEL });
  add({ id: 11, key: 'water', name: 'Water', solid: false, opaque: false, liquid: true, translucent: true, hardness: Infinity, placeable: false, drops: 0, tiles: T.WATER });
  add({ id: 12, key: 'glass', name: 'Glass', opaque: false, cutout: true, hardness: 0.4, tiles: T.GLASS });
  add({ id: 13, key: 'brick', name: 'Brick', hardness: 3.0, tiles: T.BRICK });
  add({ id: 14, key: 'bookshelf', name: 'vim Shelf', hardness: 1.8, tiles: { top: T.PLANKS, side: T.BOOKSHELF, bottom: T.PLANKS } });
  add({ id: 15, key: 'glowstone', name: 'Menthol Lamp', hardness: 0.5, emissive: 1.0, tiles: T.GLOWSTONE });
  add({ id: 16, key: 'coal_ore', name: 'Coal Ore', hardness: 3.0, tiles: T.COAL_ORE });
  add({ id: 17, key: 'iron_ore', name: 'Iron Ore', hardness: 3.5, tiles: T.IRON_ORE });
  add({ id: 18, key: 'gold_ore', name: 'Gold Ore', hardness: 3.5, tiles: T.GOLD_ORE });
  add({ id: 19, key: 'diamond_ore', name: 'Diamond Ore', hardness: 4.0, tiles: T.DIAMOND_ORE });
  add({ id: 20, key: 'snow_grass', name: 'Snowy Grass', hardness: 0.9, tiles: { top: T.SNOW_TOP, side: T.SNOW_SIDE, bottom: T.DIRT } });
  add({ id: 21, key: 'wool_white', name: 'White Wool', hardness: 1.0, tiles: T.WOOL_WHITE });
  add({ id: 22, key: 'wool_red', name: 'Red Wool', hardness: 1.0, tiles: T.WOOL_RED });
  add({ id: 23, key: 'wool_green', name: 'Green Wool', hardness: 1.0, tiles: T.WOOL_GREEN });
  add({ id: 24, key: 'wool_blue', name: 'Blue Wool', hardness: 1.0, tiles: T.WOOL_BLUE });
  add({ id: 25, key: 'wool_yellow', name: 'Yellow Wool', hardness: 1.0, tiles: T.WOOL_YELLOW });
  add({ id: 26, key: 'wool_black', name: 'Black Wool', hardness: 1.0, tiles: T.WOOL_BLACK });
  add({ id: 27, key: 'flower_red', name: 'Red Flower', solid: false, opaque: false, cross: true, cutout: true, hardness: 0.05, tiles: T.FLOWER_RED });
  add({ id: 28, key: 'flower_yellow', name: 'Yellow Flower', solid: false, opaque: false, cross: true, cutout: true, hardness: 0.05, tiles: T.FLOWER_YELLOW });
  add({ id: 29, key: 'tallgrass', name: 'Tall Grass', solid: false, opaque: false, cross: true, cutout: true, hardness: 0.05, drops: 0, tiles: T.TALLGRASS });
  add({ id: 30, key: 'sandstone', name: 'Sandstone', hardness: 2.0, tiles: { top: T.SANDSTONE_TOP, side: T.SANDSTONE_SIDE, bottom: T.SANDSTONE_TOP } });
  add({ id: 31, key: 'obsidian', name: 'Obsidian', hardness: 15.0, tiles: T.OBSIDIAN });
  add({ id: 32, key: 'tux_block', name: 'Tux Block', hardness: 1.5, tiles: { top: T.TUX_TOP, side: T.TUX_FACE, bottom: T.TUX_TOP } });
  add({ id: 33, key: 'lozenge', name: "Fisherman's Block", hardness: 1.0, emissive: 0.3, tiles: T.LOZENGE });

  // -- Part III additions (§3): new stable ids 34-61, never renumbered --
  add({ id: 34, key: 'redstone_ore', name: 'Redstone Ore', hardness: 3.5, emissive: 0.15, tiles: T.REDSTONE_ORE });
  add({ id: 35, key: 'lapis_ore', name: 'Lapis Ore', hardness: 3.5, tiles: T.LAPIS_ORE });
  add({ id: 36, key: 'emerald_ore', name: 'Emerald Ore', hardness: 4.5, tiles: T.EMERALD_ORE });
  add({ id: 37, key: 'netherite_scrap_ore', name: 'Ancient Debris', hardness: 6.0, tiles: T.ANCIENT_DEBRIS });
  add({ id: 38, key: 'granite', name: 'Granite', hardness: 2.5, tiles: T.GRANITE });
  add({ id: 39, key: 'diorite', name: 'Diorite', hardness: 2.5, tiles: T.DIORITE });
  add({ id: 40, key: 'andesite', name: 'Andesite', hardness: 2.5, tiles: T.ANDESITE });
  add({ id: 41, key: 'clay', name: 'Clay', hardness: 0.6, tiles: T.CLAY });
  add({ id: 42, key: 'terracotta', name: 'Terracotta', hardness: 1.25, tiles: T.TERRACOTTA });
  add({ id: 43, key: 'mossy_cobble', name: 'Mossy Cobblestone', hardness: 3.0, tiles: T.MOSSY_COBBLE });
  add({ id: 44, key: 'ice', name: 'Ice', opaque: false, translucent: true, hardness: 0.5, tiles: T.ICE });
  add({ id: 45, key: 'packed_ice', name: 'Packed Ice', hardness: 0.5, tiles: T.PACKED_ICE });
  add({ id: 46, key: 'cactus', name: 'Cactus', opaque: false, cutout: true, hardness: 0.4, tiles: { top: T.CACTUS_TOP, side: T.CACTUS_SIDE, bottom: T.CACTUS_TOP } });
  add({ id: 47, key: 'melon', name: 'Melon Block', hardness: 1.0, tiles: { top: T.MELON_TOP, side: T.MELON_SIDE, bottom: T.MELON_TOP } });
  add({ id: 48, key: 'pumpkin', name: 'Pumpkin', hardness: 1.0, tiles: { top: T.PUMPKIN_TOP, side: T.PUMPKIN_SIDE, bottom: T.PUMPKIN_TOP } });
  add({ id: 49, key: 'mushroom_red', name: 'Red Mushroom Block', hardness: 0.2, tiles: { top: T.MUSHROOM_RED_TOP, side: T.MUSHROOM_RED_SIDE, bottom: T.MUSHROOM_RED_SIDE } });
  add({ id: 50, key: 'mushroom_brown', name: 'Brown Mushroom Block', hardness: 0.2, tiles: { top: T.MUSHROOM_BROWN_TOP, side: T.MUSHROOM_BROWN_SIDE, bottom: T.MUSHROOM_BROWN_SIDE } });
  add({ id: 51, key: 'vine', name: 'Vines', solid: false, opaque: false, cutout: true, hardness: 0.2, drops: 0, tiles: T.VINE });
  add({ id: 52, key: 'wool_orange', name: 'Orange Wool', hardness: 1.0, tiles: T.WOOL_ORANGE });
  add({ id: 53, key: 'wool_purple', name: 'Purple Wool', hardness: 1.0, tiles: T.WOOL_PURPLE });
  add({ id: 54, key: 'wool_cyan', name: 'Cyan Wool', hardness: 1.0, tiles: T.WOOL_CYAN });
  add({ id: 55, key: 'wool_pink', name: 'Pink Wool', hardness: 1.0, tiles: T.WOOL_PINK });
  add({ id: 56, key: 'wool_gray', name: 'Gray Wool', hardness: 1.0, tiles: T.WOOL_GRAY });
  add({ id: 57, key: 'wool_lightgray', name: 'Light Gray Wool', hardness: 1.0, tiles: T.WOOL_LIGHTGRAY });
  add({ id: 58, key: 'tnt_lozenge', name: 'Lozenge Charge', hardness: 0, tiles: T.TNT_LOZENGE });
  add({ id: 59, key: 'end_stone', name: 'Sunset Stone', hardness: 4.0, tiles: T.END_STONE });
  add({ id: 60, key: 'basalt', name: 'Basalt', hardness: 3.0, tiles: T.BASALT });
  add({ id: 61, key: 'quartz_block', name: 'Quartz Block', hardness: 2.0, tiles: T.QUARTZ_BLOCK });

  // -- §13a liquid-flow fix (cross-agent coordination): `flowing_water`,
  // id 62, the next free id after this section's own top (61). world.js
  // (owned by a sibling agent building the water-flow simulation) needed
  // this id registered here — it left a detailed integration note in its
  // own header explaining it could only hardcode id 62 as an ASSUMED
  // constant (blocks.js's add() is a private closure, not a public
  // extension point) and asked for this exact shape: same liquid/physics/
  // rendering flags as `water` (mirrors id 11 exactly for solid/opaque/
  // liquid/translucent/hardness/placeable/drops) so flowing water swims,
  // collides and meshes identically to source water, but with its own
  // slightly-more-turbulent tile art so it reads as the spreading, lower-
  // strength liquid it represents rather than a duplicate of calm water.
  add({ id: 62, key: 'flowing_water', name: 'Flowing Water', solid: false, opaque: false, liquid: true, translucent: true, hardness: Infinity, placeable: false, drops: 0, tiles: T.FLOWING_WATER });

  // ---- public API ----
  return {
    AIR: 0,
    ATLAS_TILES: ATLAS_TILES,

    byId: function (id) { return DEFS[id]; },
    byKey: function (key) { return BY_KEY[key]; },

    // All real blocks, id-ascending (air excluded; water + bedrock included —
    // their def.placeable === false keeps them out of the creative palette,
    // which filters with Blocks.list().filter(d => d.placeable)).
    list: function () {
      return DEFS.filter(function (d) { return d && d.id !== 0; });
    },

    buildAtlas: buildAtlas,

    // Convenience extras (not contract-pinned, safe to ignore):
    tileUV: tileUV,          // same UV math without a GL context
    atlasCanvas: atlasCanvas, // the raw 256×256 canvas (HUD icons draw from it)
    nameOf: function (id) {
      var d = DEFS[id];
      if (!d) return '';
      return (typeof I18n !== 'undefined' && I18n && I18n.t)
        ? I18n.t(d.i18nKey, d.name) : d.name;
    }
  };
})();

window.Blocks = Blocks;
