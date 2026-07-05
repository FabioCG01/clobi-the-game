// market.js — the skin Marketplace screen (3D voxel era). Global: window.Market.
//
// Browse every published Minecraft-format skin as a live 3D preview card,
// search / sort / filter by model (classic|slim), open an item for a big
// draggable turntable, then: Try on (session only), Wear (set active skin),
// Download (save a copy to the wardrobe), or Remix (opens the Skin Studio
// with lineage). Community moderation is ported from the 2D-era market:
// half-star ratings, threaded comments, report / "false report" vouch with
// live counts, author/admin delete, admin ban + revoke; censored items render
// a blurred placeholder silhouette until their reports are resolved.
//
// Publishing does NOT happen here — skins are published from the Skin Studio
// or the Wardrobe; the toolbar button just routes there with a toast.
// Lifecycle: Market.show()/Market.hide() own #screen-market (called by
// App.showScreen('market'); safe to call standalone too).
//
// Depends on globals: Store (skin + market wrappers, §5.19), I18n, Skins,
// PlayerModel (3D previews) — and optionally App, SkinStudio, Menu, Sound.
(function () {
  'use strict';

  // ---- tiny helpers -------------------------------------------------------
  function t(k, en) { return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(k, en) : en; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function loggedIn() { return !!(window.Store && Store.isLoggedIn && Store.isLoggedIn()); }
  function isAdmin() { return !!(window.Store && Store.isAdmin && Store.isAdmin()); }
  function meName() { return (window.Store && Store.getUsername && Store.getUsername()) || ''; }
  function sfx(name) { try { if (window.Sound && Sound.play) Sound.play(name); } catch (e) { /* ignore */ } }
  function noop() { }

  // ---- state --------------------------------------------------------------
  var root = null, built = false;
  var gridEl, statusEl, searchInput, sortSel, modelSel;
  var items = [];
  var filters = { q: '', sort: 'new', model: '' };
  var searchTimer = null;
  var activeTurntable = null;   // PlayerModel.attachTurntable handle (modal)
  var openOverlay = null;       // the currently-open detail modal overlay

  // skin/thumbnail caches, keyed by market item id
  var skinCache = {};   // id -> Promise<skin>   (Skins.load result, model forced)
  var thumbCache = {};  // id -> master canvas   (PlayerModel.preview output)
  var thumbQueue = [];  // pending {item, box} thumbnail jobs
  var thumbPumping = false;

  // ---- skin loading + 3D thumbnails ---------------------------------------

  // Resolve (and cache) the decoded skin object for a market item. The item's
  // own `model` field wins over auto-detection — the publisher chose it.
  function skinFor(item) {
    if (!skinCache[item.id]) {
      if (!item.png || !(window.Skins && Skins.load)) {
        skinCache[item.id] = Promise.reject(new Error('no skin data'));
      } else {
        skinCache[item.id] = Skins.load(item.png).then(function (skin) {
          if (item.model === 'classic' || item.model === 'slim') skin.model = item.model;
          return skin;
        });
      }
      skinCache[item.id].catch(noop); // swallow so nothing logs "unhandled"
    }
    return skinCache[item.id];
  }

  // Resolve a fresh thumbnail canvas for an item (the master render is cached;
  // clones are handed out because a canvas can only live in one DOM spot).
  function thumbFor(item) {
    if (thumbCache[item.id]) return Promise.resolve(cloneCanvas(thumbCache[item.id]));
    return skinFor(item).then(function (skin) {
      if (!(window.PlayerModel && PlayerModel.preview)) throw new Error('no 3d renderer');
      var cv = PlayerModel.preview(skin, { width: 140, height: 180, yaw: 0.6 });
      thumbCache[item.id] = cv;
      return cloneCanvas(cv);
    });
  }

  function cloneCanvas(src) {
    var cv = document.createElement('canvas');
    cv.width = src.width; cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
    return cv;
  }

  // Queue a card's thumbnail; the pump renders ONE per animation frame so a
  // long grid never janks the UI (each preview is a full GL draw).
  function queueThumb(item, box) {
    thumbQueue.push({ item: item, box: box });
    pumpThumbs();
  }
  function pumpThumbs() {
    if (thumbPumping) return;
    thumbPumping = true;
    var step = function () {
      var job = thumbQueue.shift();
      if (!job) { thumbPumping = false; return; }
      if (!job.box.isConnected) { requestAnimationFrame(step); return; } // grid was re-rendered
      thumbFor(job.item).then(function (cv) {
        if (!job.box.isConnected) return;
        cv.className = 'mk-thumb-canvas';
        var ph = job.box.querySelector('.mk-silhouette');
        if (ph) job.box.removeChild(ph);
        job.box.insertBefore(cv, job.box.firstChild);
      }).catch(noop).then(function () { requestAnimationFrame(step); });
    };
    requestAnimationFrame(step);
  }

  // A blocky player-shaped placeholder: shown while a thumbnail renders, as
  // the permanent stand-in for censored items (blurred via CSS), and as the
  // fallback when WebGL previews are unavailable.
  function silhouetteCanvas(w, h) {
    var cv = el('canvas', 'mk-thumb-canvas mk-silhouette');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    var u = Math.floor(Math.min(w / 20, h / 38));  // 1 model pixel in canvas px
    if (u < 1) u = 1;
    var cx = Math.floor(w / 2), top = Math.floor((h - 32 * u) / 2);
    ctx.fillStyle = '#2a3350';
    ctx.fillRect(cx - 4 * u, top, 8 * u, 8 * u);              // head
    ctx.fillRect(cx - 4 * u, top + 8 * u, 8 * u, 12 * u);     // body
    ctx.fillRect(cx - 8 * u, top + 8 * u, 4 * u, 12 * u);     // right arm
    ctx.fillRect(cx + 4 * u, top + 8 * u, 4 * u, 12 * u);     // left arm
    ctx.fillRect(cx - 4 * u, top + 20 * u, 4 * u, 12 * u);    // right leg
    ctx.fillRect(cx, top + 20 * u, 4 * u, 12 * u);            // left leg
    return cv;
  }

  // Convert a market item to a wardrobe/active-skin record (§5.19 shape).
  function recFromItem(item) {
    return {
      name: item.title || t('market.untitled', 'Untitled'),
      model: item.model === 'slim' ? 'slim' : 'classic',
      png: item.png,
      remixOf: item.remixOf || '',
      marketId: item.id
    };
  }

  function modelLabel(model) {
    return model === 'slim' ? t('market.modelSlim', 'Slim') : t('market.modelClassic', 'Classic');
  }

  // ---- SVG star widgets (ported from the 2D-era market) --------------------
  function starSvg(cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('class', cls || '');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M12 2 L15 9 L22 9 L16.5 13.5 L18.5 21 L12 16.5 L5.5 21 L7.5 13.5 L2 9 L9 9 Z');
    p.setAttribute('fill', 'currentColor'); svg.appendChild(p); return svg;
  }
  // read-only star bar showing `value` (0..5) via a clipped gold overlay.
  function starsDisplay(value) {
    var wrap = el('div', 'mk-stars');
    var grey = el('div', 'mk-stars-row mk-stars-grey');
    var gold = el('div', 'mk-stars-row mk-stars-gold');
    for (var i = 0; i < 5; i++) { grey.appendChild(starSvg()); gold.appendChild(starSvg()); }
    gold.style.width = (Math.max(0, Math.min(5, value)) / 5 * 100) + '%';
    wrap.appendChild(grey); wrap.appendChild(gold);
    return wrap;
  }
  // interactive half-star picker.
  function starsInput(value, onPick) {
    var wrap = el('div', 'mk-stars mk-stars-input');
    var grey = el('div', 'mk-stars-row mk-stars-grey');
    var gold = el('div', 'mk-stars-row mk-stars-gold');
    for (var i = 0; i < 5; i++) { grey.appendChild(starSvg()); gold.appendChild(starSvg()); }
    function setW(v) { gold.style.width = (v / 5 * 100) + '%'; }
    setW(value || 0);
    wrap.appendChild(grey); wrap.appendChild(gold);
    var hit = el('div', 'mk-stars-hit');
    for (var s = 1; s <= 10; s++) {
      (function (half) {
        var seg = el('div', 'mk-stars-seg');
        seg.addEventListener('mousemove', function () { setW(half * 0.5); });
        seg.addEventListener('mouseleave', function () { setW(value || 0); });
        seg.addEventListener('click', function () { value = half * 0.5; setW(value); onPick(value); });
        hit.appendChild(seg);
      })(s);
    }
    wrap.appendChild(hit);
    return wrap;
  }

  // ---- build (once) ---------------------------------------------------------
  function build() {
    root = document.getElementById('screen-market');
    if (!root) { root = el('section'); root.id = 'screen-market'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = '';
    injectStyle();
    var wrap = el('div', 'mk-wrap');

    // header: title + publish hint + back
    var head = el('div', 'mk-head');
    head.appendChild(el('div', 'mk-title', t('market.title', 'Marketplace')));
    var pubBtn = el('button', 'mk-btn mk-accent', t('market.publish', 'Publish a skin')); pubBtn.type = 'button';
    pubBtn.addEventListener('click', routeToPublish);
    head.appendChild(pubBtn);
    var backBtn = el('button', 'mk-btn', t('common.back', 'Back')); backBtn.type = 'button';
    backBtn.addEventListener('click', onBack);
    head.appendChild(backBtn);
    wrap.appendChild(head);

    // toolbar: search (debounced) + sort + model filter
    var bar = el('div', 'mk-bar');
    searchInput = el('input', 'mk-search'); searchInput.type = 'text';
    searchInput.placeholder = t('market.search', 'Search name, author, tag…');
    searchInput.addEventListener('input', function () {
      filters.q = searchInput.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 220);
    });
    bar.appendChild(searchInput);

    sortSel = sel([
      ['new', t('market.sortNew', 'Newest')], ['old', t('market.sortOld', 'Oldest')],
      ['rating_hi', t('market.sortRatingHi', 'Top rated')], ['rating_lo', t('market.sortRatingLo', 'Low rated')],
      ['dl_hi', t('market.sortDlHi', 'Most downloads')], ['dl_lo', t('market.sortDlLo', 'Fewest downloads')]
    ], filters.sort, function (v) { filters.sort = v; load(); });
    bar.appendChild(labeled(t('market.sort', 'Sort'), sortSel));

    modelSel = sel([
      ['', t('market.modelAll', 'All models')],
      ['classic', t('market.modelClassic', 'Classic')],
      ['slim', t('market.modelSlim', 'Slim')]
    ], filters.model, function (v) { filters.model = v; load(); });
    bar.appendChild(labeled(t('market.model', 'Model'), modelSel));
    wrap.appendChild(bar);

    gridEl = el('div', 'mk-grid'); wrap.appendChild(gridEl);
    statusEl = el('div', 'mk-status'); wrap.appendChild(statusEl);
    root.appendChild(wrap);
    built = true;
  }

  function sel(opts, val, fn) {
    var s = el('select', 'mk-select');
    opts.forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; s.appendChild(op); });
    s.value = val; s.addEventListener('change', function () { fn(s.value); }); return s;
  }
  function labeled(label, control) { var d = el('div', 'mk-lrow'); d.appendChild(el('span', 'mk-llbl', label)); d.appendChild(control); return d; }

  // ---- load + grid ----------------------------------------------------------
  function load() {
    thumbQueue.length = 0; // stale jobs point at a grid we're replacing
    if (!(window.Store && Store.marketListSkins)) {
      renderEmpty(t('market.unavailable', 'Marketplace unavailable.'), false);
      return;
    }
    setStatus(t('market.loading', 'Loading…'));
    Store.marketListSkins({ q: filters.q, sort: filters.sort, model: filters.model })
      .then(function (list) {
        items = Array.isArray(list) ? list : [];
        setStatus('');
        if (!items.length) {
          renderEmpty(filters.q || filters.model
            ? t('market.noResults', 'No skins match your search.')
            : t('market.empty', 'Nothing here yet — be the first to publish a skin!'), false);
        } else {
          renderGrid();
        }
      })
      .catch(function () {
        renderEmpty(t('market.loadFail', "Can't reach the marketplace — check your connection."), true);
      });
  }

  function renderGrid() {
    gridEl.innerHTML = '';
    items.forEach(function (item) { gridEl.appendChild(card(item)); });
  }

  // friendly empty / offline state, with an optional retry button
  function renderEmpty(message, withRetry) {
    gridEl.innerHTML = '';
    setStatus('');
    var box = el('div', 'mk-empty');
    box.appendChild(el('div', 'mk-empty-face', withRetry ? '·derp·' : '(^-^)/'));
    box.appendChild(el('div', 'mk-empty-msg', message));
    if (withRetry) {
      var retry = el('button', 'mk-btn mk-primary mk-retry', t('market.retry', 'Retry')); retry.type = 'button';
      retry.addEventListener('click', load);
      box.appendChild(retry);
    } else {
      var hint = el('button', 'mk-btn mk-accent', t('market.publishHint', 'Make one in the Skin Studio')); hint.type = 'button';
      hint.addEventListener('click', function () { if (window.App && App.showScreen) App.showScreen('studio'); });
      box.appendChild(hint);
    }
    gridEl.appendChild(box);
  }

  // ---- cards ----------------------------------------------------------------
  function card(item) {
    var hidden = item.censored && !item.canSee;
    var c = el('div', 'mk-card' + (item.censored ? ' mk-censored censored' : ''));

    var box = el('div', 'mk-thumb');
    box.appendChild(silhouetteCanvas(110, 145));           // instant placeholder
    if (hidden) {
      box.appendChild(el('div', 'mk-censor-badge', t('market.censored', 'Under review')));
    } else if (item.png) {
      queueThumb(item, box);                               // lazily swap in the 3D render
    }
    c.appendChild(box);

    c.appendChild(el('div', 'mk-card-title', item.title || t('market.untitled', 'Untitled')));
    c.appendChild(el('div', 'mk-card-author', t('market.by', 'by') + ' ' + (item.author || '???')));

    var rate = el('div', 'mk-card-rate');
    rate.appendChild(starsDisplay(item.avgRating || 0));
    rate.appendChild(el('span', 'mk-card-dl', '↓ ' + (item.downloads || 0)));
    c.appendChild(rate);

    var meta = el('div', 'mk-card-meta-row');
    meta.appendChild(el('span', 'mk-model-badge mk-model-' + (item.model === 'slim' ? 'slim' : 'classic'), modelLabel(item.model)));
    if (item.remixOf) meta.appendChild(el('span', 'mk-card-remix', '↻ ' + t('market.remix', 'Remix')));
    if (item.reportCount > 0) meta.appendChild(el('span', 'mk-card-flags', '⚑ ' + item.reportCount));
    c.appendChild(meta);

    c.addEventListener('click', function () { openDetail(item.id); });
    return c;
  }

  // ---- detail modal -----------------------------------------------------
  function openDetail(id) {
    Store.marketItem(id)
      .then(function (item) { if (item) showDetail(item); })
      .catch(function (e) { setStatus((e && e.message) || t('market.loadFail', "Can't reach the marketplace — check your connection.")); });
  }

  function showDetail(item) {
    closeDetail(); // never stack two modals
    var overlay = el('div', 'mk-overlay');
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    openOverlay = overlay;
    function close() { closeDetail(); }

    var modal = el('div', 'mk-modal' + (item.censored && !item.canSee ? ' mk-censored censored' : ''));
    var head = el('div', 'mk-modal-head');
    head.appendChild(el('h3', 'mk-modal-title', item.title || t('market.untitled', 'Untitled')));
    var x = el('button', 'mk-x', '✕'); x.type = 'button'; x.addEventListener('click', close); head.appendChild(x);
    modal.appendChild(head);

    var body = el('div', 'mk-modal-body');
    var hidden = item.censored && !item.canSee;

    // -- big preview: draggable turntable (or blurred silhouette) --
    var top = el('div', 'mk-detail-top');
    var pbox = el('div', 'mk-detail-preview');
    if (hidden || !item.png) {
      pbox.appendChild(silhouetteCanvas(220, 280));
      if (hidden) pbox.appendChild(el('div', 'mk-censor-badge', t('market.censoredFull', 'Censored — under community review')));
    } else {
      var tcv = el('canvas', 'mk-turn-canvas'); tcv.width = 240; tcv.height = 300;
      pbox.appendChild(tcv);
      skinFor(item).then(function (skin) {
        if (!overlay.isConnected) return;
        if (window.PlayerModel && PlayerModel.attachTurntable) {
          if (activeTurntable) { try { activeTurntable.destroy(); } catch (e) { /* ignore */ } }
          activeTurntable = PlayerModel.attachTurntable(tcv, skin, {});
        } else if (window.PlayerModel && PlayerModel.preview) {
          // static fallback if the turntable helper is unavailable
          tcv.getContext('2d').drawImage(PlayerModel.preview(skin, { width: 240, height: 300, yaw: 0.6 }), 0, 0);
        }
      }).catch(noop);
    }
    top.appendChild(pbox);

    // -- facts column --
    var facts = el('div', 'mk-facts');
    top.appendChild(facts);
    body.appendChild(top);

    function renderFacts() {
      facts.innerHTML = '';
      facts.appendChild(el('div', 'mk-fact', t('market.by', 'by') + ' ' + (item.author || '???')));
      var mrow = el('div', 'mk-fact');
      mrow.appendChild(el('span', 'mk-model-badge mk-model-' + (item.model === 'slim' ? 'slim' : 'classic'), modelLabel(item.model)));
      facts.appendChild(mrow);
      if (item.remixOf) {
        var lin = el('button', 'mk-lineage', '↻ ' + t('market.remixOfBtn', 'Remix — view original'));
        lin.type = 'button';
        lin.addEventListener('click', function () {
          Store.marketItem(item.remixOf)
            .then(function (orig) { if (orig) { close(); showDetail(orig); } })
            .catch(function () { setS(t('market.originalGone', 'The original skin is gone.')); });
        });
        facts.appendChild(lin);
      }
      var rrow = el('div', 'mk-fact mk-fact-rate');
      rrow.appendChild(starsDisplay(item.avgRating || 0));
      rrow.appendChild(el('span', null, ' ' + (item.avgRating || 0).toFixed(1) + ' (' + (item.ratingCount || 0) + ')'));
      facts.appendChild(rrow);
      facts.appendChild(el('div', 'mk-fact', '↓ ' + (item.downloads || 0) + '  ·  ⚑ ' + (item.reportCount || 0) + (item.vouchCount ? (' / ✓ ' + item.vouchCount) : '')));
      if (item.tags && item.tags.length) facts.appendChild(el('div', 'mk-tags', item.tags.map(function (tg) { return '#' + tg; }).join(' ')));
    }
    renderFacts();

    // -- your rating (half-stars) --
    if (!hidden) {
      var rateRow = el('div', 'mk-rate-row');
      rateRow.appendChild(el('span', 'mk-rate-lbl', t('market.yourRating', 'Your rating')));
      rateRow.appendChild(starsInput(item.myRating || 0, function (stars) {
        guard(function () {
          Store.marketRate(item.id, stars)
            .then(function (u) { merge(item, u); refresh(); })
            .catch(function (e) { setS(e && e.message); });
        });
      }));
      body.appendChild(rateRow);
    }

    // -- actions --
    var actions = el('div', 'mk-actions');
    body.appendChild(actions);

    function renderActions() {
      actions.innerHTML = '';
      if (item.canSee && item.png) {
        actions.appendChild(btn(t('market.tryOn', 'Try on'), '', function () {
          if (window.App && App.setSkin) {
            App.setSkin(recFromItem(item), { persist: false });
            sfx('click');
            setS(t('market.tryingOn', 'Trying it on — worn for this session only.'));
          } else { setS(t('market.unavailable', 'Marketplace unavailable.')); }
        }));
        actions.appendChild(btn(t('market.wear', 'Wear'), 'mk-primary', function () {
          if (window.App && App.setSkin) {
            App.setSkin(recFromItem(item));
            sfx('click');
            setS(t('market.worn', 'Worn! This is your skin now.'));
          } else { setS(t('market.unavailable', 'Marketplace unavailable.')); }
        }));
        actions.appendChild(btn(t('market.download', 'Download'), '', function () {
          if (window.Store && Store.saveSkin) Store.saveSkin(recFromItem(item));
          if (window.Store && Store.marketDownload) {
            Store.marketDownload(item.id).then(function (u) { merge(item, u); refresh(); }).catch(noop);
          }
          sfx('click');
          setS(t('market.downloaded', 'Saved to your wardrobe.'));
        }));
        actions.appendChild(btn(t('market.remixBtn', 'Remix'), 'mk-accent', function () {
          if (window.SkinStudio && SkinStudio.show) {
            close();
            if (window.App && App.showScreen) App.showScreen('studio');
            SkinStudio.show({ remixOf: item });
          } else { setS(t('market.remixSoon', 'The Skin Studio is not available.')); }
        }));
      }
      // moderation: report / cancel report
      if (item.myReport) {
        actions.appendChild(btn(t('market.cancelReport', 'Cancel report'), 'mk-warn', function () {
          guard(function () {
            Store.marketUnreport(item.id).then(function (u) { merge(item, u); refresh(); }).catch(function (e) { setS(e && e.message); });
          });
        }));
      } else {
        actions.appendChild(btn(t('market.report', 'Report'), 'mk-warn', function () {
          guard(function () { openReport(item, refresh); });
        }));
      }
      // false-report vouch
      if (item.reportCount > 0 || item.myVouch) {
        if (item.myVouch) {
          actions.appendChild(btn(t('market.cancelVouch', 'Undo "false report"'), '', function () {
            guard(function () {
              Store.marketUnvouch(item.id).then(function (u) { merge(item, u); refresh(); }).catch(function (e) { setS(e && e.message); });
            });
          }));
        } else {
          actions.appendChild(btn(t('market.falseReport', 'This is a false report'), '', function () {
            guard(function () {
              Store.marketVouch(item.id).then(function (u) { merge(item, u); refresh(); }).catch(function (e) { setS(e && e.message); });
            });
          }));
        }
      }
      // owner / admin: delete
      if (meName() && (item.author === meName() || isAdmin())) {
        actions.appendChild(btn(t('market.delete', 'Delete'), 'mk-danger', function () {
          if (!window.confirm(t('market.deleteSure', 'Delete this skin?'))) return;
          Store.marketDelete(item.id)
            .then(function () { close(); load(); })
            .catch(function (e) { setS(e && e.message); });
        }));
      }
      // admin: ban / un-ban + revoke reports
      if (isAdmin()) {
        actions.appendChild(btn(item.banned ? t('market.unban', 'Un-ban') : t('market.ban', 'Ban'), 'mk-danger', function () {
          Store.marketAdmin(item.id, item.banned ? 'revoke' : 'ban')
            .then(function (u) { merge(item, u); refresh(); })
            .catch(function (e) { setS(e && e.message); });
        }));
        actions.appendChild(btn(t('market.revoke', 'Revoke reports'), '', function () {
          Store.marketAdmin(item.id, 'revoke')
            .then(function (u) { merge(item, u); refresh(); })
            .catch(function (e) { setS(e && e.message); });
        }));
      }
    }
    renderActions();

    // -- threaded comments --
    var comments = el('div', 'mk-comments');
    body.appendChild(comments);

    modal.appendChild(body);
    overlay.appendChild(modal);
    (document.getElementById('modal-root') || document.body).appendChild(overlay);

    var statusLine = el('div', 'mk-detail-status'); body.appendChild(statusLine);
    function setS(m) { statusLine.textContent = m || ''; }

    function refresh() { renderFacts(); renderActions(); renderComments(); }

    function renderComments() {
      comments.innerHTML = '';
      comments.appendChild(el('div', 'mk-comments-h', t('market.comments', 'Comments') + ' (' + ((item.comments && item.comments.length) || 0) + ')'));
      var byParent = {};
      (item.comments || []).forEach(function (cm) { var key = cm.parentId || '_'; (byParent[key] = byParent[key] || []).push(cm); });
      (byParent['_'] || []).forEach(function (cm) { comments.appendChild(renderComment(cm, byParent[cm.id] || [])); });
      // add-comment box
      var ta = el('textarea', 'mk-comment-input'); ta.placeholder = t('market.addComment', 'Add a comment…'); ta.rows = 2;
      var add = btn(t('market.post', 'Post'), 'mk-primary', function () {
        var txt = ta.value.trim(); if (!txt) return;
        guard(function () {
          Store.marketComment(item.id, txt, '')
            .then(function (u) { merge(item, u); ta.value = ''; renderComments(); })
            .catch(function (e) { setS(e && e.message); });
        });
      });
      comments.appendChild(ta); comments.appendChild(add);
    }
    function renderComment(cm, replies) {
      var box = el('div', 'mk-comment');
      box.appendChild(el('div', 'mk-comment-author', cm.author || '???'));
      box.appendChild(el('div', 'mk-comment-text', cm.text));
      var replyBtn = el('button', 'mk-reply-btn', t('market.reply', 'Reply')); replyBtn.type = 'button';
      replyBtn.addEventListener('click', function () {
        guard(function () {
          var rt = window.prompt(t('market.replyTo', 'Reply to') + ' ' + (cm.author || '???') + ':'); if (rt == null) return;
          rt = rt.trim(); if (!rt) return;
          Store.marketComment(item.id, rt, cm.id)
            .then(function (u) { merge(item, u); renderComments(); })
            .catch(function (e) { setS(e && e.message); });
        });
      });
      box.appendChild(replyBtn);
      (replies || []).forEach(function (rep) {
        var r = el('div', 'mk-comment mk-reply');
        r.appendChild(el('div', 'mk-comment-author', rep.author || '???'));
        r.appendChild(el('div', 'mk-comment-text', rep.text));
        box.appendChild(r);
      });
      return box;
    }
    renderComments();
  }

  // tear down whatever detail modal is open (turntable rAF loop included)
  function closeDetail() {
    if (activeTurntable) { try { activeTurntable.destroy(); } catch (e) { /* ignore */ } activeTurntable = null; }
    if (openOverlay) {
      if (openOverlay.parentNode) openOverlay.parentNode.removeChild(openOverlay);
      openOverlay = null;
    }
  }

  function btn(label, cls, fn) { var b = el('button', 'mk-btn ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; }

  // copy mutated fields from server view `u` onto `item`
  function merge(item, u) { if (!u) return; for (var k in u) if (Object.prototype.hasOwnProperty.call(u, k)) item[k] = u[k]; }

  // require login for an action; otherwise nudge to sign in.
  function guard(fn) {
    if (!loggedIn()) {
      setStatus(t('market.signinFirst', 'Sign in to do that.'));
      if (window.Menu && Menu.openSignIn) Menu.openSignIn();
      return;
    }
    fn();
  }

  // ---- report dialog -----------------------------------------------------
  function openReport(item, after) {
    var reason = window.prompt(t('market.reportWhy', 'Why are you reporting this? (offensive / spam / stolen / other)'), '');
    if (reason == null) return;
    Store.marketReport(item.id, reason)
      .then(function (u) { merge(item, u); if (after) after(); setStatus(t('market.reported', 'Reported. Thank you.')); })
      .catch(function (e) { setStatus((e && e.message) || ''); });
  }

  // ---- publish routing + misc ----------------------------------------------
  // Publishing lives in the Skin Studio / Wardrobe; explain, then route there.
  function routeToPublish() {
    toast(t('market.publishFrom', 'Publish from your Wardrobe or the Skin Studio — pick a skin and hit Publish.'));
    if (window.App && App.showScreen) App.showScreen('wardrobe');
  }

  // small floating toast that survives a screen switch
  function toast(msg) {
    var d = el('div', 'mk-toast', msg);
    document.body.appendChild(d);
    setTimeout(function () { d.classList.add('mk-toast-out'); }, 2800);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3400);
  }

  function onBack() {
    if (window.App && App.showScreen) App.showScreen('menu');
    else hide();
  }
  function setStatus(m) { if (statusEl) statusEl.textContent = m || ''; }

  // ---- public lifecycle ------------------------------------------------------
  function show() {
    if (!built) build();
    root.classList.add('active');
    load();
  }
  function hide() {
    closeDetail();
    thumbQueue.length = 0;
    if (root) root.classList.remove('active');
  }
  // legacy-style entry point (routes through the App screen router when present)
  function open() {
    if (window.App && App.showScreen) App.showScreen('market');
    else show();
  }

  // ---- styles ------------------------------------------------------------
  // Baseline look lives here (like the old market.js) so the screen works even
  // before the theme pass; style.css can override any of it.
  function injectStyle() {
    if (document.getElementById('market-style')) return;
    var css = [
      '#screen-market{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e7ecff;background:#0e111b;overflow:auto;}',
      '#screen-market *{box-sizing:border-box;}',
      '.mk-wrap{min-height:100%;padding:12px 16px 40px;display:flex;flex-direction:column;gap:10px;}',
      '.mk-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.mk-title{font-size:16px;color:#7ff9e0;text-shadow:2px 2px 0 #000;margin-right:auto;}',
      '.mk-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}',
      '.mk-search{flex:1 1 200px;min-width:160px;font-family:inherit;font-size:10px;color:#e7ecff;background:#10121f;border:2px solid #2a3350;border-radius:6px;padding:9px;}',
      '.mk-lrow{display:flex;align-items:center;gap:6px;}',
      '.mk-llbl{font-size:8px;color:#8a93ad;}',
      '.mk-select{font-family:inherit;font-size:9px;color:#0e111b;background:#e7ecff;border:0;border-radius:5px;padding:6px;}',
      '.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}',
      '.mk-card{background:#141826;border:2px solid #232a40;border-radius:8px;padding:8px;cursor:pointer;display:flex;flex-direction:column;gap:5px;align-items:center;}',
      '.mk-card:hover{border-color:#7ff9e0;}',
      '.mk-thumb{position:relative;width:100%;display:flex;justify-content:center;background:#12151f;border:1px solid #232a40;border-radius:6px;padding:4px;min-height:120px;}',
      '.mk-thumb-canvas{image-rendering:auto;max-width:100%;height:auto;}',
      '.mk-silhouette{opacity:.85;}',
      // censored blur — both the legacy class and the contract-pinned `censored`
      '.mk-censored .mk-thumb-canvas,.censored .mk-thumb-canvas,.mk-censored .mk-turn-canvas,.censored .mk-turn-canvas{filter:blur(7px) grayscale(1);}',
      '.mk-censor-badge{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;font-size:8px;color:#ffcf3c;background:rgba(10,12,20,.74);padding:6px;}',
      '.mk-card-title{font-size:9px;color:#e7ecff;text-align:center;line-height:1.4;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mk-card-author{font-size:7px;color:#8a93ad;}',
      '.mk-card-rate{display:flex;align-items:center;gap:8px;}',
      '.mk-card-dl{font-size:8px;color:#7ff9e0;}',
      '.mk-card-meta-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;}',
      '.mk-model-badge{font-size:7px;text-transform:uppercase;color:#0e111b;background:#7ff9e0;border-radius:4px;padding:3px 6px;}',
      '.mk-model-slim{background:#ffb3e6;}',
      '.mk-card-remix{font-size:7px;color:#ff9e2c;}',
      '.mk-card-flags{font-size:7px;color:#ffcf3c;}',
      // stars
      '.mk-stars{position:relative;display:inline-block;height:16px;line-height:0;white-space:nowrap;}',
      '.mk-stars-row{display:inline-flex;height:16px;}',
      '.mk-stars-grey{color:#39405c;}',
      '.mk-stars-gold{color:#ffcf3c;position:absolute;top:0;left:0;overflow:hidden;width:0;}',
      '.mk-stars-input{cursor:pointer;}',
      '.mk-stars-hit{position:absolute;inset:0;display:flex;}',
      '.mk-stars-seg{flex:1 1 0;}',
      // status / empty state
      '.mk-status{text-align:center;font-size:9px;color:#7ff9e0;min-height:12px;}',
      '.mk-empty{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;gap:14px;padding:44px 16px;text-align:center;}',
      '.mk-empty-face{font-size:18px;color:#39405c;}',
      '.mk-empty-msg{font-size:10px;color:#8a93ad;line-height:1.8;max-width:420px;}',
      // buttons
      '.mk-btn{font-family:inherit;font-size:9px;color:#e7ecff;background:#222a40;border:0;border-radius:6px;padding:9px 12px;cursor:pointer;}',
      '.mk-btn:hover{background:#2c3656;}',
      '.mk-primary{background:#7ff9e0;color:#0e111b;}',
      '.mk-accent{background:#ff9e2c;color:#0e111b;}',
      '.mk-warn{background:#ffcf3c;color:#0e111b;}',
      '.mk-danger{background:#ff5a5a;color:#0e111b;}',
      // modal
      '.mk-overlay{position:fixed;inset:0;background:rgba(8,9,16,.85);display:flex;align-items:center;justify-content:center;z-index:9000;padding:14px;}',
      '.mk-modal{background:#181b2c;border:3px solid #7ff9e0;border-radius:8px;box-shadow:8px 8px 0 #0a0b14;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;color:#e7ecff;}',
      '.mk-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:2px solid #2a3350;position:sticky;top:0;background:#10121f;z-index:1;}',
      '.mk-modal-title{margin:0;font-size:12px;color:#7ff9e0;}',
      '.mk-x{font-family:inherit;background:transparent;border:2px solid #2a3350;color:#aab3cc;cursor:pointer;padding:4px 8px;border-radius:5px;}',
      '.mk-modal-body{padding:14px;display:flex;flex-direction:column;gap:12px;}',
      '.mk-detail-top{display:flex;gap:14px;flex-wrap:wrap;}',
      '.mk-detail-preview{position:relative;background:#12151f;border:2px solid #2a3350;border-radius:6px;padding:6px;display:flex;align-items:center;justify-content:center;}',
      '.mk-turn-canvas{touch-action:none;cursor:grab;max-width:100%;}',
      '.mk-facts{flex:1 1 200px;display:flex;flex-direction:column;gap:6px;font-size:9px;color:#cfd4e8;align-items:flex-start;}',
      '.mk-fact{font-size:9px;color:#cfd4e8;}',
      '.mk-fact-rate{display:flex;align-items:center;gap:6px;}',
      '.mk-lineage{font-family:inherit;font-size:8px;color:#ff9e2c;background:transparent;border:0;cursor:pointer;padding:0;text-decoration:underline;text-align:left;}',
      '.mk-tags{font-size:8px;color:#7ff9e0;}',
      '.mk-rate-row{display:flex;align-items:center;gap:10px;}',
      '.mk-rate-lbl{font-size:9px;color:#8a93ad;}',
      '.mk-actions{display:flex;flex-wrap:wrap;gap:8px;}',
      // comments
      '.mk-comments{display:flex;flex-direction:column;gap:8px;}',
      '.mk-comments-h{font-size:9px;color:#ff9e2c;}',
      '.mk-comment{background:#141826;border:1px solid #232a40;border-radius:6px;padding:7px 9px;}',
      '.mk-reply{margin-left:18px;border-left:2px solid #2a3350;}',
      '.mk-comment-author{font-size:8px;color:#7ff9e0;margin-bottom:3px;}',
      '.mk-comment-text{font-size:9px;color:#cfd4e8;line-height:1.6;word-break:break-word;}',
      '.mk-reply-btn{font-family:inherit;font-size:7px;color:#8a93ad;background:transparent;border:0;cursor:pointer;padding:3px 0 0;text-decoration:underline;}',
      '.mk-comment-input{font-family:inherit;font-size:9px;color:#0e111b;background:#e7ecff;border:0;border-radius:6px;padding:8px;resize:vertical;}',
      '.mk-detail-status{font-size:8px;color:#7ff9e0;min-height:11px;text-align:center;}',
      // toast
      '.mk-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:9500;font-family:"Press Start 2P",monospace;font-size:9px;color:#0e111b;background:#7ff9e0;border-radius:6px;padding:10px 14px;box-shadow:4px 4px 0 #0a0b14;max-width:86vw;text-align:center;line-height:1.6;opacity:1;transition:opacity .5s;}',
      '.mk-toast-out{opacity:0;}',
      '@media(max-width:560px){.mk-detail-top{flex-direction:column;align-items:center;}.mk-facts{align-items:center;}}'
    ].join('');
    var st = el('style'); st.id = 'market-style'; st.textContent = css; document.head.appendChild(st);
  }

  var Market = { show: show, hide: hide, open: open, close: hide };
  window.Market = Market;
})();
