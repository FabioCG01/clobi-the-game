package rooms

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// This file implements the contract §10 (closing MP paragraph) server-
// tracked drop entities: spawn/despawn broadcasts mirroring the mob pattern
// established in mobs.go, and pickup{dropId} validation.
//
// Trust posture (documented explicitly, per the contract's own instruction
// to document this as "an explicit simplification, not an oversight"): the
// server validates PROXIMITY (the requesting player must be within
// pickupRadius of the drop) before confirming a pickup, but does NOT
// validate inventory space server-side — inventory is never server-tracked
// anywhere in Parts I/II/III (confirmed by this package's existing design:
// no inventory field exists on Player at all), so "does the client have
// room" is trusted entirely to the client's own Inventory.add() check. This
// is a deliberate low-stakes simplification: at worst a player who fibs
// about having room duplicates a drop's despawn without actually gaining
// the item client-side, which is a cosmetic desync, not an economy exploit
// (there is no server-side economy to exploit).

// dropDespawnAfter is how long an unclaimed drop persists before despawning
// (contract §11: "despawn after 5 min").
const dropDespawnAfter = 5 * time.Minute

// pickupRadius is the proximity a pickup{} request is validated against
// (contract §11: "radius ~1.2 blocks").
const pickupRadius = 1.2

// Drop is one server-tracked dropped-item entity (contract §10's MP
// paragraph: "a `drops map[string]Drop{id,pos,stack,spawnedAt}`, same
// pattern as the mob map").
type Drop struct {
	ID        string
	Pos       [3]float64
	Stack     DropStack
	SpawnedAt time.Time

	mu sync.Mutex
}

// DropStack mirrors the client-side {id,count,kind} stack shape (contract
// §4/§11) so a drop's payload round-trips through JSON exactly as the
// client's own Inventory stack entries do.
type DropStack struct {
	ID    string `json:"id"`
	Count int    `json:"count"`
	Kind  string `json:"kind"` // "block" | "item"
}

// spawnDrop creates and registers a new server-tracked drop, broadcasting
// 'dropSpawn'. Used both for manual drops (client 'drop' local action that
// then tells the server, mirroring how 'block' edits are echoed
// authoritatively) and death drops when keepInventory is off — though per
// §5.2, death-inventory-clearing is a CLIENT-side action in this v1; the
// server's drops map exists purely for the manual-drop/pickup path described
// in §10/§11, not for auto-populating death loot server-side.
func (inst *Instance) spawnDrop(pos [3]float64, stack DropStack) *Drop {
	inst.mu.Lock()
	inst.nextDropID++
	id := "d" + strconv.FormatUint(inst.nextDropID, 10)
	d := &Drop{ID: id, Pos: pos, Stack: stack, SpawnedAt: time.Now()}
	inst.drops[id] = d
	recipients := inst.connSlice()
	inst.mu.Unlock()

	frame := mustMarshal(wsFrame{"t": "dropSpawn", "id": id, "pos": []float64{pos[0], pos[1], pos[2]}, "stack": stack})
	broadcastRaw(recipients, frame)
	return d
}

// despawnDrop removes a drop and broadcasts 'dropDespawn'.
func (inst *Instance) despawnDrop(dropID string, recipients []wsConn) {
	inst.mu.Lock()
	if _, ok := inst.drops[dropID]; !ok {
		inst.mu.Unlock()
		return
	}
	delete(inst.drops, dropID)
	if recipients == nil {
		recipients = inst.connSlice()
	}
	inst.mu.Unlock()

	frame := mustMarshal(wsFrame{"t": "dropDespawn", "id": dropID})
	broadcastRaw(recipients, frame)
}

