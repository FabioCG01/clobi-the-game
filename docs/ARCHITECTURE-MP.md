# CLOBI CRAFT — PART II: PERSISTENT WORLDS, ROOMS & CO-OP HOSTING (BINDING CONTRACT)

Extends `ARCHITECTURE-3D.md` (Part I). Part I terms (coords, chunk layout, block ids,
module globals, house rules) apply unchanged. This part specifies the pivot from a
session-local sandbox to a **persistent, server-authoritative world architecture**:
seed-based procedural worlds stored server-side as **deltas only**, a **room/hosting
layer** with access control, a **friend system**, **world memberships**, and
**instance locking** so a world can never run twice.

Design pillars:

1. **The server never generates or stores terrain.** A world is `(seed, deltas)`.
   Clients regenerate base terrain deterministically from the seed with the exact
   same `WorldGen` used offline, then overlay deltas. Storage and join payloads are
   proportional to *player edits*, not world size (Delta Saving).
2. **One live instance per world, enforced server-side** (Instance Locking): all
   play on a server world — solo included — goes through the same instance path,
   so there is no unlocked side door.
3. **Accounts stay optional.** Guests keep the fully offline local world (Part I
   IndexedDB) and may join *public* rooms. Owning/hosting/friends require sign-in.

## 1. Storage model (PostgreSQL — extends the Part I/pgdb schema)

```sql
CREATE TABLE IF NOT EXISTS worlds (
    id         text PRIMARY KEY,            -- 'w' + 12 hex bytes
    name       text NOT NULL,               -- clipped 32
    owner      text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    seed       bigint NOT NULL,             -- int32 range (JS-safe)
    settings   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {cap:8}
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worlds_owner ON worlds(owner);

CREATE TABLE IF NOT EXISTS world_members (
    world_id  text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    username  text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, username)
);

CREATE TABLE IF NOT EXISTS world_deltas (
    world_id   text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    cx         integer NOT NULL,
    cz         integer NOT NULL,
    data       bytea NOT NULL,              -- packed records, see §2
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, cx, cz)
);

CREATE TABLE IF NOT EXISTS friends (
    a          text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    b          text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    requester  text NOT NULL,               -- who asked (equals a or b)
    status     text NOT NULL,               -- 'pending' | 'accepted'
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (a, b),
    CHECK (a < b)                            -- normalized pair: a = lesser username
);
```

World meta (spawn point, time-of-day) lives in `worlds.settings` jsonb:
`{cap:int (2..8, default 8), spawn:[x,y,z]|null, time:int ticks}` — written by the
instance on flush. Rooms/instances/locks are **in-memory only** (single-process
server; a restart closes all rooms and thereby releases all locks by construction).

## 2. Delta encoding (shared client/server byte format)

Per chunk, a sequence of little-endian **3-byte records**: `u16 blockIndex`
(`(y*16+z)*16+x`, 0..24575) + `u8 blockId`. Later records for the same index win
(server compacts on flush: at most one record per index, ascending index order).
Wire/dump encoding: base64 of the record blob. An empty blob = delta removed
(chunk back to pure-seed state — server deletes the row).

- Server keeps per-instance deltas as `map[chunkKey]map[uint16]uint8`, flushes
  **dirty chunks only** every 10 s and on instance close (compact + upsert).
- Join payload (`welcome`): ALL deltas of the world as `{ "cx,cz": base64, … }`.
  (Edit-proportional; fine for the target scale. Streaming per-chunk fetch is a
  documented future optimization, not built now.)
- Client applies: generate chunk from seed → overlay records → mark remeshed.

## 3. Server architecture (Go, all stdlib — new packages)

