// Package accounts is the account + settings store for TUX SMASH ROYALE.
//
// Storage is PostgreSQL (via the pure-Go pgx driver through database/sql, so the
// server stays a single static binary). Everything a player owns lives on the
// server and follows them across devices: the account (username + bcrypt hash +
// character), the creative library (painted textures + character presets),
// durable bearer-token sessions, and the admin-controlled default looks.
//
// Tables (see internal/pgdb for the schema):
//   accounts(username, display, hash, is_admin, character jsonb, skin jsonb, presets jsonb, …)
//   textures(username, tex_id, record jsonb)        -- per-user painted cosmetics
//                                                      (3D era: doubles as the cloud skin library)
//   sessions(token, username)                        -- durable login tokens
//   settings(key, value jsonb)                       -- default looks + default skin
//
// Session tokens are also cached in memory so per-request auth is a map lookup
// (the sessions table is the durable backing, reloaded on boot).
package accounts

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"clobi/internal/protocol"

	"golang.org/x/crypto/bcrypt"
)

// Errors returned by the Store (compare with errors.Is).
var (
	ErrUserExists   = errors.New("username already taken")
	ErrBadCreds     = errors.New("invalid username or password")
	ErrBadUsername  = errors.New("username must be 2-20 characters")
	ErrBadPassword  = errors.New("password must be at least 4 characters")
	ErrUnknownUser  = errors.New("unknown user")
	ErrInvalidToken = errors.New("invalid token")
	ErrBadInput     = errors.New("invalid input")
)

// DefaultSlots are the three independent default-look slots. A "tux" has no
// gender split; humanoids split into "male" and "female".
var DefaultSlots = []string{"tux", "male", "female"}

// globalKey is the settings key for the single look every brand-new player
// starts with (the "first character"), independent of body-type slot.
const globalKey = "globalDefaultCharacter"

// slotFor maps a character to its default slot.
func slotFor(c protocol.Character) string {
	if c.BodyType == "tux" {
		return "tux"
	}
	if c.Gender == "female" {
		return "female"
	}
	return "male"
}

// validSlot normalises an arbitrary slot string to one of DefaultSlots.
func validSlot(slot string) string {
	switch slot {
	case "tux", "male", "female":
		return slot
	default:
		return "male"
	}
}

// defaultKey is the settings key holding the default look for a slot.
func defaultKey(slot string) string { return "defaultCharacter:" + validSlot(slot) }

// Store is a concurrency-safe account + settings store backed by Postgres.
type Store struct {
	db     *sql.DB
	mu     sync.RWMutex      // guards the in-memory token cache
	tokens map[string]string // token -> canonical username (cache over sessions table)
	admin  string            // lowercase admin username (gets is_admin on touch)
}

// NewStore wraps an open *sql.DB (schema already migrated by pgdb.Open), loads
// the session cache, and flags adminUser as an admin if that account exists.
func NewStore(db *sql.DB, adminUser string) (*Store, error) {
	s := &Store{db: db, tokens: make(map[string]string), admin: key(adminUser)}
	if err := s.loadSessions(); err != nil {
		return nil, err
	}
	s.ensureAdmin()
	return s, nil
}

// loadSessions repopulates the in-memory token cache from the durable sessions
// table so logins survive a restart / redeploy.
func (s *Store) loadSessions() error {
	rows, err := s.db.Query(`SELECT token, username FROM sessions`)
	if err != nil {
		return err
	}
	defer rows.Close()
	s.mu.Lock()
	defer s.mu.Unlock()
	for rows.Next() {
		var token, uname string
		if err := rows.Scan(&token, &uname); err != nil {
			return err
		}
		s.tokens[token] = uname
	}
	return rows.Err()
}

// Close releases the database pool.
func (s *Store) Close() error { return s.db.Close() }

// DB exposes the pool so sibling stores (the marketplace) share one connection
// pool instead of opening their own.
func (s *Store) DB() *sql.DB { return s.db }

// key normalizes a username for case-insensitive lookups.
func key(username string) string { return strings.ToLower(strings.TrimSpace(username)) }

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ---- tokens / sessions ----

func (s *Store) newSession(uname string) (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}
	if _, err := s.db.Exec(
		`INSERT INTO sessions(token, username) VALUES ($1, $2)`, token, uname); err != nil {
		return "", err
	}
	s.mu.Lock()
	s.tokens[token] = uname
	s.mu.Unlock()
	return token, nil
}

