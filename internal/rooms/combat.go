package rooms

import (
	"encoding/json"
	"math"
	"strings"
	"time"
)

// This file implements the contract §5.2 server-authoritative combat model:
// hit validation (range + cooldown), damage computation (weapon vs armor),
// death/respawn, and the low-stakes selfDamage path for client-detected
// environmental damage (fall/drown/void/cactus) in multiplayer (§8).
//
// A "target" in 'hit{targetId}' is either a player id (e.g. "p3", exactly
// the Player.ID assigned at join) or "mob:<mobId>" (contract §5.1). Both
// kinds of entity share the exact same hp/hit/death machinery per §7's
// closing paragraph ("a mob is not a special case, it's an entity with
// kind:'mob'") — the two branches below differ only in where the target's
// position/hp/armor live (Player vs Mob), not in the validation or damage
// formula itself.

// swordDamageByTier mirrors the client js/vox/items.js Items registry's
// sword damage table (contract §4: "damage (sword: 4/5/6/8 wood..diamond;
// fist=1)"). This package cannot import the client-only JS registry (Go/JS
// boundary — no shared code across the language split, same duplication
// posture as §14's mob-AI note), so it keeps its own small mirror keyed by
// the same item id strings the client sends via 'move'.Held.ID/'hit' path.
var swordDamageByTier = map[string]float64{
	"sword_wood": 4, "sword_stone": 5, "sword_iron": 6, "sword_diamond": 8,
}

// attackerDamage resolves the damage a hit deals based on the attacker's
// currently-held item, per contract §5.2: "attacker's equipped sword
// Items.def(id).damage else fist=1". Non-sword held items (tools, blocks,
// empty hand) all deal fist damage — only swords get the weapon table.
func attackerDamage(heldID string) float64 {
	if d, ok := swordDamageByTier[heldID]; ok {
		return d
	}
	return fistDamage
}

// applyArmorReduction implements the exact contract §5.2 formula:
// `dmg * max(0.2, 1 - armorPoints*0.04)`.
func applyArmorReduction(dmg, armorPoints float64) float64 {
	mult := 1 - armorPoints*armorReductionK
	if mult < minDamageMult {
		mult = minDamageMult
	}
	return dmg * mult
}

// dist3 returns the straight-line distance between two [3]float64 points.
func dist3(a, b [3]float64) float64 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

// ---- hit --------------------------------------------------------------

type hitMsg struct {
	TargetID string `json:"targetId"`
}

// handleHit implements the contract §5.2 hit-validation gate EXACTLY:
// attacker's claimed position (from their last 'move') within 4.5 blocks of
// the target's last known position, AND the attacker hasn't hit within the
// last 350ms — both must pass before any damage is computed. Silently
// no-ops (does not error/kick) on a rejected hit: a marginal miss due to
// network lag is normal gameplay noise, not a protocol violation worth
// warning about, matching how the existing block/move handlers already
// silently drop invalid-but-plausible edits (see validBlockEdit's doc).
func handleHit(inst *Instance, attacker *Player, raw []byte) {
	var hm hitMsg
	if json.Unmarshal(raw, &hm) != nil || hm.TargetID == "" {
		return
	}

	now := time.Now()
	attacker.mu.Lock()
	if now.Sub(attacker.lastHitAt) < hitCooldown {
		attacker.mu.Unlock()
		return // cooldown not elapsed: reject silently
	}
	attackerPos := attacker.Pos
	heldID := attacker.HeldID
	attackerDead := attacker.Dead
	attacker.mu.Unlock()
	if attackerDead {
		return // a dead player cannot attack
	}

	if mobID, isMob := strings.CutPrefix(hm.TargetID, "mob:"); isMob {
		handleHitMob(inst, attacker, attackerPos, heldID, mobID, now)
		return
	}
	handleHitPlayer(inst, attacker, attackerPos, heldID, hm.TargetID, now)
}

// handleHitPlayer resolves a PvP hit against another connected player.
func handleHitPlayer(inst *Instance, attacker *Player, attackerPos [3]float64, heldID, targetID string, now time.Time) {
	inst.mu.Lock()
	target, ok := inst.players[targetID]
	recipients := inst.connSlice()
	inst.mu.Unlock()
	if !ok || target.ID == attacker.ID {
		return // unknown target or self-hit: reject silently
	}

	target.mu.Lock()
	targetPos := target.Pos
	targetDead := target.Dead
	targetArmor := target.Armor
	target.mu.Unlock()
	if targetDead {
		return
	}
	if dist3(attackerPos, targetPos) > hitRange {
		return // out of range: reject silently
	}

	// Both gates passed: commit the cooldown and compute damage.
	attacker.mu.Lock()
	attacker.lastHitAt = now
	attacker.mu.Unlock()

	dmg := applyArmorReduction(attackerDamage(heldID), totalArmorPoints(targetArmor))
	newHP, died := damagePlayer(target, dmg, now)

	frame := mustMarshal(wsFrame{"t": "damage", "id": target.ID, "amount": dmg, "by": attacker.ID, "cause": "player"})
	broadcastRaw(recipients, frame)
	healthFrame := mustMarshal(wsFrame{"t": "health", "id": target.ID, "hp": newHP, "max": maxHP})
	broadcastRaw(recipients, healthFrame)
	if died {
		inst.handlePlayerDeath(target, attacker.ID, recipients)
	}
}

