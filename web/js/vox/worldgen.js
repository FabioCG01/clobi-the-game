// worldgen.js — deterministic seeded terrain generator for CLOBI CRAFT.
//
// Single global: WorldGen.
//
//   WorldGen.create(seed:int) -> gen
//   gen.generateChunk(cx, cz) -> Uint8Array(16*96*16)   // ids, i = (y*16+z)*16+x
//   gen.surfaceHeight(x, z)   -> int                    // terrain top (no trees)
//
// Pure functions — no GL, no DOM, no dependencies. Noise is home-grown:
// integer-hash lattice value noise with smoothstep interpolation, 3 octaves
// for the height field, a very-low-frequency mask that gates hill country,
// and a rare high-frequency field for gravel/sand patches. Everything keys
// off the integer seed, so any (seed, cx, cz) always yields the same chunk.
//
// Terrain script (contract §5.4):
//   rolling plains + hills around y≈44 (sea level y=40, world height 96),
//   sand beaches at sea level ±1, snow_grass above y≈66, water fills air
//   up to y=40, stone under 3–4 soil, bedrock at y=0, depth-gated ore veins
//   (coal y<70 … diamond y<16) via per-chunk seeded RNG walks, oak trees
//   whose radius-2 canopy always fits inside their own chunk, and
//   flowers/tallgrass tufts on grass.
//
// Block ids are the stable contract §4 values (mirrored as local constants;
// blocks.js is the registry of record and loads before this file).

