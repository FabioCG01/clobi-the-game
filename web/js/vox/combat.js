// vox/combat.js -- global Combat.
//
// Client-side combat for CLOBI CRAFT: entity-AABB raycasting (DDA-adjacent,
// mirrors Interact's ray style but tests entity boxes instead of voxels),
// LMB-tap-to-attack dispatch, and a small pub-sub surface Game wires to the
// server's authoritative health/damage/death/mob messages.
// Contract: ARCHITECTURE-COMBAT.md §5 (esp. §5.3 Combat.js, §5.4 input
// disambiguation), extends Part I ARCHITECTURE-3D.md §5.11 Interact.
//
// Combat itself never talks to RemotePlayers/Mobs directly -- those are
// sibling-owned entity sources that don't exist as concrete modules at this
// file's authoring time. Instead Combat.setEntitySource(fn) accepts a
// pluggable provider: fn() -> [{id, pos:[x,y,z], kind:'player'|'mob', radius?, height?}, ...]
// Game wires this once RemotePlayers/Mobs exist (e.g. a fn that concats
// RemotePlayers.list() and Mobs.list()). Until a source is set, attemptHit
// simply finds nothing and is a safe no-op.
//
// Server authority: Combat NEVER applies damage locally. attemptHit only
// SENDS {t:'hit', targetId} via the injected net reference; the resulting
// hp change always arrives back through 'health'/'damage'/'death' server
// messages that Game forwards into onHealth/onDamage/onDeath.
//
// Integration point for §5.4 ray priority ("test entities first within 4.5
// blocks, then blocks"): the caller wiring LMB-tap/touch-tap (Game.js or
// wherever Interact's action dispatch lives) should call Combat.probe(camera)
// (or probeAt for touch) BEFORE falling back to Interact's block raycast on a
// tap gesture -- probe() is a free, no-network-send lookup. If it returns a
// hit, call attemptHit/attemptHitAt (which re-runs the same cheap probe and
// sends) instead of treating the tap as a block-break attempt. A HOLD always
// goes straight to Interact's existing break path unchanged, regardless of
// what's under the crosshair -- §5.4 only reprioritizes the disambiguated TAP
// gesture, not holds. Combat.isTapGesture(pressMs, releaseMs, dxPx, dyPx)
// encodes the exact 200ms/6px tap-vs-hold rule §5.4 specifies, for whichever
// module owns the raw pointer press/release timestamps.
//
// Exposes exactly one global: window.Combat
// Depends on globals: none required at load time (net/hud are injected via
// Combat.init; guards typeof for optional lookups everywhere else).

