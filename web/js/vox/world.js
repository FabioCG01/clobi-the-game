// world.js — chunk storage + edit tracking + IndexedDB persistence.
//
// Single global: World.
//
//   World.create({seed, name:'default', gen, edits?}) -> world
//     world.getBlock(x,y,z) / world.setBlock(x,y,z,id)
//     world.getChunk(cx,cz) -> {blocks, cx, cz} | null
//     world.ensureChunk(cx,cz)              // synchronous generate-if-missing
//     world.chunksInRadius(cx,cz,r)         // generated chunks only (square r)
//     world.dirtyChunks() / world.clearDirty(cx,cz)
//     world.heightAt(x,z)                   // highest solid y from LIVE data
//     world.save() -> Promise               // edited chunks + meta -> IndexedDB
//     world.setMeta(obj) / world.getMeta()
//   World.load(name) -> Promise<{seed, meta, edits} | null>
//   World.wipe(name) -> Promise
//
// Persistence model: generation is deterministic, so only chunks the player
// actually EDITED are stored (whole 16×96×16 Uint8Array per edited chunk —
// dumb and bulletproof). IndexedDB db 'clobi3d' v1, object stores 'meta'
// (key = world name) and 'chunks' (key = 'name:cx,cz').
//
// Rehydrating a save: pass World.load()'s `edits` map into World.create as
// opts.edits (or call world.applyEdits(edits) afterwards — both work). Saved
// chunks then overlay the generator output as they stream in.
//
// Every IndexedDB op is promise-wrapped and fails SOFT (warn once, resolve) —
// private-browsing mode without IDB still gets a fully playable, unsaved game.
//
// Depends on: a WorldGen-created generator passed in via opts.gen (contract
// §5.4). Blocks is optional — heightAt uses it for solidity when present.
//
// ---- Part II (ARCHITECTURE-MP.md) additions: server-authoritative worlds ----
//
//   World.createRemote({seed, name, deltas}) -> world
//     Same shape as World.create()'s return value, but: NO IndexedDB (save()
//     is a no-op resolved promise), and `deltas` (the server's welcome payload
//     — {"cx,cz": base64 of packed 3-byte records}) is decoded and applied as
//     a chunk edit overlay at chunk-generation time (lazily, same as the local
//     applyEdits()/pendingEdits path — chunks not yet streamed in get their
//     overlay queued until they are).
//   world.setBlockSilent(x,y,z,id)
//     Identical to setBlock() (marks dirty for remeshing) but does NOT invoke
//     the onLocalEdit callback — used when applying a server-authoritative
//     'block' echo so it isn't re-sent to the server as if it were a fresh
//     local edit (no echo loop).
//   world.onLocalEdit(fn(x,y,z,id))
//     Registers a callback fired by the NORMAL setBlock() path (never by
//     setBlockSilent) whenever a block actually changed. Game hooks this in
//     multiplayer mode to forward local edits to Net.send('block', …).
//   world.exportLocalDeltas() -> Promise<{"cx,cz": base64}>
//     LOCAL (non-remote) world only. For every chunk this world instance has
//     ever edited: regenerate a pristine copy from the seed (via the same
//     `gen` this world already holds) and diff it against the live edited
//     chunk, producing minimal delta records in the §2 wire format (per
//     record: little-endian u16 blockIndex + u8 blockId, index =
//     (y*16+z)*16+x, ascending index order, later record for the same index
//     wins — here there is at most one per index since we diff once). Each
//     chunk's record blob is base64-encoded. Chunks with zero surviving diffs
//     (edited back to pristine) are omitted entirely. Resolves synchronously
//     via Promise.resolve (no IO — kept as a Promise so callers can always
//     `.then()` regardless of how the encoding ends up being done).

