// glx.js — thin WebGL2 helper layer for the CLOBI CRAFT engine. Single
// global: GLX.
//
// Wraps the handful of raw-GL chores every render module repeats: context
// creation, program compile/link (with LOUD errors — the full info log plus
// numbered source is thrown, never swallowed), uniform reflection, texture
// upload, FBO management, VAO building (interleaved or separate vertex
// buffers, optional Uint32 index buffer), and a shared fullscreen quad for
// post-process passes.
//
//   GLX.getContext(canvas)            -> gl | null   (webgl2 only)
//   GLX.program(gl, vsSrc, fsSrc)     -> WebGLProgram (throws on failure)
//   GLX.uniforms(gl, prog)            -> {name: WebGLUniformLocation}
//   GLX.texture2D(gl, opts)           -> WebGLTexture
//   GLX.updateTexture2D(gl, tex, canvas)
//   GLX.fbo(gl, w, h, {depth:true})   -> {fb, colorTex, depthRb, w, h, resize, destroy}
//   GLX.vao(gl, prog, buffers)        -> {vao, draw(count, mode?), destroy()}
//   GLX.fullscreenQuad(gl)            -> {draw(prog)}  (one shared quad per gl)
//
// Depends on: nothing (standalone). Consumed by Renderer, PlayerModel,
// Blocks, LUT, Skins — precision over cleverness; no state is left bound
// behind after any call here.

