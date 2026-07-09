// vox/interact.js -- global Interact.
//
// Block interaction for CLOBI CRAFT: voxel raycasting (Amanatides-Woo DDA),
// survival hold-to-break with per-block hardness progress, creative instant
// break with repeat, placing with player-overlap veto, and pick-block.
// Contract: ARCHITECTURE-3D.md §5.11 (+§8 tap actions).
//
//   Interact.raycast(world, origin[3], dir[3], maxDist)
//     -> {hit, x, y, z, face:[nx,ny,nz], dist}
//     Targets any non-air, non-liquid block (flowers/tallgrass ARE targets,
//     water is not). Handles zero direction components, negative coords and
//     starting inside a block (face = [0,0,0], dist = 0).
//
//   Interact.create({world, player, inventory, hud}) -> sys
//   sys.update(dt, actions, camera)
//     actions = Input.consumeActions() output; camera needs {pos, projView}
//     (+ yaw/pitch for the crosshair ray; tap actions unproject px,py through
//     the inverse projView).
//   sys.target -> {hit, x, y, z, face, progress 0..1} | null
//
// Reach: 4.5 survival / 6 creative (mode read live from Game.mode, falling
// back to player.mode). Drops go through Inventory.add in survival; placing
// consumes via Inventory.consumeSelected. Sounds via Sound.play (guarded).
//
// Exposes exactly one global: window.Interact
// Depends on globals: Blocks, M3 (unproject), Inventory instances (duck-typed),
// optional Sound, optional Game (mode lookup).

