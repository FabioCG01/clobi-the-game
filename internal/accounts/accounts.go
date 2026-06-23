// Package accounts provides a tiny, dependency-free account store for
// TUX SMASH ROYALE: bcrypt-hashed passwords persisted to a single JSON file
// guarded by a mutex, plus per-login random bearer tokens kept only in memory.
//
// There is no database and no cgo. Plaintext passwords are never stored.
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

	"clobi/internal/protocol"

	"golang.org/x/crypto/bcrypt"
)

// Errors returned by the Store. Callers may compare against these with
// errors.Is.
var (
	ErrUserExists   = errors.New("username already taken")
	ErrBadCreds     = errors.New("invalid username or password")
	ErrBadUsername  = errors.New("username must be 2-20 characters")
	ErrBadPassword  = errors.New("password must be at least 4 characters")
	ErrUnknownUser  = errors.New("unknown user")
	ErrInvalidToken = errors.New("invalid token")
)

// account is the on-disk record for one user.
type account struct {
	Username  string             `json:"username"`
	Hash      string             `json:"hash"`
	Character protocol.Character `json:"character"`
}

// fileModel is the JSON document persisted to disk.
type fileModel struct {
	Accounts map[string]account `json:"accounts"`
}

// Store is a concurrency-safe account store backed by a JSON file.
type Store struct {
	mu       sync.Mutex
	path     string
	accounts map[string]account // keyed by lowercase username
	tokens   map[string]string  // token -> canonical username (in-memory only)
}

// NewStore loads the JSON file at path, creating it (and parent dirs) if it does
// not yet exist.
func NewStore(path string) (*Store, error) {
	s := &Store{
		path:     path,
		accounts: make(map[string]account),
		tokens:   make(map[string]string),
	}

	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// Fresh start: write an empty document so the file exists.
			if werr := s.persistLocked(); werr != nil {
				return nil, werr
			}
			return s, nil
		}
		return nil, err
	}

	if len(strings.TrimSpace(string(data))) == 0 {
		return s, nil
	}

	var model fileModel
	if err := json.Unmarshal(data, &model); err != nil {
		return nil, err
	}
	if model.Accounts != nil {
		s.accounts = model.Accounts
	}
	return s, nil
}

// key normalizes a username for case-insensitive lookups.
func key(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// persistLocked writes the current account map to disk atomically. The caller
// must hold s.mu.
func (s *Store) persistLocked() error {
	model := fileModel{Accounts: s.accounts}
	data, err := json.MarshalIndent(model, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// newToken returns a cryptographically random hex token.
func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// defaultCharacter returns the classic Tux used for brand-new accounts. The
// indices line up with the client's Sprites.PARTS default selection.
func defaultCharacter(name string) protocol.Character {
	return protocol.Character{
		Name:       name,
		BodyType:   "humanoid",
		Gender:     "male",
		Body:       "#11131c",
		Belly:      "#fdfdfd",
		Feet:       "#5a3a22",
		Skin:       "#f3c69a",
		HairColor:  "#b07a43",
		BeardColor: "#7a4a1f",
		Pants:      "#33405c",
		CapeColor:  "#ff5a3c",
		IrisColor:  "#222a3a",
		MouthColor: "",
		Fat:        0,
		Hair:       3, // ponytail
		Beard:      2, // clobi (around the mouth)
		ShirtStyle: 0,
		PantsStyle: 0,
		ShoeStyle:  0,
		Hat:        0,
		Eyes:       0,
		Eyebrows:   0,
		Mouth:      0,
		Accessory:  0,
		Cape:       0,
	}
}

// Register creates a new account, returning a fresh session token and the
// account's (default) character.
func (s *Store) Register(username, password string) (string, protocol.Character, error) {
	uname := strings.TrimSpace(username)
	if n := len([]rune(uname)); n < 2 || n > 20 {
		return "", protocol.Character{}, ErrBadUsername
	}
	if len(password) < 4 {
		return "", protocol.Character{}, ErrBadPassword
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	k := key(uname)
	if _, exists := s.accounts[k]; exists {
		return "", protocol.Character{}, ErrUserExists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", protocol.Character{}, err
	}

	acc := account{
		Username:  uname,
		Hash:      string(hash),
		Character: defaultCharacter(uname),
	}
	s.accounts[k] = acc

	if err := s.persistLocked(); err != nil {
		delete(s.accounts, k)
		return "", protocol.Character{}, err
	}

	token, err := newToken()
	if err != nil {
		return "", protocol.Character{}, err
	}
	s.tokens[token] = uname
	return token, acc.Character, nil
}

// Login verifies credentials and returns a fresh session token plus the stored
// character.
func (s *Store) Login(username, password string) (string, protocol.Character, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	acc, ok := s.accounts[key(username)]
	if !ok {
		// Run a throwaway compare to reduce username-enumeration timing leaks.
		_ = bcrypt.CompareHashAndPassword(
			[]byte("$2a$10$3euPcmQFCiblsZeEu5s7p.9OVHgeHWFDk9nhMqZ0m/3pd/lhwZgES"),
			[]byte(password),
		)
		return "", protocol.Character{}, ErrBadCreds
	}
	if err := bcrypt.CompareHashAndPassword([]byte(acc.Hash), []byte(password)); err != nil {
		return "", protocol.Character{}, ErrBadCreds
	}

	token, err := newToken()
	if err != nil {
		return "", protocol.Character{}, err
	}
	s.tokens[token] = acc.Username
	return token, acc.Character, nil
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

// GetCharacter returns the stored character for a username.
func (s *Store) GetCharacter(username string) (protocol.Character, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	acc, ok := s.accounts[key(username)]
	if !ok {
		return protocol.Character{}, false
	}
	return acc.Character, true
}

// SetCharacter persists a new character for a username.
func (s *Store) SetCharacter(username string, c protocol.Character) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	k := key(username)
	acc, ok := s.accounts[k]
	if !ok {
		return ErrUnknownUser
	}
	prev := acc.Character
	acc.Character = c
	s.accounts[k] = acc

	if err := s.persistLocked(); err != nil {
		acc.Character = prev
		s.accounts[k] = acc
		return err
	}
	return nil
}
