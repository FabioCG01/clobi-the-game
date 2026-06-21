// sprites.js — procedural 8-bit pixel art for "Tux Smash Royale". Single global:
// Sprites. Pure fillRect art on a 32x36 virtual grid (2x the old resolution);
// the part catalogs + colour presets live in the editable web/assets/parts.js.
//
// THE UNIVERSAL CHARACTER (v2) — one object across both modes + both bodies:
//   {
//     name, bodyType:'tux'|'humanoid', gender:'male'|'female',
//     body, belly, feet,        // hex colours (tux: body/belly/feet)
//     skin, hairColor, beardColor, // hex colours (humanoid)
//     hair, beard,              // style indices (humanoid)
//     hat, eyes, accessory, cape   // style indices (shared)
//   }
// Colours are full hex strings so the editor can offer a free colour picker.
// For the humanoid, `belly` doubles as the shirt colour and `skin` is the face.
//
// drawCharacter(ctx, character, x, y, scale, facing): (x,y) is the sprite CENTRE
// in canvas px; `scale` is destination px per OLD-16-grid cell (kept stable so
// callers don't change); `facing` is +1 right / -1 left (whole sprite mirrors).
var Sprites = (function () {
  'use strict';

  var P = (window.ClobiParts) || {};
  var GW = P.GRID_W || 32;
  var GH = P.GRID_H || 36;

  // Fallback colour presets if the data file failed to load.
  var PRESETS = P.presets || {
    skin: ['#f3c69a'], hair: ['#b07a43'], body: ['#11131c'],
    belly: ['#fdfdfd'], shirt: ['#fdfdfd'], feet: ['#ff9e2c'], beard: ['#7a4a1f']
  };
  var HAIRS = P.hair || [{ name: 'Short', px: [[12, 2, 8, 1], [11, 3, 10, 1]] }];
  var BEARDS = P.beard || [{ name: 'None', px: [] }];
  var HATS = P.hats || [{ name: 'None', kind: 'none' }];
  var EYES = P.eyes || [{ name: 'Classic', kind: 'classic' }];
  var ACC = P.accessories || [{ name: 'None', kind: 'none' }];
  var CAPES = P.capes || [{ name: 'None', kind: 'none' }];
  var CLOBI = P.clobi || {
    gender: 'male', skin: '#f3c69a', hairColor: '#b07a43', beardColor: '#7a4a1f',
    belly: '#fdfdfd', feet: '#5a3a22', hair: 0, beard: 1
  };

  // PARTS is consumed by the editor (colour presets + catalogs + counts).
  var PARTS = {
    presets: PRESETS,
    HAIRS: HAIRS, BEARDS: BEARDS, HATS: HATS,
    EYES: EYES, ACCESSORIES: ACC, CAPES: CAPES
  };

  // ---- character factories -------------------------------------------------

  function defaultCharacter() {
    return {
      name: '', bodyType: 'tux', gender: 'male',
      body: '#11131c', belly: '#fdfdfd', feet: '#ff9e2c',
      skin: CLOBI.skin, hairColor: CLOBI.hairColor, beardColor: CLOBI.beardColor,
      hair: CLOBI.hair, beard: CLOBI.beard,
      hat: 0, eyes: 0, accessory: 0, cape: 0
    };
  }

  // clobiHumanoid returns a humanoid that looks like Clobi (the default person):
  // light-brown ponytail, a small beard, a white shirt. Keeps the given name.
  function clobiHumanoid(base) {
    var c = sanitize(base || {});
    c.bodyType = 'humanoid';
    c.gender = CLOBI.gender;
    c.skin = CLOBI.skin;
    c.hairColor = CLOBI.hairColor;
    c.beardColor = CLOBI.beardColor;
    c.belly = CLOBI.belly;
    c.feet = CLOBI.feet;
    c.hair = CLOBI.hair;
    c.beard = CLOBI.beard;
    return c;
  }

  function randInt(n) { return Math.floor(Math.random() * n); }
  function pickArr(a) { return a[randInt(a.length)]; }

  function randomCharacter() {
    var humanoid = Math.random() < 0.5;
    return {
      name: '',
      bodyType: humanoid ? 'humanoid' : 'tux',
      gender: Math.random() < 0.5 ? 'male' : 'female',
      body: pickArr(PRESETS.body), belly: pickArr(PRESETS.belly), feet: pickArr(PRESETS.feet),
      skin: pickArr(PRESETS.skin), hairColor: pickArr(PRESETS.hair), beardColor: pickArr(PRESETS.beard),
      hair: randInt(HAIRS.length), beard: randInt(BEARDS.length),
      hat: randInt(HATS.length), eyes: randInt(EYES.length),
      accessory: randInt(ACC.length), cape: randInt(CAPES.length)
    };
  }

  // sanitize coerces an arbitrary/partial/old character into a valid v2 one.
  function sanitize(c) {
    var d = defaultCharacter();
    if (!c || typeof c !== 'object') { return d; }
    function col(v, def) {
      return (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : def;
    }
    function idx(v, len, def) {
      v = (typeof v === 'number') ? Math.floor(v) : def;
      if (v < 0 || v >= len) { return 0; }
      return v;
    }
    return {
      name: (typeof c.name === 'string') ? c.name : '',
      bodyType: (c.bodyType === 'humanoid') ? 'humanoid' : 'tux',
      gender: (c.gender === 'female') ? 'female' : 'male',
      body: col(c.body, d.body),
      belly: col(c.belly, d.belly),
      feet: col(c.feet, d.feet),
      skin: col(c.skin, d.skin),
      hairColor: col(c.hairColor, d.hairColor),
      beardColor: col(c.beardColor, d.beardColor),
      hair: idx(c.hair, HAIRS.length, 0),
      beard: idx(c.beard, BEARDS.length, 0),
      hat: idx(c.hat, HATS.length, 0),
      eyes: idx(c.eyes, EYES.length, 0),
      accessory: idx(c.accessory, ACC.length, 0),
      cape: idx(c.cape, CAPES.length, 0)
    };
  }

  // ---- low-level pixel pen -------------------------------------------------
  // makePen: cx,cy = canvas centre; s = canvas px per grid cell; flip -1 mirrors.
  function makePen(ctx, cx, cy, s, flip) {
    var halfW = GW / 2, halfH = GH / 2;
    return {
      px: function (gx, gy, w, h, color) {
        if (!color) { return; }
        w = (w === undefined ? 1 : w);
        h = (h === undefined ? 1 : h);
        var lx = gx;
        if (flip < 0) { lx = GW - (gx + w); }
        var X = cx + (lx - halfW) * s;
        var Y = cy + (gy - halfH) * s;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(X), Math.round(Y),
          Math.ceil(w * s) + 1, Math.ceil(h * s) + 1);
      }
    };
  }

  // ---- public entry --------------------------------------------------------
  function drawCharacter(ctx, character, x, y, scale, facing) {
    var c = sanitize(character);
    var flip = (facing < 0) ? -1 : 1;
    // Keep visual size stable vs the old 16-wide reference grid.
    var s = scale * 16 / GW;
    var pen = makePen(ctx, x, y, s, flip);
    if (c.bodyType === 'humanoid') { drawHumanoid(pen, c); }
    else { drawTux(pen, c); }
  }

  // ===========================================================================
  // TUX — the 8-bit penguin (32x36). Classic egg body + belly + flippers + feet.
  // ===========================================================================
  function drawTux(P0, c) {
    var bodyCol = c.body, bellyCol = c.belly, feetCol = c.feet;

    drawCape(P0, c, 'tux');

    // Body (egg) — rows as [x,y,w] painted 2 tall.
    var body = [
      [12, 4, 8], [10, 6, 12], [8, 8, 16], [8, 10, 16],
      [6, 12, 20], [6, 14, 20], [6, 16, 20], [6, 18, 20],
      [6, 20, 20], [8, 22, 16], [8, 24, 16], [10, 26, 12]
    ];
    for (var i = 0; i < body.length; i++) {
      P0.px(body[i][0], body[i][1], body[i][2], 2, bodyCol);
    }
    // Belly (white oval inset).
    var belly = [
      [12, 12, 8], [10, 14, 12], [10, 16, 12], [10, 18, 12],
      [10, 20, 12], [12, 22, 8], [12, 24, 8]
    ];
    for (var b = 0; b < belly.length; b++) {
      P0.px(belly[b][0], belly[b][1], belly[b][2], 2, bellyCol);
    }
    // Flippers.
    P0.px(4, 14, 2, 8, bodyCol);
    P0.px(26, 14, 2, 8, bodyCol);
    // Feet.
    P0.px(8, 28, 6, 2, feetCol);
    P0.px(18, 28, 6, 2, feetCol);
    P0.px(8, 30, 8, 2, feetCol);
    P0.px(16, 30, 8, 2, feetCol);
    // Beak.
    P0.px(14, 10, 4, 2, feetCol);
    P0.px(14, 12, 4, 1, feetCol);
    // Eyes on the upper body/face.
    drawEyes(P0, c, 12, 18, 8);
    drawAccessory(P0, c, 'tux');
    drawHat(P0, c, { cx: 16, headTop: 4, headW: 16 });
  }

  // ===========================================================================
  // HUMANOID — an 8-bit person (32x36). FIX: `body` no longer tints the hair —
  // `skin` is the face, `hairColor` the hair, `beardColor` the beard, `belly`
  // the shirt. Gender slightly changes the silhouette.
  // ===========================================================================
  function drawHumanoid(P0, c) {
    var skin = c.skin, shirt = c.belly, shoe = c.feet;
    var pants = mix(shirt, '#000000', 0.55);
    var female = (c.gender === 'female');

    drawCape(P0, c, 'humanoid');

    // Hair BEHIND head (back layer: ponytail tails etc. read as behind).
    drawHairLayer(P0, c, true);

    // Head (skin).
    P0.px(13, 4, 6, 1, skin);
    P0.px(12, 5, 8, 1, skin);
    P0.px(11, 6, 10, 5, skin); // face block y6..10
    P0.px(12, 11, 8, 1, skin);
    P0.px(14, 12, 4, 1, skin); // chin
    P0.px(10, 8, 1, 2, skin);  // left ear
    P0.px(21, 8, 1, 2, skin);  // right ear
    P0.px(14, 13, 4, 1, skin); // neck

    // Hair ON TOP of head.
    drawHairLayer(P0, c, false);
    // Beard over the lower face.
    drawBeard(P0, c);
    // Eyes.
    drawEyes(P0, c, 13, 17, 8);

    // Torso / shirt.
    var shW = female ? 10 : 12;
    var shX = 16 - shW / 2;
    P0.px(shX, 14, shW, 2, shirt);            // shoulders
    P0.px(female ? 12 : 11, 16, female ? 8 : 10, 6, shirt); // chest..belly
    if (female) {
      P0.px(13, 22, 6, 1, shirt);             // taper to waist
    } else {
      P0.px(12, 22, 8, 1, shirt);
    }

    // Arms (shirt sleeves + skin hands).
    P0.px(9, 15, 2, 5, shirt);
    P0.px(21, 15, 2, 5, shirt);
    P0.px(9, 20, 2, 1, skin);
    P0.px(21, 20, 2, 1, skin);

    // Legs (pants).
    P0.px(12, 24, 3, 7, pants);
    P0.px(17, 24, 3, 7, pants);
    // Shoes.
    P0.px(11, 31, 5, 2, shoe);
    P0.px(16, 31, 5, 2, shoe);

    drawAccessory(P0, c, 'humanoid');
    drawHat(P0, c, { cx: 16, headTop: 2, headW: 11 });
  }

  // ---- hair + beard (data-driven from parts.js) ----------------------------
  // Front pass draws the cap/top; back pass draws trailing pieces (ponytail).
  function drawHairLayer(P0, c, back) {
    var style = HAIRS[c.hair] || HAIRS[0];
    if (!style || !style.px) { return; }
    for (var i = 0; i < style.px.length; i++) {
      var r = style.px[i];
      var isBack = (r[0] < 11); // pieces left of the skull = behind (ponytail)
      if (isBack !== !!back) { continue; }
      P0.px(r[0], r[1], r[2], r[3], c.hairColor);
    }
  }

  function drawBeard(P0, c) {
    var style = BEARDS[c.beard] || BEARDS[0];
    if (!style || !style.px) { return; }
    for (var i = 0; i < style.px.length; i++) {
      var r = style.px[i];
      P0.px(r[0], r[1], r[2], r[3], c.beardColor);
    }
  }

  // ---- eyes ----------------------------------------------------------------
  function drawEyes(P0, c, lx, rx, ey) {
    var e = EYES[c.eyes] || EYES[0];
    var white = '#ffffff', dark = '#11131c';
    switch (e.kind) {
      case 'angry':
        P0.px(lx - 1, ey - 1, 3, 1, dark);
        P0.px(rx, ey - 1, 3, 1, dark);
        P0.px(lx, ey, 2, 2, white); P0.px(rx, ey, 2, 2, white);
        P0.px(lx + 1, ey, 1, 1, dark); P0.px(rx, ey, 1, 1, dark);
        break;
      case 'sleepy':
        P0.px(lx - 1, ey + 1, 3, 1, dark);
        P0.px(rx, ey + 1, 3, 1, dark);
        break;
      case 'shades':
        P0.px(lx - 1, ey - 1, rx - lx + 4, 2, dark);
        P0.px(lx, ey + 1, 1, 1, '#7ff9e0');
        break;
      case 'sparkle':
        P0.px(lx, ey - 1, 2, 3, white); P0.px(rx, ey - 1, 2, 3, white);
        P0.px(lx, ey, 1, 1, '#7ff9e0'); P0.px(rx, ey, 1, 1, '#7ff9e0');
        break;
      case 'classic':
      default:
        P0.px(lx, ey - 1, 2, 3, white); P0.px(rx, ey - 1, 2, 3, white);
        P0.px(lx, ey, 1, 2, dark); P0.px(rx, ey, 1, 2, dark);
        break;
    }
  }

  // ---- hats (scaled to the 32 grid) ----------------------------------------
  function drawHat(P0, c, h) {
    var hat = HATS[c.hat] || HATS[0];
    if (!hat || hat.kind === 'none') { return; }
    var left = h.cx - Math.floor(h.headW / 2);
    var w = h.headW, top = h.headTop;
    switch (hat.kind) {
      case 'cap':
        P0.px(left, top, w, 2, hat.c1);
        P0.px(left + 1, top - 2, w - 2, 2, hat.c1);
        P0.px(left - 2, top + 2, w + 4, 1, hat.c2);
        P0.px(h.cx - 1, top, 2, 2, hat.logo);
        break;
      case 'wizard':
        P0.px(h.cx, top - 8, 2, 2, hat.c1);
        P0.px(h.cx - 1, top - 6, 4, 2, hat.c1);
        P0.px(h.cx - 2, top - 4, 6, 2, hat.c1);
        P0.px(left, top - 2, w, 2, hat.c1);
        P0.px(left - 1, top, w + 2, 1, hat.c2);
        P0.px(h.cx, top - 6, 1, 1, hat.star);
        break;
      case 'crown':
        P0.px(left + 2, top, w - 4, 2, hat.c1);
        P0.px(left + 2, top - 2, 2, 2, hat.c1);
        P0.px(h.cx - 1, top - 2, 2, 2, hat.c1);
        P0.px(left + w - 4, top - 2, 2, 2, hat.c1);
        P0.px(h.cx - 1, top, 2, 2, hat.gem);
        break;
      case 'beanie':
        P0.px(left, top - 1, w, 3, hat.c1);
        P0.px(left, top + 2, w, 1, hat.c2);
        P0.px(h.cx - 1, top - 3, 2, 2, hat.c2);
        break;
      case 'tophat':
        P0.px(left - 1, top + 2, w + 2, 1, hat.c1);
        P0.px(left + 2, top - 6, w - 4, 8, hat.c1);
        P0.px(left + 2, top - 2, w - 4, 1, hat.c2);
        break;
      case 'phones':
        P0.px(left, top - 2, w, 2, hat.c1);
        P0.px(left - 2, top + 1, 2, 3, hat.c2);
        P0.px(left + w, top + 1, 2, 3, hat.c2);
        break;
      case 'halo':
        P0.px(left + 1, top - 5, w - 2, 1, hat.c1);
        P0.px(left, top - 5, 1, 1, hat.c2);
        P0.px(left + w - 1, top - 5, 1, 1, hat.c2);
        break;
      default: break;
    }
  }

  // ---- accessories ---------------------------------------------------------
  function drawAccessory(P0, c, bodyType) {
    var a = ACC[c.accessory] || ACC[0];
    if (!a || a.kind === 'none') { return; }
    var chestY = (bodyType === 'humanoid') ? 15 : 13;
    switch (a.kind) {
      case 'bowtie':
        P0.px(14, 13, 4, 2, a.c1);
        P0.px(12, 13, 2, 2, a.c1);
        P0.px(18, 13, 2, 2, a.c1);
        break;
      case 'fish':
        P0.px(14, chestY + 2, 4, 3, a.c1);
        P0.px(14, chestY + 2, 4, 1, '#ffffff');
        P0.px(15, chestY + 3, 2, 1, a.c2);
        break;
      case 'scarf':
        P0.px(11, 13, 10, 2, a.c1);
        P0.px(13, 15, 2, 3, a.c1);
        break;
      case 'badge':
        P0.px(11, chestY + 2, 2, 2, '#ffffff');
        P0.px(11, chestY + 2, 2, 1, a.c1);
        break;
      default: break;
    }
  }

  // ---- capes ---------------------------------------------------------------
  function drawCape(P0, c, bodyType) {
    var cp = CAPES[c.cape] || CAPES[0];
    if (!cp || cp.kind === 'none') { return; }
    var topY = (bodyType === 'humanoid') ? 14 : 12;
    P0.px(4, topY, 6, 2, cp.c1);
    P0.px(2, topY + 2, 8, 2, cp.c1);
    P0.px(2, topY + 4, 8, 2, cp.c2);
    P0.px(0, topY + 6, 8, 2, cp.c1);
    P0.px(0, topY + 8, 8, 2, cp.c2);
    P0.px(2, topY + 10, 6, 2, cp.c1);
    P0.px(4, topY + 12, 4, 2, cp.c2);
  }

  // ---- colour utils --------------------------------------------------------
  function mix(a, b, t) {
    var ca = hexToRgb(a), cb = hexToRgb(b);
    return 'rgb(' + Math.round(ca[0] + (cb[0] - ca[0]) * t) + ',' +
      Math.round(ca[1] + (cb[1] - ca[1]) * t) + ',' +
      Math.round(ca[2] + (cb[2] - ca[2]) * t) + ')';
  }
  function hexToRgb(h) {
    if (!h || h[0] !== '#') { return [128, 128, 128]; }
    h = h.slice(1);
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    var n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

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