```
internal/social/    friends store (Postgres)             — social.Store
internal/worlds/    worlds + members + deltas (Postgres) — worlds.Store
internal/rooms/     in-memory instance manager + WS game protocol — rooms.Manager
internal/ws/        minimal RFC 6455 WebSocket server (stdlib only: handshake,
                    text/close/ping frames, fragmentation, masking; no permessage-
                    deflate). Thoroughly unit-tested. If this proves flaky it may
                    be swapped for vendored golang.org/x/net/websocket — but the
                    default is our own ~300-line implementation, in repo spirit.
```

### 3.1 `rooms.Manager` — the instance lock

```go
type Manager struct { mu sync.Mutex; byWorld map[string]*Instance; byRoom map[string]*Instance }

func (m *Manager) Open(world worlds.World, host string, access, pin string) (*Instance, error)
    // ErrAlreadyHosted{Host, RoomID} if byWorld[world.ID] exists — THE lock.
    // access: "public"|"password"|"friends"|"private"; pin required (4-12 chars) for password (stored bcrypt).
func (m *Manager) Close(roomID, requester string, isOwner bool) error   // host or world owner or admin
func (m *Manager) List(viewer string, friendsOf func(host string) []string) []RoomInfo
    // public → all; password → listed with locked=true; friends → only if viewer ∈ host's accepted
    // friends or viewer is a world member/owner; private → never listed.
func (m *Manager) Get(roomID string) (*Instance, bool)
```

`Instance` state: world meta, seed, deltas (map form), dirty set, players
(conn, username, guest flag, skin record, pos/look/anim, mode), timeTicks
(advances 20/s server-side), hostUsername, access/pinHash, createdAt, lastEmpty.
Lifecycle: created by `Open` (loads deltas from `worlds.Store`); closed by
explicit Close, or by a janitor when **empty for 60 s**; on close: flush deltas +
settings (spawn/time), release lock. Server shutdown flushes all instances.
Autoflush ticker: 10 s, dirty chunks only (Delta Saving).

Join permission (`CanJoin(user, guest bool)`): banned=no v1. Members and the
owner ALWAYS pass, at ANY access level, including `private` — "private" means
"not discoverable/joinable by the general public," not "excludes your own
invited members" (world memberships exist precisely so an owner can share a
world; a private room that locked out its own members would defeat that).
For everyone else (non-member, non-owner accounts, and guests): `private` →
host only; `friends` → host's accepted friends (world members/owner already
covered by the always-pass rule above, so this branch is strangers-only);
`password` → anyone with correct PIN (bcrypt compare); `public` → anyone incl.
guests. Guests may join only `public` (and never host, and never match a
member/owner check since they have no account username). Cap enforced
(settings.cap).

### 3.2 REST endpoints (same mux/auth/JSON patterns as Part I)

```
GET  /api/worlds                  (auth)   -> {worlds:[WorldView]}  owned + member-of, each:
      {id,name,seed,owner,role:'owner'|'member',members:[names],updatedAt,
       live:null|{roomId,host,players,access}}
POST /api/worlds/create           (auth)   {name, seed?} -> WorldView   (seed default: crypto-random int32)
POST /api/worlds/rename           (owner)  {id, name}
POST /api/worlds/delete           (owner)  {id}          (refused while hosted: 409 "close the room first")
POST /api/worlds/members/add      (owner)  {id, username}   404 unknown user; member sees world in list
POST /api/worlds/members/remove   (owner)  {id, username}
POST /api/worlds/import           (auth)   {name, seed, deltas:{"cx,cz":base64,…}} -> WorldView
      (validates every record: index < 24576, valid block id, y>0 for edits at y==0 → reject record)
GET  /api/rooms                   (public; optional auth) -> {rooms:[RoomInfo]}
      RoomInfo: {roomId,worldId,worldName,host,access,locked:bool,players,cap,uptime}
POST /api/rooms/open              (auth)   {worldId, access, pin?} -> {roomId}
      403 not owner/member · 409 ErrAlreadyHosted -> {"error":"already hosted","host":…,"roomId":…}
POST /api/rooms/close             (auth)   {roomId}   (host, world owner, or admin)
GET  /api/friends                 (auth)   -> {friends:[name], incoming:[name], outgoing:[name]}
POST /api/friends/request         (auth)   {username}   404 unknown; auto-accept if they already requested you
POST /api/friends/accept          (auth)   {username}
POST /api/friends/remove          (auth)   {username}   (decline pending OR unfriend accepted)
```

