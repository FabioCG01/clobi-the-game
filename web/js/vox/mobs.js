// mobs.js — mob rendering (server-synced, multiplayer) + a small self-
// contained local mob simulation for solo/offline play.
// Exactly one global: window.Mobs (contract ARCHITECTURE-COMBAT.md §7).
//
// Rendering reuses PlayerModel's existing classic-rig geometry (Part I §5.8):
// a mob is drawn as a PlayerModel-shaped entity with a procedurally generated
// skin texture (green/tattered zombie, pink pig), model 'classic', no overlay
// content (the overlay layer geometry still exists — PlayerModel always draws
// both layers — but the overlay pixels we paint are fully transparent, so
// nothing extra shows; that's what "no overlay layer" means in practice here
// since PlayerModel.draw() doesn't have a per-call layer-skip switch).
//
// Two independent halves live in this one file, per the contract:
//
//   1) SERVER-SYNCED mobs (multiplayer): Mobs.sync/applyState/spawn/despawn
//      feed a snapshot-history buffer per mob id; Mobs.update(dt) renders
//      150ms behind the newest snapshot, exactly like RemotePlayers (Part II
//      §4.2) — position lerp + shortest-arc yaw lerp. The Go server owns all
//      AI/authority for this path; this module only interpolates + draws.
//
//   2) LOCAL mob simulation (solo/offline, !Game.isMultiplayer): a small
//      (~50 line) wander/chase heuristic exposed as Mobs.localTick(dt, world,
//      physics, playerPos) that Game.js calls every frame instead of relying
//      on the server. This half owns its OWN spawn/despawn/population-cap
//      bookkeeping so Game.js's job is just "call localTick, render whatever
//      comes back" — no spawn logic lives in Game.js.
//
// These two halves share only the rendering code (draw()) and the procedural
// skin-texture cache; their state (players/snapshots vs. local mob list) is
// kept in separate structures so multiplayer sync can never leak into local
// simulation state or vice versa.
//
// Depends on (all optional/guarded, matching house style): PlayerModel, M3,
// Blocks (for isSolidAt-style ground checks in the local sim).

