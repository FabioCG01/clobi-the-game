// Package server is the HTTP transport for Clobi's Arena. It wires together the
// account store, the REST account/worlds/rooms/friends APIs, the /ws/room
// multiplayer WebSocket upgrade, and a static file handler for the web client,
// then serves them all from one net/http mux.
//
// The old realtime PvP gamemodes (Tux Smash / Distro Royale) and their bespoke
// WebSocket transport were retired during the 3D revamp. Part II reintroduces a
// WebSocket, but for a different purpose: persistent, server-authoritative
// co-op voxel worlds (internal/rooms), not PvP matches.
package server

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"clobi/internal/accounts"
	"clobi/internal/market"
	"clobi/internal/pgdb"
	"clobi/internal/protocol"
	"clobi/internal/rooms"
	"clobi/internal/social"
	"clobi/internal/worlds"
	"clobi/internal/ws"
)

// server bundles the long-lived dependencies shared across handlers.
type server struct {
	acc    *accounts.Store
	mkt    *market.Store
	wld    *worlds.Store
	soc    *social.Store
	rms    *rooms.Manager
	webDir string
}

// Run builds the HTTP mux and serves until ListenAndServe returns. addr is the
// listen address (e.g. ":1337"), webDir is the static client directory, dsn is
// the PostgreSQL connection URL.
func Run(addr, webDir, dsn string) error {
	adminUser := os.Getenv("ADMIN_USER")
	if adminUser == "" {
		adminUser = "fabiocg"
	}
	db, err := pgdb.Open(dsn)
	if err != nil {
		return err
	}
	acc, err := accounts.NewStore(db, adminUser)
	if err != nil {
		return err
	}
	mkt, err := market.NewStore(acc.DB())
	if err != nil {
		return err
	}
	wld, err := worlds.NewStore(acc.DB())
	if err != nil {
		return err
	}
	soc, err := social.NewStore(acc.DB())
	if err != nil {
		return err
	}
	rms := rooms.NewManager(wld, acc.VerifyToken, soc)

	absWeb, err := filepath.Abs(webDir)
	if err != nil {
		return err
	}

	s := &server{
		acc:    acc,
		mkt:    mkt,
		wld:    wld,
		soc:    soc,
		rms:    rms,
		webDir: absWeb,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/register", s.handleRegister)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/character", s.handleCharacter)
	mux.HandleFunc("/api/default-character", s.handleDefaultCharacter)
	mux.HandleFunc("/api/admin/default", s.handleAdminDefault)
	mux.HandleFunc("/api/skin", s.handleSkin)
	mux.HandleFunc("/api/default-skin", s.handleDefaultSkin)
	mux.HandleFunc("/api/admin/default-skin", s.handleAdminDefaultSkin)
	mux.HandleFunc("/api/account/export", s.handleExport)
	mux.HandleFunc("/api/account", s.handleAccount)
	mux.HandleFunc("/api/library", s.handleLibrary)
	mux.HandleFunc("/api/library/texture", s.handleLibraryTexture)
	mux.HandleFunc("/api/library/texture-delete", s.handleLibraryTextureDelete)
	mux.HandleFunc("/api/library/presets", s.handleLibraryPresets)
	mux.HandleFunc("/api/library/migrate", s.handleLibraryMigrate)
	mux.HandleFunc("/api/market/", s.handleMarket)
	mux.HandleFunc("/api/worlds", s.handleWorldsList)
	mux.HandleFunc("/api/worlds/create", s.handleWorldsCreate)
	mux.HandleFunc("/api/worlds/rename", s.handleWorldsRename)
	mux.HandleFunc("/api/worlds/delete", s.handleWorldsDelete)
	mux.HandleFunc("/api/worlds/members/add", s.handleWorldsMemberAdd)
	mux.HandleFunc("/api/worlds/members/remove", s.handleWorldsMemberRemove)
	mux.HandleFunc("/api/worlds/import", s.handleWorldsImport)
	mux.HandleFunc("/api/rooms", s.handleRoomsList)
	mux.HandleFunc("/api/rooms/open", s.handleRoomsOpen)
	mux.HandleFunc("/api/rooms/close", s.handleRoomsClose)
	mux.HandleFunc("/api/friends", s.handleFriendsList)
	mux.HandleFunc("/api/friends/request", s.handleFriendsRequest)
	mux.HandleFunc("/api/friends/accept", s.handleFriendsAccept)
	mux.HandleFunc("/api/friends/remove", s.handleFriendsRemove)
	mux.HandleFunc("/ws/room", s.handleWSRoom)
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

// handleAdminDefault (POST, admin only) sets the GLOBAL default look — the first
// character every brand-new player starts with — to the posted character, and
// also writes it as the default for its body-type slot (so "the male default"
// and "the first character" stay in sync).
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
	if err := s.acc.SetGlobalDefault(ch); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save default")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ---- REST: 3D skins ----

// handleSkin serves GET (read the cloud-stored skin) and PUT (save a skin).
// Both require a valid Bearer token. The PUT body is a protocol.Skin; it is
// validated + normalized (model classic|slim, PNG 64×64/64×32 ≤32 KiB) and the
// saved record is echoed back.
func (s *server) handleSkin(w http.ResponseWriter, r *http.Request) {
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}

	switch r.Method {
	case http.MethodGet:
		sk, found := s.acc.GetSkin(username)
		if !found {
			writeError(w, http.StatusNotFound, "no skin")
			return
		}
		writeJSON(w, http.StatusOK, sk)

	case http.MethodPut:
		var sk protocol.Skin
		if err := decodeJSON(r, &sk); err != nil {
			writeError(w, http.StatusBadRequest, "invalid skin body")
			return
		}
		if err := protocol.ValidateSkin(&sk); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if sk.CreatedAt == "" {
			sk.CreatedAt = time.Now().UTC().Format(time.RFC3339)
		}
		if err := s.acc.SetSkin(username, sk); err != nil {
			switch {
			case errors.Is(err, accounts.ErrBadInput):
				writeError(w, http.StatusBadRequest, err.Error())
			case errors.Is(err, accounts.ErrUnknownUser):
				writeError(w, http.StatusNotFound, "unknown user")
			default:
				writeError(w, http.StatusInternalServerError, "could not save skin")
			}
			return
		}
		writeJSON(w, http.StatusOK, sk)

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleDefaultSkin (GET, public) returns the admin-set default skin — the look
// every fresh visitor wears — or 404 when none has been configured yet.
func (s *server) handleDefaultSkin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	sk, ok := s.acc.GetDefaultSkin()
	if !ok {
		writeError(w, http.StatusNotFound, "no default skin")
		return
	}
	writeJSON(w, http.StatusOK, sk)
}

// handleAdminDefaultSkin (POST, admin only) stores the posted skin as the
// default every brand-new visitor starts with.
func (s *server) handleAdminDefaultSkin(w http.ResponseWriter, r *http.Request) {
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
	var sk protocol.Skin
	if err := decodeJSON(r, &sk); err != nil {
		writeError(w, http.StatusBadRequest, "invalid skin body")
		return
	}
	if sk.CreatedAt == "" {
		sk.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err := s.acc.SetDefaultSkin(sk); err != nil {
		if errors.Is(err, accounts.ErrBadInput) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "could not save default skin")
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

// ---- REST: creative library (textures + presets), per account ----

// libraryResponse is the shape returned by GET /api/library and the migrate
// endpoint: the user's whole creative library so the client can hydrate its cache.
type libraryResponse struct {
	Textures map[string]json.RawMessage `json:"textures"`
	Presets  json.RawMessage            `json:"presets"`
}

// handleLibrary (GET, auth) returns the signed-in user's textures + presets.
func (s *server) handleLibrary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	tex, pre, _ := s.acc.GetLibrary(username)
	writeJSON(w, http.StatusOK, libraryResponse{Textures: tex, Presets: pre})
}

// handleLibraryTexture (POST, auth) saves one painted texture record. The body
// is the full record {id,slot,title,glowColor,tintHint,createdAt,remixOf,png}.
func (s *server) handleLibraryTexture(w http.ResponseWriter, r *http.Request) {
	username, ok := s.libAuth(w, r)
	if !ok {
		return
	}
	var rec struct {
		ID string `json:"id"`
	}
	raw, err := readBody(r, 8<<20) // textures carry a base64 PNG; allow headroom
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if json.Unmarshal(raw, &rec) != nil || rec.ID == "" {
		writeError(w, http.StatusBadRequest, "texture needs an id")
		return
	}
	if err := s.acc.SaveTexture(username, rec.ID, json.RawMessage(raw)); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save texture")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "id": rec.ID})
}

// handleLibraryTextureDelete (POST, auth) removes one texture by id.
func (s *server) handleLibraryTextureDelete(w http.ResponseWriter, r *http.Request) {
	username, ok := s.libAuth(w, r)
	if !ok {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &body); err != nil || body.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.acc.DeleteTexture(username, body.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "could not delete texture")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// handleLibraryPresets (PUT, auth) replaces the user's saved character presets.
func (s *server) handleLibraryPresets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	raw, err := readBody(r, 2<<20)
	if err != nil || !json.Valid(raw) {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := s.acc.SetPresets(username, json.RawMessage(raw)); err != nil {
		writeError(w, http.StatusInternalServerError, "could not save presets")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleLibraryMigrate (POST, auth) folds anonymous/guest work (textures +
// presets created before signing in) into the account without clobbering what is
// already stored, then returns the merged library.
func (s *server) handleLibraryMigrate(w http.ResponseWriter, r *http.Request) {
	username, ok := s.libAuth(w, r)
	if !ok {
		return
	}
	raw, err := readBody(r, 16<<20) // a whole guest library of PNGs
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	var in libraryResponse
	if json.Unmarshal(raw, &in) != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	tex, pre, err := s.acc.MergeLibrary(username, in.Textures, in.Presets)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not merge library")
		return
	}
	writeJSON(w, http.StatusOK, libraryResponse{Textures: tex, Presets: pre})
}

// libAuth requires POST + a valid token for the write-style library endpoints.
func (s *server) libAuth(w http.ResponseWriter, r *http.Request) (string, bool) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return "", false
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return "", false
	}
	return username, true
}

// ---- REST: marketplace ----

// optUser returns the requester's username + admin flag if a valid token is
// present, or ("", false) for anonymous requests.
func (s *server) optUser(r *http.Request) (string, bool) {
	u, ok := s.authUser(r)
	if !ok {
		return "", false
	}
	return u, s.acc.IsAdmin(u)
}

// handleMarket dispatches every /api/market/* endpoint.
func (s *server) handleMarket(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/market/")
	switch action {
	case "list":
		s.mktList(w, r)
	case "item":
		s.mktItem(w, r)
	case "publish":
		s.mktPublish(w, r)
	case "rate":
		s.mktRate(w, r)
	case "comment":
		s.mktComment(w, r)
	case "report":
		s.mktReportLike(w, r, "report")
	case "unreport":
		s.mktReportLike(w, r, "unreport")
	case "vouch":
		s.mktReportLike(w, r, "vouch")
	case "unvouch":
		s.mktReportLike(w, r, "unvouch")
	case "download":
		s.mktDownload(w, r)
	case "delete":
		s.mktDelete(w, r)
	case "admin/ban":
		s.mktAdmin(w, r, "ban")
	case "admin/revoke":
		s.mktAdmin(w, r, "revoke")
	default:
		writeError(w, http.StatusNotFound, "unknown market endpoint")
	}
}

func (s *server) mktList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	user, isAdmin := s.optUser(r)
	q := r.URL.Query()
	opts := market.ListOpts{
		Q: q.Get("q"), Sort: q.Get("sort"), Kind: q.Get("kind"),
		Slot: q.Get("slot"), Model: q.Get("model"),
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"items": s.mkt.List(opts, user, isAdmin)})
}

func (s *server) mktItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	user, isAdmin := s.optUser(r)
	it, ok := s.mkt.Get(r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"item": s.mkt.ViewOne(it, user, isAdmin)})
}

