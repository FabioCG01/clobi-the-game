// friends.js -- global Friends.
//
// The friend system (Part II, ARCHITECTURE-MP.md §4.4): a modal reachable
// from the menu's corner Friends button AND from WorldSelect's world-members
// picker, showing three lists (friends / incoming with Accept·Decline /
// outgoing with Cancel) plus an add-by-username field. Backed by the thin
// Store wrappers (§4.6): Store.friendsList/friendsRequest/friendsAccept/
// friendsRemove. Polls the three lists every 8s ONLY while the modal is open
// (cleared the instant it closes, detected via a MutationObserver on
// #modal-root rather than requiring a close-callback from the shared modal
// helpers).
//
// Friends.refreshBadge() is the badge-count PROVIDER: it resolves the
// pending-incoming count (a Promise<number>) but does not touch any DOM
// itself -- menu.js owns and paints its own corner badge, calling this and
// applying the result (same separation as Store.isAdmin()/Store.getUsername()
// feeding menu.js's account corner button). Whenever a request is sent,
// accepted, removed, or the modal closes, this file dispatches the
// 'clobi:friends-changed' DOM event so menu.js's badge listener (a different
// closure -- there is no direct call path) can refresh, mirroring the
// existing 'clobi:auth-expired' cross-module pattern already used by Store.
//
// Modal chrome duplicates menu.js's exact structural + CSS-class pattern
// (#modal-root, .pixmodal/.modal-overlay/.form-row/.modal-actions/.pixbtn*/
// .pixinput) for the same reason worldselect.js does: each file is its own
// IIFE/global per the house rules, so there is no shared import to reuse.
//
// Exposes exactly one global: window.Friends
// Depends on globals (typeof-guarded): I18n, Store, Menu (for its toast), Sound.

