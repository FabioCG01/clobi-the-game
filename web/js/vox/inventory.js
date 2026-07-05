// vox/inventory.js -- global Inventory.
//
// Hotbar (9 slots) + backpack (27 slots) inventory for CLOBI CRAFT with
// 64-stacking, survival consumption and creative no-op semantics.
// Contract: ARCHITECTURE-3D.md §5.12.
//
//   Inventory.create(mode) -> inv        // mode: 'survival' | 'creative'
//   inv.hotbar   -> [{id,count}|null x9]
//   inv.backpack -> [{id,count}|null x27]
//   inv.selected -> 0..8;  inv.select(n)
//   inv.selectedBlock() -> id | 0
//   inv.add(id, n) -> leftover           // stacks to 64, hotbar then backpack
//   inv.consumeSelected()                // survival: -1 from selected; creative: no-op
//   inv.setSurvivalDefaults()            // empty bar (you earn your blocks)
//   inv.setCreativeDefaults()            // starter palette of pretty blocks
//   inv.serialize() -> plain JSON obj;  Inventory.deserialize(obj) -> inv
//   inv.onChange(fn)                     // HUD subscribes; fired on any mutation
//
// Extras (not pinned, used by Interact pick-block and the HUD panel):
//   inv.mode, inv.setMode(m), inv.setHotbarSlot(n,id,count),
//   inv.setBackpackSlot(n,id,count), inv.offChange(fn)
//
// Exposes exactly one global: window.Inventory
// Depends on globals: Blocks (optional; validates ids when present).