func (s *Store) revokeUser(username string) {
	u := key(username)
	_, _ = s.db.Exec(`DELETE FROM sessions WHERE lower(username) = $1`, u)
	s.mu.Lock()
	for t, who := range s.tokens {
		if key(who) == u {
			delete(s.tokens, t)
		}
	}
	s.mu.Unlock()
}

// VerifyToken resolves a session token to its canonical username.
func (s *Store) VerifyToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	s.mu.RLock()
	uname, ok := s.tokens[token]
	s.mu.RUnlock()
	return uname, ok
}

// ---- default looks (admin-controlled) ----

// builtinFor is the fallback look for a slot when the admin has not set one.
func builtinFor(slot, name string) protocol.Character {
	if slot == "tux" {
		return protocol.Character{
			Name: name, BodyType: "tux", Gender: "male",
			Body: "#11131c", Belly: "#fdfdfd", Feet: "#ff9e2c", Skin: "#f3c69a",
			HairColor: "#b07a43", BeardColor: "#7a4a1f", Pants: "#33405c",
			CapeColor: "#ff5a3c", IrisColor: "#222a3a", MouthColor: "",
		}
	}
	c := protocol.Character{
		Name: name, BodyType: "humanoid", Gender: "male",
		Body: "#11131c", Belly: "#fdfdfd", Feet: "#5a3a22", Skin: "#f3c69a",
		HairColor: "#b07a43", BeardColor: "#7a4a1f", Pants: "#33405c",
		CapeColor: "#ff5a3c", IrisColor: "#222a3a", MouthColor: "",
		Fat: 0, Hair: 3, Beard: 3, ShirtStyle: 5, PantsStyle: 0, ShoeStyle: 0,
	}
	if slot == "female" {
		c.Gender = "female"
		c.Beard = 0
	}
	return c
}

// getSetting reads a Character stored under a settings key.
func (s *Store) getSetting(k string) (protocol.Character, bool) {
	var raw []byte
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = $1`, k).Scan(&raw)
	if err != nil {
		return protocol.Character{}, false
	}
	var c protocol.Character
	if json.Unmarshal(raw, &c) != nil {
		return protocol.Character{}, false
	}
	return c, true
}

// setSetting stores a Character under a settings key (upsert).
func (s *Store) setSetting(k string, c protocol.Character) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, k, string(data))
	return err
}

// DefaultCharacter returns the effective default look for a slot (admin-set if
// present, else the built-in), with the given name applied.
func (s *Store) DefaultCharacter(slot, name string) protocol.Character {
	if c, ok := s.getSetting(defaultKey(slot)); ok {
		c.Name = name
		return c
	}
	return builtinFor(validSlot(slot), name)
}

// GetDefaultCharacter returns the admin-set default for a slot, if one is stored.
func (s *Store) GetDefaultCharacter(slot string) (protocol.Character, bool) {
	return s.getSetting(defaultKey(slot))
}

// SetDefaultCharacter stores a character as the default for its own slot.
func (s *Store) SetDefaultCharacter(c protocol.Character) error {
	c.Name = ""
	return s.setSetting(defaultKey(slotFor(c)), c)
}

// GetGlobalDefault returns the single look new players start with, if set.
func (s *Store) GetGlobalDefault() (protocol.Character, bool) {
	return s.getSetting(globalKey)
}

// SetGlobalDefault stores the look every brand-new player starts with. It also
// writes the matching body-type slot default, so "the default for male
// characters" and "the first character new users see" stay in sync.
func (s *Store) SetGlobalDefault(c protocol.Character) error {
	c.Name = ""
	if err := s.setSetting(globalKey, c); err != nil {
		return err
	}
	return s.setSetting(defaultKey(slotFor(c)), c)
}

// AllDefaults returns the effective default look for every slot, keyed by slot,
// plus a "global" entry (the first-character look) when the admin has set one.
func (s *Store) AllDefaults(name string) map[string]protocol.Character {
	out := make(map[string]protocol.Character, len(DefaultSlots)+1)
	for _, slot := range DefaultSlots {
		out[slot] = s.DefaultCharacter(slot, name)
	}
	if g, ok := s.GetGlobalDefault(); ok {
		g.Name = name
		out["global"] = g
	}
	return out
}

// registerDefault is the look a brand-new account is created with: the global
// default if the admin set one, else the male built-in.
func (s *Store) registerDefault(name string) protocol.Character {
	if g, ok := s.GetGlobalDefault(); ok {
		g.Name = name
		return g
	}
	return s.DefaultCharacter("male", name)
}

// ---- accounts ----

func (s *Store) accountExists(k string) bool {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM accounts WHERE username = $1`, k).Scan(&one)
	return err == nil
}

