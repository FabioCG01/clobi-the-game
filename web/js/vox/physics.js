// vox/physics.js -- global Physics.
//
// Player physics for CLOBI CRAFT: axis-separated AABB sweeps against solid
// blocks, gravity, jumping, water buoyancy and creative flight. Pure logic --
// no DOM, no GL. Contract: docs/ARCHITECTURE-3D.md §5.9.
//
//   Physics.createBody({x,y,z}) -> body
//     body = {pos:{x,y,z}, vel:{x,y,z}, onGround, inWater, headInWater,
//             width:0.6, height:1.8, eyeHeight, fallDistance}
//   Physics.step(world, body, input, dt, opts)
//     input = {forward,strafe (-1..1), jump, sneak, sprint, yaw?}
//     opts  = {mode:'walk'|'fly', speedMult:1, yaw?}
//     (yaw is read from input.yaw first, then opts.yaw -- the caller supplies
//      the camera yaw so forward/strafe can be rotated into world space with
//      the pinned basis: forwardXZ = (-sin yaw, 0, -cos yaw).)
//   Physics.fallDamage(fallDistance) -> half-hearts (int)
//
// Collision order per step: Y first, then X, then Z; every clamped face keeps
// an epsilon gap of 1e-3 so we never end up flush inside a block boundary.
// Solidity is asked from the Blocks registry (world stores raw ids).
//
// Exposes exactly one global: window.Physics
// Depends on globals: Blocks (solid/liquid lookups; degrades to raw-id checks
// if missing), and duck-types `world.getBlock(x,y,z)`.

