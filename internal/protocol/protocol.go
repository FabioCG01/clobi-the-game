// Package protocol defines the shared data contracts between the Go server and
// the vanilla-JS browser client of Clobi's Arena.
//
// The realtime PvP gamemodes (Tux Smash / Distro Royale) and their WebSocket
// wire messages have been retired. Two record types remain:
//
//   - Character — the legacy universal 8-bit avatar (kept because legacy data
//     still lives in the database).
//   - Skin — the 3D-era Minecraft-compatible player skin (a 64×64 or legacy
//     64×32 PNG data URL plus its arm model), used by the accounts store, the
//     marketplace and the /api/skin endpoints.
//
// All json tag names are read/written verbatim by the JS client.
package protocol

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"strings"
)

// Character is the universal 8-bit avatar definition. BodyType selects the
// renderer ("tux" penguin or "humanoid" person); the remaining indices reference
// entries in the client's texture catalog (web/assets/tex/manifest.json).
type Character struct {
	Name       string  `json:"name"`
	BodyType   string  `json:"bodyType"`   // "tux" or "humanoid"
	Gender     string  `json:"gender"`     // "male" or "female" (humanoid)
	Fat        float64 `json:"fat"`        // 0..1 build (thin -> fat); visual only
	Body       string  `json:"body"`       // hex — tux body color
	Belly      string  `json:"belly"`      // hex — tux belly / humanoid shirt
	Feet       string  `json:"feet"`       // hex — feet / shoes color
	Skin       string  `json:"skin"`       // hex — humanoid skin
	HairColor  string  `json:"hairColor"`  // hex — humanoid hair
	BeardColor string  `json:"beardColor"` // hex — humanoid beard
	Pants      string  `json:"pants"`      // hex — humanoid pants
	CapeColor  string  `json:"capeColor"`  // hex — cape tint
	IrisColor  string  `json:"irisColor"`  // hex — eye iris colour
	MouthColor string  `json:"mouthColor"` // hex — mouth colour ("" = auto: darker skin)
	Hair       int     `json:"hair"`       // hairstyle index (humanoid)
	Beard      int     `json:"beard"`      // beard index (0 = none)
	ShirtStyle int     `json:"shirtStyle"` // shirt style index (humanoid)
	PantsStyle int     `json:"pantsStyle"` // pants style index (humanoid)
	ShoeStyle  int     `json:"shoeStyle"`  // shoe style index (humanoid)
	Hat        int     `json:"hat"`
	Eyes       int     `json:"eyes"`
	Eyebrows   int     `json:"eyebrows"` // eyebrow style index (humanoid)
	Mouth      int     `json:"mouth"`    // mouth/expression style index (humanoid)
	Accessory  int     `json:"accessory"`
	Cape       int     `json:"cape"`
	// Tf holds per-object visual transforms (move/resize/rotate) keyed by object
	// name (head/hair/beard/eyes/eyebrows/mouth/accessory/hat). Purely cosmetic.
	Tf map[string]Transform `json:"tf,omitempty"`
	// Tex maps a part-category slot (e.g. "shirt", "hat", "body") to a custom
	// marketplace texture id, letting a character wear user-painted textures.
	Tex map[string]string `json:"tex,omitempty"`
}

// Transform is a per-object visual transform: offset (x,y), scale (s), rotation (r).
type Transform struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	S float64 `json:"s"`
	R float64 `json:"r"`
}

// ---- 3D skins (Minecraft-compatible) ----

// Skin is a complete 3D player skin: a Minecraft-format PNG (64×64 modern or
// 64×32 legacy) carried as a base64 data URL, plus the arm model it was made
// for. RemixOf preserves marketplace lineage (the id of the remixed original).
type Skin struct {
	Name      string `json:"name"`
	Model     string `json:"model"`               // "classic" (4 px arms) | "slim" (3 px arms)
	PNG       string `json:"png"`                 // "data:image/png;base64,…" 64×64 or 64×32
	RemixOf   string `json:"remixOf,omitempty"`   // market item id this skin remixes
	CreatedAt string `json:"createdAt,omitempty"` // RFC3339
}

// MaxSkinPNGBytes is the decoded-PNG size ceiling for an uploaded skin. A full
// 64×64 RGBA skin compresses to a few KiB; 32 KiB leaves generous headroom
// while keeping hostile payloads small.
const MaxSkinPNGBytes = 32 * 1024

// skinDataURLPrefix is the only accepted data-URL header for skin pixels.
const skinDataURLPrefix = "data:image/png;base64,"

// MaxSkinNameRunes is the display-name clip length (mirrors market titles).
const MaxSkinNameRunes = 48

// ValidateSkin checks and NORMALIZES a skin in place. It is the single shared
// validator used by the accounts store, the marketplace and the HTTP layer:
//
//   - Model is trimmed/lowercased and must end up "classic" or "slim"
//     (empty defaults to "classic" — the safe render for any imported PNG).
//   - Name is trimmed and clipped to MaxSkinNameRunes runes.
//   - PNG must be a "data:image/png;base64," URL whose payload decodes to at
//     most MaxSkinPNGBytes bytes of valid PNG measuring exactly 64×64 or 64×32.
//
// A nil error means the skin is safe to store and serve as-is.
func ValidateSkin(s *Skin) error {
	if s == nil {
		return errors.New("skin: missing")
	}
	switch strings.ToLower(strings.TrimSpace(s.Model)) {
	case "", "classic":
		s.Model = "classic"
	case "slim":
		s.Model = "slim"
	default:
		return errors.New("skin: model must be \"classic\" or \"slim\"")
	}
	s.Name = strings.TrimSpace(s.Name)
	if r := []rune(s.Name); len(r) > MaxSkinNameRunes {
		s.Name = string(r[:MaxSkinNameRunes])
	}
	if !strings.HasPrefix(s.PNG, skinDataURLPrefix) {
		return errors.New("skin: png must be a data:image/png;base64 URL")
	}
	b64 := s.PNG[len(skinDataURLPrefix):]
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		// canvas.toDataURL always pads, but tolerate unpadded encoders too.
		if raw, err = base64.RawStdEncoding.DecodeString(b64); err != nil {
			return errors.New("skin: png payload is not valid base64")
		}
	}
	if len(raw) > MaxSkinPNGBytes {
		return fmt.Errorf("skin: png is %d bytes, limit is %d (32 KiB)", len(raw), MaxSkinPNGBytes)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return errors.New("skin: payload is not a decodable PNG")
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w != 64 || (h != 64 && h != 32) {
		return fmt.Errorf("skin: dimensions must be 64x64 or 64x32, got %dx%d", w, h)
	}
	return nil
}