func (s *server) mktPublish(w http.ResponseWriter, r *http.Request) {
	user, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "sign in to publish")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var in market.Item
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	it, err := s.mkt.Publish(user, in)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"id": it.ID, "flagged": it.Flagged})
}

type mktBody struct {
	ID       string  `json:"id"`
	Stars    float64 `json:"stars"`
	Text     string  `json:"text"`
	ParentID string  `json:"parentId"`
	Reason   string  `json:"reason"`
}

func (s *server) mktRate(w http.ResponseWriter, r *http.Request) {
	user, body, ok := s.mktAuthBody(w, r)
	if !ok {
		return
	}
	if _, err := s.mkt.Rate(body.ID, user, body.Stars); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mktReturn(w, r, body.ID, user)
}

func (s *server) mktComment(w http.ResponseWriter, r *http.Request) {
	user, body, ok := s.mktAuthBody(w, r)
	if !ok {
		return
	}
	if _, err := s.mkt.Comment(body.ID, user, body.Text, body.ParentID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mktReturn(w, r, body.ID, user)
}

func (s *server) mktReportLike(w http.ResponseWriter, r *http.Request, kind string) {
	user, body, ok := s.mktAuthBody(w, r)
	if !ok {
		return
	}
	var err error
	switch kind {
	case "report":
		_, err = s.mkt.Report(body.ID, user, body.Reason)
	case "unreport":
		_, err = s.mkt.CancelReport(body.ID, user)
	case "vouch":
		_, err = s.mkt.Vouch(body.ID, user)
	case "unvouch":
		_, err = s.mkt.CancelVouch(body.ID, user)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.mktReturn(w, r, body.ID, user)
}

func (s *server) mktDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body mktBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if _, err := s.mkt.Download(body.ID); err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	user, _ := s.optUser(r)
	s.mktReturn(w, r, body.ID, user)
}

func (s *server) mktDelete(w http.ResponseWriter, r *http.Request) {
	user, body, ok := s.mktAuthBody(w, r)
	if !ok {
		return
	}
	if err := s.mkt.Delete(body.ID, user, s.acc.IsAdmin(user)); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *server) mktAdmin(w http.ResponseWriter, r *http.Request, kind string) {
	user, body, ok := s.mktAuthBody(w, r)
	if !ok {
		return
	}
	if !s.acc.IsAdmin(user) {
		writeError(w, http.StatusForbidden, "admin only")
		return
	}
	var err error
	if kind == "ban" {
		_, err = s.mkt.AdminBan(body.ID)
	} else {
		_, err = s.mkt.AdminRevoke(body.ID)
	}
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	s.mktReturn(w, r, body.ID, user)
}

// mktAuthBody requires POST + a valid token and decodes the common body.
func (s *server) mktAuthBody(w http.ResponseWriter, r *http.Request) (string, mktBody, bool) {
	var body mktBody
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return "", body, false
	}
	user, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "sign in first")
		return "", body, false
	}
	if err := decodeJSON(r, &body); err != nil || body.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return "", body, false
	}
	return user, body, true
}

