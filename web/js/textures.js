// textures.js — image-based character compositor. Single global: Textures.
//
// Loads the baked PNG masks (web/assets/tex/, see tools/gen-textures.mjs) and
// the manifest, then for any character:
//   1) TINTS each grayscale mask by the fighter's chosen colour (multiply),
//   2) COMPOSITES the paper-doll layers back-to-front onto a canonical canvas,
//   3) WARPS that canvas horizontally for gender + fat (head/feet stay put, the
//      torso/hips widen or cinch) — purely visual, the hitbox never changes.
// Everything is cached, so drawing 16 fighters/ frame is cheap.
//
// No frameworks, no ES modules — this file assigns exactly one global.
var Textures = (function () {
  'use strict';

  var GW = 32, GH = 36;      // canonical grid
  var WW = 48, WC = 24;      // warp canvas: wider so a fat torso isn't clipped
  var base = 'assets/tex/';
  var manifest = null, ready = false, readyCbs = [];
  var imgs = {};             // file -> {img, canvas} (canvas for tinted source)
  var tintCache = {};        // file|hex -> canvas
  var canonCache = {};       // sig -> canvas(GW,GH)
  var warpCache = {};        // sig|g|fat -> canvas(WW,GH)

  function onReady(cb) { if (ready) cb(); else readyCbs.push(cb); }

  // ---- loading ------------------------------------------------------------
  function load(basePath) {
    if (basePath) base = basePath;
    return fetch(base + 'manifest.json').then(function (r) { return r.json(); }).then(function (m) {
      manifest = m; GW = m.grid.w; GH = m.grid.h;
      WW = Math.round(GW * 1.5); WC = Math.round(WW / 2);   // warp canvas (room for a fat belly)
      var files = [];
      Object.keys(m.base).forEach(function (k) { files.push(m.base[k]); });
      Object.keys(m.catalog).forEach(function (g) {
        m.catalog[g].forEach(function (it) {
          if (it.file) files.push(it.file);
          if (it.front) files.push(it.front);
          if (it.back) files.push(it.back);
        });
      });
      return Promise.all(files.filter(uniq).map(loadImg));
    }).then(function () {
      ready = true; readyCbs.splice(0).forEach(function (cb) { try { cb(); } catch (e) {} });
      return true;
    });
  }
  var _seen = {};
  function uniq(f) { if (_seen[f]) return false; _seen[f] = 1; return true; }
  function loadImg(file) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = GW; c.height = GH;
        c.getContext('2d').drawImage(img, 0, 0);
        imgs[file] = { img: img, canvas: c }; res();
      };
      img.onerror = function () { res(); };
      img.src = base + file;
    });
  }

  // ---- tinting ------------------------------------------------------------
  function newCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  // tint a grayscale mask by hex; hex===null => raw (fixed-colour) image.
  function tint(file, hex) {
    if (!file || !imgs[file]) return null;
    var key = file + '|' + (hex || 'RAW');
    if (tintCache[key]) return tintCache[key];
    var src = imgs[file].canvas;
    var out = newCanvas(GW, GH); var octx = out.getContext('2d');
    if (!hex) { octx.drawImage(src, 0, 0); tintCache[key] = out; return out; }
    var rgb = hexToRgb(hex);
    var id = src.getContext('2d').getImageData(0, 0, GW, GH);
    var d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3]; if (!a) continue;
      var v = d[i] / 255;                 // grayscale value (r==g==b)
      d[i] = Math.round(rgb[0] * v);
      d[i + 1] = Math.round(rgb[1] * v);
      d[i + 2] = Math.round(rgb[2] * v);
    }
    octx.putImageData(id, 0, 0);
    tintCache[key] = out; return out;
  }

  // ---- character colour/style resolution ----------------------------------
  function cat(g) { return (manifest && manifest.catalog[g]) || []; }
  function styleFile(g, idx, which) {
    var a = cat(g), it = a[(idx | 0) % (a.length || 1)] || a[0];
    if (!it) return null;
    return which ? it[which] : it.file;
  }
  function col(ch, key, def) {
    var v = ch[key];
    return (typeof v === 'string' && /^#/.test(v)) ? v : def;
  }

  // ---- per-object transforms (move / resize / rotate). Purely VISUAL — the
  // server hitbox is the fixed body skeleton and is never affected. Anchors are
  // given in 32x36 authoring space and scaled to the real grid.
  var ANCHOR_A = { head: [16, 12], hair: [16, 4], beard: [16, 11], eyes: [16, 7], eyebrows: [16, 6], mouth: [16, 11], accessory: [16, 16] };
  function anchorFor(key) { var a = ANCHOR_A[key] || [16, 18]; return { x: a[0] * GW / 32, y: a[1] * GH / 36 }; }

  // Build the ordered list of {file, hex, key?} layers for a character.
  function layersFor(ch) {
    var L = [];
    var skin = col(ch, 'skin', '#f3c69a'), hcol = col(ch, 'hairColor', '#b07a43');
    var capeF = (ch.cape | 0) ? styleFile('cape', ch.cape) : null;
    if (capeF) L.push({ f: capeF, c: col(ch, 'capeColor', '#ff5a3c') });

    if (ch.bodyType === 'humanoid') {
      var hb = styleFile('hair', ch.hair, 'back');
      if (hb) L.push({ f: hb, c: hcol, key: 'hair' });
      L.push({ f: manifest.base.humanoidBody, c: skin });                          // skeleton (fixed)
      L.push({ f: styleFile('pants', ch.pantsStyle), c: col(ch, 'pants', '#3a4a66') });
      L.push({ f: styleFile('shirt', ch.shirtStyle), c: col(ch, 'belly', '#fdfdfd') });
      L.push({ f: styleFile('shoes', ch.shoeStyle), c: col(ch, 'feet', '#5a3a22') });
      L.push({ f: manifest.base.humanoidHead, c: skin, key: 'head' });             // resizable
      var hf = styleFile('hair', ch.hair, 'front');
      if (hf) L.push({ f: hf, c: hcol, key: 'hair' });
      var bd = (ch.beard | 0) ? styleFile('beard', ch.beard) : null;
      if (bd) L.push({ f: bd, c: col(ch, 'beardColor', '#7a4a1f'), key: 'beard' });
      var mo = styleFile('mouth', ch.mouth); if (mo) L.push({ f: mo, c: darken(skin, 0.85), key: 'mouth' }); // slightly darker skin
      var br = styleFile('eyebrows', ch.eyebrows); if (br) L.push({ f: br, c: darken(hcol, 0.78), key: 'eyebrows' }); // a touch darker than hair so they read
      L.push({ f: styleFile('eyes', ch.eyes), c: null, key: 'eyes' });
    } else {
      L.push({ f: manifest.base.tuxBody, c: col(ch, 'body', '#11131c') });
      L.push({ f: manifest.base.tuxBelly, c: col(ch, 'belly', '#fdfdfd') });
      L.push({ f: manifest.base.tuxFeet, c: col(ch, 'feet', '#ff9e2c') });
      L.push({ f: manifest.base.tuxBeak, c: col(ch, 'feet', '#ff9e2c') });
      L.push({ f: styleFile('eyes', ch.eyes), c: null, dy: 5 });
    }
    var tux = (ch.bodyType !== 'humanoid');
    var accF = (ch.accessory | 0) ? styleFile('accessory', ch.accessory) : null;
    if (accF) L.push({ f: accF, c: null, dy: tux ? 6 : 0, key: tux ? undefined : 'accessory' });
    var hatF = (ch.hat | 0) ? styleFile('hat', ch.hat) : null;
    if (hatF) L.push({ f: hatF, c: null, dy: tux ? 8 : 0 });
    return L;
  }

  function sig(ch) {
    return [ch.bodyType, ch.body, ch.belly, ch.feet, ch.skin, ch.hairColor, ch.beardColor,
      ch.pants, ch.capeColor, ch.hair, ch.beard, ch.hat, ch.eyes, ch.eyebrows, ch.mouth, ch.accessory, ch.cape,
      ch.shirtStyle, ch.pantsStyle, ch.shoeStyle, JSON.stringify(ch.tf || {})].join(',');
  }

  function canon(ch) {
    var k = sig(ch);
    if (canonCache[k]) return canonCache[k];
    var c = newCanvas(GW, GH), cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    var tf = ch.tf || {};
    layersFor(ch).forEach(function (ly) {
      var t = tint(ly.f, ly.c);
      if (!t) return;
      var T = ly.key ? tf[ly.key] : null;
      if (T && (T.x || T.y || (T.s && T.s !== 1) || T.r)) {
        var a = anchorFor(ly.key);
        cx.save();
        cx.translate(a.x + (T.x || 0), a.y + (T.y || 0));
        if (T.r) cx.rotate(T.r * Math.PI / 180);
        var sc = T.s || 1; if (sc !== 1) cx.scale(sc, sc);
        cx.translate(-a.x, -a.y);
        cx.drawImage(t, 0, 0);
        cx.restore();
      } else {
        cx.drawImage(t, 0, ly.dy || 0);
      }
    });
    canonCache[k] = c; return c;
  }

  // gender silhouette: a per-row UNIFORM horizontal scale (shoulders/waist/hips).
  // Bands are fractions of the sprite height so it works at any resolution.
  function genderScale(yn, gender) {
    if (yn >= 0.37 && yn <= 0.44) return gender === 'female' ? 0.95 : 1.07; // shoulders
    if (yn >= 0.45 && yn <= 0.57) return gender === 'female' ? 0.99 : 1.03; // chest
    if (yn >= 0.58 && yn <= 0.64) return gender === 'female' ? 0.89 : 1.0;  // waist
    if (yn >= 0.65 && yn <= 0.74) return gender === 'female' ? 1.11 : 1.0;  // hips
    return 1;
  }
  // fat: a CENTRE-weighted belly push — peaks at the stomach and fades out before
  // the arms, so the gut sticks out without the arms splaying.
  function fatBulge(yn, fat) {
    if (yn >= 0.44 && yn <= 0.66) { var d = 1 - Math.abs(0.55 - yn) / 0.12; return Math.max(0, d) * fat * 1.25; }
    return 0;
  }

  function warped(ch) {
    var g = ch.gender === 'female' ? 'female' : 'male';
    var fat = Math.max(0, Math.min(1, +ch.fat || 0));
    var fb = Math.round(fat * 8);
    var k = sig(ch) + '|' + g + '|' + fb;
    if (warpCache[k]) return warpCache[k];
    var src = canon(ch);
    var out = newCanvas(WW, GH), o = out.getContext('2d');
    o.imageSmoothingEnabled = false;
    var humanoid = (ch.bodyType === 'humanoid');
    var CX = GW / 2, UMAX = GW * 0.20;          // belly half-width; arms sit beyond this
    for (var y = 0; y < GH; y++) {
      if (!humanoid) { o.drawImage(src, 0, y, GW, 1, WC - GW / 2, y, GW, 1); continue; }
      var yn = y / GH, G = genderScale(yn, g), B = fatBulge(yn, fat);
      var mapX = function (x) { var u = x - CX, w = Math.max(0, 1 - (u / UMAX) * (u / UMAX)); return WC + u * G * (1 + B * w); };
      var prev = mapX(0);
      for (var x = 0; x < GW; x++) {            // forward-map each source column (no gaps)
        var nx = mapX(x + 1);
        o.drawImage(src, x, y, 1, 1, prev, y, Math.max(0.6, nx - prev) + 0.5, 1);
        prev = nx;
      }
    }
    warpCache[k] = out; return out;
  }

  // ---- public draw --------------------------------------------------------
  // s = canvas px per grid cell; (x,y) = sprite centre; flip -1 mirrors.
  function draw(ctx, ch, x, y, s, flip) {
    if (!ready || !manifest) return false;
    var w = warped(ch);
    var dw = WW * s, dh = GH * s;
    var dx = x - WC * s, dy = y - (GH / 2) * s;
    ctx.imageSmoothingEnabled = false;
    if (flip < 0) {
      ctx.save(); ctx.translate(x, 0); ctx.scale(-1, 1); ctx.translate(-x, 0);
      ctx.drawImage(w, dx, dy, dw, dh); ctx.restore();
    } else {
      ctx.drawImage(w, dx, dy, dw, dh);
    }
    return true;
  }

  function hexToRgb(h) {
    if (!h || h[0] !== '#') return [128, 128, 128];
    h = h.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // darken a hex colour by factor f (0..1); used to derive the mouth shade from skin.
  function darken(hex, f) {
    var c = hexToRgb(hex);
    function h2(v) { v = Math.max(0, Math.min(255, Math.round(v * f))); return ('0' + v.toString(16)).slice(-2); }
    return '#' + h2(c[0]) + h2(c[1]) + h2(c[2]);
  }

  return {
    load: load, onReady: onReady, draw: draw,
    isReady: function () { return ready; },
    catalog: function (g) { return g ? cat(g) : (manifest && manifest.catalog); },
    grid: function () { return { w: GW, h: GH }; }
  };
})();
window.Textures = Textures;
