// editor.js — modern, tabbed character editor with DIRECT MANIPULATION. Global: Editor.
//
// Left: a big live preview. Click a face/head part to select it, then DRAG to move,
// WHEEL to resize, SHIFT+WHEEL to rotate; click the same spot again to cycle to an
// overlapping part underneath. Right: tabs (Body / Face / Hair / Wear / Adjust /
// Saves) so controls are grouped instead of one long scroll. All transforms are
// visual only — the server hitbox never changes.
(function () {
  'use strict';

  function S() { return window.Sprites || null; }
  function TX() { return window.Textures || null; }
  function t(k, en) { return (window.I18n && I18n.t) ? I18n.t(k, en) : en; }
  function catalog(g) { var s = S(); return (s && s.PARTS && s.PARTS.catalog) ? (s.PARTS.catalog(g) || []) : []; }
  function presetsFor(n) { var s = S(); var p = (s && s.PARTS && s.PARTS.presets) || {}; return Array.isArray(p[n]) ? p[n] : ['#888888']; }
  function sanitize(c) { var s = S(); return (s && s.sanitize) ? s.sanitize(c) : (c || {}); }
  function defaultCharacter() { var s = S(); return (s && s.defaultCharacter) ? s.defaultCharacter() : { bodyType: 'tux' }; }
  function clone(c) { var o = {}; for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) o[k] = c[k]; return o; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function toHex6(h) { if (typeof h !== 'string' || h[0] !== '#') return '#000000'; var x = h.slice(1); if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2]; return '#' + x.slice(0, 6); }

  // transformable parts (humanoid): label + which sliders apply.
  var TF_OBJ = { head: ['Head', 's'], hair: ['Hair', 'xysr'], eyebrows: ['Brows', 'xysr'], eyes: ['Eyes', 'xysr'], mouth: ['Mouth', 'xysr'], beard: ['Beard', 'xysr'], hat: ['Hat', 'xysr'], accessory: ['Acc.', 'xysr'] };
  var TF_ORDER = ['head', 'hair', 'eyebrows', 'eyes', 'mouth', 'beard', 'hat', 'accessory'];
  var PRESETS_KEY = 'clobi.presets';

  var root, built = false, canvas, ctx, box, nameInput, tabbarEl, panelEl, hintEl, bodyToggleEl, zoomSlider, adjBody, presetSel;
  var character = null, facing = 1, zoom = 1.0, animFrame = 0, rafId = null;
  var activeTab = 'body', tfSel = null, dragging = false, dragStart = null, lastClick = null;
  var mapCx = 0, mapCy = 0, mapS = 1;
  var styleEls = {};

  function GWg() { var T = TX(); return (T && T.grid && T.grid().w) || 64; }
  function GHg() { var T = TX(); return (T && T.grid && T.grid().h) || 72; }

  // ---- skeleton -----------------------------------------------------------
  function build() {
    root = document.getElementById('screen-editor');
    if (!root) { root = el('section'); root.id = 'screen-editor'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = ''; injectStyle();
    var wrap = el('div', 'ed2-wrap');

    var head = el('div', 'ed2-head');
    head.appendChild(el('div', 'ed2-title', t('editor.title', 'Character Editor')));
    head.appendChild(buildBodyToggle());
    wrap.appendChild(head);

    var stage = el('div', 'ed2-stage');
    var left = el('div', 'ed2-left');
    box = el('div', 'ed2-pbox'); canvas = el('canvas', 'ed2-canvas'); box.appendChild(canvas); left.appendChild(box);
    hintEl = el('div', 'ed2-hint', ''); left.appendChild(hintEl);
    left.appendChild(buildZoomRow());
    stage.appendChild(left);

    var right = el('div', 'ed2-right');
    nameInput = el('input', 'ed2-name'); nameInput.type = 'text'; nameInput.maxLength = 16; nameInput.spellcheck = false;
    nameInput.placeholder = t('editor.namePh', 'NAME');
    nameInput.addEventListener('input', function () { if (character) character.name = nameInput.value; });
    right.appendChild(nameInput);
    tabbarEl = el('div', 'ed2-tabbar'); right.appendChild(tabbarEl);
    panelEl = el('div', 'ed2-panel'); right.appendChild(panelEl);
    stage.appendChild(right);
    wrap.appendChild(stage);

    var actions = el('div', 'ed2-actions');
    actions.appendChild(actBtn('editor.random', 'Randomize', onRandom));
    actions.appendChild(actBtn('editor.reset', 'Reset', onReset));
    var sv = actBtn('editor.save', 'Save', onSave); sv.classList.add('ed2-primary'); actions.appendChild(sv);
    actions.appendChild(actBtn('common.back', 'Back', onBack));
    wrap.appendChild(actions);
    var st = el('div', 'ed2-status'); st.id = 'ed-status'; wrap.appendChild(st);

    root.appendChild(wrap);
    if (canvas.getContext) ctx = canvas.getContext('2d');
    wireCanvas();
    if (window.addEventListener) window.addEventListener('resize', resizeCanvas);
    if (TX() && TX().onReady) TX().onReady(function () { if (built && character) buildTabs(); });
    built = true;
  }
  function actBtn(k, en, fn) { var b = el('button', 'ed2-btn', t(k, en)); b.type = 'button'; b.addEventListener('click', fn); return b; }

  function buildBodyToggle() {
    bodyToggleEl = el('div', 'ed2-seg');
    ['tux', 'humanoid'].forEach(function (bt) {
      var b = el('button', 'ed2-segbtn', t('editor.' + bt, bt === 'tux' ? 'Tux' : 'Humanoid')); b.type = 'button'; b.dataset.bt = bt;
      b.addEventListener('click', function () { if (character.bodyType !== bt) { character.bodyType = bt; tfSel = null; ensureTab(); buildTabs(); } });
      bodyToggleEl.appendChild(b);
    });
    return bodyToggleEl;
  }
  function syncBodyToggle() { if (!bodyToggleEl) return; var cur = character.bodyType === 'humanoid' ? 'humanoid' : 'tux'; Array.prototype.forEach.call(bodyToggleEl.children, function (b) { b.classList.toggle('active', b.dataset.bt === cur); }); }

  function buildZoomRow() {
    var zr = el('div', 'ed2-zoom');
    var zo = el('button', 'ed2-zbtn', '−'); zo.type = 'button'; zo.addEventListener('click', function () { setZoom(zoom - 0.2); });
    zoomSlider = el('input', 'ed2-slider'); zoomSlider.type = 'range'; zoomSlider.min = '0.6'; zoomSlider.max = '3'; zoomSlider.step = '0.05'; zoomSlider.value = String(zoom);
    zoomSlider.addEventListener('input', function () { setZoom(+zoomSlider.value, true); });
    var zi = el('button', 'ed2-zbtn', '+'); zi.type = 'button'; zi.addEventListener('click', function () { setZoom(zoom + 0.2); });
    var fl = el('button', 'ed2-zbtn', '⇄'); fl.type = 'button'; fl.title = t('editor.flip', 'Flip'); fl.addEventListener('click', function () { facing = -facing; });
    zr.appendChild(el('span', 'ed2-zlbl', t('editor.zoom', 'Zoom'))); zr.appendChild(zo); zr.appendChild(zoomSlider); zr.appendChild(zi); zr.appendChild(fl);
    return zr;
  }
  function setZoom(z, fromS) { zoom = clampN(z, 0.6, 3); if (zoomSlider && !fromS) zoomSlider.value = String(zoom); }

  // ---- tabs ---------------------------------------------------------------
  function tabsFor(bt) { return bt === 'humanoid' ? [['body', 'Body'], ['face', 'Face'], ['hair', 'Hair'], ['wear', 'Wear'], ['adjust', 'Adjust'], ['saves', 'Saves']] : [['body', 'Body'], ['wear', 'Wear'], ['saves', 'Saves']]; }
  function ensureTab() { var ids = tabsFor(character.bodyType).map(function (x) { return x[0]; }); if (ids.indexOf(activeTab) < 0) activeTab = 'body'; }
  function buildTabs() {
    ensureTab(); tabbarEl.innerHTML = '';
    tabsFor(character.bodyType).forEach(function (tb) {
      var b = el('button', 'ed2-tab', t('editor.tab.' + tb[0], tb[1])); b.type = 'button'; b.dataset.tab = tb[0];
      b.addEventListener('click', function () { activeTab = tb[0]; syncTabs(); buildPanel(); });
      tabbarEl.appendChild(b);
    });
    if (nameInput) nameInput.value = character.name || '';
    syncTabs(); syncBodyToggle(); buildPanel();
  }
  function syncTabs() { Array.prototype.forEach.call(tabbarEl.children, function (b) { b.classList.toggle('active', b.dataset.tab === activeTab); }); }

  function buildPanel() {
    panelEl.innerHTML = ''; styleEls = {};
    var bt = character.bodyType === 'humanoid' ? 'humanoid' : 'tux';
    if (activeTab === 'body') buildBody(bt);
    else if (activeTab === 'face') buildFace();
    else if (activeTab === 'hair') buildHair();
    else if (activeTab === 'wear') buildWear(bt);
    else if (activeTab === 'adjust') buildAdjust();
    else if (activeTab === 'saves') buildSaves();
  }

  // ---- controls -----------------------------------------------------------
  function styleRow(field, catKey) {
    var row = el('div', 'ed2-pick');
    var prev = el('button', 'ed2-arrow', '‹'); prev.type = 'button'; prev.addEventListener('click', function () { cycle(field, catKey, -1); });
    var val = el('div', 'ed2-pickval'); var span = el('span', null, '');
    val.appendChild(span);
    var next = el('button', 'ed2-arrow', '›'); next.type = 'button'; next.addEventListener('click', function () { cycle(field, catKey, 1); });
    row.appendChild(prev); row.appendChild(val); row.appendChild(next);
    function upd() { var a = catalog(catKey), it = a[character[field] | 0]; span.textContent = String((it && it.name) || (((character[field] | 0) === 0) ? t('editor.none', 'None') : '#' + (character[field] | 0))).toUpperCase(); }
    upd(); styleEls[field] = upd; return row;
  }
  function cycle(field, catKey, dir) { var len = catalog(catKey).length; if (!len) return; character[field] = (((character[field] | 0) + dir) % len + len) % len; if (styleEls[field]) styleEls[field](); }

  function colorRow(field, presetKey, auto) {
    var row = el('div', 'ed2-colors');
    var chip = el('span', 'ed2-chip');
    function setChip() { var v = character[field]; if (auto && (!v || v === '')) { chip.classList.add('ed2-auto'); chip.style.background = ''; } else { chip.classList.remove('ed2-auto'); chip.style.background = toHex6(v); } if (picker && v) picker.value = toHex6(v); }
    row.appendChild(chip);
    var sw = el('div', 'ed2-sw');
    if (auto) { var ab = el('button', 'ed2-auto-btn', t('editor.auto', 'AUTO')); ab.type = 'button'; ab.title = t('editor.autoSkin', 'Match skin'); ab.addEventListener('click', function () { character[field] = ''; setChip(); }); sw.appendChild(ab); }
    presetsFor(presetKey).forEach(function (hex) { var s = el('button', 'ed2-swatch'); s.type = 'button'; s.style.background = hex; s.title = hex; s.addEventListener('click', function () { character[field] = hex; setChip(); }); sw.appendChild(s); });
    row.appendChild(sw);
    var custom = el('label', 'ed2-custom'); custom.title = t('editor.pickColor', 'Pick any colour'); custom.appendChild(el('span', 'ed2-custico', '🎨'));
    var picker = el('input', 'ed2-picker'); picker.type = 'color'; picker.value = toHex6(character[field] || '#888888');
    picker.addEventListener('input', function () { character[field] = picker.value; setChip(); }); custom.appendChild(picker);
    row.appendChild(custom);
    setChip(); return row;
  }
  function card(label, opts) {
    var c = el('div', 'ed2-card'); c.appendChild(el('div', 'ed2-cardlbl', label));
    if (opts.style) c.appendChild(styleRow(opts.style[0], opts.style[1]));
    if (opts.color) c.appendChild(colorRow(opts.color[0], opts.color[1], opts.color[2]));
    return c;
  }
  function segCard(label, field, opts) {
    var c = el('div', 'ed2-card'); c.appendChild(el('div', 'ed2-cardlbl', label));
    var seg = el('div', 'ed2-seg');
    opts.forEach(function (o) { var b = el('button', 'ed2-segbtn', t(o[1], o[2])); b.type = 'button'; b.dataset.v = o[0]; b.addEventListener('click', function () { character[field] = o[0]; Array.prototype.forEach.call(seg.children, function (x) { x.classList.toggle('active', x.dataset.v === character[field]); }); }); seg.appendChild(b); });
    Array.prototype.forEach.call(seg.children, function (x) { x.classList.toggle('active', x.dataset.v === character[field]); });
    c.appendChild(seg); return c;
  }
  function sliderCard(label, field, min, max, step, lo, hi) {
    var c = el('div', 'ed2-card'); c.appendChild(el('div', 'ed2-cardlbl', label));
    var r = el('div', 'ed2-sl'); r.appendChild(el('span', 'ed2-slend', lo));
    var sl = el('input', 'ed2-slider'); sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.step = String(step); sl.value = String(character[field] || 0);
    sl.addEventListener('input', function () { character[field] = +sl.value; });
    r.appendChild(sl); r.appendChild(el('span', 'ed2-slend', hi)); c.appendChild(r); return c;
  }

  // ---- tab content --------------------------------------------------------
  function buildBody(bt) {
    if (bt === 'humanoid') {
      panelEl.appendChild(segCard(t('editor.gender', 'Gender'), 'gender', [['male', 'editor.male', 'Male'], ['female', 'editor.female', 'Female']]));
      panelEl.appendChild(sliderCard(t('editor.build', 'Build'), 'fat', 0, 1, 0.05, t('editor.thin', 'Thin'), t('editor.fat', 'Fat')));
      panelEl.appendChild(card(t('editor.skin', 'Skin'), { color: ['skin', 'skin'] }));
    } else {
      panelEl.appendChild(card(t('editor.body', 'Body'), { color: ['body', 'body'] }));
      panelEl.appendChild(card(t('editor.belly', 'Belly'), { color: ['belly', 'belly'] }));
      panelEl.appendChild(card(t('editor.feet', 'Feet'), { color: ['feet', 'feet'] }));
    }
  }
  function buildFace() {
    panelEl.appendChild(card(t('editor.eyes', 'Eyes'), { style: ['eyes', 'eyes'], color: ['irisColor', 'iris'] }));
    panelEl.appendChild(card(t('editor.eyebrows', 'Eyebrows'), { style: ['eyebrows', 'eyebrows'] }));
    panelEl.appendChild(card(t('editor.mouth', 'Mouth'), { style: ['mouth', 'mouth'], color: ['mouthColor', 'mouth', true] }));
    panelEl.appendChild(card(t('editor.beard', 'Beard'), { style: ['beard', 'beard'], color: ['beardColor', 'beard'] }));
  }
  function buildHair() { panelEl.appendChild(card(t('editor.hairstyle', 'Hairstyle'), { style: ['hair', 'hair'], color: ['hairColor', 'hair'] })); }
  function buildWear(bt) {
    if (bt === 'humanoid') {
      panelEl.appendChild(card(t('editor.shirt', 'Shirt'), { style: ['shirtStyle', 'shirt'], color: ['belly', 'shirt'] }));
      panelEl.appendChild(card(t('editor.pants', 'Pants'), { style: ['pantsStyle', 'pants'], color: ['pants', 'pants'] }));
      panelEl.appendChild(card(t('editor.shoes', 'Shoes'), { style: ['shoeStyle', 'shoes'], color: ['feet', 'feet'] }));
      panelEl.appendChild(card(t('editor.hat', 'Hat'), { style: ['hat', 'hat'] }));
      panelEl.appendChild(card(t('editor.accessory', 'Accessory'), { style: ['accessory', 'accessory'] }));
      panelEl.appendChild(card(t('editor.cape', 'Cape'), { style: ['cape', 'cape'], color: ['capeColor', 'cape'] }));
    } else {
      panelEl.appendChild(card(t('editor.hat', 'Hat'), { style: ['hat', 'hat'] }));
      panelEl.appendChild(card(t('editor.accessory', 'Accessory'), { style: ['accessory', 'accessory'] }));
      panelEl.appendChild(card(t('editor.eyes', 'Eyes'), { style: ['eyes', 'eyes'] }));
      panelEl.appendChild(card(t('editor.cape', 'Cape'), { style: ['cape', 'cape'], color: ['capeColor', 'cape'] }));
    }
  }
  function buildAdjust() {
    panelEl.appendChild(el('div', 'ed2-note', t('editor.adjustHint', 'Click a part on the preview, then drag to move, wheel to resize, Shift+wheel to rotate. Click again to pick the part underneath.')));
    var sel = el('div', 'ed2-objsel');
    TF_ORDER.forEach(function (k) { var b = el('button', 'ed2-objtab', t('editor.obj.' + k, TF_OBJ[k][0])); b.type = 'button'; b.dataset.k = k; b.addEventListener('click', function () { tfSel = k; updateHint(); renderAdj(); }); sel.appendChild(b); });
    panelEl.appendChild(sel);
    adjBody = el('div', 'ed2-adjbody'); panelEl.appendChild(adjBody);
    if (!tfSel) tfSel = 'head'; renderAdj();
  }
  function renderAdj() {
    if (!adjBody) return; adjBody.innerHTML = '';
    var sel = panelEl.querySelector('.ed2-objsel'); if (sel) Array.prototype.forEach.call(sel.children, function (b) { b.classList.toggle('active', b.dataset.k === tfSel); });
    var which = (TF_OBJ[tfSel] || ['', ''])[1];
    adjBody.appendChild(tfSlider(t('editor.size', 'Size'), 's', 0.4, 2.2, 0.05));
    if (which.indexOf('x') >= 0) {
      adjBody.appendChild(tfSlider(t('editor.moveX', 'Move X'), 'x', -16, 16, 1));
      adjBody.appendChild(tfSlider(t('editor.moveY', 'Move Y'), 'y', -16, 16, 1));
      adjBody.appendChild(tfSlider(t('editor.rotate', 'Rotate'), 'r', -180, 180, 5));
    }
    var rb = el('button', 'ed2-mini', t('editor.resetObj', 'Reset part')); rb.type = 'button'; rb.addEventListener('click', function () { if (character.tf) delete character.tf[tfSel]; renderAdj(); }); adjBody.appendChild(rb);
  }
  function getTf(k) { var x = (character.tf && character.tf[k]) || null; return { x: (x && x.x) || 0, y: (x && x.y) || 0, s: (x && x.s) || 1, r: (x && x.r) || 0 }; }
  function setTf(k, p, v) { if (!character.tf) character.tf = {}; var x = character.tf[k] || { x: 0, y: 0, s: 1, r: 0 }; x[p] = v; character.tf[k] = x; }
  function tfSlider(label, prop, min, max, step) {
    var r = el('div', 'ed2-sl'); r.appendChild(el('span', 'ed2-sllbl', label));
    var sl = el('input', 'ed2-slider'); sl.type = 'range'; sl.min = String(min); sl.max = String(max); sl.step = String(step); sl.value = String(getTf(tfSel)[prop]); sl.dataset.prop = prop;
    sl.addEventListener('input', function () { setTf(tfSel, prop, +sl.value); }); r.appendChild(sl); return r;
  }
  function refreshAdjSliders() { if (activeTab !== 'adjust' || !adjBody) return; Array.prototype.forEach.call(adjBody.querySelectorAll('input[data-prop]'), function (sl) { sl.value = String(getTf(tfSel)[sl.dataset.prop]); }); }

  // ---- presets ----
  function readPresets() { try { return JSON.parse(window.localStorage.getItem(PRESETS_KEY)) || []; } catch (e) { return []; } }
  function writePresets(a) { try { window.localStorage.setItem(PRESETS_KEY, JSON.stringify(a)); } catch (e) { } }
  function buildSaves() {
    panelEl.appendChild(el('div', 'ed2-cardlbl', t('editor.presets', 'Presets')));
    presetSel = el('select', 'ed2-select'); refreshPresets(); panelEl.appendChild(presetSel);
    var row = el('div', 'ed2-saverow');
    row.appendChild(mini(t('editor.load', 'Load'), onLoadPreset));
    row.appendChild(mini(t('editor.savePreset', 'Save'), onSavePreset));
    row.appendChild(mini(t('editor.delete', 'Delete'), onDelPreset));
    panelEl.appendChild(row);
  }
  function mini(label, fn) { var b = el('button', 'ed2-mini', label); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function refreshPresets() { if (!presetSel) return; presetSel.innerHTML = ''; var list = readPresets(); if (!list.length) { var o = el('option', null, t('editor.noPresets', '— none —')); o.value = ''; presetSel.appendChild(o); return; } list.forEach(function (p, i) { var o = el('option', null, p.name || ('#' + i)); o.value = String(i); presetSel.appendChild(o); }); }
  function onSavePreset() { var nm = window.prompt(t('editor.presetName', 'Preset name:'), character.name || 'Preset'); if (nm == null) return; var list = readPresets(); list.push({ name: String(nm).trim() || 'Preset', ch: sanitize(character) }); writePresets(list); refreshPresets(); setStatus('editor.presetSaved', 'Preset saved.'); }
  function onLoadPreset() { var i = presetSel && presetSel.value; if (i === '' || i == null) return; var p = readPresets()[+i]; if (!p) return; var keep = character.name; character = sanitize(p.ch); if (!character.name) character.name = keep; buildTabs(); setStatus('editor.presetLoaded', 'Preset loaded.'); }
  function onDelPreset() { var i = presetSel && presetSel.value; if (i === '' || i == null) return; var list = readPresets(); list.splice(+i, 1); writePresets(list); refreshPresets(); setStatus('editor.presetDeleted', 'Preset deleted.'); }

  // ---- preview + direct manipulation -------------------------------------
  function resizeCanvas() { if (!canvas) return; var b = canvas.parentElement; if (!b) return; var w = Math.max(120, b.clientWidth), h = Math.max(120, b.clientHeight); canvas.width = w; canvas.height = h; }
  function drawPreview() {
    if (!ctx) return; var w = canvas.width, h = canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#12151f'; ctx.fillRect(0, 0, w, h);
    var tile = 22; for (var gy = 0; gy < h; gy += tile) for (var gx = 0; gx < w; gx += tile) if ((((gx / tile) + (gy / tile)) & 1) === 0) { ctx.fillStyle = '#171b29'; ctx.fillRect(gx, gy, tile, tile); }
    var baseScale = (h * 0.52) / 18, scale = baseScale * zoom, cy = h * 0.5, bob = Math.sin(animFrame / 22) * 1.5;
    mapS = scale * 16 / GWg(); mapCx = w / 2; mapCy = cy;
    ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.beginPath(); ctx.ellipse(w / 2, cy + 9 * scale, scale * 9, scale * 9 * 0.28, 0, 0, 7); ctx.fill();
    var s = S(); if (s && s.drawCharacter && character) s.drawCharacter(ctx, character, Math.round(w / 2), Math.round(cy + bob), scale, facing);
    drawSelBox();
  }
  function drawSelBox() {
    if (!tfSel || !TX() || !TX().partBox || !character || character.bodyType !== 'humanoid') return;
    var pb = TX().partBox(character, tfSel); if (!pb) return;
    var sx = mapCx + facing * (pb.cx - GWg() / 2) * mapS, sy = mapCy + (pb.cy - GHg() / 2) * mapS;
    var hw = pb.hw * mapS + 3, hh = pb.hh * mapS + 3;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(facing * (pb.r || 0) * Math.PI / 180);
    ctx.strokeStyle = '#7ff9e0'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.setLineDash([]); ctx.fillStyle = '#7ff9e0';[[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].forEach(function (c) { ctx.fillRect(c[0] - 2, c[1] - 2, 4, 4); });
    ctx.restore();
  }
  function evtGrid(e) { var r = canvas.getBoundingClientRect(); var px = (e.clientX - r.left) * (canvas.width / r.width), py = (e.clientY - r.top) * (canvas.height / r.height); return { gx: GWg() / 2 + facing * (px - mapCx) / mapS, gy: GHg() / 2 + (py - mapCy) / mapS }; }
  function wireCanvas() {
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    box.addEventListener('wheel', onWheel, { passive: false });
  }
  function onDown(e) {
    if (!character || character.bodyType !== 'humanoid' || !TX() || !TX().partAt) return;
    var g = evtGrid(e);
    var same = lastClick && Math.abs(lastClick.gx - g.gx) < 2.5 && Math.abs(lastClick.gy - g.gy) < 2.5;
    var key = TX().partAt(character, g.gx, g.gy, same ? tfSel : null);
    if (key) { tfSel = key; lastClick = { gx: g.gx, gy: g.gy }; dragging = true; var tv = getTf(key); dragStart = { gx: g.gx, gy: g.gy, x: tv.x, y: tv.y }; updateHint(); if (activeTab === 'adjust') renderAdj(); if (e.preventDefault) e.preventDefault(); }
    else { tfSel = null; lastClick = null; updateHint(); }
  }
  function onMove(e) {
    if (!dragging) return; var g = evtGrid(e);
    if (tfSel !== 'head') { setTf(tfSel, 'x', clampN(dragStart.x + (g.gx - dragStart.gx), -24, 24)); setTf(tfSel, 'y', clampN(dragStart.y + (g.gy - dragStart.gy), -24, 24)); lastClick = null; }
  }
  function onUp() { if (dragging) { dragging = false; refreshAdjSliders(); } }
  function onWheel(e) {
    if (tfSel) {
      e.preventDefault(); var tv = getTf(tfSel);
      if (e.shiftKey && tfSel !== 'head') setTf(tfSel, 'r', clampN((tv.r || 0) + (e.deltaY < 0 ? 6 : -6), -180, 180));
      else setTf(tfSel, 's', clampN((tv.s || 1) * (e.deltaY < 0 ? 1.08 : 0.926), 0.4, 2.5));
      refreshAdjSliders();
    } else { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.15 : -0.15)); }
  }
  function updateHint() {
    if (!hintEl) return;
    if (character && character.bodyType !== 'humanoid') { hintEl.textContent = t('editor.tuxHint', 'Wheel = zoom'); return; }
    if (tfSel) hintEl.textContent = (t('editor.selected', 'Selected') + ': ' + ((TF_OBJ[tfSel] && TF_OBJ[tfSel][0]) || tfSel) + ' — ' + t('editor.dragHint', 'drag · wheel · shift+wheel'));
    else hintEl.textContent = t('editor.clickHint', 'Click a part to move/resize · wheel = zoom');
  }

  function loop() { animFrame++; drawPreview(); rafId = window.requestAnimationFrame(loop); }
  function startLoop() { if (rafId == null) rafId = window.requestAnimationFrame(loop); }
  function stopLoop() { if (rafId != null) { window.cancelAnimationFrame(rafId); rafId = null; } }

  // ---- actions ----
  function onRandom() { var s = S(); var keep = character ? character.name : ''; character = sanitize(s && s.randomCharacter ? s.randomCharacter() : {}); if (!character.name) character.name = keep; tfSel = null; buildTabs(); setStatus('editor.randomized', 'Randomized.'); }
  function onReset() { var keep = character ? character.name : ''; character = sanitize(defaultCharacter()); if (keep) character.name = keep; tfSel = null; buildTabs(); setStatus('editor.resetDone', 'Reset to default.'); }
  function onSave() {
    var nm = (nameInput && nameInput.value != null) ? nameInput.value.trim() : (character.name || ''); character.name = nm;
    var saved = sanitize(character); saved.name = nm; character = clone(saved); var payload = clone(saved);
    if (window.App && App.updateCharacter) App.updateCharacter(payload); else if (window.App) App.character = payload;
    if (window.Store && Store.setCharacter) Store.setCharacter(payload);
    var synced = false;
    if (window.Store && Store.isLoggedIn && Store.isLoggedIn() && Store.saveCharacterRemote) { synced = true; try { var p = Store.saveCharacterRemote(payload); if (p && p.then) { p.then(function () { setStatus('editor.savedSynced', 'Saved and synced to your account.'); }).catch(function () { setStatus('editor.savedLocal', 'Saved locally (sync failed).'); }); } } catch (e) { synced = false; } }
    if (!synced) setStatus('editor.saved', 'Saved!');
    showMenu();
  }
  function onBack() { showMenu(); }
  function showMenu() { stopLoop(); if (window.App && App.showScreen) App.showScreen('menu'); else if (window.Menu && Menu.show) Menu.show(); }
  function setStatus(k, en) { var s = document.getElementById('ed-status'); if (s) s.textContent = k ? t(k, en) : ''; }

  // ---- public -------------------------------------------------------------
  function show() {
    if (!built) build();
    var src = (window.App && App.character) ? App.character : null;
    character = sanitize(src || defaultCharacter());
    if (!character.name && window.App && App.nickname) character.name = String(App.nickname).slice(0, 16);
    facing = 1; tfSel = null; ensureTab(); buildTabs();
    if (window.App && App.showScreen) App.showScreen('editor'); else if (root) root.classList.add('active');
    resizeCanvas(); updateHint(); drawPreview(); startLoop();
    if (window.requestAnimationFrame) window.requestAnimationFrame(resizeCanvas);
  }
  function hide() { stopLoop(); if (root && !(window.App && App.showScreen)) root.classList.remove('active'); }

  function injectStyle() {
    if (document.getElementById('editor-style')) return;
    var css = [
      '#screen-editor{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e7ecff;background:#0e111b;}',
      '#screen-editor *{box-sizing:border-box;}',
      '.ed2-wrap{height:100%;display:flex;flex-direction:column;padding:10px 14px;gap:8px;}',
      '.ed2-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}',
      '.ed2-title{font-size:15px;color:#7ff9e0;text-shadow:2px 2px 0 #000;}',
      '.ed2-seg{display:flex;border:2px solid #0a0c14;border-radius:6px;overflow:hidden;background:#0a0c14;}',
      '.ed2-segbtn{font-family:inherit;font-size:9px;color:#aab3cc;background:#171c2b;border:0;padding:8px 13px;cursor:pointer;}',
      '.ed2-segbtn.active{background:#7ff9e0;color:#0e111b;}',
      '.ed2-stage{flex:1 1 auto;display:flex;gap:14px;min-height:0;overflow:hidden;}',
      '.ed2-left{flex:1 1 50%;display:flex;flex-direction:column;gap:7px;min-width:230px;min-height:0;}',
      '.ed2-pbox{flex:1 1 auto;background:#12151f;border:2px solid #2a3350;border-radius:8px;min-height:140px;overflow:hidden;position:relative;cursor:crosshair;}',
      '.ed2-canvas{display:block;width:100%;height:100%;image-rendering:pixelated;}',
      '.ed2-hint{font-size:8px;color:#7ff9e0;min-height:11px;text-align:center;}',
      '.ed2-zoom{display:flex;align-items:center;gap:7px;}',
      '.ed2-zlbl{font-size:8px;color:#8a93ad;}',
      '.ed2-zbtn{font-family:inherit;font-size:12px;color:#0e111b;background:#7ff9e0;border:0;border-radius:5px;width:30px;height:28px;cursor:pointer;}',
      '.ed2-zbtn:hover{background:#aef6e8;}',
      '.ed2-right{flex:1 1 50%;max-width:50%;display:flex;flex-direction:column;gap:8px;min-width:300px;min-height:0;overflow:hidden;}',
      '.ed2-name{font-family:inherit;font-size:11px;color:#0e111b;background:#e7ecff;border:0;border-radius:6px;padding:9px;text-transform:uppercase;}',
      '.ed2-tabbar{display:flex;flex-wrap:wrap;gap:4px;}',
      '.ed2-tab{font-family:inherit;font-size:9px;color:#aab3cc;background:#171c2b;border:0;border-radius:6px;padding:8px 10px;cursor:pointer;}',
      '.ed2-tab.active{background:#ff9e2c;color:#0e111b;}',
      '.ed2-panel{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:8px;padding-right:4px;}',
      '.ed2-card{background:#141826;border:1px solid #232a40;border-radius:8px;padding:8px 9px;display:flex;flex-direction:column;gap:7px;}',
      '.ed2-cardlbl{font-size:9px;color:#ff9e2c;text-shadow:1px 1px 0 #000;}',
      '.ed2-note{font-size:8px;color:#aab3cc;line-height:1.5;background:#141826;border:1px solid #232a40;border-radius:8px;padding:8px;}',
      '.ed2-pick{display:flex;align-items:center;gap:6px;}',
      '.ed2-arrow{font-family:inherit;font-size:13px;color:#0e111b;background:#7ff9e0;border:0;border-radius:5px;width:28px;height:28px;cursor:pointer;flex:0 0 auto;}',
      '.ed2-arrow:hover{background:#aef6e8;}',
      '.ed2-pickval{flex:1 1 auto;font-size:9px;color:#7ff9e0;background:#0c0f18;border-radius:5px;padding:8px 6px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ed2-colors{display:flex;align-items:center;gap:6px;}',
      '.ed2-chip{flex:0 0 auto;width:20px;height:20px;border-radius:4px;border:2px solid #0a0c14;}',
      '.ed2-chip.ed2-auto{background:repeating-conic-gradient(#888 0% 25%,#bbb 0% 50%) 50%/8px 8px;}',
      '.ed2-sw{flex:1 1 auto;display:flex;flex-wrap:wrap;gap:4px;}',
      '.ed2-swatch{width:18px;height:18px;border:1px solid #0a0c14;border-radius:3px;padding:0;cursor:pointer;}',
      '.ed2-swatch:hover{outline:2px solid #fff;outline-offset:-1px;}',
      '.ed2-auto-btn{font-family:inherit;font-size:7px;color:#0e111b;background:#cfe9ff;border:0;border-radius:3px;padding:0 4px;cursor:pointer;}',
      '.ed2-custom{flex:0 0 auto;position:relative;display:flex;align-items:center;justify-content:center;width:30px;height:24px;border-radius:5px;cursor:pointer;background:conic-gradient(from 0deg,#ff5a3c,#ffcf3c,#9cff5a,#7ff9e0,#2b5fff,#7a52d0,#ff5aa0,#ff5a3c);}',
      '.ed2-custico{font-size:10px;filter:drop-shadow(0 1px 0 #000);}',
      '.ed2-picker{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:0;padding:0;}',
      '.ed2-sl{display:flex;align-items:center;gap:7px;}',
      '.ed2-sllbl{flex:0 0 56px;font-size:8px;color:#cfd4e8;}',
      '.ed2-slend{font-size:7px;color:#8a93ad;}',
      '.ed2-slider{flex:1 1 auto;accent-color:#7ff9e0;}',
      '.ed2-objsel{display:flex;flex-wrap:wrap;gap:4px;}',
      '.ed2-objtab{font-family:inherit;font-size:8px;color:#aab3cc;background:#171c2b;border:0;border-radius:5px;padding:7px 8px;cursor:pointer;}',
      '.ed2-objtab.active{background:#7ff9e0;color:#0e111b;}',
      '.ed2-adjbody{display:flex;flex-direction:column;gap:7px;background:#141826;border:1px solid #232a40;border-radius:8px;padding:8px;}',
      '.ed2-select{font-family:inherit;font-size:9px;color:#0e111b;background:#e7ecff;border:0;border-radius:6px;padding:7px;}',
      '.ed2-saverow{display:flex;gap:6px;}',
      '.ed2-mini{font-family:inherit;font-size:8px;color:#0e111b;background:#ff9e2c;border:0;border-radius:5px;padding:7px 9px;cursor:pointer;flex:1 1 auto;}',
      '.ed2-mini:hover{filter:brightness(1.1);}',
      '.ed2-actions{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;}',
      '.ed2-btn{font-family:inherit;font-size:10px;color:#e7ecff;background:#222a40;border:0;border-radius:7px;padding:11px 15px;cursor:pointer;}',
      '.ed2-btn:hover{background:#2c3656;}',
      '.ed2-primary{background:#ff9e2c;color:#0e111b;}',
      '.ed2-primary:hover{filter:brightness(1.08);background:#ff9e2c;}',
      '.ed2-status{text-align:center;font-size:8px;color:#7ff9e0;min-height:10px;}',
      '@media(max-width:620px){.ed2-stage{flex-direction:column;overflow:auto;}.ed2-right{max-width:none;flex:1 1 auto;overflow:visible;}.ed2-left{flex:0 0 auto;min-height:200px;}}'
    ].join('');
    var st = el('style'); st.id = 'editor-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Editor = { show: show, hide: hide, open: show, close: hide };
})();
