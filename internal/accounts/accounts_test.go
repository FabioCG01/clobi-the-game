package accounts

import (
	"encoding/json"
	"testing"

	"clobi/internal/protocol"
)

// newTestStore opens a Store on a throwaway temp dir.
func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := NewStore(dir, "admin")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, dir
}

// TestSessionsSurviveRestart is the regression test for the "admin set default
// silently fails after a redeploy" bug: a token minted before a restart must
// still resolve after the store is reopened on the same data dir.
func TestSessionsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir, "admin")
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

	// Reopen on the same dir — simulates a server restart / redeploy.
	s2, err := NewStore(dir, "admin")
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

// TestDeleteAccountRevokesPersistedSessions ensures erasing an account also
// drops its durable tokens.
func TestDeleteAccountRevokesPersistedSessions(t *testing.T) {
	s, _ := newTestStore(t)
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
	s, _ := newTestStore(t)
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
	if string(pre) != `[{"name":"A"}]` {
		t.Fatalf("presets = %s", pre)
	}

	if err := s.DeleteTexture("carol", "tex_1"); err != nil {
		t.Fatalf("DeleteTexture: %v", err)
	}
	tex, _, _ = s.GetLibrary("carol")
	if len(tex) != 0 {
		t.Fatalf("texture should be gone, got %v", tex)
	}

	// Empty id / record is rejected.
	if err := s.SaveTexture("carol", "", json.RawMessage(`{}`)); err == nil {
		t.Fatal("SaveTexture with empty id should error")
	}
}

// TestMergeLibraryPreservesExisting checks the migrate-on-signup semantics:
// incoming guest work is added without clobbering existing account work, and
// presets are appended (never replaced).
func TestMergeLibraryPreservesExisting(t *testing.T) {
	s, _ := newTestStore(t)
	if _, _, err := s.Register("dave", "secret"); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// Existing account work.
	_ = s.SaveTexture("dave", "keep", json.RawMessage(`{"v":"account"}`))
	_ = s.SetPresets("dave", json.RawMessage(`[{"name":"acct"}]`))

	// Guest brings: a NEW texture, a COLLIDING id (must not overwrite), a preset.
	inTex := map[string]json.RawMessage{
		"keep":  json.RawMessage(`{"v":"guest-should-not-win"}`),
		"fresh": json.RawMessage(`{"v":"guest"}`),
	}
	tex, pre, err := s.MergeLibrary("dave", inTex, json.RawMessage(`[{"name":"guest"}]`))
	if err != nil {
		t.Fatalf("MergeLibrary: %v", err)
	}
	if string(tex["keep"]) != `{"v":"account"}` {
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

// TestExportIncludesLibrary verifies the GDPR export carries textures + presets.
func TestExportIncludesLibrary(t *testing.T) {
	s, _ := newTestStore(t)
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

// TestDefaultCharacterRoundTrip is a light guard on the admin per-slot default.
func TestDefaultCharacterRoundTrip(t *testing.T) {
	s, _ := newTestStore(t)
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
	// A brand-new registration should inherit the male default.
	_, ch, err := s.Register("frank", "secret")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if ch.Skin != "#abcdef" || ch.Hair != 7 {
		t.Fatalf("new user did not inherit admin default: %+v", ch)
	}
}
