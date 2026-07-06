// vox/items.js -- global Items.
//
// Non-block item registry for CLOBI CRAFT: swords, tools (pickaxe/axe/shovel),
// armor (helmet/chestplate/leggings/boots), and buckets. Item ids are STRINGS
// (never collide with the numeric block-id space), e.g. "sword_iron",
// "pickaxe_diamond", "helmet_leather", "bucket_water".
// Contract: ARCHITECTURE-COMBAT.md §4 (also referenced by §9 held-item
// rendering, §11 crafting outputs, §13 buckets).
//
//   Items.def(id) -> {id, kind, tier, name, i18nKey, damage, armorPoints,
//                      miningSpeedMult, durability} | null
//   Items.icon(id) -> HTMLCanvasElement (40x40, cached, same fake-iso pixel-
//                      art family as the HUD's block icons)
//   Items.list() -> [def,...]                 // every registered item, id-order
//   Items.isItem(id) -> bool                   // string + registered
//   Items.TIERS.tool  -> ['wood','stone','iron','diamond']
//   Items.TIERS.armor -> ['leather','iron','diamond']
//
// Items.craft is intentionally NOT built here (out of scope per §4 -- see
// vox/craft.js for the actual crafting system, which is a separate module
// that reads Items.def()/produces item ids but owns none of this registry).
//
// Exposes exactly one global: window.Items
// Depends on globals: I18n (optional/guarded, matches Blocks.nameOf style).

