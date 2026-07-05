// vox/input.js -- global Input.
//
// Unified player input for CLOBI CRAFT: desktop keyboard/mouse (pointer lock)
// AND mobile touch controls (floating joystick, look-drag, tap/long-press
// block interaction, on-screen buttons). Contract: ARCHITECTURE-3D.md §5.10 + §8.
//
//   Input.init({canvas, hudRoot})   // installs listeners; touch DOM into hudRoot
//   Input.isTouch                   // maxTouchPoints > 0 && coarse pointer
//   Input.state                     // live {forward,back,left,right,jump,sneak,sprint}
//   Input.move                      // analog {forward:-1..1, strafe:-1..1}
//   Input.consumeLook() -> {dx,dy}  // accumulated look deltas since last call
//   Input.consumeActions() -> [{type:...}, ...]
//     // 'breakStart'|'breakStop'|'place'|'pick' (crosshair) and
//     // 'tapPlace'|'tapBreakStart' (with px,py CSS pixels)|'tapBreakStop' (touch)
//   Input.on(evt, fn)               // 'hotbar'|'hotbarScroll'|'chat'|'pause'|
//                                   // 'debug'|'perspective'|'inventory'|'flyToggle'
//   Input.setUIMode(on)             // chat/menu open: all held game state released
//   Input.requestPointerLock()/exitPointerLock()/isLocked
//   Input.setTouchVisible(on)       // touch controls shown + touch listeners active
//   Input.setFlying(on)             // extra: shows/hides fly up/down touch buttons
//
// Desktop map: WASD move, Space jump (double-Space 350 ms = flyToggle),
// Shift sneak, Ctrl/R sprint, E inventory, T chat, '/' chat-prefill, Esc pause
// (via pointer-lock loss), F3 debug, F5 perspective, 1-9 hotbar, wheel scroll,
// LMB hold break / RMB place / MMB pick.
//
// Touch (§8): floating joystick spawns at touch-down in the left 45% of the
// screen (cap radius 56 px, analog); right region drags look; tap = place,
// long-press 280 ms + hold = break, both through the tapped screen point.
// All touch handlers are passive:false and only act while setTouchVisible(true)
// so pinch-zoom on non-game screens is never broken.
//
// Exposes exactly one global: window.Input
// Depends on globals: I18n (optional, button labels).

