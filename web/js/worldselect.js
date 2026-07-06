// worldselect.js -- global WorldSelect.
//
// The "Select World" screen (Part II, ARCHITECTURE-MP.md §4.3) owning
// #screen-worlds. Two tabs:
//
//   - My Worlds: a "Local world" card ALWAYS FIRST (fully offline, guest-
//     friendly -- Continue/Play + New world, exactly the Part I flow that
//     used to live on the main menu, ported here verbatim so guests keep the
//     identical experience) plus, when signed in, "Upload to server" (reads
//     the local IndexedDB world via world.exportLocalDeltas() then
//     Store.worldsImport()) and every server world the player owns or is a
//     member of (Store.worldsList()): name, seed, role badge, members, a
//     LIVE badge with a Join button when currently hosted. Actions: Play
//     (= host private), Host (access public/password/friends + PIN),
//     Rename/Members/Delete (owner), Leave world (member), New world.
//   - Join a Game: Store.roomsList() browser, polled every 5s ONLY while this
//     tab is visible (interval cleared on hide/tab-switch): world name, host,
//     player count/cap, access icon, Join (PIN prompt for password rooms).
//
// Both Play and Host hit Store.roomsOpen(...) then Net.connect(...) then
// Game.startMultiplayer(...); a 409 (already hosted) surfaces a "join
// instead?" modal using the host/roomId the server already told us about.
//
// Modal chrome (#modal-root, .pixmodal/.modal-overlay/.tab-row/.form-row/...)
// duplicates menu.js's exact structural + CSS-class pattern (each file is its
// own IIFE/global per the house rules, so there is no shared import to reuse
// directly) -- this keeps the visuals identical without inventing a new look.
//
// Exposes exactly one global: window.WorldSelect
// Depends on globals (typeof-guarded): I18n, Store, App, Game, Net, World,
// WorldGen, Menu (for its toast), Sound.

