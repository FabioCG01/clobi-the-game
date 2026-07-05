// math3d.js — 3D math for the CLOBI CRAFT voxel engine. Single global: M3.
//
// Column-major Float32Array(16) matrices (the WebGL convention: element
// [col*4 + row]; translation lives in indices 12,13,14). Right-handed,
// Y up, camera looks down −Z (see ARCHITECTURE-3D.md §3).
//
// Everything is allocation-light, out-param style: the caller owns the
// destination array and passes it as the first argument; every function
// returns that same `out` so calls can be chained. All matrix ops are
// alias-safe (out may be the same array as any input).
//
//   M3.mat4Identity(out?)                    M3.mat4Multiply(out, a, b)     // out = a·b
//   M3.mat4Perspective(out, fovY, asp, n, f) M3.mat4Ortho(out, l,r,b,t,n,f)
//   M3.mat4LookDir(out, eye, dir, up)        M3.mat4Invert(out, m)
//   M3.mat4Translate/RotateX/RotateY/Scale(out, m, ...)   // post-multiply
//   M3.transformPoint(out3, m, p3)           // w-divide (usable for unproject)
//   M3.frustumFromMatrix(out24, projView)    // Gribb-Hartmann, normalized
//   M3.frustumTestAABB(planes, ...) -> bool  // positive-vertex trick
//   M3.v3(x,y,z) + add/sub/scale/cross/dot/normalize/length
//
// Depends on: nothing. Consumed by every GL module (renderer, playermodel,
// interact, game, ...). No DOM, no GL — pure math.

