// sound.js — global Sound. File-based audio engine for CLOBI CRAFT.
//
// Every sound is a plain MP3 under web/assets/audio/ — replace any file with
// your own (same path, same name) and it goes live on the next page load; no
// code changes needed. The current files are silent placeholders.
//
// ============================= AUDIO FILE MAP =============================
// assets/audio/
//   music/menu.mp3            menu + all non-game screens (loops)
//   music/game_day_1.mp3      gameplay, daytime pool  (rotates, crossfades)
//   music/game_day_2.mp3
//   music/game_night_1.mp3    gameplay, nighttime pool
//   music/game_night_2.mp3
//   ui/click.mp3              every UI button click
//   sfx/hurt.mp3              you take damage
//   sfx/death.mp3             you die
//   sfx/hit.mp3               you land a hit on a mob/player
//   sfx/drop.mp3              you toss an item (Q)
//   sfx/pickup.mp3            you collect a drop
//   steps/<surface>_<1..4>.mp3        footsteps, 4 variants per surface:
//     surfaces: grass dirt stone wood sand gravel snow cloth water
//     (water = swim strokes while moving in water)
//   blocks/<cat>_break_<1..3>.mp3     block finishes breaking, 3 variants
//   blocks/<cat>_place_<1..2>.mp3     block placed, 2 variants
//   blocks/<cat>_hit_1.mp3            mining tick while holding break
//     categories: stone wood dirt grass sand gravel glass cloth snow
// ==========================================================================
//
// Music behaviour:
//   - Sound.music('menu') / Sound.music('game') / Sound.music(null).
//     Idempotent: re-asking for the kind already playing is a no-op (fixes
//     the old bug where every return to the menu RESTARTED the menu track).
//   - 'game' picks a random track from the day or night pool based on the
//     world time fed in via Sound.setTimeOfDay(frac); when day flips to
//     night (or back) mid-game the music CROSSFADES (~3s) to the other pool.
//   - Multi-track pools rotate: when a track ends the next one in the pool
//     starts. Pausing the game does NOT touch music (contract: pause keeps
//     the current music playing).
//
// SFX behaviour:
//   - WebAudio-decoded buffers, lazily fetched on first use, cached forever.
//   - Variant pools (steps/breaks) pick randomly but never repeat the last
//     variant twice in a row.
//   - UNKNOWN names are silently ignored (the old engine beeped 440 Hz at
//     every unknown name — that was the "wrong audio plays" bug: the 3D
//     game's 'dig'/'place'/'hurt'/'death'/'drop' names all fell through to
//     the same beep).
//
// Pinned API (kept from the old engine, all still work):
//   Sound.init(); Sound.play(name); Sound.music(kind|null); Sound.unlock();
//   Sound.setMuted(b); Sound.isMuted(); Sound.toggleMute(); Sound.onMuteChange(fn)
// New API:
//   Sound.step(blockIdOrSurface)      footstep for the surface stood on
//   Sound.block('break'|'place'|'hit', blockId)   dig sounds by category
//   Sound.setTimeOfDay(frac)          0..1 of the 24000-tick day; drives the
//                                     day/night music pool crossfade
//
// Exposes exactly one global: window.Sound.
// Depends on: Blocks (optional, guarded — maps block ids to sound categories).

