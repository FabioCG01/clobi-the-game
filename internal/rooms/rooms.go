// Package rooms is the in-memory instance manager and live WebSocket game
// protocol for Clobi Craft's persistent multiplayer worlds (Part II of the
// architecture: see docs/ARCHITECTURE-MP.md §3.1/§3.3).
//
// A "world" is durable state owned by internal/worlds (Postgres: seed +
// deltas + members). A "room"/"instance" is the live, in-memory, single-
// process runtime that actually plays a world: it holds connected players,
// advances time, accepts edits, and periodically flushes dirty chunks back
// to the world store. rooms.Manager is THE instance lock — it guarantees at
// most one live Instance exists per world at any moment, server-wide, so a
// world can never run twice. Because rooms/instances/locks are in-memory
// only, a server restart closes every room and thereby releases every lock
// by construction (no stale-lock recovery is needed).
//
// This package intentionally does not import the concrete worlds.Store or
// social.Store types: it defines the minimal WorldStore / FriendChecker
// interfaces it actually calls (Go's implicit interface satisfaction means
// the real stores satisfy them for free), and accepts a VerifyToken function
// for account-token resolution, so it can be built and unit-tested before —
// and independently of — the sibling packages that provide the concrete
// implementations.
package rooms

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"clobi/internal/worlds"
)

// ---- injected dependencies (interfaces, not concrete sibling types) -------

// WorldStore is the subset of worlds.Store that rooms needs: loading a
// world's metadata + deltas on Open, and persisting dirty deltas/settings on
// flush/close. The concrete clobi/internal/worlds.Store satisfies this
// interface implicitly as long as its method names/signatures line up.
type WorldStore interface {
	// Get returns the world's stored metadata (id, name, owner, seed,
	// settings, membership is queried separately via IsMember).
	Get(id string) (worlds.World, bool)
	// GetDeltas returns every stored chunk delta for the world, keyed
	// "cx,cz", each value the raw packed-record blob (see §2 in the
	// contract / delta.go in this package for the exact byte format).
	GetDeltas(id string) (map[string][]byte, error)
	// SaveDeltas upserts (or, for empty blobs, deletes) the given dirty
	// chunks only — never rewrites the whole world (Delta Saving).
	SaveDeltas(id string, dirty map[string][]byte) error
	// UpdateSettings replaces the world's settings jsonb (spawn/time/cap).
	UpdateSettings(id string, settings json.RawMessage) error
	// IsMember reports whether user is a member (or the owner) of the world.
	IsMember(id, user string) (bool, error)
}

// FriendChecker is the subset of social.Store rooms needs for the "friends"
// access level.
type FriendChecker interface {
	AreFriends(a, b string) (bool, error)
}

// VerifyToken resolves an account bearer-equivalent token to a canonical
// username. Manager is constructed with one of these (typically
// accounts.Store.VerifyToken) instead of importing internal/accounts.
type VerifyToken func(token string) (username string, ok bool)

// ---- errors -----------------------------------------------------------

// ErrAlreadyHosted is returned by Manager.Open when the world already has a
// live instance elsewhere. It carries enough information for the caller
// (the REST handler) to answer with 409 + {"host":…,"roomId":…} and for the
// UI to offer a "join instead?" button — the lock, surfaced honestly.
type ErrAlreadyHosted struct {
	Host   string
	RoomID string
}

func (e ErrAlreadyHosted) Error() string {
	return fmt.Sprintf("world already hosted by %s (room %s)", e.Host, e.RoomID)
}

var (
	// ErrNotFound is returned by Close when the room id is unknown.
	ErrNotFound = errors.New("rooms: room not found")
	// ErrForbidden is returned by Close when the requester may not close
	// the room (not the host, not the world owner, not an admin).
	ErrForbidden = errors.New("rooms: not allowed to close this room")
	// ErrBadAccess is returned by Open for an unrecognized access level.
	ErrBadAccess = errors.New("rooms: access must be public, password, friends or private")
	// ErrBadPin is returned by Open when access=="password" and the pin is
	// missing or outside the 4-12 character range.
	ErrBadPin = errors.New("rooms: pin must be 4-12 characters")
)

// validAccess reports whether a is one of the four recognized access levels.
func validAccess(a string) bool {
	switch a {
	case "public", "password", "friends", "private":
		return true
	}
	return false
}

// ---- RoomInfo (public listing view) ----------------------------------

