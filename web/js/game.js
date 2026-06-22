// game.js — global Game (TUX SMASH ROYALE).
//
// Client-side match controller. Per the project contract:
//   Game.start(roomInfo) — begin a match: subscribe to SNAPSHOT, run the ~30Hz
//                          input tick, and the rAF interpolating render loop.
//   Game.stop()          — tear everything down and unsubscribe.
//
// On each SNAPSHOT we keep the latest + previous snapshot and INTERPOLATE between
// them every animation frame, then call Render.drawFrame(state, localPlayerId).
// Each ~30Hz tick we read Input.getState() + Input.consumeVimCommand() and send
// Net.send(Protocol.INPUT, {seq, dx, dy, attack, throw, dash, vim}) — the flat
// InputMsg shape the Go server expects.
// When the local player's WindowsUntil (unix-millis) is in the future and the gag
// isn't already active, we call Gag.activate(remainingMs).
// Handles GAME_OVER by showing the localized result and returning to the menu.
//
// Snapshot wire shape (lowercase JSON, identical to Go protocol.Snapshot):
//   { t, mode, players:[{id,nickname,character,x,y,hp,damage,facing,alive,boost,
//     windowsUntil}], projectiles:[{x,y,kind}], pickups:[{x,y,kind}],
//     zone:{cx,cy,r}, alive, winner }
//
// Assigns exactly ONE global: window.Game.