var Physics = (function () {
  'use strict';

  // ---- constants (contract §5.9 + task pins) ----
  var EPS = 1e-3;             // gap kept between body and block faces
  var GRAVITY = 32;           // blocks/s^2
  var JUMP_V = 9.0;           // blocks/s
  var MAX_FALL = 60;          // terminal fall speed clamp
  var MAX_DT = 0.05;          // physics never integrates more than 50 ms at once

  var WALK_SPEED = 4.3;
  var SPRINT_SPEED = 5.6;
  var SNEAK_SPEED = 1.3;
  var WATER_SPEED = 2.2;

  var FLY_SPEED = 10.8;
  var FLY_SPRINT_SPEED = 21.6;
  var FLY_VERT_SPEED = 8.5;   // jump = up, sneak = down

  var FRICTION_GROUND = 10;   // 1/s exponential damp rates
  var FRICTION_AIR = 2;
  var FRICTION_FLY = 6;
  var FRICTION_WATER = 8;

  var ACCEL_RATE = 10;        // per-second fraction of target speed added
  var AIR_CONTROL = 0.55;     // air acceleration multiplier
  var FLY_ACCEL_RATE = 14;    // flight feels near-instant

  var WATER_GRAVITY = 9.0;    // buoyancy-reduced gravity
  var WATER_VDRAG = 3;        // vertical drag rate in water (1/s)
  var SWIM_UP_SPEED = 3.9;    // max upward swim speed
  var SWIM_ACCEL = 25;        // upward accel while holding jump in water
  var MAX_SINK = 3.2;         // terminal sink speed in water

  var EYE_STAND = 1.62;
  var EYE_SNEAK = 1.27;

  var BODY_W = 0.6;
  var BODY_H = 1.8;

  // ---- block queries (guard Blocks in case of load-order surprises) ----
  function blockDef(world, x, y, z) {
    var id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (!id) return null;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      return Blocks.byId(id) || null;
    }
    // Fallback: id 11 = water; cross blocks 27..29 non-solid (contract §4).
    return {
      solid: id !== 11 && !(id >= 27 && id <= 29),
      liquid: id === 11
    };
  }

  function isSolidAt(world, x, y, z) {
    var def = blockDef(world, x, y, z);
    return !!(def && def.solid);
  }

  function isLiquidAt(world, x, y, z) {
    var def = blockDef(world, x, y, z);
    return !!(def && def.liquid);
  }

  // ---- axis-separated sweep ----
  // Box is kept as min[3]/max[3] arrays (0=x, 1=y, 2=z). Sweeps ONE axis by
  // `d`, mutates the box, and returns the distance actually moved. When a
  // solid layer blocks the move the box is clamped EPS short of the face.
  function anySolidInLayer(world, axis, layer, u0, u1, v0, v1) {
    var c = [0, 0, 0];
    c[axis] = layer;
    var u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (var cu = u0; cu <= u1; cu++) {
      for (var cv = v0; cv <= v1; cv++) {
        c[u] = cu;
        c[v] = cv;
        if (isSolidAt(world, c[0], c[1], c[2])) return true;
      }
    }
    return false;
  }

  function sweepAxis(world, min, max, axis, d) {
    if (d === 0 || !isFinite(d)) return 0;
    var u = (axis + 1) % 3, v = (axis + 2) % 3;
    // Cross-section cells the box currently overlaps (inset by EPS so a face
    // we are resting flush-with-gap against is not counted).
    var u0 = Math.floor(min[u] + EPS), u1 = Math.floor(max[u] - EPS);
    var v0 = Math.floor(min[v] + EPS), v1 = Math.floor(max[v] - EPS);
    var moved = d;
    var a, first, last, guard;

    if (d > 0) {
      // Leading face = max[axis]; first cell it can newly enter, then onward.
      first = Math.ceil(max[axis] - EPS);
      last = Math.floor(max[axis] + d);
      guard = 0;
      for (a = first; a <= last && guard < 64; a++, guard++) {
        if (anySolidInLayer(world, axis, a, u0, u1, v0, v1)) {
          moved = Math.max(0, Math.min(d, a - max[axis] - EPS));
          break;
        }
      }
    } else {
      // Leading face = min[axis]; scan downward/backward.
      first = Math.floor(min[axis] + EPS) - 1;
      last = Math.floor(min[axis] + d);
      guard = 0;
      for (a = first; a >= last && guard < 64; a--, guard++) {
        if (anySolidInLayer(world, axis, a, u0, u1, v0, v1)) {
          moved = Math.min(0, Math.max(d, (a + 1) - min[axis] + EPS));
          break;
        }
      }
    }

    min[axis] += moved;
    max[axis] += moved;
    return moved;
  }

  // ---- movement helpers ----
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  // Quake-style accelerate: adds speed along the wish direction but never
  // pushes the along-wish component past the target speed.
  function accelerate(vel, wx, wz, targetSpeed, rate, dt) {
    if (targetSpeed <= 0) return;
    var cur = vel.x * wx + vel.z * wz;
    var add = targetSpeed - cur;
    if (add <= 0) return;
    var accel = rate * targetSpeed * dt;
    if (accel > add) accel = add;
    vel.x += wx * accel;
    vel.z += wz * accel;
  }

  function updateWaterFlags(world, body, sneaking) {
    var eyeH = sneaking ? EYE_SNEAK : EYE_STAND;
    body.eyeHeight = eyeH;
    body.inWater = isLiquidAt(world, body.pos.x, body.pos.y + body.height * 0.5, body.pos.z);
    body.headInWater = isLiquidAt(world, body.pos.x, body.pos.y + eyeH, body.pos.z);
  }

  // ---- public: createBody ----
  function createBody(p) {
    p = p || {};
    return {
      pos: { x: +p.x || 0, y: +p.y || 0, z: +p.z || 0 },
      vel: { x: 0, y: 0, z: 0 },
      onGround: false,
      inWater: false,
      headInWater: false,
      width: BODY_W,
      height: BODY_H,
      eyeHeight: EYE_STAND,
      fallDistance: 0
    };
  }

  // ---- public: step ----
  function step(world, body, input, dt, opts) {
    if (!world || !body || !(dt > 0)) return;
    input = input || {};
    opts = opts || {};
    if (dt > MAX_DT) dt = MAX_DT;

    var mode = opts.mode === 'fly' ? 'fly' : 'walk';
    var mult = (typeof opts.speedMult === 'number' && opts.speedMult > 0) ? opts.speedMult : 1;
    var yaw = (typeof input.yaw === 'number') ? input.yaw
            : (typeof opts.yaw === 'number') ? opts.yaw : 0;

    var wasOnGround = body.onGround;
    updateWaterFlags(world, body, !!input.sneak && mode !== 'fly');

    // Reset the landing readout once we have been standing for a full step
    // (Game reads body.fallDistance right after the step that landed).
    if (wasOnGround || mode === 'fly' || body.inWater) body.fallDistance = 0;

    // Wish direction in world space (pinned basis, §3):
    //   forwardXZ = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
    var fwd = clamp(+input.forward || 0, -1, 1);
    var str = clamp(+input.strafe || 0, -1, 1);
    var wx = -Math.sin(yaw) * fwd + Math.cos(yaw) * str;
    var wz = -Math.cos(yaw) * fwd - Math.sin(yaw) * str;
    var wishMag = Math.sqrt(wx * wx + wz * wz);
    if (wishMag > 1e-6) { wx /= wishMag; wz /= wishMag; }
    if (wishMag > 1) wishMag = 1;

    var damp, target;

    // Part III §13(b): a SECOND, separate point-sample near the very bottom
    // of the AABB (not the center) — internal to step(), not part of the
    // public body shape (body.inWater/headInWater stay pinned exactly as
    // before). Used only by the two targeted checks below.
    var feetInWater = isLiquidAt(world, body.pos.x, body.pos.y + 0.05, body.pos.z);

    // Branch-ordering fix (contract §13(b), belt-and-suspenders check): read
    // straight, this file's dispatch below is `if (fly) {...} else if
    // (body.inWater) {...} else {walk/fall, with the normal on-ground jump
    // impulse}`. `body.inWater` is a single point-sample at the body's
    // vertical CENTER (pos.y + height*0.5) — in water only ~1 block deep,
    // that center sample can be true at the SAME time `body.onGround` is
    // ALSO genuinely true (feet resting on the solid floor under the water,
    // center still inside the single submerged block above it). Because the
    // swim branch is an `else if`, it used to run INSTEAD of the walking
    // branch whenever body.inWater was true — so a player standing on solid
    // ground in ankle-deep water, holding jump, never reached the on-ground
    // jump impulse at all; found broken exactly as the contract suspected,
    // confirmed by tracing this dispatch. Fixed by forcing dispatch into the
    // walking branch whenever body.onGround is genuinely true, regardless of
    // body.inWater — a grounded player always gets the ordinary jump
    // impulse, water or not (matches vanilla Minecraft's own feel: jumping
    // in ankle-deep water works exactly like jumping on dry land). Swimming
    // while NOT grounded (the normal deep-water case) is completely
    // unaffected — this only changes which branch runs when onGround is
    // ALSO true.
    var groundedDispatch = mode !== 'fly' && body.onGround;

    if (mode === 'fly') {
      // ---- creative flight: no gravity, snappy, instant vertical ----
      target = (input.sprint && fwd > 0) ? FLY_SPRINT_SPEED : FLY_SPEED;
      target *= mult * wishMag;
      damp = Math.exp(-FRICTION_FLY * dt);
      body.vel.x *= damp;
      body.vel.z *= damp;
      accelerate(body.vel, wx, wz, target, FLY_ACCEL_RATE, dt);

      var vy = 0;
      if (input.jump) vy += FLY_VERT_SPEED * mult;
      if (input.sneak) vy -= FLY_VERT_SPEED * mult;
      body.vel.y = vy; // instant stop when neither is held
    } else if (body.inWater && !groundedDispatch) {
      // ---- swimming ----
      target = WATER_SPEED * mult * wishMag;
      damp = Math.exp(-FRICTION_WATER * dt);
      body.vel.x *= damp;
      body.vel.z *= damp;
      accelerate(body.vel, wx, wz, target, ACCEL_RATE, dt);

      body.vel.y *= Math.exp(-WATER_VDRAG * dt);
      body.vel.y -= WATER_GRAVITY * dt;
      if (input.jump) {
        body.vel.y = Math.min(body.vel.y + SWIM_ACCEL * dt, SWIM_UP_SPEED);
      }
      if (body.vel.y < -MAX_SINK) body.vel.y = -MAX_SINK;
    } else {
      // ---- walking / falling (also: grounded-in-shallow-water, per the
      // groundedDispatch fix above) ----
      if (input.sneak) target = SNEAK_SPEED;
      else if (input.sprint && fwd > 0) target = SPRINT_SPEED; // sprint only forward
      else target = WALK_SPEED;
      target *= mult * wishMag;

      var rate = body.onGround ? FRICTION_GROUND : FRICTION_AIR;
      damp = Math.exp(-rate * dt);
      body.vel.x *= damp;
      body.vel.z *= damp;
      var control = body.onGround ? 1 : AIR_CONTROL;
      accelerate(body.vel, wx, wz, target, ACCEL_RATE * control, dt);

      body.vel.y -= GRAVITY * dt;
      if (body.vel.y < -MAX_FALL) body.vel.y = -MAX_FALL;
      if (input.jump && body.onGround) {
        body.vel.y = JUMP_V;
        body.onGround = false;
      }

      // Part III §13(b), primary fix: the exact stranded window the
      // contract describes. This `else` branch only runs when body.inWater
      // is false (center has cleared the water) or the player just got the
      // groundedDispatch jump impulse above. The remaining gap is: center
      // cleared the water, but the player hasn't landed on solid ground
      // EITHER (onGround false — feet still mid-transition through the
      // water-solid boundary), and they're holding jump. A single frame's
      // worth of reduced-fraction SWIM_ACCEL impulse (not a sustained force
      // — this is a plain per-frame velocity nudge like every other term in
      // this branch, so it naturally only ever applies for the one/two
      // frames feetInWater&&!onGround is actually true) nudges them the
      // last inch out instead of letting gravity win that frame. Guarded on
      // !body.inWater so it can never fire while the swim branch above is
      // already handling vertical motion, and deep-water swimming (2+
      // blocks) never reaches this branch at all since body.inWater stays
      // true throughout a real swim-up — completely unaffected. The cap is
      // only applied to the assist's OWN contribution (only clamps when the
      // pre-assist velocity was already below the cap) — it must never pull
      // a genuinely stronger upward velocity DOWN to SWIM_UP_SPEED, which
      // would perversely cancel most of a same-frame/adjacent-frame on-
      // ground jump impulse (JUMP_V=9.0) the moment the body leaves the
      // ground into this still-feetInWater window right after jumping.
      if (feetInWater && !body.inWater && !body.onGround && input.jump && body.vel.y < SWIM_UP_SPEED) {
        body.vel.y = Math.min(body.vel.y + SWIM_ACCEL * 0.5 * dt, SWIM_UP_SPEED);
      }
    }

    // ---- integrate with axis-separated collision: Y, then X, then Z ----
    var hw = body.width * 0.5;
    var min = [body.pos.x - hw, body.pos.y, body.pos.z - hw];
    var max = [body.pos.x + hw, body.pos.y + body.height, body.pos.z + hw];

    var dy = body.vel.y * dt;
    var movedY = sweepAxis(world, min, max, 1, dy);
    if (movedY !== dy) {
      if (dy < 0) body.onGround = true;
      body.vel.y = 0;
    } else if (dy !== 0) {
      body.onGround = false;
    }
    if (movedY < 0 && mode !== 'fly' && !body.inWater) {
      body.fallDistance += -movedY;
    }

    var dx = body.vel.x * dt;
    if (sweepAxis(world, min, max, 0, dx) !== dx) body.vel.x = 0;

    var dz = body.vel.z * dt;
    if (sweepAxis(world, min, max, 2, dz) !== dz) body.vel.z = 0;

    body.pos.x = (min[0] + max[0]) * 0.5;
    body.pos.y = min[1];
    body.pos.z = (min[2] + max[2]) * 0.5;

    // Refresh water flags at the final position so callers see current state.
    updateWaterFlags(world, body, !!input.sneak && mode !== 'fly');
  }

  // ---- public: fallDamage ----
  function fallDamage(fallDistance) {
    var d = +fallDistance || 0;
    if (d < 3.5) return 0;
    var dmg = Math.round(d - 3);
    return dmg > 0 ? dmg : 0;
  }

  // ---- module export ----
  var Physics = {
    createBody: createBody,
    step: step,
    fallDamage: fallDamage,
    // Extra read-only constants (handy for Game/HUD tuning displays).
    GRAVITY: GRAVITY,
    JUMP_V: JUMP_V,
    WALK_SPEED: WALK_SPEED,
    SPRINT_SPEED: SPRINT_SPEED,
    SNEAK_SPEED: SNEAK_SPEED,
    FLY_SPEED: FLY_SPEED,
    FLY_SPRINT_SPEED: FLY_SPRINT_SPEED,
    FLY_VERT_SPEED: FLY_VERT_SPEED,
    EYE_STAND: EYE_STAND,
    EYE_SNEAK: EYE_SNEAK
  };
  return Physics;
})();

window.Physics = Physics;
