// Package rooms is the live multiplayer layer for TUX SMASH ROYALE. It owns the
// lobby Hub, one Client per WebSocket connection, all client->server message
// routing, and the per-room 30Hz match goroutine that advances the pure
// game.Match simulation and broadcasts authoritative SNAPSHOT / GAME_OVER
// frames.
//
// The Hub is the single point of synchronization: every mutation of room and
// client state happens while holding the Hub mutex, so the package is safe to
// use from many connection goroutines at once. The per-room ticker runs its own
// goroutine but talks to the simulation only through a mutex-guarded room
// pointer.
package rooms

import (
	"encoding/json"
	"sync"
	"time"

	"clobi/internal/accounts"
	"clobi/internal/game"
	"clobi/internal/protocol"
)

// sendBuffer is the capacity of each client's outbound channel. If a client
// cannot keep up it is dropped rather than blocking the Hub or a room ticker.
const sendBuffer = 256

// tickRate is the authoritative simulation rate in ticks per second.
const tickRate = 30

// Client is one WebSocket connection. The transport (server package) owns the
// socket and the read/write pumps; this struct is the Hub's view of the
// connection. Send is a buffered channel the write pump drains and ships to the
// browser as JSON envelopes.
type Client struct {
	ID        string
	Nickname  string
	Character protocol.Character
	Send      chan protocol.Envelope

	hub    *Hub
	roomID string // "" when in the lobby
	closed bool   // guarded by hub.mu; true once dropped
}

// NewClient constructs a Client bound to a Hub with a fresh send channel. The
// transport calls this once per accepted connection.
func NewClient(hub *Hub, id string) *Client {
	return &Client{
		ID:        id,
		Character: protocol.Character{BodyType: "tux"},
		Send:      make(chan protocol.Envelope, sendBuffer),
		hub:       hub,
	}
}

// room is one lobby/match. While State == "lobby" players gather and toggle
// ready; once the host starts, a ticker goroutine drives match until GAME_OVER.
type room struct {
	id         string
	name       string
	password   string
	mode       string // "smash" or "royale"
	maxPlayers int
	hostID     string
	state      string // "lobby" or "playing"

	order   []string           // join order, for stable player lists
	members map[string]*Client // clientID -> Client
	ready   map[string]bool    // clientID -> ready flag
	inputs  map[string]protocol.InputMsg

	match *game.Match
	stop  chan struct{} // closed to tell the ticker goroutine to exit
}

// Hub is the central registry of connected clients and active rooms. All state
// is guarded by mu.
type Hub struct {
	mu       sync.Mutex
	acc      *accounts.Store
	clients  map[string]*Client
	rooms    map[string]*room
	nextRoom int
}

// NewHub creates an empty Hub bound to the given account store (used only to
// resolve characters when needed; rooms work purely off the wire payloads).
func NewHub(acc *accounts.Store) *Hub {
	return &Hub{
		acc:     acc,
		clients: make(map[string]*Client),
		rooms:   make(map[string]*room),
	}
}

// Register adds a client to the Hub. Called by the transport once the socket is
// upgraded and pumps are running.
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c.ID] = c
}

// Unregister removes a client, pulls it from any room (notifying the room), and
// closes its send channel. Safe to call exactly once per client.
func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if c.closed {
		return
	}
	c.closed = true

	if c.roomID != "" {
		h.leaveRoomLocked(c)
	}
	delete(h.clients, c.ID)
	close(c.Send)
}

// Handle routes a single decoded client->server envelope. It is invoked by the
// read pump for every inbound frame.
func (h *Hub) Handle(c *Client, env protocol.Envelope) {
	switch env.Type {
	case protocol.HELLO:
		h.handleHello(c, env.Payload)
	case protocol.LIST_ROOMS:
		h.handleListRooms(c)
	case protocol.CREATE_ROOM:
		h.handleCreateRoom(c, env.Payload)
	case protocol.JOIN_ROOM:
		h.handleJoinRoom(c, env.Payload)
	case protocol.LEAVE_ROOM:
		h.handleLeaveRoom(c)
	case protocol.READY:
		h.handleReady(c, env.Payload)
	case protocol.START_GAME:
		h.handleStartGame(c)
	case protocol.INPUT:
		h.handleInput(c, env.Payload)
	default:
		h.sendErr(c, "unknown message type")
	}
}

// ---- handlers ----

