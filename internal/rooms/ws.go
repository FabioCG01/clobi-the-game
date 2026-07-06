package rooms

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// wsConn is the minimal surface this package needs from an accepted
// WebSocket connection. It is satisfied implicitly by *ws.Conn from the
// sibling internal/ws package (Accept(w,r) (*ws.Conn,error); ReadMessage()
// ([]byte,error); WriteMessage([]byte) error; Close()/CloseWithReason(code,
// reason); SetReadDeadline(t)) — defining it locally means this package
// compiles and unit-tests against a fake conn without internal/ws existing
// yet, per the cross-package decoupling pattern used throughout Part II.
type wsConn interface {
	ReadMessage() ([]byte, error)
	WriteMessage([]byte) error
	Close() error
	CloseWithReason(code uint16, reason string) error
	SetReadDeadline(t time.Time) error
}

// MaxFrameBytes is the oversized-frame cutoff (contract §5: "oversized
// frames (> 64 KiB) -> kick").
const MaxFrameBytes = 64 * 1024

// helloDeadline is how long a freshly-accepted connection has to send its
// first 'hello' frame before being dropped (contract §3.3).
const helloDeadline = 5 * time.Second

// idleReadDeadline is the deadline applied to the read loop generally after
// hello succeeds (kept generous — the game itself pings/pongs to detect dead
// peers; this is a backstop against a peer that stops sending entirely
// without closing cleanly).
const idleReadDeadline = 90 * time.Second

// clipChat is the chat message character clip (contract §3.3: "clipped 200").
const clipChat = 200

// helloMsg is the shape of the first client frame.
type helloMsg struct {
	Token *string         `json:"token"`
	Nick  *string         `json:"nick"`
	RoomID string         `json:"roomId"`
	Pin    string         `json:"pin"`
	Skin   json.RawMessage `json:"skin"`
	Mode   string          `json:"mode"`
}

// genericMsg is used to sniff the "t" discriminator before decoding the
// full typed payload.
type genericMsg struct {
	T string `json:"t"`
}

// HandleConn drives one accepted WebSocket connection end-to-end: waits for
// 'hello' (5s deadline), resolves identity, checks join permission + cap,
// registers the player, sends 'welcome' + broadcasts 'join', then loops
// reading frames until the connection closes, dispatching each per the
// contract §3.3 client->server table. manager is used to look up the target
// room by roomId. It always returns after the connection is fully done
// (closed/kicked/errored) — callers (the HTTP upgrade handler) should run it
// synchronously per-connection (each connection needs its own goroutine at
// the HTTP layer, exactly as net/http already gives you for the accepting
// handler).
func HandleConn(conn wsConn, m *Manager) {
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(helloDeadline))
	raw, err := conn.ReadMessage()
	if err != nil {
		_ = conn.CloseWithReason(1002, "no hello")
		return
	}
	if len(raw) > MaxFrameBytes {
		_ = conn.CloseWithReason(1009, "frame too large")
		return
	}
	var gm genericMsg
	if json.Unmarshal(raw, &gm) != nil || gm.T != "hello" {
		_ = conn.CloseWithReason(1002, "expected hello")
		return
	}
	var hello helloMsg
	if json.Unmarshal(raw, &hello) != nil {
		_ = conn.CloseWithReason(1002, "bad hello")
		return
	}

	inst, ok := m.Get(hello.RoomID)
	if !ok {
		writeError(conn, "room not found")
		_ = conn.CloseWithReason(1000, "room not found")
		return
	}

	username, guest, name, ok := resolveIdentity(m, inst, hello)
	if !ok {
		writeError(conn, "could not resolve identity")
		_ = conn.CloseWithReason(1008, "bad identity")
		return
	}

	if !inst.CanJoin(username, guest, hello.Pin) {
		writeError(conn, "access denied")
		_ = conn.CloseWithReason(1008, "access denied")
		return
	}

	mode := hello.Mode
	if mode != "survival" && mode != "creative" {
		mode = "survival"
	}

	player, welcomeFrame, ok := inst.tryJoin(username, guest, name, mode, hello.Skin, conn)
	if !ok {
		writeError(conn, "room is full")
		_ = conn.CloseWithReason(1013, "room full")
		return
	}

	_ = conn.WriteMessage(welcomeFrame)
	inst.broadcastJoin(player)

	_ = conn.SetReadDeadline(time.Now().Add(idleReadDeadline))
	readLoop(conn, inst, player)

	inst.removePlayer(player)
}

