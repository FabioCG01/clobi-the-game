// vox/inventory.js -- global Inventory.
//
// Hotbar (9 slots) + backpack (27 slots) inventory for CLOBI CRAFT with
// 64-stacking, survival consumption and creative no-op semantics.
// Contract: ARCHITECTURE-3D.md §5.12, extended by ARCHITECTURE-COMBAT.md §4.
//
//   Inventory.create(mode) -> inv        // mode: 'survival' | 'creative'
//   inv.hotbar   -> [{id,count,kind}|null x9]
//   inv.backpack -> [{id,count,kind}|null x27]
//   inv.selected -> 0..8;  inv.select(n)
//   inv.selectedBlock() -> id | 0
//   inv.add(id, n) -> leftover           // stacks to 64 (items cap at 1), hotbar then backpack
//   inv.consumeSelected()                // survival: -1 from selected; creative: no-op
//   inv.setSurvivalDefaults()            // empty bar (you earn your blocks)
//   inv.setCreativeDefaults()            // starter palette of pretty blocks
//   inv.serialize() -> plain JSON obj;  Inventory.deserialize(obj) -> inv
//   inv.onChange(fn)                     // HUD subscribes; fired on any mutation
//
// COMBAT §4 additions: a slot is now `{id, count, kind}` where `kind`
// defaults to 'block' for a numeric id and 'item' for a string id (every
// pre-Part-III caller that only ever set numeric ids keeps working
// unchanged, since `kind` is always inferred correctly when omitted).
// Item-kind stacks NEVER exceed count=1 when the id is Items-registered gear
// (tools/armor/buckets don't stack, per contract §4's stated rationale) --
// enforced everywhere a slot is created or added into. A kind:'item' id that
// Items does NOT recognize (currently just Craft's plain 'stick' material,
// which has no durability/damage/armor -- it's crafting fodder, not gear)
// stacks normally to 64 like a block, since the cap's entire purpose is
// "equippable single-use gear doesn't stack," which doesn't describe sticks.
//
//   inv.armor -> {helmet, chest, legs, boots}   // each: item id string | null
//   inv.equipArmor(slot, itemId)                // slot: 'helmet'|'chest'|'legs'|'boots'
//   inv.unequipArmor(slot)                      // -> the item id that was unequipped, or null
//
// Armor changes fire the SAME onChange listeners as hotbar/backpack changes
// (no second notification path -- HUD/Game subscribe once via inv.onChange
// and see every mutation, armor included).
//
// Extras (not pinned, used by Interact pick-block and the HUD panel):
//   inv.mode, inv.setMode(m), inv.setHotbarSlot(n,id,count,kind),
//   inv.setBackpackSlot(n,id,count,kind), inv.offChange(fn)
//
// Exposes exactly one global: window.Inventory
// Depends on globals: Blocks (optional; validates block ids when present),
// Items (optional; validates item ids + armor-slot/kind matching when present).

