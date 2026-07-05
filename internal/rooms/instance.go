package rooms

import (
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"clobi/internal/worlds"

	"golang.org/x/crypto/bcrypt"
)

// Tick/broadcast cadences pinned by the contract §3.1/§3.3. The server tick
// loop runs at 20Hz and, per §3 of ARCHITECTURE-3D ("advancing 20 ticks/s"),
// advances the timeTicks counter by exactly 1 per tick — the two 20s are the
// same pinned rate, not a coincidence to be divided out.
const (
	tickHz       = 20                   // server timeTicks advance rate
	tickPeriod   = time.Second / tickHz // 50ms
	movesHz      = 10                   // batched 'moves' broadcast rate
	movesPeriod  = time.Second / movesHz // 100ms
	timeBcast    = 10 * time.Second     // batched 'time' broadcast interval
	autoflush    = 10 * time.Second     // dirty-chunk flush interval
	emptyTimeout = 60 * time.Second     // janitor: close after this long empty
	ticksPerDay  = 24000                // Minecraft-style day length
)

// Rate limits pinned by the contract §3.3/§5.
const (
	moveMaxHz   = 15 // hard ceiling; client throttles itself to 10/s
	blockMaxHz  = 40
	chatMaxHz   = 1
	floodWindow = time.Second
	maxWarnings = 2 // 2 sys warnings then kick
)

const defaultCap = 8

// Player is one connected participant in a live Instance.
type Player struct {
	ID       string // stable per-connection id, assigned on join
	Username string // resolved account username, or "" for guests
	Name     string // display name: username, or "~nick"/"~nick2" for guests
	Guest    bool
	Skin     json.RawMessage // {model,png} as sent in hello, re-validated
	Mode     string          // "survival" | "creative"

	// Live transform, updated by 'move' frames (client-authoritative per
	// the contract's security posture — movement is never server-validated
	// for physics, only relayed).
	mu       sync.Mutex
	Pos      [3]float64
	Yaw      float64
	Pitch    float64
	Swing    float64
	Crouch   bool
	Fly      bool
	changed  bool // has this player's state changed since the last 'moves' batch?

	conn wsConn

	// per-player rate-limit state (only touched from that player's own
	// read loop goroutine, so no locking needed).
	moveWindowStart  time.Time
	moveCount        int
	blockWindowStart time.Time
	blockCount       int
	chatWindowStart  time.Time
	chatCount        int
	warnings         int32 // atomic: flood warnings issued so far

	closeOnce sync.Once
	closed    atomic.Bool
}

// snapshot copies the fields needed for a 'moves'/'join'/'welcome' entry
// under the player's own lock.
func (p *Player) snapshot() (pos [3]float64, yaw, pitch, swing float64, crouch, fly bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Pos, p.Yaw, p.Pitch, p.Swing, p.Crouch, p.Fly
}

// Instance is one live, in-memory room: the runtime for a single world being
// played right now. Exactly one Instance may exist per world at a time,
// which Manager enforces (see rooms.go). Instance state mirrors the
// contract §3.1 list: world meta/seed, deltas (map form), dirty set,
// players, timeTicks, host, access/pinHash, createdAt, lastEmpty.
type Instance struct {
	RoomID    string
	World     worlds.World // world meta + seed (immutable for the instance's life, except settings on flush)
	CreatedAt time.Time

	store   WorldStore
	friends FriendChecker
	onEmpty func(*Instance) // Manager.closeIfStillEmpty, invoked by the janitor

	// ---- mutable state, guarded by mu ----
	mu         sync.Mutex
	access     string // "public"|"password"|"friends"|"private"
	pinHash    string // bcrypt hash, "" unless access=="password"
	hostID     string // current host's Player.ID ("" if no players)
	hostName   string // current host's display name (cached so HostUsername() is lock-cheap... still locked)
	cap        int
	spawn      [3]float64
	timeTicks  int64
	deltas     map[string]map[uint16]uint8 // chunkKey -> index -> blockId
	dirty      map[string]bool             // chunkKey -> needs flush
	players    map[string]*Player          // Player.ID -> player
	lastEmpty  time.Time                   // zero while non-empty; set when it becomes empty
	nextPID    uint64
	closed     bool

	// lifecycle control
	stopCh   chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
}