// resolveIdentity implements the contract's hello resolution: "token ->
// account user; else nick -> guest "~nick" (public rooms only, uniquified
// "~nick2")". A token that fails to verify is treated as an error (not a
// silent guest fallback) so a client with a stale token gets an honest
// failure rather than an unexpectedly-demoted guest session.
func resolveIdentity(m *Manager, inst *Instance, hello helloMsg) (username string, guest bool, name string, ok bool) {
	if hello.Token != nil && strings.TrimSpace(*hello.Token) != "" {
		u, verified := m.verifyToken(*hello.Token)
		if !verified {
			return "", false, "", false
		}
		return u, false, u, true
	}
	if hello.Nick != nil {
		nick := strings.TrimSpace(*hello.Nick)
		if nick == "" {
			nick = "guest"
		}
		nick = clip(nick, 20)
		return "", true, inst.uniquifyGuestName(nick), true
	}
	return "", false, "", false
}

// clip trims a string to at most n runes.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func writeError(conn wsConn, message string) {
	_ = conn.WriteMessage(mustMarshal(wsFrame{"t": "error", "message": message}))
}

// uniquifyGuestName returns "~nick", or "~nick2", "~nick3", … if that name
// is already taken by a connected player in this instance.
func (inst *Instance) uniquifyGuestName(nick string) string {
	base := "~" + nick
	inst.mu.Lock()
	defer inst.mu.Unlock()
	taken := make(map[string]bool, len(inst.players))
	for _, p := range inst.players {
		taken[p.Name] = true
	}
	if !taken[base] {
		return base
	}
	for i := 2; ; i++ {
		candidate := base + strconv.Itoa(i)
		if !taken[candidate] {
			return candidate
		}
	}
}

// tryJoin registers a new player under the cap, assigns it an id, updates
// host-on-first-join bookkeeping, and builds the 'welcome' frame — all
// atomically under the instance lock so a join can never race the cap
// check or the host handoff. Returns ok=false (no player created) if the
// room is at capacity.
func (inst *Instance) tryJoin(username string, guest bool, name, mode string, skin json.RawMessage, conn wsConn) (*Player, []byte, bool) {
	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return nil, nil, false
	}
	if len(inst.players) >= inst.cap {
		inst.mu.Unlock()
		return nil, nil, false
	}

	inst.nextPID++
	id := "p" + strconv.FormatUint(inst.nextPID, 10)
	p := &Player{
		ID: id, Username: username, Name: name, Guest: guest,
		Skin: sanitizeSkin(skin), Mode: mode, conn: conn,
	}
	p.Pos = inst.spawn

	// Existing players for the welcome roster, BEFORE inserting the new one.
	roster := make([]map[string]interface{}, 0, len(inst.players))
	for _, other := range inst.players {
		roster = append(roster, playerView(other))
	}

	inst.players[id] = p
	inst.lastEmpty = time.Time{} // non-empty now

	if inst.hostID == "" {
		// First player in an empty instance becomes host.
		inst.hostID = id
		inst.hostName = name
	}
	hostName := inst.hostName

	welcome := wsFrame{
		"t":     "welcome",
		"youId": id,
		"roomId": inst.RoomID,
		"world": map[string]interface{}{
			"id": inst.World.ID, "name": inst.World.Name, "seed": inst.World.Seed,
			"spawn": inst.spawn, "time": inst.timeTicks, "cap": inst.cap,
		},
		"deltas":  inst.deltasSnapshotB64Locked(),
		"players": roster,
		"host":    hostName,
	}
	inst.mu.Unlock()

	return p, mustMarshal(welcome), true
}

