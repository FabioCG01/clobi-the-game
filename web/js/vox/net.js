// net.js — WebSocket game-protocol client for CLOBI CRAFT multiplayer.
// Exactly one global: window.Net (contract §4.1, wire protocol §3.3).
//
// Opens ONE WebSocket to `(wss|ws)://location.host/ws/room`, sends the
// `hello` handshake as soon as the socket opens, and resolves connect()'s
// Promise when the server answers with `welcome` (rejects on `error`/`kick`
// before welcome, or after an 8s timeout). After that, server->client frames
// are dispatched through a small pub-sub keyed by the message's `t` field —
// callers subscribe with Net.on(type, fn). `close` is a SYNTHETIC event this
// module emits locally (never a server message type) when the socket is
// gone for good (after the single reconnect attempt also fails, or on a
// clean/explicit disconnect the caller doesn't get 'close' — see below).
//
// Reconnect: an ABNORMAL close (the server dropped us, network blip — i.e.
// anything that wasn't triggered by our own disconnect()) waits 2s, reopens
// with the same roomId/pin/skin/mode, and re-sends hello. A fresh 'welcome'
// on that reconnected socket is re-emitted as a 'welcome' event (Game
// listens for this to rebuild from the new deltas snapshot). If the
// reconnect attempt itself fails or errors, THIS module gives up (no further
// retries) and emits the synthetic 'close' event so Game can return to the
// menu with a toast. disconnect() is an intentional, clean close: it never
// reconnects and never emits 'close' (the caller already knows it hung up).
//
// send(type,obj) queues while CONNECTING (flushed on open) and silently
// drops while CLOSING/CLOSED. sendMove(state) throttles internally to 10 Hz
// AND skips sends when nothing actually changed since the last send, per
// §3.3's "move ... throttle 10/s client" + the bandwidth note in §4.1.
//
// Depends on nothing at file-eval time (guards every optional lookup with
// typeof); reads Store.getToken() only inside connect(), never at load time,
// so file order relative to store.js doesn't matter for correctness (store.js
// loads first per the house script order regardless).