// RoomInfo is the JSON-safe projection of a live instance for room listings
// (GET /api/rooms) and Manager.List. PINs are never exposed — only whether
// the room is locked.
type RoomInfo struct {
	RoomID    string `json:"roomId"`
	WorldID   string `json:"worldId"`
	WorldName string `json:"worldName"`
	Host      string `json:"host"`
	Access    string `json:"access"`
	Locked    bool   `json:"locked"`
	Players   int    `json:"players"`
	Cap       int    `json:"cap"`
	Uptime    int64  `json:"uptime"` // seconds since createdAt
}

// ---- Manager: the instance lock ----------------------------------------

// Manager owns every live Instance server-side. byWorld and byRoom are two
// views of the same set of instances, guarded by the same mutex; that mutex
// IS the instance lock — Open atomically checks byWorld[world.ID] and, if
// absent, inserts the new Instance under the same critical section, so two
// concurrent Open calls for the same world can never both succeed.
type Manager struct {
	mu      sync.Mutex
	byWorld map[string]*Instance
	byRoom  map[string]*Instance

	store       WorldStore
	friends     FriendChecker
	verifyToken VerifyToken

	// newRoomID is overridable in tests for deterministic ids; production
	// uses randomRoomID.
	newRoomID func() string
	// now is overridable in tests; production uses time.Now.
	now func() time.Time
}

// NewManager builds a Manager over the given dependencies. store and
// friends must be non-nil; verifyToken may be nil (accounts always fail to
// resolve, i.e. only guests/public rooms are reachable) but in production is
// always accounts.Store.VerifyToken.
func NewManager(store WorldStore, friends FriendChecker, verifyToken VerifyToken) *Manager {
	if verifyToken == nil {
		verifyToken = func(string) (string, bool) { return "", false }
	}
	return &Manager{
		byWorld:     make(map[string]*Instance),
		byRoom:      make(map[string]*Instance),
		store:       store,
		friends:     friends,
		verifyToken: verifyToken,
		newRoomID:   randomRoomID,
		now:         time.Now,
	}
}

// Open creates and registers a live Instance for world, hosted by host, or
// returns ErrAlreadyHosted{Host,RoomID} if the world already has one — THE
// lock. access must be one of public/password/friends/private; pin is
// required (4-12 chars) for access=="password" and is stored as a bcrypt
// hash, never in plaintext. Deltas are loaded from the WorldStore before the
// instance is registered (so a slow DB read cannot itself race the lock: the
// check-and-insert below is what matters, and it is a single mutex-guarded
// step).
func (m *Manager) Open(world worlds.World, host, access, pin string) (*Instance, error) {
	if !validAccess(access) {
		return nil, ErrBadAccess
	}
	var pinHash string
	if access == "password" {
		if len(pin) < 4 || len(pin) > 12 {
			return nil, ErrBadPin
		}
		h, err := hashPin(pin)
		if err != nil {
			return nil, err
		}
		pinHash = h
	}

	// Load deltas OUTSIDE the lock (I/O), then take the lock only for the
	// atomic check-and-insert + any final setup. If a racing Open for the
	// same world wins the lock first, our redundant load is simply thrown
	// away and we report ErrAlreadyHosted.
	deltaBlobs, err := m.store.GetDeltas(world.ID)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	if existing, ok := m.byWorld[world.ID]; ok {
		m.mu.Unlock()
		return nil, ErrAlreadyHosted{Host: existing.HostUsername(), RoomID: existing.RoomID}
	}
	roomID := m.newRoomID()
	for { // extremely unlikely collision guard
		if _, taken := m.byRoom[roomID]; !taken {
			break
		}
		roomID = m.newRoomID()
	}
	inst := newInstance(instanceConfig{
		roomID:    roomID,
		world:     world,
		host:      host,
		access:    access,
		pinHash:   pinHash,
		deltas:    decodeAllDeltas(deltaBlobs),
		store:     m.store,
		friends:   m.friends,
		createdAt: m.now(),
		onEmpty:   m.closeIfStillEmpty,
	})
	m.byWorld[world.ID] = inst
	m.byRoom[roomID] = inst
	m.mu.Unlock()

	inst.start()
	return inst, nil
}