var Input = (function () {
  'use strict';

  // ---- tuning constants ----
  var DOUBLE_TAP_MS = 350;     // double-space / double-jump fly toggle window
  var LONG_PRESS_MS = 280;     // touch hold-to-break threshold
  var TAP_SLOP_PX = 12;        // movement beyond this cancels tap/long-press
  var JOY_CAP_PX = 56;         // joystick knob cap radius (CSS px)
  var JOY_ZONE = 0.45;         // joystick spawns in the left 45% of the screen
  var TOUCH_LOOK_SCALE = 1.8;  // touch px -> look px (≈0.28°/px with typical sens)

  // ---- module state ----
  var canvas = null;
  var hudRoot = null;
  var inited = false;
  var uiMode = false;
  var touchActive = false;
  var isTouchCached = detectTouch();

  var state = {
    forward: false, back: false, left: false, right: false,
    jump: false, sneak: false, sprint: false
  };
  var keyHeld = {};            // e.code -> bool (movement keys only)
  var actions = [];
  var lookDX = 0, lookDY = 0;
  var breakHeld = false;       // desktop LMB held
  var lastSpaceTime = 0;
  var lastJumpTapTime = 0;
  var handlers = {};           // evt -> [fn]
  var prevLocked = false;

  // touch state
  var touchDom = null;         // {container, joy, knob, btns:{...}}
  var joyTouchId = null;
  var joyOrigin = { x: 0, y: 0 };
  var joyVec = { f: 0, s: 0 };
  var lookTouches = {};        // identifier -> {lastX,lastY,startX,startY,t0,moved,pressing,timer}
  var pressTouchId = null;     // the one finger currently long-press breaking
  var jumpHeld = false, flyUpHeld = false, flyDownHeld = false, sneakToggle = false, sprintToggle = false;

  // ---- tiny helpers ----
  function tr(key, fb) {
    return (typeof I18n !== 'undefined' && I18n && I18n.t) ? I18n.t(key, fb) : fb;
  }
  function detectTouch() {
    try {
      return (navigator.maxTouchPoints > 0) &&
        !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) {
      return false;
    }
  }
  function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }
  function now() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }
  function emit(evt, arg) {
    var list = handlers[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg); } catch (e) { /* one bad listener never kills input */ }
    }
  }
  function isEditableTarget(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    var tag = t.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable === true;
  }

  // ---- held-state recompute (touch buttons feed the same state booleans) ----
  function recomputeHeld() {
    state.jump = jumpHeld || flyUpHeld || !!keyHeld.Space;
    state.sneak = sneakToggle || flyDownHeld ||
      !!keyHeld.ShiftLeft || !!keyHeld.ShiftRight;
    state.sprint = sprintToggle || !!keyHeld.ControlLeft || !!keyHeld.ControlRight || !!keyHeld.KeyR;
  }

  function releaseAll() {
    state.forward = state.back = state.left = state.right = false;
    state.jump = state.sneak = state.sprint = false;
    keyHeld = {};
    jumpHeld = flyUpHeld = flyDownHeld = false;
    // sneakToggle/sprintToggle are also cleared here (and their button .on
    // classes unpinned) so the next recomputeHeld() -- triggered by any
    // keydown/keyup while UI mode is on -- can't silently re-derive
    // state.sneak/sprint from a stale latch and undo this release.
    sneakToggle = sprintToggle = false;
    if (touchDom) {
      touchDom.btns.sneak.classList.remove('on');
      touchDom.btns.sprint.classList.remove('on');
    }
    if (breakHeld) { actions.push({ type: 'breakStop' }); breakHeld = false; }
    stopAllTouches();
    resetJoystick();
    lookDX = 0;
    lookDY = 0;
  }

  // ---- keyboard ----
  var MOVE_CODES = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right'
  };

  function onKeyDown(e) {
    if (isEditableTarget(e)) return;
    if (uiMode) return;

    var code = e.code;

    // F-keys work even without pointer lock (and must not reach the browser).
    if (code === 'F3') { e.preventDefault(); emit('debug'); return; }
    if (code === 'F5') { e.preventDefault(); emit('perspective'); return; }

    if (code === 'Escape') {
      // While pointer-locked the browser exits the lock itself and the
      // pointerlockchange handler emits 'pause'; only handle the unlocked case.
      if (!isLockedNow()) emit('pause');
      return;
    }

    var dir = MOVE_CODES[code];
    if (dir) { state[dir] = true; e.preventDefault(); return; }

    switch (code) {
      case 'Space':
        e.preventDefault();
        keyHeld.Space = true;
        recomputeHeld();
        if (!e.repeat) {
          var t = now();
          if (t - lastSpaceTime < DOUBLE_TAP_MS) {
            lastSpaceTime = 0;
            emit('flyToggle');
          } else {
            lastSpaceTime = t;
          }
        }
        return;
      case 'ShiftLeft':
      case 'ShiftRight':
        keyHeld[code] = true;
        recomputeHeld();
        return;
      case 'ControlLeft':
      case 'ControlRight':
      case 'KeyR':
        e.preventDefault();
        keyHeld[code] = true;
        recomputeHeld();
        return;
      case 'KeyE':
        e.preventDefault();
        if (!e.repeat) emit('inventory');
        return;
      case 'KeyT':
        e.preventDefault();
        if (!e.repeat) emit('chat', '');
        return;
    }

    // '/' opens chat pre-filled -- match by key so it works on any layout.
    if (e.key === '/') {
      e.preventDefault();
      if (!e.repeat) emit('chat', '/');
      return;
    }

    // 1..9 hotbar
    if (code.length === 6 && code.indexOf('Digit') === 0) {
      var n = code.charCodeAt(5) - 49; // '1' -> 0
      if (n >= 0 && n <= 8) { emit('hotbar', n); return; }
    }
  }

  function onKeyUp(e) {
    // keyup ALWAYS clears state, even in UI mode, so nothing sticks.
    var code = e.code;
    var dir = MOVE_CODES[code];
    if (dir) { state[dir] = false; return; }
    switch (code) {
      case 'Space':
      case 'ShiftLeft':
      case 'ShiftRight':
        keyHeld[code] = false;
        recomputeHeld();
        return;
      case 'ControlLeft':
      case 'ControlRight':
      case 'KeyR':
        keyHeld[code] = false;
        recomputeHeld();
        return;
    }
  }

  // ---- mouse (desktop) ----
  function onMouseDown(e) {
    if (uiMode) return;
    if (e.button === 0) {
      breakHeld = true;
      actions.push({ type: 'breakStart' });
    } else if (e.button === 1) {
      e.preventDefault(); // no autoscroll
      actions.push({ type: 'pick' });
    } else if (e.button === 2) {
      actions.push({ type: 'place' });
    }
  }

  function onMouseUp(e) {
    if (e.button === 0 && breakHeld) {
      breakHeld = false;
      actions.push({ type: 'breakStop' });
    }
  }

  function onMouseMove(e) {
    if (uiMode || !isLockedNow()) return;
    lookDX += e.movementX || 0;
    lookDY += e.movementY || 0;
  }

  function onWheel(e) {
    if (uiMode) return;
    e.preventDefault();
    if (e.deltaY > 0) emit('hotbarScroll', 1);
    else if (e.deltaY < 0) emit('hotbarScroll', -1);
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  function onPointerLockChange() {
    var locked = isLockedNow();
    if (!locked && prevLocked) {
      // Esc (or alt-tab) broke the lock -> that IS the pause gesture on desktop.
      var wasUi = uiMode;
      releaseAll();
      if (!wasUi) emit('pause');
    }
    prevLocked = locked;
  }

  function isLockedNow() {
    return !!canvas && document.pointerLockElement === canvas;
  }

  function onBlur() {
    releaseAll();
  }

  // ---- touch: joystick ----
  function resetJoystick() {
    joyTouchId = null;
    joyVec.f = 0;
    joyVec.s = 0;
    if (touchDom) {
      touchDom.joy.style.display = 'none';
      touchDom.knob.style.transform = 'translate(-50%, -50%)';
    }
  }

  function startJoystick(t) {
    joyTouchId = t.identifier;
    joyOrigin.x = t.clientX;
    joyOrigin.y = t.clientY;
    joyVec.f = 0;
    joyVec.s = 0;
    if (touchDom) {
      touchDom.joy.style.left = t.clientX + 'px';
      touchDom.joy.style.top = t.clientY + 'px';
      touchDom.joy.style.display = 'block';
      touchDom.knob.style.transform = 'translate(-50%, -50%)';
    }
  }

  function moveJoystick(t) {
    var dx = t.clientX - joyOrigin.x;
    var dy = t.clientY - joyOrigin.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > JOY_CAP_PX) {
      dx *= JOY_CAP_PX / len;
      dy *= JOY_CAP_PX / len;
    }
    joyVec.s = clamp1(dx / JOY_CAP_PX);
    joyVec.f = clamp1(-dy / JOY_CAP_PX);
    if (touchDom) {
      touchDom.knob.style.transform =
        'translate(-50%, -50%) translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    }
  }

  // ---- touch: look / tap / long-press on the canvas ----
  function stopAllTouches() {
    for (var id in lookTouches) {
      var rec = lookTouches[id];
      if (rec && rec.timer) clearTimeout(rec.timer);
    }
    lookTouches = {};
    if (pressTouchId !== null) {
      actions.push({ type: 'tapBreakStop' });
      pressTouchId = null;
    }
  }

  function onTouchStart(e) {
    if (!touchActive) return; // inactive -> never block pinch-zoom elsewhere
    e.preventDefault();
    if (uiMode) return;
    var vw = window.innerWidth || 1;
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (joyTouchId === null && t.clientX < vw * JOY_ZONE) {
        startJoystick(t);
      } else {
        startLookTouch(t);
      }
    }
  }

  function startLookTouch(t) {
    var id = t.identifier;
    var rec = {
      lastX: t.clientX, lastY: t.clientY,
      startX: t.clientX, startY: t.clientY,
      t0: now(), moved: false, pressing: false, timer: null
    };
    rec.timer = setTimeout(function () {
      rec.timer = null;
      // Still down, hasn't wandered, and no other finger is already breaking.
      if (lookTouches[id] === rec && !rec.moved && pressTouchId === null && !uiMode) {
        rec.pressing = true;
        pressTouchId = id;
        actions.push({ type: 'tapBreakStart', px: rec.lastX, py: rec.lastY });
      }
    }, LONG_PRESS_MS);
    lookTouches[id] = rec;
  }

  function onTouchMove(e) {
    if (!touchActive) return;
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier === joyTouchId) {
        moveJoystick(t);
        continue;
      }
      var rec = lookTouches[t.identifier];
      if (!rec) continue;
      var ddx = t.clientX - rec.lastX;
      var ddy = t.clientY - rec.lastY;
      rec.lastX = t.clientX;
      rec.lastY = t.clientY;
      var sx = t.clientX - rec.startX, sy = t.clientY - rec.startY;
      if (!rec.moved && (sx * sx + sy * sy) > TAP_SLOP_PX * TAP_SLOP_PX) {
        rec.moved = true;
        if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; } // a drag, not a press
      }
      if (rec.pressing) {
        // While breaking, the finger re-aims the break ray instead of the camera.
        if (ddx !== 0 || ddy !== 0) {
          actions.push({ type: 'tapBreakStart', px: rec.lastX, py: rec.lastY });
        }
      } else if (!uiMode) {
        lookDX += ddx * TOUCH_LOOK_SCALE;
        lookDY += ddy * TOUCH_LOOK_SCALE;
      }
    }
  }

  function onTouchEnd(e) {
    if (!touchActive) return;
    e.preventDefault();
    endTouches(e, /*cancelled=*/false);
  }

  function onTouchCancel(e) {
    if (!touchActive) return;
    endTouches(e, /*cancelled=*/true);
  }

  function endTouches(e, cancelled) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier === joyTouchId) {
        resetJoystick();
        continue;
      }
      var rec = lookTouches[t.identifier];
      if (!rec) continue;
      delete lookTouches[t.identifier];
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      if (rec.pressing) {
        actions.push({ type: 'tapBreakStop' });
        if (pressTouchId === t.identifier) pressTouchId = null;
      } else if (!cancelled && !rec.moved && (now() - rec.t0) < LONG_PRESS_MS && !uiMode) {
        actions.push({ type: 'tapPlace', px: t.clientX, py: t.clientY });
      }
    }
  }

  // ---- touch: DOM construction (only when Input.isTouch) ----
  function styleButton(el, size) {
    var s = el.style;
    s.position = 'absolute';
    s.width = size + 'px';
    s.height = size + 'px';
    s.borderRadius = '50%';
    s.border = '2px solid rgba(255,255,255,0.35)';
    s.background = 'rgba(18,22,32,0.45)';
    s.color = '#fff';
    s.fontSize = Math.round(size * 0.42) + 'px';
    s.lineHeight = size + 'px';
    s.textAlign = 'center';
    s.padding = '0';
    s.pointerEvents = 'auto';
    s.touchAction = 'none';
    s.userSelect = 'none';
    s.webkitUserSelect = 'none';
    s.webkitTapHighlightColor = 'transparent';
  }

  function mkButton(cls, glyph, i18nKey, fallback, size, pos) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = glyph;
    b.setAttribute('aria-label', tr(i18nKey, fallback));
    b.title = tr(i18nKey, fallback);
    styleButton(b, size);
    for (var k in pos) b.style[k] = pos[k];
    return b;
  }

  // Hold-style button: pressed while the finger is down.
  function wireHold(btn, set) {
    btn.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (uiMode) return;
      set(true);
      recomputeHeld();
    }, { passive: false });
    var release = function (e) {
      e.preventDefault();
      set(false);
      recomputeHeld();
    };
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
  }

  // Tap-style button: fires an emitter event on touch-down.
  function wireTap(btn, fn, allowInUiMode) {
    btn.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (uiMode && !allowInUiMode) return;
      fn();
    }, { passive: false });
  }

  function buildTouchDom() {
    if (touchDom || !hudRoot) return;

    var container = document.createElement('div');
    container.className = 'vox-touch';
    var cs = container.style;
    cs.position = 'absolute';
    cs.left = '0';
    cs.top = '0';
    cs.right = '0';
    cs.bottom = '0';
    cs.pointerEvents = 'none';
    cs.touchAction = 'none';
    cs.display = 'none';
    cs.zIndex = '30';

    // floating joystick (hidden until a touch spawns it)
    var joy = document.createElement('div');
    joy.className = 'vox-joy';
    var js = joy.style;
    js.position = 'absolute';
    js.width = (JOY_CAP_PX * 2 + 12) + 'px';
    js.height = (JOY_CAP_PX * 2 + 12) + 'px';
    js.borderRadius = '50%';
    js.border = '2px solid rgba(255,255,255,0.3)';
    js.background = 'rgba(255,255,255,0.08)';
    js.transform = 'translate(-50%, -50%)';
    js.pointerEvents = 'none';
    js.display = 'none';

    var knob = document.createElement('div');
    knob.className = 'vox-joy-knob';
    var ks = knob.style;
    ks.position = 'absolute';
    ks.left = '50%';
    ks.top = '50%';
    ks.width = '48px';
    ks.height = '48px';
    ks.borderRadius = '50%';
    ks.background = 'rgba(255,255,255,0.35)';
    ks.transform = 'translate(-50%, -50%)';
    ks.pointerEvents = 'none';
    joy.appendChild(knob);
    container.appendChild(joy);

    // safe-area aware placement helpers
    function bottomRight(bpx, rpx) {
      return {
        bottom: 'calc(' + bpx + 'px + env(safe-area-inset-bottom, 0px))',
        right: 'calc(' + rpx + 'px + env(safe-area-inset-right, 0px))'
      };
    }
    function topRight(tpx, rpx) {
      return {
        top: 'calc(' + tpx + 'px + env(safe-area-inset-top, 0px))',
        right: 'calc(' + rpx + 'px + env(safe-area-inset-right, 0px))'
      };
    }

    var btns = {
      jump: mkButton('vox-btn-jump', '⬆', 'vox.touch.jump', 'Jump', 64, bottomRight(24, 20)),
      sneak: mkButton('vox-btn-sneak', '⬇', 'vox.touch.sneak', 'Sneak', 56, bottomRight(28, 100)),
      sprint: mkButton('vox-btn-sprint', '»', 'vox.touch.sprint', 'Sprint', 56, bottomRight(28, 168)),
      flyUp: mkButton('vox-btn-fly-up', '▲', 'vox.touch.flyUp', 'Fly up', 56, bottomRight(104, 24)),
      flyDown: mkButton('vox-btn-fly-down', '▼', 'vox.touch.flyDown', 'Fly down', 56, bottomRight(104, 100)),
      pause: mkButton('vox-btn-pause', '⏸', 'vox.touch.pause', 'Pause', 48, topRight(10, 10)),
      chat: mkButton('vox-btn-chat', '💬', 'vox.touch.chat', 'Chat', 48, topRight(10, 66)),
      inv: mkButton('vox-btn-inv', '🎒', 'vox.touch.inventory', 'Inventory', 48, topRight(10, 122)),
      persp: mkButton('vox-btn-persp', '👁', 'vox.touch.perspective', 'Perspective', 48, topRight(10, 178))
    };

    // fly buttons stay hidden until Game reports flying via setFlying(true)
    btns.flyUp.style.display = 'none';
    btns.flyDown.style.display = 'none';

    // JUMP: hold = jump/swim/fly-up; double-tap = fly toggle
    btns.jump.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (uiMode) return;
      jumpHeld = true;
      recomputeHeld();
      var t = now();
      if (t - lastJumpTapTime < DOUBLE_TAP_MS) {
        lastJumpTapTime = 0;
        emit('flyToggle');
      } else {
        lastJumpTapTime = t;
      }
    }, { passive: false });
    var jumpUp = function (e) {
      e.preventDefault();
      jumpHeld = false;
      recomputeHeld();
    };
    btns.jump.addEventListener('touchend', jumpUp, { passive: false });
    btns.jump.addEventListener('touchcancel', jumpUp, { passive: false });

    // SNEAK: toggle (pinned .on class shows the latched state)
    btns.sneak.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (uiMode) return;
      sneakToggle = !sneakToggle;
      btns.sneak.classList.toggle('on', sneakToggle);
      recomputeHeld();
    }, { passive: false });

    // SPRINT: toggle (a hold button would fight the joystick thumb on touch)
    btns.sprint.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (uiMode) return;
      sprintToggle = !sprintToggle;
      btns.sprint.classList.toggle('on', sprintToggle);
      recomputeHeld();
    }, { passive: false });

    wireHold(btns.flyUp, function (on) { flyUpHeld = on; });
    wireHold(btns.flyDown, function (on) { flyDownHeld = on; });

    wireTap(btns.pause, function () { emit('pause'); }, /*allowInUiMode=*/true);
    wireTap(btns.chat, function () { emit('chat', ''); }, false);
    wireTap(btns.inv, function () { emit('inventory'); }, false);
    wireTap(btns.persp, function () { emit('perspective'); }, false);

    for (var k in btns) container.appendChild(btns[k]);
    hudRoot.appendChild(container);
    touchDom = { container: container, joy: joy, knob: knob, btns: btns };
  }

  // ---- public API ----
  function init(opts) {
    opts = opts || {};
    canvas = opts.canvas || canvas;
    hudRoot = opts.hudRoot || hudRoot;
    isTouchCached = detectTouch();

    if (isTouchCached && hudRoot && !touchDom) buildTouchDom();
    if (inited) return; // listeners are global; never double-install
    inited = true;

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    if (canvas) {
      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('contextmenu', onContextMenu);
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchmove', onTouchMove, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd, { passive: false });
      canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });
    }
  }

  function consumeLook() {
    var out = { dx: lookDX, dy: lookDY };
    lookDX = 0;
    lookDY = 0;
    return out;
  }

  function consumeActions() {
    if (actions.length === 0) return [];
    var out = actions;
    actions = [];
    return out;
  }

  function on(evt, fn) {
    (handlers[evt] || (handlers[evt] = [])).push(fn);
  }

  function off(evt, fn) {
    var list = handlers[evt];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  function setUIMode(onFlag) {
    var next = !!onFlag;
    if (next === uiMode) return;
    uiMode = next;
    if (uiMode) releaseAll();
    else recomputeHeld(); // re-apply the latched touch sneak toggle
  }

  function requestPointerLock() {
    if (!canvas || !canvas.requestPointerLock) return;
    try {
      var p = canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(function () { /* denied: fine */ });
    } catch (e) { /* older browsers throw; ignore */ }
  }

  function exitPointerLock() {
    try {
      if (document.exitPointerLock) document.exitPointerLock();
    } catch (e) { /* ignore */ }
  }

  function setTouchVisible(onFlag) {
    touchActive = !!onFlag && isTouchCached;
    if (touchDom) touchDom.container.style.display = touchActive ? 'block' : 'none';
    if (canvas) canvas.style.touchAction = touchActive ? 'none' : '';
    if (!touchActive) {
      stopAllTouches();
      resetJoystick();
      jumpHeld = flyUpHeld = flyDownHeld = false;
      recomputeHeld();
    }
  }

  // Extra (not pinned): Game may call this so UP/DOWN buttons appear while
  // flying (§8). If it never does, JUMP/SNEAK still cover fly up/down.
  function setFlying(onFlag) {
    if (!touchDom) return;
    var d = onFlag ? '' : 'none';
    touchDom.btns.flyUp.style.display = d;
    touchDom.btns.flyDown.style.display = d;
  }

  // ---- module export ----
  var Input = {
    init: init,
    state: state,
    consumeLook: consumeLook,
    consumeActions: consumeActions,
    on: on,
    off: off,
    setUIMode: setUIMode,
    requestPointerLock: requestPointerLock,
    exitPointerLock: exitPointerLock,
    setTouchVisible: setTouchVisible,
    setFlying: setFlying,
    get move() {
      var f, s;
      if (joyTouchId !== null) {
        f = joyVec.f;
        s = joyVec.s;
      } else {
        f = (state.forward ? 1 : 0) - (state.back ? 1 : 0);
        s = (state.right ? 1 : 0) - (state.left ? 1 : 0);
      }
      return { forward: clamp1(f), strafe: clamp1(s) };
    },
    get isTouch() { return isTouchCached; },
    get isLocked() { return isLockedNow(); }
  };
  return Input;
})();

window.Input = Input;