// mktReturn re-reads the item and returns its fresh view (so the client updates).
func (s *server) mktReturn(w http.ResponseWriter, r *http.Request, id, user string) {
	it, ok := s.mkt.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"item": s.mkt.ViewOne(it, user, s.acc.IsAdmin(user))})
}

// ---- REST: worlds ----

// worldView is the wire shape for one world in GET /api/worlds, per contract
// §3.2. Live is populated by cross-referencing rooms.Manager for an instance
// currently hosting this world — worlds.Store has no notion of live rooms, and
// rooms.Manager has no notion of ownership/membership, so the merge happens
// here in the handler.
type worldView struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Seed      int64      `json:"seed"`
	Owner     string     `json:"owner"`
	Role      string     `json:"role"` // "owner" | "member"
	Members   []string   `json:"members"`
	UpdatedAt string     `json:"updatedAt"`
	Live      *liveWorld `json:"live"`
}

// liveWorld is the "world is currently hosted" summary embedded in worldView.
type liveWorld struct {
	RoomID  string `json:"roomId"`
	Host    string `json:"host"`
	Players int    `json:"players"`
	Access  string `json:"access"`
}

// worldViewOf builds the wire view for a world the requesting user owns or is
// a member of, merging in live-room info from rooms.Manager when present.
func (s *server) worldViewOf(w worlds.World, viewer string) worldView {
	role := "member"
	if w.Owner == viewer {
		role = "owner"
	}
	v := worldView{
		ID:        w.ID,
		Name:      w.Name,
		Seed:      w.Seed,
		Owner:     w.Owner,
		Role:      role,
		Members:   w.Members,
		UpdatedAt: w.UpdatedAt,
	}
	if inst, ok := s.rms.FindByWorld(w.ID); ok {
		info := inst.Info()
		v.Live = &liveWorld{RoomID: info.RoomID, Host: info.Host, Players: info.Players, Access: info.Access}
	}
	return v
}

