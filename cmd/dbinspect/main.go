// throwaway DB inspector — read-only dump of accounts + default settings.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	bolt "go.etcd.io/bbolt"
)

func main() {
	path := os.Args[1]
	db, err := bolt.Open(path, 0o600, &bolt.Options{ReadOnly: true})
	if err != nil {
		panic(err)
	}
	defer db.Close()
	_ = db.View(func(tx *bolt.Tx) error {
		fmt.Println("=== buckets ===")
		_ = tx.ForEach(func(name []byte, b *bolt.Bucket) error {
			fmt.Printf("  %s (keys=%d)\n", name, b.Stats().KeyN)
			return nil
		})

		fmt.Println("\n=== settings (default* keys) ===")
		if sb := tx.Bucket([]byte("settings")); sb != nil {
			_ = sb.ForEach(func(k, v []byte) error {
				fmt.Printf("  [%s] = %s\n", k, truncate(v, 400))
				return nil
			})
		}

		fmt.Println("\n=== accounts ===")
		if ab := tx.Bucket([]byte("accounts")); ab != nil {
			_ = ab.ForEach(func(k, v []byte) error {
				var m map[string]json.RawMessage
				_ = json.Unmarshal(v, &m)
				fmt.Printf("  user=%s isAdmin=%s\n", k, string(m["isAdmin"]))
				if p, ok := m["presets"]; ok {
					fmt.Printf("    presets=%s\n", truncate(p, 4000))
				} else {
					fmt.Printf("    presets=<none>\n")
				}
				if c, ok := m["character"]; ok {
					fmt.Printf("    character=%s\n", truncate(c, 600))
				}
				return nil
			})
		}
		return nil
	})
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…(" + fmt.Sprint(len(b)) + " bytes)"
}