// handleHitMob resolves a PvE hit against a server-simulated mob.
func handleHitMob(inst *Instance, attacker *Player, attackerPos [3]float64, heldID, mobID string, now time.Time) {
	inst.mu.Lock()
	mob, ok := inst.mobs[mobID]
	recipients := inst.connSlice()
	inst.mu.Unlock()
	if !ok {
		return
	}

	mob.mu.Lock()
	mobPos := mob.Pos
	mob.mu.Unlock()
	if dist3(attackerPos, mobPos) > hitRange {
		return
	}

	attacker.mu.Lock()
	attacker.lastHitAt = now
	attacker.mu.Unlock()

	// Mobs wear no armor: dmg applies at full attacker value.
	dmg := attackerDamage(heldID)
	newHP, died := damageMob(mob, dmg, attacker.ID, now)

	frame := mustMarshal(wsFrame{"t": "damage", "id": "mob:" + mob.ID, "amount": dmg, "by": attacker.ID, "cause": "player"})
	broadcastRaw(recipients, frame)
	healthFrame := mustMarshal(wsFrame{"t": "health", "id": "mob:" + mob.ID, "hp": newHP, "max": mob.MaxHP})
	broadcastRaw(recipients, healthFrame)
	if died {
		inst.despawnMob(mob.ID, recipients, true, attacker.ID)
	}
}

// damagePlayer applies dmg to a player's HP (never below 0), resets their
// regen idle window, and reports the resulting hp + whether this hit killed
// them (hp crossed from >0 to <=0 — so a hit landing on an already-dead
// player, which handleHit's callers already filter out, never double-fires
// death). Returns the new hp for the caller's 'health' broadcast.
func damagePlayer(p *Player, dmg float64, now time.Time) (newHP float64, died bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.HP -= dmg
	if p.HP < 0 {
		p.HP = 0
	}
	p.lastDamageAt = now
	p.hpChanged = true
	if p.HP <= 0 && !p.Dead {
		p.Dead = true
		died = true
	}
	return p.HP, died
}

// handlePlayerDeath broadcasts 'death' for a player who just hit 0 hp. by is
// the killer's Player.ID (PvP) or "" (environmental/mob — mob-kill 'by' is
// the mob's synthetic "mob:<id>" form, environmental is "").
func (inst *Instance) handlePlayerDeath(target *Player, by string, recipients []wsConn) {
	frame := mustMarshal(wsFrame{"t": "death", "id": target.ID, "by": by})
	broadcastRaw(recipients, frame)
}

// ---- respawn ------------------------------------------------------------

// handleRespawn implements the contract §5.1/§5.2 respawn{} handler: resets
// the requesting player's hp to 20 and repositions them at the instance's
// world spawn (the same spawn point mechanism join-time positioning already
// uses). A respawn request from a player who isn't actually dead is a
// harmless no-op-ish reset (never an error) — simplest, safest behavior for
// a client that might race its own death overlay dismissal.
func handleRespawn(inst *Instance, p *Player) {
	inst.mu.Lock()
	spawn := inst.spawn
	recipients := inst.connSlice()
	inst.mu.Unlock()

	p.mu.Lock()
	p.HP = maxHP
	p.Dead = false
	p.Pos = spawn
	p.lastDamageAt = time.Time{}
	p.hpChanged = true
	p.changed = true
	p.mu.Unlock()

	healthFrame := mustMarshal(wsFrame{"t": "health", "id": p.ID, "hp": maxHP, "max": maxHP})
	broadcastRaw(recipients, healthFrame)
}

// ---- selfDamage (trusted, low-stakes environmental damage) --------------

type selfDamageMsg struct {
	Amount float64 `json:"amount"`
	Cause  string  `json:"cause"`
}

// validSelfDamageCauses are the only causes a client may self-report,
// matching the 'damage' cause enum from contract §5.1 minus 'player'/'mob'
// (those are always server-computed, never client-claimed).
var validSelfDamageCauses = map[string]bool{"fall": true, "drown": true, "void": true, "cactus": true}

// maxSelfDamagePerReport caps a single selfDamage report defensively (never
// more than a full health bar in one message) — the contract explicitly
// accepts this path is trusted "at low stakes tolerances", but an
// unbounded/negative amount is still worth clamping since it's free insurance
// against a malformed or hostile client, not a real anti-cheat gate.
const maxSelfDamagePerReport = maxHP

// handleSelfDamage implements contract §8's client-trusted environmental
// damage path: "the CLIENT computes the amount using Part I's existing
// formulas and sends it via a new lightweight selfDamage{amount,cause}
// message that the server trusts at low stakes tolerances". This is the
// ONLY damage path that trusts a client-claimed amount — 'hit' (§5.2)
// remains fully server-computed.
func handleSelfDamage(inst *Instance, p *Player, raw []byte) {
	var sm selfDamageMsg
	if json.Unmarshal(raw, &sm) != nil {
		return
	}
	if !validSelfDamageCauses[sm.Cause] {
		return
	}
	if sm.Amount <= 0 {
		return
	}
	if sm.Amount > maxSelfDamagePerReport {
		sm.Amount = maxSelfDamagePerReport
	}

	now := time.Now()
	p.mu.Lock()
	wasDead := p.Dead
	p.mu.Unlock()
	if wasDead {
		return
	}

	newHP, died := damagePlayer(p, sm.Amount, now)

	inst.mu.Lock()
	recipients := inst.connSlice()
	inst.mu.Unlock()

	frame := mustMarshal(wsFrame{"t": "damage", "id": p.ID, "amount": sm.Amount, "by": "", "cause": sm.Cause})
	broadcastRaw(recipients, frame)
	healthFrame := mustMarshal(wsFrame{"t": "health", "id": p.ID, "hp": newHP, "max": maxHP})
	broadcastRaw(recipients, healthFrame)
	if died {
		inst.handlePlayerDeath(p, "", recipients)
	}
}
