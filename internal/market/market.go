// Package market is the open-source cosmetic marketplace store for Clobi's Arena.
//
// Everything published is ALWAYS FREE. Users publish either a painted texture or
// a whole character (with the custom textures it wears bundled in, so it renders
// for everyone). Items can be rated (half-stars), commented on (with threaded
// replies), reported, and "false-report" vouched. A Reddit-style net score drives
// soft moderation: at +5 net reports an item is auto-censored (its pixels are
// withheld from everyone but its author and admins) until an admin bans it or
// revokes the reports; at -5 net the community-cleared reports reset automatically.
//
// Storage is one bbolt bucket shared with the account store (single DB file).
package market

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image/png"
	"sort"
	"strings"
	"time"

	"clobi/internal/protocol"

	bolt "go.etcd.io/bbolt"
)

// CensorThreshold is the net (reports - vouches) score at which an item is
// auto-censored; the negative of it auto-clears community reports.
const CensorThreshold = 5

var (
	ErrNotFound  = errors.New("item not found")
	ErrForbidden = errors.New("not allowed")
	ErrBadInput  = errors.New("invalid item")
	ErrCensored  = errors.New("item is censored")
)

var bItems = []byte("market_items")

// TextureLite is a custom texture bundled with a published character so the
// character renders for others. Mirrors the client's local texture record.
type TextureLite struct {
	Slot      string `json:"slot"`
	GlowColor string `json:"glowColor"`
	TintHint  string `json:"tintHint"`
	PNG       string `json:"png"` // packed RGBA data URL (R=value,G=glow,A=alpha)
}

// Comment is one comment or reply (ParentID != "" means it replies to a comment).
type Comment struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Text      string `json:"text"`
	ParentID  string `json:"parentId"`
	CreatedAt string `json:"createdAt"`
	CreatedTS int64  `json:"createdTs"`
}

// Item is a published marketplace entry (texture or character).
type Item struct {
	ID        string                 `json:"id"`
	Kind      string                 `json:"kind"`  // "texture" | "character"
	Slot      string                 `json:"slot"`  // texture slot
	Title     string                 `json:"title"`
	Tags      []string               `json:"tags"`
	Author    string                 `json:"author"`
	CreatedAt string                 `json:"createdAt"`
	CreatedTS int64                  `json:"createdTs"`
	GlowColor string                 `json:"glowColor,omitempty"`
	TintHint  string                 `json:"tintHint,omitempty"`
	PNG       string                 `json:"png,omitempty"`       // texture pixels
	Character *protocol.Character    `json:"character,omitempty"` // kind=character
	Bundle    map[string]TextureLite `json:"bundle,omitempty"`    // texId -> texture (for characters)
	RemixOf   string                 `json:"remixOf,omitempty"`
	Downloads int                    `json:"downloads"`
	Ratings   map[string]float64     `json:"ratings"` // user -> 0.5..5
	Comments  []Comment              `json:"comments"`
	Reports   map[string]string      `json:"reports"` // user -> reason
	Vouches   map[string]bool        `json:"vouches"` // user -> true (false-report vote)
	Banned    bool                   `json:"banned"`  // admin permanent takedown
	Flagged   bool                   `json:"flagged"` // auto NSFW heuristic flag
}

// Store is the marketplace persistence layer (bbolt).
type Store struct{ db *bolt.DB }

// NewStore creates the marketplace bucket in the shared bbolt database.
func NewStore(db *bolt.DB) (*Store, error) {
	if err := db.Update(func(tx *bolt.Tx) error {
		_, e := tx.CreateBucketIfNotExists(bItems)
		return e
	}); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }
func nowTS() int64 { return time.Now().UTC().Unix() }

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "m" + hex.EncodeToString([]byte(time.Now().Format("150405.000000")))
	}
	return "m" + hex.EncodeToString(b)
}

func (s *Store) get(tx *bolt.Tx, id string) (Item, bool) {
	v := tx.Bucket(bItems).Get([]byte(id))
	if v == nil {
		return Item{}, false
	}
	var it Item
	if json.Unmarshal(v, &it) != nil {
		return Item{}, false
	}
	return it, true
}

func (s *Store) put(tx *bolt.Tx, it Item) error {
	data, err := json.Marshal(it)
	if err != nil {
		return err
	}
	return tx.Bucket(bItems).Put([]byte(it.ID), data)
}

// ---- publish ------------------------------------------------------------

