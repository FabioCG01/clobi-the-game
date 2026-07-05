package worlds

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"clobi/internal/pgdb"
)

// ---- pure-unit coverage (no database) --------------------------------------

// TestCompactDeltaBlob pins the byte-level compaction rules from contract §2:
// later records for the same index win, output is deduplicated and sorted
// ascending by index, and malformed input (wrong length, out-of-range index)
// is rejected.
func TestCompactDeltaBlob(t *testing.T) {
	rec := func(idx int, id byte) []byte { return []byte{byte(idx), byte(idx >> 8), id} }

	t.Run("empty stays empty", func(t *testing.T) {
		out, err := compactDeltaBlob(nil)
		if err != nil || len(out) != 0 {
			t.Fatalf("compactDeltaBlob(nil) = %v, %v", out, err)
		}
	})

	t.Run("dedups keeping the later record and sorts ascending", func(t *testing.T) {
		// Out of order + duplicate index 5 (id 9 should win over id 1, since it
		// comes later in the byte stream).
		var in []byte
		in = append(in, rec(10, 3)...)
		in = append(in, rec(5, 1)...)
		in = append(in, rec(5, 9)...)
		out, err := compactDeltaBlob(in)
		if err != nil {
			t.Fatalf("compactDeltaBlob: %v", err)
		}
		want := append(append([]byte{}, rec(5, 9)...), rec(10, 3)...)
		if string(out) != string(want) {
			t.Fatalf("compacted = %v, want %v", out, want)
		}
	})

	t.Run("rejects length not a multiple of 3", func(t *testing.T) {
		if _, err := compactDeltaBlob([]byte{1, 2}); !errors.Is(err, ErrBadInput) {
			t.Fatalf("want ErrBadInput, got %v", err)
		}
	})

	t.Run("rejects index out of range", func(t *testing.T) {
		if _, err := compactDeltaBlob(rec(maxBlockIndex, 1)); !errors.Is(err, ErrBadInput) {
			t.Fatalf("want ErrBadInput for index==maxBlockIndex, got %v", err)
		}
		// Max valid index (maxBlockIndex-1) must be accepted.
		if _, err := compactDeltaBlob(rec(maxBlockIndex-1, 1)); err != nil {
			t.Fatalf("max valid index should be accepted: %v", err)
		}
	})
}

func TestSplitChunkKey(t *testing.T) {
	cases := []struct {
		in     string
		cx, cz int
		ok     bool
	}{
		{"0,0", 0, 0, true},
		{"-3,7", -3, 7, true},
		{" 12 , -5 ", 12, -5, true},
		{"bad", 0, 0, false},
		{"1,2,3", 0, 0, false},
		{"a,b", 0, 0, false},
	}
	for _, c := range cases {
		cx, cz, ok := splitChunkKey(c.in)
		if ok != c.ok || (ok && (cx != c.cx || cz != c.cz)) {
			t.Errorf("splitChunkKey(%q) = (%d,%d,%v), want (%d,%d,%v)", c.in, cx, cz, ok, c.cx, c.cz, c.ok)
		}
	}
	if k := chunkKey(-3, 7); k != "-3,7" {
		t.Errorf("chunkKey(-3,7) = %q", k)
	}
}

func TestDeltasWireRoundTrip(t *testing.T) {
	raw := map[string][]byte{
		"0,0": {1, 0, 5},
		"1,2": {},
	}
	wire := DeltasToWire(raw)
	if wire["0,0"] == "" {
		t.Fatal("expected non-empty base64 for non-empty blob")
	}
	if wire["1,2"] != "" {
		t.Fatalf("empty blob should base64-encode to empty string, got %q", wire["1,2"])
	}
	back, err := DeltasFromWire(wire)
	if err != nil {
		t.Fatalf("DeltasFromWire: %v", err)
	}
	if string(back["0,0"]) != string(raw["0,0"]) {
		t.Fatalf("round-trip mismatch: %v vs %v", back["0,0"], raw["0,0"])
	}
	if len(back["1,2"]) != 0 {
		t.Fatalf("round-trip of empty blob should stay empty, got %v", back["1,2"])
	}
	if _, err := DeltasFromWire(map[string]string{"x,y": "@@@not base64@@@"}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("garbage base64 should yield ErrBadInput, got %v", err)
	}
}

// ---- store tests (need live PostgreSQL; skipped without TEST_DATABASE_URL) --

