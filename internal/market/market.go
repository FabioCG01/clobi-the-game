// Package market is the open-source cosmetic marketplace store for Clobi's Arena.
//
// Everything published is ALWAYS FREE. The 3D era trades exactly ONE kind of
// good: complete Minecraft-compatible 3D skins (kind "skin" — a 64×64/64×32 PNG
// data URL plus its classic/slim arm model). The legacy 2D economy (painted
// textures, whole characters) is discarded: publishing those kinds is rejected,
// and legacy rows still in the database stay invisible to List.
//
// Items can be rated (half-stars), commented on (with threaded replies),
// reported, and "false-report" vouched. A Reddit-style net score drives soft
// moderation: at +5 net reports an item is auto-censored (its pixels are
// withheld from everyone but its author and admins) until an admin bans it or
// revokes the reports; at -5 net the community-cleared reports reset automatically.
//
// Storage is the shared PostgreSQL pool: one row per item, with hot columns
// (author/kind/slot/created_ts/…) for filtering and the full item as jsonb.
package market

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"sort"
	"strings"
	"time"

	"clobi/internal/protocol"
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

// Item is a published marketplace entry. The only publishable kind is "skin";
// "texture" and "character" fields remain so legacy rows still unmarshal (they
// are hidden from listings and can no longer be published).
type Item struct {
	ID        string                 `json:"id"`
	Kind      string                 `json:"kind"`            // "skin" | legacy: "texture"/"character"
	Slot      string                 `json:"slot"`            // legacy texture slot ("" for skins)
	Model     string                 `json:"model,omitempty"` // skins: "classic" | "slim"
	Title     string                 `json:"title"`
	Tags      []string               `json:"tags"`
	Author    string                 `json:"author"`
	CreatedAt string                 `json:"createdAt"`
	CreatedTS int64                  `json:"createdTs"`
	GlowColor string                 `json:"glowColor,omitempty"`
	TintHint  string                 `json:"tintHint,omitempty"`
	PNG       string                 `json:"png,omitempty"`       // skin pixels (data URL)
	Character *protocol.Character    `json:"character,omitempty"` // legacy kind=character
	Bundle    map[string]TextureLite `json:"bundle,omitempty"`    // legacy texId -> texture
	RemixOf   string                 `json:"remixOf,omitempty"`
	Downloads int                    `json:"downloads"`
	Ratings   map[string]float64     `json:"ratings"` // user -> 0.5..5
	Comments  []Comment              `json:"comments"`
	Reports   map[string]string      `json:"reports"` // user -> reason
	Vouches   map[string]bool        `json:"vouches"` // user -> true (false-report vote)
	Banned    bool                   `json:"banned"`  // admin permanent takedown
	Flagged   bool                   `json:"flagged"` // auto NSFW heuristic flag
}

// querier is the subset of *sql.DB / *sql.Tx the store needs.
type querier interface {
	Exec(query string, args ...interface{}) (sql.Result, error)
	QueryRow(query string, args ...interface{}) *sql.Row
}

// Store is the marketplace persistence layer (PostgreSQL).
type Store struct{ db *sql.DB }

// NewStore returns a marketplace store over the shared pool (schema is created
// by pgdb.Open).
func NewStore(db *sql.DB) (*Store, error) {
	if db == nil {
		return nil, errors.New("market: nil db")
	}
	return &Store{db: db}, nil
}

func now() string  { return time.Now().UTC().Format(time.RFC3339) }
func nowTS() int64 { return time.Now().UTC().Unix() }

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "m" + hex.EncodeToString([]byte(time.Now().Format("150405.000000")))
	}
	return "m" + hex.EncodeToString(b)
}

func scanItem(raw []byte) (Item, bool) {
	var it Item
	if json.Unmarshal(raw, &it) != nil {
		return Item{}, false
	}
	return it, true
}

