// skins.js — Minecraft-compatible skin decoding + THE NET (the single source
// of truth for the 64x64 skin layout). Single global: Skins.
//
// What lives here:
//   Skins.NET                frozen box/UV table (models x parts x layers x
//                            faces) generated from the box-unwrap rule, so it
//                            can never drift from the code that consumes it
//                            (PlayerModel geometry, Skin Studio, docs).
//   Skins.load(src)          URL | dataURL | File/Blob | Image | canvas ->
//                            Promise<{canvas (64x64), model, dataURL()}>
//   Skins.loadDefault()      fetches 'assets/skins/default.png'; on failure
//                            falls back to a procedural skin (FALLBACK_PNG).
//   Skins.detectModel(c)     'classic' | 'slim' via the pinned 6-px alpha probe.
//   Skins.convertLegacy(i)   64x32 -> 64x64 (mirrors right limbs to left).
//   Skins.normalize(i)       pass-through / legacy-convert to a fresh 64x64.
//   Skins.texture(gl, skin)  NEAREST/NEAREST, CLAMP, flipY=false, no premult.
//   Skins.templateCanvas(m)  color-coded region template built from NET.
//   Skins.regionAt(x, y, m)  reverse lookup -> {part, layer, face} | null.
//   Skins.FALLBACK_PNG       dataURL of the embedded procedural fallback skin
//                            (lazy getter — built on first access).
//
// Depends on: I18n (optional, guarded) for error strings. Nothing else.
// Error convention: thrown/rejected Errors carry .message = the i18n key
// (e.g. 'vox.err.badSkin') and .friendly = the translated human-readable text,
// so machine checks and UI toasts both work.
//
// Contract: docs/ARCHITECTURE-3D.md §5.7.

