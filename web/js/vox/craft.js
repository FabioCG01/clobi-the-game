// vox/craft.js -- global Craft.
//
// A minimal Minecraft-style 3x3 shaped/shapeless crafting system for
// CLOBI CRAFT. Purely a local inventory transform -- no server involvement,
// works identically solo or in multiplayer (contract: ARCHITECTURE-COMBAT.md
// §12). Recipes read Blocks (numeric ids) and Items (string ids, §4) but
// this module owns neither registry, only the recipe list + matching logic.
//
//   Craft.RECIPES -> [{id, shape, shapeless, output:{id,count,kind}}, ...]
//   Craft.match(grid3x3) -> recipe | null
//   Craft.craftOnce(inventory, recipe) -> bool
//   Craft.STICK_ID -> 'stick'   // craft-only intermediate item id (not in Items).
//                                  A kind:'item' id (string, so it must be 'item' by
//                                  Inventory's kind-inference rule) but NOT
//                                  Items-registered gear -- Inventory's count=1 cap
//                                  only applies to ids Items recognizes as
//                                  equippable gear (swords/tools/armor/buckets), so
//                                  'stick' stacks normally to 64 like a block (see
//                                  inventory.js maxStackFor()). A "4 sticks" craft
//                                  output correctly lands as one stack of 4.
//
// ---- v1 simplifications (deliberate, per contract §12 -- NOT bugs) --------
//
// 1. NO SMELTING/FURNACES this pass. Iron- and diamond-tier tools/armor are
//    crafted directly from the RAW ore blocks (iron_ore id 17, diamond_ore
//    id 19) instead of smelted ingots. This skips an entire furnace/fuel
//    subsystem that is explicitly out of scope for Part III.
// 2. NO LEATHER DROP SOURCE this pass. Leather armor substitutes the existing
//    wool_white block (id 21) as a "leather-like" soft material stand-in
//    rather than inventing a new mob-drop item. Purely a placeholder
//    ingredient choice, not a mechanical error.
//
// Both substitutions are called out again inline on the exact recipes below.
//
// Exposes exactly one global: window.Craft
// Depends on globals: Blocks (block ids/validation, optional-guarded),
// Items (item defs for tool/armor output shape, optional-guarded).

