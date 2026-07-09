/* CLOBI CRAFT service worker — PWA offline shell + fast repeat loads.
 *
 * Strategy (kept deliberately simple and safe for a live multiplayer game):
 *
 *   /api/*, /ws/*          -> NEVER touched. Passed straight to the network.
 *                             (WebSockets can't be cached; API responses are
 *                             auth'd + dynamic. Intercepting them would break
 *                             login, rooms, and multiplayer.)
 *   navigations (the page) -> network-first, fall back to cached index.html
 *                             so the menu/solo game still boots offline.
 *   same-origin GET assets -> stale-while-revalidate: serve the cached copy
 *                             instantly, refresh it in the background. This is
 *                             what makes repeat launches feel instant on phones.
 *   cross-origin (fonts…)  -> left to the browser (not intercepted).
 *
 * Bump CACHE_VERSION on every deploy so old shells are dropped in `activate`.
 * The Go server already sends Cache-Control:no-cache, so the SW cache is the
 * real repeat-load accelerator here.
 */
'use strict';

var CACHE_VERSION = 'clobi-v3-2026-07-10';
var SHELL_CACHE = CACHE_VERSION + '-shell';
var RUNTIME_CACHE = CACHE_VERSION + '-runtime';

// App shell: everything needed to boot the menu + solo game offline. Kept in
// dependency order matching index.html so a cold offline load has every module.
var SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/favicon.ico',
  // top-level modules
  '/js/i18n.js',
  '/js/gag.js',
  '/js/sound.js',
  '/js/store.js',
  '/js/skinstudio.js',
  '/js/market.js',
  '/js/worldselect.js',
  '/js/friends.js',
  '/js/menu.js',
  '/js/main.js',
  // voxel engine modules
  '/js/vox/math3d.js',
  '/js/vox/glx.js',
  '/js/vox/lut.js',
  '/js/vox/blocks.js',
  '/js/vox/items.js',
  '/js/vox/worldgen.js',
  '/js/vox/world.js',
  '/js/vox/mesher.js',
  '/js/vox/skins.js',
  '/js/vox/playermodel.js',
  '/js/vox/physics.js',
  '/js/vox/input.js',
  '/js/vox/interact.js',
  '/js/vox/inventory.js',
  '/js/vox/craft.js',
  '/js/vox/commands.js',
  '/js/vox/hud.js',
  '/js/vox/renderer.js',
  '/js/vox/net.js',
  '/js/vox/remoteplayers.js',
  '/js/vox/combat.js',
  '/js/vox/mobs.js',
  '/js/vox/drops.js',
  '/js/vox/game.js',
  // key icons (home-screen + in-app)
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png'
];

// ---- install: precache the shell (tolerant — a single 404 won't abort) ----
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // addAll is all-or-nothing; add individually so one missing optional
      // file never blocks the whole install.
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
          /* keep going — offline coverage is best-effort per-file */
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

// ---- activate: drop caches from older versions ----
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// ---- fetch routing ----
self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Only GET is cacheable; everything else (POST logins, etc.) goes to network.
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Cross-origin (Google Fonts, etc.): don't intercept — let the browser and
  // its own HTTP cache handle it. Avoids opaque-response cache bloat.
  if (url.origin !== self.location.origin) return;

  // Dynamic backend: never cache or intercept API + WebSocket upgrades.
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/ws/') === 0) {
    return; // default network handling
  }

  // Navigations (address-bar loads, app launch): network-first so a live
  // deploy is picked up, but fall back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put('/index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('/index.html').then(function (r) {
          return r || caches.match('/');
        });
      })
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        // Only cache good, basic (same-origin) responses.
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      // Serve cache immediately if present; otherwise wait on the network.
      return cached || network;
    })
  );
});

// Allow the page to trigger an immediate SW takeover after an update prompt.
self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
