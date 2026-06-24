// Package accounts is the account + settings store for TUX SMASH ROYALE.
//
// Storage is a proper embedded database: bbolt (go.etcd.io/bbolt), the pure-Go,
// ACID, single-file transactional key/value engine that powers etcd and Consul.
// It keeps the project a single static binary (no cgo, no external DB service),
// while giving real transactions, crash safety and a file we can lock down on
// the data volume (0600). There is no SQL, so there is no injection surface;
// passwords are only ever stored as bcrypt hashes.
//
// Two buckets:
//   "accounts" : lower(username) -> JSON account{username,hash,character,isAdmin,timestamps}
//   "settings" : "defaultCharacter" -> JSON Character set by the admin (loaded for everyone)
//
// Session tokens are random bearer tokens kept only in memory (not personal data
// at rest). A one-time migration imports any legacy accounts.json on first boot.
package accounts

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"clobi/internal/protocol"

	bolt "go.etcd.io/bbolt"
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
)

var (
	bAccounts    = []byte("accounts")
	bSettings    = []byte("settings")
	kDefaultChar = []byte("defaultCharacter") // legacy single-default key (migrated to slots)
)

// DefaultSlots are the three independent default-look slots. A "tux" has no
// gender split; humanoids split into "male" and "female".
var DefaultSlots = []string{"tux", "male", "female"}

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

// defaultKey is the settings-bucket key holding the default for a slot.
func defaultKey(slot string) []byte { return []byte("defaultCharacter:" + validSlot(slot)) }

// account is the stored record for one user (JSON-encoded in the accounts bucket).
type account struct {
	Username  string             `json:"username"`
	Hash      string             `json:"hash"`
	Character protocol.Character `json:"character"`
	IsAdmin   bool               `json:"isAdmin"`
	CreatedAt string             `json:"createdAt"`
	UpdatedAt string             `json:"updatedAt"`
}

// Store is a concurrency-safe account + settings store backed by bbolt.
type Store struct {
	db     *bolt.DB
	mu     sync.Mutex        // guards tokens only (bbolt has its own locking)
	tokens map[string]string // token -> canonical username (in-memory only)
	admin  string            // lowercase admin username (gets isAdmin on touch)
}

// NewStore opens (creating if needed) the bbolt database under dataDir, ensures
// the buckets exist, migrates any legacy accounts.json once, and marks adminUser
// as an admin. The DB file is created mode 0600.
func NewStore(dataDir, adminUser string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dataDir, "clobi.db"), 0o600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	s := &Store{db: db, tokens: make(map[string]string), admin: key(adminUser)}
	if err := db.Update(func(tx *bolt.Tx) error {
		if _, e := tx.CreateBucketIfNotExists(bAccounts); e != nil {
			return e
		}
		_, e := tx.CreateBucketIfNotExists(bSettings)
		return e
	}); err != nil {
		_ = db.Close()
		return nil, err
	}
	s.migrateJSON(filepath.Join(dataDir, "accounts.json"))
	s.migrateDefaults()
	s.ensureAdmin()
	return s, nil
}

// migrateDefaults upgrades the legacy single "defaultCharacter" setting to the
// per-slot scheme: it copies the old value into the slot matching its body
// type/gender (only if that slot is still empty), then removes the legacy key.
func (s *Store) migrateDefaults() {
	_ = s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bSettings)
		v := b.Get(kDefaultChar)
		if v == nil {
			return nil
		}
		var c protocol.Character
		if json.Unmarshal(v, &c) == nil {
			slot := slotFor(c)
			if b.Get(defaultKey(slot)) == nil {
				c.Name = ""
				if data, err := json.Marshal(c); err == nil {
					_ = b.Put(defaultKey(slot), data)
				}
			}
		}
		return b.Delete(kDefaultChar)
	})
}

// Close releases the database file.
func (s *Store) Close() error { return s.db.Close() }

// key normalizes a username for case-insensitive lookups.
func key(username string) string { return strings.ToLower(strings.TrimSpace(username)) }

