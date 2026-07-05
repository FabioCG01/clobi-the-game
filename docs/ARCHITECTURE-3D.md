# CLOBI'S ARENA — 3D VOXEL REVAMP: BINDING ARCHITECTURE CONTRACT

This document is the **single source of truth** for the 3D overhaul. Every module is
built against the APIs pinned here. If you are implementing a module: implement
EXACTLY the public API written here (you may add private helpers freely, and you MAY
add extra public members, but never rename/remove/change the semantics of what is
pinned). If you consume another module: consume EXACTLY what is pinned — the other
module may not exist yet while you write yours.

## 0. Product summary

TUX SMASH ROYALE pivots from a 2D 8-bit character creator to **CLOBI CRAFT**: a
fully 3D, cross-platform (desktop + mobile) voxel sandbox in the browser with:

- A custom WebGL2 voxel engine (no frameworks, no build step — house rule).
- One seamless world with **survival and creative** playstyles, switched live via
  an in-game command system (`/gamemode creative` …).
- Vibrant-realistic rendering: day/night sun, per-vertex AO, fog, water, and a
  post-process pass with filmic tonemapping + a signature **"CLOBI POP" color LUT**.
- A **1:1 Minecraft-compatible skin system**: 64×64 (and legacy 64×32) skin PNGs,
  classic (4 px arms) + slim (3 px arms) models, dual-layer (base + overlay) with
  both layers rendered as true 3D geometry. Real Minecraft skin .png files are
  plug-and-play.
- An in-game **Skin Studio** (paint on the flat "net" AND see a live 3D preview),
  remix culture (every published skin carries lineage), and a marketplace that
  now exclusively trades **complete 3D skins** (always free, community-moderated).

Old 2D modules (`editor.js`, `paint.js`, `sprites.js`, `textures.js`,
`assets/parts.js`, `assets/tex/`) are **retired and deleted**. `gag.js` (the
Activate Windows easter egg), `sound.js`, `i18n.js` and the account system live on.

## 1. House rules (unchanged from 2D era)

- Plain browser JS via `<script>` tags. **No ES modules, no frameworks, no build
  step.** Each file assigns **exactly one global** (`window.Foo = Foo;` at the end).
- Modern JS syntax is fine (const/let/arrows/classes); target = evergreen browsers
  with **WebGL2** (fallback: a friendly "needs WebGL2" message).
- Every user-visible string goes through `I18n.t('key', 'English fallback')`.
  New keys are prefixed `vox.` (game), `studio.`, `wardrobe.`, plus reuse of
  existing `market.*` / `menu.*` keys where they fit.
- Backend: Go stdlib + pgx/bcrypt only. Single static binary. The bbolt→Postgres
  migration in the working tree is the base — build on it, do not revert it.
- Comment density/style: match existing files (block header explaining the module,
  section banners like `// ---- xxx ----`).

## 2. Global module map + `<script>` load order

Load order in `web/index.html` (each file → one global):

| # | file | global | role |
|---|------|--------|------|
| 1 | `js/i18n.js` | `I18n` | localization (existing, keys added) |
| 2 | `js/gag.js` | `Gag` | Activate Windows easter egg (existing, untouched) |
| 3 | `js/sound.js` | `Sound` | SFX/music (existing, untouched). `Sound.play(name)` is safe with unknown names |
| 4 | `js/store.js` | `Store` | local persistence + REST client (extended for skins) |
| 5 | `js/vox/math3d.js` | `M3` | vectors/matrices/frustum |
| 6 | `js/vox/glx.js` | `GLX` | WebGL2 helpers |
| 7 | `js/vox/lut.js` | `LUT` | procedural color-grading LUT |
| 8 | `js/vox/blocks.js` | `Blocks` | block registry + procedural texture atlas |
| 9 | `js/vox/worldgen.js` | `WorldGen` | seeded terrain generator |
| 10 | `js/vox/world.js` | `World` | chunk storage + IndexedDB persistence |
| 11 | `js/vox/mesher.js` | `Mesher` | chunk → GPU mesh (AO, light) |
| 12 | `js/vox/skins.js` | `Skins` | Minecraft skin decoding, THE NET, templates |
| 13 | `js/vox/playermodel.js` | `PlayerModel` | dual-layer 3D player mesh + preview renderer |
| 14 | `js/vox/physics.js` | `Physics` | AABB collision, gravity, water, fly |
| 15 | `js/vox/input.js` | `Input` | keyboard/mouse/pointer-lock + touch controls |
| 16 | `js/vox/interact.js` | `Interact` | raycast, break/place, break progress |
| 17 | `js/vox/inventory.js` | `Inventory` | hotbar + survival counts + creative palette |
| 18 | `js/vox/commands.js` | `Commands` | chat + `/command` registry |
| 19 | `js/vox/hud.js` | `HUD` | all in-game DOM UI (crosshair, hotbar, chat, touch) |
| 20 | `js/vox/renderer.js` | `Renderer` | full frame pipeline incl. post/LUT |
| 21 | `js/vox/game.js` | `Game` | orchestrator + game loop |
| 22 | `js/skinstudio.js` | `SkinStudio` | the skin paint studio screen |
| 23 | `js/market.js` | `Market` | skin marketplace screen (rewrite) |
| 24 | `js/menu.js` | `Menu` | main menu screen (rewrite, keeps corner widgets + About/gag) |
| 25 | `js/main.js` | `App` | boot + screen router (rewrite) |

`web/index.html` screens (empty divs; each module owns its own DOM):
`#screen-menu`, `#screen-game` (contains `<canvas id="game-canvas">` + `<div id="hud-root">`),
`#screen-studio`, `#screen-wardrobe`, `#screen-market`, plus existing `#gag-overlay`, `#modal-root`.
Screen switching = `.active` class toggle (existing CSS pattern), via `App.showScreen(name)`
with `name ∈ {menu, game, studio, wardrobe, market}`.

## 3. Coordinates, units, world

- Right-handed, **Y up**. +X east, +Z south. 1.0 = one block edge = one metre.
- Yaw: radians, 0 = looking toward **−Z** (north), increases turning right
  (clockwise from above): forward = `(sin(yaw)·−1 ... )` — precisely:
  `forward = ( -sin(yaw)·cos(pitch), sin(pitch)... )` NO — pin it flat:
  `forwardXZ = (-sin(yaw), 0, -cos(yaw))`, `right = (cos(yaw), 0, -sin(yaw))`.
  Pitch: radians, positive looks **up**, clamped ±(π/2 − 0.001).
  Look direction: `dir = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))`.