// deltasSnapshotB64Locked returns the FULL welcome payload: every chunk's
// compacted records, base64-encoded, keyed "cx,cz" — the contract's "ALL
// deltas of the world" join payload. Caller must already hold inst.mu (it is
// only ever called from tryJoin, which builds the whole 'welcome' frame
// under one critical section).
func (inst *Instance) deltasSnapshotB64Locked() map[string]string {
	out := make(map[string]string, len(inst.deltas))
	for key, chunk := range inst.deltas {
		if len(chunk) == 0 {
			continue
		}
		out[key] = base64Encode(encodeRecords(chunk))
	}
	return out
}

// playerView is the JSON-safe roster/join entry for one player. Skin is set
// once at join time (in tryJoin, before p is ever published to another
// goroutine) and never mutated afterwards, so it is safe to read here
// without locking; Mode and the transform fields DO mutate concurrently
// (via handleMode / handleMove on the player's own read-loop goroutine)
// while this function may run from another connection's goroutine (e.g.
// building a join roster), so both go through their locked accessors.
func playerView(p *Player) map[string]interface{} {
	pos, yaw, pitch, _, _, _ := p.snapshot()
	return map[string]interface{}{
		"id": p.ID, "name": p.Name, "guest": p.Guest, "skin": p.Skin, "mode": p.modeSnapshot(),
		"p": pos, "yaw": yaw, "pitch": pitch,
	}
}

// sanitizeSkin re-validates a hello skin payload defensively: an oversize or
// malformed skin is dropped to null rather than rejecting the whole
// connection (contract §3.3: "oversize -> dropped to null"). The actual PNG
// dimension/format validation mirrors protocol.ValidateSkin; since this
// package intentionally does not import internal/protocol (kept dependency-
// free per the injection pattern), it applies the same size ceiling
// (32 KiB decoded data URL) as a conservative, dependency-free proxy — any
// skin that passes this still gets fully validated by the account/library
// endpoints that originally produced it.
func sanitizeSkin(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if len(raw) > 44*1024 { // ~32 KiB base64-inflated PNG plus JSON overhead
		return nil
	}
	var probe struct {
		Model string `json:"model"`
		PNG   string `json:"png"`
	}
	if json.Unmarshal(raw, &probe) != nil {
		return nil
	}
	if probe.Model != "classic" && probe.Model != "slim" {
		return nil
	}
	if !strings.HasPrefix(probe.PNG, "data:image/png;base64,") {
		return nil
	}
	return raw
}

// broadcastJoin sends 'join' to everyone EXCEPT the newly-joined player.
func (inst *Instance) broadcastJoin(p *Player) {
	inst.mu.Lock()
	recipients := make([]wsConn, 0, len(inst.players))
	for _, other := range inst.players {
		if other.ID == p.ID {
			continue
		}
		recipients = append(recipients, other.conn)
	}
	inst.mu.Unlock()
	frame := mustMarshal(wsFrame{"t": "join", "player": playerView(p)})
	broadcastRaw(recipients, frame)
}

// removePlayer removes a player on disconnect, reassigns host if it was
// them (old host leaves -> oldest present member, else oldest player,
// exactly as the contract specifies), broadcasts 'leave' and, if the host
// changed, 'host'. If the instance becomes empty, marks lastEmpty so the
// janitor's 60s countdown starts now.
func (inst *Instance) removePlayer(p *Player) {
	inst.mu.Lock()
	if _, ok := inst.players[p.ID]; !ok {
		inst.mu.Unlock()
		return // already removed (e.g. kicked then naturally closed)
	}
	delete(inst.players, p.ID)

	wasHost := inst.hostID == p.ID
	var newHostFrame []byte
	if wasHost {
		newHost := inst.pickNextHost()
		if newHost != nil {
			inst.hostID = newHost.ID
			inst.hostName = newHost.Name
			newHostFrame = mustMarshal(wsFrame{"t": "host", "name": newHost.Name})
		} else {
			inst.hostID = ""
			inst.hostName = ""
		}
	}

	if len(inst.players) == 0 {
		inst.lastEmpty = time.Now()
	}
	recipients := inst.connSlice()
	inst.mu.Unlock()

	leaveFrame := mustMarshal(wsFrame{"t": "leave", "id": p.ID})
	broadcastRaw(recipients, leaveFrame)
	if newHostFrame != nil {
		broadcastRaw(recipients, newHostFrame)
	}
}

