// input.js — global Input (TUX SMASH ROYALE).
//
// Responsibilities (per the project contract):
//   - Track held keys: WASD + arrows move; Space/J attack; K throw; Shift dash.
//   - Provide a small 8-bit "vim command line" overlay opened with "/"; the typed
//     text is exposed exactly once via Input.consumeVimCommand() (one-shot, then
//     cleared). Movement/action keys are ignored while the vim line is focused.
//
// Public API (assigns exactly ONE global, window.Input):
//   Input.init()                 -> attach key listeners + build the vim overlay
//   Input.getState()             -> {dx, dy, attack, throw, dash}
//   Input.consumeVimCommand()    -> string (the command, ':' stripped) or null
//   Input.isVimOpen()            -> bool (helper; movement is suppressed while true)
//
// 8-bit styling matches the style guide: Press Start 2P, hard borders, minty cyan
// (#7ff9e0) accents, dark slate (#1a1d2e) background, no rounded corners, pixelated.

const Input = (function () {
  'use strict';

  // ---- held key state ---------------------------------------------------
  // Raw directional/action flags; the movement vector is derived in getState().
  var held = {
    up: false,
    down: false,
    left: false,
    right: false,
    attack: false,
    throw: false,
    dash: false,
  };

  // Jump is edge-triggered (one jump per press); jumpKeyHeld guards OS key-repeat.
  var jumpEdge = false;
  var jumpKeyHeld = false;
  function isJumpCode(code) {
    return code === 'Space' || code === 'KeyW' || code === 'ArrowUp';
  }

  // Mouse: aim position (viewport px) + buttons (left = attack, right = throw).
  var mouseX = 0, mouseY = 0, mouseMoved = false;
  var mAttack = false, mThrow = false;

  var initialized = false;

  // ---- vim command overlay state ---------------------------------------
  var vimOverlay = null; // container element
  var vimInput = null; // the <input> element
  var vimOpen = false; // is the overlay shown + focused?
  var pendingVimCommand = null; // one-shot buffer, drained by consumeVimCommand()

  // ---- key mapping ------------------------------------------------------
  // Map a KeyboardEvent to one of our held-state flag names, or null. We prefer
  // e.code (keyboard-layout independent) so AZERTY/QWERTZ players still move.
  function mapKey(e) {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        return 'up';
      case 'KeyS':
      case 'ArrowDown':
        return 'down';
      case 'KeyA':
      case 'ArrowLeft':
        return 'left';
      case 'KeyD':
      case 'ArrowRight':
        return 'right';
      case 'KeyJ':
      case 'KeyL':
        return 'attack';
      case 'KeyK':
        return 'throw';
      case 'ShiftLeft':
      case 'ShiftRight':
        return 'dash';
      default:
        return null;
    }
  }

  function clearHeld() {
    held.up = held.down = held.left = held.right = false;
    held.attack = held.throw = held.dash = false;
    jumpKeyHeld = false;
    mAttack = mThrow = false;
  }

  // ---- vim command overlay ---------------------------------------------
  function buildVimOverlay() {
    if (vimOverlay) return;

    var overlay = document.createElement('div');
    overlay.id = 'vim-overlay';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.zIndex = '9000';
    overlay.style.display = 'none';
    overlay.style.padding = '10px';
    overlay.style.boxSizing = 'border-box';
    overlay.style.background = '#1a1d2e';
    overlay.style.borderTop = '4px solid #7ff9e0';
    overlay.style.boxShadow = '0 -6px 0 0 rgba(0,0,0,0.6)';
    overlay.style.fontFamily = "'Press Start 2P', monospace";
    overlay.style.imageRendering = 'pixelated';

    var row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.maxWidth = '720px';
    row.style.margin = '0 auto';

    var prompt = document.createElement('span');
    prompt.textContent = ':';
    prompt.style.color = '#7ff9e0';
    prompt.style.fontSize = '16px';
    prompt.style.marginRight = '8px';
    prompt.style.lineHeight = '1';
    prompt.style.userSelect = 'none';

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'vim-input';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'vim command');
    input.style.flex = '1';
    input.style.minWidth = '0';
    input.style.background = '#0e1020';
    input.style.color = '#7ff9e0';
    input.style.border = '3px solid #7ff9e0';
    input.style.borderRadius = '0';
    input.style.outline = 'none';
    input.style.padding = '8px';
    input.style.fontFamily = "'Press Start 2P', monospace";
    input.style.fontSize = '12px';
    input.style.letterSpacing = '1px';
    input.style.imageRendering = 'pixelated';

    var hint = document.createElement('span');
    hint.id = 'vim-hint';
    hint.textContent = ':wq  dd  sudo';
    hint.style.color = '#566089';
    hint.style.fontSize = '8px';
    hint.style.marginLeft = '10px';
    hint.style.whiteSpace = 'nowrap';
    hint.style.userSelect = 'none';

    row.appendChild(prompt);
    row.appendChild(input);
    row.appendChild(hint);
    overlay.appendChild(row);

    // Prefer the game screen as host so the overlay sits over the canvas; fall
    // back to <body> if the screen container isn't in the DOM yet.
    var host = document.getElementById('screen-game') || document.body;
    host.appendChild(overlay);

    // Keystrokes inside the field must never leak out to the global game binds.
    input.addEventListener('keydown', onVimInputKeydown);

    vimOverlay = overlay;
    vimInput = input;
  }

  function openVim(prefill) {
    buildVimOverlay();
    // Drop all held movement/action keys so the character doesn't keep walking
    // (or attacking) while the player types a command.
    clearHeld();
    vimOpen = true;
    vimOverlay.style.display = 'block';
    vimInput.value = prefill || '';
    // Focus on the next frame so the triggering keypress isn't inserted into
    // the field, and the caret lands at the end.
    requestAnimationFrame(function () {
      if (vimOpen && vimInput) {
        vimInput.focus();
        var len = vimInput.value.length;
        try {
          vimInput.setSelectionRange(len, len);
        } catch (_) {
          /* some input states reject setSelectionRange; ignore */
        }
      }
    });
  }

  function closeVim() {
    vimOpen = false;
    if (vimOverlay) vimOverlay.style.display = 'none';
    if (vimInput) {
      vimInput.value = '';
      vimInput.blur();
    }
  }

  function submitVim() {
    if (!vimInput) {
      closeVim();
      return;
    }
    var cmd = vimInput.value.trim();
    // Tolerate a leading ':' the player may have typed even though we render one.
    if (cmd.charAt(0) === ':') cmd = cmd.slice(1).trim();
    if (cmd.length > 0) {
      // Newest command wins if a previous one wasn't consumed yet.
      pendingVimCommand = cmd;
    }
    closeVim();
  }

  function onVimInputKeydown(e) {
    // Keep these keystrokes local to the field; they must not move the player.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submitVim();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeVim();
    }
    // All other keys: let the input element handle them normally.
  }

  // ---- global key handlers ---------------------------------------------
  // True when the global game keybinds must NOT fire for this event.
  function shouldIgnoreGlobalKeys(e) {
    // While the vim line is open the game binds are inert.
    if (vimOpen) return true;
    // If focus is in any text-entry element (nickname field, account modal,
    // editor name field, room name, password, etc.) we must not steal the keys.
    var t = e.target;
    if (t && t !== document.body) {
      var tag = (t.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (t.isContentEditable) return true;
    }
    return false;
  }

  function onKeyDown(e) {
    // Open the vim command line with "/". We do this before the focus/ignore
    // check so it works whenever the game screen has keyboard focus.
    if (!vimOpen && !shouldIgnoreGlobalKeys(e)) {
      if (e.key === '/') {
        e.preventDefault();
        // Don't prefill the slash itself.
        openVim('');
        return;
      }
    }

    if (shouldIgnoreGlobalKeys(e)) return;

    // Direct vim specials (1/2/3) — fire instantly, never interrupt movement.
    if (e.code === 'Digit1' || e.code === 'Numpad1') { fireVim(':wq'); e.preventDefault(); return; }
    if (e.code === 'Digit2' || e.code === 'Numpad2') { fireVim('dd'); e.preventDefault(); return; }
    if (e.code === 'Digit3' || e.code === 'Numpad3') { fireVim('sudo'); e.preventDefault(); return; }

    // Jump (Space / W / Up) — rising edge only.
    if (isJumpCode(e.code)) {
      if (!jumpKeyHeld) jumpEdge = true;
      jumpKeyHeld = true;
      e.preventDefault();
    }

    var flag = mapKey(e);
    if (flag) {
      held[flag] = true;
      // Stop Space/arrows from scrolling the page or activating focused buttons.
      e.preventDefault();
    }
  }

  function onKeyUp(e) {
    // While the vim line is open everything is already cleared and stays that
    // way; ignore key-ups so a stray release can't toggle a flag.
    if (vimOpen) return;
    if (isJumpCode(e.code)) jumpKeyHeld = false;
    var flag = mapKey(e);
    if (flag) {
      held[flag] = false;
    }
  }

  function onBlur() {
    // Losing window focus: release everything so the character stops moving.
    clearHeld();
  }

  // ---- mobile touch controls -------------------------------------------
  var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  var touchBuilt = false;

  function bindHold(btn, onDown, onUp) {
    function down(e) { e.preventDefault(); onDown(); }
    function up(e) { e.preventDefault(); if (onUp) onUp(); }
    btn.addEventListener('touchstart', down, { passive: false });
    btn.addEventListener('touchend', up, { passive: false });
    btn.addEventListener('touchcancel', up, { passive: false });
    btn.addEventListener('mousedown', down);
    btn.addEventListener('mouseup', up);
    btn.addEventListener('mouseleave', up);
  }

  function bindTap(btn, fn) {
    function go(e) { e.preventDefault(); fn(); }
    btn.addEventListener('touchstart', go, { passive: false });
    btn.addEventListener('mousedown', go);
  }

  // Mouse controls: aim by moving the mouse; left-click = attack, right = throw.
  function setupMouse() {
    var cv = document.getElementById('game-canvas');
    if (!cv) return;
    cv.addEventListener('mousemove', function (e) { mouseX = e.clientX; mouseY = e.clientY; mouseMoved = true; });
    cv.addEventListener('mousedown', function (e) {
      mouseX = e.clientX; mouseY = e.clientY; mouseMoved = true;
      if (e.button === 0) { mAttack = true; }
      else if (e.button === 2) { mThrow = true; e.preventDefault(); }
    });
    window.addEventListener('mouseup', function (e) {
      if (e.button === 0) mAttack = false;
      else if (e.button === 2) mThrow = false;
    });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function tcBtn(label, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tc-btn ' + (cls || '');
    b.textContent = label;
    return b;
  }

  function buildTouchControls() {
    if (touchBuilt) return;
    touchBuilt = true;
    injectTouchStyle();

    var wrap = document.createElement('div');
    wrap.id = 'touch-controls';

    // Left: move + fast-fall.
    var left = document.createElement('div');
    left.className = 'tc-cluster tc-left';
    var bL = tcBtn('◀', 'tc-move'), bD = tcBtn('▼', 'tc-move'), bR = tcBtn('▶', 'tc-move');
    bindHold(bL, function () { held.left = true; }, function () { held.left = false; });
    bindHold(bR, function () { held.right = true; }, function () { held.right = false; });
    bindHold(bD, function () { held.down = true; }, function () { held.down = false; });
    left.appendChild(bL); left.appendChild(bD); left.appendChild(bR);

    // Right: jump + actions + vim.
    var right = document.createElement('div');
    right.className = 'tc-cluster tc-right';
    var rVim = document.createElement('div'); rVim.className = 'tc-row';
    var rTop = document.createElement('div'); rTop.className = 'tc-row';
    var rBot = document.createElement('div'); rBot.className = 'tc-row';
    var vWq = tcBtn(':wq', 'tc-vim'), vDd = tcBtn('dd', 'tc-vim'), vSu = tcBtn('sudo', 'tc-vim');
    var bJump = tcBtn('▲', 'tc-jump');
    var bThr = tcBtn('T', 'tc-thr'), bAtk = tcBtn('A', 'tc-atk'), bDash = tcBtn('»', 'tc-dash');
    bindTap(vWq, function () { fireVim(':wq'); });
    bindTap(vDd, function () { fireVim('dd'); });
    bindTap(vSu, function () { fireVim('sudo'); });
    bindHold(bJump, function () { jumpEdge = true; }, null);
    bindHold(bAtk, function () { held.attack = true; }, function () { held.attack = false; });
    bindHold(bThr, function () { held.throw = true; }, function () { held.throw = false; });
    bindHold(bDash, function () { held.dash = true; }, function () { held.dash = false; });
    rVim.appendChild(vWq); rVim.appendChild(vDd); rVim.appendChild(vSu);
    rTop.appendChild(bJump);
    rBot.appendChild(bThr); rBot.appendChild(bAtk); rBot.appendChild(bDash);
    right.appendChild(rVim); right.appendChild(rTop); right.appendChild(rBot);

    wrap.appendChild(left); wrap.appendChild(right);
    var host = document.getElementById('screen-game') || document.body;
    host.appendChild(wrap);
  }

  function injectTouchStyle() {
    if (document.getElementById('touch-style')) return;
    var css = [
      '#touch-controls{position:fixed;left:0;right:0;bottom:0;z-index:8500;display:none;',
      'justify-content:space-between;align-items:flex-end;padding:14px;pointer-events:none;',
      'font-family:"Press Start 2P",monospace;}',
      'body.touch #touch-controls{display:flex;}',
      '.tc-cluster{display:flex;gap:10px;pointer-events:none;}',
      '.tc-left{align-items:flex-end;}',
      '.tc-right{flex-direction:column;align-items:flex-end;}',
      '.tc-row{display:flex;gap:10px;}',
      '.tc-btn{pointer-events:auto;width:58px;height:58px;font-family:inherit;font-size:16px;',
      'color:#e8ecff;background:rgba(17,19,31,0.72);border:3px solid #7ff9e0;box-shadow:3px 3px 0 #000;',
      'border-radius:0;-webkit-user-select:none;user-select:none;touch-action:none;}',
      '.tc-btn:active{background:#7ff9e0;color:#11131f;transform:translate(3px,3px);box-shadow:0 0 0 #000;}',
      '.tc-jump{border-color:#ff9e2c;width:70px;height:70px;}',
      '.tc-atk{border-color:#ff5a3c;}',
      '.tc-vim{border-color:#9cff5a;font-size:9px;width:auto;min-width:46px;height:42px;padding:0 8px;}',
      '@media (max-width:520px){.tc-btn{width:50px;height:50px;font-size:13px;}.tc-jump{width:60px;height:60px;}}'
    ].join('');
    var st = document.createElement('style'); st.id = 'touch-style'; st.textContent = css;
    document.head.appendChild(st);
  }

  // ---- public API -------------------------------------------------------
  function init() {
    if (initialized) return;
    initialized = true;

    // Capture phase so we can intercept "/" before other handlers and so Space
    // doesn't trigger a focused button.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);

    // Build the overlay once the DOM is ready.
    function buildOverlays() {
      buildVimOverlay();
      setupMouse();
      if (IS_TOUCH) {
        document.body.classList.add('touch');
        buildTouchControls();
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildOverlays, { once: true });
    } else {
      buildOverlays();
    }
  }

  function getState() {
    // Movement is suppressed entirely while the vim line is focused.
    if (vimOpen) {
      jumpEdge = false;
      return { dx: 0, dy: 0, attack: false, throw: false, dash: false, jump: false };
    }

    // Derive a movement vector from held flags. Normalize diagonals so they
    // aren't faster than cardinal movement.
    var dx = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    var dy = (held.down ? 1 : 0) - (held.up ? 1 : 0);

    if (dx !== 0 && dy !== 0) {
      var inv = 1 / Math.sqrt(2);
      dx *= inv;
      dy *= inv;
    }

    var jump = jumpEdge;
    jumpEdge = false;
    return {
      dx: dx,
      dy: dy,
      attack: held.attack || mAttack,
      throw: held.throw || mThrow,
      dash: held.dash,
      jump: jump,
    };
  }

  function getMouse() {
    return { x: mouseX, y: mouseY, moved: mouseMoved };
  }

  function consumeVimCommand() {
    if (pendingVimCommand === null) return null;
    var cmd = pendingVimCommand;
    pendingVimCommand = null;
    return cmd;
  }

  // fireVim queues a vim special WITHOUT opening the text line, so it never
  // blocks movement (used by the 1/2/3 hotkeys + the touch command buttons).
  function fireVim(cmd) {
    if (cmd) pendingVimCommand = cmd;
  }

  function isVimOpen() {
    return vimOpen;
  }

  return {
    init: init,
    getState: getState,
    consumeVimCommand: consumeVimCommand,
    fireVim: fireVim,
    getMouse: getMouse,
    isVimOpen: isVimOpen,
  };
})();

window.Input = Input;