- World height `WORLD_H = 96` (y ∈ [0,95]); bedrock at y=0; **sea level y=40**.
- Chunk = 16×96×16 blocks. Chunk coords `cx = floor(x/16)`, `cz = floor(z/16)`.
  Block index inside a chunk `Uint8Array(16*96*16)`: `i = (y*16 + z)*16 + x`
  with local x,z ∈ [0,15].
- Player AABB 0.6 wide × 1.8 tall × 0.6 deep; eye height 1.62 (1.27 sneaking);
  spawn at world center highest solid + 1.
- Time: ticks 0..24000 like Minecraft (0 = dawn, 6000 = noon, 12000 = dusk,
  18000 = midnight), advancing 20 ticks/s (full day = 20 min).

## 4. Block registry (`Blocks`)

IDs are stable (Uint8). `0 = AIR`.

| id | key | name (en) | solid | opaque | hardness s | notes |
|----|-----|-----------|-------|--------|-----------|-------|
| 0 | air | Air | no | no | — | |
| 1 | grass | Grass Block | yes | yes | 0.9 | green top, dirt bottom, blended side |
| 2 | dirt | Dirt | yes | yes | 0.75 | |
| 3 | stone | Stone | yes | yes | 2.5 | drops cobblestone |
| 4 | cobble | Cobblestone | yes | yes | 3.0 | |
| 5 | bedrock | Bedrock | yes | yes | ∞ (unbreakable) | |
| 6 | log | Tux Log | yes | yes | 1.5 | ringed top |
| 7 | planks | Planks | yes | yes | 1.5 | |
| 8 | leaves | Leaves | yes | **no** (cutout) | 0.3 | alpha-tested, both faces |
| 9 | sand | Sand | yes | yes | 0.75 | |
| 10 | gravel | Gravel | yes | yes | 0.9 | |
| 11 | water | Water | **no** | no (translucent) | — | not placeable/breakable v1; α≈0.72, waves |
| 12 | glass | Glass | yes | no (cutout) | 0.4 | clear pane w/ frame |
| 13 | brick | Brick | yes | yes | 3.0 | |
| 14 | bookshelf | vim Shelf | yes | yes | 1.8 | book spines w/ tiny `:wq` |
| 15 | glowstone | Menthol Lamp | yes | yes | 0.5 | emissive (lights up at night via emissive term) |
| 16 | coal_ore | Coal Ore | yes | yes | 3.0 | |
| 17 | iron_ore | Iron Ore | yes | yes | 3.5 | |
| 18 | gold_ore | Gold Ore | yes | yes | 3.5 | |
| 19 | diamond_ore | Diamond Ore | yes | yes | 4.0 | |
| 20 | snow_grass | Snowy Grass | yes | yes | 0.9 | high-altitude grass variant |
| 21 | wool_white | White Wool | yes | yes | 1.0 | |
| 22 | wool_red | Red Wool | yes | yes | 1.0 | |
| 23 | wool_green | Green Wool | yes | yes | 1.0 | |
| 24 | wool_blue | Blue Wool | yes | yes | 1.0 | |
| 25 | wool_yellow | Yellow Wool | yes | yes | 1.0 | |
| 26 | wool_black | Black Wool | yes | yes | 1.0 | |
| 27 | flower_red | Red Flower | **no** | no | 0.05 | cross-quads |
| 28 | flower_yellow | Yellow Flower | no | no | 0.05 | cross-quads |
| 29 | tallgrass | Tall Grass | no | no | 0.05 | cross-quads, drops nothing |
| 30 | sandstone | Sandstone | yes | yes | 2.0 | |
| 31 | obsidian | Obsidian | yes | yes | 15.0 | |
| 32 | tux_block | Tux Block | yes | yes | 1.5 | pixel-art Tux face on sides — brand block |
| 33 | lozenge | Fisherman's Block | yes | yes | 1.0 | mint-white lozenge look, subtle emissive |

API:

```js
Blocks.AIR === 0
Blocks.byId(id)   -> def | undefined   // def fields below
Blocks.byKey(key) -> def | undefined
Blocks.list()     -> [def...]          // placeable, id-ascending (excludes air, water, bedrock? NO —
                                       // includes bedrock+water only for creative; def.placeable flag)
Blocks.buildAtlas(gl) -> { tex: WebGLTexture, tileUV(tileIndex) -> [u0,v0,u1,v1] }
Blocks.ATLAS_TILES = 16                // 16×16 tiles of 16×16 px → 256×256 canvas
```

`def = { id, key, name, i18nKey, solid, opaque, liquid, cross, cutout, translucent,
hardness, emissive (0..1), placeable, drops (id), tiles: {top, side, bottom} (atlas
tile indices) }`. Name lookup for UI: `I18n.t(def.i18nKey, def.name)`.

Atlas is drawn procedurally on an offscreen canvas at boot (16×16 px tiles,
hand-crafted pixel patterns with per-pixel deterministic noise — NO external
images). Water tile = animated in shader (not atlas frames). `buildAtlas` uploads
NEAREST/NEAREST, no mips, premultiplied = false, and returns half-texel-inset
`tileUV`s to prevent bleeding.

## 5. Module contracts (client)

### 5.1 `M3` (js/vox/math3d.js)

Column-major `Float32Array(16)` matrices (WebGL convention).

```js
M3.mat4Identity(out?) M3.mat4Multiply(out,a,b) M3.mat4Perspective(out,fovYrad,aspect,near,far)
M3.mat4LookDir(out, eye[3], dir[3], up[3])   // view matrix from eye + direction
M3.mat4Translate(out,m,x,y,z) M3.mat4RotateX(out,m,rad) M3.mat4RotateY(out,m,rad)
M3.mat4Scale(out,m,x,y,z) M3.mat4Ortho(out,l,r,b,t,n,f) M3.mat4Invert(out,m)
M3.transformPoint(out[3], m, p[3])
M3.frustumFromMatrix(out6planes, projView)   // out: Float32Array(24), 6 planes (a,b,c,d)
M3.frustumTestAABB(planes, minx,miny,minz, maxx,maxy,maxz) -> bool  // true = visible
M3.v3(x,y,z) add/sub/scale/cross/dot/normalize/length  (allocation-light, out-param style)
```

