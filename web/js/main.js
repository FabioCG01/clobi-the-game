// main.js — application bootstrap + screen router. Single global: window.App.
//
// App is the small spine that wires the independently-authored modules together
// for the 3D voxel era (CLOBI CRAFT):
//   - boots localization (I18n.init),
//   - resolves the player's ACTIVE SKIN through the pinned fallback chain:
//       Store.getActiveSkin() (local record)
//         -> logged-in cloud skin (Store.loadActiveSkinRemote)
//         -> server-wide default (Store.getDefaultSkinRemote)
//         -> the bundled default (Skins.loadDefault),
//     exposes it as App.skin (a resolved Skins skin object: {canvas, model,
//     dataURL()}) and keeps it in sync via Store.onSkinChange,
//   - exposes the screen router App.showScreen(name[, opts]) which toggles the
//     .active class on the five screens and calls each module's show()/hide()
//     lifecycle (Game is the exception: Game.start()/Game.stop() are explicit
//     and drive the 'game' screen themselves),
//   - shows the first-visit language popup (defaulting to English) on the menu.
//
// Saving on tab close is handled inside Game (visibilitychange/pagehide), so
// there is no beforeunload wiring here. No frameworks, no ES modules: this file
// assigns exactly one global and is the LAST <script>, so every other global
// already exists (each one still defensively typeof-guarded — modules must be
// individually removable without breaking boot).
//
// Depends on (all optional at runtime): I18n, Store, Skins, Game, Menu,
// SkinStudio, Market.

