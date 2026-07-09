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
//
// ---- Part II (ARCHITECTURE-MP.md §4.5): multiplayer additions ----
//
//   Game.startMultiplayer({welcome, skinRec}) -> Promise   Game.isMultiplayer
//
// Sibling entry point to start(): reuses the same one-time GPU bootstrap
// (factored into the private bootEngine() helper) and the same idempotent
// Input/HUD/Interact/Commands wiring, but sources the world from an
// already-resolved `welcome` payload (World.createRemote — no IndexedDB) and
// wires Net event handlers ('welcome' (reconnect rebuild — see applyWelcome)/
// 'join'/'leave'/'moves'/'block'/'chat'/'sys'/'mode'/'time'/'host'/'kick'/
// 'close') + world.onLocalEdit -> Net.send('block').
// Autosave/IDB writes are disabled in MP (guarded inside saveNow()); /regen
// and /setspawn are disabled with a toast+chat error (guarded inside regen()/
// api.setSpawn); /time and /gamemode route their network side-effects through
// api.setTime/setMode. Additionally consumes (guarded as optional, since they
// load after game.js in index.html): Net, RemotePlayers, Menu (for the
// kick/close toast).

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

  // ---- feel/polish tuning (Part III smoothness pass) ------------------------
  // All of these are frame-rate independent (exp-smoothed with dt) and kept
  // deliberately conservative -- polish, not a theme park.
  var EYE_EASE_RATE = 8;        // /s -- sneak eye-height ease toward its target
  var BOB_AMP_Y = 0.035;        // blocks -- first-person walk-bob vertical amp
  var BOB_AMP_X = 0.012;        // blocks -- walk-bob lateral sway amp (subtle)
  var BOB_SPEED_REF = 4.3;      // m/s of horizontal speed for full bob amp
                                //   (same reference the arm bob already uses)
  var SPRINT_FOV_BOOST = 8;     // deg -- added ON TOP of the user's /fov base
  var FOV_EASE_RATE = 6;        // /s -- sprint FOV kick ease in/out
  var CAM_DIST_EASE_RATE = 10;  // /s -- third-person boom distance ease
  var LAND_DIP_AMOUNT = 0.08;   // blocks -- camera dip depth after a real fall
  var LAND_DIP_SEC = 0.15;      // s -- landing dip duration
  var LAND_DIP_MIN_FALL = 2;    // blocks -- never dip on a 1-block step

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
  var exposure = 0.82;   // user-tunable brightness (Settings); <1 = darker than the old always-1.0 look
  var dev = false;

  var paused = false, dead = false;

  // ---- Part II (ARCHITECTURE-MP.md §4.5): multiplayer session state --------
  var isMultiplayer = false;
  var difficulty = 'normal';     // §6: peaceful|easy|normal|hard
  var keepInventory = false;     // §6: /gamerule keepInventory (vanilla default: false)
  var myNetId = null;             // welcome.youId — used to skip self-echoes
  var netHandlers = null;         // {type: fn} registered via Net.on, unwired on stop()
  var _moveState = {              // reused scratch object for Net.sendMove (no per-frame alloc)
    p: [0, 0, 0], yaw: 0, pitch: 0,
    anim: { swing: 0, crouch: false, fly: false }
  };

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

  // feel/polish trackers (smoothness pass): eased sneak eye height, eased
  // sprint FOV kick (deg, modulates AROUND fovDeg -- never written back to
  // it), eased third-person boom length, seconds since the last landing dip
  // started (large value = no dip playing).
  var currentEyeH = EYE_STAND, fovKick = 0;
  var camDistCur = THIRD_PERSON_DIST, landDipT = 1e9;

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

  // Must list EVERY #screen-* id, or showGameScreen() leaves a stale screen
  // .active on top of the game HUD. 'worlds' (the WorldSelect / "Play" + "Join
  // a Game" screen, added in Part II) was missing — so starting a world from
  // it left #screen-worlds rendered over the HUD, swallowing clicks and
  // blocking pointer lock (you couldn't walk). Keep this in sync with the
  // screen list in main.js and the #screen-* divs in index.html.
  var SCREENS = ['menu', 'game', 'studio', 'wardrobe', 'market', 'worlds'];

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
    // sprint FOV kick: fovKick eases toward SPRINT_FOV_BOOST/0 in frame() and
    // modulates around the user's /fov base -- fovDeg itself is never touched.
    var fovEff = fovDeg + fovKick;
    cam.fovDeg = fovEff; cam.aspect = aspect;
    var far = Math.max(96, (renderDist + 2) * 16 + 16);
    M3.mat4Perspective(proj, fovEff * Math.PI / 180, aspect, 0.05, far);
    M3.mat4LookDir(view, pos, dir, _up);
    M3.mat4Multiply(pv, proj, view);
  }

  // Computes eyeCam (always first-person, used for interaction rays) and
  // renderCam (respects player.perspective). Returns renderCam. dt drives the
  // exp-smoothed feel effects (sneak dip, walk bob, landing dip, boom ease) --
  // all of them touch renderCam ONLY, so eyeCam raycasts stay clean.
  function computeCameras(dt) {
    dt = dt || 0;
    // sneak dip: ease the eye height toward its target instead of snapping
    currentEyeH += (eyeHeight() - currentEyeH) * (1 - Math.exp(-EYE_EASE_RATE * dt));
    readVec(player.body.pos, _p);
    _eye[0] = _p[0]; _eye[1] = _p[1] + currentEyeH; _eye[2] = _p[2];
    lookDir(player.yaw, player.pitch, _dir);

    fillCam(eyeCam, _eye, player.yaw, player.pitch, _dir, _eView, _eProj, _ePv);

    var persp = player.perspective;
    if (persp === 0) {
      // first person: renderCam gets a subtle walk bob (on ground + moving
      // only, zero when flying/swimming, scaled by horizontal speed) plus the
      // brief landing dip -- eyeCam above is untouched by either.
      var bobY = 0, bobX = 0;
      readVec(player.body.vel, _v);
      var hs = Math.sqrt(_v[0] * _v[0] + _v[2] * _v[2]);
      if (player.body.onGround && !player.flying && !player.body.inWater && hs > 0.05) {
        var k = Math.min(1, hs / BOB_SPEED_REF);
        var ang = bobPhase * Math.PI * 2;
        bobY = Math.sin(ang * 2) * BOB_AMP_Y * k;
        bobX = Math.sin(ang) * BOB_AMP_X * k;
      }
      if (landDipT < LAND_DIP_SEC) {
        bobY -= Math.sin((landDipT / LAND_DIP_SEC) * Math.PI) * LAND_DIP_AMOUNT;
      }
      // lateral sway rides the camera-right axis (yaw only, stays horizontal)
      _camPos[0] = _eye[0] + Math.cos(player.yaw) * bobX;
      _camPos[1] = _eye[1] + bobY;
      _camPos[2] = _eye[2] - Math.sin(player.yaw) * bobX;
      fillCam(renderCam, _camPos, player.yaw, player.pitch, _dir, _view, _proj, _pv);
    } else if (persp === 1) {
      // behind the player, looking the same way (boom eased so wall pull-in
      // glides instead of popping; cameraDist's own 0.9 margin absorbs the
      // small transient overshoot while the ease catches up)
      _camDir[0] = -_dir[0]; _camDir[1] = -_dir[1]; _camDir[2] = -_dir[2];
      var d1 = cameraDist(_eye, _camDir, THIRD_PERSON_DIST);
      camDistCur += (d1 - camDistCur) * (1 - Math.exp(-CAM_DIST_EASE_RATE * dt));
      _camPos[0] = _eye[0] + _camDir[0] * camDistCur;
      _camPos[1] = _eye[1] + _camDir[1] * camDistCur;
      _camPos[2] = _eye[2] + _camDir[2] * camDistCur;
      fillCam(renderCam, _camPos, player.yaw, player.pitch, _dir, _view, _proj, _pv);
    } else {
      // in front of the player, looking back at it (same eased boom)
      var d2 = cameraDist(_eye, _dir, THIRD_PERSON_DIST);
      camDistCur += (d2 - camDistCur) * (1 - Math.exp(-CAM_DIST_EASE_RATE * dt));
      _camPos[0] = _eye[0] + _dir[0] * camDistCur;
      _camPos[1] = _eye[1] + _dir[1] * camDistCur;
      _camPos[2] = _eye[2] + _dir[2] * camDistCur;
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

  function die(cause) {
    if (dead) return;
    dead = true;
    player.health = 0;
    sfx('death');
    if (typeof Input !== 'undefined') {
      if (Input.setUIMode) Input.setUIMode(true);
      if (Input.exitPointerLock) Input.exitPointerLock();
    }
    HUD.showDeath(true, { onRespawn: function () { api.respawn(); }, cause: cause });
    saveNow();
  }

  // Part III (§5.2/§8): formats a death cause and kills the local player.
  // Two call sites feed this: (1) multiplayer, when a 'death' message for OUR
  // OWN player id arrives from the server (authoritative, whether the killer
  // was another player or a mob) even if local survivalTick hadn't
  // independently noticed hp<=0 yet -- `by` is the attacker's display name or
  // a mob-kind string per contract §5.1's death{id,by} shape; (2) solo/
  // offline, from Mobs.localTick's onPlayerDamage callback the instant local
  // health hits 0 (there is no server to report a death in solo mode) -- `by`
  // there is simply the local mob's kind string. Both format into one of the
  // three cause phrasings §8 asks for.
  function handleLocalDeath(by) {
    var cause;
    if (by) {
      var isMobName = ['zombie', 'pig'].indexOf(by) !== -1;
      cause = isMobName
        ? t('vox.death.byMob', 'Killed by a {mob}').replace('{mob}', t('vox.mob.' + by, by))
        : t('vox.death.byPlayer', 'Slain by {name}').replace('{name}', by);
    }
    dead = false; // let die() run its normal (idempotent, single-fire) path
    die(cause);
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
        // feel: a real fall (>= LAND_DIP_MIN_FALL blocks -- never a 1-block
        // step) kicks off the brief eased camera dip (see computeCameras)
        if (fallDist >= LAND_DIP_MIN_FALL) landDipT = 0;
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
    // Part II: broadcast the player's own gamemode so others render it correctly
    // (§3.3 'mode' — affects their rendering only, still client-authoritative).
    if (isMultiplayer && typeof Net !== 'undefined' && Net.isConnected) {
      try { Net.send('mode', { mode: m }); } catch (e) { /* connection hiccup — next echo self-heals */ }
    }
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
    Input.on('drop', function () {
      if (running && !paused && !dead && !uiBlocked()) dropSelected();
    });
  }

  // Part III (§10): drop ONE item from the selected hotbar slot. Solo: spawn
  // it directly via Drops.spawn (no server to ask). Multiplayer: send the
  // request and let the server's own 'dropSpawn' broadcast -- which reaches
  // every connected client INCLUDING us, per the existing house pattern
  // where an authoritative echo is how the sender itself sees its own action
  // take effect (mirrors how a 'block' edit is echoed back to its own
  // sender) -- actually create the visible drop; nothing is spawned
  // optimistically client-side in MP.
  function dropSelected() {
    if (!inv || !inv.hotbar) return;
    var stack = inv.hotbar[inv.selected];
    if (!stack || !stack.id) return;
    var one = { id: stack.id, count: 1, kind: stack.kind || 'block' };

    if (isMultiplayer) {
      if (typeof Net !== 'undefined' && Net.isConnected && Net.send) {
        Net.send('drop', { stack: one });
      } else {
        return; // no connection: nothing to do, do not consume the item
      }
    }

    // Consume from the hotbar in BOTH modes (in MP we don't wait for the
    // server's echo to decrement -- dropping your own held item is not a
    // contested resource the way a block edit or a pickup is, so there is
    // nothing meaningful to roll back if the send somehow fails after this
    // point; Net.send never throws synchronously per its own contract).
    // Routed through setHotbarSlot (not a direct array write) so it fires
    // inv's onChange the same way every other inventory mutation does --
    // the HUD hotbar redraw depends on that signal.
    if (stack.count > 1) {
      inv.setHotbarSlot(inv.selected, stack.id, stack.count - 1, stack.kind);
    } else {
      inv.setHotbarSlot(inv.selected, 0, 0);
    }

    if (!isMultiplayer && typeof Drops !== 'undefined' && Drops.spawn) {
      readVec(player.body.pos, _p);
      var fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
      Drops.spawn([_p[0] + fx * 0.6, _p[1] + eyeHeight() * 0.6, _p[2] + fz * 0.6], one);
    }
    sfx('drop');
  }

  function onCanvasClick() {
    if (running) resumePointerLock();
  }

  // ---- persistence -----------------------------------------------------------------------

  function saveNow() {
    if (!world) return Promise.resolve();
    if (isMultiplayer) return Promise.resolve();   // Part II: server owns persistence in MP — no IDB writes
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

  // ---- combat: entity-first raycast on press (§5.4) ------------------------
  //
  // Entities beat blocks under the crosshair (contract §5.4). This has to be
  // decided at the MOMENT of breakStart, not on release: Interact starts
  // acting on breakStart the instant it sees it (accruing break-progress that
  // same frame), so waiting for breakStop to decide "was this actually an
  // attack" would mean retroactively un-mining a block that was already
  // partway broken -- not possible. So: on every breakStart/tapBreakStart,
  // probe for an entity first; if one is under the crosshair, treat this
  // press as an attack (send/apply the hit right away) and strip that one
  // action so Interact never sees it and never starts a break-progress timer
  // for this press. Holding down on a mob keeps re-probing on each NEW
  // breakStart (there is only ever one per physical press), so repeated
  // clicks land repeated attacks exactly like Minecraft's own click-to-hit
  // feel -- rate limiting is Combat's own 120ms client debounce plus the
  // server's 350ms cooldown, not anything gated here. A press that finds no
  // entity falls through untouched, zero change to existing block breaking.
  function processCombatActions(actions) {
    if (typeof Combat === 'undefined') return actions;
    var out = actions;
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (a.type !== 'breakStart' && a.type !== 'tapBreakStart') continue;
      var hit = Combat.probe(eyeCam);
      if (!hit) continue;
      attackEntity(hit);
      out = out.filter(function (x) { return x !== a; });
    }
    return out;
  }

  // Resolves a Combat.probe() hit into an actual attack: sends the network
  // hit in multiplayer (server is authoritative -- no local damage applied,
  // matching Combat's own "never apply damage locally" design, see combat.js
  // header); in solo/offline there IS no server, so a mob hit is resolved
  // immediately against the local mob simulation via Mobs.localHit (the one
  // bridge Combat intentionally leaves for a caller to build, since it has no
  // way to know solo mode exists). A solo hit on a real player id can't occur
  // (Combat.setEntitySource never contributes RemotePlayers in solo mode).
  function attackEntity(hit) {
    if (isMultiplayer) {
      Combat.attemptHit(eyeCam, world);
      return;
    }
    if (hit.kind === 'mob' && typeof Mobs !== 'undefined' && Mobs.localHit) {
      var mobLocalId = String(hit.id).indexOf('mob:') === 0 ? hit.id.slice(4) : hit.id;
      var dmg = localAttackDamage();
      Mobs.localHit(mobLocalId, dmg);
      sfx('hit');
    }
  }

  // Damage dealt by the locally-selected weapon (solo PvE only -- multiplayer
  // damage is always server-computed, see attackEntity above). Fist = 1,
  // matching Items' own fist-less convention (Items has no "fist" entry; an
  // empty/non-sword selection just uses the bare-hands default here).
  function localAttackDamage() {
    if (!inv || !inv.hotbar) return 1;
    var stack = inv.hotbar[inv.selected];
    if (!stack || stack.kind !== 'item' || typeof Items === 'undefined') return 1;
    var def = Items.def(stack.id);
    return (def && typeof def.damage === 'number') ? def.damage : 1;
  }

  // Wires Combat once per session (idempotent-safe: Combat.init/setEntitySource
  // just overwrite module state, no leak from calling this twice across a
  // stop()->start() cycle). net: the real Net global in multiplayer, null
  // solo/offline -- Combat.init stores this SAME reference for both sending
  // ('hit' via netRef.send) and its own auto-wire of 6 incoming event types
  // (netRef.on('health'/'damage'/'death'/'mobSpawn'/'mobState'/'mobDespawn'),
  // there is no way to opt into one without the other, so wireNetHandlers()
  // below deliberately does NOT also register those 6 types -- Combat owns
  // that half of the incoming dispatch table entirely once init() has run
  // with a real net. localPlayerId: welcome.youId in MP, null solo (nothing
  // needs to self-filter when there ARE no remote players to filter out).
  function setupCombatSystems(net, localPlayerId) {
    if (typeof Combat === 'undefined') return;
    Combat.init({ net: net, hud: HUD, localPlayerId: localPlayerId });
    Combat.setEntitySource(function () {
      var list = [];
      if (isMultiplayer && typeof RemotePlayers !== 'undefined' && RemotePlayers.list) {
        list = list.concat(RemotePlayers.list());
      }
      if (typeof Mobs !== 'undefined' && Mobs.list) {
        // Mobs.list() reports kind as 'zombie'/'pig' (the mob's actual
        // species); Combat's entity-source shape wants the literal 'mob' so
        // it knows to id-prefix with 'mob:' (contract §5.1) rather than
        // treating the entry as a player. Remap here, at the one seam that
        // joins the two modules, rather than either module assuming the
        // other's convention.
        var mobs = Mobs.list();
        for (var i = 0; i < mobs.length; i++) {
          list.push({ id: mobs[i].id, pos: mobs[i].pos, kind: 'mob' });
        }
      }
      return list;
    });
  }

  // Part III (§10, MP branch): drops we've asked the server to let us pick
  // up, keyed by dropId -> the stack we'll grant ourselves once confirmed.
  // Cleared/repopulated is unnecessary -- an entry is removed the instant its
  // 'dropDespawn' arrives (see wireNetHandlers), and a drop that despawns for
  // an unrelated reason (another player grabbed it, or it timed out) just
  // leaves a harmless orphaned entry that is never looked up again.
  var pendingPickups = {};
  var PICKUP_REQUEST_RADIUS = 1.2;   // matches drops.js's own PICKUP_RADIUS / the Go server's pickupRadius
  var PICKUP_REQUEST_COOLDOWN_MS = 500; // don't spam pickup{} every frame while standing on an unconfirmed drop
  var _lastPickupRequestAt = Object.create(null);

  function requestNearbyPickups(playerPosArr) {
    var list = Drops.list();
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d || !d.pos || pendingPickups[d.id]) continue;
      var dx = d.pos[0] - playerPosArr[0], dy = d.pos[1] - playerPosArr[1], dz = d.pos[2] - playerPosArr[2];
      if ((dx * dx + dy * dy + dz * dz) > PICKUP_REQUEST_RADIUS * PICKUP_REQUEST_RADIUS) continue;
      var last = _lastPickupRequestAt[d.id] || -1e9;
      if (now - last < PICKUP_REQUEST_COOLDOWN_MS) continue;
      _lastPickupRequestAt[d.id] = now;
      pendingPickups[d.id] = d.stack;
      Net.send('pickup', { dropId: d.id });
    }
  }

  // Cheap per-point sky exposure for Mobs.localTick's spawn gate (§7: hostile
  // mobs need a dark/night spot, not broad daylight). Mesher computes a
  // proper per-vertex version of this internally but keeps it private to its
  // own chunk-meshing pass; this is the same "is the column open above y"
  // idea, just queried for one point via World's already-public heightAt().
  function skyExposureAt(x, y, z) {
    if (!world || !world.heightAt) return 1;
    return (world.heightAt(x, z) <= y) ? 1 : 0.55;
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

  // Part III (ARCHITECTURE-COMBAT.md §9): the currently-selected hotbar
  // stack's {id, kind} for held-item rendering, empty-hand-safe. Guards for
  // an inventory.js snapshot that predates §4's 'kind' field by defaulting
  // to 'block' -- matching that module's own stated backward-compat default
  // for numeric ids (every Part I/II stack id is numeric today).
  function selectedHeld() {
    if (!inv || !inv.hotbar) return { heldId: null, heldKind: null };
    var stack = inv.hotbar[inv.selected];
    if (!stack || stack.id == null || stack.id === 0) return { heldId: null, heldKind: null };
    return { heldId: stack.id, heldKind: stack.kind || 'block' };
  }

  function drawOwnPlayer(env) {
    readVec(player.body.pos, _p);
    var held = selectedHeld();
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
      camPos: renderCam.pos,
      heldId: held.heldId,
      heldKind: held.heldKind,
      armor: (inv && inv.armor) ? inv.armor : null
    });
  }

  function drawArm(env) {
    // ease-out (1-(1-t)^3) on the swing phase: the arm snaps out fast and
    // settles softly instead of ramping linearly. Combat.swingPhase() still
    // max-merges below, unchanged.
    var swing01 = 0;
    if (armSwingT < 0.3) {
      var st01 = 1 - armSwingT / 0.3;
      swing01 = 1 - st01 * st01 * st01;
    }
    if (typeof Combat !== 'undefined' && Combat.swingPhase) {
      var attackSwing = Combat.swingPhase();
      if (attackSwing > swing01) swing01 = attackSwing;
    }
    readVec(player.body.vel, _v);
    var hs = Math.sqrt(_v[0] * _v[0] + _v[2] * _v[2]);
    var bob = Math.sin(bobPhase * Math.PI * 2) * Math.min(1, hs / 4.3) *
              (player.body.onGround ? 1 : 0);
    var held = selectedHeld();
    PlayerModel.drawFirstPersonArm(gl, {
      skinTex: skinTex,
      model: skinModel,
      proj: renderCam.proj,
      swing01: swing01,
      bob: bob,
      light: playerLight(env),
      heldId: held.heldId,
      heldKind: held.heldKind
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

    // -- feel: sprint FOV kick target + landing-dip clock (smoothness pass) --
    var sprinting = active && !uiBlocked() && player.body &&
        Input.state && !!Input.state.sprint && Input.move.forward > 0 &&
        player.body.onGround && !player.body.inWater && !player.flying;
    fovKick += ((sprinting ? SPRINT_FOV_BOOST : 0) - fovKick) *
               (1 - Math.exp(-FOV_EASE_RATE * dt));
    if (landDipT < 1) landDipT += dt;   // 1 s cap: dip only lasts LAND_DIP_SEC

    // -- cameras (eyeCam for interaction, renderCam for drawing) --
    computeCameras(dt);

    // -- interaction --
    var actions = Input.consumeActions();
    if (active) actions = processCombatActions(actions);
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

    // -- Part III (§13a): pump the water-flow simulation. This was the
    // missing wiring that made water never flow: world.js owns the whole
    // liquid tick queue (queueLiquidTick fires automatically on block edits
    // near water) but only processes it when THIS budget call runs. Solo/
    // offline only: in multiplayer each client simulating liquids locally
    // would diverge (edits sync over the wire, tick timing doesn't), so MP
    // water stays static until a server-authoritative liquid pass exists.
    if (active && !isMultiplayer && world && world.processLiquidTicks) {
      world.processLiquidTicks(64);
    }

    // -- Part II: send our own move state, advance remote-player interpolation --
    if (isMultiplayer) {
      if (typeof Net !== 'undefined' && Net.isConnected && Net.sendMove) {
        readVec(player.body.pos, _moveState.p);
        _moveState.yaw = player.yaw;
        _moveState.pitch = player.pitch;
        _moveState.anim.swing = walkPhase;
        _moveState.anim.crouch = !player.flying && typeof Input !== 'undefined' && !!Input.state && !!Input.state.sneak;
        _moveState.anim.fly = !!player.flying;
        Net.sendMove(_moveState);
      }
      if (typeof RemotePlayers !== 'undefined' && RemotePlayers.update) RemotePlayers.update(dt);
    }

    // -- Part III (§7/§10): mobs + dropped items --------------------------------
    // Mobs.draw()/Drops.draw() fold BOTH rosters (server-synced + local-sim)
    // into one draw call each and are safe to call unconditionally every
    // frame (see their own draw() implementations) -- only the TICKING side
    // needs to branch on mode: MP mobs are server-authoritative (interpolate
    // toward the last mobState batch, never simulated client-side); solo/
    // offline mobs run their own lightweight AI locally since there is no
    // server to ask.
    //
    // Drops are subtler: the Go server (internal/rooms/drops.go) fixes a
    // drop's position once at spawn and never moves it again -- bob/spin/
    // gravity settling is explicitly a client-rendering-only concern there,
    // so Drops.update()'s local physics sim is safe to run in BOTH modes
    // (nothing server-side ever contests position). The one thing that DOES
    // need a mode split is GRANTING an item: Drops.checkPickup() applies
    // inventory.add() immediately and unconditionally, which is correct
    // solo (no server to ask) but would let a client hand itself items with
    // zero server validation in MP. So in MP we do our own proximity check
    // via Drops.list() and send pickup{dropId} instead of calling
    // checkPickup() at all; the actual inventory.add() only happens once the
    // server confirms via a 'dropDespawn' echo for a drop we ourselves
    // requested (see wireNetHandlers' dropDespawn entry and pendingPickups).
    if (active) {
      readVec(player.body.pos, _p);
      if (typeof Drops !== 'undefined' && Drops.update) Drops.update(dt, world);
      if (isMultiplayer) {
        if (typeof Mobs !== 'undefined' && Mobs.update) Mobs.update(dt);
        if (typeof Drops !== 'undefined' && Drops.list && typeof Net !== 'undefined' && Net.isConnected) {
          requestNearbyPickups(_p);
        }
      } else {
        if (typeof Mobs !== 'undefined' && Mobs.localTick) {
          Mobs.localTick(dt, world, null, _p, {
            skyExposure: skyExposureAt,
            timeTicks: timeTicks,
            difficulty: difficulty,
            onPlayerDamage: function (amount, mobKind) {
              damage(amount * 2); // damage() takes half-hearts; mob dmg is whole hearts
              if (player.health <= 0) handleLocalDeath(mobKind);
            }
          });
        }
        if (typeof Drops !== 'undefined' && Drops.checkPickup && inv) Drops.checkPickup(_p, inv);
      }
    }

    // -- render (pass order pinned in §5.15/§5.16) --
    var env = Renderer.computeEnv(timeTicks, renderDist);
    var under = eyeUnderwater();
    env.underwater = under;
    Renderer.beginFrame(renderCam, env);
    Renderer.drawSky(env, renderCam);
    Renderer.drawChunks(renderCam, env, 'opaque');
    if (player.perspective !== 0 && skinTex) drawOwnPlayer(env);
    Renderer.drawSelection(renderCam, interactSys ? interactSys.target : null);
    if (isMultiplayer && typeof RemotePlayers !== 'undefined' && RemotePlayers.draw) {
      RemotePlayers.draw(gl, renderCam, env);
    }
    // Part III (§7/§10): unconditional, unlike RemotePlayers -- both Mobs and
    // Drops fold their local-sim/local-drop roster into the SAME draw() call
    // as their server-synced one, so this renders correctly in solo AND
    // multiplayer without a mode check here (the mode branch that matters is
    // in the TICKING code above, not drawing).
    if (typeof Mobs !== 'undefined' && Mobs.draw) Mobs.draw(gl, renderCam, env);
    if (typeof Drops !== 'undefined' && Drops.draw) Drops.draw(gl, renderCam, env);
    Renderer.drawChunks(renderCam, env, 'translucent');
    Renderer.drawClouds(env, renderCam, nowMs);
    if (player.perspective === 0 && skinTex && active && !uiBlocked()) drawArm(env);
    Renderer.endFrame({
      lutAmount: lutAmount,
      exposure: exposure,
      vibrance: 0.18,
      gamma: 1.0,
      underwater: under,
      vignette: 0.15
    });

    if (isMultiplayer && typeof RemotePlayers !== 'undefined' && RemotePlayers.nametags) {
      RemotePlayers.nametags(renderCam, hudRoot);
    }

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
    exposure = clamp((typeof s.exp === 'number' ? s.exp : 82) / 100, 0.5, 1.3);
  }

  // GPU-side one-time boot shared by start() and startMultiplayer() (Part II):
  // atlas + LUT texture + Renderer/PlayerModel init are identical regardless
  // of where the world data comes from. Returns the atlas (HUD.init wants it
  // for hotbar icon drawing).
  function bootEngine(glCtx) {
    var atlas = Blocks.buildAtlas(glCtx);
    var lutTex = LUT.texture(glCtx);
    Renderer.init(glCtx, { atlas: atlas, lutTex: lutTex });
    // Part III (ARCHITECTURE-COMBAT.md §9): PlayerModel reuses this SAME
    // atlas texture (no new upload) to texture held-block meshes -- pass it
    // through as an additive, optional init() field.
    PlayerModel.init(glCtx, { atlasTex: atlas.tex });
    // Part III (§7/§10): Mobs/Drops render in BOTH solo and multiplayer (each
    // module folds its local-sim/local-drop roster into the same draw() path
    // as its server-synced one), so -- unlike RemotePlayers, which is MP-only
    // and initialized inside startMultiplayer() -- these belong in the shared
    // one-time GPU bootstrap so solo play gets them too.
    if (typeof Mobs !== 'undefined' && Mobs.init) Mobs.init(glCtx);
    if (typeof Drops !== 'undefined' && Drops.init) Drops.init(glCtx);
    return atlas;
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

    // GPU-side one-offs (shared with startMultiplayer via bootEngine)
    var atlas = bootEngine(gl);

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
      setupCombatSystems(null, null); // solo/offline: no server, Combat never sends a network hit

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
      currentEyeH = EYE_STAND; fovKick = 0;
      camDistCur = THIRD_PERSON_DIST; landDipT = 1e9;
      running = true;
      starting = false;
      rafId = requestAnimationFrame(frame);
    }).catch(function (e) {
      starting = false;
      throw e;
    });
  }

  // ---- Part II (ARCHITECTURE-MP.md §4.5): multiplayer entry point ----------
  //
  // Sibling to start(): same GL/engine/input/HUD bootstrap (bootEngine +
  // Input.init/wireInputEvents/HUD.init/Interact.create/Commands.init are
  // reused verbatim — those are already idempotent, mode-agnostic shared
  // helpers), but the world comes from an already-resolved `welcome` (the
  // caller — WorldSelect — already did Store.roomsOpen -> Net.connect and is
  // handing us the resolved welcome payload + the resolved skin to wear) and
  // everything is synchronous (no IndexedDB probing, no saved-meta merge).

  // Shared consumer of a 'welcome' payload's room state — everything that
  // must be applied BOTH on the initial connect (startMultiplayer below) and
  // again when Net's single auto-reconnect succeeds and re-emits 'welcome'
  // (net.js §4.1). The server treats a reconnect as a brand-new join
  // (tryJoin assigns a fresh player id, builds a fresh roster, snapshots ALL
  // deltas), so everything keyed on the old id or drifted during the gap is
  // rebuilt here. World identity (seed/name/spawn) is deliberately NOT here:
  // it is immutable for the life of a session — a reconnect rejoins the same
  // world, and only startMultiplayer() ever creates one.
  function applyWelcome(welcome) {
    welcome = welcome || {};
    var wWorld = welcome.world || {};

    // Our id is reassigned by every (re)join; every self-echo filter (the
    // join/leave/moves/mode handlers below, Combat's self-hit exclusion and
    // health/death routing) keys off it.
    if (welcome.youId != null) myNetId = welcome.youId;
    if (typeof Combat !== 'undefined' && Combat.setLocalPlayerId) Combat.setLocalPlayerId(myNetId);

    // Full roster replace: anyone who left while we were gone falls out, and
    // on a reconnect so does the ghost of our own OLD player id.
    if (typeof RemotePlayers !== 'undefined' && RemotePlayers.sync) {
      var others = Array.isArray(welcome.players)
        ? welcome.players.filter(function (p) { return p && p.id !== myNetId; })
        : [];
      RemotePlayers.sync(others);
    }

    // Server-authoritative block state. On the initial connect
    // World.createRemote already consumed this same snapshot, making this an
    // idempotent no-op; on a reconnect it replays every server-known cell
    // (only genuinely changed blocks dirty meshes — see world.js).
    if (world && world.applyRemoteDeltas) world.applyRemoteDeltas(welcome.deltas);

    if (typeof wWorld.time === 'number') applyTimeLocal(wWorld.time);
    if (typeof welcome.difficulty === 'string') applyDifficultyLocal(welcome.difficulty);
    if (typeof welcome.keepInventory === 'boolean') applyKeepInventoryLocal(!!welcome.keepInventory);

    // Mob/drop sets rebuild exactly like a fresh joiner's: the server sends
    // no entity snapshot in welcome (welcome.mobs is forward-compat only) and
    // mobState batches drop unknown ids, so whatever the gap made stale would
    // otherwise linger as ghosts the server will never despawn for us.
    if (typeof Mobs !== 'undefined' && Mobs.sync) Mobs.sync(welcome.mobs);
    if (typeof Drops !== 'undefined' && Drops.clear) Drops.clear();
  }

  // Net.on(type, fn) handlers, wired once per startMultiplayer() call and
  // unwired symmetrically in stop(). Kept as named functions on `netHandlers`
  // so unwireNetHandlers() can pass the exact same reference to Net.off().
  function wireNetHandlers() {
    if (typeof Net === 'undefined' || !Net.on) return;
    netHandlers = {
      welcome: function (msg) {
        // Only ever fires when net.js's single auto-reconnect succeeds — the
        // INITIAL welcome resolves connect()'s Promise instead of emitting
        // (see net.js). The server treated the reconnect as a brand-new join,
        // so rebuild everything the disconnect gap could have drifted.
        if (!msg) return;
        applyWelcome(msg);
        // The reconnect hello re-sent our ORIGINAL requested gamemode (Net
        // kept its connect params); if /gamemode changed it mid-session,
        // re-assert the current one so the server and other players agree.
        if (typeof Net !== 'undefined' && Net.isConnected) Net.send('mode', { mode: mode });
        HUD.chatPrint(t('mp.chat.reconnected', 'Reconnected to the server'), 'sys');
      },
      join: function (msg) {
        if (msg && msg.player && msg.player.id !== myNetId && typeof RemotePlayers !== 'undefined') {
          RemotePlayers.add(msg.player);
        }
      },
      leave: function (msg) {
        if (msg && msg.id !== myNetId && typeof RemotePlayers !== 'undefined') {
          RemotePlayers.remove(msg.id);
        }
      },
      moves: function (msg) {
        if (!msg || !msg.m || typeof RemotePlayers === 'undefined') return;
        var batch = msg.m.filter(function (row) { return row && row[0] !== myNetId; });
        RemotePlayers.applyMoves(batch);
      },
      block: function (msg) {
        if (msg && world) world.setBlockSilent(msg.x, msg.y, msg.z, msg.id);
      },
      chat: function (msg) {
        if (msg) HUD.chatPrint('<' + msg.from + '> ' + msg.text);
      },
      sys: function (msg) {
        if (msg) HUD.chatPrint(msg.text, msg.cls || 'sys');
      },
      mode: function (msg) {
        if (msg && msg.id !== myNetId && typeof RemotePlayers !== 'undefined' && RemotePlayers.setMode) {
          RemotePlayers.setMode(msg.id, msg.mode);
        }
      },
      time: function (msg) {
        if (msg && typeof msg.ticks === 'number') applyTimeLocal(msg.ticks);
      },
      host: function (msg) {
        if (msg && msg.name) {
          HUD.chatPrint(t('mp.chat.newHost', '{name} is now the host').replace('{name}', msg.name), 'sys');
        }
      },
      kick: function (msg) {
        var reason = (msg && msg.reason) || t('mp.err.kicked', 'You were disconnected from the server');
        stop();
        if (typeof Menu !== 'undefined' && Menu.toast) Menu.toast(reason, 'danger');
      },
      close: function (msg) {
        stop();
        if (typeof Menu !== 'undefined' && Menu.toast) {
          Menu.toast((msg && msg.reason) || t('mp.err.disconnected', 'Disconnected from the server'), 'warn');
        }
      },
      // health/damage/death/mobSpawn/mobState/mobDespawn are NOT listed here:
      // Combat.init() (see setupCombatSystems) auto-registers its own
      // Net.on(...) for the first three, and adding them a second time here
      // would double-fire every health/damage/death event. mobSpawn/mobState/
      // mobDespawn route through Combat's own onMobSpawn/onMobState/
      // onMobDespawn pub-sub below instead of a second raw Net.on, for the
      // same one-dispatch-path-per-message-type reason.
      difficulty: function (msg) {
        if (msg && typeof msg.value === 'string') applyDifficultyLocal(msg.value);
      },
      gamerule: function (msg) {
        if (msg && msg.rule === 'keepInventory') applyKeepInventoryLocal(!!msg.value);
      },
      dropSpawn: function (msg) {
        if (msg && msg.id != null && typeof Drops !== 'undefined' && Drops.serverSpawn) {
          Drops.serverSpawn(msg);
        }
      },
      dropDespawn: function (msg) {
        if (!msg || msg.id == null) return;
        // If WE requested this pickup (see requestNearbyPickups), the server
        // confirming its despawn IS the authorization to actually grant the
        // item -- this is the second half of the two-phase pickup flow (§10/
        // §11's server-authoritative trust posture: the server validates
        // proximity, we trust ourselves for inventory space, matching
        // internal/rooms/drops.go's own documented design). A despawn for a
        // drop we never asked for (another player grabbed it, or it timed
        // out) just removes it visually, same as always.
        var stack = pendingPickups[msg.id];
        if (stack && inv && inv.add) {
          inv.add(stack.id, stack.count);
          delete pendingPickups[msg.id];
          sfx('pickup');
        }
        if (typeof Drops !== 'undefined' && Drops.serverDespawn) Drops.serverDespawn(msg.id);
      }
    };
    if (typeof Combat !== 'undefined') {
      // Wire mob lifecycle through Combat's already-established pub-sub
      // (Combat.handleMobSpawn/etc. were already invoked once by Combat's
      // OWN auto-wire per setupCombatSystems' comment above; onMobSpawn here
      // is a SEPARATE listener list Combat exposes precisely so callers can
      // still react to the same events without re-subscribing to Net
      // directly -- see combat.js's onMobSpawn/onMobState/onMobDespawn).
      if (Combat.onMobSpawn) Combat.onMobSpawn(function (msg) {
        if (msg && typeof Mobs !== 'undefined' && Mobs.spawn) Mobs.spawn(msg);
      });
      if (Combat.onMobState) Combat.onMobState(function (msg) {
        // Wire payload is {m:[[id,x,y,z,yaw,hp,anim],...]}; Mobs.applyState
        // wants the raw array, not the wrapper object.
        if (msg && msg.m && typeof Mobs !== 'undefined' && Mobs.applyState) Mobs.applyState(msg.m);
      });
      if (Combat.onMobDespawn) Combat.onMobDespawn(function (msg) {
        if (msg && msg.id != null && typeof Mobs !== 'undefined' && Mobs.despawn) Mobs.despawn(msg.id);
      });
      if (Combat.onDeath) Combat.onDeath(function (msg) {
        if (msg && msg.id === myNetId) handleLocalDeath(msg.by);
      });
    }
    for (var type in netHandlers) {
      if (Object.prototype.hasOwnProperty.call(netHandlers, type)) Net.on(type, netHandlers[type]);
    }
  }

  function unwireNetHandlers() {
    if (!netHandlers || typeof Net === 'undefined' || !Net.off) { netHandlers = null; return; }
    for (var type in netHandlers) {
      if (Object.prototype.hasOwnProperty.call(netHandlers, type)) Net.off(type, netHandlers[type]);
    }
    netHandlers = null;
  }

  function startMultiplayer(opts) {
    opts = opts || {};
    if (running || starting) return Promise.resolve();
    starting = true;

    try {
      var welcome = opts.welcome || {};
      var wWorld = welcome.world || {};

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

      // GPU-side one-offs (shared with start() via bootEngine)
      var atlas = bootEngine(gl);
      if (typeof RemotePlayers !== 'undefined' && RemotePlayers.init) RemotePlayers.init(gl);

      // skin: whatever the caller already resolved (App.skin, typically)
      setSkinInternal(opts.skinRec || (typeof App !== 'undefined' ? App.skin : null));

      // world: server-authoritative, generated from seed + the welcome deltas
      seed = (typeof wWorld.seed === 'number') ? (wWorld.seed | 0) : 0;
      world = World.createRemote({ seed: seed, name: wWorld.name || welcome.roomId || 'remote', deltas: welcome.deltas });
      gen = world.gen;

      // own mode: whatever the server accepted at hello time (see our entry
      // in welcome.players), defaulting to survival if not found.
      mode = 'survival';
      var myEntry = null;
      if (Array.isArray(welcome.players)) {
        for (var i = 0; i < welcome.players.length; i++) {
          if (welcome.players[i] && welcome.players[i].id === welcome.youId) { myEntry = welcome.players[i]; break; }
        }
      }
      if (myEntry && (myEntry.mode === 'survival' || myEntry.mode === 'creative')) mode = myEntry.mode;

      timeTicks = (typeof wWorld.time === 'number') ? ((wWorld.time % DAY_TICKS) + DAY_TICKS) % DAY_TICKS : 0;

      if (Array.isArray(wWorld.spawn) && wWorld.spawn.length === 3) {
        player.spawn = wWorld.spawn.slice();
      } else {
        player.spawn = [0.5, (gen && gen.surfaceHeight ? gen.surfaceHeight(0, 0) : 68) + 2, 0.5];
      }
      var startPos = player.spawn;
      pregenAround(startPos[0], startPos[2]);

      player.body = Physics.createBody({ x: startPos[0], y: startPos[1], z: startPos[2] });
      player.yaw = (myEntry && typeof myEntry.yaw === 'number') ? myEntry.yaw : 0;
      player.pitch = (myEntry && typeof myEntry.pitch === 'number') ? myEntry.pitch : 0;
      player.health = 20;
      player.air = 10;
      player.flying = false;
      player.speedMult = 1;
      player.perspective = 0;

      inv = Inventory.create(mode);
      if (mode === 'creative') inv.setCreativeDefaults();
      else inv.setSurvivalDefaults();

      // input / hud / interact / commands (Input listeners installed once —
      // exactly the same shared, idempotent bootstrap as solo start())
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
      // isMultiplayer/myNetId aren't assigned until just below this block, so
      // welcome.youId (already resolved, right here in scope) is passed
      // explicitly rather than read back off module state.
      setupCombatSystems((typeof Net !== 'undefined') ? Net : null, welcome.youId);

      canvas.removeEventListener('click', onCanvasClick);
      canvas.addEventListener('click', onCanvasClick);

      if (dev) window.__vox = { Game: api, World: world };

      // ---- multiplayer-only wiring ----
      isMultiplayer = true;
      // myNetId, roster sync, time/difficulty/keepInventory, mob/drop reset —
      // shared with the reconnect re-'welcome' handler (see applyWelcome).
      applyWelcome(welcome);

      // forward every LOCAL (non-silent) block edit to the server; the
      // server's authoritative echo comes back through the 'block' handler
      // above and applies via setBlockSilent (no loop — see world.js).
      world.onLocalEdit(function (x, y, z, id) {
        if (isMultiplayer && typeof Net !== 'undefined' && Net.isConnected) {
          try { Net.send('block', { x: x, y: y, z: z, id: id }); } catch (e) { /* connection hiccup */ }
        }
      });

      wireNetHandlers();

      if (typeof Input !== 'undefined' && !Input.isTouch) {
        HUD.chatPrint(t('vox.chat.hint', 'Press T to chat, / for commands, F3 for debug'), 'sys');
      }
      HUD.chatPrint(t('mp.chat.connected', 'Connected to {world}').replace('{world}', wWorld.name || t('mp.world.unnamed', 'the world')), 'sys');

      // reset loop state and go (identical to start()'s reset block)
      paused = false; dead = false;
      physAcc = 0; lastMs = 0; frameNo = 0;
      fpsFrames = 0; fpsTime = 0; fpsVal = 0;
      lastW = 0; lastH = 0; lastDpr = 0;
      fallDist = 0; wasOnGround = true; drownAcc = 0; regenAcc = 0;
      lastDamageMs = -1e9; armSwingT = 99; wasBreaking = false;
      currentEyeH = EYE_STAND; fovKick = 0;
      camDistCur = THIRD_PERSON_DIST; landDipT = 1e9;
      running = true;
      starting = false;
      rafId = requestAnimationFrame(frame);
      return Promise.resolve();
    } catch (e) {
      starting = false;
      isMultiplayer = false;
      return Promise.reject(e);
    }
  }

  function stop() {
    if (!running && !starting) return;
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(autosaveId);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    saveNow();

    // Part II: leave the room + drop remote-player GL resources before the
    // context itself goes away (Renderer.destroyAll() below).
    if (isMultiplayer) {
      unwireNetHandlers();
      if (typeof Net !== 'undefined' && Net.disconnect) {
        try { Net.disconnect(); } catch (e) { /* already gone */ }
      }
      if (typeof RemotePlayers !== 'undefined' && RemotePlayers.destroy) {
        try { RemotePlayers.destroy(); } catch (e) { /* ignore */ }
      }
      isMultiplayer = false;
      myNetId = null;
    }

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
    if (isMultiplayer) {
      HUD.toast(t('mp.err.regenDisabled', 'World regen is disabled in multiplayer'));
      return Promise.reject(new Error(t('mp.err.regenDisabled', 'World regen is disabled in multiplayer')));
    }
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

  // Local time mutation only — never re-forwards to the network. This is the
  // function the Part II Net 'time' handler calls to apply the server's
  // authoritative tick (see wireNetHandlers below); api.setTime (below) is the
  // command-facing entry point that forwards instead of mutating when in MP.
  function applyTimeLocal(tv) {
    timeTicks = ((tv % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
  }

  // Local-only mutation for /difficulty and /gamerule keepInventory (§6),
  // mirroring applyTimeLocal's split: this is what the incoming Net
  // 'difficulty'/'gamerule' handlers call to apply the host's authoritative
  // value; api.setDifficulty/setKeepInventory (below) are the command-facing
  // entry points that forward instead of mutating when in MP.
  function applyDifficultyLocal(d) {
    difficulty = d;
    // Mobs.localTick (solo/offline mode) reads the current `difficulty` value
    // via its own opts.difficulty argument every tick and clears hostiles
    // itself the instant it sees "peaceful" (contract §7) -- no separate
    // despawn call is needed here, see stepMobsLocal()/wireNetHandlers below.
  }
  function applyKeepInventoryLocal(kv) {
    keepInventory = !!kv;
  }

  // ---- public API --------------------------------------------------------------------------------

  var api = {
    start: start,
    startMultiplayer: startMultiplayer,
    stop: stop,
    setMode: setMode,

    setTime: function (tv) {
      // Part II (§4.5): the /time command routes through the network when
      // connected (host-only server-side; a non-host gets an 'error' event
      // back and nothing changes locally until/unless the host actually sets
      // it — the periodic 'time' broadcast then applies via applyTimeLocal).
      if (isMultiplayer && typeof Net !== 'undefined' && Net.isConnected) {
        Net.send('time', { set: ((tv % DAY_TICKS) + DAY_TICKS) % DAY_TICKS });
        return;
      }
      applyTimeLocal(tv);
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
      // §5.1: tell the server we're back so its authoritative hp resets too
      // (it broadcast our 'death' and is otherwise still holding us at 0 hp).
      if (isMultiplayer && typeof Net !== 'undefined' && Net.isConnected && Net.send) {
        Net.send('respawn', {});
      }
    },

    setSpawn: function (x, y, z) {
      // Part II (§4.5): disabled in multiplayer (v1 does not build the
      // host-writes-world-settings path) — surface it loudly since the
      // command itself (owned by commands.js) always prints a success line.
      if (isMultiplayer) {
        HUD.toast(t('mp.err.setspawnDisabled', 'Spawn changes are disabled in multiplayer'));
        HUD.chatPrint(t('mp.err.setspawnDisabled', 'Spawn changes are disabled in multiplayer'), 'err');
        return;
      }
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
    setExposure: function (e) {
      exposure = clamp(+e || 0.82, 0.5, 1.3);
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
    timeTicks: { get: function () { return timeTicks; }, enumerable: true },
    isMultiplayer: { get: function () { return isMultiplayer; }, enumerable: true }
  });

  return api;
})();

window.Game = Game;
