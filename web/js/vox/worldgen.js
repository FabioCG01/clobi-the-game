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
// Part III additions (ARCHITECTURE-COMBAT.md §3):
//   - biomeNoise(x,z): a cheap, huge-blob, height-INDEPENDENT lateral value
//     (own low-freq lattice channel, S_BIOME) gating four lateral bands —
//     cold / temperate / desert-ish / jungle-ish — independent of the
//     existing altitude-gated snow line. Documented per-band below at its
//     definition.
//   - a second cheap value-noise channel (S_STONEVAR) recolors plain stone
//     below y≈40 into granite/diorite/andesite blobs, same blob-threshold
//     technique as the existing S_PATCH gravel/sand patches.
//   - new depth-gated ore veins (redstone/lapis/emerald/ancient-debris),
//     same per-chunk seeded vein-walk (carveVeins) as coal/iron/gold/diamond.
//   - clay in beach/riverbed columns at sea level, mossy cobble as a rare
//     shoreline+forest surface variant, and cactus/melon/pumpkin/mushroom/
//     vine surface decorations analogous to the existing flowers/tallgrass
//     (same "must fit fully inside the chunk" rule — all are single-column
//     or leaf-attached features with no cross-chunk radius).
//
// Block ids are the stable contract §4 (Part I) + §3 (Part III) values
// (mirrored as local constants; blocks.js is the registry of record and
// loads before this file).

