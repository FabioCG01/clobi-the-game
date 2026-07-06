package rooms

import (
	"encoding/json"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"clobi/internal/worlds"
)

// ---- fakes ---------------------------------------------------------------

// fakeWorldStore is a small hand-rolled, table-driven-friendly in-memory
// stand-in for the real worlds.Store, satisfying rooms.WorldStore.
type fakeWorldStore struct {
	mu       sync.Mutex
	worlds   map[string]worlds.World
	deltas   map[string]map[string][]byte // worldID -> chunkKey -> blob
	members  map[string]map[string]bool   // worldID -> username -> member
	settings map[string]json.RawMessage   // worldID -> last UpdateSettings payload
	saveErr  error
}

func newFakeWorldStore() *fakeWorldStore {
	return &fakeWorldStore{
		worlds:   map[string]worlds.World{},
		deltas:   map[string]map[string][]byte{},
		members:  map[string]map[string]bool{},
		settings: map[string]json.RawMessage{},
	}
}

func (f *fakeWorldStore) addWorld(w worlds.World) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.worlds[w.ID] = w
}

func (f *fakeWorldStore) addMember(worldID, user string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.members[worldID] == nil {
		f.members[worldID] = map[string]bool{}
	}
	f.members[worldID][user] = true
}

func (f *fakeWorldStore) Get(id string) (worlds.World, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.worlds[id]
	return w, ok
}

func (f *fakeWorldStore) GetDeltas(id string) (map[string][]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string][]byte{}
	for k, v := range f.deltas[id] {
		out[k] = append([]byte(nil), v...)
	}
	return out, nil
}

func (f *fakeWorldStore) SaveDeltas(id string, dirty map[string][]byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.saveErr != nil {
		return f.saveErr
	}
	if f.deltas[id] == nil {
		f.deltas[id] = map[string][]byte{}
	}
	for k, v := range dirty {
		if len(v) == 0 {
			delete(f.deltas[id], k) // empty blob = delta removed
			continue
		}
		f.deltas[id][k] = append([]byte(nil), v...)
	}
	return nil
}

func (f *fakeWorldStore) UpdateSettings(id string, settings json.RawMessage) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.settings[id] = settings
	// Also propagate into the stored World's own Settings field, mirroring
	// the real worlds.Store (an UPDATE statement on the same row Get later
	// reads back) — without this, a Get() immediately after UpdateSettings
	// would see stale settings, which no real store would ever exhibit and
	// which would make a re-Open-after-Close round-trip test (see
	// TestDifficultyAndKeepInventoryPersistRoundTrip) fail for a reason
	// that has nothing to do with the code under test.
	if w, ok := f.worlds[id]; ok {
		w.Settings = settings
		f.worlds[id] = w
	}
	return nil
}

func (f *fakeWorldStore) IsMember(id, user string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.members[id][user], nil
}

// fakeFriendChecker is a symmetric-pair friend graph for tests.
type fakeFriendChecker struct {
	pairs map[[2]string]bool
}

func newFakeFriendChecker() *fakeFriendChecker {
	return &fakeFriendChecker{pairs: map[[2]string]bool{}}
}

func (f *fakeFriendChecker) addFriends(a, b string) {
	f.pairs[[2]string{a, b}] = true
	f.pairs[[2]string{b, a}] = true
}

func (f *fakeFriendChecker) AreFriends(a, b string) (bool, error) {
	return f.pairs[[2]string{a, b}], nil
}

// fakeConn is a minimal in-memory wsConn: WriteMessage appends to an
// in-process slice instead of touching a real socket, and ReadMessage pops
// from a queue the test can push to (or blocks/returns io.EOF-ish once
// closed) — enough to drive tryJoin/removePlayer/handle* without any real
// networking, matching "these don't need a real WS connection".
type fakeConn struct {
	mu      sync.Mutex
	written [][]byte
	closed  bool
	reason  string
	code    uint16
}

func newFakeConn() *fakeConn { return &fakeConn{} }

func (c *fakeConn) ReadMessage() ([]byte, error) {
	return nil, errors.New("fakeConn: ReadMessage not used in these tests")
}
func (c *fakeConn) WriteMessage(b []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := append([]byte(nil), b...)
	c.written = append(c.written, cp)
	return nil
}
func (c *fakeConn) Close() error { c.mu.Lock(); defer c.mu.Unlock(); c.closed = true; return nil }
func (c *fakeConn) CloseWithReason(code uint16, reason string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.code = code
	c.reason = reason
	return nil
}
func (c *fakeConn) SetReadDeadline(time.Time) error { return nil }

func (c *fakeConn) lastFrame() map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.written) == 0 {
		return nil
	}
	var m map[string]interface{}
	_ = json.Unmarshal(c.written[len(c.written)-1], &m)
	return m
}

func (c *fakeConn) framesOfType(t string) []map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []map[string]interface{}
	for _, raw := range c.written {
		var m map[string]interface{}
		if json.Unmarshal(raw, &m) == nil && m["t"] == t {
			out = append(out, m)
		}
	}
	return out
}

// ---- test helpers ----------------------------------------------------

func testWorld(id, owner string) worlds.World {
	return worlds.World{ID: id, Name: "Test World " + id, Owner: owner, Seed: 12345, Settings: json.RawMessage(`{"cap":8}`)}
}

// newTestManager builds a Manager with deterministic room ids (sequential,
// collision-free, no crypto/rand) so assertions can pin exact expected ids.
func newTestManager(store WorldStore, friends FriendChecker, verify VerifyToken) *Manager {
	m := NewManager(store, friends, verify)
	seq := 0
	m.newRoomID = func() string {
		seq++
		return "room" + string(rune('0'+seq))
	}
	return m
}

// ---- 1. the lock itself --------------------------------------------------

func TestOpenTwiceSameWorldIsLocked(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "alice")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)

	inst1, err := m.Open(w, "alice", "public", "")
	if err != nil {
		t.Fatalf("first Open should succeed, got %v", err)
	}
	defer inst1.shutdown()

	_, err = m.Open(w, "bob", "public", "")
	if err == nil {
		t.Fatal("second Open on the same world should fail")
	}
	var already ErrAlreadyHosted
	if !errors.As(err, &already) {
		t.Fatalf("expected ErrAlreadyHosted, got %T: %v", err, err)
	}
	if already.Host != "alice" {
		t.Fatalf("ErrAlreadyHosted.Host = %q, want %q", already.Host, "alice")
	}
	if already.RoomID != inst1.RoomID {
		t.Fatalf("ErrAlreadyHosted.RoomID = %q, want %q", already.RoomID, inst1.RoomID)
	}
}

func TestCloseThenOpenAgainSucceeds(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "alice")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)

	inst1, err := m.Open(w, "alice", "public", "")
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if err := m.Close(inst1.RoomID, "alice", false); err != nil {
		t.Fatalf("Close: %v", err)
	}

	inst2, err := m.Open(w, "bob", "public", "")
	if err != nil {
		t.Fatalf("re-Open after Close should succeed, got %v", err)
	}
	defer inst2.shutdown()
	if inst2.RoomID == inst1.RoomID {
		t.Fatal("re-opened instance reused the old room id; expected a fresh one")
	}
	if _, stillOpen := m.Get(inst1.RoomID); stillOpen {
		t.Fatal("old room id should no longer resolve after Close")
	}
}

func TestCloseRequiresHostOwnerOrAdmin(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "alice")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)

	inst, err := m.Open(w, "alice", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	if err := m.Close(inst.RoomID, "mallory", false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("stranger Close should be ErrForbidden, got %v", err)
	}
	if err := m.Close("no-such-room", "alice", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown room Close should be ErrNotFound, got %v", err)
	}
	// isOwner=true (world owner / admin path) succeeds even though "carol"
	// never joined as a player.
	if err := m.Close(inst.RoomID, "carol", true); err != nil {
		t.Fatalf("owner/admin Close should succeed, got %v", err)
	}
}

