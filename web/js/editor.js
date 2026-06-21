// editor.js -- the ONE UNIVERSAL character editor for "Tux Smash Royale".
// Global: Editor. Renders into #screen-editor.
//
// Features (per project contract):
//   - A TUX / HUMANOID body-type toggle at the top that sets character.bodyType
//     ('tux' | 'humanoid'); the same shared parts (colors, hat, eyes, accessory,
//     cape) apply to whichever body. The character is cross-compatible across
//     both game modes.
//   - A big live pixel preview via Sprites.drawCharacter (idle-bobs; click to flip).
//   - One control row per shared part: prev/next (</>) arrows; color rows also
//     render a swatch grid for direct picking, list rows show the part name.
//   - A name field, and Randomize / Reset / Save buttons.
//   - Save: App.updateCharacter(c); Store.setCharacter(c); and, if logged in,
//     Store.saveCharacterRemote(c).
//   - Every label goes through I18n.t(key, englishFallback) and re-localizes on
//     I18n.onChange.
//
// Depends on globals: Sprites, I18n, Store, App. All are accessed defensively so
// the editor degrades gracefully if a dependency is momentarily unavailable.
(function () {
  'use strict';

  // ---- character field <-> Sprites.PARTS mapping --------------------------
  // Color rows back onto a hex-list in Sprites.PARTS and draw a swatch grid.
  var COLOR_ROWS = [
    { field: 'body',  key: 'editor.body',  en: 'Body',  source: 'BODY_COLORS' },
    { field: 'belly', key: 'editor.belly', en: 'Belly', source: 'BELLY_COLORS' },
    { field: 'feet',  key: 'editor.feet',  en: 'Feet',  source: 'FEET_COLORS' }
  ];
  // List rows back onto a named-part list and show the current part name.
  var LIST_ROWS = [
    { field: 'hat',       key: 'editor.hat',       en: 'Hat',       source: 'HATS' },
    { field: 'eyes',      key: 'editor.eyes',      en: 'Eyes',      source: 'EYES' },
    { field: 'accessory', key: 'editor.accessory', en: 'Accessory', source: 'ACCESSORIES' },
    { field: 'cape',      key: 'editor.cape',      en: 'Cape',      source: 'CAPES' }
  ];

  // ---- module state -------------------------------------------------------
  var root = null;          // #screen-editor element
  var built = false;        // DOM built once
  var canvas = null;        // preview canvas
  var ctx = null;
  var nameInput = null;
  var swatchEls = {};       // field -> [swatch button elements]
  var listValueEls = {};    // field -> the <span> showing the current part name
  var bodyTabs = {};        // 'tux' | 'humanoid' -> tab button element
  var i18nEls = [];         // [{el, key, en, attr}] static labels to re-localize
  var character = null;     // working copy being edited (local until Save)
  var facing = 1;           // preview facing (toggled by clicking the preview)
  var animFrame = 0;        // idle-bob counter
  var rafId = null;
  var statusKey = null;     // current status (so it re-localizes on lang change)
  var i18nBound = false;    // I18n.onChange listener attached once

  // ---- dependency helpers -------------------------------------------------
  function S() { return window.Sprites || null; }

  function parts() {
    var s = S();
    return (s && s.PARTS) || {};
  }

  function arr(name) {
    var p = parts();
    return Array.isArray(p[name]) ? p[name] : [];
  }

  function t(key, en) {
    if (window.I18n && typeof I18n.t === 'function') return I18n.t(key, en);
    return en;
  }

  function defaultCharacter() {
    var s = S();
    if (s && typeof s.defaultCharacter === 'function') {
      var c = s.defaultCharacter();
      if (c && typeof c === 'object') return normalize(c);
    }
    return {
      name: 'Tux', bodyType: 'tux',
      body: 0, belly: 0, feet: 0, hat: 0, eyes: 0, accessory: 0, cape: 0
    };
  }

  // Clamp every field into a safe full character. Never mutates the input.
  function normalize(c) {
    var s = S();
    if (s && typeof s.sanitize === 'function') {
      var n = s.sanitize(c);
      if (n && typeof n === 'object') {
        // Ensure bodyType survives even if a normalizer drops it.
        if (n.bodyType !== 'humanoid' && n.bodyType !== 'tux') {
          n.bodyType = (c && c.bodyType === 'humanoid') ? 'humanoid' : 'tux';
        }
        return n;
      }
    }
    return localNormalize(c);
  }

  function localNormalize(c) {
    c = (c && typeof c === 'object') ? c : {};
    function pick(v, len) {
      var i = (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0;
      if (!len || len <= 0) return 0;
      i = i % len;
      if (i < 0) i += len;
      return i;
    }
    var name = (typeof c.name === 'string') ? c.name.slice(0, 16) : 'Tux';
    return {
      name: name,
      bodyType: (c.bodyType === 'humanoid') ? 'humanoid' : 'tux',
      body: pick(c.body, arr('BODY_COLORS').length),
      belly: pick(c.belly, arr('BELLY_COLORS').length),
      feet: pick(c.feet, arr('FEET_COLORS').length),
      hat: pick(c.hat, arr('HATS').length),
      eyes: pick(c.eyes, arr('EYES').length),
      accessory: pick(c.accessory, arr('ACCESSORIES').length),
      cape: pick(c.cape, arr('CAPES').length)
    };
  }

  function cloneChar(c) {
    var out = {};
    if (c && typeof c === 'object') {
      for (var k in c) {
        if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k];
      }
    }
    return out;
  }

  // Keep an index within [0,len), wrapping both ways. Empty -> 0.
  function wrap(idx, len) {
    if (!len || len <= 0) return 0;
    idx = idx % len;
    if (idx < 0) idx += len;
    return idx;
  }

  function fieldIndex(field, source) {
    var len = arr(source).length;
    var v = character ? character[field] : 0;
    v = (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0;
    return wrap(v, len);
  }

  // Localized name for a part index, falling back to the array's own name.
  function partName(source, idx) {
    var a = arr(source);
    var item = a[idx];
    if (item && typeof item === 'object' && typeof item.name === 'string') return item.name;
    if (typeof item === 'string') return item;
    return idx === 0 ? t('editor.none', 'None') : ('#' + idx);
  }

  // ---- DOM construction ---------------------------------------------------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Register a static element for re-localization. attr === 'placeholder' sets
  // the placeholder; otherwise textContent.
  function i18nText(e, key, en, attr) {
    i18nEls.push({ el: e, key: key, en: en, attr: attr || null });
    if (attr === 'placeholder') e.placeholder = t(key, en);
    else e.textContent = t(key, en);
    return e;
  }

  function build() {
    root = document.getElementById('screen-editor');
    if (!root) {
      // Container is normally owned by index.html / App; create a fallback.
      root = el('section');
      root.id = 'screen-editor';
      root.className = 'screen';
      document.body.appendChild(root);
    }
    root.innerHTML = '';
    i18nEls = [];
    injectStyle();

    var wrapEl = el('div', 'ed-wrap');

    // Title bar
    var title = el('div', 'ed-title');
    i18nText(title, 'editor.title', 'Character Editor');
    wrapEl.appendChild(title);

    // Body-type toggle (TUX / HUMANOID)
    wrapEl.appendChild(buildBodyTypeToggle());

    var cols = el('div', 'ed-cols');

    // --- Left: live preview ---
    var previewCol = el('div', 'ed-preview-col');
    var previewBox = el('div', 'ed-preview-box');
    canvas = el('canvas', 'ed-canvas');
    canvas.width = 256;
    canvas.height = 256;
    previewBox.appendChild(canvas);
    previewCol.appendChild(previewBox);

    var flipBtn = el('button', 'ed-btn ed-flip');
    flipBtn.type = 'button';
    i18nText(flipBtn, 'editor.flip', 'Flip <>');
    flipBtn.addEventListener('click', flip);
    previewCol.appendChild(flipBtn);

    canvas.addEventListener('click', flip);
    cols.appendChild(previewCol);

    // --- Right: controls ---
    var controls = el('div', 'ed-controls');

    // Name field
    var nameRow = el('div', 'ed-row ed-namerow');
    var nameLabel = el('div', 'ed-rowlabel');
    i18nText(nameLabel, 'editor.name', 'Name');
    nameRow.appendChild(nameLabel);
    nameInput = el('input', 'ed-name');
    nameInput.type = 'text';
    nameInput.maxLength = 16;
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    i18nText(nameInput, 'editor.namePh', 'TUX', 'placeholder');
    nameInput.addEventListener('input', function () {
      if (character) character.name = nameInput.value;
    });
    nameRow.appendChild(nameInput);
    controls.appendChild(nameRow);

    // Color rows (swatch grids)
    swatchEls = {};
    COLOR_ROWS.forEach(function (row) { controls.appendChild(buildColorRow(row)); });

    // List rows (named parts with </> arrows)
    listValueEls = {};
    LIST_ROWS.forEach(function (row) { controls.appendChild(buildListRow(row)); });

    cols.appendChild(controls);
    wrapEl.appendChild(cols);

    // --- Action buttons ---
    var actions = el('div', 'ed-actions');

    var randomBtn = el('button', 'ed-btn');
    randomBtn.type = 'button';
    i18nText(randomBtn, 'editor.random', 'Randomize');
    randomBtn.addEventListener('click', onRandomize);

    var resetBtn = el('button', 'ed-btn');
    resetBtn.type = 'button';
    i18nText(resetBtn, 'editor.reset', 'Reset');
    resetBtn.addEventListener('click', onReset);

    var backBtn = el('button', 'ed-btn');
    backBtn.type = 'button';
    i18nText(backBtn, 'common.back', 'Back');
    backBtn.addEventListener('click', onBack);

    var saveBtn = el('button', 'ed-btn ed-btn-primary');
    saveBtn.type = 'button';
    i18nText(saveBtn, 'editor.save', 'Save');
    saveBtn.addEventListener('click', onSave);

    actions.appendChild(randomBtn);
    actions.appendChild(resetBtn);
    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    wrapEl.appendChild(actions);

    var status = el('div', 'ed-status');
    status.id = 'ed-status';
    wrapEl.appendChild(status);

    root.appendChild(wrapEl);

    if (canvas.getContext) ctx = canvas.getContext('2d');

    // Re-localize whenever the language changes (attach exactly once).
    if (!i18nBound && window.I18n && typeof I18n.onChange === 'function') {
      I18n.onChange(relocalize);
      i18nBound = true;
    }

    built = true;
  }

  function buildBodyTypeToggle() {
    var rowEl = el('div', 'ed-bodytype');
    var label = el('div', 'ed-bt-label');
    i18nText(label, 'editor.bodyType', 'Body Type');
    rowEl.appendChild(label);

    var tabsEl = el('div', 'ed-bt-tabs');
    bodyTabs = {};

    var tux = el('button', 'ed-bt-tab');
    tux.type = 'button';
    i18nText(tux, 'editor.tux', 'Tux');
    tux.addEventListener('click', function () { setBodyType('tux'); });
    bodyTabs.tux = tux;

    var humanoid = el('button', 'ed-bt-tab');
    humanoid.type = 'button';
    i18nText(humanoid, 'editor.humanoid', 'Humanoid');
    humanoid.addEventListener('click', function () { setBodyType('humanoid'); });
    bodyTabs.humanoid = humanoid;

    tabsEl.appendChild(tux);
    tabsEl.appendChild(humanoid);
    rowEl.appendChild(tabsEl);
    return rowEl;
  }

  function buildColorRow(row) {
    var rowEl = el('div', 'ed-row');
    var lbl = el('div', 'ed-rowlabel');
    i18nText(lbl, row.key, row.en);
    rowEl.appendChild(lbl);

    var ctrl = el('div', 'ed-rowctrl');

    var prev = el('button', 'ed-arrow', '<');
    prev.type = 'button';
    prev.addEventListener('click', function () { cycle(row.field, row.source, -1); });

    var grid = el('div', 'ed-swatches');
    var colors = arr(row.source);
    var list = [];
    colors.forEach(function (hex, i) {
      var sw = el('button', 'ed-swatch');
      sw.type = 'button';
      sw.style.background = (typeof hex === 'string') ? hex : '#000';
      sw.title = (typeof hex === 'string') ? hex : ('#' + i);
      sw.setAttribute('data-idx', String(i));
      sw.addEventListener('click', function () { setField(row.field, i); });
      grid.appendChild(sw);
      list.push(sw);
    });
    swatchEls[row.field] = list;

    var next = el('button', 'ed-arrow', '>');
    next.type = 'button';
    next.addEventListener('click', function () { cycle(row.field, row.source, 1); });

    ctrl.appendChild(prev);
    ctrl.appendChild(grid);
    ctrl.appendChild(next);
    rowEl.appendChild(ctrl);
    return rowEl;
  }

  function buildListRow(row) {
    var rowEl = el('div', 'ed-row');
    var lbl = el('div', 'ed-rowlabel');
    i18nText(lbl, row.key, row.en);
    rowEl.appendChild(lbl);

    var ctrl = el('div', 'ed-rowctrl');

    var prev = el('button', 'ed-arrow', '<');
    prev.type = 'button';
    prev.addEventListener('click', function () { cycle(row.field, row.source, -1); });

    var val = el('div', 'ed-listval');
    var valText = el('span', 'ed-listval-text', '');
    val.appendChild(valText);
    listValueEls[row.field] = valText;

    var next = el('button', 'ed-arrow', '>');
    next.type = 'button';
    next.addEventListener('click', function () { cycle(row.field, row.source, 1); });

    ctrl.appendChild(prev);
    ctrl.appendChild(val);
    ctrl.appendChild(next);
    rowEl.appendChild(ctrl);
    return rowEl;
  }

  // ---- editing actions ----------------------------------------------------
  function flip() {
    facing = (facing === 1) ? -1 : 1;
    drawPreview();
  }

  function setBodyType(bt) {
    if (bt !== 'tux' && bt !== 'humanoid') return;
    if (!character) return;
    character.bodyType = bt;
    syncUI();
    drawPreview();
  }

  function cycle(field, source, dir) {
    var len = arr(source).length;
    if (!len) return;
    var cur = fieldIndex(field, source);
    setField(field, wrap(cur + dir, len));
  }

  function setField(field, idx) {
    if (!character) return;
    character[field] = idx;
    syncUI();
    drawPreview();
  }

  function onRandomize() {
    var rc = null;
    var s = S();
    if (s && typeof s.randomCharacter === 'function') {
      try { rc = s.randomCharacter(); } catch (e) { rc = null; }
    }
    if (!rc || typeof rc !== 'object') rc = randomFallback();
    rc = normalize(rc);
    // Preserve the player's typed name unless random supplies a fresh one.
    var keepName = character ? character.name : '';
    character = rc;
    if (character.name == null || character.name === '') character.name = keepName;
    syncUI();
    drawPreview();
    setStatus('editor.randomized', 'Randomized.');
  }

  function randomFallback() {
    function r(name) {
      var n = arr(name).length;
      return n ? Math.floor(Math.random() * n) : 0;
    }
    return {
      name: character ? character.name : 'Tux',
      bodyType: (Math.random() < 0.5) ? 'tux' : 'humanoid',
      body: r('BODY_COLORS'),
      belly: r('BELLY_COLORS'),
      feet: r('FEET_COLORS'),
      hat: r('HATS'),
      eyes: r('EYES'),
      accessory: r('ACCESSORIES'),
      cape: r('CAPES')
    };
  }

  function onReset() {
    var keepName = character ? character.name : '';
    character = defaultCharacter();
    if ((character.name == null || character.name === '') && keepName) {
      character.name = keepName;
    }
    syncUI();
    drawPreview();
    setStatus('editor.resetDone', 'Reset to classic Tux.');
  }

  function onSave() {
    // Normalize all indices + name into valid ranges before persisting.
    var nm = (nameInput && nameInput.value != null) ? nameInput.value.trim() : (character.name || '');
    character.name = nm;
    var saved = normalize(character);
    if (saved.name === '') saved.name = defaultCharacter().name;
    character = cloneChar(saved);

    var payload = cloneChar(saved);

    // App is the source of truth for the live character.
    if (window.App && typeof App.updateCharacter === 'function') {
      App.updateCharacter(payload);
    } else if (window.App) {
      App.character = payload;
    }

    // Local persistence.
    if (window.Store && typeof Store.setCharacter === 'function') {
      Store.setCharacter(payload);
    }

    // Remote sync only when logged in.
    var synced = false;
    if (window.Store &&
        typeof Store.isLoggedIn === 'function' && Store.isLoggedIn() &&
        typeof Store.saveCharacterRemote === 'function') {
      synced = true;
      try {
        var p = Store.saveCharacterRemote(payload);
        if (p && typeof p.then === 'function') {
          p.then(function () { setStatus('editor.savedSynced', 'Saved and synced to your account.'); })
           .catch(function () { setStatus('editor.savedLocal', 'Saved locally (account sync failed).'); });
        }
      } catch (e) {
        synced = false;
      }
    }
    if (!synced) setStatus('editor.saved', 'Saved!');

    showMenu();
  }

  function onBack() {
    showMenu();
  }

  function showMenu() {
    hide();
    if (window.App && typeof App.showScreen === 'function') {
      App.showScreen('menu');
    } else if (window.Menu && typeof Menu.show === 'function') {
      Menu.show();
    }
  }

  function setStatus(key, en) {
    statusKey = key ? { key: key, en: en } : null;
    var s = document.getElementById('ed-status');
    if (s) s.textContent = statusKey ? t(statusKey.key, statusKey.en) : '';
  }

  // ---- UI sync (highlight current selections + body-type tabs) ------------
  function syncUI() {
    if (!character) return;

    // Body-type tabs
    var bt = (character.bodyType === 'humanoid') ? 'humanoid' : 'tux';
    character.bodyType = bt;
    if (bodyTabs.tux) bodyTabs.tux.classList.toggle('active', bt === 'tux');
    if (bodyTabs.humanoid) bodyTabs.humanoid.classList.toggle('active', bt === 'humanoid');

    // Name (don't clobber while the user is typing in it)
    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = character.name != null ? character.name : '';
    }

    // Color swatches
    COLOR_ROWS.forEach(function (row) {
      var idx = fieldIndex(row.field, row.source);
      character[row.field] = idx;
      var listEls = swatchEls[row.field] || [];
      for (var i = 0; i < listEls.length; i++) {
        listEls[i].classList.toggle('selected', i === idx);
      }
    });

    // List rows
    LIST_ROWS.forEach(function (row) {
      var idx = fieldIndex(row.field, row.source);
      character[row.field] = idx;
      var span = listValueEls[row.field];
      if (span) span.textContent = String(partName(row.source, idx)).toUpperCase();
    });
  }

  // Re-apply translations to every registered static label + the dynamic status.
  function relocalize() {
    for (var i = 0; i < i18nEls.length; i++) {
      var rec = i18nEls[i];
      if (!rec || !rec.el) continue;
      if (rec.attr === 'placeholder') rec.el.placeholder = t(rec.key, rec.en);
      else rec.el.textContent = t(rec.key, rec.en);
    }
    // List row part names may differ per language; refresh them too.
    syncUI();
    if (statusKey) setStatus(statusKey.key, statusKey.en);
  }

  // ---- preview rendering --------------------------------------------------
  function drawPreview() {
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;
    ctx.imageSmoothingEnabled = false;

    // 8-bit checker background inside the preview box.
    ctx.fillStyle = '#1a1d2e';
    ctx.fillRect(0, 0, w, h);
    var tile = 16;
    for (var gy = 0; gy < h; gy += tile) {
      for (var gx = 0; gx < w; gx += tile) {
        if (((gx / tile) + (gy / tile)) % 2 === 0) {
          ctx.fillStyle = '#222640';
          ctx.fillRect(gx, gy, tile, tile);
        }
      }
    }

    // floor shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(w * 0.5 - 44, h * 0.5 + 60, 88, 12);

    var s = S();
    if (s && typeof s.drawCharacter === 'function' && character) {
      var scale = 6;
      var bob = Math.round(Math.sin(animFrame / 18) * 2); // whole-pixel idle bob
      s.drawCharacter(ctx, character, Math.round(w / 2), Math.round(h / 2 + bob), scale, facing);
    } else if (s && typeof s.drawPenguin === 'function' && character) {
      // Backward-compatible fallback if only the penguin renderer exists.
      var scale2 = 6;
      var bob2 = Math.round(Math.sin(animFrame / 18) * 2);
      s.drawPenguin(ctx, character, Math.round(w / 2), Math.round(h / 2 + bob2), scale2, facing);
    } else {
      ctx.fillStyle = '#ff9e2c';
      ctx.font = '10px monospace';
      ctx.fillText('Sprites unavailable', 40, h / 2);
    }
  }

  function loop() {
    animFrame++;
    drawPreview();
    rafId = window.requestAnimationFrame(loop);
  }
  function startLoop() {
    if (rafId == null) rafId = window.requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ---- public API ---------------------------------------------------------
  function show() {
    if (!built) build();

    // Seed the working copy from the current App character (or default).
    var src = (window.App && App.character) ? App.character : null;
    character = normalize(src || defaultCharacter());

    // If the character has no name yet, fall back to the app nickname.
    if ((character.name == null || character.name === '') && window.App && App.nickname) {
      character.name = String(App.nickname).slice(0, 16);
    }

    facing = 1;
    statusKey = null;
    syncUI();
    if (nameInput) nameInput.value = character.name != null ? character.name : '';
    setStatus(null);

    if (window.App && typeof App.showScreen === 'function') {
      App.showScreen('editor');
    } else if (root) {
      root.classList.add('active');
      root.style.display = '';
    }

    drawPreview();
    startLoop();
  }

  function hide() {
    stopLoop();
    if (root && !(window.App && typeof App.showScreen === 'function')) {
      root.classList.remove('active');
    }
  }

  // ---- 8-bit styling (scoped to #screen-editor) ---------------------------
  function injectStyle() {
    if (document.getElementById('editor-style')) return;
    var css = [
      '#screen-editor{font-family:"Press Start 2P",monospace;color:#e8ecff;',
      '  image-rendering:pixelated;padding:16px;box-sizing:border-box;}',
      '#screen-editor *{box-sizing:border-box;}',
      '.ed-wrap{max-width:900px;margin:0 auto;}',
      '.ed-title{font-size:20px;color:#7ff9e0;text-align:center;margin:8px 0 16px;',
      '  text-shadow:3px 3px 0 #000;letter-spacing:1px;}',

      // body-type toggle
      '.ed-bodytype{display:flex;align-items:center;justify-content:center;gap:12px;',
      '  margin:0 0 18px;flex-wrap:wrap;}',
      '.ed-bt-label{font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;}',
      '.ed-bt-tabs{display:flex;gap:0;border:4px solid #000;box-shadow:4px 4px 0 #000;}',
      '.ed-bt-tab{font-family:inherit;font-size:11px;color:#e8ecff;background:#11131f;',
      '  border:0;border-right:4px solid #000;padding:12px 18px;cursor:pointer;letter-spacing:1px;}',
      '.ed-bt-tab:last-child{border-right:0;}',
      '.ed-bt-tab:hover{background:#222640;}',
      '.ed-bt-tab.active{background:#7ff9e0;color:#1a1d2e;}',

      '.ed-cols{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;justify-content:center;}',
      '.ed-preview-col{display:flex;flex-direction:column;align-items:center;gap:12px;}',
      '.ed-preview-box{background:#1a1d2e;border:4px solid #7ff9e0;',
      '  box-shadow:6px 6px 0 #000;padding:6px;}',
      '.ed-canvas{display:block;width:256px;height:256px;image-rendering:pixelated;',
      '  image-rendering:crisp-edges;cursor:pointer;}',
      '.ed-controls{flex:1 1 360px;min-width:300px;display:flex;flex-direction:column;gap:10px;}',
      '.ed-row,.ed-namerow{display:flex;align-items:center;gap:10px;}',
      '.ed-rowlabel{flex:0 0 96px;font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;}',
      '.ed-rowctrl{flex:1 1 auto;display:flex;align-items:center;gap:8px;}',
      '.ed-name{flex:1 1 auto;font-family:inherit;font-size:11px;color:#1a1d2e;',
      '  background:#e8ecff;border:3px solid #000;box-shadow:3px 3px 0 #000;',
      '  padding:8px;text-transform:uppercase;outline:none;}',
      '.ed-name:focus{border-color:#7ff9e0;background:#fff;}',
      '.ed-arrow{font-family:inherit;font-size:12px;color:#1a1d2e;background:#7ff9e0;',
      '  border:3px solid #000;box-shadow:2px 2px 0 #000;width:30px;height:30px;',
      '  line-height:1;cursor:pointer;padding:0;flex:0 0 auto;}',
      '.ed-arrow:hover{background:#1a1d2e;color:#7ff9e0;}',
      '.ed-arrow:active{transform:translate(2px,2px);box-shadow:0 0 0 #000;}',
      '.ed-swatches{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:5px;',
      '  background:#11131f;border:3px solid #000;box-shadow:3px 3px 0 #000;padding:5px;}',
      '.ed-swatch{width:22px;height:22px;border:3px solid #000;padding:0;cursor:pointer;',
      '  image-rendering:pixelated;}',
      '.ed-swatch:hover{outline:2px solid #fff;outline-offset:-1px;}',
      '.ed-swatch.selected{border-color:#ff9e2c;outline:2px solid #ff9e2c;outline-offset:1px;}',
      '.ed-listval{flex:1 1 auto;font-size:10px;color:#e8ecff;background:#11131f;',
      '  border:3px solid #000;box-shadow:3px 3px 0 #000;padding:9px 8px;text-align:center;',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ed-listval-text{color:#7ff9e0;}',
      '.ed-actions{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:24px;}',
      '.ed-btn{font-family:inherit;font-size:11px;color:#1a1d2e;background:#e8ecff;',
      '  border:4px solid #000;box-shadow:4px 4px 0 #000;padding:12px 16px;cursor:pointer;',
      '  letter-spacing:1px;}',
      '.ed-btn:hover{background:#1a1d2e;color:#e8ecff;}',
      '.ed-btn:active{transform:translate(4px,4px);box-shadow:0 0 0 #000;}',
      '.ed-btn-primary{background:#ff9e2c;color:#1a1d2e;}',
      '.ed-btn-primary:hover{background:#1a1d2e;color:#ff9e2c;}',
      '.ed-flip{font-size:9px;padding:8px 12px;}',
      '.ed-status{text-align:center;font-size:9px;color:#7ff9e0;margin-top:14px;min-height:12px;',
      '  text-shadow:2px 2px 0 #000;}'
    ].join('');
    var style = el('style');
    style.id = 'editor-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---- export -------------------------------------------------------------
  var Editor = {
    show: show,
    hide: hide,
    // Aliases for callers using the open/close vocabulary.
    open: show,
    close: hide,
    // Exposed for testing / external callers; not required by the contract.
    getCharacter: function () { return cloneChar(character || defaultCharacter()); }
  };

  window.Editor = Editor;
})();
