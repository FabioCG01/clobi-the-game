// sound.js — global Sound. 8-bit audio for TUX SMASH ROYALE.
//
// Works out of the box via WebAudio synthesis (SFX + simple chiptune music), so
// there are NO required binary assets. To use your OWN audio, drop files in
// web/assets/audio/ and point web/assets/audio/manifest.json at them — any entry
// with a "file" overrides the built-in synth (mp3/ogg/wav). Music files loop.
//
// API: Sound.init(); Sound.play(name); Sound.music('menu'|'game'|null);
//      Sound.setMuted(bool); Sound.isMuted(); Sound.toggleMute(); Sound.unlock();
var Sound = (function () {
  'use strict';

  var ctx = null, master = null;
  var muted = false, volume = 0.55;
  var buffers = {};        // name -> AudioBuffer (loaded file override)
  var curMusic = null;     // { kind, gain, stop }
  var listeners = [];      // mute-change callbacks
  var inited = false;
  var MUTE_KEY = 'clobi.muted';
  var AUDIO_BASE = 'assets/audio/';

  // ---- context + autoplay unlock ------------------------------------------
  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  function unlock() {
    ensureCtx();
    if (ctx && ctx.state === 'suspended') { ctx.resume(); }
  }

  // ---- low-level synth voices ---------------------------------------------
  function tone(freq, dur, type, vol, glideTo) {
    if (!ctx) return;
    var t0 = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) { o.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t0 + dur); }
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, hp) {
    if (!ctx) return;
    var t0 = ctx.currentTime;
    var len = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) { d[i] = (Math.random() * 2 - 1) * (1 - i / len); }
    var src = ctx.createBufferSource(); src.buffer = buf;
    var g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.001, vol), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (hp) { var f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; src.connect(f); f.connect(g); }
    else { src.connect(g); }
    g.connect(master);
    src.start(t0);
  }

  // ---- SFX recipes ---------------------------------------------------------
  function synth(name) {
    switch (name) {
      case 'click': tone(660, 0.06, 'square', 0.25); break;
      case 'jump': tone(320, 0.16, 'square', 0.3, 720); break;
      case 'attack': tone(180, 0.08, 'sawtooth', 0.3, 90); noise(0.06, 0.12, 1200); break;
      case 'throw': tone(540, 0.12, 'square', 0.22, 240); break;
      case 'dash': tone(420, 0.1, 'sawtooth', 0.18, 880); break;
      case 'hit': noise(0.1, 0.25, 800); tone(140, 0.1, 'square', 0.22, 70); break;
      case 'ko': tone(440, 0.4, 'sawtooth', 0.32, 60); noise(0.35, 0.2, 400); break;
      case 'pickup': tone(523, 0.08, 'square', 0.25); setTimeout(function () { tone(784, 0.1, 'square', 0.25); }, 70); break;
      case 'win': [523, 659, 784, 1047].forEach(function (f, i) { setTimeout(function () { tone(f, 0.18, 'square', 0.3); }, i * 120); }); break;
      case 'lose': [392, 330, 262, 196].forEach(function (f, i) { setTimeout(function () { tone(f, 0.22, 'triangle', 0.3); }, i * 150); }); break;
      default: tone(440, 0.08, 'square', 0.2); break;
    }
  }

  function playBuffer(buf, vol, loop) {
    if (!ctx) return null;
    var src = ctx.createBufferSource();
    src.buffer = buf; src.loop = !!loop;
    var g = ctx.createGain(); g.gain.value = (muted ? 0 : volume * (vol || 1));
    src.connect(g); g.connect(master);
    src.start(0);
    return { src: src, gain: g };
  }

  function play(name) {
    if (muted) return;
    ensureCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (buffers[name]) { playBuffer(buffers[name], 0.9, false); return; }
    synth(name);
  }

  // ---- music ---------------------------------------------------------------
  function stopMusic() {
    if (curMusic) { try { curMusic.stop(); } catch (e) {} curMusic = null; }
  }

  function startSynthMusic(kind) {
    ensureCtx(); if (!ctx) return;
    var g = ctx.createGain(); g.gain.value = (muted ? 0 : volume * 0.32); g.connect(master);
    var pats = {
      menu: { tempo: 0.30, notes: [220, 277, 330, 277, 196, 247, 294, 247] },
      game: { tempo: 0.17, notes: [330, 392, 494, 392, 294, 349, 440, 349, 262, 330, 392, 330] }
    };
    var p = pats[kind] || pats.menu;
    var i = 0;
    function beat() {
      if (!curMusic || curMusic.kind !== kind || !ctx) return;
      var t0 = ctx.currentTime;
      var f = p.notes[i % p.notes.length];
      var o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.45, t0 + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + p.tempo * 0.9);
      o.connect(ng); ng.connect(g); o.start(t0); o.stop(t0 + p.tempo);
      if (i % 4 === 0) {
        var b = ctx.createOscillator(); b.type = 'triangle'; b.frequency.value = f / 2;
        var bg = ctx.createGain();
        bg.gain.setValueAtTime(0.0001, t0);
        bg.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
        bg.gain.exponentialRampToValueAtTime(0.0001, t0 + p.tempo * 1.7);
        b.connect(bg); bg.connect(g); b.start(t0); b.stop(t0 + p.tempo * 2);
      }
      i++;
    }
    var iv = setInterval(beat, p.tempo * 1000);
    curMusic = { kind: kind, gain: g, stop: function () { clearInterval(iv); try { g.disconnect(); } catch (e) {} } };
    beat();
  }

  function music(kind) {
    stopMusic();
    if (!kind) return;
    ensureCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    var fileKey = kind + 'Music';
    if (buffers[fileKey]) {
      var h = playBuffer(buffers[fileKey], 0.6, true);
      if (h) { curMusic = { kind: kind, gain: h.gain, stop: function () { try { h.src.stop(); } catch (e) {} try { h.gain.disconnect(); } catch (e) {} } }; }
      return;
    }
    startSynthMusic(kind);
  }

  // ---- mute ----------------------------------------------------------------
  function applyMute() {
    if (master) master.gain.value = muted ? 0 : volume;
    if (curMusic && curMusic.gain) {
      curMusic.gain.gain.value = muted ? 0 : volume * 0.32;
    }
  }
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) {}
    applyMute();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](muted); } catch (e) {} }
  }
  function isMuted() { return muted; }
  function toggleMute() { setMuted(!muted); return muted; }
  function onMuteChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

  // ---- optional file manifest ---------------------------------------------
  function loadManifest() {
    if (typeof fetch !== 'function') return;
    fetch(AUDIO_BASE + 'manifest.json').then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (man) {
      if (!man || !man.sounds) return;
      Object.keys(man.sounds).forEach(function (name) {
        var entry = man.sounds[name];
        if (!entry || !entry.file) return;
        fetch(AUDIO_BASE + entry.file).then(function (r) {
          return r.ok ? r.arrayBuffer() : null;
        }).then(function (ab) {
          if (!ab) return;
          ensureCtx(); if (!ctx) return;
          ctx.decodeAudioData(ab, function (buf) { buffers[name] = buf; }, function () {});
        }).catch(function () {});
      });
    }).catch(function () {});
  }

  function init() {
    if (inited) return;
    inited = true;
    try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) {}
    // Resume the audio context on the first user gesture (autoplay policy).
    var gestures = ['pointerdown', 'keydown', 'touchstart'];
    function once() {
      unlock();
      gestures.forEach(function (g) { window.removeEventListener(g, once, true); });
    }
    gestures.forEach(function (g) { window.addEventListener(g, once, true); });
    loadManifest();
  }

  return {
    init: init, play: play, music: music, unlock: unlock,
    setMuted: setMuted, isMuted: isMuted, toggleMute: toggleMute, onMuteChange: onMuteChange
  };
})();

window.Sound = Sound;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { Sound.init(); }, { once: true });
} else {
  Sound.init();
}