var Net = (function () {
  'use strict';

  // ---- constants --------------------------------------------------------

  var HELLO_TIMEOUT_MS = 8000;
  var RECONNECT_DELAY_MS = 2000;
  var MOVE_HZ = 10;
  var MOVE_INTERVAL_MS = 1000 / MOVE_HZ;
  var MOVE_EPS_POS = 0.001;     // metres
  var MOVE_EPS_ANG = 0.001;     // radians

  // ---- small helpers ------------------------------------------------------

  function noop() {}

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function wsURL() {
    var proto = (location.protocol === 'https:') ? 'wss' : 'ws';
    return proto + '://' + location.host + '/ws/room';
  }

  // ---- pub-sub ------------------------------------------------------------

  var handlers = Object.create(null);

  function on(type, fn) {
    if (typeof fn !== 'function') return;
    (handlers[type] || (handlers[type] = [])).push(fn);
  }

  function off(type, fn) {
    var list = handlers[type];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  function emit(type, payload) {
    var list = handlers[type];
    if (!list || !list.length) return;
    // Snapshot: a handler may call off()/on() during dispatch.
    var snap = list.slice();
    for (var i = 0; i < snap.length; i++) {
      try { snap[i](payload); } catch (e) {
        if (typeof console !== 'undefined') console.error('Net: listener for "' + type + '" threw', e);
      }
    }
  }

  // ---- module state ---------------------------------------------------------

  var ws = null;
  var connectParams = null;         // {roomId, pin, skinRec, mode, nick} — kept for reconnect
  var intentionalClose = false;     // true only while disconnect() is tearing down
  var reconnecting = false;         // true while the single reconnect attempt is in flight
  var reconnectedOnce = false;      // this connection is itself a reconnect (no further retries)
  var helloTimer = 0;
  var reconnectTimer = 0;
  var sendQueue = [];                // frames queued while CONNECTING

  var youId = null;
  var hostName = null;

  // sendMove throttling/dedup state
  var lastMoveSentAt = 0;
  var lastMoveSnapshot = null;      // {p:[x,y,z], yaw, pitch, anim:{...}}

  // ---- connection helpers ----------------------------------------------------

  function clearHelloTimer() {
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = 0; }
  }
  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
  }

  function resetPerConnectionState() {
    youId = null;
    hostName = null;
    lastMoveSentAt = 0;
    lastMoveSnapshot = null;
    sendQueue.length = 0;
  }

  function buildHello(params) {
    var hello = { t: 'hello', roomId: params.roomId, mode: params.mode };
    var token = null;
    try { token = (typeof Store !== 'undefined' && Store.getToken) ? Store.getToken() : null; } catch (e) { token = null; }
    if (token) {
      hello.token = token;
    } else if (params.nick) {
      hello.nick = params.nick;
    }
    if (params.pin) hello.pin = params.pin;
    if (params.skinRec && params.skinRec.png) {
      hello.skin = { model: params.skinRec.model === 'slim' ? 'slim' : 'classic', png: params.skinRec.png };
    }
    return hello;
  }

  function rawSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function flushQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    var q = sendQueue;
    sendQueue = [];
    for (var i = 0; i < q.length; i++) rawSend(q[i]);
  }

  // Opens a fresh socket for `params` and wires it up. `isReconnectAttempt`
  // marks this socket as the (only) automatic retry — if IT also fails, we
  // give up entirely instead of scheduling yet another attempt.
  function openSocket(params, isReconnectAttempt, resolve, reject) {
    resetPerConnectionState();
    intentionalClose = false;
    reconnectedOnce = !!isReconnectAttempt;

    var socket;
    try {
      socket = new WebSocket(wsURL());
    } catch (e) {
      if (reject) reject(e);
      if (isReconnectAttempt) emit('close', { reason: 'reconnect-failed' });
      return;
    }
    ws = socket;

    var settled = false; // whether the connect() promise has been resolved/rejected

    function settleResolve(welcome) {
      if (settled) return;
      settled = true;
      clearHelloTimer();
      if (resolve) resolve(welcome);
    }
    function settleReject(err) {
      if (settled) return;
      settled = true;
      clearHelloTimer();
      if (reject) reject(err);
    }

    socket.onopen = function () {
      rawSend(buildHello(params));
      flushQueue();
      clearHelloTimer();
      helloTimer = setTimeout(function () {
        if (!settled) {
          settleReject(new Error('Connection timed out.'));
          try { socket.close(); } catch (e) { /* ignore */ }
        }
      }, HELLO_TIMEOUT_MS);
    };

    socket.onmessage = function (ev) {
      var msg = safeParse(ev.data);
      if (!msg || typeof msg.t !== 'string') return;
      var type = msg.t;

      if (type === 'welcome') {
        youId = msg.youId != null ? msg.youId : null;
        hostName = msg.host != null ? msg.host : null;
        if (!settled) {
          settleResolve(msg);
        } else if (reconnectedOnce) {
          // Reconnect succeeded: re-emit 'welcome' so Game rebuilds from the
          // fresh deltas snapshot (per contract §4.1).
          emit('welcome', msg);
        }
        return;
      }
      if (type === 'error') {
        if (!settled) { settleReject(new Error((msg && msg.message) || 'Server error.')); return; }
        emit('error', msg);
        return;
      }
      if (type === 'kick') {
        if (!settled) { settleReject(new Error((msg && msg.reason) || 'Kicked.')); return; }
        emit('kick', msg);
        return;
      }
      if (type === 'host') {
        hostName = msg.name != null ? msg.name : hostName;
      }
      emit(type, msg);
    };

    socket.onerror = function () {
      if (!settled) {
        settleReject(new Error('Connection error.'));
      }
      // onclose always follows onerror for a WebSocket; reconnect logic
      // lives there so we don't double-handle the failure.
    };

    socket.onclose = function (ev) {
      clearHelloTimer();
      var wasIntentional = intentionalClose;
      var wasThisSocket = (ws === socket);
      if (wasThisSocket) ws = null;

      if (!settled) {
        // Closed before we ever got a welcome/error/kick — treat as a
        // rejection of the connect() promise; no reconnect attempt from here
        // (the caller's initial connect() failed outright).
        settleReject(new Error('Connection closed before joining.'));
        return;
      }

      if (wasIntentional) {
        // disconnect() called — clean, no reconnect, no synthetic event.
        return;
      }

      if (reconnectedOnce) {
        // This socket WAS itself the one reconnect attempt and it also died
        // — give up for good.
        emit('close', { reason: 'reconnect-failed', code: ev ? ev.code : undefined });
        return;
      }

      // Abnormal close of an established (post-welcome) connection: try
      // exactly once more after a short backoff.
      if (reconnecting) return; // already scheduled (defensive; shouldn't happen)
      reconnecting = true;
      clearReconnectTimer();
      reconnectTimer = setTimeout(function () {
        reconnectTimer = 0;
        reconnecting = false;
        openSocket(params, true, null, null);
      }, RECONNECT_DELAY_MS);
    };
  }

  // ---- public: connect / disconnect ------------------------------------------

  function connect(opts) {
    opts = opts || {};
    var params = {
      roomId: opts.roomId,
      pin: opts.pin || null,
      skinRec: opts.skinRec || null,
      mode: (opts.mode === 'creative') ? 'creative' : 'survival',
      nick: opts.nick || null
    };
    connectParams = params;
    clearReconnectTimer();
    reconnecting = false;
    return new Promise(function (resolve, reject) {
      openSocket(params, false, resolve, reject);
    });
  }

  function disconnect() {
    intentionalClose = true;
    clearReconnectTimer();
    clearHelloTimer();
    reconnecting = false;
    reconnectedOnce = false;
    connectParams = null;
    if (ws) {
      try { ws.close(1000, 'client disconnect'); } catch (e) { /* ignore */ }
    }
    ws = null;
    resetPerConnectionState();
  }

  // ---- public: send -----------------------------------------------------------

  function send(type, obj) {
    if (!type) return;
    var frame = { t: type };
    if (obj) {
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) frame[k] = obj[k];
    }
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      return; // silently dropped
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      sendQueue.push(frame);
      return;
    }
    rawSend(frame); // OPEN
  }

  // Cheap shallow-ish compare for the small move-state object; avoids
  // sending redundant frames when the player hasn't actually moved/looked.
  function moveChanged(a, b) {
    if (!a || !b) return true;
    var pa = a.p || [0, 0, 0], pb = b.p || [0, 0, 0];
    if (Math.abs(pa[0] - pb[0]) > MOVE_EPS_POS) return true;
    if (Math.abs(pa[1] - pb[1]) > MOVE_EPS_POS) return true;
    if (Math.abs(pa[2] - pb[2]) > MOVE_EPS_POS) return true;
    if (Math.abs((a.yaw || 0) - (b.yaw || 0)) > MOVE_EPS_ANG) return true;
    if (Math.abs((a.pitch || 0) - (b.pitch || 0)) > MOVE_EPS_ANG) return true;
    var aa = a.anim || {}, ba = b.anim || {};
    if (Math.abs((aa.swing || 0) - (ba.swing || 0)) > MOVE_EPS_POS) return true;
    if (!!aa.crouch !== !!ba.crouch) return true;
    if (!!aa.fly !== !!ba.fly) return true;
    return false;
  }

  function cloneMoveState(state) {
    var p = state.p || [0, 0, 0];
    var anim = state.anim || {};
    return {
      p: [p[0], p[1], p[2]],
      yaw: state.yaw || 0,
      pitch: state.pitch || 0,
      anim: { swing: anim.swing || 0, crouch: !!anim.crouch, fly: !!anim.fly }
    };
  }

  function sendMove(state) {
    if (!state) return;
    var t = nowMs();
    if (t - lastMoveSentAt < MOVE_INTERVAL_MS) return;
    if (!moveChanged(lastMoveSnapshot, state)) return;
    var snap = cloneMoveState(state);
    lastMoveSentAt = t;
    lastMoveSnapshot = snap;
    send('move', snap);
  }

  // ---- public API -------------------------------------------------------------

  return {
    connect: connect,
    disconnect: disconnect,
    send: send,
    sendMove: sendMove,
    on: on,
    off: off,

    get isConnected() { return !!ws && ws.readyState === WebSocket.OPEN; },
    get youId() { return youId; },
    get hostName() { return hostName; }
  };
})();

window.Net = Net;
