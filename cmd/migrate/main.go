// Command migrate is a one-shot importer that copies the old embedded bbolt
// database into PostgreSQL. It is safe to re-run: accounts/items already present
// are left untouched (ON CONFLICT DO NOTHING).
//
// Usage:
//
//	DATABASE_URL=postgres://... migrate <path/to/clobi.db> [flags]
//
// Flags:
//
//	-skip-prefix s   skip accounts whose username starts with s (repeatable)
//	-drop-presets    do not import saved character presets (e.g. test junk)
//	-skip-settings   do not import the settings bucket (default looks)
//	-skip-market     do not import marketplace items
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"clobi/internal/pgdb"

	bolt "go.etcd.io/bbolt"
)

type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}

type oldAccount struct {
	Username  string                     `json:"username"`
	Hash      string                     `json:"hash"`
	Character json.RawMessage            `json:"character"`
	IsAdmin   bool                       `json:"isAdmin"`
	CreatedAt string                     `json:"createdAt"`
	UpdatedAt string                     `json:"updatedAt"`
	Textures  map[string]json.RawMessage `json:"textures"`
	Presets   json.RawMessage            `json:"presets"`
}

func main() {
	var skipPrefixes multiFlag
	dropPresets := flag.Bool("drop-presets", false, "do not import character presets")
	dropTextures := flag.Bool("drop-textures", false, "do not import painted textures")
	skipSettings := flag.Bool("skip-settings", false, "do not import settings bucket")
	skipMarket := flag.Bool("skip-market", false, "do not import marketplace items")
	flag.Var(&skipPrefixes, "skip-prefix", "skip usernames with this prefix (repeatable)")
	flag.Parse()

	if flag.NArg() < 1 {
		log.Fatal("usage: migrate <path/to/clobi.db> [flags]")
	}
	boltPath := flag.Arg(0)
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}

	bdb, err := bolt.Open(boltPath, 0o600, &bolt.Options{ReadOnly: true})
	if err != nil {
		log.Fatalf("open bbolt: %v", err)
	}
	defer bdb.Close()

	// pgdb.Open also creates the schema if it is not there yet.
	pg, err := pgdb.Open(dsn)
	if err != nil {
		log.Fatalf("open postgres: %v", err)
	}
	defer pg.Close()

	var accImported, accSkipped, texImported, setImported, mktImported int

	_ = bdb.View(func(tx *bolt.Tx) error {
		// ---- accounts ----
		if b := tx.Bucket([]byte("accounts")); b != nil {
			_ = b.ForEach(func(k, v []byte) error {
				var a oldAccount
				if json.Unmarshal(v, &a) != nil {
					return nil
				}
				uname := strings.ToLower(strings.TrimSpace(a.Username))
				if uname == "" {
					uname = string(k)
				}
				for _, p := range skipPrefixes {
					if p != "" && strings.HasPrefix(uname, strings.ToLower(p)) {
						accSkipped++
						return nil
					}
				}
				ch := a.Character
				if len(ch) == 0 {
					ch = json.RawMessage(`{}`)
				}
				var presetsArg interface{}
				if !*dropPresets && len(a.Presets) > 0 {
					presetsArg = string(a.Presets)
				}
				res, err := pg.Exec(
					`INSERT INTO accounts(username, display, hash, is_admin, character, presets)
					 VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
					 ON CONFLICT (username) DO NOTHING`,
					uname, a.Username, a.Hash, a.IsAdmin, string(ch), presetsArg)
				if err != nil {
					log.Printf("  account %q: %v", uname, err)
					return nil
				}
				if n, _ := res.RowsAffected(); n == 0 {
					return nil // already present
				}
				accImported++
				if *dropTextures {
					return nil
				}
				for id, rec := range a.Textures {
					if id == "" || len(rec) == 0 {
						continue
					}
					if _, err := pg.Exec(
						`INSERT INTO textures(username, tex_id, record) VALUES ($1,$2,$3::jsonb)
						 ON CONFLICT (username, tex_id) DO NOTHING`, uname, id, string(rec)); err == nil {
						texImported++
					}
				}
				return nil
			})
		}

		// ---- settings ----
		if !*skipSettings {
			if b := tx.Bucket([]byte("settings")); b != nil {
				_ = b.ForEach(func(k, v []byte) error {
					if !json.Valid(v) {
						return nil
					}
					if _, err := pg.Exec(
						`INSERT INTO settings(key, value) VALUES ($1,$2::jsonb)
						 ON CONFLICT (key) DO NOTHING`, string(k), string(v)); err == nil {
						setImported++
					}
					return nil
				})
			}
		}

		// ---- market items ----
		if !*skipMarket {
			if b := tx.Bucket([]byte("market_items")); b != nil {
				_ = b.ForEach(func(k, v []byte) error {
					var it struct {
						ID        string `json:"id"`
						Author    string `json:"author"`
						Kind      string `json:"kind"`
						Slot      string `json:"slot"`
						CreatedTS int64  `json:"createdTs"`
						Downloads int    `json:"downloads"`
						Banned    bool   `json:"banned"`
						Flagged   bool   `json:"flagged"`
					}
					if json.Unmarshal(v, &it) != nil || it.ID == "" {
						return nil
					}
					if _, err := pg.Exec(
						`INSERT INTO market_items(id,author,kind,slot,created_ts,downloads,banned,flagged,body)
						 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
						 ON CONFLICT (id) DO NOTHING`,
						it.ID, it.Author, it.Kind, it.Slot, it.CreatedTS, it.Downloads, it.Banned, it.Flagged, string(v)); err == nil {
						mktImported++
					}
					return nil
				})
			}
		}
		return nil
	})

	fmt.Printf("migration complete: accounts +%d (skipped %d), textures +%d, settings +%d, market +%d\n",
		accImported, accSkipped, texImported, setImported, mktImported)
}
