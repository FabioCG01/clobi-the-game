// gag.js — the "Activate Windows" annoyance overlay for TUX SMASH ROYALE.
//
// A loving jab at the proprietary OS Clobi spent a career warning us about.
// When a penguin gets hit by a "windows"-charged melee, their client is cursed
// with the authentic, undismissable Activate Windows watermark — bottom-right,
// translucent light grey, two lines — plus a desaturated, dimmed page, and the
// watermark jitters and flickers like the real thing nagging you forever.
//
// Self-contained. Assigns exactly ONE global: window.Gag.
// Public API:
//   Gag.activate(durationMs)  -> start (or extend) the curse for durationMs
//   Gag.deactivate()          -> force-clear immediately (used by Game on reset)
//   Gag.isActive()            -> boolean
//
// No dependencies on any other module. Callable from anywhere.

const Gag = (function () {
  'use strict';

  // ---- tuning constants ---------------------------------------------------
  var STYLE_ID = 'gag-style';
  var OVERLAY_ID = 'gag-overlay';
  var FILTER_CLASS = 'gag-active';        // applied to <html> while active
  var MAX_Z = 2147483647;                  // max 32-bit int z-index
  var JITTER_MS = 700;                     // how often the mark hops/flickers
  var JITTER_PX = 4;                       // max px the mark hops each tick
  var DRIFT_DUPLICATES = 2;                // extra drifting ghost watermarks

  // ---- private state ------------------------------------------------------
  var active = false;
  var expiresAt = 0;        // performance.now() timestamp when the curse lifts
  var rafId = 0;            // requestAnimationFrame handle (expiry watcher)
  var jitterTimer = 0;      // setInterval handle (jitter/flicker)
  var expiryTimer = 0;      // setTimeout handle (guaranteed expiry, tab-safe)
  var overlayEl = null;     // #gag-overlay root
  var marks = [];           // array of {el, baseRight, baseBottom, phase, speed}

  // ------------------------------------------------------------------------
  // CSS — injected once. Uses a <style> tag so the module is fully drop-in.
  // ------------------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      // While cursed: desaturate + dim the entire page. We target <html> so
      // the whole document (every screen + canvas) is affected, but we exclude
      // the overlay itself so the watermark stays crisp and readable.
      'html.' + FILTER_CLASS + ' body {',
      '  filter: grayscale(0.85) brightness(0.78) contrast(0.96);',
      '  transition: filter 220ms ease;',
      '}',
      // The overlay is a sibling of the screens (per index.html), but if the
      // body filter ever bled onto it we counter it here anyway.
      '#' + OVERLAY_ID + ' {',
      '  position: fixed;',
      '  inset: 0;',
      '  margin: 0;',
      '  padding: 0;',
      '  pointer-events: none;',     // never blocks clicks
      '  overflow: hidden;',
      '  z-index: ' + MAX_Z + ';',
      '  display: none;',
      '  filter: none;',
      '}',
      '#' + OVERLAY_ID + '.gag-on { display: block; }',
      // A faint cold blue-grey tint layer — reinforces the "dead OS" mood
      // on top of the body desaturation, and reads as Windows-y.
      '#' + OVERLAY_ID + ' .gag-tint {',
      '  position: absolute;',
      '  inset: 0;',
      '  background: rgba(20, 26, 46, 0.16);',
      '  pointer-events: none;',
      '}',
      // The watermark itself: bottom-right, translucent light grey, the real
      // anti-aliased system look (NOT the pixel font) so it reads as genuine.
      '#' + OVERLAY_ID + ' .gag-mark {',
      '  position: absolute;',
      '  right: 38px;',
      '  bottom: 30px;',
      '  text-align: right;',
      '  color: #d7d7d7;',
      '  opacity: 0.62;',
      '  text-shadow: 0 1px 1px rgba(0,0,0,0.28);',
      '  font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;',
      '  font-weight: 400;',
      '  line-height: 1.32;',
      '  letter-spacing: 0.2px;',
      '  user-select: none;',
      '  white-space: nowrap;',
      '  will-change: transform, opacity;',
      '}',
      '#' + OVERLAY_ID + ' .gag-mark .gag-line1 {',
      '  font-size: 27px;',
      '}',
      '#' + OVERLAY_ID + ' .gag-mark .gag-line2 {',
      '  font-size: 15px;',
      '  margin-top: 2px;',
      '  opacity: 0.92;',
      '}',
      // Drifting duplicate ghosts: a touch fainter, lazily floating around.
      '#' + OVERLAY_ID + ' .gag-mark.gag-ghost {',
      '  opacity: 0.20;',
      '}'
    ].join('\n');

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  // ------------------------------------------------------------------------
  // Build a single watermark element (two lines).
  // ------------------------------------------------------------------------
  function buildMark(isGhost) {
    var mark = document.createElement('div');
    mark.className = 'gag-mark' + (isGhost ? ' gag-ghost' : '');

    var l1 = document.createElement('div');
    l1.className = 'gag-line1';
    l1.textContent = 'Activate Windows';

    var l2 = document.createElement('div');
    l2.className = 'gag-line2';
    l2.textContent = 'Go to Settings to activate Windows.';

    mark.appendChild(l1);
    mark.appendChild(l2);
    return mark;
  }

  // ------------------------------------------------------------------------
  // Create the overlay DOM lazily (and re-create if it was removed).
  // ------------------------------------------------------------------------
  function ensureOverlay() {
    ensureStyle();

    overlayEl = document.getElementById(OVERLAY_ID);
    if (!overlayEl) {
      // Per the contract index.html SHOULD contain #gag-overlay outside all
      // screens, but we self-heal by creating it if absent so the module is
      // genuinely callable from anywhere, any time.
      overlayEl = document.createElement('div');
      overlayEl.id = OVERLAY_ID;
      (document.body || document.documentElement).appendChild(overlayEl);
    }

    // Always rebuild contents fresh so re-activation is clean.
    overlayEl.innerHTML = '';
    marks = [];

    var tint = document.createElement('div');
    tint.className = 'gag-tint';
    overlayEl.appendChild(tint);

    // The primary, anchored watermark (bottom-right).
    var primary = buildMark(false);
    overlayEl.appendChild(primary);
    marks.push({
      el: primary,
      ghost: false,
      // drift phase parameters (ghosts use these; primary stays mostly put)
      phase: 0,
      speed: 0,
      ampX: 0,
      ampY: 0
    });

    // Optional drifting duplicate ghosts. They float slowly around the screen
    // to make the nag feel like it's everywhere.
    for (var i = 0; i < DRIFT_DUPLICATES; i++) {
      var ghost = buildMark(true);
      // Seed each ghost at a different on-screen spot via inline overrides.
      ghost.style.right = 'auto';
      ghost.style.bottom = 'auto';
      ghost.style.left = (8 + i * 33) + '%';
      ghost.style.top = (22 + i * 27) + '%';
      overlayEl.appendChild(ghost);
      marks.push({
        el: ghost,
        ghost: true,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 0.5,        // radians per second-ish
        ampX: 18 + Math.random() * 26,           // px drift amplitude
        ampY: 14 + Math.random() * 22
      });
    }

    overlayEl.classList.add('gag-on');
  }

  // ------------------------------------------------------------------------
  // Jitter + flicker: the authentic "it never sits still" nag. Runs on an
  // interval. Hops the primary mark a few px and flickers its opacity.
  // ------------------------------------------------------------------------
  function jitterTick() {
    if (!active) return;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.ghost) continue; // ghosts drift smoothly in the rAF loop instead
      var jx = (Math.random() * 2 - 1) * JITTER_PX;
      var jy = (Math.random() * 2 - 1) * JITTER_PX;
      m.el.style.transform = 'translate(' + jx.toFixed(1) + 'px,' + jy.toFixed(1) + 'px)';
      // Flicker opacity around the resting 0.62.
      var op = 0.5 + Math.random() * 0.22;
      m.el.style.opacity = op.toFixed(2);
    }
  }

  // ------------------------------------------------------------------------
  // Main loop: smoothly drift ghosts and watch for expiry. One rAF chain.
  // ------------------------------------------------------------------------
  function loop() {
    if (!active) { rafId = 0; return; }

    var now = perfNow();

    // Expired? Lift the curse.
    if (now >= expiresAt) {
      clearAll();
      return;
    }

    // Drift the ghost watermarks on a lazy sine path.
    var tSec = now / 1000;
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (!m.ghost) continue;
      var dx = Math.cos(tSec * m.speed + m.phase) * m.ampX;
      var dy = Math.sin(tSec * m.speed * 0.8 + m.phase) * m.ampY;
      m.el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    }

    rafId = requestAnimationFrame(loop);
  }

  function perfNow() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  // ------------------------------------------------------------------------
  // Tear everything down — used both on natural expiry and forced deactivate.
  // ------------------------------------------------------------------------
  function clearAll() {
    active = false;
    expiresAt = 0;

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (jitterTimer) {
      clearInterval(jitterTimer);
      jitterTimer = 0;
    }
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = 0;
    }

    var root = document.documentElement;
    if (root) root.classList.remove(FILTER_CLASS);

    var ov = document.getElementById(OVERLAY_ID);
    if (ov) {
      ov.classList.remove('gag-on');
      ov.innerHTML = '';
    }
    overlayEl = null;
    marks = [];
  }

  // ------------------------------------------------------------------------
  // PUBLIC API
  // ------------------------------------------------------------------------

  // (Re)arm the guaranteed-expiry timer. The rAF loop is throttled or paused
  // when the tab is in the background, so on its own it could let the curse
  // overstay its welcome. A setTimeout keeps firing while backgrounded and
  // guarantees the watermark lifts on schedule no matter the tab state.
  function armExpiry() {
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = 0;
    }
    var remaining = expiresAt - perfNow();
    if (remaining < 0) remaining = 0;
    expiryTimer = setTimeout(function () {
      expiryTimer = 0;
      if (active && perfNow() >= expiresAt) clearAll();
    }, remaining);
  }

  // Start (or extend) the curse. The overlay cannot be dismissed by the user;
  // it lifts only when durationMs elapses (or on an explicit deactivate()).
  function activate(durationMs) {
    var ms = Number(durationMs);
    if (!isFinite(ms) || ms <= 0) ms = 10000; // sane default (server uses 10s)

    var now = perfNow();
    var target = now + ms;

    // If already cursed, EXTEND rather than restart — re-getting hit should
    // never shorten the punishment.
    if (active) {
      if (target > expiresAt) {
        expiresAt = target;
        armExpiry(); // push the guaranteed-expiry deadline out to match
      }
      return;
    }

    active = true;
    expiresAt = target;

    ensureOverlay();

    // Dim + desaturate the whole page.
    var root = document.documentElement;
    if (root) root.classList.add(FILTER_CLASS);

    // Kick off jitter/flicker and the drift+expiry loop.
    if (jitterTimer) clearInterval(jitterTimer);
    jitterTimer = setInterval(jitterTick, JITTER_MS);
    jitterTick(); // immediate first hop so it never looks static

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);

    // Tab-safe expiry net (in case rAF is throttled/paused in the background).
    armExpiry();
  }

  // Force-clear immediately. Safe to call when inactive.
  function deactivate() {
    clearAll();
  }

  function isActive() {
    return active;
  }

  // Clean up if the page is torn down mid-curse (defensive; harmless).
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function () {
      if (active) clearAll();
    });
  }

  return {
    activate: activate,
    deactivate: deactivate,
    isActive: isActive
  };
})();

window.Gag = Gag;