var Mobs = (function () {
  'use strict';

  // ---- constants ----------------------------------------------------------

  var RENDER_DELAY_MS = 150;      // same render-behind window as RemotePlayers
  var HISTORY_MAX = 4;
  var TWO_PI = Math.PI * 2;

  // Roster HP (contract §7).
  var HP_BY_KIND = { zombie: 20, pig: 10 };

  // Population caps (contract §7: "e.g. 8" zombies, "e.g. 6" pigs).
  var CAP_ZOMBIE = 8;
  var CAP_PIG = 6;

  // Local-sim tunables.
  var CHASE_RANGE = 16;           // blocks; zombie aggro radius
  var ATTACK_RANGE = 1.2;         // blocks; adjacency for an attack
  var ATTACK_COOLDOWN_S = 1.0;    // seconds between zombie hits on the player
  var DESPAWN_DIST = 64;          // blocks; no player within this -> despawn timer starts
  var DESPAWN_AFTER_S = 30;       // seconds with no nearby player before despawn
  var WANDER_INTERVAL_MIN = 3, WANDER_INTERVAL_MAX = 7; // seconds between new wander targets
  var WANDER_RADIUS = 6;          // blocks
  var FLEE_DURATION_S = 4;        // seconds a pig flees after being hit
  var MOB_SPEED = { zombie: 2.6, pig: 2.0, zombieFlee: 0, pigFlee: 3.4 }; // blocks/s
  var SPAWN_CHECK_INTERVAL_S = 2; // how often localTick attempts a new spawn roll
  var SPAWN_TRY_RADIUS_MIN = 8, SPAWN_TRY_RADIUS_MAX = 24; // blocks from player
  var MOB_HALF_WIDTH = 0.3;       // rough mob footprint half-width for step-avoid checks
  var MOB_HEIGHT = 1.8;

  // Motion-smoothing tunables (render polish only — AI decisions never read
  // these). All easing is frame-rate independent via factor = 1 - e^(-k*dt).
  var YAW_EASE_RATE = 10;          // ~rad/s: visible yaw eases toward the wish direction
  var SWING_EASE_RATE = 10;        // walk-cycle amplitude ease-in/out speed (start/stop walking)
  var SWING_CYCLES_PER_BLOCK = 0.85; // walk-cycle phase advance per block actually traveled
  var STAND_SPEED_EPS = 0.2;       // blocks/s under which a mob counts as standing still
  var LUNGE_DURATION_S = 0.25;     // zombie attack telegraph: brief full-amplitude whip
  var LUNGE_SWING_RATE = 2.5;      // extra swing-phase cycles/s while the telegraph plays
  var GRAZE_ROLL_MIN = 5, GRAZE_ROLL_MAX = 11;      // seconds between pig graze-pause rolls
  var GRAZE_PAUSE_MIN = 1.2, GRAZE_PAUSE_MAX = 2.6; // seconds a grazing pig stands still
  var GRAZE_CHANCE = 0.6;          // probability a graze roll actually pauses the pig
  var IDLE_SWAY_SPEED = 1.7;       // rad/s of the idle pig head-sway sine
  var IDLE_SWAY_RAD = 0.12;        // amplitude (rad) of that sway — subtle, head only

  // ---- tiny helpers ---------------------------------------------------------

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, f) { return a + (b - a) * f; }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  function shortestAngleDelta(from, to) {
    var d = (to - from) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    return d;
  }
  function lerpAngle(a, b, f) { return a + shortestAngleDelta(a, b) * f; }

  function dist2(ax, az, bx, bz) {
    var dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }

  function randRange(lo, hi) { return lo + Math.random() * (hi - lo); }

  // ---- procedural mob skin textures (green zombie / pink pig) ---------------
  // Built as a full 64x64 "skin sheet" canvas honoring the SAME net layout
  // PlayerModel/Skins already use (classic model), so PlayerModel.draw() can
  // treat a mob exactly like a reskinned player with zero geometry changes.
  // Base layer is fully painted (opaque); overlay-layer region is left fully
  // transparent (alpha 0) so no second silhouette shows — satisfies "no
  // overlay layer" while still handing PlayerModel a normal 64x64 sheet.

  function hashPix(x, y, salt) {
    var h = Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA6B) ^ Math.imul(salt, 0xC2B2AE35);
    h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
    h = Math.imul(h ^ (h >>> 12), 0x297A2D39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  // Paints one solid-ish region [x0,y0,w,h) with a base color + per-pixel
  // jitter + occasional darker "tatter/spot" fleck, entirely deterministic.
  function paintRegion(data, x0, y0, w, h, base, jitter, fleckChance, fleckColor, salt) {
    for (var y = y0; y < y0 + h; y++) {
      for (var x = x0; x < x0 + w; x++) {
        var r1 = hashPix(x, y, salt);
        var f = 1 + (hashPix(x, y, salt + 101) - 0.5) * 2 * jitter;
        var col = base;
        if (fleckChance > 0 && r1 < fleckChance) col = fleckColor;
        var o = (y * 64 + x) * 4;
        data[o] = clamp(Math.round(col[0] * f), 0, 255);
        data[o + 1] = clamp(Math.round(col[1] * f), 0, 255);
        data[o + 2] = clamp(Math.round(col[2] * f), 0, 255);
        data[o + 3] = 255;
      }
    }
  }

  // Net origins for the classic model, base layer (Part I §5.7 table) — only
  // what we need to paint a believable full-body base skin: head, body, arms,
  // legs. We paint generously-sized rectangular blocks covering each part's
  // full net footprint (a little wasted canvas coverage between UV islands is
  // harmless; nothing outside the actual UV rects is ever sampled).
  var NET_BASE_RECTS = [
    { x: 0, y: 0, w: 32, h: 16 },    // head (top+bottom+4 sides strip)
    { x: 16, y: 16, w: 24, h: 16 },  // body
    { x: 40, y: 16, w: 16, h: 16 },  // right arm (classic 4px)
    { x: 32, y: 48, w: 16, h: 16 },  // left arm (classic 4px)
    { x: 0, y: 16, w: 16, h: 16 },   // right leg
    { x: 16, y: 48, w: 16, h: 16 }   // left leg
  ];

  function buildMobSkinCanvas(kind) {
    var cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(64, 64);
    var data = img.data; // starts fully transparent (alpha 0) everywhere

    var palette, jitter, fleckChance, fleckColor, salt;
    if (kind === 'pig') {
      palette = [222, 150, 165];       // pink
      jitter = 0.10;
      fleckChance = 0.05;
      fleckColor = [190, 110, 130];    // dusty rose spots
      salt = 7001;
    } else { // zombie (default)
      palette = [86, 140, 74];         // sickly green
      jitter = 0.16;
      fleckChance = 0.10;
      fleckColor = [58, 66, 46];       // tattered dark patches
      salt = 4001;
    }

    for (var i = 0; i < NET_BASE_RECTS.length; i++) {
      var r = NET_BASE_RECTS[i];
      paintRegion(data, r.x, r.y, r.w, r.h, palette, jitter, fleckChance, fleckColor, salt + i * 31);
    }

    // A few deterministic darker "eye" pixels on the zombie's head-front face
    // so it doesn't read as a featureless green blob (front face = net rect
    // (U+D, V+D, W, H) for the 8x8x8 head at (0,0) -> (8,8,8,8)).
    if (kind === 'zombie') {
      var eyeO1 = (10 * 64 + 10) * 4, eyeO2 = (10 * 64 + 13) * 4;
      data[eyeO1] = 20; data[eyeO1 + 1] = 20; data[eyeO1 + 2] = 20; data[eyeO1 + 3] = 255;
      data[eyeO2] = 20; data[eyeO2 + 1] = 20; data[eyeO2 + 2] = 20; data[eyeO2 + 3] = 255;
    }
    if (kind === 'pig') {
      // Tiny darker snout dots on the head front face for a pig "nose" hint.
      var noseO1 = (11 * 64 + 10) * 4, noseO2 = (11 * 64 + 12) * 4;
      data[noseO1] = 150; data[noseO1 + 1] = 90; data[noseO1 + 2] = 100; data[noseO1 + 3] = 255;
      data[noseO2] = 150; data[noseO2 + 1] = 90; data[noseO2 + 2] = 100; data[noseO2 + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // Cache: per (gl, kind) -> WebGLTexture. Rebuilt per GL context like
  // RemotePlayers' default-skin texture cache.
  var _skinCanvasByKind = Object.create(null);   // kind -> HTMLCanvasElement (shared across GL contexts)
  var _texByGL = [];                             // [{gl, kind, tex}]

  function skinCanvasFor(kind) {
    var k = (kind === 'pig') ? 'pig' : 'zombie';
    if (!_skinCanvasByKind[k]) _skinCanvasByKind[k] = buildMobSkinCanvas(k);
    return _skinCanvasByKind[k];
  }

  function texFor(gl, kind) {
    if (!gl) return null;
    var k = (kind === 'pig') ? 'pig' : 'zombie';
    for (var i = 0; i < _texByGL.length; i++) {
      if (_texByGL[i].gl === gl && _texByGL[i].kind === k) return _texByGL[i].tex;
    }
    if (typeof Skins === 'undefined' || !Skins.texture) return null;
    var tex = null;
    try { tex = Skins.texture(gl, { canvas: skinCanvasFor(k) }); } catch (e) { tex = null; }
    if (tex) _texByGL.push({ gl: gl, kind: k, tex: tex });
    return tex;
  }

  // ---- module state: GL + server-synced mobs ---------------------------------

  var _gl = null;
  var mobs = Object.create(null);   // id -> MobState (server-synced roster)

  // MobState:
  //   id, kind ('zombie'|'pig'), hp, maxHp
  //   history: [{t, p:[x,y,z], yaw, hp, anim}]
  //   pose: {p:[x,y,z], yaw, swing, swingAmp}

  function newMobState(id, kind, p, hp) {
    var st = {
      id: id,
      kind: (kind === 'pig') ? 'pig' : 'zombie',
      hp: (typeof hp === 'number') ? hp : (HP_BY_KIND[kind] || 20),
      maxHp: HP_BY_KIND[kind] || 20,
      history: [],
      pose: { p: p ? [p[0], p[1], p[2]] : [0, 0, 0], yaw: 0, swing: 0, swingAmp: 0 }
    };
    st.history.push({ t: nowMs(), p: st.pose.p.slice(), yaw: 0, hp: st.hp, anim: 0 });
    return st;
  }

  function init(gl) {
    _gl = gl || null;
    // Warm the skin textures eagerly so the first draw() frame isn't bare.
    if (_gl) { texFor(_gl, 'zombie'); texFor(_gl, 'pig'); }
  }

  // ---- public: server-synced roster (multiplayer) ----------------------------

  // Replace the whole roster (e.g. on a fresh 'welcome'-adjacent mob list, if
  // the server ever sends one; also usable to bulk-seed from a snapshot).
  function sync(list) {
    var next = Object.create(null);
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (!m || m.id == null) continue;
        var existing = mobs[m.id];
        next[m.id] = existing || newMobState(m.id, m.kind, m.p || m.pos, m.hp);
      }
    }
    mobs = next;
  }

  // mobSpawn {id, kind, p:[x,y,z], hp} (contract §5.1 server->client)
  function spawn(m) {
    if (!m || m.id == null) return;
    if (mobs[m.id]) return; // already known
    mobs[m.id] = newMobState(m.id, m.kind, m.p || m.pos, m.hp);
  }

  function despawn(id) {
    delete mobs[id];
  }

  // batch: [[id,x,y,z,yaw,hp,anim],...] per contract §5.1 'mobState'.
  function applyState(batch) {
    if (!Array.isArray(batch)) return;
    var t = nowMs();
    for (var i = 0; i < batch.length; i++) {
      var row = batch[i];
      if (!row) continue;
      var id, x, y, z, yaw, hp, anim;
      if (Array.isArray(row)) {
        id = row[0]; x = row[1]; y = row[2]; z = row[3];
        yaw = row[4]; hp = row[5]; anim = row[6];
      } else {
        id = row.id;
        var p = row.p || [row.x, row.y, row.z];
        x = p[0]; y = p[1]; z = p[2];
        yaw = row.yaw; hp = row.hp; anim = row.anim;
      }
      var st = mobs[id];
      if (!st) continue; // unknown id (spawn hasn't arrived yet) — drop safely
      if (typeof hp === 'number') st.hp = hp;
      st.history.push({
        t: t,
        p: [Number(x) || 0, Number(y) || 0, Number(z) || 0],
        yaw: Number(yaw) || 0,
        hp: st.hp,
        anim: Number(anim) || 0
      });
      if (st.history.length > HISTORY_MAX) st.history.shift();
    }
  }

  // ---- interpolation (identical pattern to RemotePlayers §4.2) --------------

  function interpolate(history, tt) {
    var n = history.length;
    if (n === 0) return null;
    if (n === 1) return history[0];
    if (tt <= history[0].t) return history[0];
    if (tt >= history[n - 1].t) return history[n - 1];
    for (var i = 0; i < n - 1; i++) {
      var a = history[i], b = history[i + 1];
      if (tt >= a.t && tt <= b.t) {
        var span = b.t - a.t;
        var f = span > 0 ? (tt - a.t) / span : 1;
        f = clamp(f, 0, 1);
        return {
          t: tt,
          p: [lerp(a.p[0], b.p[0], f), lerp(a.p[1], b.p[1], f), lerp(a.p[2], b.p[2], f)],
          yaw: lerpAngle(a.yaw, b.yaw, f),
          hp: f < 0.5 ? a.hp : b.hp,
          anim: lerp(a.anim || 0, b.anim || 0, f)
        };
      }
    }
    return history[n - 1];
  }

  function update(dt) {
    var target = nowMs() - RENDER_DELAY_MS;
    // Same smoothing rates as the local sim so both rosters read identically:
    // yaw eases toward the interpolated sample (low snapshot rates can still
    // jump several degrees between samples) and swing amplitude follows REAL
    // horizontal movement of the pose, so a mob the server parks stops
    // swinging its legs instead of marching in place.
    var step = (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 0.016;
    var yawEase = 1 - Math.exp(-YAW_EASE_RATE * step);
    var ampEase = 1 - Math.exp(-SWING_EASE_RATE * step);
    for (var id in mobs) {
      var st = mobs[id];
      var sample = interpolate(st.history, target);
      if (!sample) continue;
      var px = st.pose.p[0], pz = st.pose.p[2];
      st.pose.p[0] = sample.p[0]; st.pose.p[1] = sample.p[1]; st.pose.p[2] = sample.p[2];
      st.pose.yaw = lerpAngle(st.pose.yaw, sample.yaw, yawEase);
      // `anim` is a 0..1-ish walk-cycle phase the server advances; treat it
      // the same way RemotePlayers treats `swing` (already-scaled phase).
      st.pose.swing = sample.anim || 0;
      var speed = Math.sqrt(dist2(st.pose.p[0], st.pose.p[2], px, pz)) / step;
      st.pose.swingAmp += ((speed > STAND_SPEED_EPS ? 1 : 0) - st.pose.swingAmp) * ampEase;
    }
  }

  // ---- draw -------------------------------------------------------------------

  function mobLight(env) {
    var ambient = (env && typeof env.ambient === 'number') ? env.ambient : 0.5;
    return clamp(ambient + 0.45, 0.25, 1);
  }

  function drawOne(gl, st, camera, fog, light) {
    var tex = texFor(gl, st.kind);
    if (!tex) return;
    PlayerModel.draw(gl, {
      skinTex: tex,
      model: 'classic',
      viewProj: camera.projView,
      pos: st.pose.p,
      yaw: st.pose.yaw,
      // headYaw may carry a small idle-sway offset (pigs); default = body yaw.
      headYaw: (typeof st.pose.headYaw === 'number') ? st.pose.headYaw : st.pose.yaw,
      headPitch: 0,
      swing: st.pose.swing,
      swingAmp: st.pose.swingAmp,
      crouch: false,
      light: light,
      fog: fog,
      camPos: camera.pos
    });
  }

  function draw(gl, camera, env) {
    if (!gl || typeof PlayerModel === 'undefined' || !PlayerModel.draw) return;
    if (!camera || !camera.projView) return;
    var fog = env ? { color: env.fogColor, start: env.fogStart, end: env.fogEnd } : null;
    var light = mobLight(env);

    for (var id in mobs) drawOne(gl, mobs[id], camera, fog, light);
    // Local-sim mobs share the exact same draw path — see localTick's return
    // value / _localMobs below (Game.js renders whichever list it's using;
    // this module's own draw() also renders local mobs so a caller that
    // simply always calls Mobs.draw() after Mobs.update()/Mobs.localTick()
    // gets correct behavior in both MP and solo without special-casing).
    for (var lid in _localMobs) drawOne(gl, _localMobs[lid].render, camera, fog, light);
  }

  function list() {
    var out = [];
    for (var id in mobs) {
      var st = mobs[id];
      out.push({ id: st.id, kind: st.kind, hp: st.hp, maxHp: st.maxHp, pos: st.pose.p.slice() });
    }
    for (var lid in _localMobs) {
      var lm = _localMobs[lid];
      out.push({ id: lm.id, kind: lm.kind, hp: lm.hp, maxHp: lm.maxHp, pos: lm.pos.slice() });
    }
    return out;
  }

  function count() {
    var n = 0;
    for (var id in mobs) n++;
    for (var lid in _localMobs) n++;
    return n;
  }

  // ===========================================================================
  // ---- LOCAL (solo/offline) mob simulation ----------------------------------
  // ===========================================================================
  //
  // A deliberately small, NOT-shared-with-Go wander/chase heuristic (contract
  // §7 closing paragraph / §14 closing paragraph). Owns its own spawn/despawn/
  // population-cap bookkeeping so Game.js's only job is:
  //   var list = Mobs.localTick(dt, world, physics, playerPos, opts);
  //   // ...render `list` (or just call Mobs.draw() — local mobs are folded
  //   // into the same draw() above via _localMobs).
  //
  // opts (all optional): { skyExposure: fn(x,y,z)->0..1 | number 0..1,
  //                         timeTicks: 0..24000, difficulty: 'peaceful'|...,
  //                         onPlayerDamage: fn(amount) }

  var _localMobs = Object.create(null); // id -> LocalMob
  var _localIdSeq = 1;
  var _lastSpawnCheckAt = 0;   // seconds (accumulated dt clock)
  var _localClock = 0;         // seconds, monotonic accumulation of dt

  // LocalMob: { id, kind, pos:[x,y,z], vel:[x,z], yaw (eased visible),
  //             targetYaw (instant wish direction), hp, maxHp,
  //             wanderTarget:[x,z]|null, wanderAt (s), fleeUntil (s),
  //             attackCooldownUntil (s), lastPlayerNearAt (s),
  //             swingAmp, swingPhase, lungeT (s), fallVel, idlePhase,
  //             grazeUntil (s), nextGrazeAt (s),
  //             render: {pose:{p,yaw,headYaw,swing,swingAmp}} } -- drawOne()

  function isSolidBlock(world, x, y, z) {
    if (!world || !world.getBlock) return false;
    var id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (!id) return false;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var def = Blocks.byId(id);
      return !!(def && def.solid);
    }
    return id !== 11 && !(id >= 27 && id <= 29); // fallback (water + cross blocks non-solid)
  }

  function groundYBelow(world, x, z, fromY) {
    var y = Math.floor(fromY);
    var guard = 0;
    while (y > 0 && !isSolidBlock(world, x, y - 1, z) && guard < 96) { y--; guard++; }
    return y;
  }

  function surfaceBlockOk(world, x, z, y) {
    // Grass/dirt/stone check (contract: "grass, dirt, stone within render
    // distance" for zombies; "grass in daylight" for pigs). Duck-types via
    // Blocks.byKey when present, else falls back to the known Part I ids
    // (1=grass, 2=dirt, 3=stone).
    if (!world || !world.getBlock) return false;
    var id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var def = Blocks.byId(id);
      return !!(def && (def.key === 'grass' || def.key === 'dirt' || def.key === 'stone' || def.key === 'snow_grass'));
    }
    return id === 1 || id === 2 || id === 3;
  }

  function isGrassBlock(world, x, y, z) {
    if (!world || !world.getBlock) return false;
    var id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var def = Blocks.byId(id);
      return !!(def && (def.key === 'grass' || def.key === 'snow_grass'));
    }
    return id === 1 || id === 20;
  }

  // Resolve a caller-supplied skyExposure-ish signal (number 0..1, or a
  // fn(x,y,z)->0..1) at a point; missing signal defaults to "exposed" (1) so
  // spawning isn't silently blocked when a caller hasn't wired lighting yet.
  function skyExposureAt(opts, x, y, z) {
    if (!opts) return 1;
    var se = opts.skyExposure;
    if (typeof se === 'function') {
      try { var v = se(x, y, z); return (typeof v === 'number') ? v : 1; } catch (e) { return 1; }
    }
    if (typeof se === 'number') return se;
    return 1;
  }

  // Part I §3: ticks 0..24000, 0=dawn, 6000=noon, 12000=dusk, 18000=midnight.
  // "Night band" (hostile-mob-eligible) = dusk through just-before-dawn, i.e.
  // the closed interval [13000, 23000] — leaves a buffer either side of the
  // exact dusk/dawn instants so mobs don't spawn/despawn on a single-tick edge.
  function isNightTicks(ticks) {
    if (typeof ticks !== 'number') return false;
    return ticks >= 13000 && ticks <= 23000;
  }

  function makeRenderPose(pos, yaw) {
    // swingAmp starts at 0 so a fresh mob eases INTO its first steps instead
    // of popping in mid-stride; headYaw defaults to the body yaw.
    return { pose: { p: [pos[0], pos[1], pos[2]], yaw: yaw, headYaw: yaw, swing: 0, swingAmp: 0 } };
  }

  function spawnLocalMob(kind, pos) {
    var id = 'local' + (_localIdSeq++);
    var hp = HP_BY_KIND[kind] || 20;
    var yaw0 = Math.random() * TWO_PI;
    var lm = {
      id: id, kind: kind, pos: pos.slice(), vel: [0, 0], yaw: yaw0, targetYaw: yaw0,
      hp: hp, maxHp: hp,
      wanderTarget: null, wanderAt: 0,
      fleeUntil: 0, attackCooldownUntil: 0,
      lastPlayerNearAt: _localClock,
      // Visual-smoothing state (AI never reads these): eased walk-cycle
      // amplitude + phase, attack-telegraph countdown, settle fall speed,
      // per-mob idle-sway phase seed, and pig grazing-pause timers.
      swingAmp: 0, swingPhase: 0, lungeT: 0, fallVel: 0,
      idlePhase: Math.random() * TWO_PI,
      grazeUntil: 0, nextGrazeAt: _localClock + randRange(GRAZE_ROLL_MIN, GRAZE_ROLL_MAX),
      render: makeRenderPose(pos, yaw0)
    };
    _localMobs[id] = lm;
    return lm;
  }

  function countLocalByKind(kind) {
    var n = 0;
    for (var id in _localMobs) if (_localMobs[id].kind === kind) n++;
    return n;
  }

  // Attempt to place ONE new mob of `kind` near the player if under cap and
  // gates pass. Very small/cheap: a handful of random-point tries.
  function trySpawn(kind, world, playerPos, opts) {
    var cap = (kind === 'pig') ? CAP_PIG : CAP_ZOMBIE;
    if (countLocalByKind(kind) >= cap) return;
    if (opts && opts.difficulty === 'peaceful' && kind === 'zombie') return;

    for (var attempt = 0; attempt < 6; attempt++) {
      var ang = Math.random() * TWO_PI;
      var r = randRange(SPAWN_TRY_RADIUS_MIN, SPAWN_TRY_RADIUS_MAX);
      var x = playerPos[0] + Math.cos(ang) * r;
      var z = playerPos[2] + Math.sin(ang) * r;
      // groundYBelow returns the FEET cell -- the first air cell resting on
      // top of solid ground (its own loop walks down "while the cell below
      // is NOT solid"), not the ground block itself. Every check below reads
      // relative to that: the ground is at y-1, and the 2-tall clearance a
      // standing mob needs is y (feet) and y+1 (head), not y+1/y+2 (which
      // would demand a 3rd clear cell for no reason and reject perfectly
      // good spawn spots).
      var y = groundYBelow(world, x, z, playerPos[1] + 20);
      if (y <= 1 || y >= 94) continue;
      if (!surfaceBlockOk(world, x, z, y - 1)) continue;
      if (isSolidBlock(world, x, y, z) || isSolidBlock(world, x, y + 1, z)) continue;

      if (kind === 'zombie') {
        var expo = skyExposureAt(opts, x, y, z);
        var night = isNightTicks(opts && opts.timeTicks);
        if (!night && expo > 0.4) continue; // needs night OR a dark area
      } else { // pig
        var isDay = !isNightTicks(opts && opts.timeTicks);
        if (!isDay) continue;
        if (!isGrassBlock(world, x, y - 1, z)) continue;
      }

      spawnLocalMob(kind, [x, y, z]);
      return;
    }
  }

  // Blocked-by-solid-block avoidance: try to step up 1 block along the wish
  // direction; if that's also blocked, turn +/-45 degrees and retry (single
  // retry each side) — NOT real pathfinding, per contract.
  function stepToward(world, lm, dirx, dirz, speed, dt) {
    var stepLen = speed * dt;
    function blocked(nx, nz, ny) {
      // Check the mob's rough footprint at (nx,nz) for feet + head level.
      return isSolidBlock(world, nx, ny, nz) || isSolidBlock(world, nx, ny + 1, nz);
    }
    var tryDirs = [
      [dirx, dirz],
      [dirx * 0.7071 - dirz * 0.7071, dirx * 0.7071 + dirz * 0.7071],   // +45deg
      [dirx * 0.7071 + dirz * 0.7071, -dirx * 0.7071 + dirz * 0.7071]   // -45deg
    ];
    for (var i = 0; i < tryDirs.length; i++) {
      var dx = tryDirs[i][0], dz = tryDirs[i][1];
      var len = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= len; dz /= len;
      var nx = lm.pos[0] + dx * stepLen;
      var nz = lm.pos[2] + dz * stepLen;
      var footY = Math.floor(lm.pos[1]);
      if (!blocked(nx, nz, footY)) {
        lm.pos[0] = nx; lm.pos[2] = nz;
        // §3 yaw convention: forward = (-sin(yaw),0,-cos(yaw)). Only the
        // TARGET is snapped here — localTick eases the visible yaw toward it
        // so zigzag course corrections turn over several frames.
        lm.targetYaw = Math.atan2(-dx, -dz);
        return true;
      }
      // Try a 1-block step-up: same XZ, foot level +1, only if that cell and
      // the one above it are clear.
      if (!blocked(nx, nz, footY + 1) && isSolidBlock(world, nx, footY, nz)) {
        lm.pos[0] = nx; lm.pos[1] = footY + 1; lm.pos[2] = nz;
        lm.targetYaw = Math.atan2(-dx, -dz);
        return true;
      }
    }
    return false; // fully stuck this tick — just stand still, no crash/loop
  }

  function settleToGround(world, lm, dt) {
    // Vertical settle so mobs don't float/sink when their column's terrain
    // height differs from spawn. groundYBelow returns the FEET cell (the air
    // cell resting ON the ground) — same convention as trySpawn — so the
    // target is g itself, NOT g+1 (g+1 floats the mob a full block up, the
    // exact off-by-one that made mobs walk on air).
    //
    // Downward moves ease with a gravity-ish acceleration instead of
    // snapping (a mob walking off a ledge visibly falls); upward moves
    // (stepping onto higher terrain) stay instant since stepToward already
    // gates 1-block step-ups and a visible "pop" upward reads as a step.
    var g = groundYBelow(world, lm.pos[0], lm.pos[2], lm.pos[1] + 3);
    if (lm.pos[1] > g) {
      lm.fallVel = (lm.fallVel || 0) + 24 * (dt || 0.016);
      lm.pos[1] = Math.max(g, lm.pos[1] - lm.fallVel * (dt || 0.016));
      if (lm.pos[1] === g) lm.fallVel = 0;
    } else {
      lm.pos[1] = g;
      lm.fallVel = 0;
    }
  }

  function tickZombie(lm, dt, world, playerPos, opts) {
    var d2 = dist2(lm.pos[0], lm.pos[2], playerPos[0], playerPos[2]);
    if (d2 <= CHASE_RANGE * CHASE_RANGE) {
      lm.lastPlayerNearAt = _localClock;
      var d = Math.sqrt(d2);
      if (d > ATTACK_RANGE) {
        var dx = (playerPos[0] - lm.pos[0]) / d, dz = (playerPos[2] - lm.pos[2]) / d;
        stepToward(world, lm, dx, dz, MOB_SPEED.zombie, dt);
      } else {
        // In melee range: keep tracking the player with the eased yaw even
        // while standing, so the zombie squares up between swings.
        if (d > 0.001) lm.targetYaw = Math.atan2(-(playerPos[0] - lm.pos[0]), -(playerPos[2] - lm.pos[2]));
        if (_localClock >= lm.attackCooldownUntil) {
          lm.attackCooldownUntil = _localClock + ATTACK_COOLDOWN_S;
          lm.lungeT = LUNGE_DURATION_S; // attack telegraph: pose whips through a fast swing
          var dmgBase = randRange(2, 4);
          var diffMult = { peaceful: 0, easy: 0.5, normal: 1.0, hard: 1.5 };
          var mult = (opts && diffMult[opts.difficulty] != null) ? diffMult[opts.difficulty] : 1.0;
          var amount = dmgBase * mult;
          if (amount > 0 && opts && typeof opts.onPlayerDamage === 'function') {
            try { opts.onPlayerDamage(amount, lm.kind); } catch (e) { /* caller's bug, not ours */ }
          }
        }
      }
    } else {
      // Idle shuffle: reuse the pig's wander behavior when no player is near.
      tickWander(lm, dt, world, MOB_SPEED.zombie * 0.5);
    }
  }

  function tickWander(lm, dt, world, speed) {
    if (!lm.wanderTarget || _localClock >= lm.wanderAt) {
      var ang = Math.random() * TWO_PI;
      var r = randRange(1, WANDER_RADIUS);
      lm.wanderTarget = [lm.pos[0] + Math.cos(ang) * r, lm.pos[2] + Math.sin(ang) * r];
      lm.wanderAt = _localClock + randRange(WANDER_INTERVAL_MIN, WANDER_INTERVAL_MAX);
    }
    var dx = lm.wanderTarget[0] - lm.pos[0], dz = lm.wanderTarget[1] - lm.pos[2];
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d > 0.3) {
      stepToward(world, lm, dx / d, dz / d, speed, dt);
    }
  }

  function tickPig(lm, dt, world, playerPos) {
    if (_localClock < lm.fleeUntil) {
      var d2 = dist2(lm.pos[0], lm.pos[2], playerPos[0], playerPos[2]);
      var d = Math.sqrt(d2) || 1;
      var dx = (lm.pos[0] - playerPos[0]) / d, dz = (lm.pos[2] - playerPos[2]) / d;
      stepToward(world, lm, dx, dz, MOB_SPEED.pigFlee, dt);
      return;
    }
    // Occasional grazing pause: every few seconds a pig may stop mid-wander
    // and stand for a moment (the idle head-sway applied in localTick's pose
    // pass makes the pause read as grazing, not as a stuck mob).
    if (_localClock < lm.grazeUntil) return;
    if (_localClock >= lm.nextGrazeAt) {
      lm.nextGrazeAt = _localClock + randRange(GRAZE_ROLL_MIN, GRAZE_ROLL_MAX);
      if (Math.random() < GRAZE_CHANCE) {
        lm.grazeUntil = _localClock + randRange(GRAZE_PAUSE_MIN, GRAZE_PAUSE_MAX);
        return;
      }
    }
    tickWander(lm, dt, world, MOB_SPEED.pig);
  }

  // Public: called by an external hit system (Combat, when built) to notify
  // a local mob it was struck — not contract-pinned by name, but harmless
  // to expose since local solo combat needs SOME way to apply damage/flee.
  function localHit(id, amount) {
    var lm = _localMobs[id];
    if (!lm) return false;
    lm.hp -= (typeof amount === 'number' ? amount : 1);
    if (lm.kind === 'pig') lm.fleeUntil = _localClock + FLEE_DURATION_S;
    if (lm.hp <= 0) { delete _localMobs[id]; return true; }
    return false;
  }

  function localTick(dt, world, physics, playerPos, opts) {
    dt = (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 0;
    _localClock += dt;
    opts = opts || {};
    playerPos = playerPos || [0, 0, 0];

    // If difficulty just flipped to peaceful, clear hostiles immediately
    // (contract §7: "Despawns ... immediately on /difficulty peaceful").
    if (opts.difficulty === 'peaceful') {
      for (var zid in _localMobs) {
        if (_localMobs[zid].kind === 'zombie') delete _localMobs[zid];
      }
    }

    // ---- per-mob AI + despawn bookkeeping ----
    for (var id in _localMobs) {
      var lm = _localMobs[id];
      var prevX = lm.pos[0], prevZ = lm.pos[2];
      if (lm.kind === 'zombie') tickZombie(lm, dt, world, playerPos, opts);
      else tickPig(lm, dt, world, playerPos);

      if (world) settleToGround(world, lm, dt);

      var near = dist2(lm.pos[0], lm.pos[2], playerPos[0], playerPos[2]) <= DESPAWN_DIST * DESPAWN_DIST;
      if (near) lm.lastPlayerNearAt = _localClock;
      if (_localClock - lm.lastPlayerNearAt >= DESPAWN_AFTER_S) {
        delete _localMobs[id];
        continue;
      }

      // ---- render-pose smoothing (visual only; nothing above reads it) ----
      // Real horizontal speed this tick drives everything: the walk-cycle
      // phase advances with distance actually covered (legs stop the instant
      // the mob does) and the amplitude eases 0<->1 so starts/stops look
      // weighted instead of binary.
      var moved = Math.sqrt(dist2(lm.pos[0], lm.pos[2], prevX, prevZ));
      var speed = dt > 0 ? moved / dt : 0;
      var yawEase = 1 - Math.exp(-YAW_EASE_RATE * dt);
      var ampEase = 1 - Math.exp(-SWING_EASE_RATE * dt);

      // Visible yaw eases toward the wish direction stepToward/tickZombie
      // recorded in targetYaw (the value the old code snapped to raw), then
      // is re-wrapped so it can't drift unbounded over long circling paths.
      lm.yaw = lerpAngle(lm.yaw, lm.targetYaw, yawEase);
      if (lm.yaw > Math.PI) lm.yaw -= TWO_PI; else if (lm.yaw < -Math.PI) lm.yaw += TWO_PI;

      lm.swingAmp += ((speed > STAND_SPEED_EPS ? 1 : 0) - lm.swingAmp) * ampEase;
      lm.swingPhase = (lm.swingPhase + moved * SWING_CYCLES_PER_BLOCK) % 1;

      // Zombie attack telegraph: for LUNGE_DURATION_S after a hit the pose
      // whips through a fast full-amplitude swing, then eases back out.
      var amp = lm.swingAmp;
      if (lm.lungeT > 0) {
        lm.lungeT = Math.max(0, lm.lungeT - dt);
        amp = Math.max(amp, lm.lungeT / LUNGE_DURATION_S); // 1 -> 0 over the telegraph
        lm.swingPhase = (lm.swingPhase + dt * LUNGE_SWING_RATE) % 1;
      }

      // Pig idle life: a slow head sway while standing (head only — the body
      // stays planted) so parked pigs read as grazing, not as statues.
      var headYaw = lm.yaw;
      if (lm.kind === 'pig' && speed < STAND_SPEED_EPS) {
        headYaw += Math.sin(_localClock * IDLE_SWAY_SPEED + lm.idlePhase) * IDLE_SWAY_RAD;
      }

      lm.render.pose.p[0] = lm.pos[0]; lm.render.pose.p[1] = lm.pos[1]; lm.render.pose.p[2] = lm.pos[2];
      lm.render.pose.yaw = lm.yaw;
      lm.render.pose.headYaw = headYaw;
      lm.render.pose.swing = lm.swingPhase;
      lm.render.pose.swingAmp = clamp(amp, 0, 1);
    }

    // ---- spawn attempts (throttled) ----
    if (_localClock - _lastSpawnCheckAt >= SPAWN_CHECK_INTERVAL_S) {
      _lastSpawnCheckAt = _localClock;
      trySpawn('zombie', world, playerPos, opts);
      trySpawn('pig', world, playerPos, opts);
    }

    return list();
  }

  function localList() {
    var out = [];
    for (var id in _localMobs) {
      var lm = _localMobs[id];
      // yaw here is the eased VISIBLE yaw; swingAmp is exposed for debugging
      // (0 = standing pose, 1 = full walk cycle) — both additive fields.
      out.push({ id: lm.id, kind: lm.kind, hp: lm.hp, maxHp: lm.maxHp, pos: lm.pos.slice(), yaw: lm.yaw, swingAmp: lm.render.pose.swingAmp });
    }
    return out;
  }

  function clearLocal() {
    _localMobs = Object.create(null);
  }

  // ---- public API -------------------------------------------------------------

  return {
    init: init,

    // server-synced (multiplayer)
    sync: sync,
    applyState: applyState,
    spawn: spawn,
    despawn: despawn,
    update: update,
    draw: draw,
    list: list,
    get count() { return count(); },

    // local (solo/offline) simulation
    localTick: localTick,
    localList: localList,
    localHit: localHit,
    clearLocal: clearLocal
  };
})();

window.Mobs = Mobs;