var WorldGen = (function () {

  // ---- world geometry ----
  var CHUNK = 16;
  var WORLD_H = 96;
  var SEA = 40;
  var CHUNK_VOL = CHUNK * WORLD_H * CHUNK;

  // ---- block ids (contract §4 — stable) ----
  var AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, BEDROCK = 5, LOG = 6,
      LEAVES = 8, SAND = 9, GRAVEL = 10, WATER = 11,
      COAL_ORE = 16, IRON_ORE = 17, GOLD_ORE = 18, DIAMOND_ORE = 19,
      SNOW_GRASS = 20, FLOWER_RED = 27, FLOWER_YELLOW = 28, TALLGRASS = 29;

  // ---- noise salts (namespaces inside the one seed) ----
  var S_HEIGHT = 101;   // 3-octave plains field (uses +1, +2 too)
  var S_MASK = 110;     // low-freq hill-country mask
  var S_HILL = 120;     // 3-octave hill relief (uses +1, +2 too)
  var S_PATCH = 130;    // rare gravel/sand surface patches
  var S_SOIL = 140;     // dirt depth 3/4
  var S_SNOW = 150;     // snow line jitter
  var S_TREE = 160;     // tree placement
  var S_TRUNK = 170;    // trunk height
  var S_CANOPY = 180;   // canopy corner trimming
  var S_DECO = 190;     // tallgrass / flower placement
  var S_ORE = 200;      // per-chunk ore RNG stream

  function idx(x, y, z) { return (y * CHUNK + z) * CHUNK + x; }

  // ---- mulberry32 — tiny fast PRNG for per-chunk ore walks ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function create(seed) {
    seed = (typeof seed === 'number' && isFinite(seed)) ? (seed | 0) : 0;

    // ---- integer hash / lattice noise (seed-bound closures) ----
    function h32(x, z, salt) {
      var h = seed ^ Math.imul(x | 0, 0x27D4EB2D) ^ Math.imul(z | 0, 0x165667B1) ^
              Math.imul(salt | 0, 0x9E3779B1);
      h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
      h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
      return (h ^ (h >>> 16)) >>> 0;
    }
    function rnd(salt, x, z) { return h32(x, z, salt) / 4294967296; }

    // 2D value noise: hash at integer lattice, smoothstep-blended. Returns 0..1.
    function vnoise(salt, x, z) {
      var x0 = Math.floor(x), z0 = Math.floor(z);
      var fx = x - x0, fz = z - z0;
      var sx = fx * fx * (3 - 2 * fx);
      var sz = fz * fz * (3 - 2 * fz);
      var a = rnd(salt, x0, z0), b = rnd(salt, x0 + 1, z0);
      var c = rnd(salt, x0, z0 + 1), d = rnd(salt, x0 + 1, z0 + 1);
      var top = a + (b - a) * sx;
      var bot = c + (d - c) * sx;
      return top + (bot - top) * sz;
    }

    // 3 octaves, weights 4:2:1 (≈0..1). Odd lacunarities hide lattice echoes.
    function fbm3(salt, x, z) {
      return vnoise(salt, x, z) * 0.5714 +
             vnoise(salt + 1, x * 2.03 + 37.7, z * 2.03 - 11.3) * 0.2857 +
             vnoise(salt + 2, x * 4.11 - 71.1, z * 4.11 + 23.9) * 0.1429;
    }

    function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

    // ---- the height field ----
    // plains: gentle ±10 rolling; hills: masked-in mountains up to +27 —
    // peaks crest ≈80 so the >66 snow line actually gets used.
    function terrainHeight(wx, wz) {
      var plains = fbm3(S_HEIGHT, wx / 52, wz / 52) * 2 - 1;    // -1..1
      var maskRaw = vnoise(S_MASK, wx / 170, wz / 170);          // 0..1, huge blobs
      var mask = clamp01((maskRaw - 0.52) / 0.26);
      mask = mask * mask * (3 - 2 * mask);                       // smooth gate
      var hills = fbm3(S_HILL, wx / 64, wz / 64);                // 0..1
      var h = Math.round(43 + plains * 13 + mask * hills * 27);
      if (h < 3) h = 3;
      if (h > 86) h = 86;
      return h;
    }

    function snowLine(wx, wz) {
      return 65 + (h32(wx, wz, S_SNOW) % 3); // 65..67 — ragged, not a contour line
    }

    // ---- ore veins: seeded random walk, only ever replaces stone ----
    function carveVeins(b, rng, ore, count, yMin, yMax, lenMin, lenMax) {
      for (var v = 0; v < count; v++) {
        var x = (rng() * CHUNK) | 0;
        var z = (rng() * CHUNK) | 0;
        var y = yMin + ((rng() * (yMax - yMin)) | 0);
        var len = lenMin + ((rng() * (lenMax - lenMin + 1)) | 0);
        for (var s = 0; s < len; s++) {
          var i = idx(x, y, z);
          if (b[i] === STONE) b[i] = ore;
          // thicken the vein sideways half the time
          if (rng() < 0.5) {
            var tx = x + ((rng() * 3) | 0) - 1;
            var ty = y + ((rng() * 3) | 0) - 1;
            var tz = z + ((rng() * 3) | 0) - 1;
            if (tx >= 0 && tx < CHUNK && tz >= 0 && tz < CHUNK && ty >= 1 && ty <= yMax) {
              var ti = idx(tx, ty, tz);
              if (b[ti] === STONE) b[ti] = ore;
            }
          }
          // drunken step
          x += ((rng() * 3) | 0) - 1;
          y += ((rng() * 3) | 0) - 1;
          z += ((rng() * 3) | 0) - 1;
          if (x < 0) x = 0; else if (x > 15) x = 15;
          if (z < 0) z = 0; else if (z > 15) z = 15;
          if (y < 1) y = 1; else if (y > yMax) y = yMax;
        }
      }
    }

    // ---- oak tree: trunk 4–6 + leaf blob, canopy stays inside the chunk ----
    function placeTree(b, x, z, h, wx, wz) {
      var th = 4 + (h32(wx, wz, S_TRUNK) % 3);         // 4..6
      if (h + th + 2 >= WORLD_H) return;
      b[idx(x, h, z)] = DIRT;                          // roots eat the grass
      for (var k = 1; k <= th; k++) b[idx(x, h + k, z)] = LOG;
      var ty = h + th;                                 // canopy centre height
      for (var ly = ty - 2; ly <= ty + 1; ly++) {
        var rad = (ly <= ty - 1) ? 2 : 1;
        for (var dz = -rad; dz <= rad; dz++) {
          for (var dx = -rad; dx <= rad; dx++) {
            var ax = dx < 0 ? -dx : dx, az = dz < 0 ? -dz : dz;
            if (ly === ty + 1 && ax + az > 1) continue;              // top = plus
            if (rad === 2 && ax === 2 && az === 2 &&
                rnd(S_CANOPY + ly - ty, wx + dx, wz + dz) < 0.6) continue; // round big layers
            if (rad === 1 && ly === ty && ax === 1 && az === 1 &&
                rnd(S_CANOPY + 7, wx + dx, wz + dz) < 0.4) continue;       // ruffle mid layer
            var i = idx(x + dx, ly, z + dz);
            if (b[i] === AIR) b[i] = LEAVES;
          }
        }
      }
    }

    // ---- the chunk ----
    function generateChunk(cx, cz) {
      var b = new Uint8Array(CHUNK_VOL);
      var heights = new Int16Array(CHUNK * CHUNK);
      var x, z, y, wx, wz, h, i;

      // -- pass 1: columns (bedrock / stone / soil / top / water) --
      for (z = 0; z < CHUNK; z++) {
        for (x = 0; x < CHUNK; x++) {
          wx = cx * CHUNK + x;
          wz = cz * CHUNK + z;
          h = terrainHeight(wx, wz);
          heights[z * CHUNK + x] = h;

          var soil = 3 + (h32(wx, wz, S_SOIL) & 1);    // 3–4 soil layers
          var top, under;
          if (h <= SEA - 2) {
            // submerged floor: sand shallows, gravel beds in patches
            var floorPatch = vnoise(S_PATCH, wx / 7.3, wz / 7.3);
            top = under = (floorPatch > 0.62) ? GRAVEL : SAND;
          } else if (h <= SEA + 1) {
            top = under = SAND;                        // beaches (sea level ±1)
          } else if (h >= snowLine(wx, wz)) {
            top = SNOW_GRASS; under = DIRT;            // high-altitude caps
          } else {
            top = GRASS; under = DIRT;
            var pv = vnoise(S_PATCH, wx / 7.3, wz / 7.3);
            if (pv > 0.83) { top = GRAVEL; under = GRAVEL; }   // rare bald patches
            else if (pv < 0.045) { top = SAND; under = SAND; }
          }

          b[idx(x, 0, z)] = BEDROCK;
          for (y = 1; y <= h; y++) {
            if (y === h) b[idx(x, y, z)] = top;
            else if (y >= h - soil) b[idx(x, y, z)] = under;
            else b[idx(x, y, z)] = STONE;
          }
          if (h < SEA) {
            for (y = h + 1; y <= SEA; y++) b[idx(x, y, z)] = WATER;
          }
        }
      }

      // -- pass 2: ore veins (per-chunk RNG stream; depth-gated rarity) --
      var rng = mulberry32(h32(cx, cz, S_ORE) | 0);
      carveVeins(b, rng, COAL_ORE, 8, 8, 69, 4, 9);    // common, y<70
      carveVeins(b, rng, IRON_ORE, 5, 4, 47, 4, 8);    // y<48
      carveVeins(b, rng, GOLD_ORE, 3, 2, 27, 3, 6);    // y<28
      if (rng() < 0.6) carveVeins(b, rng, DIAMOND_ORE, 1, 1, 15, 3, 4); // rare, y<16
      if (rng() < 0.25) carveVeins(b, rng, DIAMOND_ORE, 1, 1, 15, 3, 4);

      // -- pass 3: trees (interior columns only, so the radius-2 canopy
      //    never crosses the chunk border → chunks stay independent) --
      for (z = 2; z <= 13; z++) {
        for (x = 2; x <= 13; x++) {
          wx = cx * CHUNK + x;
          wz = cz * CHUNK + z;
          h = heights[z * CHUNK + x];
          if (b[idx(x, h, z)] !== GRASS) continue;     // grass only (skips beaches,
          if (rnd(S_TREE, wx, wz) >= 0.022) continue;  //  snow, gravel patches)
          placeTree(b, x, z, h, wx, wz);
        }
      }

      // -- pass 4: decorations (tallgrass tufts + the odd flower) --
      for (z = 0; z < CHUNK; z++) {
        for (x = 0; x < CHUNK; x++) {
          h = heights[z * CHUNK + x];
          if (h + 1 >= WORLD_H || h <= SEA) continue;
          if (b[idx(x, h, z)] !== GRASS) continue;     // tree roots turned to dirt
          i = idx(x, h + 1, z);
          if (b[i] !== AIR) continue;                  // canopy/trunk already there
          wx = cx * CHUNK + x;
          wz = cz * CHUNK + z;
          var r = rnd(S_DECO, wx, wz);
          if (r < 0.055) b[i] = TALLGRASS;
          else if (r < 0.068) {
            b[i] = (h32(wx, wz, S_DECO + 1) & 1) ? FLOWER_RED : FLOWER_YELLOW;
          }
        }
      }

      return b;
    }

    function surfaceHeight(x, z) {
      return terrainHeight(Math.floor(x), Math.floor(z));
    }

    return {
      seed: seed,
      generateChunk: generateChunk,
      surfaceHeight: surfaceHeight
    };
  }

  // ---- public API ----
  return { create: create };
})();

window.WorldGen = WorldGen;
