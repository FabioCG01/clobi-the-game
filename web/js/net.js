// net.js — WebSocket client to the Go server's /ws endpoint. Single global: Net.
//
// Contract:
//   Net.connect(url?)          open the socket (defaults to ws(s)://<host>/ws)
//   Net.send(type, payload)    send a JSON Envelope {type, payload}
//   Net.on(type, handler)      register handler(payload) for an incoming type
//   Net.off(type, handler?)    remove one handler (or all handlers for a type)
//   Net.onOpen(fn)             callback fired when the socket opens
//   Net.onClose(fn)            callback fired when the socket closes
//   Net.isOpen()               -> bool
//   Net.disconnect()           close and stop auto-reconnect
//
// Incoming text frames are parsed as JSON {type, payload} and dispatched to the
// handlers registered for that type. Auto-reconnect (with capped backoff) is on
// while connected; outbound messages sent before the socket is open are queued
// and flushed on (re)connect.
//
// No frameworks, no ES modules — this file assigns exactly one global.

var Net = (function () {
  var ws = null;
  var url = null;
  var autoReconnect = true;
  var reconnectTimer = null;
  var reconnectDelay = 1000;       // ms, grows with backoff up to a cap
  var RECONNECT_BASE = 1000;
  var RECONNECT_MAX = 8000;

  // handlers: message-type string -> array of handler functions
  var handlers = Object.create(null);
  var openCbs = [];
  var closeCbs = [];

  // frames sent before the socket is open are queued and flushed on open
  var outQueue = [];

  // Build the default WebSocket URL: same host that served the page, /ws path,
  // upgraded to wss: when the page itself is served over https:.
  function defaultUrl() {
    var loc = window.location;
    var proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    var host = loc.host || (loc.hostname + (loc.port ? ':' + loc.port : ''));
    return proto + '//' + host + '/ws';
  }

  function reportErr(e) {
    if (typeof console !== 'undefined' && console.error) {
      console.error('[Net]', e);
    }
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (!autoReconnect || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      open();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  }

  function flushQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (outQueue.length) {
      var frame = outQueue.shift();
      try {
        ws.send(frame);
      } catch (err) {
        // put it back and stop; retried on the next flush
        outQueue.unshift(frame);
        break;
      }
    }
  }

  function dispatch(type, payload) {
    var list = handlers[type];
    if (!list || !list.length) return;
    // iterate a copy so handlers may add/remove during dispatch
    var snap = list.slice();
    for (var i = 0; i < snap.length; i++) {
      try { snap[i](payload); } catch (e) { reportErr(e); }
    }
  }

  function open() {
    clearReconnect();
    if (!url) url = defaultUrl();

    // Avoid stacking sockets if one is already live or connecting.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      ws = new WebSocket(url);
    } catch (err) {
      // Construction can throw on a malformed URL; back off and retry.
      ws = null;
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = RECONNECT_BASE; // reset backoff on a clean connect
      flushQueue();
      for (var i = 0; i < openCbs.length; i++) {
        try { openCbs[i](); } catch (e) { reportErr(e); }
      }
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (err) {
        return; // ignore non-JSON / malformed frames
      }
      if (!msg || typeof msg.type !== 'string') return;
      dispatch(msg.type, msg.payload);
    };

    ws.onclose = function () {
      ws = null;
      for (var i = 0; i < closeCbs.length; i++) {
        try { closeCbs[i](); } catch (e) { reportErr(e); }
      }
      scheduleReconnect();
    };

    ws.onerror = function () {
      // The browser fires onclose right after onerror; let onclose drive the
      // reconnect. Swallow here so it does not surface as an uncaught error.
    };
  }

  return {
    // Open (or re-open) the socket. Pass a URL to override the default /ws target.
    connect: function (u) {
      if (u) url = u;
      autoReconnect = true;
      open();
      return this;
    },

    // Close the socket and stop auto-reconnecting.
    disconnect: function () {
      autoReconnect = false;
      clearReconnect();
      if (ws) {
        try { ws.close(); } catch (e) { /* ignore */ }
        ws = null;
      }
      return this;
    },

    // Send a JSON Envelope {type, payload}. Missing payload becomes {}.
    send: function (type, payload) {
      var frame = JSON.stringify({ type: type, payload: payload === undefined ? {} : payload });
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(frame);
        } catch (err) {
          outQueue.push(frame);
        }
      } else {
        // Not connected yet — queue and (re)open if auto-reconnect is enabled.
        outQueue.push(frame);
        if (autoReconnect) open();
      }
      return this;
    },

    // Register handler(payload) for an incoming message type.
    on: function (type, handler) {
      if (typeof handler !== 'function') return this;
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(handler);
      return this;
    },

    // Remove a specific handler, or every handler for a type when omitted.
    off: function (type, handler) {
      var list = handlers[type];
      if (!list) return this;
      if (!handler) {
        delete handlers[type];
        return this;
      }
      var idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
      if (!list.length) delete handlers[type];
      return this;
    },

    onOpen: function (fn) {
      if (typeof fn === 'function') openCbs.push(fn);
      return this;
    },

    onClose: function (fn) {
      if (typeof fn === 'function') closeCbs.push(fn);
      return this;
    },

    isOpen: function () {
      return !!ws && ws.readyState === WebSocket.OPEN;
    }
  };
})();

window.Net = Net;