func (s *server) handleWorldsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	list, err := s.wld.ListForUser(username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list worlds")
		return
	}
	views := make([]worldView, 0, len(list))
	for _, wd := range list {
		views = append(views, s.worldViewOf(wd, username))
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"worlds": views})
}

type worldsCreateBody struct {
	Name string `json:"name"`
	Seed *int64 `json:"seed"`
}

func (s *server) handleWorldsCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body worldsCreateBody
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var seed int64
	if body.Seed != nil {
		seed = *body.Seed
	} else {
		seed = worlds.RandomSeed()
	}
	wd, err := s.wld.Create(username, body.Name, seed)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.worldViewOf(wd, username))
}

type worldsIDBody struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s *server) handleWorldsRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body worldsIDBody
	if err := decodeJSON(r, &body); err != nil || body.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.wld.Rename(body.ID, username, body.Name); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	wd, ok := s.wld.Get(body.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "world not found")
		return
	}
	writeJSON(w, http.StatusOK, s.worldViewOf(wd, username))
}

func (s *server) handleWorldsDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body worldsIDBody
	if err := decodeJSON(r, &body); err != nil || body.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if _, hosted := s.rms.FindByWorld(body.ID); hosted {
		writeError(w, http.StatusConflict, "close the room first")
		return
	}
	if err := s.wld.Delete(body.ID, username); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

