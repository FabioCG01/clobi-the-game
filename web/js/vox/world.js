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
//
// ---- Part III (ARCHITECTURE-COMBAT.md §13a) additions: water flow ----
//
//   world.queueLiquidTick(x,y,z)
//     Enqueues a liquid cell (water or flowing_water) for the next tick pass.
//     Called automatically by setBlock/setBlockSilent whenever a water/
//     flowing_water block is placed/broken/exposed by a neighbour edit (same
//     spot that already dirties neighbour chunks for remeshing on border
//     writes) — callers normally never need to invoke this directly, but it
//     is exposed publicly in case a future feature (buckets, etc.) needs to
//     kick off a flow pass explicitly after a silent/bulk edit.
//   world.processLiquidTicks(maxCount)
//     Drains up to `maxCount` queued liquid cells, budgeted like the existing
//     chunk-streaming budget (Game calls this once per frame with a small
//     budget, e.g. 64). Each tick: falls straight down if the cell below is
//     replaceable, else spreads to up to 4 orthogonal replaceable neighbours
//     capped at ~4 cells from the nearest source. Distance-from-source is
//     tracked in an in-memory-only Map (never persisted — on world load,
//     flowing_water cells simply re-settle from a fresh tick pass, an
//     accepted v1 simplification). Breaking a water SOURCE queues a recede
//     pass (flood-fill-from-remaining-sources) that converts now-unreachable
//     flowing_water back to air after a short delay.
//
//   NOTE (integration): `flowing_water` is block id 62, added by this file
//   as a hardcoded constant because `blocks.js` (owned by a sibling agent in
//   this build wave) exposes NO public registration hook (no add()/register()
//   extension point — its `add()` is a private closure fn, verified by
//   reading the file directly) to add a new block id from outside its own
//   IIFE. Id 62 is the next free id after the contract §3 table's top (id 61
//   = quartz_block). This world.js module treats id 62 as a liquid exactly
//   like id 11 (water) for its own bookkeeping; a human/future integration
//   pass must add id 62 = flowing_water directly into blocks.js's own table
//   with props {liquid:true, translucent:true, solid:false, opaque:false,
//   hardness:Infinity, placeable:false, drops:0, tiles: same as water but a
//   touch more turbulent} — see this build's reported deviations for the
//   exact spec. Until that lands, isWaterLikeId()/isReplaceableId() below
//   degrade gracefully (id 62 is recognized as liquid via this file's own
//   hardcoded check even before Blocks knows about it, so the simulation
//   logic here is fully correct and ready the moment the id is registered —
//   note that until blocks.js registers id 62, Blocks.byId(62) returns
//   undefined so the MESHER will not yet render it with water's translucent
//   liquid material; the block will still simulate correctly and, once
//   Blocks registers it, will immediately render correctly with no further
//   code changes needed here).

