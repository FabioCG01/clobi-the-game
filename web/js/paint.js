// paint.js — the Paint Studio (Create screen). Single global: window.Paint.
//
// Draw your OWN cosmetic textures and wear them. A texture is a GW×GH grid with
// three channels:
//   - VALUE  : a grayscale shade, tinted at wear-time by the wearer's color
//   - ALPHA  : transparency / translucency
//   - GLOW   : pixels painted in the GLOW color. They show as a flat color in
//              the editor, and only emit a pixelated glow WHEN RENDERED on a model.
//
// Two modes share one canonical grid (1:1 mapping):
//   - "On model" (default): paint directly on the live character.
//   - "Raw": paint on the flat texture grid with a faint character ghost.
//
// Depends on globals: Textures, Sprites, Store, App, I18n (and optionally Market, Menu).
(function () {
  'use strict';

  function TX() { return window.Textures || null; }
  function t(k, en) { return (window.I18n && I18n.t) ? I18n.t(k, en) : en; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function GW() { var T = TX(); return (T && T.grid && T.grid().w) || 64; }
  function GH() { var T = TX(); return (T && T.grid && T.grid().h) || 72; }

  var SLOT_LABELS = { body: 'Body', belly: 'Belly', feet: 'Feet', shirt: 'Shirt', pants: 'Pants', shoes: 'Shoes', hair: 'Hair', beard: 'Beard', eyes: 'Eyes', cape: 'Cape', hat: 'Hat', accessory: 'Accessory' };
  var TEMP_ID = '__paint_preview__';
  var CELL = 8;

  // ---- state -------------------------------------------------------------
  var root, built = false, shown = false;
  var canvas, ctx, prevWrap, prevCanvas, prevCtx, rafId = null;
  var slotSel, titleInput, statusEl, modeSeg, toolSeg;
  var shadeSlider, glowToggleBtn, mirrorBtn, ghostBtn;
  var gw, gh, valBuf, alphaBuf, glowBuf;
  var slot = 'shirt', mode = 'model', tool = 'brush';
  var baseColor = '#7ff9e0', glowColor = '#5dff8f';
  var shade = 1.0, opacity = 1.0, brushSize = 2;
  var glowOn = false, mirror = false, ghost = true;
  var painting = false, hoverGx = -1, hoverGy = -1, remixOf = '';
  var history = [], histIdx = -1, previewChar = null;

  // ---- buffers -----------------------------------------------------------
  function allocBuffers() { gw = GW(); gh = GH(); var n = gw * gh; valBuf = new Uint8Array(n); alphaBuf = new Uint8Array(n); glowBuf = new Uint8Array(n); }
  function clearBuffers() { valBuf.fill(0); alphaBuf.fill(0); glowBuf.fill(0); }

  function packPixels() {
    var n = gw * gh, d = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) { var p = i * 4; d[p] = valBuf[i]; d[p + 1] = glowBuf[i]; d[p + 2] = 0; d[p + 3] = alphaBuf[i]; }
    return d;
  }
  function packPNG() {
    var c = document.createElement('canvas'); c.width = gw; c.height = gh;
    var cx = c.getContext('2d'); var img = cx.createImageData(gw, gh); img.data.set(packPixels()); cx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  function loadFromPNG(dataUrl) {
    return new Promise(function (res) {
      if (!dataUrl) { res(false); return; }
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = gw; c.height = gh; var cx = c.getContext('2d'); cx.imageSmoothingEnabled = false; cx.drawImage(img, 0, 0, gw, gh);
        var d = cx.getImageData(0, 0, gw, gh).data;
        for (var i = 0; i < gw * gh; i++) { var p = i * 4; valBuf[i] = d[p]; glowBuf[i] = d[p + 1]; alphaBuf[i] = d[p + 3]; }
        res(true);
      };
      img.onerror = function () { res(false); };
      img.src = dataUrl;
    });
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return 'tex_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    return 'tex_' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  }
  function syncTemp() { var T = TX(); if (T && T.registerCustom) T.registerCustom({ id: TEMP_ID, slot: slot, glowColor: glowColor, tintHint: baseColor }, packPixels()); }
  function setSlotTemp(s) {
    if (previewChar) { previewChar.tex = previewChar.tex || {}; Object.keys(previewChar.tex).forEach(function (k) { if (previewChar.tex[k] === TEMP_ID) delete previewChar.tex[k]; }); }
    slot = s; if (previewChar) previewChar.tex[slot] = TEMP_ID;
  }

  // ---- DOM build ---------------------------------------------------------
  function build() {
    root = document.getElementById('screen-create');
    if (!root) { root = el('section'); root.id = 'screen-create'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = ''; injectStyle();
    var wrap = el('div', 'pt-wrap');

    // top bar
    var head = el('div', 'pt-head');
    head.appendChild(el('div', 'pt-title', t('paint.title', 'Paint Studio')));
    var spacer = el('div', 'pt-spacer'); head.appendChild(spacer);
    slotSel = el('select', 'pt-select');
    slotSel.addEventListener('change', function () { setSlotTemp(slotSel.value); pushHistory(); render(); });
    head.appendChild(field(t('paint.slot', 'Part'), slotSel));
    modeSeg = seg([['model', t('paint.model', 'On model')], ['raw', t('paint.raw', 'Raw')]], function (m) { mode = m; syncMode(); render(); });
    head.appendChild(field(t('paint.mode', 'Mode'), modeSeg));
    wrap.appendChild(head);

    // stage: canvas (left) + tools (right)
    var stage = el('div', 'pt-stage');
    var left = el('div', 'pt-left');
    var box = el('div', 'pt-box'); canvas = el('canvas', 'pt-canvas'); box.appendChild(canvas); left.appendChild(box);
    var toggles = el('div', 'pt-toggles');
    mirrorBtn = toggle(t('paint.mirror', 'Mirror'), 'mirror', function (on) { mirror = on; });
    ghostBtn = toggle(t('paint.ghost', 'Ghost'), 'ghost', function (on) { ghost = on; render(); });
    toggles.appendChild(mirrorBtn); toggles.appendChild(ghostBtn);
    left.appendChild(toggles);
    left.appendChild(el('div', 'pt-hint', t('paint.hint', 'Drag to paint. Grayscale + tint = recolorable. Glow pixels light up only on the model.')));
    stage.appendChild(left);

    var right = el('div', 'pt-right');
    buildTools(right);
    stage.appendChild(right);
    wrap.appendChild(stage);

    // actions
    var actions = el('div', 'pt-actions');
    actions.appendChild(actBtn(t('paint.undo', 'Undo'), 'pt-btn pt-icon', undo));
    actions.appendChild(actBtn(t('paint.redo', 'Redo'), 'pt-btn pt-icon', redo));
    actions.appendChild(actBtn(t('paint.clear', 'Clear'), 'pt-btn', onClear));
    var grow = el('div', 'pt-spacer'); actions.appendChild(grow);
    actions.appendChild(actBtn(t('common.back', 'Back'), 'pt-btn', onBack));
    actions.appendChild(actBtn(t('paint.publish', 'Publish'), 'pt-btn pt-accent', onPublish));
    actions.appendChild(actBtn(t('paint.save', 'Save & wear'), 'pt-btn pt-primary', onSave));
    wrap.appendChild(actions);
    statusEl = el('div', 'pt-status'); wrap.appendChild(statusEl);

    root.appendChild(wrap);
    ctx = canvas.getContext('2d');
    wireCanvas();
    built = true;
  }

  function field(label, control) { var d = el('div', 'pt-field'); d.appendChild(el('span', 'pt-flbl', label)); d.appendChild(control); return d; }
  function actBtn(label, cls, fn) { var b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; }
  function seg(opts, fn) {
    var s = el('div', 'pt-seg');
    opts.forEach(function (o) { var b = el('button', 'pt-segbtn', o[1]); b.type = 'button'; b.dataset.v = o[0]; b.addEventListener('click', function () { fn(o[0]); }); s.appendChild(b); });
    return s;
  }
  function toggle(label, key, fn) {
    var b = el('button', 'pt-toggle', label); b.type = 'button'; b.dataset.on = '0';
    b.addEventListener('click', function () { var on = b.dataset.on === '0'; b.dataset.on = on ? '1' : '0'; b.classList.toggle('on', on); fn(on); });
    return b;
  }

  function buildTools(right) {
    toolSeg = seg([['brush', t('paint.brush', 'Brush')], ['eraser', t('paint.eraser', 'Eraser')], ['fill', t('paint.fill', 'Fill')]], function (tt) { tool = tt; syncTool(); });
    right.appendChild(group(t('paint.tool', 'Tool'), [toolSeg]));

    // color + continuous shade slider
    var colRow = el('div', 'pt-row');
    var picker = el('input'); picker.type = 'color'; picker.value = baseColor; picker.className = 'pt-color';
    picker.addEventListener('input', function () { baseColor = picker.value; if (glowOn) setGlow(false); syncTemp(); render(); });
    colRow.appendChild(picker);
    shadeSlider = mkSlider(0.1, 1, 0.02, shade, function (v) { shade = v; });
    colRow.appendChild(labeledSlider(t('paint.shade', 'Shade'), shadeSlider));
    right.appendChild(group(t('paint.color', 'Color'), [colRow]));

    // glow: a color that lights up only when rendered
    var glowRow = el('div', 'pt-row');
    glowToggleBtn = el('button', 'pt-glowtoggle', t('paint.glowPaint', 'Paint glow')); glowToggleBtn.type = 'button';
    glowToggleBtn.addEventListener('click', function () { setGlow(!glowOn); });
    var glowPick = el('input'); glowPick.type = 'color'; glowPick.value = glowColor; glowPick.className = 'pt-color';
    glowPick.addEventListener('input', function () { glowColor = glowPick.value; syncTemp(); render(); });
    glowRow.appendChild(glowToggleBtn); glowRow.appendChild(glowPick);
    right.appendChild(group(t('paint.glow', 'Glow'), [glowRow]));

    right.appendChild(group(t('paint.brushSize', 'Brush size'), [mkSlider(1, 6, 1, brushSize, function (v) { brushSize = v; })]));
    right.appendChild(group(t('paint.opacity', 'Opacity'), [mkSlider(0.1, 1, 0.05, opacity, function (v) { opacity = v; })]));

    // worn preview (raw mode only — redundant on model)
    prevWrap = group(t('paint.preview', 'Worn preview'), []);
    prevCanvas = el('canvas', 'pt-prevcanvas'); prevCanvas.width = 150; prevCanvas.height = 180;
    prevWrap.appendChild(prevCanvas); prevCtx = prevCanvas.getContext('2d');
    right.appendChild(prevWrap);

    titleInput = el('input', 'pt-titleinput'); titleInput.type = 'text'; titleInput.maxLength = 28; titleInput.placeholder = t('paint.namePh', 'Name your texture');
    right.appendChild(group(t('paint.name', 'Name'), [titleInput]));
  }
  function group(label, children) { var c = el('div', 'pt-group'); c.appendChild(el('div', 'pt-grouplbl', label)); children.forEach(function (ch) { c.appendChild(ch); }); return c; }
  function mkSlider(min, max, step, val, fn) { var s = el('input', 'pt-slider'); s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(val); s.addEventListener('input', function () { fn(+s.value); }); return s; }
  function labeledSlider(label, sliderEl) { var d = el('div', 'pt-sl'); d.appendChild(el('span', 'pt-sllbl', label)); d.appendChild(sliderEl); return d; }

  function setGlow(on) { glowOn = on; if (glowToggleBtn) glowToggleBtn.classList.toggle('on', on); }
  function syncMode() { if (modeSeg) Array.prototype.forEach.call(modeSeg.children, function (b) { b.classList.toggle('active', b.dataset.v === mode); }); if (prevWrap) prevWrap.style.display = (mode === 'model') ? 'none' : ''; }
  function syncTool() { if (toolSeg) Array.prototype.forEach.call(toolSeg.children, function (b) { b.classList.toggle('active', b.dataset.v === tool); }); }

  function populateSlots() {
    var T = TX(); var defs = (T && T.paintSlots) ? T.paintSlots() : {};
    var tux = (previewChar && previewChar.bodyType === 'tux');
    slotSel.innerHTML = '';
    Object.keys(defs).forEach(function (s) { var def = defs[s]; if (tux ? !def.tux : !def.hum) return; var o = el('option', null, t('slot.' + s, SLOT_LABELS[s] || s)); o.value = s; slotSel.appendChild(o); });
    if (!Array.prototype.some.call(slotSel.options, function (o) { return o.value === slot; })) slot = slotSel.options.length ? slotSel.options[0].value : 'shirt';
    slotSel.value = slot;
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
  function onUp() { if (painting) { painting = false; pushHistory(); } }
  function onTouch(e) { if (!e.touches || !e.touches.length) return; var tt = e.touches[0]; var c = evtCell(tt.clientX, tt.clientY); if (e.type === 'touchstart') painting = true; if (painting) { stroke(c.gx, c.gy); e.preventDefault(); } }

  function stroke(gx, gy) {
    dab(gx, gy);
    if (mirror) dab(gw - 1 - gx, gy);
    syncTemp(); render();
  }
  function dab(gx, gy) { var r = brushSize - 1; for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) { if (dx * dx + dy * dy > r * r + r) continue; paintCell(gx + dx, gy + dy); } }
  function paintCell(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return;
    var i = gy * gw + gx;
    if (tool === 'eraser') { valBuf[i] = 0; alphaBuf[i] = 0; glowBuf[i] = 0; }
    else if (tool === 'fill') { floodFill(gx, gy); }
    else if (glowOn) { glowBuf[i] = 255; alphaBuf[i] = 255; valBuf[i] = 0; }
    else { valBuf[i] = Math.round(shade * 255); alphaBuf[i] = Math.round(opacity * 255); glowBuf[i] = 0; }
  }
  function floodFill(sx, sy) {
    var startI = sy * gw + sx, targetA = alphaBuf[startI];
    var nv = Math.round(shade * 255), na = Math.round(opacity * 255);
    var match = function (a) { return (targetA === 0) ? (a === 0) : (a > 0); };
    var stack = [[sx, sy]], seen = {};
    while (stack.length) {
      var p = stack.pop(), x = p[0], y = p[1];
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      var i = y * gw + x; if (seen[i]) continue; seen[i] = 1;
      if (!match(alphaBuf[i])) continue;
      if (glowOn) { glowBuf[i] = 255; alphaBuf[i] = 255; valBuf[i] = 0; } else { valBuf[i] = nv; alphaBuf[i] = na; glowBuf[i] = 0; }
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  // ---- rendering ---------------------------------------------------------
  function render() {
    if (!ctx) return;
    canvas.width = gw * CELL; canvas.height = gh * CELL;
    var W = canvas.width, H = canvas.height; ctx.imageSmoothingEnabled = false;
    // checkerboard backdrop (transparency)
    for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) { ctx.fillStyle = ((x + y) & 1) ? '#181c2b' : '#1f2536'; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
    var T = TX();
    if (mode === 'model' && T && T.drawCanon && previewChar) {
      T.drawCanon(ctx, previewChar, 0, 0, CELL);          // full character, glow blooms here
    } else {
      if (ghost && T && T.drawCanon && previewChar) { ctx.globalAlpha = 0.20; T.drawCanon(ctx, ghostWithout(slot), 0, 0, CELL); ctx.globalAlpha = 1; }
      drawFlat(W, H);                                       // flat texture: glow shown as solid color (no bloom)
    }
    // subtle grid
    ctx.strokeStyle = 'rgba(127,249,224,0.08)'; ctx.lineWidth = 1;
    for (var gx2 = 0; gx2 <= gw; gx2 += 4) { ctx.beginPath(); ctx.moveTo(gx2 * CELL + 0.5, 0); ctx.lineTo(gx2 * CELL + 0.5, H); ctx.stroke(); }
    for (var gy2 = 0; gy2 <= gh; gy2 += 4) { ctx.beginPath(); ctx.moveTo(0, gy2 * CELL + 0.5); ctx.lineTo(W, gy2 * CELL + 0.5); ctx.stroke(); }
    // mirror axis guide
    if (mirror) { ctx.strokeStyle = 'rgba(255,227,77,0.5)'; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.setLineDash([]); }
    // brush cursor
    if (hoverGx >= 0 && hoverGy >= 0) {
      var r = brushSize - 1; ctx.strokeStyle = '#ffe34d'; ctx.lineWidth = 2;
      ctx.strokeRect((hoverGx - r) * CELL, (hoverGy - r) * CELL, (2 * r + 1) * CELL, (2 * r + 1) * CELL);
      if (mirror) ctx.strokeRect((gw - 1 - hoverGx - r) * CELL, (hoverGy - r) * CELL, (2 * r + 1) * CELL, (2 * r + 1) * CELL);
    }
    if (mode !== 'model') drawPreview();
  }
  function drawFlat(W, H) {
    var rgb = hexToRgb(baseColor), gc = hexToRgb(glowColor);
    for (var i = 0; i < gw * gh; i++) {
      var a = alphaBuf[i], g = glowBuf[i];
      if (!a && !g) continue;
      var x = (i % gw) * CELL, y = ((i / gw) | 0) * CELL;
      if (g > 0) { ctx.fillStyle = 'rgba(' + gc[0] + ',' + gc[1] + ',' + gc[2] + ',1)'; }
      else { var v = valBuf[i] / 255; ctx.fillStyle = 'rgba(' + Math.round(rgb[0] * v) + ',' + Math.round(rgb[1] * v) + ',' + Math.round(rgb[2] * v) + ',' + (a / 255) + ')'; }
      ctx.fillRect(x, y, CELL, CELL);
    }
  }
  function ghostWithout(s) { var c = cloneChar(previewChar); if (c.tex) { c.tex = assign({}, c.tex); delete c.tex[s]; } return c; }
  function drawPreview() {
    if (!prevCtx) return; var w = prevCanvas.width, h = prevCanvas.height;
    prevCtx.imageSmoothingEnabled = false; prevCtx.fillStyle = '#12151f'; prevCtx.fillRect(0, 0, w, h);
    var s = window.Sprites; if (s && s.drawCharacter && previewChar) { try { s.drawCharacter(prevCtx, previewChar, w / 2, h * 0.58, h / 20, 1); } catch (e) {} }
  }
  function hexToRgb(h) { h = (h || '#888888').slice(1); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var n = parseInt(h.slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // ---- history -----------------------------------------------------------
  function snapshot() { return { v: valBuf.slice(0), a: alphaBuf.slice(0), g: glowBuf.slice(0), slot: slot }; }
  function applySnapshot(s) { valBuf.set(s.v); alphaBuf.set(s.a); glowBuf.set(s.g); slot = s.slot; if (slotSel) slotSel.value = slot; }
  function pushHistory() { history = history.slice(0, histIdx + 1); history.push(snapshot()); if (history.length > 60) history.shift(); histIdx = history.length - 1; }
  function undo() { if (histIdx > 0) { histIdx--; applySnapshot(history[histIdx]); setSlotTemp(slot); syncTemp(); render(); } }
  function redo() { if (histIdx < history.length - 1) { histIdx++; applySnapshot(history[histIdx]); setSlotTemp(slot); syncTemp(); render(); } }

  // ---- actions -----------------------------------------------------------
  function onClear() { clearBuffers(); pushHistory(); syncTemp(); render(); setStatus(t('paint.cleared', 'Cleared.')); }
  function buildRecord(id) { return { id: id, slot: slot, title: (titleInput.value || '').trim() || t('paint.untitled', 'Untitled'), glowColor: glowColor, tintHint: baseColor, createdAt: nowIso(), remixOf: remixOf || '', png: packPNG() }; }
  function wear(id) {
    if (typeof App === 'undefined') return;
    var ch = cloneChar(App.character || (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
    ch.tex = assign({}, ch.tex); ch.tex[slot] = id;
    if (App.updateCharacter) App.updateCharacter(ch); else App.character = ch;
    if (window.Store && Store.isLoggedIn && Store.isLoggedIn() && Store.saveCharacterRemote) { try { Store.saveCharacterRemote(ch); } catch (e) {} }
  }
  function onSave() {
    if (isEmpty()) { setStatus(t('paint.empty', 'Paint something first!')); return; }
    var id = uid(), rec = buildRecord(id);
    if (window.Store && Store.saveLocalTexture) Store.saveLocalTexture(rec);
    var T = TX(); if (T && T.registerCustom) T.registerCustom({ id: id, slot: slot, glowColor: glowColor, tintHint: baseColor }, packPixels());
    wear(id); setStatus(t('paint.saved', 'Saved & worn — find it on your character.'));
  }
  function onPublish() {
    if (isEmpty()) { setStatus(t('paint.empty', 'Paint something first!')); return; }
    var id = uid(), rec = buildRecord(id);
    if (window.Store && Store.saveLocalTexture) Store.saveLocalTexture(rec);
    var T = TX(); if (T && T.registerCustom) T.registerCustom({ id: id, slot: slot, glowColor: glowColor, tintHint: baseColor }, packPixels());
    wear(id);
    if (window.Market && Market.publishTexture) { setStatus(t('paint.publishing', 'Publishing…')); Market.publishTexture(rec).then(function () { setStatus(t('paint.published', 'Published — always free.')); }).catch(function (e) { setStatus((e && e.message) || t('paint.publishFail', 'Could not publish (saved locally).')); }); }
    else setStatus(t('paint.marketSoon', 'Saved & worn. Publish opens when the marketplace is up.'));
  }
  function onBack() { hide(); if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu'); if (window.Menu && Menu.show) Menu.show(); }
  function isEmpty() { for (var i = 0; i < alphaBuf.length; i++) if (alphaBuf[i] || glowBuf[i]) return false; return true; }
  function setStatus(m) { if (statusEl) statusEl.textContent = m || ''; }

  // ---- helpers -----------------------------------------------------------
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
    allocBuffers(); clearBuffers();
    previewChar = cloneChar((typeof App !== 'undefined' && App.character) ? App.character : (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
    previewChar.tex = assign({}, previewChar.tex); remixOf = '';
    slot = (opts.remix && opts.remix.slot) || opts.slot || slot;
    var after = function () { populateSlots(); setSlotTemp(slot); slotSel.value = slot; syncMode(); syncTool(); setGlow(false); syncTemp(); render(); };
    if (opts.remix && opts.remix.png) { remixOf = opts.remix.id || ''; baseColor = opts.remix.tintHint || baseColor; glowColor = opts.remix.glowColor || glowColor; loadFromPNG(opts.remix.png).then(function () { history = []; histIdx = -1; pushHistory(); after(); }); }
    else { history = []; histIdx = -1; pushHistory(); after(); }
    if (titleInput) titleInput.value = (opts.remix && opts.remix.title) ? (opts.remix.title + ' (remix)') : '';
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
      '.pt-box{flex:1 1 auto;display:flex;align-items:center;justify-content:center;background:#10141f;border:1px solid #283150;border-radius:12px;overflow:hidden;padding:10px;min-height:0;}',
      '.pt-canvas{max-width:100%;max-height:100%;image-rendering:pixelated;cursor:crosshair;border-radius:4px;}',
      '.pt-toggles{display:flex;gap:8px;}',
      '.pt-toggle{font-family:inherit;font-size:9px;color:#9aa6c4;background:#161b29;border:1px solid #313a55;border-radius:7px;padding:8px 12px;cursor:pointer;}',
      '.pt-toggle.on{background:#ffe34d;color:#0c0f18;border-color:#ffe34d;}',
      '.pt-hint{font-size:8px;color:#6f7aa0;line-height:1.6;}',
      '.pt-right{flex:0 0 300px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding-right:4px;}',
      '.pt-group{background:#11151f;border:1px solid #232c45;border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:9px;}',
      '.pt-grouplbl{font-size:8px;color:#ff9e2c;text-transform:uppercase;letter-spacing:1px;}',
      '.pt-row{display:flex;align-items:center;gap:10px;}',
      '.pt-color{width:40px;height:32px;border:1px solid #313a55;border-radius:7px;padding:0;background:#10141f;cursor:pointer;flex:0 0 auto;}',
      '.pt-sl{flex:1 1 auto;display:flex;align-items:center;gap:8px;}',
      '.pt-sllbl{font-size:8px;color:#7e89a8;flex:0 0 auto;}',
      '.pt-slider{flex:1 1 auto;width:100%;accent-color:#7ff9e0;}',
      '.pt-glowtoggle{flex:1 1 auto;font-family:inherit;font-size:9px;color:#9aa6c4;background:#161b29;border:1px solid #313a55;border-radius:7px;padding:9px;cursor:pointer;}',
      '.pt-glowtoggle.on{background:#5dff8f;color:#0c0f18;border-color:#5dff8f;}',
      '.pt-prevcanvas{image-rendering:pixelated;background:#12151f;border:1px solid #283150;border-radius:8px;align-self:center;}',
      '.pt-titleinput{font-family:inherit;font-size:10px;color:#e7ecff;background:#1a2030;border:1px solid #313a55;border-radius:7px;padding:9px;width:100%;}',
      '.pt-actions{display:flex;align-items:center;gap:8px;}',
      '.pt-btn{font-family:inherit;font-size:9px;color:#e7ecff;background:#1c2235;border:1px solid #313a55;border-radius:8px;padding:11px 14px;cursor:pointer;}',
      '.pt-btn:hover{background:#26304a;}',
      '.pt-icon{padding:11px 12px;}',
      '.pt-primary{background:#7ff9e0;color:#0c0f18;border-color:#7ff9e0;font-weight:bold;}',
      '.pt-accent{background:#ff9e2c;color:#0c0f18;border-color:#ff9e2c;}',
      '.pt-status{text-align:center;font-size:9px;color:#7ff9e0;min-height:12px;}',
      '@media(max-width:760px){.pt-stage{flex-direction:column;}.pt-right{flex:0 0 auto;}.pt-box{min-height:280px;}}'
    ].join('');
    var st = el('style'); st.id = 'paint-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Paint = { open: open, close: hide };
})();