func TestOpenValidatesAccessAndPin(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "alice")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)

	if _, err := m.Open(w, "alice", "bogus", ""); !errors.Is(err, ErrBadAccess) {
		t.Fatalf("bad access level should be ErrBadAccess, got %v", err)
	}
	if _, err := m.Open(w, "alice", "password", "12"); !errors.Is(err, ErrBadPin) {
		t.Fatalf("too-short pin should be ErrBadPin, got %v", err)
	}
	if _, err := m.Open(w, "alice", "password", "thispiniswaytoolongforsure"); !errors.Is(err, ErrBadPin) {
		t.Fatalf("too-long pin should be ErrBadPin, got %v", err)
	}
	inst, err := m.Open(w, "alice", "password", "1234")
	if err != nil {
		t.Fatalf("valid pin should Open, got %v", err)
	}
	defer inst.shutdown()
	if inst.pinHash == "" || inst.pinHash == "1234" {
		t.Fatal("pin must be stored bcrypt-hashed, never in plaintext")
	}
}

// ---- 2. CanJoin truth table -----------------------------------------------

// role enumerates the six identities the contract's join-permission rules
// distinguish.
type role int

const (
	roleGuest role = iota
	roleStranger
	roleFriend
	roleMember
	roleOwner
	roleHost
)

func (r role) String() string {
	return [...]string{"guest", "stranger", "friend", "member", "owner", "host"}[r]
}

func TestCanJoinTruthTable(t *testing.T) {
	const owner = "owner1"
	const host = "host1"
	const member = "member1"
	const friend = "friend1"
	const stranger = "stranger1"
	const correctPin = "4242"

	newFixture := func(access string) (*Instance, *fakeWorldStore, *fakeFriendChecker) {
		store := newFakeWorldStore()
		w := testWorld("w1", owner)
		store.addWorld(w)
		store.addMember(w.ID, member)
		friends := newFakeFriendChecker()
		friends.addFriends(friend, host)

		m := newTestManager(store, friends, nil)
		var pin string
		if access == "password" {
			pin = correctPin
		}
		inst, err := m.Open(w, host, access, pin)
		if err != nil {
			t.Fatalf("Open(%s): %v", access, err)
		}
		t.Cleanup(inst.shutdown)
		return inst, store, friends
	}

	// identity(r) returns (user, guest) for CanJoin, per role.
	identity := func(r role) (user string, guest bool) {
		switch r {
		case roleGuest:
			return "", true
		case roleStranger:
			return stranger, false
		case roleFriend:
			return friend, false
		case roleMember:
			return member, false
		case roleOwner:
			return owner, false
		case roleHost:
			return host, false
		}
		return "", false
	}

	roles := []role{roleGuest, roleStranger, roleFriend, roleMember, roleOwner, roleHost}

	// expected[access][role] = should CanJoin succeed (with the correct pin
	// offered when access=="password").
	expected := map[string]map[role]bool{
		"public": {
			roleGuest: true, roleStranger: true, roleFriend: true,
			roleMember: true, roleOwner: true, roleHost: true,
		},
		"password": {
			roleGuest: false, roleStranger: true, roleFriend: true, // correct pin offered
			roleMember: true, roleOwner: true, roleHost: true,
		},
		"friends": {
			roleGuest: false, roleStranger: false, roleFriend: true,
			roleMember: true, roleOwner: true, roleHost: true,
		},
		"private": {
			// Contract §3.1: "`private` -> host only (and world owner)" is
			// the base rule for strangers/friends, but the very next
			// sentence is a blanket override: "Members and the owner
			// ALWAYS pass access checks (any access level)" — so a world
			// member (someone the owner explicitly granted access to this
			// specific world) also passes a private room, same as the
			// owner and the host.
			roleGuest: false, roleStranger: false, roleFriend: false,
			roleMember: true, roleOwner: true, roleHost: true,
		},
	}

	for _, access := range []string{"public", "password", "friends", "private"} {
		access := access
		t.Run(access, func(t *testing.T) {
			inst, _, _ := newFixture(access)
			for _, r := range roles {
				r := r
				t.Run(r.String(), func(t *testing.T) {
					user, guest := identity(r)
					pin := ""
					if access == "password" {
						pin = correctPin
					}
					got := inst.CanJoin(user, guest, pin)
					want := expected[access][r]
					if got != want {
						t.Errorf("CanJoin(user=%q,guest=%v,pin) access=%s role=%s = %v, want %v",
							user, guest, access, r, got, want)
					}
				})
			}
		})
	}
}

func TestCanJoinPasswordWrongPinRejected(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "password", "4242")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	if inst.CanJoin("stranger1", false, "0000") {
		t.Fatal("wrong pin should be rejected")
	}
	if !inst.CanJoin("stranger1", false, "4242") {
		t.Fatal("correct pin should be accepted")
	}
}

func TestCanJoinNeverEnforcesCap(t *testing.T) {
	// CanJoin is pure permission logic; the cap is enforced separately by
	// tryJoin. A world with cap 2 should still report CanJoin==true for a
	// public room even conceptually "at capacity" — this test just pins
	// that CanJoin itself has no player-count awareness (tryJoin's cap
	// enforcement is exercised implicitly by TestJoinRespectsCap below via
	// the full HandleConn-adjacent path).
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	w.Settings = json.RawMessage(`{"cap":2}`)
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()
	if !inst.CanJoin("anyone", false, "") {
		t.Fatal("CanJoin should not itself consider capacity")
	}
}

func TestJoinRespectsCap(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	w.Settings = json.RawMessage(`{"cap":2}`)
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	c1 := newFakeConn()
	if _, _, ok := inst.tryJoin("host1", false, "host1", "survival", nil, c1); !ok {
		t.Fatal("1st join should succeed under cap 2")
	}
	c2 := newFakeConn()
	if _, _, ok := inst.tryJoin("", true, "~guest", "survival", nil, c2); !ok {
		t.Fatal("2nd join should succeed under cap 2")
	}
	c3 := newFakeConn()
	if _, _, ok := inst.tryJoin("", true, "~guest2", "survival", nil, c3); ok {
		t.Fatal("3rd join should be refused: at cap")
	}
}

// ---- host reassignment -----------------------------------------------

func TestHostReassignmentOldestMemberThenOldestPlayer(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	store.addMember(w.ID, "memberA")
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	hostConn := newFakeConn()
	hostPlayer, _, ok := inst.tryJoin("host1", false, "host1", "survival", nil, hostConn)
	if !ok {
		t.Fatal("host join failed")
	}
	if inst.HostUsername() != "host1" {
		t.Fatalf("initial host should be host1, got %q", inst.HostUsername())
	}

	// A guest joins first (should NOT become host over a later member).
	guestConn := newFakeConn()
	if _, _, ok := inst.tryJoin("", true, "~guest", "survival", nil, guestConn); !ok {
		t.Fatal("guest join failed")
	}
	// Then an actual world member joins.
	memberConn := newFakeConn()
	if _, _, ok := inst.tryJoin("memberA", false, "memberA", "survival", nil, memberConn); !ok {
		t.Fatal("member join failed")
	}

	// Host leaves: the member (even though it joined after the guest)
	// should become host, per "oldest present member, else oldest player".
	inst.removePlayer(hostPlayer)
	if inst.HostUsername() != "memberA" {
		t.Fatalf("host should reassign to the member, got %q", inst.HostUsername())
	}
	hostFrames := memberConn.framesOfType("host")
	if len(hostFrames) == 0 {
		t.Fatal("expected a 'host' broadcast frame")
	}
	if hostFrames[len(hostFrames)-1]["name"] != "memberA" {
		t.Fatalf("host frame name = %v, want memberA", hostFrames[len(hostFrames)-1]["name"])
	}
}

