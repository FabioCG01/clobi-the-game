// mesher.js -- chunk -> GPU mesh geometry. Single global: Mesher.
//
// Turns one 16x96x16 chunk of block ids into flat, non-indexed triangle
// arrays ready for upload (Renderer owns the VAOs):
//
//   Mesher.meshChunk(world, cx, cz) -> {
//     opaque:      {pos, uv, shade, count},   // solid + cutout (leaves/glass/cross)
//     translucent: {pos, uv, shade, count},   // water only
//     empty: bool
//   }
//
// Positions are WORLD-space floats (no per-chunk model matrix needed).
// `shade` is one float per vertex: faceLight * ao * skyExposure, where
//   faceLight = top 1.0 | north/south 0.82 | east/west 0.7 | bottom 0.55,
//   ao        = classic 4-sample vertex AO in steps 0.55 / 0.70 / 0.85 / 1.0,
//   skyExposure = 1.0 with open sky above the block's column, else 0.55.
// Emissive blocks write a flat shade >= 1.2 (the renderer treats >1 as glow).
// Quads flip their diagonal when AO anisotropy demands it (the classic
// a00+a11 > a01+a10 rule) so smooth corners never show the bent-quad seam.
//
// Face rules:
//   - solid opaque: face emitted when the neighbor is not opaque,
//   - cutout (leaves/glass): emitted vs any NON-IDENTICAL non-opaque neighbor,
//   - cross plants: two diagonal quads, both windings, no culling, in opaque,
//   - water: faces only against non-water non-opaque neighbors; the surface
//     sits at 14/16 when no water is above; goes to the translucent batch.
// Neighbor chunks are read through world.getBlock (ungenerated == AIR; Game
// only meshes chunks whose four neighbors exist, so seams don't flicker).
//
// Depends on: Blocks (registry + atlas layout). Pure CPU: no GL, no DOM.
// No user-visible strings. No ES modules, no frameworks -- one global.