type worldsMemberBody struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func (s *server) handleWorldsMemberAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body worldsMemberBody
	if err := decodeJSON(r, &body); err != nil || body.ID == "" || body.Username == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.wld.AddMember(body.ID, username, body.Username); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	wd, ok := s.wld.Get(body.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "world not found")
		return
	}
	writeJSON(w, http.StatusOK, s.worldViewOf(wd, username))
}

func (s *server) handleWorldsMemberRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body worldsMemberBody
	if err := decodeJSON(r, &body); err != nil || body.ID == "" || body.Username == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.wld.RemoveMember(body.ID, username, body.Username); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	wd, ok := s.wld.Get(body.ID)
	if !ok {
		writeError(w, http.StatusNotFound, "world not found")
		return
	}
	writeJSON(w, http.StatusOK, s.worldViewOf(wd, username))
}

type worldsImportBody struct {
	Name   string            `json:"name"`
	Seed   int64             `json:"seed"`
	Deltas map[string]string `json:"deltas"`
}

// handleWorldsImport (POST, auth) creates a new server world seeded from a
// local (offline) world's edits. The body carries per-chunk base64 delta blobs
// keyed "cx,cz" (contract §2 encoding); worlds.Store validates every record
// (index range, block id, immutable y==0 edits) and rejects the whole import on
// the first bad record.
func (s *server) handleWorldsImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	raw, err := readBody(r, 16<<20) // a whole local world's worth of edited chunks
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	var body worldsImportBody
	if json.Unmarshal(raw, &body) != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	wd, err := s.wld.Import(username, body.Name, body.Seed, body.Deltas)
	if err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.worldViewOf(wd, username))
}

// ---- REST: rooms ----

func (s *server) handleRoomsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	viewer, _ := s.optUser(r)
	list := s.rms.List(viewer, s.soc.FriendsOf)
	writeJSON(w, http.StatusOK, map[string]interface{}{"rooms": list})
}

type roomsOpenBody struct {
	WorldID string `json:"worldId"`
	Access  string `json:"access"`
	Pin     string `json:"pin"`
}

// handleRoomsOpen (POST, auth) starts (or resumes) a live instance for a world
// the caller owns or is a member of. Per contract §3.1/§3.2, an already-hosted
// world yields rooms.ErrAlreadyHosted, reported as a 409 with the exact shape
// pinned by the contract (not routed through statusFor/writeError, since it
// carries extra fields the generic error envelope doesn't have room for).
func (s *server) handleRoomsOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body roomsOpenBody
	if err := decodeJSON(r, &body); err != nil || body.WorldID == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	wd, ok := s.wld.Get(body.WorldID)
	if !ok {
		writeError(w, http.StatusNotFound, "world not found")
		return
	}
	isMember := wd.Owner == username
	if !isMember {
		for _, m := range wd.Members {
			if m == username {
				isMember = true
				break
			}
		}
	}
	if !isMember {
		writeError(w, http.StatusForbidden, "not an owner or member of this world")
		return
	}
	inst, err := s.rms.Open(wd, username, body.Access, body.Pin)
	if err != nil {
		var already rooms.ErrAlreadyHosted
		if errors.As(err, &already) {
			writeJSON(w, http.StatusConflict, map[string]interface{}{
				"error":  "already hosted",
				"host":   already.Host,
				"roomId": already.RoomID,
			})
			return
		}
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"roomId": inst.Info().RoomID})
}