// Publish stores a new item authored by `author`. It assigns id/timestamps,
// initialises the moderation maps, and runs the best-effort NSFW heuristic.
func (s *Store) Publish(author string, in Item) (Item, error) {
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	if in.Kind != "texture" && in.Kind != "character" {
		return Item{}, ErrBadInput
	}
	if in.Kind == "texture" && strings.TrimSpace(in.PNG) == "" {
		return Item{}, ErrBadInput
	}
	if in.Kind == "character" && in.Character == nil {
		return Item{}, ErrBadInput
	}
	it := Item{
		ID: newID(), Kind: in.Kind, Slot: in.Slot,
		Title: clip(in.Title, 48), Tags: cleanTags(in.Tags),
		Author: author, CreatedAt: now(), CreatedTS: nowTS(),
		GlowColor: in.GlowColor, TintHint: in.TintHint, PNG: in.PNG,
		Character: in.Character, Bundle: in.Bundle, RemixOf: in.RemixOf,
		Ratings: map[string]float64{}, Comments: []Comment{},
		Reports: map[string]string{}, Vouches: map[string]bool{},
	}
	if it.Title == "" {
		it.Title = "Untitled"
	}
	it.Flagged = looksNSFW(it)
	err := s.db.Update(func(tx *bolt.Tx) error { return s.put(tx, it) })
	if err != nil {
		return Item{}, err
	}
	return it, nil
}

// ---- mutations ----------------------------------------------------------

// update loads an item, applies fn, and saves it back atomically.
func (s *Store) update(id string, fn func(*Item) error) (Item, error) {
	var out Item
	err := s.db.Update(func(tx *bolt.Tx) error {
		it, ok := s.get(tx, id)
		if !ok {
			return ErrNotFound
		}
		if err := fn(&it); err != nil {
			return err
		}
		out = it
		return s.put(tx, it)
	})
	return out, err
}

// Get returns a single item.
func (s *Store) Get(id string) (Item, bool) {
	var it Item
	var ok bool
	_ = s.db.View(func(tx *bolt.Tx) error { it, ok = s.get(tx, id); return nil })
	return it, ok
}

// Rate sets a user's rating (0.5..5, half-steps). 0 removes it.
func (s *Store) Rate(id, user string, stars float64) (Item, error) {
	return s.update(id, func(it *Item) error {
		if it.Ratings == nil {
			it.Ratings = map[string]float64{}
		}
		if stars <= 0 {
			delete(it.Ratings, user)
			return nil
		}
		stars = float64(int(stars*2+0.5)) / 2 // snap to half-stars
		if stars < 0.5 {
			stars = 0.5
		}
		if stars > 5 {
			stars = 5
		}
		it.Ratings[user] = stars
		return nil
	})
}

// Comment adds a comment or reply.
func (s *Store) Comment(id, user, text, parentID string) (Item, error) {
	text = clip(strings.TrimSpace(text), 400)
	if text == "" {
		return Item{}, ErrBadInput
	}
	return s.update(id, func(it *Item) error {
		it.Comments = append(it.Comments, Comment{
			ID: newID(), Author: user, Text: text, ParentID: parentID,
			CreatedAt: now(), CreatedTS: nowTS(),
		})
		return nil
	})
}

// Report flags an item; CancelReport removes the user's report. A "false-report"
// Vouch counter-votes; CancelVouch removes it. After each, community auto-clear
// is applied (net <= -CensorThreshold resets the dispute).
func (s *Store) Report(id, user, reason string) (Item, error) {
	return s.update(id, func(it *Item) error {
		if it.Reports == nil {
			it.Reports = map[string]string{}
		}
		delete(it.Vouches, user) // a report and a vouch are mutually exclusive
		it.Reports[user] = clip(strings.TrimSpace(reason), 200)
		autoClear(it)
		return nil
	})
}

func (s *Store) CancelReport(id, user string) (Item, error) {
	return s.update(id, func(it *Item) error { delete(it.Reports, user); return nil })
}

func (s *Store) Vouch(id, user string) (Item, error) {
	return s.update(id, func(it *Item) error {
		if it.Vouches == nil {
			it.Vouches = map[string]bool{}
		}
		delete(it.Reports, user)
		it.Vouches[user] = true
		autoClear(it)
		return nil
	})
}

func (s *Store) CancelVouch(id, user string) (Item, error) {
	return s.update(id, func(it *Item) error { delete(it.Vouches, user); return nil })
}

// Download increments the download counter and returns the item.
func (s *Store) Download(id string) (Item, error) {
	return s.update(id, func(it *Item) error { it.Downloads++; return nil })
}

// Delete removes an item; only its author or an admin may do so.
func (s *Store) Delete(id, user string, isAdmin bool) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		it, ok := s.get(tx, id)
		if !ok {
			return ErrNotFound
		}
		if !isAdmin && !strings.EqualFold(it.Author, user) {
			return ErrForbidden
		}
		return tx.Bucket(bItems).Delete([]byte(id))
	})
}