func TestHostReassignmentFallsBackToOldestPlayer(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	hostConn := newFakeConn()
	hostPlayer, _, _ := inst.tryJoin("host1", false, "host1", "survival", nil, hostConn)
	firstGuestConn := newFakeConn()
	inst.tryJoin("", true, "~first", "survival", nil, firstGuestConn)
	secondGuestConn := newFakeConn()
	inst.tryJoin("", true, "~second", "survival", nil, secondGuestConn)

	inst.removePlayer(hostPlayer)
	// No members present at all -> oldest remaining PLAYER (the first
	// guest, who joined before the second guest).
	if inst.HostUsername() != "~first" {
		t.Fatalf("host should fall back to the oldest player ~first, got %q", inst.HostUsername())
	}
}

// ---- 3. delta compaction round-trip -------------------------------------

func TestDeltaCompactionKeepsLastWriteAscending(t *testing.T) {
	// Apply out-of-order, overlapping edits to the same index via SetBlock,
	// then flush and inspect the compacted bytes directly: exactly one
	// record per index, ascending index order, last write wins.
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	// All edits land in chunk (0,0) (x,z in [0,15]). Three target cells,
	// chosen at different heights so their linear indices
	// idx=(y*16+z)*16+x land respectively low/mid/high: (x=10,y=0,z=0) ->
	// idx 10; (x=8,y=7,z=12) -> idx 1992; (x=4,y=1,z=15) -> idx 500. The
	// mid-value cell (idx 500) is written three times, out of order
	// relative to the others, to verify both "last write wins" and
	// "ascending index order" survive compaction independent of write order.
	const idxLow, idxMid, idxHigh = 10, 500, 1992
	if got := blockIndex(0, 10, 0); got != idxLow {
		t.Fatalf("test setup: blockIndex(0,10,0) = %d, want %d", got, idxLow)
	}
	if got := blockIndex(1, 4, 15); got != idxMid {
		t.Fatalf("test setup: blockIndex(1,4,15) = %d, want %d", got, idxMid)
	}
	if got := blockIndex(7, 8, 12); got != idxHigh {
		t.Fatalf("test setup: blockIndex(7,8,12) = %d, want %d", got, idxHigh)
	}

	inst.SetBlock(4, 1, 15, 1) // idxMid, id 1 (will be overwritten)
	inst.SetBlock(10, 0, 0, 7) // idxLow
	inst.SetBlock(4, 1, 15, 3) // idxMid, overwrite id 1 -> 3
	inst.SetBlock(8, 7, 12, 5) // idxHigh
	inst.SetBlock(4, 1, 15, 9) // idxMid, final overwrite -> 9 wins

	inst.flushDirty()

	blobs, err := store.GetDeltas(w.ID)
	if err != nil {
		t.Fatalf("GetDeltas: %v", err)
	}
	blob, ok := blobs[chunkKey(0, 0)]
	if !ok {
		t.Fatal("expected a flushed delta for chunk 0,0")
	}
	if len(blob)%recordSize != 0 {
		t.Fatalf("blob length %d is not a multiple of recordSize %d", len(blob), recordSize)
	}
	n := len(blob) / recordSize
	if n != 3 {
		t.Fatalf("expected exactly 3 compacted records (indexes %d,%d,%d), got %d", idxLow, idxMid, idxHigh, n)
	}

	// Decode and verify ascending order + last-write-wins.
	decoded := decodeRecords(blob)
	if len(decoded) != 3 {
		t.Fatalf("decoded map should have 3 entries, got %d", len(decoded))
	}
	if decoded[idxMid] != 9 {
		t.Fatalf("index %d should keep the LAST write (9), got %d", idxMid, decoded[idxMid])
	}
	if decoded[idxLow] != 7 {
		t.Fatalf("index %d should be 7, got %d", idxLow, decoded[idxLow])
	}
	if decoded[idxHigh] != 5 {
		t.Fatalf("index %d should be 5, got %d", idxHigh, decoded[idxHigh])
	}

	// Verify ascending order directly on the raw bytes (record i's index <
	// record i+1's index).
	var lastIdx = -1
	for i := 0; i < n; i++ {
		off := i * recordSize
		idx := int(blob[off]) | int(blob[off+1])<<8
		if idx <= lastIdx {
			t.Fatalf("records not in strict ascending order: record %d index %d follows %d", i, idx, lastIdx)
		}
		lastIdx = idx
	}
}

func TestDeltaEmptyBlobRemovesChunk(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	inst.SetBlock(0, 5, 0, 3)
	inst.flushDirty()
	if _, ok := store.deltas[w.ID][chunkKey(0, 0)]; !ok {
		t.Fatal("expected chunk 0,0 to be persisted after first edit")
	}

	// Reverting the single edited index to air (0) and flushing should
	// write an EMPTY compacted blob... but our in-memory delta map only
	// ever forgets a key if we explicitly clear it; setting a block back to
	// its original id still counts as "a delta" at the wire-format level
	// (this package does not know the seed's original id, so it cannot by
	// itself detect "back to pure seed" — it only guarantees the *encoding*
	// rule: an empty map compacts to an empty blob). We verify that rule
	// directly instead.
	empty := encodeRecords(map[uint16]uint8{})
	if len(empty) != 0 {
		t.Fatalf("compacting an empty delta map must yield an empty (nil/zero-length) blob, got %d bytes", len(empty))
	}
	if err := store.SaveDeltas(w.ID, map[string][]byte{chunkKey(0, 0): empty}); err != nil {
		t.Fatalf("SaveDeltas: %v", err)
	}
	if _, ok := store.deltas[w.ID][chunkKey(0, 0)]; ok {
		t.Fatal("an empty blob should delete the chunk's delta row")
	}
}

func TestDecodeAllDeltasRoundTrip(t *testing.T) {
	original := map[uint16]uint8{5: 1, 900: 2, 24000: 3}
	blob := encodeRecords(original)
	blobs := map[string][]byte{"1,-2": blob, "garbage-key": {1, 2, 3}}
	decoded := decodeAllDeltas(blobs)
	if _, ok := decoded["garbage-key"]; ok {
		t.Fatal("a malformed chunk key should be skipped, not decoded")
	}
	got, ok := decoded["1,-2"]
	if !ok {
		t.Fatal("valid chunk key should decode")
	}
	for idx, id := range original {
		if got[idx] != id {
			t.Fatalf("round-trip mismatch at index %d: got %d want %d", idx, got[idx], id)
		}
	}

	// Base64 wire round-trip (welcome payload path).
	b64 := base64Encode(blob)
	raw, err := base64Decode(b64)
	if err != nil {
		t.Fatalf("base64Decode: %v", err)
	}
	if string(raw) != string(blob) {
		t.Fatal("base64 round-trip should reproduce the exact bytes")
	}
}

// blockIndex mirrors the contract §2 in-chunk index formula
// (i = (y*16+z)*16+x) independently of SetBlock's own implementation, so the
// compaction test can pin exact expected indices for chosen (x,y,z) rather
// than trusting the code under test to compute its own expectations.
func blockIndex(y, x, z int) int { return (y*16+z)*16 + x }

// ---- 4. flood-then-kick counter -------------------------------------

