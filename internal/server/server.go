// Package server is the HTTP/WebSocket transport for TUX SMASH ROYALE. It wires
// together the account store, the rooms Hub, the REST account API, and a static
// file handler for the web client, then serves them all from one net/http mux.
//
// The simulation and lobby logic live in the game and rooms packages; this layer
// only handles transport concerns: routing, auth, the gorilla WebSocket upgrade,
// and the per-connection read/write pumps.
package server

import (
	"crypto/rand"
	"encoding/hex"
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
	"clobi/internal/rooms"

	"github.com/gorilla/websocket"
)

// WebSocket pump tuning.
const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 1 << 16 // 64 KiB inbound frame cap
)

// upgrader turns an HTTP request into a WebSocket. Origin is permitted from any
// host: this is a self-hosted hobby game with no cookies/sessions on the socket
// (the WS itself carries no credentials), so CSRF is not a concern here.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// server bundles the long-lived dependencies shared across handlers.
type server struct {
	acc    *accounts.Store
	hub    *rooms.Hub
	webDir string
}

// Run builds the HTTP mux and serves until ListenAndServe returns. addr is the
// listen address (e.g. ":1337"), webDir is the static client directory, dataDir
// is where the accounts JSON file lives.
func Run(addr, webDir, dataDir string) error {
	acc, err := accounts.NewStore(filepath.Join(dataDir, "accounts.json"))
	if err != nil {
		return err
	}

	absWeb, err := filepath.Abs(webDir)
	if err != nil {
		return err
	}

	s := &server{
		acc:    acc,
		hub:    rooms.NewHub(acc),
		webDir: absWeb,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/register", s.handleRegister)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/character", s.handleCharacter)
	mux.HandleFunc("/ws", s.handleWS)
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

// ---- WebSocket ----

// handleWS upgrades the connection, registers a Client with the Hub, and runs
// the read and write pumps. The connection lifecycle is fully owned here.
func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // upgrader already wrote an error response
	}

	client := rooms.NewClient(s.hub, newConnID())
	s.hub.Register(client)

	// Write pump runs in its own goroutine; read pump runs here. When the read
	// pump returns the connection is closing, so unregister and let the write
	// pump observe the closed channel.
	go s.writePump(conn, client)
	s.readPump(conn, client)
}

// readPump reads frames off the socket, decodes each into an Envelope, and hands
// it to the Hub until the client disconnects or sends garbage.
func (s *server) readPump(conn *websocket.Conn, client *rooms.Client) {
	defer func() {
		s.hub.Unregister(client)
		_ = conn.Close()
	}()

	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue // ignore malformed frames rather than dropping the client
		}
		s.hub.Handle(client, env)
	}
}

// writePump drains the client's send channel onto the socket and emits periodic
// pings. It exits when the channel is closed (by Hub.Unregister) or a write
// fails.
func (s *server) writePump(conn *websocket.Conn, client *rooms.Client) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = conn.Close()
	}()

	for {
		select {
		case env, ok := <-client.Send:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel: tell the peer and stop.
				_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(
					websocket.CloseNormalClosure, ""))
				return
			}
			if err := conn.WriteJSON(env); err != nil {
				return
			}
		case <-ticker.C:
			_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// newConnID returns a short random hex id for a connection/player.
func newConnID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		// Fall back to a time-derived id; uniqueness is best-effort for ids.
		return "p" + hex.EncodeToString([]byte(time.Now().Format("150405.000000")))
	}
	return "p" + hex.EncodeToString(b)
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
