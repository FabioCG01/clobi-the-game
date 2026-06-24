// paint.js — the Paint Studio (Create screen). Single global: window.Paint.
//
// Lets a player draw their OWN cosmetic textures and wear them. A texture is a
// GW×GH grid stored as three channels: a grayscale VALUE (tinted by the wearer's
// colour, so recolouring still works), an ALPHA (transparency / translucency),
// and a GLOW mask (rendered in a secondary glow colour with a chunky pixel halo).
//
// Two painting modes share the exact same canonical grid (so they map 1:1):
//   - "Raw"      : paint on the flat texture grid (with a faint character ghost).
//   - "On model" : paint on the live canonical character wearing the texture.
//
// Saving stores the texture in the local library (Store) and wears it on the
// current character. Publishing (always free) is handed to the Marketplace when
// that module is present. Authorship/createdAt travel with every record.
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

  var SLOT_LABELS = {
    body: 'Body', belly: 'Belly', feet: 'Feet', shirt: 'Shirt', pants: 'Pants',
    shoes: 'Shoes', hair: 'Hair', beard: 'Beard', eyes: 'Eyes', cape: 'Cape',
    hat: 'Hat', accessory: 'Accessory'
  };
  var TEMP_ID = '__paint_preview__';
  var CELL = 8; // logical px per texture cell on the editing canvas

  // ---- state -------------------------------------------------------------
  var root, built = false, shown = false;
  var canvas, ctx, prevCanvas, prevCtx, rafId = null, animFrame = 0;
  var slotSel, titleInput, statusEl, ghostChk, modeTabsEl, toolsEl;
  var gw, gh;                       // grid dims (resolved once shown)
  var valBuf, alphaBuf, glowBuf;   // Uint8Array(gw*gh)
  var slot = 'shirt', mode = 'raw', tool = 'brush';
  var baseColor = '#7ff9e0', glowColor = '#ff5aa0';
  var shade = 1.0, opacity = 1.0, glowStrength = 1.0, brushSize = 2;
  var painting = false, hoverGx = -1, hoverGy = -1, remixOf = '';
  var history = [], histIdx = -1;
  var previewChar = null;

  // ---- buffers -----------------------------------------------------------
  function allocBuffers() {
    gw = GW(); gh = GH();
    var n = gw * gh;
    valBuf = new Uint8Array(n); alphaBuf = new Uint8Array(n); glowBuf = new Uint8Array(n);
  }
  function clearBuffers() { valBuf.fill(0); alphaBuf.fill(0); glowBuf.fill(0); }

  // Pack the buffers into a Uint8ClampedArray (R=value, G=glow, B=0, A=alpha).
  function packPixels() {
    var n = gw * gh, d = new Uint8ClampedArray(n * 4);
    for (var i = 0; i < n; i++) { var p = i * 4; d[p] = valBuf[i]; d[p + 1] = glowBuf[i]; d[p + 2] = 0; d[p + 3] = alphaBuf[i]; }
    return d;
  }
  // Export a packed RGBA PNG data URL (the storage / marketplace format).
  function packPNG() {
    var c = document.createElement('canvas'); c.width = gw; c.height = gh;
    var cx = c.getContext('2d'); var img = cx.createImageData(gw, gh);
    img.data.set(packPixels()); cx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
  // Load buffers from a packed PNG data URL (for remix). Resolves true/false.
  function loadFromPNG(dataUrl) {
    return new Promise(function (res) {
      if (!dataUrl) { res(false); return; }
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = gw; c.height = gh;
        var cx = c.getContext('2d'); cx.imageSmoothingEnabled = false; cx.drawImage(img, 0, 0, gw, gh);
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

  // Register the in-progress texture under TEMP_ID so the renderer can show it.
  function syncTemp() {
    var T = TX(); if (!T || !T.registerCustom) return;
    T.registerCustom({ id: TEMP_ID, slot: slot, glowColor: glowColor, tintHint: baseColor }, packPixels());
  }

  // Move the live preview's TEMP texture onto a new slot.
  function setSlotTemp(newSlot) {
    if (previewChar && previewChar.tex) {
      Object.keys(previewChar.tex).forEach(function (k) { if (previewChar.tex[k] === TEMP_ID) delete previewChar.tex[k]; });
    } else if (previewChar) { previewChar.tex = {}; }
    slot = newSlot;
    if (previewChar) previewChar.tex[slot] = TEMP_ID;
  }

  // ---- DOM build ---------------------------------------------------------
  function build() {
    root = document.getElementById('screen-create');
    if (!root) { root = el('section'); root.id = 'screen-create'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = ''; injectStyle();
    var wrap = el('div', 'pt-wrap');

    // head
    var head = el('div', 'pt-head');
    head.appendChild(el('div', 'pt-title', t('paint.title', 'Paint Studio')));
    slotSel = el('select', 'pt-select');
    slotSel.addEventListener('change', function () { setSlotTemp(slotSel.value); pushHistory(); syncTemp(); render(); });
    head.appendChild(labeledRow(t('paint.slot', 'Part'), slotSel));
    modeTabsEl = el('div', 'pt-seg');
    [['raw', t('paint.raw', 'Raw')], ['model', t('paint.model', 'On model')]].forEach(function (m) {
      var b = el('button', 'pt-segbtn', m[1]); b.type = 'button'; b.dataset.m = m[0];
      b.addEventListener('click', function () { mode = m[0]; syncSeg(); render(); });
      modeTabsEl.appendChild(b);
    });
    head.appendChild(labeledRow(t('paint.mode', 'Mode'), modeTabsEl));
    wrap.appendChild(head);

    // stage
    var stage = el('div', 'pt-stage');
    var left = el('div', 'pt-left');
    var box = el('div', 'pt-box'); canvas = el('canvas', 'pt-canvas'); box.appendChild(canvas); left.appendChild(box);
    var ghostRow = el('label', 'pt-ghost');
    ghostChk = el('input'); ghostChk.type = 'checkbox'; ghostChk.checked = true;
    ghostChk.addEventListener('change', render);
    ghostRow.appendChild(ghostChk); ghostRow.appendChild(el('span', null, t('paint.ghost', 'Show character ghost')));
    left.appendChild(ghostRow);
    left.appendChild(el('div', 'pt-hint', t('paint.hint', 'Drag to paint · the texture is grayscale and tinted by the wearer · glow adds a second colour')));
    stage.appendChild(left);

    var right = el('div', 'pt-right');
    toolsEl = right;
    buildTools(right);
    stage.appendChild(right);
    wrap.appendChild(stage);

    // actions
    var actions = el('div', 'pt-actions');
    actions.appendChild(actBtn(t('paint.clear', 'Clear'), 'pt-btn', onClear));
    actions.appendChild(actBtn(t('paint.undo', 'Undo'), 'pt-btn', undo));
    actions.appendChild(actBtn(t('paint.redo', 'Redo'), 'pt-btn', redo));
    var sv = actBtn(t('paint.save', 'Save & wear'), 'pt-btn pt-primary', onSave); actions.appendChild(sv);
    actions.appendChild(actBtn(t('paint.publish', 'Publish (free)'), 'pt-btn pt-accent', onPublish));
    actions.appendChild(actBtn(t('common.back', 'Back'), 'pt-btn', onBack));
    wrap.appendChild(actions);
    statusEl = el('div', 'pt-status'); wrap.appendChild(statusEl);

    root.appendChild(wrap);
    ctx = canvas.getContext('2d');
    wireCanvas();
    built = true;
  }

  function labeledRow(label, control) {
    var r = el('div', 'pt-lrow'); r.appendChild(el('span', 'pt-llbl', label)); r.appendChild(control); return r;
  }
  function actBtn(label, cls, fn) { var b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; }

  function buildTools(right) {
    // tool buttons
    var toolRow = el('div', 'pt-seg');
    [['brush', t('paint.brush', 'Brush')], ['eraser', t('paint.eraser', 'Eraser')], ['fill', t('paint.fill', 'Fill')], ['glow', t('paint.glow', 'Glow')]].forEach(function (tt) {
      var b = el('button', 'pt-segbtn', tt[1]); b.type = 'button'; b.dataset.t = tt[0];
      b.addEventListener('click', function () { tool = tt[0]; syncSeg(); });
      toolRow.appendChild(b);
    });
    right.appendChild(card(t('paint.tool', 'Tool'), [toolRow]));

    // base colour + shade ramp
    var colorRow = el('div', 'pt-colrow');
    var picker = el('input'); picker.type = 'color'; picker.value = baseColor; picker.className = 'pt-color';
    picker.addEventListener('input', function () { baseColor = picker.value; syncTemp(); render(); });
    colorRow.appendChild(picker);
    var ramp = el('div', 'pt-ramp');
    [1.0, 0.82, 0.64, 0.46, 0.28, 0.12].forEach(function (s) {
      var sw = el('button', 'pt-shade'); sw.type = 'button'; sw.title = Math.round(s * 100) + '%';
      sw.style.background = shadeHex(baseColor, s); sw.dataset.s = String(s);
      sw.addEventListener('click', function () { shade = s; syncShadeUi(); });
      ramp.appendChild(sw);
    });
    colorRow.appendChild(ramp);
    right.appendChild(card(t('paint.baseColor', 'Base colour'), [colorRow]));

    // sliders: brush size, opacity
    right.appendChild(card(t('paint.brushSize', 'Brush size'), [slider(1, 5, 1, brushSize, function (v) { brushSize = v; })]));
    right.appendChild(card(t('paint.opacity', 'Opacity'), [slider(0.1, 1, 0.05, opacity, function (v) { opacity = v; })]));

    // glow controls
    var glowPick = el('input'); glowPick.type = 'color'; glowPick.value = glowColor; glowPick.className = 'pt-color';
    glowPick.addEventListener('input', function () { glowColor = glowPick.value; syncTemp(); render(); });
    var glowCard = card(t('paint.glowColor', 'Glow colour'), [glowPick, slider(0.2, 1, 0.05, glowStrength, function (v) { glowStrength = v; })]);
    right.appendChild(glowCard);

    // live preview
    var pv = el('div', 'pt-preview');
    prevCanvas = el('canvas', 'pt-prevcanvas'); prevCanvas.width = 140; prevCanvas.height = 168;
    pv.appendChild(prevCanvas);
    right.appendChild(card(t('paint.preview', 'Worn preview'), [pv]));
    prevCtx = prevCanvas.getContext('2d');

    // title
    titleInput = el('input', 'pt-titleinput'); titleInput.type = 'text'; titleInput.maxLength = 28;
    titleInput.placeholder = t('paint.namePh', 'Name your texture');
    right.appendChild(card(t('paint.name', 'Name'), [titleInput]));
  }

  function card(label, children) {
    var c = el('div', 'pt-card'); c.appendChild(el('div', 'pt-cardlbl', label));
    children.forEach(function (ch) { c.appendChild(ch); }); return c;
  }
  function slider(min, max, step, val, fn) {
    var s = el('input', 'pt-slider'); s.type = 'range'; s.min = String(min); s.max = String(max); s.step = String(step); s.value = String(val);
    s.addEventListener('input', function () { fn(+s.value); }); return s;
  }

  function syncSeg() {
    if (modeTabsEl) Array.prototype.forEach.call(modeTabsEl.children, function (b) { b.classList.toggle('active', b.dataset.m === mode); });
    if (toolsEl) Array.prototype.forEach.call(toolsEl.querySelectorAll('.pt-segbtn[data-t]'), function (b) { b.classList.toggle('active', b.dataset.t === tool); });
  }
  function syncShadeUi() {
    if (!toolsEl) return;
    Array.prototype.forEach.call(toolsEl.querySelectorAll('.pt-shade'), function (b) { b.classList.toggle('active', Math.abs(+b.dataset.s - shade) < 0.001); });
  }

  function populateSlots() {
    var T = TX(); var defs = (T && T.paintSlots) ? T.paintSlots() : {};
    var tux = (previewChar && previewChar.bodyType === 'tux');
    slotSel.innerHTML = '';
    Object.keys(defs).forEach(function (s) {
      var def = defs[s]; if (tux ? !def.tux : !def.hum) return;
      var o = el('option', null, t('slot.' + s, SLOT_LABELS[s] || s)); o.value = s; slotSel.appendChild(o);
    });
    if (!Array.prototype.some.call(slotSel.options, function (o) { return o.value === slot; })) {
      slot = slotSel.options.length ? slotSel.options[0].value : 'shirt';
    }
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
  function evtCell(clientX, clientY) {
    var r = canvas.getBoundingClientRect();
    var px = (clientX - r.left) * (canvas.width / r.width);
    var py = (clientY - r.top) * (canvas.height / r.height);
    return { gx: Math.floor(px / CELL), gy: Math.floor(py / CELL) };
  }
  function onDown(e) { painting = true; var c = evtCell(e.clientX, e.clientY); stroke(c.gx, c.gy); if (e.preventDefault) e.preventDefault(); }
  function onMove(e) {
    var c = evtCell(e.clientX, e.clientY); hoverGx = c.gx; hoverGy = c.gy;
    if (painting) stroke(c.gx, c.gy);
  }
  function onUp() { if (painting) { painting = false; pushHistory(); } }
  function onTouch(e) {
    if (!e.touches || !e.touches.length) return;
    var tch = e.touches[0]; var c = evtCell(tch.clientX, tch.clientY);
    if (e.type === 'touchstart') painting = true;
    if (painting) { stroke(c.gx, c.gy); e.preventDefault(); }
  }

  function stroke(gx, gy) {
    var r = brushSize - 1;
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + r) continue; // roughly round
      paintCell(gx + dx, gy + dy);
    }
    syncTemp(); render();
  }
  function paintCell(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return;
    var i = gy * gw + gx;
    if (tool === 'eraser') { valBuf[i] = 0; alphaBuf[i] = 0; glowBuf[i] = 0; }
    else if (tool === 'glow') { glowBuf[i] = Math.round(glowStrength * 255); if (alphaBuf[i] === 0) { alphaBuf[i] = Math.round(opacity * 255); valBuf[i] = Math.round(shade * 255); } }
    else if (tool === 'fill') { floodFill(gx, gy); }
    else { valBuf[i] = Math.round(shade * 255); alphaBuf[i] = Math.round(opacity * 255); }
  }
  function floodFill(sx, sy) {
    var startI = sy * gw + sx; var targetA = alphaBuf[startI];
    var nv = Math.round(shade * 255), na = Math.round(opacity * 255);
    // fill the contiguous region with the same "filled-ness" (alpha bucket)
    var match = function (a) { return (targetA === 0) ? (a === 0) : (a > 0); };
    var stack = [[sx, sy]], seen = {};
    while (stack.length) {
      var p = stack.pop(), x = p[0], y = p[1];
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      var i = y * gw + x; if (seen[i]) continue; seen[i] = 1;
      if (!match(alphaBuf[i])) continue;
      valBuf[i] = nv; alphaBuf[i] = na;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  // ---- rendering ---------------------------------------------------------
  function render() {
    if (!ctx) return;
    canvas.width = gw * CELL; canvas.height = gh * CELL;
    var W = canvas.width, H = canvas.height;
    ctx.imageSmoothingEnabled = false;
    // checkerboard (transparency)
    for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) {
      ctx.fillStyle = ((x + y) & 1) ? '#14172270' : '#1c2030';
      // keep it subtle/dark
      ctx.fillStyle = ((x + y) & 1) ? '#171b29' : '#1f2435';
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
    var T = TX();
    if (mode === 'model' && T && T.drawCanon && previewChar) {
      // full canonical character (already wearing the temp texture)
      T.drawCanon(ctx, previewChar, 0, 0, CELL);
    } else {
      // faint character ghost for alignment, then the texture on top
      if (ghostChk && ghostChk.checked && T && T.drawCanon && previewChar) {
        ctx.globalAlpha = 0.22; T.drawCanon(ctx, ghostWithout(slot), 0, 0, CELL); ctx.globalAlpha = 1;
      }
      var tc = T && T.customCanvas ? T.customCanvas(TEMP_ID, baseColor) : null;
      if (tc) ctx.drawImage(tc, 0, 0, W, H);
    }
    // grid lines
    ctx.strokeStyle = 'rgba(127,249,224,0.10)'; ctx.lineWidth = 1;
    for (var gx2 = 0; gx2 <= gw; gx2 += 4) { ctx.beginPath(); ctx.moveTo(gx2 * CELL + 0.5, 0); ctx.lineTo(gx2 * CELL + 0.5, H); ctx.stroke(); }
    for (var gy2 = 0; gy2 <= gh; gy2 += 4) { ctx.beginPath(); ctx.moveTo(0, gy2 * CELL + 0.5); ctx.lineTo(W, gy2 * CELL + 0.5); ctx.stroke(); }
    // brush cursor
    if (hoverGx >= 0 && hoverGy >= 0) {
      var r = brushSize - 1;
      ctx.strokeStyle = '#ffe34d'; ctx.lineWidth = 2;
      ctx.strokeRect((hoverGx - r) * CELL, (hoverGy - r) * CELL, (2 * r + 1) * CELL, (2 * r + 1) * CELL);
    }
    drawPreview();
  }
  // a copy of the preview character WITHOUT the slot we're editing (for the ghost)
  function ghostWithout(s) {
    var c = cloneChar(previewChar); if (c.tex) { c.tex = assign({}, c.tex); delete c.tex[s]; } return c;
  }
  function drawPreview() {
    if (!prevCtx) return;
    var w = prevCanvas.width, h = prevCanvas.height;
    prevCtx.imageSmoothingEnabled = false; prevCtx.clearRect(0, 0, w, h);
    prevCtx.fillStyle = '#12151f'; prevCtx.fillRect(0, 0, w, h);
    var s = window.Sprites;
    if (s && s.drawCharacter && previewChar) {
      try { s.drawCharacter(prevCtx, previewChar, w / 2, h - 12, (h * 0.5) / 18, 1); } catch (e) { /* ignore */ }
    }
  }

  // ---- history -----------------------------------------------------------
  function snapshot() { return { v: valBuf.slice(0), a: alphaBuf.slice(0), g: glowBuf.slice(0), slot: slot }; }
  function applySnapshot(s) { valBuf.set(s.v); alphaBuf.set(s.a); glowBuf.set(s.g); slot = s.slot; if (slotSel) slotSel.value = slot; }
  function pushHistory() { history = history.slice(0, histIdx + 1); history.push(snapshot()); if (history.length > 50) history.shift(); histIdx = history.length - 1; }
  function undo() { if (histIdx > 0) { histIdx--; applySnapshot(history[histIdx]); syncTemp(); render(); setStatus(t('paint.undone', 'Undo')); } }
  function redo() { if (histIdx < history.length - 1) { histIdx++; applySnapshot(history[histIdx]); syncTemp(); render(); setStatus(t('paint.redone', 'Redo')); } }

  // ---- actions -----------------------------------------------------------
  function onClear() { clearBuffers(); pushHistory(); syncTemp(); render(); setStatus(t('paint.cleared', 'Cleared.')); }

  function buildRecord(id) {
    return {
      id: id, slot: slot, title: (titleInput.value || '').trim() || t('paint.untitled', 'Untitled'),
      glowColor: glowColor, tintHint: baseColor, createdAt: nowIso(), remixOf: remixOf || '',
      png: packPNG()
    };
  }
  function wear(id) {
    if (typeof App === 'undefined') return;
    var ch = cloneChar(App.character || (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
    ch.tex = assign({}, ch.tex); ch.tex[slot] = id;
    if (App.updateCharacter) App.updateCharacter(ch); else App.character = ch;
    if (window.Store && Store.isLoggedIn && Store.isLoggedIn() && Store.saveCharacterRemote) {
      try { Store.saveCharacterRemote(ch); } catch (e) { /* ignore */ }
    }
  }
  function onSave() {
    if (isEmpty()) { setStatus(t('paint.empty', 'Paint something first!')); return; }
    var id = uid(); var rec = buildRecord(id);
    if (window.Store && Store.saveLocalTexture) Store.saveLocalTexture(rec);
    var T = TX(); if (T && T.registerCustom) T.registerCustom({ id: id, slot: slot, glowColor: glowColor, tintHint: baseColor }, packPixels());
    wear(id);
    setStatus(t('paint.saved', 'Saved & worn — find it on your character.'));
  }
  function onPublish() {
    if (isEmpty()) { setStatus(t('paint.empty', 'Paint something first!')); return; }
    var id = uid(); var rec = buildRecord(id);
    if (window.Store && Store.saveLocalTexture) Store.saveLocalTexture(rec);
    var T = TX(); if (T && T.registerCustom) T.registerCustom({ id: id, slot: slot, glowColor: glowColor, tintHint: baseColor }, packPixels());
    wear(id);
    if (window.Market && Market.publishTexture) {
      setStatus(t('paint.publishing', 'Publishing…'));
      Market.publishTexture(rec).then(function () { setStatus(t('paint.published', 'Published to the marketplace — always free.')); })
        .catch(function (e) { setStatus((e && e.message) || t('paint.publishFail', 'Could not publish (saved locally).')); });
    } else {
      setStatus(t('paint.marketSoon', 'Saved & worn. The marketplace opens soon — then you can publish.'));
    }
  }
  function onBack() { hide(); if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu'); if (window.Menu && Menu.show) Menu.show(); }

  function isEmpty() { for (var i = 0; i < alphaBuf.length; i++) if (alphaBuf[i] || glowBuf[i]) return false; return true; }
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

  // ---- helpers -----------------------------------------------------------
  function assign(a, b) { a = a || {}; if (b) for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k]; return a; }
  function cloneChar(c) { try { return JSON.parse(JSON.stringify(c || {})); } catch (e) { return {}; } }
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }
  function shadeHex(hex, s) {
    var n = parseInt((hex || '#888888').slice(1), 16); var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    function h2(v) { v = Math.max(0, Math.min(255, Math.round(v * s))); return ('0' + v.toString(16)).slice(-2); }
    return '#' + h2(r) + h2(g) + h2(b);
  }

  // ---- loop --------------------------------------------------------------
  function loop() { animFrame++; if (shown) { drawPreview(); rafId = window.requestAnimationFrame(loop); } }

  // ---- public ------------------------------------------------------------
  function open(opts) {
    opts = opts || {};
    if (!built) build();
    shown = true;
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('create'); else root.classList.add('active');
    var T = TX();
    if (!(T && T.isReady && T.isReady())) {
      // Textures (and the canonical grid size) aren't loaded yet — defer.
      setStatus(t('paint.loading', 'Loading textures…'));
      if (T && T.onReady) T.onReady(function () { if (shown) reallyOpen(opts); });
      return;
    }
    reallyOpen(opts);
  }
  function reallyOpen(opts) {
    opts = opts || {};
    allocBuffers();
    clearBuffers();
    previewChar = cloneChar((typeof App !== 'undefined' && App.character) ? App.character : (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
    previewChar.tex = assign({}, previewChar.tex);
    remixOf = '';
    var startSlot = (opts.remix && opts.remix.slot) || opts.slot || slot;
    var afterLoad = function () { populateSlots(); setSlotTemp(slot); slotSel.value = slot; syncSeg(); syncShadeUi(); syncTemp(); render(); };
    if (opts.remix && opts.remix.png) {
      remixOf = opts.remix.id || '';
      baseColor = opts.remix.tintHint || baseColor; glowColor = opts.remix.glowColor || glowColor;
      slot = startSlot;
      loadFromPNG(opts.remix.png).then(function () { history = []; histIdx = -1; pushHistory(); afterLoad(); });
    } else {
      slot = startSlot;
      history = []; histIdx = -1; pushHistory();
      afterLoad();
    }
    if (titleInput) titleInput.value = (opts.remix && opts.remix.title) ? (opts.remix.title + ' (remix)') : '';
    if (rafId == null) rafId = window.requestAnimationFrame(loop);
    setStatus('');
  }
  function hide() { shown = false; if (rafId != null) { window.cancelAnimationFrame(rafId); rafId = null; } if (root && !(window.App && App.showScreen)) root.classList.remove('active'); }

  // ---- styles ------------------------------------------------------------
  function injectStyle() {
    if (document.getElementById('paint-style')) return;
    var css = [
      '#screen-create{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e7ecff;background:#0e111b;overflow:auto;}',
      '#screen-create *{box-sizing:border-box;}',
      '.pt-wrap{min-height:100%;display:flex;flex-direction:column;padding:10px 14px;gap:8px;}',
      '.pt-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}',
      '.pt-title{font-size:15px;color:#7ff9e0;text-shadow:2px 2px 0 #000;margin-right:auto;}',
      '.pt-lrow{display:flex;align-items:center;gap:7px;}',
      '.pt-llbl{font-size:8px;color:#8a93ad;}',
      '.pt-select{font-family:inherit;font-size:9px;color:#0e111b;background:#e7ecff;border:0;border-radius:5px;padding:7px;}',
      '.pt-seg{display:flex;border:2px solid #0a0c14;border-radius:6px;overflow:hidden;background:#0a0c14;}',
      '.pt-segbtn{font-family:inherit;font-size:9px;color:#aab3cc;background:#171c2b;border:0;padding:8px 11px;cursor:pointer;}',
      '.pt-segbtn.active{background:#7ff9e0;color:#0e111b;}',
      '.pt-stage{flex:1 1 auto;display:flex;gap:14px;min-height:0;}',
      '.pt-left{flex:1 1 56%;display:flex;flex-direction:column;gap:7px;min-width:240px;}',
      '.pt-box{flex:1 1 auto;background:#12151f;border:2px solid #2a3350;border-radius:8px;min-height:280px;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:8px;}',
      '.pt-canvas{max-width:100%;max-height:64vh;image-rendering:pixelated;cursor:crosshair;background:#171b29;}',
      '.pt-ghost{display:flex;align-items:center;gap:7px;font-size:8px;color:#aab3cc;}',
      '.pt-ghost input{width:15px;height:15px;accent-color:#7ff9e0;}',
      '.pt-hint{font-size:8px;color:#7ff9e0;line-height:1.5;}',
      '.pt-right{flex:1 1 44%;max-width:360px;display:flex;flex-direction:column;gap:8px;min-width:260px;overflow-y:auto;max-height:74vh;padding-right:4px;}',
      '.pt-card{background:#141826;border:1px solid #232a40;border-radius:8px;padding:8px 9px;display:flex;flex-direction:column;gap:7px;}',
      '.pt-cardlbl{font-size:9px;color:#ff9e2c;text-shadow:1px 1px 0 #000;}',
      '.pt-colrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.pt-color{width:38px;height:30px;border:2px solid #0a0c14;border-radius:5px;padding:0;background:#0a0c14;cursor:pointer;}',
      '.pt-ramp{display:flex;gap:4px;flex-wrap:wrap;}',
      '.pt-shade{width:22px;height:22px;border:2px solid #0a0c14;border-radius:4px;padding:0;cursor:pointer;}',
      '.pt-shade.active{outline:2px solid #7ff9e0;outline-offset:1px;}',
      '.pt-slider{width:100%;accent-color:#7ff9e0;}',
      '.pt-preview{display:flex;justify-content:center;}',
      '.pt-prevcanvas{image-rendering:pixelated;background:#12151f;border:2px solid #2a3350;border-radius:6px;}',
      '.pt-titleinput{font-family:inherit;font-size:10px;color:#0e111b;background:#e7ecff;border:0;border-radius:6px;padding:9px;width:100%;}',
      '.pt-actions{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;}',
      '.pt-btn{font-family:inherit;font-size:10px;color:#e7ecff;background:#222a40;border:0;border-radius:7px;padding:11px 14px;cursor:pointer;}',
      '.pt-btn:hover{background:#2c3656;}',
      '.pt-primary{background:#7ff9e0;color:#0e111b;}',
      '.pt-primary:hover{filter:brightness(1.08);background:#7ff9e0;}',
      '.pt-accent{background:#ff9e2c;color:#0e111b;}',
      '.pt-accent:hover{filter:brightness(1.08);background:#ff9e2c;}',
      '.pt-status{text-align:center;font-size:8px;color:#7ff9e0;min-height:11px;}',
      '@media(max-width:680px){.pt-stage{flex-direction:column;}.pt-right{max-width:none;max-height:none;}}'
    ].join('');
    var st = el('style'); st.id = 'paint-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Paint = { open: open, close: hide };
})();