func TestFloodWarningsThenKick(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	conn := newFakeConn()
	p, _, ok := inst.tryJoin("host1", false, "host1", "survival", nil, conn)
	if !ok {
		t.Fatal("join failed")
	}

	// Exhaust the chat budget (1/s) instantly so every subsequent call in
	// this same window is a breach.
	if !inst.rateOK(p, rateChat) {
		t.Fatal("first chat message should be allowed")
	}

	// 1st breach -> warning (still connected).
	if !inst.rateOK(p, rateChat) {
		t.Fatal("first breach should warn, not kick")
	}
	if p.closed.Load() {
		t.Fatal("player should not be closed after 1 warning")
	}
	sysFrames := conn.framesOfType("sys")
	if len(sysFrames) != 1 {
		t.Fatalf("expected exactly 1 sys warning so far, got %d", len(sysFrames))
	}

	// 2nd breach -> second warning (still connected: maxWarnings==2).
	if !inst.rateOK(p, rateChat) {
		t.Fatal("second breach should still warn, not kick")
	}
	if p.closed.Load() {
		t.Fatal("player should not be closed after 2 warnings")
	}
	sysFrames = conn.framesOfType("sys")
	if len(sysFrames) != 2 {
		t.Fatalf("expected exactly 2 sys warnings so far, got %d", len(sysFrames))
	}

	// 3rd breach -> kick.
	if inst.rateOK(p, rateChat) {
		t.Fatal("third breach should kick (rateOK should return false)")
	}
	if !p.closed.Load() {
		t.Fatal("player should be marked closed after the kick threshold")
	}
	kickFrames := conn.framesOfType("kick")
	if len(kickFrames) != 1 {
		t.Fatalf("expected exactly 1 kick frame, got %d", len(kickFrames))
	}
	if kickFrames[0]["reason"] != "flood" {
		t.Fatalf("kick reason = %v, want %q", kickFrames[0]["reason"], "flood")
	}
	if !conn.closed {
		t.Fatal("underlying connection should be closed on kick")
	}
}

func TestFloodCounterIsPerKindWindowButSharedWarnings(t *testing.T) {
	// The contract phrases flood control as one policy (2 warnings then
	// kick): the warning counter accumulates across message kinds even
	// though each kind tracks its own rate window independently. Here we
	// draw warning 1 from chat and warning 2 from block, then verify the
	// THIRD breach — from a third kind, move — is the one that kicks
	// (proving the counter is shared, not per-kind).
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	conn := newFakeConn()
	p, _, _ := inst.tryJoin("host1", false, "host1", "survival", nil, conn)

	// Breach chat once: 1st call consumes the 1/s budget, 2nd call breaches
	// -> warning 1.
	inst.rateOK(p, rateChat)
	if !inst.rateOK(p, rateChat) {
		t.Fatal("warning 1 (chat) should not kick yet")
	}
	if p.closed.Load() {
		t.Fatal("player should still be connected after 1 warning")
	}

	// Breach block once (a DIFFERENT kind's window): exhaust its budget,
	// then breach -> warning 2.
	for i := 0; i < blockMaxHz; i++ {
		if !inst.rateOK(p, rateBlock) {
			t.Fatal("should not kick before exhausting the block budget")
		}
	}
	if !inst.rateOK(p, rateBlock) {
		t.Fatal("warning 2 (block) should not kick yet")
	}
	if p.closed.Load() {
		t.Fatal("player should still be connected after 2 warnings, even across kinds")
	}

	// Breach move once (a THIRD kind): exhaust its budget, then breach ->
	// this is the 3rd total warning, which must kick.
	for i := 0; i < moveMaxHz; i++ {
		if !inst.rateOK(p, rateMove) {
			t.Fatal("should not kick before exhausting the move budget")
		}
	}
	if inst.rateOK(p, rateMove) {
		t.Fatal("the 3rd total breach, from yet another kind, should kick")
	}
	if !p.closed.Load() {
		t.Fatal("player should be kicked once total warnings across kinds reach 3")
	}
}

// ---- misc small pieces worth pinning directly -----------------------

func TestUniquifyGuestName(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	first := inst.uniquifyGuestName("nick")
	if first != "~nick" {
		t.Fatalf("first guest name should be ~nick, got %q", first)
	}
	inst.tryJoin("", true, first, "survival", nil, newFakeConn())

	second := inst.uniquifyGuestName("nick")
	if second != "~nick2" {
		t.Fatalf("second guest name should be ~nick2, got %q", second)
	}
}

func TestListVisibilityRules(t *testing.T) {
	store := newFakeWorldStore()
	pubW := testWorld("pub", "owner1")
	pwW := testWorld("pw", "owner2")
	frW := testWorld("fr", "owner3")
	privW := testWorld("priv", "owner4")
	store.addWorld(pubW)
	store.addWorld(pwW)
	store.addWorld(frW)
	store.addWorld(privW)
	store.addMember(frW.ID, "membercarol")

	friends := newFakeFriendChecker()
	friends.addFriends("dave", "hostfr")

	m := newTestManager(store, friends, nil)
	i1, _ := m.Open(pubW, "hostpub", "public", "")
	i2, _ := m.Open(pwW, "hostpw", "password", "1234")
	i3, _ := m.Open(frW, "hostfr", "friends", "")
	i4, _ := m.Open(privW, "hostpriv", "private", "")
	defer i1.shutdown()
	defer i2.shutdown()
	defer i3.shutdown()
	defer i4.shutdown()

	friendsOf := func(host string) []string {
		if host == "hostfr" {
			return []string{"dave"}
		}
		return nil
	}

	// A totally anonymous viewer ("") sees public + password (locked), but
	// never friends or private.
	anon := m.List("", friendsOf)
	seen := map[string]RoomInfo{}
	for _, r := range anon {
		seen[r.RoomID] = r
	}
	if _, ok := seen[i1.RoomID]; !ok {
		t.Error("anonymous viewer should see the public room")
	}
	if r, ok := seen[i2.RoomID]; !ok || !r.Locked {
		t.Error("anonymous viewer should see the password room as locked")
	}
	if _, ok := seen[i3.RoomID]; ok {
		t.Error("anonymous viewer should NOT see the friends room")
	}
	if _, ok := seen[i4.RoomID]; ok {
		t.Error("anonymous viewer should NEVER see the private room")
	}
	// The password room must never leak its pin/hash via the listing: this
	// is a compile-time guarantee too (RoomInfo has no pin/hash field at
	// all), but assert the runtime shape stays exactly the documented one.
	if pw := seen[i2.RoomID]; pw.Access != "password" {
		t.Errorf("password room Access = %q, want %q", pw.Access, "password")
	}

	// dave (accepted friend of hostfr) also sees the friends room.
	daveView := m.List("dave", friendsOf)
	daveSeen := map[string]bool{}
	for _, r := range daveView {
		daveSeen[r.RoomID] = true
	}
	if !daveSeen[i3.RoomID] {
		t.Error("dave (friend of host) should see the friends room")
	}
	if daveSeen[i4.RoomID] {
		t.Error("dave should still never see the private room")
	}

	// membercarol (world member of frW, not personally friends with hostfr)
	// also sees the friends room via membership.
	carolView := m.List("membercarol", friendsOf)
	carolSeen := map[string]bool{}
	for _, r := range carolView {
		carolSeen[r.RoomID] = true
	}
	if !carolSeen[i3.RoomID] {
		t.Error("a world member should see the friends room even without a personal friendship")
	}
}

func TestGetByWorldAndGet(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	if got, ok := m.Get(inst.RoomID); !ok || got != inst {
		t.Fatal("Get should resolve the room id to the same instance")
	}
	if got, ok := m.GetByWorld(w.ID); !ok || got != inst {
		t.Fatal("GetByWorld should resolve the world id to the same instance")
	}
	if _, ok := m.Get("nope"); ok {
		t.Fatal("unknown room id should not resolve")
	}
}

func TestSetTimeWraps(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	inst.SetTime(-100)
	if got := inst.TimeTicks(); got != ticksPerDay-100 {
		t.Fatalf("negative SetTime should wrap into [0,24000), got %d", got)
	}
	inst.SetTime(ticksPerDay + 500)
	if got := inst.TimeTicks(); got != 500 {
		t.Fatalf("SetTime beyond a day should wrap, got %d", got)
	}
}

