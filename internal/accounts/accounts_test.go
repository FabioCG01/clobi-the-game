package accounts

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"os"
	"testing"

	"clobi/internal/pgdb"
	"clobi/internal/protocol"
)

// These tests need a throwaway PostgreSQL database. Point TEST_DATABASE_URL at
// one (e.g. postgres://clobi:pw@127.0.0.1:5432/clobi_test?sslmode=disable);
// without it the suite is skipped so `go test` stays green on machines with no
// database. Each test truncates the tables first for isolation.
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run accounts tests against PostgreSQL")
	}
	return dsn
}

func openClean(t *testing.T) *sql.DB {
	t.Helper()
	db, err := pgdb.Open(testDSN(t))
	if err != nil {
		t.Fatalf("pgdb.Open: %v", err)
	}
	// Only the tables this suite touches: the market suite owns market_items and
	// may be running in parallel (go test runs packages concurrently) against
	// the same TEST_DATABASE_URL.
	if _, err := db.Exec(`TRUNCATE accounts, settings RESTART IDENTITY CASCADE`); err != nil {
		_ = db.Close()
		t.Fatalf("truncate: %v", err)
	}
	return db
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	db := openClean(t)
	s, err := NewStore(db, "admin")
	if err != nil {
		_ = db.Close()
		t.Fatalf("NewStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// TestSessionsSurviveRestart is the regression test for the "admin set default
// silently fails after a redeploy" bug: a token minted before a restart must
// still resolve after the store (pool) is reopened against the same database.
func TestSessionsSurviveRestart(t *testing.T) {
	dsn := testDSN(t)
	db := openClean(t)
	s, err := NewStore(db, "admin")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	token, _, err := s.Register("alice", "secret")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, ok := s.VerifyToken(token); !ok {
		t.Fatal("token should verify before restart")
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen — simulates a server restart / redeploy against the same DB.
	db2, err := pgdb.Open(dsn)
	if err != nil {
		t.Fatalf("reopen pgdb.Open: %v", err)
	}
	s2, err := NewStore(db2, "admin")
	if err != nil {
		t.Fatalf("reopen NewStore: %v", err)
	}
	defer s2.Close()
	uname, ok := s2.VerifyToken(token)
	if !ok {
		t.Fatal("token must STILL verify after restart (persisted sessions)")
	}
	if uname != "alice" {
		t.Fatalf("token resolved to %q, want alice", uname)
	}
}

func TestDeleteAccountRevokesPersistedSessions(t *testing.T) {
	s := newTestStore(t)
	token, _, err := s.Register("bob", "secret")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := s.DeleteAccount("bob"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if _, ok := s.VerifyToken(token); ok {
		t.Fatal("token must not verify after the account is deleted")
	}
}

func TestLibrarySaveDeletePresets(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.Register("carol", "secret"); err != nil {
		t.Fatalf("Register: %v", err)
	}

	if err := s.SaveTexture("carol", "tex_1", json.RawMessage(`{"id":"tex_1","slot":"hat"}`)); err != nil {
		t.Fatalf("SaveTexture: %v", err)
	}
	if err := s.SetPresets("carol", json.RawMessage(`[{"name":"A"}]`)); err != nil {
		t.Fatalf("SetPresets: %v", err)
	}
	tex, pre, ok := s.GetLibrary("carol")
	if !ok || len(tex) != 1 || tex["tex_1"] == nil {
		t.Fatalf("GetLibrary textures = %v", tex)
	}
	var got []map[string]string
	if err := json.Unmarshal(pre, &got); err != nil || len(got) != 1 || got[0]["name"] != "A" {
		t.Fatalf("presets = %s (%v)", pre, err)
	}

	if err := s.DeleteTexture("carol", "tex_1"); err != nil {
		t.Fatalf("DeleteTexture: %v", err)
	}
	tex, _, _ = s.GetLibrary("carol")
	if len(tex) != 0 {
		t.Fatalf("texture should be gone, got %v", tex)
	}

	if err := s.SaveTexture("carol", "", json.RawMessage(`{}`)); err == nil {
		t.Fatal("SaveTexture with empty id should error")
	}
}

// TestMergeLibraryPreservesExisting checks migrate-on-signup semantics.
func TestMergeLibraryPreservesExisting(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.Register("dave", "secret"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	_ = s.SaveTexture("dave", "keep", json.RawMessage(`{"v":"account"}`))
	_ = s.SetPresets("dave", json.RawMessage(`[{"name":"acct"}]`))

	inTex := map[string]json.RawMessage{
		"keep":  json.RawMessage(`{"v":"guest-should-not-win"}`),
		"fresh": json.RawMessage(`{"v":"guest"}`),
	}
	tex, pre, err := s.MergeLibrary("dave", inTex, json.RawMessage(`[{"name":"guest"}]`))
	if err != nil {
		t.Fatalf("MergeLibrary: %v", err)
	}
	if string(tex["keep"]) != `{"v": "account"}` && string(tex["keep"]) != `{"v":"account"}` {
		t.Fatalf("existing texture was clobbered: %s", tex["keep"])
	}
	if tex["fresh"] == nil {
		t.Fatal("guest texture was not added")
	}
	var presets []map[string]string
	if err := json.Unmarshal(pre, &presets); err != nil {
		t.Fatalf("presets json: %v", err)
	}
	if len(presets) != 2 || presets[0]["name"] != "acct" || presets[1]["name"] != "guest" {
		t.Fatalf("presets not appended in order: %s", pre)
	}
}

func TestExportIncludesLibrary(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.Register("erin", "secret"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	_ = s.SaveTexture("erin", "t", json.RawMessage(`{"id":"t"}`))
	_ = s.SetPresets("erin", json.RawMessage(`[{"name":"P"}]`))
	out, ok := s.ExportAccount("erin")
	if !ok {
		t.Fatal("ExportAccount not found")
	}
	if _, has := out["textures"]; !has {
		t.Fatal("export missing textures")
	}
	if _, has := out["presets"]; !has {
		t.Fatal("export missing presets")
	}
}

func TestDefaultCharacterRoundTrip(t *testing.T) {
	s := newTestStore(t)
	c := protocol.Character{BodyType: "humanoid", Gender: "male", Skin: "#abcdef", Hair: 7}
	if err := s.SetDefaultCharacter(c); err != nil {
		t.Fatalf("SetDefaultCharacter: %v", err)
	}
	got := s.DefaultCharacter("male", "newbie")
	if got.Skin != "#abcdef" || got.Hair != 7 {
		t.Fatalf("default not stored: %+v", got)
	}
	if got.Name != "newbie" {
		t.Fatalf("name not applied: %q", got.Name)
	}
}

// skinDataURL builds a tiny in-memory PNG of the given size as a base64 data
// URL — the exact shape the JS client produces with canvas.toDataURL().
func skinDataURL(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

// TestSkinRoundTrip covers the 3D-era per-account skin: absent by default,
// saved with validation + model normalization, and read back verbatim.
func TestSkinRoundTrip(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.Register("gina", "secret"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, ok := s.GetSkin("gina"); ok {
		t.Fatal("a brand-new account must not have a skin yet")
	}
	sk := protocol.Skin{
		Name: "My First Skin", Model: "SLIM", PNG: skinDataURL(t, 64, 64),
		RemixOf: "m123", CreatedAt: "2026-01-01T00:00:00Z",
	}
	if err := s.SetSkin("gina", sk); err != nil {
		t.Fatalf("SetSkin: %v", err)
	}
	got, ok := s.GetSkin("gina")
	if !ok {
		t.Fatal("GetSkin: skin should exist after SetSkin")
	}
	if got.Model != "slim" {
		t.Fatalf("model not normalized: %q", got.Model)
	}
	if got.PNG != sk.PNG || got.Name != "My First Skin" || got.RemixOf != "m123" {
		t.Fatalf("skin round-trip mismatch: %+v", got)
	}
	// Legacy 64×32 sheets are accepted too.
	if err := s.SetSkin("gina", protocol.Skin{Model: "classic", PNG: skinDataURL(t, 64, 32)}); err != nil {
		t.Fatalf("SetSkin 64x32: %v", err)
	}
	// Invalid input is refused with ErrBadInput and does not clobber the skin.
	if err := s.SetSkin("gina", protocol.Skin{Model: "classic", PNG: skinDataURL(t, 32, 32)}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("bad dimensions should yield ErrBadInput, got %v", err)
	}
	if got, ok := s.GetSkin("gina"); !ok || got.PNG == "" {
		t.Fatal("failed SetSkin must not clobber the stored skin")
	}
	// Unknown users cannot be given a skin.
	if err := s.SetSkin("nobody", sk); !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("unknown user should yield ErrUnknownUser, got %v", err)
	}
}

// TestDefaultSkinRoundTrip covers the admin default skin under settings key
// "defaultSkin" and checks it never interferes with the Character defaults
// stored in the same settings table.
func TestDefaultSkinRoundTrip(t *testing.T) {
	s := newTestStore(t)
	if _, ok := s.GetDefaultSkin(); ok {
		t.Fatal("clean database must have no default skin")
	}
	sk := protocol.Skin{Name: "Clobi", Model: "classic", PNG: skinDataURL(t, 64, 64)}
	if err := s.SetDefaultSkin(sk); err != nil {
		t.Fatalf("SetDefaultSkin: %v", err)
	}
	got, ok := s.GetDefaultSkin()
	if !ok || got.Name != "Clobi" || got.Model != "classic" || got.PNG != sk.PNG {
		t.Fatalf("default skin round-trip mismatch: %+v", got)
	}
	// Invalid default skins are rejected.
	if err := s.SetDefaultSkin(protocol.Skin{Model: "chunky", PNG: sk.PNG}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("bad model should yield ErrBadInput, got %v", err)
	}
	// The Character defaults live in the same settings table under other keys
	// and must be completely unaffected by the skin helpers.
	c := protocol.Character{BodyType: "humanoid", Gender: "male", Skin: "#aabbcc"}
	if err := s.SetDefaultCharacter(c); err != nil {
		t.Fatalf("SetDefaultCharacter: %v", err)
	}
	if got := s.DefaultCharacter("male", "x"); got.Skin != "#aabbcc" {
		t.Fatalf("character default broken by skin helpers: %+v", got)
	}
	if got, ok := s.GetDefaultSkin(); !ok || got.Name != "Clobi" {
		t.Fatalf("default skin lost after setting a character default: %+v", got)
	}
}

// TestGlobalDefaultDrivesNewUsers verifies the new global default: it is exposed
// under AllDefaults["global"], also writes the matching slot, and is the look a
// brand-new registration inherits.
func TestGlobalDefaultDrivesNewUsers(t *testing.T) {
	s := newTestStore(t)
	g := protocol.Character{BodyType: "humanoid", Gender: "male", Skin: "#123456", Hair: 4, Beard: 2}
	if err := s.SetGlobalDefault(g); err != nil {
		t.Fatalf("SetGlobalDefault: %v", err)
	}
	all := s.AllDefaults("")
	gd, ok := all["global"]
	if !ok || gd.Skin != "#123456" {
		t.Fatalf("AllDefaults missing/incorrect global: %+v", all["global"])
	}
	// It also became the male slot default.
	if md := s.DefaultCharacter("male", ""); md.Skin != "#123456" || md.Hair != 4 {
		t.Fatalf("global default did not set male slot: %+v", md)
	}
	// A brand-new registration inherits the global default look.
	_, ch, err := s.Register("frank", "secret")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if ch.Skin != "#123456" || ch.Hair != 4 || ch.Beard != 2 {
		t.Fatalf("new user did not inherit global default: %+v", ch)
	}
	if ch.Name != "frank" {
		t.Fatalf("name not applied to new user: %q", ch.Name)
	}
}