// AdminBan permanently takes an item down. AdminRevoke clears the whole dispute
// (reports + vouches + flag) and un-bans it.
func (s *Store) AdminBan(id string) (Item, error) {
	return s.update(id, func(it *Item) error { it.Banned = true; return nil })
}
func (s *Store) AdminRevoke(id string) (Item, error) {
	return s.update(id, func(it *Item) error {
		it.Reports = map[string]string{}
		it.Vouches = map[string]bool{}
		it.Banned = false
		it.Flagged = false
		return nil
	})
}

// autoClear resets a dispute when the community vouches outweigh reports by the
// threshold ("all reports get revoked").
func autoClear(it *Item) {
	if score(it) <= -CensorThreshold {
		it.Reports = map[string]string{}
		it.Vouches = map[string]bool{}
	}
}

// ---- queries ------------------------------------------------------------

// ListOpts controls search / sort / filter.
type ListOpts struct {
	Q    string // search title / author / tags
	Sort string // new|old|rating_hi|rating_lo|dl_hi|dl_lo
	Kind string // ""|texture|character
	Slot string // ""|<slot>
}

// List returns item views matching the options, ordered by Sort.
func (s *Store) List(opts ListOpts, user string, isAdmin bool) []map[string]interface{} {
	var items []Item
	_ = s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bItems).ForEach(func(k, v []byte) error {
			var it Item
			if json.Unmarshal(v, &it) == nil {
				items = append(items, it)
			}
			return nil
		})
	})
	q := strings.ToLower(strings.TrimSpace(opts.Q))
	out := items[:0]
	for _, it := range items {
		if it.Banned && !isAdmin {
			continue // banned items vanish for everyone but admins
		}
		if opts.Kind != "" && it.Kind != opts.Kind {
			continue
		}
		if opts.Slot != "" && it.Slot != opts.Slot {
			continue
		}
		if q != "" && !matches(it, q) {
			continue
		}
		out = append(out, it)
	}
	sortItems(out, opts.Sort)
	views := make([]map[string]interface{}, 0, len(out))
	for _, it := range out {
		views = append(views, view(it, user, isAdmin))
	}
	return views
}

func matches(it Item, q string) bool {
	if strings.Contains(strings.ToLower(it.Title), q) || strings.Contains(strings.ToLower(it.Author), q) {
		return true
	}
	for _, t := range it.Tags {
		if strings.Contains(strings.ToLower(t), q) {
			return true
		}
	}
	return false
}

func sortItems(items []Item, mode string) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		switch mode {
		case "old":
			return a.CreatedTS < b.CreatedTS
		case "rating_hi":
			return avg(a) > avg(b)
		case "rating_lo":
			return avg(a) < avg(b)
		case "dl_hi":
			return a.Downloads > b.Downloads
		case "dl_lo":
			return a.Downloads < b.Downloads
		default: // "new"
			return a.CreatedTS > b.CreatedTS
		}
	})
}

// ---- views + moderation helpers -----------------------------------------

// ViewOne returns the JSON-safe view of a single item for a given requester.
func (s *Store) ViewOne(it Item, user string, isAdmin bool) map[string]interface{} {
	return view(it, user, isAdmin)
}

func score(it *Item) int   { return len(it.Reports) - len(it.Vouches) }
func censored(it Item) bool { return it.Banned || it.Flagged || (len(it.Reports)-len(it.Vouches)) >= CensorThreshold }

func avg(it Item) float64 {
	if len(it.Ratings) == 0 {
		return 0
	}
	var sum float64
	for _, v := range it.Ratings {
		sum += v
	}
	return sum / float64(len(it.Ratings))
}

// view is the JSON-safe projection sent to clients. The pixel payload of a
// censored item is withheld from everyone but its author and admins.
func view(it Item, user string, isAdmin bool) map[string]interface{} {
	cz := censored(it)
	mine := strings.EqualFold(it.Author, user)
	canSee := !cz || isAdmin || mine
	m := map[string]interface{}{
		"id": it.ID, "kind": it.Kind, "slot": it.Slot, "title": it.Title,
		"tags": it.Tags, "author": it.Author, "createdAt": it.CreatedAt, "createdTs": it.CreatedTS,
		"glowColor": it.GlowColor, "tintHint": it.TintHint, "remixOf": it.RemixOf,
		"downloads": it.Downloads, "comments": it.Comments,
		"avgRating": avg(it), "ratingCount": len(it.Ratings),
		"reportCount": len(it.Reports), "vouchCount": len(it.Vouches),
		"censored": cz, "banned": it.Banned, "flagged": it.Flagged,
		"canSee": canSee,
	}
	if user != "" {
		if r, ok := it.Ratings[user]; ok {
			m["myRating"] = r
		}
		_, rep := it.Reports[user]
		_, vch := it.Vouches[user]
		m["myReport"] = rep
		m["myVouch"] = vch
	}
	if canSee {
		if it.PNG != "" {
			m["png"] = it.PNG
		}
		if it.Character != nil {
			m["character"] = it.Character
		}
		if it.Bundle != nil {
			m["bundle"] = it.Bundle
		}
	}
	return m
}