func TestVerifyTokenInjection(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	verify := func(token string) (string, bool) {
		if token == "good-token" {
			return "alice", true
		}
		return "", false
	}
	m := newTestManager(store, newFakeFriendChecker(), verify)
	inst, err := m.Open(w, "alice", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	good := "good-token"
	user, guest, name, ok := resolveIdentity(m, inst, helloMsg{Token: &good})
	if !ok || guest || user != "alice" || name != "alice" {
		t.Fatalf("good token should resolve to account alice, got user=%q guest=%v name=%q ok=%v", user, guest, name, ok)
	}

	bad := "bad-token"
	_, _, _, ok = resolveIdentity(m, inst, helloMsg{Token: &bad})
	if ok {
		t.Fatal("a token that fails verification must not silently succeed as a guest")
	}

	nick := "steve"
	user, guest, name, ok = resolveIdentity(m, inst, helloMsg{Nick: &nick})
	if !ok || !guest || user != "" || name != "~steve" {
		t.Fatalf("nick-only hello should resolve to a guest, got user=%q guest=%v name=%q ok=%v", user, guest, name, ok)
	}
}

// ===========================================================================
// Part III: combat, mobs, drops, difficulty/keepInventory (ARCHITECTURE-
// COMBAT.md §5.2/§6/§7/§10).
// ===========================================================================

// joinTestPlayer is a small helper wrapping tryJoin for the combat tests
// below, which mostly don't care about mode/skin/guest nuances (already
// thoroughly covered by the Part II tests above) and just need a connected
// *Player with a known starting position.
func joinTestPlayer(t *testing.T, inst *Instance, id string) (*Player, *fakeConn) {
	t.Helper()
	conn := newFakeConn()
	p, _, ok := inst.tryJoin(id, false, id, "survival", nil, conn)
	if !ok {
		t.Fatalf("join failed for %q", id)
	}
	return p, conn
}

// ---- hit validation (§5.2) -----------------------------------------------

func TestHitInRangeSucceeds(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, _ := joinTestPlayer(t, inst, "attacker")
	target, targetConn := joinTestPlayer(t, inst, "target")

	attacker.mu.Lock()
	attacker.Pos = [3]float64{0, 64, 0}
	attacker.mu.Unlock()
	target.mu.Lock()
	target.Pos = [3]float64{2, 64, 0} // 2 blocks away: within the 4.5 range
	target.mu.Unlock()

	raw, _ := json.Marshal(hitMsg{TargetID: target.ID})
	handleHit(inst, attacker, raw)

	hp, dead := target.hpSnapshot()
	if hp != maxHP-fistDamage {
		t.Fatalf("in-range fist hit should deal %v damage, target hp = %v (want %v)", fistDamage, hp, maxHP-fistDamage)
	}
	if dead {
		t.Fatal("a single fist hit should not kill a full-hp target")
	}
	dmgFrames := targetConn.framesOfType("damage")
	if len(dmgFrames) != 1 {
		t.Fatalf("expected exactly 1 'damage' frame broadcast to the target, got %d", len(dmgFrames))
	}
	if dmgFrames[0]["by"] != attacker.ID || dmgFrames[0]["cause"] != "player" {
		t.Fatalf("damage frame = %+v, want by=%q cause=player", dmgFrames[0], attacker.ID)
	}
}

func TestHitOutOfRangeRejected(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, _ := joinTestPlayer(t, inst, "attacker")
	target, _ := joinTestPlayer(t, inst, "target")

	attacker.mu.Lock()
	attacker.Pos = [3]float64{0, 64, 0}
	attacker.mu.Unlock()
	target.mu.Lock()
	target.Pos = [3]float64{100, 64, 0} // far beyond the 4.5-block range
	target.mu.Unlock()

	raw, _ := json.Marshal(hitMsg{TargetID: target.ID})
	handleHit(inst, attacker, raw)

	hp, _ := target.hpSnapshot()
	if hp != maxHP {
		t.Fatalf("out-of-range hit should deal no damage, target hp = %v (want %v)", hp, maxHP)
	}
}

func TestHitCooldownEnforced(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, _ := joinTestPlayer(t, inst, "attacker")
	target, _ := joinTestPlayer(t, inst, "target")
	attacker.mu.Lock()
	attacker.Pos = [3]float64{0, 64, 0}
	attacker.mu.Unlock()
	target.mu.Lock()
	target.Pos = [3]float64{1, 64, 0}
	target.mu.Unlock()

	raw, _ := json.Marshal(hitMsg{TargetID: target.ID})
	handleHit(inst, attacker, raw) // 1st hit: allowed
	handleHit(inst, attacker, raw) // 2nd hit, same instant: cooldown should reject

	hp, _ := target.hpSnapshot()
	if hp != maxHP-fistDamage {
		t.Fatalf("second hit within the 350ms cooldown should be rejected, target hp = %v (want %v after exactly 1 landed hit)", hp, maxHP-fistDamage)
	}

	// After the cooldown elapses, a further hit should land.
	time.Sleep(hitCooldown + 20*time.Millisecond)
	handleHit(inst, attacker, raw)
	hp, _ = target.hpSnapshot()
	if hp != maxHP-2*fistDamage {
		t.Fatalf("a hit after the cooldown elapses should land, target hp = %v (want %v)", hp, maxHP-2*fistDamage)
	}
}

func TestHitSelfRejected(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, _ := joinTestPlayer(t, inst, "attacker")
	raw, _ := json.Marshal(hitMsg{TargetID: attacker.ID})
	handleHit(inst, attacker, raw)

	hp, _ := attacker.hpSnapshot()
	if hp != maxHP {
		t.Fatalf("hitting yourself should never deal damage, hp = %v (want %v)", hp, maxHP)
	}
}

// ---- damage/armor-reduction math (§5.2) -----------------------------------

func TestApplyArmorReductionFormula(t *testing.T) {
	cases := []struct {
		dmg, armorPoints, want float64
	}{
		{10, 0, 10},      // no armor: full damage
		{10, 5, 8},       // 1 - 5*0.04 = 0.8
		{10, 20, 2},      // 1 - 20*0.04 = 0.2 -> exactly the floor
		{10, 100, 2},     // way over the floor: clamped to the 0.2 minimum multiplier
		{4, 15, 4 * 0.4}, // sword_wood damage vs 15 armor points: 1-15*0.04=0.4
	}
	for _, c := range cases {
		got := applyArmorReduction(c.dmg, c.armorPoints)
		if math.Abs(got-c.want) > 1e-9 {
			t.Errorf("applyArmorReduction(%v,%v) = %v, want %v", c.dmg, c.armorPoints, got, c.want)
		}
	}
}

func TestHitWithArmorReducesDamage(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, _ := joinTestPlayer(t, inst, "attacker")
	target, _ := joinTestPlayer(t, inst, "target")
	attacker.mu.Lock()
	attacker.Pos = [3]float64{0, 64, 0}
	attacker.HeldID = "sword_iron" // damage 6, per contract §4
	attacker.mu.Unlock()
	target.mu.Lock()
	target.Pos = [3]float64{1, 64, 0}
	// Full iron armor set: helmet 2 + chest 5 + legs 4 + boots 2 = 13 points.
	target.Armor = ArmorSet{Helmet: "helmet_iron", Chest: "chestplate_iron", Legs: "leggings_iron", Boots: "boots_iron"}
	target.mu.Unlock()

	raw, _ := json.Marshal(hitMsg{TargetID: target.ID})
	handleHit(inst, attacker, raw)

	wantDmg := applyArmorReduction(6, 13)
	hp, _ := target.hpSnapshot()
	if math.Abs(hp-(maxHP-wantDmg)) > 1e-9 {
		t.Fatalf("armored hit: target hp = %v, want %v (dmg=%v)", hp, maxHP-wantDmg, wantDmg)
	}

	// Sanity: the SAME attack against a bare target should deal full,
	// unreduced iron-sword damage (6), proving the armor really is the
	// thing doing the reducing above, not some other unrelated factor.
	bareTarget, _ := joinTestPlayer(t, inst, "baretarget")
	bareTarget.mu.Lock()
	bareTarget.Pos = [3]float64{0, 64, 1}
	bareTarget.mu.Unlock()
	time.Sleep(hitCooldown + 20*time.Millisecond) // clear the attacker's own cooldown from the first swing
	raw2, _ := json.Marshal(hitMsg{TargetID: bareTarget.ID})
	handleHit(inst, attacker, raw2)
	bareHP, _ := bareTarget.hpSnapshot()
	if bareHP != maxHP-6 {
		t.Fatalf("unarmored target hit by an iron sword should take exactly 6 damage, hp = %v (want %v)", bareHP, maxHP-6)
	}
}

func TestTotalArmorPointsSumsAllSlots(t *testing.T) {
	set := ArmorSet{Helmet: "helmet_diamond", Chest: "chestplate_diamond", Legs: "leggings_diamond", Boots: "boots_diamond"}
	got := totalArmorPoints(set)
	want := 3.0 + 6.0 + 5.0 + 3.0 // contract §4: helmet 1-3, chest 3-6, legs 2-5, boots 1-3 by tier; diamond is the top of each range
	if got != want {
		t.Fatalf("totalArmorPoints(full diamond) = %v, want %v", got, want)
	}
	if got := totalArmorPoints(ArmorSet{}); got != 0 {
		t.Fatalf("totalArmorPoints(empty) = %v, want 0", got)
	}
}

// ---- death + respawn (§5.1/§5.2) ------------------------------------------

func TestDeathBroadcastsOnZeroHP(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, _ := joinTestPlayer(t, inst, "attacker")
	target, targetConn := joinTestPlayer(t, inst, "target")
	attacker.mu.Lock()
	attacker.Pos = [3]float64{0, 64, 0}
	attacker.HeldID = "sword_diamond" // damage 8: 3 hits kill a full-hp unarmored target (20 hp)
	attacker.mu.Unlock()
	target.mu.Lock()
	target.Pos = [3]float64{1, 64, 0}
	target.mu.Unlock()

	raw, _ := json.Marshal(hitMsg{TargetID: target.ID})
	for i := 0; i < 3; i++ {
		handleHit(inst, attacker, raw)
		if i < 2 {
			time.Sleep(hitCooldown + 20*time.Millisecond)
		}
	}

	hp, dead := target.hpSnapshot()
	if hp != 0 {
		t.Fatalf("hp should clamp at exactly 0, got %v", hp)
	}
	if !dead {
		t.Fatal("target should be marked Dead once hp reaches 0")
	}
	deathFrames := targetConn.framesOfType("death")
	if len(deathFrames) != 1 {
		t.Fatalf("expected exactly 1 'death' frame, got %d", len(deathFrames))
	}
	if deathFrames[0]["id"] != target.ID || deathFrames[0]["by"] != attacker.ID {
		t.Fatalf("death frame = %+v, want id=%q by=%q", deathFrames[0], target.ID, attacker.ID)
	}

	// A dead target takes no further damage (already-dead hits are filtered
	// before reaching the damage/armor math at all).
	time.Sleep(hitCooldown + 20*time.Millisecond)
	handleHit(inst, attacker, raw)
	hp2, _ := target.hpSnapshot()
	if hp2 != 0 {
		t.Fatalf("hitting an already-dead player should be a no-op, hp = %v", hp2)
	}
}

func TestRespawnResetsHPAndPosition(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	w.Settings = json.RawMessage(`{"cap":8,"spawn":[5,70,5]}`)
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	p, conn := joinTestPlayer(t, inst, "p1")
	p.mu.Lock()
	p.HP = 0
	p.Dead = true
	p.Pos = [3]float64{999, 12, 999}
	p.mu.Unlock()

	handleRespawn(inst, p)

	hp, dead := p.hpSnapshot()
	if hp != maxHP {
		t.Fatalf("respawn should reset hp to %v, got %v", maxHP, hp)
	}
	if dead {
		t.Fatal("respawn should clear the Dead flag")
	}
	p.mu.Lock()
	pos := p.Pos
	p.mu.Unlock()
	if pos != ([3]float64{5, 70, 5}) {
		t.Fatalf("respawn should reposition to world spawn, got %v want [5 70 5]", pos)
	}
	healthFrames := conn.framesOfType("health")
	if len(healthFrames) == 0 {
		t.Fatal("respawn should broadcast a 'health' frame")
	}
	last := healthFrames[len(healthFrames)-1]
	if last["hp"] != maxHP {
		t.Fatalf("final health frame hp = %v, want %v", last["hp"], maxHP)
	}
}

// ---- selfDamage (§8) -------------------------------------------------------

func TestSelfDamageAppliesAndCanKill(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	p, conn := joinTestPlayer(t, inst, "p1")
	raw, _ := json.Marshal(selfDamageMsg{Amount: 7, Cause: "fall"})
	handleSelfDamage(inst, p, raw)

	hp, _ := p.hpSnapshot()
	if hp != maxHP-7 {
		t.Fatalf("selfDamage should apply the claimed amount, hp = %v (want %v)", hp, maxHP-7)
	}
	dmgFrames := conn.framesOfType("damage")
	if len(dmgFrames) != 1 || dmgFrames[0]["cause"] != "fall" {
		t.Fatalf("expected a 'damage' frame with cause=fall, got %+v", dmgFrames)
	}

	// An invalid cause is rejected outright.
	rawBad, _ := json.Marshal(selfDamageMsg{Amount: 5, Cause: "player"})
	handleSelfDamage(inst, p, rawBad)
	hp2, _ := p.hpSnapshot()
	if hp2 != maxHP-7 {
		t.Fatalf("a selfDamage cause of 'player' must never be accepted (that path is hit-only), hp changed to %v", hp2)
	}

	// Can kill: enough fall damage to reach 0.
	rawKill, _ := json.Marshal(selfDamageMsg{Amount: maxHP, Cause: "void"})
	handleSelfDamage(inst, p, rawKill)
	hp3, dead := p.hpSnapshot()
	if hp3 != 0 || !dead {
		t.Fatalf("large selfDamage should be able to kill, hp = %v dead = %v", hp3, dead)
	}
}

// ---- difficulty / keepInventory persistence round-trip (§6) ---------------

func TestDifficultyAndKeepInventoryPersistRoundTrip(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	if got := inst.Difficulty(); got != "normal" {
		t.Fatalf("default difficulty should be %q, got %q", "normal", got)
	}
	if got := inst.KeepInventory(); got != false {
		t.Fatal("default keepInventory should be false, matching vanilla convention")
	}

	host, hostConn := joinTestPlayer(t, inst, "owner1")

	diffRaw, _ := json.Marshal(difficultyMsg{Value: "hard"})
	handleDifficulty(inst, host, diffRaw)
	if got := inst.Difficulty(); got != "hard" {
		t.Fatalf("Difficulty() after handleDifficulty = %q, want hard", got)
	}
	diffFrames := hostConn.framesOfType("difficulty")
	if len(diffFrames) != 1 || diffFrames[0]["value"] != "hard" {
		t.Fatalf("expected a 'difficulty' broadcast frame with value=hard, got %+v", diffFrames)
	}

	ruleRaw, _ := json.Marshal(gameruleMsg{Rule: "keepInventory", Value: true})
	handleGamerule(inst, host, ruleRaw)
	if got := inst.KeepInventory(); got != true {
		t.Fatal("KeepInventory() after handleGamerule should be true")
	}
	ruleFrames := hostConn.framesOfType("gamerule")
	if len(ruleFrames) != 1 || ruleFrames[0]["rule"] != "keepInventory" || ruleFrames[0]["value"] != true {
		t.Fatalf("expected a 'gamerule' broadcast frame, got %+v", ruleFrames)
	}

	// Now flush settings (as shutdown() does) and verify the SAME
	// worlds.settings jsonb object round-trips difficulty+keepInventory
	// alongside cap/spawn/time — not a second persistence path.
	inst.flushSettings()

	raw := store.settings[w.ID]
	if raw == nil {
		t.Fatal("expected UpdateSettings to have been called")
	}
	var persisted worldSettings
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatalf("persisted settings did not decode: %v", err)
	}
	if persisted.Difficulty != "hard" {
		t.Fatalf("persisted settings.difficulty = %q, want hard", persisted.Difficulty)
	}
	if !persisted.KeepInventory {
		t.Fatal("persisted settings.keepInventory should be true")
	}
	if persisted.Cap != inst.Cap() {
		t.Fatalf("persisted settings.cap = %d, want %d (extending the SAME object, not replacing it)", persisted.Cap, inst.Cap())
	}

	// Close via the Manager (not a bare inst.shutdown()) so the world's
	// byWorld/byRoom lock entries are actually released — mirroring
	// TestCloseThenOpenAgainSucceeds above, since Manager.Close is what
	// performs shutdown() AND removes the instance from the manager's maps.
	// The requester must be the CONNECTED host ("owner1", who actually
	// joined above and became host), not "host1" (only Open()'s pre-join
	// placeholder host name, per newInstance's doc).
	if err := m.Close(inst.RoomID, "owner1", false); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Re-opening the world should load difficulty/keepInventory straight
	// back out of the persisted settings, proving the round-trip through
	// parseSettings on the load side too.
	w2, _ := store.Get(w.ID)
	inst2, err := m.Open(w2, "host1", "public", "")
	if err != nil {
		t.Fatalf("re-Open: %v", err)
	}
	defer inst2.shutdown()
	if got := inst2.Difficulty(); got != "hard" {
		t.Fatalf("re-opened instance Difficulty() = %q, want hard (loaded from persisted settings)", got)
	}
	if got := inst2.KeepInventory(); got != true {
		t.Fatal("re-opened instance KeepInventory() should be true (loaded from persisted settings)")
	}
}