// pickNextHost implements "old host leaves -> oldest present member, else
// oldest player". "Member" here means an account user who is a member (or
// owner) of the underlying world; "oldest" is by join order, which this
// package tracks via the monotonically increasing numeric suffix of
// Player.ID ("p1" < "p2" < …) since ids are assigned in join order. Caller
// must hold inst.mu.
func (inst *Instance) pickNextHost() *Player {
	var bestMember, bestAny *Player
	var bestMemberSeq, bestAnySeq uint64
	for _, p := range inst.players {
		seq := pidSeq(p.ID)
		if bestAny == nil || seq < bestAnySeq {
			bestAny = p
			bestAnySeq = seq
		}
		if p.Guest || p.Username == "" {
			continue
		}
		isMember := inst.isOwner(p.Username)
		if !isMember {
			if ok, _ := inst.store.IsMember(inst.World.ID, p.Username); ok {
				isMember = true
			}
		}
		if isMember && (bestMember == nil || seq < bestMemberSeq) {
			bestMember = p
			bestMemberSeq = seq
		}
	}
	if bestMember != nil {
		return bestMember
	}
	return bestAny
}

func pidSeq(id string) uint64 {
	n, _ := strconv.ParseUint(strings.TrimPrefix(id, "p"), 10, 64)
	return n
}

// broadcastRaw fires the same pre-marshaled frame at every recipient,
// tolerating individual write failures (a dead connection's own read loop
// will notice and clean it up).
func broadcastRaw(conns []wsConn, frame []byte) {
	for _, c := range conns {
		_ = c.WriteMessage(frame)
	}
}

// ---- per-connection read loop + message dispatch ------------------------

// readLoop consumes frames from one player's connection until it errors or
// closes, dispatching each by its "t" discriminator. It returns when the
// connection is done; the caller (HandleConn) then removes the player.
func readLoop(conn wsConn, inst *Instance, p *Player) {
	for {
		raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if len(raw) > MaxFrameBytes {
			p.close(1009, "frame too large")
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(idleReadDeadline))

		var gm genericMsg
		if json.Unmarshal(raw, &gm) != nil {
			continue // ignore unparsable frames rather than dropping the whole connection
		}
		switch gm.T {
		case "move":
			if !inst.rateOK(p, rateMove) {
				return
			}
			handleMove(inst, p, raw)
		case "block":
			if !inst.rateOK(p, rateBlock) {
				return
			}
			handleBlock(inst, p, raw)
		case "chat":
			if !inst.rateOK(p, rateChat) {
				return
			}
			handleChat(inst, p, raw)
		case "mode":
			handleMode(inst, p, raw)
		case "time":
			handleTime(inst, p, raw)
		case "ping":
			_ = conn.WriteMessage(mustMarshal(wsFrame{"t": "pong"}))
		default:
			// unknown message types are ignored (forward-compat, never fatal)
		}
		if p.closed.Load() {
			return
		}
	}
}

// ---- move -----------------------------------------------------------

type moveMsg struct {
	P    [3]float64 `json:"p"`
	Yaw  float64    `json:"yaw"`
	Pitch float64   `json:"pitch"`
	Anim struct {
		Swing  float64 `json:"swing"`
		Crouch bool    `json:"crouch"`
		Fly    bool    `json:"fly"`
	} `json:"anim"`
}

