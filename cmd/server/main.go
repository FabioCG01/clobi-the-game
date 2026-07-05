// Command server is the entry point for Clobi's Arena: a single static Go
// binary that serves the web client (character creator, texture paint tool, and
// the open-source marketplace) plus the REST account/character API.
//
// Configuration comes entirely from the environment so the same binary runs
// unchanged inside the project's Docker image and on a developer's machine:
//
//	PORT          TCP port to listen on            (default 1337)
//	WEB_DIR       static web client directory      (default web)
//	DATABASE_URL  PostgreSQL connection URL        (required)
//	ADMIN_USER    username granted admin rights    (default fabiocg)
//
// A tribute to Clobi: Linux, open source, vim, and a healthy distaste for
// Windows pop-ups.
package main

import (
	"log"
	"os"

	"clobi/internal/server"
)

func main() {
	port := envOr("PORT", "1337")
	webDir := envOr("WEB_DIR", "web")
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required (e.g. postgres://clobi:pw@127.0.0.1:5432/clobi?sslmode=disable)")
	}

	addr := ":" + port

	log.Printf("TUX SMASH ROYALE listening on %s (web=%q, postgres)", addr, webDir)
	if err := server.Run(addr, webDir, dsn); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}

// envOr returns the value of the environment variable named key, or def when it
// is unset or empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