### 3.3 WebSocket game protocol — `GET /ws/room` (Upgrade)

JSON text frames, `{"t":"<type>", …}`. First client frame MUST be `hello` within
5 s or the socket is dropped.

**client → server**
```
hello  {token?|nick?, roomId, pin?, skin:{model,png}?, mode:'survival'|'creative'}
       // token → account user; else nick → guest "~nick" (public rooms only, uniquified "~nick2")
       // skin png ≤ 32 KiB data URL (server re-validates like market skins; oversize → dropped to null)
move   {p:[x,y,z], yaw, pitch, anim:{swing:0..1, crouch:bool, fly:bool}}     ≤ 15/s (throttle 10/s client)
block  {x,y,z,id}          ≤ 40/s; validated: id valid+placeable-or-air, 0<y<96, |x|,|z| ≤ 100000; y==0 immutable
chat   {text}              ≤ 1/s, clipped 200
mode   {mode}              // player's own gamemode; echoed to others (affects their rendering only)
time   {set:ticks}         // host only; else error
ping   {}                  // → pong
```

**server → client**
```
welcome    {youId, roomId, world:{id,name,seed,spawn,time,cap}, deltas:{"cx,cz":b64,…},
            players:[{id,name,guest,skin,mode,p,yaw,pitch}], host}
join       {player:{id,name,guest,skin,mode,p,yaw,pitch}}
leave      {id}
moves      {m:[[id,x,y,z,yaw,pitch,swing,crouchFlyBits],…]}   // batched @ 10 Hz, only changed players
block      {x,y,z,id,by}                                      // echoed to ALL incl. sender (authoritative)
chat       {from,text}   sys {text,cls?}   mode {id,mode}
time       {ticks}                                            // on join + every 10 s + on /time
host       {name}                                             // host changed (old host left → oldest member present, else oldest player)
kick       {reason}      error {message}                      // error may precede close
pong       {}
```

Rate-limit breach: 2 warnings (`sys`) then `kick{"flood"}`. Server echoes `block`
back to the sender (client applies authoritatively; optimistic local set is fine —
the echo confirms; a rejected edit sends corrective `block` with the old id… v1
simplification: server-validated failures just send `error` + corrective block
from delta/seed knowledge is NOT possible server-side for seed blocks, so
correction = `block{x,y,z,id: previous-known-delta-or-?}` — implement corrections
ONLY for delta'd cells; invalid edits on virgin cells are rare and self-heal on
rejoin. Keep validation strict enough that legit clients never hit it.)

## 4. Client architecture (new/changed modules)

New `<script>` entries (Part I order, inserted after `game.js`):
`js/vox/net.js` (**Net**), `js/vox/remoteplayers.js` (**RemotePlayers**),
`js/worldselect.js` (**WorldSelect**), `js/friends.js` (**Friends**).
New screen div: `#screen-worlds` (router name `worlds`).

### 4.1 `Net` (js/vox/net.js)

```js
Net.connect({roomId, pin, skinRec, mode, nick}) -> Promise<welcome>   // resolves on welcome; rejects on error/kick/timeout(8s)
Net.isConnected -> bool ;  Net.youId ;  Net.hostName
Net.send(type, obj)                    // queued while CONNECTING; dropped when closed
Net.sendMove(state)                    // internally throttled to 10 Hz + only-on-change
Net.on(type, fn) / Net.off(type, fn)   // 'join','leave','moves','block','chat','sys','mode','time','host','kick','close'
Net.disconnect()
```

