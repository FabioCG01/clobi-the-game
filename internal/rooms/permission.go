package rooms

import "strings"

// CanJoin implements the join permission rules pinned in the contract §3.1:
//
//	banned=no v1; `private` -> host only (and world owner); `friends` ->
//	host's accepted friends UNION world members UNION owner; `password` ->
//	anyone with correct PIN (bcrypt compare); `public` -> anyone incl.
//	guests. Members and the owner ALWAYS pass access checks (any access
//	level). Guests may join only `public` (and never host).
//
// user is the resolved account username ("" for a guest — guests never have
// an account username, so membership/ownership/friendship checks correctly
// never match them). guest indicates a guest connection (nick-based, no
// account). pin is the plaintext PIN offered by the client for a password
// room (ignored for other access levels).
//
// CanJoin never itself enforces the player cap — that is a separate,
// simpler numeric check the caller (Instance.tryJoin) applies after
// permission passes, so cap-full is a distinguishable error from
// access-denied.
func (inst *Instance) CanJoin(user string, guest bool, pin string) bool {
	access := inst.Access()

	// Members and the owner always pass, at any access level, account
	// users only (a guest never has a username to match against).
	if !guest && user != "" {
		if inst.isOwner(user) {
			return true
		}
		if isMember, _ := inst.store.IsMember(inst.World.ID, user); isMember {
			return true
		}
	}

	switch access {
	case "public":
		return true // anyone, including guests
	case "password":
		if guest {
			return false // guests may only join public rooms
		}
		return inst.checkPin(pin)
	case "friends":
		if guest || user == "" {
			return false
		}
		host := inst.HostUsername()
		if strings.EqualFold(user, host) {
			return true // hosting yourself always passes (defensive; host already connected)
		}
		if inst.friends == nil {
			return false
		}
		ok, _ := inst.friends.AreFriends(user, host)
		return ok
	case "private":
		if guest || user == "" {
			return false
		}
		return strings.EqualFold(user, inst.HostUsername())
	default:
		return false
	}
}

// isOwner reports whether user is the world's owner.
func (inst *Instance) isOwner(user string) bool {
	return user != "" && strings.EqualFold(user, inst.World.Owner)
}
