// main.js — application bootstrap + screen manager. Single global: window.App.
//
// App is the small spine that wires the independently-authored modules together:
//   - boots localization (I18n.init),
//   - restores the player's display name + character from Store (defaulting to
//     the classic Clobi look when none is saved),
//   - preloads the image-based character textures,
//   - exposes the screen manager (App.showScreen) and the shared state
//     (App.nickname / App.character) that menu / editor / create / marketplace read,
//   - shows the first-visit language popup (defaulting to English) on top of the menu.
//
// The realtime PvP gamemodes and their WebSocket transport are retired, so there
// is no Net/Input wiring here anymore — character sync happens over the REST API
// in store.js. No frameworks, no ES modules: this file assigns exactly one global
// and is the LAST script loaded, so every other global already exists.

var App = (function () {
  'use strict';

  // ---- live shared state -------------------------------------------------
  var _nickname = '';
  var _character = null;
  var _currentScreen = 'menu'; // 'menu' | 'editor' | 'create' | 'marketplace'
  var _booted = false;

  // The set of swappable full-viewport screens.
  var SCREENS = ['menu', 'editor', 'create', 'marketplace'];

  // ---- helpers -----------------------------------------------------------
  function hasStore() { return typeof Store !== 'undefined' && Store; }

  function fallbackCharacter() {
    return { name: '', bodyType: 'tux', body: 0, belly: 0, feet: 0, hat: 0, eyes: 0, accessory: 0, cape: 0 };
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

  // Register the player's locally-painted textures with the renderer so any
  // worn custom cosmetics show up. Resolves once all are registered.
  function registerLocalTextures() {
    if (!hasStore() || !Store.listLocalTextures || typeof Textures === 'undefined' || !Textures.registerCustomPNG) {
      return Promise.resolve();
    }
    var list = Store.listLocalTextures();
    return Promise.all(list.map(function (rec) {
      if (rec && rec.id && rec.png) {
        return Textures.registerCustomPNG({ id: rec.id, slot: rec.slot, glowColor: rec.glowColor, tintHint: rec.tintHint }, rec.png);
      }
      return null;
    }));
  }

  // ---- screen manager ----------------------------------------------------
  // Toggles the .active class on the #screen-* containers. Each module owns its
  // own DOM inside those containers; this only flips which one is shown.
  function showScreen(name) {
    for (var i = 0; i < SCREENS.length; i++) {
      var elScreen = document.getElementById('screen-' + SCREENS[i]);
      if (!elScreen) continue;
      if (SCREENS[i] === name) elScreen.classList.add('active');
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

  // updateCharacter is the callsite editor/create use after an edit: update the
  // in-memory copy and persist locally. Remote cloud sync (when logged in) is
  // driven by the editor's Save via Store.saveCharacterRemote.
  function updateCharacter(c) {
    return setCharacter(c);
  }

  // ---- boot --------------------------------------------------------------
  function boot() {
    if (_booted) return;
    _booted = true;

    // 1) Localization.
    if (typeof I18n !== 'undefined' && I18n.init) {
      try { I18n.init(); } catch (e) { /* default 'en' */ }
    }

    // 2) Preload the image-based character textures. If signed in, first pull the
    //    account's creative library into the local cache so a fresh device is
    //    hydrated; then register any painted custom textures so worn cosmetics
    //    render. Non-blocking.
    if (typeof Textures !== 'undefined' && Textures.load) {
      try {
        Textures.load('assets/tex/')
          .then(function () { return (hasStore() && Store.syncLibrary) ? Store.syncLibrary() : null; })
          .then(function () { return registerLocalTextures(); })
          .then(function () { refreshUI(); })
          .catch(function () {});
      } catch (e) { /* ignore */ }
    }

    // 3) Restore display name + character from local storage (defaults otherwise).
    var savedChar = null;
    if (hasStore()) {
      try { _nickname = Store.getNickname ? (Store.getNickname() || '') : ''; }
      catch (e) { _nickname = ''; }
      try { savedChar = Store.getCharacter ? Store.getCharacter() : null; }
      catch (e) { savedChar = null; }
      _character = savedChar ? normalizeCharacter(savedChar) : defaultCharacter();
    } else {
      _character = defaultCharacter();
    }

    // 4) If logged in, pull the cloud-stored character so it follows the player
    //    across devices. Otherwise, brand-new players (no saved character) start
    //    with the admin-chosen default look for the current body type.
    if (hasStore() && Store.isLoggedIn && Store.isLoggedIn() && Store.loadCharacterRemote) {
      Store.loadCharacterRemote().then(function (c) {
        if (c) { _character = normalizeCharacter(c); refreshUI(); }
      }).catch(function () { /* offline / no character — keep local */ });
    } else if (hasStore() && !savedChar && Store.getDefaultCharacter) {
      Store.getDefaultCharacter(_character.bodyType, _character.gender).then(function (c) {
        if (c && !(Store.getCharacter && Store.getCharacter())) {
          _character = normalizeCharacter(c); refreshUI();
        }
      }).catch(function () { /* keep local default */ });
    }

    // 5) Show the menu, then the first-visit language popup on top (default EN).
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
  // character load). Only re-renders the screen already showing.
  function refreshUI() {
    if (_currentScreen === 'menu' && typeof Menu !== 'undefined' && Menu.show) {
      try { Menu.show(); } catch (e) { /* ignore */ }
    } else if (_currentScreen === 'editor' && typeof Editor !== 'undefined' && Editor.show) {
      try { Editor.show(); } catch (e) { /* ignore */ }
    }
  }

  // Re-register painted textures from the (freshly synced) cache and re-render.
  // Called after sign-in so the account's cosmetics show up immediately.
  function refreshTextures() {
    return registerLocalTextures().then(function () { refreshUI(); });
  }

  // ---- public object -----------------------------------------------------
  var api = {
    showScreen: showScreen,
    updateCharacter: updateCharacter,
    refreshTextures: refreshTextures,
    boot: boot
  };

  Object.defineProperty(api, 'nickname', { enumerable: true, get: getNickname, set: setNickname });
  Object.defineProperty(api, 'character', { enumerable: true, get: getCharacter, set: setCharacter });

  return api;
})();

window.App = App;

// Kick off once the DOM is ready (main.js is the last <script> tag).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { App.boot(); });
} else {
  App.boot();
}
