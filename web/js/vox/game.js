// game.js — orchestrator + game loop for CLOBI CRAFT (contract §5.16).
// Exactly one global: window.Game.
//
// Boots the whole 3D stack: GLX context, Blocks atlas, LUT, Renderer,
// PlayerModel, Skins, World(+WorldGen), Input, Interact, Inventory, HUD and
// Commands — then runs the requestAnimationFrame loop with a fixed 60 Hz
// physics accumulator, budgeted chunk generation/meshing, the render pass
// order pinned in §5.15/§5.16 and the survival systems (fall damage,
// drowning, void, regen, death/respawn).
//
// Consumes (per the binding contract): M3, GLX, LUT, Blocks, WorldGen, World,
// Mesher, Skins, PlayerModel, Physics, Input, Interact, Inventory, Commands,
// HUD, Renderer — plus App/I18n/Sound/Store guarded as optional.
//
// Pinned API:
//   Game.start({mode, seed?, fresh?}) -> Promise      Game.stop()
//   Game.isRunning  Game.setMode(m)  Game.mode  Game.player  Game.world
//   Game.inventory  Game.timeTicks   Game.setTime/addTime  Game.teleport
//   Game.respawn    Game.setSpawn    Game.setRenderDist/setFov/setLutAmount
//   Game.setSpeed   Game.setSkin     Game.regen(seed?)  Game.debugSnapshot()
// Extra public members (allowed): setSkinModel, saveNow, resumePointerLock,
//   getSettings.
//
// URL dev hooks: ?seed=N&mode=creative&dist=3&dev=1 (dev=1 skips the
// pointer-lock requirement and exposes window.__vox = {Game, World: world}).