// Register creates a new account and returns a session token + its character.
func (s *Store) Register(username, password string) (string, protocol.Character, error) {
	uname := strings.TrimSpace(username)
	if n := len([]rune(uname)); n < 2 || n > 20 {
		return "", protocol.Character{}, ErrBadUsername
	}
	if len(password) < 4 {
		return "", protocol.Character{}, ErrBadPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", protocol.Character{}, err
	}
	k := key(uname)
	ch := s.registerDefault(uname)
	chJSON, err := json.Marshal(ch)
	if err != nil {
		return "", protocol.Character{}, err
	}
	isAdmin := k == s.admin && s.admin != ""
	res, err := s.db.Exec(
		`INSERT INTO accounts(username, display, hash, is_admin, character)
		 VALUES ($1, $2, $3, $4, $5::jsonb)
		 ON CONFLICT (username) DO NOTHING`,
		k, uname, string(hash), isAdmin, string(chJSON))
	if err != nil {
		return "", protocol.Character{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", protocol.Character{}, ErrUserExists
	}
	token, err := s.newSession(uname)
	if err != nil {
		return "", protocol.Character{}, err
	}
	return token, ch, nil
}

// Login verifies credentials and returns a session token + the stored character.
func (s *Store) Login(username, password string) (string, protocol.Character, error) {
	var (
		display string
		hash    string
		chRaw   []byte
	)
	err := s.db.QueryRow(
		`SELECT display, hash, character FROM accounts WHERE username = $1`, key(username)).
		Scan(&display, &hash, &chRaw)
	if err == sql.ErrNoRows {
		// Throwaway compare to blunt username-enumeration timing leaks.
		_ = bcrypt.CompareHashAndPassword(
			[]byte("$2a$10$3euPcmQFCiblsZeEu5s7p.9OVHgeHWFDk9nhMqZ0m/3pd/lhwZgES"),
			[]byte(password))
		return "", protocol.Character{}, ErrBadCreds
	}
	if err != nil {
		return "", protocol.Character{}, err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return "", protocol.Character{}, ErrBadCreds
	}
	var ch protocol.Character
	_ = json.Unmarshal(chRaw, &ch)
	token, err := s.newSession(display)
	if err != nil {
		return "", protocol.Character{}, err
	}
	return token, ch, nil
}

// GetCharacter returns the stored character for a username.
func (s *Store) GetCharacter(username string) (protocol.Character, bool) {
	var chRaw []byte
	err := s.db.QueryRow(`SELECT character FROM accounts WHERE username = $1`, key(username)).Scan(&chRaw)
	if err != nil {
		return protocol.Character{}, false
	}
	var ch protocol.Character
	if json.Unmarshal(chRaw, &ch) != nil {
		return protocol.Character{}, false
	}
	return ch, true
}

// SetCharacter persists a new character for a username (all fields, incl. transforms).
func (s *Store) SetCharacter(username string, c protocol.Character) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(
		`UPDATE accounts SET character = $2::jsonb, updated_at = now() WHERE username = $1`,
		key(username), string(data))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownUser
	}
	return nil
}

// ---- 3D skins (Minecraft-compatible, stored as jsonb) ----

// defaultSkinKey is the settings key for the admin-set default skin: the look
// every visitor wears until they save a skin of their own. It lives alongside
// the legacy Character default keys in the same settings table; the parallel
// skin-typed helpers below never touch those.
const defaultSkinKey = "defaultSkin"

// GetSkin returns the user's saved 3D skin, if they have one.
func (s *Store) GetSkin(username string) (protocol.Skin, bool) {
	var raw []byte
	err := s.db.QueryRow(`SELECT skin FROM accounts WHERE username = $1`, key(username)).Scan(&raw)
	if err != nil || len(raw) == 0 {
		return protocol.Skin{}, false // no row, or skin column still NULL
	}
	var sk protocol.Skin
	if json.Unmarshal(raw, &sk) != nil || sk.PNG == "" {
		return protocol.Skin{}, false
	}
	return sk, true
}

// SetSkin validates (via the shared protocol validator, which also normalizes
// model/name in place) and persists the user's 3D skin.
func (s *Store) SetSkin(username string, sk protocol.Skin) error {
	if err := protocol.ValidateSkin(&sk); err != nil {
		return fmt.Errorf("%w: %v", ErrBadInput, err)
	}
	data, err := json.Marshal(sk)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(
		`UPDATE accounts SET skin = $2::jsonb, updated_at = now() WHERE username = $1`,
		key(username), string(data))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownUser
	}
	return nil
}