func TestDifficultyRejectsUnknownValue(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()
	host, hostConn := joinTestPlayer(t, inst, "owner1")

	raw, _ := json.Marshal(difficultyMsg{Value: "nightmare"})
	handleDifficulty(inst, host, raw)
	if got := inst.Difficulty(); got != "normal" {
		t.Fatalf("an unknown difficulty value must be rejected, Difficulty() = %q, want unchanged normal", got)
	}
	errFrames := hostConn.framesOfType("error")
	if len(errFrames) == 0 {
		t.Fatal("expected an 'error' frame for the unknown difficulty value")
	}
}

func TestDifficultyAndGameruleAreHostOnly(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	joinTestPlayer(t, inst, "host1") // becomes host (first joiner)
	nonHost, nonHostConn := joinTestPlayer(t, inst, "mallory")

	diffRaw, _ := json.Marshal(difficultyMsg{Value: "hard"})
	handleDifficulty(inst, nonHost, diffRaw)
	if got := inst.Difficulty(); got != "normal" {
		t.Fatalf("a non-host difficulty change must be rejected, got %q", got)
	}

	ruleRaw, _ := json.Marshal(gameruleMsg{Rule: "keepInventory", Value: true})
	handleGamerule(inst, nonHost, ruleRaw)
	if got := inst.KeepInventory(); got != false {
		t.Fatal("a non-host gamerule change must be rejected")
	}

	errFrames := nonHostConn.framesOfType("error")
	if len(errFrames) != 2 {
		t.Fatalf("expected 2 'error' frames (one per rejected command) sent to the non-host, got %d", len(errFrames))
	}
}