func (h *Hub) handleHello(c *Client, payload json.RawMessage) {
	var msg protocol.HelloMsg
	if err := json.Unmarshal(payload, &msg); err != nil {
		h.sendErr(c, "bad HELLO payload")
		return
	}

	h.mu.Lock()
	if msg.Nickname != "" {
		c.Nickname = msg.Nickname
	}
	if c.Nickname == "" {
		c.Nickname = "Penguin"
	}
	c.Character = msg.Character
	if c.Character.BodyType != "tux" && c.Character.BodyType != "humanoid" {
		c.Character.BodyType = "tux"
	}
	h.mu.Unlock()

	h.send(c, protocol.HELLO_OK, protocol.PlayerLobby{
		ID:        c.ID,
		Nickname:  c.Nickname,
		Character: c.Character,
		Ready:     false,
	})
}

func (h *Hub) handleListRooms(c *Client) {
	h.mu.Lock()
	list := h.roomListLocked()
	h.mu.Unlock()
	h.send(c, protocol.ROOM_LIST, list)
}

func (h *Hub) handleCreateRoom(c *Client, payload json.RawMessage) {
	var msg protocol.CreateRoomMsg
	if err := json.Unmarshal(payload, &msg); err != nil {
		h.sendErr(c, "bad CREATE_ROOM payload")
		return
	}

	mode := normalizeMode(msg.Mode)
	maxP := clampMaxPlayers(mode, msg.MaxPlayers)
	name := msg.Name
	if name == "" {
		name = c.Nickname + "'s room"
	}

	h.mu.Lock()
	// Leave any current room first so a client is only ever in one place.
	if c.roomID != "" {
		h.leaveRoomLocked(c)
	}

	h.nextRoom++
	id := "room-" + itoa(h.nextRoom)
	r := &room{
		id:         id,
		name:       name,
		password:   msg.Password,
		mode:       mode,
		maxPlayers: maxP,
		hostID:     c.ID,
		state:      "lobby",
		members:    make(map[string]*Client),
		ready:      make(map[string]bool),
		inputs:     make(map[string]protocol.InputMsg),
		stop:       make(chan struct{}),
	}
	h.rooms[id] = r
	h.addToRoomLocked(r, c)

	info := h.roomInfoLocked(r)
	h.mu.Unlock()

	h.send(c, protocol.ROOM_JOINED, info)
	h.broadcastRoom(r, protocol.ROOM_UPDATE, info)
}

func (h *Hub) handleJoinRoom(c *Client, payload json.RawMessage) {
	var msg protocol.JoinRoomMsg
	if err := json.Unmarshal(payload, &msg); err != nil {
		h.sendErr(c, "bad JOIN_ROOM payload")
		return
	}

	h.mu.Lock()
	r, ok := h.rooms[msg.RoomID]
	if !ok {
		h.mu.Unlock()
		h.send(c, protocol.JOIN_DENIED, map[string]string{"reason": "room not found"})
		return
	}
	if r.password != "" && r.password != msg.Password {
		h.mu.Unlock()
		h.send(c, protocol.JOIN_DENIED, map[string]string{"reason": "wrong password"})
		return
	}
	if r.state != "lobby" {
		h.mu.Unlock()
		h.send(c, protocol.JOIN_DENIED, map[string]string{"reason": "game in progress"})
		return
	}
	if len(r.members) >= r.maxPlayers {
		h.mu.Unlock()
		h.send(c, protocol.JOIN_DENIED, map[string]string{"reason": "room full"})
		return
	}

	// Already in another room? Leave it before joining the new one.
	if c.roomID != "" && c.roomID != r.id {
		h.leaveRoomLocked(c)
	}
	if _, already := r.members[c.ID]; !already {
		h.addToRoomLocked(r, c)
	}

	info := h.roomInfoLocked(r)
	h.mu.Unlock()

	h.send(c, protocol.ROOM_JOINED, info)
	h.broadcastRoom(r, protocol.ROOM_UPDATE, info)
}

func (h *Hub) handleLeaveRoom(c *Client) {
	h.mu.Lock()
	r := h.roomOf(c)
	if r == nil {
		h.mu.Unlock()
		return
	}
	h.leaveRoomLocked(c)
	var info protocol.RoomInfo
	stillAlive := h.rooms[r.id] != nil
	if stillAlive {
		info = h.roomInfoLocked(r)
	}
	h.mu.Unlock()

	if stillAlive {
		h.broadcastRoom(r, protocol.ROOM_UPDATE, info)
	}
}

func (h *Hub) handleReady(c *Client, payload json.RawMessage) {
	var msg protocol.ReadyMsg
	if err := json.Unmarshal(payload, &msg); err != nil {
		h.sendErr(c, "bad READY payload")
		return
	}

	h.mu.Lock()
	r := h.roomOf(c)
	if r == nil || r.state != "lobby" {
		h.mu.Unlock()
		return
	}
	r.ready[c.ID] = msg.Ready
	info := h.roomInfoLocked(r)
	h.mu.Unlock()

	h.broadcastRoom(r, protocol.ROOM_UPDATE, info)
}