// getSkinSetting reads a Skin stored under a settings key. It deliberately
// mirrors getSetting (which is Character-typed) instead of reusing it, so the
// legacy character defaults keep working untouched.
func (s *Store) getSkinSetting(k string) (protocol.Skin, bool) {
	var raw []byte
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = $1`, k).Scan(&raw)
	if err != nil {
		return protocol.Skin{}, false
	}
	var sk protocol.Skin
	if json.Unmarshal(raw, &sk) != nil || sk.PNG == "" {
		return protocol.Skin{}, false
	}
	return sk, true
}

// setSkinSetting stores a Skin under a settings key (upsert).
func (s *Store) setSkinSetting(k string, sk protocol.Skin) error {
	data, err := json.Marshal(sk)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(
		`INSERT INTO settings(key, value) VALUES ($1, $2::jsonb)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, k, string(data))
	return err
}

// GetDefaultSkin returns the admin-set default skin, if one is stored.
func (s *Store) GetDefaultSkin() (protocol.Skin, bool) {
	return s.getSkinSetting(defaultSkinKey)
}

// SetDefaultSkin validates and stores the default skin every new visitor wears.
func (s *Store) SetDefaultSkin(sk protocol.Skin) error {
	if err := protocol.ValidateSkin(&sk); err != nil {
		return fmt.Errorf("%w: %v", ErrBadInput, err)
	}
	return s.setSkinSetting(defaultSkinKey, sk)
}

// ---- creative library (painted textures + presets) ----

// GetLibrary returns the user's stored texture library and presets. The texture
// map is never nil; presets may be nil when the user has none.
func (s *Store) GetLibrary(username string) (map[string]json.RawMessage, json.RawMessage, bool) {
	k := key(username)
	if !s.accountExists(k) {
		return map[string]json.RawMessage{}, nil, false
	}
	tex := map[string]json.RawMessage{}
	rows, err := s.db.Query(`SELECT tex_id, record FROM textures WHERE username = $1`, k)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var id string
			var rec []byte
			if rows.Scan(&id, &rec) == nil {
				tex[id] = json.RawMessage(append([]byte(nil), rec...))
			}
		}
	}
	var pre json.RawMessage
	var preRaw []byte
	if err := s.db.QueryRow(`SELECT presets FROM accounts WHERE username = $1`, k).Scan(&preRaw); err == nil && preRaw != nil {
		pre = json.RawMessage(preRaw)
	}
	return tex, pre, true
}

// SaveTexture stores (or replaces) one texture record in the user's library.
func (s *Store) SaveTexture(username, id string, rec json.RawMessage) error {
	if strings.TrimSpace(id) == "" || len(rec) == 0 {
		return ErrBadInput
	}
	k := key(username)
	if !s.accountExists(k) {
		return ErrUnknownUser
	}
	_, err := s.db.Exec(
		`INSERT INTO textures(username, tex_id, record) VALUES ($1, $2, $3::jsonb)
		 ON CONFLICT (username, tex_id) DO UPDATE SET record = EXCLUDED.record`,
		k, id, string(rec))
	if err != nil {
		return err
	}
	_, _ = s.db.Exec(`UPDATE accounts SET updated_at = now() WHERE username = $1`, k)
	return nil
}

// DeleteTexture removes one texture from the user's library (no error if absent).
func (s *Store) DeleteTexture(username, id string) error {
	k := key(username)
	if !s.accountExists(k) {
		return ErrUnknownUser
	}
	_, err := s.db.Exec(`DELETE FROM textures WHERE username = $1 AND tex_id = $2`, k, id)
	return err
}

// SetPresets replaces the user's saved character presets (opaque JSON array).
func (s *Store) SetPresets(username string, raw json.RawMessage) error {
	k := key(username)
	var arg interface{}
	if len(raw) == 0 {
		arg = nil
	} else {
		arg = string(raw)
	}
	res, err := s.db.Exec(
		`UPDATE accounts SET presets = $2::jsonb, updated_at = now() WHERE username = $1`, k, arg)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownUser
	}
	return nil
}