// ---- input cleaning -----------------------------------------------------

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) > n {
		return string([]rune(s)[:n])
	}
	return s
}

func cleanTags(tags []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, t := range tags {
		t = strings.ToLower(clip(t, 24))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

// ---- best-effort NSFW guard ---------------------------------------------
//
// This is deliberately humble: from a grayscale texture alone you cannot
// reliably detect intent, so the REAL safety net is the community report/vouch
// system. We do two cheap things at publish time: (1) a wordlist scan of the
// title/tags, and (2) a crude phallic-silhouette heuristic on the alpha mask
// (a tall, narrow painted stalk with two low blobs). A hit only FLAGS the item
// (auto-censored pending review), which an admin can revoke.

var nsfwWords = []string{
	"penis", "dick", "cock", "phallus", "boob", "tit", "nipple", "vagina",
	"pussy", "nsfw", "porn", "nude", "genital", "scrotum", "testicle",
}

func looksNSFW(it Item) bool {
	hay := strings.ToLower(it.Title + " " + strings.Join(it.Tags, " "))
	for _, w := range nsfwWords {
		if strings.Contains(hay, w) {
			return true
		}
	}
	if it.Kind == "texture" {
		if mask, w, h, ok := decodeAlpha(it.PNG); ok {
			return phallicShape(mask, w, h)
		}
	}
	return false
}

// decodeAlpha decodes a packed PNG data URL into a boolean painted-mask
// (alpha>32). Returns the mask plus dimensions.
func decodeAlpha(dataURL string) ([]bool, int, int, bool) {
	i := strings.Index(dataURL, ",")
	if i < 0 || !strings.HasPrefix(dataURL, "data:image") {
		return nil, 0, 0, false
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[i+1:])
	if err != nil {
		return nil, 0, 0, false
	}
	img, err := png.Decode(strings.NewReader(string(raw)))
	if err != nil {
		return nil, 0, 0, false
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 || w > 256 || h > 256 {
		return nil, 0, 0, false
	}
	mask := make([]bool, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			_, _, _, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			mask[y*w+x] = (a >> 8) > 32
		}
	}
	return mask, w, h, true
}

// phallicShape is a conservative heuristic: a tall narrow vertical column of
// painted pixels (the "shaft") whose width is a small fraction of its height,
// with two painted blobs flanking its base. Tuned to avoid most false positives.
func phallicShape(mask []bool, w, h int) bool {
	// Per-row painted span around the horizontal centre third.
	rowFilled := make([]int, h)
	rowMinX := make([]int, h)
	rowMaxX := make([]int, h)
	total := 0
	for y := 0; y < h; y++ {
		minX, maxX, cnt := -1, -1, 0
		for x := 0; x < w; x++ {
			if mask[y*w+x] {
				cnt++
				if minX < 0 {
					minX = x
				}
				maxX = x
			}
		}
		rowFilled[y] = cnt
		rowMinX[y] = minX
		rowMaxX[y] = maxX
		total += cnt
	}
	if total < 12 {
		return false
	}
	// Find the tallest contiguous run of narrow rows (width <= 35% of grid) that
	// are also painted — the candidate shaft.
	narrow := func(y int) bool {
		if rowFilled[y] == 0 {
			return false
		}
		span := rowMaxX[y] - rowMinX[y] + 1
		return span > 0 && span <= w*35/100 && rowFilled[y] >= 1
	}
	best, run := 0, 0
	for y := 0; y < h; y++ {
		if narrow(y) {
			run++
			if run > best {
				best = run
			}
		} else {
			run = 0
		}
	}
	tallShaft := best >= h*40/100 // shaft spans >=40% of the height
	if !tallShaft {
		return false
	}
	// Two low blobs: in the bottom third, a row noticeably wider than the shaft.
	wideBase := false
	for y := h * 66 / 100; y < h; y++ {
		span := rowMaxX[y] - rowMinX[y] + 1
		if rowFilled[y] > 0 && span >= w*45/100 {
			wideBase = true
			break
		}
	}
	return tallShaft && wideBase
}