// Close closes a room. requester must be the current host, the world owner
// (isOwner==true), or an admin (isOwner==true is also passed for admins by
// callers — the semantics is "requester is privileged", matching the
// contract's "host, world owner, or admin"). isOwner short-circuits the
// per-request host-username check.
func (m *Manager) Close(roomID, requester string, isOwner bool) error {
	m.mu.Lock()
	inst, ok := m.byRoom[roomID]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	if !isOwner && !inst.IsHost(requester) {
		m.mu.Unlock()
		return ErrForbidden
	}
	delete(m.byRoom, roomID)
	delete(m.byWorld, inst.World.ID)
	m.mu.Unlock()

	inst.shutdown()
	return nil
}

// closeIfStillEmpty is the janitor callback an Instance invokes after being
// empty for 60s. It re-checks emptiness AND identity under the manager lock
// before removing the instance, so a player who joined in the last instant
// (racing the janitor) is never evicted from under themselves.
func (m *Manager) closeIfStillEmpty(inst *Instance) {
	m.mu.Lock()
	cur, ok := m.byRoom[inst.RoomID]
	if !ok || cur != inst || inst.PlayerCount() > 0 {
		m.mu.Unlock()
		return
	}
	delete(m.byRoom, inst.RoomID)
	delete(m.byWorld, inst.World.ID)
	m.mu.Unlock()

	inst.shutdown()
}

// List returns the public listing of live rooms visible to viewer.
// friendsOf, when non-nil, is used to additionally reveal "friends"-access
// rooms whose host has viewer among their accepted friends — callers
// typically pass a closure over social.Store; the Manager itself uses
// FriendChecker.AreFriends via CanJoin-equivalent logic for join-time
// checks, but List keeps its own signature exactly as pinned in the
// contract (a callback rather than the FriendChecker interface) so callers
// can inject batch-friendly friend lookups.
//
// Visibility rules (contract §3.1): public → always listed; password →
// listed with Locked=true (never the pin); friends → listed only if viewer
// is in friendsOf(host), or viewer is a member/owner of the underlying
// world; private → never listed.
func (m *Manager) List(viewer string, friendsOf func(host string) []string) []RoomInfo {
	m.mu.Lock()
	insts := make([]*Instance, 0, len(m.byRoom))
	for _, inst := range m.byRoom {
		insts = append(insts, inst)
	}
	m.mu.Unlock()

	now := m.now()
	out := make([]RoomInfo, 0, len(insts))
	for _, inst := range insts {
		access := inst.Access()
		visible := false
		switch access {
		case "public", "password":
			visible = true
		case "friends":
			if viewer != "" {
				if isMember, _ := m.store.IsMember(inst.World.ID, viewer); isMember {
					visible = true
				} else if strings.EqualFold(inst.World.Owner, viewer) {
					visible = true
				} else if friendsOf != nil {
					for _, f := range friendsOf(inst.HostUsername()) {
						if strings.EqualFold(f, viewer) {
							visible = true
							break
						}
					}
				}
			}
		case "private":
			visible = false
		}
		if !visible {
			continue
		}
		out = append(out, RoomInfo{
			RoomID:    inst.RoomID,
			WorldID:   inst.World.ID,
			WorldName: inst.World.Name,
			Host:      inst.HostUsername(),
			Access:    access,
			Locked:    access == "password",
			Players:   inst.PlayerCount(),
			Cap:       inst.Cap(),
			Uptime:    int64(now.Sub(inst.CreatedAt).Seconds()),
		})
	}
	return out
}

// Get returns the live instance for a room id, if any.
func (m *Manager) Get(roomID string) (*Instance, bool) {
	m.mu.Lock()
	inst, ok := m.byRoom[roomID]
	m.mu.Unlock()
	return inst, ok
}

// GetByWorld returns the live instance hosting a given world id, if any.
// (Not part of the pinned §3.1 signature list, but a small, obviously-safe
// addition used by the REST layer to answer GET /api/worlds's `live` field
// without scanning every room.)
func (m *Manager) GetByWorld(worldID string) (*Instance, bool) {
	m.mu.Lock()
	inst, ok := m.byWorld[worldID]
	m.mu.Unlock()
	return inst, ok
}

// Shutdown flushes and closes every live instance (server shutdown path).
func (m *Manager) Shutdown() {
	m.mu.Lock()
	insts := make([]*Instance, 0, len(m.byRoom))
	for _, inst := range m.byRoom {
		insts = append(insts, inst)
	}
	m.byRoom = make(map[string]*Instance)
	m.byWorld = make(map[string]*Instance)
	m.mu.Unlock()

	for _, inst := range insts {
		inst.shutdown()
	}
}