var Craft = (function () {
  'use strict';

  // Craft-only intermediate material. Not a placeable block, not a §4 Items
  // registry entry (it has no damage/armor/durability -- it is pure crafting
  // fodder) -- represented as a plain stacking 'item'-kind id the same shape
  // convention Inventory already uses for everything else: {id, count, kind}.
  var STICK_ID = 'stick';
  var PLANKS_ID = 7;   // Blocks id, wood-tier tool/armor material
  var LOG_ID = 6;      // Blocks id
  var COBBLE_ID = 4;   // Blocks id, stone-tier tool material
  var IRON_ORE_ID = 17;    // Blocks id -- raw-ore-as-ingot substitute (no smelting, see header)
  var DIAMOND_ORE_ID = 19; // Blocks id -- raw-ore-as-ingot substitute (no smelting, see header)
  var WOOL_WHITE_ID = 21;  // Blocks id -- wool-as-leather substitute (see header)

  // ---- grid cell helpers ---------------------------------------------------
  // A recipe shape cell is either null (empty) or {id, kind} where kind is
  // 'block' (numeric Blocks id) or 'item' (string Items/Craft id) -- the SAME
  // {id,kind} shape Inventory slots use, so a crafting-grid slot can be
  // compared directly against a shape cell with no translation step.

  function blockCell(id) { return { id: id, kind: 'block' }; }
  function itemCell(id) { return { id: id, kind: 'item' }; }

  function cellEq(a, b) {
    // a = grid cell (may be null), b = shape cell (may be null)
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.id === b.id && (a.kind || 'block') === (b.kind || 'block');
  }

  // ---- shape recipes ---------------------------------------------------
  // Row 0 = top row of the 3x3 crafting grid. Standard, universally-
  // recognizable Minecraft-style layouts (pickaxe/axe/shovel/sword) are used
  // rather than a bespoke pixel-count reading of the contract's descriptive
  // prose -- see header. Every tool/armor recipe below is documented with
  // which v1 simplification (if any) it relies on.

  var RECIPES = [];

  // -- planks from log: 1 log -> 4 planks, SHAPELESS --
  RECIPES.push({
    id: 'planks_from_log',
    shapeless: true,
    inputs: [{ id: LOG_ID, kind: 'block', count: 1 }],
    output: { id: PLANKS_ID, count: 4, kind: 'block' }
  });

  // -- stick from planks: 2 planks stacked vertically -> 4 sticks --
  RECIPES.push({
    id: 'stick_from_planks',
    shapeless: false,
    shape: [
      [null, blockCell(PLANKS_ID), null],
      [null, blockCell(PLANKS_ID), null],
      [null, null, null]
    ],
    output: { id: STICK_ID, count: 4, kind: 'item' }
  });

  // Tier -> crafting material cell (the "tier's material", per §12).
  // wood=planks, stone=cobble, iron=RAW iron_ore (no smelting, see header),
  // diamond=RAW diamond_ore (no smelting, see header).
  var TOOL_TIER_MATERIAL = {
    wood: blockCell(PLANKS_ID),
    stone: blockCell(COBBLE_ID),
    iron: blockCell(IRON_ORE_ID),      // simplification: raw ore, no ingot/furnace
    diamond: blockCell(DIAMOND_ORE_ID) // simplification: raw ore, no ingot/furnace
  };

  var STICK = itemCell(STICK_ID);

  function toolShape(kind, mat) {
    // Standard vanilla-Minecraft tool shapes (mat=M, stick=S, .=empty).
    if (kind === 'sword') {
      return [
        [null, mat, null],
        [null, mat, null],
        [null, STICK, null]
      ];
    }
    if (kind === 'pickaxe') {
      return [
        [mat, mat, mat],
        [null, STICK, null],
        [null, STICK, null]
      ];
    }
    if (kind === 'axe') {
      return [
        [mat, mat, null],
        [mat, STICK, null],
        [null, STICK, null]
      ];
    }
    // shovel
    return [
      [null, mat, null],
      [null, STICK, null],
      [null, STICK, null]
    ];
  }

  var TOOL_KINDS = ['sword', 'pickaxe', 'axe', 'shovel'];
  var TOOL_TIERS = ['wood', 'stone', 'iron', 'diamond'];

  TOOL_KINDS.forEach(function (kind) {
    TOOL_TIERS.forEach(function (tier) {
      RECIPES.push({
        id: kind + '_' + tier,
        shapeless: false,
        shape: toolShape(kind, TOOL_TIER_MATERIAL[tier]),
        output: { id: kind + '_' + tier, count: 1, kind: 'item' }
      });
    });
  });

  // -- armor --
  // Materials per §12: leather tier substitutes wool_white (simplification,
  // see header); iron/diamond tiers substitute the RAW ore block, same
  // no-smelting simplification as tools above. Quantities per §12's "raw ore
  // x5-8 depending on piece" guidance -- helmet/boots use the smaller piece
  // count (5), leggings the middle (6), chestplate the largest (8),
  // matching vanilla Minecraft's own per-slot material-count ordering
  // (chest > legs > helmet == boots).
  var ARMOR_TIERS = ['leather', 'iron', 'diamond'];
  var ARMOR_TIER_MATERIAL_ID = {
    leather: WOOL_WHITE_ID,   // simplification: wool stands in for leather, no drop source built
    iron: IRON_ORE_ID,        // simplification: raw ore, no smelting
    diamond: DIAMOND_ORE_ID   // simplification: raw ore, no smelting
  };

  // Standard vanilla Minecraft armor shapes (M=material, .=empty):
  var ARMOR_SHAPE = {
    helmet: [
      [1, 1, 1],
      [1, 0, 1],
      [0, 0, 0]
    ],
    chestplate: [
      [1, 0, 1],
      [1, 1, 1],
      [1, 1, 1]
    ],
    leggings: [
      [1, 1, 1],
      [1, 0, 1],
      [1, 0, 1]
    ],
    boots: [
      [0, 0, 0],
      [1, 0, 1],
      [1, 0, 1]
    ]
  };
  // Piece material counts actually consumed (per §12's 5-8 range) -- since the
  // vanilla armor shapes above have a fixed cell count that doesn't always
  // equal the desired 5-8 total (helmet/boots shapes = 5 cells, leggings = 7,
  // chestplate = 8 cells), we use the shapes AS-IS (their natural cell count
  // already lands inside or very close to the 5-8 band) rather than layering
  // a second "multiplier" concept on top of a shaped recipe -- documented
  // here so the piece-to-piece count variation (5/7/8) reads as intentional.
  var ARMOR_KINDS = ['helmet', 'chestplate', 'leggings', 'boots'];

  function armorShapeFor(kind, materialBlockId) {
    var pattern = ARMOR_SHAPE[kind];
    var mat = blockCell(materialBlockId);
    var out = [];
    for (var r = 0; r < 3; r++) {
      var row = [];
      for (var c = 0; c < 3; c++) row.push(pattern[r][c] ? mat : null);
      out.push(row);
    }
    return out;
  }

  ARMOR_KINDS.forEach(function (kind) {
    ARMOR_TIERS.forEach(function (tier) {
      RECIPES.push({
        id: kind + '_' + tier,
        shapeless: false,
        shape: armorShapeFor(kind, ARMOR_TIER_MATERIAL_ID[tier]),
        output: { id: kind + '_' + tier, count: 1, kind: 'item' }
      });
    });
  });

  // ================================================================
  // ---- matching -----------------------------------------------------
  // ================================================================

  // Trim a 3x3 shape down to its minimal bounding box (drop fully-empty
  // border rows/cols) so it can be slid to any of the 9 possible offsets
  // within the caller's 3x3 grid, per standard Minecraft crafting-match
  // convention (a shape need not touch the top-left corner).
  function trimShape(shape) {
    var minR = 3, maxR = -1, minC = 3, maxC = -1;
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        if (shape[r][c]) {
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (c < minC) minC = c;
          if (c > maxC) maxC = c;
        }
      }
    }
    if (maxR < 0) return { rows: 0, cols: 0, cells: [] }; // fully-empty shape (degenerate, unused)
    var rows = maxR - minR + 1, cols = maxC - minC + 1;
    var cells = [];
    for (r = 0; r < rows; r++) {
      var row = [];
      for (c = 0; c < cols; c++) row.push(shape[minR + r][minC + c]);
      cells.push(row);
    }
    return { rows: rows, cols: cols, cells: cells };
  }

  // Does `grid` (3x3 of {id,kind}|null) match `recipe`'s shape at row/col
  // offset (dr,dc), with every OTHER grid cell required to be empty?
  function matchesShapeAtOffset(grid, trimmed, dr, dc) {
    if (dr + trimmed.rows > 3 || dc + trimmed.cols > 3) return false;
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        var inShape = (r >= dr && r < dr + trimmed.rows && c >= dc && c < dc + trimmed.cols);
        var shapeCell = inShape ? trimmed.cells[r - dr][c - dc] : null;
        if (!cellEq(grid[r][c], shapeCell)) return false;
      }
    }
    return true;
  }

  function matchesShapeRecipe(grid, recipe) {
    var trimmed = trimShape(recipe.shape);
    if (!trimmed.rows) return false;
    // shift-search all valid offsets (standard MC crafting-match convention:
    // the pattern may sit anywhere inside the 3x3, not just top-left).
    for (var dr = 0; dr <= 3 - trimmed.rows; dr++) {
      for (var dc = 0; dc <= 3 - trimmed.cols; dc++) {
        if (matchesShapeAtOffset(grid, trimmed, dr, dc)) return true;
      }
    }
    return false;
  }

  function matchesShapelessRecipe(grid, recipe) {
    // Bag-of-ids match: every non-empty grid cell must be accounted for by
    // exactly the recipe's required counts, and vice versa (no extra items,
    // no missing items) -- position-independent.
    var need = {};
    recipe.inputs.forEach(function (inp) {
      var key = (inp.kind || 'block') + ':' + inp.id;
      need[key] = (need[key] || 0) + inp.count;
    });
    var have = {};
    var haveTotal = 0;
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        var cell = grid[r][c];
        if (!cell) continue;
        haveTotal++;
        var key = (cell.kind || 'block') + ':' + cell.id;
        have[key] = (have[key] || 0) + 1; // each grid cell contributes 1 toward shapeless matching
      }
    }
    var needTotal = 0;
    for (var k in need) {
      if (!Object.prototype.hasOwnProperty.call(need, k)) continue;
      needTotal += need[k];
      if ((have[k] || 0) < need[k]) return false;
    }
    // every filled cell must be part of the recipe (no stray ingredients) --
    // shapeless recipes in this v1 registry all need exactly 1 filled cell,
    // so this also guards against e.g. 2 logs in the grid over-matching.
    return haveTotal === needTotal;
  }

  // Remembers the most recent grid passed to match() so the pinned 2-arg
  // `craftOnce(inventory, recipe)` signature (contract §12 -- no grid
  // parameter) has something to consume from without requiring every caller
  // to also thread the grid through craftOnce explicitly. HUD's normal flow
  // is naturally match-then-craft against the same staged grid (the player
  // fills the 3x3, sees a live preview via match(), then taps "craft"), so
  // this is safe in practice; craftOnce ALSO accepts an explicit optional
  // 3rd `grid3x3` argument for callers that want to be fully explicit/avoid
  // any ambiguity if match() and craftOnce() could ever be called out of
  // order (e.g. multiple crafting panels) -- pass it and this fallback is
  // never consulted.
  var lastMatchedGrid = null;

  function match(grid) {
    if (!grid || grid.length !== 3) return null;
    for (var i = 0; i < RECIPES.length; i++) {
      var recipe = RECIPES[i];
      var ok = recipe.shapeless ? matchesShapelessRecipe(grid, recipe) : matchesShapeRecipe(grid, recipe);
      if (ok) {
        lastMatchedGrid = grid;
        return recipe;
      }
    }
    return null;
  }

  // ================================================================
  // ---- crafting: consume + produce -----------------------------
  // ================================================================

  // Best-effort inventory scan/removal helpers (Inventory has no native
  // remove-by-id; hotbar+backpack are plain arrays per vox/inventory.js's
  // pinned shape, so we can scan/mutate them directly).
  function countInSlots(slots, id, kind) {
    var n = 0;
    if (!slots) return n;
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s && s.id === id && (s.kind || 'block') === (kind || 'block')) n += s.count;
    }
    return n;
  }

  function removeFromSlots(slots, id, kind, need) {
    if (!slots || need <= 0) return need;
    for (var i = 0; i < slots.length && need > 0; i++) {
      var s = slots[i];
      if (s && s.id === id && (s.kind || 'block') === (kind || 'block')) {
        var take = Math.min(s.count, need);
        s.count -= take;
        need -= take;
        if (s.count <= 0) slots[i] = null;
      }
    }
    return need;
  }

  function removeFromInventory(inventory, id, kind, need) {
    need = removeFromSlots(inventory.hotbar, id, kind, need);
    need = removeFromSlots(inventory.backpack, id, kind, need);
    return need; // 0 if fully removed
  }

  // Consume exactly 1x the matched recipe's inputs from wherever they sit in
  // `grid` (the SAME 3x3 array of {id,count,kind}|null last passed to
  // match(), or an explicitly-supplied equivalent), decrementing counts in
  // place and nulling out emptied cells. Grid cells hold {id,count,kind} with
  // count>=1 (a crafting-grid slot behaves like any other inventory slot);
  // only 1 unit per occupied shape cell is ever consumed per craft, per
  // contract ("consumes 1x the matched inputs").
  function consumeFromGrid(grid, recipe) {
    if (recipe.shapeless) {
      // v1 shapeless recipes need exactly 1 filled cell (e.g. 1 log); walk
      // the 3x3 and take `count` units from the first cell(s) whose (id,kind)
      // matches each required input.
      recipe.inputs.forEach(function (inp) {
        var need = inp.count;
        for (var r = 0; r < 3 && need > 0; r++) {
          for (var c = 0; c < 3 && need > 0; c++) {
            var s = grid[r][c];
            if (s && s.id === inp.id && (s.kind || 'block') === (inp.kind || 'block')) {
              var take = Math.min(s.count, need);
              s.count -= take;
              need -= take;
              if (s.count <= 0) grid[r][c] = null;
            }
          }
        }
      });
      return;
    }
    // shaped: re-derive the occupied offset (same search match() used) so we
    // decrement the SAME physical cells the player filled, not just any
    // slot sharing that id -- matters when extra copies of the material sit
    // outside the matched footprint (already disallowed by matching itself,
    // but staying precise here keeps this function correct in isolation).
    var trimmed = trimShape(recipe.shape);
    for (var dr = 0; dr <= 3 - trimmed.rows; dr++) {
      for (var dc = 0; dc <= 3 - trimmed.cols; dc++) {
        if (matchesShapeAtOffset(grid, trimmed, dr, dc)) {
          for (var r = 0; r < trimmed.rows; r++) {
            for (var c = 0; c < trimmed.cols; c++) {
              if (!trimmed.cells[r][c]) continue;
              var s = grid[dr + r][dc + c];
              if (s) {
                s.count -= 1;
                if (s.count <= 0) grid[dr + r][dc + c] = null;
              }
            }
          }
          return;
        }
      }
    }
  }

  // Craft.craftOnce(inventory, recipe, grid3x3?) -> bool
  //
  // Consumes 1x the matched recipe's inputs from the crafting-grid staging
  // area and adds the output to `inventory` (any object exposing hotbar/
  // backpack arrays + `.add(id,n)`, i.e. vox/inventory.js's Inventory).
  // Returns false (no-op -- consumes NOTHING, grid untouched) if the output
  // has no room.
  //
  // `grid3x3` is an explicit optional 3rd argument for callers that want to
  // avoid any ambiguity about which staged grid to consume from; when
  // omitted, the grid most recently passed to Craft.match() is used (see
  // `lastMatchedGrid` above) -- the pinned contract signature is exactly
  // `craftOnce(inventory, recipe)`, so the normal HUD flow of "match() to
  // preview, then craftOnce() to commit against that same grid" works with
  // no 3rd argument at all.
  function craftOnce(inventory, recipe, grid3x3) {
    if (!inventory || !recipe) return false;
    var grid = grid3x3 || lastMatchedGrid;
    if (!grid) return false; // nothing staged to consume from -- refuse rather than guess

    // All-or-nothing add: Inventory has no dry-run mode, so add the full
    // output stack, then if ANY of it failed to land (leftover > 0) undo
    // exactly that leftover amount and report failure WITHOUT touching the
    // grid. A full success (leftover === 0) is followed by consuming the
    // grid's matched inputs -- crafting only "spends" ingredients once the
    // output is confirmed to exist somewhere in the inventory.
    var out = recipe.output;
    var leftover = inventory.add(out.id, out.count);
    if (leftover > 0) {
      if (leftover < out.count) removeFromInventory(inventory, out.id, out.kind, out.count - leftover);
      return false;
    }
    consumeFromGrid(grid, recipe);
    return true;
  }

  function to3x3(grid9) {
    var g = [[null, null, null], [null, null, null], [null, null, null]];
    for (var i = 0; i < 9 && i < grid9.length; i++) g[(i / 3) | 0][i % 3] = grid9[i];
    return g;
  }

  // ---- public API ----------------------------------------------------------
  return {
    RECIPES: RECIPES,
    STICK_ID: STICK_ID,
    match: match,
    craftOnce: craftOnce,
    to3x3: to3x3
  };
})();

window.Craft = Craft;
