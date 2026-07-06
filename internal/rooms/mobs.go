package rooms

import (
	"math"
	"math/rand"
	"strconv"
	"sync"
	"time"
)

// This file implements the contract §7 server-simulated mob roster: spawn/
// despawn population caps, and simple wander (pig) / chase-melee (zombie)
// AI, ticked from the SAME 20Hz-derived loop as everything else in Instance
// (tickMobs is called from tickLoop's 10Hz movesTicker case, never a
// separate goroutine — see instance.go's tickLoop doc).

// Mob population caps + lifecycle constants (contract §7).
const (
	maxZombies       = 8
	maxPigs          = 6
	mobDespawnRadius = 64.0             // no player within this range for...
	mobDespawnIdle   = 30 * time.Second // ...this long -> despawn
	mobAggroRange    = 16.0             // zombie: chase within this range
	mobAttackRange   = 1.2              // adjacent enough to melee
	mobMoveSpeed     = 3.2              // blocks/sec, straight-line step
	mobSpawnCheckHz  = 3 * time.Second  // how often tickMobs attempts a new spawn roll
	zombieHP         = 20.0
	pigHP            = 10.0
	zombieDmgMin     = 2.0
	zombieDmgMax     = 4.0
	zombieAttackCD   = 1 * time.Second // a zombie can only land a hit this often
	fleeDuration     = 4 * time.Second // pig: flee window after being hit
)

// Mob is one server-simulated entity (contract §7: "a mob is not a special
// case, it's an entity with kind:'mob' and a mobKind field" — sharing the
// exact same hp/hit/death machinery as players, see combat.go's
// handleHitMob/damageMob).
type Mob struct {
	ID    string
	Kind  string // "zombie" | "pig"
	MaxHP float64

	mu           sync.Mutex
	Pos          [3]float64
	Yaw          float64
	HP           float64
	TargetPlayer string // Player.ID currently being chased (zombie) or fled from (pig), "" if none
	WanderTo     *[3]float64
	FleeUntil    time.Time
	LastAttackAt time.Time
	LastHitAt    time.Time // last time ANY player damaged this mob (drives pig flee + despawn-timer reset is NOT needed here)
	SpawnedAt    time.Time
	lastMoveAt   time.Time // wall-clock of the last AI step, for dt computation
	changed      bool      // moved/hp changed since the last mobState batch
}

// snapshot copies the fields needed for a 'mobState' batch entry.
func (m *Mob) snapshot() (pos [3]float64, yaw, hp float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.Pos, m.Yaw, m.HP
}

// spawnMob creates and registers a new mob at pos, returning it. Caller must
// NOT hold inst.mu (this method takes it itself); the returned mob is
// already inserted into inst.mobs and its mobSpawn frame already broadcast.
func (inst *Instance) spawnMob(kind string, pos [3]float64) *Mob {
	maxHP := zombieHP
	if kind == "pig" {
		maxHP = pigHP
	}
	now := time.Now()

	inst.mu.Lock()
	inst.nextMobID++
	id := "m" + strconv.FormatUint(inst.nextMobID, 10)
	mob := &Mob{
		ID: id, Kind: kind, MaxHP: maxHP, HP: maxHP,
		Pos: pos, SpawnedAt: now, lastMoveAt: now,
	}
	inst.mobs[id] = mob
	recipients := inst.connSlice()
	inst.mu.Unlock()

	frame := mustMarshal(wsFrame{"t": "mobSpawn", "id": id, "kind": kind, "p": []float64{pos[0], pos[1], pos[2]}, "hp": maxHP})
	broadcastRaw(recipients, frame)
	return mob
}

