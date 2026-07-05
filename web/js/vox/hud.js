// hud.js — all in-game DOM UI for CLOBI CRAFT (contract §5.14).
// Exactly one global: window.HUD.
//
// Owns every game-screen element inside #hud-root: crosshair, hotbar (with
// fake-iso block icons drawn from the Blocks atlas canvas), hearts + bubbles,
// chat (log + input + history), debug panel, inventory panel (creative palette
// or survival backpack), pause overlay with settings sliders, death overlay,
// mode badge and title toast. Touch control DOM is owned by Input (§5.10) —
// HUD never touches it.
//
// Consumes: I18n (guarded), Input (setUIMode / isTouch / pointer lock, guarded),
//           Commands (chat Enter -> exec, guarded), Blocks (icons + names),
//           the Game api object handed to init (setters, debugSnapshot, ...).
//
// Pinned API:
//   HUD.init({root, game})  HUD.update(state)  HUD.chatPrint(text, cls?)
//   HUD.openChat(prefill?)  HUD.isChatOpen()   HUD.toast(text)
//   HUD.setDebug(v)/HUD.toggleDebug()          HUD.openInventory()/closeInventory()
//   HUD.showPaused(on, {onResume,onSettings,onQuit})   HUD.destroy()
// Extra public members (allowed by contract):
//   HUD.showDeath(on, {onRespawn})  HUD.isInventoryOpen()  HUD.isPaused()
//
// Settings persist to localStorage 'clobi3d.settings' ({dist,fov,lut,touch})
// and are re-applied by Game.start.

