// market.js — the open-source cosmetic Marketplace screen. Global: window.Market.
//
// Browse, try-on, rate (half-stars), comment (+ threaded replies), report /
// "false-report" vouch, download (save to your library), and remix every
// always-free cosmetic. Publish your painted textures or your whole character
// (with the custom textures it wears bundled in). Censored items show blurred
// until an admin bans them or revokes the reports; admins get ban/revoke here.
//
// Depends on globals: Store (Store.market), Textures, Sprites, App, I18n
// (and optionally Paint, Menu, Editor).
(function () {
  'use strict';

  function t(k, en) { return (window.I18n && I18n.t) ? I18n.t(k, en) : en; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function TX() { return window.Textures || null; }
  function loggedIn() { return !!(window.Store && Store.isLoggedIn && Store.isLoggedIn()); }
  function isAdmin() { return !!(window.Store && Store.isAdmin && Store.isAdmin()); }
  function meName() { return (window.Store && Store.getUsername && Store.getUsername()) || ''; }

  var root, built = false, gridEl, statusEl, searchInput, sortSel, kindSel, slotSel;
  var items = [], filters = { q: '', sort: 'new', kind: '', slot: '' }, searchTimer = null;
  var registered = {}; // texId -> true (already registered with Textures)

  var SLOT_LABELS = { body: 'Body', belly: 'Belly', feet: 'Feet', shirt: 'Shirt', pants: 'Pants', shoes: 'Shoes', hair: 'Hair', beard: 'Beard', mouth: 'Mouth', eyes: 'Eyes', cape: 'Cape', hat: 'Hat', accessory: 'Accessory' };

  // ---- SVG star ----------------------------------------------------------
  function starSvg(cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('class', cls || '');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M12 2 L15 9 L22 9 L16.5 13.5 L18.5 21 L12 16.5 L5.5 21 L7.5 13.5 L2 9 L9 9 Z');
    p.setAttribute('fill', 'currentColor'); svg.appendChild(p); return svg;
  }
  // a read-only star bar showing `value` (0..5) via a clipped gold overlay.
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

  // ---- build -------------------------------------------------------------
  function build() {
    root = document.getElementById('screen-marketplace');
    if (!root) { root = el('section'); root.id = 'screen-marketplace'; root.className = 'screen'; document.body.appendChild(root); }
    root.innerHTML = ''; injectStyle();
    var wrap = el('div', 'mk-wrap');

    var head = el('div', 'mk-head');
    head.appendChild(el('div', 'mk-title', t('market.title', 'Marketplace')));
    var pubBtn = el('button', 'mk-btn mk-accent', t('market.publishChar', 'Publish my character')); pubBtn.type = 'button';
    pubBtn.addEventListener('click', publishCurrentCharacter);
    head.appendChild(pubBtn);
    var backBtn = el('button', 'mk-btn', t('common.back', 'Back')); backBtn.type = 'button';
    backBtn.addEventListener('click', onBack);
    head.appendChild(backBtn);
    wrap.appendChild(head);

    // filter bar
    var bar = el('div', 'mk-bar');
    searchInput = el('input', 'mk-search'); searchInput.type = 'text'; searchInput.placeholder = t('market.search', 'Search name, author, tag…');
    searchInput.addEventListener('input', function () { filters.q = searchInput.value; if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(load, 220); });
    bar.appendChild(searchInput);

    sortSel = sel([
      ['new', t('market.sortNew', 'Newest')], ['old', t('market.sortOld', 'Oldest')],
      ['rating_hi', t('market.sortRatingHi', 'Top rated')], ['rating_lo', t('market.sortRatingLo', 'Low rated')],
      ['dl_hi', t('market.sortDlHi', 'Most downloads')], ['dl_lo', t('market.sortDlLo', 'Fewest downloads')]
    ], 'new', function (v) { filters.sort = v; load(); });
    bar.appendChild(labeled(t('market.sort', 'Sort'), sortSel));

    kindSel = sel([['', t('market.allKinds', 'All')], ['texture', t('market.textures', 'Textures')], ['character', t('market.characters', 'Characters')]], '', function (v) { filters.kind = v; load(); });
    bar.appendChild(labeled(t('market.kind', 'Type'), kindSel));

    var slotOpts = [['', t('market.allSlots', 'All parts')]];
    Object.keys(SLOT_LABELS).forEach(function (s) { slotOpts.push([s, t('slot.' + s, SLOT_LABELS[s])]); });
    slotSel = sel(slotOpts, '', function (v) { filters.slot = v; load(); });
    bar.appendChild(labeled(t('market.part', 'Part'), slotSel));
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

  // ---- load + render -----------------------------------------------------
  function load() {
    if (!(window.Store && Store.market)) { setStatus(t('market.unavailable', 'Marketplace unavailable.')); return; }
    setStatus(t('market.loading', 'Loading…'));
    Store.market.list(filters).then(function (list) {
      items = list || []; renderGrid();
      setStatus(items.length ? '' : t('market.empty', 'Nothing here yet — be the first to publish!'));
    }).catch(function () { setStatus(t('market.loadFail', 'Could not reach the marketplace.')); });
  }

  function renderGrid() {
    gridEl.innerHTML = '';
    items.forEach(function (item) { gridEl.appendChild(card(item)); });
  }

  function card(item) {
    var c = el('div', 'mk-card' + (item.censored ? ' mk-censored' : ''));
    var thumbBox = el('div', 'mk-thumb');
    var cv = el('canvas', 'mk-thumb-canvas'); cv.width = 96; cv.height = 112; thumbBox.appendChild(cv);
    if (item.censored && !item.canSee) {
      thumbBox.appendChild(el('div', 'mk-censor-badge', t('market.censored', 'Under review')));
    } else {
      drawItemInto(cv, item);
    }
    c.appendChild(thumbBox);
    c.appendChild(el('div', 'mk-card-title', item.title || 'Untitled'));
    c.appendChild(el('div', 'mk-card-author', t('market.by', 'by') + ' ' + (item.author || '???')));
    var rate = el('div', 'mk-card-rate');
    rate.appendChild(starsDisplay(item.avgRating || 0));
    rate.appendChild(el('span', 'mk-card-dl', '↓ ' + (item.downloads || 0)));
    c.appendChild(rate);
    var tagline = el('div', 'mk-card-meta', (item.kind === 'character' ? t('market.character', 'Character') : (t('slot.' + item.slot, SLOT_LABELS[item.slot] || item.slot))));
    c.appendChild(tagline);
    c.addEventListener('click', function () { openDetail(item.id); });
    return c;
  }

  // Register the texture(s) an item needs, then resolve.
  function ensureRegistered(item) {
    var T = TX(); if (!T || !T.registerCustomPNG) return Promise.resolve();
    var jobs = [];
    if (item.kind === 'texture' && item.png && !registered[item.id]) {
      jobs.push(T.registerCustomPNG({ id: item.id, slot: item.slot, glowColor: item.glowColor, tintHint: item.tintHint }, item.png).then(function () { registered[item.id] = true; }));
    }
    if (item.bundle) {
      Object.keys(item.bundle).forEach(function (tid) {
        var b = item.bundle[tid];
        if (b && b.png && !registered[tid]) jobs.push(T.registerCustomPNG({ id: tid, slot: b.slot, glowColor: b.glowColor, tintHint: b.tintHint }, b.png).then(function () { registered[tid] = true; }));
      });
    }
    return Promise.all(jobs);
  }

  // A character that best showcases the item (the published one, or a base body
  // that supports the texture's slot, wearing it).
  function previewCharFor(item) {
    var S = window.Sprites;
    if (item.kind === 'character' && item.character) { return S ? S.sanitize(item.character) : item.character; }
    var def = (TX() && TX().paintSlots) ? TX().paintSlots()[item.slot] : null;
    var base = S ? S.sanitize(S.defaultCharacter()) : { bodyType: 'humanoid', tex: {} };
    if (def && def.tux && !def.hum) base.bodyType = 'tux';
    base.tex = base.tex || {}; base.tex[item.slot] = item.id;
    return base;
  }

  function drawItemInto(cv, item) {
    var ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#12151f'; ctx.fillRect(0, 0, cv.width, cv.height);
    ensureRegistered(item).then(function () {
      var S = window.Sprites; if (!S || !S.drawCharacter) return;
      ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#12151f'; ctx.fillRect(0, 0, cv.width, cv.height);
      try { S.drawCharacter(ctx, previewCharFor(item), cv.width / 2, cv.height - 8, (cv.height * 0.5) / 18, 1); } catch (e) { /* ignore */ }
    });
  }

  // ---- detail modal ------------------------------------------------------
  function openDetail(id) {
    Store.market.get(id).then(function (item) { if (item) showDetail(item); }).catch(function () {});
  }

  function showDetail(item) {
    var overlay = el('div', 'mk-overlay'); overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

    var modal = el('div', 'mk-modal');
    var head = el('div', 'mk-modal-head');
    head.appendChild(el('h3', 'mk-modal-title', item.title || 'Untitled'));
    var x = el('button', 'mk-x', '✕'); x.type = 'button'; x.addEventListener('click', close); head.appendChild(x);
    modal.appendChild(head);

    var body = el('div', 'mk-modal-body');

    // preview + facts
    var top = el('div', 'mk-detail-top');
    var pcv = el('canvas', 'mk-detail-canvas'); pcv.width = 140; pcv.height = 168;
    var pbox = el('div', 'mk-detail-preview');
    pbox.appendChild(pcv);
    if (item.censored && !item.canSee) pbox.appendChild(el('div', 'mk-censor-badge', t('market.censoredFull', 'Censored — under community review')));
    else drawItemInto(pcv, item);
    top.appendChild(pbox);

    var facts = el('div', 'mk-facts');
    facts.appendChild(el('div', 'mk-fact', t('market.by', 'by') + ' ' + (item.author || '???')));
    facts.appendChild(el('div', 'mk-fact', (item.kind === 'character' ? t('market.character', 'Character') : (t('slot.' + item.slot, SLOT_LABELS[item.slot] || item.slot))) + (item.remixOf ? ' · ' + t('market.remix', 'Remix') : '')));
    var rrow = el('div', 'mk-fact mk-fact-rate');
    rrow.appendChild(starsDisplay(item.avgRating || 0));
    rrow.appendChild(el('span', null, ' ' + (item.avgRating || 0).toFixed(1) + ' (' + (item.ratingCount || 0) + ')'));
    facts.appendChild(rrow);
    facts.appendChild(el('div', 'mk-fact', '↓ ' + (item.downloads || 0) + '  ·  ⚑ ' + (item.reportCount || 0) + (item.vouchCount ? (' / ✓ ' + item.vouchCount) : '')));
    if (item.tags && item.tags.length) facts.appendChild(el('div', 'mk-tags', item.tags.map(function (tg) { return '#' + tg; }).join(' ')));
    top.appendChild(facts);
    body.appendChild(top);

    // your rating
    if (!(item.censored && !item.canSee)) {
      var rateRow = el('div', 'mk-rate-row');
      rateRow.appendChild(el('span', 'mk-rate-lbl', t('market.yourRating', 'Your rating')));
      rateRow.appendChild(starsInput(item.myRating || 0, function (stars) {
        guard(function () { Store.market.rate(item.id, stars).then(function (u) { merge(item, u); refresh(); }); });
      }));
      body.appendChild(rateRow);
    }

    // actions
    var actions = el('div', 'mk-actions');
    if (item.canSee) {
      actions.appendChild(btn(t('market.tryOn', 'Try on'), 'mk-primary', function () { tryOn(item); }));
      actions.appendChild(btn(t('market.download', 'Download'), '', function () { downloadItem(item); }));
      if (item.kind === 'texture') actions.appendChild(btn(t('market.remixBtn', 'Remix'), '', function () { close(); remix(item); }));
    }
    // moderation
    if (item.myReport) actions.appendChild(btn(t('market.cancelReport', 'Cancel report'), 'mk-warn', function () { guard(function () { Store.market.unreport(item.id).then(function (u) { merge(item, u); refresh(); }); }); }));
    else actions.appendChild(btn(t('market.report', 'Report'), 'mk-warn', function () { guard(function () { openReport(item, refresh); }); }));
    // false-report vouch
    if (item.reportCount > 0 || item.myVouch) {
      if (item.myVouch) actions.appendChild(btn(t('market.cancelVouch', 'Undo "false report"'), '', function () { guard(function () { Store.market.unvouch(item.id).then(function (u) { merge(item, u); refresh(); }); }); }));
      else actions.appendChild(btn(t('market.falseReport', 'This is a false report'), '', function () { guard(function () { Store.market.vouch(item.id).then(function (u) { merge(item, u); refresh(); }); }); }));
    }
    // owner / admin
    if (meName() && (item.author === meName() || isAdmin())) actions.appendChild(btn(t('market.delete', 'Delete'), 'mk-danger', function () { if (window.confirm(t('market.deleteSure', 'Delete this item?'))) Store.market.del(item.id).then(function () { close(); load(); }); }));
    if (isAdmin()) {
      actions.appendChild(btn(item.banned ? t('market.unban', 'Un-ban') : t('market.ban', 'Ban'), 'mk-danger', function () {
        var p = item.banned ? Store.market.revoke(item.id) : Store.market.ban(item.id);
        p.then(function (u) { merge(item, u); refresh(); });
      }));
      actions.appendChild(btn(t('market.revoke', 'Revoke reports'), '', function () { Store.market.revoke(item.id).then(function (u) { merge(item, u); refresh(); }); }));
    }
    body.appendChild(actions);

    // comments
    var comments = el('div', 'mk-comments');
    body.appendChild(comments);

    modal.appendChild(body);
    overlay.appendChild(modal);
    (document.getElementById('modal-root') || document.body).appendChild(overlay);

    var statusLine = el('div', 'mk-detail-status'); body.appendChild(statusLine);
    function setS(m) { statusLine.textContent = m || ''; }

    function refresh() {
      // re-render facts that change often
      rrow.innerHTML = ''; rrow.appendChild(starsDisplay(item.avgRating || 0)); rrow.appendChild(el('span', null, ' ' + (item.avgRating || 0).toFixed(1) + ' (' + (item.ratingCount || 0) + ')'));
      renderComments();
    }
    function renderComments() {
      comments.innerHTML = '';
      comments.appendChild(el('div', 'mk-comments-h', t('market.comments', 'Comments') + ' (' + ((item.comments && item.comments.length) || 0) + ')'));
      var byParent = {};
      (item.comments || []).forEach(function (cm) { var key = cm.parentId || '_'; (byParent[key] = byParent[key] || []).push(cm); });
      (byParent['_'] || []).forEach(function (cm) { comments.appendChild(renderComment(cm, byParent[cm.id] || [])); });
      // add comment
      var ta = el('textarea', 'mk-comment-input'); ta.placeholder = t('market.addComment', 'Add a comment…'); ta.rows = 2;
      var add = btn(t('market.post', 'Post'), 'mk-primary', function () {
        var txt = ta.value.trim(); if (!txt) return;
        guard(function () { Store.market.comment(item.id, txt, '').then(function (u) { merge(item, u); ta.value = ''; renderComments(); }); });
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
          var rt = window.prompt(t('market.replyTo', 'Reply to') + ' ' + cm.author + ':'); if (rt == null) return;
          rt = rt.trim(); if (!rt) return;
          Store.market.comment(item.id, rt, cm.id).then(function (u) { merge(item, u); renderComments(); });
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

  function btn(label, cls, fn) { var b = el('button', 'mk-btn ' + (cls || ''), label); b.type = 'button'; b.addEventListener('click', fn); return b; }

  // copy mutated fields from server view `u` onto `item`
  function merge(item, u) { if (!u) return; for (var k in u) if (Object.prototype.hasOwnProperty.call(u, k)) item[k] = u[k]; }

  // require login for an action; otherwise nudge to sign in.
  function guard(fn) {
    if (!loggedIn()) { setStatus(t('market.signinFirst', 'Sign in to do that.')); if (window.Menu && Menu.openSignIn) Menu.openSignIn(); return; }
    fn();
  }

  // ---- report dialog -----------------------------------------------------
  function openReport(item, after) {
    var reason = window.prompt(t('market.reportWhy', 'Why are you reporting this? (offensive / spam / stolen / other)'), '');
    if (reason == null) return;
    Store.market.report(item.id, reason).then(function (u) { merge(item, u); if (after) after(); setStatus(t('market.reported', 'Reported. Thank you.')); });
  }

  // ---- try-on / download / remix / publish -------------------------------
  function tryOn(item) {
    ensureRegistered(item).then(function () {
      if (typeof App === 'undefined') return;
      if (item.kind === 'character' && item.character) {
        var ch = window.Sprites ? Sprites.sanitize(item.character) : item.character;
        if (App.updateCharacter) App.updateCharacter(ch); else App.character = ch;
        persistDownloadBundle(item);
      } else {
        var cur = clone((App.character) || (window.Sprites && Sprites.defaultCharacter ? Sprites.defaultCharacter() : {}));
        cur.tex = cur.tex || {}; cur.tex[item.slot] = item.id;
        if (App.updateCharacter) App.updateCharacter(cur); else App.character = cur;
      }
      saveRemoteChar();
      setStatus(t('market.wearing', 'Trying it on — see it in Edit Character.'));
    });
  }
  function downloadItem(item) {
    ensureRegistered(item).then(function () {
      if (item.kind === 'texture' && item.png && window.Store && Store.saveLocalTexture) {
        Store.saveLocalTexture({ id: item.id, slot: item.slot, title: item.title, glowColor: item.glowColor, tintHint: item.tintHint, createdAt: item.createdAt, remixOf: item.remixOf || '', png: item.png });
      }
      persistDownloadBundle(item);
      if (Store.market && Store.market.download) Store.market.download(item.id).then(function (u) { merge(item, u); });
      setStatus(t('market.downloaded', 'Saved to your library.'));
    });
  }
  // save a character item's bundled textures into the local library too
  function persistDownloadBundle(item) {
    if (!item.bundle || !(window.Store && Store.saveLocalTexture)) return;
    Object.keys(item.bundle).forEach(function (tid) {
      var b = item.bundle[tid];
      if (b && b.png) Store.saveLocalTexture({ id: tid, slot: b.slot, title: (item.title || '') + ' part', glowColor: b.glowColor, tintHint: b.tintHint, createdAt: item.createdAt, remixOf: '', png: b.png });
    });
  }
  function remix(item) {
    if (!(window.Paint && Paint.open)) { setStatus(t('market.remixSoon', 'Open the paint studio to remix.')); return; }
    if (!item.png) { setStatus(t('market.remixNoData', 'No texture data to remix.')); return; }
    Paint.open({ remix: { id: item.id, slot: item.slot, glowColor: item.glowColor, tintHint: item.tintHint, png: item.png, title: item.title } });
  }

  // Publish a painted texture record (called by the Paint Studio).
  function publishTexture(record) {
    if (!(window.Store && Store.market)) return Promise.reject(new Error('marketplace unavailable'));
    if (!loggedIn()) { if (window.Menu && Menu.openSignIn) Menu.openSignIn(); return Promise.reject(new Error('sign in to publish')); }
    return Store.market.publish({
      kind: 'texture', slot: record.slot, title: record.title, tags: record.tags || [],
      glowColor: record.glowColor, tintHint: record.tintHint, png: record.png, remixOf: record.remixOf || ''
    });
  }

  // Publish the current character with its worn custom textures bundled in.
  function publishCurrentCharacter() {
    guard(function () {
      var ch = (typeof App !== 'undefined' && App.character) ? App.character : null;
      if (!ch) { setStatus(t('market.noChar', 'No character to publish.')); return; }
      var title = window.prompt(t('market.charName', 'Name your character:'), ch.name || 'My Clobi');
      if (title == null) return;
      var bundle = {};
      if (ch.tex && window.Store && Store.getLocalTexture) {
        Object.keys(ch.tex).forEach(function (slot) {
          var id = ch.tex[slot]; var rec = Store.getLocalTexture(id);
          if (rec && rec.png) bundle[id] = { slot: rec.slot || slot, glowColor: rec.glowColor, tintHint: rec.tintHint, png: rec.png };
        });
      }
      setStatus(t('market.publishing', 'Publishing…'));
      Store.market.publish({ kind: 'character', title: title.trim() || 'My Clobi', tags: [], character: ch, bundle: bundle })
        .then(function () { setStatus(t('market.published', 'Published — always free. Refreshing…')); load(); })
        .catch(function (e) { setStatus((e && e.message) || t('market.publishFail', 'Could not publish.')); });
    });
  }

  function saveRemoteChar() {
    if (loggedIn() && window.Store && Store.saveCharacterRemote && App && App.character) {
      try { Store.saveCharacterRemote(App.character); } catch (e) { /* ignore */ }
    }
  }
  function clone(o) { try { return JSON.parse(JSON.stringify(o || {})); } catch (e) { return {}; } }

  function onBack() { hide(); if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu'); if (window.Menu && Menu.show) Menu.show(); }
  function setStatus(m) { if (statusEl) statusEl.textContent = m || ''; }

  // ---- public ------------------------------------------------------------
  function open() {
    if (!built) build();
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('marketplace'); else root.classList.add('active');
    load();
  }
  function hide() { /* nothing persistent */ }

  // ---- styles ------------------------------------------------------------
  function injectStyle() {
    if (document.getElementById('market-style')) return;
    var css = [
      '#screen-marketplace{position:absolute;inset:0;font-family:"Press Start 2P",monospace;color:#e7ecff;background:#0e111b;overflow:auto;}',
      '#screen-marketplace *{box-sizing:border-box;}',
      '.mk-wrap{min-height:100%;padding:12px 16px 40px;display:flex;flex-direction:column;gap:10px;}',
      '.mk-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.mk-title{font-size:16px;color:#7ff9e0;text-shadow:2px 2px 0 #000;margin-right:auto;}',
      '.mk-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}',
      '.mk-search{flex:1 1 200px;min-width:160px;font-family:inherit;font-size:10px;color:#e7ecff;background:#10121f;border:2px solid #2a3350;border-radius:6px;padding:9px;}',
      '.mk-lrow{display:flex;align-items:center;gap:6px;}',
      '.mk-llbl{font-size:8px;color:#8a93ad;}',
      '.mk-select{font-family:inherit;font-size:9px;color:#0e111b;background:#e7ecff;border:0;border-radius:5px;padding:6px;}',
      '.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px;}',
      '.mk-card{background:#141826;border:2px solid #232a40;border-radius:8px;padding:8px;cursor:pointer;display:flex;flex-direction:column;gap:5px;align-items:center;}',
      '.mk-card:hover{border-color:#7ff9e0;}',
      '.mk-thumb{position:relative;width:100%;display:flex;justify-content:center;background:#12151f;border:1px solid #232a40;border-radius:6px;padding:4px;}',
      '.mk-thumb-canvas{image-rendering:pixelated;}',
      '.mk-censored .mk-thumb-canvas,.mk-censored .mk-detail-canvas{filter:blur(7px) grayscale(1);}',
      '.mk-censor-badge{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;font-size:8px;color:#ffcf3c;background:rgba(10,12,20,.74);padding:6px;}',
      '.mk-card-title{font-size:9px;color:#e7ecff;text-align:center;line-height:1.4;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mk-card-author{font-size:7px;color:#8a93ad;}',
      '.mk-card-rate{display:flex;align-items:center;gap:8px;}',
      '.mk-card-dl{font-size:8px;color:#7ff9e0;}',
      '.mk-card-meta{font-size:7px;color:#ff9e2c;text-transform:uppercase;}',
      // stars
      '.mk-stars{position:relative;display:inline-block;height:16px;line-height:0;white-space:nowrap;}',
      '.mk-stars-row{display:inline-flex;height:16px;}',
      '.mk-stars-grey{color:#39405c;}',
      '.mk-stars-gold{color:#ffcf3c;position:absolute;top:0;left:0;overflow:hidden;width:0;}',
      '.mk-stars-input{cursor:pointer;}',
      '.mk-stars-hit{position:absolute;inset:0;display:flex;}',
      '.mk-stars-seg{flex:1 1 0;}',
      // status
      '.mk-status{text-align:center;font-size:9px;color:#7ff9e0;min-height:12px;}',
      '.mk-btn{font-family:inherit;font-size:9px;color:#e7ecff;background:#222a40;border:0;border-radius:6px;padding:9px 12px;cursor:pointer;}',
      '.mk-btn:hover{background:#2c3656;}',
      '.mk-primary{background:#7ff9e0;color:#0e111b;}',
      '.mk-accent{background:#ff9e2c;color:#0e111b;}',
      '.mk-warn{background:#ffcf3c;color:#0e111b;}',
      '.mk-danger{background:#ff5a5a;color:#0e111b;}',
      // modal
      '.mk-overlay{position:fixed;inset:0;background:rgba(8,9,16,.85);display:flex;align-items:center;justify-content:center;z-index:9000;padding:14px;}',
      '.mk-modal{background:#181b2c;border:3px solid #7ff9e0;border-radius:8px;box-shadow:8px 8px 0 #0a0b14;width:100%;max-width:520px;max-height:92vh;overflow-y:auto;color:#e7ecff;}',
      '.mk-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:2px solid #2a3350;position:sticky;top:0;background:#10121f;}',
      '.mk-modal-title{margin:0;font-size:12px;color:#7ff9e0;}',
      '.mk-x{font-family:inherit;background:transparent;border:2px solid #2a3350;color:#aab3cc;cursor:pointer;padding:4px 8px;border-radius:5px;}',
      '.mk-modal-body{padding:14px;display:flex;flex-direction:column;gap:12px;}',
      '.mk-detail-top{display:flex;gap:14px;flex-wrap:wrap;}',
      '.mk-detail-preview{position:relative;background:#12151f;border:2px solid #2a3350;border-radius:6px;padding:6px;}',
      '.mk-detail-canvas{image-rendering:pixelated;}',
      '.mk-facts{flex:1 1 180px;display:flex;flex-direction:column;gap:6px;font-size:9px;color:#cfd4e8;}',
      '.mk-fact{font-size:9px;color:#cfd4e8;}',
      '.mk-fact-rate{display:flex;align-items:center;gap:6px;}',
      '.mk-tags{font-size:8px;color:#7ff9e0;}',
      '.mk-rate-row{display:flex;align-items:center;gap:10px;}',
      '.mk-rate-lbl{font-size:9px;color:#8a93ad;}',
      '.mk-actions{display:flex;flex-wrap:wrap;gap:8px;}',
      '.mk-comments{display:flex;flex-direction:column;gap:8px;}',
      '.mk-comments-h{font-size:9px;color:#ff9e2c;}',
      '.mk-comment{background:#141826;border:1px solid #232a40;border-radius:6px;padding:7px 9px;}',
      '.mk-reply{margin-left:18px;border-left:2px solid #2a3350;}',
      '.mk-comment-author{font-size:8px;color:#7ff9e0;margin-bottom:3px;}',
      '.mk-comment-text{font-size:9px;color:#cfd4e8;line-height:1.6;word-break:break-word;}',
      '.mk-reply-btn{font-family:inherit;font-size:7px;color:#8a93ad;background:transparent;border:0;cursor:pointer;padding:3px 0 0;text-decoration:underline;}',
      '.mk-comment-input{font-family:inherit;font-size:9px;color:#0e111b;background:#e7ecff;border:0;border-radius:6px;padding:8px;resize:vertical;}',
      '.mk-detail-status{font-size:8px;color:#7ff9e0;min-height:11px;text-align:center;}',
      '@media(max-width:520px){.mk-detail-top{flex-direction:column;align-items:center;}}'
    ].join('');
    var st = el('style'); st.id = 'market-style'; st.textContent = css; document.head.appendChild(st);
  }

  window.Market = { open: open, close: hide, publishTexture: publishTexture };
})();
