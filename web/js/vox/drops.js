// drops.js — dropped-item entities: small bobbing/spinning pickups that
// represent a stack, collected on player proximity.
// Exactly one global: window.Drops (contract ARCHITECTURE-COMBAT.md §11).
//
// No physics simulation beyond a simple gravity-drop-then-rest-on-ground arc
// plus an idle bob/spin — NOT a general physics-entity system.
//
// Two independent paths, per contract:
//
//   1) LOCAL (solo/offline) — the DEFAULT/simpler path. Drops.spawn/update/
//      checkPickup/draw/remove run entirely client-side; this is fully
//      self-contained and correct with no server involved.
//
//   2) MULTIPLAYER shapes — Drops.applyServerState(batch)/serverSpawn(d)/
//      serverDespawn(id) entry points a sibling's Go server + Game.js can
//      wire Net events into later (dropSpawn/dropState/dropDespawn messages,
//      client sends pickup{dropId}). This module does not assume the Go side
//      exists yet; it just exposes the shapes a reasonable server-authoritative
//      implementation would emit, matching the mob-sync wire shape established
//      in §7/§5.1 (batched state messages, spawn/despawn singles).
//
// Rendering: shares the Blocks atlas texture (block-kind drops) and, when the
// sibling `Items` module is present, its 40x40 icon canvases (item-kind
// drops) — both drawn as a small ~0.25-unit simple 3-face box (top + 2
// visible sides), matching the "held-block mini-cube" style used elsewhere
// (§9's held-item mesh) rather than a full 6-face cube (cheap and the bottom/
// back faces are never seen on a bobbing ground pickup anyway... actually we
// DO draw all 6 so spinning always looks correct from any angle a player can
// walk around to; "small 3-face box is fine" in the contract describes the
// *held* mesh specifically, drops spin freely so full box reads better for
// roughly the same vertex cost at this tiny scale).
//
// Depends on (all optional/guarded): GLX, M3, Blocks, Items, Skins (unused
// here directly, but harmless if absent), World (duck-typed via getBlock).