var Game = (function () {
  'use strict';

  // ---- constants ------------------------------------------------------------

  var WORLD_NAME = 'default';
  var DAY_TICKS = 24000;
  var TICKS_PER_SEC = 20;
  var PHYS_DT = 1 / 60;
  var MAX_PHYS_STEPS = 5;
  var GEN_BUDGET_MS = 3;      // chunk generation budget per frame
  var MESH_PER_FRAME = 2;     // dirty-chunk remeshes per frame
  var AUTOSAVE_MS = 4000;
  var LOOK_SENS = 0.0026;     // rad per pixel of look delta
  var EYE_STAND = 1.62;
  var EYE_SNEAK = 1.27;
  var THIRD_PERSON_DIST = 4;
  var SETTINGS_KEY = 'clobi3d.settings';
  var WATER_ID = 11;

  // ---- helpers ----------------------------------------------------------------

  function t(key, en) {
    return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, en) : en;
  }

  function sfx(name) {
    try { if (typeof Sound !== 'undefined' && Sound.play) Sound.play(name); } catch (e) { /* ok */ }
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function randomSeed() { return (Math.random() * 0x7fffffff) | 0; }

  // The Physics body stores pos/vel either as {x,y,z} or as arrays; read/write
  // through these so we only depend on the pinned createBody() shape loosely.
  function readVec(v, out) {
    if (typeof v.x === 'number') { out[0] = v.x; out[1] = v.y; out[2] = v.z; }
    else { out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; }
    return out;
  }
  function writeVec(v, x, y, z) {
    if (typeof v.x === 'number') { v.x = x; v.y = y; v.z = z; }
    else { v[0] = x; v[1] = y; v[2] = z; }
  }

  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function persistSettings(partial) {
    try {
      var o = loadSettings();
      for (var k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) o[k] = partial[k];
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    } catch (e) { /* ok */ }
  }

  // ---- module state ---------------------------------------------------------

  var canvas = null, hudRoot = null, gl = null;
  var running = false, starting = false, rafId = 0;
  var world = null, gen = null, seed = 0;
  var inv = null, interactSys = null;
  var mode = 'survival';
  var timeTicks = 0;

  var skin = null, skinTex = null, skinModel = 'classic';

  var renderDist = 6, fovDeg = 70, lutAmount = 0.85;
  var dev = false;

  var paused = false, dead = false;

  var player = {
    body: null, yaw: 0, pitch: 0, health: 20, air: 10,
    spawn: [0.5, 70, 0.5], flying: false, speedMult: 1, perspective: 0
  };

  // chunk streaming
  var generated = {};        // "cx,cz" -> true (chunk data exists in world)
  var meshed = {};           // "cx,cz" -> true (mesh uploaded to Renderer)
  var pendingMesh = {};      // "cx,cz" -> true (needs (re)mesh)
  var spiralCache = {};

  // loop bookkeeping
  var lastMs = 0, physAcc = 0, frameNo = 0;
  var fpsFrames = 0, fpsTime = 0, fpsVal = 0;
  var lastW = 0, lastH = 0, lastDpr = 0, aspect = 1;

  // survival trackers
  var fallDist = 0, wasOnGround = true, drownAcc = 0, regenAcc = 0, lastDamageMs = -1e9;

  // animation trackers
  var walkPhase = 0, swingAmp = 0, bobPhase = 0, armSwingT = 99, wasBreaking = false;

  // one-time hooks
  var inputWired = false, inputInited = false;
  var autosaveId = 0;

  // scratch vectors/matrices (reused every frame — no per-frame allocation)
  var _p = [0, 0, 0], _v = [0, 0, 0], _dir = [0, 0, 0], _eye = [0, 0, 0];
  var _camPos = [0, 0, 0], _camDir = [0, 0, 0], _up = [0, 1, 0];
  var _view = new Float32Array(16), _proj = new Float32Array(16), _pv = new Float32Array(16);
  var _eView = new Float32Array(16), _eProj = new Float32Array(16), _ePv = new Float32Array(16);
  var renderCam = { pos: [0, 0, 0], yaw: 0, pitch: 0, fovDeg: 70, aspect: 1, view: _view, proj: _proj, projView: _pv };
  var eyeCam = { pos: [0, 0, 0], yaw: 0, pitch: 0, fovDeg: 70, aspect: 1, view: _eView, proj: _eProj, projView: _ePv };
  var hudState = { mode: 'survival', health: 20, air: null, selected: 0, hotbar: null, fps: 0, pos: [0, 0, 0], targetName: '', time: 0 };

  // ---- URL params -------------------------------------------------------------

  function urlParams() {
    var out = {};
    try {
      var q = window.location.search.replace(/^\?/, '').split('&');
      for (var i = 0; i < q.length; i++) {
        var kv = q[i].split('=');
        if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      }
    } catch (e) { /* ok */ }
    return out;
  }

  // ---- screen switching ---------------------------------------------------------

  var SCREENS = ['menu', 'game', 'studio', 'wardrobe', 'market'];

  function showGameScreen() {
    // Direct .active toggle (calling App.showScreen('game') here could recurse
    // if the router itself starts the game).
    for (var i = 0; i < SCREENS.length; i++) {
      var e = document.getElementById('screen-' + SCREENS[i]);
      if (e) e.classList.toggle('active', SCREENS[i] === 'game');
    }
  }

  function backToMenu() {
    if (typeof App !== 'undefined' && App.showScreen) {
      App.showScreen('menu');
    } else {
      for (var i = 0; i < SCREENS.length; i++) {
        var e = document.getElementById('screen-' + SCREENS[i]);
        if (e) e.classList.toggle('active', SCREENS[i] === 'menu');
      }
    }
  }

  // Make sure the game screen skeleton exists (defensive: only creates what is
  // missing so the index.html owner keeps authority over the real markup).
  function ensureDom() {
    var screen = document.getElementById('screen-game');
    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'screen-game';
      document.body.appendChild(screen);
    }
    canvas = document.getElementById('game-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'game-canvas';
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
      screen.appendChild(canvas);
    }
    hudRoot = document.getElementById('hud-root');
    if (!hudRoot) {
      hudRoot = document.createElement('div');
      hudRoot.id = 'hud-root';
      hudRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      screen.appendChild(hudRoot);
    }
    if (getComputedStyle(screen).position === 'static') screen.style.position = 'relative';
  }

  function showWebglError() {
    var screen = document.getElementById('screen-game') || document.body;
    var d = document.createElement('div');
    d.className = 'vox-webgl-error';
    d.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#101820;color:#fff;text-align:center;padding:24px;z-index:50;';
    var h = document.createElement('h2');
    h.textContent = t('vox.err.webgl2.title', 'WebGL2 not available');
    var p = document.createElement('p');
    p.textContent = t('vox.err.webgl2', 'CLOBI CRAFT needs a browser with WebGL2. Please update your browser or enable hardware acceleration.');
    var b = document.createElement('button');
    b.textContent = t('vox.err.webgl2.back', 'Back to menu');
    b.style.cssText = 'padding:10px 24px;font:inherit;cursor:pointer;';
    b.addEventListener('click', function () {
      if (d.parentNode) d.parentNode.removeChild(d);
      backToMenu();
    });
    d.appendChild(h); d.appendChild(p); d.appendChild(b);
    screen.appendChild(d);
  }

  // ---- chunk key helpers ---------------------------------------------------------

  function ck(cx, cz) { return cx + ',' + cz; }

  function playerChunk(out) {
    readVec(player.body.pos, _p);
    out[0] = Math.floor(_p[0] / 16);
    out[1] = Math.floor(_p[2] / 16);
    return out;
  }
  var _pc = [0, 0];

  // Offsets within chebyshev radius r, sorted nearest-first (spiral order).
  function spiral(r) {
    var c = spiralCache[r];
    if (c) return c;
    var list = [];
    for (var dz = -r; dz <= r; dz++) {
      for (var dx = -r; dx <= r; dx++) list.push([dx, dz]);
    }
    list.sort(function (a, b) {
      return (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]);
    });
    spiralCache[r] = list;
    return list;
  }

  function ensureChunkTracked(cx, cz) {
    var key = ck(cx, cz);
    if (generated[key]) return;
    world.ensureChunk(cx, cz);
    generated[key] = true;
    // this chunk + already-meshed neighbors need (re)meshing for border faces
    pendingMesh[key] = true;
    var n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var i = 0; i < 4; i++) {
      var nk = ck(cx + n[i][0], cz + n[i][1]);
      if (generated[nk]) pendingMesh[nk] = true;
    }
  }

  function neighborsGenerated(cx, cz) {
    return generated[ck(cx + 1, cz)] && generated[ck(cx - 1, cz)] &&
           generated[ck(cx, cz + 1)] && generated[ck(cx, cz - 1)];
  }

  // ---- chunk streaming (generate → mesh → drop) -----------------------------------

  function streamChunks() {
    var t0 = performance.now();
    playerChunk(_pc);
    var offs = spiral(renderDist + 1);
    for (var i = 0; i < offs.length; i++) {
      var key = ck(_pc[0] + offs[i][0], _pc[1] + offs[i][1]);
      if (generated[key]) continue;
      ensureChunkTracked(_pc[0] + offs[i][0], _pc[1] + offs[i][1]);
      if (performance.now() - t0 > GEN_BUDGET_MS) break;
    }
  }

  function meshChunks() {
    // ingest world-side dirty marks (block edits)
    var dirty = world.dirtyChunks();
    for (var i = 0; i < dirty.length; i++) {
      var dk = ck(dirty[i][0], dirty[i][1]);
      pendingMesh[dk] = true;
      world.clearDirty(dirty[i][0], dirty[i][1]);
    }
    // re-queue generated-but-unmeshed chunks that came back into range
    var offs = spiral(renderDist);
    for (i = 0; i < offs.length; i++) {
      var kk = ck(_pc[0] + offs[i][0], _pc[1] + offs[i][1]);
      if (generated[kk] && !meshed[kk] && !pendingMesh[kk]) pendingMesh[kk] = true;
    }
    // pick the nearest meshable candidates, budget MESH_PER_FRAME per frame
    var picks = [];
    for (var key in pendingMesh) {
      var parts = key.split(',');
      var cx = parts[0] | 0, cz = parts[1] | 0;
      var d = Math.max(Math.abs(cx - _pc[0]), Math.abs(cz - _pc[1]));
      if (d > renderDist + 2) { delete pendingMesh[key]; continue; }
      if (d > renderDist + 1) continue;                    // wait until closer
      if (!neighborsGenerated(cx, cz)) continue;           // §5.6 precondition
      picks.push([cx, cz, (cx - _pc[0]) * (cx - _pc[0]) + (cz - _pc[1]) * (cz - _pc[1])]);
    }
    picks.sort(function (a, b) { return a[2] - b[2]; });
    var n = Math.min(MESH_PER_FRAME, picks.length);
    for (i = 0; i < n; i++) {
      var cx2 = picks[i][0], cz2 = picks[i][1];
      var key2 = ck(cx2, cz2);
      var m = Mesher.meshChunk(world, cx2, cz2);
      if (m && !m.empty) Renderer.uploadChunkMesh(cx2, cz2, m);
      else Renderer.dropChunkMesh(cx2, cz2);
      meshed[key2] = true;
      delete pendingMesh[key2];
    }
  }

  function dropFarMeshes() {
    for (var key in meshed) {
      var parts = key.split(',');
      var cx = parts[0] | 0, cz = parts[1] | 0;
      if (Math.max(Math.abs(cx - _pc[0]), Math.abs(cz - _pc[1])) > renderDist + 2) {
        Renderer.dropChunkMesh(cx, cz);
        delete meshed[key];
        delete pendingMesh[key];
      }
    }
  }

  function meshedCount() {
    var n = 0;
    for (var k in meshed) if (meshed[k]) n++;
    return n;
  }

  // Synchronously generate a 3×3 chunk area (spawn / teleport landing zone).
  function pregenAround(x, z) {
    var cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (var dz = -1; dz <= 1; dz++) {
      for (var dx = -1; dx <= 1; dx++) ensureChunkTracked(cx + dx, cz + dz);
    }
  }

  // ---- camera (pinned math, §3) ---------------------------------------------------

  function lookDir(yaw, pitch, out) {
    var cp = Math.cos(pitch);
    out[0] = -Math.sin(yaw) * cp;
    out[1] = Math.sin(pitch);
    out[2] = -Math.cos(yaw) * cp;
    return out;
  }

  function eyeHeight() {
    var sneaking = !player.flying && typeof Input !== 'undefined' &&
                   Input.state && Input.state.sneak && !uiBlocked();
    return sneaking ? EYE_SNEAK : EYE_STAND;
  }

  // Raycast pull-in so the 3rd-person camera never clips through walls.
  function cameraDist(origin, dir, maxD) {
    if (typeof Interact !== 'undefined' && Interact.raycast && world) {
      try {
        var r = Interact.raycast(world, origin, dir, maxD);
        if (r && r.hit) return Math.max(0.4, r.dist * 0.9);
      } catch (e) { /* fall through */ }
    }
    return maxD;
  }

  function fillCam(cam, pos, yaw, pitch, dir, view, proj, pv) {
    cam.pos[0] = pos[0]; cam.pos[1] = pos[1]; cam.pos[2] = pos[2];
    cam.yaw = yaw; cam.pitch = pitch;
    cam.fovDeg = fovDeg; cam.aspect = aspect;
    var far = Math.max(96, (renderDist + 2) * 16 + 16);
    M3.mat4Perspective(proj, fovDeg * Math.PI / 180, aspect, 0.05, far);
    M3.mat4LookDir(view, pos, dir, _up);
    M3.mat4Multiply(pv, proj, view);
  }

  // Computes eyeCam (always first-person, used for interaction rays) and
  // renderCam (respects player.perspective). Returns renderCam.
  function computeCameras() {
    readVec(player.body.pos, _p);
    _eye[0] = _p[0]; _eye[1] = _p[1] + eyeHeight(); _eye[2] = _p[2];
    lookDir(player.yaw, player.pitch, _dir);

    fillCam(eyeCam, _eye, player.yaw, player.pitch, _dir, _eView, _eProj, _ePv);

    var persp = player.perspective;
    if (persp === 0) {
      fillCam(renderCam, _eye, player.yaw, player.pitch, _dir, _view, _proj, _pv);
    } else if (persp === 1) {
      // behind the player, looking the same way
      _camDir[0] = -_dir[0]; _camDir[1] = -_dir[1]; _camDir[2] = -_dir[2];
      var d1 = cameraDist(_eye, _camDir, THIRD_PERSON_DIST);
      _camPos[0] = _eye[0] + _camDir[0] * d1;
      _camPos[1] = _eye[1] + _camDir[1] * d1;
      _camPos[2] = _eye[2] + _camDir[2] * d1;
      fillCam(renderCam, _camPos, player.yaw, player.pitch, _dir, _view, _proj, _pv);
    } else {
      // in front of the player, looking back at it
      var d2 = cameraDist(_eye, _dir, THIRD_PERSON_DIST);
      _camPos[0] = _eye[0] + _dir[0] * d2;
      _camPos[1] = _eye[1] + _dir[1] * d2;
      _camPos[2] = _eye[2] + _dir[2] * d2;
      _camDir[0] = -_dir[0]; _camDir[1] = -_dir[1]; _camDir[2] = -_dir[2];
      fillCam(renderCam, _camPos, player.yaw + Math.PI, -player.pitch, _camDir, _view, _proj, _pv);
    }
    return renderCam;
  }

  // ---- UI state -----------------------------------------------------------------

  function uiBlocked() {
    if (paused || dead) return true;
    if (typeof HUD !== 'undefined') {
      if (HUD.isChatOpen && HUD.isChatOpen()) return true;
      if (HUD.isInventoryOpen && HUD.isInventoryOpen()) return true;
    }
    return false;
  }

  function resumePointerLock() {
    if (!running || dev || uiBlocked()) return;
    if (typeof Input !== 'undefined' && !Input.isTouch && Input.requestPointerLock && !Input.isLocked) {
      Input.requestPointerLock();
    }
  }

  // ---- survival systems -------------------------------------------------------

  function damage(halfHearts) {
    if (mode !== 'survival' || dead) return;
    player.health = Math.max(0, player.health - halfHearts);
    lastDamageMs = performance.now();
    regenAcc = 0;
    sfx('hurt');
  }

  function die() {
    if (dead) return;
    dead = true;
    player.health = 0;
    sfx('death');
    if (typeof Input !== 'undefined') {
      if (Input.setUIMode) Input.setUIMode(true);
      if (Input.exitPointerLock) Input.exitPointerLock();
    }
    HUD.showDeath(true, { onRespawn: function () { api.respawn(); } });
    saveNow();
  }

  function survivalTick(dt) {
    var b = player.body;
    readVec(b.pos, _p);
    readVec(b.vel, _v);

    // -- fall distance / fall damage --
    if (b.inWater || player.flying) {
      fallDist = 0;
    } else if (!b.onGround && _v[1] < 0) {
      fallDist += -_v[1] * dt;
    }
    if (b.onGround) {
      if (!wasOnGround && fallDist > 0) {
        var dmg = Physics.fallDamage(fallDist);
        if (dmg > 0) damage(dmg);
      }
      fallDist = 0;
    }
    wasOnGround = b.onGround;

    // -- drowning (10 bubbles, then 1 half-heart per second) --
    if (b.headInWater) {
      player.air = Math.max(0, player.air - dt);
      if (player.air <= 0) {
        drownAcc += dt;
        while (drownAcc >= 1) { drownAcc -= 1; damage(1); }
      }
    } else {
      drownAcc = 0;
      player.air = Math.min(10, player.air + 4 * dt);
    }

    // -- void --
    if (_p[1] < -8) damage(1000);

    // -- health regen: +1 per 4 s when 30 s+ since last damage --
    if (player.health > 0 && player.health < 20 &&
        performance.now() - lastDamageMs > 30000) {
      regenAcc += dt;
      if (regenAcc >= 4) {
        regenAcc -= 4;
        player.health = Math.min(20, player.health + 1);
      }
    }

    if (player.health <= 0) die();
  }

  // ---- fixed-rate physics step ------------------------------------------------------

  var physInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
  var physOpts = { mode: 'walk', speedMult: 1, yaw: 0 };

  var lastFlyShown = null;

  function stepPhysics(dt) {
    if (mode === 'survival') player.flying = false;   // survival never flies
    var flying = mode === 'creative' && player.flying;
    if (flying !== lastFlyShown && typeof Input !== 'undefined' && Input.setFlying) {
      Input.setFlying(flying);   // touch fly up/down buttons follow flight state
      lastFlyShown = flying;
    }

    var blocked = uiBlocked();
    physInput.forward = blocked ? 0 : Input.move.forward;
    physInput.strafe = blocked ? 0 : Input.move.strafe;
    physInput.jump = !blocked && !!Input.state.jump;
    physInput.sneak = !blocked && !!Input.state.sneak;
    physInput.sprint = !blocked && !!Input.state.sprint;

    physOpts.mode = flying ? 'fly' : 'walk';
    physOpts.speedMult = player.speedMult;
    physOpts.yaw = player.yaw;
    player.body.yaw = player.yaw;   // extra hint for Physics implementations

    Physics.step(world, player.body, physInput, dt, physOpts);

    if (mode === 'survival') survivalTick(dt);

    // walk-cycle bookkeeping for the player model + first-person bob
    readVec(player.body.vel, _v);
    var hs = Math.sqrt(_v[0] * _v[0] + _v[2] * _v[2]);
    walkPhase = (walkPhase + hs * dt * 0.55) % 1;
    var ampTarget = Math.min(1, hs / 4.3);
    swingAmp += (ampTarget - swingAmp) * Math.min(1, 10 * dt);
    if (player.body.onGround) bobPhase = (bobPhase + hs * dt * 0.4) % 1;
  }

  // ---- mode switch ------------------------------------------------------------------

  function setMode(m) {
    if (m !== 'survival' && m !== 'creative') return;
    if (m === mode) return;
    mode = m;
    if (m === 'survival') {
      player.flying = false;   // creative→survival drops flying
      fallDist = 0;            // ...but the drop starts counting fresh
      wasOnGround = !!(player.body && player.body.onGround);
    }
    // survival→creative keeps velocity: nothing to do — we simply don't touch it
    if (inv) {
      if (typeof inv.setMode === 'function') inv.setMode(m);
      else inv.mode = m;
    }
    var name = m === 'creative' ? t('vox.mode.creative', 'Creative') : t('vox.mode.survival', 'Survival');
    HUD.toast(name);
    HUD.chatPrint(t('vox.msg.modeChanged', 'Game mode: {mode}').replace('{mode}', name), 'sys');
    saveNow();
  }

  // ---- pause ------------------------------------------------------------------------

  function pauseGame() {
    if (paused || dead || !running) return;
    paused = true;
    if (typeof Input !== 'undefined') {
      if (Input.setUIMode) Input.setUIMode(true);
      if (Input.exitPointerLock) Input.exitPointerLock();
    }
    HUD.showPaused(true, {
      onResume: resumeGame,
      onSettings: function () { /* HUD renders the settings view itself */ },
      onQuit: function () { api.stop(); }
    });
    saveNow();
  }

  function resumeGame() {
    if (!paused) return;
    paused = false;
    HUD.showPaused(false);
    if (typeof Input !== 'undefined' && Input.setUIMode) Input.setUIMode(false);
    resumePointerLock();
  }

  function onPauseEvent() {
    if (!running || dead) return;
    if (HUD.isChatOpen && HUD.isChatOpen()) return;          // Esc closes chat itself
    if (HUD.isInventoryOpen && HUD.isInventoryOpen()) {      // Esc closes the panel
      HUD.closeInventory();
      return;
    }
    if (paused) resumeGame(); else pauseGame();
  }

  // ---- input wiring --------------------------------------------------------------------

  function wireInputEvents() {
    if (inputWired) return;
    inputWired = true;
    Input.on('hotbar', function (n) {
      if (running && inv && !uiBlocked()) inv.select(n);
    });
    Input.on('hotbarScroll', function (d) {
      if (running && inv && !uiBlocked()) inv.select(((inv.selected + d) % 9 + 9) % 9);
    });
    Input.on('chat', function (prefill) {
      if (running && !paused && !dead) HUD.openChat(prefill || '');
    });
    Input.on('pause', onPauseEvent);
    Input.on('debug', function () { if (running) HUD.toggleDebug(); });
    Input.on('perspective', function () {
      if (running && !uiBlocked()) player.perspective = (player.perspective + 1) % 3;
    });
    Input.on('inventory', function () {
      if (!running || paused || dead) return;
      if (HUD.isInventoryOpen && HUD.isInventoryOpen()) HUD.closeInventory();
      else HUD.openInventory();
    });
    Input.on('flyToggle', function () {
      if (running && mode === 'creative' && !uiBlocked()) player.flying = !player.flying;
    });
  }

  function onCanvasClick() {
    if (running) resumePointerLock();
  }

  // ---- persistence -----------------------------------------------------------------------

  function saveNow() {
    if (!world) return Promise.resolve();
    try {
      readVec(player.body.pos, _p);
      world.setMeta({
        seed: seed,
        mode: mode,
        time: timeTicks,
        spawn: player.spawn.slice(),
        pos: [_p[0], _p[1], _p[2]],
        yaw: player.yaw,
        pitch: player.pitch,
        health: player.health,
        flying: player.flying,
        inv: (inv && inv.serialize) ? inv.serialize() : null,
        sel: inv ? inv.selected : 0
      });
    } catch (e) { /* meta write must never break the loop */ }
    return world.save().catch(function () { /* IndexedDB hiccup — retried in 4 s */ });
  }

  function onVisibility() {
    if (document.hidden && running) saveNow();
  }
  function onPageHide() {
    if (running) saveNow();
  }

  // ---- per-frame: resize, HUD state, render --------------------------------------------

  function resizeIfNeeded() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    var dpr = window.devicePixelRatio || 1;
    if (w !== lastW || h !== lastH || dpr !== lastDpr) {
      lastW = w; lastH = h; lastDpr = dpr;
      Renderer.resize(w, h, dpr);
    }
    aspect = h > 0 ? w / h : 1;
  }

  function targetName() {
    if (!interactSys || !interactSys.target || !interactSys.target.hit) return '';
    var tg = interactSys.target;
    var id = world.getBlock(tg.x, tg.y, tg.z);
    var def = (typeof Blocks !== 'undefined') ? Blocks.byId(id) : null;
    return def && id !== 0 ? t(def.i18nKey, def.name) : '';
  }

  function eyeUnderwater() {
    readVec(player.body.pos, _p);
    var ey = _p[1] + eyeHeight();
    return world.getBlock(Math.floor(_p[0]), Math.floor(ey), Math.floor(_p[2])) === WATER_ID;
  }

  function playerLight(env) {
    return clamp((env.ambient || 0.5) + 0.45, 0.25, 1);
  }

  // Trigger the first-person arm swing from interaction activity.
  function updateArmSwing(dt, actions) {
    var breaking = !!(interactSys && interactSys.target && interactSys.target.progress > 0);
    for (var i = 0; i < actions.length; i++) {
      var ty = actions[i].type;
      if (ty === 'place' || ty === 'breakStart' || ty === 'tapPlace' || ty === 'tapBreakStart' || ty === 'pick') {
        armSwingT = 0;
      }
    }
    if (breaking && !wasBreaking) armSwingT = 0;
    if (breaking && armSwingT > 0.3) armSwingT = 0;   // keep swinging while mining
    wasBreaking = breaking;
    armSwingT += dt;
  }

  function drawOwnPlayer(env) {
    readVec(player.body.pos, _p);
    PlayerModel.draw(gl, {
      skinTex: skinTex,
      model: skinModel,
      viewProj: renderCam.projView,
      pos: [_p[0], _p[1], _p[2]],
      yaw: player.yaw,
      headYaw: player.yaw,
      headPitch: player.pitch,
      swing: walkPhase,
      swingAmp: swingAmp,
      crouch: !player.flying && typeof Input !== 'undefined' && Input.state && !!Input.state.sneak,
      light: playerLight(env),
      fog: { color: env.fogColor, start: env.fogStart, end: env.fogEnd },
      camPos: renderCam.pos
    });
  }

  function drawArm(env) {
    var swing01 = armSwingT < 0.3 ? armSwingT / 0.3 : 0;
    readVec(player.body.vel, _v);
    var hs = Math.sqrt(_v[0] * _v[0] + _v[2] * _v[2]);
    var bob = Math.sin(bobPhase * Math.PI * 2) * Math.min(1, hs / 4.3) *
              (player.body.onGround ? 1 : 0);
    PlayerModel.drawFirstPersonArm(gl, {
      skinTex: skinTex,
      model: skinModel,
      proj: renderCam.proj,
      swing01: swing01,
      bob: bob,
      light: playerLight(env)
    });
  }

  function fillHudState() {
    hudState.mode = mode;
    hudState.health = player.health;
    hudState.air = (mode === 'survival' && player.body.headInWater) ? player.air : null;
    hudState.selected = inv ? inv.selected : 0;
    hudState.hotbar = inv ? inv.hotbar : null;
    hudState.fps = fpsVal;
    readVec(player.body.pos, _p);
    hudState.pos[0] = _p[0]; hudState.pos[1] = _p[1]; hudState.pos[2] = _p[2];
    hudState.targetName = targetName();
    hudState.time = timeTicks;
    return hudState;
  }

  // ---- the main loop -----------------------------------------------------------------------

  function frame(nowMs) {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    var dt = Math.min(0.25, lastMs ? (nowMs - lastMs) / 1000 : PHYS_DT);
    lastMs = nowMs;

    // fps (updated twice a second)
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) { fpsVal = Math.round(fpsFrames / fpsTime); fpsFrames = 0; fpsTime = 0; }

    resizeIfNeeded();

    var active = !paused && !dead;

    // -- input: look --
    var look = Input.consumeLook();
    if (active && !uiBlocked()) {
      // yaw=0 faces -Z and increasing yaw sweeps toward -X (see forwardXZ in
      // computeCameras), so turning the view right (movementX/dx > 0) needs
      // yaw to DECREASE -- otherwise the camera turns opposite the mouse.
      player.yaw -= look.dx * LOOK_SENS;
      player.pitch = clamp(player.pitch - look.dy * LOOK_SENS,
        -(Math.PI / 2 - 0.001), Math.PI / 2 - 0.001);
      if (player.yaw > Math.PI * 2 || player.yaw < -Math.PI * 2) {
        player.yaw = player.yaw % (Math.PI * 2);
      }
    }

    // -- physics: fixed 60 Hz accumulator, max 5 steps --
    if (active) {
      physAcc += dt;
      var steps = 0;
      while (physAcc >= PHYS_DT && steps < MAX_PHYS_STEPS) {
        stepPhysics(PHYS_DT);
        physAcc -= PHYS_DT;
        steps++;
      }
      if (steps === MAX_PHYS_STEPS) physAcc = 0;   // dropped time on heavy frames
    }

    // -- cameras (eyeCam for interaction, renderCam for drawing) --
    computeCameras();

    // -- interaction --
    var actions = Input.consumeActions();
    if (active && interactSys) {
      interactSys.update(dt, actions, eyeCam);
      updateArmSwing(dt, actions);
    }

    // -- world time (+20 ticks/s) --
    if (active) timeTicks = (timeTicks + TICKS_PER_SEC * dt) % DAY_TICKS;

    // -- chunk streaming --
    streamChunks();
    meshChunks();
    if ((frameNo & 31) === 0) dropFarMeshes();

    // -- render (pass order pinned in §5.15/§5.16) --
    var env = Renderer.computeEnv(timeTicks, renderDist);
    var under = eyeUnderwater();
    env.underwater = under;
    Renderer.beginFrame(renderCam, env);
    Renderer.drawSky(env, renderCam);
    Renderer.drawChunks(renderCam, env, 'opaque');
    if (player.perspective !== 0 && skinTex) drawOwnPlayer(env);
    Renderer.drawSelection(renderCam, interactSys ? interactSys.target : null);
    Renderer.drawChunks(renderCam, env, 'translucent');
    Renderer.drawClouds(env, renderCam, nowMs);
    if (player.perspective === 0 && skinTex && active && !uiBlocked()) drawArm(env);
    Renderer.endFrame({
      lutAmount: lutAmount,
      vibrance: 0.18,
      gamma: 1.0,
      underwater: under,
      vignette: 0.15
    });

    HUD.update(fillHudState());
    frameNo++;
  }

  // ---- boot ----------------------------------------------------------------------------------

  function applyStoredSettings(q) {
    var s = loadSettings();
    renderDist = clamp((q.dist ? parseInt(q.dist, 10) : 0) || s.dist ||
      ((typeof Input !== 'undefined' && Input.isTouch) ? 4 : 6), 2, 10);
    fovDeg = clamp(s.fov || 70, 30, 110);
    lutAmount = clamp((typeof s.lut === 'number' ? s.lut : 85) / 100, 0, 1);
  }

  function start(opts) {
    opts = opts || {};
    if (running || starting) return Promise.resolve();
    starting = true;

    var q = urlParams();
    dev = q.dev === '1';

    ensureDom();
    showGameScreen();

    gl = GLX.getContext(canvas);
    if (!gl) {
      showWebglError();
      starting = false;
      return Promise.resolve();
    }

    applyStoredSettings(q);

    // GPU-side one-offs
    var atlas = Blocks.buildAtlas(gl);
    var lutTex = LUT.texture(gl);
    Renderer.init(gl, { atlas: atlas, lutTex: lutTex });
    PlayerModel.init(gl);

    // skin: the app-wide active skin if the shell resolved one, else default
    var skinP = (typeof App !== 'undefined' && App.skin)
      ? Promise.resolve(App.skin)
      : Skins.loadDefault();

    // world: wipe on fresh, else load-or-create with seed reuse
    var worldP = skinP.then(function (s) {
      setSkinInternal(s);
      if (opts.fresh) return World.wipe(WORLD_NAME).then(function () { return null; });
      return World.load(WORLD_NAME).catch(function () { return null; });
    });

    return worldP.then(function (saved) {
      var urlSeed = /^-?\d+$/.test(q.seed || '') ? parseInt(q.seed, 10) : undefined;
      seed = (saved && typeof saved.seed === 'number') ? saved.seed
        : (typeof opts.seed === 'number' ? opts.seed
          : (urlSeed !== undefined ? urlSeed : randomSeed()));

      gen = WorldGen.create(seed);
      world = World.create({
        seed: seed, name: WORLD_NAME, gen: gen,
        edits: saved && saved.edits, meta: saved && saved.meta   // extra hints, harmless
      });

      var meta = (saved && saved.meta) ||
                 (world.getMeta ? (world.getMeta() || {}) : {});

      // mode priority: explicit option > URL > saved > survival
      var qm = (q.mode === 'creative' || q.mode === 'survival') ? q.mode : null;
      mode = opts.mode || qm || meta.mode || 'survival';
      timeTicks = (typeof meta.time === 'number') ? meta.time % DAY_TICKS : 0;

      // spawn + starting position
      if (Array.isArray(meta.spawn) && meta.spawn.length === 3) {
        player.spawn = meta.spawn.slice();
      } else {
        player.spawn = [0.5, gen.surfaceHeight(0, 0) + 2, 0.5];
      }
      var startPos = (Array.isArray(meta.pos) && meta.pos.length === 3)
        ? meta.pos : player.spawn;
      pregenAround(startPos[0], startPos[2]);

      player.body = Physics.createBody({ x: startPos[0], y: startPos[1], z: startPos[2] });
      player.yaw = meta.yaw || 0;
      player.pitch = meta.pitch || 0;
      player.health = (mode === 'survival' && typeof meta.health === 'number')
        ? clamp(meta.health, 1, 20) : 20;
      player.air = 10;
      player.flying = mode === 'creative' && !!meta.flying;
      player.speedMult = 1;
      player.perspective = 0;

      // inventory (restored when saved, else mode defaults)
      inv = null;
      if (meta.inv && Inventory.deserialize) {
        try { inv = Inventory.deserialize(meta.inv); } catch (e) { inv = null; }
      }
      if (!inv) {
        inv = Inventory.create(mode);
        if (mode === 'creative') inv.setCreativeDefaults();
        else inv.setSurvivalDefaults();
      } else if (typeof inv.setMode === 'function') {
        inv.setMode(mode);
      }
      if (typeof meta.sel === 'number') inv.select(clamp(meta.sel, 0, 8));

      // input / hud / interact / commands (Input listeners installed once)
      if (!inputInited) {
        Input.init({ canvas: canvas, hudRoot: hudRoot });
        inputInited = true;
      }
      wireInputEvents();
      Input.setTouchVisible(true);
      Input.setUIMode(false);

      HUD.init({ root: hudRoot, game: api, atlas: atlas });
      interactSys = Interact.create({ world: world, player: player, inventory: inv, hud: HUD, game: api });
      Commands.init({ game: api, hud: HUD });

      // pointer lock on canvas click (idempotent re-hook; skipped when ?dev=1
      // inside resumePointerLock itself)
      canvas.removeEventListener('click', onCanvasClick);
      canvas.addEventListener('click', onCanvasClick);

      // autosave + lifecycle saves
      autosaveId = setInterval(saveNow, AUTOSAVE_MS);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);

      if (dev) window.__vox = { Game: api, World: world };

      if (typeof Input !== 'undefined' && !Input.isTouch) {
        HUD.chatPrint(t('vox.chat.hint', 'Press T to chat, / for commands, F3 for debug'), 'sys');
      }

      // reset loop state and go
      paused = false; dead = false;
      physAcc = 0; lastMs = 0; frameNo = 0;
      fpsFrames = 0; fpsTime = 0; fpsVal = 0;
      lastW = 0; lastH = 0; lastDpr = 0;
      fallDist = 0; wasOnGround = true; drownAcc = 0; regenAcc = 0;
      lastDamageMs = -1e9; armSwingT = 99; wasBreaking = false;
      running = true;
      starting = false;
      rafId = requestAnimationFrame(frame);
    }).catch(function (e) {
      starting = false;
      throw e;
    });
  }

  function stop() {
    if (!running && !starting) return;
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(autosaveId);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    saveNow();

    Renderer.destroyAll();
    generated = {}; meshed = {}; pendingMesh = {};
    interactSys = null;
    world = null; gen = null;
    skinTex = null;   // GL objects died with the context resources

    HUD.destroy();
    if (typeof Input !== 'undefined') {
      if (Input.setUIMode) Input.setUIMode(true);
      if (Input.setTouchVisible) Input.setTouchVisible(false);
      if (Input.exitPointerLock) Input.exitPointerLock();
    }
    paused = false; dead = false;
    gl = null;
    backToMenu();
  }

  // ---- world regen (used by /regen confirm) --------------------------------------------------

  function regen(newSeed) {
    if (!running) return Promise.resolve();
    return World.wipe(WORLD_NAME).then(function () {
      // drop every uploaded mesh, forget all streaming state
      for (var key in meshed) {
        var parts = key.split(',');
        Renderer.dropChunkMesh(parts[0] | 0, parts[1] | 0);
      }
      generated = {}; meshed = {}; pendingMesh = {};

      seed = (typeof newSeed === 'number' && isFinite(newSeed)) ? (newSeed | 0) : randomSeed();
      gen = WorldGen.create(seed);
      world = World.create({ seed: seed, name: WORLD_NAME, gen: gen });
      interactSys = Interact.create({ world: world, player: player, inventory: inv, hud: HUD, game: api });

      timeTicks = 0;
      player.spawn = [0.5, gen.surfaceHeight(0, 0) + 2, 0.5];
      pregenAround(player.spawn[0], player.spawn[2]);
      writeVec(player.body.pos, player.spawn[0], player.spawn[1], player.spawn[2]);
      writeVec(player.body.vel, 0, 0, 0);
      player.health = 20; player.air = 10;
      fallDist = 0; drownAcc = 0; regenAcc = 0; dead = false;
      HUD.showDeath(false);

      if (dev && window.__vox) window.__vox.World = world;
      return saveNow();
    });
  }

  // ---- skin ------------------------------------------------------------------------------------

  function setSkinInternal(s) {
    if (!s) return;
    skin = s;
    skinModel = s.model === 'slim' ? 'slim' : 'classic';
    if (gl) skinTex = Skins.texture(gl, s);
  }

  // ---- public API --------------------------------------------------------------------------------

  var api = {
    start: start,
    stop: stop,
    setMode: setMode,

    setTime: function (tv) {
      timeTicks = ((tv % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
    },
    addTime: function (dtT) {
      api.setTime(timeTicks + dtT);
    },

    teleport: function (x, y, z) {
      if (!player.body) return;
      pregenAround(x, z);
      writeVec(player.body.pos, x, y, z);
      writeVec(player.body.vel, 0, 0, 0);
      fallDist = 0;
    },

    respawn: function () {
      if (!player.body) return;
      player.health = 20;
      player.air = 10;
      dead = false;
      fallDist = 0; drownAcc = 0; regenAcc = 0;
      lastDamageMs = -1e9;
      HUD.showDeath(false);
      api.teleport(player.spawn[0], player.spawn[1], player.spawn[2]);
      if (typeof Input !== 'undefined' && Input.setUIMode) Input.setUIMode(false);
      resumePointerLock();
    },

    setSpawn: function (x, y, z) {
      player.spawn = [x, y, z];
      saveNow();
    },

    setRenderDist: function (n) {
      renderDist = clamp(Math.round(n), 2, 10);
      persistSettings({ dist: renderDist });
    },
    setFov: function (deg) {
      fovDeg = clamp(deg, 30, 110);
      persistSettings({ fov: fovDeg });
    },
    setLutAmount: function (a) {
      lutAmount = clamp(a, 0, 1);
      persistSettings({ lut: Math.round(lutAmount * 100) });
    },
    setSpeed: function (m) {
      player.speedMult = clamp(m, 0.5, 10);
    },

    setSkin: function (s) { setSkinInternal(s); },
    setSkinModel: function (m) {
      if (m === 'classic' || m === 'slim') skinModel = m;
    },

    regen: regen,

    debugSnapshot: function () {
      var pos = [0, 0, 0];
      if (player.body) readVec(player.body.pos, pos);
      return {
        pos: pos,
        mode: mode,
        fps: fpsVal,
        chunkCount: meshedCount(),
        seed: seed,
        time: Math.floor(timeTicks)
      };
    },

    // extra public members (HUD/Commands conveniences)
    saveNow: saveNow,
    resumePointerLock: resumePointerLock,
    getSettings: function () {
      return { dist: renderDist, fov: fovDeg, lut: Math.round(lutAmount * 100) };
    }
  };

  Object.defineProperties(api, {
    isRunning: { get: function () { return running; }, enumerable: true },
    mode: { get: function () { return mode; }, enumerable: true },
    player: { get: function () { return player; }, enumerable: true },
    world: { get: function () { return world; }, enumerable: true },
    inventory: { get: function () { return inv; }, enumerable: true },
    timeTicks: { get: function () { return timeTicks; }, enumerable: true }
  });

  return api;
})();

window.Game = Game;