func (h *Hub) handleStartGame(c *Client) {
	h.mu.Lock()
	r := h.roomOf(c)
	if r == nil {
		h.mu.Unlock()
		return
	}
	if r.hostID != c.ID {
		h.mu.Unlock()
		h.sendErr(c, "only the host can start the game")
		return
	}
	if r.state != "lobby" {
		h.mu.Unlock()
		return
	}

	// Build the participant roster from the current lobby members (join order).
	participants := make([]game.Participant, 0, len(r.order))
	for _, id := range r.order {
		cl := r.members[id]
		if cl == nil {
			continue
		}
		participants = append(participants, game.Participant{
			ID:        cl.ID,
			Nickname:  cl.Nickname,
			Character: cl.Character,
			Bot:       false,
		})
	}

	r.state = "playing"
	r.match = game.NewMatch(game.Mode(r.mode), participants)
	r.inputs = make(map[string]protocol.InputMsg)
	r.stop = make(chan struct{})

	info := h.roomInfoLocked(r)
	h.mu.Unlock()

	h.broadcastRoom(r, protocol.GAME_START, info)

	go h.runMatch(r)
}

func (h *Hub) handleInput(c *Client, payload json.RawMessage) {
	var msg protocol.InputMsg
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	h.mu.Lock()
	r := h.roomOf(c)
	if r != nil && r.state == "playing" {
		r.inputs[c.ID] = msg
	}
	h.mu.Unlock()
}

// ---- match loop ----

// runMatch is the per-room authoritative ticker goroutine. It advances the
// match at tickRate, broadcasts a SNAPSHOT each tick, and emits GAME_OVER when
// the simulation resolves (or the room empties / is stopped).
func (h *Hub) runMatch(r *room) {
	dt := 1.0 / float64(tickRate)
	ticker := time.NewTicker(time.Second / tickRate)
	defer ticker.Stop()

	// Capture this match's stop channel; a later match (after this one ends)
	// installs a fresh one, so we must not observe a reassignment mid-loop.
	stop := r.stop

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			h.mu.Lock()

			// Room may have been torn down between ticks.
			if h.rooms[r.id] == nil || r.match == nil || r.state != "playing" {
				h.mu.Unlock()
				return
			}

			// Feed the latest input frame for each human into the simulation.
			for id, in := range r.inputs {
				r.match.ApplyInput(id, in)
			}

			snap, over, winnerID, winnerNick := r.match.Step(dt)

			// Resolve the winner's display name from the snapshot when possible.
			if over && winnerNick == "" && winnerID != "" {
				for _, p := range snap.Players {
					if p.ID == winnerID {
						winnerNick = p.Nickname
						break
					}
				}
			}

			members := h.membersSnapshot(r)
			h.mu.Unlock()

			h.broadcastTo(members, protocol.SNAPSHOT, snap)

			if over {
				h.broadcastTo(members, protocol.GAME_OVER, protocol.GameOverMsg{
					WinnerID:       winnerID,
					WinnerNickname: winnerNick,
				})
				h.finishMatch(r)
				return
			}
		}
	}
}

// finishMatch returns a room from "playing" back to "lobby", clears match state
// and ready flags, and pushes a fresh ROOM_UPDATE so clients can re-ready.
func (h *Hub) finishMatch(r *room) {
	h.mu.Lock()
	if h.rooms[r.id] == nil {
		h.mu.Unlock()
		return
	}
	r.state = "lobby"
	r.match = nil
	r.inputs = make(map[string]protocol.InputMsg)
	for id := range r.ready {
		r.ready[id] = false
	}
	info := h.roomInfoLocked(r)
	h.mu.Unlock()

	h.broadcastRoom(r, protocol.ROOM_UPDATE, info)
}

// ---- room membership helpers (all require h.mu held) ----

// addToRoomLocked inserts a client into a room and updates the back-pointer.
func (h *Hub) addToRoomLocked(r *room, c *Client) {
	r.members[c.ID] = c
	r.ready[c.ID] = false
	r.order = append(r.order, c.ID)
	c.roomID = r.id
}

