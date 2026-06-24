// Package server is the HTTP transport for Clobi's Arena. It wires together the
// account store, the REST account API, and a static file handler for the web
// client, then serves them all from one net/http mux.
//
// The realtime PvP gamemodes and their WebSocket transport have been retired;
// this layer now handles only HTTP concerns: routing, auth, the account/character
// REST API, and serving the static creator + marketplace client.
package server

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"clobi/internal/accounts"
	"clobi/internal/protocol"
)

// server bundles the long-lived dependencies shared across handlers.
type server struct {
	acc    *accounts.Store
	webDir string
}

// Run builds the HTTP mux and serves until ListenAndServe returns. addr is the
// listen address (e.g. ":1337"), webDir is the static client directory, dataDir
// is where the bbolt database lives.
func Run(addr, webDir, dataDir string) error {
	adminUser := os.Getenv("ADMIN_USER")
	if adminUser == "" {
		adminUser = "fabiocg"
	}
	acc, err := accounts.NewStore(dataDir, adminUser)
	if err != nil {
		return err
	}

	absWeb, err := filepath.Abs(webDir)
	if err != nil {
		return err
	}

	s := &server{
		acc:    acc,
		webDir: absWeb,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/register", s.handleRegister)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/character", s.handleCharacter)
	mux.HandleFunc("/api/default-character", s.handleDefaultCharacter)
	mux.HandleFunc("/api/admin/default", s.handleAdminDefault)
	mux.HandleFunc("/api/account/export", s.handleExport)
	mux.HandleFunc("/api/account", s.handleAccount)
	mux.HandleFunc("/", s.handleStatic)

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv.ListenAndServe()
}

// ---- REST: accounts ----

type authResponse struct {
	Token     string             `json:"token"`
	Username  string             `json:"username"`
	Character protocol.Character `json:"character"`
	IsAdmin   bool               `json:"isAdmin"`
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var creds credentials
	if err := decodeJSON(r, &creds); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	token, ch, err := s.acc.Register(creds.Username, creds.Password)
	if err != nil {
		writeError(w, registerStatus(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, authResponse{
		Token:     token,
		Username:  strings.TrimSpace(creds.Username),
		Character: ch,
		IsAdmin:   s.acc.IsAdmin(strings.TrimSpace(creds.Username)),
	})
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var creds credentials
	if err := decodeJSON(r, &creds); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	token, ch, err := s.acc.Login(creds.Username, creds.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	writeJSON(w, http.StatusOK, authResponse{
		Token:     token,
		Username:  strings.TrimSpace(creds.Username),
		Character: ch,
		IsAdmin:   s.acc.IsAdmin(strings.TrimSpace(creds.Username)),
	})
}

// handleCharacter serves GET (read the cloud-stored character) and PUT (save a
// character). Both require a valid Bearer token.
func (s *server) handleCharacter(w http.ResponseWriter, r *http.Request) {
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}

	switch r.Method {
	case http.MethodGet:
		ch, found := s.acc.GetCharacter(username)
		if !found {
			writeError(w, http.StatusNotFound, "no character")
			return
		}
		writeJSON(w, http.StatusOK, ch)

	case http.MethodPut:
		var ch protocol.Character
		if err := decodeJSON(r, &ch); err != nil {
			writeError(w, http.StatusBadRequest, "invalid character body")
			return
		}
		if ch.BodyType != "tux" && ch.BodyType != "humanoid" {
			ch.BodyType = "tux"
		}
		if err := s.acc.SetCharacter(username, ch); err != nil {
			writeError(w, http.StatusInternalServerError, "could not save character")
			return
		}
		writeJSON(w, http.StatusOK, ch)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleDefaultCharacter (GET, public) returns the looks new players start with:
// the admin-set default per body-type slot (tux / male / female) if set, else
// the built-ins. Response shape: {"tux":{...},"male":{...},"female":{...}}.
func (s *server) handleDefaultCharacter(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, s.acc.AllDefaults(""))
}

// handleAdminDefault (POST, admin only) sets the default character for the body
// type slot of the posted character (derived from its bodyType/gender), loaded
// automatically for everyone who has not customised their own.
func (s *server) handleAdminDefault(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	if !s.acc.IsAdmin(username) {
		writeError(w, http.StatusForbidden, "admin only")
		return
	}
	var ch protocol.Character
	if err := decodeJSON(r, &ch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid character body")
		return
	}
	if ch.BodyType != "tux" && ch.BodyType != "humanoid" {
		ch.BodyType = "humanoid"
	}
	if err := s.acc.SetDefaultCharacter(ch); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save default")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleExport (GET, auth) returns all personal data for the user (GDPR access).
func (s *server) handleExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	data, found := s.acc.ExportAccount(username)
	if !found {
		writeError(w, http.StatusNotFound, "no account")
		return
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\"clobi-my-data.json\"")
	writeJSON(w, http.StatusOK, data)
}

// handleAccount (DELETE, auth) erases the account and all its data (GDPR erasure).
func (s *server) handleAccount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	if err := s.acc.DeleteAccount(username); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete account")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// authUser extracts and verifies a Bearer token from the Authorization header.
func (s *server) authUser(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return "", false
	}
	token := strings.TrimSpace(h[len(prefix):])
	return s.acc.VerifyToken(token)
}

func registerStatus(err error) int {
	switch {
	case errors.Is(err, accounts.ErrUserExists):
		return http.StatusConflict
	case errors.Is(err, accounts.ErrBadUsername), errors.Is(err, accounts.ErrBadPassword):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

// ---- static files ----

// handleStatic serves the web client directory, defends against path traversal,
// and falls back to index.html for the root.
func (s *server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Clean and confine the request path to the web directory.
	upath := r.URL.Path
	if upath == "" || upath == "/" {
		upath = "/index.html"
	}
	clean := path.Clean("/" + upath) // always starts with "/", strips ".."
	full := filepath.Join(s.webDir, filepath.FromSlash(clean))

	// Verify the resolved path is still inside webDir (belt-and-suspenders
	// against traversal even though path.Clean already neutralizes "..").
	rel, err := filepath.Rel(s.webDir, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}

	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		// Missing file or a directory request: serve index.html so the SPA-ish
		// client can boot. Directory listings are never exposed.
		full = filepath.Join(s.webDir, "index.html")
		if _, err := os.Stat(full); err != nil {
			http.NotFound(w, r)
			return
		}
	}

	if ct := contentTypeFor(full); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	// Revalidate instead of serving stale: ServeFile still sends Last-Modified, so
	// caches (browser + Cloudflare) do a conditional request and pick up a redeploy
	// immediately rather than serving old JS/textures for hours.
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, full)
}

// contentTypeFor returns an explicit content type for known web extensions so
// the client always gets correct MIME types regardless of OS registry quirks.
func contentTypeFor(full string) string {
	switch strings.ToLower(filepath.Ext(full)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".ico":
		return "image/x-icon"
	case ".png":
		return "image/png"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	default:
		if ct := mime.TypeByExtension(filepath.Ext(full)); ct != "" {
			return ct
		}
		return ""
	}
}

// ---- JSON helpers ----

func decodeJSON(r *http.Request, dst interface{}) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	return dec.Decode(dst)
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
