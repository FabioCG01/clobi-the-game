package social

import (
	"database/sql"
	"errors"
	"os"
	"testing"

	"clobi/internal/pgdb"
)

// ---- pure-unit coverage (no database) --------------------------------------

func TestPairNormalizes(t *testing.T) {
	a, b := pair("Bob", "alice")
	if a != "alice" || b != "bob" {
		t.Fatalf("pair(Bob, alice) = (%q, %q), want (alice, bob)", a, b)
	}
	a2, b2 := pair(" ALICE ", "bob")
	if a2 != "alice" || b2 != "bob" {
		t.Fatalf("pair should trim+lowercase: (%q, %q)", a2, b2)
	}
	// Order-independence: pair(x,y) == pair(y,x).
	a3, b3 := pair("bob", "alice")
	if a3 != a || b3 != b {
		t.Fatalf("pair should be symmetric: (%q,%q) vs (%q,%q)", a3, b3, a, b)
	}
}

// ---- store tests (need live PostgreSQL; skipped without TEST_DATABASE_URL) --

// newDBStore opens a throwaway store against TEST_DATABASE_URL (same pattern
// as internal/accounts and internal/market) and truncates the friends table
// for isolation.
func newDBStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run social store tests against PostgreSQL")
	}
	db, err := pgdb.Open(dsn)
	if err != nil {
		t.Fatalf("pgdb.Open: %v", err)
	}
	if _, err := db.Exec(`TRUNCATE friends`); err != nil {
		_ = db.Close()
		t.Fatalf("truncate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	s, err := NewStore(db)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s, db
}

func registerAccount(t *testing.T, db *sql.DB, username string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO accounts(username, display, hash) VALUES ($1, $1, 'x')
		 ON CONFLICT (username) DO NOTHING`, username)
	if err != nil {
		t.Fatalf("registerAccount(%s): %v", username, err)
	}
}

func TestRequestUnknownUser(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	if err := s.Request("alice", "ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Request to unknown user should be ErrNotFound, got %v", err)
	}
	if err := s.Request("alice", "alice"); !errors.Is(err, ErrBadInput) {
		t.Fatalf("Request to yourself should be ErrBadInput, got %v", err)
	}
}

func TestRequestAcceptFlowBothDirections(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")

	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	friends, incoming, outgoing, err := s.ListFriends("alice")
	if err != nil {
		t.Fatalf("ListFriends(alice): %v", err)
	}
	if len(friends) != 0 || len(incoming) != 0 || len(outgoing) != 1 || outgoing[0] != "bob" {
		t.Fatalf("alice should have bob in outgoing: friends=%v incoming=%v outgoing=%v", friends, incoming, outgoing)
	}
	friends, incoming, outgoing, err = s.ListFriends("bob")
	if err != nil {
		t.Fatalf("ListFriends(bob): %v", err)
	}
	if len(friends) != 0 || len(incoming) != 1 || incoming[0] != "alice" || len(outgoing) != 0 {
		t.Fatalf("bob should have alice in incoming: friends=%v incoming=%v outgoing=%v", friends, incoming, outgoing)
	}
	if ok, _ := s.AreFriends("alice", "bob"); ok {
		t.Fatal("a pending request must not count as friends yet")
	}

	// bob cannot accept his own... wait, bob accepts alice's incoming request.
	if err := s.Accept("bob", "alice"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if ok, err := s.AreFriends("alice", "bob"); err != nil || !ok {
		t.Fatalf("should be friends after accept: %v, %v", ok, err)
	}
	if ok, err := s.AreFriends("bob", "alice"); err != nil || !ok {
		t.Fatalf("AreFriends should be symmetric: %v, %v", ok, err)
	}
	friends, incoming, outgoing, _ = s.ListFriends("alice")
	if len(friends) != 1 || friends[0] != "bob" || len(incoming) != 0 || len(outgoing) != 0 {
		t.Fatalf("alice's lists after accept wrong: friends=%v incoming=%v outgoing=%v", friends, incoming, outgoing)
	}
	friends, incoming, outgoing, _ = s.ListFriends("bob")
	if len(friends) != 1 || friends[0] != "alice" || len(incoming) != 0 || len(outgoing) != 0 {
		t.Fatalf("bob's lists after accept wrong: friends=%v incoming=%v outgoing=%v", friends, incoming, outgoing)
	}
}

// TestAutoAcceptOnMutualRequest pins contract §3.2: "auto-accept if they
// already requested you" — if B requests A after A already requested B, the
// pair flips straight to accepted with no lingering second pending row.
func TestAutoAcceptOnMutualRequest(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")

	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request(alice->bob): %v", err)
	}
	if err := s.Request("bob", "alice"); err != nil {
		t.Fatalf("Request(bob->alice) should auto-accept: %v", err)
	}
	if ok, err := s.AreFriends("alice", "bob"); err != nil || !ok {
		t.Fatalf("mutual request should auto-accept: %v, %v", ok, err)
	}
	friends, incoming, outgoing, _ := s.ListFriends("alice")
	if len(friends) != 1 || len(incoming) != 0 || len(outgoing) != 0 {
		t.Fatalf("after auto-accept there should be no pending rows left: friends=%v incoming=%v outgoing=%v",
			friends, incoming, outgoing)
	}

	var count int
	if err := db.QueryRow(`SELECT count(*) FROM friends WHERE (a='alice' AND b='bob') OR (a='bob' AND b='alice')`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("exactly one normalized row should exist for the pair, got %d", count)
	}
}

func TestRequestIdempotentAndAlreadyFriendsNoop(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")

	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("re-requesting the same pending request should be a no-op, got %v", err)
	}
	_, _, outgoing, _ := s.ListFriends("alice")
	if len(outgoing) != 1 {
		t.Fatalf("re-request should not create a duplicate row: outgoing=%v", outgoing)
	}

	if err := s.Accept("bob", "alice"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("requesting an existing friend should be a harmless no-op, got %v", err)
	}
	if ok, _ := s.AreFriends("alice", "bob"); !ok {
		t.Fatal("should still be friends")
	}
}

func TestAcceptRejectsWrongDirectionAndNoRequest(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	registerAccount(t, db, "carol")

	// No request at all.
	if err := s.Accept("bob", "alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Accept with no pending request should be ErrNotFound, got %v", err)
	}

	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	// alice cannot accept her OWN outgoing request.
	if err := s.Accept("alice", "bob"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Accept of own outgoing request should be ErrNotFound, got %v", err)
	}
	// carol has no request from anyone with alice.
	if err := s.Accept("carol", "alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Accept with unrelated pair should be ErrNotFound, got %v", err)
	}
	// The real recipient CAN accept.
	if err := s.Accept("bob", "alice"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
}

func TestRemoveDeclinesPendingAndUnfriendsAccepted(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	registerAccount(t, db, "carol")

	// Decline a pending incoming request.
	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	if err := s.Remove("bob", "alice"); err != nil {
		t.Fatalf("Remove (decline): %v", err)
	}
	_, incoming, _, _ := s.ListFriends("bob")
	if len(incoming) != 0 {
		t.Fatalf("declined request should be gone: incoming=%v", incoming)
	}

	// Cancel a pending outgoing request (same verb, other side calling).
	if err := s.Request("alice", "carol"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	if err := s.Remove("alice", "carol"); err != nil {
		t.Fatalf("Remove (cancel outgoing): %v", err)
	}
	_, _, outgoing, _ := s.ListFriends("alice")
	if len(outgoing) != 0 {
		t.Fatalf("cancelled outgoing request should be gone: outgoing=%v", outgoing)
	}

	// Unfriend an accepted friendship.
	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	if err := s.Accept("bob", "alice"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if ok, _ := s.AreFriends("alice", "bob"); !ok {
		t.Fatal("should be friends before unfriending")
	}
	if err := s.Remove("alice", "bob"); err != nil {
		t.Fatalf("Remove (unfriend): %v", err)
	}
	if ok, _ := s.AreFriends("alice", "bob"); ok {
		t.Fatal("should no longer be friends after Remove")
	}

	// Removing a nonexistent relationship is a harmless no-op.
	if err := s.Remove("alice", "bob"); err != nil {
		t.Fatalf("Remove on nonexistent relationship should be a no-op, got %v", err)
	}
}

func TestAreFriendsSelfIsFalse(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	if ok, err := s.AreFriends("alice", "alice"); err != nil || ok {
		t.Fatalf("a user is never their own friend: %v, %v", ok, err)
	}
}

func TestListFriendsEmptyForNewUser(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	friends, incoming, outgoing, err := s.ListFriends("alice")
	if err != nil {
		t.Fatalf("ListFriends: %v", err)
	}
	if friends == nil || incoming == nil || outgoing == nil {
		t.Fatal("lists should be non-nil empty slices, not nil")
	}
	if len(friends) != 0 || len(incoming) != 0 || len(outgoing) != 0 {
		t.Fatalf("brand-new user should have empty lists: %v %v %v", friends, incoming, outgoing)
	}
}

// TestFriendsOfMatchesAcceptedOnly checks the rooms.Manager.List-facing
// convenience wrapper: only ACCEPTED friends, never pending, and an empty
// (never nil) slice for a user with none.
func TestFriendsOfMatchesAcceptedOnly(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	registerAccount(t, db, "carol")

	if got := s.FriendsOf("alice"); got == nil || len(got) != 0 {
		t.Fatalf("FriendsOf with no friends should be an empty slice, got %v", got)
	}

	if err := s.Request("alice", "bob"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	// Still pending — must not show up yet.
	if got := s.FriendsOf("alice"); len(got) != 0 {
		t.Fatalf("pending request must not count as a friend: %v", got)
	}
	if err := s.Accept("bob", "alice"); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if err := s.Request("alice", "carol"); err != nil {
		t.Fatalf("Request: %v", err)
	}
	got := s.FriendsOf("alice")
	if len(got) != 1 || got[0] != "bob" {
		t.Fatalf("FriendsOf(alice) = %v, want [bob]", got)
	}
	gotBob := s.FriendsOf("bob")
	if len(gotBob) != 1 || gotBob[0] != "alice" {
		t.Fatalf("FriendsOf(bob) = %v, want [alice]", gotBob)
	}
}