var Inventory = (function () {
  'use strict';

  // ---- constants ----
  var HOTBAR_SIZE = 9;
  var BACKPACK_SIZE = 27;
  var MAX_STACK = 64;

  // Armor slot name -> the Items.def().kind an equipped item must have
  // (contract §4: `inv.armor -> {helmet,chest,legs,boots}`, while Items'
  // own kind strings use the longer 'chestplate'/'leggings' forms per §4's
  // Items.def() shape -- this map is the one place that translation lives).
  var ARMOR_SLOT_KIND = { helmet: 'helmet', chest: 'chestplate', legs: 'leggings', boots: 'boots' };

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

  // ---- kind inference + validation ----
  // kind defaults to 'block' for a numeric id, 'item' for a string id -- this
  // is the ONE place that inference rule lives; every other function below
  // either receives an explicit kind or derives it by calling inferKind().
  function inferKind(id, kind) {
    if (kind === 'item' || kind === 'block') return kind;
    return (typeof id === 'string') ? 'item' : 'block';
  }

  function validId(id) {
    id = id | 0;
    if (id <= 0 || id > 255) return 0;
    if (typeof Blocks !== 'undefined' && Blocks && Blocks.byId) {
      return Blocks.byId(id) ? id : 0;
    }
    return id;
  }

  // Item ids are opaque strings owned by vox/items.js's Items registry (plus
  // Craft's own 'stick' intermediate, which never appears in Items -- both
  // are just non-empty strings from Inventory's point of view). When Items
  // is present we validate against it; otherwise (Items not loaded, e.g. a
  // minimal test harness) any non-empty string is accepted so Inventory
  // never hard-depends on a sibling module that may load after it.
  function validItemId(id) {
    if (typeof id !== 'string' || !id) return 0;
    if (typeof Items !== 'undefined' && Items && Items.isItem) {
      // Craft's 'stick' is a legitimate item id that Items itself doesn't
      // register (see vox/craft.js) -- accept it explicitly alongside
      // anything Items recognizes, rather than rejecting valid crafting
      // output because it lives in a different module's registry.
      if (Items.isItem(id) || id === 'stick') return id;
      return 0;
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

  // Stack cap for a slot: 64 for blocks (and for item-kind ids that Items
  // doesn't recognize as gear, e.g. Craft's plain 'stick' material -- see
  // header comment), 1 for anything Items registers (every §4 entry --
  // swords/tools/armor/buckets -- is single-use equippable gear that must
  // never stack). Gated on `id` (not just `kind`) so a plain crafting
  // material sharing the string-id 'item' kind isn't collaterally capped.
  function maxStackFor(kind, id) {
    if (kind !== 'item') return MAX_STACK;
    if (typeof Items !== 'undefined' && Items && Items.def && Items.def(id)) return 1;
    return MAX_STACK;
  }

  function sanitizeSlot(s) {
    if (!s || typeof s !== 'object') return null;
    var kind = inferKind(s.id, s.kind);
    var id = (kind === 'item') ? validItemId(s.id) : validId(s.id);
    if (!id) return null;
    var count = Math.floor(+s.count || 0);
    if (count < 1) return null;
    var cap = maxStackFor(kind, id);
    if (count > cap) count = cap;
    return { id: id, count: count, kind: kind };
  }

  // ---- factory ----
  function create(mode) {
    var listeners = [];

    var inv = {
      mode: mode === 'creative' ? 'creative' : 'survival',
      hotbar: emptySlots(HOTBAR_SIZE),
      backpack: emptySlots(BACKPACK_SIZE),
      selected: 0,

      // 4 equippable armor slots (COMBAT §4/§5.5) -- each holds an item id
      // string (e.g. "helmet_iron") or null. NOT part of hotbar/backpack;
      // a wholly separate concept, same as Minecraft's armor slots.
      armor: { helmet: null, chest: null, legs: null, boots: null },

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

      // ---- adding (stacks to 64 for blocks / 1 for items; hotbar first, then backpack) ----
      add: function (id, n) {
        var kind = inferKind(id);
        id = (kind === 'item') ? validItemId(id) : validId(id);
        var left = Math.floor(+n || 0);
        if (!id || left <= 0) return left > 0 ? left : 0;
        var before = left;

        left = stackInto(inv.hotbar, id, kind, left);
        left = stackInto(inv.backpack, id, kind, left);
        left = fillInto(inv.hotbar, id, kind, left);
        left = fillInto(inv.backpack, id, kind, left);

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
          backpack: inv.backpack.map(copySlot),
          armor: {
            helmet: inv.armor.helmet || null,
            chest: inv.armor.chest || null,
            legs: inv.armor.legs || null,
            boots: inv.armor.boots || null
          }
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

      setHotbarSlot: function (n, id, count, kind) {
        n = n | 0;
        if (n < 0 || n >= HOTBAR_SIZE) return;
        inv.hotbar[n] = sanitizeSlot({ id: id, count: count == null ? 1 : count, kind: kind });
        fire();
      },

      setBackpackSlot: function (n, id, count, kind) {
        n = n | 0;
        if (n < 0 || n >= BACKPACK_SIZE) return;
        inv.backpack[n] = sanitizeSlot({ id: id, count: count == null ? 1 : count, kind: kind });
        fire();
      },

      // ---- armor (COMBAT §4/§5.5) ----
      // Equips `itemId` (a string item id, e.g. "helmet_iron") into the given
      // slot ('helmet'|'chest'|'legs'|'boots'). Validates against Items when
      // present: the id must resolve to an Items def AND that def's `kind`
      // must match the slot (helmet->'helmet', chest->'chestplate',
      // legs->'leggings', boots->'boots') so a player can't jam a sword into
      // the helmet slot. Returns the PREVIOUSLY equipped item id (or null) so
      // callers can put it back in the inventory (matching Part I's existing
      // click-to-swap inventory interaction style); does nothing (returns
      // undefined, no fire()) if the slot name or item kind is invalid.
      equipArmor: function (slot, itemId) {
        if (!ARMOR_SLOT_KIND[slot]) return;
        if (typeof Items !== 'undefined' && Items && Items.def) {
          var def = Items.def(itemId);
          if (!def || def.kind !== ARMOR_SLOT_KIND[slot]) return;
        } else if (typeof itemId !== 'string' || !itemId) {
          return;
        }
        var prev = inv.armor[slot] || null;
        inv.armor[slot] = itemId;
        fire();
        return prev;
      },

      // Clears the given armor slot. Returns the item id that was unequipped
      // (or null if the slot was already empty / slot name invalid).
      unequipArmor: function (slot) {
        if (!ARMOR_SLOT_KIND[slot]) return null;
        var prev = inv.armor[slot] || null;
        if (prev === null) return null;
        inv.armor[slot] = null;
        fire();
        return prev;
      }
    };

    // ---- private: stacking passes ----
    // Gear (Items-registered kind:'item' ids) caps at 1, so an existing gear
    // slot with count>=1 is already "full" and stackInto correctly skips it
    // (take = min(1-1, left) = 0) -- a second copy of the same tool always
    // falls through to fillInto and lands in its OWN slot instead of
    // merging, exactly matching "tools/armor don't stack" (contract §4).
    // Plain kind:'item' materials Items doesn't recognize (e.g. 'stick')
    // stack to 64 same as a block.
    function stackInto(slots, id, kind, left) {
      var cap = maxStackFor(kind, id);
      for (var i = 0; i < slots.length && left > 0; i++) {
        var s = slots[i];
        if (s && s.id === id && (s.kind || 'block') === kind && s.count < cap) {
          var take = Math.min(cap - s.count, left);
          s.count += take;
          left -= take;
        }
      }
      return left;
    }

    function fillInto(slots, id, kind, left) {
      var cap = maxStackFor(kind, id);
      for (var i = 0; i < slots.length && left > 0; i++) {
        if (!slots[i]) {
          var take = Math.min(cap, left);
          slots[i] = { id: id, count: take, kind: kind };
          left -= take;
        }
      }
      return left;
    }

    function copySlot(s) {
      return s ? { id: s.id, count: s.count, kind: s.kind || 'block' } : null;
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

    if (obj.armor && typeof obj.armor === 'object') {
      for (var slot in ARMOR_SLOT_KIND) {
        if (!Object.prototype.hasOwnProperty.call(ARMOR_SLOT_KIND, slot)) continue;
        var itemId = obj.armor[slot];
        if (typeof itemId !== 'string' || !itemId) continue;
        // route through equipArmor's own validation (kind must match the
        // slot when Items is loaded) rather than trusting the saved blob
        // blindly -- a hand-edited or stale save shouldn't be able to jam a
        // sword into the helmet slot just because it round-tripped once.
        inv.equipArmor(slot, itemId);
      }
    }
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