type roomsCloseBody struct {
	RoomID string `json:"roomId"`
}

func (s *server) handleRoomsClose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	var body roomsCloseBody
	if err := decodeJSON(r, &body); err != nil || body.RoomID == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	isOwner := false
	if inst, ok := s.rms.Get(body.RoomID); ok {
		if wd, ok := s.wld.Get(inst.Info().WorldID); ok {
			isOwner = wd.Owner == username
		}
	}
	if err := s.rms.Close(body.RoomID, username, isOwner || s.acc.IsAdmin(username)); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "closed"})
}

// ---- REST: friends ----

func (s *server) handleFriendsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return
	}
	friends, incoming, outgoing, err := s.soc.List(username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not list friends")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"friends": friends, "incoming": incoming, "outgoing": outgoing,
	})
}

type friendsUserBody struct {
	Username string `json:"username"`
}

func (s *server) handleFriendsRequest(w http.ResponseWriter, r *http.Request) {
	username, body, ok := s.friendsAuthBody(w, r)
	if !ok {
		return
	}
	if err := s.soc.Request(username, body.Username); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleFriendsAccept(w http.ResponseWriter, r *http.Request) {
	username, body, ok := s.friendsAuthBody(w, r)
	if !ok {
		return
	}
	if err := s.soc.Accept(username, body.Username); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleFriendsRemove(w http.ResponseWriter, r *http.Request) {
	username, body, ok := s.friendsAuthBody(w, r)
	if !ok {
		return
	}
	if err := s.soc.Remove(username, body.Username); err != nil {
		writeError(w, statusFor(err), err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// friendsAuthBody requires POST + a valid token and decodes the common
// {"username":"…"} body shared by all three write endpoints.
func (s *server) friendsAuthBody(w http.ResponseWriter, r *http.Request) (string, friendsUserBody, bool) {
	var body friendsUserBody
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return "", body, false
	}
	username, ok := s.authUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "missing or invalid token")
		return "", body, false
	}
	if err := decodeJSON(r, &body); err != nil || body.Username == "" {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return "", body, false
	}
	return username, body, true
}

// ---- WebSocket: /ws/room ----

// handleWSRoom upgrades the connection to a WebSocket and hands it to
// rooms.Manager, which owns the entire client<->instance game protocol from
// here (contract §3.3). Per contract §5, same-host origin is required (empty
// Origin is allowed through for native/non-browser clients that don't send one
// at all; browsers always send Origin on cross-origin AND same-origin requests
// for WS upgrades, so this still blocks a page on another host from opening a
// socket against this server on behalf of a visitor).
func (s *server) handleWSRoom(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		if !sameHostOrigin(origin, r.Host) {
			writeError(w, http.StatusForbidden, "cross-origin websocket rejected")
			return
		}
	}
	conn, err := ws.Accept(w, r)
	if err != nil {
		// ws.Accept has already written whatever HTTP response is appropriate
		// (e.g. 400 on a bad handshake); nothing more to do here.
		return
	}
	s.rms.HandleConn(conn, r)
}

// sameHostOrigin reports whether the Origin header's host matches r.Host,
// ignoring scheme (http vs https / ws vs wss both pass) so the server works
// identically behind a plain reverse proxy or TLS termination.
func sameHostOrigin(origin, host string) bool {
	rest := origin
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	rest = strings.TrimSuffix(rest, "/")
	return strings.EqualFold(rest, host)
}

func statusFor(err error) int {
	switch {
	case errors.Is(err, market.ErrNotFound), errors.Is(err, worlds.ErrNotFound),
		errors.Is(err, social.ErrNotFound), errors.Is(err, rooms.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, market.ErrForbidden), errors.Is(err, worlds.ErrForbidden),
		errors.Is(err, social.ErrForbidden), errors.Is(err, rooms.ErrForbidden):
		return http.StatusForbidden
	case errors.Is(err, market.ErrBadInput), errors.Is(err, worlds.ErrBadInput),
		errors.Is(err, social.ErrBadInput), errors.Is(err, rooms.ErrBadInput):
		return http.StatusBadRequest
	case errors.Is(err, worlds.ErrHosted):
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
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

// readBody reads a request body up to max bytes (for endpoints that carry larger
// payloads than the default 1 MiB, e.g. base64-encoded PNG textures).
func readBody(r *http.Request, max int64) ([]byte, error) {
	return io.ReadAll(http.MaxBytesReader(nil, r.Body, max))
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
