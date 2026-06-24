// paint.js — the Paint Studio (Create screen). Single global: window.Paint.
//
// Paint your OWN cosmetic textures and wear them. The studio holds a SEPARATE
// working texture PER PART, so you can paint a shirt, switch to the hat, come
// back — nothing is lost. When you Save or Publish you pick exactly which parts
// to commit. Each texture is a GW×GH grid with three channels:
//   - VALUE  : a grayscale shade, tinted at wear-time by the wearer's color
//   - ALPHA  : transparency / translucency
//   - GLOW   : pixels painted in the glow color; flat in the editor, they only
//              emit a pixelated glow WHEN RENDERED on a model.
// The tint color is PREVIEW-ONLY — it never bakes into the (grayscale) texture.
//
// Modes share one canonical grid: "On model" (default) paints on the live
// character (showing every part you've worked on); "Raw" paints the flat grid.
//
// Depends on globals: Textures, Sprites, Store, App, I18n (and optionally Market, Menu).
(function () {
  'use strict';

  function TX() { return window.Textures || null; }
  function t(k, en) { return (window.I18n && I18n.t) ? I18n.t(k, en) : en; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function loggedIn() { return !!(window.Store && Store.isLoggedIn && Store.isLoggedIn()); }
  function GW() { var T = TX(); return (T && T.grid && T.grid().w) || 64; }
  function GH() { var T = TX(); return (T && T.grid && T.grid().h) || 72; }

  var SLOT_LABELS = { body: 'Body', belly: 'Belly', feet: 'Feet', shirt: 'Shirt', pants: 'Pants', shoes: 'Shoes', hair: 'Hair', beard: 'Beard', mouth: 'Mouth', eyes: 'Eyes', cape: 'Cape', hat: 'Hat', accessory: 'Accessory' };
  var CELL = 8;
  function tempId(s) { return '__pt_' + s; }

  // ---- state -------------------------------------------------------------
  var root, built = false, shown = false;
  var canvas, ctx, prevWrap, prevCanvas, prevCtx, rafId = null;
  var slotSel, statusEl, modeSeg, toolSeg, zoomSlider, basePicker, glowPicker;
  var gw, gh;
  var works = {};                 // slot -> { val, alpha, glow, base, glowC, history, hi, remixOf }
  var slot = 'shirt';
  var mode = 'model', tool = 'brush';
  var shade = 1.0, opacity = 1.0, brushSize = 2, zoom = 1.0;
  var glowOn = false, mirror = false, ghost = true;
  var painting = false, hoverGx = -1, hoverGy = -1;
  var previewChar = null, origTex = {};

  // ---- working textures (per part) ---------------------------------------
  function newWork() { var n = gw * gh; return { val: new Uint8Array(n), alpha: new Uint8Array(n), glow: new Uint8Array(n), base: '#7ff9e0', glowC: '#5dff8f', history: [], hi: -1, remixOf: '' }; }
  function W() { if (!works[slot]) works[slot] = newWork(); return works[slot]; }
  function hasContent(s) { var w = works[s]; if (!w) return false; for (var i = 0; i < w.alpha.length; i++) if (w.alpha[i] || w.glow[i]) return true; return false; }

  function packWork(w) { var n = gw * gh, d = new Uint8ClampedArray(n * 4); for (var i = 0; i < n; i++) { var p = i * 4; d[p] = w.val[i]; d[p + 1] = w.glow[i]; d[p + 2] = 0; d[p + 3] = w.alpha[i]; } return d; }
  function packPNG(w) { var c = document.createElement('canvas'); c.width = gw; c.height = gh; var cx = c.getContext('2d'); var img = cx.createImageData(gw, gh); img.data.set(packWork(w)); cx.putImageData(img, 0, 0); return c.toDataURL('image/png'); }
  function loadInto(w, dataUrl) {
    return new Promise(function (res) {
      if (!dataUrl) { res(false); return; }
      var img = new Image();
      img.onload = function () { var c = document.createElement('canvas'); c.width = gw; c.height = gh; var cx = c.getContext('2d'); cx.imageSmoothingEnabled = false; cx.drawImage(img, 0, 0, gw, gh); var d = cx.getImageData(0, 0, gw, gh).data; for (var i = 0; i < gw * gh; i++) { var p = i * 4; w.val[i] = d[p]; w.glow[i] = d[p + 1]; w.alpha[i] = d[p + 3]; } res(true); };
      img.onerror = function () { res(false); };
      img.src = dataUrl;
    });
  }
  function uid() { if (window.crypto && crypto.randomUUID) return 'tex_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16); return 'tex_' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36); }

  // Register the live preview textures for every worked (or active) slot, set
  // the preview character to wear them, and apply the PREVIEW-ONLY tints.
  function syncAll() {
    if (!previewChar) return;
    var T = TX();
    var defs = (T && T.paintSlots) ? T.paintSlots() : {};
    previewChar.tex = assign({}, origTex);
    Object.keys(works).forEach(function (s) {
      var on = hasContent(s) || s === slot;
      if (!on) { delete previewChar.tex[s]; return; }
      previewChar.tex[s] = tempId(s);
      if (T && T.registerCustom) T.registerCustom({ id: tempId(s), slot: s, glowColor: works[s].glowC, tintHint: works[s].base }, packWork(works[s]));
      var def = defs[s];
      if (def && def.tint) previewChar[def.tint] = works[s].base;   // preview tint only
    });
  }
  function syncActive() { var T = TX(); var w = W(); if (T && T.registerCustom) T.registerCustom({ id: tempId(slot), slot: slot, glowColor: w.glowC, tintHint: w.base }, packWork(w)); syncAll(); }

  // ---- DOM build ---------------------------------------------------------
  function build() {
    root = document.getElementById('screen-create');
    if (!root) { root = el('section'); root.id = 'screen-create'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = ''; injectStyle();
    var wrap = el('div', 'pt-wrap');

    var head = el('div', 'pt-head');
    head.appendChild(el('div', 'pt-title', t('paint.title', 'Paint Studio')));
    head.appendChild(el('div', 'pt-spacer'));
    slotSel = el('select', 'pt-select');
    slotSel.addEventListener('change', function () { switchSlot(slotSel.value); });
    head.appendChild(field(t('paint.slot', 'Part'), slotSel));
    modeSeg = seg([['model', t('paint.model', 'On model')], ['raw', t('paint.raw', 'Raw')]], function (m) { mode = m; syncMode(); render(); });
    head.appendChild(field(t('paint.mode', 'Mode'), modeSeg));
    wrap.appendChild(head);

    var stage = el('div', 'pt-stage');
    var left = el('div', 'pt-left');
    var box = el('div', 'pt-box'); canvas = el('canvas', 'pt-canvas'); box.appendChild(canvas); left.appendChild(box);
    // zoom row
    var zoomRow = el('div', 'pt-zoom');
    zoomRow.appendChild(el('span', 'pt-zlbl', t('paint.zoom', 'Zoom')));
    zoomRow.appendChild(zbtn('−', function () { setZoom(zoom - 0.25); }));
    zoomSlider = el('input', 'pt-zslider'); zoomSlider.type = 'range'; zoomSlider.min = '0.5'; zoomSlider.max = '5'; zoomSlider.step = '0.25'; zoomSlider.value = '1';
    zoomSlider.addEventListener('input', function () { setZoom(+zoomSlider.value); });
    zoomRow.appendChild(zoomSlider);
    zoomRow.appendChild(zbtn('+', function () { setZoom(zoom + 0.25); }));
    left.appendChild(zoomRow);
    var toggles = el('div', 'pt-toggles');
    toggles.appendChild(toggle(t('paint.mirror', 'Mirror'), function (on) { mirror = on; render(); }));
    toggles.appendChild(toggle(t('paint.ghost', 'Ghost'), function (on) { ghost = on; render(); }, true));
    left.appendChild(toggles);
    left.appendChild(el('div', 'pt-hint', t('paint.hint', 'Drag to paint. Texture stays grayscale; tint is preview-only. Glow lights up only on the model.')));
    stage.appendChild(left);

    var right = el('div', 'pt-right'); buildTools(right); stage.appendChild(right);
    wrap.appendChild(stage);

    var actions = el('div', 'pt-actions');
    actions.appendChild(actBtn(t('paint.undo', 'Undo'), 'pt-btn pt-icon', undo));
    actions.appendChild(actBtn(t('paint.redo', 'Redo'), 'pt-btn pt-icon', redo));
    actions.appendChild(actBtn(t('paint.clear', 'Clear part'), 'pt-btn', onClear));
    actions.appendChild(el('div', 'pt-spacer'));
    actions.appendChild(actBtn(t('common.back', 'Back'), 'pt-btn', onBack));
    actions.appendChild(actBtn(t('paint.publish', 'Publish…'), 'pt-btn pt-accent', function () { openCommit('publish'); }));
    actions.appendChild(actBtn(t('paint.save', 'Save & wear…'), 'pt-btn pt-primary', function () { openCommit('save'); }));
    wrap.appendChild(actions);
    statusEl = el('div', 'pt-status'); wrap.appendChild(statusEl);

    root.appendChild(wrap);
    ctx = canvas.getContext('2d');
    wireCanvas();
    window.addEventListener('resize', function () { if (shown) applyZoom(); });
    built = true;
  }

  function field(label, control) { var d = el('div', 'pt-field'); d.appendChild(el('span', 'pt-flbl', label)); d.appendChild(control); return d; }
  function actBtn(label, cls, fn) { var b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function zbtn(label, fn) { var b = el('button', 'pt-zbtn', label); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function seg(opts, fn) { var s = el('div', 'pt-seg'); opts.forEach(function (o) { var b = el('button', 'pt-segbtn', o[1]); b.type = 'button'; b.dataset.v = o[0]; b.addEventListener('click', function () { fn(o[0]); }); s.appendChild(b); }); return s; }
  function toggle(label, fn, on0) { var b = el('button', 'pt-toggle', label); b.type = 'button'; if (on0) b.classList.add('on'); b.dataset.on = on0 ? '1' : '0'; b.addEventListener('click', function () { var on = b.dataset.on === '0'; b.dataset.on = on ? '1' : '0'; b.classList.toggle('on', on); fn(on); }); return b; }

  function buildTools(right) {
    toolSeg = seg([['brush', t('paint.brush', 'Brush')], ['eraser', t('paint.eraser', 'Eraser')], ['fill', t('paint.fill', 'Fill')]], function (tt) { tool = tt; syncTool(); });
    right.appendChild(group(t('paint.tool', 'Tool'), [toolSeg]));

    var colRow = el('div', 'pt-row');
    basePicker = el('input'); basePicker.type = 'color'; basePicker.className = 'pt-color';
    basePicker.addEventListener('input', function () { W().base = basePicker.value; if (glowOn) setGlow(false); syncActive(); render(); });
    colRow.appendChild(basePicker);
    colRow.appendChild(labeledSlider(t('paint.shade', 'Shade'), mkSlider(0.1, 1, 0.02, shade, function (v) { shade = v; })));
    var g = group(t('paint.tint', 'Tint (preview)'), [colRow]);
    g.appendChild(el('div', 'pt-note', t('paint.tintNote', 'Preview only — the texture stays grayscale so wearers can recolor it.')));
    right.appendChild(g);

    var glowRow = el('div', 'pt-row');
    glowToggleBtn = el('button', 'pt-glowtoggle', t('paint.glowPaint', 'Paint glow')); glowToggleBtn.type = 'button';
    glowToggleBtn.addEventListener('click', function () { setGlow(!glowOn); });
    glowPicker = el('input'); glowPicker.type = 'color'; glowPicker.className = 'pt-color';
    glowPicker.addEventListener('input', function () { W().glowC = glowPicker.value; syncActive(); render(); });
    glowRow.appendChild(glowToggleBtn); glowRow.appendChild(glowPicker);
    right.appendChild(group(t('paint.glow', 'Glow'), [glowRow]));

    right.appendChild(group(t('paint.brushSize', 'Brush size'), [mkSlider(1, 6, 1, brushSize, function (v) { brushSize = v; })]));
    right.appendChild(group(t('paint.opacity', 'Opacity'), [mkSlider(0.1, 1, 0.05, opacity, function (v) { opacity = v; })]));

    prevWrap = group(t('paint.preview', 'Worn preview'), []);
    prevCanvas = el('canvas', 'pt-prevcanvas'); prevCanvas.width = 150; prevCanvas.height = 180; prevWrap.appendChild(prevCanvas); prevCtx = prevCanvas.getContext('2d');
    right.appendChild(prevWrap);
  }
  var glowToggleBtn;
  function group(label, children) { var c = el('div', 'pt-group'); c.appendChild(el('div', 'pt-grouplbl', label)); children.forEach(function (ch) { c.appendChild(ch); }); return c; }
  function mkSlider(min, max, step, val, fn) { var s = el('input', 'pt-slider'); s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(val); s.addEventListener('input', function () { fn(+s.value); }); return s; }
  function labeledSlider(label, sliderEl) { var d = el('div', 'pt-sl'); d.appendChild(el('span', 'pt-sllbl', label)); d.appendChild(sliderEl); return d; }

  function setGlow(on) { glowOn = on; if (glowToggleBtn) glowToggleBtn.classList.toggle('on', on); }
  function syncMode() { if (modeSeg) Array.prototype.forEach.call(modeSeg.children, function (b) { b.classList.toggle('active', b.dataset.v === mode); }); if (prevWrap) prevWrap.style.display = (mode === 'model') ? 'none' : ''; }
  function syncTool() { if (toolSeg) Array.prototype.forEach.call(toolSeg.children, function (b) { b.classList.toggle('active', b.dataset.v === tool); }); }
  function syncPickers() { var w = W(); if (basePicker) basePicker.value = w.base; if (glowPicker) glowPicker.value = w.glowC; }

  function populateSlots() {
    var T = TX(); var defs = (T && T.paintSlots) ? T.paintSlots() : {};
    var tux = (previewChar && previewChar.bodyType === 'tux');
    slotSel.innerHTML = '';
    Object.keys(defs).forEach(function (s) { var def = defs[s]; if (tux ? !def.tux : !def.hum) return; var mark = hasContent(s) ? ' •' : ''; var o = el('option', null, (t('slot.' + s, SLOT_LABELS[s] || s)) + mark); o.value = s; slotSel.appendChild(o); });
    if (!Array.prototype.some.call(slotSel.options, function (o) { return o.value === slot; })) slot = slotSel.options.length ? slotSel.options[0].value : 'shirt';
    slotSel.value = slot;
  }

  function switchSlot(s) { slot = s; W(); syncPickers(); syncAll(); render(); }

  // ---- zoom --------------------------------------------------------------
  function setZoom(z) { zoom = Math.max(0.5, Math.min(5, z)); if (zoomSlider) zoomSlider.value = String(zoom); applyZoom(); }
  function applyZoom() {
    if (!canvas || !canvas.parentElement) return;
    var box = canvas.parentElement, bw = gw * CELL, bh = gh * CELL;
    var availW = Math.max(40, box.clientWidth - 16), availH = Math.max(40, box.clientHeight - 16);
    var fit = Math.min(availW / bw, availH / bh); if (!isFinite(fit) || fit <= 0) fit = 1;
    var disp = fit * zoom;
    canvas.style.width = Math.round(bw * disp) + 'px';
    canvas.style.height = Math.round(bh * disp) + 'px';
  }

  // ---- painting ----------------------------------------------------------
  function wireCanvas() {
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', function () { hoverGx = hoverGy = -1; });
    canvas.addEventListener('touchstart', onTouch, { passive: false });
    canvas.addEventListener('touchmove', onTouch, { passive: false });
    canvas.addEventListener('touchend', function () { onUp(); });
  }
  function evtCell(cx, cy) { var r = canvas.getBoundingClientRect(); var px = (cx - r.left) * (canvas.width / r.width), py = (cy - r.top) * (canvas.height / r.height); return { gx: Math.floor(px / CELL), gy: Math.floor(py / CELL) }; }
  function onDown(e) { painting = true; var c = evtCell(e.clientX, e.clientY); stroke(c.gx, c.gy); if (e.preventDefault) e.preventDefault(); }
  function onMove(e) { var c = evtCell(e.clientX, e.clientY); hoverGx = c.gx; hoverGy = c.gy; if (painting) stroke(c.gx, c.gy); else if (shown) render(); }
  function onUp() { if (painting) { painting = false; pushHistory(); populateSlots(); } }
  function onTouch(e) { if (!e.touches || !e.touches.length) return; var tt = e.touches[0]; var c = evtCell(tt.clientX, tt.clientY); if (e.type === 'touchstart') painting = true; if (painting) { stroke(c.gx, c.gy); e.preventDefault(); } }

  function stroke(gx, gy) { dab(gx, gy); if (mirror) dab(gw - 1 - gx, gy); syncActive(); render(); }
  function dab(gx, gy) { var r = brushSize - 1; for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r + r) continue; paintCell(gx + dx, gy + dy); } }
  function paintCell(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return;
    var w = W(), i = gy * gw + gx;
    if (tool === 'eraser') { w.val[i] = 0; w.alpha[i] = 0; w.glow[i] = 0; }
    else if (tool === 'fill') { floodFill(w, gx, gy); }
    else if (glowOn) { w.glow[i] = 255; w.alpha[i] = 255; w.val[i] = 0; }
    else { w.val[i] = Math.round(shade * 255); w.alpha[i] = Math.round(opacity * 255); w.glow[i] = 0; }
  }
  function floodFill(w, sx, sy) {
    var startI = sy * gw + sx, targetA = w.alpha[startI], nv = Math.round(shade * 255), na = Math.round(opacity * 255);
    var match = function (a) { return (targetA === 0) ? (a === 0) : (a > 0); };
    var stack = [[sx, sy]], seen = {};
    while (stack.length) { var p = stack.pop(), x = p[0], y = p[1]; if (x < 0 || y < 0 || x >= gw || y >= gh) continue; var i = y * gw + x; if (seen[i]) continue; seen[i] = 1; if (!match(w.alpha[i])) continue; if (glowOn) { w.glow[i] = 255; w.alpha[i] = 255; w.val[i] = 0; } else { w.val[i] = nv; w.alpha[i] = na; w.glow[i] = 0; } stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]); }
  }

  // ---- rendering ---------------------------------------------------------
  function render() {
    if (!ctx) return;
    canvas.width = gw * CELL; canvas.height = gh * CELL; var Wd = canvas.width, Hd = canvas.height; ctx.imageSmoothingEnabled = false;
    for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) { ctx.fillStyle = ((x + y) & 1) ? '#181c2b' : '#1f2536'; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
    var T = TX();
    if (mode === 'model' && T && T.drawCanon && previewChar) { T.drawCanon(ctx, previewChar, 0, 0, CELL); }
    else { if (ghost && T && T.drawCanon && previewChar) { ctx.globalAlpha = 0.20; T.drawCanon(ctx, ghostWithout(slot), 0, 0, CELL); ctx.globalAlpha = 1; } drawFlat(ctx, W(), CELL); }
    ctx.strokeStyle = 'rgba(127,249,224,0.08)'; ctx.lineWidth = 1;
    for (var gx2 = 0; gx2 <= gw; gx2 += 4) { ctx.beginPath(); ctx.moveTo(gx2 * CELL + 0.5, 0); ctx.lineTo(gx2 * CELL + 0.5, Hd); ctx.stroke(); }
    for (var gy2 = 0; gy2 <= gh; gy2 += 4) { ctx.beginPath(); ctx.moveTo(0, gy2 * CELL + 0.5); ctx.lineTo(Wd, gy2 * CELL + 0.5); ctx.stroke(); }
    if (mirror) { ctx.strokeStyle = 'rgba(255,227,77,0.5)'; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(Wd / 2, 0); ctx.lineTo(Wd / 2, Hd); ctx.stroke(); ctx.setLineDash([]); }
    if (hoverGx >= 0 && hoverGy >= 0) {
      var r = brushSize - 1; ctx.strokeStyle = '#ffe34d'; ctx.lineWidth = 2;
      ctx.strokeRect((hoverGx - r) * CELL, (hoverGy - r) * CELL, (2 * r + 1) * CELL, (2 * r + 1) * CELL);
      if (mirror) ctx.strokeRect((gw - 1 - hoverGx - r) * CELL, (hoverGy - r) * CELL, (2 * r + 1) * CELL, (2 * r + 1) * CELL);
    }
    if (mode !== 'model') drawPreview();
  }
  function drawFlat(c, w, cell) {
    var rgb = hexToRgb(w.base), gc = hexToRgb(w.glowC);
    for (var i = 0; i < gw * gh; i++) {
      var a = w.alpha[i], g = w.glow[i]; if (!a && !g) continue;
      var x = (i % gw) * cell, y = ((i / gw) | 0) * cell;
      if (g > 0) c.fillStyle = 'rgba(' + gc[0] + ',' + gc[1] + ',' + gc[2] + ',1)';
      else { var v = w.val[i] / 255; c.fillStyle = 'rgba(' + Math.round(rgb[0] * v) + ',' + Math.round(rgb[1] * v) + ',' + Math.round(rgb[2] * v) + ',' + (a / 255) + ')'; }
      c.fillRect(x, y, cell, cell);
    }
  }
  function ghostWithout(s) { var c = cloneChar(previewChar); if (c.tex) { c.tex = assign({}, c.tex); delete c.tex[s]; } return c; }
  function drawPreview() {
    if (!prevCtx) return; var w = prevCanvas.width, h = prevCanvas.height;
    prevCtx.imageSmoothingEnabled = false; prevCtx.fillStyle = '#12151f'; prevCtx.fillRect(0, 0, w, h);
    var s = window.Sprites; if (s && s.drawCharacter && previewChar) { try { s.drawCharacter(prevCtx, previewChar, w / 2, h * 0.58, h / 20, 1); } catch (e) {} }
  }
  function hexToRgb(h) { h = (h || '#888888').slice(1); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // ---- history (per active part) -----------------------------------------
  function snapshot() { var w = W(); return { v: w.val.slice(0), a: w.alpha.slice(0), g: w.glow.slice(0) }; }
  function applySnap(s) { var w = W(); w.val.set(s.v); w.alpha.set(s.a); w.glow.set(s.g); }
  function pushHistory() { var w = W(); w.history = w.history.slice(0, w.hi + 1); w.history.push(snapshot()); if (w.history.length > 60) w.history.shift(); w.hi = w.history.length - 1; }
  function undo() { var w = W(); if (w.hi > 0) { w.hi--; applySnap(w.history[w.hi]); syncActive(); render(); populateSlots(); } }
  function redo() { var w = W(); if (w.hi < w.history.length - 1) { w.hi++; applySnap(w.history[w.hi]); syncActive(); render(); populateSlots(); } }

  // ---- save / publish selection dialog -----------------------------------
  function onClear() { var w = W(); w.val.fill(0); w.alpha.fill(0); w.glow.fill(0); pushHistory(); syncActive(); render(); populateSlots(); setStatus(t('paint.cleared', 'Cleared this part.')); }

  function openCommit(kind) {
    var slots = Object.keys(works).filter(hasContent);
    if (!slots.length) { setStatus(t('paint.empty', 'Paint something first!')); return; }
    if (kind === 'publish' && !loggedIn()) { setStatus(t('market.signinFirst', 'Sign in to publish.')); if (window.Menu && Menu.openSignIn) Menu.openSignIn(); return; }
    var rows = slots.map(function (s) {
      var row = el('div', 'pt-commit-row');
      var chk = el('input'); chk.type = 'checkbox'; chk.checked = true; chk.dataset.slot = s;
      var thumb = el('canvas', 'pt-commit-thumb'); thumb.width = 40; thumb.height = 45; var tx = thumb.getContext('2d'); tx.imageSmoothingEnabled = false; tx.fillStyle = '#12151f'; tx.fillRect(0, 0, 40, 45); drawFlat(tx, works[s], Math.max(1, Math.floor(40 / gw)));
      var name = el('input', 'pt-commit-name'); name.type = 'text'; name.maxLength = 28; name.value = t('slot.' + s, SLOT_LABELS[s] || s); name.dataset.slot = s;
      var lbl = el('label', 'pt-commit-lbl'); lbl.appendChild(chk); lbl.appendChild(thumb); lbl.appendChild(el('span', 'pt-commit-slot', t('slot.' + s, SLOT_LABELS[s] || s)));
      row.appendChild(lbl); row.appendChild(name);
      return row;
    });
    var overlay = el('div', 'pt-overlay'); overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    var modal = el('div', 'pt-modal');
    modal.appendChild(el('div', 'pt-modal-title', kind === 'publish' ? t('paint.publishWhich', 'Publish which parts?') : t('paint.saveWhich', 'Save & wear which parts?')));
    var list = el('div', 'pt-commit-list'); rows.forEach(function (r) { list.appendChild(r); }); modal.appendChild(list);
    var pubHint = (kind === 'publish') ? el('div', 'pt-note', t('paint.publishFree', 'Everything published is free and open-source.')) : null;
    if (pubHint) modal.appendChild(pubHint);
    var act = el('div', 'pt-modal-actions');
    act.appendChild(actBtn(t('common.cancel', 'Cancel'), 'pt-btn', close));
    act.appendChild(actBtn(kind === 'publish' ? t('paint.publishSel', 'Publish selected') : t('paint.saveSel', 'Save selected'), 'pt-btn ' + (kind === 'publish' ? 'pt-accent' : 'pt-primary'), function () { doCommit(kind, list, close); }));
    modal.appendChild(act);
    overlay.appendChild(modal);
    (document.getElementById('modal-root') || document.body).appendChild(overlay);
  }
  function doCommit(kind, list, close) {
    var chks = list.querySelectorAll('input[type=checkbox]'); var names = {};
    Array.prototype.forEach.call(list.querySelectorAll('input.pt-commit-name'), function (n) { names[n.dataset.slot] = (n.value || '').trim(); });
    var chosen = []; Array.prototype.forEach.call(chks, function (c) { if (c.checked) chosen.push(c.dataset.slot); });
    if (!chosen.length) { close(); return; }
    var pubs = [];
    chosen.forEach(function (s) {
      var w = works[s], id = uid();
      var rec = { id: id, slot: s, title: names[s] || (SLOT_LABELS[s] || s), glowColor: w.glowC, tintHint: w.base, createdAt: nowIso(), remixOf: w.remixOf || '', png: packPNG(w) };
      if (window.Store && Store.saveLocalTexture) Store.saveLocalTexture(rec);
      var T = TX(); if (T && T.registerCustom) T.registerCustom({ id: id, slot: s, glowColor: w.glowC, tintHint: w.base }, packWork(w));
      wear(s, id);
      if (kind === 'publish' && window.Market && Market.publishTexture) pubs.push(Market.publishTexture(rec));
    });
    close();
    if (kind === 'publish') {
      if (pubs.length) { setStatus(t('paint.publishing', 'Publishing…')); Promise.all(pubs.map(function (p) { return p.catch(function () { return null; }); })).then(function () { setStatus(chosen.length + ' ' + t('paint.publishedN', 'part(s) published — always free.')); }); }
      else setStatus(t('paint.marketSoon', 'Saved & worn. Publishing opens when the marketplace is up.'));
    } else setStatus(chosen.length + ' ' + t('paint.savedN', 'part(s) saved & worn.'));
  }
  function wear(s, id) {
    if (typeof App === 'undefined') return;
    var ch = cloneChar(App.character || (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
    ch.tex = assign({}, ch.tex); ch.tex[s] = id; origTex = assign({}, ch.tex);
    if (App.updateCharacter) App.updateCharacter(ch); else App.character = ch;
    if (loggedIn() && window.Store && Store.saveCharacterRemote) { try { Store.saveCharacterRemote(ch); } catch (e) {} }
  }
  function onBack() { hide(); if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu'); if (window.Menu && Menu.show) Menu.show(); }
  function setStatus(m) { if (statusEl) statusEl.textContent = m || ''; }

  function assign(a, b) { a = a || {}; if (b) for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; return a; }
  function cloneChar(c) { try { return JSON.parse(JSON.stringify(c || {})); } catch (e) { return {}; } }
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }
  function loop() { if (shown) { if (mode !== 'model') drawPreview(); rafId = window.requestAnimationFrame(loop); } }

  // ---- public ------------------------------------------------------------
  function open(opts) {
    opts = opts || {};
    if (!built) build();
    shown = true;
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('create'); else root.classList.add('active');
    var T = TX();
    if (!(T && T.isReady && T.isReady())) { setStatus(t('paint.loading', 'Loading textures…')); if (T && T.onReady) T.onReady(function () { if (shown) reallyOpen(opts); }); return; }
    reallyOpen(opts);
  }
  function reallyOpen(opts) {
    opts = opts || {};
    gw = GW(); gh = GH(); works = {};
    previewChar = cloneChar((typeof App !== 'undefined' && App.character) ? App.character : (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
    origTex = assign({}, previewChar.tex);
    slot = (opts.remix && opts.remix.slot) || opts.slot || slot;
    var finish = function () { populateSlots(); W(); syncPickers(); syncMode(); syncTool(); setGlow(false); pushHistory(); syncAll(); render(); applyZoom(); if (window.requestAnimationFrame) requestAnimationFrame(applyZoom); };
    if (opts.remix && opts.remix.png) { var w = newWork(); w.base = opts.remix.tintHint || w.base; w.glowC = opts.remix.glowColor || w.glowC; w.remixOf = opts.remix.id || ''; works[slot] = w; loadInto(w, opts.remix.png).then(finish); }
    else { finish(); }
    if (rafId == null) rafId = window.requestAnimationFrame(loop);
    setStatus('');
  }
  function hide() { shown = false; if (rafId != null) { window.cancelAnimationFrame(rafId); rafId = null; } if (root && !(window.App && App.showScreen)) root.classList.remove('active'); }

  // ---- styles ------------------------------------------------------------
  function injectStyle() {
    if (document.getElementById('paint-style')) return;
    var css = [
      '#screen-create{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e7ecff;background:#0c0f18;overflow:hidden;}',
      '#screen-create *{box-sizing:border-box;}',
      '.pt-wrap{height:100%;display:flex;flex-direction:column;padding:14px 18px;gap:12px;}',
      '.pt-head{display:flex;align-items:center;gap:16px;}',
      '.pt-title{font-size:16px;color:#7ff9e0;text-shadow:2px 2px 0 #000;}',
      '.pt-spacer{flex:1 1 auto;}',
      '.pt-field{display:flex;align-items:center;gap:8px;}',
      '.pt-flbl{font-size:8px;color:#7e89a8;text-transform:uppercase;letter-spacing:1px;}',
      '.pt-select{font-family:inherit;font-size:10px;color:#e7ecff;background:#1a2030;border:1px solid #313a55;border-radius:6px;padding:8px 10px;cursor:pointer;}',
      '.pt-seg{display:inline-flex;background:#10141f;border:1px solid #313a55;border-radius:7px;overflow:hidden;}',
      '.pt-segbtn{font-family:inherit;font-size:9px;color:#9aa6c4;background:transparent;border:0;padding:9px 13px;cursor:pointer;}',
      '.pt-segbtn.active{background:#7ff9e0;color:#0c0f18;}',
      '.pt-stage{flex:1 1 auto;display:flex;gap:16px;min-height:0;}',
      '.pt-left{flex:1 1 auto;display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.pt-box{flex:1 1 auto;display:flex;align-items:safe center;justify-content:safe center;background:#10141f;border:1px solid #283150;border-radius:12px;overflow:auto;padding:8px;min-height:0;}',
      '.pt-canvas{image-rendering:pixelated;cursor:crosshair;border-radius:2px;flex:0 0 auto;}',
      '.pt-zoom{display:flex;align-items:center;gap:8px;}',
      '.pt-zlbl{font-size:8px;color:#7e89a8;text-transform:uppercase;}',
      '.pt-zbtn{font-family:inherit;font-size:12px;color:#0c0f18;background:#7ff9e0;border:0;border-radius:6px;width:28px;height:26px;cursor:pointer;}',
      '.pt-zslider{flex:1 1 auto;accent-color:#7ff9e0;}',
      '.pt-toggles{display:flex;gap:8px;}',
      '.pt-toggle{font-family:inherit;font-size:9px;color:#9aa6c4;background:#161b29;border:1px solid #313a55;border-radius:7px;padding:8px 12px;cursor:pointer;}',
      '.pt-toggle.on{background:#ffe34d;color:#0c0f18;border-color:#ffe34d;}',
      '.pt-hint{font-size:8px;color:#6f7aa0;line-height:1.6;}',
      '.pt-right{flex:0 0 300px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding-right:4px;}',
      '.pt-group{background:#11151f;border:1px solid #232c45;border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:9px;}',
      '.pt-grouplbl{font-size:8px;color:#ff9e2c;text-transform:uppercase;letter-spacing:1px;}',
      '.pt-note{font-size:7px;color:#6f7aa0;line-height:1.6;}',
      '.pt-row{display:flex;align-items:center;gap:10px;}',
      '.pt-color{width:40px;height:32px;border:1px solid #313a55;border-radius:7px;padding:0;background:#10141f;cursor:pointer;flex:0 0 auto;}',
      '.pt-sl{flex:1 1 auto;display:flex;align-items:center;gap:8px;}',
      '.pt-sllbl{font-size:8px;color:#7e89a8;flex:0 0 auto;}',
      '.pt-slider{flex:1 1 auto;width:100%;accent-color:#7ff9e0;}',
      '.pt-glowtoggle{flex:1 1 auto;font-family:inherit;font-size:9px;color:#9aa6c4;background:#161b29;border:1px solid #313a55;border-radius:7px;padding:9px;cursor:pointer;}',
      '.pt-glowtoggle.on{background:#5dff8f;color:#0c0f18;border-color:#5dff8f;}',
      '.pt-prevcanvas{image-rendering:pixelated;background:#12151f;border:1px solid #283150;border-radius:8px;align-self:center;}',
      '.pt-actions{display:flex;align-items:center;gap:8px;}',
      '.pt-btn{font-family:inherit;font-size:9px;color:#e7ecff;background:#1c2235;border:1px solid #313a55;border-radius:8px;padding:11px 14px;cursor:pointer;}',
      '.pt-btn:hover{background:#26304a;}',
      '.pt-icon{padding:11px 12px;}',
      '.pt-primary{background:#7ff9e0;color:#0c0f18;border-color:#7ff9e0;font-weight:bold;}',
      '.pt-accent{background:#ff9e2c;color:#0c0f18;border-color:#ff9e2c;}',
      '.pt-status{text-align:center;font-size:9px;color:#7ff9e0;min-height:12px;}',
      // commit dialog
      '.pt-overlay{position:fixed;inset:0;background:rgba(8,9,16,.82);display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px;}',
      '.pt-modal{background:#161b29;border:2px solid #7ff9e0;border-radius:10px;box-shadow:8px 8px 0 #0a0b14;width:100%;max-width:380px;max-height:88vh;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;}',
      '.pt-modal-title{font-size:12px;color:#7ff9e0;}',
      '.pt-commit-list{display:flex;flex-direction:column;gap:8px;}',
      '.pt-commit-row{display:flex;align-items:center;gap:10px;}',
      '.pt-commit-lbl{display:flex;align-items:center;gap:8px;cursor:pointer;flex:0 0 auto;}',
      '.pt-commit-lbl input{width:16px;height:16px;accent-color:#7ff9e0;}',
      '.pt-commit-thumb{image-rendering:pixelated;background:#12151f;border:1px solid #283150;border-radius:4px;}',
      '.pt-commit-slot{font-size:9px;color:#cfd6ea;}',
      '.pt-commit-name{flex:1 1 auto;font-family:inherit;font-size:9px;color:#e7ecff;background:#1a2030;border:1px solid #313a55;border-radius:6px;padding:8px;}',
      '.pt-modal-actions{display:flex;justify-content:flex-end;gap:8px;}',
      '@media(max-width:760px){.pt-stage{flex-direction:column;}.pt-right{flex:0 0 auto;}.pt-box{min-height:300px;}}'
    ].join('');
    var st = el('style'); st.id = 'paint-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Paint = { open: open, close: hide };
})();