var HUD = (function () {
  'use strict';

  var SETTINGS_KEY = 'clobi3d.settings';
  var CHAT_MAX_LINES = 100;
  var CHAT_FADE_MS = 8000;
  var HISTORY_MAX = 32;

  // ---- helpers -------------------------------------------------------------

  function t(key, en) {
    return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, en) : en;
  }

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function isTouch() {
    return (typeof Input !== 'undefined') && !!Input.isTouch;
  }

  function setUIMode(on) {
    if (typeof Input !== 'undefined' && Input.setUIMode) Input.setUIMode(on);
  }

  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(SETTINGS_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }

  function saveSettings(partial) {
    try {
      var o = loadSettings();
      for (var k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) o[k] = partial[k];
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(o));
    } catch (e) { /* quota / private mode */ }
  }

  // ---- injected baseline CSS -----------------------------------------------
  // Functional layout only, so the HUD works even before the central stylesheet
  // lands; the pinned class names let dedicated CSS refine/override everything.

  var CSS = [
    '.vox-hud{position:absolute;inset:0;pointer-events:none;user-select:none;-webkit-user-select:none;color:#fff;font-family:inherit;overflow:hidden;z-index:5;}',
    '.vox-crosshair{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:22px;line-height:1;mix-blend-mode:difference;color:#fff;}',
    '.vox-hotbar{position:absolute;left:50%;bottom:calc(10px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;gap:4px;pointer-events:auto;}',
    '.vox-slot{position:relative;width:46px;height:46px;background:rgba(10,14,20,.55);border:2px solid rgba(255,255,255,.25);border-radius:4px;box-sizing:border-box;}',
    '.vox-slot.sel{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.35);}',
    '.vox-slot canvas{position:absolute;inset:1px;width:40px;height:40px;image-rendering:pixelated;}',
    '.vox-slot-count{position:absolute;right:2px;bottom:0;font-size:12px;font-weight:bold;text-shadow:1px 1px 0 #000;z-index:1;}',
    '.vox-bars{position:absolute;left:50%;bottom:calc(64px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:min(462px,94vw);display:flex;justify-content:space-between;pointer-events:none;}',
    '.vox-hearts,.vox-bubbles{display:flex;gap:1px;font-size:16px;line-height:1;text-shadow:1px 1px 0 rgba(0,0,0,.6);}',
    '.vox-heart{color:#ff3b3b;}.vox-heart.empty{color:rgba(255,255,255,.28);}',
    '.vox-heart.half{background:linear-gradient(90deg,#ff3b3b 50%,rgba(255,255,255,.28) 50%);-webkit-background-clip:text;background-clip:text;color:transparent;}',
    '.vox-bubble{color:#9fd8ff;}.vox-bubble.empty{color:rgba(255,255,255,.15);}',
    '.vox-chat{position:absolute;left:8px;bottom:calc(118px + env(safe-area-inset-bottom,0px));width:min(520px,72vw);pointer-events:none;}',
    '.vox-chat-log{display:flex;flex-direction:column;gap:2px;max-height:38vh;overflow:hidden;justify-content:flex-end;}',
    '.vox-chat-line{background:rgba(0,0,0,.45);padding:2px 8px;border-radius:3px;font-size:14px;line-height:1.35;word-break:break-word;transition:opacity .6s;}',
    '.vox-chat-line.err{color:#ff7b7b;}.vox-chat-line.sys{color:#ffe08a;}',
    '.vox-chat-input{display:none;width:100%;margin-top:4px;padding:8px;font-size:16px;font-family:inherit;color:#fff;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.35);border-radius:4px;outline:none;box-sizing:border-box;pointer-events:auto;}',
    '.vox-debug{display:none;position:absolute;top:8px;left:8px;padding:6px 10px;background:rgba(0,0,0,.55);font:12px/1.5 monospace;white-space:pre;border-radius:4px;}',
    '.vox-mode-badge{position:absolute;top:calc(10px + env(safe-area-inset-top,0px));right:calc(10px + env(safe-area-inset-right,0px));padding:4px 12px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.3);border-radius:12px;font-size:13px;opacity:0;transition:opacity .4s;}',
    '.vox-title-toast{position:absolute;left:50%;top:22%;transform:translateX(-50%);font-size:30px;font-weight:bold;text-shadow:2px 2px 0 rgba(0,0,0,.6);opacity:0;transition:opacity .5s;white-space:nowrap;}',
    '.vox-target-label{position:absolute;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);font-size:13px;opacity:.85;text-shadow:1px 1px 0 #000;}',
    '.vox-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;pointer-events:auto;}',
    '.vox-paused{background:rgba(6,10,16,.6);}',
    '.vox-death{background:rgba(110,0,0,.5);}',
    '.vox-overlay h2{margin:0 0 10px;font-size:32px;text-shadow:2px 2px 0 rgba(0,0,0,.5);}',
    '.vox-ui-btn{min-width:220px;padding:11px 22px;font:inherit;font-size:16px;color:#fff;background:rgba(30,42,58,.9);border:2px solid rgba(255,255,255,.35);border-radius:6px;cursor:pointer;}',
    '.vox-ui-btn:hover{background:rgba(52,70,94,.95);}',
    '.vox-settings{display:none;flex-direction:column;gap:12px;min-width:min(340px,90vw);background:rgba(12,18,26,.85);padding:18px;border-radius:8px;border:1px solid rgba(255,255,255,.2);}',
    '.vox-set-row{display:flex;align-items:center;gap:10px;font-size:14px;}',
    '.vox-set-row label{flex:0 0 42%;}',
    '.vox-set-row input[type=range]{flex:1;pointer-events:auto;}',
    '.vox-set-row .vox-set-val{flex:0 0 44px;text-align:right;font-family:monospace;}',
    '.vox-touch-sizes{display:flex;gap:6px;}',
    '.vox-touch-sizes button{flex:1;padding:6px;font:inherit;color:#fff;background:rgba(30,42,58,.9);border:1px solid rgba(255,255,255,.3);border-radius:4px;cursor:pointer;}',
    '.vox-touch-sizes button.sel{border-color:#fff;background:rgba(70,95,125,.95);}',
    '.vox-inv-panel{display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:94vw;max-height:80vh;overflow:auto;background:rgba(14,20,28,.94);border:2px solid rgba(255,255,255,.25);border-radius:8px;padding:14px;pointer-events:auto;}',
    '.vox-inv-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:16px;font-weight:bold;}',
    '.vox-inv-close{width:32px;height:32px;font:inherit;font-size:18px;color:#fff;background:rgba(30,42,58,.9);border:1px solid rgba(255,255,255,.3);border-radius:4px;cursor:pointer;}',
    '.vox-inv-grid{display:grid;grid-template-columns:repeat(9,46px);gap:4px;margin-bottom:10px;}',
    '.vox-inv-cell{position:relative;width:46px;height:46px;background:rgba(255,255,255,.06);border:2px solid rgba(255,255,255,.18);border-radius:4px;box-sizing:border-box;cursor:pointer;}',
    '.vox-inv-cell.sel{border-color:#ffd76b;}',
    '.vox-inv-cell canvas{position:absolute;inset:1px;width:40px;height:40px;image-rendering:pixelated;}',
    '.vox-inv-cell .vox-slot-count{z-index:1;}',
    '.vox-hotbar-row{display:grid;grid-template-columns:repeat(9,46px);gap:4px;padding-top:8px;border-top:1px solid rgba(255,255,255,.2);}',
    '.vox-tooltip{display:none;position:absolute;padding:3px 8px;background:rgba(0,0,0,.85);border:1px solid rgba(255,255,255,.3);border-radius:4px;font-size:12px;pointer-events:none;z-index:20;white-space:nowrap;}',
    '.vox-webgl-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#101820;color:#fff;text-align:center;padding:24px;pointer-events:auto;z-index:50;}',
    '@media (max-width:520px){.vox-inv-grid,.vox-hotbar-row{grid-template-columns:repeat(9,minmax(30px,1fr));}.vox-inv-cell{width:auto;height:auto;aspect-ratio:1;}.vox-inv-cell canvas{width:86%;height:86%;}}'
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('vox-hud-style')) return;
    var s = document.createElement('style');
    s.id = 'vox-hud-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---- module state ----------------------------------------------------------

  var root = null;         // #hud-root
  var game = null;         // Game api object
  var box = null;          // our single container (.vox-hud)
  var dom = {};            // named element refs
  var atlasCanvas = null;  // source pixels for block icons (if available)

  var chatOpen = false;
  var chatHistory = [];
  var chatHistIdx = -1;
  var chatDraft = '';

  var invOpen = false;
  var pausedOpen = false;
  var deathOpen = false;
  var settingsOpen = false;
  var pauseCbs = {};
  var deathCbs = {};

  var swapSrc = null;      // survival inventory pending-swap {arr, idx, el}
  var iconCache = {};      // block id -> 40x40 master canvas
  var lastMode = null;
  var lastHealth = -1;
  var lastAir = 'x';
  var lastHotbarSig = '';
  var lastSelected = -1;
  var lastTarget = '';
  var badgeTimer = 0;
  var toastTimer = 0;
  var debugVisible = false;
  var debugLast = 0;

  // ---- block icons (fake-iso from the atlas canvas) ---------------------------

  // Fallback flat colors when the atlas canvas can't be reached (keyed by block key).
  var FALLBACK_COLORS = {
    grass: '#5cae32', dirt: '#8a5a32', stone: '#8a8a8a', cobble: '#7a7a7a',
    bedrock: '#333333', log: '#6b4a2a', planks: '#b08a4f', leaves: '#3e7d23',
    sand: '#e6d9a8', gravel: '#9a938c', water: '#3f76e4', glass: '#c8e8f0',
    brick: '#a04a3c', bookshelf: '#8a6a3a', glowstone: '#ffd97a',
    coal_ore: '#4a4a4a', iron_ore: '#c8a888', gold_ore: '#e0c050',
    diamond_ore: '#6fe3df', snow_grass: '#e8f0f4', wool_white: '#f0f0f0',
    wool_red: '#cc3333', wool_green: '#33aa33', wool_blue: '#3366cc',
    wool_yellow: '#ddcc33', wool_black: '#222222', flower_red: '#dd3333',
    flower_yellow: '#ffdd33', tallgrass: '#5a9e3a', sandstone: '#d8cba0',
    obsidian: '#1a1030', tux_block: '#222831', lozenge: '#dff5ec'
  };

  // Locate the procedural atlas canvas from whatever the Blocks module exposes.
  function resolveAtlasCanvas(opts) {
    var cands = [];
    if (opts && opts.atlas) { cands.push(opts.atlas.canvas, opts.atlas.atlasCanvas); }
    if (typeof Blocks !== 'undefined') {
      cands.push(Blocks.atlasCanvas, Blocks.canvas, Blocks.atlas && Blocks.atlas.canvas);
    }
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      try {
        if (typeof c === 'function') c = c.call(typeof Blocks !== 'undefined' ? Blocks : null);
        if (c && typeof c.getContext === 'function' && c.width >= 16) return c;
      } catch (e) { /* keep looking */ }
    }
    return null;
  }

  function tileXY(idx) {
    var n = (typeof Blocks !== 'undefined' && Blocks.ATLAS_TILES) || 16;
    return { x: (idx % n) * 16, y: Math.floor(idx / n) * 16 };
  }

  // Draw one face of the fake-iso cube: transform maps the 16×16 tile onto a
  // parallelogram, then a translucent rect tints it (top light, sides dark).
  function isoFace(ctx, src, tile, m, tint) {
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    if (src) {
      var p = tileXY(tile);
      ctx.drawImage(src, p.x, p.y, 16, 16, 0, 0, 16, 16);
    }
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, 16, 16);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Build (and cache) the 40×40 master icon canvas for a block id.
  function getIcon(id) {
    if (iconCache[id]) return iconCache[id];
    var c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    var def = (typeof Blocks !== 'undefined') ? Blocks.byId(id) : null;
    if (def) {
      var tiles = def.tiles || {};
      if (def.cross) {
        // cross blocks (flowers/tallgrass): just the tile, flat and crisp
        if (atlasCanvas) {
          var p = tileXY(tiles.side != null ? tiles.side : (tiles.top || 0));
          ctx.drawImage(atlasCanvas, p.x, p.y, 16, 16, 4, 4, 32, 32);
        } else {
          ctx.fillStyle = FALLBACK_COLORS[def.key] || '#999';
          ctx.beginPath();
          ctx.moveTo(20, 6); ctx.lineTo(32, 20); ctx.lineTo(20, 34); ctx.lineTo(8, 20);
          ctx.closePath(); ctx.fill();
        }
      } else {
        var src = atlasCanvas;
        var topT = tiles.top || 0, sideT = (tiles.side != null ? tiles.side : topT);
        if (!src) {
          // flat-color cube fallback
          ctx.fillStyle = FALLBACK_COLORS[def.key] || '#999';
        }
        var base = src ? null : (FALLBACK_COLORS[def.key] || '#999999');
        // solid-color pre-fill of faces when no atlas pixels are available
        function tintOnly(m, tint) {
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          ctx.fillStyle = base; ctx.fillRect(0, 0, 16, 16);
          ctx.fillStyle = tint; ctx.fillRect(0, 0, 16, 16);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        var TOP = [1, 0.5, -1, 0.5, 20, 4];    // maps (u,v) -> diamond top
        var LEFT = [1, 0.5, 0, 1, 4, 12];      // left face
        var RIGHT = [1, -0.5, 0, 1, 20, 20];   // right face
        if (src) {
          isoFace(ctx, src, topT, TOP, 'rgba(255,255,255,0.16)');
          isoFace(ctx, src, sideT, LEFT, 'rgba(0,0,0,0.22)');
          isoFace(ctx, src, sideT, RIGHT, 'rgba(0,0,0,0.38)');
        } else {
          tintOnly(TOP, 'rgba(255,255,255,0.16)');
          tintOnly(LEFT, 'rgba(0,0,0,0.22)');
          tintOnly(RIGHT, 'rgba(0,0,0,0.38)');
        }
      }
    }
    iconCache[id] = c;
    return c;
  }

  // Paint a slot/cell canvas from the master icon.
  function paintIconInto(canvas, id) {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (id) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(getIcon(id), 0, 0, canvas.width, canvas.height);
    }
  }

  // ---- DOM construction --------------------------------------------------------

  function buildDom() {
    box = el('div', 'vox-hud', root);

    // crosshair
    dom.crosshair = el('div', 'vox-crosshair', box);
    dom.crosshair.textContent = '+';
    if (isTouch()) dom.crosshair.style.display = 'none';

    // hearts + bubbles row
    dom.bars = el('div', 'vox-bars', box);
    dom.hearts = el('div', 'vox-hearts', dom.bars);
    dom.bubbles = el('div', 'vox-bubbles', dom.bars);
    var i;
    dom.heartEls = [];
    for (i = 0; i < 10; i++) {
      var h = el('span', 'vox-heart', dom.hearts);
      h.textContent = '♥';
      dom.heartEls.push(h);
    }
    dom.bubbleEls = [];
    for (i = 0; i < 10; i++) {
      var b = el('span', 'vox-bubble', dom.bubbles);
      b.textContent = '●';
      dom.bubbleEls.push(b);
    }
    dom.bubbles.style.display = 'none';

    // hotbar
    dom.hotbar = el('div', 'vox-hotbar', box);
    dom.slots = [];
    for (i = 0; i < 9; i++) {
      (function (idx) {
        var s = el('div', 'vox-slot', dom.hotbar);
        var cv = document.createElement('canvas');
        cv.width = 40; cv.height = 40;
        s.appendChild(cv);
        var cnt = el('span', 'vox-slot-count', s);
        s.addEventListener('click', function () {
          if (game && game.inventory) game.inventory.select(idx);
        });
        dom.slots.push({ root: s, canvas: cv, count: cnt });
      })(i);
    }

    // target block name label
    dom.targetLabel = el('div', 'vox-target-label', box);

    // chat
    dom.chat = el('div', 'vox-chat', box);
    dom.chatLog = el('div', 'vox-chat-log', dom.chat);
    dom.chatInput = el('input', 'vox-chat-input', dom.chat);
    dom.chatInput.type = 'text';
    dom.chatInput.autocomplete = 'off';
    dom.chatInput.autocapitalize = 'off';
    dom.chatInput.spellcheck = false;
    dom.chatInput.placeholder = t('vox.chat.placeholder', 'Chat or /command…');
    dom.chatInput.addEventListener('keydown', onChatKey);
    dom.chatInput.addEventListener('blur', function () {
      // Mobile keyboards dismiss with no key event; treat that as close.
      if (chatOpen && isTouch()) closeChat(false);
    });

    // debug panel
    dom.debug = el('div', 'vox-debug', box);

    // mode badge + toast + tooltip
    dom.badge = el('div', 'vox-mode-badge', box);
    dom.toast = el('div', 'vox-title-toast', box);
    dom.tooltip = el('div', 'vox-tooltip', box);

    // inventory panel
    dom.inv = el('div', 'vox-inv-panel', box);

    // pause overlay
    dom.paused = el('div', 'vox-overlay vox-paused', box);
    buildPauseOverlay();

    // death overlay
    dom.death = el('div', 'vox-overlay vox-death', box);
    var dt = el('h2', null, dom.death);
    dt.textContent = t('vox.death.title', 'You died!');
    var rb = el('button', 'vox-ui-btn', dom.death);
    rb.textContent = t('vox.death.respawn', 'Respawn');
    rb.addEventListener('click', function () {
      if (deathCbs.onRespawn) deathCbs.onRespawn();
    });
  }

  // ---- chat ---------------------------------------------------------------

  function onChatKey(ev) {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
      ev.preventDefault();
      var v = dom.chatInput.value.trim();
      closeChat(true);
      if (v) {
        chatHistory.push(v);
        if (chatHistory.length > HISTORY_MAX) chatHistory.shift();
        if (typeof Commands !== 'undefined' && Commands.exec) Commands.exec(v);
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      closeChat(true);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!chatHistory.length) return;
      if (chatHistIdx === -1) { chatDraft = dom.chatInput.value; chatHistIdx = chatHistory.length; }
      chatHistIdx = Math.max(0, chatHistIdx - 1);
      dom.chatInput.value = chatHistory[chatHistIdx];
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (chatHistIdx === -1) return;
      chatHistIdx++;
      if (chatHistIdx >= chatHistory.length) {
        chatHistIdx = -1;
        dom.chatInput.value = chatDraft;
      } else {
        dom.chatInput.value = chatHistory[chatHistIdx];
      }
    }
  }

  function chatPrint(text, cls) {
    if (!dom.chatLog) return;
    var line = el('div', 'vox-chat-line' + (cls ? ' ' + cls : ''), dom.chatLog);
    line.textContent = String(text);
    while (dom.chatLog.children.length > CHAT_MAX_LINES) {
      dom.chatLog.removeChild(dom.chatLog.firstChild);
    }
    // auto-fade after 8 s (kept in DOM; fully visible again while chat is open)
    setTimeout(function () {
      line.dataset.faded = '1';
      if (!chatOpen) line.style.opacity = '0';
    }, CHAT_FADE_MS);
  }

  function openChat(prefill) {
    if (deathOpen || pausedOpen) return;
    chatOpen = true;
    chatHistIdx = -1;
    chatDraft = '';
    setUIMode(true);
    dom.chatInput.style.display = 'block';
    dom.chatInput.value = prefill || '';
    // un-fade the whole log while typing
    for (var i = 0; i < dom.chatLog.children.length; i++) {
      dom.chatLog.children[i].style.opacity = '1';
    }
    // focus without scrolling/zooming (16px font prevents iOS zoom)
    try { dom.chatInput.focus({ preventScroll: true }); } catch (e) { dom.chatInput.focus(); }
    var len = dom.chatInput.value.length;
    try { dom.chatInput.setSelectionRange(len, len); } catch (e) { /* ok */ }
  }

  function closeChat(relock) {
    if (!chatOpen) return;
    chatOpen = false;
    dom.chatInput.value = '';
    dom.chatInput.style.display = 'none';
    try { dom.chatInput.blur(); } catch (e) { /* ok */ }
    // re-fade lines whose time already passed
    for (var i = 0; i < dom.chatLog.children.length; i++) {
      var line = dom.chatLog.children[i];
      if (line.dataset.faded === '1') line.style.opacity = '0';
    }
    setUIMode(false);
    if (relock && game && typeof game.resumePointerLock === 'function') game.resumePointerLock();
  }

  // ---- toast + mode badge ----------------------------------------------------

  function toast(text) {
    dom.toast.textContent = String(text);
    dom.toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.style.opacity = '0'; }, 1800);
  }

  function showBadge(text) {
    dom.badge.textContent = String(text);
    dom.badge.style.opacity = '1';
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(function () { dom.badge.style.opacity = '0'; }, 3000);
  }

  // ---- tooltip ----------------------------------------------------------------

  function showTooltip(target, text) {
    dom.tooltip.textContent = text;
    dom.tooltip.style.display = 'block';
    var br = box.getBoundingClientRect();
    var r = target.getBoundingClientRect();
    var x = r.left - br.left + r.width / 2;
    var y = r.top - br.top - 26;
    dom.tooltip.style.left = Math.max(4, x - dom.tooltip.offsetWidth / 2) + 'px';
    dom.tooltip.style.top = Math.max(4, y) + 'px';
  }
  function hideTooltip() { dom.tooltip.style.display = 'none'; }

  // ---- inventory panel ----------------------------------------------------------

  function blockName(id) {
    var def = (typeof Blocks !== 'undefined') ? Blocks.byId(id) : null;
    return def ? t(def.i18nKey, def.name) : '';
  }

  function invCell(parent, slot, onClick, name) {
    var cell = el('div', 'vox-inv-cell', parent);
    var cv = document.createElement('canvas');
    cv.width = 40; cv.height = 40;
    cell.appendChild(cv);
    var id = slot ? slot.id : 0;
    paintIconInto(cv, id);
    if (slot && slot.count > 1) {
      var cnt = el('span', 'vox-slot-count', cell);
      cnt.textContent = slot.count;
    }
    var label = name || (id ? blockName(id) : '');
    if (label) {
      cell.addEventListener('mouseenter', function () { showTooltip(cell, label); });
      cell.addEventListener('mouseleave', hideTooltip);
    }
    cell.addEventListener('click', onClick);
    return cell;
  }

  // Write a hotbar/backpack slot, preferring an inventory setter if one exists.
  function setSlot(arr, idx, val, which) {
    var inv = game.inventory;
    if (inv && typeof inv.setSlot === 'function') {
      try { inv.setSlot(which, idx, val); return; } catch (e) { /* fall through */ }
    }
    arr[idx] = val;
  }

  function pokeInventory() {
    var inv = game.inventory;
    if (inv && typeof inv.select === 'function') inv.select(inv.selected);
    lastHotbarSig = '';   // force hotbar DOM refresh on next update
  }

  function buildInventoryPanel() {
    dom.inv.innerHTML = '';
    swapSrc = null;
    var inv = game.inventory;
    if (!inv) return;
    var creative = game.mode === 'creative';

    var head = el('div', 'vox-inv-title', dom.inv);
    var title = el('span', null, head);
    title.textContent = creative
      ? t('vox.inv.blocks', 'Blocks')
      : t('vox.inv.title', 'Inventory');
    var closeBtn = el('button', 'vox-inv-close', head);
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { closeInventory(); });

    if (creative) {
      // -- creative: full placeable palette; click assigns to selected hotbar slot
      var grid = el('div', 'vox-inv-grid', dom.inv);
      var defs = (typeof Blocks !== 'undefined')
        ? Blocks.list().filter(function (d) { return d.placeable; })
        : [];
      defs.forEach(function (def) {
        invCell(grid, { id: def.id, count: 1 }, function () {
          setSlot(inv.hotbar, inv.selected, { id: def.id, count: 1 }, 'hotbar');
          pokeInventory();
          buildInventoryPanel();   // refresh hotbar row highlight
        }, t(def.i18nKey, def.name));
      });
    } else {
      // -- survival: backpack grid + hotbar row; click to swap two slots
      var bp = el('div', 'vox-inv-grid', dom.inv);
      var i;
      var makeSwap = function (arr, idx, which) {
        return function (ev) {
          var cell = ev.currentTarget;
          if (!swapSrc) {
            swapSrc = { arr: arr, idx: idx, el: cell };
            cell.classList.add('sel');
            return;
          }
          if (swapSrc.el === cell) {
            cell.classList.remove('sel');
            swapSrc = null;
            return;
          }
          var a = swapSrc.arr[swapSrc.idx];
          var b = arr[idx];
          setSlot(swapSrc.arr, swapSrc.idx, b, swapSrc.which);
          setSlot(arr, idx, a, which);
          swapSrc = null;
          pokeInventory();
          buildInventoryPanel();
        };
      };
      for (i = 0; i < 27; i++) {
        invCell(bp, inv.backpack ? inv.backpack[i] : null, makeSwap(inv.backpack, i, 'backpack'));
      }
      var hb = el('div', 'vox-hotbar-row', dom.inv);
      for (i = 0; i < 9; i++) {
        var cell = invCell(hb, inv.hotbar[i], makeSwap(inv.hotbar, i, 'hotbar'));
        if (i === inv.selected) cell.style.borderColor = 'rgba(255,255,255,.6)';
      }
    }
  }

  function openInventory() {
    if (deathOpen || pausedOpen) return;
    if (chatOpen) closeChat(false);
    invOpen = true;
    buildInventoryPanel();
    dom.inv.style.display = 'block';
    setUIMode(true);
    if (typeof Input !== 'undefined' && Input.exitPointerLock) Input.exitPointerLock();
  }

  function closeInventory() {
    if (!invOpen) return;
    invOpen = false;
    hideTooltip();
    dom.inv.style.display = 'none';
    setUIMode(false);
    if (game && typeof game.resumePointerLock === 'function') game.resumePointerLock();
  }

  // ---- pause overlay + settings ------------------------------------------------

  function currentSettings() {
    var s = loadSettings();
    var g = (game && typeof game.getSettings === 'function') ? game.getSettings() : null;
    return {
      dist: (g && g.dist) || s.dist || 6,
      fov: (g && g.fov) || s.fov || 70,
      lut: (g && typeof g.lut === 'number') ? g.lut : (typeof s.lut === 'number' ? s.lut : 85),
      touch: s.touch || 'm'
    };
  }

  function sliderRow(parent, labelText, min, max, step, value, onChange) {
    var row = el('div', 'vox-set-row', parent);
    var lab = el('label', null, row);
    lab.textContent = labelText;
    var range = document.createElement('input');
    range.type = 'range';
    range.min = min; range.max = max; range.step = step; range.value = value;
    row.appendChild(range);
    var val = el('span', 'vox-set-val', row);
    val.textContent = String(value);
    range.addEventListener('input', function () {
      val.textContent = String(range.value);
      onChange(Number(range.value));
    });
    return range;
  }

  var TOUCH_SCALES = { s: '0.85', m: '1', l: '1.2' };

  function applyTouchSize(sz) {
    if (root) root.style.setProperty('--vox-touch-scale', TOUCH_SCALES[sz] || '1');
  }

  function buildPauseOverlay() {
    dom.paused.innerHTML = '';

    // main view
    dom.pauseMain = el('div', null, dom.paused);
    dom.pauseMain.style.cssText = 'display:flex;flex-direction:column;gap:14px;align-items:center;';
    var h = el('h2', null, dom.pauseMain);
    h.textContent = t('vox.pause.title', 'Paused');
    var bResume = el('button', 'vox-ui-btn', dom.pauseMain);
    bResume.textContent = t('vox.pause.resume', 'Resume');
    bResume.addEventListener('click', function () { if (pauseCbs.onResume) pauseCbs.onResume(); });
    var bSettings = el('button', 'vox-ui-btn', dom.pauseMain);
    bSettings.textContent = t('vox.pause.settings', 'Settings');
    bSettings.addEventListener('click', function () {
      openSettingsView();
      if (typeof pauseCbs.onSettings === 'function') pauseCbs.onSettings();
    });
    var bQuit = el('button', 'vox-ui-btn', dom.pauseMain);
    bQuit.textContent = t('vox.pause.quit', 'Save & Quit');
    bQuit.addEventListener('click', function () { if (pauseCbs.onQuit) pauseCbs.onQuit(); });

    // settings view
    dom.settings = el('div', 'vox-settings', dom.paused);
  }

  function openSettingsView() {
    settingsOpen = true;
    dom.pauseMain.style.display = 'none';
    dom.settings.innerHTML = '';
    dom.settings.style.display = 'flex';
    var cur = currentSettings();

    var h = el('h2', null, dom.settings);
    h.textContent = t('vox.settings.title', 'Settings');
    h.style.fontSize = '22px';

    sliderRow(dom.settings, t('vox.settings.dist', 'Render distance'), 2, 10, 1, cur.dist,
      function (v) {
        if (game && game.setRenderDist) game.setRenderDist(v);
        saveSettings({ dist: v });
      });
    sliderRow(dom.settings, t('vox.settings.fov', 'Field of view'), 30, 110, 1, cur.fov,
      function (v) {
        if (game && game.setFov) game.setFov(v);
        saveSettings({ fov: v });
      });
    sliderRow(dom.settings, t('vox.settings.lut', 'Color pop'), 0, 100, 1, cur.lut,
      function (v) {
        if (game && game.setLutAmount) game.setLutAmount(v / 100);
        saveSettings({ lut: v });
      });

    if (isTouch()) {
      var row = el('div', 'vox-set-row', dom.settings);
      var lab = el('label', null, row);
      lab.textContent = t('vox.settings.touchSize', 'Touch controls');
      var sizes = el('div', 'vox-touch-sizes', row);
      sizes.style.flex = '1';
      [['s', t('vox.settings.touch.s', 'Small')],
       ['m', t('vox.settings.touch.m', 'Medium')],
       ['l', t('vox.settings.touch.l', 'Large')]].forEach(function (opt) {
        var btn = el('button', null, sizes);
        btn.textContent = opt[1];
        if (cur.touch === opt[0]) btn.classList.add('sel');
        btn.addEventListener('click', function () {
          var sib = sizes.children;
          for (var i = 0; i < sib.length; i++) sib[i].classList.remove('sel');
          btn.classList.add('sel');
          applyTouchSize(opt[0]);
          saveSettings({ touch: opt[0] });
        });
      });
    }

    var back = el('button', 'vox-ui-btn', dom.settings);
    back.textContent = t('vox.settings.back', 'Back');
    back.addEventListener('click', closeSettingsView);
  }

  function closeSettingsView() {
    settingsOpen = false;
    dom.settings.style.display = 'none';
    dom.pauseMain.style.display = 'flex';
  }

  function showPaused(on, cbs) {
    if (cbs) pauseCbs = cbs;
    pausedOpen = !!on;
    if (on) {
      if (chatOpen) closeChat(false);
      if (invOpen) closeInventory();
      closeSettingsView();
      dom.paused.style.display = 'flex';
    } else {
      dom.paused.style.display = 'none';
    }
  }

  function showDeath(on, cbs) {
    if (cbs) deathCbs = cbs;
    deathOpen = !!on;
    if (on) {
      if (chatOpen) closeChat(false);
      if (invOpen) closeInventory();
      dom.death.style.display = 'flex';
    } else {
      dom.death.style.display = 'none';
    }
  }

  // ---- per-frame update ----------------------------------------------------------

  function hotbarSig(hotbar, selected) {
    var s = String(selected);
    for (var i = 0; i < 9; i++) {
      var it = hotbar[i];
      s += '|' + (it ? it.id + ':' + it.count : '');
    }
    return s;
  }

  function updateHotbar(state) {
    var sig = hotbarSig(state.hotbar || [], state.selected);
    if (sig === lastHotbarSig) return;
    lastHotbarSig = sig;
    for (var i = 0; i < 9; i++) {
      var slot = dom.slots[i];
      var it = state.hotbar ? state.hotbar[i] : null;
      slot.root.classList.toggle('sel', i === state.selected);
      paintIconInto(slot.canvas, it ? it.id : 0);
      var showCount = it && it.count > 1 && state.mode !== 'creative';
      slot.count.textContent = showCount ? String(it.count) : '';
    }
  }

  function updateHearts(state) {
    var creative = state.mode === 'creative';
    dom.hearts.style.display = creative ? 'none' : 'flex';
    if (creative) return;
    var hp = Math.max(0, Math.min(20, Math.round(state.health)));
    if (hp === lastHealth) return;
    lastHealth = hp;
    for (var i = 0; i < 10; i++) {
      var v = hp - i * 2;
      var e = dom.heartEls[i];
      e.classList.toggle('half', v === 1);
      e.classList.toggle('empty', v <= 0);
    }
  }

  function updateBubbles(state) {
    var show = state.mode !== 'creative' && state.air !== null && state.air !== undefined;
    var key = show ? String(Math.ceil(state.air)) : 'off';
    if (key === lastAir) return;
    lastAir = key;
    dom.bubbles.style.display = show ? 'flex' : 'none';
    if (!show) return;
    var n = Math.ceil(state.air);
    for (var i = 0; i < 10; i++) {
      dom.bubbleEls[i].classList.toggle('empty', i >= n);
    }
  }

  var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  function updateDebug(state) {
    if (!debugVisible) return;
    var now = performance.now();
    if (now - debugLast < 250) return;
    debugLast = now;
    var snap = null;
    try { snap = game && game.debugSnapshot ? game.debugSnapshot() : null; } catch (e) { /* ok */ }
    var p = state.pos || [0, 0, 0];
    var yaw = (game && game.player) ? game.player.yaw : 0;
    var pitch = (game && game.player) ? game.player.pitch : 0;
    var deg = ((yaw * 180 / Math.PI) % 360 + 360) % 360;
    var lines = [
      t('vox.debug.pos', 'pos') + '  ' + p[0].toFixed(1) + ' / ' + p[1].toFixed(1) + ' / ' + p[2].toFixed(1),
      t('vox.debug.facing', 'facing') + '  ' + COMPASS[Math.round(deg / 45) % 8] +
        ' (' + deg.toFixed(0) + '° / ' + (pitch * 180 / Math.PI).toFixed(0) + '°)',
      t('vox.debug.mode', 'mode') + '  ' + state.mode,
      t('vox.debug.fps', 'fps') + '  ' + (state.fps | 0),
      t('vox.debug.chunks', 'chunks') + '  ' + (snap ? snap.chunkCount : '?'),
      t('vox.debug.seed', 'seed') + '  ' + (snap ? snap.seed : '?'),
      t('vox.debug.time', 'time') + '  ' + Math.floor(state.time || 0)
    ];
    dom.debug.textContent = lines.join('\n');
  }

  function update(state) {
    if (!box) return;

    // mode change → badge (skip the very first frame)
    if (lastMode !== null && state.mode !== lastMode) {
      showBadge(state.mode === 'creative'
        ? t('vox.mode.creative', 'Creative')
        : t('vox.mode.survival', 'Survival'));
      lastHealth = -1;   // hearts may have been hidden; force refresh
      lastHotbarSig = '';
      if (invOpen) buildInventoryPanel();
    }
    lastMode = state.mode;

    updateHotbar(state);
    updateHearts(state);
    updateBubbles(state);
    updateDebug(state);

    var tn = state.targetName || '';
    if (tn !== lastTarget) {
      lastTarget = tn;
      dom.targetLabel.textContent = tn;
    }
  }

  // ---- public API -------------------------------------------------------------

  var api = {
    init: function (opts) {
      root = opts.root;
      game = opts.game;
      injectCSS();
      if (box && box.parentNode) box.parentNode.removeChild(box);   // re-init safety
      dom = {};
      iconCache = {};
      chatOpen = false; invOpen = false; pausedOpen = false; deathOpen = false;
      lastMode = null; lastHealth = -1; lastAir = 'x'; lastHotbarSig = ''; lastTarget = '';
      atlasCanvas = resolveAtlasCanvas(opts);
      buildDom();
      applyTouchSize(loadSettings().touch || 'm');
    },

    update: update,
    chatPrint: chatPrint,
    openChat: openChat,
    isChatOpen: function () { return chatOpen; },
    toast: toast,

    setDebug: function (v) {
      debugVisible = !!v;
      if (dom.debug) dom.debug.style.display = debugVisible ? 'block' : 'none';
    },
    toggleDebug: function () { api.setDebug(!debugVisible); },

    openInventory: openInventory,
    closeInventory: closeInventory,
    isInventoryOpen: function () { return invOpen; },

    showPaused: showPaused,
    isPaused: function () { return pausedOpen; },
    showDeath: showDeath,

    destroy: function () {
      clearTimeout(toastTimer);
      clearTimeout(badgeTimer);
      if (chatOpen) closeChat(false);
      pauseCbs = {}; deathCbs = {};
      chatOpen = invOpen = pausedOpen = deathOpen = settingsOpen = false;
      debugVisible = false;
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      dom = {};
      game = null;
      root = null;
    }
  };

  return api;
})();

window.HUD = HUD;
