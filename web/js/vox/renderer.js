// renderer.js -- the full WebGL2 frame pipeline. Single global: Renderer.
//
// Owns every GPU pass of a frame (Game orchestrates the order):
//   beginFrame  -> bind scene FBO (canvas*dpr, dpr capped at 2), clear to fog
//   drawSky     -> fullscreen ray-dir quad: gradient, sun disc+glow, moon, stars
//   drawChunks('opaque')      -> solid + cutout terrain (frustum culled)
//   (Game draws entities via PlayerModel here)
//   drawSelection             -> wireframe box + 5-stage procedural crack decal
//   drawChunks('translucent') -> water, back-to-front, no depth write, uv wobble
//   drawClouds  -> one big scrolling quad at y=118, value-noise blobs, fogged
//   endFrame    -> post pass to the default framebuffer: filmic tonemap,
//                  vibrance, gamma, CLOBI-POP LUT (LUT.shaderSnippet()),
//                  underwater tint+wobble, subtle vignette
//
// Also home of computeEnv(timeTicks, renderDist): the day/night color script
// (dawn 22200-1800, day, dusk 10200-13800, night -- widened per Part III §14
// for a fuller golden-hour moment, was a narrower ±1000-tick band around each
// peak) with the sun rotating in the X/Y plane, a moon opposite it + fading
// procedural stars (Part III §13), and fog pinned to renderDist (start 0.72,
// end 1.15 of the range -- pushed out from 0.55/0.92 per Part III §2's fix
// for fog washing distant terrain to near-white at low render distances).
//
// Chunk meshes are registered via uploadChunkMesh(cx, cz, meshData) (from
// Mesher.meshChunk) and kept in a Map 'cx,cz' -> {VAOs, counts, aabb}; culling
// uses M3.frustumFromMatrix / M3.frustumTestAABB.
//
// Renderer owns ALL of its GL state changes and leaves state clean after
// endFrame: depth test ON, depth writes ON, blend OFF, cull OFF.
//
// Depends on: GLX (programs/VAOs/FBO/textures), M3 (matrices/frustum),
// LUT (shader snippet), and optionally Blocks (only via the atlas handed in).
// No user-visible strings. No ES modules, no frameworks -- one global.