// newDBStore opens a throwaway store against TEST_DATABASE_URL (same pattern
// as internal/accounts and internal/market) and truncates the tables this
// suite owns for isolation. It also registers the fixture accounts every
// store test needs, since worlds/world_members both FK into accounts.
func newDBStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run worlds store tests against PostgreSQL")
	}
	db, err := pgdb.Open(dsn)
	if err != nil {
		t.Fatalf("pgdb.Open: %v", err)
	}
	if _, err := db.Exec(`TRUNCATE worlds, world_members, world_deltas RESTART IDENTITY CASCADE`); err != nil {
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

// registerAccount inserts a minimal accounts row directly (this package does
// not import internal/accounts, so tests fabricate the FK target by hand —
// mirrors how a real account would exist by the time worlds.Store is used).
func registerAccount(t *testing.T, db *sql.DB, username string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO accounts(username, display, hash) VALUES ($1, $1, 'x')
		 ON CONFLICT (username) DO NOTHING`, username)
	if err != nil {
		t.Fatalf("registerAccount(%s): %v", username, err)
	}
}

func TestCreateGetDefaults(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")

	w, err := s.Create("alice", "My World", 12345)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if w.ID == "" || w.Owner != "alice" || w.Name != "My World" || w.Seed != 12345 {
		t.Fatalf("Create result wrong: %+v", w)
	}
	var settings map[string]interface{}
	if err := json.Unmarshal(w.Settings, &settings); err != nil {
		t.Fatalf("settings not valid json: %v", err)
	}
	if cap, _ := settings["cap"].(float64); cap != DefaultCap {
		t.Fatalf("default cap = %v, want %d", settings["cap"], DefaultCap)
	}

	got, ok := s.Get(w.ID)
	if !ok {
		t.Fatal("Get: world should exist")
	}
	if got.ID != w.ID || got.Seed != w.Seed {
		t.Fatalf("Get mismatch: %+v vs %+v", got, w)
	}

	if _, ok := s.Get("wnonexistent"); ok {
		t.Fatal("Get: nonexistent world should not be found")
	}

	// Unknown owner is rejected.
	if _, err := s.Create("nobody", "X", 1); err == nil {
		t.Fatal("Create with unknown owner should fail")
	}

	// Blank/overlong name handling.
	blank, err := s.Create("alice", "   ", 1)
	if err != nil || blank.Name != "World" {
		t.Fatalf("blank name should default to \"World\": %+v (%v)", blank, err)
	}
	long := ""
	for i := 0; i < 50; i++ {
		long += "x"
	}
	clipped, err := s.Create("alice", long, 1)
	if err != nil || len([]rune(clipped.Name)) != MaxNameRunes {
		t.Fatalf("long name should clip to %d runes, got %d (%v)", MaxNameRunes, len([]rune(clipped.Name)), err)
	}
}

func TestRenameOwnershipEnforced(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	w, err := s.Create("alice", "Original", 1)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := s.Rename(w.ID, "alice", "Renamed"); err != nil {
		t.Fatalf("Rename by owner: %v", err)
	}
	got, _ := s.Get(w.ID)
	if got.Name != "Renamed" {
		t.Fatalf("name not updated: %+v", got)
	}

	if err := s.Rename(w.ID, "bob", "Hijacked"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Rename by non-owner should be ErrForbidden, got %v", err)
	}
	if err := s.Rename("wnonexistent", "alice", "X"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Rename of nonexistent world should be ErrNotFound, got %v", err)
	}
	if err := s.Rename(w.ID, "alice", ""); err == nil {
		t.Fatal("Rename to empty name should fail")
	}
}

func TestDeleteOwnershipEnforced(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	w, err := s.Create("alice", "World", 1)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := s.Delete(w.ID, "bob"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("Delete by non-owner should be ErrForbidden, got %v", err)
	}
	if _, ok := s.Get(w.ID); !ok {
		t.Fatal("world should still exist after a forbidden delete attempt")
	}
	if err := s.Delete(w.ID, "alice"); err != nil {
		t.Fatalf("Delete by owner: %v", err)
	}
	if _, ok := s.Get(w.ID); ok {
		t.Fatal("world should be gone after Delete")
	}
	if err := s.Delete(w.ID, "alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete of already-deleted world should be ErrNotFound, got %v", err)
	}
}

func TestMembershipAddRemoveIsMember(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	registerAccount(t, db, "carol")
	w, err := s.Create("alice", "Shared", 1)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Owner is always a member.
	if ok, err := s.IsMember(w.ID, "alice"); err != nil || !ok {
		t.Fatalf("owner should be a member: %v, %v", ok, err)
	}
	if ok, _ := s.IsMember(w.ID, "bob"); ok {
		t.Fatal("bob should not be a member yet")
	}

	if err := s.AddMember(w.ID, "alice", "bob"); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if ok, err := s.IsMember(w.ID, "bob"); err != nil || !ok {
		t.Fatalf("bob should be a member after AddMember: %v, %v", ok, err)
	}

	// Non-owner cannot add members.
	if err := s.AddMember(w.ID, "bob", "carol"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("AddMember by non-owner should be ErrForbidden, got %v", err)
	}

	// Unknown username is rejected.
	if err := s.AddMember(w.ID, "alice", "ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("AddMember of unknown username should be ErrNotFound, got %v", err)
	}

	if err := s.RemoveMember(w.ID, "alice", "bob"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if ok, _ := s.IsMember(w.ID, "bob"); ok {
		t.Fatal("bob should no longer be a member after RemoveMember")
	}

	// Non-owner cannot remove members.
	if err := s.AddMember(w.ID, "alice", "bob"); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := s.RemoveMember(w.ID, "carol", "bob"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("RemoveMember by non-owner should be ErrForbidden, got %v", err)
	}

	if _, err := s.IsMember("wnonexistent", "alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("IsMember of nonexistent world should be ErrNotFound, got %v", err)
	}
}

func TestListForUserOwnedAndMemberOf(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	registerAccount(t, db, "bob")
	registerAccount(t, db, "carol")

	owned, err := s.Create("alice", "Alice's World", 1)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	_, err = s.Create("carol", "Carol's Solo World", 2)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	sharedWorld, err := s.Create("carol", "Carol's Shared World", 3)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.AddMember(sharedWorld.ID, "carol", "alice"); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := s.AddMember(sharedWorld.ID, "carol", "bob"); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	views, err := s.ListForUser("alice")
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if len(views) != 2 {
		t.Fatalf("alice should see 2 worlds (owned + member), got %d: %+v", len(views), views)
	}
	byID := map[string]WorldView{}
	for _, v := range views {
		byID[v.ID] = v
		if v.Live != nil {
			t.Fatalf("Live must be nil (caller-populated), got %v", v.Live)
		}
	}
	if v, ok := byID[owned.ID]; !ok || v.Role != "owner" {
		t.Fatalf("alice should own her own world: %+v", byID[owned.ID])
	}
	if v, ok := byID[sharedWorld.ID]; !ok || v.Role != "member" {
		t.Fatalf("alice should be a member of carol's shared world: %+v", byID[sharedWorld.ID])
	} else if len(v.Members) != 2 {
		t.Fatalf("shared world should list 2 members, got %+v", v.Members)
	}

	// bob only sees the one shared world he was added to.
	bobViews, err := s.ListForUser("bob")
	if err != nil {
		t.Fatalf("ListForUser(bob): %v", err)
	}
	if len(bobViews) != 1 || bobViews[0].ID != sharedWorld.ID {
		t.Fatalf("bob should see exactly the shared world: %+v", bobViews)
	}

	// A user with no worlds gets an empty (non-nil) slice.
	registerAccount(t, db, "dave")
	daveViews, err := s.ListForUser("dave")
	if err != nil {
		t.Fatalf("ListForUser(dave): %v", err)
	}
	if daveViews == nil || len(daveViews) != 0 {
		t.Fatalf("dave should see an empty slice, got %v", daveViews)
	}
}

func TestSaveAndGetDeltasRoundTripAndDelete(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	w, err := s.Create("alice", "World", 1)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	rec := func(idx int, id byte) []byte { return []byte{byte(idx), byte(idx >> 8), id} }
	if err := s.SaveDeltas(w.ID, map[string][]byte{
		"0,0": rec(1, 5),
		"1,1": append(rec(2, 3), rec(1000, 9)...),
	}); err != nil {
		t.Fatalf("SaveDeltas: %v", err)
	}

	deltas, err := s.GetDeltas(w.ID)
	if err != nil {
		t.Fatalf("GetDeltas: %v", err)
	}
	if len(deltas) != 2 {
		t.Fatalf("expected 2 chunk deltas, got %d: %v", len(deltas), deltas)
	}
	if string(deltas["0,0"]) != string(rec(1, 5)) {
		t.Fatalf("chunk 0,0 mismatch: %v", deltas["0,0"])
	}

	// Overwrite 0,0 and delete 1,1 (empty blob = removed, contract §2).
	if err := s.SaveDeltas(w.ID, map[string][]byte{
		"0,0": rec(1, 7),
		"1,1": {},
	}); err != nil {
		t.Fatalf("SaveDeltas (update+delete): %v", err)
	}
	deltas, err = s.GetDeltas(w.ID)
	if err != nil {
		t.Fatalf("GetDeltas: %v", err)
	}
	if len(deltas) != 1 {
		t.Fatalf("chunk 1,1 should have been deleted, remaining: %v", deltas)
	}
	if string(deltas["0,0"]) != string(rec(1, 7)) {
		t.Fatalf("chunk 0,0 should have been overwritten: %v", deltas["0,0"])
	}

	// A malformed blob aborts the whole batch (nothing partially applied).
	badErr := s.SaveDeltas(w.ID, map[string][]byte{
		"5,5": {1, 2}, // not a multiple of 3
	})
	if !errors.Is(badErr, ErrBadInput) {
		t.Fatalf("malformed blob should be ErrBadInput, got %v", badErr)
	}
	deltas, _ = s.GetDeltas(w.ID)
	if _, ok := deltas["5,5"]; ok {
		t.Fatal("malformed chunk must not have been stored")
	}

	// SaveDeltas against an unknown world is ErrNotFound.
	if err := s.SaveDeltas("wnonexistent", map[string][]byte{"0,0": rec(1, 1)}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SaveDeltas on unknown world should be ErrNotFound, got %v", err)
	}

	// Deleting the world cascades its deltas away.
	if err := s.Delete(w.ID, "alice"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM world_deltas WHERE world_id = $1`, w.ID).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("world_deltas should cascade-delete with the world, got %d rows", count)
	}
}