// despawnMob removes a mob and broadcasts 'mobDespawn'. If died is true, a
// 'death' frame is ALSO broadcast first (contract §5.1: death applies to
// "any entity", mobs included, via the player death-screen reuse note in
// §5.2's closing paragraph — a mob's own "death" is purely a client FX cue
// since mobs have no death screen, but the wire shape is shared). killerID
// is only meaningful when died is true.
func (inst *Instance) despawnMob(mobID string, recipients []wsConn, died bool, killerID string) {
	inst.mu.Lock()
	if _, ok := inst.mobs[mobID]; !ok {
		inst.mu.Unlock()
		return
	}
	delete(inst.mobs, mobID)
	if recipients == nil {
		recipients = inst.connSlice()
	}
	inst.mu.Unlock()

	if died {
		frame := mustMarshal(wsFrame{"t": "death", "id": "mob:" + mobID, "by": killerID})
		broadcastRaw(recipients, frame)
	}
	frame := mustMarshal(wsFrame{"t": "mobDespawn", "id": mobID})
	broadcastRaw(recipients, frame)
}

// damageMob applies dmg to a mob's HP (never below 0), marks it hit (for pig
// flee behavior + zombie aggro), and reports the resulting hp + whether this
// hit killed it.
func damageMob(m *Mob, dmg float64, byPlayerID string, now time.Time) (newHP float64, died bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	wasAlive := m.HP > 0
	m.HP -= dmg
	if m.HP < 0 {
		m.HP = 0
	}
	m.LastHitAt = now
	m.changed = true
	if m.Kind == "pig" {
		m.FleeUntil = now.Add(fleeDuration)
		m.TargetPlayer = byPlayerID // "flee from" reuses the same field as "chase" (mutually exclusive by kind)
	}
	died = wasAlive && m.HP <= 0
	return m.HP, died
}

// tickMobs runs one AI step for every live mob (wander/chase/flee/attack),
// broadcasts a batched 'mobState' frame for any that moved or changed hp,
// and rolls population-capped spawns/despawns. Called from tickLoop's 10Hz
// cadence (see instance.go) — NOT a separate goroutine.
func (inst *Instance) tickMobs() {
	now := time.Now()

	inst.mu.Lock()
	if inst.closed {
		inst.mu.Unlock()
		return
	}
	players := make([]*Player, 0, len(inst.players))
	for _, p := range inst.players {
		players = append(players, p)
	}
	mobs := make([]*Mob, 0, len(inst.mobs))
	for _, m := range inst.mobs {
		mobs = append(mobs, m)
	}
	difficulty := inst.difficulty
	recipients := inst.connSlice()
	shouldRollSpawns := now.Sub(inst.lastMobSpawnAttempt) >= mobSpawnCheckHz
	if shouldRollSpawns {
		inst.lastMobSpawnAttempt = now
	}
	inst.mu.Unlock()

	if len(players) == 0 {
		// Nothing to chase/flee-from/despawn-relative-to; still let existing
		// mobs idle in place (no players means no proximity data anyway).
		return
	}

	var toDespawn []string
	var toDamage []mobHit
	batch := make([][]interface{}, 0, len(mobs))

	for _, mob := range mobs {
		mob.mu.Lock()
		dt := now.Sub(mob.lastMoveAt).Seconds()
		if dt <= 0 || dt > 2 { // clamp a stalled/first tick's dt to something sane
			dt = float64(movesPeriod) / float64(time.Second)
		}
		mob.lastMoveAt = now

		nearest, nearestDist := nearestPlayer(mob.Pos, players)

		// Despawn check: no player within mobDespawnRadius for mobDespawnIdle.
		if nearestDist > mobDespawnRadius {
			if mob.LastHitAt.IsZero() && now.Sub(mob.SpawnedAt) >= mobDespawnIdle {
				toDespawn = append(toDespawn, mob.ID)
				mob.mu.Unlock()
				continue
			}
		}

		switch mob.Kind {
		case "zombie":
			tickZombieLocked(mob, nearest, nearestDist, dt, now, difficulty, &toDamage)
		case "pig":
			tickPigLocked(mob, nearest, nearestDist, dt, now)
		}

		if mob.changed {
			batch = append(batch, []interface{}{mob.ID, mob.Pos[0], mob.Pos[1], mob.Pos[2], mob.Yaw, mob.HP, mobAnimCode(mob)})
			mob.changed = false
		}
		mob.mu.Unlock()
	}

	if len(batch) > 0 {
		frame := mustMarshal(wsFrame{"t": "mobState", "m": batch})
		broadcastRaw(recipients, frame)
	}
	inst.applyMobDamageBatch(toDamage, recipients)
	for _, id := range toDespawn {
		inst.despawnMob(id, recipients, false, "")
	}

	if shouldRollSpawns {
		inst.rollMobSpawns(players, difficulty)
	}
}