var WorldGen = (function () {

  // ---- world geometry ----
  var CHUNK = 16;
  var WORLD_H = 96;
  var SEA = 40;
  var CHUNK_VOL = CHUNK * WORLD_H * CHUNK;

  // ---- block ids (contract §4/§3 — stable) ----
  var AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, BEDROCK = 5, LOG = 6,
      LEAVES = 8, SAND = 9, GRAVEL = 10, WATER = 11,
      COAL_ORE = 16, IRON_ORE = 17, GOLD_ORE = 18, DIAMOND_ORE = 19,
      SNOW_GRASS = 20, FLOWER_RED = 27, FLOWER_YELLOW = 28, TALLGRASS = 29,
      REDSTONE_ORE = 34, LAPIS_ORE = 35, EMERALD_ORE = 36, ANCIENT_DEBRIS = 37,
      GRANITE = 38, DIORITE = 39, ANDESITE = 40, CLAY = 41, MOSSY_COBBLE = 43,
      ICE = 44, PACKED_ICE = 45, CACTUS = 46, MELON = 47, PUMPKIN = 48,
      MUSHROOM_RED = 49, MUSHROOM_BROWN = 50, VINE = 51;

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
  var S_BIOME = 210;    // Part III: lateral biome band (huge blobs, height-independent)
  var S_STONEVAR = 220; // Part III: granite/diorite/andesite blob channel
  var S_MOSSY = 230;    // Part III: mossy cobble shoreline+forest roll
  var S_DECO2 = 240;    // Part III: cactus/melon/pumpkin/mushroom placement
  var S_VINE = 250;     // Part III: vine attachment under jungle-biome leaves

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

    // ---- Part III: biomeNoise(x,z) — cheap, huge-blob, HEIGHT-INDEPENDENT
    // lateral value (0..1) gating four bands, independent of the altitude-
    // gated snow line above (a mountaintop and a lowland can each land in
    // any band). Very low frequency (denominator ~210) so bands read as
    // broad regions many chunks wide, not per-chunk noise. Bands (contract
    // §3): snow_grass/ice/packed_ice extend into the COLD band; cactus into
    // DESERT; melon/pumpkin/vine (+jungle mushroom pockets) into JUNGLE;
    // mossy cobble + occasional dark-forest mushrooms sit in TEMPERATE.
    //   [0.00, 0.18) cold      — lake surfaces freeze (ice/packed_ice)
    //   [0.18, 0.62) temperate — the existing default plains/forest look
    //   [0.62, 0.82) desert    — cactus on sand/gravel patches
    //   [0.82, 1.00] jungle    — melon/pumpkin fields, vines off tree leaves
    function biomeNoise(wx, wz) {
      return vnoise(S_BIOME, wx / 210, wz / 210);
    }
    var BIOME_COLD = 0.18, BIOME_DESERT = 0.62, BIOME_JUNGLE = 0.82;

    // ---- Part III: mountain mask — reuses the existing hills-country mask
    // channel (S_MASK) but thresholded much higher, so only the tallest
    // hill-country blobs count as "mountain" (gates emerald ore, very rare).
    function isMountain(wx, wz) {
      return vnoise(S_MASK, wx / 170, wz / 170) > 0.74;
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

    // ---- Part III: ancient debris — "very rare, isolated single-block
    // finds not veins" (contract §3): unlike carveVeins, this drops a
    // single ore block per roll with no walk/thicken, so debris never
    // clusters into a vein shape. Same per-chunk RNG stream as the other
    // ore passes for full determinism. ----
    function carveIsolated(b, rng, ore, count, yMin, yMax) {
      for (var v = 0; v < count; v++) {
        var x = (rng() * CHUNK) | 0;
        var z = (rng() * CHUNK) | 0;
        var y = yMin + ((rng() * (yMax - yMin + 1)) | 0);
        var i = idx(x, y, z);
        if (b[i] === STONE) b[i] = ore;
      }
    }

    // ---- oak tree: trunk 4–6 + leaf blob, canopy stays inside the chunk ----
    // `jungle` (Part III): when true, some canopy-edge leaf columns grow a
    // short VINE strand hanging straight down into the air below them —
    // same x,z as an already-in-chunk leaf block, so it trivially satisfies
    // the "canopy must fit fully inside the chunk" rule (no new x/z reach).
    function placeTree(b, x, z, h, wx, wz, jungle) {
      var th = 4 + (h32(wx, wz, S_TRUNK) % 3);         // 4..6
      if (h + th + 2 >= WORLD_H) return;
      b[idx(x, h, z)] = DIRT;                          // roots eat the grass
      for (var k = 1; k <= th; k++) b[idx(x, h + k, z)] = LOG;
      var ty = h + th;                                 // canopy centre height
      var leafCols = [];                               // [dx,dz,lowestLeafY] for vine pass
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
            if (b[i] === AIR) { b[i] = LEAVES; leafCols.push([dx, dz, ly]); }
          }
        }
      }
      if (!jungle) return;
      // vines: for a handful of canopy-edge leaf columns, hang a short
      // strand (1-3 blocks) straight down through the air beneath them.
      for (var c = 0; c < leafCols.length; c++) {
        var vdx = leafCols[c][0], vdz = leafCols[c][1], vly = leafCols[c][2];
        if (rnd(S_VINE, wx + vdx, wz + vdz + vly) > 0.22) continue;   // sparse
        var vlen = 1 + (h32(wx + vdx, wz + vdz, S_VINE + 1) % 3);     // 1..3
        for (var vy = vly - 1; vy > vly - 1 - vlen; vy--) {
          if (vy < 1) break;
          var vi = idx(x + vdx, vy, z + vdz);
          if (b[vi] !== AIR) break;                                  // stop at first obstruction
          b[vi] = VINE;
        }
      }
    }

    // ---- the chunk ----
    function generateChunk(cx, cz) {
      var b = new Uint8Array(CHUNK_VOL);
      var heights = new Int16Array(CHUNK * CHUNK);
      var x, z, y, wx, wz, h, i;

      // biome band per column, cached for passes 2-4 (avoids recomputing the
      // vnoise lookup 3-4x per column across passes).
      var biomes = new Uint8Array(CHUNK * CHUNK); // 0 cold, 1 temperate, 2 desert, 3 jungle

      // -- pass 1: columns (bedrock / stone / soil / top / water) --
      for (z = 0; z < CHUNK; z++) {
        for (x = 0; x < CHUNK; x++) {
          wx = cx * CHUNK + x;
          wz = cz * CHUNK + z;
          h = terrainHeight(wx, wz);
          heights[z * CHUNK + x] = h;

          var bn = biomeNoise(wx, wz);
          var biome = (bn < BIOME_COLD) ? 0 : (bn < BIOME_DESERT) ? 1 : (bn < BIOME_JUNGLE) ? 2 : 3;
          biomes[z * CHUNK + x] = biome;
          // cold biome lowers the effective snow line dramatically so whole
          // regions read as snowy regardless of hill height (vs. the plain
          // altitude gate elsewhere), giving biomeNoise real visual effect.
          var effSnowLine = (biome === 0) ? (SEA + 2) : snowLine(wx, wz);

          var soil = 3 + (h32(wx, wz, S_SOIL) & 1);    // 3–4 soil layers
          var top, under;
          var isBeach = false;
          if (h <= SEA - 2) {
            // submerged floor: sand shallows, gravel beds in patches
            var floorPatch = vnoise(S_PATCH, wx / 7.3, wz / 7.3);
            top = under = (floorPatch > 0.62) ? GRAVEL : SAND;
          } else if (h <= SEA + 1) {
            top = under = SAND;                        // beaches (sea level ±1)
            isBeach = true;
            // Part III: clay patches in beach/riverbed columns at sea level
            if (vnoise(S_PATCH, wx / 5.1 + 19.0, wz / 5.1 - 7.0) > 0.72) top = under = CLAY;
          } else if (h >= effSnowLine) {
            top = SNOW_GRASS; under = DIRT;            // high-altitude caps / cold biome
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
            else {
              // Part III: granite/diorite/andesite blob patches replace
              // plain stone below y≈40 (own value-noise channel, same
              // blob-threshold technique as the S_PATCH gravel/sand patches
              // above, at a lower frequency so blobs span many blocks).
              var variant = STONE;
              if (y < 40) {
                var sv = vnoise(S_STONEVAR, wx / 11.0, wz / 11.0) +
                         (vnoise(S_STONEVAR + 1, x * 0.6, y * 0.6) - 0.5) * 0.2;
                if (sv > 0.74) variant = GRANITE;
                else if (sv > 0.6) variant = DIORITE;
                else if (sv > 0.5) variant = ANDESITE;
              }
              b[idx(x, y, z)] = variant;
            }
          }
          if (h < SEA) {
            for (y = h + 1; y <= SEA; y++) b[idx(x, y, z)] = WATER;
            // Part III: cold-biome lakes freeze at the surface
            if (biome === 0) {
              var freezeIdx = idx(x, SEA, z);
              b[freezeIdx] = (rnd(S_BIOME + 3, wx, wz) < 0.35) ? PACKED_ICE : ICE;
            }
          }
          // Part III: mossy cobble — rare shoreline+forest surface variant.
          // Gate: shoreline column (beach or just-above-beach land edge) in
          // the temperate biome (stands in for "near water+forest"); replace
          // a couple of blocks right under the surface with mossy cobble.
          if (biome === 1 && (isBeach || (h > SEA + 1 && h <= SEA + 3)) &&
              rnd(S_MOSSY, wx, wz) < 0.05) {
            var my = h - 1;
            if (my >= 1) b[idx(x, my, z)] = MOSSY_COBBLE;
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
      // -- Part III ore veins (same per-chunk RNG stream, depth-gated) --
      carveVeins(b, rng, REDSTONE_ORE, 4, 2, 31, 3, 7);   // uncommon, y<32
      carveVeins(b, rng, LAPIS_ORE, 2, 1, 23, 4, 8);      // uncommon, clusters, y<24
      if (rng() < 0.5) carveVeins(b, rng, LAPIS_ORE, 1, 1, 23, 4, 7); // occasional 2nd cluster
      // emerald: y<40 AND only inside the mountain mask -- test the CHUNK
      // center (cheap single sample; emerald is "very rare" so a per-chunk
      // gate rather than per-column is intentional and keeps it isolated to
      // genuine mountain chunks) before rolling any veins at all.
      if (isMountain(cx * CHUNK + 8, cz * CHUNK + 8) && rng() < 0.35) {
        carveVeins(b, rng, EMERALD_ORE, 1, 4, 39, 2, 4);
      }
      // ancient debris: very rare, isolated single blocks, deep only (y<12)
      if (rng() < 0.4) carveIsolated(b, rng, ANCIENT_DEBRIS, 1, 1, 11);

      // -- pass 3: trees (interior columns only, so the radius-2 canopy
      //    never crosses the chunk border → chunks stay independent) --
      for (z = 2; z <= 13; z++) {
        for (x = 2; x <= 13; x++) {
          wx = cx * CHUNK + x;
          wz = cz * CHUNK + z;
          h = heights[z * CHUNK + x];
          if (b[idx(x, h, z)] !== GRASS) continue;     // grass only (skips beaches,
          if (rnd(S_TREE, wx, wz) >= 0.022) continue;  //  snow, gravel patches)
          placeTree(b, x, z, h, wx, wz, biomes[z * CHUNK + x] === 3 /* jungle */);
        }
      }

      // -- pass 4: decorations (tallgrass tufts + the odd flower, plus
      //    Part III's biome-gated cactus/melon/pumpkin/mushroom) --
      for (z = 0; z < CHUNK; z++) {
        for (x = 0; x < CHUNK; x++) {
          h = heights[z * CHUNK + x];
          if (h + 1 >= WORLD_H || h <= SEA) continue;
          wx = cx * CHUNK + x;
          wz = cz * CHUNK + z;
          var biome4 = biomes[z * CHUNK + x];
          var surfaceId = b[idx(x, h, z)];
          i = idx(x, h + 1, z);
          if (b[i] !== AIR) continue;                  // canopy/trunk already there

          if (surfaceId === GRASS) {
            var r = rnd(S_DECO, wx, wz);
            if (r < 0.055) { b[i] = TALLGRASS; continue; }
            else if (r < 0.068) {
              b[i] = (h32(wx, wz, S_DECO + 1) & 1) ? FLOWER_RED : FLOWER_YELLOW;
              continue;
            }
            // Part III: melon/pumpkin fields in the jungle band; rare
            // mushroom pockets in temperate/jungle (dark-forest flavor).
            var r2 = rnd(S_DECO2, wx, wz);
            if (biome4 === 3 && r2 < 0.02) {
              b[i] = (h32(wx, wz, S_DECO2 + 1) & 1) ? MELON : PUMPKIN;
            } else if ((biome4 === 1 || biome4 === 3) && r2 > 0.988) {
              b[i] = (h32(wx, wz, S_DECO2 + 2) & 1) ? MUSHROOM_RED : MUSHROOM_BROWN;
            }
          } else if (surfaceId === SAND && biome4 === 2) {
            // Part III: cactus in the desert band, short 1-3 tall stack
            if (rnd(S_DECO2 + 3, wx, wz) < 0.03) {
              var cactusH = 1 + (h32(wx, wz, S_DECO2 + 4) % 3);   // 1..3
              for (var cy = 0; cy < cactusH && h + 1 + cy < WORLD_H; cy++) {
                b[idx(x, h + 1 + cy, z)] = CACTUS;
              }
            }
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
