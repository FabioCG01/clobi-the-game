// menu.js -- global Menu.
//
// The main menu of "Tux Smash Royale" (Clobi's Arena):
//   - Kahoot-style nickname field (prefilled from Store).
//   - [Play] and [Edit Character] buttons.
//   - The public ROOM LIST: auto-refresh via LIST_ROOMS/ROOM_LIST. Each row shows
//     the room name, its mode (Tux Smash / Distro Royale), players/max, and a lock
//     icon when password-protected. Click a row to join (prompts for a password if
//     it is locked).
//   - Create Room: name + optional password + MODE selector + max players.
//   - In-room lobby: every player's character preview (via Sprites.drawCharacter),
//     a Ready toggle, a host-only Start, and Leave.
//   - A SUBTLE top-right "Sign in" button opening the account modal (register /
//     login / logout via Store) and a small language switcher.
//   - Menu.showLanguagePopup(): the first-visit / on-demand 8-bit language chooser
//     listing I18n.LANGS, English highlighted as the default.
//
// A respectful TRIBUTE to Clobi delivered through comedy. ZERO forced-signup nags.
// All user-facing text flows through I18n.t(key, fallbackEn) and re-renders when the
// language changes.
//
// Exposes exactly one global: window.Menu
// Depends on globals: Protocol, Net, Store, Sprites, I18n, App, Game, Editor.