var Friends = (function () {
  'use strict';

  var FRIENDS_POLL_MS = 8000;
  var pollId = 0;

  // ---- i18n shortcut ----------------------------------------------------
  function t(key, fallback) {
    if (typeof I18n !== 'undefined' && I18n.t) return I18n.t(key, fallback);
    return fallback != null ? fallback : key;
  }

  // ---- tiny DOM helpers (mirrors menu.js's el()/appendChildren()) -------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, v);
        }
      }
    }
    appendChildren(node, children);
    return node;
  }
  function appendChildren(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) { children.forEach(function (c) { appendChildren(node, c); }); }
    else if (typeof children === 'string' || typeof children === 'number') { node.appendChild(document.createTextNode(String(children))); }
    else if (children instanceof Node) { node.appendChild(children); }
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
  function byId(id) { return document.getElementById(id); }
  function click() { if (window.Sound && Sound.play) { try { Sound.play('click'); } catch (e) { /* ignore */ } } }

  // Reuse Menu's existing toast UI (same look, avoids a second toast host).
  function toast(msg, kind) {
    if (typeof Menu !== 'undefined' && Menu.toast) { Menu.toast(msg, kind); return; }
    try { console.warn('[Friends]', msg); } catch (e) { /* ignore */ }
  }

  // Small icon set matching menu.js's chunky/stroke-only style.
  var ICON_PATHS = {
    x: ['M6 6 L18 18', 'M18 6 L6 18'],
    plus: ['M12 5 V19', 'M5 12 H19'],
    check: ['M5 13 L10 18 L19 6']
  };
  function icon(name, size) {
    var s = size || 12;
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.6');
    svg.setAttribute('stroke-linecap', 'square');
    svg.setAttribute('stroke-linejoin', 'miter');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'inline-block';
    svg.style.verticalAlign = 'middle';
    (ICON_PATHS[name] || []).forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // =========================================================================
  // Modal infrastructure -- duplicates menu.js's exact structural/CSS pattern,
  // see worldselect.js's identical block for the full rationale.
  // =========================================================================
  function modalHost() {
    var host = byId('modal-root');
    if (!host) { host = el('div', { id: 'modal-root' }); document.body.appendChild(host); }
    return host;
  }
  function openModal(node) {
    closeAnyModal();
    var overlay = el('div', { class: 'modal-overlay' });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeAnyModal(); });
    overlay.appendChild(node);
    var onKey = function (e) { if (e.key === 'Escape') closeAnyModal(); };
    overlay._onKey = onKey;
    document.addEventListener('keydown', onKey);
    modalHost().appendChild(overlay);
    return overlay;
  }
  function closeAnyModal() {
    var host = byId('modal-root'); if (!host) return;
    while (host.firstChild) {
      var ov = host.firstChild;
      if (ov._onKey) document.removeEventListener('keydown', ov._onKey);
      host.removeChild(ov);
    }
  }
  function modalShell(titleText, bodyNodes, opts) {
    opts = opts || {};
    var closeBtn = el('button', { class: 'modal-x', type: 'button', title: t('common.close', 'Close'), onclick: closeAnyModal }, [icon('x', 14)]);
    return el('div', { class: 'pixmodal' + (opts.wide ? ' pixmodal-wide' : '') }, [
      el('div', { class: 'pixmodal-head' }, [el('h3', { class: 'pixmodal-title', text: titleText }), closeBtn]),
      el('div', { class: 'pixmodal-body' }, bodyNodes)
    ]);
  }
  function formRow(labelText, control, hintText) {
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'form-label', text: labelText }), control,
      hintText ? el('div', { class: 'form-hint', text: hintText }) : null
    ]);
  }

  // Cross-module notification: menu.js's corner badge listens for this (its
  // own closure has no direct call path into this one) -- same pattern as
  // the existing 'clobi:auth-expired' event Store/menu.js already use.
  function notifyChanged() {
    try {
      var ev = (typeof Event === 'function') ? new Event('clobi:friends-changed') : null;
      if (ev && window.dispatchEvent) window.dispatchEvent(ev);
    } catch (e) { /* ignore */ }
  }

  function startPolling() {
    stopPolling();
    pollId = setInterval(refreshLists, FRIENDS_POLL_MS);
  }
  function stopPolling() {
    if (pollId) { clearInterval(pollId); pollId = 0; }
  }

  // ---- list rendering -----------------------------------------------------
  function emptyTextFor(kind) {
    if (kind === 'incoming') return t('friends.noIncoming', 'No pending requests.');
    if (kind === 'outgoing') return t('friends.noOutgoing', 'No sent requests waiting.');
    return t('friends.noFriends', 'No friends yet — add one above!');
  }

  function renderList(container, names, kind) {
    if (!container) return;
    clear(container);
    if (!names || !names.length) {
      container.appendChild(el('p', { class: 'fr-empty', text: emptyTextFor(kind) }));
      return;
    }
    names.forEach(function (name) {
      var row = el('div', { class: 'fr-row' }, [el('span', { class: 'fr-name', text: name })]);
      if (kind === 'incoming') {
        row.appendChild(el('button', {
          class: 'pixbtn pixbtn-primary fr-btn-sm', type: 'button',
          onclick: function () { click(); acceptRequest(name); }
        }, [icon('check', 11), el('span', { text: t('friends.accept', 'Accept') })]));
        row.appendChild(el('button', {
          class: 'pixbtn-ghost fr-btn-sm', type: 'button',
          onclick: function () { click(); removeFriend(name); }
        }, [icon('x', 11), el('span', { text: t('friends.decline', 'Decline') })]));
      } else if (kind === 'outgoing') {
        row.appendChild(el('button', {
          class: 'pixbtn-ghost fr-btn-sm', type: 'button',
          onclick: function () { click(); removeFriend(name); }
        }, [icon('x', 11), el('span', { text: t('friends.cancel', 'Cancel') })]));
      } else {
        row.appendChild(el('button', {
          class: 'pixbtn-ghost fr-btn-sm fr-btn-danger', type: 'button',
          onclick: function () { click(); removeFriend(name); }
        }, [icon('x', 11), el('span', { text: t('friends.remove', 'Remove') })]));
      }
      container.appendChild(row);
    });
  }

  function refreshLists() {
    if (typeof Store === 'undefined' || !Store.friendsList) return;
    Store.friendsList().then(function (d) {
      renderList(byId('fr-list-friends'), d.friends, 'friend');
      renderList(byId('fr-list-incoming'), d.incoming, 'incoming');
      renderList(byId('fr-list-outgoing'), d.outgoing, 'outgoing');
    }).catch(function () { /* transient — the modal keeps showing the last-known lists */ });
  }

  function acceptRequest(name) {
    Store.friendsAccept(name).then(function () {
      toast(t('friends.accepted', '{name} is now your friend!').replace('{name}', name), 'info');
      refreshLists();
      notifyChanged();
    }).catch(function (err) {
      toast((err && err.message) || t('friends.actionFail', 'Something went wrong.'), 'danger');
    });
  }

  // Handles decline (incoming), cancel (outgoing) and unfriend (accepted) —
  // all the same server endpoint per contract §3.2 ("decline pending OR
  // unfriend accepted").
  function removeFriend(name) {
    Store.friendsRemove(name).then(function () {
      refreshLists();
      notifyChanged();
    }).catch(function (err) {
      toast((err && err.message) || t('friends.actionFail', 'Something went wrong.'), 'danger');
    });
  }

  // ---- modal body -----------------------------------------------------------
  function buildBody() {
    var addInput = el('input', { class: 'pixinput', type: 'text', maxlength: '24', autocomplete: 'off', spellcheck: 'false', placeholder: t('friends.addPh', 'username') });
    var addErr = el('div', { class: 'form-err', text: '' });
    var addBtn = el('button', { class: 'pixbtn pixbtn-primary', type: 'button' }, [icon('plus', 12), el('span', { text: t('friends.add', 'Add friend') })]);

    function doAdd() {
      var name = (addInput.value || '').trim();
      if (!name) return;
      addErr.textContent = '';
      addBtn.disabled = true; addBtn.classList.add('pixbtn-disabled');
      Store.friendsRequest(name).then(function () {
        addInput.value = '';
        addBtn.disabled = false; addBtn.classList.remove('pixbtn-disabled');
        toast(t('friends.requestSent', 'Friend request sent!'), 'info');
        refreshLists();
        notifyChanged();
      }).catch(function (err) {
        addBtn.disabled = false; addBtn.classList.remove('pixbtn-disabled');
        addErr.textContent = (err && err.message) || t('friends.requestFail', 'Could not send that request.');
      });
    }
    addBtn.addEventListener('click', function () { click(); doAdd(); });
    addInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });

    var friendsList = el('div', { id: 'fr-list-friends', class: 'fr-list' });
    var incomingList = el('div', { id: 'fr-list-incoming', class: 'fr-list' });
    var outgoingList = el('div', { id: 'fr-list-outgoing', class: 'fr-list' });

    return [
      el('div', { class: 'fr-section' }, [
        formRow(t('friends.addLabel', 'Add a friend'), el('div', { class: 'fr-inline-row' }, [addInput, addBtn])),
        addErr
      ]),
      el('div', { class: 'fr-section' }, [
        el('h4', { class: 'fr-section-title', text: t('friends.incoming', 'Incoming requests') }),
        incomingList
      ]),
      el('div', { class: 'fr-section' }, [
        el('h4', { class: 'fr-section-title', text: t('friends.outgoing', 'Sent requests') }),
        outgoingList
      ]),
      el('div', { class: 'fr-section' }, [
        el('h4', { class: 'fr-section-title', text: t('friends.myFriends', 'Friends') }),
        friendsList
      ]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'pixbtn pixbtn-primary', type: 'button', onclick: closeAnyModal }, [el('span', { text: t('common.close', 'Close') })])
      ])
    ];
  }

  // ---- public: showModal ----------------------------------------------------
  function showModal() {
    if (typeof Store === 'undefined' || !Store.friendsList) {
      toast(t('friends.unavailable', 'Friends are unavailable right now.'), 'warn');
      return;
    }
    injectStyles();
    var overlay = openModal(modalShell(t('friends.title', 'Friends'), buildBody(), { wide: true }));
    refreshLists();
    startPolling();

    // The shared modal helpers have no close-callback, so watch #modal-root
    // directly: the instant our overlay stops being a child (Escape, backdrop
    // click, or the Close button — all funnel through closeAnyModal), stop
    // polling and let menu.js's badge know the pending count may have changed.
    var host = byId('modal-root');
    if (host && typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function () {
        if (!overlay.parentNode) {
          stopPolling();
          notifyChanged();
          mo.disconnect();
        }
      });
      mo.observe(host, { childList: true });
    }
  }

  // ---- styles (self-injected, one-time) --------------------------------------
  function injectStyles() {
    if (byId('friends-styles')) return;
    var css = [
      '.fr-section{margin-bottom:6px;}',
      '.fr-section-title{margin:0 0 8px;font-size:10px;color:#7ff9e0;letter-spacing:1px;}',
      '.fr-inline-row{display:flex;gap:8px;}',
      '.fr-inline-row .pixinput{flex:1;}',
      '.fr-list{display:flex;flex-direction:column;gap:6px;max-height:150px;overflow-y:auto;}',
      '.fr-row{display:flex;align-items:center;justify-content:space-between;gap:8px;background:#10121f;border:2px solid #3a3f5c;padding:8px 10px;flex-wrap:wrap;}',
      '.fr-name{font-size:10px;color:#cfd4e8;}',
      '.fr-empty{font-size:9px;color:#646b8a;line-height:1.7;margin:0;padding:6px 0;}',
      '.fr-btn-sm{font-size:8px;padding:6px 9px;}',
      '.fr-btn-danger{color:#ff6b6b;border-color:#ff6b6b;}',
      '.fr-btn-danger:hover{background:#ff6b6b;color:#1a1d2e;}'
    ].join('\n');
    var style = el('style', { id: 'friends-styles' });
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- public API -------------------------------------------------------------
  return {
    showModal: showModal,
    // Badge-count PROVIDER: resolves the pending-incoming count. Never
    // touches DOM itself — menu.js owns and paints its own corner badge.
    refreshBadge: function () {
      if (typeof Store === 'undefined' || !Store.friendsList) return Promise.resolve(0);
      return Store.friendsList().then(function (d) {
        return (d && d.incoming && d.incoming.length) || 0;
      }).catch(function () { return 0; });
    }
  };
})();

window.Friends = Friends;