var World = (function () {

  // ---- world geometry (contract §3) ----
  var CHUNK = 16;
  var WORLD_H = 96;
  var CHUNK_VOL = CHUNK * WORLD_H * CHUNK;

  // ---- IndexedDB plumbing (shared by all worlds) ----
  var DB_NAME = 'clobi3d';
  var DB_VERSION = 1;
  var STORE_META = 'meta';
  var STORE_CHUNKS = 'chunks';

  var _dbPromise = null;
  var _warned = false;

  function warnOnce(err) {
    if (_warned) return;
    _warned = true;
    try {
      console.warn('[World] IndexedDB unavailable — the game runs fine but this world will not be saved.', err);
    } catch (e) { /* ignore */ }
  }

  // Resolves the open db, or null when IDB is missing/blocked (never rejects).
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve) {
      var req;
      try {
        if (!window.indexedDB) { warnOnce('no window.indexedDB'); resolve(null); return; }
        req = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        warnOnce(e); resolve(null); return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
        if (!db.objectStoreNames.contains(STORE_CHUNKS)) db.createObjectStore(STORE_CHUNKS);
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* ignore */ } };
        resolve(db);
      };
      req.onerror = function () { warnOnce(req.error); resolve(null); };
      req.onblocked = function () { warnOnce('open blocked'); resolve(null); };
    });
    return _dbPromise;
  }

  function chunkKeyRange(name) {
    // every key of the form 'name:...' — ':' sorts low, '￿' caps the range
    return IDBKeyRange.bound(name + ':', name + ':￿');
  }

  function key(cx, cz) { return cx + ',' + cz; }

  // Coerce whatever structured-clone gave back into a chunk-sized Uint8Array.
  function toChunkArray(v) {
    if (v instanceof ArrayBuffer) v = new Uint8Array(v);
    if (v && v.buffer instanceof ArrayBuffer && v.length === CHUNK_VOL) {
      return (v instanceof Uint8Array) ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    return null;
  }

  // Fallback solidity when Blocks isn't loaded: air/water/cross-plants pass.
  function isSolidId(id) {
    if (id === 0) return false;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var d = Blocks.byId(id);
      return !!(d && d.solid);
    }
    return !(id === 11 || id === 27 || id === 28 || id === 29);
  }

  // ================================================================
  // ---- world instance --------------------------------------------
  // ================================================================

  function create(opts) {
    opts = opts || {};
    var name = opts.name || 'default';
    var seed = (typeof opts.seed === 'number' && isFinite(opts.seed)) ? (opts.seed | 0) : 0;
    var gen = opts.gen || null;

    var chunks = new Map();       // 'cx,cz' -> {cx, cz, blocks, edited, unsaved, edits}
    var dirty = new Set();        // 'cx,cz' keys needing a remesh
    var pendingEdits = {};        // 'cx,cz' -> Uint8Array from a save, not yet streamed in
    var meta = {};                // player pos, mode, time, spawn, hotbar, …
    var remote = !!opts.remote;   // true for World.createRemote() worlds (no IDB persistence)
    var localEditListeners = [];  // fn(x,y,z,id) — fired by setBlock, never setBlockSilent

    function dirtyIf(cx, cz) {
      var k = key(cx, cz);
      if (chunks.has(k)) dirty.add(k);
    }

    // ---- chunk lifecycle ----
    function ensureChunk(cx, cz) {
      var k = key(cx, cz);
      var ch = chunks.get(k);
      if (ch) return ch;
      var blocks;
      var edited = false;
      var saved = pendingEdits[k];
      if (saved) {
        blocks = new Uint8Array(saved);        // copy; keep the loaded buffer pristine
        edited = true;                         // it exists in IDB ⇒ it was edited
        delete pendingEdits[k];
      } else if (gen && gen.generateChunk) {
        blocks = gen.generateChunk(cx, cz);
      } else {
        blocks = new Uint8Array(CHUNK_VOL);    // no generator: empty void chunk
      }
      ch = {
        cx: cx, cz: cz,
        blocks: blocks,
        edited: edited,     // has this chunk EVER diverged from the generator?
        unsaved: false,     // edited since the last successful save?
        edits: new Map()    // index -> id overlay (bookkeeping / debug)
      };
      applyRemoteDeltaChunk(ch, k);   // Part II: overlay server deltas as this chunk streams in
      chunks.set(k, ch);
      dirty.add(k);         // fresh chunks need their first mesh
      return ch;
    }

    function getChunk(cx, cz) {
      return chunks.get(key(cx, cz)) || null;
    }

    function chunksInRadius(cx, cz, r) {
      var out = [];
      for (var dz = -r; dz <= r; dz++) {
        for (var dx = -r; dx <= r; dx++) {
          var ch = chunks.get(key(cx + dx, cz + dz));
          if (ch) out.push(ch);
        }
      }
      return out;
    }

    // ---- block access ----
    function getBlock(x, y, z) {
      y = Math.floor(y);
      if (y < 0 || y >= WORLD_H) return 0;
      x = Math.floor(x); z = Math.floor(z);
      var ch = chunks.get(key(x >> 4, z >> 4));
      if (!ch) return 0;                       // ungenerated reads as air
      return ch.blocks[(y * CHUNK + (z & 15)) * CHUNK + (x & 15)];
    }

    // Shared core: writes the block, dirties chunks for remeshing. Returns
    // true if the block actually changed (false on a no-op write), so the two
    // public entry points (setBlock/setBlockSilent) can decide independently
    // whether to fire the local-edit callback.
    function writeBlock(x, y, z, id) {
      y = Math.floor(y);
      if (y < 0 || y >= WORLD_H) return false;
      x = Math.floor(x); z = Math.floor(z);
      id = id & 255;
      var cx = x >> 4, cz = z >> 4;
      var ch = ensureChunk(cx, cz);
      var lx = x & 15, lz = z & 15;
      var i = (y * CHUNK + lz) * CHUNK + lx;
      if (ch.blocks[i] === id) return false;   // no-op writes don't dirty anything
      ch.blocks[i] = id;
      ch.edits.set(i, id);
      ch.edited = true;
      ch.unsaved = true;
      dirty.add(key(cx, cz));
      // border edits change neighbour faces AND their vertex AO — remesh them
      // (diagonals too on corner edits, AO samples reach across corners).
      if (lx === 0) dirtyIf(cx - 1, cz); else if (lx === 15) dirtyIf(cx + 1, cz);
      if (lz === 0) dirtyIf(cx, cz - 1); else if (lz === 15) dirtyIf(cx, cz + 1);
      if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15)) {
        dirtyIf(cx + (lx === 0 ? -1 : 1), cz + (lz === 0 ? -1 : 1));
      }
      return true;
    }

    function fireLocalEdit(x, y, z, id) {
      for (var i = 0; i < localEditListeners.length; i++) {
        try { localEditListeners[i](x, y, z, id); } catch (e) { /* listener errors stay theirs */ }
      }
    }

    function setBlock(x, y, z, id) {
      if (writeBlock(x, y, z, id)) fireLocalEdit(Math.floor(x), Math.floor(y), Math.floor(z), id & 255);
    }

    // Part II (§4.5): identical to setBlock (dirties for remesh) but never
    // fires the local-edit callback — used for server-authoritative 'block'
    // events so they don't loop back to Net.send as if freshly edited here.
    function setBlockSilent(x, y, z, id) {
      writeBlock(x, y, z, id);
    }

    function onLocalEdit(fn) {
      if (typeof fn === 'function') localEditListeners.push(fn);
      return function () {
        var i = localEditListeners.indexOf(fn);
        if (i >= 0) localEditListeners.splice(i, 1);
      };
    }

    // ---- dirty bookkeeping (consumed by Game's mesh scheduler) ----
    function dirtyChunks() {
      var out = [];
      dirty.forEach(function (k) {
        var p = k.split(',');
        out.push([+p[0], +p[1]]);
      });
      return out;
    }

    function clearDirty(cx, cz) {
      dirty.delete(key(cx, cz));
    }

    // ---- queries ----
    function heightAt(x, z) {
      x = Math.floor(x); z = Math.floor(z);
      var ch = ensureChunk(x >> 4, z >> 4);    // live data, generating if needed
      var lx = x & 15, lz = z & 15;
      for (var y = WORLD_H - 1; y >= 0; y--) {
        if (isSolidId(ch.blocks[(y * CHUNK + lz) * CHUNK + lx])) return y;
      }
      return 0;
    }

    // ---- meta ----
    function setMeta(obj) {
      if (obj && typeof obj === 'object') {
        for (var k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k)) meta[k] = obj[k];
        }
      }
    }
    function getMeta() { return meta; }

    // ---- saved-edit overlay (from World.load) ----
    function applyEdits(edits) {
      if (!edits || typeof edits !== 'object') return;
      Object.keys(edits).forEach(function (k) {
        var arr = toChunkArray(edits[k]);
        if (!arr) return;
        var ch = chunks.get(k);
        if (ch) {
          ch.blocks.set(arr);                  // already streamed in: swap live
          ch.edited = true;
          ch.unsaved = false;                  // this exact state IS the save
          ch.edits.clear();
          dirty.add(k);
        } else {
          pendingEdits[k] = arr;               // overlay when it streams in
        }
      });
    }
    applyEdits(opts.edits);                    // create-time hydration path
    primeRemoteDeltas(opts.deltas);            // Part II: create-time server-delta hydration

    // ---- Part II: server-delta overlay (packed 3-byte records, base64) ----
    // Decodes ONE chunk's base64 blob (contract §2: little-endian u16
    // blockIndex + u8 blockId per 3-byte record) and applies it over whatever
    // is currently in that chunk slot (freshly generated from the seed, since
    // remote worlds never IndexedDB-hydrate). Queues into pendingEdits (same
    // mechanism as the local applyEdits path) when the chunk hasn't streamed
    // in yet — ensureChunk() below drains it at generation time.
    function decodeDeltaRecords(b64) {
      var bin;
      try { bin = window.atob(b64); } catch (e) { return null; }
      var n = bin.length;
      if (n < 3) return (n === 0) ? new Map() : null;
      var recs = new Map();
      for (var off = 0; off + 3 <= n; off += 3) {
        var idx = bin.charCodeAt(off) | (bin.charCodeAt(off + 1) << 8);
        var id = bin.charCodeAt(off + 2) & 255;
        if (idx >= 0 && idx < CHUNK_VOL) recs.set(idx, id);
      }
      return recs;
    }

    // remoteDeltas: 'cx,cz' -> Map(index -> blockId), pre-decoded once at
    // createRemote time so per-chunk generation only does array writes.
    var remoteDeltas = null;
    function primeRemoteDeltas(deltasB64) {
      remoteDeltas = new Map();
      if (!deltasB64 || typeof deltasB64 !== 'object') return;
      Object.keys(deltasB64).forEach(function (k) {
        var recs = decodeDeltaRecords(deltasB64[k] || '');
        if (recs) remoteDeltas.set(k, recs);
      });
    }
    function applyRemoteDeltaChunk(ch, k) {
      if (!remoteDeltas) return;
      var recs = remoteDeltas.get(k);
      if (!recs) return;
      recs.forEach(function (id, idx) { ch.blocks[idx] = id; });
      ch.edited = true;
      ch.unsaved = false;   // server state IS the save; nothing to write back locally
      remoteDeltas.delete(k);
    }

    // Encode a plain byte array/Uint8Array to base64 (inverse of the atob-based
    // decodeDeltaRecords above — this is binary bytes, not text, so we build
    // the input string one char code per byte before calling btoa).
    function bytesToBase64(bytes) {
      var bin = '';
      var CHUNK_SZ = 0x8000; // avoid call-stack limits on String.fromCharCode(...arr) for big arrays
      for (var i = 0; i < bytes.length; i += CHUNK_SZ) {
        bin += String.fromCharCode.apply(null, bytes.subarray ? bytes.subarray(i, i + CHUNK_SZ) : bytes.slice(i, i + CHUNK_SZ));
      }
      return window.btoa(bin);
    }

    // Part II (§4.5, §2): LOCAL world only. For every chunk this instance ever
    // edited, regenerate a pristine chunk fresh from the seed and diff it
    // against the live edited chunk to produce the minimal delta record set,
    // per the shared wire format (u16 blockIndex + u8 blockId, little-endian,
    // ascending index, base64 per chunk). Chunks whose edits net out to zero
    // difference from pristine are omitted. Used by "Upload to server" ->
    // Store.worldsImport(). No IO is involved, but this stays a Promise so
    // callers can always `.then()` it uniformly.
    function exportLocalDeltas() {
      var out = {};
      if (!gen || !gen.generateChunk) return Promise.resolve(out);
      // Materialize every not-yet-streamed-in edited chunk from pendingEdits
      // first: exportLocalDeltas() is typically called right after hydrating
      // a fresh World.create({seed, gen, edits}) purely to upload it (nothing
      // has actually streamed in yet — every edited chunk still sits in
      // pendingEdits until ensureChunk() is called for that key), so without
      // this the diff below would see an empty `chunks` Map and silently
      // export {}. Safe to call on a live, partially-streamed world too —
      // ensureChunk() is a no-op for keys already in `chunks`.
      Object.keys(pendingEdits).forEach(function (k) {
        var parts = k.split(',');
        ensureChunk(parts[0] | 0, parts[1] | 0);
      });
      chunks.forEach(function (ch) {
        if (!ch.edited) return;
        var pristine = gen.generateChunk(ch.cx, ch.cz);
        var live = ch.blocks;
        // First pass: count differing indices so we can size the byte buffer
        // exactly (records must be exactly 3 bytes each, no padding).
        var diffCount = 0;
        var i;
        for (i = 0; i < CHUNK_VOL; i++) if (pristine[i] !== live[i]) diffCount++;
        if (diffCount === 0) return;   // edited back to pristine — nothing to store
        var buf = new Uint8Array(diffCount * 3);
        var w = 0;
        for (i = 0; i < CHUNK_VOL; i++) {
          if (pristine[i] === live[i]) continue;
          buf[w] = i & 255;
          buf[w + 1] = (i >> 8) & 255;
          buf[w + 2] = live[i] & 255;
          w += 3;
        }
        out[key(ch.cx, ch.cz)] = bytesToBase64(buf);
      });
      return Promise.resolve(out);
    }

    // ---- persistence ----
    // Writes meta every time (player pos/time move constantly, it's tiny) and
    // only the chunks edited since the last save. Soft-fails to a resolved
    // promise so autosave loops never explode in private browsing.
    // Remote (server-hosted) worlds never touch IndexedDB — Game disables
    // autosave in multiplayer, but this no-op keeps save() safe to call
    // unconditionally from any code path that doesn't know the world's kind.
    function save() {
      if (remote) return Promise.resolve();
      return openDB().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          var tx;
          try {
            tx = db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
          } catch (e) {
            warnOnce(e); resolve(null); return;
          }
          try {
            tx.objectStore(STORE_META).put(
              { seed: seed, meta: meta, savedAt: Date.now() }, name);
            var written = [];
            var chunkStore = tx.objectStore(STORE_CHUNKS);
            chunks.forEach(function (ch) {
              if (ch.edited && ch.unsaved) {
                chunkStore.put(ch.blocks, name + ':' + key(ch.cx, ch.cz));
                written.push(ch);
              }
            });
            tx.oncomplete = function () {
              for (var i = 0; i < written.length; i++) written[i].unsaved = false;
              resolve(null);
            };
            tx.onerror = tx.onabort = function () { warnOnce(tx.error); resolve(null); };
          } catch (e2) {
            warnOnce(e2); resolve(null);
          }
        });
      });
    }

    return {
      // identity (handy for /seed, debug HUD, Game.regen)
      name: name,
      seed: seed,
      gen: gen,

      // contract §5.5 API
      getBlock: getBlock,
      setBlock: setBlock,
      getChunk: getChunk,
      ensureChunk: ensureChunk,
      chunksInRadius: chunksInRadius,
      dirtyChunks: dirtyChunks,
      clearDirty: clearDirty,
      heightAt: heightAt,
      save: save,
      setMeta: setMeta,
      getMeta: getMeta,

      // extras
      applyEdits: applyEdits,

      // Part II (contract §4.5) additions
      isRemote: remote,
      setBlockSilent: setBlockSilent,
      onLocalEdit: onLocalEdit,
      exportLocalDeltas: exportLocalDeltas
    };
  }

  // ================================================================
  // ---- static: createRemote (Part II, contract §4.5) --------------
  // ================================================================

  // Server-authoritative world: same shape/behavior as create(), except
  // persistence (save()) is a no-op and `deltas` (the server's welcome
  // payload — {"cx,cz": base64 packed 3-byte records, per §2}) is applied
  // as chunks stream in instead of IndexedDB edit snapshots. Per contract
  // §4.5 the generator is built HERE from `seed` (WorldGen.create) — callers
  // (Game.startMultiplayer) just pass {seed, name, deltas}, exactly the
  // client's own deterministic terrain generator used offline.
  function createRemote(opts) {
    opts = opts || {};
    var seed = (typeof opts.seed === 'number' && isFinite(opts.seed)) ? (opts.seed | 0) : 0;
    var gen = (typeof WorldGen !== 'undefined' && WorldGen.create) ? WorldGen.create(seed) : null;
    return create({
      seed: seed,
      name: opts.name || 'remote',
      gen: gen,
      deltas: opts.deltas,
      remote: true
    });
  }

  // ================================================================
  // ---- static: load / wipe ---------------------------------------
  // ================================================================

  // Read a saved world. Resolves {seed, meta, edits} (edits: 'cx,cz' ->
  // Uint8Array full-chunk snapshots) or null when nothing was ever saved
  // (or IDB is unavailable). Never rejects.
  function load(name) {
    name = name || 'default';
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var tx;
        try {
          tx = db.transaction([STORE_META, STORE_CHUNKS], 'readonly');
        } catch (e) {
          warnOnce(e); resolve(null); return;
        }
        var rec = null;
        var edits = {};
        try {
          var metaReq = tx.objectStore(STORE_META).get(name);
          metaReq.onsuccess = function () { rec = metaReq.result || null; };
          var curReq = tx.objectStore(STORE_CHUNKS).openCursor(chunkKeyRange(name));
          curReq.onsuccess = function () {
            var cursor = curReq.result;
            if (!cursor) return;
            var arr = toChunkArray(cursor.value);
            if (arr) edits[String(cursor.key).slice(name.length + 1)] = arr;
            cursor.continue();
          };
          tx.oncomplete = function () {
            if (!rec) { resolve(null); return; }
            resolve({ seed: rec.seed | 0, meta: rec.meta || {}, edits: edits });
          };
          tx.onerror = tx.onabort = function () { warnOnce(tx.error); resolve(null); };
        } catch (e2) {
          warnOnce(e2); resolve(null);
        }
      });
    });
  }

  // Delete a saved world (meta + every stored chunk). Never rejects.
  function wipe(name) {
    name = name || 'default';
    return openDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var tx;
        try {
          tx = db.transaction([STORE_META, STORE_CHUNKS], 'readwrite');
        } catch (e) {
          warnOnce(e); resolve(null); return;
        }
        try {
          tx.objectStore(STORE_META).delete(name);
          tx.objectStore(STORE_CHUNKS).delete(chunkKeyRange(name));
          tx.oncomplete = function () { resolve(null); };
          tx.onerror = tx.onabort = function () { warnOnce(tx.error); resolve(null); };
        } catch (e2) {
          warnOnce(e2); resolve(null);
        }
      });
    });
  }

  // ---- public API ----
  return {
    create: create,
    load: load,
    wipe: wipe,
    // Part II (contract §4.5)
    createRemote: createRemote
  };
})();

window.World = World;
