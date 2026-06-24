// Command server is the entry point for Clobi's Arena: a single static Go
// binary that serves the web client (character creator, texture paint tool, and
// the open-source marketplace) plus the REST account/character API.
//
// Configuration comes entirely from the environment so the same binary runs
// unchanged inside the project's Docker image and on a developer's machine:
//
//	PORT      TCP port to listen on        (default 1337)
//	WEB_DIR   static web client directory  (default web)
//	DATA_DIR  account/data directory       (default data)
//
// A tribute to Clobi: Linux, open source, vim, and a militant distaste for
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
	dataDir := envOr("DATA_DIR", "data")

	addr := ":" + port

	log.Printf("TUX SMASH ROYALE listening on %s (web=%q data=%q)", addr, webDir, dataDir)
	if err := server.Run(addr, webDir, dataDir); err != nil {
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