func (s *Store) getQ(q querier, id string) (Item, bool) {
	var raw []byte
	if err := q.QueryRow(`SELECT body FROM market_items WHERE id = $1`, id).Scan(&raw); err != nil {
		return Item{}, false
	}
	return scanItem(raw)
}

func put(q querier, it Item) error {
	data, err := json.Marshal(it)
	if err != nil {
		return err
	}
	_, err = q.Exec(
		`INSERT INTO market_items(id, author, kind, slot, created_ts, downloads, banned, flagged, body)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
		 ON CONFLICT (id) DO UPDATE SET
		   author=EXCLUDED.author, kind=EXCLUDED.kind, slot=EXCLUDED.slot,
		   created_ts=EXCLUDED.created_ts, downloads=EXCLUDED.downloads,
		   banned=EXCLUDED.banned, flagged=EXCLUDED.flagged, body=EXCLUDED.body`,
		it.ID, it.Author, it.Kind, it.Slot, it.CreatedTS, it.Downloads, it.Banned, it.Flagged, string(data))
	return err
}

// ---- publish ------------------------------------------------------------

// Publish stores a new item authored by `author`. Only kind "skin" is accepted
// — the legacy 2D kinds ("texture"/"character") are rejected with ErrBadInput.
// The skin pixels + model are checked with the shared protocol validator
// (valid PNG, ≤32 KiB, exactly 64×64 or 64×32, model classic|slim).
func (s *Store) Publish(author string, in Item) (Item, error) {
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	// Tolerate a missing kind (the client only publishes skins now); every
	// explicit non-skin kind is refused — the 2D economy is discarded.
	if in.Kind == "" {
		in.Kind = "skin"
	}
	if in.Kind != "skin" {
		return Item{}, ErrBadInput
	}
	sk := protocol.Skin{Name: in.Title, Model: in.Model, PNG: in.PNG}
	if err := protocol.ValidateSkin(&sk); err != nil {
		return Item{}, fmt.Errorf("%w: %v", ErrBadInput, err)
	}
	it := Item{
		ID: newID(), Kind: "skin", Model: sk.Model,
		Title: clip(in.Title, 48), Tags: cleanTags(in.Tags),
		Author: author, CreatedAt: now(), CreatedTS: nowTS(),
		PNG: in.PNG, RemixOf: clip(in.RemixOf, 64),
		Ratings: map[string]float64{}, Comments: []Comment{},
		Reports: map[string]string{}, Vouches: map[string]bool{},
	}
	if it.Title == "" {
		it.Title = "Untitled"
	}
	it.Flagged = looksNSFW(it)
	if err := put(s.db, it); err != nil {
		return Item{}, err
	}
	return it, nil
}

// ---- mutations ----------------------------------------------------------

// update loads an item FOR UPDATE, applies fn, and saves it back atomically.
func (s *Store) update(id string, fn func(*Item) error) (Item, error) {
	var out Item
	tx, err := s.db.Begin()
	if err != nil {
		return Item{}, err
	}
	defer tx.Rollback()

	var raw []byte
	if err := tx.QueryRow(`SELECT body FROM market_items WHERE id = $1 FOR UPDATE`, id).Scan(&raw); err != nil {
		if err == sql.ErrNoRows {
			return Item{}, ErrNotFound
		}
		return Item{}, err
	}
	it, ok := scanItem(raw)
	if !ok {
		return Item{}, ErrNotFound
	}
	if err := fn(&it); err != nil {
		return Item{}, err
	}
	if err := put(tx, it); err != nil {
		return Item{}, err
	}
	if err := tx.Commit(); err != nil {
		return Item{}, err
	}
	out = it
	return out, nil
}

// Get returns a single item.
func (s *Store) Get(id string) (Item, bool) { return s.getQ(s.db, id) }

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