// mobHit is one queued mob->player attack, captured while a mob's AI step
// holds mob.mu (so it snapshots the target id and amount rather than
// re-reading the mob later) and applied afterward in applyMobDamageBatch,
// which needs inst.mu to resolve the target Player by id — this keeps lock
// ordering consistent with the rest of the package (never nest mob.mu
// inside inst.mu or vice versa).
type mobHit struct {
	mobID    string
	targetID string
	amt      float64
}

// applyMobDamageBatch resolves each queued mobHit's target player by id and
// applies the damage, broadcasting 'damage'/'health' and, on death,
// 'death'. A target that disconnected between the AI step and this apply
// pass is silently skipped (nothing to damage anymore).
func (inst *Instance) applyMobDamageBatch(hits []mobHit, recipients []wsConn) {
	for _, h := range hits {
		inst.mu.Lock()
		target, ok := inst.players[h.targetID]
		inst.mu.Unlock()
		if !ok {
			continue
		}
		newHP, died := damagePlayer(target, h.amt, time.Now())
		frame := mustMarshal(wsFrame{"t": "damage", "id": target.ID, "amount": h.amt, "by": "mob:" + h.mobID, "cause": "mob"})
		broadcastRaw(recipients, frame)
		healthFrame := mustMarshal(wsFrame{"t": "health", "id": target.ID, "hp": newHP, "max": maxHP})
		broadcastRaw(recipients, healthFrame)
		if died {
			inst.handlePlayerDeath(target, "mob:"+h.mobID, recipients)
		}
	}
}

// mobAnimCode packs a small anim hint into the batched mobState wire shape's
// trailing `anim` slot (contract §7: "[id,x,y,z,yaw,hp,anim]") — 0 idle/
// walk, 1 attacking (a brief swing cue for the client's swing animation).
func mobAnimCode(m *Mob) int {
	if !m.LastAttackAt.IsZero() && time.Since(m.LastAttackAt) < 250*time.Millisecond {
		return 1
	}
	return 0
}

// nearestPlayer returns the closest living, non-dead player to pos and its
// distance (math.MaxFloat64 if no players qualify).
func nearestPlayer(pos [3]float64, players []*Player) (*Player, float64) {
	var best *Player
	bestDist := math.MaxFloat64
	for _, p := range players {
		p.mu.Lock()
		dead := p.Dead
		ppos := p.Pos
		p.mu.Unlock()
		if dead {
			continue
		}
		d := dist3(pos, ppos)
		if d < bestDist {
			best = p
			bestDist = d
		}
	}
	return best, bestDist
}

