// Package pgdb opens the PostgreSQL connection pool shared by the account and
// marketplace stores and creates the schema on first boot.
//
// The whole backend now lives in Postgres: accounts (incl. the player's active
// 3D skin), the per-user creative library (painted textures + presets — it
// doubles as the cloud skin library), durable sessions, admin settings (default
// looks + default skin), and the marketplace. We use the pure-Go pgx driver through
// database/sql, so the server stays a single static binary (CGO_ENABLED=0) with
// no external client libraries.
//
// Hot, queryable fields are real columns (with indexes); the rich nested blobs
// the JS client owns (a character, a preset array, a marketplace item body) are
// stored as jsonb. That is idiomatic Postgres and keeps the Go logic identical
// to what it was, so the migration carries no behavioural risk.
package pgdb

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Open dials the database, tunes the pool, verifies connectivity, and ensures
// the schema exists. dsn is a libpq/pgx URL, e.g.
//
//	postgres://clobi:secret@127.0.0.1:5432/clobi?sslmode=disable
func Open(dsn string) (*sql.DB, error) {
	if dsn == "" {
		return nil, fmt.Errorf("pgdb: empty DATABASE_URL")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	// A loopback Postgres is plenty fast; keep a small warm pool.
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(time.Hour)

	if err := pingWithRetry(db, 10, 500*time.Millisecond); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func pingWithRetry(db *sql.DB, attempts int, gap time.Duration) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = db.Ping(); err == nil {
			return nil
		}
		time.Sleep(gap)
	}
	return fmt.Errorf("pgdb: could not reach database: %w", err)
}

// schema is created idempotently on every boot. Adding a column later? Append an
// "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" statement here.
const schema = `
CREATE TABLE IF NOT EXISTS accounts (
    username    text PRIMARY KEY,
    display     text NOT NULL,
    hash        text NOT NULL,
    is_admin    boolean NOT NULL DEFAULT false,
    character   jsonb NOT NULL DEFAULT '{}'::jsonb,
    presets     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS textures (
    username  text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    tex_id    text NOT NULL,
    record    jsonb NOT NULL,
    PRIMARY KEY (username, tex_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token      text PRIMARY KEY,
    username   text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username);

CREATE TABLE IF NOT EXISTS settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS market_items (
    id          text PRIMARY KEY,
    author      text NOT NULL,
    kind        text NOT NULL,
    slot        text NOT NULL DEFAULT '',
    created_ts  bigint NOT NULL,
    downloads   integer NOT NULL DEFAULT 0,
    banned      boolean NOT NULL DEFAULT false,
    flagged     boolean NOT NULL DEFAULT false,
    body        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_author ON market_items(lower(author));
CREATE INDEX IF NOT EXISTS idx_market_kind   ON market_items(kind);
CREATE INDEX IF NOT EXISTS idx_market_slot   ON market_items(slot);

-- 3D era: each account carries one active Minecraft-compatible skin
-- (protocol.Skin as jsonb; NULL until the player saves one).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS skin jsonb;

-- Part II: persistent server worlds (seed + deltas only — see internal/worlds),
-- world memberships, packed per-chunk deltas, and the friend graph (see
-- internal/social). Rooms/instances/locks stay in-memory only (internal/rooms);
-- nothing about a live hosting session is durable here.
CREATE TABLE IF NOT EXISTS worlds (
    id         text PRIMARY KEY,            -- 'w' + 12 hex bytes
    name       text NOT NULL,               -- clipped 32
    owner      text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    seed       bigint NOT NULL,             -- int32 range (JS-safe)
    settings   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {cap:8}
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_worlds_owner ON worlds(owner);

CREATE TABLE IF NOT EXISTS world_members (
    world_id  text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    username  text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    added_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, username)
);

CREATE TABLE IF NOT EXISTS world_deltas (
    world_id   text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    cx         integer NOT NULL,
    cz         integer NOT NULL,
    data       bytea NOT NULL,              -- packed records, see ARCHITECTURE-MP.md §2
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (world_id, cx, cz)
);

CREATE TABLE IF NOT EXISTS friends (
    a          text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    b          text NOT NULL REFERENCES accounts(username) ON DELETE CASCADE,
    requester  text NOT NULL,               -- who asked (equals a or b)
    status     text NOT NULL,               -- 'pending' | 'accepted'
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (a, b),
    CHECK (a < b)                            -- normalized pair: a = lesser username
);
`

// schemaLockKey is the pg_advisory_lock key that serializes schema creation.
// Arbitrary but stable — every clobi process migrating the same database uses it.
const schemaLockKey int64 = 0x0C10B1D6

func migrate(db *sql.DB) error {
	// Concurrent bootstrappers (two server replicas, or parallel test binaries)
	// can trip Postgres catalog races even with IF NOT EXISTS ("duplicate key
	// value violates unique constraint pg_type_typname_nsp_index"), so schema
	// creation is serialized with a server-side advisory lock. The lock is
	// session-scoped: it must be taken and released on the SAME pooled
	// connection, hence the explicit db.Conn.
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("pgdb: schema migration failed: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, schemaLockKey); err != nil {
		return fmt.Errorf("pgdb: schema lock failed: %w", err)
	}
	_, execErr := conn.ExecContext(ctx, schema)
	// Always release, even after a failed exec, so other bootstrappers proceed.
	_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, schemaLockKey)
	if execErr != nil {
		return fmt.Errorf("pgdb: schema migration failed: %w", execErr)
	}
	return nil
}
