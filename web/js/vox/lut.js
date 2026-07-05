// lut.js -- the signature "CLOBI POP" color-grading LUT. Single global: LUT.
//
// Generates a 32^3 color lookup table baked into a 1024x32 canvas (32 slices of
// 32x32 laid side by side; slice index = blue channel). The grade is what gives
// the game its identity: punchy teal-orange with protected greens and skin:
//   - filmic S-curve applied on luma (contrast without hue distortion),
//   - vibrance (saturation boost that favours LOW-saturation pixels),
//   - split-toning: shadows pushed ~8% toward teal rgb(26,107,115),
//     highlights ~6% toward warm rgb(255,208,138) -- luma-preserving,
//   - greens + skin hues protected from the split-tone hue shift,
//   - blacks lifted +0.02 for that soft filmic floor.
//
//   LUT.SIZE = 32
//   LUT.generateCanvas() -> canvas(1024x32)   // deterministic, cached
//   LUT.texture(gl)      -> WebGLTexture      // LINEAR/LINEAR, clamp (via GLX)
//   LUT.shaderSnippet()  -> GLSL 'vec3 applyLUT(sampler2D lut, vec3 c)'
//                           // samples two z-slices, fract(blue) mix, half-texel correct
//
// Depends on: GLX (texture upload; soft-guarded with a raw-GL fallback).
// No user-visible strings. No ES modules, no frameworks -- one global.

