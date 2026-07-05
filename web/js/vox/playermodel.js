// playermodel.js — dual-layer 3D player mesh + preview renderer.
// Single global: PlayerModel.
//
// Builds per-variant (classic/slim) per-layer (base/overlay) box geometry
// straight from Skins.NET (§5.7) so the mesh can never disagree with the UV
// table: sizes, pivots, local bounds and overlay inflation all come from the
// same frozen object. UVs are 0..1 with the bottom-face V-flip honored via
// the rect's own `vflip` flag.
//
// Public API (contract §5.8):
//   PlayerModel.init(gl)                    build program + geometry for a ctx
//   PlayerModel.draw(gl, opts)              one fully-posed player
//   PlayerModel.drawFirstPersonArm(gl, o)   right arm view-model
//   PlayerModel.preview(skin, opts)         synchronous thumbnail -> 2d canvas
//   PlayerModel.attachTurntable(c2d, skin, opts)
//       -> {setSkin, setModel, setPose, destroy}   rotating live preview
//
// Rendering notes:
// - ONE shader for everything: skin sampler, uViewProj, per-part uModel
//   computed on the CPU, uLight + light direction, linear fog, uCutout flag.
//   Base layer forces alpha to 1.0 (Minecraft treats the base as opaque);
//   overlay discards alpha < 0.5 and is drawn with culling disabled.
// - Model space faces +Z; the game's yaw convention (0 = facing -Z, §3) is
//   satisfied by rotating the model by yaw + PI inside draw(), so callers
//   simply pass their §3 yaw.
// - preview()/attachTurntable() share ONE lazily-created hidden 256x320
//   WebGL2 canvas; every caller renders on demand then blits synchronously.
//
// Depends on: M3 (math), GLX (program/uniform helpers), Skins (NET + texture).