### 5.2 `GLX` (js/vox/glx.js)

```js
GLX.getContext(canvas) -> gl | null           // webgl2, antialias:false, alpha:false
GLX.program(gl, vsSrc, fsSrc) -> WebGLProgram // throws Error with shader log on failure
GLX.uniforms(gl, prog) -> {name: WebGLUniformLocation}   // all active uniforms
GLX.texture2D(gl, {width,height,data|canvas|image, filter:'nearest'|'linear', wrap:'clamp'|'repeat', srgb:false}) -> tex
GLX.updateTexture2D(gl, tex, canvas)
GLX.fbo(gl, w, h, {depth:true}) -> {fb, colorTex, depthRb, w, h, resize(w,h), destroy()}
GLX.vao(gl, prog, buffers) -> {vao, draw(count, mode?), destroy()}
   // buffers: [{name:'aPos', size:3, data:Float32Array, type?:gl.FLOAT, normalized?, stride?, offset?}, ...]
   //          plus optional {index: Uint32Array} element buffer (draw uses drawElements then)
GLX.fullscreenQuad(gl) -> {draw(prog)}        // shared -1..1 quad; aPos location 0
```

### 5.3 `LUT` (js/vox/lut.js)

The signature "CLOBI POP" grade: filmic S-curve, +sat in mids, teal-pushed
shadows, warm highlights, protected skin tones, slightly lifted blacks.

```js
LUT.SIZE = 32
LUT.generateCanvas() -> canvas(1024×32)   // 32 slices of 32×32 side by side; slice = blue
LUT.texture(gl) -> WebGLTexture           // LINEAR/LINEAR, clamp
LUT.shaderSnippet() -> GLSL string        // vec3 applyLUT(sampler2D lut, vec3 c) with 2-slice blend
```

### 5.4 `WorldGen` (js/vox/worldgen.js)

Deterministic from an integer seed. Pure functions; no GL, no DOM.

```js
WorldGen.create(seed:int) -> gen
gen.generateChunk(cx, cz) -> Uint8Array(16*96*16)    // block ids, indexing per §3
gen.surfaceHeight(x, z) -> int                        // terrain height used for spawn
```

Terrain: layered value noise (2–3 octaves, integer-hash based — include your own
hash/noise, no deps): rolling plains + hills (amplitude ±16 around y≈44), sand
beaches near sea level (±1), gravel/sand patches, snow_grass above y≈66, water
fills y≤40 in air below terrain, stone below 3–4 dirt, bedrock y=0, ore veins
(coal common → diamond rare, depth-gated), scattered oak trees (trunk 4–6 +
leaf blob, deterministic per-column hash, never overhanging chunk borders by
more than 2 — trees may write into neighbor area of their OWN chunk only; to keep
chunks independent, only plant trees whose canopy (radius 2) fits inside the
chunk), flowers/tallgrass tufts on grass.

### 5.5 `World` (js/vox/world.js)

```js
World.create({seed, name:'default', gen: WorldGen-gen}) -> world
world.getBlock(x,y,z) -> id (0 outside height range / ungenerated)
world.setBlock(x,y,z, id)          // marks chunk + neighbors dirty, records edit
world.getChunk(cx,cz) -> {blocks:Uint8Array, cx, cz} | null    // null if not generated yet
world.ensureChunk(cx,cz)           // generate now (synchronous) if missing
world.chunksInRadius(cx,cz,r) -> [chunk...]  // generated only
world.dirtyChunks() -> [[cx,cz]...]; world.clearDirty(cx,cz)
world.heightAt(x,z) -> highest solid y at column (from live data)
world.save() -> Promise           // persist edited chunks + meta to IndexedDB
world.setMeta(obj); world.getMeta() -> obj   // player pos, mode, time, spawn, hotbar…
World.load(name) -> Promise<{seed, meta, edits} | null>   // static: read saved world
World.wipe(name) -> Promise       // delete saved world
```

Persistence: IndexedDB db `clobi3d` v1, object stores `meta` (key = world name)
and `chunks` (key = `name:cx,cz`, value = Uint8Array buffer). Only chunks that
were **edited** are stored (generation is deterministic; unedited chunks rebuild
from seed). `world.save()` is called by Game every ~4 s and on pause/unload.

### 5.6 `Mesher` (js/vox/mesher.js)

```js
Mesher.meshChunk(world, cx, cz) -> {
  opaque:      {pos:Float32Array, uv:Float32Array, shade:Float32Array, count},  // + cutout faces
  translucent: {pos, uv, shade, count},        // water
  empty: bool
}
```

- Face culling vs neighbors (`world.getBlock` across borders; treat ungenerated
  neighbor as AIR — Game only meshes chunks whose 4 neighbors are generated).
- `shade` = one float per vertex: `faceLight * ao * skyExposure` where
  faceLight = {top 1.0, north/south 0.82, east/west 0.7, bottom 0.55},
  ao = classic 4-sample vertex AO (0.55..1.0 steps),
  skyExposure = 1.0 if no opaque block above the face's block (column check), else
  0.55 (underground ambient). Emissive blocks write shade ≥ 1.2 (renderer clamps).
- Cross blocks → two diagonal quads, both windings (no culling), in `opaque`
  batch (cutout in shader via alpha discard).
- Water: only faces against non-water; top surface lowered to 14/16; goes to
  `translucent`.
- Leaves/glass: cutout, in `opaque` batch, faces rendered vs any non-identical
  neighbor.

### 5.7 `Skins` (js/vox/skins.js) — THE NET (single source of truth)

Minecraft-format skins. Formats accepted: PNG 64×64 (modern), 64×32 (legacy,
auto-converted). Two model variants: `'classic'` (4 px arms) and `'slim'` (3 px).
Two layers everywhere: base + overlay (hat/jacket/sleeves/pants), overlay drawn
as inflated 3D boxes with alpha-cutout.