const LUT = (function () {
  'use strict';

  const SIZE = 32;                      // 32x32x32 lattice
  const CANVAS_W = SIZE * SIZE;         // 1024
  const CANVAS_H = SIZE;                // 32

  // ---- grade tuning constants ---------------------------------------------
  const S_CURVE_AMT = 0.55;             // filmic S strength on luma
  const VIBRANCE = 0.22;                // max saturation boost (low-sat pixels)
  const SHADOW_TONE = [26 / 255, 107 / 255, 115 / 255];   // teal
  const HIGHLIGHT_TONE = [255 / 255, 208 / 255, 138 / 255]; // warm gold
  const SHADOW_AMT = 0.08;              // ~8% toward teal in shadows
  const HIGHLIGHT_AMT = 0.06;           // ~6% toward warm in highlights
  const BLACK_LIFT = 0.02;              // lifted blacks

  let cachedCanvas = null;              // generateCanvas() result (deterministic)
  const texCache = [];                  // [{gl, tex}] one texture per GL context

  // ---- small color helpers -------------------------------------------------
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function luma709(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  // Gentle filmic S: raise mid contrast, soft toe/shoulder.
  function sCurve(x) {
    const s = x * x * (3 - 2 * x);      // smoothstep as the S backbone
    return x + (s - x) * S_CURVE_AMT;
  }

  // Hue (degrees 0..360) + saturation (0..1, HSV style) of a pixel.
  function hueSat(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-5) return { h: 0, s: 0 };
    let h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    return { h: h, s: mx > 0 ? d / mx : 0 };
  }

  // Trapezoid window: 0 below a / above d, ramps a..b and c..d, 1 between b..c.
  function trap(v, a, b, c, d) {
    if (v <= a || v >= d) return 0;
    if (v < b) return (v - a) / (b - a);
    if (v <= c) return 1;
    return (d - v) / (d - c);
  }

  // How strongly this hue must be protected from the split-tone hue shift.
  // Greens (foliage identity) and skin tones (players' faces) stay put.
  function hueProtection(h, s) {
    const green = trap(h, 70, 95, 150, 175);
    // skin: warm low-mid hues at moderate saturation only
    const skinHue = trap(h, 8, 18, 42, 55);
    const skinSat = trap(s * 100, 3, 10, 55, 80);
    const skin = skinHue * skinSat;
    return Math.min(1, Math.max(green, skin));
  }

  // ---- the CLOBI POP grade for a single color ------------------------------
  function gradePixel(r, g, b) {
    // protection is judged on the ORIGINAL hue, before any shifting
    const hs = hueSat(r, g, b);
    const prot = hueProtection(hs.h, hs.s);

    // 1) filmic S-curve on luma (scale RGB so hue is preserved)
    const l0 = luma709(r, g, b);
    let scale = sCurve(l0) / Math.max(l0, 1e-4);
    if (scale > 4) scale = 4;           // don't explode chroma near black
    r = clamp01(r * scale); g = clamp01(g * scale); b = clamp01(b * scale);

    // 2) vibrance: push saturation, harder on drab pixels
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    const l1 = luma709(r, g, b);
    const vib = 1 + VIBRANCE * (1 - Math.min(1, sat * 1.7));
    r = clamp01(l1 + (r - l1) * vib);
    g = clamp01(l1 + (g - l1) * vib);
    b = clamp01(l1 + (b - l1) * vib);

    // 3) split-tone (luma-preserving => pure hue/sat move, hence protectable)
    const l2 = luma709(r, g, b);
    const shadowW = (1 - l2) * (1 - l2);
    const highW = Math.pow(l2, 2.2);
    const sAmt = SHADOW_AMT * shadowW * (1 - prot);
    const hAmt = HIGHLIGHT_AMT * highW * (1 - prot);
    let tr = r + (SHADOW_TONE[0] - r) * sAmt + (HIGHLIGHT_TONE[0] - r) * hAmt;
    let tg = g + (SHADOW_TONE[1] - g) * sAmt + (HIGHLIGHT_TONE[1] - g) * hAmt;
    let tb = b + (SHADOW_TONE[2] - b) * sAmt + (HIGHLIGHT_TONE[2] - b) * hAmt;
    // restore original luma so toning never brightens/darkens
    const l3 = luma709(tr, tg, tb);
    let corr = l2 / Math.max(l3, 1e-4);
    if (corr > 2) corr = 2;
    r = clamp01(tr * corr); g = clamp01(tg * corr); b = clamp01(tb * corr);

    // 4) lifted blacks
    r = BLACK_LIFT + r * (1 - BLACK_LIFT);
    g = BLACK_LIFT + g * (1 - BLACK_LIFT);
    b = BLACK_LIFT + b * (1 - BLACK_LIFT);
    return [r, g, b];
  }

  // ---- canvas baking --------------------------------------------------------
  function generateCanvas() {
    if (cachedCanvas) return cachedCanvas;
    const cv = document.createElement('canvas');
    cv.width = CANVAS_W;
    cv.height = CANVAS_H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(CANVAS_W, CANVAS_H);
    const data = img.data;
    const inv = 1 / (SIZE - 1);

    // pixel (x, y): slice = floor(x/32) = blue, x%32 = red, y = green
    for (let slice = 0; slice < SIZE; slice++) {
      const bIn = slice * inv;
      for (let y = 0; y < SIZE; y++) {
        const gIn = y * inv;
        let o = (y * CANVAS_W + slice * SIZE) * 4;
        for (let x = 0; x < SIZE; x++) {
          const rgb = gradePixel(x * inv, gIn, bIn);
          data[o] = Math.round(rgb[0] * 255);
          data[o + 1] = Math.round(rgb[1] * 255);
          data[o + 2] = Math.round(rgb[2] * 255);
          data[o + 3] = 255;
          o += 4;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    cachedCanvas = cv;
    return cv;
  }

  // ---- GPU upload -----------------------------------------------------------
  function texture(gl) {
    for (let i = 0; i < texCache.length; i++) {
      if (texCache[i].gl === gl) return texCache[i].tex;
    }
    const cv = generateCanvas();
    let tex;
    if (typeof GLX !== 'undefined' && GLX.texture2D) {
      tex = GLX.texture2D(gl, { canvas: cv, filter: 'linear', wrap: 'clamp' });
    } else {
      // raw fallback (GLX should always be loaded before us, per load order)
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    texCache.push({ gl: gl, tex: tex });
    return tex;
  }

  // ---- shader snippet --------------------------------------------------------
  // Two adjacent blue slices are fetched and mixed by fract(blue). All lookups
  // are half-texel corrected so lattice points land exactly on texel centers.
  function shaderSnippet() {
    return [
      'vec3 applyLUT(sampler2D lut, vec3 c) {',
      '  vec3 cc = clamp(c, 0.0, 1.0);',
      '  float b = cc.b * 31.0;',
      '  float s0 = floor(b);',
      '  float s1 = min(s0 + 1.0, 31.0);',
      '  float f = b - s0;',
      '  float y = (cc.g * 31.0 + 0.5) / 32.0;',
      '  float x = (cc.r * 31.0 + 0.5) / 1024.0;',
      '  float w = 32.0 / 1024.0;',
      '  vec3 col0 = texture(lut, vec2(s0 * w + x, y)).rgb;',
      '  vec3 col1 = texture(lut, vec2(s1 * w + x, y)).rgb;',
      '  return mix(col0, col1, f);',
      '}'
    ].join('\n');
  }

  // ---- public API -------------------------------------------------------------
  return {
    SIZE: SIZE,
    generateCanvas: generateCanvas,
    texture: texture,
    shaderSnippet: shaderSnippet
  };
})();

window.LUT = LUT;
