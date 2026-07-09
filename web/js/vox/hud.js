// hud.js — all in-game DOM UI for CLOBI CRAFT (contract §5.14).
// Exactly one global: window.HUD.
//
// Owns every game-screen element inside #hud-root: crosshair, hotbar (with
// fake-iso block icons drawn from the Blocks atlas canvas), hearts + bubbles,
// chat (log + input + history), debug panel, inventory panel (creative palette
// or survival backpack + the §12 crafting section), pause overlay with
// settings sliders, death overlay, mode badge and title toast. Touch control
// DOM is owned by Input (§5.10) — HUD never touches it.
//
// Consumes: I18n (guarded), Input (setUIMode / isTouch / pointer lock, guarded),
//           Commands (chat Enter -> exec, guarded), Blocks (icons + names),
//           Craft (crafting section: match/craftOnce, guarded),
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

  // Part III (§8): armor-row slot keys, matching PlayerModel.draw's
  // opts.armor shape {helmet, chest, legs, boots} exactly (already landed
  // in playermodel.js -- this HUD row mirrors those same field names).
  // Each holds a full item id string ("helmet_iron", "chestplate_diamond",
  // ...) or null, so Items.icon()/Items.def() take the value directly with
  // no key->prefix remapping needed.
  var ARMOR_SLOT_KEYS = ['helmet', 'chest', 'legs', 'boots'];
  var HOTBAR_TOOLTIP_MS = 1400;   // §9/§10: selection-triggered tooltip auto-hide

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
  // STRUCTURE ONLY: position/display/sizing/pointer-events plus the few
  // functional bits (display:none defaults, the fade transitions JS drives,
  // the 16px iOS-zoom guard). ALL theme -- colors, borders, fonts, shadows --
  // lives in css/style.css, which sits AFTER this sheet in the cascade and is
  // the single source of visual truth: any visual property added here leaks
  // into the final look wherever style.css doesn't override it. Exceptions
  // that this sheet fully owns (style.css has no rules for them, on purpose):
  // .vox-webgl-error and the .vox-hitflash gradient.

  var CSS = [
    '.vox-hud{position:absolute;inset:0;pointer-events:none;user-select:none;-webkit-user-select:none;color:#fff;font-family:inherit;overflow:hidden;}',
    '.vox-crosshair{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:22px;line-height:1;}',
    '.vox-hotbar{position:absolute;left:50%;bottom:calc(10px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;gap:4px;pointer-events:auto;}',
    '.vox-slot{position:relative;width:46px;height:46px;box-sizing:border-box;overflow:hidden;}',
    '.vox-slot canvas{display:block;image-rendering:pixelated;}',
    '.vox-slot-count{position:absolute;right:2px;bottom:1px;pointer-events:none;z-index:1;}',
    '.vox-bars{position:absolute;left:50%;bottom:calc(64px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:min(462px,94vw);display:flex;justify-content:space-between;pointer-events:none;}',
    '.vox-hearts,.vox-bubbles{display:flex;gap:2px;}',
    '.vox-chat{position:absolute;left:8px;bottom:calc(118px + env(safe-area-inset-bottom,0px));width:min(520px,72vw);pointer-events:none;}',
    '.vox-chat-log{display:flex;flex-direction:column;gap:2px;max-height:38vh;overflow:hidden;justify-content:flex-end;}',
    '.vox-chat-line{word-break:break-word;transition:opacity .6s;}',   // transition = the 8s auto-fade mechanism
    '.vox-chat-input{display:none;width:100%;margin-top:4px;font-size:16px;box-sizing:border-box;pointer-events:auto;}',   // 16px: no iOS focus zoom
    '.vox-debug{display:none;position:absolute;top:8px;left:8px;white-space:pre;pointer-events:none;}',
    '.vox-mode-badge{position:absolute;top:calc(10px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);opacity:0;transition:opacity .4s;pointer-events:none;}',
    '.vox-title-toast{position:absolute;left:50%;top:22%;transform:translateX(-50%);opacity:0;pointer-events:none;white-space:nowrap;}',
    '.vox-title-toast.show{opacity:1;}',
    '.vox-target-label{position:absolute;left:50%;top:calc(44px + env(safe-area-inset-top,0px));transform:translateX(-50%);pointer-events:none;}',
    '.vox-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;pointer-events:auto;}',
    '.vox-overlay h2{margin:0;}',
    '.vox-pause-main{display:flex;flex-direction:column;gap:14px;align-items:center;}',
    '.vox-ui-btn{min-width:220px;padding:11px 22px;font:inherit;cursor:pointer;pointer-events:auto;}',
    '.vox-settings{display:none;flex-direction:column;gap:12px;min-width:min(340px,90vw);}',
    '.vox-set-row{display:flex;align-items:center;gap:10px;}',
    '.vox-set-row label{flex:0 0 42%;}',
    '.vox-set-row input[type=range]{flex:1;pointer-events:auto;}',
    '.vox-set-row .vox-set-val{flex:0 0 44px;text-align:right;}',
    '.vox-touch-sizes{display:flex;gap:6px;}',
    '.vox-touch-sizes button{flex:1;font:inherit;cursor:pointer;}',
    '.vox-inv-panel{display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:94vw;max-height:80vh;overflow:auto;pointer-events:auto;}',
    '.vox-inv-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}',
    '.vox-inv-close{width:32px;height:32px;font:inherit;cursor:pointer;}',
    '.vox-inv-grid{display:grid;grid-template-columns:repeat(9,46px);gap:4px;margin-bottom:10px;}',
    '.vox-inv-cell{position:relative;box-sizing:border-box;overflow:hidden;cursor:pointer;}',
    '.vox-inv-cell canvas{display:block;image-rendering:pixelated;}',
    '.vox-hotbar-row{display:grid;grid-template-columns:repeat(9,46px);gap:4px;padding-top:8px;}',
    '.vox-tooltip{display:none;position:absolute;pointer-events:none;white-space:nowrap;z-index:80;}',   // z-scale: tooltip
    '.vox-webgl-error{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#101820;color:#fff;text-align:center;padding:24px;pointer-events:auto;z-index:90;}',
    '@media (max-width:520px){.vox-inv-grid,.vox-hotbar-row{grid-template-columns:repeat(9,minmax(30px,1fr));}}',
    /* ---- Part III combat additions (ARCHITECTURE-COMBAT.md §8) ---- */
    // z:0 (not 6): an explicit positive z lifted the flash ABOVE the
    // auto-stacked HUD siblings, contradicting the "sits low" contract.
    '.vox-hitflash{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(200,0,0,0) 40%,rgba(180,0,0,.55) 100%);opacity:0;pointer-events:none;transition:opacity .12s ease-out;z-index:0;}',
    '.vox-hitflash.on{opacity:1;transition:opacity 0s;}',
    '.vox-armor-row{position:absolute;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;gap:4px;pointer-events:none;}',
    '.vox-armor-slot{position:relative;width:28px;height:28px;box-sizing:border-box;overflow:hidden;}',
    '.vox-armor-slot canvas{display:block;width:100%;height:100%;image-rendering:pixelated;}',
    /* ---- Part III crafting section (ARCHITECTURE-COMBAT.md §12) ---- */
    '.vox-craft-panel{margin-bottom:10px;}',
    '.vox-craft-title{margin-bottom:8px;}',
    '.vox-craft-area{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;}',
    '.vox-craft-grid{display:grid;grid-template-columns:repeat(3,46px);gap:4px;}',
    '.vox-craft-side{display:flex;flex-direction:column;align-items:center;gap:8px;}',
    '.vox-craft-out{width:46px;height:46px;}',
    '.vox-craft-btn{font:inherit;cursor:pointer;pointer-events:auto;}'
  ].join('\n');

  function injectCSS() {
    if (document.getElementById('vox-hud-style')) return;
    var s = document.createElement('style');
    s.id = 'vox-hud-style';
    s.textContent = CSS;
    // Insert BEFORE the first stylesheet <link>, not appendChild: this sheet
    // is a works-without-any-CSS fallback, and the central style.css must win
    // every equal-specificity conflict. Appended at the end of <head> it came
    // AFTER style.css in the cascade and silently overrode the themed HUD
    // styles (the "some UIs look broken" bug).
    var firstSheet = document.head.querySelector('link[rel="stylesheet"]');
    if (firstSheet) document.head.insertBefore(s, firstSheet);
    else document.head.appendChild(s);
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
  var craftGrid = null;    // §12 crafting 3x3 staging grid [[{id,count,kind}|null x3] x3] -- NOT part of Inventory
  var stickIcon = null;    // lazily-built 40x40 icon for Craft's 'stick' (not Items-registered)
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

  // Part III (§8/§9/§10) state
  var lastArmorSig = '';
  var hitflashTimer = 0;
  var heartsPulseTimer = 0;         // clears the .hurt damage-pulse class
  var hotbarTooltipTimer = 0;
  var hotbarTooltipSelected = -1;   // last selection we already showed a tooltip for
  var combatWired = false;

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

  // Paint a slot/cell canvas from the master icon. `id` may be a numeric
  // block id (existing behaviour, unchanged) or -- Part III §4/§9 -- a
  // string item id, in which case it's drawn via Items.icon() instead of
  // the block atlas fake-iso builder. Kind is inferred from typeof id when
  // not passed explicitly, matching Inventory's own {id,kind} slot rule
  // ("kind defaults to 'block' for numeric ids, 'item' for string ids").
  function paintIconInto(canvas, id, kind) {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!id) return;
    ctx.imageSmoothingEnabled = false;
    var isItem = kind ? kind === 'item' : typeof id === 'string';
    if (isItem) {
      // Craft's 'stick' is a craft-only id with no Items registration
      // (crafting fodder, see craft.js) -- Items.icon() would hand back a
      // blank canvas, so it gets a locally-drawn icon instead.
      if (id === craftStickId()) {
        ctx.drawImage(getStickIcon(), 0, 0, canvas.width, canvas.height);
        return;
      }
      if (typeof Items === 'undefined' || !Items || typeof Items.icon !== 'function') return;
      var itemCanvas = Items.icon(id);
      if (itemCanvas) ctx.drawImage(itemCanvas, 0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.drawImage(getIcon(id), 0, 0, canvas.width, canvas.height);
  }

  // ---- 'stick' icon + id (§12) ----------------------------------------------
  // Craft's one intermediate material lives outside the Items registry, so
  // HUD supplies its icon and display name itself (the ONLY id with that
  // property -- everything else in a slot is a Blocks id or an Items id).

  function craftStickId() {
    return (typeof Craft !== 'undefined' && Craft && Craft.STICK_ID) || 'stick';
  }

  // Simple pixel-art diagonal rod, same 16-grid-scaled-x2.5 family as the
  // Items tool icons so it doesn't clash sitting next to them in a grid.
  function getStickIcon() {
    if (stickIcon) return stickIcon;
    var c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    function px(x, y, w, h, col) {
      ctx.fillStyle = col;
      ctx.fillRect(x * 2.5, y * 2.5, w * 2.5, h * 2.5);
    }
    for (var i = 0; i < 8; i++) {
      px(4 + i, 11 - i, 2, 2, '#8a5c2e');   // rod body, bottom-left -> top-right
    }
    for (i = 0; i < 8; i++) {
      px(4 + i, 11 - i, 1, 1, '#b08a4f');   // lit top-left edge
      px(5 + i, 12 - i, 1, 1, '#5d3d1e');   // shadowed lower edge
    }
    stickIcon = c;
    return c;
  }

  // ---- DOM construction --------------------------------------------------------

  function buildDom() {
    box = el('div', 'vox-hud', root);

    // full-screen damage pulse (Part III §8) -- sits low in z-order, under
    // every other element, so it never blocks crosshair/hotbar/chat input.
    dom.hitflash = el('div', 'vox-hitflash', box);

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

    // armor row (Part III §8): 4 small slot icons above the hotbar reflecting
    // inv.armor -> {helmet,chest,legs,boots}; empty = dim dashed outline.
    dom.armorRow = el('div', 'vox-armor-row', box);
    dom.armorSlots = {};
    ARMOR_SLOT_KEYS.forEach(function (key) {
      var s = el('div', 'vox-armor-slot', dom.armorRow);
      var cv = document.createElement('canvas');
      cv.width = 40; cv.height = 40;
      s.appendChild(cv);
      dom.armorSlots[key] = { root: s, canvas: cv };
    });

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
    dom.deathBy = el('div', 'vox-death-by', dom.death);
    dom.deathBy.style.display = 'none';
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
    // class toggle, not inline opacity: style.css owns the fade/scale-in
    // transition on .vox-title-toast.show (baseline has a plain opacity
    // fallback for the same class).
    dom.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.classList.remove('show'); }, 1800);
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

  // ---- hotbar selection tooltip (Part III §9/§10) -----------------------------
  // Bug fix per contract §10: the pinned hotbar row never called the existing
  // tooltip mechanism. Whenever the SELECTED slot changes (hotbar number key,
  // wheel scroll, or a touch tap -- i.e. any real call to inv.select() that
  // actually changes inv.selected, which is exactly when Inventory's onChange
  // fires for a selection edit per inventory.js's own `if (n === inv.selected)
  // return;` early-out) show the slot's name above it for ~1.4s, auto-hiding.
  // Explicitly NOT triggered by mere mouse hover (that's the pre-existing
  // crosshair-target-name / inventory-panel-hover behaviour, left alone).
  var hotbarSelectionListener = null;

  function showHotbarSelectionTooltip() {
    var inv = game && game.inventory;
    if (!inv || !inv.hotbar || typeof inv.selected !== 'number') return;
    var slot = dom.slots[inv.selected];
    if (!slot) return;
    var it = inv.hotbar[inv.selected];
    if (!it) { hideTooltip(); return; } // empty slot selected: nothing to name
    var label = slotName(it);
    if (!label) return;
    showTooltip(slot.root, label);
    clearTimeout(hotbarTooltipTimer);
    hotbarTooltipTimer = setTimeout(hideTooltip, HOTBAR_TOOLTIP_MS);
  }

  function wireHotbarSelectionTooltip() {
    unwireHotbarSelectionTooltip();
    if (!game || !game.inventory || typeof game.inventory.onChange !== 'function') return;
    hotbarSelectionListener = function (inv) {
      if (!inv || typeof inv.selected !== 'number') return;
      if (inv.selected === hotbarTooltipSelected) return; // a non-selection mutation (count/contents change)
      hotbarTooltipSelected = inv.selected;
      showHotbarSelectionTooltip();
    };
    hotbarTooltipSelected = game.inventory.selected;
    game.inventory.onChange(hotbarSelectionListener);
  }

  function unwireHotbarSelectionTooltip() {
    if (hotbarSelectionListener && game && game.inventory && typeof game.inventory.offChange === 'function') {
      game.inventory.offChange(hotbarSelectionListener);
    }
    hotbarSelectionListener = null;
  }

  // ---- inventory panel ----------------------------------------------------------

  function blockName(id) {
    var def = (typeof Blocks !== 'undefined') ? Blocks.byId(id) : null;
    return def ? t(def.i18nKey, def.name) : '';
  }

  // Part III (§4/§9/§10): item-id name lookup, same i18n shape as blockName.
  // Items.nameOf already does the I18n.t(i18nKey,name) fallback internally,
  // but we mirror it locally too so this file degrades identically (empty
  // string) when Items isn't loaded, matching blockName's own empty-string
  // contract for an unknown id.
  function itemName(id) {
    if (id === craftStickId()) return t('vox.item.stick', 'Stick'); // craft-only id, not in Items (§12)
    if (typeof Items === 'undefined' || !Items) return '';
    var def = Items.def ? Items.def(id) : null;
    if (!def) return '';
    return typeof Items.nameOf === 'function' ? Items.nameOf(id) : t(def.i18nKey, def.name);
  }

  // Name lookup that works for BOTH a hotbar/backpack slot's {id,kind} shape
  // (§4: kind defaults to 'block' for numeric ids, 'item' for string ids)
  // and a bare id (numeric = block, string = item) for callers that don't
  // carry a slot object (e.g. the armor row, which stores bare item ids).
  function slotName(slotOrId) {
    if (slotOrId && typeof slotOrId === 'object') {
      if (slotOrId.kind === 'item' || typeof slotOrId.id === 'string') return itemName(slotOrId.id);
      return blockName(slotOrId.id);
    }
    if (typeof slotOrId === 'string') return itemName(slotOrId);
    return blockName(slotOrId);
  }

  function invCell(parent, slot, onClick, name) {
    var cell = el('div', 'vox-inv-cell', parent);
    var cv = document.createElement('canvas');
    cv.width = 40; cv.height = 40;
    cell.appendChild(cv);
    var id = slot ? slot.id : 0;
    paintIconInto(cv, id, slot ? slot.kind : null);
    if (slot && slot.count > 1) {
      var cnt = el('span', 'vox-slot-count', cell);
      cnt.textContent = slot.count;
    }
    // Part III §4: slot may now be an item-kind {id,count,kind} entry, not
    // just a block id -- slotName() handles both transparently.
    var label = name || (id ? slotName(slot) : '');
    if (label) {
      cell.addEventListener('mouseenter', function () { showTooltip(cell, label); });
      cell.addEventListener('mouseleave', hideTooltip);
    }
    cell.addEventListener('click', onClick);
    return cell;
  }

  // Write a hotbar/backpack slot, preferring an inventory setter if one exists.
  // which:'craft' targets the local §12 staging grid, never an Inventory slot.
  function setSlot(arr, idx, val, which) {
    var inv = game.inventory;
    if (which !== 'craft' && inv && typeof inv.setSlot === 'function') {
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
      // -- survival: crafting section (§12) + backpack grid + hotbar row;
      //    click to swap two slots (craft-grid cells join the same mechanic)
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
      // Crafting sits ABOVE the backpack (Minecraft survival-inventory
      // order). Creative mode deliberately has NO craft section: the palette
      // already grants every block, and there would be no backpack cells on
      // screen to tap-move ingredients from (vanilla-MC parity: the creative
      // inventory has no crafting grid either).
      buildCraftSection(dom.inv, makeSwap);
      var bp = el('div', 'vox-inv-grid', dom.inv);
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
    returnCraftGridToInventory();
    dom.inv.style.display = 'none';
    setUIMode(false);
    if (game && typeof game.resumePointerLock === 'function') game.resumePointerLock();
  }

  // ---- crafting section (Part III §12 -- pinned class .vox-craft-panel) ------
  // A 3x3 STAGING grid separate from hotbar/backpack (contract §12): the
  // player tap-moves ingredients from the backpack/hotbar cells into these 9
  // cells with the exact same swapSrc click-to-move mechanic the survival
  // panel already uses, Craft.match() re-runs on every grid change (each
  // move rebuilds the panel, which rebuilds this section), and the matched
  // recipe's output is previewed live in the result cell. "Craft" commits
  // via Craft.craftOnce -- craft.js consumes 1x the inputs from this same
  // staged grid (consumeFromGrid nulls the emptied cells of craftGrid in
  // place, since craftGrid IS the 3x3 array handed to match/craftOnce) and
  // adds the output to the inventory.

  function newCraftGrid() {
    return [[null, null, null], [null, null, null], [null, null, null]];
  }

  function buildCraftSection(parent, makeSwap) {
    if (typeof Craft === 'undefined' || !Craft || typeof Craft.match !== 'function') return;
    if (!craftGrid) craftGrid = newCraftGrid();

    var wrap = el('div', 'vox-craft-panel', parent);
    var title = el('div', 'vox-craft-title', wrap);
    title.textContent = t('vox.craft.title', 'Crafting');

    var area = el('div', 'vox-craft-area', wrap);
    var grid = el('div', 'vox-craft-grid', area);
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        invCell(grid, craftGrid[r][c], makeSwap(craftGrid[r], c, 'craft'));
      }
    }

    // Live match preview: this section is rebuilt after every grid mutation,
    // so calling match() here IS the "recompute on every grid change".
    var matched = Craft.match(craftGrid);

    var arrow = el('span', 'vox-craft-arrow', area);
    arrow.textContent = '→';

    var side = el('div', 'vox-craft-side', area);
    var out = el('div', 'vox-inv-cell vox-craft-out' + (matched ? '' : ' empty'), side);
    var cv = document.createElement('canvas');
    cv.width = 40; cv.height = 40;
    out.appendChild(cv);
    if (matched) {
      paintIconInto(cv, matched.output.id, matched.output.kind);
      if (matched.output.count > 1) {
        var cnt = el('span', 'vox-slot-count', out);
        cnt.textContent = matched.output.count;
      }
      var label = slotName({ id: matched.output.id, kind: matched.output.kind });
      if (label) {
        out.addEventListener('mouseenter', function () { showTooltip(out, label); });
        out.addEventListener('mouseleave', hideTooltip);
      }
    }
    // Clicking the result crafts too (familiar MC affordance); the button is
    // the primary, contract-named entry point. doCraft no-ops on no match.
    out.addEventListener('click', doCraft);

    var btn = el('button', 'vox-craft-btn', side);
    btn.textContent = t('vox.craft.btn', 'Craft');
    btn.disabled = !matched;
    btn.addEventListener('click', doCraft);
  }

  function doCraft() {
    var inv = game && game.inventory;
    if (!inv || typeof Craft === 'undefined' || !Craft) return;
    var recipe = Craft.match(craftGrid);
    if (!recipe) return;
    // Explicit grid argument (supported by craftOnce, see craft.js) so there
    // is zero ambiguity about which staged grid gets consumed. On success
    // consumeFromGrid already decremented/nulled the consumed cells of
    // craftGrid itself, so the rebuild below shows them cleared.
    if (Craft.craftOnce(inv, recipe, craftGrid)) {
      var label = slotName({ id: recipe.output.id, kind: recipe.output.kind });
      toast('+' + recipe.output.count + (label ? ' ' + label : ''));
      hideTooltip();
      pokeInventory();
      buildInventoryPanel();
    } else {
      toast(t('vox.craft.noRoom', 'No room in inventory!'));
    }
  }

  // Closing the panel hands staged ingredients back to the inventory
  // (Minecraft behaviour) so nothing sits invisibly in the hidden grid;
  // whatever doesn't fit (inventory full) stays staged for the next open
  // rather than being destroyed.
  function returnCraftGridToInventory() {
    var inv = game && game.inventory;
    if (!inv || !craftGrid || typeof inv.add !== 'function') return;
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        var s = craftGrid[r][c];
        if (!s) continue;
        var left = inv.add(s.id, s.count);
        if (left <= 0) craftGrid[r][c] = null;
        else s.count = left;
      }
    }
  }

  // ---- pause overlay + settings ------------------------------------------------

  function currentSettings() {
    var s = loadSettings();
    var g = (game && typeof game.getSettings === 'function') ? game.getSettings() : null;
    return {
      dist: (g && g.dist) || s.dist || 6,
      fov: (g && g.fov) || s.fov || 70,
      lut: (g && typeof g.lut === 'number') ? g.lut : (typeof s.lut === 'number' ? s.lut : 85),
      exp: (typeof s.exp === 'number') ? s.exp : 82,
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

    // main view (flex-column layout comes from the .vox-pause-main class;
    // showPaused/closeSettingsView only toggle inline display flex/none)
    dom.pauseMain = el('div', 'vox-pause-main', dom.paused);
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
    sliderRow(dom.settings, t('vox.settings.brightness', 'Brightness'), 50, 130, 1, cur.exp,
      function (v) {
        if (game && game.setExposure) game.setExposure(v / 100);
        saveSettings({ exp: v });
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
      // Part III §8: an optional cbs.cause string sets the "Slain by <name>"
      // / "Killed by a zombie" / "Fell to their death" line in one call;
      // callers that prefer to set it separately can still use
      // HUD.setDeathCause(text) at any point (e.g. once a 'death' message
      // with `by` arrives slightly after the local death is first shown).
      if (cbs && typeof cbs.cause === 'string') setDeathCause(cbs.cause);
      else if (!cbs || cbs.cause === undefined) setDeathCause(''); // fresh death, no cause yet
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
      s += '|' + (it ? it.id + ':' + it.count + ':' + (it.kind || '') : '');
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
      paintIconInto(slot.canvas, it ? it.id : 0, it ? it.kind : null);
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
    // damage pulse (§8 polish): only on a real decrease, never on the first
    // frame / respawn refill (lastHealth is -1 after init or a mode change).
    if (lastHealth >= 0 && hp < lastHealth) {
      dom.hearts.classList.remove('hurt');
      void dom.hearts.offsetWidth;   // restart the animation on rapid hits
      dom.hearts.classList.add('hurt');
      clearTimeout(heartsPulseTimer);
      heartsPulseTimer = setTimeout(function () {
        if (dom.hearts) dom.hearts.classList.remove('hurt');
      }, 240);
    }
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

  // Part III §8: armor row -- reads game.inventory.armor directly (rather
  // than requiring it on the passed `state`) so HUD.update(state)'s pinned
  // signature stays exactly as documented; this mirrors how updateDebug()
  // already reaches into `game` for extra info beyond `state`.
  function armorSig(armor) {
    if (!armor) return '';
    var s = '';
    for (var i = 0; i < ARMOR_SLOT_KEYS.length; i++) s += '|' + (armor[ARMOR_SLOT_KEYS[i]] || '');
    return s;
  }

  function updateArmorRow() {
    if (!dom.armorRow) return;
    var inv = game && game.inventory;
    var armor = inv && inv.armor ? inv.armor : null;
    var sig = armorSig(armor);
    if (sig === lastArmorSig) return;
    lastArmorSig = sig;
    for (var i = 0; i < ARMOR_SLOT_KEYS.length; i++) {
      var key = ARMOR_SLOT_KEYS[i];
      var itemId = armor ? armor[key] : null;
      var s = dom.armorSlots[key];
      if (!s) continue;
      s.root.classList.toggle('filled', !!itemId);
      var ctx = s.canvas.getContext('2d');
      ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
      if (itemId && typeof Items !== 'undefined' && Items && typeof Items.icon === 'function') {
        ctx.imageSmoothingEnabled = false;
        var icon = Items.icon(itemId);
        if (icon) ctx.drawImage(icon, 0, 0, s.canvas.width, s.canvas.height);
      }
    }
  }

  // Part III §8: full-screen red pulse on taking damage. Public entry point
  // HUD.flashDamage(); also self-wires to Combat.onDamage the first time
  // update() runs with a Combat global present, so Game doesn't strictly
  // have to call it manually (either path is safe -- flashDamage() is a
  // plain re-triggerable animation, not a queue).
  function flashDamage() {
    if (!dom.hitflash) return;
    dom.hitflash.classList.remove('on');
    // force reflow so re-adding 'on' restarts the CSS transition even if a
    // flash is already fading (rapid hits shouldn't silently no-op).
    void dom.hitflash.offsetWidth;
    dom.hitflash.classList.add('on');
    clearTimeout(hitflashTimer);
    hitflashTimer = setTimeout(function () {
      if (dom.hitflash) dom.hitflash.classList.remove('on');
    }, 90);
  }

  function wireCombatOnce() {
    if (combatWired) return;
    if (typeof Combat === 'undefined' || !Combat || typeof Combat.onDamage !== 'function') return;
    combatWired = true;
    Combat.onDamage(function (msg) {
      // Only the local player's own incoming damage should pulse the
      // screen -- Combat doesn't know the local id itself at the HUD layer,
      // so we compare against Combat.localHP's owner via the message id
      // when available; if `msg.id` is absent (older/looser payload),
      // flash anyway since that's the safer default for a solo/offline path.
      if (msg && msg.id != null && typeof Net !== 'undefined' && Net && Net.youId != null && msg.id !== Net.youId) {
        return; // damage to someone else (e.g. a mob you hit) -- not our screen to flash
      }
      flashDamage();
    });
  }

  // Part III §8: death-by cause line, e.g. "Slain by Steve" / "Killed by a
  // zombie" / "Fell to their death". Also settable via showDeath's cbs.cause
  // for callers that prefer to pass it alongside onRespawn in one call.
  function setDeathCause(text) {
    if (!dom.deathBy) return;
    var s = text ? String(text) : '';
    dom.deathBy.textContent = s;
    dom.deathBy.style.display = s ? 'block' : 'none';
  }

  function update(state) {
    if (!box) return;
    wireCombatOnce();

    // mode change → badge (skip the very first frame)
    if (lastMode !== null && state.mode !== lastMode) {
      showBadge(state.mode === 'creative'
        ? t('vox.mode.creative', 'Creative')
        : t('vox.mode.survival', 'Survival'));
      lastHealth = -1;   // hearts may have been hidden; force refresh
      lastHotbarSig = '';
      // §12: the creative panel has no craft section, so staged ingredients
      // would be unreachable there -- hand them back on any gamemode switch.
      returnCraftGridToInventory();
      if (invOpen) buildInventoryPanel();
    }
    lastMode = state.mode;

    updateHotbar(state);
    updateHearts(state);
    updateBubbles(state);
    updateArmorRow();
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
      lastArmorSig = ''; hotbarTooltipSelected = -1; combatWired = false;
      craftGrid = newCraftGrid();
      atlasCanvas = resolveAtlasCanvas(opts);
      buildDom();
      applyTouchSize(loadSettings().touch || 'm');
      wireHotbarSelectionTooltip();
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
      clearTimeout(hitflashTimer);
      clearTimeout(heartsPulseTimer);
      clearTimeout(hotbarTooltipTimer);
      unwireHotbarSelectionTooltip();
      if (chatOpen) closeChat(false);
      pauseCbs = {}; deathCbs = {};
      chatOpen = invOpen = pausedOpen = deathOpen = settingsOpen = false;
      debugVisible = false;
      combatWired = false;
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
      dom = {};
      game = null;
      root = null;
      craftGrid = null;
    },

    // Part III (§8): explicit entry points, in case Game prefers to drive
    // these itself rather than relying on HUD's own Combat.onDamage auto-wire.
    flashDamage: flashDamage,
    setDeathCause: setDeathCause
  };

  return api;
})();

window.HUD = HUD;
