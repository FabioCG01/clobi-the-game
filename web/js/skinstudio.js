// skinstudio.js — the CLOBI CRAFT Skin Studio screen. Single global: SkinStudio.
//
// A full-screen Minecraft-skin editor living in #screen-studio:
//   - Left: a zoomable/pannable NET canvas — the flat 64×64 skin layout with
//     checkerboard transparency, per-part region outlines, hover part labels,
//     and an optional 25% template ghost underlay (Skins.templateCanvas).
//   - Right: a live 3D turntable preview (PlayerModel.attachTurntable) with
//     pose (stand/walk), per-layer visibility toggles and the classic/slim
//     model switch (repacks the 4px↔3px arm regions per the net table).
//   - Tools: pen / eraser / fill (region-bounded flood) / eyedropper / line /
//     mirror mode (paired-limb mirroring), brush 1–3 px, 50-step undo/redo,
//     24 curated swatches + HSV picker + alpha (alpha only on the overlay
//     layer — the base layer always paints opaque, like Minecraft renders it).
//   - Actions: New (template/current/blank), Import PNG (file or drag-drop),
//     Export PNG, Save to wardrobe (Store.saveSkin), Publish
//     (Store.marketPublishSkin) and a remix-lineage banner when remixing.
//
// Every edit happens on ONE canonical 64×64 canvas; the turntable shares that
// exact canvas reference (zero-copy) and is refreshed via a rAF-debounced
// turntable.setSkin() after each stroke.
//
// Public API (contract §5.17):  SkinStudio.show(opts?)  /  SkinStudio.hide()
//   opts: { skin (Skins skin), record (wardrobe rec), remixOf (market item),
//           fresh:bool }
//
// Depends on (all guarded, may load later / be absent in tests):
//   Skins (§5.7), PlayerModel (§5.8), Store (§5.19), I18n, Sound, App (router).
// The net geometry table below mirrors Skins.NET exactly (both are generated
// from the pinned table in docs/ARCHITECTURE-3D.md §5.7).
//
// No frameworks, no ES modules — this file assigns exactly one global.