var Interact = (function () {
  'use strict';

  // ---- constants ----
  var REACH_SURVIVAL = 4.5;
  var REACH_CREATIVE = 6.0;
  var CREATIVE_REPEAT = 0.15;   // seconds between creative insta-breaks
  var WORLD_MAX_Y = 95;         // contract §3: y ∈ [0,95]

  // scratch (allocation-light per frame)
  var invPV = new Float32Array(16);
  var scratchFar = [0, 0, 0];

  // ---- block helpers (Blocks may be missing in exotic load orders) ----
  function defOf(id) {
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) return Blocks.byId(id);
    return undefined;
  }

  function isTargetable(world, x, y, z) {
    var id = world.getBlock(x, y, z);
    if (!id) return false;
    var def = defOf(id);
    if (def) return !def.liquid;
    return id !== 11; // fallback: only water is see-through to the ray
  }

  function isReplaceable(world, x, y, z) {
    var id = world.getBlock(x, y, z);
    if (!id) return true; // air
    var def = defOf(id);
    if (def) return !!(def.liquid || def.cross);
    return id === 11 || (id >= 27 && id <= 29); // water / flowers / tallgrass
  }

  function playSound(name, blockId) {
    if (typeof Sound !== 'undefined' && Sound && typeof Sound.play === 'function') {
      try {
        // Block-aware routing: dig/place/mine carry the block id so the
        // sound matches the material (stone vs wood vs sand…, sound.js §map).
        if (typeof Sound.block === 'function' &&
            (name === 'dig' || name === 'place' || name === 'mine')) {
          Sound.block(name === 'dig' ? 'break' : (name === 'mine' ? 'hit' : 'place'), blockId);
          return;
        }
        Sound.play(name);
      } catch (e) { /* audio must never break gameplay */ }
    }
  }

  function readVec3(p) {
    if (!p) return [0, 0, 0];
    if (typeof p[0] === 'number') return [p[0], p[1] || 0, p[2] || 0];
    if (typeof p.x === 'number') return [p.x, p.y || 0, p.z || 0];
    return [0, 0, 0];
  }

  // ---- public: Amanatides-Woo voxel raycast ----
  function raycast(world, origin, dir, maxDist) {
    var ox = origin[0], oy = origin[1], oz = origin[2];
    var dx = dir[0], dy = dir[1], dz = dir[2];

    // normalize defensively (contract callers pass unit vectors already)
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-9 && Math.abs(len - 1) > 1e-6) {
      dx /= len; dy /= len; dz /= len;
    }

    var x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);

    // start-inside-block: report immediately with a null face
    if (isTargetable(world, x, y, z)) {
      return { hit: true, x: x, y: y, z: z, face: [0, 0, 0], dist: 0 };
    }
    if (len <= 1e-9) {
      return { hit: false, x: x, y: y, z: z, face: [0, 0, 0], dist: 0 };
    }

    var stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    var stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
    var stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);

    var tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    var tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    var tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

    var tMaxX = dx !== 0 ? ((stepX > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX) : Infinity;
    var tMaxY = dy !== 0 ? ((stepY > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY) : Infinity;
    var tMaxZ = dz !== 0 ? ((stepZ > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ) : Infinity;

    var fx = 0, fy = 0, fz = 0;
    var t = 0;
    var maxIter = Math.ceil((maxDist || 0) * 3) + 8;

    for (var i = 0; i < maxIter; i++) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX;
        fx = -stepX; fy = 0; fz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY;
        fx = 0; fy = -stepY; fz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        fx = 0; fy = 0; fz = -stepZ;
      }
      if (!(t <= maxDist)) break; // also exits when all tMax are Infinity
      if (isTargetable(world, x, y, z)) {
        return { hit: true, x: x, y: y, z: z, face: [fx, fy, fz], dist: t };
      }
    }
    return { hit: false, x: x, y: y, z: z, face: [0, 0, 0], dist: maxDist || 0 };
  }

  // ---- projective unproject helper (own w-divide; only needs M3.mat4Invert) ----
  function unprojectPoint(out, m, nx, ny, nz) {
    var w = m[3] * nx + m[7] * ny + m[11] * nz + m[15];
    if (w === 0) w = 1;
    out[0] = (m[0] * nx + m[4] * ny + m[8] * nz + m[12]) / w;
    out[1] = (m[1] * nx + m[5] * ny + m[9] * nz + m[13]) / w;
    out[2] = (m[2] * nx + m[6] * ny + m[10] * nz + m[14]) / w;
    return out;
  }

  // ---- interaction system ----
  function create(ctx) {
    ctx = ctx || {};
    var world = ctx.world;
    var player = ctx.player;
    var inventory = ctx.inventory;
    var hud = ctx.hud; // kept for future use (progress hints etc.)

    var breaking = false;        // desktop crosshair LMB held
    var tapBreak = null;         // {px, py} while a touch long-press is active
    var progress = 0;
    var lastBreak = null;        // {x,y,z,id} progress belongs to
    var mineTickT = 0;           // throttle for the while-mining material tick
    var MINE_TICK_SEC = 0.25;
    var creativeTimer = 0;
    var canvasEl = null;

    var sys = {
      target: null,
      update: update,
      // exposed for tests/debug (extra, not pinned)
      raycast: raycast
    };

    function gameCanvas() {
      if (!canvasEl) canvasEl = document.getElementById('game-canvas');
      return canvasEl;
    }

    function currentMode() {
      if (typeof Game !== 'undefined' && Game && typeof Game.mode === 'string') return Game.mode;
      if (player && typeof player.mode === 'string') return player.mode;
      return 'survival';
    }

    // ---- rays ----
    function crosshairRay(camera, maxDist) {
      var origin = readVec3(camera.pos);
      var dir;
      if (typeof camera.yaw === 'number' && typeof camera.pitch === 'number') {
        // pinned look direction (§3)
        var cp = Math.cos(camera.pitch);
        dir = [-Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
      } else {
        dir = screenDir(camera, 0, 0); // NDC center
        if (!dir) return null;
      }
      return raycast(world, origin, dir, maxDist);
    }

    function tapRay(camera, px, py, maxDist) {
      var cv = gameCanvas();
      var left = 0, top = 0;
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      if (cv && cv.getBoundingClientRect) {
        var r = cv.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { left = r.left; top = r.top; w = r.width; h = r.height; }
      }
      var nx = ((px - left) / w) * 2 - 1;
      var ny = 1 - ((py - top) / h) * 2;
      var dir = screenDir(camera, nx, ny);
      if (!dir) return null;
      return raycast(world, readVec3(camera.pos), dir, maxDist);
    }

    // NDC (nx,ny) -> world-space unit ray direction from the camera position.
    function screenDir(camera, nx, ny) {
      if (typeof M3 === 'undefined' || !M3 || !M3.mat4Invert || !camera.projView) return null;
      M3.mat4Invert(invPV, camera.projView);
      var far = unprojectPoint(scratchFar, invPV, nx, ny, 1);
      var o = readVec3(camera.pos);
      var dx = far[0] - o[0], dy = far[1] - o[1], dz = far[2] - o[2];
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) return null;
      return [dx / len, dy / len, dz / len];
    }

    // ---- breaking ----
    function resetProgress() {
      progress = 0;
      lastBreak = null;
    }

    function doBreak(tgt, mode) {
      var id = world.getBlock(tgt.x, tgt.y, tgt.z);
      if (!id) return;
      var def = defOf(id);
      world.setBlock(tgt.x, tgt.y, tgt.z, 0);
      if (mode !== 'creative' && inventory && typeof inventory.add === 'function') {
        var drop = def ? (typeof def.drops === 'number' ? def.drops : def.id) : id;
        if (drop > 0) inventory.add(drop, 1);
      }
      playSound('dig', id);
      resetProgress();
    }

    // ---- placing ----
    function doPlace(tgt, mode) {
      if (!tgt || !tgt.hit || !inventory) return;
      var id = typeof inventory.selectedBlock === 'function' ? inventory.selectedBlock() : 0;
      if (!id) return;
      var def = defOf(id);
      if (def && def.placeable === false) return;

      var bx = tgt.x + tgt.face[0];
      var by = tgt.y + tgt.face[1];
      var bz = tgt.z + tgt.face[2];
      if (by < 0 || by > WORLD_MAX_Y) return;
      if (bx === tgt.x && by === tgt.y && bz === tgt.z) return; // start-inside ray, no face
      if (!isReplaceable(world, bx, by, bz)) return;

      // veto: a SOLID block may not be placed inside the player's own AABB
      var solid = def ? !!def.solid : true;
      if (solid && player) {
        var body = player.body || player;
        var pp = body && body.pos ? body.pos : null;
        if (pp) {
          var px = typeof pp.x === 'number' ? pp.x : pp[0];
          var py = typeof pp.y === 'number' ? pp.y : pp[1];
          var pz = typeof pp.z === 'number' ? pp.z : pp[2];
          var hw = (body.width || 0.6) * 0.5;
          var bh = body.height || 1.8;
          if (bx < px + hw && bx + 1 > px - hw &&
              by < py + bh && by + 1 > py &&
              bz < pz + hw && bz + 1 > pz - hw) {
            return;
          }
        }
      }

      world.setBlock(bx, by, bz, id);
      if (mode !== 'creative' && typeof inventory.consumeSelected === 'function') {
        inventory.consumeSelected();
      }
      playSound('place', id);
    }

    // ---- pick-block (MMB) ----
    function doPick(tgt, mode) {
      if (!tgt || !tgt.hit || !inventory) return;
      var id = world.getBlock(tgt.x, tgt.y, tgt.z);
      if (!id) return;
      var def = defOf(id);
      var pickId = def
        ? (def.placeable === false ? (def.drops || id) : id)
        : id;
      if (!pickId) return;

      var hotbar = inventory.hotbar || [];
      for (var i = 0; i < hotbar.length; i++) {
        if (hotbar[i] && hotbar[i].id === pickId) {
          if (typeof inventory.select === 'function') inventory.select(i);
          return;
        }
      }
      if (mode === 'creative') {
        var slot = typeof inventory.selected === 'number' ? inventory.selected : 0;
        if (typeof inventory.setHotbarSlot === 'function') {
          inventory.setHotbarSlot(slot, pickId, 1);
        } else if (hotbar) {
          hotbar[slot] = { id: pickId, count: 1 };
        }
      }
    }

    // ---- per-frame update ----
    function update(dt, actions, camera) {
      if (!world || !camera) return;
      if (!(dt > 0)) dt = 0;

      var mode = currentMode();
      var creative = mode === 'creative';
      var reach = creative ? REACH_CREATIVE : REACH_SURVIVAL;

      // consume the action queue
      if (actions && actions.length) {
        for (var i = 0; i < actions.length; i++) {
          var a = actions[i];
          switch (a.type) {
            case 'breakStart':
              breaking = true;
              creativeTimer = 0; // first creative break is immediate
              resetProgress();
              break;
            case 'breakStop':
              breaking = false;
              if (!tapBreak) resetProgress();
              break;
            case 'place':
              doPlace(crosshairRay(camera, reach), mode);
              break;
            case 'pick':
              doPick(crosshairRay(camera, reach), mode);
              break;
            case 'tapPlace':
              doPlace(tapRay(camera, a.px, a.py, reach), mode);
              break;
            case 'tapBreakStart':
              // repeated events just re-aim the break ray (finger drag)
              if (!tapBreak) creativeTimer = 0;
              tapBreak = { px: a.px, py: a.py };
              break;
            case 'tapBreakStop':
              tapBreak = null;
              if (!breaking) resetProgress();
              break;
          }
        }
      }

      // resolve this frame's aim: touch break ray wins over the crosshair
      var tgt = tapBreak
        ? tapRay(camera, tapBreak.px, tapBreak.py, reach)
        : crosshairRay(camera, reach);

      var aiming = breaking || !!tapBreak;

      if (!tgt || !tgt.hit) {
        sys.target = null;
        if (aiming) resetProgress();
        return;
      }

      if (aiming) {
        var id = world.getBlock(tgt.x, tgt.y, tgt.z);
        if (creative) {
          creativeTimer -= dt;
          if (creativeTimer <= 0) {
            doBreak(tgt, mode);
            creativeTimer = CREATIVE_REPEAT;
          }
          progress = 0;
        } else {
          // survival: hold-to-break, progress resets when the target changes
          if (!lastBreak || lastBreak.x !== tgt.x || lastBreak.y !== tgt.y ||
              lastBreak.z !== tgt.z || lastBreak.id !== id) {
            progress = 0;
            lastBreak = { x: tgt.x, y: tgt.y, z: tgt.z, id: id };
          }
          var def = defOf(id);
          var hard = (def && typeof def.hardness === 'number') ? def.hardness : 1.0;
          if (hard <= 0) hard = 0.05;
          if (isFinite(hard)) {
            progress += dt / hard;
            // soft material tick while actively mining (Minecraft-style),
            // throttled so long digs don't machine-gun the sound
            mineTickT -= dt;
            if (mineTickT <= 0 && progress < 1) {
              playSound('mine', id);
              mineTickT = MINE_TICK_SEC;
            }
            if (progress >= 1) doBreak(tgt, mode);
          } else {
            progress = 0; // bedrock and friends: never
          }
        }
      } else {
        progress = 0;
        lastBreak = null;
      }

      sys.target = {
        hit: true,
        x: tgt.x, y: tgt.y, z: tgt.z,
        face: tgt.face,
        progress: progress > 1 ? 1 : progress
      };
    }

    return sys;
  }

  // ---- module export ----
  var Interact = {
    raycast: raycast,
    create: create
  };
  return Interact;
})();

window.Interact = Interact;