const Renderer = (function () {
  'use strict';

  // ---- internal state -------------------------------------------------------
  let gl = null;
  let atlasTex = null;                 // WebGLTexture (from Blocks.buildAtlas)
  let lutTex = null;                   // WebGLTexture (from LUT.texture)
  let fsq = null;                      // shared fullscreen quad (GLX)
  let sceneFbo = null;                 // {fb, colorTex, ...} scene render target
  let pixelW = 0, pixelH = 0;          // FBO/backbuffer size in device px
  let t0 = 0;                          // time origin (float-precision-friendly)

  const progs = {};                    // name -> WebGLProgram
  const U = {};                        // name -> {uniformName: location}

  const meshes = new Map();            // 'cx,cz' -> chunk mesh entry
  let selVao = null;                   // wireframe box (LINES, 24 verts)
  let crackVao = null;                 // unit cube faces (36 verts, pos+uv)
  let cloudVao = null;                 // one quad (6 verts, vec2)
  let crackTex = null;                 // 80x16 strip, 5 stages of 16x16
  let cloudTex = null;                 // 256x256 tiling value-noise blobs

  const planes = new Float32Array(24); // scratch frustum planes
  const invPV = new Float32Array(16);  // scratch inverse projView
  let sortScratch = [];                // translucent draw-order scratch

  const CLOUD_Y = 118;
  const CLOUD_RANGE = 640;

  // ---- day/night keyframe states (see ARCHITECTURE-3D.md section 7, polished
  // per ARCHITECTURE-COMBAT.md §13/§14) ----------
  const ENV_DAY = {
    skyTop: [0.239, 0.545, 1.0],       // #3D8BFF
    horizon: [0.749, 0.890, 1.0],      // #BFE3FF
    sun: [1.0, 0.98, 0.92],
    ambient: 0.55,
    night: 0.0
  };
  // Golden-hour peak (Part III §14: "widen and warm... a bit more saturated
  // orange/pink at the sun-near-horizon moment" -- the single prettiest beat
  // of the cycle, so it gets richer saturation + a warmer magenta-pink top
  // and a slightly hotter, more saturated horizon/sun than the Part I values).
  const ENV_GOLD = {                   // sunrise / sunset
    skyTop: [0.46, 0.22, 0.50],        // warmer magenta-pink top (was 0.42/0.26/0.55)
    horizon: [1.0, 0.522, 0.184],      // #FF8530 -- hotter, more saturated orange
    sun: [1.0, 0.49, 0.20],
    ambient: 0.36,
    night: 0.08
  };
  const ENV_NIGHT = {
    skyTop: [0.039, 0.071, 0.188],     // #0A1230
    horizon: [0.075, 0.11, 0.24],
    sun: [0.22, 0.27, 0.42],           // moonlight
    ambient: 0.16,
    night: 1.0
  };

  // ---- tiny uniform helpers (missing = optimized out -> silently skipped) ----
  function u1f(us, n, v) { if (us[n]) gl.uniform1f(us[n], v); }
  function u1i(us, n, v) { if (us[n]) gl.uniform1i(us[n], v); }
  function u3f(us, n, a, b, c) { if (us[n]) gl.uniform3f(us[n], a, b, c); }
  function u3fv(us, n, v) { if (us[n]) gl.uniform3f(us[n], v[0], v[1], v[2]); }
  function uM4(us, n, m) { if (us[n]) gl.uniformMatrix4fv(us[n], false, m); }

  function nowSec() { return (performance.now() - t0) / 1000; }

  // ---- shader sources ---------------------------------------------------------
  const VS_FSQ = [
    '#version 300 es',
    'layout(location=0) in vec2 aPos;',
    'out vec2 vNDC;',
    'void main() { vNDC = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  // Part III §13/§14: real moon (soft glow, simple lit-half, geometrically
  // gated on dot(sunDir,up)<~0.05 rather than the old env.night proxy, smooth-
  // stepped so it fades rather than pops) + procedural stars whose density
  // AND brightness both ramp in with a smoothstep of "how far past dusk" the
  // current sun altitude is (not a hard >0.02 cutoff) so dusk->night reads as
  // a gradual reveal. uSunDir.y IS dot(sunDir, up) since up=(0,1,0) -- no new
  // uniform needed, uSunDir is already bound every frame.
  const FS_SKY = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vNDC;',
    'uniform mat4 uInvPV;',
    'uniform vec3 uCamPos, uSunDir, uSkyTop, uSkyHorizon, uSunColor;',
    'uniform float uNight, uTicks;',
    'out vec4 outColor;',
    'void main() {',
    '  vec4 p = uInvPV * vec4(vNDC, 1.0, 1.0);',
    '  vec3 dir = normalize(p.xyz / p.w - uCamPos);',
    '  float h = clamp(dir.y, -1.0, 1.0);',
    '  vec3 col = mix(uSkyHorizon, uSkyTop, pow(clamp(h, 0.0, 1.0), 0.55));',
    // NOTE: GLSL smoothstep(edge0,edge1,x) is spec-undefined when edge0>=
    // edge1, so a below-the-horizon darken (wants HIGH output at LOW h) is
    // written as 1-smoothstep(loEdge,hiEdge,h) with edges correctly ordered,
    // never as a reversed-edge smoothstep call (same fix applied to the new
    // moon/star gates below, for the same reason).
    '  col = mix(col, uSkyHorizon * 0.82, 1.0 - smoothstep(-0.35, 0.0, h));',
    '  float d = dot(dir, uSunDir);',
    '  float disc = smoothstep(0.99955, 0.99985, d);',
    '  float glow = pow(clamp(d, 0.0, 1.0), 180.0) * 0.45',
    '             + pow(clamp(d, 0.0, 1.0), 8.0) * 0.08;',
    '  col += uSunColor * (disc * 1.2 + glow);',
    // moon: geometric visibility gate is the sun's altitude crossing the
    // horizon (dot(sunDir,up) = uSunDir.y), smoothstepped over a small band
    // around the ~0.05 threshold so it eases in/out with dusk/dawn rather
    // than snapping the instant the sun's y goes negative. Wants HIGH output
    // at LOW uSunDir.y -> invert a correctly-ordered smoothstep (see NOTE above).
    '  float belowHorizon = 1.0 - smoothstep(-0.05, 0.10, uSunDir.y);',
    '  vec3 moonDir = -uSunDir;',
    '  float md = dot(dir, moonDir);',
    '  float moonMask = smoothstep(0.99975, 0.99991, md);',
    '  if (moonMask > 0.0001) {',
    '    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), moonDir) + vec3(0.0001, 0.0, 0.0));',
    '    vec3 onMoon = dir - moonDir * md;',
    '    float lu = dot(onMoon, right) * 340.0;',               // simple lit-half terminator
    '    float lit = smoothstep(-0.35, 0.45, lu);',
    '    vec3 moonCol = mix(vec3(0.30, 0.32, 0.40), vec3(0.92, 0.94, 1.0), lit);',
    '    col += moonCol * moonMask * belowHorizon;',
    '  }',
    '  col += vec3(0.60, 0.70, 0.90) * pow(clamp(md, 0.0, 1.0), 300.0) * 0.14 * belowHorizon;', // soft glow halo
    // stars: dusk-depth factor ramps smoothly with how far past the horizon
    // the sun has sunk (belowHorizon itself is already a smoothstep of sun
    // altitude); use it to drive BOTH density (lower reveal threshold as it
    // grows) and brightness, so more stars visibly appear over the dusk->
    // night transition rather than the same star field just dimming.
    '  float duskDepth = smoothstep(-0.05, 0.55, -uSunDir.y);',
    '  if (duskDepth > 0.01 && dir.y > 0.0) {',
    '    vec2 sc = vec2(atan(dir.x, dir.z), asin(h)) * 57.3;',
    '    vec2 cell = floor(sc);',
    '    vec2 f = fract(sc);',
    '    float hh = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453123);',
    '    vec2 sp = fract(vec2(hh * 13.73, hh * 7.31)) * 0.8 + 0.1;',
    '    float star = 1.0 - smoothstep(0.02, 0.10, length(f - sp));', // near sp -> 1 (see NOTE above re: edge order)
    '    float revealThresh = mix(0.985, 0.94, duskDepth);',      // density grows with duskDepth
    '    star *= smoothstep(revealThresh, revealThresh + 0.02, hh);',
    '    float tw = 0.7 + 0.3 * sin(uTicks * 0.02 + hh * 40.0);',
    '    col += vec3(star * tw) * duskDepth * smoothstep(0.0, 0.20, dir.y) * 0.85;',
    '  }',
    '  outColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  const VS_CHUNK = [
    '#version 300 es',
    'in vec3 aPos;',
    'in vec2 aUV;',
    'in float aShade;',
    'uniform mat4 uProjView;',
    'uniform vec3 uCamPos;',
    'out vec2 vUV;',
    'out float vShade;',
    'out float vDist;',
    'out vec3 vWorld;',
    'void main() {',
    '  vUV = aUV; vShade = aShade; vWorld = aPos;',
    '  vDist = distance(aPos, uCamPos);',
    '  gl_Position = uProjView * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  // Shared lighting + fog body for terrain; cutout discard lives in opaque only.
  const FS_CHUNK = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUV; in float vShade; in float vDist; in vec3 vWorld;',
    'uniform sampler2D uAtlas;',
    'uniform vec3 uSunColor, uFogColor;',
    'uniform float uAmbient, uFogStart, uFogEnd;',
    'out vec4 outColor;',
    'void main() {',
    '  vec4 tex = texture(uAtlas, vUV);',
    '  if (tex.a < 0.5) discard;',                                 // cutout pass
    '  vec3 lit;',
    '  if (vShade > 1.001) { lit = tex.rgb * min(vShade, 1.6); }', // emissive glow
    '  else { lit = tex.rgb * (uAmbient + uSunColor * vShade); }',
    '  float f = clamp((vDist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);',
    '  float fog = clamp(1.0 - exp2(-6.0 * f * f), 0.0, 1.0);',
    '  outColor = vec4(mix(lit, uFogColor, fog), 1.0);',
    '}'
  ].join('\n');

  const FS_WATER = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUV; in float vShade; in float vDist; in vec3 vWorld;',
    'uniform sampler2D uAtlas;',
    'uniform vec3 uSunColor, uFogColor, uCamPos;',
    'uniform float uAmbient, uFogStart, uFogEnd, uTime;',
    'out vec4 outColor;',
    'void main() {',
    // wobble the UV with time, clamped inside the block's own atlas tile
    '  vec2 tileBase = floor(vUV * 16.0) / 16.0;',
    '  vec2 wuv = vUV + vec2(sin(uTime * 1.7 + vWorld.x * 2.1 + vWorld.z * 1.3),',
    '                        cos(uTime * 1.4 + vWorld.z * 2.3 + vWorld.x * 0.7)) * 0.004;',
    '  wuv = clamp(wuv, tileBase + 0.5 / 256.0, tileBase + 1.0 / 16.0 - 0.5 / 256.0);',
    '  vec4 tex = texture(uAtlas, wuv);',
    '  vec3 lit = tex.rgb * (uAmbient + uSunColor * vShade);',
    // cheap fresnel: brighten at grazing view angles
    '  vec3 toCam = normalize(uCamPos - vWorld);',
    '  float grazing = 1.0 - abs(toCam.y);',
    '  lit *= 1.0 + 0.35 * grazing * grazing;',
    '  float f = clamp((vDist - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);',
    '  float fog = clamp(1.0 - exp2(-6.0 * f * f), 0.0, 1.0);',
    '  outColor = vec4(mix(lit, uFogColor, fog), 0.72);',
    '}'
  ].join('\n');

  const VS_SEL = [
    '#version 300 es',
    'in vec3 aPos;',
    'uniform mat4 uProjView;',
    'uniform vec3 uOffset;',
    'void main() {',
    '  vec3 p = uOffset + aPos * 1.004 - 0.002;',                  // slight inflate
    '  gl_Position = uProjView * vec4(p, 1.0);',
    '}'
  ].join('\n');

  const FS_SEL = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec3 uColor;',
    'out vec4 outColor;',
    'void main() { outColor = vec4(uColor, 1.0); }'
  ].join('\n');

  const VS_CRACK = [
    '#version 300 es',
    'in vec3 aPos;',
    'in vec2 aUV;',
    'uniform mat4 uProjView;',
    'uniform vec3 uOffset;',
    'uniform float uUVOff;',                                       // stage * 0.2
    'out vec2 vUV;',
    'void main() {',
    '  vUV = vec2(uUVOff + aUV.x * 0.2, aUV.y);',
    '  vec3 p = uOffset + 0.5 + (aPos - 0.5) * 1.002;',            // decal inflate
    '  gl_Position = uProjView * vec4(p, 1.0);',
    '}'
  ].join('\n');

  const FS_CRACK = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUV;',
    'uniform sampler2D uCrack;',
    'out vec4 outColor;',
    'void main() {',
    '  vec4 t = texture(uCrack, vUV);',
    '  if (t.a < 0.1) discard;',
    '  outColor = vec4(t.rgb, t.a * 0.85);',
    '}'
  ].join('\n');

  const VS_CLOUD = [
    '#version 300 es',
    'in vec2 aPos;',
    'uniform mat4 uProjView;',
    'uniform vec3 uCenter;',
    'uniform float uRange, uCloudY;',
    'out vec3 vWorld;',
    'out vec2 vLocal;',
    'void main() {',
    '  vec3 w = vec3(uCenter.x + aPos.x * uRange, uCloudY, uCenter.z + aPos.y * uRange);',
    '  vWorld = w; vLocal = aPos;',
    '  gl_Position = uProjView * vec4(w, 1.0);',
    '}'
  ].join('\n');

  const FS_CLOUD = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vWorld;',
    'in vec2 vLocal;',
    'uniform sampler2D uCloudTex;',
    'uniform vec3 uSunColor, uFogColor, uCamPos;',
    'uniform float uAmbient, uFogStart, uFogEnd, uTimeMs;',
    'out vec4 outColor;',
    'void main() {',
    '  vec2 uv = vWorld.xz * (1.0 / 380.0)',
    '          + vec2(uTimeMs * 0.0000045, uTimeMs * 0.0000021);', // slow wind drift
    '  float a = texture(uCloudTex, uv).a;',
    '  if (a < 0.01) discard;',
    '  vec3 col = mix(vec3(1.0), uSunColor, 0.30) * clamp(0.35 + uAmbient * 1.25, 0.0, 1.3);',
    '  float dist = distance(vWorld.xz, uCamPos.xz);',
    '  float f = clamp((dist - uFogStart * 1.6) / max(uFogEnd * 2.6 - uFogStart * 1.6, 1.0), 0.0, 1.0);',
    '  float fog = clamp(1.0 - exp2(-4.0 * f * f), 0.0, 1.0);',
    '  float edge = 1.0 - smoothstep(0.72, 1.0, max(abs(vLocal.x), abs(vLocal.y)));',
    '  outColor = vec4(mix(col, uFogColor, fog), a * 0.55 * edge);',
    '}'
  ].join('\n');

  function buildPostFS() {
    const lutFn = (typeof LUT !== 'undefined' && LUT.shaderSnippet)
      ? LUT.shaderSnippet()
      : 'vec3 applyLUT(sampler2D lut, vec3 c) { return c; }';
    return [
      '#version 300 es',
      'precision highp float;',
      'in vec2 vNDC;',
      'uniform sampler2D uScene;',
      'uniform sampler2D uLut;',
      'uniform float uLutAmount, uVibrance, uGamma, uUnderwater, uVignette, uTime;',
      'out vec4 outColor;',
      lutFn,
      'void main() {',
      '  vec2 vUV = vNDC * 0.5 + 0.5;',
      '  vec2 uv = vUV;',
      // underwater: subtle sine wobble (0.004)
      '  uv += vec2(sin(uv.y * 34.0 + uTime * 2.1),',
      '             cos(uv.x * 27.0 + uTime * 1.7)) * 0.004 * uUnderwater;',
      '  uv = clamp(uv, vec2(0.001), vec2(0.999));',
      '  vec3 c = texture(uScene, uv).rgb;',
      // Part III §2 fog fix: the filmic shoulder's brightness lift is eased
      // back slightly (1.30 -> 1.22) -- it was pushing already-bright pixels
      // (foggy/distant terrain, which sits close to the fog color and is
      // naturally light) hard against the 1.0 clip. Vibrance stays at its
      // full "vibrant realism" strength (uVibrance is untouched, still the
      // Part I default 0.18) but its (1-sat) weighting -- which boosts
      // ALREADY-DESATURATED pixels the most, i.e. exactly the washed-out
      // far-field fog case -- is curved with pow(...,1.4) so that boost
      // tapers off for near-zero-saturation pixels while barely changing it
      // for already-saturated up-close pixels (where 1-sat is small either
      // way): distant haze stays gently hazy instead of blowing out, and
      // up-close color keeps its full vivid punch.
      '  c = c / (c + 0.35) * 1.22;',                              // filmic tonemap
      '  float l = dot(c, vec3(0.299, 0.587, 0.114));',            // vibrance
      '  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));',
      '  float vibW = pow(clamp(1.0 - sat, 0.0, 1.0), 1.4);',
      '  c = clamp(vec3(l) + (c - vec3(l)) * (1.0 + uVibrance * vibW), 0.0, 1.0);',
      '  c = pow(c, vec3(1.0 / max(uGamma, 0.1)));',               // gamma
      '  vec3 graded = applyLUT(uLut, c);',                        // CLOBI POP
      '  c = mix(c, graded, uLutAmount);',
      '  c = mix(c, vec3(0.07, 0.24, 0.42), 0.30 * uUnderwater);', // deep blue tint
      '  float d = length(vUV - 0.5);',                            // vignette
      '  c *= 1.0 - uVignette * smoothstep(0.35, 0.78, d);',
      '  outColor = vec4(c, 1.0);',
      '}'
    ].join('\n');
  }

  // ---- procedural textures -----------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 5-stage crack strip: cumulative random-walk fractures on a 16x16 tile,
  // stages laid side by side in an 80x16 canvas (stage n = x offset n*16).
  function buildCrackCanvas() {
    const cv = document.createElement('canvas');
    cv.width = 80; cv.height = 16;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(80, 16);
    const rng = mulberry32(0xC10B1);
    const acc = new Float32Array(256);                             // cumulative alpha
    for (let s = 0; s < 5; s++) {
      const strokes = 2 + s * 2;
      for (let st = 0; st < strokes; st++) {
        let px = 3 + rng() * 10, py = 3 + rng() * 10;
        let ang = rng() * Math.PI * 2;
        const len = 6 + ((rng() * 8) | 0);
        for (let n = 0; n < len; n++) {
          const ix = Math.max(0, Math.min(15, px | 0));
          const iy = Math.max(0, Math.min(15, py | 0));
          acc[iy * 16 + ix] = Math.min(1, acc[iy * 16 + ix] + 0.9);
          if (rng() < 0.35) {                                      // widen a touch
            const jx = Math.max(0, Math.min(15, ix + (rng() < 0.5 ? 1 : -1)));
            acc[iy * 16 + jx] = Math.min(1, acc[iy * 16 + jx] + 0.45);
          }
          ang += (rng() - 0.5) * 1.2;
          px += Math.cos(ang); py += Math.sin(ang);
          if (px < 0.5 || px > 15.5 || py < 0.5 || py > 15.5) {
            px = 3 + rng() * 10; py = 3 + rng() * 10;
          }
        }
      }
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const o = (y * 80 + s * 16 + x) * 4;
          img.data[o] = 24; img.data[o + 1] = 20; img.data[o + 2] = 18;
          img.data[o + 3] = Math.round(Math.min(1, acc[y * 16 + x]) * 235);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // Tiling blobby cloud alpha map: 4-octave value noise, soft threshold.
  function buildCloudCanvas() {
    const N = 256;
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(N, N);
    function hash(x, y, p) {
      x = ((x % p) + p) % p; y = ((y % p) + p) % p;                // wrap = tiling
      let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(p, 1013)) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    }
    function vnoise(fx, fy, p) {
      const ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const a = hash(ix, iy, p), b = hash(ix + 1, iy, p);
      const c = hash(ix, iy + 1, p), d = hash(ix + 1, iy + 1, p);
      return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let n = 0, amp = 0.5, freq = 4;
        for (let o = 0; o < 4; o++) {
          n += vnoise(x / N * freq, y / N * freq, freq) * amp;
          amp *= 0.5; freq *= 2;
        }
        n /= 0.9375;                                               // normalize octaves
        let a = Math.max(0, Math.min(1, (n - 0.54) / 0.16));       // soft threshold
        a = a * a * (3 - 2 * a);
        const o4 = (y * N + x) * 4;
        img.data[o4] = 255; img.data[o4 + 1] = 255; img.data[o4 + 2] = 255;
        img.data[o4 + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // ---- static geometry -----------------------------------------------------------
  // Unit cube edges for the selection wireframe (24 verts, gl.LINES).
  const SEL_LINES = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0,
    0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 1
  ]);

  // Unit cube faces (pos + uv) for the crack decal: same CCW face layout as
  // the mesher so the decal hugs every face of the targeted block.
  function buildCrackGeometry() {
    const faces = [
      [[0, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [0, 0, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, -1], [0, 0, 0], [0, 1, 0], [1, 0, 0]],
      [[0, 0, 1], [0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 0, 0], [0, 0, 1], [0, 1, 0]]
    ];
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const tris = [0, 1, 2, 0, 2, 3];
    const pos = [], uv = [];
    for (let f = 0; f < 6; f++) {
      const o = faces[f][1], u = faces[f][2], v = faces[f][3];
      const c = [];
      for (let k = 0; k < 4; k++) {
        const du = corners[k][0], dv = corners[k][1];
        c.push([
          o[0] + u[0] * du + v[0] * dv,
          o[1] + u[1] * du + v[1] * dv,
          o[2] + u[2] * du + v[2] * dv
        ]);
      }
      for (let n = 0; n < 6; n++) {
        const k = tris[n];
        pos.push(c[k][0], c[k][1], c[k][2]);
        uv.push(corners[k][0], corners[k][1]);
      }
    }
    return { pos: new Float32Array(pos), uv: new Float32Array(uv) };
  }

  const CLOUD_QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

  // ---- env interpolation helpers ----------------------------------------------
  function smooth01(k) { return k * k * (3 - 2 * k); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function lerp3(a, b, k) {
    return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
  }
  function mixEnvState(a, b, k) {
    return {
      skyTop: lerp3(a.skyTop, b.skyTop, k),
      horizon: lerp3(a.horizon, b.horizon, k),
      sun: lerp3(a.sun, b.sun, k),
      ambient: lerp(a.ambient, b.ambient, k),
      night: lerp(a.night, b.night, k)
    };
  }

  // ---- scene FBO management -----------------------------------------------------
  function ensureFbo() {
    if (!pixelW || !pixelH) {
      pixelW = gl.drawingBufferWidth || 1;
      pixelH = gl.drawingBufferHeight || 1;
    }
    if (!sceneFbo) {
      sceneFbo = GLX.fbo(gl, pixelW, pixelH, { depth: true });
    } else if (sceneFbo.w !== pixelW || sceneFbo.h !== pixelH) {
      sceneFbo.resize(pixelW, pixelH);
    }
  }

  // ---- public: init / resize -----------------------------------------------------
  function init(glCtx, opts) {
    if (!glCtx) throw new Error('Renderer.init: missing WebGL2 context');
    if (typeof GLX === 'undefined' || typeof M3 === 'undefined') {
      throw new Error('Renderer.init: GLX and M3 must be loaded first');
    }
    gl = glCtx;
    opts = opts || {};
    atlasTex = (opts.atlas && opts.atlas.tex) ? opts.atlas.tex : opts.atlas || null;
    lutTex = opts.lutTex || null;
    t0 = performance.now();

    // programs + uniform tables
    progs.sky = GLX.program(gl, VS_FSQ, FS_SKY);
    progs.chunk = GLX.program(gl, VS_CHUNK, FS_CHUNK);
    progs.water = GLX.program(gl, VS_CHUNK, FS_WATER);
    progs.sel = GLX.program(gl, VS_SEL, FS_SEL);
    progs.crack = GLX.program(gl, VS_CRACK, FS_CRACK);
    progs.cloud = GLX.program(gl, VS_CLOUD, FS_CLOUD);
    progs.post = GLX.program(gl, VS_FSQ, buildPostFS());
    for (const name in progs) U[name] = GLX.uniforms(gl, progs[name]);

    // shared quad + static geometry
    fsq = GLX.fullscreenQuad(gl);
    selVao = GLX.vao(gl, progs.sel, [{ name: 'aPos', size: 3, data: SEL_LINES }]);
    const crackGeo = buildCrackGeometry();
    crackVao = GLX.vao(gl, progs.crack, [
      { name: 'aPos', size: 3, data: crackGeo.pos },
      { name: 'aUV', size: 2, data: crackGeo.uv }
    ]);
    cloudVao = GLX.vao(gl, progs.cloud, [{ name: 'aPos', size: 2, data: CLOUD_QUAD }]);

    // procedural textures
    crackTex = GLX.texture2D(gl, { canvas: buildCrackCanvas(), filter: 'nearest', wrap: 'clamp' });
    cloudTex = GLX.texture2D(gl, { canvas: buildCloudCanvas(), filter: 'linear', wrap: 'repeat' });

    if (!lutTex && typeof LUT !== 'undefined' && LUT.texture) lutTex = LUT.texture(gl);
  }

  function resize(w, h, dpr) {
    dpr = Math.min(Math.max(dpr || 1, 0.5), 2);                    // cap dpr at 2
    pixelW = Math.max(1, Math.round(w * dpr));
    pixelH = Math.max(1, Math.round(h * dpr));
    if (gl && gl.canvas) {
      if (gl.canvas.width !== pixelW) gl.canvas.width = pixelW;
      if (gl.canvas.height !== pixelH) gl.canvas.height = pixelH;
    }
    if (sceneFbo) sceneFbo.resize(pixelW, pixelH);
  }

  // ---- public: environment script -------------------------------------------------
  // Part III §14 polish: the dawn/dusk transition half-segments are widened
  // from 1000 to 1800 ticks each (was a narrow ~4.2% of the day; now a fuller
  // ~7.5% each side of the two true gold peaks at t=0 [sunrise] and t=12000
  // [sunset]) so golden hour reads as a real, lingering moment rather than a
  // quick flash. Every segment already blends via smooth01 (verified: at
  // each of the 6 boundaries below both the incoming segment's smooth01(1)
  // and the outgoing segment's smooth01(0) evaluate to slope 0, so the
  // composite is C1-continuous already -- no hard/linear cuts exist anywhere
  // in this script, nothing needed converting). Total still sums to 24000.
  const BAND = 1800;                    // half-segment width (was 1000)
  const DUSK1_START = 6000 + 4200;      // 10200 -- day fades toward sunset gold
  const DUSK_PEAK = 12000;              // true sunset instant (sun at horizon)
  const NIGHT_START = DUSK_PEAK + BAND; // 13800
  const NIGHT_END = 24000 - BAND;       // 22200 -- dawn gold begins approaching

  function computeEnv(timeTicks, renderDist) {
    const t = ((timeTicks % 24000) + 24000) % 24000;
    let st;
    if (t < BAND) {                                                // dawn 2nd half (gold -> day)
      st = mixEnvState(ENV_GOLD, ENV_DAY, smooth01(t / BAND));
    } else if (t < DUSK1_START) {                                  // day
      st = mixEnvState(ENV_DAY, ENV_DAY, 0);
    } else if (t < DUSK_PEAK) {                                    // dusk 1st half (day -> gold)
      st = mixEnvState(ENV_DAY, ENV_GOLD, smooth01((t - DUSK1_START) / (DUSK_PEAK - DUSK1_START)));
    } else if (t < NIGHT_START) {                                  // dusk 2nd half (gold -> night)
      st = mixEnvState(ENV_GOLD, ENV_NIGHT, smooth01((t - DUSK_PEAK) / BAND));
    } else if (t < NIGHT_END) {                                    // night
      st = mixEnvState(ENV_NIGHT, ENV_NIGHT, 0);
    } else {                                                       // dawn 1st half (night -> gold)
      st = mixEnvState(ENV_NIGHT, ENV_GOLD, smooth01((t - NIGHT_END) / BAND));
    }

    // sun rotates in the X/Y plane: rises +X (t=0), zenith at noon (t=6000)
    const theta = (t - 6000) / 24000 * Math.PI * 2;
    const sunDir = [-Math.sin(theta), Math.cos(theta), 0];

    const range = (renderDist || 4) * 16;
    // Part III §2 fog fix: push fogStart/fogEnd further out (was 0.55/0.92 of
    // range -- fog read as a wall at 60% of view distance and washed distant
    // terrain to near-white). Also deepen the fog/horizon colors ~12% (×0.88)
    // at all times of day so distant terrain reads as tinted-toward-sky haze
    // rather than washed-out white, while keeping every band's hue intact.
    const FOG_DEEPEN = 0.88;
    const fogColor = [st.horizon[0] * FOG_DEEPEN, st.horizon[1] * FOG_DEEPEN, st.horizon[2] * FOG_DEEPEN];
    const skyHorizon = [st.horizon[0] * FOG_DEEPEN, st.horizon[1] * FOG_DEEPEN, st.horizon[2] * FOG_DEEPEN];
    return {
      timeTicks: t,
      sunDir: sunDir,
      skyTop: st.skyTop,
      skyHorizon: skyHorizon,
      fogColor: fogColor,
      fogStart: range * 0.72,
      fogEnd: range * 1.15,
      sunColor: st.sun,
      ambient: st.ambient,
      underwater: false,
      night: st.night                                              // extra: for stars
    };
  }

  // ---- public: frame begin / sky ----------------------------------------------------
  function beginFrame(camera, env) {
    ensureFbo();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFbo.fb);
    gl.viewport(0, 0, sceneFbo.w, sceneFbo.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const fc = env.fogColor;
    gl.clearColor(fc[0], fc[1], fc[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  function drawSky(env, camera) {
    const us = U.sky;
    gl.useProgram(progs.sky);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    M3.mat4Invert(invPV, camera.projView);
    uM4(us, 'uInvPV', invPV);
    u3fv(us, 'uCamPos', camera.pos);
    const sd = env.sunDir;
    const sl = Math.hypot(sd[0], sd[1], sd[2]) || 1;
    u3f(us, 'uSunDir', sd[0] / sl, sd[1] / sl, sd[2] / sl);
    u3fv(us, 'uSkyTop', env.skyTop);
    u3fv(us, 'uSkyHorizon', env.skyHorizon);
    u3fv(us, 'uSunColor', env.sunColor);
    u1f(us, 'uNight', env.night !== undefined ? env.night : Math.max(0, (0.30 - env.ambient) / 0.14));
    u1f(us, 'uTicks', env.timeTicks || 0);
    fsq.draw(progs.sky);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  // ---- public: chunk meshes -----------------------------------------------------------
  function meshKey(cx, cz) { return cx + ',' + cz; }

  // Tight vertical bounds across both batches make frustum culling meaningful.
  function scanYBounds(entry, arrays) {
    let mn = 96, mx = 0, any = false;
    for (let a = 0; a < arrays.length; a++) {
      const pos = arrays[a];
      if (!pos) continue;
      for (let i = 1; i < pos.length; i += 3) {
        const v = pos[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        any = true;
      }
    }
    if (any) { entry.aabb[1] = mn - 0.1; entry.aabb[4] = mx + 0.1; }
  }

  function uploadChunkMesh(cx, cz, meshData) {
    dropChunkMesh(cx, cz);
    if (!meshData || meshData.empty) return;
    const entry = {
      cx: cx, cz: cz,
      opaqueVAO: null, opaqueCount: 0,
      transVAO: null, transCount: 0,
      aabb: [cx * 16, 0, cz * 16, cx * 16 + 16, 96, cz * 16 + 16],
      centerX: cx * 16 + 8, centerZ: cz * 16 + 8
    };
    const op = meshData.opaque, tr = meshData.translucent;
    if (op && op.count > 0) {
      entry.opaqueVAO = GLX.vao(gl, progs.chunk, [
        { name: 'aPos', size: 3, data: op.pos },
        { name: 'aUV', size: 2, data: op.uv },
        { name: 'aShade', size: 1, data: op.shade }
      ]);
      entry.opaqueCount = op.count;
    }
    if (tr && tr.count > 0) {
      entry.transVAO = GLX.vao(gl, progs.water, [
        { name: 'aPos', size: 3, data: tr.pos },
        { name: 'aUV', size: 2, data: tr.uv },
        { name: 'aShade', size: 1, data: tr.shade }
      ]);
      entry.transCount = tr.count;
    }
    if (!entry.opaqueVAO && !entry.transVAO) return;
    scanYBounds(entry, [op && op.pos, tr && tr.pos]);
    meshes.set(meshKey(cx, cz), entry);
  }

  function dropChunkMesh(cx, cz) {
    const key = meshKey(cx, cz);
    const entry = meshes.get(key);
    if (!entry) return;
    if (entry.opaqueVAO) entry.opaqueVAO.destroy();
    if (entry.transVAO) entry.transVAO.destroy();
    meshes.delete(key);
  }

  function setTerrainUniforms(us, camera, env) {
    uM4(us, 'uProjView', camera.projView);
    u3fv(us, 'uCamPos', camera.pos);
    u3fv(us, 'uSunColor', env.sunColor);
    u3fv(us, 'uFogColor', env.fogColor);
    u1f(us, 'uAmbient', env.ambient);
    u1f(us, 'uFogStart', env.fogStart);
    u1f(us, 'uFogEnd', env.fogEnd);
  }

  function drawChunks(camera, env, pass) {
    if (meshes.size === 0) return;
    M3.frustumFromMatrix(planes, camera.projView);

    if (pass === 'translucent') {
      const us = U.water;
      gl.useProgram(progs.water);
      setTerrainUniforms(us, camera, env);
      u1f(us, 'uTime', nowSec());
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      u1i(us, 'uAtlas', 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);                                         // no depth write
      gl.disable(gl.CULL_FACE);                                    // see from below

      // back-to-front by camera distance
      sortScratch.length = 0;
      const px = camera.pos[0], pz = camera.pos[2];
      meshes.forEach(function (e) {
        if (!e.transVAO) return;
        if (!M3.frustumTestAABB(planes, e.aabb[0], e.aabb[1], e.aabb[2], e.aabb[3], e.aabb[4], e.aabb[5])) return;
        const dx = e.centerX - px, dz = e.centerZ - pz;
        sortScratch.push({ e: e, d: dx * dx + dz * dz });
      });
      sortScratch.sort(function (a, b) { return b.d - a.d; });
      for (let n = 0; n < sortScratch.length; n++) {
        const e = sortScratch[n].e;
        e.transVAO.draw(e.transCount);
      }

      gl.depthMask(true);
      gl.disable(gl.BLEND);
      return;
    }

    // opaque + cutout
    const us = U.chunk;
    gl.useProgram(progs.chunk);
    setTerrainUniforms(us, camera, env);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    u1i(us, 'uAtlas', 0);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    meshes.forEach(function (e) {
      if (!e.opaqueVAO) return;
      if (!M3.frustumTestAABB(planes, e.aabb[0], e.aabb[1], e.aabb[2], e.aabb[3], e.aabb[4], e.aabb[5])) return;
      e.opaqueVAO.draw(e.opaqueCount);
    });
    gl.disable(gl.CULL_FACE);
  }

  // ---- public: selection box + crack decal ----------------------------------------------
  function drawSelection(camera, target) {
    if (!target || !target.hit) return;

    // 2px-ish black wireframe (lineWidth is best-effort on most GPUs)
    const us = U.sel;
    gl.useProgram(progs.sel);
    uM4(us, 'uProjView', camera.projView);
    u3f(us, 'uOffset', target.x, target.y, target.z);
    u3f(us, 'uColor', 0.0, 0.0, 0.0);
    try { gl.lineWidth(2); } catch (e) { /* clamped to 1 on many GPUs */ }
    selVao.draw(24, gl.LINES);

    // crack decal by break progress (5 stages)
    const progress = target.progress || 0;
    if (progress > 0.001) {
      const stage = Math.min(4, Math.floor(progress * 5));
      const uc = U.crack;
      gl.useProgram(progs.crack);
      uM4(uc, 'uProjView', camera.projView);
      u3f(uc, 'uOffset', target.x, target.y, target.z);
      u1f(uc, 'uUVOff', stage * 0.2);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, crackTex);
      u1i(uc, 'uCrack', 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1.0, -2.0);
      gl.depthMask(false);
      crackVao.draw(36);
      gl.depthMask(true);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
    }
  }

  // ---- public: clouds ---------------------------------------------------------------------
  function drawClouds(env, camera, timeMs) {
    const us = U.cloud;
    gl.useProgram(progs.cloud);
    uM4(us, 'uProjView', camera.projView);
    u3fv(us, 'uCenter', camera.pos);
    u1f(us, 'uRange', CLOUD_RANGE);
    u1f(us, 'uCloudY', CLOUD_Y);
    u3fv(us, 'uSunColor', env.sunColor);
    u3fv(us, 'uFogColor', env.fogColor);
    u3fv(us, 'uCamPos', camera.pos);
    u1f(us, 'uAmbient', env.ambient);
    u1f(us, 'uFogStart', env.fogStart);
    u1f(us, 'uFogEnd', env.fogEnd);
    u1f(us, 'uTimeMs', timeMs || 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cloudTex);
    u1i(us, 'uCloudTex', 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);                                      // double-sided
    cloudVao.draw(6);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // ---- public: post-process to the default framebuffer --------------------------------------
  function endFrame(postOpts) {
    const opts = postOpts || {};
    const lutAmount = opts.lutAmount !== undefined ? opts.lutAmount : 0.85;
    const vibrance = opts.vibrance !== undefined ? opts.vibrance : 0.18;
    const gamma = opts.gamma !== undefined ? opts.gamma : 1.0;
    const vignette = opts.vignette !== undefined ? opts.vignette : 0.15;
    const underwater = opts.underwater ? 1.0 : 0.0;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);

    const us = U.post;
    gl.useProgram(progs.post);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneFbo ? sceneFbo.colorTex : null);
    u1i(us, 'uScene', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    u1i(us, 'uLut', 1);
    u1f(us, 'uLutAmount', lutAmount);
    u1f(us, 'uVibrance', vibrance);
    u1f(us, 'uGamma', gamma);
    u1f(us, 'uUnderwater', underwater);
    u1f(us, 'uVignette', vignette);
    u1f(us, 'uTime', nowSec());
    fsq.draw(progs.post);

    // leave state clean: depth test on, depth writes on, blend off, cull off
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
  }

  // ---- public: teardown -----------------------------------------------------------------------
  function destroyAll() {
    if (!gl) return;
    meshes.forEach(function (e) {
      if (e.opaqueVAO) e.opaqueVAO.destroy();
      if (e.transVAO) e.transVAO.destroy();
    });
    meshes.clear();
    if (selVao) { selVao.destroy(); selVao = null; }
    if (crackVao) { crackVao.destroy(); crackVao = null; }
    if (cloudVao) { cloudVao.destroy(); cloudVao = null; }
    if (crackTex) { gl.deleteTexture(crackTex); crackTex = null; }
    if (cloudTex) { gl.deleteTexture(cloudTex); cloudTex = null; }
    if (sceneFbo) { sceneFbo.destroy(); sceneFbo = null; }
    for (const name in progs) {
      if (progs[name]) gl.deleteProgram(progs[name]);
      delete progs[name];
      delete U[name];
    }
    // atlasTex and lutTex are owned by their creators (Blocks / LUT) -- not deleted
    pixelW = 0; pixelH = 0;
  }

  // ---- public API -------------------------------------------------------------------------------
  return {
    init: init,
    resize: resize,
    beginFrame: beginFrame,
    computeEnv: computeEnv,
    drawSky: drawSky,
    uploadChunkMesh: uploadChunkMesh,
    dropChunkMesh: dropChunkMesh,
    drawChunks: drawChunks,
    drawSelection: drawSelection,
    drawClouds: drawClouds,
    endFrame: endFrame,
    destroyAll: destroyAll
  };
})();

window.Renderer = Renderer;
