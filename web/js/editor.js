// editor.js — the ONE UNIVERSAL character editor for "Tux Smash Royale".
// Global: Editor. Renders into #screen-editor.
//
// v3 UX: a BIG live preview on the left (with zoom + flip), all options on the
// right. Body-type toggle (Tux / Humanoid); for Humanoid: gender, a thin<->fat
// slider, hair/beard + shirt/pants/shoe STYLES, and skin/hair/beard/shirt/pants/
// shoe/cape colours. Every colour row has preset swatches AND an obvious rainbow
// "Custom" picker. Save / load / delete named PRESETS. Catalogs come from the
// baked texture manifest (Sprites.PARTS.catalog), so new art appears automatically.
(function () {
  'use strict';

  // character field -> texture catalog group (for style pickers)
  var CAT = { hair: 'hair', beard: 'beard', shirtStyle: 'shirt', pantsStyle: 'pants', shoeStyle: 'shoes', hat: 'hat', eyes: 'eyes', mouth: 'mouth', accessory: 'accessory', cape: 'cape' };

  var LAYOUT = {
    tux: {
      colors: [['body', 'editor.body', 'Body', 'body'], ['belly', 'editor.belly', 'Belly', 'belly'], ['feet', 'editor.feet', 'Feet', 'feet']],
      lists: [['hat', 'editor.hat', 'Hat'], ['eyes', 'editor.eyes', 'Eyes'], ['accessory', 'editor.accessory', 'Accessory'], ['cape', 'editor.cape', 'Cape']]
    },
    humanoid: {
      colors: [['skin', 'editor.skin', 'Skin', 'skin'], ['hairColor', 'editor.hairColor', 'Hair', 'hair'], ['beardColor', 'editor.beardColor', 'Beard', 'beard'], ['belly', 'editor.shirt', 'Shirt', 'shirt'], ['pants', 'editor.pants', 'Pants', 'pants'], ['feet', 'editor.shoes', 'Shoes', 'feet']],
      lists: [['hair', 'editor.hairstyle', 'Hairstyle'], ['beard', 'editor.beard', 'Beard'], ['shirtStyle', 'editor.shirtStyle', 'Shirt'], ['pantsStyle', 'editor.pantsStyle', 'Pants'], ['shoeStyle', 'editor.shoeStyle', 'Shoes'], ['hat', 'editor.hat', 'Hat'], ['eyes', 'editor.eyes', 'Eyes'], ['mouth', 'editor.mouth', 'Mouth'], ['accessory', 'editor.accessory', 'Accessory'], ['cape', 'editor.cape', 'Cape']]
    }
  };
  var PRESETS_KEY = 'clobi.presets';

  var root = null, built = false, canvas = null, ctx = null;
  var nameInput = null, optionsEl = null, presetSel = null;
  var bodyTabs = {}, genderTabs = {}, listValueEls = {};
  var character = null, facing = 1, zoom = 1.0, animFrame = 0, rafId = null, statusKey = null;

  function S() { return window.Sprites || null; }
  function t(key, en) { return (window.I18n && I18n.t) ? I18n.t(key, en) : en; }
  function catalog(group) { var s = S(); return (s && s.PARTS && s.PARTS.catalog) ? (s.PARTS.catalog(group) || []) : []; }
  function presetsFor(name) { var s = S(); var p = (s && s.PARTS && s.PARTS.presets) || {}; return Array.isArray(p[name]) ? p[name] : ['#888888']; }
  function sanitize(c) { var s = S(); return (s && s.sanitize) ? s.sanitize(c) : (c || {}); }
  function defaultCharacter() { var s = S(); return (s && s.defaultCharacter) ? s.defaultCharacter() : { bodyType: 'tux' }; }
  function clone(c) { var o = {}; for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) o[k] = c[k]; return o; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function partName(group, idx) { var a = catalog(group), it = a[idx]; return (it && it.name) ? it.name : (idx === 0 ? t('editor.none', 'None') : ('#' + idx)); }

  // ---- DOM ----------------------------------------------------------------
  function build() {
    root = document.getElementById('screen-editor');
    if (!root) { root = el('section'); root.id = 'screen-editor'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = ''; injectStyle();

    var wrap = el('div', 'ed-wrap');
    var head = el('div', 'ed-head');
    head.appendChild(el('div', 'ed-title', t('editor.title', 'Character Editor')));
    head.appendChild(buildBodyTypeToggle());
    wrap.appendChild(head);

    var stage = el('div', 'ed-stage');

    // LEFT: big preview
    var left = el('div', 'ed-left');
    var box = el('div', 'ed-preview-box');
    canvas = el('canvas', 'ed-canvas');
    box.appendChild(canvas);
    left.appendChild(box);
    var zr = el('div', 'ed-zoomrow');
    var zo = el('button', 'ed-zbtn', '−'); zo.type = 'button'; zo.addEventListener('click', function () { setZoom(zoom - 0.2); });
    var zoom_ = el('input', 'ed-zoom'); zoom_.type = 'range'; zoom_.min = '0.6'; zoom_.max = '3'; zoom_.step = '0.05'; zoom_.value = String(zoom);
    zoom_.addEventListener('input', function () { setZoom(+zoom_.value, true); });
    zoomSlider = zoom_;
    var zi = el('button', 'ed-zbtn', '+'); zi.type = 'button'; zi.addEventListener('click', function () { setZoom(zoom + 0.2); });
    var flip = el('button', 'ed-zbtn ed-flip', '⇄'); flip.type = 'button'; flip.title = t('editor.flip', 'Flip'); flip.addEventListener('click', doFlip);
    zr.appendChild(el('span', 'ed-zlabel', t('editor.zoom', 'Zoom'))); zr.appendChild(zo); zr.appendChild(zoom_); zr.appendChild(zi); zr.appendChild(flip);
    left.appendChild(zr);
    box.addEventListener('click', doFlip);
    box.addEventListener('wheel', function (e) { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.15 : -0.15)); }, { passive: false });
    stage.appendChild(left);

    // RIGHT: scrollable options
    optionsEl = el('div', 'ed-right');
    stage.appendChild(optionsEl);
    wrap.appendChild(stage);

    // actions
    var actions = el('div', 'ed-actions');
    actions.appendChild(actionBtn('editor.random', 'Randomize', onRandomize));
    actions.appendChild(actionBtn('editor.reset', 'Reset', onReset));
    actions.appendChild(actionBtn('common.back', 'Back', onBack));
    var save = actionBtn('editor.save', 'Save', onSave); save.classList.add('ed-btn-primary');
    actions.appendChild(save);
    wrap.appendChild(actions);

    var status = el('div', 'ed-status'); status.id = 'ed-status'; wrap.appendChild(status);
    root.appendChild(wrap);
    if (canvas.getContext) ctx = canvas.getContext('2d');
    if (window.addEventListener) window.addEventListener('resize', resizeCanvas);
    if (window.Textures && Textures.onReady) Textures.onReady(function () { if (built && character) { renderControls(); } });
    built = true;
  }
  var zoomSlider = null;

  function actionBtn(key, en, fn) { var b = el('button', 'ed-btn', t(key, en)); b.type = 'button'; b.addEventListener('click', fn); return b; }

  function buildBodyTypeToggle() {
    var row = el('div', 'ed-bodytype');
    row.appendChild(el('div', 'ed-bt-label', t('editor.bodyType', 'Body Type')));
    var tabs = el('div', 'ed-bt-tabs'); bodyTabs = {};
    ['tux', 'humanoid'].forEach(function (bt) {
      var b = el('button', 'ed-bt-tab', t('editor.' + bt, bt === 'tux' ? 'Tux' : 'Humanoid')); b.type = 'button';
      b.addEventListener('click', function () { setBodyType(bt); });
      bodyTabs[bt] = b; tabs.appendChild(b);
    });
    row.appendChild(tabs); return row;
  }

  // Rebuild the right-hand options for the current body type.
  function renderControls() {
    optionsEl.innerHTML = ''; listValueEls = {};
    var bt = (character.bodyType === 'humanoid') ? 'humanoid' : 'tux';
    var lay = LAYOUT[bt];

    // name
    var nameRow = el('div', 'ed-row');
    nameRow.appendChild(el('div', 'ed-rowlabel', t('editor.name', 'Name')));
    nameInput = el('input', 'ed-name'); nameInput.type = 'text'; nameInput.maxLength = 16; nameInput.spellcheck = false;
    nameInput.placeholder = t('editor.namePh', 'TUX'); nameInput.value = character.name || '';
    nameInput.addEventListener('input', function () { if (character) character.name = nameInput.value; });
    nameRow.appendChild(nameInput); optionsEl.appendChild(nameRow);

    if (bt === 'humanoid') { optionsEl.appendChild(buildGenderRow()); optionsEl.appendChild(buildFatRow()); }

    optionsEl.appendChild(sectionLabel(t('editor.colors', 'Colours')));
    lay.colors.forEach(function (c) { optionsEl.appendChild(buildColorRow({ field: c[0], key: c[1], en: c[2], preset: c[3] })); });
    if ((character.cape | 0) > 0) optionsEl.appendChild(buildColorRow({ field: 'capeColor', key: 'editor.capeColor', en: 'Cape', preset: 'cape' }));

    optionsEl.appendChild(sectionLabel(t('editor.styles', 'Styles')));
    lay.lists.forEach(function (c) { optionsEl.appendChild(buildListRow({ field: c[0], key: c[1], en: c[2], cat: CAT[c[0]] })); });

    optionsEl.appendChild(buildPresetsRow());
    syncTabs();
  }

  function sectionLabel(text) { return el('div', 'ed-section', text); }

  function buildGenderRow() {
    var row = el('div', 'ed-row');
    row.appendChild(el('div', 'ed-rowlabel', t('editor.gender', 'Gender')));
    var tabs = el('div', 'ed-seg'); genderTabs = {};
    [['male', 'Male'], ['female', 'Female']].forEach(function (g) {
      var b = el('button', 'ed-segbtn', t('editor.' + g[0], g[1])); b.type = 'button';
      b.addEventListener('click', function () { character.gender = g[0]; syncTabs(); }); genderTabs[g[0]] = b; tabs.appendChild(b);
    });
    row.appendChild(tabs); return row;
  }

  function buildFatRow() {
    var row = el('div', 'ed-row');
    row.appendChild(el('div', 'ed-rowlabel', t('editor.build', 'Build')));
    var ctrl = el('div', 'ed-rowctrl');
    ctrl.appendChild(el('span', 'ed-slmin', t('editor.thin', 'Thin')));
    var sl = el('input', 'ed-slider'); sl.type = 'range'; sl.min = '0'; sl.max = '1'; sl.step = '0.05'; sl.value = String(character.fat || 0);
    sl.addEventListener('input', function () { character.fat = +sl.value; });
    ctrl.appendChild(sl); ctrl.appendChild(el('span', 'ed-slmax', t('editor.fat', 'Fat')));
    row.appendChild(ctrl); return row;
  }

  function buildColorRow(cfg) {
    var row = el('div', 'ed-row');
    row.appendChild(el('div', 'ed-rowlabel', t(cfg.key, cfg.en)));
    var ctrl = el('div', 'ed-rowctrl');

    // current colour chip
    var cur = el('span', 'ed-current'); cur.style.background = toHex6(character[cfg.field]);
    ctrl.appendChild(cur);

    var grid = el('div', 'ed-swatches');
    presetsFor(cfg.preset).forEach(function (hex) {
      var sw = el('button', 'ed-swatch'); sw.type = 'button'; sw.style.background = hex; sw.title = hex;
      sw.addEventListener('click', function () { setColor(cfg.field, hex); cur.style.background = hex; if (picker) picker.value = toHex6(hex); });
      grid.appendChild(sw);
    });
    ctrl.appendChild(grid);

    // obvious custom picker: rainbow button with label + hidden native input
    var custom = el('label', 'ed-custom'); custom.title = t('editor.pickColor', 'Pick any colour');
    custom.appendChild(el('span', 'ed-custom-ico', '🎨'));
    custom.appendChild(el('span', 'ed-custom-txt', t('editor.custom', 'CUSTOM')));
    var picker = el('input', 'ed-picker'); picker.type = 'color'; picker.value = toHex6(character[cfg.field]);
    picker.addEventListener('input', function () { setColor(cfg.field, picker.value); cur.style.background = picker.value; });
    custom.appendChild(picker);
    ctrl.appendChild(custom);

    row.appendChild(ctrl); return row;
  }

  function buildListRow(cfg) {
    var row = el('div', 'ed-row');
    row.appendChild(el('div', 'ed-rowlabel', t(cfg.key, cfg.en)));
    var ctrl = el('div', 'ed-rowctrl');
    var prev = el('button', 'ed-arrow', '‹'); prev.type = 'button'; prev.addEventListener('click', function () { cycle(cfg.field, cfg.cat, -1); });
    var val = el('div', 'ed-listval'); var span = el('span', 'ed-listval-text', ''); val.appendChild(span);
    listValueEls[cfg.field] = { span: span, cat: cfg.cat };
    var next = el('button', 'ed-arrow', '›'); next.type = 'button'; next.addEventListener('click', function () { cycle(cfg.field, cfg.cat, 1); });
    ctrl.appendChild(prev); ctrl.appendChild(val); ctrl.appendChild(next);
    row.appendChild(ctrl); updateListVal(cfg.field); return row;
  }

  function buildPresetsRow() {
    var box = el('div', 'ed-presets');
    box.appendChild(sectionLabel(t('editor.presets', 'Presets')));
    var row = el('div', 'ed-row');
    presetSel = el('select', 'ed-select'); refreshPresetOptions();
    var load = el('button', 'ed-mini', t('editor.load', 'Load')); load.type = 'button'; load.addEventListener('click', onLoadPreset);
    var savep = el('button', 'ed-mini', t('editor.savePreset', 'Save')); savep.type = 'button'; savep.addEventListener('click', onSavePreset);
    var del = el('button', 'ed-mini', t('editor.delete', 'Del')); del.type = 'button'; del.addEventListener('click', onDeletePreset);
    var ctrl = el('div', 'ed-rowctrl'); ctrl.appendChild(presetSel); ctrl.appendChild(load); ctrl.appendChild(savep); ctrl.appendChild(del);
    row.appendChild(ctrl); box.appendChild(row); return box;
  }

  // ---- presets storage ----
  function readPresets() { try { return JSON.parse(window.localStorage.getItem(PRESETS_KEY)) || []; } catch (e) { return []; } }
  function writePresets(a) { try { window.localStorage.setItem(PRESETS_KEY, JSON.stringify(a)); } catch (e) { } }
  function refreshPresetOptions() {
    if (!presetSel) return; presetSel.innerHTML = '';
    var list = readPresets();
    if (!list.length) { var o = el('option', null, t('editor.noPresets', '— none —')); o.value = ''; presetSel.appendChild(o); return; }
    list.forEach(function (p, i) { var o = el('option', null, p.name || ('#' + i)); o.value = String(i); presetSel.appendChild(o); });
  }
  function onSavePreset() {
    var nm = window.prompt(t('editor.presetName', 'Preset name:'), character.name || 'Preset');
    if (nm == null) return; nm = String(nm).trim() || 'Preset';
    var list = readPresets(); list.push({ name: nm, ch: sanitize(character) });
    writePresets(list); refreshPresetOptions(); setStatus('editor.presetSaved', 'Preset saved.');
  }
  function onLoadPreset() {
    var i = presetSel && presetSel.value; if (i === '' || i == null) return;
    var list = readPresets(), p = list[+i]; if (!p) return;
    var keep = character.name; character = sanitize(p.ch); if (!character.name) character.name = keep;
    renderControls(); setStatus('editor.presetLoaded', 'Preset loaded.');
  }
  function onDeletePreset() {
    var i = presetSel && presetSel.value; if (i === '' || i == null) return;
    var list = readPresets(); list.splice(+i, 1); writePresets(list); refreshPresetOptions(); setStatus('editor.presetDeleted', 'Preset deleted.');
  }

  // ---- actions ------------------------------------------------------------
  function doFlip() { facing = -facing; }
  function setZoom(z, fromSlider) { zoom = Math.max(0.6, Math.min(3, z)); if (zoomSlider && !fromSlider) zoomSlider.value = String(zoom); }
  function setBodyType(bt) { if (bt !== 'tux' && bt !== 'humanoid') return; character.bodyType = bt; renderControls(); }
  function setColor(field, hex) { character[field] = hex; }
  function cycle(field, cat, dir) {
    var len = catalog(cat).length; if (!len) return;
    var v = (character[field] | 0) + dir; v = ((v % len) + len) % len; character[field] = v;
    updateListVal(field);
    if (field === 'cape') renderControls();   // toggling cape on/off shows/hides cape-colour row
  }
  function updateListVal(field) { var rec = listValueEls[field]; if (!rec) return; rec.span.textContent = String(partName(rec.cat, character[field] | 0)).toUpperCase(); }
  function syncTabs() {
    var bt = (character.bodyType === 'humanoid') ? 'humanoid' : 'tux';
    if (bodyTabs.tux) bodyTabs.tux.classList.toggle('active', bt === 'tux');
    if (bodyTabs.humanoid) bodyTabs.humanoid.classList.toggle('active', bt === 'humanoid');
    var g = (character.gender === 'female') ? 'female' : 'male';
    if (genderTabs.male) genderTabs.male.classList.toggle('active', g === 'male');
    if (genderTabs.female) genderTabs.female.classList.toggle('active', g === 'female');
  }

  function onRandomize() { var s = S(); var keep = character ? character.name : ''; character = sanitize(s && s.randomCharacter ? s.randomCharacter() : {}); if (!character.name) character.name = keep; renderControls(); setStatus('editor.randomized', 'Randomized.'); }
  function onReset() { var keep = character ? character.name : ''; character = sanitize(defaultCharacter()); if (keep) character.name = keep; renderControls(); setStatus('editor.resetDone', 'Reset to classic Tux.'); }
  function onSave() {
    var nm = (nameInput && nameInput.value != null) ? nameInput.value.trim() : (character.name || '');
    character.name = nm; var saved = sanitize(character); saved.name = nm; character = clone(saved);
    var payload = clone(saved);
    if (window.App && App.updateCharacter) App.updateCharacter(payload); else if (window.App) App.character = payload;
    if (window.Store && Store.setCharacter) Store.setCharacter(payload);
    var synced = false;
    if (window.Store && Store.isLoggedIn && Store.isLoggedIn() && Store.saveCharacterRemote) {
      synced = true;
      try { var p = Store.saveCharacterRemote(payload); if (p && p.then) { p.then(function () { setStatus('editor.savedSynced', 'Saved and synced to your account.'); }).catch(function () { setStatus('editor.savedLocal', 'Saved locally (sync failed).'); }); } }
      catch (e) { synced = false; }
    }
    if (!synced) setStatus('editor.saved', 'Saved!');
    showMenu();
  }
  function onBack() { showMenu(); }
  function showMenu() { stopLoop(); if (window.App && App.showScreen) App.showScreen('menu'); else if (window.Menu && Menu.show) Menu.show(); }
  function setStatus(key, en) { statusKey = key ? { key: key, en: en } : null; var s = document.getElementById('ed-status'); if (s) s.textContent = statusKey ? t(statusKey.key, statusKey.en) : ''; }

  // ---- preview ------------------------------------------------------------
  function resizeCanvas() {
    if (!canvas) return; var box = canvas.parentElement; if (!box) return;
    var w = Math.max(120, box.clientWidth), h = Math.max(120, box.clientHeight);
    canvas.width = w; canvas.height = h;
  }
  function drawPreview() {
    if (!ctx) return; var w = canvas.width, h = canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#171a2b'; ctx.fillRect(0, 0, w, h);
    var tile = 24;
    for (var gy = 0; gy < h; gy += tile) for (var gx = 0; gx < w; gx += tile) if ((((gx / tile) + (gy / tile)) & 1) === 0) { ctx.fillStyle = '#1d2138'; ctx.fillRect(gx, gy, tile, tile); }
    // base scale fits the 36-tall sprite to ~62% of the panel height, * zoom
    var baseScale = (h * 0.50) / 18;
    var scale = baseScale * zoom;
    var cyFeet = h * 0.5;
    var bob = Math.sin(animFrame / 22) * 1.5;
    // soft shadow under the feet
    ctx.fillStyle = 'rgba(0,0,0,0.30)'; var sw = scale * 9; ctx.beginPath(); ctx.ellipse(w / 2, cyFeet + 9 * scale, sw, sw * 0.28, 0, 0, 7); ctx.fill();
    var s = S();
    if (s && s.drawCharacter && character) s.drawCharacter(ctx, character, Math.round(w / 2), Math.round(cyFeet + bob), scale, facing);
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
    renderControls(); setStatus(null);
    if (window.App && App.showScreen) App.showScreen('editor'); else if (root) { root.classList.add('active'); root.style.display = ''; }
    resizeCanvas(); drawPreview(); startLoop();
    // a second resize after layout settles (fonts/flex)
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { resizeCanvas(); });
  }
  function hide() { stopLoop(); if (root && !(window.App && App.showScreen)) root.classList.remove('active'); }

  function toHex6(h) { if (typeof h !== 'string' || h[0] !== '#') return '#000000'; var x = h.slice(1); if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2]; return '#' + x.slice(0, 6); }

  function injectStyle() {
    if (document.getElementById('editor-style')) return;
    var css = [
      '#screen-editor{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e8ecff;}',
      '#screen-editor *{box-sizing:border-box;}',
      '.ed-wrap{height:100%;display:flex;flex-direction:column;padding:10px 14px;gap:8px;}',
      '.ed-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.ed-title{font-size:16px;color:#7ff9e0;text-shadow:2px 2px 0 #000;}',
      '.ed-bodytype{display:flex;align-items:center;gap:10px;}',
      '.ed-bt-label{font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;}',
      '.ed-bt-tabs,.ed-seg{display:flex;border:3px solid #000;box-shadow:3px 3px 0 #000;}',
      '.ed-bt-tab,.ed-segbtn{font-family:inherit;font-size:10px;color:#e8ecff;background:#11131f;border:0;border-right:3px solid #000;padding:9px 14px;cursor:pointer;}',
      '.ed-bt-tab:last-child,.ed-segbtn:last-child{border-right:0;}',
      '.ed-bt-tab.active,.ed-segbtn.active{background:#7ff9e0;color:#10131f;}',
      '.ed-segbtn{font-size:9px;padding:7px 10px;}',
      '.ed-stage{flex:1 1 auto;display:flex;gap:14px;min-height:0;}',
      '.ed-left{flex:1 1 46%;max-width:50%;display:flex;flex-direction:column;gap:8px;min-width:240px;}',
      '.ed-preview-box{flex:1 1 auto;background:#171a2b;border:4px solid #7ff9e0;box-shadow:6px 6px 0 #000;min-height:200px;overflow:hidden;cursor:pointer;position:relative;}',
      '.ed-canvas{display:block;width:100%;height:100%;image-rendering:pixelated;}',
      '.ed-zoomrow{display:flex;align-items:center;gap:8px;}',
      '.ed-zlabel{font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;}',
      '.ed-zoom{flex:1 1 auto;accent-color:#7ff9e0;}',
      '.ed-zbtn{font-family:inherit;font-size:12px;color:#10131f;background:#7ff9e0;border:3px solid #000;box-shadow:2px 2px 0 #000;width:34px;height:30px;cursor:pointer;padding:0;}',
      '.ed-zbtn:hover{background:#10131f;color:#7ff9e0;}',
      '.ed-right{flex:1 1 54%;min-width:320px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;padding-right:6px;}',
      '.ed-section{font-size:9px;color:#ff9e2c;text-shadow:2px 2px 0 #000;margin:6px 0 0;border-bottom:2px solid #2a2f4a;padding-bottom:4px;}',
      '.ed-row{display:flex;align-items:center;gap:8px;}',
      '.ed-rowlabel{flex:0 0 74px;font-size:8px;color:#cfd4e8;text-shadow:1px 1px 0 #000;}',
      '.ed-rowctrl{flex:1 1 auto;display:flex;align-items:center;gap:6px;min-width:0;}',
      '.ed-name{flex:1 1 auto;font-family:inherit;font-size:11px;color:#10131f;background:#e8ecff;border:3px solid #000;box-shadow:2px 2px 0 #000;padding:8px;text-transform:uppercase;width:100%;}',
      '.ed-current{flex:0 0 auto;width:20px;height:20px;border:2px solid #000;box-shadow:1px 1px 0 #000;}',
      '.ed-swatches{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:4px;background:#11131f;border:2px solid #000;padding:4px;min-width:0;}',
      '.ed-swatch{width:18px;height:18px;border:2px solid #000;padding:0;cursor:pointer;}',
      '.ed-swatch:hover{outline:2px solid #fff;outline-offset:-1px;}',
      '.ed-custom{flex:0 0 auto;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;width:46px;height:34px;border:3px solid #fff;box-shadow:2px 2px 0 #000;cursor:pointer;background:conic-gradient(from 0deg,#ff5a3c,#ffcf3c,#9cff5a,#7ff9e0,#2b5fff,#7a52d0,#ff5aa0,#ff5a3c);}',
      '.ed-custom-ico{font-size:11px;line-height:1;filter:drop-shadow(0 1px 0 #000);}',
      '.ed-custom-txt{font-size:5px;color:#fff;text-shadow:1px 1px 0 #000;margin-top:1px;letter-spacing:1px;}',
      '.ed-picker{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:0;padding:0;}',
      '.ed-arrow{font-family:inherit;font-size:13px;color:#10131f;background:#7ff9e0;border:3px solid #000;box-shadow:2px 2px 0 #000;width:28px;height:28px;cursor:pointer;padding:0;flex:0 0 auto;}',
      '.ed-arrow:hover{background:#10131f;color:#7ff9e0;}',
      '.ed-listval{flex:1 1 auto;font-size:9px;background:#11131f;border:2px solid #000;box-shadow:2px 2px 0 #000;padding:8px 6px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}',
      '.ed-listval-text{color:#7ff9e0;}',
      '.ed-slider{flex:1 1 auto;accent-color:#ff9e2c;}',
      '.ed-slmin,.ed-slmax{font-size:7px;color:#cfd4e8;}',
      '.ed-presets{display:flex;flex-direction:column;gap:6px;}',
      '.ed-select{flex:1 1 auto;font-family:inherit;font-size:9px;color:#10131f;background:#e8ecff;border:2px solid #000;padding:6px;min-width:0;}',
      '.ed-mini{font-family:inherit;font-size:8px;color:#10131f;background:#ff9e2c;border:2px solid #000;box-shadow:2px 2px 0 #000;padding:6px 7px;cursor:pointer;flex:0 0 auto;}',
      '.ed-mini:hover{background:#10131f;color:#ff9e2c;}',
      '.ed-actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;}',
      '.ed-btn{font-family:inherit;font-size:10px;color:#10131f;background:#e8ecff;border:3px solid #000;box-shadow:3px 3px 0 #000;padding:11px 15px;cursor:pointer;}',
      '.ed-btn:hover{background:#10131f;color:#e8ecff;}',
      '.ed-btn-primary{background:#ff9e2c;}',
      '.ed-status{text-align:center;font-size:8px;color:#7ff9e0;min-height:10px;text-shadow:1px 1px 0 #000;}',
      '@media(max-width:720px){.ed-stage{flex-direction:column;}.ed-right{flex:1 1 auto;min-width:0;}.ed-left{min-height:240px;max-width:none;}}'
    ].join('');
    var st = el('style'); st.id = 'editor-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Editor = { show: show, hide: hide, open: show, close: hide };
})();