func handleMove(inst *Instance, p *Player, raw []byte) {
	var mv moveMsg
	if json.Unmarshal(raw, &mv) != nil {
		return
	}
	swing := mv.Anim.Swing
	if swing < 0 {
		swing = 0
	}
	if swing > 1 {
		swing = 1
	}
	p.mu.Lock()
	p.Pos = mv.P
	p.Yaw = mv.Yaw
	p.Pitch = mv.Pitch
	p.Swing = swing
	p.Crouch = mv.Anim.Crouch
	p.Fly = mv.Anim.Fly
	p.changed = true
	p.mu.Unlock()
}

// ---- block ------------------------------------------------------------

type blockMsg struct {
	X  int `json:"x"`
	Y  int `json:"y"`
	Z  int `json:"z"`
	ID int `json:"id"`
}

// maxCoord bounds |x|,|z| per the contract §3.3 ("|x|,|z| <= 100000").
const maxCoord = 100000

// worldMaxY is WORLD_H per ARCHITECTURE-3D §3 (y in [0,95]); the contract's
// block validation says "0<y<96" for the move/edit bound.
const worldMaxY = 96

func handleBlock(inst *Instance, p *Player, raw []byte) {
	var bm blockMsg
	if json.Unmarshal(raw, &bm) != nil {
		return
	}
	if !validBlockEdit(bm) {
		writeErrorTo(p, "invalid block edit")
		return
	}
	inst.SetBlock(bm.X, bm.Y, bm.Z, uint8(bm.ID))

	inst.mu.Lock()
	recipients := inst.connSlice()
	inst.mu.Unlock()
	frame := mustMarshal(wsFrame{"t": "block", "x": bm.X, "y": bm.Y, "z": bm.Z, "id": bm.ID, "by": p.ID})
	broadcastRaw(recipients, frame) // echoed to ALL including sender (authoritative)
}

// validBlockEdit validates bounds + id per contract §3.3: "id valid+
// placeable-or-air, 0<y<96, |x|,|z| <= 100000; y==0 immutable". This
// package does not import internal/vox's block registry (client-only,
// JS); "valid id" here is the wire-level sanity check (0..255 fits uint8
// trivially; the meaningful range for the current block registry is
// documented as 0..33 in ARCHITECTURE-3D §4, but new blocks may be added
// there without touching this package, so the bound checked here is the
// wire-format ceiling of a byte, not a specific max id — placeability is
// enforced client-side and by the fact that unknown ids simply render as
// nothing worse than an unrecognized block, never a crash).
func validBlockEdit(bm blockMsg) bool {
	if bm.ID < 0 || bm.ID > 255 {
		return false
	}
	if bm.Y <= 0 || bm.Y >= worldMaxY { // y==0 immutable (bedrock), and 0<y<96
		return false
	}
	if bm.X > maxCoord || bm.X < -maxCoord || bm.Z > maxCoord || bm.Z < -maxCoord {
		return false
	}
	return true
}

func writeErrorTo(p *Player, message string) {
	_ = p.conn.WriteMessage(mustMarshal(wsFrame{"t": "error", "message": message}))
}

// ---- chat -------------------------------------------------------------

type chatMsg struct {
	Text string `json:"text"`
}

func handleChat(inst *Instance, p *Player, raw []byte) {
	var cm chatMsg
	if json.Unmarshal(raw, &cm) != nil {
		return
	}
	text := clip(strings.TrimSpace(cm.Text), clipChat)
	if text == "" {
		return
	}
	inst.mu.Lock()
	recipients := inst.connSlice()
	inst.mu.Unlock()
	frame := mustMarshal(wsFrame{"t": "chat", "from": p.Name, "text": text})
	broadcastRaw(recipients, frame)
}

// ---- mode ---------------------------------------------------------------

type modeMsg struct {
	Mode string `json:"mode"`
}