var M3 = (function () {

  // ---- mat4 basics ----------------------------------------------------

  // Identity. `out` is optional: omitted → a fresh Float32Array(16) is
  // allocated (the ONLY function here that allocates on demand).
  function mat4Identity(out) {
    if (!out) out = new Float32Array(16);
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
    return out;
  }

  // Straight copy (convenience extra; not pinned but handy for consumers).
  function mat4Copy(out, m) {
    for (var i = 0; i < 16; i++) out[i] = m[i];
    return out;
  }

  // out = a · b  (i.e. the combined transform applies b first, then a).
  // Both inputs are fully cached in locals, so out may alias a and/or b.
  function mat4Multiply(out, a, b) {
    var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    var a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    var a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    var a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

    var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
    out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
    out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

    b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
    out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
    return out;
  }

  // ---- projections ----------------------------------------------------

  // Standard WebGL right-handed perspective: camera looks down −Z, clip z
  // in [−1, +1]. fovY in radians. far may be Infinity (rare, but handled).
  function mat4Perspective(out, fovYrad, aspect, near, far) {
    var f = 1.0 / Math.tan(fovYrad / 2);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[11] = -1;
    out[12] = 0; out[13] = 0; out[15] = 0;
    if (far != null && far !== Infinity) {
      var nf = 1 / (near - far);
      out[10] = (far + near) * nf;
      out[14] = 2 * far * near * nf;
    } else {
      out[10] = -1;
      out[14] = -2 * near;
    }
    return out;
  }

  // Orthographic projection (used for UI-ish passes, shadow-style tricks).
  function mat4Ortho(out, l, r, b, t, n, f) {
    var lr = 1 / (l - r);
    var bt = 1 / (b - t);
    var nf = 1 / (n - f);
    out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
    out[12] = (l + r) * lr;
    out[13] = (t + b) * bt;
    out[14] = (f + n) * nf;
    out[15] = 1;
    return out;
  }

  // ---- view matrix ----------------------------------------------------

  // View matrix from an eye position and a look DIRECTION (not a target —
  // the game always has yaw/pitch → dir, so this avoids a subtract).
  // `up` defaults to +Y; a degenerate dir/up pair (looking straight along
  // up) falls back to an alternate up axis instead of producing NaNs.
  function mat4LookDir(out, eye, dir, up) {
    var ex = eye[0], ey = eye[1], ez = eye[2];
    var fx = dir[0], fy = dir[1], fz = dir[2];

    // normalize forward (fall back to −Z on a zero-length dir)
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (fl < 1e-8) { fx = 0; fy = 0; fz = -1; } else { fx /= fl; fy /= fl; fz /= fl; }

    var ux = up ? up[0] : 0, uy = up ? up[1] : 1, uz = up ? up[2] : 0;

    // s = normalize(cross(f, up))  — the camera's right vector
    var sx = fy * uz - fz * uy;
    var sy = fz * ux - fx * uz;
    var sz = fx * uy - fy * ux;
    var sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (sl < 1e-8) {
      // dir is (anti)parallel to up: pick a fallback up that can't also be
      // parallel (if f is vertical use −Z, otherwise use +Y's replacement +X)
      ux = (Math.abs(fy) > 0.9) ? 0 : 0;
      uy = (Math.abs(fy) > 0.9) ? 0 : 1;
      uz = (Math.abs(fy) > 0.9) ? -1 : 0;
      sx = fy * uz - fz * uy;
      sy = fz * ux - fx * uz;
      sz = fx * uy - fy * ux;
      sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (sl < 1e-8) { sx = 1; sy = 0; sz = 0; sl = 1; }
    }
    sx /= sl; sy /= sl; sz /= sl;

    // u = cross(s, f) — true up, already unit length
    var tx = sy * fz - sz * fy;
    var ty = sz * fx - sx * fz;
    var tz = sx * fy - sy * fx;

    out[0] = sx; out[1] = tx; out[2] = -fx; out[3] = 0;
    out[4] = sy; out[5] = ty; out[6] = -fy; out[7] = 0;
    out[8] = sz; out[9] = tz; out[10] = -fz; out[11] = 0;
    out[12] = -(sx * ex + sy * ey + sz * ez);
    out[13] = -(tx * ex + ty * ey + tz * ez);
    out[14] = (fx * ex + fy * ey + fz * ez);
    out[15] = 1;
    return out;
  }

  // ---- affine post-multiplies ------------------------------------------

  // out = m · T(x,y,z). Alias-safe: only column 3 is recomputed.
  function mat4Translate(out, m, x, y, z) {
    if (out !== m) {
      for (var i = 0; i < 12; i++) out[i] = m[i];
    }
    var m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
    var m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
    var m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
    out[12] = m0 * x + m4 * y + m8 * z + m[12];
    out[13] = m1 * x + m5 * y + m9 * z + m[13];
    out[14] = m2 * x + m6 * y + m10 * z + m[14];
    out[15] = m3 * x + m7 * y + m11 * z + m[15];
    return out;
  }

  // out = m · Rx(rad). Rotates around the matrix's local X axis.
  function mat4RotateX(out, m, rad) {
    var s = Math.sin(rad), c = Math.cos(rad);
    var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    if (out !== m) {
      out[0] = m[0]; out[1] = m[1]; out[2] = m[2]; out[3] = m[3];
      out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15];
    }
    out[4] = a10 * c + a20 * s;
    out[5] = a11 * c + a21 * s;
    out[6] = a12 * c + a22 * s;
    out[7] = a13 * c + a23 * s;
    out[8] = a20 * c - a10 * s;
    out[9] = a21 * c - a11 * s;
    out[10] = a22 * c - a12 * s;
    out[11] = a23 * c - a13 * s;
    return out;
  }

  // out = m · Ry(rad). Rotates around the matrix's local Y axis.
  function mat4RotateY(out, m, rad) {
    var s = Math.sin(rad), c = Math.cos(rad);
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    if (out !== m) {
      out[4] = m[4]; out[5] = m[5]; out[6] = m[6]; out[7] = m[7];
      out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15];
    }
    out[0] = a00 * c - a20 * s;
    out[1] = a01 * c - a21 * s;
    out[2] = a02 * c - a22 * s;
    out[3] = a03 * c - a23 * s;
    out[8] = a00 * s + a20 * c;
    out[9] = a01 * s + a21 * c;
    out[10] = a02 * s + a22 * c;
    out[11] = a03 * s + a23 * c;
    return out;
  }

  // out = m · S(x,y,z).
  function mat4Scale(out, m, x, y, z) {
    out[0] = m[0] * x; out[1] = m[1] * x; out[2] = m[2] * x; out[3] = m[3] * x;
    out[4] = m[4] * y; out[5] = m[5] * y; out[6] = m[6] * y; out[7] = m[7] * y;
    out[8] = m[8] * z; out[9] = m[9] * z; out[10] = m[10] * z; out[11] = m[11] * z;
    if (out !== m) {
      out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15];
    }
    return out;
  }

  // ---- inversion --------------------------------------------------------

  // Full cofactor-expansion inverse (handles ANY invertible mat4, including
  // perspective matrices — required for touch unprojects, §8). All of `m`
  // is cached before writing so out may alias m. If the matrix is singular
  // (|det| ≈ 0) `out` is set to identity and returned rather than emitting
  // NaNs — callers get a sane matrix in all cases.
  function mat4Invert(out, m) {
    var a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    var a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    var a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    var a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    var b00 = a00 * a11 - a01 * a10;
    var b01 = a00 * a12 - a02 * a10;
    var b02 = a00 * a13 - a03 * a10;
    var b03 = a01 * a12 - a02 * a11;
    var b04 = a01 * a13 - a03 * a11;
    var b05 = a02 * a13 - a03 * a12;
    var b06 = a20 * a31 - a21 * a30;
    var b07 = a20 * a32 - a22 * a30;
    var b08 = a20 * a33 - a23 * a30;
    var b09 = a21 * a32 - a22 * a31;
    var b10 = a21 * a33 - a23 * a31;
    var b11 = a22 * a33 - a23 * a32;

    var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det || !isFinite(det)) {
      return mat4Identity(out);
    }
    det = 1.0 / det;

    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  }

  // ---- point transform ---------------------------------------------------

  // out3 = m · (p, 1), with perspective w-divide. Feeding this the INVERSE
  // of projView turns NDC coords back into world space (touch unproject).
  // out may alias p.
  function transformPoint(out, m, p) {
    var x = p[0], y = p[1], z = p[2];
    var w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!w || !isFinite(w)) w = 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
  }

  // ---- frustum -------------------------------------------------------------

  // Gribb–Hartmann plane extraction from a combined proj·view matrix.
  // `out` = Float32Array(24): 6 planes × (a,b,c,d) in the order
  // left, right, bottom, top, near, far. Planes are normalized (|abc| = 1)
  // so d is a real signed distance. A point P is INSIDE a plane when
  // a·Px + b·Py + c·Pz + d >= 0.
  function frustumFromMatrix(out, m) {
    // rows of the column-major matrix
    var r0x = m[0], r0y = m[4], r0z = m[8], r0w = m[12];
    var r1x = m[1], r1y = m[5], r1z = m[9], r1w = m[13];
    var r2x = m[2], r2y = m[6], r2z = m[10], r2w = m[14];
    var r3x = m[3], r3y = m[7], r3z = m[11], r3w = m[15];

    // left = row3 + row0, right = row3 − row0, ...
    setPlane(out, 0, r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
    setPlane(out, 4, r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
    setPlane(out, 8, r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
    setPlane(out, 12, r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
    setPlane(out, 16, r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);
    setPlane(out, 20, r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
    return out;
  }

  // normalize a plane in place at offset o
  function setPlane(out, o, a, b, c, d) {
    var len = Math.sqrt(a * a + b * b + c * c);
    var inv = (len > 1e-12) ? 1.0 / len : 0.0;
    out[o] = a * inv;
    out[o + 1] = b * inv;
    out[o + 2] = c * inv;
    out[o + 3] = d * inv;
  }

  // AABB vs frustum via the positive-vertex trick: per plane, test only the
  // box corner farthest along the plane normal. If even that corner is
  // behind the plane, the whole box is out. Conservative (may return true
  // for boxes just outside a corner) which is exactly what culling wants.
  // Returns true = (possibly) visible.
  function frustumTestAABB(planes, minx, miny, minz, maxx, maxy, maxz) {
    for (var i = 0; i < 24; i += 4) {
      var a = planes[i], b = planes[i + 1], c = planes[i + 2], d = planes[i + 3];
      var px = (a >= 0) ? maxx : minx;
      var py = (b >= 0) ? maxy : miny;
      var pz = (c >= 0) ? maxz : minz;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }

  // ---- vec3 -----------------------------------------------------------------

  // The only vec3 allocator; everything else takes out-params. Prefer
  // creating these once and reusing them in hot loops.
  function v3(x, y, z) {
    var out = new Float32Array(3);
    out[0] = x || 0; out[1] = y || 0; out[2] = z || 0;
    return out;
  }

  function v3Set(out, x, y, z) {
    out[0] = x; out[1] = y; out[2] = z;
    return out;
  }

  function add(out, a, b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    return out;
  }

  function sub(out, a, b) {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
  }

  function scale(out, a, s) {
    out[0] = a[0] * s;
    out[1] = a[1] * s;
    out[2] = a[2] * s;
    return out;
  }

  function cross(out, a, b) {
    var ax = a[0], ay = a[1], az = a[2];
    var bx = b[0], by = b[1], bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function length(a) {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  }

  // Zero-length input → zero vector (no NaNs), so normalizing a stationary
  // velocity or degenerate direction is always safe.
  function normalize(out, a) {
    var x = a[0], y = a[1], z = a[2];
    var len = Math.sqrt(x * x + y * y + z * z);
    if (len > 1e-12) {
      var inv = 1.0 / len;
      out[0] = x * inv; out[1] = y * inv; out[2] = z * inv;
    } else {
      out[0] = 0; out[1] = 0; out[2] = 0;
    }
    return out;
  }

  // ---- public API ------------------------------------------------------------

  return {
    // mat4
    mat4Identity: mat4Identity,
    mat4Copy: mat4Copy,
    mat4Multiply: mat4Multiply,
    mat4Perspective: mat4Perspective,
    mat4Ortho: mat4Ortho,
    mat4LookDir: mat4LookDir,
    mat4Translate: mat4Translate,
    mat4RotateX: mat4RotateX,
    mat4RotateY: mat4RotateY,
    mat4Scale: mat4Scale,
    mat4Invert: mat4Invert,
    transformPoint: transformPoint,

    // frustum
    frustumFromMatrix: frustumFromMatrix,
    frustumTestAABB: frustumTestAABB,

    // vec3 (short names per contract, v3-prefixed aliases as convenience)
    v3: v3,
    v3Set: v3Set,
    add: add,       v3Add: add,
    sub: sub,       v3Sub: sub,
    scale: scale,   v3Scale: scale,
    cross: cross,   v3Cross: cross,
    dot: dot,       v3Dot: dot,
    normalize: normalize, v3Normalize: normalize,
    length: length, v3Length: length
  };
})();

window.M3 = M3;