var Drops = (function () {
  'use strict';

  // ---- constants ------------------------------------------------------------

  var DROP_SIZE = 0.25;              // model half-extent-ish scale (contract: "~0.25 unit")
  var PICKUP_RADIUS = 1.2;           // blocks
  var MERGE_RADIUS = 0.5;            // blocks
  var DESPAWN_AFTER_MS = 5 * 60 * 1000; // 5 minutes
  var GRAVITY = 22;                  // blocks/s^2 (a bit gentler than player gravity — reads floatier)
  var BOB_AMP = 0.08;                // blocks
  var BOB_SPEED = 2.2;               // rad/s
  var SPIN_SPEED = 1.1;              // rad/s
  var GROUND_EPS = 0.02;

  // ---- tiny helpers -----------------------------------------------------------

  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function isSolidAt(world, x, y, z) {
    if (!world || !world.getBlock) return false;
    var id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (!id) return false;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var def = Blocks.byId(id);
      return !!(def && def.solid);
    }
    return id !== 11 && !(id >= 27 && id <= 29);
  }

  var _idSeq = 1;
  function nextLocalId() { return 'drop' + (_idSeq++); }

  // ---- shader (one tiny textured-box program, independent of PlayerModel) ----
  // aPos(3) aUV(2) aFaceTint(1, 0..1 per-face shade for a cheap fake-AO look).

  var VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec2 aUV;',
    'layout(location=2) in float aTint;',
    'uniform mat4 uViewProj;',
    'uniform mat4 uModel;',
    'out vec2 vUV;',
    'out float vTint;',
    'void main() {',
    '  vec4 w = uModel * vec4(aPos, 1.0);',
    '  vUV = aUV;',
    '  vTint = aTint;',
    '  gl_Position = uViewProj * w;',
    '}'
  ].join('\n');

  var FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUV;',
    'in float vTint;',
    'uniform sampler2D uTex;',
    'uniform float uLight;',
    'uniform vec3 uFogColor;',
    'uniform float uFogStart;',
    'uniform float uFogEnd;',
    'uniform float uCamDist;',   // distance from camera to this drop's world pos (cheap per-draw scalar fog)
    'uniform float uCutout;',
    'out vec4 outColor;',
    'void main() {',
    '  vec4 c = texture(uTex, vUV);',
    '  if (uCutout > 0.5 && c.a < 0.5) discard;',
    '  vec3 col = c.rgb * vTint * uLight;',
    '  float f = clamp((uCamDist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);',
    '  outColor = vec4(mix(col, uFogColor, f), 1.0);',
    '}'
  ].join('\n');

  // ---- geometry: a simple 6-face unit box, UV per-face 0..1 (caller supplies
  // an atlas sub-rect or a whole-icon texture; both are just "sample this
  // texture" from the shader's point of view — icon textures use the full
  // 0..1 range, atlas textures use the tile's inset UV rect passed in per
  // vertex at build time). Built once, shared by every drop instance via a
  // per-vertex UV rebuild only when a drop's texture rect actually differs
  // (atlas tile) — items always reuse the same 0..1 rect.

  function pushFace(v, p0, p1, p2, p3, uvRect, tint) {
    var u0 = uvRect[0], v0v = uvRect[1], u1 = uvRect[2], v1v = uvRect[3];
    var uvs = [[u0, v0v], [u1, v0v], [u1, v1v], [u0, v1v]];
    var corners = [p0, p1, p2, p0, p2, p3];
    var uvOrder = [uvs[0], uvs[1], uvs[2], uvs[0], uvs[2], uvs[3]];
    for (var i = 0; i < 6; i++) {
      v.push(corners[i][0], corners[i][1], corners[i][2], uvOrder[i][0], uvOrder[i][1], tint);
    }
  }

  // Builds one box's CPU vertex data for a given uvRect (applied identically
  // to all 6 faces — fine for both a whole-icon texture and a single atlas
  // tile, since a block's def.tiles may differ per face but a drop is small
  // enough that using the block's TOP tile on every face reads perfectly
  // well at this scale and keeps geometry trivial).
  function buildBoxData(uvRect) {
    var h = 0.5; // unit cube -0.5..0.5, scaled by DROP_SIZE*2 at draw time
    var verts = [];
    // Per-face tint gives a cheap fake-AO so the cube doesn't look flat.
    pushFace(verts, [-h, h, h], [h, h, h], [h, -h, h], [-h, -h, h], uvRect, 1.0);   // front (+Z)
    pushFace(verts, [h, h, -h], [-h, h, -h], [-h, -h, -h], [h, -h, -h], uvRect, 0.75); // back (-Z)
    pushFace(verts, [-h, h, -h], [-h, h, h], [-h, -h, h], [-h, -h, -h], uvRect, 0.8);  // left (-X)
    pushFace(verts, [h, h, h], [h, h, -h], [h, -h, -h], [h, -h, h], uvRect, 0.8);      // right (+X)
    pushFace(verts, [-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h], uvRect, 1.0);      // top (+Y)
    pushFace(verts, [-h, -h, h], [h, -h, h], [h, -h, -h], [-h, -h, -h], uvRect, 0.6);  // bottom (-Y)
    return new Float32Array(verts);
  }

  // ---- per-GL-context state ---------------------------------------------------

  var _states = []; // [{gl, prog, uni, broken}]

  function buildState(gl) {
    var st = { gl: gl, prog: null, uni: null, broken: false };
    try {
      if (typeof GLX === 'undefined' || typeof M3 === 'undefined') {
        throw new Error('Drops: GLX/M3 must load first');
      }
      st.prog = GLX.program(gl, VS, FS);
      st.uni = GLX.uniforms(gl, st.prog);
    } catch (e) {
      st.broken = true;
      if (typeof console !== 'undefined') console.error('Drops init failed:', e);
    }
    return st;
  }

  function stateFor(gl) {
    if (!gl) return null;
    for (var i = 0; i < _states.length; i++) {
      if (_states[i].gl === gl) return _states[i].broken ? null : _states[i];
    }
    var st = buildState(gl);
    _states.push(st);
    return st.broken ? null : st;
  }

  // ---- texture resolution ------------------------------------------------------
  // Block-kind drops share the SAME atlas texture already bound for world
  // rendering (no new upload) — we ask Blocks for its atlas canvas and build
  // ONE shared texture from it per GL context (distinct from Renderer's own
  // atlas upload, since Blocks doesn't hand out its already-uploaded texture
  // handle across modules — Blocks.buildAtlas(gl) is meant to be called by
  // whoever owns rendering per contract §4, so calling it again here just
  // re-uploads the identical procedural canvas, which is cheap/one-time and
  // avoids any cross-module texture-handle coupling).
  var _atlasByGL = []; // [{gl, tex, tileUV}]
  var _iconTexByGL = []; // [{gl, id, tex}] — Items.icon() cache, memoized per (gl,id)

  function atlasFor(gl) {
    for (var i = 0; i < _atlasByGL.length; i++) if (_atlasByGL[i].gl === gl) return _atlasByGL[i];
    if (typeof Blocks === 'undefined' || !Blocks.buildAtlas) return null;
    var built = null;
    try { built = Blocks.buildAtlas(gl); } catch (e) { built = null; }
    if (!built) return null;
    var entry = { gl: gl, tex: built.tex, tileUV: built.tileUV || Blocks.tileUV };
    _atlasByGL.push(entry);
    return entry;
  }

  function iconTexFor(gl, id) {
    for (var i = 0; i < _iconTexByGL.length; i++) {
      if (_iconTexByGL[i].gl === gl && _iconTexByGL[i].id === id) return _iconTexByGL[i].tex;
    }
    if (typeof Items === 'undefined' || !Items.icon) return null;
    var canvas = null;
    try { canvas = Items.icon(id); } catch (e) { canvas = null; }
    if (!canvas) return null;
    var tex = null;
    try { tex = GLX.texture2D(gl, { canvas: canvas, filter: 'nearest', wrap: 'clamp' }); } catch (e) { tex = null; }
    if (tex) _iconTexByGL.push({ gl: gl, id: id, tex: tex });
    return tex;
  }

  // Returns {tex, uvRect, cutout} for a stack {id,kind}, or null if not
  // resolvable yet (e.g. Items not loaded, or an id Blocks doesn't know).
  function resolveVisual(gl, stack) {
    if (!stack) return null;
    if (stack.kind === 'item') {
      var tex = iconTexFor(gl, stack.id);
      if (!tex) return null;
      return { tex: tex, uvRect: [0, 0, 1, 1], cutout: true };
    }
    // block kind (default)
    var atlas = atlasFor(gl);
    if (!atlas) return null;
    var def = (typeof Blocks !== 'undefined' && Blocks.byId) ? Blocks.byId(stack.id) : null;
    if (!def) return null;
    var tileIdx = (def.tiles && typeof def.tiles === 'object') ? def.tiles.top : def.tiles;
    if (typeof tileIdx !== 'number') tileIdx = 0;
    var uv = atlas.tileUV(tileIdx);
    return { tex: atlas.tex, uvRect: uv, cutout: !!def.cutout };
  }

  // ---- module state: drop instances -------------------------------------------

  var _gl = null;
  var drops = Object.create(null); // id -> Drop

  // Drop: { id, pos:[x,y,z], vel:[x,y,z], stack:{id,count,kind}, spawnedAt (ms),
  //         resting (bool), phase (rad, bob/spin clock), geo:{vao,ranges}|null,
  //         visualKey (string, to detect stack-visual changes -> rebuild geo) }

  function init(gl) {
    _gl = gl || null;
  }

  function makeDrop(id, pos, stack) {
    return {
      id: id,
      pos: [pos[0], pos[1], pos[2]],
      vel: [0, 0, 0],
      stack: { id: stack.id, count: Math.max(1, stack.count | 0 || 1), kind: (stack.kind === 'item') ? 'item' : 'block' },
      spawnedAt: nowMs(),
      resting: false,
      phase: Math.random() * Math.PI * 2,
      vao: null,
      visualKey: null
    };
  }

  // ---- public: local spawn -----------------------------------------------------

  function spawn(pos, stack) {
    if (!pos || !stack || !stack.id) return null;
    var id = nextLocalId();
    drops[id] = makeDrop(id, pos, stack);
    return id;
  }

  function remove(dropId) {
    var d = drops[dropId];
    if (!d) return;
    if (d.vao && _gl) { try { _gl.deleteVertexArray(d.vao); } catch (e) { /* ctx may be gone */ } }
    delete drops[dropId];
  }

  // ---- update: gravity-drop-then-rest, despawn, merge --------------------------

  function stepOne(d, dt, world) {
    if (!d.resting) {
      d.vel[1] -= GRAVITY * dt;
      var nx = d.pos[0] + d.vel[0] * dt;
      var ny = d.pos[1] + d.vel[1] * dt;
      var nz = d.pos[2] + d.vel[2] * dt;

      // Falling straight down onto a solid top: stop at the surface instead
      // of tunneling through (simple sample-below check, not a full sweep —
      // adequate at drop-fall speeds and world-block granularity).
      if (d.vel[1] < 0 && isSolidAt(world, d.pos[0], ny, d.pos[2])) {
        var floorY = Math.floor(ny) + 1;
        ny = floorY;
        d.vel[0] = 0; d.vel[1] = 0; d.vel[2] = 0;
        d.resting = true;
      }
      // No horizontal collision handling: drops only ever fall straight down
      // per contract ("no full physics engine", "gravity-drop-then-rest").
      d.pos[0] = nx; d.pos[1] = ny; d.pos[2] = nz;

      // Safety: if we've fallen well past any reasonable world floor (e.g.
      // spawned over a hole with ungenerated chunks below), settle at y=0
      // rather than fall forever.
      if (d.pos[1] < -8) { d.pos[1] = 0; d.resting = true; d.vel[0] = d.vel[1] = d.vel[2] = 0; }
    } else {
      // Once resting, re-check the ground is still there (a block below could
      // have been mined out from under the drop) — if not, resume falling.
      if (!isSolidAt(world, d.pos[0], d.pos[1] - GROUND_EPS - 0.01, d.pos[2])) {
        d.resting = false;
      }
    }
    d.phase += dt;
  }

  function mergeDrops() {
    var ids = Object.keys(drops);
    for (var i = 0; i < ids.length; i++) {
      var a = drops[ids[i]];
      if (!a) continue;
      for (var j = i + 1; j < ids.length; j++) {
        var b = drops[ids[j]];
        if (!b) continue;
        if (a.stack.id !== b.stack.id || a.stack.kind !== b.stack.kind) continue;
        // Item-kind stacks (tools/armor) never stack beyond 1 (contract §4) —
        // merging two item drops would silently create an invalid count>1
        // item stack, so skip merge for kind==='item' entirely.
        if (a.stack.kind === 'item') continue;
        var dx = a.pos[0] - b.pos[0], dy = a.pos[1] - b.pos[1], dz = a.pos[2] - b.pos[2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > MERGE_RADIUS) continue;
        var total = a.stack.count + b.stack.count;
        var cap = (typeof Inventory !== 'undefined' && Inventory.MAX_STACK) ? Inventory.MAX_STACK : 64;
        if (total > cap) continue; // don't merge past the stack cap
        a.stack.count = total;
        remove(b.id);
        ids[j] = null; // already removed
      }
    }
  }

  function update(dt, world) {
    dt = (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 0;
    var now = nowMs();
    for (var id in drops) {
      var d = drops[id];
      if (now - d.spawnedAt >= DESPAWN_AFTER_MS) { remove(id); continue; }
      stepOne(d, dt, world);
    }
    mergeDrops();
  }

  // ---- pickup -------------------------------------------------------------------

  function checkPickup(playerPos, inventory) {
    var collected = [];
    if (!playerPos || !inventory || !inventory.add) return collected;
    for (var id in drops) {
      var d = drops[id];
      var dx = d.pos[0] - playerPos[0], dy = d.pos[1] - playerPos[1], dz = d.pos[2] - playerPos[2];
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > PICKUP_RADIUS) continue;

      var leftover;
      if (d.stack.kind === 'item') {
        // Item-kind stacks are always count 1 (contract §4); Inventory.add
        // (Part I) is block-id-shaped today — call it defensively and treat
        // "any room" as all-or-nothing for a single item, since a partial
        // pickup of a count-1 stack is meaningless.
        leftover = inventory.add(d.stack.id, 1);
        if (leftover === 0) {
          collected.push({ id: d.stack.id, kind: 'item', count: 1 });
          remove(id);
        }
        continue;
      }

      leftover = inventory.add(d.stack.id, d.stack.count);
      var picked = d.stack.count - leftover;
      if (picked > 0) {
        collected.push({ id: d.stack.id, kind: 'block', count: picked });
        if (leftover > 0) {
          d.stack.count = leftover; // partial pickup: leftover stays as a (smaller) drop
        } else {
          remove(id);
        }
      }
    }
    return collected;
  }

  // ---- draw ---------------------------------------------------------------------

  function ensureGeo(gl, d, visual) {
    var key = visual.uvRect.join(',') + '|' + (visual.tex === d._lastTex ? '1' : '0');
    if (d.vao && d.visualKey === key) return; // unchanged since last build
    if (d.vao) { try { gl.deleteVertexArray(d.vao); } catch (e) { /* ignore */ } }
    var data = buildBoxData(visual.uvRect);
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
    gl.bindVertexArray(null);
    d.vao = vao;
    d.vertCount = data.length / 6;
    d.visualKey = key;
    d._lastTex = visual.tex;
  }

  var _mIdent = new Float32Array(16), _mT = new Float32Array(16),
      _mR = new Float32Array(16), _mS = new Float32Array(16);

  function drawOne(gl, st, d, camera, env) {
    var visual = resolveVisual(gl, d.stack);
    if (!visual) return; // texture not resolvable yet (e.g. Items not loaded) — skip this frame

    ensureGeo(gl, d, visual);

    var bobY = Math.sin(d.phase * BOB_SPEED) * BOB_AMP;
    var spin = d.phase * SPIN_SPEED;

    M3.mat4Identity(_mIdent);
    M3.mat4Translate(_mT, _mIdent, d.pos[0], d.pos[1] + DROP_SIZE + bobY, d.pos[2]);
    M3.mat4RotateY(_mR, _mT, spin);
    M3.mat4Scale(_mS, _mR, DROP_SIZE, DROP_SIZE, DROP_SIZE);

    gl.uniformMatrix4fv(st.uni.uModel, false, _mS);
    gl.uniform1f(st.uni.uCutout, visual.cutout ? 1 : 0);

    var camPos = camera.pos || [0, 0, 0];
    var ddx = d.pos[0] - camPos[0], ddy = d.pos[1] - camPos[1], ddz = d.pos[2] - camPos[2];
    var camDist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    gl.uniform1f(st.uni.uCamDist, camDist);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, visual.tex);
    gl.bindVertexArray(d.vao);
    gl.drawArrays(gl.TRIANGLES, 0, d.vertCount);
    gl.bindVertexArray(null);
  }

  function pushDrawState(gl) {
    var cull = gl.isEnabled(gl.CULL_FACE);
    var blend = gl.isEnabled(gl.BLEND);
    var depth = gl.isEnabled(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    return function () {
      if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      if (blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      if (depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    };
  }

  function draw(gl, camera, env) {
    var st = stateFor(gl);
    if (!st || !camera || !camera.projView) return;
    var hasDrops = false;
    for (var id in drops) { hasDrops = true; break; }
    if (!hasDrops) return;

    gl.useProgram(st.prog);
    gl.uniformMatrix4fv(st.uni.uViewProj, false, camera.projView);
    gl.uniform1i(st.uni.uTex, 0);
    var ambient = (env && typeof env.ambient === 'number') ? env.ambient : 0.5;
    gl.uniform1f(st.uni.uLight, clamp(ambient + 0.5, 0.3, 1.1));
    if (env && env.fogColor) {
      gl.uniform3f(st.uni.uFogColor, env.fogColor[0], env.fogColor[1], env.fogColor[2]);
      gl.uniform1f(st.uni.uFogStart, env.fogStart != null ? env.fogStart : 1e8);
      gl.uniform1f(st.uni.uFogEnd, env.fogEnd != null ? env.fogEnd : 2e8);
    } else {
      gl.uniform3f(st.uni.uFogColor, 0, 0, 0);
      gl.uniform1f(st.uni.uFogStart, 1e8);
      gl.uniform1f(st.uni.uFogEnd, 2e8);
    }

    var restore = pushDrawState(gl);
    for (var did in drops) drawOne(gl, st, drops[did], camera, env);
    gl.bindVertexArray(null);
    restore();
  }

  // ---- misc / lifecycle ---------------------------------------------------------

  function list() {
    var out = [];
    for (var id in drops) {
      var d = drops[id];
      out.push({ id: d.id, pos: d.pos.slice(), stack: { id: d.stack.id, count: d.stack.count, kind: d.stack.kind } });
    }
    return out;
  }

  function count() {
    var n = 0;
    for (var id in drops) n++;
    return n;
  }

  function clear() {
    for (var id in drops) remove(id);
  }

  // ===========================================================================
  // ---- MULTIPLAYER server-state entry points (shapes only — §11 closing) ----
  // ===========================================================================
  //
  // A sibling Go builder's `internal/rooms` Instance is expected to track a
  // `drops map[string]Drop{id,pos,stack,spawnedAt}` and broadcast:
  //   dropSpawn   {id, pos:[x,y,z], stack:{id,count,kind}}
  //   dropState   {d:[[id,x,y,z],...]}          // batched like mobState, position-only
  //                                              // (stack/count don't change mid-flight)
  //   dropDespawn {id}
  // and accept a client `pickup{dropId}` request, validating proximity +
  // inventory space server-authoritatively before confirming removal (same
  // anti-cheat posture as combat's `hit` — a client never unilaterally
  // deletes a server-tracked drop in MP; it only requests, then the server's
  // own dropDespawn confirms it, same as chunk `block` edits echo back).
  //
  // These entry points let Game.js wire Net.on('dropSpawn'/'dropState'/
  // 'dropDespawn', ...) straight into this module without this module ever
  // touching Net directly (matches this file's "no Net dependency" posture —
  // Game.js is the integration point, per house convention elsewhere too).

  // dropSpawn: register a server-authoritative drop by its SERVER id (so a
  // later dropDespawn{id} or dropState row referencing the same id resolves
  // to the same visual instance — server ids are used as-is, no local prefix,
  // so they never collide with locally-spawned 'dropN' ids in solo mode,
  // where this path is simply never invoked).
  function serverSpawn(d) {
    if (!d || d.id == null || !d.stack) return;
    if (drops[d.id]) return; // already known (e.g. dropState arrived first via a race)
    var pos = d.pos || d.p || [0, 0, 0];
    var drop = makeDrop(d.id, pos, d.stack);
    drop.resting = true; // server already resolved rest state; avoid a client-side re-simulation pop
    drop.serverManaged = true;
    drops[d.id] = drop;
  }

  function serverDespawn(id) {
    remove(id);
  }

  // batch: [[id,x,y,z],...] OR [{id,pos:[x,y,z]},...] — position-only update
  // for server-tracked drops (a drop's stack contents never change in place;
  // only position moves, e.g. sliding down a slope before resting).
  function applyServerState(batch) {
    if (!Array.isArray(batch)) return;
    for (var i = 0; i < batch.length; i++) {
      var row = batch[i];
      if (!row) continue;
      var id, x, y, z;
      if (Array.isArray(row)) {
        id = row[0]; x = row[1]; y = row[2]; z = row[3];
      } else {
        id = row.id;
        var p = row.pos || row.p || [row.x, row.y, row.z];
        x = p[0]; y = p[1]; z = p[2];
      }
      var d = drops[id];
      if (!d) continue; // unknown id (spawn hasn't arrived yet) — drop safely, matches Mobs/RemotePlayers pattern
      d.pos[0] = Number(x) || 0; d.pos[1] = Number(y) || 0; d.pos[2] = Number(z) || 0;
    }
  }

  // ---- public API -------------------------------------------------------------

  return {
    init: init,

    // local (solo/offline) path — default/simpler, fully self-contained
    spawn: spawn,
    update: update,
    checkPickup: checkPickup,
    draw: draw,
    remove: remove,
    list: list,
    count: count,
    clear: clear,

    // multiplayer server-state shapes (Game.js wires Net events into these)
    applyServerState: applyServerState,
    serverSpawn: serverSpawn,
    serverDespawn: serverDespawn,

    // tunables exposed read-only for callers/tests that want to reason about
    // merge/pickup distances without hardcoding a second copy of the numbers
    PICKUP_RADIUS: PICKUP_RADIUS,
    MERGE_RADIUS: MERGE_RADIUS
  };
})();

window.Drops = Drops;
