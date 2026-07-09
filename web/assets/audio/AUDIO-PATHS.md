# CLOBI CRAFT — audio file map

Every file below is currently a **silent placeholder MP3**. Replace any file
with your own MP3 — **same path, same name** — and it goes live on the next
page load. No code changes needed. (If the game is installed as a PWA, do a
hard refresh once so the service worker picks up the new file.)

Recommended encoding: MP3, 44.1 kHz. SFX: mono, 96–128 kbps, short (< 1 s for
steps/clicks). Music: stereo, 128–192 kbps.

## Music (`assets/audio/music/`)

| File | Plays when |
|---|---|
| `music/menu.mp3` | Menu and every non-game screen (loops) |
| `music/game_day_1.mp3` | In-game, daytime (pool track 1) |
| `music/game_day_2.mp3` | In-game, daytime (pool track 2) |
| `music/game_night_1.mp3` | In-game, nighttime (pool track 1) |
| `music/game_night_2.mp3` | In-game, nighttime (pool track 2) |

Day/night pools crossfade (~3 s) when world time crosses the boundary
(ticks 13000 → night, 23000 → day). Tracks in a pool rotate when one ends.
Pausing the game does **not** change the music.

## UI + one-shot SFX

| File | Plays when |
|---|---|
| `ui/click.mp3` | Any UI button click |
| `sfx/hurt.mp3` | You take damage |
| `sfx/death.mp3` | You die |
| `sfx/hit.mp3` | You land a hit on a mob/player |
| `sfx/drop.mp3` | You toss an item (Q / touch drop) |
| `sfx/pickup.mp3` | You collect a dropped item |

## Footsteps (`assets/audio/steps/`) — 4 variants per surface

Surfaces: `grass dirt stone wood sand gravel snow cloth water`
(`water` = swim strokes while moving in water; also used for landing thuds
after a real fall, on whatever surface you land on.)

```
steps/grass_1.mp3   steps/grass_2.mp3   steps/grass_3.mp3   steps/grass_4.mp3
steps/dirt_1.mp3    steps/dirt_2.mp3    steps/dirt_3.mp3    steps/dirt_4.mp3
steps/stone_1.mp3   steps/stone_2.mp3   steps/stone_3.mp3   steps/stone_4.mp3
steps/wood_1.mp3    steps/wood_2.mp3    steps/wood_3.mp3    steps/wood_4.mp3
steps/sand_1.mp3    steps/sand_2.mp3    steps/sand_3.mp3    steps/sand_4.mp3
steps/gravel_1.mp3  steps/gravel_2.mp3  steps/gravel_3.mp3  steps/gravel_4.mp3
steps/snow_1.mp3    steps/snow_2.mp3    steps/snow_3.mp3    steps/snow_4.mp3
steps/cloth_1.mp3   steps/cloth_2.mp3   steps/cloth_3.mp3   steps/cloth_4.mp3
steps/water_1.mp3   steps/water_2.mp3   steps/water_3.mp3   steps/water_4.mp3
```

## Block dig sounds (`assets/audio/blocks/`)

Categories: `stone wood dirt grass sand gravel glass cloth snow`
Per category: `_break_1..3` (block breaks, 3 variants), `_place_1..2`
(block placed, 2 variants), `_hit_1` (soft tick while holding break).

```
blocks/stone_break_1.mp3  blocks/stone_break_2.mp3  blocks/stone_break_3.mp3
blocks/stone_place_1.mp3  blocks/stone_place_2.mp3  blocks/stone_hit_1.mp3
blocks/wood_break_1.mp3   blocks/wood_break_2.mp3   blocks/wood_break_3.mp3
blocks/wood_place_1.mp3   blocks/wood_place_2.mp3   blocks/wood_hit_1.mp3
blocks/dirt_break_1.mp3   blocks/dirt_break_2.mp3   blocks/dirt_break_3.mp3
blocks/dirt_place_1.mp3   blocks/dirt_place_2.mp3   blocks/dirt_hit_1.mp3
blocks/grass_break_1.mp3  blocks/grass_break_2.mp3  blocks/grass_break_3.mp3
blocks/grass_place_1.mp3  blocks/grass_place_2.mp3  blocks/grass_hit_1.mp3
blocks/sand_break_1.mp3   blocks/sand_break_2.mp3   blocks/sand_break_3.mp3
blocks/sand_place_1.mp3   blocks/sand_place_2.mp3   blocks/sand_hit_1.mp3
blocks/gravel_break_1.mp3 blocks/gravel_break_2.mp3 blocks/gravel_break_3.mp3
blocks/gravel_place_1.mp3 blocks/gravel_place_2.mp3 blocks/gravel_hit_1.mp3
blocks/glass_break_1.mp3  blocks/glass_break_2.mp3  blocks/glass_break_3.mp3
blocks/glass_place_1.mp3  blocks/glass_place_2.mp3  blocks/glass_hit_1.mp3
blocks/cloth_break_1.mp3  blocks/cloth_break_2.mp3  blocks/cloth_break_3.mp3
blocks/cloth_place_1.mp3  blocks/cloth_place_2.mp3  blocks/cloth_hit_1.mp3
blocks/snow_break_1.mp3   blocks/snow_break_2.mp3   blocks/snow_break_3.mp3
blocks/snow_place_1.mp3   blocks/snow_place_2.mp3   blocks/snow_hit_1.mp3
```

### Which blocks use which category

grass/leaves/flowers/tallgrass/vine/mushrooms → **grass** · dirt/clay → **dirt**
· snow_grass → **snow** · sand → **sand** · gravel → **gravel** ·
log/planks/bookshelf/melon/pumpkin → **wood** · wool*/cactus → **cloth** ·
glass/glowstone/ice/packed_ice → **glass** · everything else (stone, cobble,
ores, brick, obsidian, terracotta, quartz, granite/diorite/andesite, basalt,
end_stone, …) → **stone** · water: no dig sound.

The full mapping lives in `web/js/sound.js` (`CAT_EXACT` + `catForKey`).
