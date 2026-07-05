// remoteplayers.js — renders every OTHER player in a multiplayer room.
// Exactly one global: window.RemotePlayers (contract §4.2).
//
// Shares the already-built PlayerModel module (Part I §5.8) for geometry and
// the shader; this file owns only: per-player state, snapshot history for
// interpolation, skin-texture caching, and the DOM nametag layer.
//
// Interpolation (per contract): each applyMoves() snapshot is timestamped
// with performance.now() and pushed onto a short per-player history buffer.
// update(dt) renders players 150ms BEHIND the newest snapshot by finding the
// two history entries bracketing (now - 150ms) and lerping between them:
// straight lerp for position, shortest-arc lerp for yaw (so a player turning
// through the yaw=PI/-PI seam doesn't spin the long way around).
//
// Depends on (all optional/guarded — load order matters but defensive coding
// is still the house style): PlayerModel, Skins, M3.

var RemotePlayers = (function () {
  'use strict';

  // ---- constants --------------------------------------------------------

  var RENDER_DELAY_MS = 150;     // render this far behind the newest snapshot
  var HISTORY_MAX = 4;           // snapshots kept per player
  var NAMETAG_MAX_DIST = 40;     // blocks; hide nametag beyond this
  var TWO_PI = Math.PI * 2;

  // ---- helpers ------------------------------------------------------------

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // Normalize an angle delta into [-PI, PI] so lerping never takes the long
  // way around the yaw=PI/-PI seam.
  function shortestAngleDelta(from, to) {
    var d = (to - from) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    return d;
  }

  function lerpAngle(a, b, f) {
    return a + shortestAngleDelta(a, b) * f;
  }

  function lerp(a, b, f) { return a + (b - a) * f; }

  function safeSkinsLoad(png) {
    if (typeof Skins === 'undefined' || !Skins.load) return Promise.reject(new Error('Skins unavailable'));
    return Skins.load(png);
  }
  function safeSkinsLoadDefault() {
    if (typeof Skins === 'undefined' || !Skins.loadDefault) return Promise.reject(new Error('Skins unavailable'));
    return Skins.loadDefault();
  }

  // Cheap deterministic hash of a (long) PNG data URL string so identical
  // skins re-set on a player don't trigger a reload/re-upload.
  function hashPng(str) {
    if (!str) return '0';
    var h = 5381;
    // Sampling every 7th char keeps this O(1)-ish for multi-KB data URLs
    // while still being sensitive to real content changes.
    for (var i = 0; i < str.length; i += 7) {
      h = ((h * 33) ^ str.charCodeAt(i)) | 0;
    }
    return String(h >>> 0) + ':' + str.length;
  }

  // ---- shared default-skin texture (fallback while custom skins load) -----

  var defaultSkinPromise = null;   // Promise<skin> (Skins skin object)
  var defaultTexByGL = [];         // [{gl, tex}] — one default texture per GL context

  function ensureDefaultSkin() {
    if (!defaultSkinPromise) defaultSkinPromise = safeSkinsLoadDefault().catch(function () { return null; });
    return defaultSkinPromise;
  }

  function defaultTexFor(gl) {
    if (!gl) return null;
    for (var i = 0; i < defaultTexByGL.length; i++) {
      if (defaultTexByGL[i].gl === gl) return defaultTexByGL[i].tex;
    }
    return null;
  }

  function buildDefaultTexFor(gl) {
    if (!gl || typeof Skins === 'undefined' || !Skins.texture) return;
    if (defaultTexFor(gl)) return;
    ensureDefaultSkin().then(function (skin) {
      if (!skin || !gl) return;
      if (defaultTexFor(gl)) return; // built meanwhile
      try {
        var tex = Skins.texture(gl, skin);
        defaultTexByGL.push({ gl: gl, tex: tex });
      } catch (e) { /* ignore */ }
    });
  }

  // ---- module state ---------------------------------------------------------

  var _gl = null;
  var players = Object.create(null);   // id -> PlayerState
  var container = null;                // last containerEl passed to nametags()

  // PlayerState:
  //   id, name, guest, mode, model ('classic'|'slim')
  //   pngHash, skinTex (WebGLTexture|null), skinLoading (bool)
  //   history: [{t, p:[x,y,z], yaw, pitch, swing, crouch, fly}]
  //   pose: {p:[x,y,z], yaw, pitch, swing, crouch, fly}   -- last computed interpolated pose
  //   nameEl: HTMLElement|null

  function newPlayerState(p) {
    var st = {
      id: p.id,
      name: (p && p.name) ? String(p.name) : '???',
      guest: !!(p && p.guest),
      mode: (p && p.mode === 'creative') ? 'creative' : 'survival',
      model: (p && p.skin && p.skin.model === 'slim') ? 'slim' : 'classic',
      pngHash: null,
      skinTex: null,
      skinLoading: false,
      history: [],
      pose: {
        p: (p && Array.isArray(p.p)) ? [p.p[0], p.p[1], p.p[2]] : [0, 0, 0],
        yaw: (p && typeof p.yaw === 'number') ? p.yaw : 0,
        pitch: (p && typeof p.pitch === 'number') ? p.pitch : 0,
        swing: 0, swingAmp: 0, crouch: false, fly: false
      },
      nameEl: null
    };
    // Seed one history entry so update() has something to interpolate from
    // immediately (avoids a pop from the origin on the very first frame).
    st.history.push({
      t: nowMs(), p: st.pose.p.slice(), yaw: st.pose.yaw, pitch: st.pose.pitch,
      swing: 0, crouch: false, fly: false
    });
    return st;
  }

  function loadSkinFor(st, rec) {
    if (!rec || !rec.png) { st.pngHash = null; st.skinTex = null; return; }
    var h = hashPng(rec.png);
    if (h === st.pngHash) return; // identical skin already applied/loading
    st.pngHash = h;
    st.model = (rec.model === 'slim') ? 'slim' : 'classic';
    st.skinTex = null; // fall back to default while loading
    st.skinLoading = true;
    var gl = _gl;
    var myHash = h;
    safeSkinsLoad(rec.png).then(function (skin) {
      if (!gl || st.pngHash !== myHash) return; // superseded or torn down
      st.skinLoading = false;
      if (typeof Skins === 'undefined' || !Skins.texture) return;
      try { st.skinTex = Skins.texture(gl, skin); } catch (e) { st.skinTex = null; }
    }).catch(function () {
      if (st.pngHash !== myHash) return;
      st.skinLoading = false;
      st.skinTex = null; // stays on the default fallback
    });
  }

  // ---- public: init / lifecycle ------------------------------------------------

  function init(gl) {
    _gl = gl || null;
    if (_gl) buildDefaultTexFor(_gl);
  }

  function sync(list) {
    // Replace the whole remote-player set (from a 'welcome' payload).
    var next = Object.create(null);
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || p.id == null) continue;
        var existing = players[p.id];
        var st = existing || newPlayerState(p);
        st.name = (p.name != null) ? String(p.name) : st.name;
        st.guest = !!p.guest;
        st.mode = (p.mode === 'creative') ? 'creative' : 'survival';
        if (p.skin) loadSkinFor(st, p.skin);
        next[p.id] = st;
      }
    }
    // Detach nametag DOM for anyone who fell out of the roster.
    for (var id in players) {
      if (!next[id] && players[id].nameEl && players[id].nameEl.parentNode) {
        players[id].nameEl.parentNode.removeChild(players[id].nameEl);
      }
    }
    players = next;
  }

  function add(p) {
    if (!p || p.id == null) return;
    var st = newPlayerState(p);
    if (p.skin) loadSkinFor(st, p.skin);
    players[p.id] = st;
  }

  function remove(id) {
    var st = players[id];
    if (!st) return;
    if (st.nameEl && st.nameEl.parentNode) st.nameEl.parentNode.removeChild(st.nameEl);
    delete players[id];
  }

  // batch: [[id,x,y,z,yaw,pitch,swing,crouchFlyBits], ...] per §3.3 'moves'.
  // crouchFlyBits: bit0 = crouch, bit1 = fly (kept permissive: accept either
  // a numeric bitfield or an already-expanded {crouch,fly} object so this
  // stays robust to a sibling's exact wire choice).
  function applyMoves(batch) {
    if (!Array.isArray(batch)) return;
    var t = nowMs();
    for (var i = 0; i < batch.length; i++) {
      var row = batch[i];
      if (!row) continue;
      var id, x, y, z, yaw, pitch, swing, flags;
      if (Array.isArray(row)) {
        id = row[0]; x = row[1]; y = row[2]; z = row[3];
        yaw = row[4]; pitch = row[5]; swing = row[6]; flags = row[7];
      } else {
        id = row.id;
        var p = row.p || [row.x, row.y, row.z];
        x = p[0]; y = p[1]; z = p[2];
        yaw = row.yaw; pitch = row.pitch;
        var anim = row.anim || {};
        swing = (row.swing != null) ? row.swing : anim.swing;
        flags = row.flags != null ? row.flags : anim;
      }
      var st = players[id];
      if (!st) continue; // unknown id (join hasn't arrived yet) — drop safely

      var crouch, fly;
      if (typeof flags === 'number') {
        crouch = !!(flags & 1);
        fly = !!(flags & 2);
      } else if (flags && typeof flags === 'object') {
        crouch = !!flags.crouch;
        fly = !!flags.fly;
      } else {
        crouch = false; fly = false;
      }

      var snap = {
        t: t,
        p: [Number(x) || 0, Number(y) || 0, Number(z) || 0],
        yaw: Number(yaw) || 0,
        pitch: Number(pitch) || 0,
        swing: Number(swing) || 0,
        crouch: crouch,
        fly: fly
      };
      st.history.push(snap);
      if (st.history.length > HISTORY_MAX) st.history.shift();
    }
  }

  function setMode(id, mode) {
    var st = players[id];
    if (!st) return;
    st.mode = (mode === 'creative') ? 'creative' : 'survival';
  }

  function setSkin(id, rec) {
    var st = players[id];
    if (!st) return;
    loadSkinFor(st, rec);
  }

  // ---- interpolation ------------------------------------------------------------

  // Find the two history entries bracketing target time `tt` and lerp. If
  // every snapshot is newer than tt (just joined / low history), clamp to
  // the oldest known one; if every snapshot is older (server stalled), hold
  // at the newest instead of extrapolating.
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
          pitch: lerp(a.pitch, b.pitch, f),
          swing: lerp(a.swing, b.swing, f),
          crouch: f < 0.5 ? a.crouch : b.crouch,
          fly: f < 0.5 ? a.fly : b.fly
        };
      }
    }
    return history[n - 1];
  }

  function update(dt) {
    var target = nowMs() - RENDER_DELAY_MS;
    for (var id in players) {
      var st = players[id];
      var sample = interpolate(st.history, target);
      if (!sample) continue;
      st.pose.p[0] = sample.p[0]; st.pose.p[1] = sample.p[1]; st.pose.p[2] = sample.p[2];
      st.pose.yaw = sample.yaw;
      st.pose.pitch = sample.pitch;
      st.pose.swing = sample.swing;
      st.pose.swingAmp = 1; // server sends the already-scaled walk-cycle phase
      st.pose.crouch = sample.crouch;
      st.pose.fly = sample.fly;
    }
  }

  // ---- draw ---------------------------------------------------------------------

  function playerLight(env) {
    var ambient = (env && typeof env.ambient === 'number') ? env.ambient : 0.5;
    return clamp(ambient + 0.45, 0.25, 1);
  }

  function draw(gl, camera, env) {
    if (!gl || typeof PlayerModel === 'undefined' || !PlayerModel.draw) return;
    if (!camera || !camera.projView) return;
    var fog = env ? { color: env.fogColor, start: env.fogStart, end: env.fogEnd } : null;
    var light = playerLight(env);
    var defTex = defaultTexFor(gl);

    for (var id in players) {
      var st = players[id];
      var tex = st.skinTex || defTex;
      if (!tex) continue; // neither custom nor default ready yet — skip this frame
      PlayerModel.draw(gl, {
        skinTex: tex,
        model: st.model,
        viewProj: camera.projView,
        pos: st.pose.p,
        yaw: st.pose.yaw,
        headYaw: st.pose.yaw,
        headPitch: st.pose.pitch,
        swing: st.pose.swing,
        swingAmp: st.pose.swingAmp,
        crouch: st.pose.crouch,
        light: light,
        fog: fog,
        camPos: camera.pos
      });
    }
  }

  // ---- nametags -----------------------------------------------------------------

  var _headPt = [0, 0, 0];
  var _proj = [0, 0, 0];

  function ensureNameEl(st, containerEl) {
    if (st.nameEl && st.nameEl.parentNode === containerEl) return st.nameEl;
    if (st.nameEl && st.nameEl.parentNode) st.nameEl.parentNode.removeChild(st.nameEl);
    var el = document.createElement('div');
    el.className = 'vox-nametag';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transform = 'translate(-50%, -100%)';
    el.style.pointerEvents = 'none';
    el.style.whiteSpace = 'nowrap';
    containerEl.appendChild(el);
    st.nameEl = el;
    return el;
  }

  function nametags(camera, containerEl) {
    if (!containerEl || !camera || !camera.projView) return;
    container = containerEl;
    var w = containerEl.clientWidth || containerEl.offsetWidth || 0;
    var h = containerEl.clientHeight || containerEl.offsetHeight || 0;
    if (!w || !h) return;

    var haveM3 = (typeof M3 !== 'undefined' && M3.transformPoint);
    var camPos = camera.pos || [0, 0, 0];

    for (var id in players) {
      var st = players[id];
      var el = ensureNameEl(st, containerEl);
      if (el.textContent !== st.name) el.textContent = st.name;

      // Head roughly 1.62m above the feet-anchored pose position (matches
      // the local player's standing eye height, close enough for a label).
      _headPt[0] = st.pose.p[0];
      _headPt[1] = st.pose.p[1] + 1.75;
      _headPt[2] = st.pose.p[2];

      var dx = _headPt[0] - camPos[0], dy = _headPt[1] - camPos[1], dz = _headPt[2] - camPos[2];
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > NAMETAG_MAX_DIST) { el.style.display = 'none'; continue; }

      if (!haveM3) { el.style.display = 'none'; continue; }

      // Project through the un-divided clip-space w to detect "behind
      // camera" (M3.transformPoint already does the w-divide for xyz, so we
      // replicate the w computation here to know when to hide).
      var m = camera.projView;
      var wClip = m[3] * _headPt[0] + m[7] * _headPt[1] + m[11] * _headPt[2] + m[15];
      if (wClip <= 0) { el.style.display = 'none'; continue; }

      M3.transformPoint(_proj, m, _headPt); // _proj now in NDC [-1,1]
      var sx = (_proj[0] * 0.5 + 0.5) * w;
      var sy = (1 - (_proj[1] * 0.5 + 0.5)) * h;

      el.style.display = '';
      el.style.left = sx.toFixed(1) + 'px';
      el.style.top = sy.toFixed(1) + 'px';
    }
  }

  // ---- misc -----------------------------------------------------------------------

  function count() {
    var n = 0;
    for (var id in players) n++;
    return n;
  }

  function list() {
    var out = [];
    for (var id in players) {
      var st = players[id];
      out.push({ id: st.id, name: st.name, guest: st.guest, mode: st.mode });
    }
    return out;
  }

  function destroy() {
    for (var id in players) {
      var st = players[id];
      if (st.nameEl && st.nameEl.parentNode) st.nameEl.parentNode.removeChild(st.nameEl);
    }
    players = Object.create(null);
    container = null;
    _gl = null;
    // Default-skin textures are cheap and shared across sessions/GL contexts
    // that may still be alive (e.g. preview canvases) — intentionally not
    // deleted here; a fresh GL context on next init() gets its own entry.
  }

  // ---- public API -----------------------------------------------------------------

  return {
    init: init,
    sync: sync,
    add: add,
    remove: remove,
    applyMoves: applyMoves,
    setMode: setMode,
    setSkin: setSkin,
    update: update,
    draw: draw,
    nametags: nametags,
    count: count,
    list: list,
    destroy: destroy
  };
})();

window.RemotePlayers = RemotePlayers;