func nowStr() string { return time.Now().UTC().Format(time.RFC3339) }

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *Store) getAccount(tx *bolt.Tx, k string) (account, bool) {
	v := tx.Bucket(bAccounts).Get([]byte(k))
	if v == nil {
		return account{}, false
	}
	var a account
	if json.Unmarshal(v, &a) != nil {
		return account{}, false
	}
	return a, true
}

func (s *Store) putAccount(tx *bolt.Tx, k string, a account) error {
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return tx.Bucket(bAccounts).Put([]byte(k), data)
}

// ---- tokens (in-memory sessions) ----

func (s *Store) newSession(uname string) (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.tokens[token] = uname
	s.mu.Unlock()
	return token, nil
}

func (s *Store) revokeUser(username string) {
	u := strings.TrimSpace(username)
	s.mu.Lock()
	for t, who := range s.tokens {
		if strings.EqualFold(who, u) {
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
	s.mu.Lock()
	defer s.mu.Unlock()
	uname, ok := s.tokens[token]
	return uname, ok
}

// ---- default character (admin-controlled, loaded for everyone) ----

// builtinFor is the fallback look for a slot when the admin has not set one:
//   - "tux":    the classic black-and-white penguin with orange feet.
//   - "male":   a male humanoid "Clobi" — light-brown ponytail, full beard.
//   - "female": the same humanoid, female silhouette, no beard.
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
		c.Beard = 0 // no beard on the female default
	}
	return c
}

// DefaultCharacter returns the effective default look for a slot (admin-set if
// present, else the built-in), with the given name applied.
func (s *Store) DefaultCharacter(slot, name string) protocol.Character {
	if c, ok := s.GetDefaultCharacter(slot); ok {
		c.Name = name
		return c
	}
	return builtinFor(validSlot(slot), name)
}

// AllDefaults returns the effective default look for every slot, keyed by slot.
func (s *Store) AllDefaults(name string) map[string]protocol.Character {
	out := make(map[string]protocol.Character, len(DefaultSlots))
	for _, slot := range DefaultSlots {
		out[slot] = s.DefaultCharacter(slot, name)
	}
	return out
}

// GetDefaultCharacter returns the admin-set default for a slot, if one is stored.
func (s *Store) GetDefaultCharacter(slot string) (protocol.Character, bool) {
	var c protocol.Character
	found := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bSettings).Get(defaultKey(slot))
		if v != nil && json.Unmarshal(v, &c) == nil {
			found = true
		}
		return nil
	})
	return c, found
}

// SetDefaultCharacter stores a character as the default for its own slot (the
// slot is derived from the character's body type / gender).
func (s *Store) SetDefaultCharacter(c protocol.Character) error {
	slot := slotFor(c)
	c.Name = "" // a shared default carries no personal name
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bSettings).Put(defaultKey(slot), data)
	})
}

// ---- accounts ----

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
	ch := s.DefaultCharacter("male", uname)
	k := key(uname)
	now := nowStr()
	err = s.db.Update(func(tx *bolt.Tx) error {
		if _, ok := s.getAccount(tx, k); ok {
			return ErrUserExists
		}
		return s.putAccount(tx, k, account{
			Username: uname, Hash: string(hash), Character: ch,
			IsAdmin: k == s.admin && s.admin != "", CreatedAt: now, UpdatedAt: now,
		})
	})
	if err != nil {
		return "", protocol.Character{}, err
	}
	token, err := s.newSession(uname)
	if err != nil {
		return "", protocol.Character{}, err
	}
	return token, ch, nil
}

// Login verifies credentials and returns a session token + the stored character.
func (s *Store) Login(username, password string) (string, protocol.Character, error) {
	var acc account
	ok := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		acc, ok = s.getAccount(tx, key(username))
		return nil
	})
	if !ok {
		// Throwaway compare to blunt username-enumeration timing leaks.
		_ = bcrypt.CompareHashAndPassword(
			[]byte("$2a$10$3euPcmQFCiblsZeEu5s7p.9OVHgeHWFDk9nhMqZ0m/3pd/lhwZgES"),
			[]byte(password))
		return "", protocol.Character{}, ErrBadCreds
	}
	if err := bcrypt.CompareHashAndPassword([]byte(acc.Hash), []byte(password)); err != nil {
		return "", protocol.Character{}, ErrBadCreds
	}
	token, err := s.newSession(acc.Username)
	if err != nil {
		return "", protocol.Character{}, err
	}
	return token, acc.Character, nil
}

