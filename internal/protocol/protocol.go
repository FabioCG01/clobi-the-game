// Package protocol defines the shared character contract between the Go server
// and the vanilla-JS browser client of Clobi's Arena.
//
// The realtime PvP gamemodes (Tux Smash / Distro Royale) and their WebSocket
// wire messages have been retired; what remains is the universal Character — the
// avatar shared by the editor, the texture paint tool, and the marketplace. Its
// json tag names are read/written verbatim by the JS client.
package protocol

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