const Game = (function () {
  'use strict';

  var TICK_HZ = 30;
  var TICK_MS = 1000 / TICK_HZ;

  // ---- runtime state ----------------------------------------------------
  var running = false;
  var roomInfo = null; // the RoomInfo we started in
  var localPlayerId = null; // resolved id of the local player

  // Snapshot buffer for interpolation.
  var prevSnap = null; // earlier snapshot
  var lastSnap = null; // most recent snapshot
  var prevRecvAt = 0; // performance.now() when prevSnap arrived
  var lastRecvAt = 0; // performance.now() when lastSnap arrived

  // Loop handles.
  var rafId = 0;
  var tickTimer = 0;

  // Monotonic input sequence number sent with every INPUT frame.
  var inputSeq = 0;

  // Gag bookkeeping so we don't re-activate on every snapshot.
  var lastWindowsUntil = 0;

  // Royale town cache: the server sends the static town on the first ticks +
  // periodically; we keep the latest non-empty copy + the world dimensions.
  var townObstacles = null;
  var townW = 0, townH = 0;

  // Registered Net handlers, kept so we can detach them on stop().
  var netHandlers = []; // [{type, handler}]

  // ---- helpers ----------------------------------------------------------
  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  function tr(key, fallback) {
    if (typeof window !== 'undefined' && window.I18n && typeof window.I18n.t === 'function') {
      return window.I18n.t(key, fallback);
    }
    return fallback;
  }

  // Best-effort resolution of which player in the snapshot is "us".
  function resolveLocalPlayerId(snap) {
    if (localPlayerId != null) return localPlayerId;

    // 1) App may already know our id (e.g. learned from HELLO_OK).
    if (typeof window !== 'undefined' && window.App) {
      if (window.App.playerId != null) {
        localPlayerId = window.App.playerId;
        return localPlayerId;
      }
      if (typeof window.App.getPlayerId === 'function') {
        var id = window.App.getPlayerId();
        if (id != null) {
          localPlayerId = id;
          return localPlayerId;
        }
      }
    }

    // 2) Fall back to matching our nickname against the snapshot.
    var myNick = (window.App && window.App.nickname) || null;
    if (!myNick && roomInfo && Array.isArray(roomInfo.players)) {
      // No App nickname? Nothing else to match on here.
    }
    if (myNick && snap && Array.isArray(snap.players)) {
      for (var i = 0; i < snap.players.length; i++) {
        if (snap.players[i].nickname === myNick) {
          localPlayerId = snap.players[i].id;
          return localPlayerId;
        }
      }
    }
    return null;
  }

  // Linear interpolation.
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Facing is an integer (-1 / +1). Snap to the target past the midpoint so the
  // sprite flips cleanly rather than scaling through zero.
  function lerpFacing(a, b, t) {
    if (a === b) return b;
    return t < 0.5 ? a : b;
  }

  // Build an interpolated render state from prevSnap/lastSnap at fraction t.
  // The output preserves the snapshot field names so Render reads them directly.
  // Attach the cached royale town + world dims so Render can draw the town and
  // size the follow-camera.
  function withTown(s) {
    if (!s) return s;
    s.w = townW || s.w || 0;
    s.h = townH || s.h || 0;
    s.obstacles = townObstacles || s.obstacles || null;
    return s;
  }

  function buildInterpolatedState(t) {
    if (!lastSnap) return null;
    if (!prevSnap) return withTown(lastSnap);

    var a = prevSnap;
    var b = lastSnap;

    // Index previous players by id for quick lookup.
    var prevById = Object.create(null);
    if (Array.isArray(a.players)) {
      for (var i = 0; i < a.players.length; i++) {
        prevById[a.players[i].id] = a.players[i];
      }
    }

    var players = [];
    var bp = b.players || [];
    for (var j = 0; j < bp.length; j++) {
      var pb = bp[j];
      var pa = prevById[pb.id];
      if (!pa) {
        // New player this snapshot — no history to interpolate from.
        players.push(pb);
        continue;
      }
      players.push({
        id: pb.id,
        nickname: pb.nickname,
        character: pb.character,
        x: lerp(pa.x, pb.x, t),
        y: lerp(pa.y, pb.y, t),
        hp: lerp(pa.hp, pb.hp, t),
        damage: lerp(pa.damage || 0, pb.damage || 0, t),
        facing: lerpFacing(pa.facing, pb.facing, t),
        alive: pb.alive,
        boost: pb.boost,
        windowsUntil: pb.windowsUntil,
      });
    }

    // Projectiles & pickups spawn/despawn freely; interpolating them by array
    // index is unreliable, so we render the authoritative latest positions. This
    // keeps fast LibreOffice frisbees visually correct.
    var projectiles = b.projectiles || [];
    var pickups = b.pickups || [];

    // Interpolate the Menthol Zone center/radius for a smooth shrink (royale).
    var zone = b.zone;
    if (a.zone && b.zone) {
      zone = {
        cx: lerp(a.zone.cx, b.zone.cx, t),
        cy: lerp(a.zone.cy, b.zone.cy, t),
        r: lerp(a.zone.r, b.zone.r, t),
      };
    }

    return withTown({
      t: b.t,
      mode: b.mode,
      players: players,
      projectiles: projectiles,
      pickups: pickups,
      zone: zone,
      alive: b.alive,
      winner: b.winner,
    });
  }

  // ---- gag trigger ------------------------------------------------------
  function maybeTriggerGag(snap) {
    var id = resolveLocalPlayerId(snap);
    if (id == null || !snap || !Array.isArray(snap.players)) return;

    var me = null;
    for (var i = 0; i < snap.players.length; i++) {
      if (snap.players[i].id === id) {
        me = snap.players[i];
        break;
      }
    }
    if (!me) return;

    var until = me.windowsUntil || 0; // unix-millis; 0 means inactive
    var t = Date.now();
    if (until > t) {
      var remaining = until - t;
      var gagActive = !!(window.Gag && window.Gag.isActive && window.Gag.isActive());
      // (Re)activate only when this is a fresh/extended curse, or the gag isn't
      // currently running. Gag.activate() is idempotent w.r.t. extension.
      if (!gagActive || until > lastWindowsUntil) {
        if (window.Gag && typeof window.Gag.activate === 'function') {
          window.Gag.activate(remaining);
        }
      }
      lastWindowsUntil = until;
    }
  }

  // ---- network handlers -------------------------------------------------
  function onSnapshot(payload) {
    if (!running || !payload) return;

    // Shift the buffer: previous <- last, last <- new.
    prevSnap = lastSnap;
    prevRecvAt = lastRecvAt;
    lastSnap = payload;
    lastRecvAt = now();

    // Cache the royale town + world size (sent only on some ticks).
    if (payload.obstacles && payload.obstacles.length) townObstacles = payload.obstacles;
    if (payload.w) { townW = payload.w; townH = payload.h; }

    if (!prevSnap) {
      // Seed the previous slot so the first frames have something to lerp from.
      prevSnap = payload;
      prevRecvAt = lastRecvAt;
    }

    resolveLocalPlayerId(payload);
    maybeTriggerGag(payload);
  }

  function onGameOver(payload) {
    if (!running) return;
    var winnerId = payload ? payload.winnerId : null;
    var winnerNickname = (payload && payload.winnerNickname) || '';
    var youWon = winnerId != null && localPlayerId != null && winnerId === localPlayerId;

    // Stop the loops/handlers before handing control back to the menu.
    stop();

    showResult({ youWon: youWon, winnerNickname: winnerNickname, winnerId: winnerId });
  }

  function returnToMenu() {
    if (window.Menu && typeof window.Menu.show === 'function') {
      window.Menu.show();
    }
    if (window.App && typeof window.App.showScreen === 'function') {
      window.App.showScreen('menu');
    }
  }

  function showResult(result) {
    // Prefer a Menu-provided result UI if one exists; otherwise render a minimal,
    // fully localized 8-bit banner so the player always sees the outcome.
    if (window.Menu && typeof window.Menu.showGameOver === 'function') {
      window.Menu.showGameOver(result, returnToMenu);
      return;
    }

    var host = document.getElementById('screen-game') || document.body;
    var existing = document.getElementById('game-over-banner');
    if (existing) existing.parentNode.removeChild(existing);

    var banner = document.createElement('div');
    banner.id = 'game-over-banner';
    banner.style.position = 'absolute';
    banner.style.left = '50%';
    banner.style.top = '50%';
    banner.style.transform = 'translate(-50%, -50%)';
    banner.style.zIndex = '8000';
    banner.style.background = '#1a1d2e';
    banner.style.border = '4px solid ' + (result.youWon ? '#7ff9e0' : '#ff9e2c');
    banner.style.boxShadow = '8px 8px 0 0 rgba(0,0,0,0.6)';
    banner.style.padding = '24px';
    banner.style.textAlign = 'center';
    banner.style.fontFamily = "'Press Start 2P', monospace";
    banner.style.color = '#ffffff';
    banner.style.imageRendering = 'pixelated';

    var title = document.createElement('div');
    title.style.fontSize = '20px';
    title.style.marginBottom = '14px';
    title.style.lineHeight = '1.4';
    title.style.color = result.youWon ? '#7ff9e0' : '#ff9e2c';
    title.textContent = result.youWon
      ? tr('game.youWin', 'YOU WIN!')
      : tr('game.youLose', 'GAME OVER');

    var sub = document.createElement('div');
    sub.style.fontSize = '10px';
    sub.style.marginBottom = '20px';
    sub.style.lineHeight = '1.6';
    if (!result.youWon && result.winnerNickname) {
      // "winnerIs" is a template like "Winner: {name}" / "Gewënner: {name}".
      var tpl = tr('game.winnerIs', 'Winner: {name}');
      sub.textContent = tpl.indexOf('{name}') !== -1
        ? tpl.replace('{name}', result.winnerNickname)
        : tpl + ' ' + result.winnerNickname;
    } else if (result.youWon) {
      sub.textContent = '';
    } else {
      sub.textContent = '';
    }

    var btn = document.createElement('button');
    btn.textContent = tr('game.backToMenu', 'BACK TO MENU');
    btn.style.fontFamily = "'Press Start 2P', monospace";
    btn.style.fontSize = '10px';
    btn.style.padding = '10px 14px';
    btn.style.cursor = 'pointer';
    btn.style.color = '#1a1d2e';
    btn.style.background = '#7ff9e0';
    btn.style.border = '3px solid #1a1d2e';
    btn.style.borderRadius = '0';
    btn.addEventListener('mouseenter', function () {
      btn.style.background = '#1a1d2e';
      btn.style.color = '#7ff9e0';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = '#7ff9e0';
      btn.style.color = '#1a1d2e';
    });
    btn.addEventListener('click', function () {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
      returnToMenu();
    });

    banner.appendChild(title);
    if (sub.textContent) banner.appendChild(sub);
    banner.appendChild(btn);
    host.appendChild(banner);
  }

  // ---- input tick -------------------------------------------------------
  function sendInputTick() {
    if (!running) return;

    var state = (window.Input && typeof window.Input.getState === 'function')
      ? window.Input.getState()
      : { dx: 0, dy: 0, attack: false, throw: false, dash: false };

    var vim = (window.Input && typeof window.Input.consumeVimCommand === 'function')
      ? window.Input.consumeVimCommand()
      : null;

    inputSeq += 1;

    // Flat InputMsg shape — matches Go protocol.InputMsg json tags exactly.
    var payload = {
      seq: inputSeq,
      dx: state.dx || 0,
      dy: state.dy || 0,
      attack: !!state.attack,
      throw: !!state.throw,
      dash: !!state.dash,
      jump: !!state.jump,
      vim: vim || '',
    };

    if (window.Net && typeof window.Net.send === 'function' && window.Protocol) {
      window.Net.send(window.Protocol.INPUT, payload);
    }
  }

  // ---- render loop ------------------------------------------------------
  function renderFrame() {
    if (!running) return;

    // Interpolation fraction: how far we are from prevSnap toward lastSnap based
    // on how long ago each arrived. We render slightly in the past (about one
    // snapshot interval), which the recv-time delta naturally accounts for.
    var t = 1;
    if (prevSnap && lastSnap && lastSnap !== prevSnap) {
      var span = lastRecvAt - prevRecvAt;
      if (span > 0) {
        t = (now() - lastRecvAt) / span;
      }
      if (t < 0) t = 0;
      if (t > 1) t = 1;
    }

    var state = buildInterpolatedState(t);
    if (state && window.Render && typeof window.Render.drawFrame === 'function') {
      window.Render.drawFrame(state, localPlayerId);
    }

    rafId = requestAnimationFrame(renderFrame);
  }

  // ---- subscription management -----------------------------------------
  function subscribe(type, handler) {
    if (window.Net && typeof window.Net.on === 'function') {
      window.Net.on(type, handler);
      netHandlers.push({ type: type, handler: handler });
    }
  }

  function unsubscribeAll() {
    if (window.Net && typeof window.Net.off === 'function') {
      for (var i = 0; i < netHandlers.length; i++) {
        window.Net.off(netHandlers[i].type, netHandlers[i].handler);
      }
    }
    // If Net has no off(), the handlers are still guarded by the `running` flag
    // (they early-return once stopped), so stale subscriptions stay inert.
    netHandlers.length = 0;
  }

  // ---- public API -------------------------------------------------------
  function start(info) {
    if (running) stop();

    running = true;
    roomInfo = info || null;
    localPlayerId = null;
    prevSnap = null;
    lastSnap = null;
    prevRecvAt = 0;
    lastRecvAt = 0;
    inputSeq = 0;
    lastWindowsUntil = 0;
    townObstacles = null;
    townW = 0;
    townH = 0;

    // Resolve our id eagerly if App already knows it.
    resolveLocalPlayerId(null);

    // (Re)initialize the renderer against the game canvas.
    var canvas = document.getElementById('game-canvas');
    if (canvas && window.Render && typeof window.Render.init === 'function') {
      window.Render.init(canvas);
    }

    // Network subscriptions (guarded against a missing Protocol global).
    if (window.Protocol) {
      subscribe(window.Protocol.SNAPSHOT, onSnapshot);
      subscribe(window.Protocol.GAME_OVER, onGameOver);
    }

    // Kick off the loops.
    tickTimer = setInterval(sendInputTick, TICK_MS);
    rafId = requestAnimationFrame(renderFrame);
  }

  function stop() {
    running = false;

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }

    unsubscribeAll();

    // Clear the gag if it's still tinting the screen from this match.
    if (window.Gag && typeof window.Gag.deactivate === 'function') {
      window.Gag.deactivate();
    }

    prevSnap = null;
    lastSnap = null;
    roomInfo = null;
  }

  function isRunning() {
    return running;
  }

  return {
    start: start,
    stop: stop,
    isRunning: isRunning,
  };
})();

window.Game = Game;