// MergeLibrary folds anonymous/guest work into the account WITHOUT clobbering
// what is already there: texture ids not yet present are added; presets passed in
// are appended after the existing ones. Returns the resulting library.
func (s *Store) MergeLibrary(username string, tex map[string]json.RawMessage, pre json.RawMessage) (map[string]json.RawMessage, json.RawMessage, error) {
	k := key(username)
	tx, err := s.db.Begin()
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()

	var existingPre []byte
	if err := tx.QueryRow(`SELECT presets FROM accounts WHERE username = $1`, k).Scan(&existingPre); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil, ErrUnknownUser
		}
		return nil, nil, err
	}
	for id, rec := range tex {
		if id == "" || len(rec) == 0 {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO textures(username, tex_id, record) VALUES ($1, $2, $3::jsonb)
			 ON CONFLICT (username, tex_id) DO NOTHING`, k, id, string(rec)); err != nil {
			return nil, nil, err
		}
	}
	merged := appendPresets(existingPre, pre)
	var preArg interface{}
	if len(merged) == 0 {
		preArg = nil
	} else {
		preArg = string(merged)
	}
	if _, err := tx.Exec(
		`UPDATE accounts SET presets = $2::jsonb, updated_at = now() WHERE username = $1`, k, preArg); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	outTex, outPre, _ := s.GetLibrary(username)
	return outTex, outPre, nil
}

// appendPresets concatenates two JSON preset arrays, tolerating nils/garbage.
func appendPresets(existing, incoming json.RawMessage) json.RawMessage {
	var a, b []json.RawMessage
	if len(existing) > 0 {
		_ = json.Unmarshal(existing, &a)
	}
	if len(incoming) > 0 {
		_ = json.Unmarshal(incoming, &b)
	}
	if len(b) == 0 {
		if len(existing) > 0 {
			return existing
		}
		return nil
	}
	merged := append(a, b...)
	out, err := json.Marshal(merged)
	if err != nil {
		return existing
	}
	return out
}

// IsAdmin reports whether the user may set the global default character.
func (s *Store) IsAdmin(username string) bool {
	var admin bool
	err := s.db.QueryRow(`SELECT is_admin FROM accounts WHERE username = $1`, key(username)).Scan(&admin)
	if err != nil {
		return false
	}
	return admin
}

// ---- GDPR: access + erasure ----

// ExportAccount returns every piece of personal data held for the user (GDPR
// access / portability). The password hash is intentionally excluded.
func (s *Store) ExportAccount(username string) (map[string]interface{}, bool) {
	k := key(username)
	var (
		display   string
		isAdmin   bool
		chRaw     []byte
		skRaw     []byte
		preRaw    []byte
		createdAt sql.NullTime
		updatedAt sql.NullTime
	)
	err := s.db.QueryRow(
		`SELECT display, is_admin, character, skin, presets, created_at, updated_at
		 FROM accounts WHERE username = $1`, k).
		Scan(&display, &isAdmin, &chRaw, &skRaw, &preRaw, &createdAt, &updatedAt)
	if err != nil {
		return nil, false
	}
	var ch protocol.Character
	_ = json.Unmarshal(chRaw, &ch)
	textures, presets, _ := s.GetLibrary(username)
	var pre interface{}
	if len(presets) > 0 {
		pre = presets
	}
	out := map[string]interface{}{
		"username":  display,
		"character": ch,
		"textures":  textures,
		"presets":   pre,
		"isAdmin":   isAdmin,
		"createdAt": timeStr(createdAt),
		"updatedAt": timeStr(updatedAt),
		"note":      "This is all personal data we store about your account: your username, character, 3D skin, painted textures and saved presets. Your password is kept only as a one-way bcrypt hash and is never exported. No email, IP address, or tracking data is collected.",
	}
	if len(skRaw) > 0 {
		var sk protocol.Skin
		if json.Unmarshal(skRaw, &sk) == nil && sk.PNG != "" {
			out["skin"] = sk
		}
	}
	return out, true
}

func timeStr(t sql.NullTime) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format("2006-01-02T15:04:05Z07:00")
}

// DeleteAccount erases the account and all its data, and revokes its sessions
// (textures + sessions cascade via foreign keys).
func (s *Store) DeleteAccount(username string) error {
	k := key(username)
	res, err := s.db.Exec(`DELETE FROM accounts WHERE username = $1`, k)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownUser
	}
	// Drop cached tokens for the deleted user (sessions rows are gone via cascade).
	s.mu.Lock()
	for t, who := range s.tokens {
		if key(who) == k {
			delete(s.tokens, t)
		}
	}
	s.mu.Unlock()
	return nil
}

// ---- maintenance ----

// ensureAdmin flags the configured admin account (if it exists) as admin.
func (s *Store) ensureAdmin() {
	if s.admin == "" {
		return
	}
	_, _ = s.db.Exec(`UPDATE accounts SET is_admin = true WHERE username = $1`, s.admin)
}