// leaveRoomLocked removes a client from its current room, reassigns the host if
// needed, stops an in-progress match if it empties, and deletes empty rooms.
func (h *Hub) leaveRoomLocked(c *Client) {
	r, ok := h.rooms[c.roomID]
	c.roomID = ""
	if !ok {
		return
	}

	delete(r.members, c.ID)
	delete(r.ready, c.ID)
	delete(r.inputs, c.ID)
	for i, id := range r.order {
		if id == c.ID {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}

	if len(r.members) == 0 {
		h.destroyRoomLocked(r)
		return
	}

	// Reassign host to the earliest remaining member if the host left.
	if r.hostID == c.ID {
		r.hostID = r.order[0]
	}

	// If a live match loses everyone capable of playing, end it.
	if r.state == "playing" {
		h.destroyRoomLocked(r)
	}
}

// destroyRoomLocked stops any running match ticker and removes the room.
func (h *Hub) destroyRoomLocked(r *room) {
	if r.stop != nil {
		select {
		case <-r.stop:
			// already closed
		default:
			close(r.stop)
		}
	}
	r.match = nil
	delete(h.rooms, r.id)
}

// roomOf returns the room a client is currently in, or nil.
func (h *Hub) roomOf(c *Client) *room {
	if c.roomID == "" {
		return nil
	}
	return h.rooms[c.roomID]
}

// membersSnapshot copies the current member clients into a slice so the ticker
// can broadcast without holding the lock.
func (h *Hub) membersSnapshot(r *room) []*Client {
	out := make([]*Client, 0, len(r.members))
	for _, id := range r.order {
		if cl := r.members[id]; cl != nil {
			out = append(out, cl)
		}
	}
	return out
}

// roomListLocked builds the public lobby list.
func (h *Hub) roomListLocked() protocol.RoomListMsg {
	rooms := make([]protocol.RoomSummary, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, protocol.RoomSummary{
			ID:          r.id,
			Name:        r.name,
			HasPassword: r.password != "",
			Players:     len(r.members),
			MaxPlayers:  r.maxPlayers,
			Mode:        r.mode,
			State:       r.state,
		})
	}
	return protocol.RoomListMsg{Rooms: rooms}
}

// roomInfoLocked builds the full RoomInfo for a single room.
func (h *Hub) roomInfoLocked(r *room) protocol.RoomInfo {
	players := make([]protocol.PlayerLobby, 0, len(r.order))
	for _, id := range r.order {
		cl := r.members[id]
		if cl == nil {
			continue
		}
		players = append(players, protocol.PlayerLobby{
			ID:        cl.ID,
			Nickname:  cl.Nickname,
			Character: cl.Character,
			Ready:     r.ready[id],
		})
	}
	return protocol.RoomInfo{
		ID:         r.id,
		Name:       r.name,
		Host:       r.hostID,
		Mode:       r.mode,
		MaxPlayers: r.maxPlayers,
		State:      r.state,
		Players:    players,
	}
}

// ---- send helpers ----

// send marshals payload and queues one envelope to a single client. A client
// whose buffer is full is dropped (its send channel is non-blocking here).
func (h *Hub) send(c *Client, typ string, payload interface{}) {
	env, err := makeEnvelope(typ, payload)
	if err != nil {
		return
	}
	h.deliver(c, env)
}

// sendErr is a convenience for ERRORMSG frames.
func (h *Hub) sendErr(c *Client, msg string) {
	h.send(c, protocol.ERRORMSG, map[string]string{"message": msg})
}

// broadcastRoom sends the same payload to every current member of a room.
func (h *Hub) broadcastRoom(r *room, typ string, payload interface{}) {
	env, err := makeEnvelope(typ, payload)
	if err != nil {
		return
	}
	h.mu.Lock()
	members := h.membersSnapshot(r)
	h.mu.Unlock()
	for _, c := range members {
		h.deliver(c, env)
	}
}

// broadcastTo sends a payload to an already-collected slice of clients.
func (h *Hub) broadcastTo(members []*Client, typ string, payload interface{}) {
	env, err := makeEnvelope(typ, payload)
	if err != nil {
		return
	}
	for _, c := range members {
		h.deliver(c, env)
	}
}

// deliver places an envelope on a client's send channel without blocking. If the
// channel is full the frame is dropped; SNAPSHOTs are sent every tick so a brief
// stall self-heals.
func (h *Hub) deliver(c *Client, env protocol.Envelope) {
	defer func() { _ = recover() }() // tolerate a racing close on Send
	select {
	case c.Send <- env:
	default:
	}
}

// ---- small pure helpers ----

func makeEnvelope(typ string, payload interface{}) (protocol.Envelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return protocol.Envelope{}, err
	}
	return protocol.Envelope{Type: typ, Payload: raw}, nil
}

func normalizeMode(mode string) string {
	if mode == string(game.ModeRoyale) {
		return string(game.ModeRoyale)
	}
	return string(game.ModeSmash)
}

func clampMaxPlayers(mode string, n int) int {
	max := 16
	min := 2
	if mode == string(game.ModeSmash) {
		max = 4
		min = 2
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
