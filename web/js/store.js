// store.js — local persistence + account REST client. Single global: Store.
//
// Casual (no-account) save lives in localStorage, with a nickname cookie as a
// fallback so the player's name survives even if localStorage is blocked:
//   Store.getNickname() / Store.setNickname(n)
//   Store.getCharacter() / Store.setCharacter(c)   (localStorage 'clobi.character')
//
// Optional account REST client (talks to the Go server's /api/* endpoints via
// fetch; Bearer-token auth):
//   Store.register(u, p)         -> Promise<character>  (saves token, persists character)
//   Store.login(u, p)            -> Promise<character>  (saves token, persists character)
//   Store.logout()               clears token + remembered username
//   Store.isLoggedIn()           -> bool
//   Store.getToken()             -> string|null
//   Store.getUsername()          -> string|null
//   Store.saveCharacterRemote(c) -> Promise  (PUT; no-op unless logged in)
//   Store.loadCharacterRemote()  -> Promise<character|null>  (GET; null unless logged in)
//
// register/login resolve with the server's stored character; that character is
// also written to the local 'clobi.character' save so the editor/menu pick it up.
//
// No frameworks, no ES modules — this file assigns exactly one global.

var Store = (function () {
  var KEY_NICK = 'clobi.nickname';
  var KEY_CHAR = 'clobi.character';
  var KEY_TOKEN = 'clobi.token';
  var KEY_USER = 'clobi.username';
  var KEY_ADMIN = 'clobi.isAdmin';
  var KEY_TEX = 'clobi.textures';   // local library of painted textures (id -> record)
  var KEY_PRESETS = 'clobi.presets'; // local library of saved character presets (array)
  var COOKIE_NICK = 'clobi_nick';

  // ---- low-level localStorage helpers (degrade gracefully if unavailable) ----
  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      if (value === null || value === undefined) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  function lsRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) { /* ignore */ }
  }

  // ---- cookie helpers (nickname fallback so it survives if LS is blocked) ----
  function setCookie(name, value, days) {
    try {
      var maxAge = days ? '; max-age=' + (days * 24 * 60 * 60) : '';
      document.cookie =
        encodeURIComponent(name) + '=' + encodeURIComponent(value) +
        maxAge + '; path=/; SameSite=Lax';
    } catch (e) { /* ignore */ }
  }
  function getCookie(name) {
    try {
      var target = encodeURIComponent(name) + '=';
      var parts = document.cookie ? document.cookie.split(';') : [];
      for (var i = 0; i < parts.length; i++) {
        var c = parts[i];
        while (c.charAt(0) === ' ') c = c.substring(1);
        if (c.indexOf(target) === 0) {
          return decodeURIComponent(c.substring(target.length));
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---- character (de)serialization ----
  function readCharacter() {
    var raw = lsGet(KEY_CHAR);
    if (!raw) return null;
    try {
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
      return null;
    }
  }
  function writeCharacter(c) {
    if (c === null || c === undefined) {
      lsRemove(KEY_CHAR);
      return;
    }
    try {
      lsSet(KEY_CHAR, JSON.stringify(c));
    } catch (e) { /* ignore non-serializable */ }
  }

  // ---- REST helper: JSON request to /api/*, optional Bearer auth ----
  function request(method, path, body, useAuth) {
    var headers = { 'Content-Type': 'application/json' };
    if (useAuth) {
      var token = lsGet(KEY_TOKEN);
      if (token) headers['Authorization'] = 'Bearer ' + token;
    }
    var opts = { method: method, headers: headers };
    if (body !== undefined && body !== null) {
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      // Parse a JSON body if present; tolerate empty bodies.
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        if (!res.ok) {
          // A stale token (e.g. after a server restart) means the client only
          // *looks* signed in. Drop the dead session so the UI reflects reality
          // and the user is prompted to sign in again instead of silent failures.
          if (res.status === 401 && useAuth) clearSession();
          var message = (data && (data.error || data.message)) || ('HTTP ' + res.status);
          var err = new Error(message);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data || {};
      });
    });
  }

  // Drop the session token (keeps the local library cache so worn cosmetics
  // still show until the next sign-in re-syncs them). Fires a one-off event so
  // the UI can refresh its "Sign in" button and tell the user.
  var _clearing = false;
  function clearSession() {
    if (_clearing) return; // guard re-entrancy when many requests 401 at once
    _clearing = true;
    lsRemove(KEY_TOKEN); lsRemove(KEY_USER); lsRemove(KEY_ADMIN);
    try { if (window.dispatchEvent) window.dispatchEvent(new Event('clobi:auth-expired')); } catch (e) { /* ignore */ }
    setTimeout(function () { _clearing = false; }, 0);
  }

  // Extract the {item} envelope returned by most marketplace mutations.
  function it(d) { return d && d.item; }
  function noop() { }

  // ---- creative library cache (textures + presets) -----------------------
  // localStorage is a write-through cache; when signed in the server is the
  // source of truth and follows the player across devices.
  function readTexturesLocal() {
    var raw = lsGet(KEY_TEX);
    if (!raw) return {};
    try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function writeTexturesLocal(map) {
    try { lsSet(KEY_TEX, JSON.stringify(map || {})); } catch (e) { /* quota */ }
  }
  function readPresetsLocal() {
    var raw = lsGet(KEY_PRESETS);
    if (!raw) return [];
    try { var a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writePresetsLocal(arr) {
    try { lsSet(KEY_PRESETS, JSON.stringify(Array.isArray(arr) ? arr : [])); } catch (e) { /* quota */ }
  }

  function loggedIn() { return !!lsGet(KEY_TOKEN); }

  // Pull the account library into the local cache (used at boot when already
  // signed in). Server wins, so the cache mirrors the account exactly.
  function pullLibrary() {
    if (!loggedIn()) return Promise.resolve(null);
    return request('GET', '/api/library', null, true).then(function (d) {
      if (d && d.textures && typeof d.textures === 'object') writeTexturesLocal(d.textures);
      if (d && Object.prototype.hasOwnProperty.call(d, 'presets')) writePresetsLocal(d.presets || []);
      return d;
    }).catch(function () { return null; });
  }

  // Fold whatever the player made while signed out into their account WITHOUT
  // clobbering existing work, then mirror the merged result into the cache.
  // Runs right after register/login so guest creations are never lost.
  function migrateLibrary() {
    if (!loggedIn()) return Promise.resolve(null);
    var payload = { textures: readTexturesLocal(), presets: readPresetsLocal() };
    return request('POST', '/api/library/migrate', payload, true).then(function (d) {
      if (d && d.textures && typeof d.textures === 'object') writeTexturesLocal(d.textures);
      if (d && Object.prototype.hasOwnProperty.call(d, 'presets')) writePresetsLocal(d.presets || []);
      return d;
    }).catch(function () { return null; });
  }

  // Persist the session returned by register/login and surface the character.
  function adoptSession(username, data) {
    if (data && data.token) {
      lsSet(KEY_TOKEN, data.token);
      lsSet(KEY_USER, String(username));
      lsSet(KEY_ADMIN, data.isAdmin ? '1' : '');
    }
    var character = (data && data.character) ? data.character : null;
    if (character) {
      writeCharacter(character);
    }
    return character;
  }

  return {
    // -------- nickname --------
    getNickname: function () {
      var n = lsGet(KEY_NICK);
      if (n === null || n === '') {
        // fall back to the cookie if localStorage was empty/blocked
        var cookieNick = getCookie(COOKIE_NICK);
        if (cookieNick) n = cookieNick;
      }
      return n || '';
    },

    setNickname: function (n) {
      var value = (n === null || n === undefined) ? '' : String(n);
      lsSet(KEY_NICK, value);
      setCookie(COOKIE_NICK, value, 365); // fallback copy
      return value;
    },

    // -------- character --------
    getCharacter: function () {
      return readCharacter();
    },

    setCharacter: function (c) {
      writeCharacter(c);
      return c;
    },

    // -------- creative library: painted textures (per device + account) --------
    // Each record: {id, slot, title, glowColor, tintHint, createdAt, remixOf, png}.
    // localStorage is a write-through cache; when signed in every change is also
    // pushed to the account so it shows up on every device.
    getLocalTextures: function () { return readTexturesLocal(); },
    getLocalTexture: function (id) {
      return readTexturesLocal()[id] || null;
    },
    listLocalTextures: function () {
      var all = readTexturesLocal();
      return Object.keys(all).map(function (k) { return all[k]; });
    },
    saveLocalTexture: function (record) {
      if (!record || !record.id) return record;
      var all = readTexturesLocal();
      all[record.id] = record;
      writeTexturesLocal(all);
      if (loggedIn()) request('POST', '/api/library/texture', record, true).catch(noop);
      return record;
    },
    removeLocalTexture: function (id) {
      var all = readTexturesLocal();
      if (all[id]) { delete all[id]; writeTexturesLocal(all); }
      if (loggedIn()) request('POST', '/api/library/texture-delete', { id: id }, true).catch(noop);
    },

    // -------- creative library: character presets (per device + account) --------
    listPresets: function () { return readPresetsLocal(); },
    savePresets: function (arr) {
      arr = Array.isArray(arr) ? arr : [];
      writePresetsLocal(arr);
      if (loggedIn()) request('PUT', '/api/library/presets', arr, true).catch(noop);
      return arr;
    },

    // Pull the whole account library (textures + presets) into the local cache.
    // Called at boot when already signed in so a fresh device is hydrated.
    syncLibrary: function () { return pullLibrary(); },

    // -------- account session state --------
    getToken: function () {
      return lsGet(KEY_TOKEN);
    },

    getUsername: function () {
      return lsGet(KEY_USER);
    },

    isLoggedIn: function () {
      return !!lsGet(KEY_TOKEN);
    },

    // -------- account REST client --------
    // Resolve with the server's stored character (and persist token + character).
    register: function (username, password) {
      return request('POST', '/api/register',
        { username: username, password: password }, false)
        .then(function (data) {
          var ch = adoptSession(username, data);
          // Carry anonymous work into the brand-new account, then settle on it.
          return migrateLibrary().then(function () { return ch; });
        });
    },

    login: function (username, password) {
      return request('POST', '/api/login',
        { username: username, password: password }, false)
        .then(function (data) {
          var ch = adoptSession(username, data);
          // Merge any guest work made on this device, then mirror the account.
          return migrateLibrary().then(function () { return ch; });
        });
    },

    logout: function () {
      lsRemove(KEY_TOKEN);
      lsRemove(KEY_USER);
      lsRemove(KEY_ADMIN);
      // The library lives safely on the account now; drop the local cache so it
      // can't bleed into the next person who signs in on this device.
      lsRemove(KEY_TEX);
      lsRemove(KEY_PRESETS);
    },

    isAdmin: function () {
      return lsGet(KEY_ADMIN) === '1';
    },

    // The default-look slot a character belongs to (tux / male / female).
    defaultSlotFor: function (bodyType, gender) {
      if (bodyType === 'tux') return 'tux';
      return (gender === 'female') ? 'female' : 'male';
    },

    // GET every per-slot default look (admin-set, else built-in). Public.
    // Resolves with { tux:{...}, male:{...}, female:{...} } (or {} on error).
    getDefaultCharacters: function () {
      return request('GET', '/api/default-character', null, false)
        .then(function (data) { return (data && typeof data === 'object') ? data : {}; })
        .catch(function () { return {}; });
    },

    // GET the default look for one body-type slot. Resolves with the character
    // or null. Used to start guests / brand-new players with the admin's look.
    getDefaultCharacter: function (bodyType, gender) {
      var slot = this.defaultSlotFor(bodyType, gender);
      return this.getDefaultCharacters().then(function (all) {
        var c = all && all[slot];
        return (c && typeof c === 'object' && c.bodyType) ? c : null;
      });
    },

    // Admin only: set the default look for the posted character's slot (the
    // server derives the slot from its bodyType/gender). Full look incl. transforms.
    setDefaultRemote: function (character) {
      return request('POST', '/api/admin/default', character, true);
    },

    // -------- marketplace REST client (always-free cosmetics) --------
    // All calls pass auth when a token exists (so the server can fill in the
    // "my rating / my report / my vouch" flags), and degrade to anonymous.
    market: {
      list: function (opts) {
        opts = opts || {};
        var qp = [];
        if (opts.q) qp.push('q=' + encodeURIComponent(opts.q));
        if (opts.sort) qp.push('sort=' + encodeURIComponent(opts.sort));
        if (opts.kind) qp.push('kind=' + encodeURIComponent(opts.kind));
        if (opts.slot) qp.push('slot=' + encodeURIComponent(opts.slot));
        var q = qp.length ? ('?' + qp.join('&')) : '';
        return request('GET', '/api/market/list' + q, null, true).then(function (d) { return (d && d.items) || []; });
      },
      get: function (id) {
        return request('GET', '/api/market/item?id=' + encodeURIComponent(id), null, true).then(function (d) { return d && d.item; });
      },
      publish: function (item) { return request('POST', '/api/market/publish', item, true); },
      rate: function (id, stars) { return request('POST', '/api/market/rate', { id: id, stars: stars }, true).then(it); },
      comment: function (id, text, parentId) { return request('POST', '/api/market/comment', { id: id, text: text, parentId: parentId || '' }, true).then(it); },
      report: function (id, reason) { return request('POST', '/api/market/report', { id: id, reason: reason || '' }, true).then(it); },
      unreport: function (id) { return request('POST', '/api/market/unreport', { id: id }, true).then(it); },
      vouch: function (id) { return request('POST', '/api/market/vouch', { id: id }, true).then(it); },
      unvouch: function (id) { return request('POST', '/api/market/unvouch', { id: id }, true).then(it); },
      download: function (id) { return request('POST', '/api/market/download', { id: id }, true).then(it); },
      del: function (id) { return request('POST', '/api/market/delete', { id: id }, true); },
      ban: function (id) { return request('POST', '/api/market/admin/ban', { id: id }, true).then(it); },
      revoke: function (id) { return request('POST', '/api/market/admin/revoke', { id: id }, true).then(it); }
    },

    // GDPR: download all personal data we hold for this account.
    exportAccountData: function () {
      return request('GET', '/api/account/export', null, true);
    },

    // GDPR: permanently erase this account and all its data, then sign out.
    deleteAccount: function () {
      var self = this;
      return request('DELETE', '/api/account', null, true).then(function (r) {
        self.logout();
        writeCharacter(null);
        return r;
      });
    },

    // PUT the character to the server. No-op (resolves null) unless logged in.
    // The Go server's /api/character takes and returns the bare Character object
    // (NOT wrapped in {character}), so we send/read the object directly.
    saveCharacterRemote: function (character) {
      if (!this.isLoggedIn()) {
        return Promise.resolve(null);
      }
      return request('PUT', '/api/character', character, true)
        .then(function (data) {
          // Server echoes back the saved character object directly; tolerate a
          // {character} wrapper too in case the contract ever changes.
          var saved = (data && data.character) ? data.character : data;
          return (saved && typeof saved === 'object' && saved.bodyType)
            ? saved : character;
        });
    },

    // GET the stored character. Resolves null unless logged in.
    loadCharacterRemote: function () {
      if (!this.isLoggedIn()) {
        return Promise.resolve(null);
      }
      return request('GET', '/api/character', null, true).then(function (data) {
        // Server returns the bare Character object; tolerate a {character}
        // wrapper as a fallback.
        var character = (data && data.character) ? data.character : data;
        if (character && typeof character === 'object' && character.bodyType) {
          writeCharacter(character);
          return character;
        }
        return null;
      });
    }
  };
})();

window.Store = Store;
