// Package social is the friend-graph store for Clobi Craft Part II (see
// ARCHITECTURE-MP.md §1, §3.2). It owns exactly one table shared with the
// rest of the backend pool:
//
//	friends(a, b, requester, status, created_at)
//
// The pair (a, b) is always stored NORMALIZED — a is the lexicographically
// lesser username — enforced in Postgres itself via `CHECK (a < b)`, so every
// query and mutation in this package must sort its two usernames before
// touching the table. `requester` records who actually asked (it always
// equals a or b) so accept/auto-accept logic can tell who's waiting on whom
// even though the row itself is symmetric.
//
// Style mirrors internal/accounts and internal/market: plain database/sql
// calls, sentinel errors compared with errors.Is, a Store that wraps *sql.DB.
package social

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Sentinel errors, compared with errors.Is (same convention as accounts/market).
var (
	ErrNotFound = errors.New("unknown user or no such request")
	ErrBadInput = errors.New("invalid input")
)

const (
	statusPending  = "pending"
	statusAccepted = "accepted"
)

// accountExistsFunc reports whether a username names a real account. See
// worlds.accountExistsFunc for the identical rationale: injectable at
// NewStore time so this package never imports internal/accounts; the default
// falls back to a plain `SELECT` against the shared accounts table, the same
// way internal/market coexists with internal/accounts on one pool.
type accountExistsFunc func(username string) bool

// Store is the friend-graph store (PostgreSQL).
type Store struct {
	db           *sql.DB
	accountCheck accountExistsFunc
}

// NewStore wraps an open *sql.DB (schema already migrated by pgdb.Open). Pass
// checkAccount to inject a custom "does this username exist" check; pass none
// (or nil) to use the default direct SQL query against accounts.
func NewStore(db *sql.DB, checkAccount ...accountExistsFunc) (*Store, error) {
	if db == nil {
		return nil, errors.New("social: nil db")
	}
	s := &Store{db: db}
	if len(checkAccount) > 0 && checkAccount[0] != nil {
		s.accountCheck = checkAccount[0]
	} else {
		s.accountCheck = s.accountExistsSQL
	}
	return s, nil
}