WS URL: `(wss|ws)://location.host/ws/room`. One reconnect attempt after abnormal
close (2 s backoff, re-hello, deltas re-applied via fresh welcome → Game rebuild);
second failure → `close` event → Game returns to menu with toast.

### 4.2 `RemotePlayers` (js/vox/remoteplayers.js)

```js
RemotePlayers.init(gl)                          // shares PlayerModel
RemotePlayers.sync(welcomePlayers) / add(p) / remove(id) / applyMoves(batch) / setMode(id,mode) / setSkin(id,rec)
RemotePlayers.update(dt)                        // interpolation: render 150 ms behind newest snapshot, lerp pos + shortest-arc yaw
RemotePlayers.draw(gl, camera, env)             // PlayerModel.draw per player (skins via Skins.load cache; fallback default)
RemotePlayers.nametags(camera, containerEl)     // DOM labels projected via projView (hidden when behind cam/ >40 m)
RemotePlayers.count / RemotePlayers.list()
RemotePlayers.destroy()
```

### 4.3 `WorldSelect` (js/worldselect.js) — the “Select World” screen

`WorldSelect.show()/hide()` owning `#screen-worlds`. Two tabs:

- **My Worlds**: “Local world” card always first (offline, guest-friendly:
  Continue / New — exactly the Part I flow; plus **“Upload to server”** when
  signed in: reads local IDB edits, regenerates each edited chunk from seed,
  diffs → delta records → `POST /api/worlds/import`, then offers to delete local).
  Then server worlds (`GET /api/worlds`): name, seed, role badge, members,
  live badge (“LIVE — hosted by X · N players” → Join button). Actions:
  **Play** (= host `private`), **Host** (modal: access public/password/friends,
  PIN field for password, cap slider) — both hit `/api/rooms/open` then
  `Net.connect` + `Game.startMultiplayer`; on 409 show “already hosted by X —
  join instead?” with a Join button (the lock, surfaced honestly). Owner-only:
  Rename / Members (add by username w/ friend-picker shortcut, remove) / Delete.
  Member: Leave world. Plus **New world** (name, seed optional, → create).
- **Join a Game**: `GET /api/rooms` browser (poll 5 s while visible): world name,
  host, player count/cap, access icon (🔓 public / 🔐 PIN prompt modal / 👥
  friends), Join → `Net.connect`. Empty state + sign-in nudge for friends rooms.

### 4.4 `Friends` (js/friends.js)

`Friends.showModal()` (from menu corner + world-members picker): three lists
(friends / incoming with Accept·Decline / outgoing with Cancel), add-by-username
field, badge count provider `Friends.refreshBadge()` (menu shows pending count).
Thin wrappers in Store (§4.6). Poll only while modal open (8 s).

### 4.5 `Game` + `World` multiplayer integration (edits to Part I modules)

```js
Game.startMultiplayer({welcome, skinRec}) -> Promise
   // like start(), but: world = World.createRemote({seed, name, deltas}) (no IDB, applies deltas);
   // spawn/time from welcome; RemotePlayers.init+sync; Net handlers wired:
   //   'block' → world.setBlockSilent(x,y,z,id) (no echo loop; remesh);
   //   local edits: apply optimistically + Net.send('block',…);
   //   'moves/join/leave/skin/mode' → RemotePlayers; 'chat/sys' → HUD.chatPrint;
   //   'time' → Game.setTime; 'kick'/'close' → Game.stop + menu toast.
   // per-frame: Net.sendMove(player state); RemotePlayers.update/draw between opaque and translucent passes;
   //   nametags after endFrame. Autosave/IDB OFF. HUD chat sends via Net (plain text) — '/' still local Commands
   //   except /time (sends Net time when host; error otherwise) and /gamemode (also Net.send('mode')).
   //   Disabled in MP (error toast): /regen /seed? (seed is known — keep /seed), /setspawn (host only → writes settings
   //   via... v1: /setspawn host-only sends time-style message? NOT built — /setspawn disabled in MP), /save (no-op info).
Game.isMultiplayer -> bool
World.createRemote({seed, name, deltas}) -> world   // gen from seed, overlay deltas, persistence disabled
world.setBlockSilent(x,y,z,id)                      // set + dirty, no edit-callback
world.onLocalEdit(fn(x,y,z,id))                     // Game hooks Net.send here in MP
world.exportLocalDeltas() -> Promise<{“cx,cz”: base64}>   // for /api/worlds/import (local world only;
                                                          // regenerates pristine chunks to diff)
```

