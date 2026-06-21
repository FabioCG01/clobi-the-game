// editor.js -- the ONE UNIVERSAL character editor for "Tux Smash Royale".
// Global: Editor. Renders into #screen-editor.
//
// v2: body-type-aware controls. TUX shows Body/Belly/Feet colours; HUMANOID
// shows Skin / Hair / Beard / Shirt / Shoes colours, a Gender toggle, and
// Hairstyle + Beard pickers. The default humanoid is CLOBI (ponytail, small
// beard, white shirt). Every colour offers preset swatches AND a free colour
// picker. Catalogs come from the editable web/assets/parts.js via Sprites.PARTS.
(function () {
  'use strict';

  // Control layouts per body type. preset = key in Sprites.PARTS.presets;
  // cat = key in Sprites.PARTS for list rows.
  var LAYOUT = {
    tux: {
      colors: [
        { field: 'body', key: 'editor.body', en: 'Body', preset: 'body' },
        { field: 'belly', key: 'editor.belly', en: 'Belly', preset: 'belly' },
        { field: 'feet', key: 'editor.feet', en: 'Feet', preset: 'feet' }
      ],
      lists: [
        { field: 'hat', key: 'editor.hat', en: 'Hat', cat: 'HATS' },
        { field: 'eyes', key: 'editor.eyes', en: 'Eyes', cat: 'EYES' },
        { field: 'accessory', key: 'editor.accessory', en: 'Accessory', cat: 'ACCESSORIES' },
        { field: 'cape', key: 'editor.cape', en: 'Cape', cat: 'CAPES' }
      ]
    },
    humanoid: {
      colors: [
        { field: 'skin', key: 'editor.skin', en: 'Skin', preset: 'skin' },
        { field: 'hairColor', key: 'editor.hairColor', en: 'Hair colour', preset: 'hair' },
        { field: 'beardColor', key: 'editor.beardColor', en: 'Beard colour', preset: 'beard' },
        { field: 'belly', key: 'editor.shirt', en: 'Shirt', preset: 'shirt' },
        { field: 'feet', key: 'editor.shoes', en: 'Shoes', preset: 'feet' }
      ],
      lists: [
        { field: 'hair', key: 'editor.hairstyle', en: 'Hairstyle', cat: 'HAIRS' },
        { field: 'beard', key: 'editor.beard', en: 'Beard', cat: 'BEARDS' },
        { field: 'hat', key: 'editor.hat', en: 'Hat', cat: 'HATS' },
        { field: 'eyes', key: 'editor.eyes', en: 'Eyes', cat: 'EYES' },
        { field: 'accessory', key: 'editor.accessory', en: 'Accessory', cat: 'ACCESSORIES' },
        { field: 'cape', key: 'editor.cape', en: 'Cape', cat: 'CAPES' }
      ]
    }
  };

  var root = null, built = false, canvas = null, ctx = null;
  var nameInput = null, controlsEl = null, genderRow = null;
  var bodyTabs = {}, genderTabs = {};
  var listValueEls = {};
  var character = null, facing = 1, animFrame = 0, rafId = null, statusKey = null;

  function S() { return window.Sprites || null; }
  function parts() { var s = S(); return (s && s.PARTS) || {}; }
  function presetsFor(name) {
    var p = parts().presets || {};
    return Array.isArray(p[name]) ? p[name] : ['#888888'];
  }
  function catalog(name) {
    var p = parts();
    return Array.isArray(p[name]) ? p[name] : [];
  }
  function t(key, en) {
    if (window.I18n && typeof I18n.t === 'function') return I18n.t(key, en);
    return en;
  }
  function sanitize(c) {
    var s = S();
    if (s && typeof s.sanitize === 'function') return s.sanitize(c);
    return c || {};
  }
  function defaultCharacter() {
    var s = S();
    if (s && typeof s.defaultCharacter === 'function') return s.defaultCharacter();
    return { bodyType: 'tux' };
  }
  function clone(c) {
    var out = {};
    for (var k in c) { if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k]; }
    return out;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function partName(cat, idx) {
    var a = catalog(cat), item = a[idx];
    if (item && typeof item.name === 'string') return item.name;
    return idx === 0 ? t('editor.none', 'None') : ('#' + idx);
  }

  // ---- DOM ----------------------------------------------------------------
  function build() {
    root = document.getElementById('screen-editor');
    if (!root) { root = el('section'); root.id = 'screen-editor'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = '';
    injectStyle();

    var wrap = el('div', 'ed-wrap');
    wrap.appendChild(el('div', 'ed-title', t('editor.title', 'Character Editor')));
    wrap.appendChild(buildBodyTypeToggle());

    var cols = el('div', 'ed-cols');

    var previewCol = el('div', 'ed-preview-col');
    var box = el('div', 'ed-preview-box');
    canvas = el('canvas', 'ed-canvas'); canvas.width = 256; canvas.height = 256;
    box.appendChild(canvas); previewCol.appendChild(box);
    var flipBtn = el('button', 'ed-btn ed-flip', t('editor.flip', 'Flip <>')); flipBtn.type = 'button';
    flipBtn.addEventListener('click', flip); previewCol.appendChild(flipBtn);
    canvas.addEventListener('click', flip);
    cols.appendChild(previewCol);

    controlsEl = el('div', 'ed-controls');
    // Name row.
    var nameRow = el('div', 'ed-row');
    nameRow.appendChild(el('div', 'ed-rowlabel', t('editor.name', 'Name')));
    nameInput = el('input', 'ed-name'); nameInput.type = 'text'; nameInput.maxLength = 16;
    nameInput.spellcheck = false; nameInput.placeholder = t('editor.namePh', 'TUX');
    nameInput.addEventListener('input', function () { if (character) character.name = nameInput.value; });
    nameRow.appendChild(nameInput);
    controlsEl.appendChild(nameRow);
    // Dynamic part controls get appended by renderControls().
    cols.appendChild(controlsEl);
    wrap.appendChild(cols);

    var actions = el('div', 'ed-actions');
    actions.appendChild(actionBtn('editor.random', 'Randomize', onRandomize));
    actions.appendChild(actionBtn('editor.reset', 'Reset', onReset));
    actions.appendChild(actionBtn('common.back', 'Back', onBack));
    var save = actionBtn('editor.save', 'Save', onSave); save.className = 'ed-btn ed-btn-primary';
    actions.appendChild(save);
    wrap.appendChild(actions);

    var status = el('div', 'ed-status'); status.id = 'ed-status'; wrap.appendChild(status);
    root.appendChild(wrap);
    if (canvas.getContext) ctx = canvas.getContext('2d');
    built = true;
  }

  function actionBtn(key, en, fn) {
    var b = el('button', 'ed-btn', t(key, en)); b.type = 'button';
    b.addEventListener('click', fn); return b;
  }

  function buildBodyTypeToggle() {
    var rowEl = el('div', 'ed-bodytype');
    rowEl.appendChild(el('div', 'ed-bt-label', t('editor.bodyType', 'Body Type')));
    var tabs = el('div', 'ed-bt-tabs'); bodyTabs = {};
    ['tux', 'humanoid'].forEach(function (bt) {
      var b = el('button', 'ed-bt-tab', t('editor.' + bt, bt === 'tux' ? 'Tux' : 'Humanoid'));
      b.type = 'button';
      b.addEventListener('click', function () { setBodyType(bt); });
      bodyTabs[bt] = b; tabs.appendChild(b);
    });
    rowEl.appendChild(tabs);
    return rowEl;
  }

  // Rebuild the part controls for the current body type.
  function renderControls() {
    // Remove everything after the name row (the first child).
    while (controlsEl.children.length > 1) controlsEl.removeChild(controlsEl.lastChild);
    listValueEls = {};
    var bt = (character.bodyType === 'humanoid') ? 'humanoid' : 'tux';
    var lay = LAYOUT[bt];

    if (bt === 'humanoid') controlsEl.appendChild(buildGenderRow());
    lay.colors.forEach(function (cfg) { controlsEl.appendChild(buildColorRow(cfg)); });
    lay.lists.forEach(function (cfg) { controlsEl.appendChild(buildListRow(cfg)); });

    syncTabs();
  }

  function buildGenderRow() {
    var rowEl = el('div', 'ed-row');
    rowEl.appendChild(el('div', 'ed-rowlabel', t('editor.gender', 'Gender')));
    var tabs = el('div', 'ed-gender'); genderTabs = {};
    [['male', 'Male'], ['female', 'Female']].forEach(function (g) {
      var b = el('button', 'ed-gtab', t('editor.' + g[0], g[1])); b.type = 'button';
      b.addEventListener('click', function () {
        character.gender = g[0]; syncTabs(); drawPreview();
      });
      genderTabs[g[0]] = b; tabs.appendChild(b);
    });
    rowEl.appendChild(tabs);
    return rowEl;
  }

  function buildColorRow(cfg) {
    var rowEl = el('div', 'ed-row');
    rowEl.appendChild(el('div', 'ed-rowlabel', t(cfg.key, cfg.en)));
    var ctrl = el('div', 'ed-rowctrl');

    var grid = el('div', 'ed-swatches');
    presetsFor(cfg.preset).forEach(function (hex) {
      var sw = el('button', 'ed-swatch'); sw.type = 'button';
      sw.style.background = hex; sw.title = hex;
      sw.addEventListener('click', function () { setColor(cfg.field, hex, picker); });
      grid.appendChild(sw);
    });

    var picker = el('input', 'ed-picker'); picker.type = 'color';
    picker.value = toHex6(character[cfg.field]);
    picker.title = t('editor.pickColor', 'Pick any colour');
    picker.addEventListener('input', function () { setColor(cfg.field, picker.value, null); });

    ctrl.appendChild(grid);
    ctrl.appendChild(picker);
    rowEl.appendChild(ctrl);
    return rowEl;
  }

  function buildListRow(cfg) {
    var rowEl = el('div', 'ed-row');
    rowEl.appendChild(el('div', 'ed-rowlabel', t(cfg.key, cfg.en)));
    var ctrl = el('div', 'ed-rowctrl');
    var prev = el('button', 'ed-arrow', '<'); prev.type = 'button';
    prev.addEventListener('click', function () { cycle(cfg.field, cfg.cat, -1); });
    var val = el('div', 'ed-listval'); var span = el('span', 'ed-listval-text', '');
    val.appendChild(span); listValueEls[cfg.field] = { span: span, cat: cfg.cat };
    var next = el('button', 'ed-arrow', '>'); next.type = 'button';
    next.addEventListener('click', function () { cycle(cfg.field, cfg.cat, 1); });
    ctrl.appendChild(prev); ctrl.appendChild(val); ctrl.appendChild(next);
    rowEl.appendChild(ctrl);
    updateListVal(cfg.field);
    return rowEl;
  }

  // ---- actions ------------------------------------------------------------
  function flip() { facing = -facing; drawPreview(); }

  function setBodyType(bt) {
    if (bt !== 'tux' && bt !== 'humanoid') return;
    character.bodyType = bt;
    renderControls();
    drawPreview();
  }

  function setColor(field, hex, picker) {
    character[field] = hex;
    if (picker) picker.value = toHex6(hex);
    drawPreview();
  }

  function cycle(field, cat, dir) {
    var len = catalog(cat).length; if (!len) return;
    var v = (character[field] | 0) + dir;
    v = ((v % len) + len) % len;
    character[field] = v;
    updateListVal(field);
    drawPreview();
  }

  function updateListVal(field) {
    var rec = listValueEls[field]; if (!rec) return;
    rec.span.textContent = String(partName(rec.cat, character[field] | 0)).toUpperCase();
  }

  function syncTabs() {
    var bt = (character.bodyType === 'humanoid') ? 'humanoid' : 'tux';
    if (bodyTabs.tux) bodyTabs.tux.classList.toggle('active', bt === 'tux');
    if (bodyTabs.humanoid) bodyTabs.humanoid.classList.toggle('active', bt === 'humanoid');
    var g = (character.gender === 'female') ? 'female' : 'male';
    if (genderTabs.male) genderTabs.male.classList.toggle('active', g === 'male');
    if (genderTabs.female) genderTabs.female.classList.toggle('active', g === 'female');
  }

  function onRandomize() {
    var s = S(); var keep = character ? character.name : '';
    character = sanitize(s && s.randomCharacter ? s.randomCharacter() : {});
    if (!character.name) character.name = keep;
    renderControls(); drawPreview(); setStatus('editor.randomized', 'Randomized.');
  }

  function onReset() {
    var keep = character ? character.name : '';
    character = sanitize(defaultCharacter());
    if (keep) character.name = keep;
    if (nameInput) nameInput.value = character.name || '';
    renderControls(); drawPreview(); setStatus('editor.resetDone', 'Reset to classic Tux.');
  }

  function onSave() {
    var nm = (nameInput && nameInput.value != null) ? nameInput.value.trim() : (character.name || '');
    character.name = nm;
    var saved = sanitize(character);
    saved.name = nm;
    character = clone(saved);
    var payload = clone(saved);

    if (window.App && typeof App.updateCharacter === 'function') App.updateCharacter(payload);
    else if (window.App) App.character = payload;
    if (window.Store && typeof Store.setCharacter === 'function') Store.setCharacter(payload);

    var synced = false;
    if (window.Store && Store.isLoggedIn && Store.isLoggedIn() && Store.saveCharacterRemote) {
      synced = true;
      try {
        var p = Store.saveCharacterRemote(payload);
        if (p && p.then) {
          p.then(function () { setStatus('editor.savedSynced', 'Saved and synced to your account.'); })
            .catch(function () { setStatus('editor.savedLocal', 'Saved locally (sync failed).'); });
        }
      } catch (e) { synced = false; }
    }
    if (!synced) setStatus('editor.saved', 'Saved!');
    showMenu();
  }

  function onBack() { showMenu(); }
  function showMenu() {
    stopLoop();
    if (window.App && App.showScreen) App.showScreen('menu');
    else if (window.Menu && Menu.show) Menu.show();
  }

  function setStatus(key, en) {
    statusKey = key ? { key: key, en: en } : null;
    var s = document.getElementById('ed-status');
    if (s) s.textContent = statusKey ? t(statusKey.key, statusKey.en) : '';
  }

  // ---- preview ------------------------------------------------------------
  function drawPreview() {
    if (!ctx) return;
    var w = canvas.width, h = canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1a1d2e'; ctx.fillRect(0, 0, w, h);
    var tile = 16;
    for (var gy = 0; gy < h; gy += tile) for (var gx = 0; gx < w; gx += tile) {
      if ((((gx / tile) + (gy / tile)) & 1) === 0) { ctx.fillStyle = '#222640'; ctx.fillRect(gx, gy, tile, tile); }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(w * 0.5 - 44, h * 0.5 + 60, 88, 12);
    var s = S();
    if (s && s.drawCharacter && character) {
      var bob = Math.round(Math.sin(animFrame / 18) * 2);
      s.drawCharacter(ctx, character, Math.round(w / 2), Math.round(h / 2 + bob), 6, facing);
    }
  }
  function loop() { animFrame++; drawPreview(); rafId = window.requestAnimationFrame(loop); }
  function startLoop() { if (rafId == null) rafId = window.requestAnimationFrame(loop); }
  function stopLoop() { if (rafId != null) { window.cancelAnimationFrame(rafId); rafId = null; } }

  // ---- public -------------------------------------------------------------
  function show() {
    if (!built) build();
    var src = (window.App && App.character) ? App.character : null;
    character = sanitize(src || defaultCharacter());
    if (!character.name && window.App && App.nickname) character.name = String(App.nickname).slice(0, 16);
    facing = 1; statusKey = null;
    if (nameInput) nameInput.value = character.name || '';
    renderControls(); setStatus(null);
    if (window.App && App.showScreen) App.showScreen('editor');
    else if (root) { root.classList.add('active'); root.style.display = ''; }
    drawPreview(); startLoop();
  }
  function hide() { stopLoop(); if (root && !(window.App && App.showScreen)) root.classList.remove('active'); }

  function toHex6(h) {
    if (typeof h !== 'string' || h[0] !== '#') return '#000000';
    var x = h.slice(1);
    if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
    return '#' + x.slice(0, 6);
  }

  function injectStyle() {
    if (document.getElementById('editor-style')) return;
    var css = [
      '#screen-editor{font-family:"Press Start 2P",monospace;color:#e8ecff;image-rendering:pixelated;padding:16px;box-sizing:border-box;overflow:auto;}',
      '#screen-editor *{box-sizing:border-box;}',
      '.ed-wrap{max-width:940px;margin:0 auto;}',
      '.ed-title{font-size:20px;color:#7ff9e0;text-align:center;margin:8px 0 16px;text-shadow:3px 3px 0 #000;}',
      '.ed-bodytype{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 0 18px;flex-wrap:wrap;}',
      '.ed-bt-label{font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;}',
      '.ed-bt-tabs,.ed-gender{display:flex;border:4px solid #000;box-shadow:4px 4px 0 #000;}',
      '.ed-bt-tab,.ed-gtab{font-family:inherit;font-size:11px;color:#e8ecff;background:#11131f;border:0;border-right:4px solid #000;padding:10px 16px;cursor:pointer;}',
      '.ed-bt-tab:last-child,.ed-gtab:last-child{border-right:0;}',
      '.ed-bt-tab.active,.ed-gtab.active{background:#7ff9e0;color:#1a1d2e;}',
      '.ed-gender{box-shadow:3px 3px 0 #000;border-width:3px;}',
      '.ed-gtab{font-size:9px;padding:8px 12px;border-right-width:3px;}',
      '.ed-cols{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start;justify-content:center;}',
      '.ed-preview-col{display:flex;flex-direction:column;align-items:center;gap:12px;}',
      '.ed-preview-box{background:#1a1d2e;border:4px solid #7ff9e0;box-shadow:6px 6px 0 #000;padding:6px;}',
      '.ed-canvas{display:block;width:256px;height:256px;image-rendering:pixelated;cursor:pointer;}',
      '.ed-controls{flex:1 1 380px;min-width:300px;display:flex;flex-direction:column;gap:9px;}',
      '.ed-row{display:flex;align-items:center;gap:10px;}',
      '.ed-rowlabel{flex:0 0 92px;font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;}',
      '.ed-rowctrl{flex:1 1 auto;display:flex;align-items:center;gap:8px;}',
      '.ed-name{flex:1 1 auto;font-family:inherit;font-size:11px;color:#1a1d2e;background:#e8ecff;border:3px solid #000;box-shadow:3px 3px 0 #000;padding:8px;text-transform:uppercase;}',
      '.ed-arrow{font-family:inherit;font-size:12px;color:#1a1d2e;background:#7ff9e0;border:3px solid #000;box-shadow:2px 2px 0 #000;width:30px;height:30px;cursor:pointer;padding:0;flex:0 0 auto;}',
      '.ed-arrow:hover{background:#1a1d2e;color:#7ff9e0;}',
      '.ed-swatches{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:5px;background:#11131f;border:3px solid #000;box-shadow:3px 3px 0 #000;padding:5px;}',
      '.ed-swatch{width:22px;height:22px;border:3px solid #000;padding:0;cursor:pointer;image-rendering:pixelated;}',
      '.ed-swatch:hover{outline:2px solid #fff;outline-offset:-1px;}',
      '.ed-picker{flex:0 0 auto;width:38px;height:30px;padding:0;border:3px solid #000;box-shadow:2px 2px 0 #000;background:#11131f;cursor:pointer;}',
      '.ed-listval{flex:1 1 auto;font-size:10px;background:#11131f;border:3px solid #000;box-shadow:3px 3px 0 #000;padding:9px 8px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ed-listval-text{color:#7ff9e0;}',
      '.ed-actions{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:24px;}',
      '.ed-btn{font-family:inherit;font-size:11px;color:#1a1d2e;background:#e8ecff;border:4px solid #000;box-shadow:4px 4px 0 #000;padding:12px 16px;cursor:pointer;}',
      '.ed-btn:hover{background:#1a1d2e;color:#e8ecff;}',
      '.ed-btn-primary{background:#ff9e2c;color:#1a1d2e;}',
      '.ed-flip{font-size:9px;padding:8px 12px;}',
      '.ed-status{text-align:center;font-size:9px;color:#7ff9e0;margin-top:14px;min-height:12px;text-shadow:2px 2px 0 #000;}'
    ].join('');
    var st = el('style'); st.id = 'editor-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Editor = { show: show, hide: hide, open: show, close: hide };
})();