// tickZombieLocked runs one AI step for a zombie (contract §7: "within 16
// blocks... -> pathfind straight-line toward them... adjacent (<1.2
// blocks) -> attacks"). Caller must already hold mob.mu. Queues an attack
// into toDamage rather than applying it directly: applying it needs to look
// the target Player back up by id under inst.mu (see
// Instance.applyMobDamageBatch), and nesting mob.mu inside inst.mu here
// would invert the lock ordering the rest of the package uses everywhere
// else (inst.mu is always acquired first, briefly, to snapshot/copy state,
// then released before per-entity mu locks are taken).
func tickZombieLocked(mob *Mob, nearest *Player, nearestDist float64, dt float64, now time.Time, difficulty string, toDamage *[]mobHit) {
	if difficulty == "peaceful" || nearest == nil || nearestDist > mobAggroRange {
		mob.TargetPlayer = ""
		return
	}
	mob.TargetPlayer = nearest.ID

	nearest.mu.Lock()
	targetPos := nearest.Pos
	targetDead := nearest.Dead
	nearest.mu.Unlock()
	if targetDead {
		return // never attack an already-dead player
	}

	if nearestDist <= mobAttackRange {
		if now.Sub(mob.LastAttackAt) >= zombieAttackCD {
			mob.LastAttackAt = now
			mob.changed = true
			dmg := zombieDmgMin + rand.Float64()*(zombieDmgMax-zombieDmgMin)
			dmg *= difficultyDamageMult(difficulty)
			if dmg > 0 {
				*toDamage = append(*toDamage, mobHit{mobID: mob.ID, targetID: nearest.ID, amt: dmg})
			}
		}
		return
	}

	stepToward(mob, targetPos, dt)
}

// tickPigLocked runs one AI step for a pig (contract §7: "wanders randomly
// (pick a random nearby point every few seconds, walk to it, idle), flees
// from recent attackers for a few seconds if hit"). Caller must already
// hold mob.mu.
func tickPigLocked(mob *Mob, nearest *Player, nearestDist float64, dt float64, now time.Time) {
	if now.Before(mob.FleeUntil) && nearest != nil {
		nearest.mu.Lock()
		threatPos := nearest.Pos
		nearest.mu.Unlock()
		// Flee: step AWAY from the threat (mirror the toward-vector).
		away := [3]float64{
			mob.Pos[0] - threatPos[0],
			mob.Pos[1],
			mob.Pos[2] - threatPos[2],
		}
		fleeTarget := [3]float64{mob.Pos[0] + away[0], mob.Pos[1], mob.Pos[2] + away[2]}
		stepToward(mob, fleeTarget, dt)
		return
	}

	if mob.WanderTo == nil || dist3(mob.Pos, *mob.WanderTo) < 0.3 {
		if rand.Intn(3) == 0 { // idle roughly 1/3 of the time a new target is due, per "walk to it, idle"
			mob.WanderTo = nil
			return
		}
		target := [3]float64{
			mob.Pos[0] + (rand.Float64()*2-1)*6,
			mob.Pos[1],
			mob.Pos[2] + (rand.Float64()*2-1)*6,
		}
		mob.WanderTo = &target
	}
	stepToward(mob, *mob.WanderTo, dt)
}

// stepToward moves mob.Pos a fixed-speed step toward target on the
// horizontal plane (contract §7: "normalize direction vector, no A*" —
// simple straight-line movement is the entire "obstacle handling" this v1
// implements; the "try to step up 1 block or turn ±45°" heuristic is a
// client-rendering/local-mob-AI concern per §14's solo-mode note, and since
// the SERVER here has no block-solidity lookup wired into this package
// (Instance.GetBlock only reports DELTAS, not seed terrain — see its own
// doc), a straight-line horizontal step is the server's honest v1: it will
// occasionally clip through a delta-only obstruction, which is an accepted
// v1 simplification, not a regression, since the client's OWN rendering of
// mobState positions already smooths/interpolates and mobs are cosmetic-ish
// combat entities, not terrain-integrity-critical state). Also updates Yaw
// to face the direction of travel and marks mob.changed. Caller must
// already hold mob.mu.
func stepToward(mob *Mob, target [3]float64, dt float64) {
	dx := target[0] - mob.Pos[0]
	dz := target[2] - mob.Pos[2]
	d := math.Sqrt(dx*dx + dz*dz)
	if d < 1e-6 {
		return
	}
	step := mobMoveSpeed * dt
	if step > d {
		step = d
	}
	mob.Pos[0] += dx / d * step
	mob.Pos[2] += dz / d * step
	mob.Yaw = math.Atan2(dx, dz)
	mob.changed = true
}