var WorldSelect = (function () {
  'use strict';

  // ---- internal state -------------------------------------------------------
  var rootEl = null;            // #screen-worlds
  var built = false;
  var i18nWired = false;
  var activeTab = 'mine';       // 'mine' | 'join'
  var joinPollId = 0;
  var JOIN_POLL_MS = 5000;

  var localHasSave = false;     // World.load('default') probe result
  var localSaveMeta = null;

  // ---- i18n shortcut ---------------------------------------------------------
  function t(key, fallback) {
    if (typeof I18n !== 'undefined' && I18n.t) return I18n.t(key, fallback);
    return fallback != null ? fallback : key;
  }

  // ---- tiny DOM helpers (mirrors menu.js's el()/appendChildren()) -----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    appendChildren(node, children);
    return node;
  }
  function appendChildren(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) { children.forEach(function (c) { appendChildren(node, c); }); }
    else if (typeof children === 'string' || typeof children === 'number') { node.appendChild(document.createTextNode(String(children))); }
    else if (children instanceof Node) { node.appendChild(children); }
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function byId(id) { return document.getElementById(id); }
  function click() { if (window.Sound && Sound.play) { try { Sound.play('click'); } catch (e) { /* ignore */ } } }

  // Reuse Menu's existing toast UI (same look, avoids a second toast host).
  function toast(msg, kind) {
    if (typeof Menu !== 'undefined' && Menu.toast) { Menu.toast(msg, kind); return; }
    try { console.warn('[WorldSelect]', msg); } catch (e) { /* ignore */ }
  }

  // ---- minimal SVG icon set (matches menu.js's chunky/stroke-only style) ---
  var ICON_PATHS = {
    x: ['M6 6 L18 18', 'M18 6 L6 18'],
    plus: ['M12 5 V19', 'M5 12 H19'],
    play: ['M8 5 L19 12 L8 19 Z'],
    check: ['M5 13 L10 18 L19 6'],
    globe: ['M3 12 A9 9 0 1 0 21 12 A9 9 0 1 0 3 12', 'M3 12 H21', 'M12 3 C8 7 8 17 12 21', 'M12 3 C16 7 16 17 12 21'],
    lock: ['M6 11 H18 V21 H6 Z', 'M8 11 V8 A4 4 0 0 1 16 8 V11'],
    friends: [
      'M2 21 L2 19 Q2 15.5 7 15.5 Q12 15.5 12 19 L12 21',
      'M4 9.5 A3.5 3.5 0 1 0 11 9.5 A3.5 3.5 0 1 0 4 9.5',
      'M13.5 21 L13.5 19.2 Q13.5 16.5 18 16 Q22.5 16.5 22.5 19.2 L22.5 21',
      'M15.5 6.2 A3 3 0 1 0 21.5 6.2 A3 3 0 1 0 15.5 6.2'
    ],
    edit: ['M5 19 H9 L18 10 L14 6 L5 15 Z', 'M13 7 L17 11'],
    trash: ['M5 7 H19', 'M9 7 V4 H15 V7', 'M7 7 L8 20 H16 L17 7'],
    upload: ['M12 15 V4', 'M7 9 L12 4 L17 9', 'M4 19 H20'],
    logout: ['M14 4 H6 V20 H14', 'M10 12 H21', 'M17 8 L21 12 L17 16']
  };
  function icon(name, size) {
    var s = size || 14;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.4');
    svg.setAttribute('stroke-linecap', 'square');
    svg.setAttribute('stroke-linejoin', 'miter');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'inline-block';
    svg.style.verticalAlign = 'middle';
    svg.style.flex = '0 0 auto';
    (ICON_PATHS[name] || []).forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // =========================================================================
  // Modal infrastructure -- duplicates menu.js's exact structural/CSS pattern
  // (#modal-root, .modal-overlay/.pixmodal/.pixmodal-head/.pixmodal-body/
  // .form-row/.form-err/.modal-actions/.tab-row/.tab-btn/.pixbtn*/.pixinput),
  // all already styled by menu.js's injected stylesheet (menu.js always loads
  // and Menu.show() always runs at boot, well before this screen is reachable).
  // =========================================================================
  function modalHost() {
    var host = byId('modal-root');
    if (!host) { host = el('div', { id: 'modal-root' }); document.body.appendChild(host); }
    return host;
  }
  function openModal(node) {
    closeAnyModal();
    var overlay = el('div', { class: 'modal-overlay' });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeAnyModal(); });
    overlay.appendChild(node);
    var onKey = function (e) { if (e.key === 'Escape') closeAnyModal(); };
    overlay._onKey = onKey;
    document.addEventListener('keydown', onKey);
    modalHost().appendChild(overlay);
    return overlay;
  }
  function closeAnyModal() {
    var host = byId('modal-root'); if (!host) return;
    while (host.firstChild) {
      var ov = host.firstChild;
      if (ov._onKey) document.removeEventListener('keydown', ov._onKey);
      host.removeChild(ov);
    }
  }
  function modalShell(titleText, bodyNodes, opts) {
    opts = opts || {};
    var closeBtn = el('button', { class: 'modal-x', type: 'button', title: t('common.close', 'Close'), onclick: closeAnyModal }, [icon('x', 14)]);
    return el('div', { class: 'pixmodal' + (opts.wide ? ' pixmodal-wide' : '') }, [
      el('div', { class: 'pixmodal-head' }, [el('h3', { class: 'pixmodal-title', text: titleText }), closeBtn]),
      el('div', { class: 'pixmodal-body' }, bodyNodes)
    ]);
  }
  function formRow(labelText, control, hintText) {
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'form-label', text: labelText }), control,
      hintText ? el('div', { class: 'form-hint', text: hintText }) : null
    ]);
  }
  function confirmModal(msg, yesLabel, onYes) {
    openModal(modalShell(t('common.confirm', 'Are you sure?'), [
      el('p', { class: 'modal-lead', text: msg }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        el('button', {
          class: 'pixbtn pixbtn-danger', type: 'button',
          onclick: function () { closeAnyModal(); onYes(); }
        }, [el('span', { text: yesLabel })])
      ])
    ]));
  }

  // Seed input: plain integers pass through; any other text is FNV-1a hashed
  // (same helper Part I's menu.js used -- shareable, deterministic seeds).
  function parseSeed(str) {
    str = (str || '').trim();
    if (!str) return undefined;
    if (/^[+-]?\d+$/.test(str)) {
      var n = parseInt(str, 10);
      if (isFinite(n)) return n | 0;
    }
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  }

  function nickFor() {
    if (typeof Store !== 'undefined' && Store.getNickname) {
      try { var n = Store.getNickname(); if (n) return n; } catch (e) { /* ignore */ }
    }
    return t('mp.guestNick', 'Guest');
  }

  function currentSkin() { return (typeof App !== 'undefined') ? App.skin : null; }

  // =========================================================================
  // Screen shell: header + tabs + content
  // =========================================================================
  function ensureRoot() {
    rootEl = byId('screen-worlds');
    if (!rootEl) { rootEl = el('div', { id: 'screen-worlds', class: 'screen' }); document.body.appendChild(rootEl); }
    return rootEl;
  }

  function build() {
    if (built) { rebuildStaticText(); return; }
    ensureRoot();
    clear(rootEl);

    var backBtn = el('button', {
      id: 'ws-back-btn', class: 'ws-back-btn', type: 'button',
      onclick: function () {
        click();
        if (typeof App !== 'undefined' && App.showScreen) App.showScreen('menu');
      }
    }, [icon('x', 12), el('span', { text: t('wardrobe.back', 'Back') })]);

    var titleEl = el('h2', { id: 'ws-title', class: 'ws-title', text: t('worlds.title', 'Select World') });

    var tabMine = el('button', {
      class: 'tab-btn tab-btn-active', type: 'button',
      onclick: function () { click(); switchTab('mine'); }
    }, [el('span', { text: t('worlds.tabMine', 'My Worlds') })]);
    var tabJoin = el('button', {
      class: 'tab-btn', type: 'button',
      onclick: function () { click(); switchTab('join'); }
    }, [el('span', { text: t('worlds.tabJoin', 'Join a Game') })]);
    var tabRow = el('div', { id: 'ws-tab-row', class: 'tab-row ws-tab-row' }, [tabMine, tabJoin]);

    var contentEl = el('div', { id: 'ws-content', class: 'ws-content' });

    rootEl.appendChild(el('div', { class: 'ws-inner' }, [
      el('div', { class: 'ws-head' }, [backBtn, titleEl]),
      tabRow,
      contentEl
    ]));

    injectStyles();
    built = true;
  }

  function rebuildStaticText() {
    var titleEl = byId('ws-title'); if (titleEl) titleEl.textContent = t('worlds.title', 'Select World');
    var back = byId('ws-back-btn');
    if (back) { var bs = back.querySelector('span'); if (bs) bs.textContent = t('wardrobe.back', 'Back'); }
    var row = byId('ws-tab-row');
    if (row) {
      var btns = row.querySelectorAll('.tab-btn');
      if (btns[0]) { var s0 = btns[0].querySelector('span'); if (s0) s0.textContent = t('worlds.tabMine', 'My Worlds'); }
      if (btns[1]) { var s1 = btns[1].querySelector('span'); if (s1) s1.textContent = t('worlds.tabJoin', 'Join a Game'); }
    }
    renderActiveTab();
  }

  function wireI18n() {
    if (i18nWired || typeof I18n === 'undefined' || !I18n.onChange) return;
    I18n.onChange(function () { rebuildStaticText(); });
    i18nWired = true;
  }

  function syncTabButtons() {
    var row = byId('ws-tab-row'); if (!row) return;
    var btns = row.querySelectorAll('.tab-btn');
    if (btns[0]) btns[0].classList.toggle('tab-btn-active', activeTab === 'mine');
    if (btns[1]) btns[1].classList.toggle('tab-btn-active', activeTab === 'join');
  }

  function renderActiveTab() {
    var contentEl = byId('ws-content');
    if (!contentEl) return;
    if (activeTab === 'mine') renderMyWorlds(contentEl);
    else renderJoinTab(contentEl);
  }

  function refreshMyWorlds() {
    if (activeTab === 'mine') renderActiveTab();
  }

  // Join tab polls GET /api/rooms every 5s ONLY while it is the visible tab
  // (contract §4.3) -- cleared on tab-switch, on hide(), and defensively
  // right before any action that leaves the screen entirely (Game bypasses
  // the App router for its own screen activation, so hide() alone cannot be
  // relied on for that specific transition).
  function startRoomsPolling() {
    stopRoomsPolling();
    joinPollId = setInterval(function () { refreshRoomsList(); }, JOIN_POLL_MS);
  }
  function stopRoomsPolling() {
    if (joinPollId) { clearInterval(joinPollId); joinPollId = 0; }
  }

  function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    stopRoomsPolling();
    syncTabButtons();
    renderActiveTab();
    if (activeTab === 'join') startRoomsPolling();
  }

  function show() {
    build();
    wireI18n();
    renderActiveTab();
    if (activeTab === 'join') startRoomsPolling();
    if (typeof App !== 'undefined' && App.showScreen) App.showScreen('worlds');
    else rootEl.classList.add('active');
  }

  function hide() {
    stopRoomsPolling();
  }

  // =========================================================================
  // MY WORLDS tab
  // =========================================================================
  function renderMyWorlds(container) {
    clear(container);
    container.appendChild(buildLocalWorldCard());

    var signedIn = (typeof Store !== 'undefined' && Store.isLoggedIn && Store.isLoggedIn());
    if (signedIn && typeof Store.worldsList === 'function') {
      var loadingNote = el('p', { class: 'ws-hint', text: t('worlds.loading', 'Loading your worlds…') });
      container.appendChild(loadingNote);
      Store.worldsList().then(function (list) {
        if (loadingNote.parentNode) loadingNote.parentNode.removeChild(loadingNote);
        list.forEach(function (w) { container.appendChild(buildServerWorldCard(w)); });
        container.appendChild(buildNewWorldCard());
      }).catch(function (err) {
        loadingNote.textContent = (err && err.message) || t('worlds.loadFail', 'Could not load your worlds.');
      });
    } else {
      container.appendChild(el('p', { class: 'ws-hint', text: t('worlds.signInHint', 'Sign in to host your own worlds and invite friends.') }));
    }
  }

  // ---- Local world card (ported verbatim from Part I's menu.js) -----------
  function probeLocalSave() {
    if (typeof World === 'undefined' || !World.load) {
      localHasSave = false; localSaveMeta = null;
      return Promise.resolve(null);
    }
    return World.load('default').then(function (saved) {
      localHasSave = !!saved;
      localSaveMeta = (saved && saved.meta) || null;
      return saved;
    }).catch(function () { localHasSave = false; localSaveMeta = null; return null; });
  }

  function startLocalGame(opts) {
    if (typeof Game === 'undefined' || !Game.start) {
      toast(t('vox.err.noEngine', 'The voxel engine failed to load — check the console.'), 'warn');
      return;
    }
    stopRoomsPolling();
    Promise.resolve(Game.start(opts)).catch(function (err) {
      toast((err && err.message) || t('vox.err.startFail', 'Could not start the world.'), 'danger');
    });
  }

  function onLocalPlay() {
    click();
    startLocalGame((localHasSave && localSaveMeta && localSaveMeta.mode) ? { mode: localSaveMeta.mode } : { mode: 'survival' });
  }

  function openLocalNewWorldModal() {
    var mode = 'survival';
    var seedInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '48', autocomplete: 'off', spellcheck: 'false',
      placeholder: t('menu.seedPh', 'a number, or any words')
    });

    function makeModeBtn(id, key, fallback) {
      return el('button', {
        class: 'tab-btn' + (mode === id ? ' tab-btn-active' : ''), type: 'button',
        onclick: function () { mode = id; syncTabs(); }
      }, [el('span', { text: t(key, fallback) })]);
    }
    var tabs = el('div', { class: 'tab-row' }, [
      makeModeBtn('survival', 'vox.mode.survival', 'Survival'),
      makeModeBtn('creative', 'vox.mode.creative', 'Creative')
    ]);
    function syncTabs() {
      var btns = tabs.querySelectorAll('.tab-btn');
      btns[0].classList.toggle('tab-btn-active', mode === 'survival');
      btns[1].classList.toggle('tab-btn-active', mode === 'creative');
    }

    var warn = localHasSave
      ? el('p', { class: 'form-err', text: t('menu.newWorldWarn', 'Careful: this replaces your saved world!') })
      : null;

    var createBtn = el('button', {
      class: 'pixbtn pixbtn-primary', type: 'button',
      onclick: function () {
        click();
        var opts = { fresh: true, mode: mode };
        var seed = parseSeed(seedInput.value);
        if (seed !== undefined) opts.seed = seed;
        closeAnyModal();
        startLocalGame(opts);
      }
    }, [icon('play', 14), el('span', { text: t('menu.createWorld', 'Create world') })]);

    var body = [
      formRow(t('menu.seed', 'Seed (optional)'), seedInput, t('menu.seedHint', 'Same seed = same world. Empty = random.')),
      formRow(t('menu.mode', 'Mode'), tabs),
      warn,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        createBtn
      ])
    ];
    openModal(modalShell(t('menu.newWorldTitle', 'New world'), body));
    setTimeout(function () { seedInput.focus(); }, 30);
  }

  function buildLocalWorldCard() {
    var card = el('div', { class: 'ws-card ws-card-local' });
    var playSpan = el('span', { text: t('menu.play', 'Play') });
    var playBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: onLocalPlay }, [icon('play', 14), playSpan]);
    var newBtn = el('button', {
      class: 'pixbtn-ghost', type: 'button',
      onclick: function () { click(); openLocalNewWorldModal(); }
    }, [icon('plus', 12), el('span', { text: t('menu.newWorld', 'New world') })]);

    var actions = el('div', { class: 'ws-card-actions' }, [playBtn, newBtn]);
    var signedIn = (typeof Store !== 'undefined' && Store.isLoggedIn && Store.isLoggedIn());
    if (signedIn) {
      actions.appendChild(el('button', {
        class: 'pixbtn-ghost', type: 'button', onclick: function () { click(); openUploadModal(); }
      }, [icon('upload', 12), el('span', { text: t('worlds.upload', 'Upload to server') })]));
    }

    card.appendChild(el('div', { class: 'ws-card-head' }, [
      el('span', { class: 'ws-card-name', text: t('worlds.local', 'Local world') }),
      el('span', { class: 'ws-card-badge ws-badge-offline', text: t('worlds.offline', 'Offline') })
    ]));
    card.appendChild(el('p', { class: 'ws-card-sub', text: t('worlds.localHint', 'Played only on this device — no account needed.') }));
    card.appendChild(actions);

    probeLocalSave().then(function (saved) {
      playSpan.textContent = saved ? t('menu.continue', 'Continue') : t('menu.play', 'Play');
    });

    return card;
  }

  function openUploadModal() {
    if (!localHasSave) {
      toast(t('worlds.noLocalSave', 'No local world to upload yet — play locally first.'), 'warn');
      return;
    }
    if (typeof World === 'undefined' || typeof WorldGen === 'undefined' || typeof Store === 'undefined' || !Store.worldsImport) {
      toast(t('vox.err.noEngine', 'The voxel engine failed to load — check the console.'), 'warn');
      return;
    }

    var nameInput = el('input', { class: 'pixinput', type: 'text', maxlength: '32', value: t('worlds.localDefaultName', 'My World') });
    var errLine = el('div', { class: 'form-err', text: '' });
    var goBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [icon('upload', 14), el('span', { text: t('worlds.uploadAction', 'Upload') })]);

    goBtn.addEventListener('click', function () {
      var name = (nameInput.value || '').trim().slice(0, 32) || t('worlds.localDefaultName', 'My World');
      errLine.textContent = '';
      goBtn.disabled = true; goBtn.classList.add('pixbtn-disabled');

      World.load('default').then(function (saved) {
        if (!saved) throw new Error(t('worlds.noLocalSave', 'No local world to upload yet — play locally first.'));
        var gen = WorldGen.create(saved.seed);
        var w = World.create({ seed: saved.seed, name: 'default', gen: gen, edits: saved.edits });
        return w.exportLocalDeltas().then(function (deltas) {
          return Store.worldsImport({ name: name, seed: saved.seed, deltas: deltas });
        });
      }).then(function () {
        closeAnyModal();
        toast(t('worlds.uploaded', 'Uploaded! Find it in your worlds list below.'), 'info');
        refreshMyWorlds();
        confirmModal(
          t('worlds.deleteLocalConfirm', 'Delete the local copy now that it lives on the server?'),
          t('worlds.deleteLocalYes', 'Delete local copy'),
          function () { World.wipe('default').then(function () { refreshMyWorlds(); }); }
        );
      }).catch(function (err) {
        goBtn.disabled = false; goBtn.classList.remove('pixbtn-disabled');
        errLine.textContent = (err && err.message) || t('worlds.uploadFail', 'Upload failed.');
      });
    });

    var body = [
      el('p', { class: 'modal-lead', text: t('worlds.uploadLead', 'Your local edits become a server world you can host for friends.') }),
      formRow(t('worlds.name', 'World name'), nameInput),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        goBtn
      ])
    ];
    openModal(modalShell(t('worlds.uploadTitle', 'Upload to server'), body));
    setTimeout(function () { nameInput.focus(); nameInput.select(); }, 30);
  }

  // ---- server world cards ---------------------------------------------------
  function buildServerWorldCard(w) {
    var card = el('div', { class: 'ws-card' });
    var badges = [el('span', {
      class: 'ws-card-badge ' + (w.role === 'owner' ? 'ws-badge-owner' : 'ws-badge-member'),
      text: w.role === 'owner' ? t('worlds.owner', 'Owner') : t('worlds.member', 'Member')
    })];
    if (w.live) badges.push(el('span', { class: 'ws-card-badge ws-badge-live', text: t('worlds.live', 'LIVE') }));

    card.appendChild(el('div', { class: 'ws-card-head' }, [el('span', { class: 'ws-card-name', text: w.name || t('worlds.unnamed', 'Unnamed world') })].concat(badges)));
    var memberCount = 1 + ((w.members && w.members.length) || 0);
    card.appendChild(el('p', {
      class: 'ws-card-sub',
      text: t('worlds.seedLabel', 'Seed {s}').replace('{s}', w.seed) + ' · ' +
        t('worlds.membersLabel', '{n} members').replace('{n}', String(memberCount))
    }));

    var actions = el('div', { class: 'ws-card-actions' });

    if (w.live) {
      card.appendChild(el('p', {
        class: 'ws-card-live-line',
        text: t('worlds.liveLine', 'Hosted by {h} · {n} players').replace('{h}', w.live.host).replace('{n}', String(w.live.players))
      }));
      actions.appendChild(el('button', {
        class: 'pixbtn pixbtn-primary', type: 'button',
        onclick: function () { joinExisting(w.live.roomId); }
      }, [icon('play', 14), el('span', { text: t('worlds.join', 'Join') })]));
    } else {
      actions.appendChild(el('button', {
        class: 'pixbtn pixbtn-primary', type: 'button',
        onclick: function () { openRoom({ worldId: w.id, access: 'private' }); }
      }, [icon('play', 14), el('span', { text: t('menu.play', 'Play') })]));
      actions.appendChild(el('button', {
        class: 'pixbtn-ghost', type: 'button',
        onclick: function () { openHostModal(w); }
      }, [icon('globe', 12), el('span', { text: t('worlds.host', 'Host') })]));
    }

    if (w.role === 'owner') {
      actions.appendChild(el('button', {
        class: 'pixbtn-ghost ws-icon-btn', type: 'button', title: t('worlds.rename', 'Rename'),
        onclick: function () { openRenameModal(w); }
      }, [icon('edit', 13)]));
      actions.appendChild(el('button', {
        class: 'pixbtn-ghost ws-icon-btn', type: 'button', title: t('worlds.members', 'Members'),
        onclick: function () { openMembersModal(w); }
      }, [icon('friends', 13)]));
      actions.appendChild(el('button', {
        class: 'pixbtn-ghost ws-icon-btn ws-btn-danger', type: 'button', title: t('worlds.delete', 'Delete'),
        onclick: function () { confirmDeleteWorld(w); }
      }, [icon('trash', 13)]));
    } else {
      actions.appendChild(el('button', {
        class: 'pixbtn-ghost', type: 'button',
        onclick: function () { confirmLeaveWorld(w); }
      }, [icon('logout', 12), el('span', { text: t('worlds.leave', 'Leave world') })]));
    }

    card.appendChild(actions);
    return card;
  }

  function buildNewWorldCard() {
    var card = el('div', { class: 'ws-card ws-card-new' });
    card.appendChild(el('button', {
      class: 'pixbtn pixbtn-primary', type: 'button', onclick: function () { click(); openCreateWorldModal(); }
    }, [icon('plus', 16), el('span', { text: t('worlds.newWorld', 'New world') })]));
    return card;
  }

  function openCreateWorldModal() {
    var nameInput = el('input', { class: 'pixinput', type: 'text', maxlength: '32', placeholder: t('worlds.namePh', 'My awesome world') });
    var seedInput = el('input', { class: 'pixinput', type: 'text', maxlength: '48', placeholder: t('menu.seedPh', 'a number, or any words') });
    var errLine = el('div', { class: 'form-err', text: '' });
    var createBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [icon('plus', 14), el('span', { text: t('menu.createWorld', 'Create world') })]);

    createBtn.addEventListener('click', function () {
      var name = (nameInput.value || '').trim();
      if (!name) { errLine.textContent = t('worlds.nameRequired', 'A name is required.'); return; }
      errLine.textContent = '';
      createBtn.disabled = true; createBtn.classList.add('pixbtn-disabled');
      var opts = { name: name.slice(0, 32) };
      var seed = parseSeed(seedInput.value);
      if (seed !== undefined) opts.seed = seed;
      Store.worldsCreate(opts).then(function () {
        closeAnyModal();
        toast(t('worlds.created', 'World created!'), 'info');
        refreshMyWorlds();
      }).catch(function (err) {
        createBtn.disabled = false; createBtn.classList.remove('pixbtn-disabled');
        errLine.textContent = (err && err.message) || t('worlds.createFail', 'Could not create the world.');
      });
    });

    var body = [
      formRow(t('worlds.name', 'World name'), nameInput),
      formRow(t('menu.seed', 'Seed (optional)'), seedInput, t('menu.seedHint', 'Same seed = same world. Empty = random.')),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        createBtn
      ])
    ];
    openModal(modalShell(t('worlds.newWorldTitle', 'New world'), body));
    setTimeout(function () { nameInput.focus(); }, 30);
  }

  function openRenameModal(w) {
    var nameInput = el('input', { class: 'pixinput', type: 'text', maxlength: '32', value: w.name || '' });
    var errLine = el('div', { class: 'form-err', text: '' });
    var saveBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [icon('check', 14), el('span', { text: t('common.save', 'Save') })]);

    saveBtn.addEventListener('click', function () {
      var name = (nameInput.value || '').trim();
      if (!name) { errLine.textContent = t('worlds.nameRequired', 'A name is required.'); return; }
      errLine.textContent = '';
      saveBtn.disabled = true; saveBtn.classList.add('pixbtn-disabled');
      Store.worldsRename(w.id, name.slice(0, 32)).then(function () {
        closeAnyModal();
        toast(t('worlds.renamed', 'Renamed.'), 'info');
        refreshMyWorlds();
      }).catch(function (err) {
        saveBtn.disabled = false; saveBtn.classList.remove('pixbtn-disabled');
        errLine.textContent = (err && err.message) || t('worlds.renameFail', 'Rename failed.');
      });
    });

    var body = [
      formRow(t('worlds.name', 'World name'), nameInput),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        saveBtn
      ])
    ];
    openModal(modalShell(t('worlds.renameTitle', 'Rename world'), body));
    setTimeout(function () { nameInput.focus(); nameInput.select(); }, 30);
  }

  function confirmDeleteWorld(w) {
    confirmModal(
      t('worlds.deleteConfirm', 'Delete "{name}" permanently? This cannot be undone.').replace('{name}', w.name || ''),
      t('worlds.delete', 'Delete'),
      function () {
        Store.worldsDelete(w.id).then(function () {
          toast(t('worlds.deleted', 'World deleted.'), 'info');
          refreshMyWorlds();
        }).catch(function (err) {
          toast((err && err.message) || t('worlds.deleteFail', 'Could not delete — is it currently hosted?'), 'danger');
        });
      }
    );
  }

  function confirmLeaveWorld(w) {
    confirmModal(
      t('worlds.leaveConfirm', 'Leave "{name}"? You can be re-invited later.').replace('{name}', w.name || ''),
      t('worlds.leave', 'Leave world'),
      function () {
        var me = (typeof Store !== 'undefined' && Store.getUsername) ? Store.getUsername() : null;
        if (!me) return;
        Store.worldsMemberRemove(w.id, me).then(function () {
          toast(t('worlds.left', 'Left the world.'), 'info');
          refreshMyWorlds();
        }).catch(function (err) {
          toast((err && err.message) || t('worlds.leaveFail', 'Could not leave the world.'), 'danger');
        });
      }
    );
  }

  function openMembersModal(w) {
    var listEl = el('div', { class: 'ws-member-list' });

    function renderMembers(members) {
      clear(listEl);
      if (!members.length) { listEl.appendChild(el('p', { class: 'ws-hint', text: t('worlds.noMembers', 'No members yet.') })); return; }
      members.forEach(function (name) {
        listEl.appendChild(el('div', { class: 'ws-member-row' }, [
          el('span', { class: 'ws-member-name', text: name }),
          el('button', {
            class: 'pixbtn-ghost ws-icon-btn ws-btn-danger', type: 'button', title: t('worlds.remove', 'Remove'),
            onclick: function () {
              Store.worldsMemberRemove(w.id, name).then(function () {
                w.members = (w.members || []).filter(function (n) { return n !== name; });
                renderMembers(w.members);
                toast(t('worlds.memberRemoved', 'Removed.'), 'info');
              }).catch(function (err) {
                toast((err && err.message) || t('worlds.memberRemoveFail', 'Could not remove member.'), 'danger');
              });
            }
          }, [icon('x', 11)])
        ]));
      });
    }
    renderMembers(w.members || []);

    var userInput = el('input', { class: 'pixinput', type: 'text', maxlength: '24', placeholder: t('worlds.usernamePh', 'username') });
    var errLine = el('div', { class: 'form-err', text: '' });

    function addMember(name) {
      name = (name || '').trim();
      if (!name) return;
      errLine.textContent = '';
      Store.worldsMemberAdd(w.id, name).then(function () {
        w.members = (w.members || []).concat([name]);
        renderMembers(w.members);
        userInput.value = '';
        toast(t('worlds.memberAdded', 'Added.'), 'info');
      }).catch(function (err) {
        errLine.textContent = (err && err.message) || t('worlds.memberAddFail', 'Could not add that member.');
      });
    }
    var addBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: function () { addMember(userInput.value); } },
      [icon('plus', 12), el('span', { text: t('worlds.add', 'Add') })]);
    userInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addMember(userInput.value); } });

    var friendsPicker = el('div', { class: 'ws-friend-picker' });
    if (typeof Store !== 'undefined' && Store.friendsList) {
      Store.friendsList().then(function (d) {
        var names = (d && d.friends) || [];
        if (!names.length) return;
        friendsPicker.appendChild(el('div', { class: 'form-hint', text: t('worlds.friendPickHint', 'Quick-add a friend:') }));
        var row = el('div', { class: 'ws-friend-chip-row' });
        names.forEach(function (name) {
          row.appendChild(el('button', { class: 'pixbtn-ghost ws-chip', type: 'button', onclick: function () { addMember(name); } }, [el('span', { text: name })]));
        });
        friendsPicker.appendChild(row);
      }).catch(function () { /* offline — free-text add still works */ });
    }

    var body = [
      listEl,
      formRow(t('worlds.addMember', 'Add member'), el('div', { class: 'ws-inline-row' }, [userInput, addBtn])),
      friendsPicker,
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.close', 'Close') })])
      ])
    ];
    openModal(modalShell(t('worlds.membersTitle', 'Members of {name}').replace('{name}', w.name || ''), body, { wide: true }));
  }

  // ---- Play/Host -> Store.roomsOpen -> Net.connect -> Game.startMultiplayer -
  function openRoom(opts) {
    if (typeof Store === 'undefined' || !Store.roomsOpen) return;
    toast(t('worlds.opening', 'Opening the room…'), 'info');
    Store.roomsOpen(opts).then(function (res) {
      connectAndStart(res.roomId, null);
    }).catch(function (err) {
      if (err && err.status === 409 && err.data && err.data.roomId) {
        openAlreadyHostedModal(err.data);
      } else {
        toast((err && err.message) || t('worlds.hostFail', 'Could not open the room.'), 'danger');
      }
    });
  }

  function openAlreadyHostedModal(data) {
    var body = [
      el('p', { class: 'modal-lead', text: t('worlds.alreadyHosted', 'Already hosted by {host}.').replace('{host}', data.host || '?') }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        el('button', {
          class: 'pixbtn pixbtn-primary', type: 'button',
          onclick: function () { closeAnyModal(); joinExisting(data.roomId); }
        }, [icon('play', 14), el('span', { text: t('worlds.joinInstead', 'Join instead') })])
      ])
    ];
    openModal(modalShell(t('worlds.alreadyHostedTitle', 'Room already open'), body));
  }

  function openHostModal(w) {
    var access = 'public';
    var pinInput = el('input', { class: 'pixinput', type: 'text', maxlength: '12', placeholder: t('worlds.pinPh', '4-12 characters') });
    var pinRow = formRow(t('worlds.pin', 'PIN'), pinInput, t('worlds.pinHint', 'Anyone with this PIN can join.'));
    pinRow.style.display = 'none';

    function makeAccessBtn(id, key, fallback) {
      return el('button', {
        class: 'tab-btn' + (access === id ? ' tab-btn-active' : ''), type: 'button',
        onclick: function () { access = id; syncAccessTabs(); }
      }, [el('span', { text: t(key, fallback) })]);
    }
    var tabs = el('div', { class: 'tab-row' }, [
      makeAccessBtn('public', 'worlds.access.public', 'Public'),
      makeAccessBtn('password', 'worlds.access.password', 'Password'),
      makeAccessBtn('friends', 'worlds.access.friends', 'Friends')
    ]);
    function syncAccessTabs() {
      var btns = tabs.querySelectorAll('.tab-btn');
      btns[0].classList.toggle('tab-btn-active', access === 'public');
      btns[1].classList.toggle('tab-btn-active', access === 'password');
      btns[2].classList.toggle('tab-btn-active', access === 'friends');
      pinRow.style.display = (access === 'password') ? '' : 'none';
    }

    var errLine = el('div', { class: 'form-err', text: '' });
    var hostBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [icon('play', 14), el('span', { text: t('worlds.hostAction', 'Start hosting') })]);
    hostBtn.addEventListener('click', function () {
      errLine.textContent = '';
      var opts = { worldId: w.id, access: access };
      if (access === 'password') {
        var pin = (pinInput.value || '').trim();
        if (pin.length < 4 || pin.length > 12) { errLine.textContent = t('worlds.pinLenErr', 'PIN must be 4-12 characters.'); return; }
        opts.pin = pin;
      }
      closeAnyModal();
      openRoom(opts);
    });

    var body = [
      formRow(t('worlds.access', 'Who can join'), tabs),
      pinRow,
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        hostBtn
      ])
    ];
    openModal(modalShell(t('worlds.hostTitle', 'Host {name}').replace('{name}', w.name || ''), body));
  }

  function joinExisting(roomId, pin) {
    connectAndStart(roomId, pin || null);
  }

  var connectInFlight = false; // double-click/double-tap guard for Join/Play/Host

  function connectAndStart(roomId, pin) {
    if (connectInFlight) return; // a connect is already running -- ignore repeat clicks
    if (typeof Net === 'undefined' || !Net.connect) {
      toast(t('mp.err.noNet', 'Multiplayer networking failed to load.'), 'danger');
      return;
    }
    if (typeof Game === 'undefined' || !Game.startMultiplayer) {
      toast(t('vox.err.noEngine', 'The voxel engine failed to load — check the console.'), 'warn');
      return;
    }
    var skinRec = currentSkin();
    connectInFlight = true;
    toast(t('worlds.connecting', 'Connecting…'), 'info');
    stopRoomsPolling();
    var connectOpts = { roomId: roomId, skinRec: skinRec, mode: 'survival', nick: nickFor() };
    if (pin) connectOpts.pin = pin;
    Net.connect(connectOpts).then(function (welcome) {
      connectInFlight = false;
      return Game.startMultiplayer({ welcome: welcome, skinRec: skinRec });
    }).catch(function (err) {
      connectInFlight = false;
      toast((err && err.message) || t('mp.err.joinFail', 'Could not join the room.'), 'danger');
      // The join failed and we are still ON this screen: bring the room-list
      // polling back to life (it was stopped above in anticipation of
      // leaving), otherwise the Join tab silently goes stale after one
      // failed attempt. Visibility is implicit (no flag): the screen is
      // still active and the Join tab is the one that polls.
      if (activeTab === 'join' && rootEl && rootEl.classList.contains('active')) startRoomsPolling();
    });
  }

  // =========================================================================
  // JOIN A GAME tab
  // =========================================================================
  function renderJoinTab(container) {
    clear(container);
    var listEl = el('div', { id: 'ws-rooms-list', class: 'ws-rooms-list' });
    container.appendChild(listEl);
    refreshRoomsList(listEl);
  }

  function refreshRoomsList(listEl) {
    listEl = listEl || byId('ws-rooms-list');
    if (!listEl || typeof Store === 'undefined' || !Store.roomsList) return;
    Store.roomsList().then(function (rooms) {
      clear(listEl);
      if (!rooms.length) {
        listEl.appendChild(el('p', { class: 'ws-hint', text: t('worlds.noRooms', 'No public games right now — host your own from My Worlds!') }));
        if (!(typeof Store.isLoggedIn === 'function' && Store.isLoggedIn())) {
          listEl.appendChild(el('p', { class: 'ws-hint', text: t('worlds.joinSignInHint', 'Sign in to see games hosted just for friends.') }));
        }
        return;
      }
      rooms.forEach(function (r) { listEl.appendChild(buildRoomCard(r)); });
    }).catch(function () { /* transient network hiccup — keep the last-known list on screen */ });
  }

  function buildRoomCard(r) {
    // r: {roomId,worldId,worldName,host,access,locked,players,cap,uptime}
    var accessIcon = (r.access === 'public') ? 'globe' : (r.access === 'password' ? 'lock' : 'friends');
    var card = el('div', { class: 'ws-card' });
    card.appendChild(el('div', { class: 'ws-card-head' }, [
      icon(accessIcon, 14),
      el('span', { class: 'ws-card-name', text: r.worldName || t('worlds.unnamed', 'Unnamed world') })
    ]));
    card.appendChild(el('p', {
      class: 'ws-card-sub',
      text: t('worlds.roomLine', 'Hosted by {h} · {n}/{c} players')
        .replace('{h}', r.host).replace('{n}', String(r.players)).replace('{c}', String(r.cap))
    }));
    card.appendChild(el('div', { class: 'ws-card-actions' }, [
      el('button', {
        class: 'pixbtn pixbtn-primary', type: 'button',
        onclick: function () {
          if (r.access === 'password') openPinModal(r);
          else joinExisting(r.roomId);
        }
      }, [icon('play', 14), el('span', { text: t('worlds.join', 'Join') })])
    ]));
    return card;
  }

  function openPinModal(r) {
    var pinInput = el('input', { class: 'pixinput', type: 'text', maxlength: '12', placeholder: t('worlds.pinPh', '4-12 characters') });
    var errLine = el('div', { class: 'form-err', text: '' });
    var joinBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [icon('play', 14), el('span', { text: t('worlds.join', 'Join') })]);
    joinBtn.addEventListener('click', function () {
      var pin = (pinInput.value || '').trim();
      if (pin.length < 4 || pin.length > 12) { errLine.textContent = t('worlds.pinLenErr', 'PIN must be 4-12 characters.'); return; }
      closeAnyModal();
      joinExisting(r.roomId, pin);
    });
    var body = [
      formRow(t('worlds.pin', 'PIN'), pinInput),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.cancel', 'Cancel') })]),
        joinBtn
      ])
    ];
    openModal(modalShell(t('worlds.pinTitle', 'Enter PIN'), body));
    setTimeout(function () { pinInput.focus(); }, 30);
  }

  // =========================================================================
  // styles (self-injected, one-time — mirrors menu.js/HUD.js's own pattern)
  // =========================================================================
  function injectStyles() {
    if (byId('worldselect-styles')) return;
    var css = [
      '#screen-worlds{font-family:"Press Start 2P",monospace;color:#e8ecf5;position:relative;min-height:100%;}',
      '.ws-inner{max-width:820px;margin:0 auto;padding:20px 16px 40px;}',
      '.ws-head{display:flex;align-items:center;gap:14px;margin-bottom:16px;flex-wrap:wrap;}',
      '.ws-back-btn{font-family:inherit;font-size:10px;color:#9aa3bf;background:transparent;border:2px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;padding:8px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;}',
      '.ws-back-btn:hover{color:#1a1d2e;background:#7ff9e0;border-color:#1a1d2e;}',
      '.ws-title{margin:0;font-size:16px;color:#ff9e2c;text-shadow:2px 2px 0 #1a1d2e;}',
      '.ws-tab-row{max-width:360px;margin:0 0 18px;}',
      '.ws-content{display:flex;flex-direction:column;gap:12px;}',
      '.ws-card{background:#181b2c;border:3px solid #3a3f5c;box-shadow:5px 5px 0 #0a0b14;padding:14px;}',
      '.ws-card-local{border-color:#2b5fff;}',
      '.ws-card-new{display:flex;align-items:center;justify-content:center;min-height:60px;}',
      '.ws-card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;color:#7ff9e0;}',
      '.ws-card-name{font-size:12px;color:#e8ecf5;}',
      '.ws-card-badge{font-size:7px;padding:3px 7px;border:2px solid #1a1d2e;text-transform:uppercase;letter-spacing:1px;}',
      '.ws-badge-offline{background:#2b5fff;color:#fff;}',
      '.ws-badge-owner{background:#ff9e2c;color:#1a1d2e;}',
      '.ws-badge-member{background:#7ff9e0;color:#1a1d2e;}',
      '.ws-badge-live{background:#ff6b6b;color:#1a1d2e;animation:ws-pulse 1.6s ease-in-out infinite;}',
      '@keyframes ws-pulse{0%,100%{opacity:1;}50%{opacity:.5;}}',
      '.ws-card-sub{font-size:9px;color:#9aa3bf;margin:0 0 8px;line-height:1.6;}',
      '.ws-card-live-line{font-size:9px;color:#7ff9e0;margin:0 0 8px;}',
      '.ws-card-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.ws-icon-btn{padding:8px;}',
      '.ws-btn-danger{color:#ff6b6b;border-color:#ff6b6b;}',
      '.ws-btn-danger:hover{background:#ff6b6b;color:#1a1d2e;}',
      '.ws-hint{font-size:9px;color:#646b8a;line-height:1.8;text-align:center;padding:14px 0;}',
      '.ws-rooms-list{display:flex;flex-direction:column;gap:12px;}',
      '.ws-member-list{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;}',
      '.ws-member-row{display:flex;align-items:center;justify-content:space-between;background:#10121f;border:2px solid #3a3f5c;padding:8px 10px;}',
      '.ws-member-name{font-size:10px;color:#cfd4e8;}',
      '.ws-inline-row{display:flex;gap:8px;}',
      '.ws-inline-row .pixinput{flex:1;}',
      '.ws-friend-picker{display:flex;flex-direction:column;gap:6px;}',
      '.ws-friend-chip-row{display:flex;gap:6px;flex-wrap:wrap;}',
      '.ws-chip{font-size:8px;padding:6px 10px;}',
      '@media (max-width:560px){.ws-card-actions{flex-direction:column;align-items:stretch;}.ws-card-actions .pixbtn,.ws-card-actions .pixbtn-ghost{width:100%;justify-content:center;}}'
    ].join('\n');
    var style = el('style', { id: 'worldselect-styles' });
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- public API -----------------------------------------------------------
  return {
    show: show,
    hide: hide
  };
})();

window.WorldSelect = WorldSelect;