// GetCharacter returns the stored character for a username.
func (s *Store) GetCharacter(username string) (protocol.Character, bool) {
	var ch protocol.Character
	found := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		a, ok := s.getAccount(tx, key(username))
		if ok {
			ch, found = a.Character, true
		}
		return nil
	})
	return ch, found
}

// SetCharacter persists a new character for a username (preserves all fields,
// including per-object transforms).
func (s *Store) SetCharacter(username string, c protocol.Character) error {
	k := key(username)
	return s.db.Update(func(tx *bolt.Tx) error {
		a, ok := s.getAccount(tx, k)
		if !ok {
			return ErrUnknownUser
		}
		a.Character = c
		a.UpdatedAt = nowStr()
		return s.putAccount(tx, k, a)
	})
}

// IsAdmin reports whether the user may set the global default character.
func (s *Store) IsAdmin(username string) bool {
	admin := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		if a, ok := s.getAccount(tx, key(username)); ok {
			admin = a.IsAdmin
		}
		return nil
	})
	return admin
}

// ---- GDPR: access + erasure ----

// ExportAccount returns every piece of personal data held for the user, for the
// GDPR right of access / data portability. The password hash is intentionally
// excluded (a one-way bcrypt hash is not exported).
func (s *Store) ExportAccount(username string) (map[string]interface{}, bool) {
	var out map[string]interface{}
	ok := false
	_ = s.db.View(func(tx *bolt.Tx) error {
		a, found := s.getAccount(tx, key(username))
		if !found {
			return nil
		}
		ok = true
		out = map[string]interface{}{
			"username":  a.Username,
			"character": a.Character,
			"isAdmin":   a.IsAdmin,
			"createdAt": a.CreatedAt,
			"updatedAt": a.UpdatedAt,
			"note":      "This is all personal data we store about your account. Your password is kept only as a one-way bcrypt hash and is never exported. No email, IP address, or tracking data is collected.",
		}
		return nil
	})
	return out, ok
}

// DeleteAccount erases the account and all its data, and revokes its sessions
// (GDPR right to erasure).
func (s *Store) DeleteAccount(username string) error {
	k := key(username)
	err := s.db.Update(func(tx *bolt.Tx) error {
		if _, ok := s.getAccount(tx, k); !ok {
			return ErrUnknownUser
		}
		return tx.Bucket(bAccounts).Delete([]byte(k))
	})
	if err == nil {
		s.revokeUser(username)
	}
	return err
}

// ---- maintenance ----

// ensureAdmin flags the configured admin account (if it exists) as admin.
func (s *Store) ensureAdmin() {
	if s.admin == "" {
		return
	}
	_ = s.db.Update(func(tx *bolt.Tx) error {
		a, ok := s.getAccount(tx, s.admin)
		if ok && !a.IsAdmin {
			a.IsAdmin = true
			return s.putAccount(tx, s.admin, a)
		}
		return nil
	})
}

// migrateJSON imports a legacy accounts.json exactly once (when the accounts
// bucket is still empty), then renames the file so it is not re-imported and no
// stale copy of the data lingers on disk.
func (s *Store) migrateJSON(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var model struct {
		Accounts map[string]struct {
			Username  string             `json:"username"`
			Hash      string             `json:"hash"`
			Character protocol.Character `json:"character"`
		} `json:"accounts"`
	}
	if json.Unmarshal(data, &model) != nil || len(model.Accounts) == 0 {
		_ = os.Rename(path, path+".imported")
		return
	}
	_ = s.db.Update(func(tx *bolt.Tx) error {
		if tx.Bucket(bAccounts).Stats().KeyN > 0 {
			return nil // already populated; don't clobber
		}
		now := nowStr()
		for k, old := range model.Accounts {
			lk := key(k)
			_ = s.putAccount(tx, lk, account{
				Username: old.Username, Hash: old.Hash, Character: old.Character,
				IsAdmin: lk == s.admin && s.admin != "", CreatedAt: now, UpdatedAt: now,
			})
		}
		return nil
	})
	_ = os.Rename(path, path+".imported")
}