Player list overlay (Tab / touch 👥 btn): names + ping-less simple list via
RemotePlayers.list() + HUD addition `.vox-playerlist`.

### 4.6 `Store` additions (REST wrappers, same conventions as Part I §5.19)

```js
Store.worldsList() worldsCreate({name,seed}) worldsRename(id,name) worldsDelete(id)
Store.worldsMemberAdd(id,user) worldsMemberRemove(id,user) worldsImport(payload)
Store.roomsList() roomsOpen({worldId,access,pin}) roomsClose(roomId)
Store.friendsList() friendsRequest(u) friendsAccept(u) friendsRemove(u)
```

### 4.7 Menu changes

**PLAY → `App.showScreen('worlds')`** (WorldSelect). Corner cluster gains a
Friends button (badge = incoming count, polled once at boot + on modal close).
Everything else from Part I stands.

## 5. Security & abuse posture (v1, explicit)

- Movement is client-authoritative (casual co-op, no PvP); block edits are
  server-validated (bounds/id/rate) and never trusted for physics.
- PINs: bcrypt, never logged, never echoed in room lists (only `locked:true`).
- Guests: join public rooms only; name prefix `~`; no persistence.
- All new POST endpoints: auth via existing Bearer middleware; owner checks in
  worlds.Store queries (`WHERE owner=$user`), not in handlers alone.
- WS origin check: same-host origin required (or empty for native clients).
- Flood limits per §3.3; oversized frames (> 64 KiB) → kick.

## 6. i18n

New key prefixes: `worlds.*`, `rooms.*`, `friends.*`, `mp.*` (chat/system lines).
Same rule: every string `I18n.t(key, 'English fallback')`; translation pass at the end.

## 7. Definition of done (Part II additions)

1. Two browsers, one signed-in host + one guest: host creates server world, hosts
   public; guest sees it in Join a Game, joins, both see each other move with
   correct skins + nametags; block edits sync both ways; chat works.
2. Restart nothing: host closes room (or both leave → 60 s janitor) → deltas in
   Postgres (`world_deltas` rows exist, 3-byte packed); rehost → edits are back.
3. `/api/rooms/open` on an already-hosted world → 409 with host info; UI offers Join.
4. Member (not owner) can host while owner is offline; owner’s later open → 409.
5. Password room: wrong PIN rejected, right PIN joins; friends room: stranger
   blocked, accepted friend joins; private: invisible + unjoinable for others.
6. Friend request → accept flow works both directions; auto-accept on mutual request.
7. Local world untouched for guests; “Upload to server” produces a working server
   world whose deltas equal the local edits.
8. `go build/vet/test ./...` green including `internal/ws` frame tests. **Run
   DB-gated tests with `go test -p 1 ./...`** (not the default concurrent
   per-package run) when `TEST_DATABASE_URL` is set: `accounts`/`worlds`/
   `social` share a real FK graph rooted at `accounts.username`, and each
   truncates only its own tables for isolation (deliberately, so no suite's
   truncate cascades into tables another suite owns) — correct sequentially,
   but running them as concurrent OS processes against the same live
   Postgres (Go's default) causes them to deadlock/race truncating
   overlapping rows. `-p 1` is the standard, zero-code-change fix for
   integration suites that share one database; do not "fix" this by widening
   any single suite's truncate list to cover the others' tables — that
   was tried and makes the deadlock worse, not better (verified 2026-07-06).
