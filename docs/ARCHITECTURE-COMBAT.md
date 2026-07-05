# CLOBI CRAFT — PART III: COMBAT, MOBS, ITEMS & WORLD DEPTH (BINDING CONTRACT)

Extends Part I (`ARCHITECTURE-3D.md`) and Part II (`ARCHITECTURE-MP.md`). Part II §5
said "movement is client-authoritative... no PvP" — this part **supersedes that one
line**: combat requires server-authoritative health and hit validation, specified
below. Everything else in Parts I/II stands unchanged.

Scope: rename off the old 2D-era product name, fix the over-bright/washed fog, a much
larger block/ore registry, melee PvP + PvE (players and mobs), swords/armor/tools, a
small starter mob roster, the `/difficulty` + `/gamerule keepInventory` commands, a
polished day/night sky, held-item rendering (first + third person), item drop
entities, a crafting system, and two Part I liquid/physics bugs (water doesn't flow;
players can get stranded in 1-block-deep water because the swim-up path cuts out
right as `body.inWater` flips false at shallow depth).

## 1. Rename

Product name becomes **"CLOBI CRAFT"** everywhere a name is user-visible (the old
"TUX SMASH ROYALE" 2D-arcade name is retired along with the 2D game it named).
Keep the Clobi-tribute voice (vim, Fisherman's Friend, anti-Windows gag) — only the
top-level product name changes, not the tribute framing.

- `web/index.html`: `<title>`, meta description.
- `web/js/menu.js`: hero title text/logo, About modal copy, footer credit line.
- `web/js/i18n.js`: any STRINGS values that literally contain "Tux Smash Royale" —
  EXCEPT: leave `README.md` alone (out of scope) and never touch the "Activate
  Windows" gag text (`gag.js`) — that string is pinned verbatim by design and is
  not a product name.
- Do not rename JS globals, CSS classes, DB fields, or the git repo/binary name —
  purely user-facing copy.

## 2. Fog / brightness fix

`renderer.js` `computeEnv()` currently sets `fogStart = range*0.55`, `fogEnd =
range*0.92` where `range = renderDist*16`, and post-process vibrance/tonemap lift
washes the far field to near-white haze at low render distances (diagnosed
visually at `renderDist=4`: terrain past ~35 blocks fades to `[227,243,248]`-ish
near-white by midground). Fix, in `renderer.js` only:

- `fogStart: range * 0.72, fogEnd: range * 1.15` (push both further out — fog
  should read as atmospheric haze at the render-distance edge, not a wall at
  60% of view distance).
- Deepen the fog/sky-horizon colors ~12% (multiply RGB by ~0.88) at all times of
  day so distant terrain reads as tinted-toward-sky rather than washed-to-white;
  keep the existing day/dusk/night color script's hues, just less washed.
- In the post shader, reduce vibrance-driven highlight lift slightly (the
  filmic tonemap's shoulder was pushing brights toward clipping) — target: a
  frame that still reads vivid/saturated up close (this is the "vibrant
  realism" pillar from Part I, do not flatten it) but no longer clips distant
  terrain to white. Verify by rendering the same test scene as before (camera
  at spawn, renderDist 4) and confirming the terrain_bottom / mid / sky_top
  sample points are visibly distinct in hue, not converging to near-white.

## 3. Expanded block & ore registry

Extends the Part I §4 table (ids 0–33 unchanged, never renumbered). New stable
ids 34+:

| id | key | name (en) | solid | opaque | hardness | notes |
|----|-----|-----------|-------|--------|----------|-------|
| 34 | redstone_ore | Redstone Ore | yes | yes | 3.5 | glows faintly when lit (emissive 0.15) |
| 35 | lapis_ore | Lapis Ore | yes | yes | 3.5 | |
| 36 | emerald_ore | Emerald Ore | yes | yes | 4.5 | rare, mountain-biome only |
| 37 | netherite_scrap_ore | Ancient Debris | yes | yes | 6.0 | very rare, deep (y<12) |
| 38 | granite | Granite | yes | yes | 2.5 | stone variant, deep-only patches |
| 39 | diorite | Diorite | yes | yes | 2.5 | stone variant |
| 40 | andesite | Andesite | yes | yes | 2.5 | stone variant |
| 41 | clay | Clay | yes | yes | 0.6 | riverbed/beach patches |
| 42 | terracotta | Terracotta | yes | yes | 1.25 | craftable from clay |
| 43 | mossy_cobble | Mossy Cobblestone | yes | yes | 3.0 | generates near water+forest |
| 44 | ice | Ice | yes | no (translucent) | 0.5 | slippery (physics friction ×0.4), snow biome lakes |
| 45 | packed_ice | Packed Ice | yes | yes | 0.5 | opaque ice variant, snow biome |
| 46 | cactus | Cactus | yes | no (cutout) | 0.4 | desert; touching deals 1 dmg/0.5s |
| 47 | melon | Melon Block | yes | yes | 1.0 | food source block, jungle-ish patches |
| 48 | pumpkin | Pumpkin | yes | yes | 1.0 | field patches, also a hat-slot cosmetic later (not v1) |
| 49 | mushroom_red | Red Mushroom Block | yes | yes | 0.2 | rare dark-forest decoration |
| 50 | mushroom_brown | Brown Mushroom Block | yes | yes | 0.2 | " |
| 51 | vine | Vines | no | no (cutout) | 0.2 | jungle decoration, climbable (physics: reduced gravity while touching) |
| 52 | wool_orange | Orange Wool | yes | yes | 1.0 | |
| 53 | wool_purple | Purple Wool | yes | yes | 1.0 | |
| 54 | wool_cyan | Cyan Wool | yes | yes | 1.0 | |
| 55 | wool_pink | Pink Wool | yes | yes | 1.0 | |
| 56 | wool_gray | Gray Wool | yes | yes | 1.0 | |
| 57 | wool_lightgray | Light Gray Wool | yes | yes | 1.0 | |
| 58 | tnt_lozenge | Lozenge Charge | yes | yes | 0 | decorative only v1 (mint-and-red striped block, NO explosion logic — do not build detonation, that's out of scope) |
| 59 | end_stone | Sunset Stone | yes | yes | 4.0 | pale gold-tan, deep cave rare decorative variant (reskinned end stone, no dimension travel) |
| 60 | basalt | Basalt | yes | yes | 3.0 | deep cave variant near obsidian |
| 61 | quartz_block | Quartz Block | yes | yes | 2.0 | rare deep decorative, craftable-later hook |

Ore generation (extends Part I §5.4 WorldGen depth gates, same per-chunk seeded
vein-walk approach as existing coal/iron/gold/diamond):
redstone (y<32, uncommon), lapis (y<24, uncommon, clusters), emerald (y<40 but
ONLY inside a new lightweight "mountain" mask — reuse the existing hills-mask
noise channel thresholded higher — very rare), ancient-debris-ore (y<12, very
rare, isolated single-block finds not veins). Stone variants (granite/diorite/
andesite) replace plain `stone` in patches below y≈40 via a second cheap value-
noise channel (blob threshold), same technique as existing gravel/sand patches.
Clay generates in beach/riverbed columns adjacent to water at sea level. Ice/
packed-ice replace `water`'s surface in a new cold biome variant gated by the
existing per-column temperature-ish hash (reuse whatever biome-selection value
WorldGen already has — if none exists yet, add a cheap `biomeNoise(x,z)` value
and gate snow_grass/ice/packed_ice/melon/cactus/mushroom placement on distinct
bands of it, documented inline). Cactus/melon/pumpkin/mushrooms are surface
decorations analogous to existing flowers/tallgrass (same "must fit fully
inside chunk" rule). Vines hang from jungle-biome tree leaves. Mossy cobble
generates as a rare cobble variant near water+forest.

All new tile art: same procedural hand-drawn-in-code style as the existing 34
(see Part I §4 implementation) — cohesive with the existing vibrant palette,
half-texel-inset UVs, uploaded into the SAME atlas canvas (grow `Blocks.
ATLAS_TILES` from 16 to whatever fits 62 tiles — 16×16 tiles = 256 slots at
16×16 canvas grid, so the atlas canvas size itself doesn't need to grow, only
more of the existing grid gets used; do NOT change `ATLAS_TILES` if the grid
already has headroom — verify against the current implementation first).

## 4. Items: swords, tools, armor (new client module `js/vox/items.js` — global `Items`)

Item ids are strings (not the block-id numberspace): `"sword_wood"`,
`"sword_stone"`, `"sword_iron"`, `"sword_diamond"`, `"pickaxe_<tier>"`,
`"axe_<tier>"`, `"shovel_<tier>"` (tiers: wood, stone, iron, diamond — matching
existing planks/cobble/iron_ore-implies-iron/diamond_ore-implies-diamond
progression), `"helmet_<tier>"`, `"chestplate_<tier>"`, `"leggings_<tier>"`,
`"boots_<tier>"` (tiers: leather, iron, diamond). Hotbar/backpack slots (Part I
`Inventory`) gain a `kind:'item'` variant alongside `kind:'block'` entries —
extend `Inventory` (`web/js/vox/inventory.js`) minimally: a stack entry becomes
`{id, count, kind}` where `kind` defaults to `'block'` for numeric ids and
`'item'` for string ids; items are NOT placeable (Interact's place path already
gates on `Blocks.byId` succeeding, so string ids naturally fall through — verify
this rather than assuming). 4 armor slots are a NEW inventory concept: `inv.
armor -> {helmet,chest,legs,boots}` each holding one item id or null, `inv.
equipArmor(slot, itemId)` / `inv.unequipArmor(slot)`.

```js
Items.def(id) -> {id, kind:'sword'|'pickaxe'|'axe'|'shovel'|'helmet'|'chestplate'|'leggings'|'boots',
                   tier:'wood'|'stone'|'iron'|'diamond'|'leather', name, i18nKey,
                   damage (sword: 4/5/6/8 wood..diamond; fist=1),
                   armorPoints (helmet 1-3, chest 3-6, legs 2-5, boots 1-3 by tier),
                   miningSpeedMult (pickaxe/axe/shovel vs matched block category),
                   durability (wood 60, stone 130, iron 250, diamond 1560, leather-armor 55/armor 165/240 by tier)}
Items.icon(id) -> HTMLCanvasElement (40×40, same fake-iso/flat style as HUD block icons)
Items.craft ... NOT built v1 — items are obtained via /give and mob drops only; no crafting table/grid this pass (explicitly out of scope, flag if asked).
```

Tool mining speed: `Interact` (Part I §5.11) break-time formula gains a
multiplier when the selected hotbar item is a matching tool for the target
block's category (pickaxe: stone/ore/brick/obsidian family; axe: log/planks/
bookshelf; shovel: dirt/grass/sand/gravel/clay/snow) — wrong/no tool = current
behavior unchanged; matching tool divides effective hardness by the tier's
`miningSpeedMult` (wood 2×, stone 4×, iron 6×, diamond 8×, matching Minecraft's
feel loosely). Some blocks require a minimum tool tier to drop anything (ore
blocks 16–19/34–37/61 require at least a stone pickaxe; diamond/emerald/
ancient-debris require iron+) — below-tier mining still breaks the block
(survival) but yields no drop.

Durability: each tool use (break survival-mode) or each hit taken (armor) or
each swing landing a PvP/PvE hit (sword) decrements durability by 1; reaching 0
destroys the item (removed from inventory, small HUD toast). Track durability
as a per-stack-slot field (stacks of tools/armor are always count=1 — enforce
in `Inventory.add`: item-kind entries never stack beyond 1).

## 5. Combat (client `js/vox/combat.js` — global `Combat`; supersedes Part II §5's "no PvP" line)

Combat requires server authority for health so players can't fake damage or
immunity. This changes the WS protocol (Part II §3.3) and the single-player/
solo-hosted path (which also runs through an Instance per Part II design, so
the SAME server-authoritative combat code runs whether you're alone or with
friends — no special-cased solo combat logic).

### 5.1 Wire protocol additions (extends Part II §3.3)

**client → server** (new)
```
hit    {targetId}         // "I swung and my client thinks I hit entity targetId"
                          // targetId: a player id (from welcome/join) OR "mob:<mobId>"
respawn {}                 // after death, request respawn at world spawn
```

**server → client** (new)
```
health   {id, hp (0..20), max (20)}         // authoritative HP for any entity (self included), on change
damage   {id, amount, by, cause:'player'|'mob'|'fall'|'drown'|'void'|'cactus'}   // for hit-flash/knockback FX
death    {id, by}                            // entity died; players get a death screen (Part I §5.16 death overlay reused)
mobSpawn {id, kind, p:[x,y,z], hp}
mobState {m:[[id,x,y,z,yaw,hp,anim],...]}    // batched like `moves`, mob position+state @ 10Hz
mobDespawn {id}
```

### 5.2 Server authority (Go, extends `internal/rooms` `Instance`)

The `Instance` (Part II §3.1) gains: per-player `hp float64` (0..20, default 20,
regen +1/4s when no damage taken for 30s, matching Part I's existing solo-mode
regen rule so behavior is consistent single vs multiplayer), a `mobs
map[string]*Mob` (id, kind, pos, hp, target, lastMoveAt), and difficulty +
keepInventory flags (§6). On `hit{targetId}`: server validates the attacker's
claimed position (from their last `move`) is within **4.5 blocks** of the
target's last known position and the attacker hasn't hit within the last
**350ms** (server-tracked per-attacker cooldown — this IS the anti-spam/anti-
cheat gate, not a suggestion) — if both pass, compute damage (attacker's
equipped sword `Items.def(id).damage` else fist=1, reduced by target's armor
sum via a simple flat-reduction formula: `dmg * max(0.2, 1 - armorPoints*0.04)`),
apply, broadcast `health`+`damage`, knockback (small position nudge sent as
part of the next `moves`/`mobState` batch — no separate physics feed-back
needed, client-side Physics already integrates position from server `moves`
for remote entities per Part II RemotePlayers interpolation). On hp<=0:
broadcast `death`, despawn or set a `dead` flag; player death honors
`keepInventory` (§6) by NOT clearing their `Inventory` server-side-tracked... 
NOTE: inventory itself stays fully client-authoritative in Part I/II (never
synced to the server) EXCEPT for this one interaction — when keepInventory is
OFF, the death handling on the CLIENT (not server) clears Inventory and drops
a simple "dropped items" despawn-after-delay visual (no real item-entity
pickup system v1 — out of scope; a death without keepInventory just clears the
inventory client-side with a chat/sys message, matching the spirit without
building a full item-drop-entity subsystem). Server only needs to tell the
client keepInventory's current value (in `welcome` and on `/gamerule` change).

Mobs live entirely server-side (so all connected clients see the same mob
state — no per-client mob simulation, no desync). Simple per-tick AI (§7) runs
in the Instance's existing 20Hz tick alongside time advancement.

### 5.3 Client combat (`Combat.js`)

```js
Combat.init({net, hud, localPlayerId})
Combat.attemptHit(camera, world)   // raycast (reuse Interact.raycast-style DDA against ENTITY bounding boxes,
                                   // not blocks) within 4.5 blocks of crosshair; on hit -> Net.send('hit',{targetId})
                                   // Called on LMB-tap-without-holding-to-break (see §5.4 input disambiguation)
                                   // and on touch tap-on-entity.
Combat.onHealth(fn) / onDamage(fn) / onDeath(fn) / onMobSpawn(fn) / onMobState(fn) / onMobDespawn(fn)
   // Game wires these to: HUD hearts update, hit-flash overlay (.vox-hitflash pinned class,
   // brief red vignette pulse), knockback nudge already covered by position interpolation,
   // death -> existing death overlay, mob draw/update.
Combat.localHP -> number (0..20)   // mirrors the authoritative value from 'health' for youId
```

### 5.4 Input disambiguation (extends Part I §5.11 `Interact`)

Desktop: LMB **tap** (press+release under 200ms with no movement) on an entity
under the crosshair = attack; LMB **hold** = block-break (existing behavior,
unchanged when the ray hits a block first or no entity is in range). Ray
priority: test entities first within 4.5 blocks, then blocks — matches
Minecraft's feel where you can hit a mob standing in front of a wall you'd
otherwise be breaking. Touch: tap-on-entity (screen point resolves to an
entity's screen-space bounding box, not just the block raycast) = attack;
existing tap-place/long-press-break unchanged for non-entity taps. Sword
equipped changes nothing about aiming, only damage + a brief swing animation
(reuse `PlayerModel`'s existing swing/attack arm animation hook from Part I
§5.8 first-person arm — extend its swing trigger to fire on `hit` send, not
only on block-break).

### 5.5 Armor rendering (extends `PlayerModel`, Part I §5.8)

Third inflated layer, Minecraft-style: for each equipped armor slot, an
additional box set inflated **+1.0** model units beyond the base layer (more
than the skin's own overlay +0.25/+0.5, so armor visibly sits outside a
jacket), textured from a small procedurally-generated flat-color-per-tier
texture (leather tan, iron light-gray, diamond cyan-white) rather than the
player's skin sheet — armor is NOT a skin-net region, it's independent
geometry+texture owned by `Items`/`PlayerModel`. Helmet covers the head box,
chestplate the body+shoulders-of-arms, leggings the leg boxes' upper 2/3,
boots the leg boxes' lower 1/3. `PlayerModel.draw` gains an optional
`armor:{helmet,chest,legs,boots}` opts field (item ids or null); when present,
draws the extra inflated boxes after the skin layers using the same shader
family (alpha-cutout not needed, armor pieces are simple opaque boxes).

## 6. New commands (extends Part I §5.13 `Commands`, wired through Part II's
Net when multiplayer, local-only meaning in solo/offline mode)

```
/difficulty <peaceful|easy|normal|hard>
   // peaceful: no hostile mobs spawn (existing ones despawn), no starvation/fall-death (fall damage still
   //   applies per Part I but capped so it can't kill — leaves at 1 hp), keepInventory-independent.
   // easy/normal/hard: hostile mob damage scales 0.5/1.0/1.5×; only affects PvE, never PvP damage.
   // host/owner-only when hosted (Net.send when connected); local instant when solo/offline.
/gamerule keepInventory <true|false>
   // host/owner-only when hosted; local instant offline. Default false (matches vanilla convention).
```
Both persist in `worlds.settings` jsonb (Part II §1) as `{difficulty, keepInventory}`
alongside existing `{cap,spawn,time}`, so a rehosted world remembers its rules.
`/help` output includes both. Unknown difficulty/bool value → existing
i18n'd unknown-arg error pattern from Part I commands.js.

## 7. Mobs (server-simulated per §5.2; client renders via a new `js/vox/mobs.js` — global `Mobs`)

Starter roster (small, per product decision — more can follow later):

- **zombie** (hostile): humanoid box-model (reuse `PlayerModel`'s classic rig
  geometry with a green skin texture — do NOT build a separate mesh, just draw
  a `PlayerModel`-shaped entity with a procedurally generated green/tattered
  palette skin, model 'classic', no overlay layer needed). AI: within 16
  blocks and line-of-sight of a player → pathfind straight-line toward them
  (simple: normalize direction vector, no A*, blocked-by-solid-block avoidance
  is a single "try to step up 1 block or turn ±45° and retry" heuristic — do
  NOT build real pathfinding, this is v1); adjacent (<1.2 blocks) → attacks
  (same `hit` mechanism server-side, damage 2-4 scaled by difficulty). HP 20.
  Spawns at night (timeTicks in the night band) or in dark areas (skyExposure
  low, per Part I mesher's existing light computation reused as a spawn gate)
  on grass/dirt/stone within render distance of a player, capped at a small
  per-instance mob count (e.g. 8) so it never overwhelms. Despawns if no
  player within 64 blocks for 30s, or immediately on `/difficulty peaceful`.
  Drops nothing v1 (keep it simple) — flag rotten-flesh-equivalent drop as a
  documented future addition, not built now.
- **pig** (passive): reuse the same box-rig approach with a pink palette,
  wanders randomly (pick a random nearby point every few seconds, walk to it,
  idle), flees from recent attackers for a few seconds if hit (players CAN
  attack passive mobs — same `hit` path, they just don't attack back). HP 10.
  Spawns on grass in daylight, same population cap logic (small, e.g. 6).

Both mobs use the exact same server-side `hp`/`hit`/`death` machinery as
players (§5.2) — a mob is not a special case, it's an entity with `kind:'mob'`
and a `mobKind` field. Client `Mobs.js`:

```js
Mobs.init(gl)                          // shares PlayerModel geometry + a small procedural skin-texture cache per mobKind
Mobs.sync(list) / applyState(batch) / spawn(m) / despawn(id)
Mobs.update(dt)                        // same 150ms-behind interpolation as RemotePlayers
Mobs.draw(gl, camera, env)             // drawn alongside RemotePlayers, same pass ordering
Mobs.list() / Mobs.count
```

## 8. HUD additions for combat (extends Part I §5.14)

New pinned classes: `.vox-hitflash` (full-screen brief red pulse on taking
damage), `.vox-armor-row` (4 small armor-slot icons above the hotbar, empty =
dim outline), `.vox-death-by` (extra line on the existing death overlay: "Slain
by <name>" / "Killed by a zombie" / "Fell to their death" etc., i18n'd per
cause). Hearts row (existing) now reflects `Combat.localHP` instead of Part I's
purely-local fall/drown damage tracker — merge: fall/drown/void damage in
solo/offline mode stays exactly as Part I built it (no server involved when
offline); in multiplayer, ALL damage (including fall/drown/void) routes through
the server's authoritative hp so a rejoin doesn't desync (client still detects
fall/drown/void locally and sends a `damage`-cause-equivalent — simplest: for
environmental damage the CLIENT computes the amount using Part I's existing
formulas and sends it via a new lightweight `selfDamage {amount, cause}` WS
message that the server trusts at low stakes tolerances, since environmental
damage isn't a cheating vector worth building server-side fall-tracking for;
`hit`-caused damage remains the only server-computed path per §5.2).

## 9. Held items (first + third person) — extends `PlayerModel` (Part I §5.8), `Inventory` (§5.12/§4)

Nothing currently renders in a player's hand — `PlayerModel.drawFirstPersonArm`
draws a bare arm and no other viewer sees anything attached to a remote
player's hand either. Fix both.

`Inventory` (Part I) currently assumes every slot holds a numeric block id;
§4 above already introduces `{id,count,kind}` slots (`kind:'block'|'item'`).
Held-item rendering must work for BOTH kinds from the same code path:

```js
// playermodel.js additions:
PlayerModel.heldItemMesh(heldId, kind) -> {vao, tex}  // memoized per (heldId,kind) pair, built lazily on first use
   // kind==='block': a small inflated-cube mesh (≈0.5 model units per side) textured from
   //   Blocks.buildAtlas's existing atlas UVs for that block id (reuse the SAME atlas texture
   //   already bound for world rendering -- no new texture upload). A flat quad reading "as a cube"
   //   is NOT good enough; build actual 3-6 visible faces (top+2 sides is fine, matches the existing
   //   HUD fake-iso icon convention) so it doesn't look like a sprite.
   // kind==='item': a thin extruded quad (a "flat prop" ~1px model-unit thick) textured from
   //   Items.icon(id)'s existing 40x40 canvas (upload once, memoize) -- gives tools/swords a blade-with-
   //   some-depth look without needing hand-authored 3D tool meshes.
PlayerModel.drawFirstPersonArm(gl, o)   // EXTEND existing signature: o gains {heldId, heldKind} (either may be null/undefined = empty hand).
   // When present, draw the held-item mesh parented to the same hand transform the arm already
   // uses, offset per a small per-kind pose constant (blocks held flatter/lower, tools/swords angled
   // more upright) -- swing/bob animation (existing arm swing hook) carries the item along for free
   // since it shares the arm's transform stack.
PlayerModel.draw(gl, opts)              // EXTEND existing signature: opts gains {heldId, heldKind} for THIRD-PERSON
   // rendering (both your own 3rd-person view and every OTHER player via RemotePlayers.draw, which
   // must be updated to pass each remote player's current heldId/heldKind through -- Part II's
   // 'moves'/player-state messages need the selected-item id added so remote viewers know what to
   // draw; if that wire field doesn't exist yet by integration time, add it as a small non-breaking
   // addition to the existing move/moves messages: {..., held:{id,kind}} -- omit-safe, treat missing
   // as empty-hand).
```

`Game`/`HUD` wiring: whenever the selected hotbar slot changes (`Inventory.
onChange` already exists per Part I §5.12), recompute `{heldId,heldKind}` from
`inv.hotbar[inv.selected]` and pass it into both the first-person draw call and
(in multiplayer) the outgoing move state. Empty slot / block with no visible
form (e.g. air, though air can't be selected) = no mesh drawn, arm swings bare
as it does today.

## 10. Held-item names: hotbar tooltip on selection (HUD bug fix)

`HUD` already has a working `dom.tooltip`/`showTooltip(text,x,y)`/
`hideTooltip()` and block-name lookup (`blockName(id)`) wired to inventory-
panel hover, but the pinned hotbar row (`.vox-hotbar`/`.vox-slot`) never calls
it. Fix: whenever the selected slot changes (same `Inventory.onChange`/
`HUD.update` signal that already redraws the `.sel` ring per Part I §5.14),
show the tooltip briefly (≈1.4s auto-hide, matching typical hotbar-select UX)
positioned above the now-selected hotbar slot with its name (block:
`blockName(id)`; item: `Items.def(id)` name via its `i18nKey`/`name` fields
from §4). Re-show on every selection change (hotbar number key, scroll, or
touch tap), not just once. Do not show it on mere mouse hover over the hotbar
(that would conflict with existing crosshair-target-name display) — selection-
triggered only.

## 11. Dropped item entities (new client module `js/vox/drops.js` — global `Drops`; extends `internal/rooms` Instance for multiplayer)

A minimal item-entity system: small bobbing/spinning pickups in the world that
represent a stack, collected on player proximity. No physics simulation beyond
a simple gravity-drop-then-rest-on-ground arc and a spin/bob idle animation —
this is NOT a general physics-entity system, just enough for drop-on-death (now
built, superseding §5.2's earlier "not built v1" note) and manual dropping (Q
key desktop / drop button touch, matching the Part I control-scheme spirit).

```js
Drops.init(gl)                      // shares Blocks atlas + Items icon textures (same mesh style as §8's held-block mesh, smaller ~0.25 unit)
Drops.spawn(pos[3], stack:{id,count,kind}) -> dropId    // local (solo/offline) or called from Net 'dropSpawn' in MP
Drops.update(dt, world)             // simple gravity+ground-rest per drop; despawn after 5 min; merge same-stack drops within 0.5 blocks
Drops.checkPickup(playerPos, inventory) -> collected:[{id,kind,count}] // radius ~1.2 blocks, only if Inventory.add() has room (partial pickup ok, leftover stays as a drop)
Drops.draw(gl, camera, env)
Drops.remove(dropId)
```

Manual drop: desktop `Q` (new keybind — extend `Input.js`'s key map + `state`/
emit set with a `'drop'` action, single-item-from-stack on tap, whole-stack on
a held/modifier variant is NOT required v1, keep it simple: Q drops 1 from the
selected slot), touch: a small drop button (new pinned class
`.vox-btn-drop`, same construction pattern as the existing sprint button
added this session — toggle/tap, hold not needed, simple tap-to-drop-one)
positioned near the inventory/hotbar touch cluster. Dropped stack spawns
slightly in front of the player (along their look direction, ~0.6 blocks out,
at chest height) so it doesn't instantly re-collide with their own hitbox.

**Multiplayer**: drop entities are server-tracked (extends `internal/rooms`
Instance with a `drops map[string]Drop{id,pos,stack,spawnedAt}`, same pattern
as the mob map from §7) so all clients see the same pickups — reuses the exact
broadcast/interpolation shape already established for mobs (`dropSpawn
{id,pos,stack}` / `dropState` batched like `mobState` / `dropDespawn{id}` /
client sends `pickup{dropId}` and the server validates proximity+inventory-
space server-authoritatively before confirming removal, same anti-cheat
posture as combat's `hit` validation in §5.2 — do not trust a client-only
pickup in MP). **Solo/offline**: drops run entirely client-side (no server to
ask), same duplication-is-fine posture as §7's solo mob AI.

## 12. Crafting (new client module `js/vox/craft.js` — global `Craft`; no server involvement — purely a local inventory transform, works identically solo or in multiplayer)

A simple 3×3 grid crafting UI (recipes match shape+contents, Minecraft-style),
opened from a new HUD crafting panel (pinned class `.vox-craft-panel`, opened
via the existing inventory button/key — fold it into the SAME panel the
existing creative/survival inventory UI already opens, as a second tab/section
alongside the existing hotbar+backpack grid, rather than a wholly separate
screen). No crafting table block requirement v1 (craftable from the inventory
panel directly, anywhere — a placeable `crafting_table` block + adjacency
requirement is a documented future addition, not built now, note this
explicitly if asked).

```js
Craft.RECIPES -> [{ id, shape: [[cellOrNull,...],[...],[...]] (3x3, each cell is a block/item id or null for empty),
                     shapeless: bool (if true, shape is just a bag of required ids/counts, position-independent),
                     output: {id, count, kind} }]
Craft.match(grid3x3 /* 3x3 array of {id,kind}|null */) -> recipe|null   // shape match with the standard MC allowance
                                                                        // of the pattern appearing anywhere within the 3x3 (not
                                                                        // required to touch the top-left) -- shift-search all offsets
Craft.craftOnce(inventory, recipe) -> bool    // consumes 1x the matched inputs from wherever they sit in the crafting
                                              // grid slots (a small separate 9-slot staging area, NOT the hotbar/backpack --
                                              // player drags/taps from backpack into the grid first, matching Part I's existing
                                              // click-to-move inventory interaction style), adds output to inventory, returns
                                              // false (no-op) if output has no room
```

Starter recipe set (enough to make the new items in §4 obtainable without only
using `/give` — small and pragmatic, not the full vanilla tree): planks from
log (1→4, shapeless), stick from planks (2 vertical→4), the 4 tool types ×
4 tiers from {2 sticks + 3 of the tier's material in a pickaxe/axe/shovel/sword
shape — material: planks=wood tier, cobble=stone tier, iron nuggets... NO
smelting system v1, so substitute: iron tier crafts directly from `iron_ore`
raw block ×3 (a simplification — document this explicitly as skipping
smelting/furnaces, out of scope this pass), diamond tier from `diamond_ore`
raw ×3 similarly}, leather armor pieces from a new-ish "leather" concept —
SIMPLEST option: leather armor crafts from `wool_white` (reuse existing wool
block as a leather stand-in rather than inventing a new drop source, note this
substitution explicitly), iron/diamond armor pieces from `iron_ore`/
`diamond_ore` raw ×5-8 depending on piece (same raw-ore-as-material
simplification as tools, for consistency). Document the smelting-skip and
wool-as-leather substitution clearly in the recipe list's comments so it reads
as an intentional v1 simplification, not a mistake.

## 13. Water flow + shallow-water jump fix (Part I bug fixes — `blocks.js`, `worldgen.js`, `world.js`, `mesher.js`, `physics.js`)

Two DISTINCT problems, both real:

**(a) Water doesn't flow.** Currently `water` (block id 11) is one uniform
liquid with no level/source concept — placing/removing water never spreads or
recedes. Add a lightweight flow model:

- `Blocks` gains a per-block **level** concept carried OUTSIDE the block-id
  byte (the existing world storage is `Uint8Array` block-ids only, per Part I
  §3/§5.5 — do NOT change that storage format / break existing saves).
  Simplest compatible approach: keep `water` as a single block id (still 11)
  for full "source-strength" water (used by all existing worldgen lakes/seas —
  zero migration needed, existing saves keep working unchanged), and add a
  SEPARATE new block id `flowing_water` (next free id after whatever Part III
  §3's registry lands on — coordinate with that section, do not collide ids)
  that behaves identically to `water` for rendering/collision/swimming
  purposes (same `liquid:true`, translucent, same tile art tinted slightly
  more turbulent) but represents a spreading, receding, lower-strength liquid.
  Player-placed water (from a `bucket`-equivalent item — see note below) is
  always full-strength `water`; water that SPREADS from a source or another
  flowing cell becomes `flowing_water` with an implicit falloff.
- Falloff/spread simulation (a lightweight, non-Minecraft-exact but convincing
  approximation — this is explicitly NOT required to be a perfect cellular
  automaton): maintain a small per-world **liquid tick queue** (`World` gains
  `world.queueLiquidTick(x,y,z)` called whenever a `water`/`flowing_water`
  block is placed/broken/exposed by a neighboring block change — hook this
  into the existing `setBlock`/edit path). A tick (run at a modest fixed rate,
  e.g. 4-8 ticks/sec, budgeted per-frame like the existing chunk-streaming
  budget so it never spikes frame time) for a queued liquid cell: if the cell
  below is air/replaceable, water falls straight down (converts the cell below
  to `flowing_water`, queues ITS neighbors next tick — this is what makes
  water "fall" out of a broken dam or off a ledge); else, spread horizontally
  to up to a small fixed number of orthogonal replaceable neighbors (cap
  spread distance from the nearest source at ~4 cells to keep it cheap and
  visually reasonable, tracked via a simple per-cell "distance from source"
  byte kept in the SAME in-memory liquid-tick bookkeeping structure, not
  persisted to the saved world — on world load, any `flowing_water` cells
  simply re-settle from a fresh tick pass rather than needing their distance
  restored exactly, which is a fine, honest v1 simplification). Removing a
  source (breaking a `water` block) queues a **recede** pass: any adjacent
  `flowing_water` whose distance-from-source now traces back to nothing
  reachable converts back to air after a short delay (a simple flood-fill-
  from-remaining-sources check is sufficient, does not need to be
  frame-perfect). `Mesher` needs no changes beyond treating `flowing_water`
  exactly like `water` for face-culling/translucent-batch purposes (liquid
  flag driven, already generic).
- A `bucket` item (new, folds into §4's Items registry: `"bucket_empty"` /
  `"bucket_water"`) lets a player pick up a source water block (removes it,
  bucket becomes full) and place a fresh FULL-STRENGTH `water` source block
  from a full bucket (bucket becomes empty) — this is the only way to
  CREATE a new source; breaking existing world water is otherwise just a
  removal (triggers recede per above). Keep this small; do not build lava or
  other fluids this pass.

**(b) Stranded in 1-block-deep water, can't jump out.** Root cause (confirmed
by reading `physics.js`): `body.inWater` is a single point-sample at the
body's vertical CENTER (`pos.y + height*0.5`), and the swim-up accel
(`SWIM_ACCEL` applied `if (input.jump)`) only runs `else if (body.inWater)` —
i.e., it competes with, rather than assists, the normal on-ground jump path.
In water only ~1 block deep, the center-sample flips to "not in water" the
moment the player's vertical center clears the single submerged block's top
surface (which can happen while their FEET are still inside it, well before
they've actually stood up out of the pool), so neither branch fires cleanly
at that instant: swim-accel already stopped (center says "not in water"), but
`body.onGround` isn't true yet either (feet may still be inside/at the
water-solid boundary rather than resting on a genuine solid block), so the
normal jump impulse doesn't fire that frame. Net effect: upward velocity dies
right at the lip and the player sinks back.

Fix (`physics.js`, pure logic layer — no contract-breaking signature changes,
`body.inWater`/`headInWater` stay as pinned per Part I §5.9):
- Add a THIRD internal check (not part of the public body shape, just local
  logic inside `step()`): `feetInWater = isLiquidAt(world, pos.x, pos.y + 0.05,
  pos.z)` (near the very bottom of the AABB, not the center). When
  `feetInWater && !body.inWater && !body.onGround` (the exact stranded
  window: center has cleared the water but the player hasn't landed on solid
  ground yet) AND `input.jump`, apply a small residual upward assist
  (reuse `SWIM_ACCEL` at a reduced fraction, e.g. ×0.5, for a single frame's
  worth of impulse rather than a sustained force) so the last inch of exit
  from very shallow water always completes instead of stalling. This is a
  narrow, targeted patch for the specific reported symptom — do not
  rewrite the broader water/gravity model, which works correctly at normal
  (2+ block) depths already.
- Separately/additionally (belt-and-suspenders, cheap and correct regardless):
  the existing on-ground jump path currently requires `body.onGround` to be
  strictly true; a player standing on the solid floor of a 1-deep pool
  (feet resting on the block below the water, i.e. genuinely `onGround`)
  should ALSO just get the normal jump impulse immediately — verify this
  actually already works (it should, per the existing `else if` structure,
  since `onGround` alone should take the FIRST `if` branch) and if it does
  NOT (e.g. because `body.inWater` is incorrectly ALSO true at that depth and
  some earlier check short-circuits before reaching the on-ground branch),
  fix the branch ordering so `body.onGround` is checked and honored before
  the water-branch can intercept the jump input at all.
Verify the fix by constructing a 1-block-deep pool (survival mode), standing
in it, and confirming a single jump-key press reliably exits the pool onto
dry land within 1-2 frames of input, with no regression to normal deep-water
swimming (holding jump in a 3+ block pool should still swim smoothly upward
via the existing unmodified path).

## 14. Prettier day/night cycle — extends `Renderer.computeEnv` (Part I §5.15/§7, on top of §2's fog fix above)

The existing day/night color script (dawn/day/dusk/night bands, rotating
sunDir) is functionally correct but plain. Polish, without breaking the
existing env shape consumed by `beginFrame`/`drawSky` (additive fields only):

- **Moon**: a visible moon disc opposite the sun (already noted as "optional"
  in Part I §5.15 — make it real) with a soft glow, phase-independent (a
  simple lit half is fine, no real phase cycle needed), visible only when the
  sun is below the horizon (dot(sunDir,up) < ~0.05, smoothstepped so it fades
  in/out rather than popping).
- **Stars**: procedural point-sprites (Part I already floats this as optional
  — implement it) that fade in as ambient darkens past dusk and fade out at
  dawn, density/brightness tied to how far past the dusk threshold the current
  tick is (smoothstep, not a hard cutoff) so the transition reads as gradual
  dusk→night rather than a light switch.
- **Smoother color transitions**: extend the existing dawn/dusk band windows
  (currently narrow, per Part I §7's tick ranges) with proper smoothstep
  interpolation across ALL the color fields already being blended (sky top/
  horizon, fog, sun color, ambient) — verify the current implementation
  already smoothsteps (Part I's builder summary claims it does) and if any
  field currently does a hard/linear cut at a band boundary, convert it to
  match the others so no field visibly "snaps" at a tick threshold.
- **Golden-hour emphasis**: slightly widen and warm the sunrise/sunset color
  peak (a bit more saturated orange/pink at the sun-near-horizon moment) since
  this is the single most "pretty" visual beat of a day/night cycle and is
  worth spending a little extra tuning on relative to the rest of the script.
- Keep everything within the EXISTING `env` object shape (moon/star data can
  be internal to `Renderer`, computed inside `drawSky` from `env`+`camera`,
  not necessarily new top-level `env` fields, unless a new field is the
  cleanest implementation — additive only, never remove/rename an existing
  `env` field another module reads).

Solo/offline (not connected to a server room): Part I's single-player mode
gets a LOCAL mob simulation for parity (so solo survival isn't strictly worse)
— reuse the exact same AI tick logic as a plain JS module function shared by
both the Go-ported logic (documented as intentionally duplicated simple logic,
not shared code across languages) and a new client-only path in `game.js` that
runs mobs directly against the local `World`/`Physics` when `!Game.
isMultiplayer`. Keep this duplication small and explicit (it's ~50 lines of
wander/chase heuristic, not worth abstracting across the Go/JS boundary).

## 15. Definition of done (Part III additions)

1. Title/menu/about no longer say "Tux Smash Royale" anywhere; "CLOBI CRAFT"
   is the only product name shown.
2. Rendered test frame at renderDist 4 no longer washes to near-white; distant
   terrain reads as tinted haze with visibly distinct hues at near/mid/far.
3. New ores/blocks generate in the world, mine correctly with tool-tier gating,
   and render with cohesive art in the existing atlas.
4. `/give sword_iron` then LMB-tap a mob deals iron-sword damage; holding LMB
   on a block still breaks it (no regression to block-breaking).
5. Two clients in the same room: one hits the other (PvP), both see synced
   health bars, hit-flash, and a death screen with "Slain by <name>" on 0 hp;
   `/gamerule keepInventory false` clears the dead player's inventory,
   `true` preserves it.
6. A zombie spawns at night, chases and damages an idle player; a pig wanders
   and flees when hit; both work identically in solo/offline play.
7. `/difficulty peaceful` removes hostile mobs and they stop respawning;
   `/difficulty hard` visibly increases zombie damage vs `easy`.
8. Equipping full iron armor visibly changes the player model (inflated armor
   layer) for ALL other viewers in a shared room, and measurably reduces
   incoming damage.
9. `go build/vet/test ./...` still green with the new rooms/Instance combat
   fields and mob simulation added.
10. Selecting any hotbar slot (block or item) visibly renders in the player's
    hand in first person, AND a second viewer in the same room sees it too
    (third-person, via `RemotePlayers`).
11. Selecting a hotbar slot shows its name in a tooltip above the hotbar
    (auto-hiding), for both blocks and items — not just on inventory-panel
    hover.
12. Pressing Q (desktop) or the drop button (touch) drops one item from the
    selected slot as a visible pickup entity in front of the player; walking
    over it picks it up (and, in multiplayer, a second client sees the same
    drop appear/disappear at the same time).
13. Opening the crafting panel, placing the right shape/ingredients, and
    crafting produces the correct output item and consumes the correct
    inputs; an unmatched arrangement produces nothing.
14. Breaking a water source lets water visibly spread and fall to fill nearby
    reachable space over a few seconds; removing the source lets it recede.
15. Standing in a freshly-dug 1-block-deep pool in survival, pressing jump
    once reliably exits onto dry land within 1-2 frames — no more getting
    stuck; swimming up out of a normal 3+ block pool is unaffected.
16. At night, a moon and stars are visible and fade in/out smoothly around
    dusk/dawn rather than popping; sunrise/sunset shows a richer golden-hour
    color than before; no field visibly "snaps" at a time-of-day boundary.