// ---- mob spawn/despawn + population caps (§7) ------------------------------

func TestMobSpawnAndDamageAndDespawn(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	_, conn := joinTestPlayer(t, inst, "p1")

	mob := inst.spawnMob("zombie", [3]float64{10, 64, 10})
	spawnFrames := conn.framesOfType("mobSpawn")
	if len(spawnFrames) != 1 || spawnFrames[0]["id"] != mob.ID || spawnFrames[0]["kind"] != "zombie" {
		t.Fatalf("expected a 'mobSpawn' broadcast, got %+v", spawnFrames)
	}
	if mob.HP != zombieHP {
		t.Fatalf("a freshly spawned zombie should have %v hp, got %v", zombieHP, mob.HP)
	}

	inst.mu.Lock()
	_, exists := inst.mobs[mob.ID]
	inst.mu.Unlock()
	if !exists {
		t.Fatal("spawned mob should be registered in inst.mobs")
	}

	inst.despawnMob(mob.ID, nil, false, "")
	inst.mu.Lock()
	_, stillExists := inst.mobs[mob.ID]
	inst.mu.Unlock()
	if stillExists {
		t.Fatal("despawnMob should remove the mob from inst.mobs")
	}
	despawnFrames := conn.framesOfType("mobDespawn")
	if len(despawnFrames) != 1 || despawnFrames[0]["id"] != mob.ID {
		t.Fatalf("expected a 'mobDespawn' broadcast, got %+v", despawnFrames)
	}
}

func TestHitMobDealsDamageAndKills(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	attacker, conn := joinTestPlayer(t, inst, "attacker")
	attacker.mu.Lock()
	attacker.Pos = [3]float64{0, 64, 0}
	attacker.HeldID = "sword_diamond" // 8 damage
	attacker.mu.Unlock()

	mob := inst.spawnMob("pig", [3]float64{1, 64, 0}) // pigHP = 10: 2 diamond-sword hits kill it

	raw, _ := json.Marshal(hitMsg{TargetID: "mob:" + mob.ID})
	handleHit(inst, attacker, raw)
	if mob.HP != pigHP-8 {
		t.Fatalf("mob hp after 1 hit = %v, want %v", mob.HP, pigHP-8)
	}

	time.Sleep(hitCooldown + 20*time.Millisecond)
	handleHit(inst, attacker, raw)
	if mob.HP != 0 {
		t.Fatalf("mob hp should clamp at 0, got %v", mob.HP)
	}

	inst.mu.Lock()
	_, stillExists := inst.mobs[mob.ID]
	inst.mu.Unlock()
	if stillExists {
		t.Fatal("a mob reduced to 0 hp should be despawned")
	}
	deathFrames := conn.framesOfType("death")
	if len(deathFrames) != 1 || deathFrames[0]["id"] != "mob:"+mob.ID || deathFrames[0]["by"] != attacker.ID {
		t.Fatalf("expected a 'death' frame for the killed mob, got %+v", deathFrames)
	}
}

func TestMobPopulationCapEnforced(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	joinTestPlayer(t, inst, "p1")

	// Directly spawn up to the cap (spawnMob itself has no cap check — the
	// cap is enforced by rollMobSpawns' population count before it decides
	// to roll a new spawn at all — so this test exercises rollMobSpawns
	// specifically, matching how the contract frames the cap as a spawn-time
	// gate, not a spawnMob-time gate).
	for i := 0; i < maxZombies; i++ {
		inst.spawnMob("zombie", [3]float64{float64(i), 64, 0})
	}
	inst.mu.Lock()
	inst.timeTicks = 15000 // deep night band, so zombies are eligible to spawn
	players := make([]*Player, 0, len(inst.players))
	for _, p := range inst.players {
		players = append(players, p)
	}
	inst.mu.Unlock()

	for i := 0; i < 50; i++ { // many rolls: if the cap were broken, at least one would exceed it
		inst.rollMobSpawns(players, "normal")
	}

	inst.mu.Lock()
	zombieCount := 0
	for _, mob := range inst.mobs {
		if mob.Kind == "zombie" {
			zombieCount++
		}
	}
	inst.mu.Unlock()
	if zombieCount != maxZombies {
		t.Fatalf("zombie population should stay capped at %d, got %d", maxZombies, zombieCount)
	}
}

