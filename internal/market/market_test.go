package market

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"

	"clobi/internal/pgdb"
	"clobi/internal/protocol"
)

// packMask builds a packed-PNG data URL whose alpha mask matches `paint(x,y)`.
func packMask(w, h int, paint func(x, y int) bool) string {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(0)
			if paint(x, y) {
				a = 255
			}
			img.Set(x, y, color.RGBA{200, 0, 0, a})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestRatingSnapAndAvg(t *testing.T) {
	it := Item{Ratings: map[string]float64{}}
	// snap 3.3 -> 3.5, clamp 9 -> 5, clamp .1 -> .5
	for u, in := range map[string]float64{"a": 3.3, "b": 9, "c": 0.1} {
		it.Ratings[u] = snap(in)
	}
	if it.Ratings["a"] != 3.5 || it.Ratings["b"] != 5 || it.Ratings["c"] != 0.5 {
		t.Fatalf("snap wrong: %+v", it.Ratings)
	}
	if avg(it) != (3.5+5+0.5)/3 {
		t.Fatalf("avg wrong: %v", avg(it))
	}
}

// snap mirrors the half-star snapping used in Rate (kept local to the test).
func snap(stars float64) float64 {
	stars = float64(int(stars*2+0.5)) / 2
	if stars < 0.5 {
		stars = 0.5
	}
	if stars > 5 {
		stars = 5
	}
	return stars
}

func TestCensorThresholdAndAutoClear(t *testing.T) {
	it := &Item{Reports: map[string]string{}, Vouches: map[string]bool{}}
	for i := 0; i < 4; i++ {
		it.Reports[string(rune('a'+i))] = "x"
	}
	if censored(*it) {
		t.Fatal("4 reports should NOT censor")
	}
	it.Reports["e"] = "x" // 5 reports
	if !censored(*it) {
		t.Fatal("5 net reports should censor")
	}
	// vouches reduce the score back below threshold
	it.Vouches["v1"] = true
	if censored(*it) {
		t.Fatal("5 reports - 1 vouch = 4, should not censor")
	}
	// push vouches so net <= -5 and autoClear wipes the dispute
	for i := 0; i < 11; i++ {
		it.Vouches[string(rune('A'+i))] = true // 12 vouches total vs 5 reports => net -7
	}
	autoClear(it)
	if len(it.Reports) != 0 || len(it.Vouches) != 0 {
		t.Fatalf("autoClear should wipe dispute, got reports=%d vouches=%d", len(it.Reports), len(it.Vouches))
	}
}

func TestNSFWWordlist(t *testing.T) {
	if !looksNSFW(Item{Kind: "texture", Title: "cool PENIS hat", PNG: "data:image/png;base64,AAAA"}) {
		t.Fatal("wordlist should flag")
	}
	if looksNSFW(Item{Kind: "texture", Title: "minty stripes", Tags: []string{"cute"}, PNG: "x"}) {
		t.Fatal("clean title should not flag")
	}
}

func TestNSFWShape(t *testing.T) {
	w, h := 64, 72
	// phallic: a tall narrow central shaft (top ~10% to ~75%) + a wide base near bottom.
	bad := packMask(w, h, func(x, y int) bool {
		shaft := x >= 28 && x <= 36 && y >= 8 && y <= 54
		base := y >= 54 && y <= 64 && x >= 16 && x <= 48
		return shaft || base
	})
	if !phallicShapeFromPNG(bad) {
		t.Fatal("phallic silhouette should be flagged")
	}
	// benign: a wide rectangle (a shirt) — not tall+narrow.
	good := packMask(w, h, func(x, y int) bool { return x >= 8 && x <= 56 && y >= 30 && y <= 60 })
	if phallicShapeFromPNG(good) {
		t.Fatal("wide shirt should NOT be flagged")
	}
	// benign: a small dot.
	dot := packMask(w, h, func(x, y int) bool { return x >= 30 && x <= 34 && y >= 30 && y <= 34 })
	if phallicShapeFromPNG(dot) {
		t.Fatal("small dot should NOT be flagged")
	}
}

// phallicShapeFromPNG is a tiny test helper bridging the data URL to the heuristic.
func phallicShapeFromPNG(dataURL string) bool {
	mask, w, h, ok := decodeAlpha(dataURL)
	if !ok {
		return false
	}
	return phallicShape(mask, w, h)
}

func TestDecodeAlphaRejectsGarbage(t *testing.T) {
	if _, _, _, ok := decodeAlpha("not a data url"); ok {
		t.Fatal("garbage should be rejected")
	}
	if _, _, _, ok := decodeAlpha("data:image/png;base64,@@@@"); ok {
		t.Fatal("bad base64 should be rejected")
	}
	_ = strings.TrimSpace("") // keep strings import if refactored
}

// ---- 3D skins ------------------------------------------------------------

// skinPNG builds a valid, fully opaque PNG of the given size as a data URL
// (the shape canvas.toDataURL() produces).
func skinPNG(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 4), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

// TestValidateSkin is the pure-unit coverage of the shared skin validator
// (protocol.ValidateSkin) the marketplace publish path relies on.
func TestValidateSkin(t *testing.T) {
	valid64 := skinPNG(t, 64, 64)

	// Happy path: 64×64 classic.
	sk := protocol.Skin{Name: "ok", Model: "classic", PNG: valid64}
	if err := protocol.ValidateSkin(&sk); err != nil {
		t.Fatalf("valid 64x64 skin rejected: %v", err)
	}
	// Legacy 64×32 accepted; empty model defaults to classic.
	sk = protocol.Skin{PNG: skinPNG(t, 64, 32)}
	if err := protocol.ValidateSkin(&sk); err != nil {
		t.Fatalf("valid 64x32 skin rejected: %v", err)
	}
	if sk.Model != "classic" {
		t.Fatalf("empty model should default to classic, got %q", sk.Model)
	}
	// Model is trimmed + lowercased.
	sk = protocol.Skin{Model: "  SLIM ", PNG: valid64}
	if err := protocol.ValidateSkin(&sk); err != nil || sk.Model != "slim" {
		t.Fatalf("model not normalized: %q (%v)", sk.Model, err)
	}
	// Name is clipped to 48 runes.
	sk = protocol.Skin{Name: strings.Repeat("ä", 60), Model: "classic", PNG: valid64}
	if err := protocol.ValidateSkin(&sk); err != nil {
		t.Fatalf("long-named skin rejected: %v", err)
	}
	if n := len([]rune(sk.Name)); n != 48 {
		t.Fatalf("name should clip to 48 runes, got %d", n)
	}

	// Rejections.
	bad := []struct {
		name string
		skin protocol.Skin
	}{
		{"nil png", protocol.Skin{Model: "classic"}},
		{"bad model", protocol.Skin{Model: "chunky", PNG: valid64}},
		{"not a data url", protocol.Skin{Model: "classic", PNG: "hello.png"}},
		{"wrong mime", protocol.Skin{Model: "classic", PNG: "data:image/jpeg;base64,AAAA"}},
		{"bad base64", protocol.Skin{Model: "classic", PNG: "data:image/png;base64,@@@@"}},
		{"not png bytes", protocol.Skin{Model: "classic", PNG: "data:image/png;base64," +
			base64.StdEncoding.EncodeToString([]byte("this is not a png"))}},
		{"too small", protocol.Skin{Model: "classic", PNG: skinPNG(t, 32, 32)}},
		{"wrong height", protocol.Skin{Model: "classic", PNG: skinPNG(t, 64, 48)}},
		{"too big dims", protocol.Skin{Model: "classic", PNG: skinPNG(t, 128, 128)}},
	}
	for _, c := range bad {
		if err := protocol.ValidateSkin(&c.skin); err == nil {
			t.Errorf("%s: should be rejected", c.name)
		}
	}
	if err := protocol.ValidateSkin(nil); err == nil {
		t.Error("nil skin should be rejected")
	}
}

// TestValidateSkinSizeLimit checks the 32 KiB decoded-payload ceiling (the size
// gate fires before the PNG decoder ever sees the bytes).
func TestValidateSkinSizeLimit(t *testing.T) {
	huge := make([]byte, protocol.MaxSkinPNGBytes+1)
	sk := protocol.Skin{Model: "classic", PNG: "data:image/png;base64," +
		base64.StdEncoding.EncodeToString(huge)}
	if err := protocol.ValidateSkin(&sk); err == nil {
		t.Fatal("payload over 32 KiB should be rejected")
	}
}

// TestNSFWSkipsShapeForSkins pins the moderation rule: the silhouette heuristic
// runs for legacy textures only, never for skins (their base layer is opaque so
// shape says nothing), while the wordlist still applies to skin titles/tags.
func TestNSFWSkipsShapeForSkins(t *testing.T) {
	w, h := 64, 72
	shape := packMask(w, h, func(x, y int) bool {
		shaft := x >= 28 && x <= 36 && y >= 8 && y <= 54
		base := y >= 54 && y <= 64 && x >= 16 && x <= 48
		return shaft || base
	})
	if !looksNSFW(Item{Kind: "texture", Title: "innocent", PNG: shape}) {
		t.Fatal("legacy texture with a phallic silhouette should still flag")
	}
	if looksNSFW(Item{Kind: "skin", Title: "innocent", PNG: shape}) {
		t.Fatal("the shape heuristic must never run for kind=skin")
	}
	if !looksNSFW(Item{Kind: "skin", Title: "porn skin", PNG: skinPNG(t, 64, 64)}) {
		t.Fatal("the wordlist must still apply to skins")
	}
}

// ---- store tests (need live PostgreSQL; skipped without TEST_DATABASE_URL) --

// newDBStore opens a throwaway store against TEST_DATABASE_URL (same pattern as
// the accounts suite) and truncates market_items for isolation.
func newDBStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run market store tests against PostgreSQL")
	}
	db, err := pgdb.Open(dsn)
	if err != nil {
		t.Fatalf("pgdb.Open: %v", err)
	}
	if _, err := db.Exec(`TRUNCATE market_items`); err != nil {
		_ = db.Close()
		t.Fatalf("truncate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	s, err := NewStore(db)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

// TestPublishSkinOnly verifies the 3D-era publish rules: skins in, everything
// else out with ErrBadInput.
func TestPublishSkinOnly(t *testing.T) {
	s := newDBStore(t)
	png64 := skinPNG(t, 64, 64)

	// Every legacy/unknown kind is refused.
	for _, kind := range []string{"texture", "character", "gadget"} {
		if _, err := s.Publish("alice", Item{Kind: kind, Title: "t", PNG: png64}); !errors.Is(err, ErrBadInput) {
			t.Fatalf("kind %q must be rejected with ErrBadInput, got %v", kind, err)
		}
	}
	// Skins publish; model is normalized; empty kind defaults to skin.
	it, err := s.Publish("alice", Item{Kind: "skin", Title: "Classic One", Model: "classic", PNG: png64})
	if err != nil {
		t.Fatalf("Publish skin: %v", err)
	}
	if it.Kind != "skin" || it.Model != "classic" || it.ID == "" {
		t.Fatalf("published item wrong: %+v", it)
	}
	it2, err := s.Publish("alice", Item{Title: "Slim One", Model: "SLIM", PNG: png64, RemixOf: it.ID})
	if err != nil {
		t.Fatalf("Publish slim (empty kind): %v", err)
	}
	if it2.Model != "slim" || it2.RemixOf != it.ID {
		t.Fatalf("slim publish wrong: %+v", it2)
	}
	// Invalid pixels are refused.
	if _, err := s.Publish("alice", Item{Kind: "skin", Title: "bad", Model: "classic",
		PNG: "data:image/png;base64,AAAA"}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("bad PNG must be rejected with ErrBadInput, got %v", err)
	}
}

// TestListSkinsOnlyAndModelFilter verifies that List hides legacy rows still in
// the database, exposes the model field, and honours the model filter.
func TestListSkinsOnlyAndModelFilter(t *testing.T) {
	s := newDBStore(t)
	png64 := skinPNG(t, 64, 64)

	if _, err := s.Publish("alice", Item{Kind: "skin", Title: "Classic One", Model: "classic", PNG: png64}); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if _, err := s.Publish("bob", Item{Kind: "skin", Title: "Slim One", Model: "slim", PNG: png64}); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	// Plant a legacy 2D row directly — it must stay invisible.
	legacy := Item{
		ID: "legacy1", Kind: "texture", Slot: "hat", Title: "old hat", Author: "carol",
		CreatedAt: now(), CreatedTS: nowTS(), PNG: png64,
		Ratings: map[string]float64{}, Comments: []Comment{},
		Reports: map[string]string{}, Vouches: map[string]bool{},
	}
	if err := put(s.db, legacy); err != nil {
		t.Fatalf("plant legacy row: %v", err)
	}

	views := s.List(ListOpts{}, "", false)
	if len(views) != 2 {
		t.Fatalf("List should hide the legacy row: got %d items", len(views))
	}
	for _, v := range views {
		if v["kind"] != "skin" {
			t.Fatalf("non-skin leaked into List: %v", v["kind"])
		}
		if m, _ := v["model"].(string); m != "classic" && m != "slim" {
			t.Fatalf("view must expose model, got %v", v["model"])
		}
	}
	// Model filter.
	slim := s.List(ListOpts{Model: "slim"}, "", false)
	if len(slim) != 1 || slim[0]["title"] != "Slim One" {
		t.Fatalf("model=slim filter wrong: %+v", slim)
	}
	if got := s.List(ListOpts{Model: "classic"}, "", false); len(got) != 1 || got[0]["title"] != "Classic One" {
		t.Fatalf("model=classic filter wrong: %+v", got)
	}
	// Asking for a legacy kind lists nothing, even for admins.
	if got := s.List(ListOpts{Kind: "texture"}, "carol", true); len(got) != 0 {
		t.Fatalf("legacy kind filter should list nothing, got %d", len(got))
	}
	// kind=skin passthrough behaves like no filter.
	if got := s.List(ListOpts{Kind: "skin"}, "", false); len(got) != 2 {
		t.Fatalf("kind=skin should list both skins, got %d", len(got))
	}
}