var World = (function () {

  // ---- world geometry (contract §3) ----
  var CHUNK = 16;
  var WORLD_H = 96;
  var CHUNK_VOL = CHUNK * WORLD_H * CHUNK;

  // ---- Part III §13(a) liquid flow constants ----
  var WATER_ID = 11;           // full-strength source water (Part I, unchanged)
  var FLOWING_WATER_ID = 62;   // ASSUMED id — see the big note above this IIFE
  var LIQUID_TICKS_PER_SEC = 6;         // within the contract's 4-8 tick/sec band
  var LIQUID_TICK_INTERVAL_MS = 1000 / LIQUID_TICKS_PER_SEC;
  var MAX_SPREAD_DIST = 4;              // cells from nearest source, per contract
  var RECEDE_DELAY_MS = 600;            // "short delay" before an unreachable cell dries up

  function isWaterLikeId(id) { return id === WATER_ID || id === FLOWING_WATER_ID; }
  function isSourceId(id) { return id === WATER_ID; }

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
    return !(id === 11 || id === FLOWING_WATER_ID || id === 27 || id === 28 || id === 29);
  }

  // A cell a liquid can fall/spread into: air, or a non-solid, non-liquid
  // "soft" block (cross-plants — matches Minecraft's own convention of water
  // silently displacing tallgrass/flowers). Never displaces another liquid
  // (that cell is already handled/queued on its own) or anything solid.
  function isReplaceableId(id) {
    if (id === 0) return true;
    if (isWaterLikeId(id)) return false;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var d = Blocks.byId(id);
      if (!d) return false;
      return !d.solid && !d.liquid;
    }
    return (id === 27 || id === 28 || id === 29); // fallback: flowers/tallgrass
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

    // ---- Part III §13(a): liquid tick queue (in-memory only, never saved) ----
    var liquidQueue = new Map();      // 'x,y,z' -> [x,y,z] — pending tick cells, dedup by key
    var liquidDist = new Map();       // 'x,y,z' -> integer distance-from-source (0 = source)
    var recedeQueue = [];             // [{x,y,z,at}] cells to re-check for recede after a delay
    var lastLiquidTickAt = 0;         // performance.now() of the last drained batch (rate gate)

    function lk(x, y, z) { return x + ',' + y + ',' + z; }

    function queueLiquidTick(x, y, z) {
      x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
      if (y < 0 || y >= WORLD_H) return;
      var k = lk(x, y, z);
      if (!liquidQueue.has(k)) liquidQueue.set(k, [x, y, z]);
    }

    // Queues every orthogonal neighbour of (x,y,z) that is itself a liquid —
    // mirrors the same "a border edit affects its neighbour" reasoning the
    // existing writeBlock() already applies to chunk remeshing, just applied
    // to the liquid simulation instead of the mesh.
    function queueLiquidNeighbors(x, y, z) {
      var offs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (var i = 0; i < offs.length; i++) {
        var nx = x + offs[i][0], ny = y + offs[i][1], nz = z + offs[i][2];
        if (isWaterLikeId(getBlock(nx, ny, nz))) queueLiquidTick(nx, ny, nz);
      }
    }

    // Called from writeBlock() for EVERY edit (place or break), liquid or
    // not — a placed/broken solid can expose or wall off a neighbouring
    // liquid just as easily as editing the liquid cell itself.
    function onLiquidRelevantEdit(x, y, z, id, prevId) {
      if (isWaterLikeId(id)) queueLiquidTick(x, y, z);
      // A source (water) block was just removed: kick a recede pass so any
      // flowing_water that traced its supply back to this source dries up
      // if nothing else can reach it. A non-source removal (flowing_water
      // itself, or a plain solid uncovering a liquid) is handled by the
      // ordinary neighbour-queue below — recede only needs to special-case
      // "a SOURCE disappeared".
      if (isSourceId(prevId) && !isSourceId(id)) scheduleRecedeCheck(x, y, z);
      queueLiquidNeighbors(x, y, z);
    }

    function scheduleRecedeCheck(x, y, z) {
      var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      recedeQueue.push({ x: x, y: y, z: z, at: now + RECEDE_DELAY_MS });
    }

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
      var prevId = ch.blocks[i];
      if (prevId === id) return false;   // no-op writes don't dirty anything
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
      // Part III §13(a): a water/flowing_water block placed/broken, or a
      // solid placed/broken next to one, needs a liquid-tick pass — mirrors
      // the neighbour-remesh reasoning just above, applied to flow instead.
      onLiquidRelevantEdit(x, y, z, id, prevId);
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

    // ================================================================
    // ---- Part III §13(a): liquid tick processing -------------------
    // ================================================================
    //
    // A "tick" for one queued cell:
    //   1. If the cell no longer holds water/flowing_water (something else
    //      overwrote it since it was queued), drop it — nothing to do.
    //   2. If the cell below is replaceable, the liquid FALLS: the cell
    //      below becomes flowing_water (distance = this cell's distance,
    //      falling doesn't cost distance budget, matching Minecraft's own
    //      "falling water resets lateral distance" convention) and its
    //      neighbours+below are queued for the next pass.
    //   3. Otherwise it SPREADS horizontally: each of up to 4 orthogonal
    //      neighbours that is replaceable AND within MAX_SPREAD_DIST of the
    //      nearest source becomes flowing_water at distance+1, and is itself
    //      queued to keep propagating (until it hits the distance cap).
    // Sources (id 11) are never overwritten/consumed by this process — only
    // flowing_water cells are converted to air during recede.

    function nearestSourceDistance(x, y, z) {
      // A source cell IS distance 0. Any queued cell already carries a
      // tracked distance in liquidDist (sources are seeded there at 0 when
      // first queued — see below); fall back to a full-cap distance for a
      // cell we've never seen (conservative: treat as far from any source
      // rather than assume it's fed, so a stray cell won't over-spread).
      var id = getBlock(x, y, z);
      if (isSourceId(id)) return 0;
      var d = liquidDist.get(lk(x, y, z));
      return (d === undefined) ? MAX_SPREAD_DIST : d;
    }

    function tickOneCell(x, y, z) {
      var id = getBlock(x, y, z);
      if (!isWaterLikeId(id)) { liquidDist.delete(lk(x, y, z)); return; }

      var myDist = nearestSourceDistance(x, y, z);
      if (isSourceId(id)) myDist = 0;
      liquidDist.set(lk(x, y, z), myDist);

      // -- 1. fall --
      var belowId = getBlock(x, y - 1, z);
      if (y > 0 && isReplaceableId(belowId)) {
        writeBlock(x, y - 1, z, FLOWING_WATER_ID);
        liquidDist.set(lk(x, y - 1, z), myDist);   // falling doesn't cost distance
        queueLiquidTick(x, y - 1, z);
        queueLiquidNeighbors(x, y - 1, z);
        return; // matches the contract: falls INSTEAD of spreading this tick
      }

      // -- 2. spread --
      if (myDist >= MAX_SPREAD_DIST) return;       // at the cap, propagate no further
      var offs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      for (var i = 0; i < offs.length; i++) {
        var nx = x + offs[i][0], nz = z + offs[i][2];
        var nid = getBlock(nx, y, nz);
        if (!isReplaceableId(nid)) continue;
        var nDist = myDist + 1;
        var existing = liquidDist.get(lk(nx, y, nz));
        if (existing !== undefined && existing <= nDist) continue; // already as-fed or better
        writeBlock(nx, y, nz, FLOWING_WATER_ID);
        liquidDist.set(lk(nx, y, nz), nDist);
        queueLiquidTick(nx, y, nz);
      }
    }

    // Flood-fill outward from every remaining source, marking every
    // flowing_water cell reachable within MAX_SPREAD_DIST steps as "fed".
    // Anything NOT marked (any flowing_water left over) has lost its supply
    // and dries back to air. Bounded to a modest region around the checked
    // cell so a recede check never has to walk the whole world — liquid
    // simply doesn't spread further than MAX_SPREAD_DIST anyway, so a search
    // radius a little beyond that fully covers every cell that could still
    // be fed from a source near the break point.
    function recedeCheck(cx0, cy0, cz0) {
      var R = MAX_SPREAD_DIST + 2;
      var fed = new Set();
      var frontier = [];
      // Seed the BFS from every source found in the search box (a source
      // just outside the box but within MAX_SPREAD_DIST of a flowing cell
      // inside it is vanishingly rare for this v1's cheap approximation —
      // the contract explicitly accepts non-frame-perfect recede).
      for (var dy = -R; dy <= R; dy++) {
        for (var dz = -R; dz <= R; dz++) {
          for (var dx = -R; dx <= R; dx++) {
            var x = cx0 + dx, y = cy0 + dy, z = cz0 + dz;
            if (y < 0 || y >= WORLD_H) continue;
            if (isSourceId(getBlock(x, y, z))) {
              var k0 = lk(x, y, z);
              if (!fed.has(k0)) { fed.add(k0); frontier.push([x, y, z, 0]); }
            }
          }
        }
      }
      var head = 0;
      while (head < frontier.length) {
        var cur = frontier[head++];
        if (cur[3] >= MAX_SPREAD_DIST) continue;
        var nbrs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        for (var i = 0; i < nbrs.length; i++) {
          var nx = cur[0] + nbrs[i][0], ny = cur[1] + nbrs[i][1], nz = cur[2] + nbrs[i][2];
          if (ny < 0 || ny >= WORLD_H) continue;
          if (Math.abs(nx - cx0) > R || Math.abs(ny - cy0) > R || Math.abs(nz - cz0) > R) continue;
          var nid = getBlock(nx, ny, nz);
          if (!isWaterLikeId(nid)) continue;
          var nk = lk(nx, ny, nz);
          if (fed.has(nk)) continue;
          fed.add(nk);
          frontier.push([nx, ny, nz, isSourceId(nid) ? 0 : cur[3] + 1]);
        }
      }
      // Anything flowing_water within the box that BFS never reached is
      // unfed -> dries to air (and its own neighbours get queued, so a
      // longer disconnected run of flowing_water dries up over a couple of
      // recede passes rather than requiring one pass to reach arbitrarily
      // far — consistent with the contract's "doesn't need to be frame-
      // perfect" allowance).
      for (dy = -R; dy <= R; dy++) {
        for (dz = -R; dz <= R; dz++) {
          for (dx = -R; dx <= R; dx++) {
            var xx = cx0 + dx, yy = cy0 + dy, zz = cz0 + dz;
            if (yy < 0 || yy >= WORLD_H) continue;
            var id2 = getBlock(xx, yy, zz);
            if (id2 !== FLOWING_WATER_ID) continue;
            if (fed.has(lk(xx, yy, zz))) continue;
            writeBlock(xx, yy, zz, 0);
            liquidDist.delete(lk(xx, yy, zz));
            queueLiquidNeighbors(xx, yy, zz);
          }
        }
      }
    }

    // Public: drains up to maxCount queued cells, rate-gated to
    // LIQUID_TICKS_PER_SEC so it never runs more often than the contract's
    // 4-8 ticks/sec band even if called every frame. Also drains any due
    // recede checks (they're cheap and rare — no separate budget needed).
    function processLiquidTicks(maxCount) {
      var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now - lastLiquidTickAt < LIQUID_TICK_INTERVAL_MS) return;
      lastLiquidTickAt = now;

      var n = (typeof maxCount === 'number' && maxCount > 0) ? maxCount : 64;
      var processed = 0;
      if (liquidQueue.size > 0) {
        var it = liquidQueue.keys();
        var res;
        while (processed < n && (res = it.next()) && !res.done) {
          var k = res.value;
          var cell = liquidQueue.get(k);
          liquidQueue.delete(k);
          tickOneCell(cell[0], cell[1], cell[2]);
          processed++;
        }
      }

      if (recedeQueue.length > 0) {
        var kept = [];
        for (var i = 0; i < recedeQueue.length; i++) {
          var r = recedeQueue[i];
          if (r.at <= now) recedeCheck(r.x, r.y, r.z);
          else kept.push(r);
        }
        recedeQueue = kept;
      }
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
      exportLocalDeltas: exportLocalDeltas,

      // Part III (contract §13a) additions: water flow simulation
      queueLiquidTick: queueLiquidTick,
      processLiquidTicks: processLiquidTicks
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
    createRemote: createRemote,
    // Part III (contract §13a) — the assumed flowing_water block id (see the
    // big integration note near the top of this file); exposed so any other
    // module that needs to recognize "water-like" ids (e.g. a future bucket
    // item) doesn't have to hardcode 62 a second time.
    FLOWING_WATER_ID: FLOWING_WATER_ID
  };
})();

window.World = World;