func TestZombieChasesAndAttacksPlayerViaTickMobs(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	p, conn := joinTestPlayer(t, inst, "p1")
	p.mu.Lock()
	p.Pos = [3]float64{0, 64, 0}
	p.mu.Unlock()

	// Spawn a zombie already adjacent to the player (<1.2 blocks) so the
	// very first tickMobs call goes straight to the attack branch rather
	// than needing several ticks of straight-line chase movement first.
	mob := inst.spawnMob("zombie", [3]float64{0.5, 64, 0})
	mob.mu.Lock()
	mob.lastMoveAt = time.Now().Add(-100 * time.Millisecond) // give it a sane, small dt
	mob.mu.Unlock()

	inst.tickMobs()

	hp, _ := p.hpSnapshot()
	if hp >= maxHP {
		t.Fatalf("an adjacent zombie should have landed an attack on its first tick, player hp = %v (want < %v)", hp, maxHP)
	}
	if hp < maxHP-zombieDmgMax || hp > maxHP-zombieDmgMin {
		t.Fatalf("zombie damage should fall within the contract's 2-4 range, player hp = %v (dmg = %v, want in [%v,%v])", hp, maxHP-hp, zombieDmgMin, zombieDmgMax)
	}
	dmgFrames := conn.framesOfType("damage")
	if len(dmgFrames) != 1 || dmgFrames[0]["cause"] != "mob" || dmgFrames[0]["by"] != "mob:"+mob.ID {
		t.Fatalf("expected a 'damage' frame with cause=mob by=mob:%s, got %+v", mob.ID, dmgFrames)
	}

	// A second tickMobs call immediately after should NOT land a second hit
	// (the zombie's own 1s per-attack cooldown gates repeated melee, same
	// spirit as the player-side hit cooldown).
	inst.tickMobs()
	hp2, _ := p.hpSnapshot()
	if hp2 != hp {
		t.Fatalf("a zombie should not land two attacks within its attack cooldown window, hp changed from %v to %v", hp, hp2)
	}
}

func TestPeacefulDifficultyDespawnsHostiles(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	host, _ := joinTestPlayer(t, inst, "owner1")
	zombie := inst.spawnMob("zombie", [3]float64{2, 64, 2})
	pig := inst.spawnMob("pig", [3]float64{3, 64, 3})

	raw, _ := json.Marshal(difficultyMsg{Value: "peaceful"})
	handleDifficulty(inst, host, raw)

	inst.mu.Lock()
	_, zombieStillExists := inst.mobs[zombie.ID]
	_, pigStillExists := inst.mobs[pig.ID]
	inst.mu.Unlock()
	if zombieStillExists {
		t.Fatal("/difficulty peaceful should immediately despawn existing hostile mobs")
	}
	if !pigStillExists {
		t.Fatal("/difficulty peaceful should NOT despawn passive mobs")
	}
}

func TestZombieDamageScalesWithDifficulty(t *testing.T) {
	// difficultyDamageMult is the exact per-tick multiplier applied to a
	// zombie's rolled damage (contract §6: "easy/normal/hard scale damage
	// 0.5/1.0/1.5×"), and peaceful must never deal PvE damage at all.
	cases := []struct {
		difficulty string
		want       float64
	}{
		{"peaceful", 0},
		{"easy", 0.5},
		{"normal", 1.0},
		{"hard", 1.5},
	}
	for _, c := range cases {
		if got := difficultyDamageMult(c.difficulty); got != c.want {
			t.Errorf("difficultyDamageMult(%q) = %v, want %v", c.difficulty, got, c.want)
		}
	}
}

// ---- drops (§10/§11) -------------------------------------------------------

func TestDropSpawnPickupDespawn(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	p, conn := joinTestPlayer(t, inst, "p1")
	p.mu.Lock()
	p.Pos = [3]float64{10, 64, 10}
	p.mu.Unlock()

	drop := inst.spawnDrop([3]float64{10.5, 64, 10}, DropStack{ID: "sword_iron", Count: 1, Kind: "item"})
	spawnFrames := conn.framesOfType("dropSpawn")
	if len(spawnFrames) != 1 || spawnFrames[0]["id"] != drop.ID {
		t.Fatalf("expected a 'dropSpawn' broadcast, got %+v", spawnFrames)
	}

	raw, _ := json.Marshal(pickupMsg{DropID: drop.ID})
	handlePickup(inst, p, raw)

	inst.mu.Lock()
	_, exists := inst.drops[drop.ID]
	inst.mu.Unlock()
	if exists {
		t.Fatal("an in-range pickup should remove the drop")
	}
	despawnFrames := conn.framesOfType("dropDespawn")
	if len(despawnFrames) != 1 || despawnFrames[0]["id"] != drop.ID {
		t.Fatalf("expected a 'dropDespawn' broadcast after pickup, got %+v", despawnFrames)
	}
}

func TestDropPickupOutOfRangeRejected(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	p, _ := joinTestPlayer(t, inst, "p1")
	p.mu.Lock()
	p.Pos = [3]float64{0, 64, 0}
	p.mu.Unlock()

	drop := inst.spawnDrop([3]float64{50, 64, 50}, DropStack{ID: "cobblestone", Count: 4, Kind: "block"})

	raw, _ := json.Marshal(pickupMsg{DropID: drop.ID})
	handlePickup(inst, p, raw)

	inst.mu.Lock()
	_, exists := inst.drops[drop.ID]
	inst.mu.Unlock()
	if !exists {
		t.Fatal("an out-of-range pickup request must not remove the drop")
	}
}

func TestDropDespawnsAfterTimeout(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	drop := inst.spawnDrop([3]float64{0, 64, 0}, DropStack{ID: "dirt", Count: 1, Kind: "block"})
	drop.mu.Lock()
	drop.SpawnedAt = time.Now().Add(-dropDespawnAfter - time.Second) // force it "old"
	drop.mu.Unlock()

	inst.tickDrops()

	inst.mu.Lock()
	_, exists := inst.drops[drop.ID]
	inst.mu.Unlock()
	if exists {
		t.Fatal("tickDrops should despawn a drop older than dropDespawnAfter")
	}
}

// ---- move message optional held/armor fields (§9/§5.2) --------------------

func TestMoveHeldAndArmorAreOptionalAndBackwardCompatible(t *testing.T) {
	store := newFakeWorldStore()
	w := testWorld("w1", "owner1")
	store.addWorld(w)
	m := newTestManager(store, newFakeFriendChecker(), nil)
	inst, err := m.Open(w, "host1", "public", "")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer inst.shutdown()

	p, _ := joinTestPlayer(t, inst, "p1")

	// An old-shaped move (no held/armor fields at all) must not touch
	// HeldID/HeldKind/Armor or error/kick the connection.
	oldShaped := []byte(`{"t":"move","p":[1,2,3],"yaw":0,"pitch":0,"anim":{"swing":0,"crouch":false,"fly":false}}`)
	handleMove(inst, p, oldShaped)
	p.mu.Lock()
	heldID, armor := p.HeldID, p.Armor
	p.mu.Unlock()
	if heldID != "" || armor != (ArmorSet{}) {
		t.Fatalf("an old-shaped move message must leave held/armor untouched, got heldID=%q armor=%+v", heldID, armor)
	}

	// A new-shaped move WITH held+armor should update both.
	newShaped := []byte(`{"t":"move","p":[1,2,3],"yaw":0,"pitch":0,"anim":{"swing":0,"crouch":false,"fly":false},"held":{"id":"sword_iron","kind":"item"},"armor":{"helmet":"helmet_iron","chest":"","legs":"","boots":""}}`)
	handleMove(inst, p, newShaped)
	p.mu.Lock()
	heldID, heldKind, armor := p.HeldID, p.HeldKind, p.Armor
	p.mu.Unlock()
	if heldID != "sword_iron" || heldKind != "item" {
		t.Fatalf("held field should update HeldID/HeldKind, got id=%q kind=%q", heldID, heldKind)
	}
	if armor.Helmet != "helmet_iron" {
		t.Fatalf("armor field should update Armor.Helmet, got %+v", armor)
	}
}