func (s *Store) accountExistsSQL(username string) bool {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM accounts WHERE username = $1`, key(username)).Scan(&one)
	return err == nil
}

func key(username string) string { return strings.ToLower(strings.TrimSpace(username)) }

// pair normalizes two usernames into the table's storage order: a is always
// the lexicographically lesser one (matches the `CHECK (a < b)` constraint).
func pair(x, y string) (a, b string) {
	x, y = key(x), key(y)
	if x < y {
		return x, y
	}
	return y, x
}

// row is one friends table row, always already in normalized (a<b) order.
type row struct {
	a, b, requester, status string
}

// getRow reads the row for the normalized pair (a, b), if any.
func (s *Store) getRow(a, b string) (row, bool) {
	var r row
	err := s.db.QueryRow(
		`SELECT a, b, requester, status FROM friends WHERE a = $1 AND b = $2`, a, b).
		Scan(&r.a, &r.b, &r.requester, &r.status)
	if err != nil {
		return row{}, false
	}
	return r, true
}

// ---- queries --------------------------------------------------------------

// ListFriends returns the three lists GET /api/friends needs (contract
// §3.2): accepted friends, incoming pending requests (someone else asked
// username), and outgoing pending requests (username asked someone else).
// Each list is the OTHER party's username, alphabetically sorted.
func (s *Store) ListFriends(username string) (friends, incoming, outgoing []string, err error) {
	u := key(username)
	friends, incoming, outgoing = []string{}, []string{}, []string{}
	rows, qerr := s.db.Query(
		`SELECT a, b, requester, status FROM friends WHERE a = $1 OR b = $1 ORDER BY a, b`, u)
	if qerr != nil {
		return nil, nil, nil, qerr
	}
	defer rows.Close()
	for rows.Next() {
		var r row
		if serr := rows.Scan(&r.a, &r.b, &r.requester, &r.status); serr != nil {
			return nil, nil, nil, serr
		}
		other := r.a
		if other == u {
			other = r.b
		}
		switch r.status {
		case statusAccepted:
			friends = append(friends, other)
		case statusPending:
			if r.requester == u {
				outgoing = append(outgoing, other)
			} else {
				incoming = append(incoming, other)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, nil, err
	}
	return friends, incoming, outgoing, nil
}

// AreFriends reports whether a and b have an ACCEPTED friendship (used by
// rooms.Manager's friends-access-level join check).
func (s *Store) AreFriends(a, b string) (bool, error) {
	x, y := pair(a, b)
	if x == y {
		return false, nil // a user is not their own friend
	}
	r, ok := s.getRow(x, y)
	if !ok {
		return false, nil
	}
	return r.status == statusAccepted, nil
}

// FriendsOf returns username's accepted friends only (no incoming/outgoing),
// silently returning an empty slice on any lookup error. This is the exact
// `func(host string) []string` shape rooms.Manager.List's friendsOf callback
// wants (contract §3.1: "friends → only if viewer ∈ host's accepted
// friends") — a thin convenience wrapper over ListFriends kept error-free at
// this boundary because List is a best-effort visibility filter, not a
// request that should ever fail a whole room listing over one lookup hiccup.
func (s *Store) FriendsOf(username string) []string {
	friends, _, _, err := s.ListFriends(username)
	if err != nil {
		return []string{}
	}
	return friends
}

// ---- mutations --------------------------------------------------------------

// Request sends a friend request from -> to. Returns ErrNotFound if `to`
// names no account. If `to` already requested `from` (a pending row exists
// with the OTHER party as requester), this auto-accepts instead of leaving a
// second pending request (contract §3.2: "auto-accept if they already
// requested you"). Requesting an existing friend, or re-requesting someone
// you already asked, is a harmless no-op.
func (s *Store) Request(from, to string) error {
	f, t := key(from), key(to)
	if f == "" || t == "" {
		return ErrBadInput
	}
	if f == t {
		return fmt.Errorf("%w: cannot friend yourself", ErrBadInput)
	}
	if !s.accountCheck(t) {
		return ErrNotFound
	}
	a, b := pair(f, t)

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var existingRequester, existingStatus string
	err = tx.QueryRow(
		`SELECT requester, status FROM friends WHERE a = $1 AND b = $2 FOR UPDATE`, a, b).
		Scan(&existingRequester, &existingStatus)
	switch {
	case err == sql.ErrNoRows:
		if _, err := tx.Exec(
			`INSERT INTO friends(a, b, requester, status) VALUES ($1, $2, $3, $4)`,
			a, b, f, statusPending); err != nil {
			return err
		}
	case err != nil:
		return err
	case existingStatus == statusAccepted:
		// Already friends — nothing to do.
	case existingStatus == statusPending && existingRequester == f:
		// Already requested — idempotent no-op.
	default:
		// existingStatus == pending and the OTHER party asked first: auto-accept.
		if _, err := tx.Exec(
			`UPDATE friends SET status = $3 WHERE a = $1 AND b = $2`, a, b, statusAccepted); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Accept accepts a pending incoming request: `other`'s request to `username`
// must currently be pending. Returns ErrNotFound if there is no such pending
// request (including the case where `username` is the one who sent it —
// you cannot accept your own outgoing request).
func (s *Store) Accept(username, other string) error {
	u, o := key(username), key(other)
	if u == "" || o == "" || u == o {
		return ErrNotFound
	}
	a, b := pair(u, o)
	res, err := s.db.Exec(
		`UPDATE friends SET status = $1 WHERE a = $2 AND b = $3 AND status = $4 AND requester = $5`,
		statusAccepted, a, b, statusPending, o)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// Remove deletes the friendship/request row between username and other,
// regardless of its status — this is the single verb for declining a pending
// incoming request, cancelling a pending outgoing request, AND unfriending an
// accepted friendship (contract §3.2: "decline pending OR unfriend
// accepted"). A no-op (no error) if no such row exists.
func (s *Store) Remove(username, other string) error {
	a, b := pair(username, other)
	_, err := s.db.Exec(`DELETE FROM friends WHERE a = $1 AND b = $2`, a, b)
	return err
}