var App = (function () {
  'use strict';

  // ---- live shared state ---------------------------------------------------
  // Part II (ARCHITECTURE-MP.md §4.3): 'worlds' is the WorldSelect screen
  // (My Worlds / Join a Game), routed exactly like wardrobe/studio/market.
  var SCREENS = ['menu', 'game', 'studio', 'wardrobe', 'market', 'worlds'];
  var _current = null;        // active screen name (null until boot routes)
  var _booted = false;

  var _skin = null;           // resolved Skins skin object (App.skin)
  var _lastPng = null;        // png of the last applied record (change dedupe)
  var _lastModel = null;      // model of the last applied record
  var _squelchStore = false;  // true while WE call Store.setActiveSkin (no echo)
  var _skinListeners = [];    // internal subscribers (Menu hero turntable etc.)

  // ---- helpers ---------------------------------------------------------------
  function hasStore() { return typeof Store !== 'undefined' && !!Store; }
  function hasSkins() { return typeof Skins !== 'undefined' && !!Skins; }

  // ---- screen router ---------------------------------------------------------
  // Toggles .active on the #screen-* containers and runs the show()/hide()
  // lifecycle of the leaving/entering module. Modules may call
  // App.showScreen(theirOwnName) from inside their show() — the early-return
  // below makes that re-entrant call a harmless no-op instead of a loop.
  function screenEl(name) { return document.getElementById('screen-' + name); }

  function toggleClasses(name) {
    for (var i = 0; i < SCREENS.length; i++) {
      var elScreen = screenEl(SCREENS[i]);
      if (!elScreen) continue;
      if (SCREENS[i] === name) elScreen.classList.add('active');
      else elScreen.classList.remove('active');
    }
  }

  // Lifecycle table (per contract §5.21; Part II adds 'worlds' — §4.3):
  //   menu     -> Menu.show()/Menu.hide()
  //   wardrobe -> Menu.showWardrobe()/Menu.hideWardrobe()  (wardrobe lives in menu.js)
  //   studio   -> SkinStudio.show(opts)/SkinStudio.hide()
  //   market   -> Market.show()/Market.hide()
  //   worlds   -> WorldSelect.show()/WorldSelect.hide()
  //   game     -> none: Game.start()/Game.stop() are the explicit entry/exit.
  function lifecycleHide(name) {
    if (!name) return;
    try {
      if (name === 'menu' && typeof Menu !== 'undefined' && Menu.hide) Menu.hide();
      else if (name === 'wardrobe' && typeof Menu !== 'undefined' && Menu.hideWardrobe) Menu.hideWardrobe();
      else if (name === 'studio' && typeof SkinStudio !== 'undefined' && SkinStudio.hide) SkinStudio.hide();
      else if (name === 'market' && typeof Market !== 'undefined' && Market.hide) Market.hide();
      else if (name === 'worlds' && typeof WorldSelect !== 'undefined' && WorldSelect.hide) WorldSelect.hide();
    } catch (e) { /* a module's teardown must never block navigation */ }
  }

  function lifecycleShow(name, opts) {
    try {
      if (name === 'menu' && typeof Menu !== 'undefined' && Menu.show) Menu.show();
      else if (name === 'wardrobe' && typeof Menu !== 'undefined' && Menu.showWardrobe) Menu.showWardrobe(opts);
      else if (name === 'studio' && typeof SkinStudio !== 'undefined' && SkinStudio.show) SkinStudio.show(opts);
      else if (name === 'market' && typeof Market !== 'undefined' && Market.show) Market.show(opts);
      else if (name === 'worlds' && typeof WorldSelect !== 'undefined' && WorldSelect.show) WorldSelect.show(opts);
    } catch (e) { /* module owns its DOM; a failed show leaves the screen blank, not the app dead */ }
  }

  function showScreen(name, opts) {
    if (SCREENS.indexOf(name) === -1) return;

    var target = screenEl(name);
    var alreadyActive = !!(target && target.classList.contains('active'));

    if (name === _current) {
      // Re-entrant call (e.g. from inside the target's own show()) — or the
      // classes were changed behind our back (Game toggling directly): only
      // re-assert visibility, never re-run lifecycles from here.
      if (!alreadyActive) toggleClasses(name);
      return;
    }

    var prev = _current;
    _current = name;             // set BEFORE lifecycles so nested calls no-op
    toggleClasses(name);
    lifecycleHide(prev);
    lifecycleShow(name, opts);
  }

  // ---- active skin -----------------------------------------------------------
  function fireSkinChange() {
    for (var i = 0; i < _skinListeners.length; i++) {
      try { _skinListeners[i](_skin); } catch (e) { /* listener bug != app bug */ }
    }
  }

  // Subscribe to resolved-skin changes (fires on boot resolution, App.setSkin,
  // and Store-driven changes). Menu uses this to refresh its hero turntable —
  // including for non-persisted "try on" wears that never touch the Store.
  function onSkinChange(fn) {
    if (typeof fn === 'function') _skinListeners.push(fn);
  }

  // Core: load a skin record ({name, model, png, ...}) into a live Skins skin.
  // syncOpts: {persistLocal, persistRemote} — both false/absent = memory only.
  function applyRecord(rec, syncOpts) {
    if (!rec || !rec.png) return Promise.reject(new Error('bad skin record'));
    if (!hasSkins() || !Skins.load) return Promise.reject(new Error('Skins module unavailable'));

    return Skins.load(rec.png).then(function (sk) {
      // The record's stored model wins over auto-detection (manual override).
      if (rec.model === 'classic' || rec.model === 'slim') sk.model = rec.model;
      _skin = sk;
      _lastPng = rec.png;
      _lastModel = sk.model;

      if (syncOpts && syncOpts.persistLocal && hasStore() && Store.setActiveSkin) {
        _squelchStore = true;
        try { Store.setActiveSkin(rec); } catch (e) { /* quota etc. — keep going */ }
        _squelchStore = false;
      }
      if (syncOpts && syncOpts.persistRemote && hasStore() && Store.syncActiveSkinRemote) {
        try { Store.syncActiveSkinRemote().catch(function () { /* offline is fine */ }); }
        catch (e) { /* ignore */ }
      }

      // Live-update the player mid-game.
      if (typeof Game !== 'undefined' && Game && Game.isRunning && Game.setSkin) {
        try { Game.setSkin(sk); } catch (e) { /* ignore */ }
      }

      fireSkinChange();
      return sk;
    });
  }

  // Public: wear a skin record. opts.persist === false -> session-only try-on
  // (no Store write, no cloud sync). Returns a Promise of the resolved skin.
  function setSkin(rec, opts) {
    opts = opts || {};
    var persist = opts.persist !== false;
    return applyRecord(rec, { persistLocal: persist, persistRemote: persist });
  }

  // Boot-time resolution chain (contract §5.21). Non-blocking: the menu shows
  // immediately and refreshes via the skin-change listeners when this lands.
  function resolveInitialSkin() {
    var localRec = null;
    if (hasStore() && Store.getActiveSkin) {
      try { localRec = Store.getActiveSkin(); } catch (e) { localRec = null; }
    }

    var p;
    if (localRec && localRec.png) {
      p = applyRecord(localRec, null).catch(function () { return null; });
    } else {
      p = Promise.resolve(null);
    }

    // 2) Logged in? The cloud copy of the active skin follows the player.
    p = p.then(function (sk) {
      if (sk) return sk;
      if (hasStore() && Store.isLoggedIn && Store.isLoggedIn() && Store.loadActiveSkinRemote) {
        return Store.loadActiveSkinRemote().then(function (rec) {
          if (rec && rec.png) {
            // Persist locally (fast next boot) but don't echo it back upstream.
            return applyRecord(rec, { persistLocal: true, persistRemote: false });
          }
          return null;
        }).catch(function () { return null; });
      }
      return null;
    });

    // 3) The admin-chosen server-wide default (kept in memory only so future
    //    admin changes keep propagating to players who never picked a skin).
    p = p.then(function (sk) {
      if (sk) return sk;
      if (hasStore() && Store.getDefaultSkinRemote) {
        return Store.getDefaultSkinRemote().then(function (rec) {
          if (rec && rec.png) return applyRecord(rec, null);
          return null;
        }).catch(function () { return null; });
      }
      return null;
    });

    // 4) The bundled "Clobi" default — Skins.loadDefault has its own embedded
    //    fallback, so this succeeds even fully offline.
    return p.then(function (sk) {
      if (sk) return sk;
      if (hasSkins() && Skins.loadDefault) {
        return Skins.loadDefault().then(function (dsk) {
          _skin = dsk;
          _lastPng = null;
          _lastModel = dsk ? dsk.model : null;
          fireSkinChange();
          return dsk;
        });
      }
      return null;
    }).catch(function () { return null; /* App.skin stays null; menu shows a placeholder */ });
  }

  // Keep App.skin in sync with Store-driven changes (other tabs, wardrobe code
  // paths that write straight to the Store, post-login cloud pulls…).
  function wireStoreSkinSync() {
    if (!hasStore() || !Store.onSkinChange) return;
    try {
      Store.onSkinChange(function (rec) {
        if (_squelchStore) return; // our own write echoing back
        if (!rec && Store.getActiveSkin) {
          try { rec = Store.getActiveSkin(); } catch (e) { rec = null; }
        }
        if (!rec || !rec.png) return;
        var model = (rec.model === 'classic' || rec.model === 'slim') ? rec.model : _lastModel;
        if (rec.png === _lastPng && model === _lastModel) return; // already applied
        applyRecord(rec, null).catch(function () { /* bad record — keep current */ });
      });
    } catch (e) { /* ignore */ }
  }

  // ---- boot --------------------------------------------------------------
  function boot() {
    if (_booted) return;
    _booted = true;

    // 1) Localization.
    if (typeof I18n !== 'undefined' && I18n.init) {
      try { I18n.init(); } catch (e) { /* default 'en' */ }
    }

    // 2) Active-skin resolution (async, non-blocking) + Store sync.
    wireStoreSkinSync();
    try { resolveInitialSkin(); } catch (e) { /* menu shows placeholder */ }

    // 3) Show the menu (router runs Menu.show()).
    showScreen('menu');

    // 4) First-visit language popup on top (defaults to English).
    var chosen = !(typeof I18n !== 'undefined' && I18n.hasChosen) || I18n.hasChosen();
    if (!chosen && typeof Menu !== 'undefined' && Menu.showLanguagePopup) {
      try { Menu.showLanguagePopup(); } catch (e) { /* ignore */ }
    }
  }

  // ---- public object -----------------------------------------------------
  var api = {
    showScreen: showScreen,
    setSkin: setSkin,
    onSkinChange: onSkinChange,
    boot: boot
  };

  // App.skin — the resolved Skins skin object currently worn (or null while
  // the boot chain is still in flight / everything failed).
  Object.defineProperty(api, 'skin', { enumerable: true, get: function () { return _skin; } });
  // Convenience for modules that want to know what's on screen (not pinned,
  // purely additive).
  Object.defineProperty(api, 'currentScreen', { enumerable: true, get: function () { return _current; } });

  return api;
})();

window.App = App;

// Kick off once the DOM is ready (main.js is the last <script> tag).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { App.boot(); });
} else {
  App.boot();
}