const Menu = (function () {
  'use strict';

  // ---- internal state ----------------------------------------------------
  let rootEl = null;          // #screen-menu
  let built = false;          // DOM built once
  let listTimer = null;       // room-list auto-refresh interval
  let netWired = false;       // Net handlers attached once
  let i18nWired = false;      // I18n.onChange attached once
  let myPlayerId = null;      // our own player id (from HELLO_OK / App.playerId)

  // view = 'browser' (menu + room list) | 'lobby' (inside a room)
  let view = 'browser';

  let rooms = [];             // last ROOM_LIST payload (array of RoomSummary)
  let currentRoom = null;     // last ROOM_JOINED / ROOM_UPDATE RoomInfo
  let lobbyCanvases = [];     // {canvas, character} pending redraw

  const LIST_REFRESH_MS = 2500;

  // ---- i18n shortcut -----------------------------------------------------
  function t(key, fallback) {
    if (typeof I18n !== 'undefined' && I18n.t) return I18n.t(key, fallback);
    return fallback != null ? fallback : key;
  }

  // ---- tiny DOM helpers --------------------------------------------------
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'dataset') {
          for (const dk in v) node.dataset[dk] = v[dk];
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
    if (Array.isArray(children)) {
      children.forEach(function (c) { appendChildren(node, c); });
    } else if (typeof children === 'string' || typeof children === 'number') {
      node.appendChild(document.createTextNode(String(children)));
    } else if (children instanceof Node) {
      node.appendChild(children);
    }
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function byId(id) { return document.getElementById(id); }

  // SVG icon factory (real vector icons, NO emoji). Returns an <svg> scaled to px.
  function icon(name, size) {
    const s = size || 14;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
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
    svg.style.imageRendering = 'pixelated';
    const paths = ICONS[name] || [];
    paths.forEach(function (d) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // Blocky, low-detail SVG glyphs to match the chunky 8-bit aesthetic.
  const ICONS = {
    user: [
      'M4 21 L4 18 Q4 14 12 14 Q20 14 20 18 L20 21',
      'M8 7 A4 4 0 1 0 16 7 A4 4 0 1 0 8 7'
    ],
    lock: [
      'M5 11 H19 V21 H5 Z',
      'M8 11 V7 A4 4 0 0 1 16 7 V11'
    ],
    plus: ['M12 5 V19', 'M5 12 H19'],
    refresh: [
      'M20 11 A8 8 0 1 0 18 17',
      'M20 5 V11 H14'
    ],
    check: ['M5 13 L10 18 L19 6'],
    play: ['M7 5 L19 12 L7 19 Z'],
    x: ['M6 6 L18 18', 'M18 6 L6 18'],
    arrowLeft: ['M14 6 L8 12 L14 18'],
    crown: ['M4 8 L8 14 L12 6 L16 14 L20 8 L18 19 L6 19 Z'],
    logout: ['M14 4 H6 V20 H14', 'M10 12 H21', 'M17 8 L21 12 L17 16'],
    globe: [
      'M3 12 A9 9 0 1 0 21 12 A9 9 0 1 0 3 12',
      'M3 12 H21',
      'M12 3 C8 7 8 17 12 21',
      'M12 3 C16 7 16 17 12 21'
    ],
    sword: ['M14 4 L20 4 L20 10', 'M20 4 L11 13', 'M4 16 L8 20', 'M9 15 L6 18'],
    storm: ['M5 13 A6 6 0 1 1 17 11', 'M13 9 L9 15 H13 L9 21']
  };

  // ---- mode helpers ------------------------------------------------------
  const MODE_SMASH = 'smash';
  const MODE_ROYALE = 'royale';

  function modeLabel(mode) {
    if (mode === MODE_ROYALE) return t('mode.royale', 'Distro Royale');
    return t('mode.smash', 'Tux Smash');
  }

  function modeIcon(mode, size) {
    return icon(mode === MODE_ROYALE ? 'storm' : 'sword', size || 12);
  }

  // ---- screen build ------------------------------------------------------
  function ensureRoot() {
    rootEl = byId('screen-menu');
    if (!rootEl) {
      // Defensive: index.html owns these containers, but never break if missing.
      rootEl = el('div', { id: 'screen-menu', class: 'screen' });
      document.body.appendChild(rootEl);
    }
    return rootEl;
  }

  function build() {
    if (built) {
      // A rebuild is requested (e.g. language change) -- recompute labels.
      rebuildStaticText();
      return;
    }
    ensureRoot();
    clear(rootEl);

    // ---------- Top-right corner: language switcher + subtle sign-in ----------
    const langBtn = el('button', {
      id: 'menu-lang-btn',
      class: 'corner-btn pixbtn-ghost',
      type: 'button',
      title: t('nav.language', 'Language'),
      onclick: showLanguagePopup
    }, [icon('globe', 13), el('span', { class: 'corner-lang-label', text: currentLangName() })]);

    const signLabel = el('span', { class: 'signin-label', text: t('nav.signIn', 'Sign in') });
    const signBtn = el('button', {
      id: 'menu-signin-btn',
      class: 'corner-btn signin-btn pixbtn-ghost',
      type: 'button',
      title: t('nav.signIn', 'Sign in'),
      onclick: openAccountModal
    }, [icon('user', 13), signLabel]);

    const corner = el('div', { class: 'menu-corner' }, [langBtn, signBtn]);

    // ---------- Title ----------
    const title = el('div', { class: 'menu-title' }, [
      el('h1', { class: 'title-main', text: 'TUX SMASH' }),
      el('h2', { class: 'title-sub', text: 'ROYALE' }),
      el('p', { id: 'menu-tagline', class: 'title-tag', text: t('app.tagline', "Clobi's Arena.") })
    ]);

    // ---------- Identity row: nickname (Kahoot-style) ----------
    const nickInput = el('input', {
      id: 'menu-nickname',
      class: 'kahoot-nick pixinput',
      type: 'text',
      maxlength: '16',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: t('menu.nicknamePh', 'Your penguin name'),
      oninput: onNicknameInput
    });
    const nickRow = el('div', { class: 'menu-nick-row' }, [
      el('label', { id: 'menu-nick-label', class: 'nick-label', for: 'menu-nickname', text: t('menu.nickname', 'Nickname') }),
      nickInput
    ]);

    // ---------- Primary actions ----------
    const playBtn = el('button', {
      id: 'menu-play-btn',
      class: 'pixbtn pixbtn-primary',
      type: 'button',
      onclick: onClickPlay
    }, [icon('play', 16), el('span', { text: t('nav.play', 'Play') })]);

    const editBtn = el('button', {
      id: 'menu-edit-btn',
      class: 'pixbtn',
      type: 'button',
      onclick: onClickEditCharacter
    }, [icon('user', 16), el('span', { text: t('nav.editChar', 'Edit Character') })]);

    const actionRow = el('div', { class: 'menu-actions' }, [playBtn, editBtn]);

    // ---------- Public room browser ----------
    const refreshBtn = el('button', {
      id: 'menu-refresh-btn',
      class: 'pixbtn-ghost lobby-refresh',
      type: 'button',
      title: t('menu.refresh', 'Refresh'),
      onclick: requestRooms
    }, [icon('refresh', 14), el('span', { text: t('menu.refresh', 'Refresh') })]);

    const createBtn = el('button', {
      id: 'menu-create-btn',
      class: 'pixbtn-ghost lobby-create',
      type: 'button',
      title: t('menu.createRoom', 'Create Room'),
      onclick: openCreateRoomModal
    }, [icon('plus', 14), el('span', { text: t('menu.createRoom', 'Create Room') })]);

    const lobbyHead = el('div', { class: 'lobby-head' }, [
      el('h3', { id: 'menu-rooms-title', class: 'lobby-title', text: t('menu.rooms', 'Rooms') }),
      el('div', { class: 'lobby-head-btns' }, [refreshBtn, createBtn])
    ]);

    const roomListEl = el('div', { id: 'menu-room-list', class: 'room-list' });

    const browserView = el('div', { id: 'menu-browser', class: 'menu-browser' }, [
      nickRow,
      actionRow,
      el('div', { class: 'lobby-panel pixpanel' }, [lobbyHead, roomListEl])
    ]);

    // ---------- In-room lobby view (hidden until joined) ----------
    const lobbyView = el('div', { id: 'menu-lobby', class: 'menu-lobby hidden' });

    // ---------- Footer tribute (comedy, respectful) ----------
    const footer = el('div', { id: 'menu-footer', class: 'menu-footer' }, footerNodes());

    rootEl.appendChild(corner);
    rootEl.appendChild(el('div', { class: 'menu-inner' }, [
      title, browserView, lobbyView, footer
    ]));

    injectStyles();
    built = true;
  }

  function footerNodes() {
    // A wink to Clobi: vim, Fisherman's Friend menthol, and a firm NO to Windows.
    return [
      'In honor of Clobi -- vim, ',
      el('span', { class: 'accent-mint', text: "Fisherman's Friend" }),
      ', and a militant ',
      el('span', { class: 'accent-blue', text: 'NO' }),
      ' to Windows.'
    ];
  }

  // Recompute all static (non-list) labels after a language switch.
  function rebuildStaticText() {
    setText('menu-tagline', t('app.tagline', "Clobi's Arena."));
    setText('menu-nick-label', t('menu.nickname', 'Nickname'));
    setPlaceholder('menu-nickname', t('menu.nicknamePh', 'Your penguin name'));
    setBtnLabel('menu-play-btn', t('nav.play', 'Play'));
    setBtnLabel('menu-edit-btn', t('nav.editChar', 'Edit Character'));
    setBtnLabel('menu-refresh-btn', t('menu.refresh', 'Refresh'));
    setBtnLabel('menu-create-btn', t('menu.createRoom', 'Create Room'));
    setText('menu-rooms-title', t('menu.rooms', 'Rooms'));

    const langLabel = rootEl && rootEl.querySelector('.corner-lang-label');
    if (langLabel) langLabel.textContent = currentLangName();
    const langBtn = byId('menu-lang-btn');
    if (langBtn) langBtn.title = t('nav.language', 'Language');

    refreshAccountUi();
  }

  function setText(id, text) {
    const n = byId(id);
    if (n) n.textContent = text;
  }
  function setPlaceholder(id, text) {
    const n = byId(id);
    if (n) n.setAttribute('placeholder', text);
  }
  // Buttons render [icon, <span>label]; update the span only.
  function setBtnLabel(id, text) {
    const n = byId(id);
    if (!n) return;
    const span = n.querySelector('span');
    if (span) { span.textContent = text; }
    n.title = text;
  }

  // ---- public: show / hide ----------------------------------------------
  function show() {
    build();
    wireNet();
    wireI18n();
    syncFromApp();
    refreshAccountUi();
    resolveMyId();

    if (currentRoom) {
      view = 'lobby';
      renderLobby();
    } else {
      view = 'browser';
      showBrowser();
    }

    if (typeof App !== 'undefined' && App.showScreen) {
      App.showScreen('menu');
    } else {
      rootEl.classList.add('active');
      rootEl.style.display = '';
    }

    startRoomPolling();
  }

  function hide() {
    stopRoomPolling();
  }

  function showBrowser() {
    view = 'browser';
    const b = byId('menu-browser');
    const l = byId('menu-lobby');
    if (b) b.classList.remove('hidden');
    if (l) l.classList.add('hidden');
    renderRoomList();
  }

  function showLobbyPane() {
    view = 'lobby';
    const b = byId('menu-browser');
    const l = byId('menu-lobby');
    if (b) b.classList.add('hidden');
    if (l) l.classList.remove('hidden');
  }

  // ---- App / Store sync --------------------------------------------------
  function getNickname() {
    if (typeof App !== 'undefined' && App.nickname) return App.nickname;
    if (typeof Store !== 'undefined' && Store.getNickname) return Store.getNickname() || '';
    return '';
  }

  function setNickname(n) {
    n = (n || '').slice(0, 16);
    if (typeof App !== 'undefined') {
      try { App.nickname = n; } catch (e) { /* setter may be read-only */ }
    } else if (typeof Store !== 'undefined' && Store.setNickname) {
      Store.setNickname(n);
    }
  }

  function getCharacter() {
    if (typeof App !== 'undefined' && App.character) return App.character;
    if (typeof Store !== 'undefined' && Store.getCharacter) {
      const c = Store.getCharacter();
      if (c) return c;
    }
    if (typeof Sprites !== 'undefined' && Sprites.defaultCharacter) {
      return Sprites.defaultCharacter();
    }
    return {};
  }

  function syncFromApp() {
    const input = byId('menu-nickname');
    if (input) input.value = getNickname();
  }

  function onNicknameInput(e) {
    setNickname(e.target.value);
  }

  function resolveMyId() {
    if (typeof App !== 'undefined' && App.playerId) {
      myPlayerId = App.playerId;
    }
    return myPlayerId;
  }

  // ---- Net wiring --------------------------------------------------------
  function wireNet() {
    if (netWired || typeof Net === 'undefined' || typeof Protocol === 'undefined') return;

    Net.on(Protocol.HELLO_OK, onHelloOk);
    Net.on(Protocol.ROOM_LIST, onRoomList);
    Net.on(Protocol.ROOM_JOINED, onRoomJoined);
    Net.on(Protocol.ROOM_UPDATE, onRoomUpdate);
    Net.on(Protocol.JOIN_DENIED, onJoinDenied);
    Net.on(Protocol.GAME_START, onGameStart);
    Net.on(Protocol.ERRORMSG, onServerError);

    if (Net.onOpen) {
      Net.onOpen(function () {
        if (isMenuVisible()) requestRooms();
      });
    }

    netWired = true;
  }

  function wireI18n() {
    if (i18nWired || typeof I18n === 'undefined' || !I18n.onChange) return;
    I18n.onChange(function () {
      // Recompute every label currently on screen.
      rebuildStaticText();
      if (view === 'lobby' && currentRoom) renderLobby();
      else renderRoomList();
    });
    i18nWired = true;
  }

  function isMenuVisible() {
    return rootEl && (rootEl.classList.contains('active') ||
      (rootEl.style.display !== 'none' && document.body.contains(rootEl)));
  }

  // ---- Room list polling -------------------------------------------------
  function startRoomPolling() {
    stopRoomPolling();
    requestRooms();
    listTimer = setInterval(function () {
      if (view === 'browser' && isMenuVisible()) requestRooms();
    }, LIST_REFRESH_MS);
  }

  function stopRoomPolling() {
    if (listTimer) { clearInterval(listTimer); listTimer = null; }
  }

  function requestRooms() {
    if (typeof Net === 'undefined' || !Net.send) return;
    Net.send(Protocol.LIST_ROOMS, {});
  }

  // ---- Net handlers ------------------------------------------------------
  function onHelloOk(payload) {
    // The Go server sends HELLO_OK as a PlayerLobby {id,nickname,character,ready};
    // accept either a {playerId} or a {id} field for the local player's id.
    var pid = payload && (payload.playerId || payload.id);
    if (pid) {
      myPlayerId = pid;
      if (typeof App !== 'undefined') {
        try { App.playerId = pid; } catch (e) { /* read-only ok */ }
      }
    }
  }

  function onRoomList(payload) {
    rooms = (payload && Array.isArray(payload.rooms)) ? payload.rooms : [];
    if (view === 'browser') renderRoomList();
  }

  // ROOM_JOINED / ROOM_UPDATE carry a RoomInfo object directly as the payload.
  function onRoomJoined(payload) {
    currentRoom = normalizeRoomInfo(payload);
    if (!currentRoom) return;
    closeAnyModal();
    showLobbyPane();
    renderLobby();
  }

  function onRoomUpdate(payload) {
    const room = normalizeRoomInfo(payload);
    if (!room) return;
    // Only react if this update concerns the room we are in.
    if (!currentRoom || room.id === currentRoom.id) {
      currentRoom = room;
      if (view === 'lobby') renderLobby();
    }
  }

  // Some servers may wrap the room in {room:...}; tolerate both shapes.
  function normalizeRoomInfo(payload) {
    if (!payload) return null;
    if (payload.id) return payload;
    if (payload.room && payload.room.id) return payload.room;
    return null;
  }

  function onJoinDenied(payload) {
    const reason = (payload && (payload.reason || payload.message)) ||
      t('account.error', 'Could not join room.');
    toast(reason, 'danger');
  }

  function onServerError(payload) {
    const msg = (payload && (payload.message || payload.error)) ||
      t('account.error', 'Something went wrong.');
    toast(msg, 'danger');
  }

  function onGameStart(payload) {
    stopRoomPolling();
    closeAnyModal();
    resolveMyId();
    const roomInfo = currentRoom || normalizeRoomInfo(payload) || {};
    if (typeof Game !== 'undefined' && Game.start) {
      Game.start(roomInfo);
    }
    if (typeof App !== 'undefined' && App.showScreen) {
      App.showScreen('game');
    }
  }

  // ---- Room list rendering ----------------------------------------------
  function renderRoomList() {
    const listEl = byId('menu-room-list');
    if (!listEl) return;
    clear(listEl);

    if (!rooms || rooms.length === 0) {
      listEl.appendChild(el('div', { class: 'room-empty' }, [
        el('p', { text: t('menu.noRooms', 'No open rooms.') }),
        el('p', { class: 'room-empty-sub', text: t('menu.createRoom', 'Create Room') })
      ]));
      return;
    }

    rooms.forEach(function (r) {
      const full = (r.players >= r.maxPlayers);
      const playing = (r.state === 'playing');
      const joinable = !full && !playing;

      const row = el('div', {
        class: 'room-row' + (joinable ? '' : ' room-row-disabled'),
        role: 'button',
        tabindex: joinable ? '0' : '-1',
        onclick: joinable ? function () { attemptJoin(r); } : null,
        onkeydown: joinable ? function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); attemptJoin(r); }
        } : null
      });

      const nameCell = el('div', { class: 'room-cell room-name' }, [
        r.hasPassword
          ? el('span', { class: 'room-lock', title: t('menu.locked', 'Locked') }, [icon('lock', 12)])
          : null,
        el('span', { class: 'room-name-text', text: r.name || 'Room' })
      ]);

      const modeCell = el('div', { class: 'room-cell room-mode' }, [
        el('span', {
          class: 'mode-tag mode-tag-' + (r.mode === MODE_ROYALE ? 'royale' : 'smash'),
          title: modeLabel(r.mode)
        }, [modeIcon(r.mode, 11), el('span', { class: 'mode-tag-text', text: modeLabel(r.mode) })])
      ]);

      const countCell = el('div', { class: 'room-cell room-count' }, [
        el('span', {
          class: full ? 'count-full' : 'count-ok',
          text: r.players + '/' + r.maxPlayers
        })
      ]);

      const stateCell = el('div', { class: 'room-cell room-state' }, [
        playing
          ? el('span', { class: 'tag tag-playing', text: t('game.alive', 'In match') })
          : (full
            ? el('span', { class: 'tag tag-full', text: t('menu.locked', 'Full') })
            : el('span', { class: 'tag tag-open', text: t('menu.join', 'Join') }))
      ]);

      row.appendChild(nameCell);
      row.appendChild(modeCell);
      row.appendChild(countCell);
      row.appendChild(stateCell);
      listEl.appendChild(row);
    });
  }

  function attemptJoin(r) {
    if (typeof Net === 'undefined' || !Net.send) return;
    if (r.hasPassword) {
      openPasswordPrompt(r);
    } else {
      Net.send(Protocol.JOIN_ROOM, { roomId: r.id, password: '' });
    }
  }

  // ---- In-room lobby rendering ------------------------------------------
  function renderLobby() {
    const lobby = byId('menu-lobby');
    if (!lobby) return;
    showLobbyPane();
    clear(lobby);
    lobbyCanvases = [];

    const room = currentRoom;
    if (!room) { showBrowser(); return; }

    const players = room.players || [];
    const myId = resolveMyId();
    const me = players.filter(function (p) { return p.id === myId; })[0];
    const isHost = isHostOf(room, myId);
    const amReady = me ? !!me.ready : false;
    const allReady = players.length > 0 &&
      players.every(function (p) { return !!p.ready; });

    // Header: leave + room name + lock + mode + count
    const backBtn = el('button', {
      class: 'pixbtn-ghost lobby-back',
      type: 'button',
      title: t('lobby.leave', 'Leave'),
      onclick: leaveRoom
    }, [icon('arrowLeft', 14), el('span', { text: t('lobby.leave', 'Leave') })]);

    const head = el('div', { class: 'lobby-room-head' }, [
      backBtn,
      el('div', { class: 'lobby-room-title' }, [
        room.hasPassword
          ? el('span', { class: 'room-lock', title: t('menu.locked', 'Locked') }, [icon('lock', 12)])
          : null,
        el('span', { text: room.name || 'Room' })
      ]),
      el('div', { class: 'lobby-room-mode' }, [
        modeIcon(room.mode, 12),
        el('span', { text: modeLabel(room.mode) })
      ]),
      el('div', {
        class: 'lobby-room-count',
        text: players.length + '/' + (room.maxPlayers || '?')
      })
    ]);

    // Players header + grid with character previews
    const playersHead = el('div', { class: 'lobby-players-head' }, [
      el('span', { text: t('lobby.players', 'Players') })
    ]);

    const grid = el('div', { class: 'lobby-player-grid' });
    players.forEach(function (p) {
      grid.appendChild(buildPlayerCard(p, room, myId));
    });

    // Controls: Ready toggle + (host) Start
    const readyBtn = el('button', {
      id: 'lobby-ready-btn',
      class: 'pixbtn ' + (amReady ? 'pixbtn-ready-on' : 'pixbtn-ready-off'),
      type: 'button',
      onclick: function () { toggleReady(!amReady); }
    }, [
      amReady ? icon('check', 16) : icon('x', 16),
      el('span', { text: amReady ? t('lobby.ready', 'Ready') : t('lobby.notReady', 'Not ready') })
    ]);

    const controls = el('div', { class: 'lobby-controls' }, [readyBtn]);

    if (isHost) {
      const canStart = players.length >= 1 && allReady;
      const startBtn = el('button', {
        id: 'lobby-start-btn',
        class: 'pixbtn pixbtn-primary' + (canStart ? '' : ' pixbtn-disabled'),
        type: 'button',
        disabled: canStart ? null : 'disabled',
        onclick: canStart ? startGame : null
      }, [icon('play', 16), el('span', { text: t('lobby.start', 'Start') })]);
      controls.appendChild(startBtn);

      if (!allReady) {
        controls.appendChild(el('div', {
          class: 'lobby-hint',
          text: t('lobby.notReady', 'All players must be ready.')
        }));
      }
    } else {
      controls.appendChild(el('div', {
        class: 'lobby-hint',
        text: t('lobby.waitingHost', 'Waiting for the host to start...')
      }));
    }

    lobby.appendChild(el('div', { class: 'lobby-card pixpanel' }, [
      head,
      playersHead,
      el('div', { class: 'lobby-players-wrap' }, [grid]),
      controls
    ]));

    drawLobbyCharacters();
  }

  function isHostOf(room, myId) {
    if (!room || !myId) return false;
    if (room.host) return room.host === myId;
    // Fallback: first player is treated as host if the server omitted host.
    const players = room.players || [];
    return players.length > 0 && players[0].id === myId;
  }

  function buildPlayerCard(p, room, myId) {
    const isMe = (p.id === myId);
    const isHost = room.host
      ? (room.host === p.id)
      : (room.players && room.players[0] && room.players[0].id === p.id);

    const canvas = el('canvas', {
      class: 'lobby-char-canvas',
      width: '72',
      height: '84'
    });
    lobbyCanvases.push({ canvas: canvas, character: p.character });

    const badges = el('div', { class: 'player-badges' }, [
      isHost ? el('span', { class: 'badge badge-host', title: t('lobby.start', 'Host') }, [icon('crown', 12)]) : null,
      p.ready
        ? el('span', { class: 'badge badge-ready', title: t('lobby.ready', 'Ready') }, [icon('check', 12)])
        : el('span', { class: 'badge badge-wait', title: t('lobby.notReady', 'Not ready') }, [icon('x', 12)])
    ]);

    return el('div', {
      class: 'player-card' + (isMe ? ' player-card-me' : '') +
        (p.ready ? ' player-card-ready' : '')
    }, [
      badges,
      el('div', { class: 'player-canvas-wrap' }, [canvas]),
      el('div', {
        class: 'player-name' + (isMe ? ' player-name-me' : ''),
        text: (p.nickname || 'Penguin')
      })
    ]);
  }

  function drawLobbyCharacters() {
    if (typeof Sprites === 'undefined' || !Sprites.drawCharacter) return;
    lobbyCanvases.forEach(function (entry) {
      const cv = entry.canvas;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, cv.width, cv.height);
      let character = entry.character;
      if (!character && Sprites.defaultCharacter) character = Sprites.defaultCharacter();
      try {
        // Anchor at feet-center near the bottom of the small card.
        Sprites.drawCharacter(ctx, character, cv.width / 2, cv.height - 8, 4, 1);
      } catch (e) {
        // Never let one bad character break the whole lobby.
      }
    });
  }

  // ---- Lobby actions -----------------------------------------------------
  function toggleReady(ready) {
    if (typeof Net === 'undefined' || !Net.send) return;
    Net.send(Protocol.READY, { ready: !!ready });
  }

  function startGame() {
    if (typeof Net === 'undefined' || !Net.send) return;
    Net.send(Protocol.START_GAME, {});
  }

  function leaveRoom() {
    if (typeof Net !== 'undefined' && Net.send) {
      Net.send(Protocol.LEAVE_ROOM, {});
    }
    currentRoom = null;
    showBrowser();
    requestRooms();
  }

  // ---- Play button -------------------------------------------------------
  function onClickPlay() {
    const nick = getNickname().trim();
    if (!nick) {
      const input = byId('menu-nickname');
      if (input) {
        input.focus();
        input.classList.add('shake');
        setTimeout(function () { input.classList.remove('shake'); }, 400);
      }
      toast(t('menu.nicknamePh', 'Pick a name first!'), 'warn');
      return;
    }
    setNickname(nick);
    // Re-announce identity so the server has the current nickname + character.
    if (typeof Net !== 'undefined' && Net.send && typeof Protocol !== 'undefined') {
      Net.send(Protocol.HELLO, { nickname: nick, character: getCharacter() });
    }
    // "Play" surfaces the public room browser (refresh + create are right there).
    showBrowser();
    requestRooms();
    const panel = rootEl ? rootEl.querySelector('.lobby-panel') : null;
    if (panel && panel.scrollIntoView) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function onClickEditCharacter() {
    if (typeof Editor !== 'undefined' && Editor.open) {
      Editor.open();
    }
    if (typeof App !== 'undefined' && App.showScreen) {
      App.showScreen('editor');
    }
  }

  // ---- Modal infrastructure ---------------------------------------------
  // Modals live in #modal-root (outside the screen containers, always on top).
  function modalHost() {
    let host = byId('modal-root');
    if (!host) {
      host = el('div', { id: 'modal-root' });
      document.body.appendChild(host);
    }
    return host;
  }

  function openModal(node) {
    closeAnyModal();
    const overlay = el('div', {
      class: 'modal-overlay',
      onclick: function (e) { if (e.target === overlay) closeAnyModal(); }
    }, [node]);
    const onKey = function (e) { if (e.key === 'Escape') closeAnyModal(); };
    overlay._onKey = onKey;
    document.addEventListener('keydown', onKey);
    modalHost().appendChild(overlay);
    return overlay;
  }

  function closeAnyModal() {
    const host = byId('modal-root');
    if (!host) return;
    while (host.firstChild) {
      const ov = host.firstChild;
      if (ov._onKey) document.removeEventListener('keydown', ov._onKey);
      host.removeChild(ov);
    }
  }

  function modalShell(titleText, bodyNodes, opts) {
    opts = opts || {};
    const closeBtn = el('button', {
      class: 'modal-x',
      type: 'button',
      title: t('common.close', 'Close'),
      onclick: closeAnyModal
    }, [icon('x', 14)]);

    return el('div', { class: 'pixmodal' + (opts.wide ? ' pixmodal-wide' : '') }, [
      el('div', { class: 'pixmodal-head' }, [
        el('h3', { class: 'pixmodal-title', text: titleText }),
        closeBtn
      ]),
      el('div', { class: 'pixmodal-body' }, bodyNodes)
    ]);
  }

  // ---- Create-room modal -------------------------------------------------
  function openCreateRoomModal() {
    const nameInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '24',
      autocomplete: 'off', spellcheck: 'false',
      placeholder: t('menu.roomName', 'Room name')
    });
    const passInput = el('input', {
      class: 'pixinput', type: 'password', maxlength: '32',
      autocomplete: 'new-password',
      placeholder: t('menu.passwordOpt', '(optional)')
    });

    // ---- Mode selector: two big pickable cards ----
    let chosenMode = MODE_SMASH;
    const modeDesc = el('div', { class: 'mode-desc' });

    function makeModeCard(mode, titleKey, titleEn, descKey, descEn) {
      const card = el('button', {
        type: 'button',
        class: 'mode-card' + (mode === chosenMode ? ' mode-card-on' : ''),
        dataset: { mode: mode },
        onclick: function () { pickMode(mode); }
      }, [
        el('div', { class: 'mode-card-icon' }, [modeIcon(mode, 22)]),
        el('div', { class: 'mode-card-name', text: t(titleKey, titleEn) })
      ]);
      return card;
    }

    const smashCard = makeModeCard(MODE_SMASH, 'mode.smash', 'Tux Smash');
    const royaleCard = makeModeCard(MODE_ROYALE, 'mode.royale', 'Distro Royale');
    const modeRow = el('div', { class: 'mode-row' }, [smashCard, royaleCard]);

    // Max-players options depend on the mode (smash: 2-4, royale: up to 16).
    const maxSelect = el('select', { class: 'pixinput pixselect' });

    function pickMode(mode) {
      chosenMode = mode;
      smashCard.classList.toggle('mode-card-on', mode === MODE_SMASH);
      royaleCard.classList.toggle('mode-card-on', mode === MODE_ROYALE);
      modeDesc.textContent = (mode === MODE_ROYALE)
        ? t('mode.royaleDesc', 'Shrinking Menthol Zone, BSOD storm outside. Up to 16.')
        : t('mode.smashDesc', 'Shove rivals off the platform. 2 to 4 players.');
      populateMax(mode);
    }

    function populateMax(mode) {
      clear(maxSelect);
      const opts = (mode === MODE_ROYALE) ? [2, 4, 6, 8, 12, 16] : [2, 3, 4];
      const dflt = (mode === MODE_ROYALE) ? 8 : 4;
      opts.forEach(function (n) {
        maxSelect.appendChild(el('option', {
          value: String(n),
          text: n + ' ' + t('lobby.players', 'players')
        }));
      });
      maxSelect.value = String(dflt);
    }

    pickMode(MODE_SMASH);

    const errLine = el('div', { class: 'form-err', text: '' });

    const submit = function () {
      const name = nameInput.value.trim();
      if (!name) {
        errLine.textContent = t('menu.roomName', 'Give your room a name.');
        nameInput.focus();
        return;
      }
      const maxPlayers = parseInt(maxSelect.value, 10) ||
        (chosenMode === MODE_ROYALE ? 8 : 4);
      if (typeof Net !== 'undefined' && Net.send) {
        Net.send(Protocol.CREATE_ROOM, {
          name: name,
          password: passInput.value || '',
          maxPlayers: maxPlayers,
          mode: chosenMode
        });
      }
      // The server replies with ROOM_JOINED, which switches us into the lobby.
    };

    const body = [
      formRow(t('menu.roomName', 'Room name'), nameInput),
      formRow(t('menu.mode', 'Mode'), el('div', null, [modeRow, modeDesc])),
      formRow(t('menu.maxPlayers', 'Max players'), maxSelect),
      formRow(t('menu.password', 'Password'), passInput, t('menu.passwordOpt', 'Leave blank for a public room.')),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal },
          [el('span', { text: t('common.cancel', 'Cancel') })]),
        el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: submit },
          [icon('plus', 14), el('span', { text: t('common.create', 'Create') })])
      ])
    ];

    openModal(modalShell(t('menu.createRoom', 'Create Room'), body));
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    setTimeout(function () { nameInput.focus(); }, 30);
  }

  // ---- Password prompt for locked rooms ---------------------------------
  function openPasswordPrompt(room) {
    const passInput = el('input', {
      class: 'pixinput', type: 'password', maxlength: '32',
      autocomplete: 'off', placeholder: t('menu.password', 'Password')
    });
    const errLine = el('div', { class: 'form-err', text: '' });

    const submit = function () {
      const pw = passInput.value;
      if (!pw) {
        errLine.textContent = t('menu.password', 'Enter the password.');
        passInput.focus();
        return;
      }
      if (typeof Net !== 'undefined' && Net.send) {
        Net.send(Protocol.JOIN_ROOM, { roomId: room.id, password: pw });
      }
      closeAnyModal();
    };

    const body = [
      el('p', { class: 'modal-lead' }, [
        icon('lock', 13),
        el('span', { text: ' "' + (room.name || 'Room') + '"' })
      ]),
      formRow(t('menu.password', 'Password'), passInput),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal },
          [el('span', { text: t('common.cancel', 'Cancel') })]),
        el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: submit },
          [el('span', { text: t('menu.join', 'Join') })])
      ])
    ];

    openModal(modalShell(t('menu.locked', 'Locked'), body));
    passInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    setTimeout(function () { passInput.focus(); }, 30);
  }

  // ---- Account modal (register / login / logout) ------------------------
  let accountTab = 'login'; // 'login' | 'register'

  function openAccountModal() {
    if (typeof Store !== 'undefined' && Store.isLoggedIn && Store.isLoggedIn()) {
      openAccountLoggedIn();
    } else {
      openAccountAuth();
    }
  }

  function openAccountLoggedIn() {
    const name = (Store.getUsername && Store.getUsername()) || 'penguin';
    const body = [
      el('div', { class: 'account-status' }, [
        icon('user', 16),
        el('span', { class: 'account-user', text: t('account.loggedInAs', 'Signed in as') + ' ' + name })
      ]),
      el('p', { class: 'modal-lead', text: t('account.cloudHint', 'Your character syncs to your account.') }),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal },
          [el('span', { text: t('common.close', 'Close') })]),
        el('button', {
          class: 'pixbtn pixbtn-danger', type: 'button',
          onclick: function () {
            if (Store.logout) Store.logout();
            refreshAccountUi();
            closeAnyModal();
          }
        }, [icon('logout', 14), el('span', { text: t('account.logout', 'Log out') })])
      ])
    ];
    openModal(modalShell(t('account.signIn', 'Account'), body));
  }

  function openAccountAuth() {
    const userInput = el('input', {
      class: 'pixinput', type: 'text', maxlength: '24',
      autocomplete: 'username', spellcheck: 'false',
      placeholder: t('account.username', 'username')
    });
    const passInput = el('input', {
      class: 'pixinput', type: 'password', maxlength: '64',
      autocomplete: 'current-password',
      placeholder: t('account.password', 'password')
    });
    const errLine = el('div', { class: 'form-err', text: '' });

    function makeTabBtn(id, labelKey, labelEn) {
      return el('button', {
        class: 'tab-btn' + (accountTab === id ? ' tab-btn-active' : ''),
        type: 'button',
        dataset: { tab: id },
        onclick: function () { accountTab = id; rerender(); }
      }, [el('span', { text: t(labelKey, labelEn) })]);
    }

    const tabs = el('div', { class: 'tab-row' }, [
      makeTabBtn('login', 'account.login', 'Log in'),
      makeTabBtn('register', 'account.register', 'Register')
    ]);

    const submitBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' },
      [el('span', { text: t('account.login', 'Log in') })]);

    function setBusy(on) {
      submitBtn.disabled = on ? 'disabled' : null;
      if (on) submitBtn.classList.add('pixbtn-disabled');
      else submitBtn.classList.remove('pixbtn-disabled');
    }

    function doSubmit() {
      errLine.textContent = '';
      const u = userInput.value.trim();
      const p = passInput.value;
      if (!u || !p) {
        errLine.textContent = t('account.error', 'Username and password required.');
        return;
      }
      if (typeof Store === 'undefined') {
        errLine.textContent = t('account.error', 'Accounts unavailable.');
        return;
      }
      const action = (accountTab === 'register') ? Store.register : Store.login;
      if (typeof action !== 'function') {
        errLine.textContent = t('account.error', 'Accounts unavailable.');
        return;
      }

      setBusy(true);
      Promise.resolve(action.call(Store, u, p))
        .then(function (res) {
          syncCharacterFromStore(res);
          refreshAccountUi();
          closeAnyModal();
        })
        .catch(function (err) {
          setBusy(false);
          errLine.textContent = humanizeAuthError(err);
        });
    }

    submitBtn.addEventListener('click', doSubmit);

    const switchHint = el('div', { class: 'auth-hint' });

    function rerender() {
      const tabBtns = tabs.querySelectorAll('.tab-btn');
      tabBtns[0].classList.toggle('tab-btn-active', accountTab === 'login');
      tabBtns[1].classList.toggle('tab-btn-active', accountTab === 'register');
      const span = submitBtn.querySelector('span');
      span.textContent = accountTab === 'login'
        ? t('account.login', 'Log in')
        : t('account.register', 'Register');
      clear(switchHint);
      if (accountTab === 'login') {
        switchHint.appendChild(document.createTextNode(t('account.signUp', 'Need an account?') + ' '));
        switchHint.appendChild(el('a', {
          class: 'link', href: '#',
          onclick: function (e) { e.preventDefault(); accountTab = 'register'; rerender(); }
        }, [el('span', { text: t('account.register', 'Register') })]));
      } else {
        switchHint.appendChild(document.createTextNode(t('account.signIn', 'Have an account?') + ' '));
        switchHint.appendChild(el('a', {
          class: 'link', href: '#',
          onclick: function (e) { e.preventDefault(); accountTab = 'login'; rerender(); }
        }, [el('span', { text: t('account.login', 'Log in') })]));
      }
      errLine.textContent = '';
      setBusy(false);
    }

    const enterToSubmit = function (e) { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } };
    userInput.addEventListener('keydown', enterToSubmit);
    passInput.addEventListener('keydown', enterToSubmit);

    const body = [
      tabs,
      el('p', { class: 'account-lead', text: t('account.cloudHint', 'Optional. Sign in to sync your penguin across devices.') }),
      formRow(t('account.username', 'Username'), userInput),
      formRow(t('account.password', 'Password'), passInput),
      errLine,
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn-ghost', type: 'button', onclick: closeAnyModal },
          [el('span', { text: t('common.cancel', 'Cancel') })]),
        submitBtn
      ]),
      switchHint
    ];

    openModal(modalShell(t('account.signIn', 'Account'), body));
    rerender();
    setTimeout(function () { userInput.focus(); }, 30);
  }

  function syncCharacterFromStore(res) {
    let character = null;
    if (res && res.character) character = res.character;
    else if (typeof Store !== 'undefined' && Store.getCharacter) character = Store.getCharacter();
    if (character) {
      if (typeof App !== 'undefined' && App.updateCharacter) {
        App.updateCharacter(character);
      } else if (typeof App !== 'undefined') {
        try { App.character = character; } catch (e) { /* ignore */ }
      }
    }
    // Re-announce identity so the server reflects the account's penguin.
    if (typeof Net !== 'undefined' && Net.send && typeof Protocol !== 'undefined') {
      Net.send(Protocol.HELLO, { nickname: getNickname(), character: character || getCharacter() });
    }
  }

  function humanizeAuthError(err) {
    let msg = '';
    if (err) {
      if (typeof err === 'string') msg = err;
      else if (err.error) msg = err.error;
      else if (err.message) msg = err.message;
    }
    if (!msg) msg = t('account.error', 'Something went wrong.');
    return msg;
  }

  // ---- Account UI (top-right button) ------------------------------------
  function refreshAccountUi() {
    const btn = byId('menu-signin-btn');
    if (!btn) return;
    const label = btn.querySelector('.signin-label');
    const loggedIn = (typeof Store !== 'undefined' && Store.isLoggedIn && Store.isLoggedIn());
    if (loggedIn) {
      const name = (Store.getUsername && Store.getUsername()) || t('nav.signIn', 'Account');
      if (label) label.textContent = name;
      btn.classList.add('signed-in');
      btn.title = name;
    } else {
      if (label) label.textContent = t('nav.signIn', 'Sign in');
      btn.classList.remove('signed-in');
      btn.title = t('nav.signIn', 'Sign in');
    }
  }

  // ---- Language switcher / first-visit popup -----------------------------
  function currentLangCode() {
    if (typeof I18n !== 'undefined' && I18n.get) return I18n.get();
    return 'en';
  }

  function currentLangName() {
    const code = currentLangCode();
    const langs = (typeof I18n !== 'undefined' && I18n.LANGS) ? I18n.LANGS : [];
    for (let i = 0; i < langs.length; i++) {
      if (langs[i].code === code) return langs[i].name;
    }
    return code.toUpperCase();
  }

  function showLanguagePopup() {
    const langs = (typeof I18n !== 'undefined' && I18n.LANGS) ? I18n.LANGS : [
      { code: 'en', name: 'English' }
    ];
    const active = currentLangCode();

    const listWrap = el('div', { class: 'lang-list' });
    langs.forEach(function (lang) {
      // English is highlighted as the default choice.
      const isDefault = (lang.code === 'en');
      const isActive = (lang.code === active);
      const row = el('button', {
        type: 'button',
        class: 'lang-row' +
          (isActive ? ' lang-row-active' : '') +
          (isDefault ? ' lang-row-default' : ''),
        dataset: { code: lang.code },
        onclick: function () { chooseLanguage(lang.code); }
      }, [
        el('span', { class: 'lang-code', text: lang.code.toUpperCase() }),
        el('span', { class: 'lang-name', text: lang.name }),
        isDefault ? el('span', { class: 'lang-default-tag', text: '*' }) : null,
        isActive ? el('span', { class: 'lang-check' }, [icon('check', 12)]) : null
      ]);
      listWrap.appendChild(row);
    });

    const body = [
      el('p', { class: 'lang-lead', text: t('lang.choose', 'Choose your language') }),
      listWrap
    ];

    openModal(modalShell(t('nav.language', 'Language'), body));
  }

  function chooseLanguage(code) {
    if (typeof I18n !== 'undefined' && I18n.set) {
      I18n.set(code);
    }
    // I18n.onChange re-renders the menu; just refresh the corner label + close.
    const langLabel = rootEl && rootEl.querySelector('.corner-lang-label');
    if (langLabel) langLabel.textContent = currentLangName();
    closeAnyModal();
  }

  // ---- form helpers ------------------------------------------------------
  function formRow(labelText, control, hintText) {
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'form-label', text: labelText }),
      control,
      hintText ? el('div', { class: 'form-hint', text: hintText }) : null
    ]);
  }

  // ---- toast -------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, kind) {
    let host = byId('menu-toast');
    if (!host) {
      host = el('div', { id: 'menu-toast' });
      document.body.appendChild(host);
    }
    host.className = 'toast toast-' + (kind || 'info') + ' toast-show';
    host.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      host.classList.remove('toast-show');
    }, 2600);
  }

  // ---- styles (8-bit; self-injected) -------------------------------------
  function injectStyles() {
    if (byId('menu-styles')) return;
    const css = [
      // palette: mint #7ff9e0, orange #ff9e2c, blue #2b5fff, slate #1a1d2e
      '#screen-menu{font-family:"Press Start 2P",monospace;color:#e8ecf5;position:relative;min-height:100%;}',
      '.menu-inner{max-width:740px;margin:0 auto;padding:28px 16px 60px;}',
      // title
      '.menu-title{text-align:center;margin:14px 0 22px;}',
      '.title-main{margin:0;font-size:30px;line-height:1.1;color:#ff9e2c;letter-spacing:2px;text-shadow:4px 4px 0 #1a1d2e,6px 6px 0 #2b5fff;}',
      '.title-sub{margin:6px 0 0;font-size:22px;color:#7ff9e0;letter-spacing:6px;text-shadow:3px 3px 0 #1a1d2e;}',
      '.title-tag{margin:14px auto 0;max-width:540px;font-size:9px;line-height:1.7;color:#9aa3bf;}',
      // nickname (Kahoot style)
      '.menu-nick-row{display:flex;flex-direction:column;align-items:center;gap:8px;margin:0 0 18px;}',
      '.nick-label{font-size:9px;color:#9aa3bf;letter-spacing:1px;}',
      '.kahoot-nick{width:100%;max-width:420px;text-align:center;font-size:16px;padding:16px 12px;}',
      // inputs
      '.pixinput{font-family:inherit;background:#10121f;color:#e8ecf5;border:3px solid #3a3f5c;box-shadow:4px 4px 0 #0a0b14;padding:12px;font-size:11px;outline:none;border-radius:0;width:100%;box-sizing:border-box;}',
      '.pixinput:focus{border-color:#7ff9e0;box-shadow:4px 4px 0 #0a0b14,0 0 0 2px #7ff9e0 inset;}',
      '.pixselect{cursor:pointer;}',
      '.shake{animation:menu-shake .4s;}',
      '@keyframes menu-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-6px);}75%{transform:translateX(6px);}}',
      // buttons
      '.pixbtn{font-family:inherit;font-size:11px;color:#e8ecf5;background:#262a44;border:3px solid #e8ecf5;box-shadow:5px 5px 0 #0a0b14;padding:12px 16px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center;border-radius:0;}',
      '.pixbtn:hover{background:#e8ecf5;color:#1a1d2e;}',
      '.pixbtn:active{transform:translate(2px,2px);box-shadow:3px 3px 0 #0a0b14;}',
      '.pixbtn-primary{background:#ff9e2c;color:#1a1d2e;border-color:#1a1d2e;}',
      '.pixbtn-primary:hover{background:#ffd39e;color:#1a1d2e;}',
      '.pixbtn-danger{background:#2b5fff;color:#fff;border-color:#1a1d2e;}',
      '.pixbtn-danger:hover{background:#7ff9e0;color:#1a1d2e;}',
      '.pixbtn-ghost{font-family:inherit;font-size:10px;color:#9aa3bf;background:transparent;border:2px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;padding:8px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border-radius:0;}',
      '.pixbtn-ghost:hover{color:#1a1d2e;background:#7ff9e0;border-color:#1a1d2e;}',
      '.pixbtn-disabled,.pixbtn:disabled{opacity:.45;cursor:not-allowed;}',
      '.pixbtn-disabled:hover,.pixbtn:disabled:hover{background:#262a44;color:#e8ecf5;}',
      '.pixbtn-ready-on{background:#7ff9e0;color:#1a1d2e;border-color:#1a1d2e;}',
      '.pixbtn-ready-on:hover{background:#bff8ee;color:#1a1d2e;}',
      '.pixbtn-ready-off{background:#262a44;color:#9aa3bf;border-color:#3a3f5c;}',
      // actions row
      '.menu-actions{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin:0 0 26px;}',
      '.menu-actions .pixbtn{min-width:180px;padding:16px 18px;font-size:12px;}',
      // panels
      '.pixpanel{background:#181b2c;border:3px solid #3a3f5c;box-shadow:6px 6px 0 #0a0b14;padding:14px;}',
      '.lobby-panel{margin-top:4px;}',
      '.lobby-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;}',
      '.lobby-title{margin:0;font-size:12px;color:#7ff9e0;letter-spacing:1px;}',
      '.lobby-head-btns{display:flex;gap:8px;}',
      // room list
      '.room-list{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;}',
      '.room-row{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:10px;background:#10121f;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;padding:12px;cursor:pointer;}',
      '.room-row:hover{border-color:#7ff9e0;background:#13182c;}',
      '.room-row:focus{outline:none;border-color:#ff9e2c;}',
      '.room-row-disabled{opacity:.55;cursor:not-allowed;}',
      '.room-row-disabled:hover{border-color:#3a3f5c;background:#10121f;}',
      '.room-cell{display:flex;align-items:center;}',
      '.room-name{gap:8px;min-width:0;}',
      '.room-name-text{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.room-lock{color:#ff9e2c;display:inline-flex;}',
      '.room-mode{justify-content:center;}',
      '.mode-tag{display:inline-flex;align-items:center;gap:5px;font-size:8px;padding:4px 7px;border:2px solid;}',
      '.mode-tag-smash{color:#ff9e2c;border-color:#ff9e2c;}',
      '.mode-tag-royale{color:#7ff9e0;border-color:#7ff9e0;}',
      '.mode-tag-text{white-space:nowrap;}',
      '.room-count{font-size:10px;}',
      '.count-full{color:#ff6b6b;}',
      '.count-ok{color:#7ff9e0;}',
      '.tag{font-size:8px;padding:4px 6px;border:2px solid;white-space:nowrap;}',
      '.tag-open{color:#7ff9e0;border-color:#7ff9e0;}',
      '.tag-full{color:#ff6b6b;border-color:#ff6b6b;}',
      '.tag-playing{color:#ff9e2c;border-color:#ff9e2c;}',
      '.room-empty{text-align:center;color:#9aa3bf;padding:22px 8px;}',
      '.room-empty p{margin:6px 0;font-size:10px;}',
      '.room-empty-sub{color:#646b8a;font-size:8px;}',
      // lobby (in-room)
      '.menu-lobby.hidden,.menu-browser.hidden,.hidden{display:none !important;}',
      '.lobby-card{display:flex;flex-direction:column;gap:16px;}',
      '.lobby-room-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
      '.lobby-room-title{font-size:13px;color:#ff9e2c;display:flex;align-items:center;gap:8px;flex:1;min-width:0;}',
      '.lobby-room-title span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.lobby-room-mode{font-size:9px;color:#7ff9e0;display:inline-flex;align-items:center;gap:6px;border:2px solid #3a3f5c;padding:5px 8px;}',
      '.lobby-room-count{font-size:10px;color:#7ff9e0;}',
      '.lobby-players-head{font-size:9px;color:#9aa3bf;letter-spacing:1px;}',
      '.lobby-player-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;}',
      '.player-card{position:relative;background:#10121f;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;padding:10px 8px;display:flex;flex-direction:column;align-items:center;gap:6px;}',
      '.player-card-me{border-color:#ff9e2c;}',
      '.player-card-ready{border-color:#7ff9e0;}',
      '.player-card-me.player-card-ready{border-color:#7ff9e0;box-shadow:3px 3px 0 #0a0b14,0 0 0 2px #ff9e2c inset;}',
      '.player-badges{position:absolute;top:6px;left:6px;right:6px;display:flex;justify-content:space-between;}',
      '.badge{display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;border:2px solid;background:#10121f;}',
      '.badge-host{color:#ff9e2c;border-color:#ff9e2c;}',
      '.badge-ready{color:#7ff9e0;border-color:#7ff9e0;}',
      '.badge-wait{color:#646b8a;border-color:#3a3f5c;}',
      '.player-canvas-wrap{margin-top:14px;}',
      '.lobby-char-canvas{image-rendering:pixelated;width:72px;height:84px;}',
      '.player-name{font-size:8px;text-align:center;line-height:1.4;word-break:break-word;color:#cfd5e8;}',
      '.player-name-me{color:#ff9e2c;}',
      '.lobby-controls{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:center;}',
      '.lobby-controls .pixbtn{min-width:160px;}',
      '.lobby-hint{flex-basis:100%;text-align:center;font-size:8px;color:#9aa3bf;line-height:1.6;}',
      '.lobby-back{align-self:flex-start;}',
      // top-right corner: language + sign-in (subtle)
      '.menu-corner{position:absolute;top:12px;right:14px;z-index:30;display:flex;gap:8px;align-items:center;}',
      '.corner-btn{font-size:9px;padding:6px 10px;color:#9aa3bf;}',
      '.corner-lang-label,.signin-label{letter-spacing:1px;}',
      '.signin-btn.signed-in{color:#7ff9e0;border-color:#7ff9e0;}',
      // mode selector (create-room)
      '.mode-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}',
      '.mode-card{font-family:inherit;background:#10121f;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;color:#9aa3bf;padding:12px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;border-radius:0;}',
      '.mode-card:hover{border-color:#7ff9e0;color:#e8ecf5;}',
      '.mode-card-on{border-color:#ff9e2c;color:#ff9e2c;background:#15182a;}',
      '.mode-card-icon{display:inline-flex;}',
      '.mode-card-name{font-size:9px;text-align:center;line-height:1.4;}',
      '.mode-desc{font-size:7px;color:#646b8a;line-height:1.7;margin-top:8px;min-height:14px;}',
      // footer
      '.menu-footer{margin-top:30px;text-align:center;font-size:8px;line-height:1.9;color:#646b8a;}',
      '.accent-mint{color:#7ff9e0;}',
      '.accent-blue{color:#2b5fff;}',
      // modal
      '.modal-overlay{position:fixed;inset:0;background:rgba(8,9,16,.82);display:flex;align-items:center;justify-content:center;z-index:9000;padding:16px;}',
      '.pixmodal{font-family:"Press Start 2P",monospace;background:#181b2c;border:4px solid #7ff9e0;box-shadow:8px 8px 0 #0a0b14;width:100%;max-width:400px;color:#e8ecf5;max-height:90vh;overflow-y:auto;}',
      '.pixmodal-wide{max-width:560px;}',
      '.pixmodal-head{display:flex;align-items:center;justify-content:space-between;padding:14px;border-bottom:3px solid #3a3f5c;background:#10121f;position:sticky;top:0;}',
      '.pixmodal-title{margin:0;font-size:13px;color:#7ff9e0;}',
      '.modal-x{font-family:inherit;background:transparent;border:2px solid #3a3f5c;color:#9aa3bf;cursor:pointer;padding:5px;display:inline-flex;}',
      '.modal-x:hover{color:#1a1d2e;background:#ff6b6b;border-color:#1a1d2e;}',
      '.pixmodal-body{padding:18px 16px;display:flex;flex-direction:column;gap:14px;}',
      '.form-row{display:flex;flex-direction:column;gap:7px;}',
      '.form-label{font-size:9px;color:#9aa3bf;letter-spacing:1px;}',
      '.form-hint{font-size:7px;color:#646b8a;line-height:1.6;}',
      '.form-err{font-size:8px;color:#ff6b6b;line-height:1.6;min-height:10px;}',
      '.modal-lead{font-size:9px;line-height:1.7;color:#cfd5e8;display:flex;align-items:center;gap:6px;}',
      '.modal-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:4px;}',
      // account
      '.tab-row{display:flex;gap:0;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;}',
      '.tab-btn{flex:1;font-family:inherit;font-size:10px;background:#10121f;color:#9aa3bf;border:none;padding:10px;cursor:pointer;}',
      '.tab-btn+.tab-btn{border-left:3px solid #3a3f5c;}',
      '.tab-btn-active{background:#7ff9e0;color:#1a1d2e;}',
      '.account-lead{font-size:8px;color:#646b8a;line-height:1.7;margin:0;}',
      '.account-status{display:flex;align-items:center;gap:10px;font-size:11px;color:#7ff9e0;}',
      '.account-user{font-size:11px;line-height:1.5;}',
      '.auth-hint{font-size:8px;color:#9aa3bf;text-align:center;line-height:1.7;}',
      '.link{color:#7ff9e0;text-decoration:underline;cursor:pointer;}',
      '.link:hover{color:#ff9e2c;}',
      // language popup
      '.lang-lead{font-size:9px;color:#9aa3bf;line-height:1.7;margin:0;text-align:center;}',
      '.lang-list{display:flex;flex-direction:column;gap:8px;}',
      '.lang-row{font-family:inherit;display:flex;align-items:center;gap:10px;background:#10121f;border:3px solid #3a3f5c;box-shadow:3px 3px 0 #0a0b14;color:#cfd5e8;padding:12px;cursor:pointer;text-align:left;border-radius:0;}',
      '.lang-row:hover{border-color:#7ff9e0;color:#fff;}',
      '.lang-row-active{border-color:#ff9e2c;color:#ff9e2c;}',
      '.lang-row-default{box-shadow:3px 3px 0 #0a0b14,0 0 0 2px #2b5fff inset;}',
      '.lang-code{font-size:9px;color:#7ff9e0;width:28px;flex:0 0 auto;}',
      '.lang-name{font-size:10px;flex:1;}',
      '.lang-default-tag{color:#2b5fff;font-size:10px;}',
      '.lang-check{color:#ff9e2c;display:inline-flex;}',
      // toast
      '#menu-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);font-family:"Press Start 2P",monospace;font-size:9px;line-height:1.6;color:#1a1d2e;padding:12px 16px;border:3px solid #1a1d2e;box-shadow:5px 5px 0 #0a0b14;opacity:0;pointer-events:none;z-index:9500;max-width:90vw;text-align:center;transition:opacity .15s,transform .15s;}',
      '#menu-toast.toast-show{opacity:1;transform:translateX(-50%) translateY(0);}',
      '.toast-info{background:#7ff9e0;}',
      '.toast-warn{background:#ff9e2c;}',
      '.toast-danger{background:#ff6b6b;color:#1a1d2e;}',
      // responsive
      '@media (max-width:560px){.title-main{font-size:22px;}.title-sub{font-size:16px;}.menu-actions .pixbtn{min-width:140px;}.room-row{grid-template-columns:1fr auto auto;}.room-mode{display:none;}.mode-tag-text{display:none;}}'
    ].join('\n');

    const style = el('style', { id: 'menu-styles' });
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- public API --------------------------------------------------------
  const Menu = {
    show: show,
    hide: hide,
    showLanguagePopup: showLanguagePopup,
    // helpers exposed for other modules / debugging
    refresh: requestRooms,
    leaveRoom: leaveRoom,
    openSignIn: openAccountModal,
    isInRoom: function () { return !!currentRoom; },
    getCurrentRoom: function () { return currentRoom; }
  };

  return Menu;
})();

window.Menu = Menu;
