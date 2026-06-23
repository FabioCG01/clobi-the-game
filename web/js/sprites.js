// sprites.js — character model + draw API for "Tux Smash Royale". Single global:
// Sprites. The art is now image-based: drawCharacter delegates to Textures
// (tinted PNG masks composited per fighter). A tiny procedural fallback keeps the
// game from ever rendering blank in the brief window before textures preload.
//
// THE UNIVERSAL CHARACTER (v3) — one object across both modes + both bodies:
//   {
//     name, bodyType:'tux'|'humanoid', gender:'male'|'female', fat:0..1,
//     body, belly, feet,                 // tux colours (belly=shirt for humanoid)
//     skin, hairColor, beardColor, pants, capeColor,  // humanoid + shared colours
//     hair, beard,                       // humanoid style indices
//     shirtStyle, pantsStyle, shoeStyle, // humanoid clothing style indices
//     hat, eyes, accessory, cape         // shared style indices
//   }
// Colours are full hex strings (the editor offers a free colour picker).
//
// drawCharacter(ctx, character, x, y, scale, facing): (x,y) is the sprite CENTRE
// in canvas px; `scale` is destination px per OLD-16-grid cell (kept stable so
// callers don't change); `facing` is +1 right / -1 left.
var Sprites = (function () {
  'use strict';

  var P = (window.ClobiParts) || {};
  var GW = P.GRID_W || 32;
  var PRESETS = P.presets || {
    skin: ['#f3c69a'], hair: ['#b07a43'], body: ['#11131c'], belly: ['#fdfdfd'],
    shirt: ['#fdfdfd'], pants: ['#33405c'], feet: ['#ff9e2c'], beard: ['#7a4a1f'], cape: ['#ff5a3c']
  };
  var CLOBI = P.clobi || { gender: 'male', skin: '#f3c69a', hairColor: '#b07a43', beardColor: '#7a4a1f', belly: '#fdfdfd', feet: '#5a3a22', pants: '#33405c', hair: 3, beard: 2, shirtStyle: 0, pantsStyle: 0, shoeStyle: 0 };

  // catalog length for a group (from the loaded texture manifest; 0 until ready)
  function catLen(g) { var T = window.Textures; var a = T && T.catalog && T.catalog(g); return (a && a.length) || 0; }

  // ---- character factories -------------------------------------------------
  function defaultCharacter() {
    return {
      name: '', bodyType: 'tux', gender: 'male', fat: 0,
      body: '#11131c', belly: '#fdfdfd', feet: '#ff9e2c',
      skin: CLOBI.skin, hairColor: CLOBI.hairColor, beardColor: CLOBI.beardColor,
      pants: '#33405c', capeColor: '#ff5a3c',
      hair: 0, beard: 0, shirtStyle: 0, pantsStyle: 0, shoeStyle: 0,
      hat: 0, eyes: 0, accessory: 0, cape: 0
    };
  }

  function clobiHumanoid(base) {
    var c = sanitize(base || {});
    c.bodyType = 'humanoid'; c.gender = CLOBI.gender;
    c.skin = CLOBI.skin; c.hairColor = CLOBI.hairColor; c.beardColor = CLOBI.beardColor;
    c.belly = CLOBI.belly; c.feet = CLOBI.feet; c.pants = CLOBI.pants;
    c.hair = CLOBI.hair; c.beard = CLOBI.beard;
    c.shirtStyle = CLOBI.shirtStyle; c.pantsStyle = CLOBI.pantsStyle; c.shoeStyle = CLOBI.shoeStyle;
    return c;
  }

  function randInt(n) { return Math.floor(Math.random() * n); }
  function pick(a) { return a[randInt(a.length)]; }
  function ri(g, fallback) { var n = catLen(g); return randInt(n || fallback || 1); }

  function randomCharacter() {
    var humanoid = Math.random() < 0.5;
    return {
      name: '', bodyType: humanoid ? 'humanoid' : 'tux',
      gender: Math.random() < 0.5 ? 'male' : 'female',
      fat: Math.random() < 0.4 ? +(Math.random() * 0.9).toFixed(2) : 0,
      body: pick(PRESETS.body), belly: pick(PRESETS.shirt), feet: pick(PRESETS.feet),
      skin: pick(PRESETS.skin), hairColor: pick(PRESETS.hair), beardColor: pick(PRESETS.beard),
      pants: pick(PRESETS.pants), capeColor: pick(PRESETS.cape),
      hair: ri('hair', 8), beard: ri('beard', 6),
      shirtStyle: ri('shirt', 6), pantsStyle: ri('pants', 5), shoeStyle: ri('shoes', 4),
      hat: ri('hat', 7), eyes: ri('eyes', 5), accessory: ri('accessory', 6), cape: ri('cape', 6)
    };
  }

  // sanitize coerces any partial/old character into a valid v3 one.
  function sanitize(c) {
    var d = defaultCharacter();
    if (!c || typeof c !== 'object') return d;
    function col(v, def) { return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : def; }
    function idx(v, g, def) {
      v = (typeof v === 'number') ? Math.floor(v) : def;
      var n = catLen(g);
      if (n > 0) { if (v < 0 || v >= n) return def || 0; }
      else if (v < 0) return 0;
      return v;
    }
    var fat = (typeof c.fat === 'number') ? c.fat : 0;
    fat = Math.max(0, Math.min(1, fat));
    return {
      name: (typeof c.name === 'string') ? c.name : '',
      bodyType: (c.bodyType === 'humanoid') ? 'humanoid' : 'tux',
      gender: (c.gender === 'female') ? 'female' : 'male',
      fat: fat,
      body: col(c.body, d.body), belly: col(c.belly, d.belly), feet: col(c.feet, d.feet),
      skin: col(c.skin, d.skin), hairColor: col(c.hairColor, d.hairColor),
      beardColor: col(c.beardColor, d.beardColor), pants: col(c.pants, d.pants),
      capeColor: col(c.capeColor, d.capeColor),
      hair: idx(c.hair, 'hair', 0), beard: idx(c.beard, 'beard', 0),
      shirtStyle: idx(c.shirtStyle, 'shirt', 0), pantsStyle: idx(c.pantsStyle, 'pants', 0),
      shoeStyle: idx(c.shoeStyle, 'shoes', 0),
      hat: idx(c.hat, 'hat', 0), eyes: idx(c.eyes, 'eyes', 0),
      accessory: idx(c.accessory, 'accessory', 0), cape: idx(c.cape, 'cape', 0)
    };
  }

  // ---- draw ----------------------------------------------------------------
  function drawCharacter(ctx, character, x, y, scale, facing) {
    var c = sanitize(character);
    var flip = (facing < 0) ? -1 : 1;
    var s = scale * 16 / GW;                       // px per grid cell (GW=32 -> scale/2)
    if (window.Textures && Textures.isReady() && Textures.draw(ctx, c, x, y, s, flip)) return;
    fallbackDraw(ctx, c, x, y, s, flip);
  }

  // Minimal blob so nothing renders blank before textures preload.
  function fallbackDraw(ctx, c, x, y, s, flip) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    var skin = c.bodyType === 'humanoid' ? c.skin : c.body;
    ctx.fillStyle = c.bodyType === 'humanoid' ? (c.belly || '#888') : (c.body || '#222');
    ctx.fillRect(x - 6 * s, y - 6 * s, 12 * s, 11 * s);     // torso
    ctx.fillStyle = skin || '#f3c69a';
    ctx.beginPath(); ctx.arc(x, y - 9 * s, 4 * s, 0, 7); ctx.fill();  // head
    ctx.restore();
  }

  // PARTS — kept for any caller that wants presets/catalogs in one place.
  var PARTS = {
    presets: PRESETS,
    catalog: function (g) { var T = window.Textures; return (T && T.catalog) ? T.catalog(g) : []; }
  };

  return {
    PARTS: PARTS,
    defaultCharacter: defaultCharacter,
    clobiHumanoid: clobiHumanoid,
    randomCharacter: randomCharacter,
    sanitize: sanitize,
    drawCharacter: drawCharacter
  };
})();

window.Sprites = Sprites;