```js
Skins.NET -> the box/UV table below (frozen object; studio + docs consume it)
Skins.load(src) -> Promise<skin>       // src: URL | dataURL | File | Image | canvas
   // skin = { canvas (64×64), model ('classic'|'slim' auto-detected), dataURL() }
Skins.loadDefault() -> Promise<skin>   // fetches 'assets/skins/default.png', model 'classic';
                                       // on fetch failure falls back to Skins.FALLBACK_PNG (tiny embedded data URL)
Skins.detectModel(canvas64) -> 'classic'|'slim'
Skins.convertLegacy(imgOrCanvas 64×32) -> canvas 64×64
Skins.normalize(imgOrCanvas) -> canvas 64×64   // pass-through or legacy-convert; throws Error('vox.err.badSkin') on wrong dims
Skins.texture(gl, skin) -> WebGLTexture        // NEAREST, no mips, flipY=false
Skins.templateCanvas(model) -> canvas 64×64    // color-coded region template (studio + download)
Skins.regionAt(x, y, model) -> {part, layer, face} | null   // reverse lookup for studio tooltips
```

**Model geometry (model units: 1 u = 1 px = 1/16 block; whole model scaled ×0.9375
at render so the 32 u figure stands ≈1.8 blocks tall):**

| part | size W×H×D (u) | pivot (model space, y up, origin at feet center) |
|------|----------------|--------------------------------------------------|
| head | 8×8×8 | neck (0, 24, 0) — box spans y 24..32 |
| body | 8×12×4 | (0, 24, 0) top — box spans y 12..24 |
| rightArm | 4(3)×12×4 | shoulder (−6, 22, 0) — classic box x −8..−4; slim −7..−4 |
| leftArm | 4(3)×12×4 | shoulder (+6, 22, 0) — mirrored |
| rightLeg | 4×12×4 | hip (−2, 12, 0) — box spans y 0..12 |
| leftLeg | 4×12×4 | hip (+2, 12, 0) |

Overlay layer inflation (each side, model units): head **+0.5**; all others **+0.25**.
Overlay rendered with `discard` when alpha < 0.5 and **culling disabled**.
Base layer: fully opaque (alpha forced to 1 — Minecraft treats base as opaque;
this is what makes arbitrary downloaded skins render correctly).

**THE NET — UV rectangles `(x, y, w, h)` in the 64×64 grid, per face.**
Box unwrap rule for a box W×H×D at net origin (U,V):
`top=(U+D, V, W, D)  bottom=(U+D+W, V, W, D)  right=(U, V+D, D, H)
front=(U+D, V+D, W, H)  left=(U+D+W, V+D, D, H)  back=(U+D+W+D, V+D, W, H)`
("right" = the box's own right = viewer's left when facing the front face.)
**Bottom faces are V-flipped** (sampled upside-down) — Minecraft convention.