var SkinStudio = (function () {
  'use strict';

  // ---- tiny helpers -------------------------------------------------------
  function t(k, en) { return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(k, en) : en; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function sfx(name) { if (typeof Sound !== 'undefined' && Sound.play) { try { Sound.play(name); } catch (e) { /* ignore */ } } }
  function hasApp() { return (typeof App !== 'undefined' && App && App.showScreen); }
  function validModel(m) { return m === 'classic' || m === 'slim'; }
  function nowIso() { try { return new Date().toISOString(); } catch (e) { return ''; } }
  function downloadURL(url, filename) {
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
  }

  // ---- THE NET: geometry tables (mirror of Skins.NET, contract §5.7) ------
  // Box unwrap rule for a box W×H×D at net origin (U,V):
  //   top=(U+D,V,W,D) bottom=(U+D+W,V,W,D) right=(U,V+D,D,H)
  //   front=(U+D,V+D,W,H) left=(U+D+W,V+D,D,H) back=(U+D+W+D,V+D,W,H)
  var PART_LIST = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
  var FACES = ['top', 'bottom', 'right', 'front', 'left', 'back'];
  var DIMS = {
    head: { w: 8, h: 8, d: 8 },
    body: { w: 8, h: 12, d: 4 },
    rightArm: { w: 4, h: 12, d: 4, arm: true },
    leftArm: { w: 4, h: 12, d: 4, arm: true },
    rightLeg: { w: 4, h: 12, d: 4 },
    leftLeg: { w: 4, h: 12, d: 4 }
  };
  var ORIGINS = {
    head: { base: [0, 0], overlay: [32, 0] },
    body: { base: [16, 16], overlay: [16, 32] },
    rightArm: { base: [40, 16], overlay: [40, 32] },
    leftArm: { base: [32, 48], overlay: [48, 48] },
    rightLeg: { base: [0, 16], overlay: [0, 32] },
    leftLeg: { base: [16, 48], overlay: [0, 48] }
  };
  var PART_COLORS = {
    head: '#ffd34d', body: '#7ff9e0', rightArm: '#ff9e2c',
    leftArm: '#ff6b6b', rightLeg: '#5da8ff', leftLeg: '#5dff8f'
  };
  var PART_KEYS = {
    head: ['vox.part.head', 'Head'], body: ['vox.part.body', 'Body'],
    rightArm: ['vox.part.rightArm', 'Right Arm'], leftArm: ['vox.part.leftArm', 'Left Arm'],
    rightLeg: ['vox.part.rightLeg', 'Right Leg'], leftLeg: ['vox.part.leftLeg', 'Left Leg']
  };
  var FACE_KEYS = {
    top: ['studio.face.top', 'Top'], bottom: ['studio.face.bottom', 'Bottom'],
    right: ['studio.face.right', 'Right'], front: ['studio.face.front', 'Front'],
    left: ['studio.face.left', 'Left'], back: ['studio.face.back', 'Back']
  };
  var MIRROR_PART = { leftArm: 'rightArm', rightArm: 'leftArm', leftLeg: 'rightLeg', rightLeg: 'leftLeg' };
  var MIRROR_FACE = { left: 'right', right: 'left' };

  var REGION_CACHE = {};   // model -> [ {part, layer, face, x, y, w, h} ... ]
  var MASK_CACHE = {};     // model -> 64×64 canvas dimming dead net space
  var TPL_CACHE = {};      // model -> Skins.templateCanvas(model)

  function regions(m) {
    var key = (m === 'slim') ? 'slim' : 'classic';
    if (REGION_CACHE[key]) return REGION_CACHE[key];
    var out = [];
    PART_LIST.forEach(function (part) {
      var dim = DIMS[part];
      var W = (dim.arm && key === 'slim') ? 3 : dim.w, H = dim.h, D = dim.d;
      ['base', 'overlay'].forEach(function (layer) {
        var o = ORIGINS[part][layer], U = o[0], V = o[1];
        var f = {
          top: [U + D, V, W, D],
          bottom: [U + D + W, V, W, D],
          right: [U, V + D, D, H],
          front: [U + D, V + D, W, H],
          left: [U + D + W, V + D, D, H],
          back: [U + D + W + D, V + D, W, H]
        };
        FACES.forEach(function (face) {
          var r = f[face];
          out.push({ part: part, layer: layer, face: face, x: r[0], y: r[1], w: r[2], h: r[3] });
        });
      });
    });
    REGION_CACHE[key] = out;
    return out;
  }
  function regionAtLocal(x, y, m) {
    var regs = regions(m);
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r;
    }
    return null;
  }
  function findIn(regs, part, layer, face) {
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      if (r.part === part && r.layer === layer && r.face === face) return r;
    }
    return null;
  }
  // Reverse lookup for hover labels — prefer the canonical Skins.regionAt.
  function regionInfoAt(x, y, m) {
    if (typeof Skins !== 'undefined' && Skins.regionAt) {
      try { return Skins.regionAt(x, y, m); } catch (e) { /* fall through */ }
    }
    var r = regionAtLocal(x, y, m);
    return r ? { part: r.part, layer: r.layer, face: r.face } : null;
  }
  // Mirror mapping: limb pairs mirror into the paired limb's matching face
  // (left/right faces swapped, x flipped inside the face rect); head/body
  // mirror across the same face rect's own vertical axis.
  function mirrorPixel(x, y, m) {
    var r = regionAtLocal(x, y, m);
    if (!r) return null;
    var rx = x - r.x, ry = y - r.y;
    var pair = MIRROR_PART[r.part];
    if (pair) {
      var pr = findIn(regions(m), pair, r.layer, MIRROR_FACE[r.face] || r.face);
      if (!pr) return null;
      return { x: pr.x + (pr.w - 1 - rx), y: pr.y + ry };
    }
    return { x: r.x + (r.w - 1 - rx), y: y };
  }
  function maskFor(m) {
    var key = (m === 'slim') ? 'slim' : 'classic';
    if (MASK_CACHE[key]) return MASK_CACHE[key];
    var c = mkCanvas(64, 64), cc = c.getContext('2d');
    cc.fillStyle = 'rgba(6,8,14,0.5)';
    cc.fillRect(0, 0, 64, 64);
    regions(key).forEach(function (r) { cc.clearRect(r.x, r.y, r.w, r.h); });
    MASK_CACHE[key] = c;
    return c;
  }
  function templateFor(m) {
    var key = (m === 'slim') ? 'slim' : 'classic';
    if (TPL_CACHE[key]) return TPL_CACHE[key];
    if (typeof Skins !== 'undefined' && Skins.templateCanvas) {
      try { TPL_CACHE[key] = Skins.templateCanvas(key); } catch (e) { TPL_CACHE[key] = null; }
    }
    return TPL_CACHE[key] || null;
  }

  // ---- color helpers ------------------------------------------------------
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m0 = v - c;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m0) * 255), Math.round((g + m0) * 255), Math.round((b + m0) * 255)];
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return [h, mx === 0 ? 0 : d / mx, mx];
  }
  function hexOf(r, g, b) {
    function p(n) { var s = n.toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + p(r) + p(g) + p(b);
  }
  function hexToRgb(hx) {
    hx = (hx || '#888888').replace('#', '');
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    var n = parseInt(hx.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var SWATCHES = [
    '#1b1b1b', '#4d4d4d', '#9a9a9a', '#e8e8e8', '#ffffff', '#5a2d0c',
    '#8b5a2b', '#b98753', '#e0b088', '#f4d5ae', '#a01818', '#e83b3b',
    '#ff8a2b', '#ffd23c', '#fff08a', '#3f7d20', '#6cc644', '#1f9e8a',
    '#4dd8ff', '#2f6bd8', '#1e2f8f', '#7a3cd6', '#e05ac8', '#7ff9e0'
  ];

  // ---- state ---------------------------------------------------------------
  var root = null, built = false, shown = false, session = 0, resumePending = false;
  // canvases
  var skinCanvas, sctx;          // the canonical 64×64 working canvas
  var viewCanvas, vctx;          // layer-dim composite for the net view
  var prevComp, pctx;            // composite for layer-visibility preview
  var checkerCv = null;          // 64×64 transparency checkerboard
  var netCv, netCtx, netWrap, hoverLbl;
  var cssW = 0, cssH = 0;
  // skin objects handed to the turntable
  var workSkin = null, prevSkinObj = null;
  var model = 'classic';
  // view transform (CSS px): skin pixel -> screen = view.ox + x*view.scale
  var view = { scale: 6, ox: 0, oy: 0 };
  // tools
  var tool = 'pen', prevTool = 'pen', brush = 1, mirrorMode = false, ghostOn = false, layer = 'base';
  // color (HSV + alpha; alpha applies to overlay layer only)
  var colH = 168, colS = 0.49, colV = 0.98, colA = 255;
  // gestures
  var pointers = [], pinch = null, panning = false, panLast = null, spaceDown = false, blockPaint = false;
  var strokeActive = false, strokeChanged = false, lastCell = null;
  var lineActive = false, lineStart = null, lineEnd = null;
  var hoverCell = null;
  var _pix = null;               // cached 1×1 ImageData for exact pixel writes
  // history
  var history = [], hIndex = -1, dirty = false;
  // meta
  var record = null, remixInfo = null, remixOf = '';
  // 3D preview
  var turntable = null, pose = 'stand', showBase = true, showOverlay = true, rafSkin = false;
  // ui refs
  var toolBtns = {}, brushBtns = {}, layerBtns = {}, poseBtns = {}, modelBtns = {};
  var mirrorBtn, ghostBtn, undoBtn, redoBtn;
  var svCv, svCtx, hueCv, hueCtx, alphaRange, alphaVal, chipFill, hexLbl;
  var prevCv, prevFallback, prevGroup;
  var visBaseChk, visOverChk;
  var remixBanner, fileInput;
  var toastWrap = null, openOverlay = null;

  // ---- DOM build -----------------------------------------------------------
  function build() {
    injectStyle();
    root = document.getElementById('screen-studio');
    if (!root) {
      root = el('div'); root.id = 'screen-studio'; root.className = 'screen';
      document.body.appendChild(root);
    }
    root.innerHTML = '';

    skinCanvas = mkCanvas(64, 64);
    sctx = skinCanvas.getContext('2d', { willReadFrequently: true });
    viewCanvas = mkCanvas(64, 64); vctx = viewCanvas.getContext('2d');
    prevComp = mkCanvas(64, 64); pctx = prevComp.getContext('2d');
    _pix = sctx.createImageData(1, 1);
    workSkin = { canvas: skinCanvas, model: model, dataURL: function () { return skinCanvas.toDataURL('image/png'); } };
    prevSkinObj = { canvas: prevComp, model: model, dataURL: function () { return prevComp.toDataURL('image/png'); } };
    buildChecker();

    var wrap = el('div', 'ss-wrap');
    wrap.appendChild(buildHead());
    remixBanner = el('div', 'ss-remix');
    remixBanner.style.display = 'none';
    wrap.appendChild(remixBanner);
    wrap.appendChild(buildToolbar());
    var stage = el('div', 'ss-stage');
    stage.appendChild(buildNetPanel());
    stage.appendChild(buildSide());
    wrap.appendChild(stage);
    root.appendChild(wrap);

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) importFile(fileInput.files[0]);
      fileInput.value = '';
    });
    root.appendChild(fileInput);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', function () { if (shown) resizeNet(); });
    window.addEventListener('beforeunload', function (e) {
      if (shown && dirty) { e.preventDefault(); e.returnValue = ''; }
    });
    built = true;
  }

  function buildChecker() {
    checkerCv = mkCanvas(64, 64);
    var cc = checkerCv.getContext('2d');
    for (var y = 0; y < 64; y++) for (var x = 0; x < 64; x++) {
      cc.fillStyle = ((x + y) & 1) ? '#232a40' : '#1a2033';
      cc.fillRect(x, y, 1, 1);
    }
  }

  function mkBtn(label, cls, fn, title) {
    var b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  }

  // ---- header: title + action buttons -------------------------------------
  function buildHead() {
    var head = el('div', 'ss-head');
    head.appendChild(el('div', 'ss-title', t('studio.title', 'Skin Studio')));
    head.appendChild(el('div', 'ss-spacer'));
    head.appendChild(mkBtn(t('studio.new', 'New…'), 'ss-btn', function () { sfx('click'); openNewModal(); }));
    head.appendChild(mkBtn(t('studio.import', 'Import'), 'ss-btn', function () { sfx('click'); fileInput.click(); }));
    head.appendChild(mkBtn(t('studio.export', 'Export'), 'ss-btn', function () { sfx('click'); exportPNG(); }));
    head.appendChild(mkBtn(t('studio.save', 'Save'), 'ss-btn primary', function () { sfx('click'); openSaveModal(null); }));
    head.appendChild(mkBtn(t('studio.publish', 'Publish…'), 'ss-btn accent', function () { sfx('click'); openPublishModal(); }));
    head.appendChild(mkBtn(t('common.back', 'Back'), 'ss-btn ghost', function () { sfx('click'); goBack(); }));
    return head;
  }

  // ---- toolbar: tools, brush, toggles, zoom, undo/redo ---------------------
  function buildToolbar() {
    var bar = el('div', 'ss-toolbar');
    var tools = [
      ['pen', t('studio.tool.pen', 'Pen'), 'B'],
      ['eraser', t('studio.tool.eraser', 'Eraser'), 'E'],
      ['fill', t('studio.tool.fill', 'Fill'), 'F'],
      ['picker', t('studio.tool.pick', 'Pick'), 'I'],
      ['line', t('studio.tool.line', 'Line'), 'L']
    ];
    var seg = el('div', 'ss-seg');
    tools.forEach(function (tt) {
      var b = mkBtn(tt[1], 'ss-segbtn', function () { setTool(tt[0]); }, tt[1] + ' (' + tt[2] + ')');
      toolBtns[tt[0]] = b;
      seg.appendChild(b);
    });
    bar.appendChild(seg);

    var bseg = el('div', 'ss-seg');
    bseg.appendChild(el('span', 'ss-lbl', t('studio.brush', 'Brush')));
    [1, 2, 3].forEach(function (n) {
      var b = mkBtn(String(n), 'ss-segbtn', function () { brush = n; syncBrushUI(); render(); }, t('studio.brush', 'Brush') + ' ' + n);
      brushBtns[n] = b;
      bseg.appendChild(b);
    });
    bar.appendChild(bseg);

    mirrorBtn = mkBtn(t('studio.mirror', 'Mirror'), 'ss-tgl', function () {
      mirrorMode = !mirrorMode; mirrorBtn.classList.toggle('on', mirrorMode); render();
    }, t('studio.mirror', 'Mirror') + ' (M)');
    bar.appendChild(mirrorBtn);
    ghostBtn = mkBtn(t('studio.ghost', 'Ghost'), 'ss-tgl', function () {
      ghostOn = !ghostOn; ghostBtn.classList.toggle('on', ghostOn); render();
    }, t('studio.ghost', 'Ghost') + ' (G)');
    bar.appendChild(ghostBtn);

    bar.appendChild(mkBtn('−', 'ss-tool', function () { zoomAt(cssW / 2, cssH / 2, 1 / 1.25); }, t('studio.zoomOut', 'Zoom out')));
    bar.appendChild(mkBtn('+', 'ss-tool', function () { zoomAt(cssW / 2, cssH / 2, 1.25); }, t('studio.zoomIn', 'Zoom in')));

    var sp = el('div', 'ss-spacer'); bar.appendChild(sp);
    undoBtn = mkBtn(t('studio.undo', 'Undo'), 'ss-btn', function () { undo(); }, 'Ctrl+Z');
    redoBtn = mkBtn(t('studio.redo', 'Redo'), 'ss-btn', function () { redo(); }, 'Ctrl+Y');
    bar.appendChild(undoBtn); bar.appendChild(redoBtn);
    return bar;
  }

  // ---- net panel ------------------------------------------------------------
  function buildNetPanel() {
    netWrap = el('div', 'ss-netwrap');
    netCv = el('canvas', 'ss-netcanvas');
    netCtx = netCv.getContext('2d');
    netWrap.appendChild(netCv);
    hoverLbl = el('div', 'ss-hoverlbl');
    hoverLbl.style.display = 'none';
    netWrap.appendChild(hoverLbl);

    netCv.addEventListener('pointerdown', onPointerDown);
    netCv.addEventListener('pointermove', onPointerMove);
    netCv.addEventListener('pointerup', onPointerUp);
    netCv.addEventListener('pointercancel', onPointerUp);
    netCv.addEventListener('pointerleave', function () {
      if (!strokeActive && !lineActive && !panning) { hoverCell = null; hoverLbl.style.display = 'none'; if (shown) render(); }
    });
    netCv.addEventListener('wheel', onWheel, { passive: false });
    netCv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // drag-drop skin import straight onto the net
    ['dragenter', 'dragover'].forEach(function (evn) {
      netWrap.addEventListener(evn, function (e) { e.preventDefault(); netWrap.classList.add('drag'); });
    });
    netWrap.addEventListener('dragleave', function () { netWrap.classList.remove('drag'); });
    netWrap.addEventListener('drop', function (e) {
      e.preventDefault(); netWrap.classList.remove('drag');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });
    return netWrap;
  }

  // ---- side panel: layer, color, preview ------------------------------------
  function buildSide() {
    var side = el('div', 'ss-side');

    // layer select
    var lg = el('div', 'ss-group');
    lg.appendChild(el('div', 'ss-grouplbl', t('studio.layer', 'Layer')));
    var lseg = el('div', 'ss-seg wide');
    [['base', t('studio.layer.base', 'Base')], ['overlay', t('studio.layer.overlay', 'Overlay')]].forEach(function (o) {
      var b = mkBtn(o[1], 'ss-segbtn', function () { setLayer(o[0]); });
      layerBtns[o[0]] = b;
      lseg.appendChild(b);
    });
    lg.appendChild(lseg);
    lg.appendChild(el('div', 'ss-note', t('studio.layerNote', 'Base paints opaque. Overlay supports transparency (hat, jacket, sleeves).')));
    side.appendChild(lg);

    // color
    var cg = el('div', 'ss-group');
    cg.appendChild(el('div', 'ss-grouplbl', t('studio.color', 'Color')));
    var chipRow = el('div', 'ss-row');
    var chip = el('div', 'ss-chip');
    chipFill = el('div', 'ss-chipfill');
    chip.appendChild(chipFill);
    chipRow.appendChild(chip);
    hexLbl = el('span', 'ss-hex', '#7ff9e0');
    chipRow.appendChild(hexLbl);
    cg.appendChild(chipRow);
    svCv = el('canvas', 'ss-sv'); svCv.width = 176; svCv.height = 120;
    svCtx = svCv.getContext('2d');
    cg.appendChild(svCv);
    hueCv = el('canvas', 'ss-hue'); hueCv.width = 176; hueCv.height = 14;
    hueCtx = hueCv.getContext('2d');
    cg.appendChild(hueCv);
    wireColorCanvas(svCv, pickSV);
    wireColorCanvas(hueCv, pickHue);
    var aRow = el('div', 'ss-row');
    aRow.appendChild(el('span', 'ss-lbl', t('studio.alpha', 'Alpha')));
    alphaRange = el('input');
    alphaRange.type = 'range'; alphaRange.min = '0'; alphaRange.max = '255'; alphaRange.step = '1'; alphaRange.value = '255';
    alphaRange.className = 'ss-alpha';
    alphaRange.addEventListener('input', function () { colA = +alphaRange.value; updateColorUI(); });
    aRow.appendChild(alphaRange);
    alphaVal = el('span', 'ss-lbl', '100%');
    aRow.appendChild(alphaVal);
    cg.appendChild(aRow);
    var sw = el('div', 'ss-swatches');
    SWATCHES.forEach(function (hx) {
      var b = el('button', 'ss-swatch');
      b.type = 'button'; b.style.background = hx; b.title = hx;
      b.addEventListener('click', function () {
        var rgb = hexToRgb(hx), hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
        colH = hsv[0]; colS = hsv[1]; colV = hsv[2];
        if (tool === 'eraser') setTool('pen');
        updateColorUI();
      });
      sw.appendChild(b);
    });
    cg.appendChild(sw);
    side.appendChild(cg);

    // 3D preview
    prevGroup = el('div', 'ss-group');
    var ph = el('div', 'ss-grouplbl row');
    ph.appendChild(el('span', null, t('studio.preview', 'Preview')));
    var collapse = mkBtn('▾', 'ss-collapsebtn', function () {
      prevGroup.classList.toggle('collapsed');
      collapse.textContent = prevGroup.classList.contains('collapsed') ? '▸' : '▾';
    }, t('studio.collapse', 'Collapse'));
    ph.appendChild(collapse);
    prevGroup.appendChild(ph);
    var pbody = el('div', 'ss-prevbody');
    prevCv = el('canvas', 'ss-prevcanvas'); prevCv.width = 220; prevCv.height = 275;
    pbody.appendChild(prevCv);
    prevFallback = el('div', 'ss-prevfallback', t('studio.noPreview', '3D preview unavailable.'));
    prevFallback.style.display = 'none';
    pbody.appendChild(prevFallback);

    var poseSeg = el('div', 'ss-seg wide');
    [['stand', t('studio.pose.stand', 'Stand')], ['walk', t('studio.pose.walk', 'Walk')]].forEach(function (o) {
      var b = mkBtn(o[1], 'ss-segbtn', function () {
        pose = o[0]; setSeg(poseBtns, pose);
        if (turntable && turntable.setPose) { try { turntable.setPose(pose); } catch (e) { /* ignore */ } }
      });
      poseBtns[o[0]] = b;
      poseSeg.appendChild(b);
    });
    pbody.appendChild(poseSeg);

    var visRow = el('div', 'ss-row');
    visBaseChk = mkCheck(t('studio.show.base', 'Base'), true, function (on) { showBase = on; scheduleRefresh(); });
    visOverChk = mkCheck(t('studio.show.overlay', 'Overlay'), true, function (on) { showOverlay = on; scheduleRefresh(); });
    visRow.appendChild(visBaseChk.wrap); visRow.appendChild(visOverChk.wrap);
    pbody.appendChild(visRow);

    var mRow = el('div', 'ss-row');
    mRow.appendChild(el('span', 'ss-lbl', t('studio.model', 'Model')));
    var mSeg = el('div', 'ss-seg');
    [['classic', t('studio.model.classic', 'Classic')], ['slim', t('studio.model.slim', 'Slim')]].forEach(function (o) {
      var b = mkBtn(o[1], 'ss-segbtn', function () { if (o[0] !== model) openModelConfirm(o[0]); });
      modelBtns[o[0]] = b;
      mSeg.appendChild(b);
    });
    mRow.appendChild(mSeg);
    pbody.appendChild(mRow);
    prevGroup.appendChild(pbody);
    side.appendChild(prevGroup);
    return side;
  }

  function mkCheck(label, on0, fn) {
    var wrap = el('label', 'ss-check');
    var input = el('input'); input.type = 'checkbox'; input.checked = !!on0;
    input.addEventListener('change', function () { fn(!!input.checked); });
    wrap.appendChild(input);
    wrap.appendChild(el('span', null, label));
    return { wrap: wrap, input: input };
  }
  function setSeg(map, val) {
    Object.keys(map).forEach(function (k) { map[k].classList.toggle('active', k === val); });
  }
  function setTool(v) {
    if (v !== 'picker' && tool !== 'picker') prevTool = tool;
    if (v === 'picker' && tool !== 'picker') prevTool = tool;
    tool = v;
    setSeg(toolBtns, tool);
    updateCursor();
    render();
  }
  function setLayer(l) {
    layer = (l === 'overlay') ? 'overlay' : 'base';
    setSeg(layerBtns, layer);
    updateColorUI();
    render();
  }
  function syncBrushUI() { setSeg(brushBtns, String(brush)); }
  function syncToolUI() {
    setSeg(toolBtns, tool); syncBrushUI(); setSeg(layerBtns, layer);
    setSeg(poseBtns, pose); setSeg(modelBtns, model);
    mirrorBtn.classList.toggle('on', mirrorMode);
    ghostBtn.classList.toggle('on', ghostOn);
    if (visBaseChk) visBaseChk.input.checked = showBase;
    if (visOverChk) visOverChk.input.checked = showOverlay;
  }

  // ---- net rendering --------------------------------------------------------
  function render() {
    if (!netCtx || !shown) return;
    var dpr = window.devicePixelRatio || 1;
    netCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    netCtx.imageSmoothingEnabled = false;
    netCtx.fillStyle = '#0d1120';
    netCtx.fillRect(0, 0, cssW, cssH);
    var s = view.scale, ox = view.ox, oy = view.oy, B = 64 * s;

    // board drop shadow + transparency checkerboard
    netCtx.fillStyle = 'rgba(0,0,0,0.35)';
    netCtx.fillRect(ox + 4, oy + 4, B, B);
    netCtx.drawImage(checkerCv, ox, oy, B, B);

    // template ghost underlay (25%)
    if (ghostOn) {
      var tpl = templateFor(model);
      if (tpl) {
        netCtx.globalAlpha = 0.25;
        netCtx.drawImage(tpl, ox, oy, B, B);
        netCtx.globalAlpha = 1;
      }
    }

    // skin content with active/inactive layer treatment
    rebuildViewCanvas();
    netCtx.drawImage(viewCanvas, ox, oy, B, B);

    // dim dead (non-region) net space
    netCtx.drawImage(maskFor(model), ox, oy, B, B);

    drawOutlines(s, ox, oy);
    drawGrid(s, ox, oy);
    drawLinePreview(s, ox, oy);
    drawHover(s, ox, oy);
  }

  // Compose the 64×64 view: the active layer at full strength, the other
  // dimmed to 40%; when editing the overlay, base content shows through
  // underneath each overlay rect so you can see what you are covering.
  function rebuildViewCanvas() {
    vctx.clearRect(0, 0, 64, 64);
    var regs = regions(model);
    function blit(r) { vctx.drawImage(skinCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h); }
    var i, r;
    if (layer === 'overlay') {
      vctx.globalAlpha = 0.4;
      for (i = 0; i < regs.length; i++) { if (regs[i].layer === 'base') blit(regs[i]); }
      vctx.globalAlpha = 1;
      for (i = 0; i < regs.length; i++) {
        r = regs[i];
        if (r.layer !== 'overlay') continue;
        var b = findIn(regs, r.part, 'base', r.face);
        if (b) vctx.drawImage(skinCanvas, b.x, b.y, b.w, b.h, r.x, r.y, r.w, r.h);
      }
      for (i = 0; i < regs.length; i++) { if (regs[i].layer === 'overlay') blit(regs[i]); }
    } else {
      vctx.globalAlpha = 1;
      for (i = 0; i < regs.length; i++) { if (regs[i].layer === 'base') blit(regs[i]); }
      vctx.globalAlpha = 0.4;
      for (i = 0; i < regs.length; i++) { if (regs[i].layer === 'overlay') blit(regs[i]); }
      vctx.globalAlpha = 1;
    }
  }

  function drawOutlines(s, ox, oy) {
    var regs = regions(model);
    netCtx.lineWidth = 1;
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      netCtx.globalAlpha = (r.layer === layer) ? 0.5 : 0.16;
      netCtx.strokeStyle = PART_COLORS[r.part] || '#ffffff';
      netCtx.strokeRect(ox + r.x * s + 0.5, oy + r.y * s + 0.5, r.w * s - 1, r.h * s - 1);
    }
    netCtx.globalAlpha = 1;
  }

  function drawGrid(s, ox, oy) {
    var B = 64 * s;
    if (s >= 8) {
      for (var i = 0; i <= 64; i++) {
        netCtx.strokeStyle = (i % 8 === 0) ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.045)';
        netCtx.lineWidth = 1;
        netCtx.beginPath();
        netCtx.moveTo(ox + i * s + 0.5, oy); netCtx.lineTo(ox + i * s + 0.5, oy + B);
        netCtx.stroke();
        netCtx.beginPath();
        netCtx.moveTo(ox, oy + i * s + 0.5); netCtx.lineTo(ox + B, oy + i * s + 0.5);
        netCtx.stroke();
      }
    }
    netCtx.strokeStyle = 'rgba(127,249,224,0.35)';
    netCtx.lineWidth = 1;
    netCtx.strokeRect(ox + 0.5, oy + 0.5, B - 1, B - 1);
  }

  function drawLinePreview(s, ox, oy) {
    if (!lineActive || !lineStart || !lineEnd) return;
    var rgb = hsvToRgb(colH, colS, colV);
    var fillMain = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.6)';
    var fillMir = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.35)';
    var off = Math.floor((brush - 1) / 2);
    bres(lineStart.x, lineStart.y, lineEnd.x, lineEnd.y, function (cx, cy) {
      for (var dy = 0; dy < brush; dy++) for (var dx = 0; dx < brush; dx++) {
        var px = cx + dx - off, py = cy + dy - off;
        if (px < 0 || py < 0 || px > 63 || py > 63) continue;
        netCtx.fillStyle = fillMain;
        netCtx.fillRect(ox + px * s, oy + py * s, s, s);
        if (mirrorMode) {
          var m = mirrorPixel(px, py, model);
          if (m && (m.x !== px || m.y !== py)) {
            netCtx.fillStyle = fillMir;
            netCtx.fillRect(ox + m.x * s, oy + m.y * s, s, s);
          }
        }
      }
    });
  }

  function drawHover(s, ox, oy) {
    if (!hoverCell || hoverCell.x < 0 || hoverCell.y < 0 || hoverCell.x > 63 || hoverCell.y > 63) return;
    var off = Math.floor((brush - 1) / 2);
    netCtx.strokeStyle = '#ffe34d';
    netCtx.lineWidth = 1.5;
    netCtx.strokeRect(ox + (hoverCell.x - off) * s, oy + (hoverCell.y - off) * s, brush * s, brush * s);
    if (mirrorMode) {
      var m = mirrorPixel(hoverCell.x, hoverCell.y, model);
      if (m && (m.x !== hoverCell.x || m.y !== hoverCell.y)) {
        netCtx.globalAlpha = 0.55;
        netCtx.strokeRect(ox + (m.x - off) * s, oy + (m.y - off) * s, brush * s, brush * s);
        netCtx.globalAlpha = 1;
      }
    }
  }

  // ---- view / coordinates ---------------------------------------------------
  function resizeNet() {
    if (!netWrap) return;
    var r = netWrap.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var dpr = window.devicePixelRatio || 1;
    cssW = r.width; cssH = r.height;
    var pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (netCv.width !== pw || netCv.height !== ph) { netCv.width = pw; netCv.height = ph; }
    clampView();
    render();
  }
  // The screen may still be display:none when show() runs (the router adds
  // .active around the same time) — retry until layout gives us a size.
  function ensureSized(tries) {
    resizeNet();
    if (cssW < 2 && tries > 0) {
      requestAnimationFrame(function () { ensureSized(tries - 1); });
      return;
    }
    fitView();
    render();
  }
  function fitView() {
    if (cssW < 2) return;
    var s = Math.floor(Math.min(cssW, cssH) / 68);
    view.scale = clamp(s || 4, 4, 16);
    view.ox = Math.round((cssW - 64 * view.scale) / 2);
    view.oy = Math.round((cssH - 64 * view.scale) / 2);
  }
  function clampView() {
    var B = 64 * view.scale;
    view.ox = clamp(view.ox, 48 - B, Math.max(48 - B + 1, cssW - 48));
    view.oy = clamp(view.oy, 48 - B, Math.max(48 - B + 1, cssH - 48));
  }
  function cellFromEvent(e) {
    var r = netCv.getBoundingClientRect();
    var cx = e.clientX - r.left, cy = e.clientY - r.top;
    return {
      x: Math.floor((cx - view.ox) / view.scale),
      y: Math.floor((cy - view.oy) / view.scale),
      cssX: cx, cssY: cy
    };
  }
  function zoomAt(cx, cy, f) {
    var ns = clamp(view.scale * f, 4, 16);
    if (ns === view.scale) return;
    var k = ns / view.scale;
    view.ox = cx - (cx - view.ox) * k;
    view.oy = cy - (cy - view.oy) * k;
    view.scale = ns;
    clampView();
    render();
  }
  function onWheel(e) {
    if (!shown) return;
    e.preventDefault();
    var r = netCv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }
  function updateCursor() {
    if (!netCv) return;
    netCv.style.cursor = (spaceDown || panning) ? 'grab' : 'crosshair';
  }
  function updateHoverLabel(c) {
    if (!hoverLbl) return;
    if (c.x < 0 || c.y < 0 || c.x > 63 || c.y > 63) { hoverLbl.style.display = 'none'; return; }
    var info = regionInfoAt(c.x, c.y, model);
    if (!info) { hoverLbl.style.display = 'none'; return; }
    var pk = PART_KEYS[info.part] || [null, info.part];
    var fk = FACE_KEYS[info.face] || [null, info.face];
    var ln = (info.layer === 'overlay') ? t('studio.layer.overlay', 'Overlay') : t('studio.layer.base', 'Base');
    hoverLbl.textContent = t(pk[0], pk[1]) + ' / ' + ln + ' / ' + t(fk[0], fk[1]);
    hoverLbl.style.display = '';
    var lx = clamp(c.cssX + 14, 4, Math.max(4, cssW - 150));
    var ly = clamp(c.cssY + 16, 4, Math.max(4, cssH - 30));
    hoverLbl.style.left = lx + 'px';
    hoverLbl.style.top = ly + 'px';
  }

  // ---- pointers & gestures --------------------------------------------------
  function findPointer(id) {
    for (var i = 0; i < pointers.length; i++) if (pointers[i].id === id) return i;
    return -1;
  }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  function onPointerDown(e) {
    if (!shown) return;
    try { netCv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (findPointer(e.pointerId) < 0) pointers.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
    if (e.button === 1) e.preventDefault();
    if (pointers.length === 2) { startPinch(); return; }
    if (pointers.length > 2) return;

    var c = cellFromEvent(e);
    if (e.button === 1 || spaceDown) {
      panning = true; panLast = { x: c.cssX, y: c.cssY };
      updateCursor();
      return;
    }
    if (blockPaint || e.button === 2) return;

    if (tool === 'picker') { pickAt(c.x, c.y); return; }
    if (tool === 'fill') {
      var ch = floodFill(c.x, c.y);
      if (ch) { pushHistory(); dirty = true; render(); scheduleRefresh(); }
      return;
    }
    if (tool === 'line') {
      lineActive = true;
      lineStart = { x: c.x, y: c.y };
      lineEnd = { x: c.x, y: c.y };
      render();
      return;
    }
    // pen / eraser stroke
    strokeActive = true; strokeChanged = false;
    lastCell = { x: c.x, y: c.y };
    if (dab(c.x, c.y)) strokeChanged = true;
    render(); scheduleRefresh();
  }

  function onPointerMove(e) {
    if (!shown) return;
    var idx = findPointer(e.pointerId);
    if (idx >= 0) { pointers[idx].x = e.clientX; pointers[idx].y = e.clientY; }
    if (pinch && pointers.length >= 2) { updatePinch(); return; }

    var c = cellFromEvent(e);
    hoverCell = { x: c.x, y: c.y };
    updateHoverLabel(c);

    if (panning && panLast) {
      view.ox += c.cssX - panLast.x;
      view.oy += c.cssY - panLast.y;
      panLast = { x: c.cssX, y: c.cssY };
      clampView(); render();
      return;
    }
    if (strokeActive) {
      var lc = lastCell || { x: c.x, y: c.y };
      lastCell = { x: c.x, y: c.y };
      var changed = false;
      bres(lc.x, lc.y, c.x, c.y, function (px, py) { if (dab(px, py)) changed = true; });
      if (changed) strokeChanged = true;
      render(); scheduleRefresh();
      return;
    }
    if (lineActive) { lineEnd = { x: c.x, y: c.y }; render(); return; }
    render();
  }

  function onPointerUp(e) {
    var idx = findPointer(e.pointerId);
    if (idx >= 0) pointers.splice(idx, 1);
    try { netCv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (pinch && pointers.length < 2) pinch = null;
    if (pointers.length === 0) blockPaint = false;
    if (panning && pointers.length === 0) { panning = false; updateCursor(); }
    if (strokeActive && pointers.length === 0) {
      strokeActive = false;
      if (strokeChanged) { pushHistory(); dirty = true; }
      strokeChanged = false;
    }
    if (lineActive && pointers.length === 0) {
      lineActive = false;
      var changed = false;
      if (lineStart && lineEnd) {
        bres(lineStart.x, lineStart.y, lineEnd.x, lineEnd.y, function (px, py) { if (dab(px, py)) changed = true; });
      }
      lineStart = lineEnd = null;
      if (changed) { pushHistory(); dirty = true; }
      render(); scheduleRefresh();
    }
  }

  // Two fingers: cancel any in-flight stroke (revert to the last committed
  // snapshot) and switch into pan/pinch-zoom mode until all fingers lift.
  function startPinch() {
    if (strokeActive) {
      strokeActive = false;
      if (strokeChanged && hIndex >= 0) { applySnap(history[hIndex]); scheduleRefresh(); }
      strokeChanged = false;
    }
    lineActive = false; lineStart = lineEnd = null;
    panning = false;
    blockPaint = true;
    var p0 = pointers[0], p1 = pointers[1];
    var r = netCv.getBoundingClientRect();
    pinch = {
      d0: dist(p0, p1) || 1,
      mid: { x: (p0.x + p1.x) / 2 - r.left, y: (p0.y + p1.y) / 2 - r.top },
      scale0: view.scale, ox0: view.ox, oy0: view.oy
    };
  }
  function updatePinch() {
    var p0 = pointers[0], p1 = pointers[1];
    var r = netCv.getBoundingClientRect();
    var m = { x: (p0.x + p1.x) / 2 - r.left, y: (p0.y + p1.y) / 2 - r.top };
    var d = dist(p0, p1) || 1;
    var ns = clamp(pinch.scale0 * (d / pinch.d0), 4, 16);
    var f = ns / pinch.scale0;
    view.scale = ns;
    view.ox = m.x - (pinch.mid.x - pinch.ox0) * f;
    view.oy = m.y - (pinch.mid.y - pinch.oy0) * f;
    clampView();
    render();
  }

  // ---- keyboard ---------------------------------------------------------------
  function onKeyDown(e) {
    if (!shown) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') { if (!spaceDown) { spaceDown = true; updateCursor(); } e.preventDefault(); return; }
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { redo(); e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'b' || k === 'p') setTool('pen');
    else if (k === 'e') setTool('eraser');
    else if (k === 'f') setTool('fill');
    else if (k === 'i') setTool('picker');
    else if (k === 'l') setTool('line');
    else if (k === 'm') { mirrorMode = !mirrorMode; mirrorBtn.classList.toggle('on', mirrorMode); render(); }
    else if (k === 'g') { ghostOn = !ghostOn; ghostBtn.classList.toggle('on', ghostOn); render(); }
    else if (k === '1' || k === '2' || k === '3') { brush = +k; syncBrushUI(); render(); }
  }
  function onKeyUp(e) {
    if (e.code === 'Space') { spaceDown = false; updateCursor(); }
  }

  // ---- paint operations ---------------------------------------------------
  // Exact pixel replacement (no blending) via 1×1 putImageData. Painting is
  // restricted to the ACTIVE layer's net regions; the base layer always
  // paints alpha 255 (Minecraft renders base opaque).
  function putPixel(x, y, erase) {
    if (x < 0 || y < 0 || x > 63 || y > 63) return false;
    var r = regionAtLocal(x, y, model);
    if (!r || r.layer !== layer) return false;
    var d = _pix.data;
    if (erase) { d[0] = 0; d[1] = 0; d[2] = 0; d[3] = 0; }
    else {
      var rgb = hsvToRgb(colH, colS, colV);
      d[0] = rgb[0]; d[1] = rgb[1]; d[2] = rgb[2];
      d[3] = (layer === 'base') ? 255 : colA;
    }
    sctx.putImageData(_pix, x, y);
    return true;
  }
  function dab(x, y) {
    var erase = (tool === 'eraser');
    var off = Math.floor((brush - 1) / 2);
    var changed = false;
    for (var dy = 0; dy < brush; dy++) for (var dx = 0; dx < brush; dx++) {
      var px = x + dx - off, py = y + dy - off;
      if (putPixel(px, py, erase)) changed = true;
      if (mirrorMode) {
        var m = mirrorPixel(px, py, model);
        if (m && (m.x !== px || m.y !== py) && putPixel(m.x, m.y, erase)) changed = true;
      }
    }
    return changed;
  }
  function bres(x0, y0, x1, y1, cb) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    for (; ;) {
      cb(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // Flood fill bounded by the seed pixel's net face rect — never leaks across
  // regions. Matches the seed's exact RGBA. Mirror mode floods the paired
  // region from the mirrored seed too.
  function floodFill(x, y) {
    var r = regionAtLocal(x, y, model);
    if (!r || r.layer !== layer) return false;
    var changed = fillInRegion(r, x, y);
    if (mirrorMode) {
      var m = mirrorPixel(x, y, model);
      if (m && (m.x !== x || m.y !== y)) {
        var mr = regionAtLocal(m.x, m.y, model);
        if (mr && mr.layer === layer) changed = fillInRegion(mr, m.x, m.y) || changed;
      }
    }
    return changed;
  }
  function fillInRegion(r, sx, sy) {
    var img = sctx.getImageData(r.x, r.y, r.w, r.h);
    var d = img.data, w = r.w, h = r.h;
    var lx = sx - r.x, ly = sy - r.y;
    var si = (ly * w + lx) * 4;
    var c0 = [d[si], d[si + 1], d[si + 2], d[si + 3]];
    var rgb = hsvToRgb(colH, colS, colV);
    var nc = (tool === 'eraser') ? [0, 0, 0, 0] : [rgb[0], rgb[1], rgb[2], (layer === 'base') ? 255 : colA];
    if (c0[0] === nc[0] && c0[1] === nc[1] && c0[2] === nc[2] && c0[3] === nc[3]) return false;
    var stack = [[lx, ly]];
    while (stack.length) {
      var p = stack.pop(), px = p[0], py = p[1];
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      var i = (py * w + px) * 4;
      if (d[i] !== c0[0] || d[i + 1] !== c0[1] || d[i + 2] !== c0[2] || d[i + 3] !== c0[3]) continue;
      d[i] = nc[0]; d[i + 1] = nc[1]; d[i + 2] = nc[2]; d[i + 3] = nc[3];
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    sctx.putImageData(img, r.x, r.y);
    return true;
  }

  // Eyedropper: pick color (+ alpha on the overlay layer) from any region,
  // then hop back to the previous drawing tool.
  function pickAt(x, y) {
    if (x < 0 || y < 0 || x > 63 || y > 63) return;
    var d = sctx.getImageData(x, y, 1, 1).data;
    if (d[3] === 0) return;
    var hsv = rgbToHsv(d[0], d[1], d[2]);
    colH = hsv[0]; colS = hsv[1]; colV = hsv[2];
    if (layer === 'overlay') colA = d[3];
    updateColorUI();
    setTool((prevTool && prevTool !== 'picker') ? prevTool : 'pen');
  }

  // ---- history (50-step full snapshots) ------------------------------------
  function snapshot() { return { img: sctx.getImageData(0, 0, 64, 64), model: model }; }
  function applySnap(s) {
    sctx.putImageData(s.img, 0, 0);
    if (s.model !== model) setModelState(s.model);
  }
  function resetHistory() {
    history = [snapshot()];
    hIndex = 0;
    updateHistoryBtns();
  }
  function pushHistory() {
    history = history.slice(0, hIndex + 1);
    history.push(snapshot());
    if (history.length > 50) history.shift();
    hIndex = history.length - 1;
    updateHistoryBtns();
  }
  function undo() {
    if (hIndex <= 0) return;
    hIndex--;
    applySnap(history[hIndex]);
    dirty = true;
    updateHistoryBtns();
    render(); scheduleRefresh();
  }
  function redo() {
    if (hIndex >= history.length - 1) return;
    hIndex++;
    applySnap(history[hIndex]);
    dirty = true;
    updateHistoryBtns();
    render(); scheduleRefresh();
  }
  function updateHistoryBtns() {
    if (undoBtn) undoBtn.disabled = hIndex <= 0;
    if (redoBtn) redoBtn.disabled = hIndex >= history.length - 1;
  }

  // ---- color UI --------------------------------------------------------------
  function wireColorCanvas(cv, pickFn) {
    var down = false;
    cv.addEventListener('pointerdown', function (e) {
      down = true;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      pickFn(e); e.preventDefault();
    });
    cv.addEventListener('pointermove', function (e) { if (down) pickFn(e); });
    cv.addEventListener('pointerup', function () { down = false; });
    cv.addEventListener('pointercancel', function () { down = false; });
  }
  function pickSV(e) {
    var r = svCv.getBoundingClientRect();
    colS = clamp((e.clientX - r.left) / r.width, 0, 1);
    colV = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    if (tool === 'eraser') setTool('pen');
    updateColorUI();
  }
  function pickHue(e) {
    var r = hueCv.getBoundingClientRect();
    colH = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
    if (tool === 'eraser') setTool('pen');
    updateColorUI();
  }
  function updateColorUI() {
    if (!svCtx) return;
    var w = svCv.width, h = svCv.height;
    // SV square: hue base + white→transparent (x) + transparent→black (y)
    var hueRgb = hsvToRgb(colH, 1, 1);
    svCtx.fillStyle = 'rgb(' + hueRgb[0] + ',' + hueRgb[1] + ',' + hueRgb[2] + ')';
    svCtx.fillRect(0, 0, w, h);
    var gw = svCtx.createLinearGradient(0, 0, w, 0);
    gw.addColorStop(0, 'rgba(255,255,255,1)'); gw.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = gw; svCtx.fillRect(0, 0, w, h);
    var gb = svCtx.createLinearGradient(0, 0, 0, h);
    gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,1)');
    svCtx.fillStyle = gb; svCtx.fillRect(0, 0, w, h);
    // marker
    var mx = colS * w, my = (1 - colV) * h;
    svCtx.beginPath(); svCtx.arc(mx, my, 5, 0, Math.PI * 2);
    svCtx.strokeStyle = '#000'; svCtx.lineWidth = 3; svCtx.stroke();
    svCtx.beginPath(); svCtx.arc(mx, my, 5, 0, Math.PI * 2);
    svCtx.strokeStyle = '#fff'; svCtx.lineWidth = 1.5; svCtx.stroke();

    // hue bar
    var hw = hueCv.width, hh = hueCv.height;
    var gh = hueCtx.createLinearGradient(0, 0, hw, 0);
    for (var i = 0; i <= 6; i++) {
      var rgb = hsvToRgb(i * 60, 1, 1);
      gh.addColorStop(i / 6, 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')');
    }
    hueCtx.fillStyle = gh; hueCtx.fillRect(0, 0, hw, hh);
    var hx = (colH / 360) * hw;
    hueCtx.fillStyle = '#000'; hueCtx.fillRect(hx - 2, 0, 4, hh);
    hueCtx.fillStyle = '#fff'; hueCtx.fillRect(hx - 1, 0, 2, hh);

    // chip + hex + alpha
    var cur = hsvToRgb(colH, colS, colV);
    var a = (layer === 'base') ? 255 : colA;
    if (chipFill) chipFill.style.background = 'rgba(' + cur[0] + ',' + cur[1] + ',' + cur[2] + ',' + (a / 255) + ')';
    if (hexLbl) hexLbl.textContent = hexOf(cur[0], cur[1], cur[2]);
    if (alphaRange) {
      alphaRange.disabled = (layer === 'base');
      alphaRange.value = String(layer === 'base' ? 255 : colA);
    }
    if (alphaVal) alphaVal.textContent = Math.round((a / 255) * 100) + '%';
  }

  // ---- 3D preview / turntable -------------------------------------------------
  function attachPreview() {
    if (turntable) return;
    if (typeof PlayerModel !== 'undefined' && PlayerModel.attachTurntable) {
      try {
        turntable = PlayerModel.attachTurntable(prevCv, currentPreviewSkin(), {});
        if (turntable && turntable.setPose) turntable.setPose(pose);
        prevFallback.style.display = 'none';
        prevCv.style.display = '';
        return;
      } catch (e) { turntable = null; }
    }
    prevFallback.style.display = '';
    prevCv.style.display = 'none';
  }
  // Zero-copy when both layers are visible (the turntable holds our canonical
  // canvas); otherwise composite only the visible layers' regions.
  function currentPreviewSkin() {
    if (showBase && showOverlay) { workSkin.model = model; return workSkin; }
    pctx.clearRect(0, 0, 64, 64);
    var regs = regions(model);
    for (var i = 0; i < regs.length; i++) {
      var r = regs[i];
      if ((r.layer === 'base') ? showBase : showOverlay) {
        pctx.drawImage(skinCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      }
    }
    prevSkinObj.model = model;
    return prevSkinObj;
  }
  function scheduleRefresh() {
    if (rafSkin) return;
    rafSkin = true;
    requestAnimationFrame(function () {
      rafSkin = false;
      if (turntable && turntable.setSkin) {
        try { turntable.setSkin(currentPreviewSkin()); } catch (e) { /* ignore */ }
      }
    });
  }
  function setModelState(m) {
    model = validModel(m) ? m : 'classic';
    if (workSkin) workSkin.model = model;
    if (prevSkinObj) prevSkinObj.model = model;
    setSeg(modelBtns, model);
    if (turntable && turntable.setModel) {
      try { turntable.setModel(model); } catch (e) { /* ignore */ }
    }
  }

  // ---- classic ⇄ slim conversion ---------------------------------------------
  // Repacks all four arm regions (left/right × base/overlay) per the net table:
  // 4→3 px crops the 4th pixel column of the W-wide faces; 3→4 px duplicates
  // the edge column. Right/left side faces (D wide) move but keep their pixels.
  function openModelConfirm(target) {
    var msg = (target === 'slim')
      ? t('studio.slimWarn', 'Switching to the slim model crops one pixel column from each arm. Continue?')
      : t('studio.classicWarn', 'Switching to the classic model widens the arms by duplicating the edge pixel column. Continue?');
    var body = [el('div', 'ss-note big', msg)];
    var actions = [
      mkBtn(t('common.cancel', 'Cancel'), 'ss-btn ghost', function () { closeModal(); }),
      mkBtn(t('studio.convert', 'Convert'), 'ss-btn primary', function () {
        closeModal();
        convertModel(target);
        sfx('click');
      })
    ];
    openModalShell(t('studio.modelSwitch', 'Switch model?'), body, actions);
  }
  function convertModel(target) {
    if (!validModel(target) || target === model) return;
    var srcRegs = regions(model), dstRegs = regions(target);
    var widen = (target === 'classic'); // 3 → 4
    ['rightArm', 'leftArm'].forEach(function (part) {
      ['base', 'overlay'].forEach(function (lay) {
        // capture every face before clearing the arm's net area
        var caps = {};
        FACES.forEach(function (face) {
          var sr = findIn(srcRegs, part, lay, face);
          var c = mkCanvas(sr.w, sr.h);
          c.getContext('2d').drawImage(skinCanvas, sr.x, sr.y, sr.w, sr.h, 0, 0, sr.w, sr.h);
          caps[face] = c;
        });
        var o = ORIGINS[part][lay];
        sctx.clearRect(o[0], o[1], 16, 16);   // max arm extent (2·D + 2·4 = 16)
        FACES.forEach(function (face) {
          var dr = findIn(dstRegs, part, lay, face);
          var cap = caps[face];
          if (face === 'right' || face === 'left') {
            sctx.drawImage(cap, 0, 0, cap.width, cap.height, dr.x, dr.y, dr.w, dr.h);
          } else if (widen) {
            sctx.drawImage(cap, 0, 0, 3, cap.height, dr.x, dr.y, 3, dr.h);
            sctx.drawImage(cap, 2, 0, 1, cap.height, dr.x + 3, dr.y, 1, dr.h);
          } else {
            sctx.drawImage(cap, 0, 0, 3, cap.height, dr.x, dr.y, 3, dr.h);
          }
        });
      });
    });
    setModelState(target);
    pushHistory();
    dirty = true;
    render();
    scheduleRefresh();
  }

  // ---- adopting content --------------------------------------------------------
  function adoptCanvas(c, m) {
    sctx.clearRect(0, 0, 64, 64);
    if (c) { try { sctx.drawImage(c, 0, 0); } catch (e) { /* ignore */ } }
    if (validModel(m)) setModelState(m);
  }
  function adoptSkin(skin) {
    if (!skin) return;
    adoptCanvas(skin.canvas, skin.model);
  }
  function resolveActiveSkin() {
    return new Promise(function (resolve, reject) {
      function fallbackDefault() {
        if (typeof Skins !== 'undefined' && Skins.loadDefault) Skins.loadDefault().then(resolve, reject);
        else reject(new Error('skins unavailable'));
      }
      var rec = (typeof Store !== 'undefined' && Store.getActiveSkin) ? Store.getActiveSkin() : null;
      if (rec && rec.png && typeof Skins !== 'undefined' && Skins.load) {
        Skins.load(rec.png).then(function (s) {
          resolve({ canvas: s.canvas, model: validModel(rec.model) ? rec.model : s.model });
        }, fallbackDefault);
      } else {
        fallbackDefault();
      }
    });
  }

  // ---- actions: new / import / export ------------------------------------------
  function openNewModal() {
    function opt(label, desc, fn) {
      var b = el('button', 'ss-newopt');
      b.type = 'button';
      b.appendChild(el('strong', null, label));
      b.appendChild(el('span', null, desc));
      b.addEventListener('click', function () { closeModal(); fn(); });
      return b;
    }
    var body = [
      opt(t('studio.newTemplate', 'From template'),
        t('studio.newTemplateDesc', 'Start from the color-coded region template.'),
        function () { newReset(templateFor(model), model, ''); }),
      opt(t('studio.newCurrent', 'From current skin'),
        t('studio.newCurrentDesc', 'Start from the skin you are wearing.'),
        function () {
          resolveActiveSkin().then(function (skin) {
            if (!shown) return;
            var rec = (typeof Store !== 'undefined' && Store.getActiveSkin) ? Store.getActiveSkin() : null;
            newReset(skin.canvas, skin.model, (rec && rec.remixOf) || '');
          }).catch(function () {
            toast(t('studio.loadFail', 'Could not load the current skin.'), true);
          });
        }),
      opt(t('studio.newBlank', 'Blank'),
        t('studio.newBlankDesc', 'A completely transparent canvas.'),
        function () { newReset(null, model, ''); }),
      el('div', 'ss-note', t('studio.newUndoNote', 'Your previous work stays one Undo away.'))
    ];
    var actions = [
      mkBtn(t('studio.downloadTemplate', 'Download template PNG'), 'ss-btn ghost', function () {
        var tpl = templateFor(model);
        if (tpl) downloadURL(tpl.toDataURL('image/png'), 'template_' + model + '.png');
        else toast(t('studio.unavailable', 'Not available right now.'), true);
      }),
      mkBtn(t('common.cancel', 'Cancel'), 'ss-btn', function () { closeModal(); })
    ];
    openModalShell(t('studio.newTitle', 'New skin'), body, actions);
  }
  function newReset(canvas, m, keepRemixOf) {
    adoptCanvas(canvas, m);
    record = null; remixInfo = null; remixOf = keepRemixOf || '';
    updateBanner();
    pushHistory();
    dirty = false;
    render();
    scheduleRefresh();
  }

  function importFile(file) {
    if (!file) return;
    if (typeof Skins === 'undefined' || !Skins.load) {
      toast(t('studio.unavailable', 'Not available right now.'), true);
      return;
    }
    Skins.load(file).then(function (skin) {
      if (!shown) return;
      adoptSkin(skin);
      pushHistory();
      dirty = true;
      updateBanner();
      render();
      scheduleRefresh();
      toast(t('studio.imported', 'Skin imported.'));
    }).catch(function () {
      toast(t('vox.err.badSkin', 'Not a valid Minecraft skin PNG (64×64 or 64×32 needed).'), true);
    });
  }

  function exportPNG() {
    downloadURL(skinCanvas.toDataURL('image/png'), 'skin.png');
  }

  // ---- save to wardrobe ----------------------------------------------------------
  function openSaveModal(afterFn) {
    var input = el('input', 'ss-input');
    input.type = 'text'; input.maxLength = 32;
    input.value = (record && record.name) || t('studio.untitled', 'My Clobi Skin');
    var errEl = el('div', 'ss-err');
    var body = [
      el('label', 'ss-label', t('studio.nameLabel', 'Skin name')),
      input, errEl
    ];
    function doSave() {
      var name = (input.value || '').trim() || t('studio.untitled', 'My Clobi Skin');
      if (typeof Store === 'undefined' || !Store.saveSkin) {
        errEl.textContent = t('studio.unavailable', 'Not available right now.');
        return;
      }
      var rec = { name: name, model: model, png: skinCanvas.toDataURL('image/png'), createdAt: nowIso() };
      if (record && record.id) rec.id = record.id;
      if (remixOf) rec.remixOf = remixOf;
      try {
        var saved = Store.saveSkin(rec);
        record = (saved && saved.name) ? saved : rec;
      } catch (e) {
        errEl.textContent = (e && e.message) || t('studio.saveFail', 'Save failed.');
        return;
      }
      dirty = false;
      closeModal();
      toast(t('studio.saved', 'Saved to wardrobe.'));
      sfx('click');
      if (afterFn) afterFn();
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSave(); });
    var actions = [
      mkBtn(t('common.cancel', 'Cancel'), 'ss-btn ghost', function () { closeModal(); }),
      mkBtn(t('studio.saveBtn', 'Save'), 'ss-btn primary', doSave)
    ];
    openModalShell(t('studio.saveTitle', 'Save to wardrobe'), body, actions);
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 0);
  }

  // ---- publish to the marketplace --------------------------------------------------
  function openPublishModal() {
    if (typeof Store === 'undefined' || !Store.isLoggedIn || !Store.isLoggedIn()) {
      toast(t('market.signinFirst', 'Sign in to publish.'), true);
      if (window.Menu && Menu.openSignIn) { try { Menu.openSignIn(); } catch (e) { /* ignore */ } }
      return;
    }
    var titleIn = el('input', 'ss-input');
    titleIn.type = 'text'; titleIn.maxLength = 48;
    titleIn.value = (record && record.name) || '';
    var tagsIn = el('input', 'ss-input');
    tagsIn.type = 'text'; tagsIn.maxLength = 120;
    tagsIn.placeholder = t('studio.tagsPh', 'penguin, tuxedo, retro');
    var errEl = el('div', 'ss-err');
    var body = [
      el('label', 'ss-label', t('studio.titleLabel', 'Title')),
      titleIn,
      el('label', 'ss-label', t('studio.tagsLabel', 'Tags (comma-separated, max 8)')),
      tagsIn,
      el('div', 'ss-note', t('studio.freeNote', 'Everything published is free and community-moderated. Remixes keep their lineage.')),
      errEl
    ];
    var pubBtn = mkBtn(t('studio.publishBtn', 'Publish'), 'ss-btn accent', function () {
      var title = (titleIn.value || '').trim();
      if (!title) { errEl.textContent = t('studio.needTitle', 'Give your skin a title.'); return; }
      if (!Store.marketPublishSkin) { errEl.textContent = t('studio.unavailable', 'Not available right now.'); return; }
      var tags = (tagsIn.value || '').split(',').map(function (x) { return x.trim(); })
        .filter(function (x) { return !!x; }).slice(0, 8);
      pubBtn.disabled = true;
      errEl.textContent = '';
      var payload = { title: title, tags: tags, model: model, png: skinCanvas.toDataURL('image/png') };
      if (remixOf) payload.remixOf = remixOf;
      Store.marketPublishSkin(payload).then(function (res) {
        closeModal();
        var item = (res && res.item) || res || {};
        var flagged = !!(item.censored || item.flagged || item.pending || (res && (res.flagged || res.pending)));
        toast(flagged
          ? t('studio.pendingReview', 'Published — hidden until a moderator review clears it.')
          : t('studio.published', 'Published to the marketplace — always free.'));
        sfx('click');
      }).catch(function (err) {
        pubBtn.disabled = false;
        errEl.textContent = (err && err.message) || t('studio.publishFail', 'Publish failed.');
      });
    });
    var actions = [
      mkBtn(t('common.cancel', 'Cancel'), 'ss-btn ghost', function () { closeModal(); }),
      pubBtn
    ];
    openModalShell(t('studio.publishTitle', 'Publish skin'), body, actions);
    setTimeout(function () { try { titleIn.focus(); } catch (e) { /* ignore */ } }, 0);
  }

  // ---- remix banner -------------------------------------------------------------
  function updateBanner() {
    if (!remixBanner) return;
    if (!remixInfo && !remixOf) { remixBanner.style.display = 'none'; return; }
    remixBanner.innerHTML = '';
    var lead = t('studio.remixBanner', 'Remixing');
    var credit;
    if (remixInfo) {
      credit = '"' + (remixInfo.title || remixInfo.id || '?') + '"';
      if (remixInfo.author) credit += ' ' + t('studio.by', 'by') + ' ' + remixInfo.author;
    } else {
      credit = '#' + remixOf;
    }
    remixBanner.appendChild(el('span', 'ss-remix-lead', lead + ': '));
    remixBanner.appendChild(el('span', 'ss-remix-credit', credit));
    remixBanner.appendChild(el('span', 'ss-remix-note', ' — ' + t('studio.lineage', 'lineage is kept when you save or publish.')));
    remixBanner.style.display = '';
  }

  // ---- modals & toast --------------------------------------------------------------
  function modalRoot() {
    var host = document.getElementById('modal-root');
    if (!host) { host = el('div'); host.id = 'modal-root'; document.body.appendChild(host); }
    return host;
  }
  function closeModal() {
    if (!openOverlay) return;
    if (openOverlay._onKey) document.removeEventListener('keydown', openOverlay._onKey);
    if (openOverlay.parentNode) openOverlay.parentNode.removeChild(openOverlay);
    openOverlay = null;
  }
  function openModalShell(titleText, bodyNodes, actionBtns) {
    closeModal();
    var overlay = el('div', 'ss-overlay');
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    var modal = el('div', 'ss-modal');
    var head = el('div', 'ss-modal-head');
    head.appendChild(el('div', 'ss-modal-title', titleText));
    head.appendChild(mkBtn('✕', 'ss-modal-x', closeModal, t('common.close', 'Close')));
    modal.appendChild(head);
    var body = el('div', 'ss-modal-body');
    (bodyNodes || []).forEach(function (n) { body.appendChild(n); });
    modal.appendChild(body);
    if (actionBtns && actionBtns.length) {
      var act = el('div', 'ss-modal-actions');
      actionBtns.forEach(function (b) { act.appendChild(b); });
      modal.appendChild(act);
    }
    overlay.appendChild(modal);
    var onKey = function (e) { if (e.key === 'Escape') closeModal(); };
    overlay._onKey = onKey;
    document.addEventListener('keydown', onKey);
    modalRoot().appendChild(overlay);
    openOverlay = overlay;
    return overlay;
  }
  function toast(msg, isErr) {
    if (!toastWrap) { toastWrap = el('div', 'ss-toasts'); document.body.appendChild(toastWrap); }
    var d = el('div', 'ss-toast' + (isErr ? ' err' : ''), msg);
    toastWrap.appendChild(d);
    setTimeout(function () {
      d.classList.add('out');
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 350);
    }, 2800);
  }

  // ---- unsaved-changes guard ----------------------------------------------------
  function openUnsavedModal() {
    var body = [el('div', 'ss-note big', t('studio.unsavedMsg', 'You have unsaved changes in the Skin Studio.'))];
    var actions = [
      mkBtn(t('studio.keepEditing', 'Keep editing'), 'ss-btn ghost', function () {
        closeModal();
        resumeStudio();
      }),
      mkBtn(t('studio.discard', 'Discard'), 'ss-btn danger', function () {
        dirty = false;
        closeModal();
      }),
      mkBtn(t('studio.saveFirst', 'Save to wardrobe'), 'ss-btn primary', function () {
        closeModal();
        openSaveModal(null);
      })
    ];
    openModalShell(t('studio.unsavedTitle', 'Unsaved changes'), body, actions);
  }
  function resumeStudio() {
    resumePending = true;
    if (hasApp()) App.showScreen('studio');
    else show();
  }
  function goBack() {
    // Leaving triggers hide() (via the router when present), which runs the
    // unsaved-changes guard.
    if (hasApp()) App.showScreen('menu');
    else hide();
  }

  // ---- lifecycle -----------------------------------------------------------------
  function show(opts) {
    opts = opts || {};
    if (!built) build();

    if (resumePending) {
      // returning from the unsaved-changes guard: keep canvas/history intact
      resumePending = false;
      shown = true;
      if (!hasApp()) root.classList.add('active');
      attachPreview();
      ensureSizedKeepView(30);
      return;
    }

    shown = true;
    session++;
    var mySession = session;
    if (!hasApp()) root.classList.add('active');

    // meta
    record = opts.record || null;
    remixInfo = opts.remixOf || null;
    remixOf = (remixInfo && (remixInfo.id || remixInfo.marketId)) || (record && record.remixOf) || '';

    // reset editor state
    tool = 'pen'; prevTool = 'pen'; brush = 1;
    mirrorMode = false; ghostOn = false; layer = 'base';
    pose = 'stand'; showBase = true; showOverlay = true;
    spaceDown = false; panning = false; pinch = null; blockPaint = false;
    strokeActive = false; lineActive = false; lineStart = lineEnd = null;
    hoverCell = null; pointers = [];
    colA = 255;
    dirty = false;

    sctx.clearRect(0, 0, 64, 64);
    setModelState((opts.skin && opts.skin.model) ||
      (record && record.model) || (remixInfo && remixInfo.model) || 'classic');
    resetHistory();
    syncToolUI();
    updateColorUI();
    updateBanner();
    updateCursor();
    if (prevGroup) {
      prevGroup.classList.toggle('collapsed', window.innerWidth < 860);
      var cb = prevGroup.querySelector('.ss-collapsebtn');
      if (cb) cb.textContent = prevGroup.classList.contains('collapsed') ? '▸' : '▾';
    }
    attachPreview();
    ensureSized(30);

    // resolve initial content (async — session-guarded)
    var p;
    if (opts.skin && opts.skin.canvas) {
      p = Promise.resolve(opts.skin);
    } else if (record && record.png && typeof Skins !== 'undefined' && Skins.load) {
      p = Skins.load(record.png).then(function (s) {
        return { canvas: s.canvas, model: validModel(record.model) ? record.model : s.model };
      });
    } else if (remixInfo && remixInfo.png && typeof Skins !== 'undefined' && Skins.load) {
      p = Skins.load(remixInfo.png).then(function (s) {
        return { canvas: s.canvas, model: validModel(remixInfo.model) ? remixInfo.model : s.model };
      });
    } else if (opts.fresh) {
      p = Promise.resolve({ canvas: templateFor('classic'), model: 'classic' });
    } else {
      p = resolveActiveSkin();
    }
    p.then(function (skin) {
      if (session !== mySession || !shown) return;
      adoptSkin(skin);
      resetHistory();
      dirty = false;
      render();
      scheduleRefresh();
    }).catch(function () {
      if (session !== mySession || !shown) return;
      adoptCanvas(templateFor(model), model);
      resetHistory();
      render();
      scheduleRefresh();
    });
  }
  function ensureSizedKeepView(tries) {
    resizeNet();
    if (cssW < 2 && tries > 0) {
      requestAnimationFrame(function () { ensureSizedKeepView(tries - 1); });
      return;
    }
    render();
  }

  function hide() {
    if (!shown) return;
    shown = false;
    if (turntable) {
      try { turntable.destroy(); } catch (e) { /* ignore */ }
      turntable = null;
    }
    if (!hasApp() && root) root.classList.remove('active');
    hoverCell = null;
    if (hoverLbl) hoverLbl.style.display = 'none';
    pointers = []; pinch = null; panning = false; strokeActive = false; lineActive = false;
    closeModal();
    // Unsaved-changes guard: the screen has already been left (the router owns
    // switching), but the work is intact on our canvas — offer to save it.
    if (dirty) openUnsavedModal();
  }

  // ---- styles --------------------------------------------------------------------
  function injectStyle() {
    if (document.getElementById('skinstudio-style')) return;
    var css = [
      '#screen-studio{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e7ecff;background:#0c0f18;overflow:hidden;}',
      '#screen-studio *{box-sizing:border-box;}',
      '.ss-wrap{height:100%;display:flex;flex-direction:column;gap:10px;padding:12px 14px;}',
      '.ss-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ss-title{font-size:14px;color:#7ff9e0;text-shadow:2px 2px 0 #000;margin-right:6px;}',
      '.ss-spacer{flex:1 1 auto;}',
      '.ss-lbl{font-size:8px;color:#7e89a8;text-transform:uppercase;letter-spacing:1px;flex:0 0 auto;}',
      '.ss-btn{font-family:inherit;font-size:9px;color:#e7ecff;background:#1c2235;border:1px solid #313a55;border-radius:8px;padding:10px 13px;min-height:38px;cursor:pointer;}',
      '.ss-btn:hover{background:#26304a;}',
      '.ss-btn:disabled{opacity:.4;cursor:default;}',
      '.ss-btn.primary{background:#7ff9e0;color:#0c0f18;border-color:#7ff9e0;font-weight:bold;}',
      '.ss-btn.primary:hover{background:#a5fbe9;}',
      '.ss-btn.accent{background:#ff9e2c;color:#0c0f18;border-color:#ff9e2c;}',
      '.ss-btn.accent:hover{background:#ffb45c;}',
      '.ss-btn.danger{background:#3a1620;color:#ff8d8d;border-color:#66283a;}',
      '.ss-btn.ghost{background:transparent;}',
      '.ss-remix{font-size:8px;line-height:1.7;color:#ffd34d;background:#221c0e;border:1px solid #4d4222;border-radius:8px;padding:8px 12px;}',
      '.ss-remix-credit{color:#ffe9a3;}',
      '.ss-remix-note{color:#a99b64;}',
      '.ss-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ss-seg{display:inline-flex;align-items:center;background:#10141f;border:1px solid #313a55;border-radius:8px;overflow:hidden;gap:0;}',
      '.ss-seg.wide{display:flex;}',
      '.ss-seg.wide .ss-segbtn{flex:1 1 auto;}',
      '.ss-seg .ss-lbl{padding:0 8px;}',
      '.ss-segbtn{font-family:inherit;font-size:9px;color:#9aa6c4;background:transparent;border:0;padding:10px 12px;min-height:38px;cursor:pointer;}',
      '.ss-segbtn:hover{color:#e7ecff;}',
      '.ss-segbtn.active{background:#7ff9e0;color:#0c0f18;}',
      '.ss-tool{font-family:inherit;font-size:12px;color:#e7ecff;background:#1c2235;border:1px solid #313a55;border-radius:8px;min-width:38px;min-height:38px;cursor:pointer;}',
      '.ss-tool:hover{background:#26304a;}',
      '.ss-tgl{font-family:inherit;font-size:9px;color:#9aa6c4;background:#161b29;border:1px solid #313a55;border-radius:8px;padding:10px 12px;min-height:38px;cursor:pointer;}',
      '.ss-tgl.on{background:#ffe34d;color:#0c0f18;border-color:#ffe34d;}',
      '.ss-stage{flex:1 1 auto;display:flex;gap:12px;min-height:0;}',
      '.ss-netwrap{flex:1 1 auto;position:relative;background:#10141f;border:1px solid #283150;border-radius:12px;overflow:hidden;min-width:0;min-height:0;touch-action:none;}',
      '.ss-netwrap.drag{border-color:#7ff9e0;box-shadow:0 0 0 2px rgba(127,249,224,.35) inset;}',
      '.ss-netcanvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;cursor:crosshair;touch-action:none;}',
      '.ss-hoverlbl{position:absolute;z-index:5;pointer-events:none;background:rgba(10,12,20,.92);border:1px solid #313a55;border-radius:6px;padding:5px 8px;font-size:8px;color:#cfd6ea;white-space:nowrap;}',
      '.ss-side{flex:0 0 300px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding-right:4px;}',
      '.ss-group{background:#11151f;border:1px solid #232c45;border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:9px;}',
      '.ss-grouplbl{font-size:8px;color:#ff9e2c;text-transform:uppercase;letter-spacing:1px;}',
      '.ss-grouplbl.row{display:flex;align-items:center;justify-content:space-between;}',
      '.ss-collapsebtn{font-family:inherit;font-size:10px;color:#9aa6c4;background:transparent;border:1px solid #313a55;border-radius:6px;min-width:28px;min-height:24px;cursor:pointer;}',
      '.ss-group.collapsed .ss-prevbody{display:none;}',
      '.ss-prevbody{display:flex;flex-direction:column;gap:9px;}',
      '.ss-prevcanvas{align-self:center;background:#0d1120;border:1px solid #283150;border-radius:8px;max-width:100%;touch-action:none;}',
      '.ss-prevfallback{font-size:8px;color:#6f7aa0;text-align:center;padding:20px 6px;}',
      '.ss-note{font-size:7px;color:#6f7aa0;line-height:1.7;}',
      '.ss-note.big{font-size:9px;color:#cfd6ea;line-height:1.8;}',
      '.ss-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ss-chip{width:44px;height:32px;border:1px solid #313a55;border-radius:7px;overflow:hidden;flex:0 0 auto;',
      'background-image:linear-gradient(45deg,#2a3147 25%,transparent 25%,transparent 75%,#2a3147 75%),linear-gradient(45deg,#2a3147 25%,#1a2033 25%,#1a2033 75%,#2a3147 75%);background-size:12px 12px;background-position:0 0,6px 6px;}',
      '.ss-chipfill{width:100%;height:100%;}',
      '.ss-hex{font-size:9px;color:#cfd6ea;}',
      '.ss-sv{width:100%;border-radius:8px;border:1px solid #313a55;cursor:crosshair;touch-action:none;display:block;}',
      '.ss-hue{width:100%;border-radius:7px;border:1px solid #313a55;cursor:ew-resize;touch-action:none;display:block;}',
      '.ss-alpha{flex:1 1 auto;accent-color:#7ff9e0;min-width:60px;}',
      '.ss-swatches{display:grid;grid-template-columns:repeat(8,1fr);gap:5px;}',
      '.ss-swatch{height:26px;border:1px solid rgba(0,0,0,.5);border-radius:6px;cursor:pointer;padding:0;}',
      '.ss-swatch:hover{outline:2px solid #7ff9e0;}',
      '.ss-check{display:flex;align-items:center;gap:6px;font-size:8px;color:#cfd6ea;cursor:pointer;}',
      '.ss-check input{width:16px;height:16px;accent-color:#7ff9e0;}',
      // modals (self-contained — appended to #modal-root)
      '.ss-overlay{position:fixed;inset:0;background:rgba(8,9,16,.82);display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px;font-family:"Press Start 2P",monospace;}',
      '.ss-modal{background:#161b29;border:2px solid #7ff9e0;border-radius:10px;box-shadow:8px 8px 0 #0a0b14;width:100%;max-width:400px;max-height:88vh;overflow-y:auto;color:#e7ecff;display:flex;flex-direction:column;}',
      '.ss-modal-head{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-bottom:2px solid #283150;}',
      '.ss-modal-title{font-size:11px;color:#7ff9e0;}',
      '.ss-modal-x{font-family:inherit;font-size:10px;color:#9aa6c4;background:transparent;border:1px solid #313a55;border-radius:6px;min-width:30px;min-height:30px;cursor:pointer;}',
      '.ss-modal-x:hover{color:#0c0f18;background:#ff6b6b;border-color:#ff6b6b;}',
      '.ss-modal-body{padding:14px;display:flex;flex-direction:column;gap:10px;}',
      '.ss-modal-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:0 14px 14px;}',
      '.ss-label{font-size:8px;color:#9aa3bf;letter-spacing:1px;text-transform:uppercase;}',
      '.ss-input{font-family:inherit;font-size:10px;color:#e7ecff;background:#1a2030;border:1px solid #313a55;border-radius:7px;padding:10px;width:100%;}',
      '.ss-err{font-size:8px;color:#ff6b6b;line-height:1.6;min-height:10px;}',
      '.ss-newopt{font-family:inherit;display:flex;flex-direction:column;gap:5px;text-align:left;background:#1a2030;border:1px solid #313a55;border-radius:8px;padding:12px;cursor:pointer;color:#e7ecff;}',
      '.ss-newopt:hover{border-color:#7ff9e0;background:#20283c;}',
      '.ss-newopt strong{font-size:9px;color:#7ff9e0;}',
      '.ss-newopt span{font-size:7px;color:#8b96b5;line-height:1.6;}',
      // toasts
      '.ss-toasts{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:9500;pointer-events:none;font-family:"Press Start 2P",monospace;}',
      '.ss-toast{font-size:9px;color:#0c0f18;background:#7ff9e0;border-radius:8px;padding:11px 15px;box-shadow:4px 4px 0 #0a0b14;opacity:1;transition:opacity .3s,transform .3s;max-width:80vw;text-align:center;line-height:1.6;}',
      '.ss-toast.err{background:#ff6b6b;color:#fff;}',
      '.ss-toast.out{opacity:0;transform:translateY(8px);}',
      // mobile: stack vertically, net on top, big touch targets
      '@media(max-width:860px){',
      '.ss-wrap{padding:8px;gap:8px;}',
      '.ss-stage{flex-direction:column;}',
      '.ss-side{flex:0 0 auto;overflow-y:visible;padding-right:0;}',
      '.ss-netwrap{min-height:340px;flex:1 0 340px;}',
      '.ss-btn,.ss-tgl{min-height:44px;}',
      '.ss-segbtn,.ss-tool{min-height:44px;min-width:44px;}',
      '.ss-swatch{height:36px;}',
      '.ss-title{font-size:11px;}',
      '}'
    ].join('');
    var st = el('style');
    st.id = 'skinstudio-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---- public API (contract §5.17) --------------------------------------------
  return { show: show, hide: hide };
})();

window.SkinStudio = SkinStudio;