const Mesher = (function () {
  'use strict';

  const CX = 16, CY = 96, CZ = 16;
  const WATER_TOP = 14 / 16;
  const AO_STEP = 0.15;               // 0.55 + level * 0.15 -> 0.55..1.0
  const AO_MIN = 0.55;
  const SKY_DIM = 0.55;               // underground ambient exposure

  // ---- face table ------------------------------------------------------------
  // For every face: outward normal `d`, plane origin `o` (min corner of the
  // face on the unit cube), edge axes `u`,`v` chosen so u x v = d, meaning the
  // corner order (0,0)(1,0)(1,1)(0,1) winds CCW seen from outside (WebGL
  // front-face). `st` maps each corner to tile-local texture coords with the
  // texture top at the world top on side faces. `light` = the face light.
  const FACES = [
    { d: [0, 1, 0], o: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], light: 1.0, tile: 'top', st: [[0, 0], [0, 1], [1, 1], [1, 0]] },
    { d: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], light: 0.55, tile: 'bottom', st: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    { d: [0, 0, -1], o: [0, 0, 0], u: [0, 1, 0], v: [1, 0, 0], light: 0.82, tile: 'side', st: [[0, 1], [0, 0], [1, 0], [1, 1]] }, // north
    { d: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], light: 0.82, tile: 'side', st: [[0, 1], [1, 1], [1, 0], [0, 0]] }, // south
    { d: [1, 0, 0], o: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], light: 0.7, tile: 'side', st: [[0, 1], [0, 0], [1, 0], [1, 1]] }, // east
    { d: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], light: 0.7, tile: 'side', st: [[0, 1], [1, 1], [1, 0], [0, 0]] }  // west
  ];
  const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];   // (du, dv) per quad corner

  // Precompute per-face corner offsets: off[k] = o + u*du + v*dv
  for (let f = 0; f < FACES.length; f++) {
    const face = FACES[f];
    face.off = [];
    for (let k = 0; k < 4; k++) {
      const du = CORNERS[k][0], dv = CORNERS[k][1];
      face.off.push([
        face.o[0] + face.u[0] * du + face.v[0] * dv,
        face.o[1] + face.u[1] * du + face.v[1] * dv,
        face.o[2] + face.u[2] * du + face.v[2] * dv
      ]);
    }
  }
  const F_TOP = 0, F_BOTTOM = 1;      // indices into FACES for water special-casing

  // ---- block def / atlas caches ------------------------------------------------
  let DEFS = null;                    // id -> def (or null), built once from Blocks
  let TILE_UV = null;                 // tileIndex -> [u0,v0,u1,v1], half-texel inset

  function defsTable() {
    if (DEFS) return DEFS;
    DEFS = new Array(256).fill(null);
    if (typeof Blocks !== 'undefined' && Blocks.byId) {
      for (let i = 0; i < 256; i++) DEFS[i] = Blocks.byId(i) || null;
    }
    return DEFS;
  }

  // Mirrors Blocks.buildAtlas tileUV math without needing a GL context:
  // ATLAS_TILES x ATLAS_TILES grid of 16px tiles, half-texel inset vs bleeding.
  function tileUV(tile) {
    if (!TILE_UV) {
      const tiles = (typeof Blocks !== 'undefined' && Blocks.ATLAS_TILES) ? Blocks.ATLAS_TILES : 16;
      const px = tiles * 16;
      const inset = 0.5 / px;
      TILE_UV = new Array(tiles * tiles);
      for (let t = 0; t < tiles * tiles; t++) {
        const col = t % tiles, row = (t / tiles) | 0;
        TILE_UV[t] = [
          col / tiles + inset, row / tiles + inset,
          (col + 1) / tiles - inset, (row + 1) / tiles - inset
        ];
      }
    }
    return TILE_UV[tile] || TILE_UV[0];
  }

  // ---- batch helpers -------------------------------------------------------------
  function makeBatch() { return { pos: [], uv: [], shade: [] }; }

  // Push one quad as two triangles. `flip` switches the diagonal (AO fix).
  const ORDER_STD = [0, 1, 2, 0, 2, 3];
  const ORDER_FLIP = [1, 2, 3, 1, 3, 0];
  function pushQuad(batch, cs, uvs, shades, flip) {
    const order = flip ? ORDER_FLIP : ORDER_STD;
    for (let n = 0; n < 6; n++) {
      const k = order[n];
      batch.pos.push(cs[k][0], cs[k][1], cs[k][2]);
      batch.uv.push(uvs[k][0], uvs[k][1]);
      batch.shade.push(shades[k]);
    }
  }

  function finishBatch(b) {
    return {
      pos: new Float32Array(b.pos),
      uv: new Float32Array(b.uv),
      shade: new Float32Array(b.shade),
      count: b.pos.length / 3
    };
  }

  // ---- the mesher ------------------------------------------------------------------
  function meshChunk(world, cx, cz) {
    const defs = defsTable();
    const chunk = world.getChunk(cx, cz);
    const oBatch = makeBatch();
    const tBatch = makeBatch();

    if (!chunk || !chunk.blocks) {
      return {
        opaque: finishBatch(oBatch),
        translucent: finishBatch(tBatch),
        empty: true
      };
    }

    const blocks = chunk.blocks;
    const wx0 = cx * CX, wz0 = cz * CZ;

    // -- local block access (own chunk fast path, neighbors via world) --
    function gb(lx, ly, lz) {
      if (ly < 0 || ly >= CY) return 0;
      if (lx >= 0 && lx < CX && lz >= 0 && lz < CZ) {
        return blocks[(ly * CX + lz) * CX + lx];
      }
      return world.getBlock(wx0 + lx, ly, wz0 + lz) | 0;
    }
    function opq(lx, ly, lz) {
      const d = defs[gb(lx, ly, lz)];
      return !!(d && d.opaque);
    }

    // -- sky exposure: highest opaque block per column (own chunk data) --
    const topOp = new Int16Array(CX * CZ).fill(-1);
    for (let z = 0; z < CZ; z++) {
      for (let x = 0; x < CX; x++) {
        for (let y = CY - 1; y >= 0; y--) {
          const d = defs[blocks[(y * CX + z) * CX + x]];
          if (d && d.opaque) { topOp[z * CX + x] = y; break; }
        }
      }
    }

    // -- classic 4-sample AO for one quad corner --
    function aoCorner(bx, by, bz, face, su, sv) {
      const dx = face.d[0], dy = face.d[1], dz = face.d[2];
      const ux = face.u[0] * su, uy = face.u[1] * su, uz = face.u[2] * su;
      const vx = face.v[0] * sv, vy = face.v[1] * sv, vz = face.v[2] * sv;
      const s1 = opq(bx + dx + ux, by + dy + uy, bz + dz + uz);
      const s2 = opq(bx + dx + vx, by + dy + vy, bz + dz + vz);
      if (s1 && s2) return AO_MIN;
      const c = opq(bx + dx + ux + vx, by + dy + uy + vy, bz + dz + uz + vz);
      const level = 3 - ((s1 ? 1 : 0) + (s2 ? 1 : 0) + (c ? 1 : 0));
      return AO_MIN + level * AO_STEP;
    }

    // -- scratch (reused per face; contents copied out by pushQuad) --
    const cs = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const uvs = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const shades = [0, 0, 0, 0];

    function fillUVs(face, rect) {
      for (let k = 0; k < 4; k++) {
        const st = face.st[k];
        uvs[k][0] = rect[0] + st[0] * (rect[2] - rect[0]);
        uvs[k][1] = rect[1] + st[1] * (rect[3] - rect[1]);
      }
    }

    // -- cross plants: two diagonal quads, both windings --
    function emitCross(def, x, y, z, skyExp) {
      const wx = wx0 + x, wz = wz0 + z;
      const tile = (def.tiles && def.tiles.side !== undefined) ? def.tiles.side
        : (def.tiles ? def.tiles.top : 0);
      const rect = tileUV(tile);
      const shade = (def.emissive > 0) ? (1.2 + def.emissive * 0.8) : skyExp;
      const quads = [
        [[wx, y, wz], [wx + 1, y, wz + 1], [wx + 1, y + 1, wz + 1], [wx, y + 1, wz]],
        [[wx + 1, y, wz], [wx, y, wz + 1], [wx, y + 1, wz + 1], [wx + 1, y + 1, wz]]
      ];
      // texture: bottom corners sample the tile bottom, top corners the top
      const stCross = [[0, 1], [1, 1], [1, 0], [0, 0]];
      for (let q = 0; q < 2; q++) {
        const c = quads[q];
        for (let k = 0; k < 4; k++) {
          uvs[k][0] = rect[0] + stCross[k][0] * (rect[2] - rect[0]);
          uvs[k][1] = rect[1] + stCross[k][1] * (rect[3] - rect[1]);
          shades[k] = shade;
        }
        pushQuad(oBatch, c, uvs, shades, false);                       // front winding
        const rev = [c[3], c[2], c[1], c[0]];
        const uvRev = [uvs[3], uvs[2], uvs[1], uvs[0]];
        pushQuad(oBatch, rev, uvRev, shades, false);                   // back winding
      }
    }

    // -- water: translucent batch, lowered surface, faces vs non-water only --
    function emitWater(def, x, y, z, skyExp) {
      const aboveDef = defs[gb(x, y + 1, z)];
      const aboveWater = !!(aboveDef && aboveDef.liquid);
      const h = aboveWater ? 1.0 : WATER_TOP;
      const tiles = def.tiles || {};
      for (let f = 0; f < FACES.length; f++) {
        const face = FACES[f];
        if (f === F_TOP && aboveWater) continue;                       // merged column
        const nd = defs[gb(x + face.d[0], y + face.d[1], z + face.d[2])];
        if (nd && (nd.liquid || nd.opaque)) continue;                  // vs water/hidden
        const tile = (f === F_TOP) ? (tiles.top || 0)
          : (f === F_BOTTOM) ? (tiles.bottom !== undefined ? tiles.bottom : (tiles.top || 0))
            : (tiles.side !== undefined ? tiles.side : (tiles.top || 0));
        fillUVs(face, tileUV(tile));
        const shade = face.light * skyExp;
        for (let k = 0; k < 4; k++) {
          const off = face.off[k];
          cs[k][0] = wx0 + x + off[0];
          cs[k][1] = y + (off[1] === 1 ? h : 0);
          cs[k][2] = wz0 + z + off[2];
          shades[k] = shade;
        }
        pushQuad(tBatch, cs, uvs, shades, false);
      }
    }

    // ---- main sweep (index order == memory order) ----
    let i = 0;
    for (let y = 0; y < CY; y++) {
      for (let z = 0; z < CZ; z++) {
        for (let x = 0; x < CX; x++, i++) {
          const id = blocks[i];
          if (!id) continue;
          const def = defs[id];
          if (!def) continue;

          const skyExp = (y >= topOp[z * CX + x]) ? 1.0 : SKY_DIM;

          if (def.cross) { emitCross(def, x, y, z, skyExp); continue; }
          if (def.liquid) { emitWater(def, x, y, z, skyExp); continue; }

          const emissive = (def.emissive > 0) ? (1.2 + def.emissive * 0.8) : 0;
          const tiles = def.tiles || {};

          for (let f = 0; f < FACES.length; f++) {
            const face = FACES[f];
            const nId = gb(x + face.d[0], y + face.d[1], z + face.d[2]);
            const nd = defs[nId];
            if (nd && nd.opaque) continue;                             // hidden face
            if (def.cutout && nId === id) continue;                    // leaves vs leaves

            const tile = (face.tile === 'top') ? (tiles.top || 0)
              : (face.tile === 'bottom') ? (tiles.bottom !== undefined ? tiles.bottom : (tiles.top || 0))
                : (tiles.side !== undefined ? tiles.side : (tiles.top || 0));
            fillUVs(face, tileUV(tile));

            let flip = false;
            if (emissive > 0) {
              for (let k = 0; k < 4; k++) shades[k] = emissive;        // flat glow
            } else {
              for (let k = 0; k < 4; k++) {
                const su = CORNERS[k][0] * 2 - 1, sv = CORNERS[k][1] * 2 - 1;
                shades[k] = face.light * aoCorner(x, y, z, face, su, sv) * skyExp;
              }
              // classic anisotropy fix: a00+a11 > a01+a10 -> flip diagonal
              flip = (shades[0] + shades[2]) > (shades[1] + shades[3]);
            }

            for (let k = 0; k < 4; k++) {
              const off = face.off[k];
              cs[k][0] = wx0 + x + off[0];
              cs[k][1] = y + off[1];
              cs[k][2] = wz0 + z + off[2];
            }
            pushQuad(oBatch, cs, uvs, shades, flip);
          }
        }
      }
    }

    const opaque = finishBatch(oBatch);
    const translucent = finishBatch(tBatch);
    return {
      opaque: opaque,
      translucent: translucent,
      empty: opaque.count === 0 && translucent.count === 0
    };
  }

  // ---- public API ------------------------------------------------------------------
  return {
    meshChunk: meshChunk
  };
})();

window.Mesher = Mesher;