var Inventory = (function () {
  'use strict';

  // ---- constants ----
  var HOTBAR_SIZE = 9;
  var BACKPACK_SIZE = 27;
  var MAX_STACK = 64;

  // Creative starter bar (contract task pin): grass, dirt, stone, cobble,
  // planks, log, glass, brick, glowstone — by block KEY so we stay in sync
  // with the registry, with the §4 ids as fallback when Blocks is absent.
  var CREATIVE_DEFAULTS = [
    { key: 'grass', id: 1 },
    { key: 'dirt', id: 2 },
    { key: 'stone', id: 3 },
    { key: 'cobble', id: 4 },
    { key: 'planks', id: 7 },
    { key: 'log', id: 6 },
    { key: 'glass', id: 12 },
    { key: 'brick', id: 13 },
    { key: 'glowstone', id: 15 }
  ];

  // ---- helpers ----
  function validId(id) {
    id = id | 0;
    if (id <= 0 || id > 255) return 0;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      return Blocks.byId(id) ? id : 0;
    }
    return id;
  }

  function idForKey(key, fallbackId) {
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byKey) {
      var def = Blocks.byKey(key);
      if (def) return def.id;
    }
    return fallbackId;
  }

  function emptySlots(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = null;
    return a;
  }

  function sanitizeSlot(s) {
    if (!s || typeof s !== 'object') return null;
    var id = validId(s.id);
    if (!id) return null;
    var count = Math.floor(+s.count || 0);
    if (count < 1) return null;
    if (count > MAX_STACK) count = MAX_STACK;
    return { id: id, count: count };
  }

  // ---- factory ----
  function create(mode) {
    var listeners = [];

    var inv = {
      mode: mode === 'creative' ? 'creative' : 'survival',
      hotbar: emptySlots(HOTBAR_SIZE),
      backpack: emptySlots(BACKPACK_SIZE),
      selected: 0,

      // ---- selection ----
      select: function (n) {
        n = n | 0;
        if (n < 0) n = 0;
        if (n > HOTBAR_SIZE - 1) n = HOTBAR_SIZE - 1;
        if (n === inv.selected) return;
        inv.selected = n;
        fire();
      },

      selectedBlock: function () {
        var s = inv.hotbar[inv.selected];
        return s ? s.id : 0;
      },

      // ---- adding (stacks to 64; hotbar first, then backpack) ----
      add: function (id, n) {
        id = validId(id);
        var left = Math.floor(+n || 0);
        if (!id || left <= 0) return left > 0 ? left : 0;
        var before = left;

        left = stackInto(inv.hotbar, id, left);
        left = stackInto(inv.backpack, id, left);
        left = fillInto(inv.hotbar, id, left);
        left = fillInto(inv.backpack, id, left);

        if (left !== before) fire();
        return left;
      },

      // ---- placing consumption ----
      consumeSelected: function () {
        if (inv.mode === 'creative') return; // infinite blocks
        var s = inv.hotbar[inv.selected];
        if (!s) return;
        s.count -= 1;
        if (s.count <= 0) inv.hotbar[inv.selected] = null;
        fire();
      },

      // ---- default loadouts ----
      setSurvivalDefaults: function () {
        // survival starts with empty hands: the world provides
        inv.hotbar = emptySlots(HOTBAR_SIZE);
        inv.backpack = emptySlots(BACKPACK_SIZE);
        inv.selected = 0;
        fire();
      },

      setCreativeDefaults: function () {
        inv.hotbar = emptySlots(HOTBAR_SIZE);
        for (var i = 0; i < CREATIVE_DEFAULTS.length && i < HOTBAR_SIZE; i++) {
          var d = CREATIVE_DEFAULTS[i];
          var id = validId(idForKey(d.key, d.id));
          if (id) inv.hotbar[i] = { id: id, count: 1 };
        }
        inv.backpack = emptySlots(BACKPACK_SIZE);
        inv.selected = 0;
        fire();
      },

      // ---- persistence (plain JSON, deep-copied) ----
      serialize: function () {
        return {
          mode: inv.mode,
          selected: inv.selected,
          hotbar: inv.hotbar.map(copySlot),
          backpack: inv.backpack.map(copySlot)
        };
      },

      // ---- change subscription ----
      onChange: function (fn) {
        if (typeof fn === 'function') listeners.push(fn);
      },

      offChange: function (fn) {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },

      // ---- extras (not pinned) ----
      setMode: function (m) {
        var next = m === 'creative' ? 'creative' : 'survival';
        if (next === inv.mode) return;
        inv.mode = next; // gamemode switches KEEP the inventory (contract §5.13)
        fire();
      },

      setHotbarSlot: function (n, id, count) {
        n = n | 0;
        if (n < 0 || n >= HOTBAR_SIZE) return;
        inv.hotbar[n] = sanitizeSlot({ id: id, count: count == null ? 1 : count });
        fire();
      },

      setBackpackSlot: function (n, id, count) {
        n = n | 0;
        if (n < 0 || n >= BACKPACK_SIZE) return;
        inv.backpack[n] = sanitizeSlot({ id: id, count: count == null ? 1 : count });
        fire();
      }
    };

    // ---- private: stacking passes ----
    function stackInto(slots, id, left) {
      for (var i = 0; i < slots.length && left > 0; i++) {
        var s = slots[i];
        if (s && s.id === id && s.count < MAX_STACK) {
          var take = Math.min(MAX_STACK - s.count, left);
          s.count += take;
          left -= take;
        }
      }
      return left;
    }

    function fillInto(slots, id, left) {
      for (var i = 0; i < slots.length && left > 0; i++) {
        if (!slots[i]) {
          var take = Math.min(MAX_STACK, left);
          slots[i] = { id: id, count: take };
          left -= take;
        }
      }
      return left;
    }

    function copySlot(s) {
      return s ? { id: s.id, count: s.count } : null;
    }

    function fire() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](inv); } catch (e) { /* a HUD bug never blocks play */ }
      }
    }

    // starter contents per mode
    if (inv.mode === 'creative') inv.setCreativeDefaults();
    else inv.setSurvivalDefaults();

    return inv;
  }

  // ---- static: deserialize (tolerant of hand-edited / stale saves) ----
  function deserialize(obj) {
    var inv = create(obj && obj.mode === 'creative' ? 'creative' : 'survival');
    if (!obj || typeof obj !== 'object') return inv;

    var i;
    if (Array.isArray(obj.hotbar)) {
      for (i = 0; i < HOTBAR_SIZE; i++) inv.hotbar[i] = sanitizeSlot(obj.hotbar[i]);
    }
    if (Array.isArray(obj.backpack)) {
      for (i = 0; i < BACKPACK_SIZE; i++) inv.backpack[i] = sanitizeSlot(obj.backpack[i]);
    }
    var sel = obj.selected | 0;
    inv.selected = (sel >= 0 && sel < HOTBAR_SIZE) ? sel : 0;
    return inv;
  }

  // ---- module export ----
  var Inventory = {
    create: create,
    deserialize: deserialize,
    HOTBAR_SIZE: HOTBAR_SIZE,
    BACKPACK_SIZE: BACKPACK_SIZE,
    MAX_STACK: MAX_STACK
  };
  return Inventory;
})();

window.Inventory = Inventory;
