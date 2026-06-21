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
      case 'Space':
      case 'KeyJ':
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
    var flag = mapKey(e);
    if (flag) {
      held[flag] = false;
    }
  }

  function onBlur() {
    // Losing window focus: release everything so the character stops moving.
    clearHeld();
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
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', buildVimOverlay, { once: true });
    } else {
      buildVimOverlay();
    }
  }

  function getState() {
    // Movement is suppressed entirely while the vim line is focused.
    if (vimOpen) {
      return { dx: 0, dy: 0, attack: false, throw: false, dash: false };
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

    return {
      dx: dx,
      dy: dy,
      attack: held.attack,
      throw: held.throw,
      dash: held.dash,
    };
  }

  function consumeVimCommand() {
    if (pendingVimCommand === null) return null;
    var cmd = pendingVimCommand;
    pendingVimCommand = null;
    return cmd;
  }

  function isVimOpen() {
    return vimOpen;
  }

  return {
    init: init,
    getState: getState,
    consumeVimCommand: consumeVimCommand,
    isVimOpen: isVimOpen,
  };
})();

window.Input = Input;