func TestImportCreatesWorldWithDeltas(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")

	rec := func(idx int, id byte) []byte { return []byte{byte(idx), byte(idx >> 8), id} }
	deltas := map[string][]byte{
		"0,0": rec(42, 3),
	}
	w, err := s.Import("alice", "Imported", 999, deltas)
	if err != nil {
		t.Fatalf("Import: %v", err)
	}
	if w.Owner != "alice" || w.Seed != 999 || w.Name != "Imported" {
		t.Fatalf("Import result wrong: %+v", w)
	}
	got, err := s.GetDeltas(w.ID)
	if err != nil {
		t.Fatalf("GetDeltas: %v", err)
	}
	if string(got["0,0"]) != string(rec(42, 3)) {
		t.Fatalf("imported deltas mismatch: %v", got)
	}

	// A bad import rolls back the world it would have created (no orphan).
	if _, err := s.Import("alice", "Bad", 1, map[string][]byte{"0,0": {1, 2}}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("bad import should fail with ErrBadInput, got %v", err)
	}
	views, err := s.ListForUser("alice")
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	for _, v := range views {
		if v.Name == "Bad" {
			t.Fatal("a failed import must not leave an orphan world behind")
		}
	}

	// Import with no deltas at all just creates an empty world.
	empty, err := s.Import("alice", "Empty", 5, nil)
	if err != nil {
		t.Fatalf("Import with nil deltas: %v", err)
	}
	emptyDeltas, err := s.GetDeltas(empty.ID)
	if err != nil || len(emptyDeltas) != 0 {
		t.Fatalf("empty import should have no deltas: %v (%v)", emptyDeltas, err)
	}
}

func TestUpdateSettings(t *testing.T) {
	s, db := newDBStore(t)
	registerAccount(t, db, "alice")
	w, err := s.Create("alice", "World", 1)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.UpdateSettings(w.ID, json.RawMessage(`{"cap":4,"time":6000}`)); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	got, _ := s.Get(w.ID)
	var settings map[string]interface{}
	if err := json.Unmarshal(got.Settings, &settings); err != nil {
		t.Fatalf("settings not valid json: %v", err)
	}
	if cap, _ := settings["cap"].(float64); cap != 4 {
		t.Fatalf("cap not updated: %v", settings)
	}
	if err := s.UpdateSettings("wnonexistent", json.RawMessage(`{}`)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UpdateSettings on unknown world should be ErrNotFound, got %v", err)
	}
}