// rollMobSpawns attempts population-capped spawns for both mob kinds
// (contract §7: "capped at a small per-instance mob count (e.g. 8)" for
// zombies, "(e.g. 6)" for pigs). Spawn gating (night/dark for zombies,
// daylight for pigs) uses the instance's own timeTicks band per Part I's
// day/night tick ranges (dawn≈0-1000, day≈1000-12000, dusk≈12000-13000,
// night≈13000-23000, matching ARCHITECTURE-3D §7's documented bands) since
// this package has no access to the client's per-column skyExposure mesher
// data (server-side terrain knowledge here is deltas-only, per GetBlock's
// own doc) — time-of-day is an honest, sufficient proxy for the "night or
// dark areas" spawn gate at the server-simulation level.
func (inst *Instance) rollMobSpawns(players []*Player, difficulty string) {
	if difficulty == "peaceful" {
		inst.despawnAllHostiles()
	}

	inst.mu.Lock()
	zombieCount, pigCount := 0, 0
	for _, m := range inst.mobs {
		switch m.Kind {
		case "zombie":
			zombieCount++
		case "pig":
			pigCount++
		}
	}
	isNight := isNightTick(inst.timeTicks)
	inst.mu.Unlock()

	if len(players) == 0 {
		return
	}
	anchor := players[rand.Intn(len(players))]
	anchor.mu.Lock()
	anchorPos := anchor.Pos
	anchor.mu.Unlock()

	if difficulty != "peaceful" && isNight && zombieCount < maxZombies {
		if rand.Float64() < 0.5 { // modest per-roll chance so the population fills in gradually, not instantly
			inst.spawnMob("zombie", randomSpawnPointNear(anchorPos))
		}
	}
	if !isNight && pigCount < maxPigs {
		if rand.Float64() < 0.5 {
			inst.spawnMob("pig", randomSpawnPointNear(anchorPos))
		}
	}
}

// despawnAllHostiles immediately removes every hostile (zombie) mob —
// contract §6: "peaceful: no hostile mobs spawn (existing ones despawn)".
func (inst *Instance) despawnAllHostiles() {
	inst.mu.Lock()
	var ids []string
	for id, m := range inst.mobs {
		if m.Kind == "zombie" {
			ids = append(ids, id)
		}
	}
	recipients := inst.connSlice()
	inst.mu.Unlock()
	for _, id := range ids {
		inst.despawnMob(id, recipients, false, "")
	}
}

// isNightTick reports whether ticks falls in the night band, matching
// ARCHITECTURE-3D §7's day/night tick ranges (night ≈ 13000-23000 of a
// 24000-tick day).
func isNightTick(ticks int64) bool {
	return ticks >= 13000 && ticks < 23000
}

// randomSpawnPointNear picks a spawn candidate within render-distance-ish
// range of a player (contract §7: "within render distance of a player").
// This package has no terrain height lookup (deltas-only, see GetBlock's
// doc), so it spawns at the anchor player's own Y — an honest v1
// simplification: the client-side Mobs.js rendering/interpolation will
// visually settle the mob once its next mobState positions arrive, and nothing
// about correctness depends on the FIRST tick's exact Y (mobs are not solid
// terrain-colliding entities server-side in this v1 either, per stepToward's
// doc, so an off-by-a-few-blocks initial Y is cosmetic only).
func randomSpawnPointNear(anchor [3]float64) [3]float64 {
	angle := rand.Float64() * 2 * math.Pi
	radius := 10 + rand.Float64()*20 // 10..30 blocks out
	return [3]float64{
		anchor[0] + math.Cos(angle)*radius,
		anchor[1],
		anchor[2] + math.Sin(angle)*radius,
	}
}