var Items = (function () {
  'use strict';

  // ---- tiers -----------------------------------------------------------
  var TOOL_TIERS = ['wood', 'stone', 'iron', 'diamond'];
  var ARMOR_TIERS = ['leather', 'iron', 'diamond'];

  // Per-tier numbers, §4 EXACT:
  //   sword damage:      wood 4, stone 5, iron 6, diamond 8   (fist=1 lives in Combat, not an item)
  //   tool durability:   wood 60, stone 130, iron 250, diamond 1560
  //   miningSpeedMult:   wood 2x, stone 4x, iron 6x, diamond 8x
  var TOOL_TIER_STATS = {
    wood:     { damage: 4, durability: 60,   miningSpeedMult: 2 },
    stone:    { damage: 5, durability: 130,  miningSpeedMult: 4 },
    iron:     { damage: 6, durability: 250,  miningSpeedMult: 6 },
    diamond:  { damage: 8, durability: 1560, miningSpeedMult: 8 }
  };

  // Armor durability by tier, §4 EXACT: "leather-armor 55/armor 165/240 by tier"
  // reads as: leather=55, iron=165, diamond=240 (same durability for every
  // slot within a tier -- §4 does not vary durability per-slot, only
  // armorPoints varies per-slot).
  var ARMOR_TIER_DURABILITY = { leather: 55, iron: 165, diamond: 240 };

  // armorPoints by slot+tier, §4 EXACT ranges: helmet 1-3, chest 3-6, legs
  // 2-5, boots 1-3 -- spread across the 3 armor tiers (leather/iron/diamond)
  // as low/mid/high of each stated range, integers, strictly ascending:
  var ARMOR_POINTS = {
    helmet:     { leather: 1, iron: 2, diamond: 3 },
    chestplate: { leather: 3, iron: 5, diamond: 6 },
    leggings:   { leather: 2, iron: 4, diamond: 5 },
    boots:      { leather: 1, iron: 2, diamond: 3 }
  };

  var TOOL_KINDS = ['sword', 'pickaxe', 'axe', 'shovel'];
  var ARMOR_KINDS = ['helmet', 'chestplate', 'leggings', 'boots'];

  var TIER_NAME_EN = {
    wood: 'Wooden', stone: 'Stone', iron: 'Iron', diamond: 'Diamond', leather: 'Leather'
  };
  var KIND_NAME_EN = {
    sword: 'Sword', pickaxe: 'Pickaxe', axe: 'Axe', shovel: 'Shovel',
    helmet: 'Helmet', chestplate: 'Chestplate', leggings: 'Leggings', boots: 'Boots'
  };

  // ---- registry ----------------------------------------------------------
  var DEFS = Object.create(null);
  var ORDER = [];

  function reg(d) {
    DEFS[d.id] = d;
    ORDER.push(d.id);
  }

  // -- tools + swords: <kind>_<tier> for kind in TOOL_KINDS, tier in TOOL_TIERS
  TOOL_KINDS.forEach(function (kind) {
    TOOL_TIERS.forEach(function (tier) {
      var id = kind + '_' + tier;
      var stats = TOOL_TIER_STATS[tier];
      reg({
        id: id,
        kind: kind,
        tier: tier,
        name: TIER_NAME_EN[tier] + ' ' + KIND_NAME_EN[kind],
        i18nKey: 'vox.item.' + id,
        // Only swords deal a meaningful melee damage stat; tools still carry
        // their tier's damage number (Minecraft-consistent: any tool can be
        // swung as a weak weapon) so Combat never has to special-case a
        // missing field.
        damage: stats.damage,
        armorPoints: 0,
        // Mining speed only matters for pickaxe/axe/shovel; a sword still
        // carries the number for uniformity but Interact never applies it.
        miningSpeedMult: stats.miningSpeedMult,
        durability: stats.durability
      });
    });
  });

  // -- armor: <kind>_<tier> for kind in ARMOR_KINDS, tier in ARMOR_TIERS
  ARMOR_KINDS.forEach(function (kind) {
    ARMOR_TIERS.forEach(function (tier) {
      var id = kind + '_' + tier;
      reg({
        id: id,
        kind: kind,
        tier: tier,
        name: TIER_NAME_EN[tier] + ' ' + KIND_NAME_EN[kind],
        i18nKey: 'vox.item.' + id,
        damage: 0,
        armorPoints: ARMOR_POINTS[kind][tier],
        miningSpeedMult: 0,
        durability: ARMOR_TIER_DURABILITY[tier]
      });
    });
  });

  // -- buckets (§13 water-flow section): simple items, no damage/armor/mining
  // fields -- durability:null (buckets don't wear out, they just swap state
  // between empty <-> full on use).
  reg({
    id: 'bucket_empty', kind: 'bucket', tier: null,
    name: 'Bucket', i18nKey: 'vox.item.bucket_empty',
    damage: 0, armorPoints: 0, miningSpeedMult: 0, durability: null
  });
  reg({
    id: 'bucket_water', kind: 'bucket', tier: null,
    name: 'Water Bucket', i18nKey: 'vox.item.bucket_water',
    damage: 0, armorPoints: 0, miningSpeedMult: 0, durability: null
  });

  // ================================================================
  // ---- icon rendering: 40x40 canvas, fake-iso family -------------
  // Mirrors HUD's block-icon aesthetic (vox/hud.js getIcon()): light top-left
  // key light, darker flat-shaded facets, crisp 1px-feel pixel strokes, no
  // antialiasing. Tools/swords are drawn as an angled blade+handle silhouette
  // (diagonal, top-right blade / bottom-left handle, Minecraft-icon-style);
  // armor pieces are drawn as a simple frontal silhouette (helmet dome / chest
  // vest / leg pauldrons / boot pair) filled with the tier's material color
  // and the same light/mid/dark 3-tone shading HUD's isoFace() uses for cube
  // faces, so the whole item family reads as one coherent pixel-art set
  // alongside the block icons rather than a jarring style mismatch.
  // ================================================================

  var iconCache = Object.create(null);

  // Tier -> {light, mid, dark} material palette (metal/wood/gem look).
  var TIER_PALETTE = {
    wood:    { light: [201, 156, 97],  mid: [163, 120, 69],  dark: [110, 78, 42] },
    stone:   { light: [178, 178, 178], mid: [142, 142, 142], dark: [92, 92, 96] },
    iron:    { light: [238, 238, 240], mid: [206, 206, 212], dark: [150, 150, 158] },
    diamond: { light: [173, 244, 240], mid: [110, 224, 219], dark: [58, 168, 168] },
    leather: { light: [196, 148, 96],  mid: [156, 108, 62],  dark: [108, 72, 40] }
  };

  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  // Pixel-grid helper: draws 1 "big pixel" as an NxN square in a 40x40 canvas
  // scaled from a 20x20 logical grid (2px per cell) -- matches the chunky
  // hand-drawn feel of the 16x16-tile block art scaled to 40px icons.
  function px(ctx, gx, gy, gw, gh, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(gx * 2), Math.round(gy * 2), Math.round(gw * 2), Math.round(gh * 2));
  }

  function drawHandle(ctx, cx, cy, len, pal) {
    // small vertical-ish handle/hilt block, dark-toned wood/leather wrap
    px(ctx, cx - 1, cy, 2, len, rgb(pal.dark));
    px(ctx, cx - 1, cy, 1, len, rgb([Math.max(0, pal.dark[0] - 20), Math.max(0, pal.dark[1] - 20), Math.max(0, pal.dark[2] - 20)]));
  }

  function drawSword(ctx, pal) {
    // Classic MC-style icon: diagonal blade upper-right, crossguard, grip
    // lower-left. Grid is 20x20 logical cells (40x40 canvas / 2).
    var blade = [
      [13, 2], [14, 3], [12, 4], [13, 5], [11, 6], [12, 7],
      [10, 8], [11, 9], [9, 10], [10, 11]
    ];
    for (var i = 0; i < blade.length; i++) {
      px(ctx, blade[i][0], blade[i][1], 2, 2, rgb(pal.light));
      px(ctx, blade[i][0] + 1, blade[i][1] + 1, 1, 1, rgb(pal.mid));
    }
    // crossguard
    px(ctx, 7, 11, 4, 2, rgb(pal.dark));
    // grip (always a warm wood/leather tone, independent of blade material)
    var grip = TIER_PALETTE.wood;
    px(ctx, 7, 13, 2, 5, rgb(grip.mid));
    px(ctx, 7, 13, 1, 5, rgb(grip.dark));
  }

  function drawPickaxe(ctx, pal) {
    // wide top head (two angled prongs) + vertical stick handle down the center
    px(ctx, 4, 3, 4, 2, rgb(pal.light));
    px(ctx, 8, 4, 3, 2, rgb(pal.mid));
    px(ctx, 11, 5, 3, 2, rgb(pal.mid));
    px(ctx, 14, 6, 3, 2, rgb(pal.dark));
    px(ctx, 6, 4, 3, 2, rgb(pal.mid));
    px(ctx, 4, 5, 3, 2, rgb(pal.dark));
    drawHandle(ctx, 10, 6, 11, TIER_PALETTE.wood);
  }

  function drawAxe(ctx, pal) {
    // blocky L-shaped head to one side + vertical handle
    px(ctx, 9, 2, 6, 3, rgb(pal.light));
    px(ctx, 9, 5, 5, 2, rgb(pal.mid));
    px(ctx, 9, 7, 3, 2, rgb(pal.dark));
    drawHandle(ctx, 10, 3, 14, TIER_PALETTE.wood);
  }

  function drawShovel(ctx, pal) {
    // small flat blade top-center + vertical stick
    px(ctx, 9, 2, 3, 4, rgb(pal.light));
    px(ctx, 9, 5, 3, 2, rgb(pal.mid));
    drawHandle(ctx, 10, 6, 11, TIER_PALETTE.wood);
  }

  var TOOL_DRAWERS = { sword: drawSword, pickaxe: drawPickaxe, axe: drawAxe, shovel: drawShovel };

  function drawHelmet(ctx, pal) {
    px(ctx, 6, 4, 8, 3, rgb(pal.mid));
    px(ctx, 6, 4, 8, 1, rgb(pal.light));
    px(ctx, 6, 7, 2, 2, rgb(pal.dark));
    px(ctx, 12, 7, 2, 2, rgb(pal.dark));
  }

  function drawChestplate(ctx, pal) {
    px(ctx, 5, 4, 3, 3, rgb(pal.mid));  // left shoulder
    px(ctx, 12, 4, 3, 3, rgb(pal.mid)); // right shoulder
    px(ctx, 7, 4, 6, 10, rgb(pal.mid)); // torso
    px(ctx, 7, 4, 6, 2, rgb(pal.light));
    px(ctx, 7, 12, 6, 2, rgb(pal.dark));
  }

  function drawLeggings(ctx, pal) {
    px(ctx, 7, 3, 6, 4, rgb(pal.light)); // waist
    px(ctx, 7, 7, 2, 9, rgb(pal.mid));   // left leg
    px(ctx, 11, 7, 2, 9, rgb(pal.mid));  // right leg
    px(ctx, 7, 15, 2, 1, rgb(pal.dark));
    px(ctx, 11, 15, 2, 1, rgb(pal.dark));
  }

  function drawBoots(ctx, pal) {
    px(ctx, 6, 9, 3, 6, rgb(pal.mid));
    px(ctx, 11, 9, 3, 6, rgb(pal.mid));
    px(ctx, 6, 13, 4, 2, rgb(pal.dark)); // left foot
    px(ctx, 11, 13, 4, 2, rgb(pal.dark)); // right foot
    px(ctx, 6, 9, 3, 1, rgb(pal.light));
    px(ctx, 11, 9, 3, 1, rgb(pal.light));
  }

  var ARMOR_DRAWERS = { helmet: drawHelmet, chestplate: drawChestplate, leggings: drawLeggings, boots: drawBoots };

  function drawBucket(ctx, filled) {
    var metal = TIER_PALETTE.iron;
    px(ctx, 6, 6, 8, 8, rgb(metal.mid));
    px(ctx, 6, 6, 8, 1, rgb(metal.light));
    px(ctx, 6, 13, 8, 1, rgb(metal.dark));
    px(ctx, 6, 6, 1, 8, rgb(metal.dark));
    px(ctx, 13, 6, 1, 8, rgb(metal.dark));
    // handle arc
    px(ctx, 7, 3, 6, 1, rgb(metal.dark));
    px(ctx, 6, 4, 1, 2, rgb(metal.dark));
    px(ctx, 13, 4, 1, 2, rgb(metal.dark));
    if (filled) {
      var water = [63, 118, 228];
      px(ctx, 7, 8, 6, 4, rgb(water));
      px(ctx, 7, 8, 6, 1, rgb([120, 170, 245]));
    }
  }

  // Build (and cache) the 40x40 master icon canvas for an item id.
  function buildIcon(id) {
    var def = DEFS[id];
    var c = document.createElement('canvas');
    c.width = 40; c.height = 40;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    if (!def) return c;

    if (def.kind === 'bucket') {
      drawBucket(ctx, def.id === 'bucket_water');
      return c;
    }
    var pal = TIER_PALETTE[def.tier] || TIER_PALETTE.iron;
    if (TOOL_DRAWERS[def.kind]) {
      TOOL_DRAWERS[def.kind](ctx, pal);
    } else if (ARMOR_DRAWERS[def.kind]) {
      ARMOR_DRAWERS[def.kind](ctx, pal);
    }
    return c;
  }

  function icon(id) {
    if (iconCache[id]) return iconCache[id];
    var c = buildIcon(id);
    iconCache[id] = c;
    return c;
  }

  // ---- public API ----------------------------------------------------------
  return {
    TIERS: { tool: TOOL_TIERS.slice(), armor: ARMOR_TIERS.slice() },
    TOOL_KINDS: TOOL_KINDS.slice(),
    ARMOR_KINDS: ARMOR_KINDS.slice(),

    def: function (id) { return DEFS[id] || null; },
    icon: icon,
    list: function () { return ORDER.map(function (id) { return DEFS[id]; }); },
    isItem: function (id) { return typeof id === 'string' && !!DEFS[id]; },

    nameOf: function (id) {
      var d = DEFS[id];
      if (!d) return '';
      return (typeof I18n !== 'undefined' && I18n && I18n.t)
        ? I18n.t(d.i18nKey, d.name) : d.name;
    }
  };
})();

window.Items = Items;