Net origins (U,V) per part (identical rule applied with that part's W,H,D):

| part | base layer | overlay layer |
|------|-----------|----------------|
| head (8,8,8) | (0,0) | (32,0) |
| body (8,12,4) | (16,16) | (16,32) |
| rightArm (4|3,12,4) | (40,16) | (40,32) |
| leftArm (4|3,12,4) | (32,48) | (48,48) |
| rightLeg (4,12,4) | (0,16) | (0,32) |
| leftLeg (4,12,4) | (16,48) | (0,48) |

(Slim uses W=3 for arms — same origins; the strip is 2 px narrower.)

**Slim auto-detect:** slim if ALL of these pixels have alpha 0:
(54,20),(55,20),(54,26),(55,26),(54,31),(55,31) — the columns a classic right-arm
back face uses but slim leaves empty. UI always allows manual override.

**Legacy 64×32 → 64×64:** copy the whole 64×32 to the top half; then synthesize
left limbs by mirroring right limbs (per-face horizontal flip, right/left faces
swapped) into the new regions: rightLeg(0,16)→leftLeg(16,48); rightArm(40,16)→
leftArm(32,48). Overlay regions below y=32 stay transparent.

### 5.8 `PlayerModel` (js/vox/playermodel.js)

```js
PlayerModel.init(gl)                          // build programs + geometry (both models, both layers)
PlayerModel.draw(gl, opts)                    // one fully-posed player
  // opts: { skinTex, model, viewProj (mat4), pos:[x,y,z], yaw, headYaw, headPitch,
  //         swing (0..1 walk cycle phase), swingAmp (0..1), crouch:bool, light (0..1),
  //         fog: {color:[r,g,b], start, end}, camPos:[x,y,z] }
PlayerModel.drawFirstPersonArm(gl, {skinTex, model, proj, swing01 (attack), bob, light})
PlayerModel.preview(skin, opts) -> HTMLCanvasElement   // offscreen renderer for thumbnails
  // opts: { width=160, height=200, yaw=0.6, pitch=-0.15, zoom=1, pose='stand'|'walk', transparent=true }
  // Uses ONE lazily-created hidden WebGL2 canvas internally; synchronous once Skins.load resolved.
PlayerModel.attachTurntable(canvas2d, skin, opts) -> {setSkin(skin), setModel(m), setPose(p), destroy()}
  // continuous rotating preview painted into the given 2D canvas via rAF; drag/touch-drag to rotate.
```

Animation: legs swing ±40°·swingAmp with phase `sin(swing·2π)`, arms opposite;
idle arm sway; head independent (headYaw clamped ±75° relative to body yaw).
Overlay boxes: same pose, inflated (§5.7), alpha-cutout, no culling.

### 5.9 `Physics` (js/vox/physics.js)

```js
Physics.createBody({x,y,z}) -> body   // {pos, vel, onGround, inWater, headInWater, width:0.6, height:1.8}
Physics.step(world, body, input, dt, opts)
  // input: {forward,strafe (−1..1), jump, sneak, sprint:bool}
  // opts:  {mode:'walk'|'fly', speedMult:1}
  // walk: g=32, jumpV=9.0, walk 4.3 m/s, sprint 5.6, sneak 1.3 (and won't walk off edges is NOT required v1),
  //        water: buoyancy, drag, swim-up with jump, walk 2.2
  // fly:   no g, 10.8 m/s (sprint 21.6), jump=up, sneak=down, instant stop
  // Axis-separated AABB sweep vs solid blocks; step-up NOT included (jump instead).
Physics.fallDamage(fallDistance) -> half-hearts (int, 0 if < 3.5 blocks; (d-3) rounded)
```

### 5.10 `Input` (js/vox/input.js)

```js
Input.init({canvas, hudRoot})       // installs all listeners; builds touch DOM inside hudRoot when touch
Input.isTouch -> bool               // maxTouchPoints > 0 && coarse pointer
Input.state -> {forward,back,left,right,jump,sneak,sprint}   // live booleans (WASD/space/shift/ctrl or touch)
Input.move -> {forward:−1..1, strafe:−1..1}                  // analog (joystick) or derived from state
Input.consumeLook() -> {dx, dy}     // accumulated look deltas (mouse-locked px or touch-drag px) since last call
Input.consumeActions() -> [{type:'breakStart'|'breakStop'|'place'|'pick'}...]
   // desktop: LMB hold=break, RMB=place, MMB=pick. touch: see §8.
Input.on(evt, fn)  // evt: 'hotbar'(n 0..8) | 'hotbarScroll'(±1) | 'chat'(prefill) | 'pause'
                   //      | 'debug' | 'perspective' | 'inventory' | 'flyToggle'(double-space)
Input.setUIMode(on)                 // true while chat/menus open: game keys released & ignored
Input.requestPointerLock(); Input.exitPointerLock(); Input.isLocked -> bool
Input.setTouchVisible(on)           // show/hide touch controls (Game calls when entering/leaving game screen)
```

Key map (desktop): WASD move, Space jump/fly-up, Shift sneak/fly-down, Ctrl/R sprint,
E inventory, T chat, / chat-prefill "/", Esc pause (via pointerlock loss), F3 debug,
F5 perspective, 1-9 hotbar, wheel hotbar scroll, double-Space fly toggle (creative).

### 5.11 `Interact` (js/vox/interact.js)

```js
Interact.raycast(world, origin[3], dir[3], maxDist) -> {hit:bool, x,y,z, face:[nx,ny,nz], dist} 
   // Amanatides–Woo DDA; face = normal of the struck face
Interact.create({world, player, inventory, hud}) -> sys
sys.update(dt, actions, camera)     // consumes Input actions; handles:
   // survival: hold-to-break with progress 0..1 (block.hardness seconds, ×5 penalty in water/air-borne NOT required),
   //           creative: instant break (150 ms repeat), place from hotbar w/ AABB-overlap veto,
   //           reach: 4.5 survival / 6 creative; pick-block (MMB) sets hotbar slot.
sys.target -> {hit, x,y,z, progress 0..1} | null    // renderer draws selection box + crack overlay
```

Breaking drops: `def.drops` (default self) added via `Inventory.add(id,1)` in
survival; nothing in creative. Placing: consumes 1 in survival; never in creative.
Sounds: `Sound.play('dig')` on break, `Sound.play('place')` on place (guarded).

### 5.12 `Inventory` (js/vox/inventory.js)

```js
Inventory.create(mode) -> inv
inv.hotbar -> [{id, count}|null ×9]; inv.selected -> 0..8; inv.select(n)
inv.selectedBlock() -> id|0
inv.add(id, n) -> leftover      // stacks to 64, hotbar then backpack (27 slots)
inv.consumeSelected()           // survival place; creative = no-op
inv.setCreativeDefaults(); inv.setSurvivalDefaults()   // sensible starter bars
inv.backpack -> [{id,count}|null ×27]
inv.serialize()/Inventory.deserialize(obj)
inv.onChange(fn)                // HUD subscribes
```

Creative palette = `Blocks.list().filter(d => d.placeable)` — the HUD inventory
panel lets you put any of them in the hotbar (creative) or arrange what you own
(survival).

### 5.13 `Commands` (js/vox/commands.js)

```js
Commands.init(ctx)   // ctx: {game, hud}  (hud.chatPrint(text, cls?) exists — see 5.14)
Commands.exec(line)  // "/gamemode creative" or plain chat text (echoed locally as <name> text)
Commands.register(name, {usage, help, aliases?, exec(args, ctx)})
Commands.list() -> [{name, usage, help}]   // for /help + autocomplete
```

Built-ins (all with i18n'd help): `/help [cmd]`, `/gamemode <survival|creative|s|c|0|1>`
(alias `/gm`), `/tp <x y z>` (accepts `~` relatives), `/time <set day|noon|night|midnight|N>|<add N>`,
`/give <blockKey|id> [count]`, `/clear`, `/seed`, `/setspawn`, `/spawn`, `/kill`,
`/fly`, `/speed <0.5..10>`, `/fov <30..110>`, `/dist <2..10>` (render distance),
`/lut <0..100>` (grade strength), `/skin <classic|slim>` (live model swap),
`/regen [seed]` (new world — confirm), `/save`.
Unknown command → red error line. `/gamemode` fires `game.setMode(mode)` and
prints confirmation; survival→creative keeps inventory; creative→survival keeps it too.

### 5.14 `HUD` (js/vox/hud.js)

Owns ALL game-screen DOM inside `#hud-root`. Class names pinned for CSS:

```
.vox-crosshair, .vox-hotbar, .vox-slot (+.sel), .vox-slot-count, .vox-hearts, .vox-heart(.empty/.half),
.vox-bubbles, .vox-bubble, .vox-chat, .vox-chat-log, .vox-chat-line(.err/.sys), .vox-chat-input,
.vox-debug, .vox-break-vignette (unused ok), .vox-paused, .vox-touch (container),
.vox-joy, .vox-joy-knob, .vox-btn-jump, .vox-btn-sneak, .vox-btn-fly-up, .vox-btn-fly-down,
.vox-btn-pause, .vox-btn-chat, .vox-btn-inv, .vox-btn-persp, .vox-mode-badge, .vox-inv-panel,
.vox-inv-grid, .vox-inv-cell, .vox-hotbar-row, .vox-tooltip, .vox-title-toast
```

```js
HUD.init({root, game})       // builds DOM once
HUD.update(state)            // per-frame cheap updates (called by Game):
  // state: {mode, health(0..20), air(0..10 or null), selected, hotbar, fps, pos, targetName, time}
HUD.chatPrint(text, cls?)    // append line ('err'|'sys'|undefined), max 100 lines, auto-fade
HUD.openChat(prefill?)       // shows input, Input.setUIMode(true); Enter → Commands.exec; Esc closes
HUD.isChatOpen() -> bool
HUD.toast(text)              // big center toast (gamemode changes)
HUD.setDebug(visible)/HUD.toggleDebug()
HUD.openInventory()/closeInventory()   // creative palette / survival backpack panel
HUD.showPaused(on, {onResume, onSettings, onQuit})   // pause overlay (touch pause btn + Esc)
HUD.destroy()
```

Hotbar slot icons: tiny per-block canvas (top+two sides fake-iso drawn from atlas
tiles — helper may live in HUD; 40×40). Hearts/bubbles hidden in creative.

### 5.15 `Renderer` (js/vox/renderer.js)

```js
Renderer.init(gl, {atlas, lutTex}) 
Renderer.resize(w, h, dpr)
Renderer.beginFrame(camera, env)   // camera: {pos, yaw, pitch, fovDeg, aspect, view, proj, projView}
                                   // env: {timeTicks, sunDir[3], skyTop[3], skyHorizon[3], fogColor[3],
                                   //       fogStart, fogEnd, sunColor[3], ambient (0..1), underwater:bool}
Renderer.computeEnv(timeTicks, renderDist) -> env    // the day/night color script lives here
Renderer.drawSky(env, camera)
Renderer.uploadChunkMesh(cx, cz, meshData) / Renderer.dropChunkMesh(cx, cz)   // owns VAOs
Renderer.drawChunks(camera, env, pass)   // pass: 'opaque'|'translucent'; frustum-culled, sorted for translucent
Renderer.drawSelection(camera, target)   // black wireframe box + crack texture by target.progress
Renderer.drawClouds(env, camera, timeMs)
Renderer.endFrame(postOpts)              // resolves scene FBO → canvas with post shader
  // postOpts: {lutAmount 0..1, vibrance, gamma, underwater:bool, vignette:0.15}
Renderer.destroyAll()
```

Pipeline per frame: scene FBO (RGBA8+depth) → sky → opaque chunks (+cutout) →
entities (Game calls PlayerModel.draw between passes) → selection → translucent
chunks → clouds → post to default framebuffer (tonemap: `c/(c+0.35)*1.35` filmic-ish,
vibrance boost, **LUT via `LUT.shaderSnippet()`**, subtle vignette, underwater =
blue tint + slight wobble). Post shader is where "vibrant realism" lives — bright
saturated palette, NOT washed out.

Chunk shaders: vertex takes aPos/aUV/aShade; fog = exp2 by distance in [fogStart,
fogEnd]; fragment: `albedo(atlas) * (ambient + sunColor*shade) → fog(env)`.
Emissive (shade>1) bypasses darkness at night. Water: time-based sine wobble on
UV + alpha 0.72, fresnel-ish brighten at grazing angle (cheap: mix by view dot).

### 5.16 `Game` (js/vox/game.js)

```js
Game.start({mode:'survival'|'creative', seed?:int, fresh?:bool}) -> Promise
   // loads or creates the 'default' world; shows #screen-game; grabs input
Game.stop()                      // saves, releases GL chunk meshes, back to menu (App.showScreen('menu'))
Game.isRunning -> bool
Game.setMode(mode)               // live switch: physics flags, HUD, inventory behavior; toast + chat line
Game.mode -> 'survival'|'creative'
Game.player -> {body, yaw, pitch, health(0..20), air, spawn:[x,y,z], flying, speedMult, perspective:0|1|2}
Game.world -> world  | Game.inventory -> inv | Game.timeTicks
Game.setTime(t); Game.addTime(dt)
Game.teleport(x,y,z)  Game.respawn()  Game.setSpawn(x,y,z)
Game.setRenderDist(chunks 2..10)   Game.setFov(deg)   Game.setLutAmount(0..1)  Game.setSpeed(mult)
Game.setSkin(skin)               // live: swaps player texture + model (from Skins.load result)
Game.regen(seed?) -> Promise     // wipe + fresh world
Game.debugSnapshot() -> {pos, mode, fps, chunkCount, drawCalls?, seed, time}   // for tests/debug
```

Loop: `requestAnimationFrame`; fixed 60 Hz physics accumulator (max 5 steps);
per frame: input → physics → interact → time advance → chunk stream (generate
nearest-first within renderDist+1, budget ≈3 ms/frame; mesh dirty chunks budget 2/frame,
nearest first; drop far meshes) → Renderer passes → HUD.update. Camera: 1st person
(+view-model arm), F5: 3rd back, 3rd front (draw own player via PlayerModel).
Survival: fall damage on landing, drowning after 10 bubbles (1 damage/s), void y<−8
kills, death overlay → respawn at spawn. Health regen: +1 per 4 s when > 30 s since damage.
URL dev hooks (read in `Game.start` via `location.search`): `?seed=N&mode=creative&dist=3&dev=1`
(`dev=1`: skip pointer-lock requirement, expose `window.__vox = {Game, World: world}`).
Autosave every 4 s (dirty only) + on `visibilitychange`/`pagehide` + on stop.

### 5.17 `SkinStudio` (js/skinstudio.js)

Full-screen editor in `#screen-studio`.

```js
SkinStudio.show(opts?)   // opts: {skin (Skins skin), record (library rec), remixOf (market item), fresh:bool}
SkinStudio.hide()
```

Layout (responsive; stacked on portrait mobile): left = zoomable **net canvas**
(the 64×64 grid, region outlines + hover labels via `Skins.regionAt`, checkered
transparency, faint template ghost toggle); right = live 3D turntable preview
(`PlayerModel.attachTurntable`) with pose toggle (stand/walk) + layer visibility
toggles; toolbar: pen / eraser / fill / eyedropper / line / **mirror mode**
(paints the mirrored limb region simultaneously), color swatch + full HSV+alpha
picker, brush 1–3 px, undo/redo (≥50 steps), zoom (wheel/pinch) + pan (space-drag /
two-finger), layer select (base paints opaque; overlay paints with alpha).
Actions: New (from template / from current skin / blank), Import PNG file
(drag-drop + file input, any MC skin — plug-and-play), Export/download PNG,
model toggle classic/slim (repacks arm regions, warns on 4→3 crop), Save to
wardrobe (`Store.saveSkin`), Publish (title + tags modal → `Store.marketPublishSkin`),
and when opened with `remixOf`: banner crediting the original + lineage kept.
Every edit runs on the canonical 64×64 canvas; live preview updates ≤ 16 ms via
`turntable.setSkin`.

### 5.18 `Market` (js/market.js — rewrite; keep the old file's moderation UX patterns)

Skin-only marketplace in `#screen-market`. Cards: 3D preview thumbnail
(`PlayerModel.preview`), title, author, model badge (classic/slim), stars,
downloads, report state. Search / sort (new, old, rating hi/lo, downloads hi/lo) /
filter by model. Item modal: big draggable turntable, Try on (session-only wear),
**Wear** (set active skin), **Download** (save copy to wardrobe), **Remix**
(→ `SkinStudio.show({remixOf: item})`), rate (half-stars), threaded comments,
report/vouch/cancel with live counts, author/admin delete, admin ban/revoke;
censored items blur their preview (CSS class `censored`) exactly like the old UI.
Publish flow comes FROM the studio/wardrobe (no direct upload here).
`Market.show()` / `Market.hide()`.

### 5.19 `Store` (js/store.js — extend, keep all existing account/token/i18n bits)

Keep: register/login/logout/isLoggedIn/getToken/getUsername, nickname get/set,
admin flag. **Remove** old character/texture/preset sync paths from the PUBLIC
docs but keep functions no-op-safe if referenced. Add:

```js
Store.getActiveSkin() -> rec|null          // localStorage 'clobi.activeSkin'
Store.setActiveSkin(rec)                   // rec: {name, model, png (dataURL 64×64), remixOf?, marketId?}
Store.onSkinChange(fn)                     // menu preview + game live-update subscribe
Store.syncActiveSkinRemote() -> Promise    // PUT /api/skin when logged in (no-op otherwise)
Store.loadActiveSkinRemote() -> Promise<rec|null>
Store.getDefaultSkinRemote() -> Promise<rec|null>   // GET /api/default-skin (404 → null)
Store.listSkins() -> [rec]                 // wardrobe library, localStorage 'clobi.skins' (id→rec map)
Store.saveSkin(rec) -> rec                 // assigns id 'sk'+random when missing; syncs to cloud library when logged in
Store.deleteSkin(id)
Store.syncSkinLibrary() -> Promise         // pull cloud library (records with kind==='skin') after login
Store.marketListSkins(opts) -> Promise<[item]>     // GET /api/market/list?kind=skin&…
Store.marketItem(id), Store.marketPublishSkin({title,tags,model,png,remixOf}),
Store.marketRate(id,stars), Store.marketComment(id,text,parentId),
Store.marketReport(id,reason), Store.marketUnreport(id), Store.marketVouch(id),
Store.marketUnvouch(id), Store.marketDownload(id), Store.marketDelete(id),
Store.marketAdmin(id, 'ban'|'revoke')      // thin fetch wrappers, Bearer token when present
Store.setAdminDefaultSkin(rec) -> Promise  // POST /api/admin/default-skin
```

All fetch wrappers reject with `Error(message-from-server)` and NEVER throw
synchronously; offline → rejected promise the UI turns into a friendly toast.

### 5.20 `Menu` (js/menu.js — rewrite, same visual soul)

Hero: game logo + a large live **turntable of the player's current skin**.
Buttons: **PLAY** (continue world; sub-row: "New world" → seed + mode picker
modal), **WARDROBE**, **SKIN STUDIO**, **MARKETPLACE**. Keep from old menu:
top-right corner cluster (language switcher, sound toggle, About modal — the
About modal MUST keep the Activate Windows gag button wired to `Gag`), sign-in
modal (Store register/login), footer credits. On `Store.onSkinChange` refresh the
turntable. First-visit language popup: `Menu.showLanguagePopup()` (port from old).

### 5.21 `App` (js/main.js — rewrite)

Boot: I18n.init → resolve active skin (Store.getActiveSkin → logged-in remote →
server default → `Skins.loadDefault()`) → `App.skin` (a Skins skin object) +
keep in sync via Store.onSkinChange → showScreen('menu') → Menu.show() →
language popup if `!I18n.hasChosen()`.
`App.showScreen(name)` toggles `.active` on the five screens and calls
`Module.show()/hide()` lifecycle of the target/leaving screen.
`App.skin` (getter), `App.setSkin(rec)` (Store.setActiveSkin + sync + if
Game.isRunning → Game.setSkin). `App.boot()` wired exactly like the old file
(DOMContentLoaded).

## 6. Wardrobe screen (part of Menu module file or its own DOM in `#screen-wardrobe`, owned by `Menu`)

Grid of the player's skin library (3D thumbnails), actions per skin: Wear,
Edit (studio), Duplicate, Export PNG, Delete, Publish. Plus: Import PNG
(file/drag-drop — accepts any Minecraft skin), New skin (→ studio), and the
current active skin highlighted. Keep it inside `menu.js` (Menu.showWardrobe()
internally routed via `App.showScreen('wardrobe')`).

## 7. Rendering aesthetic targets ("vibrant realism")

- Daylight: warm sun (1.0, 0.98, 0.92), sky top `#3D8BFF`, horizon `#BFE3FF`,
  fog = horizon color; noon ambient 0.55.
- Sunset/sunrise (ticks 11000–13000 / 23000–1000): sun/fog blend to `#FF9A3C`,
  sky magenta-orange gradient.
- Night: deep blue `#0A1230`, ambient 0.16, stars (procedural point sprites ok,
  optional), moon disc opposite sun.
- Post: exposure 1.0, filmic curve, vibrance +0.18, LUT amount default 0.85.
  The LUT is the identity of the game — punchy teal-orange with protected greens.
- Selection: 2px black wireframe; crack overlay 5 stages drawn into a tiny canvas.

## 8. Touch controls (mobile)

Left half: floating joystick (appears at touch-down point; knob analog →
`Input.move`). Right half: drag = look (sensitivity ~0.28 °/px·dpr-aware).
Buttons (bottom-right cluster): JUMP (hold = keep jumping/swim), SNEAK toggle;
creative fly: UP/DOWN buttons appear when flying, double-tap JUMP toggles fly.
Top bar: pause ⏸, chat 💬, inventory 🎒, perspective 👁. Block interaction:
**tap** = place (on the face you tapped), **long-press (280 ms) + hold** = break
with progress; both use a raycast through the tapped screen point (NOT the
crosshair) — implemented by Input emitting `{type:'tapPlace', px, py}` /
`{type:'tapBreakStart', px, py}` / `{type:'tapBreakStop'}` actions; Interact
resolves px,py → ray via camera unproject (`M3.mat4Invert(projView)`).
All buttons ≥ 48 px, `touch-action: none` on canvas + controls,
`env(safe-area-inset-*)` respected. Landscape recommended banner when portrait
+ width < 700 (dismissable, i18n'd).

## 9. Backend contract changes (Go, on top of the Postgres WIP)

New content type — the **skin record** (client JSON, snake-free camelCase):

```json
{ "name": "Clobi Prime", "model": "classic", "png": "data:image/png;base64,...",
  "remixOf": "m1a2b3...", "createdAt": "RFC3339" }
```

Server-side validation helper (in `internal/protocol` or `internal/market`):
decode data URL → must be `image/png`, decoded size ≤ 32 KiB, dimensions exactly
64×64 or 64×32, re-encode NOT required. Model ∈ {classic, slim}.

### 9.1 `internal/protocol`

Add `Skin` struct: `Name string`, `Model string`, `PNG string`, `RemixOf string,omitempty`,
`CreatedAt string,omitempty` (json tags: name/model/png/remixOf/createdAt).
Keep `Character` (legacy data still lives in DB).

### 9.2 `internal/accounts` (Postgres)

- Schema (append to `pgdb` schema, idempotent):
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS skin jsonb;`
- `GetSkin(username) (protocol.Skin, bool)` / `SetSkin(username string, s protocol.Skin) error`
  (validate via the shared validator; store as jsonb).
- Default skin: store in `settings` under key `defaultSkin`:
  `GetDefaultSkin() (protocol.Skin, bool)` / `SetDefaultSkin(protocol.Skin) error`.
- The existing per-user `textures` table doubles as the cloud skin library —
  skin records are saved through the EXISTING `/api/library/texture` endpoints
  with `{"id":"sk…","kind":"skin",…}` bodies. No schema change needed there.

### 9.3 `internal/market`

- `Item` gains `Model string` (json `model`). `Kind` value `"skin"` with `PNG` =
  the skin data URL. Publish rules change: **only `kind == "skin"` is accepted**
  (legacy kinds rejected with ErrBadInput — the 2D economy is discarded);
  validates model + PNG (64×64/64×32, ≤32 KiB, valid PNG). Title ≤ 48, tags ≤ 8 (existing).
- `List` additionally hides any non-`skin` legacy item (they stay in the DB,
  invisible). `ListOpts.Model` filter added (`""|classic|slim`, query param `model`).
- NSFW guard: keep the wordlist on title/tags. **Skip** the phallic-silhouette
  heuristic for skins (base layer is opaque; shape says nothing) — run it never
  for kind=skin.
- View adds `model` + keeps `png` withholding semantics for censored items.

### 9.4 `internal/server`

New routes (same auth/JSON patterns as the rest):

```
GET  /api/skin                (auth)  -> 200 protocol.Skin | 404 "no skin"
PUT  /api/skin                (auth)  body protocol.Skin -> 200 saved skin
GET  /api/default-skin        (public)-> 200 protocol.Skin | 404
POST /api/admin/default-skin  (admin) body protocol.Skin -> {"status":"ok"}
```

`/api/market/list` passes through `model` query param. Everything else unchanged.

### 9.5 Compose / deploy

`docker-compose.yml`: add `postgres:16-alpine` service `clobi-db` (internal only,
no published port), named volume `clobi-pgdata`, healthcheck `pg_isready`;
`clobi` service gets `DATABASE_URL=postgres://clobi:<generated>@clobi-db:5432/clobi?sslmode=disable`,
`depends_on: {clobi-db: {condition: service_healthy}}`. Keep `./web:/app/web:ro`
live-mount and `./data` mount (migration source). Migration from the old
`data/clobi.db` happens once via `cmd/migrate` (run inside the builder image or a
one-shot compose run). Dockerfile: also build `/app/migrate` from `./cmd/migrate`.

## 10. i18n

All new UI strings use fresh keys under `vox.*`, `studio.*`, `wardrobe.*`,
`market.*` (reuse existing market keys where the meaning is identical),
`menu.*`. Builders MUST always pass the English fallback:
`I18n.t('vox.mode.creative', 'Creative')`. A dedicated translation pass adds
every new key to all 6 languages (en/de/fr/pt/lb/sh) at the end; missing keys
fall back to English meanwhile (existing I18n behavior).

## 11. Files being DELETED (do not reference them)

`web/js/editor.js`, `web/js/paint.js`, `web/js/sprites.js`, `web/js/textures.js`,
`web/assets/parts.js`, `web/assets/tex/**`. The globals `Editor`, `Paint`,
`Sprites`, `Textures` no longer exist anywhere.

## 12. Assets & docs deliverables

- `web/assets/skins/default.png` — the default skin "**Clobi**": classic model,
  64×64, dual-layer (jacket layer = black tux blazer open over white shirt —
  penguin-tuxedo homage; gray hair + beard, glasses on the hat layer, mint
  "Fisherman's Friend" pocket square accent, blue jeans, black shoes).
- `web/assets/skins/template_classic.png` / `template_slim.png` — color-coded
  region maps generated from the same net table (also downloadable in-studio).
- `tools/make_skins.py` — deterministic generator for all three PNGs (python3,
  stdlib only — hand-rolled minimal PNG writer, no Pillow dependency).
- `docs/SKINS.md` — the preset texture template documentation: net diagrams
  (ASCII), full UV tables for both models and layers, layer inflation, bottom-face
  V-flip rule, slim detection, legacy conversion, base64 of default.png.

## 13. Definition of done (integration checklist)

1. `python -m http.server` in `web/` → open → menu shows rotating default skin.
2. PLAY → world renders > 30 fps desktop, blocks break/place, water/fog/sky/LUT visible.
3. `/gamemode creative` ⇄ survival live-switch works incl. fly + instant break.
4. Touch emulation: joystick/look/tap-place/long-press-break/jump all work.
5. A real Minecraft skin PNG imports in Wardrobe and renders correctly, both
   layers, classic AND slim auto-detected.
6. Studio: paint on net → 3D preview updates; save → wardrobe; template download.
7. Market UI loads with server offline (friendly empty state).
8. Go: `go build ./... && go test ./...` green; new endpoints validated.
9. No console errors on boot on any screen.