var Sound = (function () {
  'use strict';

  var BASE = 'assets/audio/';
  var MUTE_KEY = 'clobi.muted';

  var VOL_MASTER = 0.55;
  var VOL_MUSIC = 0.50;      // × master
  var VOL_UI = 0.9, VOL_SFX = 0.9, VOL_STEP = 0.32, VOL_BREAK = 0.75,
      VOL_PLACE = 0.55, VOL_MINE_HIT = 0.28;
  var CROSSFADE_MS = 3000;   // music transition (day<->night, menu<->game)
  var NIGHT_START = 13000 / 24000, NIGHT_END = 23000 / 24000; // MC daylight math

  // ---- file tables ---------------------------------------------------------
  var STEP_VARIANTS = 4, BREAK_VARIANTS = 3, PLACE_VARIANTS = 2;
  var SURFACES = ['grass', 'dirt', 'stone', 'wood', 'sand', 'gravel', 'snow', 'cloth', 'water'];
  var BLOCK_CATS = ['stone', 'wood', 'dirt', 'grass', 'sand', 'gravel', 'glass', 'cloth', 'snow'];

  var SFX_FILES = {
    click: 'ui/click.mp3',
    hurt: 'sfx/hurt.mp3',
    death: 'sfx/death.mp3',
    hit: 'sfx/hit.mp3',
    drop: 'sfx/drop.mp3',
    pickup: 'sfx/pickup.mp3'
  };

  var MUSIC_POOLS = {
    menu: ['music/menu.mp3'],
    game_day: ['music/game_day_1.mp3', 'music/game_day_2.mp3'],
    game_night: ['music/game_night_1.mp3', 'music/game_night_2.mp3']
  };

  // ---- block id -> sound category -------------------------------------------
  // Keyed off Blocks.byId(id).key. Explicit names first, then substring rules.
  // Anything unmatched (ores, brick, obsidian, terracotta, quartz, basalt,
  // granite/diorite/andesite, end_stone, tux_block, lozenge…) defaults to
  // 'stone' — the safe pick for the registry's hard decorative blocks.
  var CAT_EXACT = {
    grass: 'grass', snow_grass: 'snow', dirt: 'dirt', clay: 'dirt',
    sand: 'sand', gravel: 'gravel', log: 'wood', planks: 'wood',
    bookshelf: 'wood', melon: 'wood', pumpkin: 'wood', cactus: 'cloth',
    leaves: 'grass', tallgrass: 'grass', vine: 'grass',
    glass: 'glass', glowstone: 'glass', ice: 'glass', packed_ice: 'glass'
  };

  function catForKey(key) {
    if (!key) return 'stone';
    if (CAT_EXACT[key]) return CAT_EXACT[key];
    if (key.indexOf('wool') === 0) return 'cloth';
    if (key.indexOf('flower') === 0 || key.indexOf('mushroom') === 0) return 'grass';
    if (key.indexOf('water') !== -1) return null;   // liquids: no dig sound
    return 'stone';
  }

  function catForBlock(idOrSurface) {
    if (typeof idOrSurface === 'string') {
      return SURFACES.indexOf(idOrSurface) !== -1 || BLOCK_CATS.indexOf(idOrSurface) !== -1
        ? idOrSurface : 'stone';
    }
    var id = idOrSurface | 0;
    if (!id) return 'stone';
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      var def = Blocks.byId(id);
      return catForKey(def && def.key);
    }
    return 'stone';
  }

  // ---- module state ----------------------------------------------------------
  var ctx = null, master = null;
  var muted = false;
  var buffers = {};       // path -> AudioBuffer | 'loading' | 'failed'
  var lastVariant = {};   // pool key -> last index (no immediate repeats)
  var listeners = [];
  var inited = false;

  // music: two <audio> channels crossfaded into each other
  var musA = null, musB = null;      // HTMLAudio elements
  var musActive = null;              // the element currently fading IN / playing
  var curKind = null;                // 'menu' | 'game' | null
  var curPool = null;                // resolved pool name ('menu'|'game_day'|'game_night')
  var poolIdx = 0;
  var fadeTimer = 0;
  var isNight = false;
  var pendingMusic = false;          // .play() rejected pre-gesture; retry on unlock

  // ---- WebAudio core ---------------------------------------------------------
  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOL_MASTER;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  function unlock() {
    ensureCtx();
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ok */ } }
    if (pendingMusic && musActive) {
      pendingMusic = false;
      try { musActive.play().catch(function () { pendingMusic = true; }); }
      catch (e) { pendingMusic = true; }
    }
  }

  // Lazily fetch+decode a file; play it as soon as it's ready. Cached forever,
  // one in-flight fetch per path, failures remembered (no retry storm).
  function playFile(path, vol) {
    if (muted) return;
    ensureCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ok */ } }

    var buf = buffers[path];
    if (buf === 'loading' || buf === 'failed') return;
    if (buf) { playBuffer(buf, vol); return; }

    buffers[path] = 'loading';
    fetch(BASE + path).then(function (r) {
      return r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)));
    }).then(function (ab) {
      return new Promise(function (res, rej) { ctx.decodeAudioData(ab, res, rej); });
    }).then(function (decoded) {
      buffers[path] = decoded;
      playBuffer(decoded, vol);
    }).catch(function () { buffers[path] = 'failed'; });
  }

  function playBuffer(buf, vol) {
    try {
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g); g.connect(master);
      src.start(0);
    } catch (e) { /* audio must never break the game */ }
  }

  // Random variant that differs from the previous pick of the same pool.
  function pickVariant(poolKey, count) {
    var n = 1 + Math.floor(Math.random() * count);
    if (count > 1 && n === lastVariant[poolKey]) n = (n % count) + 1;
    lastVariant[poolKey] = n;
    return n;
  }

  // ---- public SFX ------------------------------------------------------------
  function play(name) {
    var f = SFX_FILES[name];
    if (f) { playFile(f, name === 'click' ? VOL_UI : VOL_SFX); return; }
    // legacy/unknown names: intentionally SILENT (the old 440 Hz fallback beep
    // was the wrong-audio bug). 'dig'/'place' without a block id still work:
    if (name === 'dig') { block('break', 0); return; }
    if (name === 'place') { block('place', 0); return; }
  }

  function step(idOrSurface) {
    var cat = catForBlock(idOrSurface);
    if (!cat) return;
    if (cat === 'glass') cat = 'stone';           // no glass footsteps recorded
    var n = pickVariant('step:' + cat, STEP_VARIANTS);
    playFile('steps/' + cat + '_' + n + '.mp3', VOL_STEP);
  }

  function block(action, blockId) {
    var cat = catForBlock(blockId);
    if (!cat) return;                              // liquids etc.
    if (action === 'break') {
      playFile('blocks/' + cat + '_break_' + pickVariant('brk:' + cat, BREAK_VARIANTS) + '.mp3', VOL_BREAK);
    } else if (action === 'place') {
      playFile('blocks/' + cat + '_place_' + pickVariant('plc:' + cat, PLACE_VARIANTS) + '.mp3', VOL_PLACE);
    } else if (action === 'hit') {
      playFile('blocks/' + cat + '_hit_1.mp3', VOL_MINE_HIT);
    }
  }

  // ---- music ------------------------------------------------------------------
  function musicVol() { return muted ? 0 : VOL_MASTER * VOL_MUSIC; }

  function makeChannel() {
    var a = new Audio();
    a.preload = 'auto';
    a.volume = 0;
    return a;
  }

  function poolFor(kind) {
    if (kind === 'menu') return 'menu';
    return isNight ? 'game_night' : 'game_day';
  }

  // Crossfade the active channel to `path`. The outgoing element ramps to 0
  // and pauses; the incoming ramps to full music volume over CROSSFADE_MS.
  function switchTrack(path, loop) {
    if (!musA) { musA = makeChannel(); musB = makeChannel(); }
    var out = musActive;
    var inn = (out === musA) ? musB : musA;

    inn.src = BASE + path;
    inn.loop = !!loop;
    inn.volume = 0;
    inn.onended = null;
    if (!loop) {
      inn.onended = function () { advancePool(); };
    }
    musActive = inn;
    pendingMusic = false;
    try {
      var p = inn.play();
      if (p && p.catch) p.catch(function () { pendingMusic = true; });
    } catch (e) { pendingMusic = true; }

    clearInterval(fadeTimer);
    var t0 = Date.now();
    fadeTimer = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / CROSSFADE_MS);
      var v = musicVol();
      try { inn.volume = v * k; } catch (e) { /* ok */ }
      if (out) { try { out.volume = v * (1 - k); } catch (e) { /* ok */ } }
      if (k >= 1) {
        clearInterval(fadeTimer);
        if (out) { try { out.pause(); out.onended = null; } catch (e) { /* ok */ } }
      }
    }, 60);
  }

  // Track finished (multi-track pool): play the next one in the pool.
  function advancePool() {
    if (!curPool) return;
    var pool = MUSIC_POOLS[curPool];
    poolIdx = (poolIdx + 1) % pool.length;
    switchTrack(pool[poolIdx], pool.length === 1);
  }

  function startPool(poolName) {
    curPool = poolName;
    var pool = MUSIC_POOLS[poolName];
    poolIdx = Math.floor(Math.random() * pool.length);
    switchTrack(pool[poolIdx], pool.length === 1);
  }

  function music(kind) {
    if (kind === curKind) {
      // Same kind already active — do NOT restart (menu.js calls this on
      // every Menu.show; the old engine restarted the track each time).
      // But if the day/night pool drifted while we weren't looking, resync:
      if (kind === 'game' && curPool !== poolFor('game')) startPool(poolFor('game'));
      return;
    }
    curKind = kind || null;
    if (!kind) {
      // fade everything out
      curPool = null;
      clearInterval(fadeTimer);
      var out = musActive; musActive = null;
      if (out) {
        var t0 = Date.now(), v0 = out.volume;
        fadeTimer = setInterval(function () {
          var k = Math.min(1, (Date.now() - t0) / 800);
          try { out.volume = v0 * (1 - k); } catch (e) { /* ok */ }
          if (k >= 1) { clearInterval(fadeTimer); try { out.pause(); } catch (e) { /* ok */ } }
        }, 60);
      }
      return;
    }
    startPool(poolFor(kind));
  }

  // Fed every frame by the game loop with timeTicks/DAY_TICKS. Cheap: only
  // acts when the day/night boundary is crossed while game music is playing.
  function setTimeOfDay(frac) {
    var night = frac >= NIGHT_START && frac < NIGHT_END;
    if (night === isNight) return;
    isNight = night;
    if (curKind === 'game') startPool(poolFor('game'));   // smooth crossfade
  }

  // ---- mute --------------------------------------------------------------------
  function applyMute() {
    if (master) master.gain.value = muted ? 0 : VOL_MASTER;
    var v = musicVol();
    if (musActive) { try { musActive.volume = v; } catch (e) { /* ok */ } }
  }
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ok */ }
    applyMute();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](muted); } catch (e) { /* ok */ } }
  }
  function isMuted() { return muted; }
  function toggleMute() { setMuted(!muted); return muted; }
  function onMuteChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // ---- init ----------------------------------------------------------------------
  function init() {
    if (inited) return;
    inited = true;
    try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* ok */ }
    var gestures = ['pointerdown', 'keydown', 'touchstart'];
    function once() {
      unlock();
      gestures.forEach(function (g) { window.removeEventListener(g, once, true); });
    }
    gestures.forEach(function (g) { window.addEventListener(g, once, true); });
  }

  return {
    init: init, play: play, music: music, unlock: unlock,
    setMuted: setMuted, isMuted: isMuted, toggleMute: toggleMute, onMuteChange: onMuteChange,
    step: step, block: block, setTimeOfDay: setTimeOfDay
  };
})();

window.Sound = Sound;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { Sound.init(); }, { once: true });
} else {
  Sound.init();
}
