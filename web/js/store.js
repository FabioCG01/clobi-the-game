// store.js — local persistence + account REST client. Single global: Store.
//
// Casual (no-account) save lives in localStorage, with a nickname cookie as a
// fallback so the player's name survives even if localStorage is blocked:
//   Store.getNickname() / Store.setNickname(n)
//
// 3D skin system (voxel era — the primary cosmetic pipeline):
//   Skin record: {id?, name, model ('classic'|'slim'), png (dataURL 64×64),
//                 remixOf?, marketId?, createdAt?}
//   Store.getActiveSkin() / Store.setActiveSkin(rec)   (localStorage 'clobi.activeSkin')
//   Store.onSkinChange(fn)              subscribe to active-skin changes
//   Store.syncActiveSkinRemote()        -> Promise      (PUT /api/skin when logged in)
//   Store.loadActiveSkinRemote()        -> Promise<rec|null>  (GET /api/skin; 404 → null)
//   Store.getDefaultSkinRemote()        -> Promise<rec|null>  (GET /api/default-skin; 404 → null)
//   Store.listSkins() / saveSkin(rec) / deleteSkin(id)  wardrobe library
//     (localStorage 'clobi.skins'; cloud copy rides the /api/library/texture
//      endpoints as records with kind:'skin' so it follows the account)
//   Store.syncSkinLibrary()             -> Promise      pull cloud skins after login
//   Store.marketListSkins/marketItem/marketPublishSkin/marketRate/marketComment/
//   Store.marketReport/marketUnreport/marketVouch/marketUnvouch/marketDownload/
//   Store.marketDelete/marketAdmin      thin /api/market/* fetch wrappers
//   Store.setAdminDefaultSkin(rec)      POST /api/admin/default-skin (admin)
//
// Part II (ARCHITECTURE-MP.md §4.6): persistent worlds, rooms and friends —
// thin fetch wrappers over the same REST client, same rules (Bearer token
// when present, reject with Error(message-from-server), never throw sync):
//   Store.worldsList()                  GET  /api/worlds            -> [WorldView]
//   Store.worldsCreate({name,seed})     POST /api/worlds/create     -> WorldView
//   Store.worldsRename(id,name)         POST /api/worlds/rename
//   Store.worldsDelete(id)              POST /api/worlds/delete     (409 while hosted)
//   Store.worldsMemberAdd(id,user)      POST /api/worlds/members/add
//   Store.worldsMemberRemove(id,user)   POST /api/worlds/members/remove
//   Store.worldsImport(payload)         POST /api/worlds/import     -> WorldView
//     (payload: {name, seed, deltas:{"cx,cz":base64,…}} — pairs with
//      world.exportLocalDeltas() in js/vox/world.js for "Upload to server")
//   Store.roomsList()                   GET  /api/rooms             -> [RoomInfo]
//   Store.roomsOpen({worldId,access,pin}) POST /api/rooms/open      -> {roomId}
//     (409 ErrAlreadyHosted surfaces as err.data = {error,host,roomId})
//   Store.roomsClose(roomId)            POST /api/rooms/close
//   Store.friendsList()                 GET  /api/friends -> {friends,incoming,outgoing}
//   Store.friendsRequest(u)             POST /api/friends/request
//   Store.friendsAccept(u)              POST /api/friends/accept
//   Store.friendsRemove(u)              POST /api/friends/remove
//
// Optional account REST client (talks to the Go server's /api/* endpoints via
// fetch; Bearer-token auth):
//   Store.register(u, p)         -> Promise<character>  (saves token, persists character)
//   Store.login(u, p)            -> Promise<character>  (saves token, persists character)
//   Store.logout()               clears token + remembered username
//   Store.isLoggedIn()           -> bool
//   Store.getToken()             -> string|null
//   Store.getUsername()          -> string|null
//
// Legacy 2D-era character APIs (getCharacter/saveCharacterRemote/…) are kept
// for data continuity but are no longer wired into any screen.
//
// All fetch wrappers reject with Error(message-from-server) and never throw
// synchronously; offline → a rejected promise the UI turns into a friendly toast.
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
  var KEY_SKINS = 'clobi.skins';    // wardrobe: local library of 3D skins (id -> record)
  var KEY_ACTIVE_SKIN = 'clobi.activeSkin'; // the skin currently worn
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

  // ---- 3D skin library helpers (wardrobe + active skin) -------------------
  function readSkinsLocal() {
    var raw = lsGet(KEY_SKINS);
    if (!raw) return {};
    try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }
  function writeSkinsLocal(map) {
    try { lsSet(KEY_SKINS, JSON.stringify(map || {})); } catch (e) { /* quota */ }
  }
  function newSkinId() {
    return 'sk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // Normalize any object into a valid skin record (or null when hopeless).
  function cleanSkinRec(rec) {
    if (!rec || typeof rec !== 'object' || typeof rec.png !== 'string' || !rec.png) return null;
    var out = {
      id: (typeof rec.id === 'string' && rec.id) ? rec.id : undefined,
      kind: 'skin',
      name: (typeof rec.name === 'string' && rec.name) ? rec.name : 'Skin',
      model: rec.model === 'slim' ? 'slim' : 'classic',
      png: rec.png,
      remixOf: (typeof rec.remixOf === 'string') ? rec.remixOf : '',
      createdAt: (typeof rec.createdAt === 'string' && rec.createdAt) ? rec.createdAt : new Date().toISOString()
    };
    if (typeof rec.marketId === 'string' && rec.marketId) out.marketId = rec.marketId;
    return out;
  }
  // Fold every kind:'skin' record of a cloud /api/library textures map into
  // the local wardrobe (server wins per id — it is the source of truth).
  function mergeSkinRecords(textures) {
    if (!textures || typeof textures !== 'object') return;
    var all = readSkinsLocal(), changed = false;
    Object.keys(textures).forEach(function (id) {
      var v = textures[id];
      if (v && typeof v === 'object' && v.kind === 'skin' && v.png) {
        var rec = cleanSkinRec(v);
        if (rec) { rec.id = id; all[id] = rec; changed = true; }
      }
    });
    if (changed) writeSkinsLocal(all);
  }
  // Strip a skin record down to the server's protocol.Skin shape for
  // /api/skin and /api/admin/default-skin bodies.
  function protoSkin(rec) {
    var out = {
      name: (rec && typeof rec.name === 'string') ? rec.name : 'Skin',
      model: (rec && rec.model === 'slim') ? 'slim' : 'classic',
      png: (rec && rec.png) || ''
    };
    if (rec && rec.remixOf) out.remixOf = rec.remixOf;
    if (rec && rec.createdAt) out.createdAt = rec.createdAt;
    return out;
  }
  // active-skin change listeners (menu turntable + running game subscribe)
  var skinListeners = [];
  function fireSkinChange(rec) {
    for (var i = 0; i < skinListeners.length; i++) {
      try { skinListeners[i](rec); } catch (e) { /* listener errors stay theirs */ }
    }
  }

  // Pull the account library into the local cache (used at boot when already
  // signed in). Server wins, so the cache mirrors the account exactly.
  function pullLibrary() {
    if (!loggedIn()) return Promise.resolve(null);
    return request('GET', '/api/library', null, true).then(function (d) {
      if (d && d.textures && typeof d.textures === 'object') {
        writeTexturesLocal(d.textures);
        mergeSkinRecords(d.textures); // cloud skins ride the textures table
      }
      if (d && Object.prototype.hasOwnProperty.call(d, 'presets')) writePresetsLocal(d.presets || []);
      return d;
    }).catch(function () { return null; });
  }

  // Fold whatever the player made while signed out into their account WITHOUT
  // clobbering existing work, then mirror the merged result into the cache.
  // Runs right after register/login so guest creations are never lost.
  function migrateLibrary() {
    if (!loggedIn()) return Promise.resolve(null);
    // Guest-made 3D skins ride along in the textures map (they carry
    // kind:'skin' and 'sk…' ids, so they can never collide with 2D textures).
    var textures = readTexturesLocal();
    var skins = readSkinsLocal();
    var merged = {};
    Object.keys(textures).forEach(function (k) { merged[k] = textures[k]; });
    Object.keys(skins).forEach(function (k) { merged[k] = skins[k]; });
    var payload = { textures: merged, presets: readPresetsLocal() };
    return request('POST', '/api/library/migrate', payload, true).then(function (d) {
      if (d && d.textures && typeof d.textures === 'object') {
        writeTexturesLocal(d.textures);
        mergeSkinRecords(d.textures);
      }
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

    // -------- 3D skins: the active (worn) skin --------
    // rec: {name, model ('classic'|'slim'), png (dataURL 64×64), remixOf?, marketId?}
    getActiveSkin: function () {
      var raw = lsGet(KEY_ACTIVE_SKIN);
      if (!raw) return null;
      try {
        var obj = JSON.parse(raw);
        return (obj && typeof obj === 'object' && obj.png) ? obj : null;
      } catch (e) { return null; }
    },

    setActiveSkin: function (rec) {
      if (rec === null || rec === undefined) {
        lsRemove(KEY_ACTIVE_SKIN);
        fireSkinChange(null);
        return null;
      }
      var clean = cleanSkinRec(rec);
      if (!clean) return null;
      try { lsSet(KEY_ACTIVE_SKIN, JSON.stringify(clean)); } catch (e) { /* quota */ }
      fireSkinChange(clean);
      return clean;
    },

    // Subscribe to active-skin changes (menu turntable + running game).
    // Returns an unsubscribe function.
    onSkinChange: function (fn) {
      if (typeof fn === 'function') skinListeners.push(fn);
      return function () {
        var i = skinListeners.indexOf(fn);
        if (i >= 0) skinListeners.splice(i, 1);
      };
    },

    // PUT the worn skin to the account (no-op resolves null when signed out).
    syncActiveSkinRemote: function () {
      if (!loggedIn()) return Promise.resolve(null);
      var rec = this.getActiveSkin();
      if (!rec) return Promise.resolve(null);
      return request('PUT', '/api/skin', protoSkin(rec), true);
    },

    // GET the account's stored skin. Resolves null when signed out or 404.
    loadActiveSkinRemote: function () {
      if (!loggedIn()) return Promise.resolve(null);
      return request('GET', '/api/skin', null, true).then(function (data) {
        return (data && typeof data === 'object' && data.png) ? data : null;
      }).catch(function (err) {
        if (err && err.status === 404) return null;
        throw err;
      });
    },

    // GET the server-wide default skin (public). 404 → null.
    getDefaultSkinRemote: function () {
      return request('GET', '/api/default-skin', null, false).then(function (data) {
        return (data && typeof data === 'object' && data.png) ? data : null;
      }).catch(function (err) {
        if (err && err.status === 404) return null;
        throw err;
      });
    },

    // Admin only: set the default skin new players start with.
    setAdminDefaultSkin: function (rec) {
      return request('POST', '/api/admin/default-skin', protoSkin(rec), true);
    },

    // -------- 3D skins: wardrobe library (per device + account) --------
    // localStorage 'clobi.skins' is a write-through cache; when signed in each
    // save/delete is mirrored to the account through the existing
    // /api/library/texture endpoints (records carry kind:'skin').
    listSkins: function () {
      var all = readSkinsLocal();
      return Object.keys(all).map(function (k) { return all[k]; }).sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
    },

    getSkin: function (id) {
      return readSkinsLocal()[id] || null;
    },

    saveSkin: function (rec) {
      var clean = cleanSkinRec(rec);
      if (!clean) return null;
      if (!clean.id) clean.id = newSkinId();
      var all = readSkinsLocal();
      all[clean.id] = clean;
      writeSkinsLocal(all);
      if (loggedIn()) request('POST', '/api/library/texture', clean, true).catch(noop);
      return clean;
    },

    deleteSkin: function (id) {
      if (!id) return;
      var all = readSkinsLocal();
      if (all[id]) { delete all[id]; writeSkinsLocal(all); }
      if (loggedIn()) request('POST', '/api/library/texture-delete', { id: id }, true).catch(noop);
    },

    // Pull the cloud library and fold every kind:'skin' record into the local
    // wardrobe. Resilient: resolves with the (possibly unchanged) local list
    // even when the network is down. Called after login and at boot.
    syncSkinLibrary: function () {
      var self = this;
      return pullLibrary().then(function () { return self.listSkins(); });
    },

    // Pull the whole account library (textures + presets + skins) into the
    // local cache. Called at boot when already signed in so a fresh device is
    // hydrated.
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
      // The library lives safely on the account now; drop the local caches so
      // they can't bleed into the next person who signs in on this device.
      // The worn skin (KEY_ACTIVE_SKIN) stays — like the nickname, it's a
      // device-level cosmetic that should survive signing out.
      lsRemove(KEY_TEX);
      lsRemove(KEY_PRESETS);
      lsRemove(KEY_SKINS);
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

    // -------- marketplace REST client: 3D skins (voxel era) --------
    // Thin wrappers over /api/market/*; auth is attached when a token exists
    // so the server can fill in the my-rating/my-report/my-vouch flags.
    // Mutations resolve with the item's fresh server view (the {item} envelope
    // unwrapped) so the UI can update in place.
    marketListSkins: function (opts) {
      opts = opts || {};
      var qp = ['kind=skin'];
      if (opts.q) qp.push('q=' + encodeURIComponent(opts.q));
      if (opts.sort) qp.push('sort=' + encodeURIComponent(opts.sort));
      if (opts.model) qp.push('model=' + encodeURIComponent(opts.model));
      return request('GET', '/api/market/list?' + qp.join('&'), null, true)
        .then(function (d) { return (d && d.items) || []; });
    },
    marketItem: function (id) {
      return request('GET', '/api/market/item?id=' + encodeURIComponent(id), null, true).then(it);
    },
    marketPublishSkin: function (opts) {
      opts = opts || {};
      return request('POST', '/api/market/publish', {
        kind: 'skin',
        title: opts.title || '',
        tags: Array.isArray(opts.tags) ? opts.tags : [],
        model: opts.model === 'slim' ? 'slim' : 'classic',
        png: opts.png || '',
        remixOf: opts.remixOf || ''
      }, true);
    },
    marketRate: function (id, stars) { return request('POST', '/api/market/rate', { id: id, stars: stars }, true).then(it); },
    marketComment: function (id, text, parentId) { return request('POST', '/api/market/comment', { id: id, text: text, parentId: parentId || '' }, true).then(it); },
    marketReport: function (id, reason) { return request('POST', '/api/market/report', { id: id, reason: reason || '' }, true).then(it); },
    marketUnreport: function (id) { return request('POST', '/api/market/unreport', { id: id }, true).then(it); },
    marketVouch: function (id) { return request('POST', '/api/market/vouch', { id: id }, true).then(it); },
    marketUnvouch: function (id) { return request('POST', '/api/market/unvouch', { id: id }, true).then(it); },
    marketDownload: function (id) { return request('POST', '/api/market/download', { id: id }, true).then(it); },
    marketDelete: function (id) { return request('POST', '/api/market/delete', { id: id }, true); },
    marketAdmin: function (id, action) {
      var path = action === 'ban' ? '/api/market/admin/ban' : '/api/market/admin/revoke';
      return request('POST', path, { id: id }, true).then(it);
    },

    // -------- Part II (§4.6): persistent worlds --------------------------
    // GET /api/worlds -> {worlds:[WorldView]}; unwrapped to the bare array
    // (same convention as marketListSkins/market.list above).
    worldsList: function () {
      return request('GET', '/api/worlds', null, true).then(function (d) { return (d && d.worlds) || []; });
    },
    // POST /api/worlds/create {name, seed?} -> WorldView (bare object — the
    // endpoint itself is not wrapped in an {item}/{world} envelope).
    worldsCreate: function (opts) {
      opts = opts || {};
      var body = { name: opts.name || '' };
      if (typeof opts.seed === 'number' && isFinite(opts.seed)) body.seed = opts.seed;
      return request('POST', '/api/worlds/create', body, true);
    },
    worldsRename: function (id, name) {
      return request('POST', '/api/worlds/rename', { id: id, name: name }, true);
    },
    // 409 while the world is currently hosted — surfaces as a rejected
    // promise (Error) same as any other non-2xx response; the caller reads
    // err.message for the "close the room first" text from the server.
    worldsDelete: function (id) {
      return request('POST', '/api/worlds/delete', { id: id }, true);
    },
    worldsMemberAdd: function (id, user) {
      return request('POST', '/api/worlds/members/add', { id: id, username: user }, true);
    },
    worldsMemberRemove: function (id, user) {
      return request('POST', '/api/worlds/members/remove', { id: id, username: user }, true);
    },
    // POST /api/worlds/import {name, seed, deltas:{"cx,cz":base64,…}} -> WorldView.
    // `payload` is passed straight through — pairs with world.exportLocalDeltas()
    // (js/vox/world.js), which already produces the deltas map in this shape.
    worldsImport: function (payload) {
      return request('POST', '/api/worlds/import', payload || {}, true);
    },

    // -------- Part II (§4.6): rooms (hosting) -----------------------------
    // GET /api/rooms is public with optional auth (so signed-in viewers also
    // see 'friends'-access rooms they're allowed into) — same "always attach
    // the token when we have one" convention as market.list/marketListSkins.
    roomsList: function () {
      return request('GET', '/api/rooms', null, true).then(function (d) { return (d && d.rooms) || []; });
    },
    // POST /api/rooms/open {worldId, access, pin?} -> {roomId}. On 409
    // ErrAlreadyHosted the rejected Error carries err.status===409 and
    // err.data === {error:"already hosted", host, roomId} (the existing
    // request() helper already attaches the full parsed body to err.data for
    // any non-2xx response — nothing extra needed here for the "join
    // instead?" UX to read host/roomId off the caught error).
    roomsOpen: function (opts) {
      opts = opts || {};
      var body = { worldId: opts.worldId, access: opts.access };
      if (opts.pin) body.pin = opts.pin;
      return request('POST', '/api/rooms/open', body, true);
    },
    roomsClose: function (roomId) {
      return request('POST', '/api/rooms/close', { roomId: roomId }, true);
    },

    // -------- Part II (§4.6): friends --------------------------------------
    friendsList: function () {
      return request('GET', '/api/friends', null, true).then(function (d) {
        return {
          friends: (d && d.friends) || [],
          incoming: (d && d.incoming) || [],
          outgoing: (d && d.outgoing) || []
        };
      });
    },
    friendsRequest: function (u) {
      return request('POST', '/api/friends/request', { username: u }, true);
    },
    friendsAccept: function (u) {
      return request('POST', '/api/friends/accept', { username: u }, true);
    },
    // Decline a pending incoming request OR unfriend an accepted one — same
    // endpoint handles both per the server contract.
    friendsRemove: function (u) {
      return request('POST', '/api/friends/remove', { username: u }, true);
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