type instanceConfig struct {
	roomID    string
	world     worlds.World
	host      string
	access    string
	pinHash   string
	deltas    map[string]map[uint16]uint8
	store     WorldStore
	friends   FriendChecker
	createdAt time.Time
	onEmpty   func(*Instance)
}

// worldSettings mirrors the jsonb shape stored in worlds.settings (contract
// §1: `{cap:int (2..8, default 8), spawn:[x,y,z]|null, time:int ticks}`).
type worldSettings struct {
	Cap   int        `json:"cap"`
	Spawn *[3]float64 `json:"spawn"`
	Time  int64       `json:"time"`
}

// newInstance builds an Instance from a config. The initial host is
// recorded by name only (hostID/hostName are finalized once that host's
// connection actually completes 'hello' and gets a Player.ID via
// registerPlayer — see ws.go). Settings (cap/spawn/time) are parsed from
// world.Settings with sane fallbacks.
func newInstance(cfg instanceConfig) *Instance {
	st := parseSettings(cfg.world.Settings)
	if cfg.deltas == nil {
		cfg.deltas = make(map[string]map[uint16]uint8)
	}
	inst := &Instance{
		RoomID:    cfg.roomID,
		World:     cfg.world,
		CreatedAt: cfg.createdAt,
		store:     cfg.store,
		friends:   cfg.friends,
		onEmpty:   cfg.onEmpty,
		access:    cfg.access,
		pinHash:   cfg.pinHash,
		hostName:  cfg.host,
		cap:       st.Cap,
		spawn:     st.spawnOrDefault(),
		timeTicks: st.Time,
		deltas:    cfg.deltas,
		dirty:     make(map[string]bool),
		players:   make(map[string]*Player),
		lastEmpty: cfg.createdAt, // empty since creation until the first join
		stopCh:    make(chan struct{}),
	}
	return inst
}

func parseSettings(raw json.RawMessage) worldSettings {
	st := worldSettings{Cap: defaultCap}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &st) // tolerate missing/partial settings
	}
	if st.Cap < 2 || st.Cap > 8 {
		st.Cap = defaultCap
	}
	return st
}

func (st worldSettings) spawnOrDefault() [3]float64 {
	if st.Spawn != nil {
		return *st.Spawn
	}
	return [3]float64{0, 64, 0} // client regenerates the real highest-solid+1 spawn from seed; this is a safe placeholder
}

// ---- small locked accessors (safe to call from any goroutine) ----------

func (inst *Instance) Access() string {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.access
}

func (inst *Instance) Cap() int {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.cap
}

// HostUsername returns the current host's display name ("" if nobody has
// ever joined yet, in which case it falls back to the name Open() was
// called with).
func (inst *Instance) HostUsername() string {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.hostName
}

// IsHost reports whether user is the current host (by display name/username
// match — a guest can never be host, so this only ever matches account
// users, matching the contract's "guests... never host").
func (inst *Instance) IsHost(user string) bool {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return user != "" && strings.EqualFold(inst.hostName, user)
}

// PlayerCount returns the number of currently connected players.
func (inst *Instance) PlayerCount() int {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return len(inst.players)
}

// TimeTicks returns the current server time-of-day tick counter.
func (inst *Instance) TimeTicks() int64 {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	return inst.timeTicks
}

// checkPin bcrypt-compares an offered plaintext PIN against the stored hash.
// Always false when access != "password" (pinHash is "" then, and an empty
// hash never matches bcrypt.CompareHashAndPassword).
func (inst *Instance) checkPin(pin string) bool {
	inst.mu.Lock()
	hash := inst.pinHash
	inst.mu.Unlock()
	if hash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pin)) == nil
}