var GLX = (function () {

  // ---- context creation ----

  // WebGL2 or nothing. antialias off (we post-process anyway and MSAA fights
  // the FBO pipeline), alpha off (opaque canvas composites faster), and we
  // ask for the discrete GPU on dual-GPU laptops.
  function getContext(canvas) {
    var gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        depth: true,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false
      });
    } catch (e) {
      gl = null;
    }
    return gl || null;
  }

  // ---- shader programs ----

  // number the source lines the way driver info logs reference them (1-based)
  function numberSource(src) {
    var lines = String(src).split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      out.push((i + 1) + ': ' + lines[i]);
    }
    return out.join('\n');
  }

  function compileShader(gl, type, src, label) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh) || '(no info log)';
      gl.deleteShader(sh);
      throw new Error(
        'GLX.program: ' + label + ' shader compile failed:\n' + log +
        '\n---- ' + label + ' source ----\n' + numberSource(src)
      );
    }
    return sh;
  }

  // Compile + link. Throws Error carrying the complete shader/linker info
  // log — a broken shader must never fail silently.
  function program(gl, vsSrc, fsSrc) {
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, 'vertex');
    var fs;
    try {
      fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, 'fragment');
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }

    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    // shaders can be flagged for deletion now; they live until the program dies
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(prog) || '(no info log)';
      gl.deleteProgram(prog);
      throw new Error('GLX.program: link failed:\n' + log);
    }
    return prog;
  }

  // Reflect every active uniform into a {name: location} map. Array
  // uniforms are registered both under their reported name ('uLights[0]')
  // and the bare name ('uLights') so callers never trip on the suffix.
  function uniforms(gl, prog) {
    var map = {};
    var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(prog, i);
      if (!info) continue;
      var loc = gl.getUniformLocation(prog, info.name);
      if (loc === null) continue;   // uniforms inside a UBO have no location
      map[info.name] = loc;
      if (info.name.indexOf('[0]') === info.name.length - 3) {
        map[info.name.slice(0, -3)] = loc;
      }
    }
    return map;
  }

  // ---- textures ----

  // Create + upload a 2D texture.
  //   opts: { width, height, data (TypedArray|null) — raw RGBA pixels,
  //           canvas|image        — alternative DOM source,
  //           filter: 'nearest'(default)|'linear',
  //           wrap:   'clamp'(default)|'repeat',
  //           srgb:   false(default) }
  // Never generates mips (voxel art wants none); flipY and premultiply are
  // forced OFF so skin/atlas pixel coordinates match canvas coordinates.
  function texture2D(gl, opts) {
    opts = opts || {};
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    var internal = opts.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    var source = opts.canvas || opts.image || null;
    if (source) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      var w = Math.max(1, opts.width | 0);
      var h = Math.max(1, opts.height | 0);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, opts.data || null);
    }

    var f = (opts.filter === 'linear') ? gl.LINEAR : gl.NEAREST;
    var wr = (opts.wrap === 'repeat') ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);

    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // Re-upload a texture's pixels from a canvas (skin studio live edits, LUT
  // regen). Full texImage2D, so a size change is fine too; filter/wrap
  // params are texture state and survive untouched.
  function updateTexture2D(gl, tex, canvas) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ---- framebuffers ----

  // Offscreen render target: RGBA8 color texture (+ optional
  // DEPTH_COMPONENT24 renderbuffer). resize(w, h) reallocates storage in
  // place — attachments and completeness are preserved, so per-frame use
  // never re-validates.
  function fbo(gl, w, h, opts) {
    opts = opts || {};
    var wantDepth = (opts.depth !== false);   // default true
    w = Math.max(1, w | 0);
    h = Math.max(1, h | 0);

    var colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var depthRb = null;
    if (wantDepth) {
      depthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    }

    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    if (depthRb) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    }

    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Should not happen with this attachment combo on any WebGL2 device;
      // log rather than throw so the game can still limp along.
      if (window.console && console.warn) {
        console.warn('GLX.fbo: framebuffer incomplete, status 0x' + status.toString(16));
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    var target = {
      fb: fb,
      colorTex: colorTex,
      depthRb: depthRb,
      w: w,
      h: h,

      // Reallocate color + depth storage. No-op when the size is unchanged.
      resize: function (nw, nh) {
        nw = Math.max(1, nw | 0);
        nh = Math.max(1, nh | 0);
        if (nw === target.w && nh === target.h) return;
        target.w = nw;
        target.h = nh;
        gl.bindTexture(gl.TEXTURE_2D, colorTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nw, nh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        if (depthRb) {
          gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
          gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, nw, nh);
          gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        }
      },

      destroy: function () {
        gl.deleteFramebuffer(fb);
        gl.deleteTexture(colorTex);
        if (depthRb) gl.deleteRenderbuffer(depthRb);
      }
    };
    return target;
  }

  // ---- vertex array objects ----

  // Map a TypedArray constructor to its GL component type (used when an
  // attribute entry omits `type`).
  function inferType(gl, data) {
    if (data instanceof Float32Array) return gl.FLOAT;
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) return gl.UNSIGNED_BYTE;
    if (data instanceof Int8Array) return gl.BYTE;
    if (data instanceof Uint16Array) return gl.UNSIGNED_SHORT;
    if (data instanceof Int16Array) return gl.SHORT;
    if (data instanceof Uint32Array) return gl.UNSIGNED_INT;
    if (data instanceof Int32Array) return gl.INT;
    return gl.FLOAT;
  }

  // Build a VAO from a buffer spec:
  //   buffers: [ {name:'aPos', size:3, data:Float32Array,
  //               type?:gl.FLOAT, normalized?:false, stride?:0, offset?:0}, ...
  //              {index: Uint32Array} ]                       // optional
  //
  // Interleaving: entries that reference the SAME `data` array share one
  // VBO (upload once, point attributes at it with stride/offset). Separate
  // arrays get separate VBOs. The optional index entry creates a Uint32
  // element buffer; draw() then uses drawElements(UNSIGNED_INT).
  //
  // draw(count, mode?): mode defaults to gl.TRIANGLES. count may be omitted
  // to draw everything (full index list, or vertex count derived from the
  // first attribute).
  function vao(gl, prog, buffers) {
    var vaoObj = gl.createVertexArray();
    gl.bindVertexArray(vaoObj);

    var ownedBuffers = [];
    var indexCount = 0;
    var hasIndex = false;
    var defaultCount = 0;

    // one VBO per distinct data array (this is what makes interleaved work)
    var vboByData = [];   // parallel arrays (data object -> WebGLBuffer)
    var vboDatas = [];
    function vboFor(data) {
      var at = vboDatas.indexOf(data);
      if (at >= 0) return vboByData[at];
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      vboDatas.push(data);
      vboByData.push(buf);
      ownedBuffers.push(buf);
      return buf;
    }

    for (var i = 0; i < buffers.length; i++) {
      var entry = buffers[i];
      if (!entry) continue;

      // ---- element buffer entry ----
      if (entry.index) {
        var ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, entry.index, gl.STATIC_DRAW);
        ownedBuffers.push(ib);
        indexCount = entry.index.length;
        hasIndex = true;
        continue;
      }

      // ---- attribute entry ----
      var loc = gl.getAttribLocation(prog, entry.name);
      if (loc < 0) {
        // attribute optimized out of the shader (or a typo) — skip quietly;
        // a hard failure here would make shader iteration miserable.
        continue;
      }
      var buf2 = vboFor(entry.data);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf2);
      var type = (entry.type !== undefined) ? entry.type : inferType(gl, entry.data);
      var stride = entry.stride || 0;
      var offset = entry.offset || 0;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, entry.size, type, !!entry.normalized, stride, offset);

      // best-effort vertex count for count-less drawArrays
      if (!defaultCount) {
        defaultCount = stride
          ? Math.floor(entry.data.byteLength / stride)
          : Math.floor(entry.data.length / entry.size);
      }
    }

    // Unbind VAO first — unbinding ELEMENT_ARRAY_BUFFER while the VAO is
    // bound would strip the index buffer out of its state.
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

    return {
      vao: vaoObj,

      draw: function (count, mode) {
        var m = (mode === undefined) ? gl.TRIANGLES : mode;
        gl.bindVertexArray(vaoObj);
        if (hasIndex) {
          var n = (count === undefined || count === null) ? indexCount : count;
          gl.drawElements(m, n, gl.UNSIGNED_INT, 0);
        } else {
          var n2 = (count === undefined || count === null) ? defaultCount : count;
          gl.drawArrays(m, 0, n2);
        }
        gl.bindVertexArray(null);
      },

      destroy: function () {
        gl.deleteVertexArray(vaoObj);
        for (var j = 0; j < ownedBuffers.length; j++) {
          gl.deleteBuffer(ownedBuffers[j]);
        }
        ownedBuffers.length = 0;
      }
    };
  }

  // ---- fullscreen quad (shared singleton per gl context) ----

  // One −1..1 triangle-strip quad per WebGL context, lazily built, shared by
  // every post pass. Contract: `aPos` sits at attribute location 0, so post
  // programs should declare `layout(location = 0) in vec2 aPos;`. As a
  // safety net draw(prog) also looks up aPos in the given program and wires
  // any extra location into the shared VAO (same buffer — harmless).
  var quadCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  var quadFallback = [];   // [gl, quad] pairs for ancient engines without WeakMap

  function fullscreenQuad(gl) {
    // cached?
    var cached = null;
    if (quadCache) {
      cached = quadCache.get(gl) || null;
    } else {
      for (var i = 0; i < quadFallback.length; i += 2) {
        if (quadFallback[i] === gl) { cached = quadFallback[i + 1]; break; }
      }
    }
    if (cached) return cached;

    // build: 4 verts, triangle strip, covers clip space exactly
    var verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    var buf = gl.createBuffer();
    var vaoObj = gl.createVertexArray();
    gl.bindVertexArray(vaoObj);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    var wiredLocs = { 0: true };            // attribute locations already set up
    var locByProg = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;

    var quad = {
      draw: function (prog) {
        if (prog) {
          gl.useProgram(prog);
          // find aPos in this program (cached per program)
          var loc;
          if (locByProg && locByProg.has(prog)) {
            loc = locByProg.get(prog);
          } else {
            loc = gl.getAttribLocation(prog, 'aPos');
            if (locByProg) locByProg.set(prog, loc);
          }
          // program uses a non-zero location → wire it into the shared VAO
          if (loc > 0 && !wiredLocs[loc]) {
            gl.bindVertexArray(vaoObj);
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            wiredLocs[loc] = true;
          }
        }
        gl.bindVertexArray(vaoObj);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
      }
    };

    if (quadCache) {
      quadCache.set(gl, quad);
    } else {
      quadFallback.push(gl, quad);
    }
    return quad;
  }

  // ---- public API ----

  return {
    getContext: getContext,
    program: program,
    uniforms: uniforms,
    texture2D: texture2D,
    updateTexture2D: updateTexture2D,
    fbo: fbo,
    vao: vao,
    fullscreenQuad: fullscreenQuad
  };
})();

window.GLX = GLX;
