package market

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
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