// Report flags an item; CancelReport removes the user's report. Vouch counter-
// votes "false report"; CancelVouch removes it. Community auto-clear applies.
func (s *Store) Report(id, user, reason string) (Item, error) {
	return s.update(id, func(it *Item) error {
		if it.Reports == nil {
			it.Reports = map[string]string{}
		}
		delete(it.Vouches, user)
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
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	it, ok := s.getQ(tx, id)
	if !ok {
		return ErrNotFound
	}
	if !isAdmin && !strings.EqualFold(it.Author, user) {
		return ErrForbidden
	}
	if _, err := tx.Exec(`DELETE FROM market_items WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// AdminBan permanently takes an item down. AdminRevoke clears the dispute.
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

// autoClear resets a dispute when vouches outweigh reports by the threshold.
func autoClear(it *Item) {
	if score(it) <= -CensorThreshold {
		it.Reports = map[string]string{}
		it.Vouches = map[string]bool{}
	}
}

// ---- queries ------------------------------------------------------------

// ListOpts controls search / sort / filter.
type ListOpts struct {
	Q     string // search title / author / tags
	Sort  string // new|old|rating_hi|rating_lo|dl_hi|dl_lo
	Kind  string // ""|skin (legacy kinds match nothing)
	Slot  string // legacy, ""|<slot>
	Model string // ""|classic|slim (skins)
}

// List returns item views matching the options, ordered by Sort. Only skins
// are ever listed: legacy "texture"/"character" rows stay in the database but
// are invisible here (asking for a legacy Kind yields an empty list).
func (s *Store) List(opts ListOpts, user string, isAdmin bool) []map[string]interface{} {
	views := []map[string]interface{}{}
	if k := strings.ToLower(strings.TrimSpace(opts.Kind)); k != "" && k != "skin" {
		return views // the 2D economy is retired — legacy kinds list as empty
	}
	where := []string{"kind = 'skin'"}
	args := []interface{}{}
	if opts.Slot != "" {
		args = append(args, opts.Slot)
		where = append(where, "slot = $"+itoa(len(args)))
	}
	q := `SELECT body FROM market_items WHERE ` + strings.Join(where, " AND ")
	var items []Item
	rows, err := s.db.Query(q, args...)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var raw []byte
			if rows.Scan(&raw) == nil {
				if it, ok := scanItem(raw); ok {
					items = append(items, it)
				}
			}
		}
	}
	search := strings.ToLower(strings.TrimSpace(opts.Q))
	model := strings.ToLower(strings.TrimSpace(opts.Model))
	out := items[:0]
	for _, it := range items {
		if it.Banned && !isAdmin {
			continue // banned items vanish for everyone but admins
		}
		if model != "" && !strings.EqualFold(it.Model, model) {
			continue // classic/slim filter
		}
		if search != "" && !matches(it, search) {
			continue
		}
		out = append(out, it)
	}
	sortItems(out, opts.Sort)
	for _, it := range out {
		views = append(views, view(it, user, isAdmin))
	}
	return views
}

// itoa is a tiny helper for building positional placeholders.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
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

func score(it *Item) int    { return len(it.Reports) - len(it.Vouches) }
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
		"id": it.ID, "kind": it.Kind, "slot": it.Slot, "model": it.Model, "title": it.Title,
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
// Deliberately humble: the REAL safety net is the community report/vouch system.
// At publish time we do two cheap things: (1) a wordlist scan of title/tags, and
// (2) for LEGACY textures only, a crude phallic-silhouette heuristic on the
// alpha mask. Skins never run the shape heuristic — a skin's base layer is
// opaque, so its silhouette is always the full 64×64 sheet and says nothing
// about content. A hit only FLAGS the item (auto-censored pending review),
// which an admin can revoke.

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
	if it.Kind == "texture" { // legacy textures only — NEVER for kind "skin"
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
// painted pixels (the "shaft") with two painted blobs flanking its base.
func phallicShape(mask []bool, w, h int) bool {
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
	tallShaft := best >= h*40/100
	if !tallShaft {
		return false
	}
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