var Skins = (function () {
  // ---- THE NET: layout tables --------------------------------------------
  var PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
  var LAYERS = ['base', 'overlay'];
  var MODELS = ['classic', 'slim'];

  // Net origins (U,V) per part + layer (§5.7) — identical for both variants
  // (slim just uses a 2 px narrower strip for the arms).
  var ORIGINS = {
    head:     { base: [0, 0],   overlay: [32, 0]  },
    body:     { base: [16, 16], overlay: [16, 32] },
    rightArm: { base: [40, 16], overlay: [40, 32] },
    leftArm:  { base: [32, 48], overlay: [48, 48] },
    rightLeg: { base: [0, 16],  overlay: [0, 32]  },
    leftLeg:  { base: [16, 48], overlay: [0, 48]  }
  };

  // Pivots in model space (origin at feet center, y up), model units (§5.7).
  var PIVOTS = {
    head: [0, 24, 0], body: [0, 24, 0],
    rightArm: [-6, 22, 0], leftArm: [6, 22, 0],
    rightLeg: [-2, 12, 0], leftLeg: [2, 12, 0]
  };

  // Box size W x H x D in model units. Slim arms are 3 px wide.
  function sizeFor(part, model) {
    if (part === 'head') return [8, 8, 8];
    if (part === 'body') return [8, 12, 4];
    if (part === 'rightArm' || part === 'leftArm') {
      return [model === 'slim' ? 3 : 4, 12, 4];
    }
    return [4, 12, 4]; // legs
  }

  // Local box bounds relative to the part pivot (pre-inflation). The slim
  // arm loses its OUTER pixel column (right arm outer edge is -X, left +X).
  function boxFor(part, model) {
    var W = sizeFor(part, model)[0];
    if (part === 'head')     return { min: [-4, 0, -4],   max: [4, 8, 4] };
    if (part === 'body')     return { min: [-4, -12, -2], max: [4, 0, 2] };
    if (part === 'rightArm') return { min: [-(W - 2), -10, -2], max: [2, 2, 2] };
    if (part === 'leftArm')  return { min: [-2, -10, -2], max: [W - 2, 2, 2] };
    return { min: [-2, -12, -2], max: [2, 0, 2] }; // legs
  }

  // Box unwrap rule (§5.7) for a W x H x D box at net origin (U,V).
  // "right" = the box's OWN right (viewer's left when facing the front face).
  // Bottom faces are V-flipped (sampled upside-down) — Minecraft convention;
  // the flag rides on the rect itself so every consumer agrees.
  function unwrap(U, V, W, H, D) {
    return {
      top:    { x: U + D,         y: V,     w: W, h: D },
      bottom: { x: U + D + W,     y: V,     w: W, h: D, vflip: true },
      right:  { x: U,             y: V + D, w: D, h: H },
      front:  { x: U + D,         y: V + D, w: W, h: H },
      left:   { x: U + D + W,     y: V + D, w: D, h: H },
      back:   { x: U + D + W + D, y: V + D, w: W, h: H }
    };
  }

  function deepFreeze(obj) {
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(function (k) { deepFreeze(obj[k]); });
      Object.freeze(obj);
    }
    return obj;
  }

  // Generate the whole table from the rule + origins so it can never drift.
  function buildNet() {
    var net = {
      bottomFlipV: true,             // global restatement of the vflip rule
      models: MODELS.slice(),
      parts: PARTS.slice(),
      layers: LAYERS.slice()
    };
    MODELS.forEach(function (model) {
      var m = {};
      PARTS.forEach(function (part) {
        var s = sizeFor(part, model);
        var entry = {
          size: s.slice(),
          pivot: PIVOTS[part].slice(),
          box: boxFor(part, model),
          inflate: { base: 0, overlay: part === 'head' ? 0.5 : 0.25 }
        };
        LAYERS.forEach(function (layer) {
          var o = ORIGINS[part][layer];
          entry[layer] = {
            origin: o.slice(),
            faces: unwrap(o[0], o[1], s[0], s[1], s[2])
          };
        });
        m[part] = entry;
      });
      net[model] = m;
    });
    return deepFreeze(net);
  }

  var NET = buildNet();

  // ---- small helpers -------------------------------------------------------
  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function ctx2d(canvas) {
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }
  // Error whose .message is the i18n KEY (per contract) and .friendly is the
  // translated text for toasts.
  function skinError(key, fallback) {
    var e = new Error(key);
    e.friendly = (typeof I18n !== 'undefined') ? I18n.t(key, fallback) : fallback;
    return e;
  }
  function drawableSize(src) {
    return {
      w: src.naturalWidth || src.videoWidth || src.width || 0,
      h: src.naturalHeight || src.videoHeight || src.height || 0
    };
  }

  // ---- normalize / legacy conversion --------------------------------------

  // Any accepted drawable -> fresh canonical 64x64 canvas.
  // Throws Error('vox.err.badSkin') on wrong dimensions.
  function normalize(src) {
    if (src && src.canvas && typeof src.canvas.getContext === 'function') {
      src = src.canvas; // tolerate a Skins skin object
    }
    var d = drawableSize(src);
    if (d.w === 64 && d.h === 64) {
      var c = makeCanvas(64, 64);
      ctx2d(c).drawImage(src, 0, 0);
      return c;
    }
    if (d.w === 64 && d.h === 32) return convertLegacy(src);
    throw skinError('vox.err.badSkin',
      'Not a valid Minecraft skin — expected a 64×64 or 64×32 PNG.');
  }

  // Legacy 64x32 -> 64x64 (§5.7): copy the whole sheet to the top half, then
  // synthesize the left limbs by mirroring the right limbs — every face is
  // horizontally flipped and the box's right/left faces swap places. Overlay
  // regions below y=32 stay transparent.
  var MIRROR_FACE = {
    top: 'top', bottom: 'bottom', front: 'front',
    back: 'back', right: 'left', left: 'right'
  };
  function convertLegacy(src) {
    var out = makeCanvas(64, 64);
    var ctx = ctx2d(out);
    ctx.drawImage(src, 0, 0);
    mirrorLimb(ctx, src, 'rightArm', 'leftArm');
    mirrorLimb(ctx, src, 'rightLeg', 'leftLeg');
    return out;
  }
  function mirrorLimb(ctx, src, srcPart, dstPart) {
    var sFaces = NET.classic[srcPart].base.faces;
    var dFaces = NET.classic[dstPart].base.faces;
    Object.keys(MIRROR_FACE).forEach(function (f) {
      var s = sFaces[f];
      var d = dFaces[MIRROR_FACE[f]];
      ctx.save();
      ctx.translate(d.x + d.w, d.y);   // flip inside the destination rect
      ctx.scale(-1, 1);
      ctx.drawImage(src, s.x, s.y, s.w, s.h, 0, 0, d.w, d.h);
      ctx.restore();
    });
  }

  // ---- slim/classic auto-detect (§5.7) -------------------------------------
  // Slim iff ALL six probe pixels are fully transparent — the columns a
  // classic right-arm back face uses but a slim skin leaves empty.
  var SLIM_PROBES = [[54, 20], [55, 20], [54, 26], [55, 26], [54, 31], [55, 31]];
  function detectModel(canvas64) {
    if (canvas64 && canvas64.canvas &&
        typeof canvas64.canvas.getContext === 'function') {
      canvas64 = canvas64.canvas; // tolerate a skin object
    }
    if (!canvas64 || typeof canvas64.getContext !== 'function') {
      canvas64 = normalize(canvas64); // tolerate an Image
    }
    var data = canvas64.getContext('2d').getImageData(54, 20, 2, 12).data;
    for (var i = 0; i < SLIM_PROBES.length; i++) {
      var px = SLIM_PROBES[i][0] - 54;
      var py = SLIM_PROBES[i][1] - 20;
      if (data[(py * 2 + px) * 4 + 3] !== 0) return 'classic';
    }
    return 'slim';
  }

  // ---- loading --------------------------------------------------------------
  function makeSkin(canvas, model) {
    return {
      canvas: canvas,
      model: model,
      dataURL: function () { return canvas.toDataURL('image/png'); }
    };
  }

  function loadImageURL(url, resolve, reject) {
    var img = new Image();
    // Non-data URLs get crossOrigin so a CORS-served remote skin does not
    // taint the canvas (harmless for same-origin/relative URLs).
    if (!/^data:/i.test(url)) img.crossOrigin = 'anonymous';
    img.onload = function () { resolve(img); };
    img.onerror = function () {
      reject(skinError('vox.err.skinLoad', 'Could not load that skin image.'));
    };
    img.src = url;
  }

  // Resolve any accepted source into something drawImage understands.
  function toDrawable(src) {
    return new Promise(function (resolve, reject) {
      if (src && src.canvas && typeof src.canvas.getContext === 'function') {
        src = src.canvas; // a Skins skin object
      }
      if (!src) {
        reject(skinError('vox.err.badSkin', 'No skin image given.'));
      } else if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) {
        resolve(src);
      } else if (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas) {
        resolve(src);
      } else if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) {
        resolve(src);
      } else if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) {
        if (src.complete && src.naturalWidth > 0) {
          resolve(src);
        } else {
          src.addEventListener('load', function () { resolve(src); }, { once: true });
          src.addEventListener('error', function () {
            reject(skinError('vox.err.skinLoad', 'Could not load that skin image.'));
          }, { once: true });
        }
      } else if (typeof Blob !== 'undefined' && src instanceof Blob) {
        var fr = new FileReader();
        fr.onload = function () { loadImageURL(String(fr.result), resolve, reject); };
        fr.onerror = function () {
          reject(skinError('vox.err.skinLoad', 'Could not read that file.'));
        };
        fr.readAsDataURL(src);
      } else if (typeof src === 'string') {
        loadImageURL(src, resolve, reject);
      } else {
        reject(skinError('vox.err.badSkin', 'Unsupported skin source.'));
      }
    });
  }

  // src: URL | dataURL | File/Blob | Image | canvas -> Promise<skin>.
  // Never throws synchronously; dimension errors reject with 'vox.err.badSkin'.
  function load(src) {
    return toDrawable(src).then(function (drawable) {
      var canvas = normalize(drawable);
      return makeSkin(canvas, detectModel(canvas));
    });
  }

  // The shipped default skin; procedural fallback if the fetch fails (e.g.
  // file:// dev, offline, asset missing). Always model 'classic'.
  function loadDefault() {
    return fetch('assets/skins/default.png')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) { return load(blob); })
      .catch(function () { return load(getFallbackPNG()); })
      .then(function (skin) { skin.model = 'classic'; return skin; });
  }

  // ---- procedural fallback skin ("emergency Clobi") ------------------------
  // Drawn from NET regions so it is always layout-correct: dark hair, tan
  // skin, teal shirt, blue pants, dark shoes. Base layer fully opaque so the
  // slim probe reads 'classic'; overlay left transparent.
  var FACE_SHADE = { top: 1.08, front: 1.0, left: 0.93, right: 0.88, back: 0.8, bottom: 0.7 };
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    var g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    var b = Math.min(255, Math.round((n & 255) * f));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function paintBox(ctx, faces, color) {
    Object.keys(FACE_SHADE).forEach(function (f) {
      var r = faces[f];
      ctx.fillStyle = shade(color, FACE_SHADE[f]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    });
  }
  function paintRows(ctx, rect, color, fromRow, nRows, face) {
    ctx.fillStyle = shade(color, FACE_SHADE[face]);
    ctx.fillRect(rect.x, rect.y + fromRow, rect.w, nRows);
  }
  function paintPx(ctx, rect, dx, dy, color) {
    ctx.fillStyle = color;
    ctx.fillRect(rect.x + dx, rect.y + dy, 1, 1);
  }
  function buildFallbackCanvas() {
    var SKIN = '#D19A6E', HAIR = '#31251F', SHIRT = '#1F9E9B';
    var PANTS = '#3B5FA0', SHOE = '#3A3A40';
    var c = makeCanvas(64, 64);
    var ctx = ctx2d(c);
    var net = NET.classic;

    // head: skin all around + hair cap + a simple friendly face
    var hf = net.head.base.faces;
    paintBox(ctx, hf, SKIN);
    ctx.fillStyle = shade(HAIR, FACE_SHADE.top);
    ctx.fillRect(hf.top.x, hf.top.y, hf.top.w, hf.top.h);
    paintRows(ctx, hf.back, HAIR, 0, 3, 'back');
    paintRows(ctx, hf.right, HAIR, 0, 2, 'right');
    paintRows(ctx, hf.left, HAIR, 0, 2, 'left');
    paintRows(ctx, hf.front, HAIR, 0, 1, 'front');
    paintPx(ctx, hf.front, 1, 3, shade(HAIR, 1)); // brows
    paintPx(ctx, hf.front, 2, 3, shade(HAIR, 1));
    paintPx(ctx, hf.front, 5, 3, shade(HAIR, 1));
    paintPx(ctx, hf.front, 6, 3, shade(HAIR, 1));
    paintPx(ctx, hf.front, 1, 4, '#FFFFFF');      // eyes
    paintPx(ctx, hf.front, 2, 4, '#3D64C6');
    paintPx(ctx, hf.front, 5, 4, '#3D64C6');
    paintPx(ctx, hf.front, 6, 4, '#FFFFFF');
    paintPx(ctx, hf.front, 3, 5, shade(SKIN, 0.85)); // nose
    paintPx(ctx, hf.front, 4, 5, shade(SKIN, 0.85));
    paintPx(ctx, hf.front, 3, 6, '#9C6650');      // mouth
    paintPx(ctx, hf.front, 4, 6, '#9C6650');

    // body: teal shirt with a pants-colored belt, pants-colored underside
    var bf = net.body.base.faces;
    paintBox(ctx, bf, SHIRT);
    ['front', 'back', 'left', 'right'].forEach(function (f) {
      paintRows(ctx, bf[f], PANTS, 10, 2, f);
    });
    ctx.fillStyle = shade(PANTS, FACE_SHADE.bottom);
    ctx.fillRect(bf.bottom.x, bf.bottom.y, bf.bottom.w, bf.bottom.h);

    // arms: short teal sleeves over skin, lighter palm underneath
    ['rightArm', 'leftArm'].forEach(function (part) {
      var af = net[part].base.faces;
      paintBox(ctx, af, SKIN);
      ['front', 'back', 'left', 'right'].forEach(function (f) {
        paintRows(ctx, af[f], SHIRT, 0, 4, f);
      });
      ctx.fillStyle = shade(SHIRT, FACE_SHADE.top);
      ctx.fillRect(af.top.x, af.top.y, af.top.w, af.top.h);
      ctx.fillStyle = shade('#DCA97E', 0.92);
      ctx.fillRect(af.bottom.x, af.bottom.y, af.bottom.w, af.bottom.h);
    });

    // legs: blue pants with dark shoes
    ['rightLeg', 'leftLeg'].forEach(function (part) {
      var lf = net[part].base.faces;
      paintBox(ctx, lf, PANTS);
      ['front', 'back', 'left', 'right'].forEach(function (f) {
        paintRows(ctx, lf[f], SHOE, 10, 2, f);
      });
      ctx.fillStyle = shade(SHOE, FACE_SHADE.bottom);
      ctx.fillRect(lf.bottom.x, lf.bottom.y, lf.bottom.w, lf.bottom.h);
    });
    return c;
  }
  var _fallbackURL = null;
  function getFallbackPNG() {
    if (!_fallbackURL) _fallbackURL = buildFallbackCanvas().toDataURL('image/png');
    return _fallbackURL;
  }

  // ---- GPU upload ------------------------------------------------------------
  // NEAREST both filters, CLAMP both axes, no mips, flipY=false, premult=false.
  function texture(gl, skin) {
    var src = (skin && skin.canvas) ? skin.canvas : skin;
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // ---- studio template + reverse lookup --------------------------------------
  // Distinct hue per part, lighter shade per face, overlay at 55% alpha of the
  // same hue family, unused pixels fully transparent. Generated from NET.
  var PART_HUE = {
    head: 356, body: 205, rightArm: 130,
    leftArm: 275, rightLeg: 32, leftLeg: 168
  };
  var FACE_LIGHT = { top: 71, front: 56, left: 63, right: 47, back: 38, bottom: 27 };
  function templateCanvas(model) {
    var net = NET[model === 'slim' ? 'slim' : 'classic'];
    var c = makeCanvas(64, 64);
    var ctx = ctx2d(c);
    PARTS.forEach(function (part) {
      LAYERS.forEach(function (layer) {
        var faces = net[part][layer].faces;
        var alpha = layer === 'overlay' ? 0.55 : 1;
        Object.keys(FACE_LIGHT).forEach(function (f) {
          var r = faces[f];
          ctx.fillStyle = 'hsla(' + PART_HUE[part] + ',78%,' + FACE_LIGHT[f] + '%,' + alpha + ')';
          ctx.fillRect(r.x, r.y, r.w, r.h);
        });
      });
    });
    return c;
  }

  // Which net region does pixel (x,y) belong to? -> {part, layer, face} | null.
  function regionAt(x, y, model) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x > 63 || y > 63) return null;
    var net = NET[model === 'slim' ? 'slim' : 'classic'];
    for (var p = 0; p < PARTS.length; p++) {
      for (var l = 0; l < LAYERS.length; l++) {
        var faces = net[PARTS[p]][LAYERS[l]].faces;
        for (var f in faces) {
          var r = faces[f];
          if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
            return { part: PARTS[p], layer: LAYERS[l], face: f };
          }
        }
      }
    }
    return null;
  }

  // ---- public API -------------------------------------------------------------
  var api = {
    NET: NET,
    load: load,
    loadDefault: loadDefault,
    detectModel: detectModel,
    convertLegacy: convertLegacy,
    normalize: normalize,
    texture: texture,
    templateCanvas: templateCanvas,
    regionAt: regionAt
  };
  // Lazy so merely loading this file never touches the DOM (also keeps the
  // module testable outside a browser).
  Object.defineProperty(api, 'FALLBACK_PNG', {
    get: getFallbackPNG,
    enumerable: true
  });
  return api;
})();

window.Skins = Skins;