// hashPin bcrypt-hashes a PIN for storage (used by Manager.Open).
func hashPin(pin string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(pin), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// ---- lifecycle -----------------------------------------------------------

// start launches the background goroutines: the 20Hz tick loop (which also
// drives the 10Hz moves-batch and 10s time-broadcast on its own
// sub-countdowns so everything shares one ticking clock), the 10s autoflush
// ticker, and the empty-janitor loop.
func (inst *Instance) start() {
	inst.wg.Add(1)
	go inst.tickLoop()
	inst.wg.Add(1)
	go inst.autoflushLoop()
	inst.wg.Add(1)
	go inst.janitorLoop()
}

// shutdown stops every background goroutine, flushes all dirty deltas +
// settings, and closes every remaining connection. Safe to call once
// (guarded); Manager calls this exactly once per instance, either from
// Close or from the janitor callback.
func (inst *Instance) shutdown() {
	inst.stopOnce.Do(func() { close(inst.stopCh) })
	inst.wg.Wait()

	inst.mu.Lock()
	players := make([]*Player, 0, len(inst.players))
	for _, p := range inst.players {
		players = append(players, p)
	}
	inst.closed = true
	inst.mu.Unlock()

	for _, p := range players {
		p.close(1001, "room closed")
	}

	inst.flushDirty()
	inst.flushSettings()
}

func (inst *Instance) tickLoop() {
	defer inst.wg.Done()
	ticker := time.NewTicker(tickPeriod)
	defer ticker.Stop()
	movesTicker := time.NewTicker(movesPeriod)
	defer movesTicker.Stop()
	timeTicker := time.NewTicker(timeBcast)
	defer timeTicker.Stop()

	for {
		select {
		case <-inst.stopCh:
			return
		case <-ticker.C:
			inst.advanceTime()
		case <-movesTicker.C:
			inst.broadcastMoves()
		case <-timeTicker.C:
			inst.broadcastTime()
		}
	}
}

func (inst *Instance) advanceTime() {
	inst.mu.Lock()
	inst.timeTicks = (inst.timeTicks + 1) % ticksPerDay
	inst.mu.Unlock()
}

// SetTime is the host-only `/time` command / `time{set:ticks}` WS message.
func (inst *Instance) SetTime(ticks int64) {
	t := ticks % ticksPerDay
	if t < 0 {
		t += ticksPerDay
	}
	inst.mu.Lock()
	inst.timeTicks = t
	inst.mu.Unlock()
	inst.broadcastTime()
}

// broadcastMoves sends the batched 'moves' frame containing only players
// whose transform changed since the last batch (contract §3.3: "batched @
// 10 Hz, only changed players"). anim bits pack crouch/fly per the contract
// wire shape `[id,x,y,z,yaw,pitch,swing,crouchFlyBits]`.
func (inst *Instance) broadcastMoves() {
	inst.mu.Lock()
	if len(inst.players) == 0 {
		inst.mu.Unlock()
		return
	}
	changed := make([]*Player, 0, len(inst.players))
	for _, p := range inst.players {
		p.mu.Lock()
		if p.changed {
			changed = append(changed, p)
		}
		p.mu.Unlock()
	}
	recipients := inst.connSlice()
	inst.mu.Unlock()

	if len(changed) == 0 {
		return
	}
	m := make([][]interface{}, 0, len(changed))
	for _, p := range changed {
		p.mu.Lock()
		bits := 0
		if p.Crouch {
			bits |= 1
		}
		if p.Fly {
			bits |= 2
		}
		m = append(m, []interface{}{
			p.ID, p.Pos[0], p.Pos[1], p.Pos[2], p.Yaw, p.Pitch, p.Swing, bits,
		})
		p.changed = false
		p.mu.Unlock()
	}
	frame := mustMarshal(wsFrame{"t": "moves", "m": m})
	broadcastRaw(recipients, frame)
}

func (inst *Instance) broadcastTime() {
	inst.mu.Lock()
	t := inst.timeTicks
	recipients := inst.connSlice()
	inst.mu.Unlock()
	frame := mustMarshal(wsFrame{"t": "time", "ticks": t})
	broadcastRaw(recipients, frame)
}

// connSlice returns every currently-connected player's conn, for broadcast.
// Caller must hold inst.mu.
func (inst *Instance) connSlice() []wsConn {
	out := make([]wsConn, 0, len(inst.players))
	for _, p := range inst.players {
		out = append(out, p.conn)
	}
	return out
}

func (inst *Instance) autoflushLoop() {
	defer inst.wg.Done()
	ticker := time.NewTicker(autoflush)
	defer ticker.Stop()
	for {
		select {
		case <-inst.stopCh:
			return
		case <-ticker.C:
			inst.flushDirty()
		}
	}
}

// flushDirty compacts and upserts every dirty chunk's deltas to the
// WorldStore (Delta Saving: dirty chunks only), then clears the dirty set.
// An empty compacted blob means the chunk has no edits at all (fully
// reverted back to seed state) — SaveDeltas / worlds.Store is expected to
// delete that row per the contract ("An empty blob = delta removed").
func (inst *Instance) flushDirty() {
	inst.mu.Lock()
	if len(inst.dirty) == 0 {
		inst.mu.Unlock()
		return
	}
	out := make(map[string][]byte, len(inst.dirty))
	for key := range inst.dirty {
		out[key] = encodeRecords(inst.deltas[key])
	}
	inst.dirty = make(map[string]bool)
	worldID := inst.World.ID
	inst.mu.Unlock()

	_ = inst.store.SaveDeltas(worldID, out) // best-effort; a failed flush retries next tick since keys are only cleared locally
}

// flushSettings persists spawn/time/cap back to worlds.settings (called on
// close, mirroring the contract: "on close: flush deltas + settings
// (spawn/time)").
func (inst *Instance) flushSettings() {
	inst.mu.Lock()
	st := worldSettings{Cap: inst.cap, Time: inst.timeTicks}
	spawn := inst.spawn
	st.Spawn = &spawn
	worldID := inst.World.ID
	inst.mu.Unlock()

	raw, err := json.Marshal(st)
	if err != nil {
		return
	}
	_ = inst.store.UpdateSettings(worldID, raw)
}

func (inst *Instance) janitorLoop() {
	defer inst.wg.Done()
	ticker := time.NewTicker(5 * time.Second) // check cadence; the 60s threshold is what matters
	defer ticker.Stop()
	for {
		select {
		case <-inst.stopCh:
			return
		case <-ticker.C:
			inst.mu.Lock()
			empty := len(inst.players) == 0
			since := inst.lastEmpty
			inst.mu.Unlock()
			if empty && !since.IsZero() && time.Since(since) >= emptyTimeout {
				if inst.onEmpty != nil {
					inst.onEmpty(inst)
				}
				return // the manager will call shutdown(); stop checking either way
			}
		}
	}
}

// SetBlock applies a validated block edit at the given world coordinates,
// marking the owning chunk dirty. Coordinates are absolute world
// coordinates; the caller (ws.go's handleBlock) is responsible for bounds
// validation before calling this — SetBlock itself trusts its caller (it is
// not part of the public WS-facing surface).
func (inst *Instance) SetBlock(x, y, z int, id uint8) {
	cx := floorDiv16(x)
	cz := floorDiv16(z)
	key := chunkKey(cx, cz)
	lx := x - cx*16
	lz := z - cz*16
	idx := uint16((y*16+lz)*16 + lx)

	inst.mu.Lock()
	chunk, ok := inst.deltas[key]
	if !ok {
		chunk = make(map[uint16]uint8)
		inst.deltas[key] = chunk
	}
	chunk[idx] = id
	inst.dirty[key] = true
	inst.mu.Unlock()
}

// GetBlock returns the delta'd block id at absolute coordinates, and
// whether a delta exists there at all (false means "unedited: ask
// WorldGen/seed", which this package never does itself — deltas are the
// only server-side terrain knowledge, per the contract's storage model).
func (inst *Instance) GetBlock(x, y, z int) (id uint8, hasDelta bool) {
	cx := floorDiv16(x)
	cz := floorDiv16(z)
	key := chunkKey(cx, cz)
	lx := x - cx*16
	lz := z - cz*16
	idx := uint16((y*16+lz)*16 + lx)

	inst.mu.Lock()
	defer inst.mu.Unlock()
	chunk, ok := inst.deltas[key]
	if !ok {
		return 0, false
	}
	v, ok := chunk[idx]
	return v, ok
}

func floorDiv16(v int) int {
	if v >= 0 {
		return v / 16
	}
	return -((-v + 15) / 16)
}

// deltasSnapshotB64 returns the FULL welcome payload: every chunk's
// compacted records, base64-encoded, keyed "cx,cz" — the contract's
// "ALL deltas of the world" join payload.
func (inst *Instance) deltasSnapshotB64() map[string]string {
	inst.mu.Lock()
	defer inst.mu.Unlock()
	out := make(map[string]string, len(inst.deltas))
	for key, chunk := range inst.deltas {
		if len(chunk) == 0 {
			continue
		}
		out[key] = base64Encode(encodeRecords(chunk))
	}
	return out
}

func mustMarshal(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// v is always one of this package's own well-formed frame maps;
		// a marshal failure here would be a programming error, not a
		// runtime condition to recover from gracefully.
		panic("rooms: unmarshalable frame: " + err.Error())
	}
	return b
}

// wsFrame is a convenience alias for building `{"t":"...", ...}` frames.
type wsFrame = map[string]interface{}