// tickDrops despawns any drop older than dropDespawnAfter. Called from
// tickLoop's 10Hz cadence alongside tickMobs (see instance.go) — drops have
// no per-tick physics/AI of their own server-side (contract §11: drop
// bob/spin/gravity is purely a client rendering concern; the server only
// tracks position+stack+age), so this is intentionally the only per-tick
// work drops need.
func (inst *Instance) tickDrops() {
	now := time.Now()
	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return
	}
	var expired []string
	for id, d := range inst.drops {
		if now.Sub(d.SpawnedAt) >= dropDespawnAfter {
			expired = append(expired, id)
		}
	}
	recipients := inst.connSlice()
	inst.mu.Unlock()

	for _, id := range expired {
		inst.despawnDrop(id, recipients)
	}
}

// ---- manual drop (client 'drop' action, contract §10) --------------------

// dropMsg is the client's request to drop one stack from its own inventory
// (Q key / touch drop button, see ARCHITECTURE-COMBAT.md §10). Only the
// stack being dropped is client-supplied; the SPAWN POSITION is always the
// server's own last-known position for that player (p.Pos, kept current by
// the existing 'move' handling) rather than anything the client claims,
// exactly so a client can't request a drop appear somewhere it isn't — the
// same "trust the server's tracked position, not a client-asserted one"
// posture handleHit already applies to attacker/target ranges.
type dropMsg struct {
	Stack DropStack `json:"stack"`
}

// maxDropStackCount is a generous wire-format sanity ceiling (not a game-rule
// stack cap enforcement — that lives client-side in Inventory.MAX_STACK,
// contract §5.12); this just stops a malformed/hostile client from asking the
// server to broadcast an absurd count.
const maxDropStackCount = 64

// handleDrop validates the wire-format shape of a manual drop request and
// spawns it at the player's own last-known server-tracked position (p.Pos).
// Contract §10 asks for the drop to appear "slightly in front of the player,
// along their look direction" -- that's a client-side rendering nicety
// (Drops.spawn's own local-sim path already offsets it that way for the
// dropping player's own view), not something worth adding a yaw field to the
// wire protocol for: every OTHER connected client's pickup-range/proximity
// check only cares about p.Pos being roughly right, not sub-block-perfect.
func handleDrop(inst *Instance, p *Player, raw []byte) {
	var dm dropMsg
	if json.Unmarshal(raw, &dm) != nil {
		return
	}
	if dm.Stack.ID == "" || dm.Stack.Count <= 0 || dm.Stack.Count > maxDropStackCount {
		return
	}
	if dm.Stack.Kind != "block" && dm.Stack.Kind != "item" {
		return
	}

	p.mu.Lock()
	pos := p.Pos
	p.mu.Unlock()

	inst.spawnDrop(pos, dm.Stack)
}

// ---- pickup ---------------------------------------------------------

type pickupMsg struct {
	DropID string `json:"dropId"`
}

// handlePickup implements contract §11's server-authoritative pickup
// validation: proximity-checked (the requester's last known position must
// be within pickupRadius of the drop), inventory-space trust delegated to
// the client (see this file's top-of-file doc). On success, the drop is
// removed and 'dropDespawn' is broadcast — the requesting client is expected
// to have already optimistically added the stack to its own Inventory (or
// does so upon seeing its own pickup take effect); other clients simply see
// the drop disappear, matching the mob-despawn broadcast pattern.
func handlePickup(inst *Instance, p *Player, raw []byte) {
	var pm pickupMsg
	if json.Unmarshal(raw, &pm) != nil || pm.DropID == "" {
		return
	}

	inst.mu.Lock()
	drop, ok := inst.drops[pm.DropID]
	recipients := inst.connSlice()
	inst.mu.Unlock()
	if !ok {
		return // already collected/despawned: reject silently (race is normal)
	}

	drop.mu.Lock()
	dropPos := drop.Pos
	drop.mu.Unlock()

	p.mu.Lock()
	playerPos := p.Pos
	p.mu.Unlock()

	if dist3(playerPos, dropPos) > pickupRadius {
		return // out of range: reject silently
	}

	inst.despawnDrop(pm.DropID, recipients)
}
