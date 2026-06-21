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

  // Persist the session returned by register/login and surface the character.
  function adoptSession(username, data) {
    if (data && data.token) {
      lsSet(KEY_TOKEN, data.token);
      lsSet(KEY_USER, String(username));
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
          return adoptSession(username, data);
        });
    },

    login: function (username, password) {
      return request('POST', '/api/login',
        { username: username, password: password }, false)
        .then(function (data) {
          return adoptSession(username, data);
        });
    },

    logout: function () {
      lsRemove(KEY_TOKEN);
      lsRemove(KEY_USER);
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
