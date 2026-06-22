// render.js — 8-bit canvas renderer for "Tux Smash Royale". Single global:
// Render. Owns NO game logic; it draws an (interpolated) SNAPSHOT each frame.
//
// Render.init(canvas)               one-time setup of the 2D context + sizing.
// Render.drawFrame(state, localId)  draw one frame of the given snapshot.
//
// The world is a 1000x1000 abstract space (matches the Go simulation):
//   SMASH : a centered platform [250..750] surrounded by void, with a danger
//           edge; ring-out elimination; damage% amplifies knockback.
//   ROYALE: an enclosed arena (40px wall margin) + the shrinking minty Menthol
//           Zone circle + a BSOD storm outside it.
// The square world is letterboxed (uniform scale, centered) into the canvas.
//
// Snapshot shape consumed (see Go protocol):
//   { t, mode:'smash'|'royale', alive, winner,
//     players:[{id,nickname,character,x,y,hp,damage,facing,alive,boost,windowsUntil}],
//     projectiles:[{x,y,kind}], pickups:[{x,y,kind}], zone:{cx,cy,r} }

var Render = (function () {
  'use strict';

  // World geometry — MUST match clobi/internal/game/game.go.
  var WORLD = 1000;
  var PLAT_L = 250, PLAT_T = 250, PLAT_R = 750, PLAT_B = 750;
  var ARENA_MARGIN = 40;

  // Side-view Smash stage — MUST match smashPlatforms + blast bounds in game.go.
  var SMASH_PLATFORMS = [
    { x0: 300, x1: 700, y: 640 },
    { x0: 215, x1: 375, y: 500 },
    { x0: 625, x1: 785, y: 500 },
    { x0: 430, x1: 570, y: 375 }
  ];
  var SMASH_BLAST = { l: 55, r: 945, t: 40, b: 965 };

  // Royale follow-camera: world units visible across the smaller canvas axis.
  var ROYALE_VIEW = 1300;
  function clampv(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 8-bit NES-like palette + theme accents from the style guide.
  var COL = {
    void: '#0c0d16',     // deep void around the smash platform
    bg: '#1a1d2e',       // dark slate background
    tileA: '#222641',
    tileB: '#1c2038',
    grid: '#2c3157',
    platTop: '#2b3157',
    platEdge: '#39406b', // platform / wall border
    mint: '#7ff9e0',     // Fisherman's minty cyan
    orange: '#ff9e2c',   // penguin orange
    winBlue: '#2b5fff',  // villain Windows blue
    danger: '#ff4d5e',
    white: '#fdfdfd',
    black: '#11131c',
    panel: '#11131c',
    panelEdge: '#0a0b12',
    panelText: '#cfe9ff',
    hpGood: '#9cff5a',
    hpMid: '#fff27f',
    hpLow: '#ff4d5e'
  };
  COL.platLip = '#161a2e';

  var canvas = null;
  var ctx = null;
  var viewW = 0, viewH = 0; // CSS pixel size of the canvas
  var dpr = 1;

  // ---- setup ---------------------------------------------------------------

  function init(c) {
    canvas = c;
    ctx = canvas.getContext('2d');
    window.addEventListener('resize', resize);
    resize();
  }

  function resize() {
    if (!canvas) { return; }
    dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    var rect = canvas.getBoundingClientRect();
    viewW = Math.max(1, Math.floor(rect.width || canvas.clientWidth || 800));
    viewH = Math.max(1, Math.floor(rect.height || canvas.clientHeight || 600));
    canvas.width = viewW * dpr;
    canvas.height = viewH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false; // crisp pixels
  }

  // Re-measure each frame so the canvas tracks its CSS box even if it was hidden
  // (size 0 -> fallback) at init time. Fixes the "tiny screen" on the first match.
  function maybeResize() {
    if (!canvas) { return; }
    var rect = canvas.getBoundingClientRect();
    var w = Math.floor(rect.width || canvas.clientWidth || 0);
    var h = Math.floor(rect.height || canvas.clientHeight || 0);
    if (w < 2 || h < 2) { return; } // not visible yet; keep last good size
    if (w !== viewW || h !== viewH ||
        canvas.width !== w * dpr || canvas.height !== h * dpr) {
      resize();
    }
  }

  // camera: uniform fit of a world window into the view, centered. Smash frames
  // a tighter window around the stage so fighters read bigger; royale shows the
  // whole arena.
  function camera(mode, state, local) {
    if (mode === 'smash') {
      var ss = Math.min(viewW, viewH) / 860;
      return { s: ss, ox: viewW / 2 - 500 * ss, oy: viewH / 2 - 510 * ss };
    }
    // Royale: follow-cam centered on the local fighter, clamped to the world.
    var W = (state && state.w) || WORLD;
    var H = (state && state.h) || WORLD;
    var s = Math.min(viewW, viewH) / ROYALE_VIEW;
    var halfW = viewW / 2 / s, halfH = viewH / 2 / s;
    var camX = local ? local.x : W / 2;
    var camY = local ? local.y : H / 2;
    camX = (W <= 2 * halfW) ? W / 2 : clampv(camX, halfW, W - halfW);
    camY = (H <= 2 * halfH) ? H / 2 : clampv(camY, halfH, H - halfH);
    return { s: s, ox: viewW / 2 - camX * s, oy: viewH / 2 - camY * s };
  }

  function wx(cam, x) { return cam.ox + x * cam.s; }
  function wy(cam, y) { return cam.oy + y * cam.s; }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  // ---- main draw -----------------------------------------------------------

  function drawFrame(state, localPlayerId) {
    if (!ctx) { return; }
    maybeResize();
    var t = nowMs();
    var mode = (state && state.mode) || 'smash';

    // Clear to background.
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, viewW, viewH);

    if (!state) { return; }
    var players = state.players || [];
    var local = findById(players, localPlayerId);
    var cam = camera(mode, state, local);

    if (mode === 'royale') {
      drawTownArena(cam, state, t);
      drawStorm(cam, state, state.zone, t);
      drawZoneEdge(cam, state.zone, t);
    } else {
      drawSmashArena(cam, t);
    }

    drawPickups(cam, state.pickups || [], t);
    drawProjectiles(cam, state.projectiles || [], t);
    drawCharacters(cam, players, localPlayerId, t);
    drawNameplates(cam, players, mode);

    drawHud(state, local, players, mode, t);
  }

  // ---- SMASH arena: platform + void + danger edge --------------------------

  function drawSmashArena(cam, t) {
    // Void fill behind the floating stage.
    ctx.fillStyle = COL.void;
    ctx.fillRect(0, 0, viewW, viewH);

    // Pulsing blast-zone frame (KO bounds): dashed danger rectangle.
    var pulse = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t / 260));
    var bl = wx(cam, SMASH_BLAST.l), br = wx(cam, SMASH_BLAST.r);
    var bt = wy(cam, SMASH_BLAST.t), bb = wy(cam, SMASH_BLAST.b);
    ctx.strokeStyle = withAlpha(COL.danger, pulse);
    ctx.lineWidth = Math.max(2, 3 * cam.s);
    var dash = Math.max(6, 12 * cam.s);
    ctx.setLineDash([dash, dash]);
    ctx.strokeRect(bl, bt, br - bl, bb - bt);
    ctx.setLineDash([]);

    // Platforms (chunky 8-bit ledges; index 0 = main stage).
    for (var i = 0; i < SMASH_PLATFORMS.length; i++) {
      var pf = SMASH_PLATFORMS[i];
      var px0 = wx(cam, pf.x0), px1 = wx(cam, pf.x1), py = wy(cam, pf.y);
      var w = px1 - px0;
      var thick = Math.max(8, 22 * cam.s);
      // Drop shadow.
      ctx.fillStyle = COL.platLip;
      ctx.fillRect(Math.round(px0), Math.round(py + 4), Math.round(w), Math.round(thick));
      // Body.
      ctx.fillStyle = (i === 0) ? COL.platTop : '#2a3157';
      ctx.fillRect(Math.round(px0), Math.round(py), Math.round(w), Math.round(thick));
      // Mint top edge (the standable surface).
      ctx.fillStyle = COL.mint;
      ctx.fillRect(Math.round(px0), Math.round(py), Math.round(w), Math.max(2, 3 * cam.s));
      // Border.
      strokeRectPx(px0, py, w, thick, Math.max(2, 3 * cam.s), COL.platEdge);
    }
  }

  // ---- ROYALE: procedural Luxembourg town (follow-cam) ---------------------

  function drawTownArena(cam, state, t) {
    var W = (state && state.w) || WORLD, H = (state && state.h) || WORLD;
    // Void outside the world.
    ctx.fillStyle = COL.void;
    ctx.fillRect(0, 0, viewW, viewH);
    var X0 = wx(cam, 0), Y0 = wy(cam, 0), X1 = wx(cam, W), Y1 = wy(cam, H);
    // Ground (grass / plaza).
    ctx.fillStyle = '#33402e';
    ctx.fillRect(Math.round(X0), Math.round(Y0), Math.round(X1 - X0), Math.round(Y1 - Y0));
    // Asphalt street bands on the block grid (matches the server's town pitch).
    ctx.fillStyle = '#2b2d36';
    var pitch = 360, sw = 96;
    for (var gx = 80; gx < W; gx += pitch) {
      ctx.fillRect(Math.round(wx(cam, gx - sw)), Math.round(Y0),
        Math.ceil(sw * cam.s), Math.round(Y1 - Y0));
    }
    for (var gy = 80; gy < H; gy += pitch) {
      ctx.fillRect(Math.round(X0), Math.round(wy(cam, gy - sw)),
        Math.round(X1 - X0), Math.ceil(sw * cam.s));
    }
    // World boundary wall.
    strokeRectPx(X0, Y0, X1 - X0, Y1 - Y0, Math.max(3, 6 * cam.s), COL.platEdge);

    // Obstacles (culled to the viewport).
    var obs = (state && state.obstacles) || [];
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      var ox = wx(cam, o.x), oy = wy(cam, o.y), ow = o.w * cam.s, oh = o.h * cam.s;
      if (ox > viewW || oy > viewH || ox + ow < 0 || oy + oh < 0) { continue; }
      drawObstacle(ox, oy, ow, oh, o.kind, cam, t);
    }
  }

  function drawObstacle(x, y, w, h, kind, cam, t) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    if (kind === 'lake') {
      ctx.fillStyle = '#1f5f8a';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = withAlpha('#7fd6ff', 0.22);
      for (var ry = y + 6; ry < y + h - 2; ry += 9) { ctx.fillRect(x + 4, ry, w - 8, 2); }
      strokeRectPx(x, y, w, h, Math.max(2, 2 * cam.s), '#14405d');
      return;
    }
    if (kind === 'construction') {
      ctx.fillStyle = '#caa53c';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#1a1c26';
      for (var sx = x; sx < x + w; sx += Math.max(8, 10 * cam.s)) {
        ctx.fillRect(sx, y, Math.max(3, 5 * cam.s), h);
      }
      strokeRectPx(x, y, w, h, Math.max(2, 2 * cam.s), '#1a1c26');
      return;
    }
    // building: wall + roof band + window grid + hard border.
    ctx.fillStyle = '#3a3f5c';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#262a40';
    ctx.fillRect(x, y, w, Math.max(3, Math.round(h * 0.16)));
    ctx.fillStyle = withAlpha('#7ff9e0', 0.85);
    var step = Math.max(7, Math.min(w, h) / 4);
    for (var wy2 = y + step * 0.7; wy2 < y + h - step * 0.4; wy2 += step) {
      for (var wx2 = x + step * 0.4; wx2 < x + w - step * 0.4; wx2 += step) {
        ctx.fillRect(Math.round(wx2), Math.round(wy2),
          Math.max(2, Math.round(step * 0.3)), Math.max(2, Math.round(step * 0.3)));
      }
    }
    strokeRectPx(x, y, w, h, Math.max(2, 3 * cam.s), '#11131c');
  }

  // ---- ROYALE arena: enclosed walls + floor (legacy, unused) ---------------

  function drawRoyaleArena(cam, t) {
    var x0 = wx(cam, ARENA_MARGIN), y0 = wy(cam, ARENA_MARGIN);
    var x1 = wx(cam, WORLD - ARENA_MARGIN), y1 = wy(cam, WORLD - ARENA_MARGIN);
    var aw = x1 - x0, ah = y1 - y0;

    // Floor.
    ctx.fillStyle = COL.tileA;
    ctx.fillRect(Math.round(x0), Math.round(y0), Math.round(aw), Math.round(ah));

    // Grid lines for an arena floor.
    var cells = 12;
    var cw = aw / cells, ch = ah / cells;
    ctx.fillStyle = COL.grid;
    for (var i = 1; i < cells; i++) {
      ctx.fillRect(Math.round(x0 + i * cw), Math.round(y0), 1, Math.round(ah));
      ctx.fillRect(Math.round(x0), Math.round(y0 + i * ch), Math.round(aw), 1);
    }

    // Chunky walls.
    var bw = Math.max(4, 6 * cam.s);
    strokeRectPx(x0, y0, aw, ah, bw, COL.platEdge);
    strokeRectPx(x0 + bw, y0 + bw, aw - 2 * bw, ah - 2 * bw,
      Math.max(2, 2 * cam.s), withAlpha(COL.winBlue, 0.4));
  }

  // ---- ROYALE storm (BSOD) outside the zone --------------------------------

  function drawStorm(cam, state, zone, t) {
    if (!zone || zone.r <= 0) { return; }
    var W = (state && state.w) || WORLD, H = (state && state.h) || WORLD;
    var cx = wx(cam, zone.cx), cy = wy(cam, zone.cy), r = zone.r * cam.s;

    // Clip to the visible slice of the world.
    var X0 = Math.max(0, wx(cam, 0)), Y0 = Math.max(0, wy(cam, 0));
    var X1 = Math.min(viewW, wx(cam, W)), Y1 = Math.min(viewH, wy(cam, H));
    if (X1 <= X0 || Y1 <= Y0) { return; }
    ctx.save();
    ctx.beginPath();
    ctx.rect(X0, Y0, X1 - X0, Y1 - Y0);
    ctx.clip();
    // BSOD-blue wash outside the safe circle (even-odd punches the hole).
    ctx.fillStyle = withAlpha(COL.winBlue, 0.9);
    ctx.beginPath();
    ctx.rect(X0, Y0, X1 - X0, Y1 - Y0);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    // Scanline flicker.
    var flick = 0.10 + 0.06 * (0.5 + 0.5 * Math.sin(t / 90));
    ctx.fillStyle = withAlpha('#000000', flick);
    for (var sy = Y0; sy < Y1; sy += 6) { ctx.fillRect(X0, sy, X1 - X0, 2); }
    ctx.restore();
  }

  // Static-ish BSOD glyphs ( :( and binary ) scattered in the storm region.
  function drawBsodGlyphs(cam, zone, t, ax0, ay0, aw) {
    var cx = wx(cam, zone.cx), cy = wy(cam, zone.cy), r = zone.r * cam.s;
    var step = Math.max(34, aw / 9);
    var sz = Math.max(2, step * 0.06);
    var phase = Math.floor(t / 380);
    ctx.fillStyle = withAlpha(COL.white, 0.55);
    var idx = 0;
    for (var yy = ay0 + step * 0.4; yy < ay0 + aw; yy += step) {
      for (var xx = ax0 + step * 0.4; xx < ax0 + aw; xx += step) {
        idx++;
        // Only inside the storm (outside the safe circle).
        var dx = xx - cx, dy = yy - cy;
        if (dx * dx + dy * dy <= r * r) { continue; }
        var kind = (idx + phase) % 3;
        if (kind === 0) {
          // sad face :(
          ctx.fillRect(xx - 2 * sz, yy - sz, sz, sz);
          ctx.fillRect(xx + sz, yy - sz, sz, sz);
          ctx.fillRect(xx - sz, yy + sz, 2 * sz, sz);
          ctx.fillRect(xx - 2 * sz, yy + 2 * sz, sz, sz);
        } else if (kind === 1) {
          // a "1"
          ctx.fillRect(xx, yy - 2 * sz, sz, 4 * sz);
        } else {
          // a "0"
          ctx.fillRect(xx - sz, yy - 2 * sz, 2 * sz, sz);
          ctx.fillRect(xx - sz, yy + sz, 2 * sz, sz);
          ctx.fillRect(xx - sz, yy - 2 * sz, sz, 3 * sz);
          ctx.fillRect(xx, yy - 2 * sz, sz, 3 * sz);
        }
      }
    }
  }

  // ---- ROYALE Menthol Zone edge (minty fog ring) ---------------------------

  function drawZoneEdge(cam, zone, t) {
    if (!zone || zone.r <= 0) { return; }
    var cx = wx(cam, zone.cx), cy = wy(cam, zone.cy), r = zone.r * cam.s;

    // Faint minty fill inside the safe zone.
    ctx.save();
    ctx.globalAlpha = 0.10 + 0.04 * (0.5 + 0.5 * Math.sin(t / 600));
    ctx.fillStyle = COL.mint;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Chunky animated dashed ring (Fisherman's fog boundary).
    var seg = 18;
    var rot = t / 1400;
    var bw = Math.max(3, 4 * cam.s);
    ctx.fillStyle = COL.mint;
    for (var i = 0; i < seg; i++) {
      if ((i & 1) === 0) { continue; }
      var a0 = rot + (i / seg) * Math.PI * 2;
      var px = cx + Math.cos(a0) * r;
      var py = cy + Math.sin(a0) * r;
      ctx.fillRect(Math.round(px - bw / 2), Math.round(py - bw / 2),
        Math.ceil(bw), Math.ceil(bw));
    }
    // Solid thin ring under the dashes for clarity.
    ctx.strokeStyle = withAlpha(COL.mint, 0.5);
    ctx.lineWidth = Math.max(1, cam.s);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ---- pickups -------------------------------------------------------------

  function drawPickups(cam, pickups, t) {
    for (var i = 0; i < pickups.length; i++) {
      var p = pickups[i];
      var x = wx(cam, p.x), y = wy(cam, p.y);
      var bob = Math.sin(t / 260 + i) * (3 * cam.s);
      drawPickup(x, y + bob, p.kind, cam.s, t);
    }
  }

  function drawPickup(x, y, kind, s, t) {
    var u = Math.max(2, 2.4 * s); // pickup "pixel" unit
    function blk(gx, gy, w, h, col) {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x + gx * u), Math.round(y + gy * u),
        Math.ceil(w * u) + 1, Math.ceil(h * u) + 1);
    }
    // Shared pulsing glow halo.
    var glow = 0.25 + 0.15 * (0.5 + 0.5 * Math.sin(t / 200));
    ctx.fillStyle = withAlpha(glowColorFor(kind), glow);
    ctx.fillRect(Math.round(x - 5 * u), Math.round(y - 5 * u),
      Math.round(10 * u), Math.round(10 * u));

    switch (kind) {
      case 'fisherman':
        // Menthol tin: minty box with white label + dark text bar.
        blk(-3, -3, 6, 6, '#0f4a44');
        blk(-3, -3, 6, 2, COL.mint);
        blk(-2, 0, 4, 2, COL.white);
        blk(-1, 1, 2, 1, COL.black);
        break;
      case 'fork':
        // Git fork: two branching dots from a stem.
        blk(-1, -3, 2, 6, COL.mint);
        blk(-3, -3, 2, 2, COL.orange);
        blk(1, -3, 2, 2, COL.orange);
        blk(-3, -1, 2, 2, COL.orange);
        blk(1, -1, 2, 2, COL.orange);
        break;
      case 'libre':
        // LibreOffice frisbee/disc: round blue-green disc with a notch.
        blk(-2, -3, 4, 1, '#18a06a');
        blk(-3, -2, 6, 4, '#18a06a');
        blk(-2, 2, 4, 1, '#18a06a');
        blk(-1, -1, 2, 2, COL.white);
        break;
      case 'windows':
        // Windows flag: 4 blue panes (the villain).
        blk(-3, -3, 3, 3, '#3b82f6');
        blk(0, -3, 3, 3, '#22c55e');
        blk(-3, 0, 3, 3, '#ef4444');
        blk(0, 0, 3, 3, '#eab308');
        break;
      default:
        blk(-2, -2, 4, 4, COL.white);
        break;
    }
  }

  function glowColorFor(kind) {
    switch (kind) {
      case 'fisherman': return COL.mint;
      case 'fork': return COL.orange;
      case 'libre': return '#18a06a';
      case 'windows': return COL.winBlue;
      default: return COL.white;
    }
  }

  // ---- projectiles ---------------------------------------------------------

  function drawProjectiles(cam, projectiles, t) {
    for (var i = 0; i < projectiles.length; i++) {
      var pr = projectiles[i];
      var x = wx(cam, pr.x), y = wy(cam, pr.y);
      drawProjectile(x, y, pr.kind, cam.s, t, i);
    }
  }

  function drawProjectile(x, y, kind, s, t, seed) {
    var u = Math.max(2, 2.2 * s);
    var spin = (t / 80 + seed) % (Math.PI * 2);
    // LibreOffice frisbee — a spinning green-blue disc.
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin);
    function blk(gx, gy, w, h, col) {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(gx * u), Math.round(gy * u),
        Math.ceil(w * u) + 1, Math.ceil(h * u) + 1);
    }
    blk(-1, -2, 2, 1, '#18a06a');
    blk(-2, -1, 4, 2, '#1fb877');
    blk(-1, 1, 2, 1, '#18a06a');
    blk(-1, -1, 1, 1, COL.white); // glint
    ctx.restore();

    // Motion trail glow.
    ctx.fillStyle = withAlpha(COL.mint, 0.25);
    ctx.fillRect(Math.round(x - 3 * u), Math.round(y - 3 * u),
      Math.round(6 * u), Math.round(6 * u));
  }

  // ---- characters ----------------------------------------------------------

  function drawCharacters(cam, players, localId, t) {
    // Sort so the dead draw first, then by Y (painter's), local player last.
    var sorted = players.slice().sort(function (a, b) {
      if (a.alive !== b.alive) { return a.alive ? 1 : -1; }
      if (a.id === localId) { return 1; }
      if (b.id === localId) { return -1; }
      return a.y - b.y;
    });

    // sprite scale: a ~16px-tall sprite mapped so it visually fills ~playerR*2.
    // playerRadius in world units is 22; the sprite reference is 16 cells, and
    // we want the body to span ~2*radius => scale = (2*22)/16 world units/cell,
    // then * cam.s to canvas px.
    var spriteScale = (44 / 16) * cam.s;

    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var x = wx(cam, p.x), y = wy(cam, p.y);

      // Ground shadow.
      ctx.fillStyle = withAlpha('#000000', p.alive ? 0.35 : 0.18);
      ctx.beginPath();
      ctx.ellipse(x, y + 14 * cam.s, 16 * cam.s, 6 * cam.s, 0, 0, Math.PI * 2);
      ctx.fill();

      if (!p.alive) {
        // Dead: faded ghost, no overlays.
        ctx.save();
        ctx.globalAlpha = 0.30;
        Sprites.drawCharacter(ctx, p.character, x, y, spriteScale, p.facing || 1);
        ctx.restore();
        continue;
      }

      // Boost aura (Fisherman's minty ring).
      if (p.boost) {
        var bp = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(t / 120 + i));
        ctx.strokeStyle = withAlpha(COL.mint, bp);
        ctx.lineWidth = Math.max(2, 3 * cam.s);
        ctx.beginPath();
        ctx.arc(x, y, 22 * cam.s, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Local-player marker (a bouncing minty arrow above).
      if (p.id === localId) {
        drawLocalMarker(x, y - 30 * cam.s, cam.s, t);
      }

      Sprites.drawCharacter(ctx, p.character, x, y, spriteScale, p.facing || 1);

      // Activate-Windows debuff tint flag on-sprite (subtle blue wash).
      if (p.windowsUntil && p.windowsUntil > Date.now()) {
        ctx.fillStyle = withAlpha(COL.winBlue, 0.22);
        ctx.fillRect(Math.round(x - 18 * cam.s), Math.round(y - 22 * cam.s),
          Math.round(36 * cam.s), Math.round(44 * cam.s));
      }
    }
  }

  function drawLocalMarker(x, y, s, t) {
    var bob = Math.sin(t / 180) * (2 * s);
    var u = Math.max(2, 2 * s);
    ctx.fillStyle = COL.mint;
    // Downward chevron.
    ctx.fillRect(Math.round(x - 2 * u), Math.round(y + bob), Math.round(4 * u), Math.round(u));
    ctx.fillRect(Math.round(x - u), Math.round(y + bob + u), Math.round(2 * u), Math.round(u));
    ctx.fillRect(Math.round(x - u * 0.5), Math.round(y + bob + 2 * u), Math.round(u), Math.round(u));
  }

  // ---- nameplates + HP / damage bars --------------------------------------

  function drawNameplates(cam, players, mode) {
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (!p.alive) { continue; }
      var x = wx(cam, p.x), y = wy(cam, p.y);
      var topY = y - 34 * cam.s;

      // Name.
      var name = (p.nickname || (p.character && p.character.name) || '???');
      setFont(Math.max(6, Math.round(7 * cam.s)));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      var ty = Math.round(topY);
      ctx.fillStyle = COL.black;
      ctx.fillText(name, x + 1, ty + 1); // shadow
      ctx.fillStyle = COL.white;
      ctx.fillText(name, x, ty);

      // Bar under the name.
      var bw = 40 * cam.s, bh = Math.max(4, 5 * cam.s);
      var bx = x - bw / 2, by = topY + 4 * cam.s;
      if (mode === 'royale') {
        // HP bar (0..100).
        var hp = clamp01((p.hp == null ? 100 : p.hp) / 100);
        drawBar(bx, by, bw, bh, hp, hpColor(hp));
      } else {
        // Smash: damage% meter. Higher = more vulnerable => fill toward red.
        var dmg = (p.damage == null ? 0 : p.damage);
        var frac = clamp01(dmg / 150);
        drawBar(bx, by, bw, bh, frac, dmgColor(frac));
        // Damage percent label.
        setFont(Math.max(6, Math.round(6 * cam.s)));
        ctx.fillStyle = dmgColor(frac);
        ctx.fillText(Math.round(dmg) + '%', x, by + bh + 8 * cam.s);
        // Stock pips.
        var stk = (p.stocks == null) ? 0 : p.stocks;
        var pip = Math.max(2, 3 * cam.s);
        var gap = pip + Math.max(1, 2 * cam.s);
        var sx = x - (stk * gap) / 2 + gap / 2;
        ctx.fillStyle = COL.orange;
        for (var s2 = 0; s2 < stk; s2++) {
          ctx.fillRect(Math.round(sx + s2 * gap - pip / 2),
            Math.round(by + bh + 12 * cam.s), Math.round(pip), Math.round(pip));
        }
      }
    }
  }

  function drawBar(x, y, w, h, frac, fillCol) {
    frac = clamp01(frac);
    // Frame.
    ctx.fillStyle = COL.black;
    ctx.fillRect(Math.round(x - 1), Math.round(y - 1), Math.round(w + 2), Math.round(h + 2));
    // Track.
    ctx.fillStyle = '#2a2f4a';
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    // Fill.
    ctx.fillStyle = fillCol;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w * frac), Math.round(h));
  }

  function hpColor(frac) {
    if (frac > 0.6) { return COL.hpGood; }
    if (frac > 0.3) { return COL.hpMid; }
    return COL.hpLow;
  }
  function dmgColor(frac) {
    // Low damage = mint (safe), high = red (about to fly).
    if (frac < 0.33) { return COL.mint; }
    if (frac < 0.66) { return COL.hpMid; }
    return COL.hpLow;
  }

  // ---- HUD -----------------------------------------------------------------

  function drawHud(state, local, players, mode, t) {
    var pad = 10;
    var aliveCount = (state.alive != null)
      ? state.alive
      : players.filter(function (p) { return p.alive; }).length;

    // ----- Top-left status panel -----
    var panelW = 188, panelH = 60;
    drawPanel(pad, pad, panelW, panelH);
    setFont(10);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    var line1, line2;
    if (mode === 'royale') {
      var hp = local ? Math.max(0, Math.round(local.hp || 0)) : 0;
      line1 = tr('game.hp', 'HP') + ' ' + hp;
      line2 = tr('game.alive', 'ALIVE') + ' ' + aliveCount;
    } else {
      var d = local ? Math.round(local.damage || 0) : 0;
      var st = local ? (local.stocks || 0) : 0;
      line1 = tr('game.damage', 'DMG') + ' ' + d + '%';
      line2 = tr('game.stocks', 'LIVES') + ' ' + st + '  ' + tr('game.alive', 'LEFT') + ' ' + aliveCount;
    }
    ctx.fillStyle = COL.mint;
    ctx.fillText(line1, pad + 10, pad + 10);
    ctx.fillStyle = COL.panelText;
    ctx.fillText(line2, pad + 10, pad + 30);

    // Local damage/HP meter bar across the bottom of the panel.
    var barX = pad + 10, barY = pad + 46, barW = panelW - 20, barH = 8;
    if (local) {
      if (mode === 'royale') {
        var hf = clamp01((local.hp == null ? 100 : local.hp) / 100);
        drawBar(barX, barY, barW, barH, hf, hpColor(hf));
      } else {
        var df = clamp01((local.damage || 0) / 150);
        drawBar(barX, barY, barW, barH, df, dmgColor(df));
      }
    }

    // ----- Royale: zone countdown / radius indicator (top-center) -----
    if (mode === 'royale' && state.zone) {
      var zPanelW = 150, zPanelH = 24;
      var zx = (viewW - zPanelW) / 2;
      drawPanel(zx, pad, zPanelW, zPanelH);
      setFont(9);
      ctx.fillStyle = COL.mint;
      ctx.textAlign = 'center';
      var zr0 = ((state.w || 1000) * 0.52) || 520;
      var pct = clamp01(state.zone.r / zr0) * 100;
      var warn = state.zone.r < zr0 * 0.3;
      ctx.fillStyle = warn ? blend(COL.mint, COL.danger, 0.5 + 0.5 * Math.sin(t / 150)) : COL.mint;
      ctx.fillText(tr('game.zone', 'ZONE') + ' ' + Math.round(pct) + '%',
        zx + zPanelW / 2, pad + 8);
      ctx.textAlign = 'left';
    }

    // ----- Vim cooldown / command hints (bottom-left) -----
    drawVimHints(pad, mode);

    // ----- Storm warning banner when the local player is outside the zone ----
    if (mode === 'royale' && local && local.alive && isOutsideZone(local, state.zone)) {
      drawStormWarning(t);
    }
  }

  // Static legend of the vim specials (the sim has no per-tick cooldown in the
  // snapshot; this teaches the controls + reminds the player of the commands).
  function drawVimHints(pad, mode) {
    var items = [
      { k: ':wq', d: tr('controls.vimWq', 'blink') },
      { k: 'dd', d: tr('controls.vimDd', 'purge') },
      { k: 'sudo', d: tr('controls.vimSudo', 'AoE') }
    ];
    var lineH = 16;
    var w = 150, h = 12 + items.length * lineH;
    var x = pad, y = viewH - h - pad;
    drawPanel(x, y, w, h);
    setFont(8);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COL.orange;
    ctx.fillText(tr('controls.vim', 'VIM') + '  /', x + 8, y + 6);
    for (var i = 0; i < items.length; i++) {
      var iy = y + 6 + (i + 1) * lineH - 4;
      ctx.fillStyle = COL.mint;
      ctx.fillText(items[i].k, x + 8, iy);
      ctx.fillStyle = COL.panelText;
      ctx.fillText(items[i].d, x + 64, iy);
    }
  }

  function drawStormWarning(t) {
    var blink = 0.5 + 0.5 * Math.sin(t / 110);
    if (blink < 0.4) { return; }
    var w = 260, h = 30, x = (viewW - w) / 2, y = viewH - h - 24;
    ctx.fillStyle = withAlpha(COL.winBlue, 0.9);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = COL.white;
    strokeRectPx(x, y, w, h, 3, COL.white);
    setFont(10);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.white;
    ctx.fillText(tr('game.bsodWarn', 'BSOD STORM!'), x + w / 2, y + h / 2 + 1);
    ctx.textBaseline = 'top';
  }

  // ---- shared UI primitives ------------------------------------------------

  // drawPanel: chunky 8-bit panel with a hard offset drop-shadow + solid border.
  function drawPanel(x, y, w, h) {
    // Hard drop shadow.
    ctx.fillStyle = COL.panelEdge;
    ctx.fillRect(Math.round(x + 4), Math.round(y + 4), Math.round(w), Math.round(h));
    // Body.
    ctx.fillStyle = COL.panel;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    // Border.
    strokeRectPx(x, y, w, h, 3, COL.platEdge);
  }

  // strokeRectPx draws a chunky filled-rectangle border of thickness bw.
  function strokeRectPx(x, y, w, h, bw, col) {
    ctx.fillStyle = col;
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    bw = Math.max(1, Math.round(bw));
    ctx.fillRect(x, y, w, bw);                 // top
    ctx.fillRect(x, y + h - bw, w, bw);        // bottom
    ctx.fillRect(x, y, bw, h);                 // left
    ctx.fillRect(x + w - bw, y, bw, h);        // right
  }

  function setFont(px) {
    ctx.font = px + "px 'Press Start 2P', monospace";
  }

  // ---- helpers -------------------------------------------------------------

  function findById(arr, id) {
    if (!id) { return null; }
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { return arr[i]; }
    }
    return null;
  }

  function isOutsideZone(p, zone) {
    if (!zone || zone.r <= 0) { return false; }
    var dx = p.x - zone.cx, dy = p.y - zone.cy;
    return Math.hypot(dx, dy) > zone.r;
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // tr: localized string via I18n when present, else the English fallback.
  function tr(key, en) {
    if (typeof I18n !== 'undefined' && I18n && I18n.t) { return I18n.t(key, en); }
    return en;
  }

  // ---- tiny color utilities (accept #rrggbb) ------------------------------
  function withAlpha(hex, a) {
    var c = parseHex(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function blend(a, b, t) {
    var ca = parseHex(a), cb = parseHex(b);
    t = clamp01(t);
    return 'rgb(' + Math.round(ca[0] + (cb[0] - ca[0]) * t) + ',' +
      Math.round(ca[1] + (cb[1] - ca[1]) * t) + ',' +
      Math.round(ca[2] + (cb[2] - ca[2]) * t) + ')';
  }
  function parseHex(h) {
    if (h[0] !== '#') {
      // already rgb()/rgba(); fall back to white so callers never crash.
      return [255, 255, 255];
    }
    h = h.slice(1);
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  return {
    init: init,
    drawFrame: drawFrame
  };
})();

window.Render = Render;
