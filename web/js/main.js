// main.js — application bootstrap + screen manager. Single global: window.App.
//
// App is the small spine that wires the independently-authored modules together:
//   - boots localization (I18n.init) and input (Input.init),
//   - restores the player's nickname + character from Store (defaulting to the
//     classic Tux when none is saved),
//   - opens the WebSocket (Net.connect) and announces identity with HELLO on
//     every (re)connect,
//   - shows the first-visit language popup (defaulting to English) BEFORE the
//     menu when the player has not yet chosen a language,
//   - exposes the screen manager (App.showScreen) and the shared player state
//     (App.nickname / App.character / App.playerId) that menu/editor/game read,
//   - re-renders the live UI when the language changes (I18n.onChange).
//
// No frameworks, no ES modules — this file assigns exactly one global and is the
// LAST script loaded, so every other global (Protocol, I18n, Sprites, Gag,
// Store, Net, Input, Render, Game, Editor, Menu) already exists.

var App = (function () {
  'use strict';

  // ---- live shared state -------------------------------------------------
  var _nickname = '';
  var _character = null;
  var _playerId = null;        // assigned by the server via HELLO_OK (menu.js)
  var _currentScreen = 'menu'; // 'menu' | 'editor' | 'game'
  var _booted = false;

  // ---- helpers -----------------------------------------------------------

  function hasStore() { return typeof Store !== 'undefined' && Store; }

  // A safe default character (classic Tux) if Sprites is somehow unavailable.
  function fallbackCharacter() {
    return {
      name: '', bodyType: 'tux',
      body: 0, belly: 0, feet: 0, hat: 0, eyes: 0, accessory: 0, cape: 0
    };
  }

  function defaultCharacter() {
    if (typeof Sprites !== 'undefined' && Sprites && Sprites.defaultCharacter) {
      try { return Sprites.defaultCharacter(); } catch (e) { /* fall through */ }
    }
    return fallbackCharacter();
  }

  // Coerce a stored/partial character into a valid one (uses Sprites.sanitize
  // when present so out-of-range indices never crash the renderers).
  function normalizeCharacter(c) {
    if (typeof Sprites !== 'undefined' && Sprites && Sprites.sanitize) {
      try { return Sprites.sanitize(c); } catch (e) { /* fall through */ }
    }
    if (c && typeof c === 'object') {
      if (c.bodyType !== 'tux' && c.bodyType !== 'humanoid') c.bodyType = 'tux';
      return c;
    }
    return defaultCharacter();
  }

  // ---- screen manager ----------------------------------------------------
  // Toggles the .active class on the #screen-* containers. Editor/Menu/Game own
  // their own DOM inside those containers; this only flips which one is shown.
  function showScreen(name) {
    var ids = ['menu', 'editor', 'game'];
    for (var i = 0; i < ids.length; i++) {
      var elScreen = document.getElementById('screen-' + ids[i]);
      if (!elScreen) continue;
      if (ids[i] === name) elScreen.classList.add('active');
      else elScreen.classList.remove('active');
    }
    _currentScreen = name;
  }

  // ---- identity persistence ----------------------------------------------

  function getNickname() { return _nickname; }

  function setNickname(n) {
    _nickname = (n === null || n === undefined) ? '' : String(n);
    if (hasStore() && Store.setNickname) {
      try { Store.setNickname(_nickname); } catch (e) { /* ignore */ }
    }
    return _nickname;
  }

  function getCharacter() {
    if (!_character) _character = defaultCharacter();
    return _character;
  }

  function setCharacter(c) {
    _character = normalizeCharacter(c);
    if (hasStore() && Store.setCharacter) {
      try { Store.setCharacter(_character); } catch (e) { /* ignore */ }
    }
    return _character;
  }

  // updateCharacter is the callsite editor.js/menu.js use after an edit: it
  // updates the in-memory copy AND persists locally, then re-announces identity
  // to the server so an in-lobby avatar change propagates.
  function updateCharacter(c) {
    setCharacter(c);
    announceHello();
    return _character;
  }

  // ---- HELLO -------------------------------------------------------------
  // Announce identity to the server. Sent on first connect and on every
  // reconnect, plus whenever the character changes, so the server always has the
  // current nickname + character for room rosters.
  function announceHello() {
    if (typeof Net === 'undefined' || !Net.send || typeof Protocol === 'undefined') return;
    if (!Net.isOpen || !Net.isOpen()) return; // queued sends would also work, but
    Net.send(Protocol.HELLO, {              // we only want HELLO once a socket is up
      nickname: getNickname(),
      character: getCharacter()
    });
  }

  // ---- boot --------------------------------------------------------------

  function boot() {
    if (_booted) return;
    _booted = true;

    // 1) Localization + input.
    if (typeof I18n !== 'undefined' && I18n.init) {
      try { I18n.init(); } catch (e) { /* default 'en' */ }
    }
    if (typeof Input !== 'undefined' && Input.init) {
      try { Input.init(); } catch (e) { /* non-fatal */ }
    }

    // 2) Restore nickname + character from local storage (defaults otherwise).
    if (hasStore()) {
      try { _nickname = Store.getNickname ? (Store.getNickname() || '') : ''; }
      catch (e) { _nickname = ''; }
      var savedChar = null;
      try { savedChar = Store.getCharacter ? Store.getCharacter() : null; }
      catch (e) { savedChar = null; }
      _character = savedChar ? normalizeCharacter(savedChar) : defaultCharacter();
    } else {
      _character = defaultCharacter();
    }

    // 3) Open the socket and announce identity on every (re)connect. menu.js
    //    also wires its own onOpen (room list refresh); both coexist.
    if (typeof Net !== 'undefined' && Net.connect) {
      if (Net.onOpen) {
        Net.onOpen(function () { announceHello(); });
      }
      try { Net.connect(); } catch (e) { /* Net retries on its own */ }
    }

    // 4) If logged in, pull the cloud-stored character so it follows the player
    //    across devices, then re-announce. Non-blocking, best-effort.
    if (hasStore() && Store.isLoggedIn && Store.isLoggedIn() && Store.loadCharacterRemote) {
      Store.loadCharacterRemote().then(function (c) {
        if (c) { _character = normalizeCharacter(c); announceHello(); refreshUI(); }
      }).catch(function () { /* offline / no character — keep local */ });
    }

    // 5) Language changes: menu.js and editor.js each self-register their own
    //    I18n.onChange and re-localize their container in place, so App does not
    //    need to (and must not force a screen switch here).

    // 6) First-visit flow: show the menu screen, then the language popup on top
    //    (default English). Otherwise go straight to the menu.
    showScreen('menu');
    if (typeof Menu !== 'undefined' && Menu.show) {
      try { Menu.show(); } catch (e) { /* menu owns its DOM; ignore */ }
    }

    var chosen = !(typeof I18n !== 'undefined' && I18n.hasChosen) || I18n.hasChosen();
    if (!chosen && typeof Menu !== 'undefined' && Menu.showLanguagePopup) {
      try { Menu.showLanguagePopup(); } catch (e) { /* ignore */ }
    }
  }

  // Re-render the currently-active screen in place (used after an async cloud
  // character load so the new avatar shows). Only re-renders the screen that is
  // already showing, so it never yanks the player off the editor or game.
  function refreshUI() {
    if (_currentScreen === 'menu' && typeof Menu !== 'undefined' && Menu.show) {
      try { Menu.show(); } catch (e) { /* ignore */ }
    } else if (_currentScreen === 'editor' && typeof Editor !== 'undefined' && Editor.show) {
      try { Editor.show(); } catch (e) { /* ignore */ }
    }
    // The game screen re-localizes itself each frame via Render; nothing to do.
  }

  // ---- public object -----------------------------------------------------
  var api = {
    showScreen: showScreen,
    updateCharacter: updateCharacter,
    boot: boot
  };

  // nickname / character / playerId as accessor properties so callsites can do
  // `App.nickname = x` and `App.character` transparently with persistence.
  Object.defineProperty(api, 'nickname', {
    enumerable: true,
    get: getNickname,
    set: setNickname
  });
  Object.defineProperty(api, 'character', {
    enumerable: true,
    get: getCharacter,
    set: setCharacter
  });
  Object.defineProperty(api, 'playerId', {
    enumerable: true,
    get: function () { return _playerId; },
    set: function (v) { _playerId = v; }
  });

  return api;
})();

window.App = App;

// Kick off once the DOM is ready (all sibling scripts have already executed,
// since main.js is the last <script> tag).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { App.boot(); });
} else {
  App.boot();
}
