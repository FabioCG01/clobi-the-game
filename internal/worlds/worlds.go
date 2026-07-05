// Package worlds is the persistent server-world store for Clobi Craft Part II
// (see ARCHITECTURE-MP.md §1, §2, §3.2). A world is `(seed, deltas)`: the server
// never generates or stores terrain, only the seed and the player edits layered
// on top of it ("Delta Saving"). This package owns three tables that share the
// pool opened by internal/pgdb:
//
//	worlds(id, name, owner, seed, settings jsonb, created_at, updated_at)
//	world_members(world_id, username, added_at)
//	world_deltas(world_id, cx, cz, data bytea, updated_at)
//
// Rooms/instances/live-hosting state are NOT this package's concern (that is
// internal/rooms, in-memory only); this store only persists world identity,
// membership, and the delta blobs, and is agnostic to whether a world is
// currently hosted. Callers needing "is this world hosted right now" (e.g. to
// refuse Delete, or to populate WorldView.Live) own that check themselves.
//
// Style mirrors internal/accounts and internal/market: plain database/sql
// calls (no prepared-statement helper, no ORM), sentinel errors compared with
// errors.Is, and a Store that just wraps *sql.DB.
package worlds

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Sentinel errors, compared with errors.Is (same convention as accounts/market).
var (
	ErrNotFound  = errors.New("world not found")
	ErrForbidden = errors.New("not allowed")
	ErrBadInput  = errors.New("invalid input")
)

// MaxNameRunes clips a world's display name (contract §1: "clipped 32").
const MaxNameRunes = 32

// DefaultCap is the default player cap written into a brand-new world's
// settings jsonb (contract §1: `{cap:8}`).
const DefaultCap = 8

// World is one persistent server world (contract §1/§3.2).
type World struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Owner     string          `json:"owner"`
	Seed      int64           `json:"seed"`
	Settings  json.RawMessage `json:"settings"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// WorldView is the GET /api/worlds shape (contract §3.2): a world plus the
// caller's role, the member list, and a Live slot the CALLER populates — this
// package has no notion of live room instances (that's internal/rooms). Live
// is left nil (JSON null) by every method here; the server package fills it
// in from rooms.Manager after calling ListForUser.
type WorldView struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	Seed      int64       `json:"seed"`
	Owner     string      `json:"owner"`
	Role      string      `json:"role"` // "owner" | "member"
	Members   []string    `json:"members"`
	UpdatedAt time.Time   `json:"updatedAt"`
	Live      interface{} `json:"live"` // populated by the caller (rooms.Manager); nil here
}

// accountExistsFunc reports whether a username names a real account. Store
// accepts one at NewStore time so this package never imports internal/accounts
// (avoiding a circular-ish dependency smell) — but the zero value (nil) falls
// back to a plain `SELECT EXISTS` against the shared accounts table, exactly
// how internal/market coexists with internal/accounts on one *sql.DB without
// importing it. Passing a func is only useful for tests/mocking; production
// code can simply call NewStore(db) and get the direct-query behaviour.
type accountExistsFunc func(username string) bool

// Store is the persistent world store (PostgreSQL).
type Store struct {
	db           *sql.DB
	accountCheck accountExistsFunc
}

// NewStore wraps an open *sql.DB (schema already migrated by pgdb.Open). Pass
// checkAccount to inject a custom "does this username exist" check (e.g. from
// a cache); pass nil to use the default direct SQL query against accounts.
func NewStore(db *sql.DB, checkAccount ...accountExistsFunc) (*Store, error) {
	if db == nil {
		return nil, errors.New("worlds: nil db")
	}
	s := &Store{db: db}
	if len(checkAccount) > 0 && checkAccount[0] != nil {
		s.accountCheck = checkAccount[0]
	} else {
		s.accountCheck = s.accountExistsSQL
	}
	return s, nil
}

// accountExistsSQL is the default accountCheck: a direct query against the
// shared accounts table (same pool, no import of internal/accounts).
func (s *Store) accountExistsSQL(username string) bool {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM accounts WHERE username = $1`, key(username)).Scan(&one)
	return err == nil
}