func handleMode(inst *Instance, p *Player, raw []byte) {
	var mm modeMsg
	if json.Unmarshal(raw, &mm) != nil {
		return
	}
	if mm.Mode != "survival" && mm.Mode != "creative" {
		return
	}
	p.mu.Lock()
	p.Mode = mm.Mode
	p.mu.Unlock()

	inst.mu.Lock()
	recipients := inst.connSlice()
	inst.mu.Unlock()
	frame := mustMarshal(wsFrame{"t": "mode", "id": p.ID, "mode": mm.Mode})
	broadcastRaw(recipients, frame)
}

// ---- time (host only) ----------------------------------------------------

type timeMsg struct {
	Set int64 `json:"set"`
}

func handleTime(inst *Instance, p *Player, raw []byte) {
	if !inst.IsHost(hostCheckName(p)) {
		writeErrorTo(p, "only the host can set time")
		return
	}
	var tm timeMsg
	if json.Unmarshal(raw, &tm) != nil {
		return
	}
	inst.SetTime(tm.Set)
}

// hostCheckName resolves the identity IsHost should compare: account
// username when signed in (guests can never be host, so this only ever
// matters for account users, matching the contract).
func hostCheckName(p *Player) string {
	if p.Guest {
		return "" // never matches a hostName (guests are never host)
	}
	return p.Username
}

// ---- flood control (contract §5: 2 warnings via 'sys' then kick) --------

type rateKind int

const (
	rateMove rateKind = iota
	rateBlock
	rateChat
)

// rateOK enforces the per-kind ceiling (moveMaxHz/blockMaxHz/chatMaxHz) over
// a rolling 1s window, tracked per-player (fields are only ever touched
// from that player's own single read-loop goroutine, so no locking is
// needed for the window/count fields themselves). On breach: increments the
// warning counter and sends a 'sys' frame for the first two breaches within
// the connection's lifetime, then kicks on the third. Returns false when the
// connection has just been kicked (caller must stop reading).
func (inst *Instance) rateOK(p *Player, kind rateKind) bool {
	now := time.Now()
	var windowStart *time.Time
	var count *int
	var maxHz int
	switch kind {
	case rateMove:
		windowStart, count, maxHz = &p.moveWindowStart, &p.moveCount, moveMaxHz
	case rateBlock:
		windowStart, count, maxHz = &p.blockWindowStart, &p.blockCount, blockMaxHz
	case rateChat:
		windowStart, count, maxHz = &p.chatWindowStart, &p.chatCount, chatMaxHz
	}
	if windowStart.IsZero() || now.Sub(*windowStart) >= floodWindow {
		*windowStart = now
		*count = 0
	}
	*count++
	if *count <= maxHz {
		return true
	}
	return inst.floodBreach(p)
}

// floodBreach applies the 2-warnings-then-kick policy shared by all three
// rate-limited message kinds (the contract phrases this as one flood policy,
// not per-kind counters, so the warning count is a single atomic on Player
// shared across move/block/chat).
func (inst *Instance) floodBreach(p *Player) bool {
	n := atomic.AddInt32(&p.warnings, 1)
	if n <= maxWarnings {
		_ = p.conn.WriteMessage(mustMarshal(wsFrame{"t": "sys", "text": "You're sending messages too fast.", "cls": "err"}))
		return true
	}
	p.close(1008, "flood")
	return false
}

// close sends a 'kick' frame (when reason indicates flood; other reasons —
// room closed, forced disconnect — still get a kick/close as appropriate)
// then closes the underlying connection exactly once.
func (p *Player) close(code uint16, reason string) {
	p.closeOnce.Do(func() {
		p.closed.Store(true)
		_ = p.conn.WriteMessage(mustMarshal(wsFrame{"t": "kick", "reason": reason}))
		_ = p.conn.CloseWithReason(code, reason)
	})
}

// ---- misc -----------------------------------------------------------

// randomRoomID generates the production room id: 'r' + 8 random hex bytes,
// short enough to be friendly in a URL/log line, long enough to never
// collide in practice (Manager.Open still guards against the theoretical
// collision).
func randomRoomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "r" + fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return "r" + hex.EncodeToString(b)
}