var Combat = (function () {
  'use strict';

  // ---- constants (contract §5.2/§5.4) ----
  var HIT_REACH = 4.5;          // blocks, matches server-side validation window
  var TAP_MAX_MS = 200;         // LMB press+release under this = a "tap" (attack), not a hold (break)
  var TAP_MAX_MOVE_PX = 6;      // press+release must not drag further than this to count as a tap
  var DEFAULT_RADIUS = 0.35;    // half-width fallback for an entity AABB (~player width 0.6/2 + margin)
  var DEFAULT_HEIGHT = 1.8;     // fallback full height (players); mobs may report their own via the source
  var SWING_DURATION_MS = 300;  // how long swingPhase() reports an active swing after a hit send

  // ---- small helpers ----
  function noop() {}

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function readVec3(p) {
    if (!p) return [0, 0, 0];
    if (typeof p[0] === 'number') return [p[0], p[1] || 0, p[2] || 0];
    if (typeof p.x === 'number') return [p.x, p.y || 0, p.z || 0];
    return [0, 0, 0];
  }

  // ---- module state ----
  var netRef = null;
  var hudRef = null;
  var localPlayerId = null;
  var entitySourceFn = null;

  var localHP = 20;
  var localMaxHP = 20;

  var lastSwingAt = -1e9;       // ms timestamp of the most recent hit-send (drives swingPhase)
  var lastHitSentAt = -1e9;     // ms timestamp of the most recent hit send, for a soft client-side
                                 // cadence guard (the server is the REAL anti-spam gate per §5.2 --
                                 // this just avoids flooding the socket with duplicate taps)
  var CLIENT_HIT_MIN_INTERVAL_MS = 120;

  // event listener lists (same pub-sub shape as Net.on -- simple array-of-fn per topic)
  var listeners = {
    health: [],
    damage: [],
    death: [],
    mobSpawn: [],
    mobState: [],
    mobDespawn: []
  };

  function addListener(topic, fn) {
    if (typeof fn !== 'function') return;
    listeners[topic].push(fn);
  }

  function fire(topic, payload) {
    var list = listeners[topic];
    if (!list || !list.length) return;
    var snap = list.slice(); // tolerate a handler mutating the list mid-dispatch
    for (var i = 0; i < snap.length; i++) {
      try { snap[i](payload); } catch (e) {
        if (typeof console !== 'undefined') console.error('Combat: listener for "' + topic + '" threw', e);
      }
    }
  }

  // ---- ray vs entity-AABB intersection ----
  // Mirrors Interact.raycast's overall style (unit-direction ray, distance-
  // bounded, returns the nearest hit) but tests axis-aligned entity boxes
  // instead of voxel cells -- a small linear scan is fine here since entity
  // counts per instance are capped low (contract §7: ~8 mobs + a handful of
  // players), unlike the world's voxel grid which needs DDA.
  //
  // Box for an entity at pos[x,y,z] spans:
  //   x: [pos.x - r, pos.x + r]   z: [pos.z - r, pos.z + r]   y: [pos.y, pos.y + h]
  // (pos is feet-level, matching the convention Physics/RemotePlayers use for
  // player body.pos per Part I §5.9).
  function rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxDist) {
    var tmin = 0, tmax = maxDist;

    var axes = [
      [dx, ox, minX, maxX],
      [dy, oy, minY, maxY],
      [dz, oz, minZ, maxZ]
    ];
    for (var i = 0; i < 3; i++) {
      var d = axes[i][0], o = axes[i][1], lo = axes[i][2], hi = axes[i][3];
      if (Math.abs(d) < 1e-9) {
        if (o < lo || o > hi) return null; // parallel and outside the slab
        continue;
      }
      var inv = 1 / d;
      var t1 = (lo - o) * inv;
      var t2 = (hi - o) * inv;
      if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    return tmin;
  }

  function entityBox(ent) {
    var p = readVec3(ent.pos);
    var r = typeof ent.radius === 'number' ? ent.radius : DEFAULT_RADIUS;
    var h = typeof ent.height === 'number' ? ent.height : DEFAULT_HEIGHT;
    return {
      minX: p[0] - r, maxX: p[0] + r,
      minY: p[1], maxY: p[1] + h,
      minZ: p[2] - r, maxZ: p[2] + r
    };
  }

  // Finds the nearest entity (excluding localPlayerId) whose AABB the ray
  // hits within maxDist. Returns {id, kind, dist} or null.
  function raycastEntities(origin, dir, maxDist) {
    if (typeof entitySourceFn !== 'function') return null;
    var list;
    try { list = entitySourceFn(); } catch (e) { return null; }
    if (!list || !list.length) return null;

    var ox = origin[0], oy = origin[1], oz = origin[2];
    var dx = dir[0], dy = dir[1], dz = dir[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return null;
    dx /= len; dy /= len; dz /= len;

    var best = null;
    var bestDist = maxDist;
    for (var i = 0; i < list.length; i++) {
      var ent = list[i];
      if (!ent || ent.id == null) continue;
      if (localPlayerId != null && ent.id === localPlayerId) continue; // never self-hit
      var box = entityBox(ent);
      var t = rayAABB(ox, oy, oz, dx, dy, dz,
        box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, bestDist);
      if (t !== null && t < bestDist) {
        bestDist = t;
        best = { id: ent.id, kind: ent.kind || 'player', dist: t };
      }
    }
    return best;
  }

  // Resolve a camera-like object into {origin[3], dir[3]} the same way
  // Interact's crosshairRay does (pinned yaw/pitch look direction preferred,
  // falls back to nothing usable -> caller no-ops).
  function crosshairRayVectors(camera) {
    if (!camera) return null;
    var origin = readVec3(camera.pos);
    var dir;
    if (typeof camera.yaw === 'number' && typeof camera.pitch === 'number') {
      var cp = Math.cos(camera.pitch);
      dir = [-Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
    } else if (typeof Interact !== 'undefined' && Interact && typeof Interact.raycast === 'function' &&
               camera.projView && typeof M3 !== 'undefined' && M3.mat4Invert) {
      // Best-effort fallback mirroring Interact's own NDC-center unproject,
      // kept local so Combat has no hard dependency on Interact internals.
      var inv = new Float32Array(16);
      M3.mat4Invert(inv, camera.projView);
      var w = inv[3] * 0 + inv[7] * 0 + inv[11] * 1 + inv[15];
      if (w === 0) w = 1;
      var fx = (inv[0] * 0 + inv[4] * 0 + inv[8] * 1 + inv[12]) / w;
      var fy = (inv[1] * 0 + inv[5] * 0 + inv[9] * 1 + inv[13]) / w;
      var fz = (inv[2] * 0 + inv[6] * 0 + inv[10] * 1 + inv[14]) / w;
      var ddx = fx - origin[0], ddy = fy - origin[1], ddz = fz - origin[2];
      var l = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
      if (l < 1e-9) return null;
      dir = [ddx / l, ddy / l, ddz / l];
    } else {
      return null;
    }
    return { origin: origin, dir: dir };
  }

  // Resolve a touch tap (screen px,py) into {origin[3], dir[3]} via the same
  // unproject approach Interact.tapRay uses.
  function tapRayVectors(camera, px, py) {
    if (!camera || !camera.projView || typeof M3 === 'undefined' || !M3.mat4Invert) return null;
    var canvasEl = document.getElementById('game-canvas');
    var left = 0, top = 0;
    var w = window.innerWidth || 1, h = window.innerHeight || 1;
    if (canvasEl && canvasEl.getBoundingClientRect) {
      var r = canvasEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { left = r.left; top = r.top; w = r.width; h = r.height; }
    }
    var nx = ((px - left) / w) * 2 - 1;
    var ny = 1 - ((py - top) / h) * 2;

    var inv = new Float32Array(16);
    M3.mat4Invert(inv, camera.projView);
    var ww = inv[3] * nx + inv[7] * ny + inv[11] * 1 + inv[15];
    if (ww === 0) ww = 1;
    var fx = (inv[0] * nx + inv[4] * ny + inv[8] * 1 + inv[12]) / ww;
    var fy = (inv[1] * nx + inv[5] * ny + inv[9] * 1 + inv[13]) / ww;
    var fz = (inv[2] * nx + inv[6] * ny + inv[10] * 1 + inv[14]) / ww;

    var origin = readVec3(camera.pos);
    var dx = fx - origin[0], dy = fy - origin[1], dz = fz - origin[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return null;
    return { origin: origin, dir: [dx / len, dy / len, dz / len] };
  }

  function targetIdFor(hit) {
    if (!hit) return null;
    if (hit.kind === 'mob') {
      // hit.id may already be prefixed ('mob:<id>') if the entity source
      // chose to hand it over that way; otherwise apply the §5.1 format here.
      return (typeof hit.id === 'string' && hit.id.indexOf('mob:') === 0) ? hit.id : ('mob:' + hit.id);
    }
    return hit.id; // player id, sent as-is per §5.1
  }

  function sendHit(targetId) {
    if (targetId == null) return false;
    var t = nowMs();
    if (t - lastHitSentAt < CLIENT_HIT_MIN_INTERVAL_MS) return false; // soft client-side debounce only
    lastHitSentAt = t;
    lastSwingAt = t; // drives swingPhase() so Game can animate the swing on send, not just on confirmed hit
    if (netRef && typeof netRef.send === 'function') {
      netRef.send('hit', { targetId: targetId });
    }
    return true;
  }

  // ---- public: attemptHit (§5.3) ----
  // camera: {pos, yaw?, pitch?, projView?}. world: accepted for future block-
  // priority tie-breaks but not required by the entity-only raycast today
  // (§5.4's "test entities first, then blocks" ordering is Interact's job to
  // honor by calling Combat.attemptHit before its own block raycast -- see
  // module doc comment above for the call-order contract).
  function attemptHit(camera, world) {
    var rv = crosshairRayVectors(camera);
    if (!rv) return false;
    var hit = raycastEntities(rv.origin, rv.dir, HIT_REACH);
    if (!hit) return false;
    var targetId = targetIdFor(hit);
    return sendHit(targetId);
  }

  // touch variant: tap-on-entity resolves a screen point to an entity's ray
  // hit (§5.4 "screen point resolves to an entity's screen-space bounding
  // box" -- implemented here as the same world-space ray test through the
  // tapped point, which is equivalent and reuses one code path).
  function attemptHitAt(camera, px, py) {
    var rv = tapRayVectors(camera, px, py);
    if (!rv) return false;
    var hit = raycastEntities(rv.origin, rv.dir, HIT_REACH);
    if (!hit) return false;
    var targetId = targetIdFor(hit);
    return sendHit(targetId);
  }

  // Pure "is there an entity under the crosshair/tap within reach" probe,
  // no send -- lets Interact/Input decide tap-vs-hold priority (§5.4: "test
  // entities first within 4.5 blocks, then blocks") without every probe
  // costing a network message.
  function probe(camera) {
    var rv = crosshairRayVectors(camera);
    if (!rv) return null;
    return raycastEntities(rv.origin, rv.dir, HIT_REACH);
  }

  function probeAt(camera, px, py) {
    var rv = tapRayVectors(camera, px, py);
    if (!rv) return null;
    return raycastEntities(rv.origin, rv.dir, HIT_REACH);
  }

  // ---- public: desktop tap-vs-hold classification helper (§5.4) ----
  // A tiny stateful helper Input/Interact can use verbatim: feed press/release
  // timestamps + movement and get back whether this gesture reads as a tap
  // (attack candidate) vs a hold (block-break candidate). Not required if the
  // caller already tracks this itself -- provided because §5.4's exact 200ms/
  // no-movement rule is spelled out here once rather than duplicated per caller.
  function isTapGesture(pressMs, releaseMs, dxPx, dyPx) {
    var dt = releaseMs - pressMs;
    if (dt < 0 || dt > TAP_MAX_MS) return false;
    var moveDist = Math.sqrt((dxPx || 0) * (dxPx || 0) + (dyPx || 0) * (dyPx || 0));
    return moveDist <= TAP_MAX_MOVE_PX;
  }

  // ---- public: swing animation hook (§5.4) ----
  // Game's drawArm()/drawOwnPlayer() compute swing01 for PlayerModel every
  // frame (Combat never calls PlayerModel itself, per house separation of
  // concerns) -- swingPhase() gives them a ready-made 0..1 value that pulses
  // whenever a hit was just sent, so equipping a sword's swing plays on
  // attack, not only on block-break. Game.js can simply do:
  //   var s = Combat.swingPhase(); if (s > 0) swing01 = Math.max(swing01, s);
  function swingPhase() {
    var elapsed = nowMs() - lastSwingAt;
    if (elapsed < 0 || elapsed > SWING_DURATION_MS) return 0;
    return 1 - (elapsed / SWING_DURATION_MS);
  }

  // ---- public: server message handlers (Game wires Net.on(...) -> these) ----
  function handleHealth(msg) {
    if (!msg) return;
    if (localPlayerId != null && msg.id === localPlayerId) {
      localHP = clamp01to(typeof msg.hp === 'number' ? msg.hp : localHP, 0, 20);
      localMaxHP = typeof msg.max === 'number' ? msg.max : localMaxHP;
    }
    fire('health', msg);
  }

  function handleDamage(msg) {
    if (!msg) return;
    fire('damage', msg);
  }

  function handleDeath(msg) {
    if (!msg) return;
    fire('death', msg);
  }

  function handleMobSpawn(msg) { if (msg) fire('mobSpawn', msg); }
  function handleMobState(msg) { if (msg) fire('mobState', msg); }
  function handleMobDespawn(msg) { if (msg) fire('mobDespawn', msg); }

  function clamp01to(v, lo, hi) {
    if (typeof v !== 'number' || !isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // ---- public: init/config ----
  function init(opts) {
    opts = opts || {};
    netRef = opts.net || null;
    hudRef = opts.hud || null;
    localPlayerId = (opts.localPlayerId != null) ? opts.localPlayerId : null;
    localHP = 20;
    localMaxHP = 20;
    lastSwingAt = -1e9;
    lastHitSentAt = -1e9;

    // Auto-wire to Net's incoming messages when a real Net-shaped object was
    // handed in (duck-typed: has .on). Game MAY instead choose to call
    // handleHealth/etc itself if it wants finer control -- both paths are
    // safe since fire() is idempotent per call and Game owns the actual
    // Net.on registration lifecycle in that alternate style. We register
    // here too only when `net` looks like the real Net module (has .on),
    // which is the common case per the contract's "Game wires these" note;
    // this is additive convenience, not a requirement Game must rely on.
    if (netRef && typeof netRef.on === 'function') {
      netRef.on('health', handleHealth);
      netRef.on('damage', handleDamage);
      netRef.on('death', handleDeath);
      netRef.on('mobSpawn', handleMobSpawn);
      netRef.on('mobState', handleMobState);
      netRef.on('mobDespawn', handleMobDespawn);
    }
  }

  function setEntitySource(fn) {
    entitySourceFn = (typeof fn === 'function') ? fn : null;
  }

  function setLocalPlayerId(id) {
    localPlayerId = id;
  }

  // ---- module export ----
  var Combat = {
    init: init,
    setEntitySource: setEntitySource,
    setLocalPlayerId: setLocalPlayerId,

    attemptHit: attemptHit,
    attemptHitAt: attemptHitAt,
    probe: probe,
    probeAt: probeAt,
    isTapGesture: isTapGesture,
    swingPhase: swingPhase,

    onHealth: function (fn) { addListener('health', fn); },
    onDamage: function (fn) { addListener('damage', fn); },
    onDeath: function (fn) { addListener('death', fn); },
    onMobSpawn: function (fn) { addListener('mobSpawn', fn); },
    onMobState: function (fn) { addListener('mobState', fn); },
    onMobDespawn: function (fn) { addListener('mobDespawn', fn); },

    // Manual dispatch entry points, for a Game that prefers to own the
    // Net.on(...) wiring itself rather than relying on init()'s auto-wire.
    handleHealth: handleHealth,
    handleDamage: handleDamage,
    handleDeath: handleDeath,
    handleMobSpawn: handleMobSpawn,
    handleMobState: handleMobState,
    handleMobDespawn: handleMobDespawn,

    // constants exposed for callers that want to mirror them (e.g. HUD
    // hit-flash duration tuning, Interact's own reach checks)
    HIT_REACH: HIT_REACH,
    TAP_MAX_MS: TAP_MAX_MS,
    TAP_MAX_MOVE_PX: TAP_MAX_MOVE_PX,

    get localHP() { return localHP; },
    get localMaxHP() { return localMaxHP; }
  };
  return Combat;
})();

window.Combat = Combat;