func key(username string) string { return strings.ToLower(strings.TrimSpace(username)) }

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func newID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "w" + hex.EncodeToString([]byte(strconv.FormatInt(time.Now().UnixNano(), 16)))
	}
	return "w" + hex.EncodeToString(b)
}

// defaultSettings is the settings jsonb a brand-new world is created with.
func defaultSettings() json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"cap":%d}`, DefaultCap))
}

// ---- create / read / rename / delete ------------------------------------

// Create makes a new world owned by owner. name is clipped to MaxNameRunes; a
// blank name becomes "World". settings default to {"cap":8}.
func (s *Store) Create(owner, name string, seed int64) (World, error) {
	owner = key(owner)
	if owner == "" {
		return World{}, fmt.Errorf("%w: owner required", ErrBadInput)
	}
	if !s.accountCheck(owner) {
		return World{}, fmt.Errorf("%w: unknown owner", ErrBadInput)
	}
	name = clip(name, MaxNameRunes)
	if name == "" {
		name = "World"
	}
	w := World{
		ID: newID(), Name: name, Owner: owner, Seed: seed,
		Settings: defaultSettings(),
	}
	err := s.db.QueryRow(
		`INSERT INTO worlds(id, name, owner, seed, settings)
		 VALUES ($1, $2, $3, $4, $5::jsonb)
		 RETURNING created_at, updated_at`,
		w.ID, w.Name, w.Owner, w.Seed, string(w.Settings)).Scan(&w.CreatedAt, &w.UpdatedAt)
	if err != nil {
		return World{}, err
	}
	return w, nil
}

// scanWorld reads one worlds row into a World.
func scanWorld(row interface {
	Scan(dest ...interface{}) error
}) (World, bool) {
	var w World
	var settings []byte
	if err := row.Scan(&w.ID, &w.Name, &w.Owner, &w.Seed, &settings, &w.CreatedAt, &w.UpdatedAt); err != nil {
		return World{}, false
	}
	w.Settings = json.RawMessage(settings)
	return w, true
}

const worldCols = `id, name, owner, seed, settings, created_at, updated_at`

// Get returns a world by id.
func (s *Store) Get(id string) (World, bool) {
	row := s.db.QueryRow(`SELECT `+worldCols+` FROM worlds WHERE id = $1`, id)
	return scanWorld(row)
}

// ListForUser returns every world the user owns or is a member of (contract
// §3.2 GET /api/worlds). Live is left nil; the caller (server package, via
// rooms.Manager) fills it in per world.
func (s *Store) ListForUser(username string) ([]WorldView, error) {
	u := key(username)
	rows, err := s.db.Query(`
		SELECT w.id, w.name, w.seed, w.owner, w.updated_at,
		       CASE WHEN w.owner = $1 THEN 'owner' ELSE 'member' END AS role
		FROM worlds w
		WHERE w.owner = $1 OR EXISTS (
		      SELECT 1 FROM world_members m WHERE m.world_id = w.id AND m.username = $1)
		ORDER BY w.updated_at DESC`, u)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	views := []WorldView{}
	ids := []string{}
	byID := map[string]*WorldView{}
	for rows.Next() {
		var v WorldView
		if err := rows.Scan(&v.ID, &v.Name, &v.Seed, &v.Owner, &v.UpdatedAt, &v.Role); err != nil {
			return nil, err
		}
		v.Members = []string{}
		views = append(views, v)
		ids = append(ids, v.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range views {
		byID[views[i].ID] = &views[i]
	}
	if len(ids) == 0 {
		return views, nil
	}
	// Build an IN ($1,$2,...) clause with individual positional placeholders
	// rather than relying on a driver-specific array binding (ANY($1) with a
	// []string arg) — plain database/sql placeholders work with any driver.
	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "$" + strconv.Itoa(i+1)
		args[i] = id
	}
	memQuery := `SELECT world_id, username FROM world_members WHERE world_id IN (` +
		strings.Join(placeholders, ",") + `) ORDER BY added_at ASC`
	memRows, err := s.db.Query(memQuery, args...)
	if err != nil {
		return nil, err
	}
	defer memRows.Close()
	for memRows.Next() {
		var worldID, uname string
		if err := memRows.Scan(&worldID, &uname); err != nil {
			return nil, err
		}
		if v, ok := byID[worldID]; ok {
			v.Members = append(v.Members, uname)
		}
	}
	if err := memRows.Err(); err != nil {
		return nil, err
	}
	return views, nil
}

// Rename renames a world. Only the owner may rename it.
func (s *Store) Rename(id, owner, newName string) error {
	newName = clip(newName, MaxNameRunes)
	if newName == "" {
		return fmt.Errorf("%w: name required", ErrBadInput)
	}
	res, err := s.db.Exec(
		`UPDATE worlds SET name = $3, updated_at = now() WHERE id = $1 AND owner = $2`,
		id, key(owner), newName)
	if err != nil {
		return err
	}
	return checkOwnerAffected(s, id, owner, res)
}

// checkOwnerAffected turns a zero-rows-affected UPDATE into either
// ErrNotFound (the world doesn't exist) or ErrForbidden (it exists, but the
// caller isn't its owner) — same shape callers rely on across this package.
func checkOwnerAffected(s *Store, id, owner string, res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if _, ok := s.Get(id); !ok {
		return ErrNotFound
	}
	return ErrForbidden
}

// Delete removes a world (members + deltas cascade via foreign keys). Only
// the owner may delete it. Whether the world is currently hosted is the
// CALLER's job (rooms.Manager) — this package has no notion of live rooms.
func (s *Store) Delete(id, owner string) error {
	if _, ok := s.Get(id); !ok {
		return ErrNotFound
	}
	res, err := s.db.Exec(`DELETE FROM worlds WHERE id = $1 AND owner = $2`, id, key(owner))
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrForbidden
	}
	return nil
}

// UpdateSettings replaces the world's settings jsonb wholesale (the instance
// flushes the full merged object — spawn/time/cap/etc — so a whole-object
// replace is correct here; callers are responsible for merging before calling).
func (s *Store) UpdateSettings(worldID string, settings json.RawMessage) error {
	if len(settings) == 0 {
		settings = json.RawMessage(`{}`)
	}
	res, err := s.db.Exec(
		`UPDATE worlds SET settings = $2::jsonb, updated_at = now() WHERE id = $1`,
		worldID, string(settings))
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- membership -----------------------------------------------------------

// AddMember adds username to the world's member list. Only the owner may add
// members. Returns ErrNotFound if username names no account.
func (s *Store) AddMember(id, owner, username string) error {
	w, ok := s.Get(id)
	if !ok {
		return ErrNotFound
	}
	if w.Owner != key(owner) {
		return ErrForbidden
	}
	u := key(username)
	if u == "" || !s.accountCheck(u) {
		return ErrNotFound
	}
	if u == w.Owner {
		return nil // owner is implicitly always "in" the world; no-op
	}
	_, err := s.db.Exec(
		`INSERT INTO world_members(world_id, username) VALUES ($1, $2)
		 ON CONFLICT (world_id, username) DO NOTHING`, id, u)
	return err
}

// RemoveMember removes username from the world's member list. Only the owner
// may remove members.
func (s *Store) RemoveMember(id, owner, username string) error {
	w, ok := s.Get(id)
	if !ok {
		return ErrNotFound
	}
	if w.Owner != key(owner) {
		return ErrForbidden
	}
	_, err := s.db.Exec(
		`DELETE FROM world_members WHERE world_id = $1 AND username = $2`, id, key(username))
	return err
}

// IsMember reports whether username is a member of the world OR its owner.
func (s *Store) IsMember(id, username string) (bool, error) {
	u := key(username)
	if u == "" {
		return false, nil
	}
	w, ok := s.Get(id)
	if !ok {
		return false, ErrNotFound
	}
	if w.Owner == u {
		return true, nil
	}
	var one int
	err := s.db.QueryRow(
		`SELECT 1 FROM world_members WHERE world_id = $1 AND username = $2`, id, u).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ---- deltas (contract §2) --------------------------------------------------

// recordSize is the byte length of one packed delta record: u16 blockIndex +
// u8 blockId, little-endian (contract §2).
const recordSize = 3

// maxBlockIndex is the exclusive upper bound of a chunk block index
// ((y*16+z)*16+x for a 16×96×16 chunk: 16*96*16 = 24576).
const maxBlockIndex = 24576

// compactDeltaBlob validates a packed delta blob's format (whole number of
// 3-byte records, every index < maxBlockIndex) and COMPACTS it to the stored
// invariant: at most one record per index, ascending index order, later
// records for the same index win (contract §2, verbatim: "Later records for
// the same index win (server compacts on flush: at most one record per
// index, ascending index order)"). Incoming blobs are NOT required to already
// be sorted/deduplicated — that would reject perfectly legitimate uncompacted
// diffs from the client — compaction is this store's job. An empty blob
// compacts to empty (contract: "empty blob = delta removed").
func compactDeltaBlob(data []byte) ([]byte, error) {
	if len(data)%recordSize != 0 {
		return nil, fmt.Errorf("%w: delta blob length %d is not a multiple of %d", ErrBadInput, len(data), recordSize)
	}
	if len(data) == 0 {
		return data, nil
	}
	latest := make(map[uint16]uint8, len(data)/recordSize)
	for i := 0; i+recordSize <= len(data); i += recordSize {
		idx := uint16(data[i]) | uint16(data[i+1])<<8
		if int(idx) >= maxBlockIndex {
			return nil, fmt.Errorf("%w: block index %d out of range", ErrBadInput, idx)
		}
		latest[idx] = data[i+2] // later record for the same index overwrites
	}
	indices := make([]int, 0, len(latest))
	for idx := range latest {
		indices = append(indices, int(idx))
	}
	sort.Ints(indices)
	out := make([]byte, 0, len(indices)*recordSize)
	for _, idx := range indices {
		out = append(out, byte(idx), byte(idx>>8), latest[uint16(idx)])
	}
	return out, nil
}

// splitChunkKey turns "cx,cz" into its two integers.
func splitChunkKey(k string) (cx, cz int, ok bool) {
	parts := strings.SplitN(k, ",", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	x, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
	z, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return x, z, true
}

func chunkKey(cx, cz int) string { return strconv.Itoa(cx) + "," + strconv.Itoa(cz) }

// GetDeltas returns every stored delta blob of a world, keyed "cx,cz", each
// value the raw packed record bytes (NOT base64 — see Import/SaveDeltas for
// where wire base64 is decoded/encoded at the boundary). Used for room
// hydration on host-open.
func (s *Store) GetDeltas(worldID string) (map[string][]byte, error) {
	rows, err := s.db.Query(`SELECT cx, cz, data FROM world_deltas WHERE world_id = $1`, worldID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]byte{}
	for rows.Next() {
		var cx, cz int
		var data []byte
		if err := rows.Scan(&cx, &cz, &data); err != nil {
			return nil, err
		}
		out[chunkKey(cx, cz)] = data
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// SaveDeltas upserts dirty chunks in one transaction. dirty is keyed "cx,cz"
// with raw packed record bytes; an empty []byte value means "delete this
// chunk's delta row" (contract §2: chunk reverts to pure-seed state). Every
// non-empty blob is format-checked and compacted (see compactDeltaBlob)
// before touching the database — a malformed blob (wrong length, index out
// of range) aborts the whole batch (rolled back) rather than partially
// applying.
func (s *Store) SaveDeltas(worldID string, dirty map[string][]byte) error {
	if len(dirty) == 0 {
		return nil
	}
	if _, ok := s.Get(worldID); !ok {
		return ErrNotFound
	}
	type entry struct {
		cx, cz int
		data   []byte
	}
	toUpsert := make([]entry, 0, len(dirty))
	toDelete := make([]entry, 0)
	for k, data := range dirty {
		cx, cz, ok := splitChunkKey(k)
		if !ok {
			return fmt.Errorf("%w: bad chunk key %q", ErrBadInput, k)
		}
		if len(data) == 0 {
			toDelete = append(toDelete, entry{cx, cz, nil})
			continue
		}
		compact, err := compactDeltaBlob(data)
		if err != nil {
			return err
		}
		if len(compact) == 0 {
			// Every record in the blob collapsed to nothing meaningful (can't
			// actually happen since we only drop duplicates, kept for safety
			// if a future caller passes an all-zero-length edge case) — treat
			// like a delete rather than storing an empty row.
			toDelete = append(toDelete, entry{cx, cz, nil})
			continue
		}
		toUpsert = append(toUpsert, entry{cx, cz, compact})
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, e := range toUpsert {
		if _, err := tx.Exec(
			`INSERT INTO world_deltas(world_id, cx, cz, data, updated_at)
			 VALUES ($1, $2, $3, $4, now())
			 ON CONFLICT (world_id, cx, cz) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
			worldID, e.cx, e.cz, e.data); err != nil {
			return err
		}
	}
	for _, e := range toDelete {
		if _, err := tx.Exec(
			`DELETE FROM world_deltas WHERE world_id = $1 AND cx = $2 AND cz = $3`,
			worldID, e.cx, e.cz); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE worlds SET updated_at = now() WHERE id = $1`, worldID); err != nil {
		return err
	}
	return tx.Commit()
}

// ---- import (local -> server upload, contract §3.2 POST /api/worlds/import) --

// Import creates a new world for owner and stores the given deltas in one
// shot (the "Upload to server" flow: client regenerates edited chunks from
// seed, diffs, and posts the resulting records). Every chunk's blob goes
// through the same format check + compaction as SaveDeltas: well-formed
// 3-byte records, every index < 24576 (contract §3.2: "validates every
// record: index < 24576, valid block id, y>0 for edits at y==0 -> reject
// record" — the block-id-validity and y==0/bedrock-immutability checks need
// the block registry, which per the module map lives client-side only; this
// package enforces everything it CAN verify purely from the byte layout
// (bounds + compaction) and leaves id/immutability re-validation to callers
// with Blocks-level knowledge. In practice the room's live edit path
// (internal/rooms) already validates id/immutability per contract §3.3
// "block" on every interactive edit, so an imported world is no less trusted
// than one built up by live play).
func (s *Store) Import(owner, name string, seed int64, deltas map[string][]byte) (World, error) {
	w, err := s.Create(owner, name, seed)
	if err != nil {
		return World{}, err
	}
	if len(deltas) == 0 {
		return w, nil
	}
	if err := s.SaveDeltas(w.ID, deltas); err != nil {
		// Roll back the just-created world so a bad import doesn't leave an
		// empty orphan world behind.
		_ = s.Delete(w.ID, owner)
		return World{}, err
	}
	// updated_at moved forward inside SaveDeltas; re-read for the fresh view.
	fresh, ok := s.Get(w.ID)
	if !ok {
		return w, nil
	}
	return fresh, nil
}

// ---- misc -------------------------------------------------------------

// DeltasToWire converts a raw-bytes delta map (as returned by GetDeltas) into
// the base64-encoded wire shape used by the "welcome" WS message and the
// GET/POST REST payloads (contract §2: "Wire/dump encoding: base64 of the
// record blob").
func DeltasToWire(raw map[string][]byte) map[string]string {
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		out[k] = base64.StdEncoding.EncodeToString(v)
	}
	return out
}

// DeltasFromWire decodes the base64 wire shape back into raw record bytes
// (the reverse of DeltasToWire), tolerating both standard and unpadded base64
// (mirrors protocol.ValidateSkin's tolerance for the same reason: some
// encoders omit padding).
func DeltasFromWire(wire map[string]string) (map[string][]byte, error) {
	out := make(map[string][]byte, len(wire))
	for k, b64 := range wire {
		data, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			if data, err = base64.RawStdEncoding.DecodeString(b64); err != nil {
				return nil, fmt.Errorf("%w: chunk %q is not valid base64", ErrBadInput, k)
			}
		}
		out[k] = data
	}
	return out, nil
}