var PlayerModel = (function () {
  // ---- constants -----------------------------------------------------------
  var SCALE = 0.9375 / 16;      // model unit -> world metres (32 u ~ 1.8 blocks)
  var ARM_SCALE = 0.075;        // first-person view-model scale (chunkier)
  var MAX_SWING = 0.6981;       // 40 deg leg/arm swing
  var HEAD_CLAMP = 1.309;       // +/-75 deg head yaw relative to body
  var CROUCH_BODY = 0.21;       // ~12 deg body tilt
  var UV_EPS = 0.02;            // texel inset against seam bleed (px units)
  var LIGHT_DIR = norm3(-0.45, 0.85, 0.55);   // fixed key light (world space)
  var ARM_LIGHT_DIR = norm3(0.35, 0.8, 0.55); // view-space light for the arm

  function norm3(x, y, z) {
    var l = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / l, y / l, z / l];
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrapAngle(a) {
    a = a % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function nowSec() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  // ---- shader (one program for base + overlay + view-model) ----------------
  var VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec3 aNormal;',
    'layout(location=2) in vec2 aUV;',
    'uniform mat4 uViewProj;',
    'uniform mat4 uModel;',
    'out vec2 vUV;',
    'out vec3 vNormal;',
    'out vec3 vWorld;',
    'void main() {',
    '  vec4 w = uModel * vec4(aPos, 1.0);',
    '  vWorld = w.xyz;',
    '  vNormal = mat3(uModel) * aNormal;', // uniform scale: normalize in FS
    '  vUV = aUV;',
    '  gl_Position = uViewProj * w;',
    '}'
  ].join('\n');

  var FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUV;',
    'in vec3 vNormal;',
    'in vec3 vWorld;',
    'uniform sampler2D uSkin;',
    'uniform float uCutout;',   // 1 = overlay: discard a<0.5; 0 = base: alpha forced 1
    'uniform float uLight;',
    'uniform vec3 uLightDir;',
    'uniform vec3 uFogColor;',
    'uniform float uFogStart;',
    'uniform float uFogEnd;',
    'uniform vec3 uCamPos;',
    'out vec4 outColor;',
    'void main() {',
    '  vec4 c = texture(uSkin, vUV);',
    '  if (uCutout > 0.5 && c.a < 0.5) discard;',
    '  vec3 n = normalize(vNormal);',
    '  float diff = max(dot(n, uLightDir), 0.0);',     // soft two-tone
    '  vec3 col = c.rgb * (0.62 + 0.38 * diff) * uLight;',
    '  float f = clamp((distance(vWorld, uCamPos) - uFogStart)',
    '                  / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);',
    '  outColor = vec4(mix(col, uFogColor, f), 1.0);', // base alpha forced 1.0
    '}'
  ].join('\n');

  // ---- geometry: boxes from Skins.NET ---------------------------------------
  // CPU-side vertex data is shared across GL contexts (game + hidden preview).
  // Layout: pos(3) normal(3) uv(2) interleaved, 36 verts per part box.
  var _geoCache = null; // {classic:{base:{data,ranges},overlay:{...}}, slim:{...}}

  function pushFace(v, n, p0, p1, p2, p3, rect) {
    var u0 = (rect.x + UV_EPS) / 64, u1 = (rect.x + rect.w - UV_EPS) / 64;
    var v0 = (rect.y + UV_EPS) / 64, v1 = (rect.y + rect.h - UV_EPS) / 64;
    if (rect.vflip) { var t = v0; v0 = v1; v1 = t; } // bottom-face V-flip (§5.7)
    var uv0 = [u0, v0], uv1 = [u1, v0], uv2 = [u1, v1], uv3 = [u0, v1];
    var corners = [p0, p1, p2, p0, p2, p3];
    var uvs = [uv0, uv1, uv2, uv0, uv2, uv3];
    for (var i = 0; i < 6; i++) {
      v.push(corners[i][0], corners[i][1], corners[i][2],
             n[0], n[1], n[2], uvs[i][0], uvs[i][1]);
    }
  }

  // Face corner order matches the canonical (u0,v0)(u1,v0)(u1,v1)(u0,v1)
  // pattern; orientations derive from texel continuity around the box
  // (right|front|left|back share edges) with model front = +Z.
  function pushBox(v, x0, y0, z0, x1, y1, z1, faces) {
    pushFace(v, [0, 0, 1],  [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], faces.front);
    pushFace(v, [0, 0, -1], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0], faces.back);
    pushFace(v, [-1, 0, 0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0], faces.right);
    pushFace(v, [1, 0, 0],  [x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1], faces.left);
    pushFace(v, [0, 1, 0],  [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], faces.top);
    pushFace(v, [0, -1, 0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], faces.bottom);
  }

  function buildLayerGeometry(model, layer) {
    var net = Skins.NET[model];
    var verts = [];
    var ranges = {};
    Skins.NET.parts.forEach(function (part) {
      var e = net[part];
      var inf = layer === 'overlay' ? e.inflate.overlay : e.inflate.base;
      var b = e.box;
      ranges[part] = { first: verts.length / 8, count: 36 };
      pushBox(verts,
        b.min[0] - inf, b.min[1] - inf, b.min[2] - inf,
        b.max[0] + inf, b.max[1] + inf, b.max[2] + inf,
        e[layer].faces);
    });
    return { data: new Float32Array(verts), ranges: ranges };
  }

  function geoCache() {
    if (!_geoCache) {
      _geoCache = {};
      ['classic', 'slim'].forEach(function (model) {
        _geoCache[model] = {
          base: buildLayerGeometry(model, 'base'),
          overlay: buildLayerGeometry(model, 'overlay')
        };
      });
    }
    return _geoCache;
  }

  // ---- per-context GL state --------------------------------------------------
  var _states = []; // [{gl, prog, uni, geo, broken}]

  function uploadLayer(gl, cpu) {
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, cpu.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 32, 24);
    gl.bindVertexArray(null);
    return { vao: vao, ranges: cpu.ranges };
  }

  function buildState(gl) {
    var st = { gl: gl, prog: null, uni: null, geo: null, broken: false };
    try {
      if (typeof M3 === 'undefined' || typeof GLX === 'undefined' ||
          typeof Skins === 'undefined') {
        throw new Error('PlayerModel: M3/GLX/Skins must load first');
      }
      st.prog = GLX.program(gl, VS, FS);
      st.uni = GLX.uniforms(gl, st.prog);
      var cache = geoCache();
      st.geo = {
        classic: {
          base: uploadLayer(gl, cache.classic.base),
          overlay: uploadLayer(gl, cache.classic.overlay)
        },
        slim: {
          base: uploadLayer(gl, cache.slim.base),
          overlay: uploadLayer(gl, cache.slim.overlay)
        }
      };
    } catch (e) {
      st.broken = true;
      if (typeof console !== 'undefined') console.error('PlayerModel init failed:', e);
    }
    return st;
  }

  function stateFor(gl) {
    if (!gl) return null;
    for (var i = 0; i < _states.length; i++) {
      if (_states[i].gl === gl) return _states[i].broken ? null : _states[i];
    }
    var st = buildState(gl);
    _states.push(st);
    return st.broken ? null : st;
  }

  // ---- pose math (§5.8) -------------------------------------------------------
  // Legs swing +/-40deg * swingAmp with phase sin(swing*2PI), arms opposite
  // their own-side leg; idle arm sway on an internal clock; head independent
  // (headYaw clamped +/-75deg relative to body yaw); crouch tilts the body
  // ~12deg and lowers the head (plus a slight forward arm tuck).
  function computePose(o) {
    var t = nowSec();
    var amp = clamp(o.swingAmp || 0, 0, 1);
    var ph = Math.sin((o.swing || 0) * Math.PI * 2) * amp;
    var sway = 0.02 + Math.cos(t * 1.6) * 0.02;   // idle arm sway
    var crouch = !!o.crouch;
    var dYaw = clamp(wrapAngle((o.headYaw || 0) - (o.yaw || 0)),
                     -HEAD_CLAMP, HEAD_CLAMP);
    var armTuck = crouch ? 0.25 : 0;
    return {
      head:     { rx: -(o.headPitch || 0), ry: dYaw, rz: 0, py: crouch ? -1.6 : 0 },
      body:     { rx: crouch ? CROUCH_BODY : 0, ry: 0, rz: 0, py: 0 },
      rightArm: { rx: -ph * MAX_SWING + armTuck, ry: 0, rz: -sway, py: crouch ? -1.2 : 0 },
      leftArm:  { rx:  ph * MAX_SWING + armTuck, ry: 0, rz:  sway, py: crouch ? -1.2 : 0 },
      rightLeg: { rx:  ph * MAX_SWING, ry: 0, rz: 0, py: 0 },
      leftLeg:  { rx: -ph * MAX_SWING, ry: 0, rz: 0, py: 0 }
    };
  }

  // ---- matrix helpers ----------------------------------------------------------
  // Scratch pool (ping-pong so we never rely on M3 allowing out === in).
  var S0 = new Float32Array(16), S1 = new Float32Array(16);
  var S2 = new Float32Array(16), S3 = new Float32Array(16);
  var S4 = new Float32Array(16), S5 = new Float32Array(16);
  var SP = new Float32Array(16), SV = new Float32Array(16), SVP = new Float32Array(16);
  var MZ = new Float32Array(16);

  // M3 pins RotateX/RotateY but no RotateZ — post-multiply a hand-built
  // column-major Z rotation instead.
  function rotZ(out, m, rad) {
    var c = Math.cos(rad), s = Math.sin(rad);
    M3.mat4Identity(MZ);
    MZ[0] = c; MZ[1] = s; MZ[4] = -s; MZ[5] = c;
    M3.mat4Multiply(out, m, MZ);
  }

  // out = base * T(pivot + py) * RZ * RY * RX   (RX innermost: pitch happens
  // inside the already-yawed frame, which is what heads/arms need).
  function partMatrix(out, base, pivot, pr) {
    M3.mat4Translate(S4, base, pivot[0], pivot[1] + (pr.py || 0), pivot[2]);
    var m = S4;
    if (pr.rz) { rotZ(S5, m, pr.rz); m = S5; }
    if (pr.ry) {
      var dst = (m === S4) ? S5 : S4;
      M3.mat4RotateY(dst, m, pr.ry);
      m = dst;
    }
    M3.mat4RotateX(out, m, pr.rx || 0);
  }

  function setCommonUniforms(gl, uni, viewProj, light, lightDir, fog, camPos) {
    gl.uniformMatrix4fv(uni.uViewProj, false, viewProj);
    gl.uniform1i(uni.uSkin, 0);
    gl.uniform1f(uni.uLight, light == null ? 1 : light);
    gl.uniform3f(uni.uLightDir, lightDir[0], lightDir[1], lightDir[2]);
    if (fog && fog.color) {
      gl.uniform3f(uni.uFogColor, fog.color[0], fog.color[1], fog.color[2]);
      gl.uniform1f(uni.uFogStart, fog.start);
      gl.uniform1f(uni.uFogEnd, fog.end);
    } else {
      gl.uniform3f(uni.uFogColor, 0, 0, 0);
      gl.uniform1f(uni.uFogStart, 1e8);   // fog effectively off
      gl.uniform1f(uni.uFogEnd, 2e8);
    }
    var cp = camPos || [0, 0, 0];
    gl.uniform3f(uni.uCamPos, cp[0], cp[1], cp[2]);
  }

  // Save GL toggles we clobber, set ours, hand back a restore fn. Overlay
  // needs culling OFF (§5.7); we draw base the same way — the depth buffer
  // resolves a handful of boxes just fine and winding bugs become impossible.
  function pushDrawState(gl) {
    var cull = gl.isEnabled(gl.CULL_FACE);
    var blend = gl.isEnabled(gl.BLEND);
    var depth = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    return function () {
      if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      if (blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      if (depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    };
  }

  function drawLayers(gl, st, geo, pose, base) {
    var layers = ['base', 'overlay'];
    for (var li = 0; li < layers.length; li++) {
      var layer = geo[layers[li]];
      gl.uniform1f(st.uni.uCutout, li === 0 ? 0 : 1);
      gl.bindVertexArray(layer.vao);
      var parts = Skins.NET.parts;
      for (var pi = 0; pi < parts.length; pi++) {
        var part = parts[pi];
        var net = Skins.NET.classic[part]; // pivots identical across variants
        partMatrix(S3, base, net.pivot, pose[part]);
        gl.uniformMatrix4fv(st.uni.uModel, false, S3);
        var r = layer.ranges[part];
        gl.drawArrays(gl.TRIANGLES, r.first, r.count);
      }
    }
    gl.bindVertexArray(null);
  }

  // ---- public: full player ------------------------------------------------------
  // opts: { skinTex, model, viewProj, pos:[x,y,z], yaw, headYaw, headPitch,
  //         swing, swingAmp, crouch, light, fog:{color,start,end}, camPos }
  function draw(gl, opts) {
    var st = stateFor(gl);
    if (!st || !opts || !opts.skinTex || !opts.viewProj) return;
    var model = opts.model === 'slim' ? 'slim' : 'classic';

    gl.useProgram(st.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, opts.skinTex);
    setCommonUniforms(gl, st.uni, opts.viewProj, opts.light, LIGHT_DIR,
                      opts.fog, opts.camPos);

    // base = T(pos) * RotY(yaw + PI) * Scale   (model space faces +Z, §3 yaw
    // faces -Z at 0 — the extra PI reconciles the two conventions)
    var pos = opts.pos || [0, 0, 0];
    M3.mat4Identity(S0);
    M3.mat4Translate(S1, S0, pos[0], pos[1], pos[2]);
    M3.mat4RotateY(S2, S1, (opts.yaw || 0) + Math.PI);
    M3.mat4Scale(S0, S2, SCALE, SCALE, SCALE);

    var restore = pushDrawState(gl);
    drawLayers(gl, st, st.geo[model], computePose(opts), S0);
    restore();
  }

  // ---- public: first-person view-model arm ---------------------------------------
  // Right arm only, bottom-right of screen, own tiny projection. swing01 is
  // the attack swing (0..1, 0 = rest), bob a walk-cycle phase in radians.
  // Depth range is squeezed to [0, 0.1] so the arm always wins against the
  // already-rendered world without clearing the depth buffer.
  function drawFirstPersonArm(gl, o) {
    var st = stateFor(gl);
    if (!st || !o || !o.skinTex || !o.proj) return;
    var model = o.model === 'slim' ? 'slim' : 'classic';

    gl.useProgram(st.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, o.skinTex);
    setCommonUniforms(gl, st.uni, o.proj, o.light, ARM_LIGHT_DIR, null, null);

    var s01 = clamp(o.swing01 || 0, 0, 1);
    var f1 = Math.sin(s01 * Math.PI);              // dip
    var f2 = Math.sin(Math.sqrt(s01) * Math.PI);   // chop
    var bob = o.bob || 0;
    var tx = 0.56 - f2 * 0.07 + Math.sin(bob) * 0.022;
    var ty = -0.52 - f1 * 0.12 - Math.abs(Math.cos(bob)) * 0.028;
    var tz = -0.30;

    M3.mat4Identity(S0);
    M3.mat4Translate(S1, S0, tx, ty, tz);
    M3.mat4RotateY(S2, S1, -0.45 + f2 * 0.4);
    M3.mat4RotateX(S1, S2, 1.30 - f2 * 0.95);
    rotZ(S2, S1, 0.10 - f2 * 0.35);
    M3.mat4Scale(S3, S2, ARM_SCALE, ARM_SCALE, ARM_SCALE);
    gl.uniformMatrix4fv(st.uni.uModel, false, S3);

    var restore = pushDrawState(gl);
    gl.depthRange(0.0, 0.1);
    var geo = st.geo[model];
    var layers = ['base', 'overlay'];
    for (var li = 0; li < layers.length; li++) {
      var layer = geo[layers[li]];
      gl.uniform1f(st.uni.uCutout, li === 0 ? 0 : 1);
      gl.bindVertexArray(layer.vao);
      var r = layer.ranges.rightArm;
      gl.drawArrays(gl.TRIANGLES, r.first, r.count);
    }
    gl.bindVertexArray(null);
    gl.depthRange(0.0, 1.0);
    restore();
  }

  // ---- shared hidden preview context -----------------------------------------
  // ONE 256x320 WebGL2 canvas for every thumbnail and turntable. Rendering
  // and the 2d blit happen in the same task, so nothing needs preserving.
  var PV_W = 256, PV_H = 320;
  var _pv = null;
  function previewGL() {
    if (_pv) return _pv;
    var canvas = document.createElement('canvas');
    canvas.width = PV_W; canvas.height = PV_H;
    var gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true, antialias: true, depth: true,
        premultipliedAlpha: true, preserveDrawingBuffer: false
      });
    } catch (e) { gl = null; }
    _pv = { canvas: canvas, gl: gl };
    return _pv;
  }

  // Render one posed model into the hidden canvas, viewport fitted to the
  // requested aspect. Returns the source rect (2d-canvas coords) to blit, or
  // null when WebGL2 is unavailable.
  // p: {tex, model, modelYaw, camPitch, zoom, pose, phase, w, h}
  function renderModelToPreview(p) {
    var pv = previewGL();
    var gl = pv.gl;
    if (!gl || !p.tex) return null;
    var aspect = (p.w > 0 && p.h > 0) ? p.w / p.h : 0.8;
    var vw = PV_W, vh = Math.round(PV_W / aspect);
    if (vh > PV_H) { vh = PV_H; vw = Math.max(16, Math.round(PV_H * aspect)); }
    vh = Math.max(16, vh);

    gl.viewport(0, 0, vw, vh);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, vw, vh);
    gl.clearColor(0, 0, 0, 0);      // transparent background
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);

    var pitch = p.camPitch == null ? -0.15 : p.camPitch;
    var dist = 3.35 / Math.max(0.2, p.zoom || 1);
    var dir = [0, Math.sin(pitch), -Math.cos(pitch)];
    var eye = [0, 0.97 - dir[1] * dist, -dir[2] * dist];
    M3.mat4Perspective(SP, 38 * Math.PI / 180, aspect, 0.1, 50);
    M3.mat4LookDir(SV, eye, dir, [0, 1, 0]);
    M3.mat4Multiply(SVP, SP, SV);

    var walk = p.pose === 'walk';
    // draw() adds PI to yaw; pre-adding PI here means modelYaw 0 == facing
    // the preview camera.
    draw(gl, {
      skinTex: p.tex,
      model: p.model,
      viewProj: SVP,
      pos: [0, 0, 0],
      yaw: (p.modelYaw || 0) + Math.PI,
      headYaw: (p.modelYaw || 0) + Math.PI,
      headPitch: 0,
      swing: walk ? (p.phase || 0) : 0,
      swingAmp: walk ? 0.75 : 0,
      crouch: false,
      light: 1,
      fog: null,
      camPos: eye
    });
    gl.flush();
    // GL viewport origin is bottom-left; drawImage coords are top-left.
    return { sx: 0, sy: PV_H - vh, sw: vw, sh: vh };
  }

  function skinTexFor(gl, skin) {
    return skin ? Skins.texture(gl, skin) : null;
  }
  function modelOf(skin, fallback) {
    if (skin && (skin.model === 'slim' || skin.model === 'classic')) return skin.model;
    return fallback || 'classic';
  }

  // ---- public: synchronous thumbnail ------------------------------------------
  // opts: {width=160, height=200, yaw=0.6, pitch=-0.15, zoom=1,
  //        pose='stand'|'walk', transparent=true}
  // Returns a NEW 2d canvas. Blank (transparent) when WebGL2 is missing.
  function preview(skin, opts) {
    opts = opts || {};
    var w = opts.width || 160, h = opts.height || 200;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    if (opts.transparent === false) {
      ctx.fillStyle = '#262b34';
      ctx.fillRect(0, 0, w, h);
    }
    var pv = previewGL();
    if (!pv.gl || !skin) return out;
    var tex = skinTexFor(pv.gl, skin);
    var rect = renderModelToPreview({
      tex: tex,
      model: modelOf(skin, opts.model),
      modelYaw: opts.yaw == null ? 0.6 : opts.yaw,
      camPitch: opts.pitch == null ? -0.15 : opts.pitch,
      zoom: opts.zoom || 1,
      pose: opts.pose || 'stand',
      phase: 0.18,
      w: w, h: h
    });
    pv.gl.deleteTexture(tex);
    if (rect) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(pv.canvas, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
    }
    return out;
  }

  // ---- public: live rotating turntable ------------------------------------------
  // rAF loop painting into the given 2d canvas. Auto-rotates ~0.5 rad/s;
  // pointer/touch drag spins with inertia and pauses the auto-rotation.
  // Multiple turntables share the one hidden GL canvas (each renders on
  // demand per frame). Returns {setSkin, setModel, setPose, destroy}.
  function attachTurntable(canvas2d, skin, opts) {
    opts = opts || {};
    var pv = previewGL();
    var st = {
      yaw: opts.yaw == null ? 0.5 : opts.yaw,
      autoSpeed: opts.autoSpeed == null ? 0.5 : opts.autoSpeed,
      vel: 0, auto: 1,
      dragging: false, lastX: 0, lastT: 0,
      pose: opts.pose === 'walk' ? 'walk' : 'stand',
      model: 'classic', tex: null,
      phase: 0, lastFrame: 0, raf: 0, destroyed: false
    };

    function adoptSkin(s) {
      if (st.destroyed) return;
      if (st.tex && pv.gl) pv.gl.deleteTexture(st.tex);
      st.tex = (s && pv.gl) ? skinTexFor(pv.gl, s) : null;
      st.model = modelOf(s, st.model);
    }
    adoptSkin(skin);
    if (opts.model === 'slim' || opts.model === 'classic') st.model = opts.model;

    try { canvas2d.style.touchAction = 'none'; } catch (e) { /* detached */ }
    function onDown(e) {
      st.dragging = true;
      st.auto = 0;
      st.vel = 0;
      st.lastX = e.clientX;
      st.lastT = nowSec();
      try { canvas2d.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
      e.preventDefault();
    }
    function onMove(e) {
      if (!st.dragging) return;
      var t = nowSec();
      var dx = e.clientX - st.lastX;
      var dt = Math.max(t - st.lastT, 1 / 240);
      st.yaw += dx * 0.013;
      st.vel = st.vel * 0.5 + (dx * 0.013 / dt) * 0.5;   // smoothed rad/s
      st.lastX = e.clientX;
      st.lastT = t;
    }
    function onUp() { st.dragging = false; }
    canvas2d.addEventListener('pointerdown', onDown);
    canvas2d.addEventListener('pointermove', onMove);
    canvas2d.addEventListener('pointerup', onUp);
    canvas2d.addEventListener('pointercancel', onUp);

    function frame(tms) {
      if (st.destroyed) return;
      st.raf = requestAnimationFrame(frame);
      var dt = clamp((tms - (st.lastFrame || tms)) / 1000, 0, 0.1);
      st.lastFrame = tms;
      if (!st.dragging) {
        st.yaw += st.vel * dt;                 // inertia...
        st.vel *= Math.exp(-dt * 2.2);         // ...decays
        if (Math.abs(st.vel) < 0.5) st.auto = Math.min(1, st.auto + dt * 0.8);
        st.yaw += st.autoSpeed * st.auto * dt
                  * (1 - Math.min(1, Math.abs(st.vel) / 0.5));
      }
      if (st.pose === 'walk') st.phase = (st.phase + dt * 0.85) % 1;
      var w = canvas2d.width, h = canvas2d.height;
      if (!w || !h) return;
      var ctx = canvas2d.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      if (!pv.gl || !st.tex) return;
      var rect = renderModelToPreview({
        tex: st.tex, model: st.model, modelYaw: st.yaw,
        camPitch: -0.12, zoom: opts.zoom || 1,
        pose: st.pose, phase: st.phase, w: w, h: h
      });
      if (rect) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(pv.canvas, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
      }
    }
    st.raf = requestAnimationFrame(frame);

    return {
      setSkin: function (s) { adoptSkin(s); },
      setModel: function (m) { st.model = m === 'slim' ? 'slim' : 'classic'; },
      setPose: function (p) { st.pose = p === 'walk' ? 'walk' : 'stand'; },
      destroy: function () {
        if (st.destroyed) return;
        st.destroyed = true;
        cancelAnimationFrame(st.raf);
        canvas2d.removeEventListener('pointerdown', onDown);
        canvas2d.removeEventListener('pointermove', onMove);
        canvas2d.removeEventListener('pointerup', onUp);
        canvas2d.removeEventListener('pointercancel', onUp);
        if (st.tex && pv.gl) pv.gl.deleteTexture(st.tex);
        st.tex = null;
      }
    };
  }

  // ---- public API ------------------------------------------------------------------
  return {
    init: function (gl) { stateFor(gl); },
    draw: draw,
    drawFirstPersonArm: drawFirstPersonArm,
    preview: preview,
    attachTurntable: attachTurntable
  };
})();

window.PlayerModel = PlayerModel;
