// Package game is the pure, authoritative simulation for TUX SMASH ROYALE. It
// contains no networking: callers feed inputs with ApplyInput and advance the
// world one tick at a time with Step, broadcasting the returned Snapshot.
//
// Two modes share one engine:
//
//   - ModeSmash:  a square platform surrounded by void. Knockback is amplified
//     by accumulated damage percent; falling off the edge (ring-out) costs a
//     life; last fighter with lives remaining wins.
//   - ModeRoyale: an enclosed arena with a shrinking minty "Menthol Zone".
//     Standing outside the zone takes BSOD-storm damage-per-second; last
//     penguin/human with HP remaining wins.
//
// Shared systems: 8-direction movement, a melee belly-bash arc, a LibreOffice
// frisbee throw, a belly dash, vim specials (":wq" blink, "dd" projectile purge
// + brief invulnerability, "sudo" radial AoE gated by a meter), time-based
// pickups ("fisherman","fork","libre","windows"), the Activate Windows debuff,
// and simple seek/attack/avoid bots that fill empty slots.
package game

import (
	"math"
	"math/rand"
	"sort"
	"strings"
	"time"

	"clobi/internal/protocol"
)

// Mode selects the ruleset.
type Mode string

const (
	ModeSmash  Mode = "smash"
	ModeRoyale Mode = "royale"
)

// World geometry. The simulation runs in an abstract coordinate space; the
// client scales it to the canvas.
const (
	worldW = 1000.0
	worldH = 1000.0

	// Smash platform (centered square) with a void all around it.
	platformLeft   = 250.0
	platformTop    = 250.0
	platformRight  = 750.0
	platformBottom = 750.0

	// Royale arena bounds (full world, walls at the edges).
	arenaMargin = 40.0
)

// Player / movement tuning.
const (
	playerRadius   = 22.0
	baseSpeed      = 165.0 // units per second
	boostSpeedMul  = 1.45
	friction       = 0.86 // per-tick velocity damping applied to knockback
	maxStartLives  = 3
	royaleStartHP  = 100.0
	royaleStormDPS = 14.0
)

// Combat tuning.
const (
	meleeRange       = 64.0
	meleeArcCos      = 0.30 // dot-product threshold ~ +/-72.5 degrees
	meleeCooldown    = 0.45 // seconds
	meleeBaseKB      = 240.0
	meleeBaseDmg     = 7.0
	boostDmgBonus    = 4.0
	dashSpeed        = 520.0
	dashDuration     = 0.18
	dashCooldown     = 0.9
	throwCooldown    = 0.55
	projSpeed        = 430.0
	projLife         = 1.6 // seconds
	projDmg          = 6.0
	projKB           = 160.0
	projRadius       = 14.0
	invulnAfterHit   = 0.35
	windowsDebuffDur = 10 * time.Second
)

// Vim special tuning.
const (
	blinkDist     = 150.0
	ddInvuln      = 1.0 // seconds of invulnerability from "dd"
	ddPurgeRange  = 220.0
	sudoCost      = 1.0 // full meter
	sudoRange     = 200.0
	sudoKB        = 360.0
	sudoDmg       = 9.0
	meterRegenSec = 8.0 // seconds to refill the sudo meter from empty
)

// Pickup tuning.
const (
	pickupInterval = 4.0 // seconds between pickup spawns
	maxPickups     = 6
	fishermanDur   = 8 * time.Second
	libreAmmo      = 3
	forkLifetime   = 7 * time.Second
)

// Zone tuning (royale).
const (
	zoneStartR    = 520.0
	zoneEndR      = 90.0
	zoneShrinkSec = 60.0 // seconds to fully close
)

// Participant describes one fighter slot. Bot players are CPU controlled.
type Participant struct {
	ID        string
	Nickname  string
	Character protocol.Character
	Bot       bool
}

// projectile is an in-flight entity.
type projectile struct {
	x, y   float64
	vx, vy float64
	life   float64
	owner  string
	kind   string
}

// pickup is a collectible on the ground.
type pickup struct {
	x, y float64
	kind string
}

// player is the full per-fighter simulation state.
type player struct {
	id        string
	nickname  string
	character protocol.Character
	bot       bool

	x, y   float64
	vx, vy float64 // knockback / dash velocity (decays via friction)
	facing int     // -1 left, +1 right

	hp     float64 // royale only
	damage float64 // smash only (accumulated percent)
	lives  int     // smash only
	alive  bool

	meleeCD float64
	throwCD float64
	dashCD  float64
	dashT   float64 // remaining dash time
	invuln  float64 // remaining invulnerability time

	boostT  float64 // remaining fisherman boost
	ammo    int     // libre throw charges
	meter   float64 // sudo meter [0,1]
	windows int64   // unix-millis: Activate Windows debuff expiry
	forkT   float64 // remaining lifetime for fork clones (0 = permanent)
	isFork  bool    // spawned by the fork pickup

	// latest input for this tick
	in protocol.InputMsg

	// bot AI bookkeeping
	aiTimer float64
}

// Match is one running game instance. It is not safe for concurrent use; the
// owning room goroutine must serialize ApplyInput/Step calls.
type Match struct {
	mode    Mode
	players []*player
	byID    map[string]*player

	projectiles []*projectile
	pickups     []*pickup

	tick        int64
	pickupTimer float64
	elapsed     float64

	// royale zone state
	zoneCx, zoneCy float64
	zoneR          float64

	rng *rand.Rand

	over       bool
	winnerID   string
	winnerNick string
}

// NewMatch builds a match for the given mode and players, padding the roster
// with CPU bots so the game is playable from a single human up to the mode cap
// (4 for smash, 16 for royale).
func NewMatch(mode Mode, players []Participant) *Match {
	if mode != ModeSmash && mode != ModeRoyale {
		mode = ModeSmash
	}

	cap := 16
	min := 2 // always pad to >=2 so a lone human gets at least one bot (royale included)
	if mode == ModeSmash {
		cap = 4
	}

	src := make([]Participant, 0, len(players))
	src = append(src, players...)
	if len(src) > cap {
		src = src[:cap]
	}

	// Ensure at least `min` total participants by adding bots.
	want := len(src)
	if want < min {
		want = min
	}

	m := &Match{
		mode: mode,
		byID: make(map[string]*player),
		rng:  rand.New(rand.NewSource(time.Now().UnixNano())),
	}

	botNames := []string{
		"vim.exe", "EmacsBot", "ClippyJr", "BSOD-9000", "Menthol", "sudo_bot",
		"DistroDan", "PenguPal", "GrubLoader", "Kernel", "Bash", "Cron",
		"Daemon", "Sandbox", "Tarball", "Mountpoint",
	}

	for i := 0; i < want; i++ {
		var p Participant
		if i < len(src) {
			p = src[i]
		} else {
			name := botNames[(i)%len(botNames)]
			p = Participant{
				ID:        "bot-" + name + "-" + itoa(i),
				Nickname:  name,
				Character: randomBotCharacter(m.rng),
				Bot:       true,
			}
		}
		pl := m.newPlayer(p)
		m.players = append(m.players, pl)
		m.byID[pl.id] = pl
	}

	m.spawnPositions()

	if mode == ModeRoyale {
		// Random-ish zone center, biased toward the middle.
		m.zoneCx = worldW/2 + (m.rng.Float64()-0.5)*160
		m.zoneCy = worldH/2 + (m.rng.Float64()-0.5)*160
		m.zoneR = zoneStartR
	}

	return m
}

func (m *Match) newPlayer(p Participant) *player {
	ch := p.Character
	if ch.BodyType != "tux" && ch.BodyType != "humanoid" {
		ch.BodyType = "tux"
	}
	pl := &player{
		id:        p.ID,
		nickname:  p.Nickname,
		character: ch,
		bot:       p.Bot,
		facing:    1,
		hp:        royaleStartHP,
		lives:     maxStartLives,
		alive:     true,
		ammo:      1,
		meter:     1.0,
	}
	return pl
}

// spawnPositions arranges players on a ring so nobody overlaps at the start.
func (m *Match) spawnPositions() {
	var cx, cy, r float64
	if m.mode == ModeSmash {
		cx = (platformLeft + platformRight) / 2
		cy = (platformTop + platformBottom) / 2
		r = (platformRight - platformLeft) / 2 * 0.6
	} else {
		cx = worldW / 2
		cy = worldH / 2
		r = zoneStartR * 0.7
	}
	n := len(m.players)
	for i, pl := range m.players {
		ang := (float64(i) / float64(n)) * 2 * math.Pi
		pl.x = cx + math.Cos(ang)*r
		pl.y = cy + math.Sin(ang)*r
		if pl.x < cx {
			pl.facing = 1
		} else {
			pl.facing = -1
		}
	}
}

// ApplyInput records the latest input frame for a player (ignored for bots and
// unknown IDs).
func (m *Match) ApplyInput(playerID string, in protocol.InputMsg) {
	pl, ok := m.byID[playerID]
	if !ok || pl.bot {
		return
	}
	pl.in = in
}

// Step advances the simulation by dt seconds and returns the snapshot to
// broadcast. When the match resolves, over is true and the winner fields are
// populated (winnerID/winnerNick may be empty on a draw / all-out).
func (m *Match) Step(dt float64) (protocol.Snapshot, bool, string, string) {
	if dt <= 0 {
		dt = 1.0 / 30.0
	}
	m.tick++
	m.elapsed += dt

	if !m.over {
		m.updateBots(dt)
		m.updateZone(dt)
		m.applyMovementAndActions(dt)
		m.updateProjectiles(dt)
		m.updatePickups(dt)
		m.applyEnvironment(dt)
		m.checkWinner()
	}

	snap := m.snapshot()
	return snap, m.over, m.winnerID, m.winnerNick
}

// updateZone shrinks the royale Menthol Zone toward its end radius.
func (m *Match) updateZone(dt float64) {
	if m.mode != ModeRoyale {
		return
	}
	// Linear interpolation toward zoneEndR over zoneShrinkSec seconds.
	frac := m.elapsed / zoneShrinkSec
	if frac > 1 {
		frac = 1
	}
	m.zoneR = zoneStartR + (zoneEndR-zoneStartR)*frac
}

// applyMovementAndActions integrates per-player intent: movement, dash, melee,
// throw and vim specials, then resolves collisions and integrates velocity.
func (m *Match) applyMovementAndActions(dt float64) {
	for _, pl := range m.players {
		if !pl.alive {
			continue
		}
		m.tickTimers(pl, dt)

		in := pl.in

		// Facing from horizontal intent.
		if in.Dx > 0.1 {
			pl.facing = 1
		} else if in.Dx < -0.1 {
			pl.facing = -1
		}

		// Normalize movement vector.
		mx, my := in.Dx, in.Dy
		if mag := math.Hypot(mx, my); mag > 1 {
			mx /= mag
			my /= mag
		}

		speed := baseSpeed
		if pl.boostT > 0 {
			speed *= boostSpeedMul
		}

		// Dash: a short burst of high speed in the facing/move direction.
		if in.Dash && pl.dashCD <= 0 && pl.dashT <= 0 {
			dx, dy := mx, my
			if dx == 0 && dy == 0 {
				dx = float64(pl.facing)
			}
			if mag := math.Hypot(dx, dy); mag > 0 {
				dx /= mag
				dy /= mag
			}
			pl.vx += dx * dashSpeed
			pl.vy += dy * dashSpeed
			pl.dashT = dashDuration
			pl.dashCD = dashCooldown
			pl.invuln = math.Max(pl.invuln, 0.12)
		}

		// Base locomotion (added to decaying knockback/dash velocity).
		moveVX := mx * speed
		moveVY := my * speed

		// Melee belly-bash.
		if in.Attack && pl.meleeCD <= 0 {
			m.doMelee(pl)
			pl.meleeCD = meleeCooldown
		}

		// LibreOffice frisbee throw.
		if in.Throw && pl.throwCD <= 0 && pl.ammo > 0 {
			m.doThrow(pl)
			pl.throwCD = throwCooldown
			pl.ammo--
		}

		// Vim specials (consume the command for this tick).
		if cmd := strings.TrimSpace(strings.ToLower(in.Vim)); cmd != "" {
			m.doVim(pl, cmd)
		}
		pl.in.Vim = "" // command is one-shot

		// Integrate position: locomotion + decaying velocity.
		pl.x += (moveVX + pl.vx) * dt
		pl.y += (moveVY + pl.vy) * dt

		// Decay knockback/dash velocity.
		pl.vx *= friction
		pl.vy *= friction
		if math.Hypot(pl.vx, pl.vy) < 4 {
			pl.vx, pl.vy = 0, 0
		}

		// Sudo meter regen.
		if pl.meter < 1 {
			pl.meter += dt / meterRegenSec
			if pl.meter > 1 {
				pl.meter = 1
			}
		}
	}

	// Soft player-vs-player separation so bodies don't fully overlap.
	m.separatePlayers()

	// Royale: keep players inside the arena walls (no void to fall into).
	if m.mode == ModeRoyale {
		for _, pl := range m.players {
			if !pl.alive {
				continue
			}
			pl.x = clamp(pl.x, arenaMargin+playerRadius, worldW-arenaMargin-playerRadius)
			pl.y = clamp(pl.y, arenaMargin+playerRadius, worldH-arenaMargin-playerRadius)
		}
	}
}

func (m *Match) tickTimers(pl *player, dt float64) {
	pl.meleeCD = decay(pl.meleeCD, dt)
	pl.throwCD = decay(pl.throwCD, dt)
	pl.dashCD = decay(pl.dashCD, dt)
	pl.dashT = decay(pl.dashT, dt)
	pl.invuln = decay(pl.invuln, dt)
	if pl.boostT > 0 {
		pl.boostT = decay(pl.boostT, dt)
	}
	if pl.isFork {
		pl.forkT = decay(pl.forkT, dt)
		if pl.forkT <= 0 {
			pl.alive = false // fork clone expires
		}
	}
}

// doMelee applies the belly-bash arc: damage + knockback to targets within range
// and roughly in front of the attacker.
func (m *Match) doMelee(att *player) {
	fx := float64(att.facing)
	dmg := meleeBaseDmg
	if att.boostT > 0 {
		dmg += boostDmgBonus
	}
	for _, t := range m.players {
		if t == att || !t.alive || t.invuln > 0 {
			continue
		}
		dx := t.x - att.x
		dy := t.y - att.y
		dist := math.Hypot(dx, dy)
		if dist > meleeRange+playerRadius || dist == 0 {
			continue
		}
		// In-front check (dot product with facing on the x axis, lenient on y).
		nx := dx / dist
		if nx*fx < meleeArcCos && math.Abs(dy) > meleeRange*0.7 {
			continue
		}
		m.hit(att, t, dx, dy, dist, dmg, meleeBaseKB, true)
	}
}

// doThrow spawns a LibreOffice frisbee projectile in the attacker's facing.
func (m *Match) doThrow(att *player) {
	dirx, diry := float64(att.facing), 0.0
	// Aim slightly toward current movement intent if present.
	if att.in.Dx != 0 || att.in.Dy != 0 {
		if mag := math.Hypot(att.in.Dx, att.in.Dy); mag > 0 {
			dirx = att.in.Dx / mag
			diry = att.in.Dy / mag
		}
	}
	m.projectiles = append(m.projectiles, &projectile{
		x:     att.x + dirx*(playerRadius+8),
		y:     att.y + diry*(playerRadius+8),
		vx:    dirx * projSpeed,
		vy:    diry * projSpeed,
		life:  projLife,
		owner: att.id,
		kind:  "libre",
	})
}

// doVim resolves a vim command line into its special effect.
func (m *Match) doVim(pl *player, cmd string) {
	switch {
	case cmd == ":wq" || cmd == "wq" || cmd == ":x":
		// Blink in the facing direction.
		dx, dy := float64(pl.facing), 0.0
		if pl.in.Dx != 0 || pl.in.Dy != 0 {
			if mag := math.Hypot(pl.in.Dx, pl.in.Dy); mag > 0 {
				dx = pl.in.Dx / mag
				dy = pl.in.Dy / mag
			}
		}
		pl.x += dx * blinkDist
		pl.y += dy * blinkDist
		pl.invuln = math.Max(pl.invuln, 0.15)

	case cmd == "dd":
		// Destroy nearby projectiles + brief invulnerability.
		kept := m.projectiles[:0]
		for _, pr := range m.projectiles {
			if math.Hypot(pr.x-pl.x, pr.y-pl.y) <= ddPurgeRange {
				continue
			}
			kept = append(kept, pr)
		}
		m.projectiles = kept
		pl.invuln = math.Max(pl.invuln, ddInvuln)

	case cmd == "sudo" || cmd == ":sudo" || cmd == "sudo!!":
		// Radial AoE knockback, gated by the meter.
		if pl.meter >= sudoCost {
			pl.meter = 0
			for _, t := range m.players {
				if t == pl || !t.alive || t.invuln > 0 {
					continue
				}
				dx := t.x - pl.x
				dy := t.y - pl.y
				dist := math.Hypot(dx, dy)
				if dist > sudoRange || dist == 0 {
					continue
				}
				m.hit(pl, t, dx, dy, dist, sudoDmg, sudoKB, false)
			}
		}
	}
}

// hit applies damage + knockback from att to t. dirx/diry are the raw (t-att)
// vector components, dist their length. applyWindows controls whether a pending
// Windows debuff transfers (only the melee that "carries" the windows pickup).
func (m *Match) hit(att, t *player, dx, dy, dist, dmg, baseKB float64, applyWindows bool) {
	if dist == 0 {
		dist = 1
		dx = 1
	}
	nx := dx / dist
	ny := dy / dist

	// Knockback scaling. In smash it grows with the victim's damage percent.
	kb := baseKB
	if m.mode == ModeSmash {
		kb *= 1 + t.damage/40.0
	}

	t.vx += nx * kb
	t.vy += ny * kb
	t.invuln = math.Max(t.invuln, invulnAfterHit)

	if m.mode == ModeSmash {
		t.damage += dmg
	} else {
		t.hp -= dmg
	}

	// Windows debuff: a melee charged with the windows pickup tags the victim.
	if applyWindows && att.windows < 0 {
		// att.windows == -1 sentinel means "next melee applies windows".
		t.windows = time.Now().Add(windowsDebuffDur).UnixMilli()
		att.windows = 0
	}
}

// updateProjectiles moves projectiles, resolves hits, and expires them.
func (m *Match) updateProjectiles(dt float64) {
	kept := m.projectiles[:0]
	for _, pr := range m.projectiles {
		pr.x += pr.vx * dt
		pr.y += pr.vy * dt
		pr.life -= dt

		if pr.life <= 0 {
			continue
		}
		// Out of world bounds -> gone.
		if pr.x < 0 || pr.x > worldW || pr.y < 0 || pr.y > worldH {
			continue
		}

		hitSomething := false
		for _, t := range m.players {
			if !t.alive || t.id == pr.owner || t.invuln > 0 {
				continue
			}
			dx := t.x - pr.x
			dy := t.y - pr.y
			if math.Hypot(dx, dy) <= playerRadius+projRadius {
				if att, ok := m.byID[pr.owner]; ok {
					m.hit(att, t, dx, dy, math.Hypot(dx, dy), projDmg, projKB, false)
				} else {
					m.hit(t, t, dx, dy, math.Hypot(dx, dy), projDmg, projKB, false)
				}
				hitSomething = true
				break
			}
		}
		if hitSomething {
			continue
		}
		kept = append(kept, pr)
	}
	m.projectiles = kept
}

// updatePickups spawns pickups over time and resolves collection.
func (m *Match) updatePickups(dt float64) {
	m.pickupTimer -= dt
	if m.pickupTimer <= 0 && len(m.pickups) < maxPickups {
		m.pickupTimer = pickupInterval
		m.spawnPickup()
	}

	kept := m.pickups[:0]
	for _, pk := range m.pickups {
		collected := false
		for _, pl := range m.players {
			if !pl.alive {
				continue
			}
			if math.Hypot(pl.x-pk.x, pl.y-pk.y) <= playerRadius+16 {
				m.collect(pl, pk.kind)
				collected = true
				break
			}
		}
		if !collected {
			kept = append(kept, pk)
		}
	}
	m.pickups = kept
}

// spawnPickup drops a random pickup at a valid location for the current mode.
func (m *Match) spawnPickup() {
	kinds := []string{"fisherman", "fork", "libre", "windows"}
	kind := kinds[m.rng.Intn(len(kinds))]

	var x, y float64
	if m.mode == ModeSmash {
		x = platformLeft + 40 + m.rng.Float64()*(platformRight-platformLeft-80)
		y = platformTop + 40 + m.rng.Float64()*(platformBottom-platformTop-80)
	} else {
		// Spawn inside the current zone so it is reachable.
		ang := m.rng.Float64() * 2 * math.Pi
		rad := m.rng.Float64() * math.Max(40, m.zoneR*0.8)
		x = clamp(m.zoneCx+math.Cos(ang)*rad, arenaMargin+30, worldW-arenaMargin-30)
		y = clamp(m.zoneCy+math.Sin(ang)*rad, arenaMargin+30, worldH-arenaMargin-30)
	}
	m.pickups = append(m.pickups, &pickup{x: x, y: y, kind: kind})
}

// collect applies a pickup's effect to a player.
func (m *Match) collect(pl *player, kind string) {
	switch kind {
	case "fisherman":
		pl.boostT = float64(fishermanDur) / float64(time.Second)
	case "fork":
		m.spawnFork(pl)
	case "libre":
		pl.ammo += libreAmmo
	case "windows":
		// Arms the next melee to apply the Activate Windows debuff. Stored as a
		// sentinel (-1) so hit() can detect and transfer it.
		pl.windows = -1
	}
}

// spawnFork creates a short-lived friendly AI clone next to the player.
func (m *Match) spawnFork(owner *player) {
	// Respect mode caps so the roster never explodes.
	cap := 16
	if m.mode == ModeSmash {
		cap = 8
	}
	if len(m.players) >= cap {
		return
	}
	clone := &player{
		id:        owner.id + "#fork" + itoa(int(m.tick)),
		nickname:  owner.nickname + "*",
		character: owner.character,
		bot:       true,
		facing:    owner.facing,
		x:         owner.x + 36,
		y:         owner.y,
		hp:        royaleStartHP,
		lives:     1,
		alive:     true,
		ammo:      1,
		meter:     1,
		isFork:    true,
		forkT:     float64(forkLifetime) / float64(time.Second),
	}
	m.players = append(m.players, clone)
	m.byID[clone.id] = clone
}

// applyEnvironment applies mode-specific environmental rules: ring-out in smash,
// storm DPS in royale, and ground/respawn handling.
func (m *Match) applyEnvironment(dt float64) {
	now := time.Now().UnixMilli()
	for _, pl := range m.players {
		if !pl.alive {
			continue
		}
		// Expire windows debuff sentinel display value (negative sentinel never
		// shows on the wire; positive expiry naturally elapses on the client).
		if pl.windows > 0 && pl.windows < now {
			pl.windows = 0
		}

		if m.mode == ModeSmash {
			// Ring-out: off the platform = lose a life.
			if pl.x < platformLeft || pl.x > platformRight ||
				pl.y < platformTop || pl.y > platformBottom {
				m.killOrRespawn(pl)
			}
		} else {
			// BSOD storm: outside the zone drains HP.
			if math.Hypot(pl.x-m.zoneCx, pl.y-m.zoneCy) > m.zoneR {
				pl.hp -= royaleStormDPS * dt
			}
			if pl.hp <= 0 {
				pl.alive = false
			}
		}
	}
}

// killOrRespawn handles a smash ring-out: decrement lives and respawn, or
// eliminate when out of lives.
func (m *Match) killOrRespawn(pl *player) {
	if pl.isFork {
		pl.alive = false
		return
	}
	pl.lives--
	if pl.lives <= 0 {
		pl.alive = false
		return
	}
	// Respawn at center, reset velocity & damage.
	pl.x = (platformLeft + platformRight) / 2
	pl.y = (platformTop + platformBottom) / 2
	pl.vx, pl.vy = 0, 0
	pl.damage = 0
	pl.invuln = 1.2
}

// separatePlayers pushes overlapping live players apart a little each tick.
func (m *Match) separatePlayers() {
	for i := 0; i < len(m.players); i++ {
		a := m.players[i]
		if !a.alive {
			continue
		}
		for j := i + 1; j < len(m.players); j++ {
			b := m.players[j]
			if !b.alive {
				continue
			}
			dx := b.x - a.x
			dy := b.y - a.y
			dist := math.Hypot(dx, dy)
			minD := playerRadius * 1.6
			if dist > 0 && dist < minD {
				push := (minD - dist) / 2
				nx := dx / dist
				ny := dy / dist
				a.x -= nx * push
				a.y -= ny * push
				b.x += nx * push
				b.y += ny * push
			}
		}
	}
}

// updateBots drives CPU players: seek the nearest target, attack in range, and
// avoid the storm/edges.
func (m *Match) updateBots(dt float64) {
	for _, pl := range m.players {
		if !pl.bot || !pl.alive {
			continue
		}
		pl.aiTimer -= dt

		target := m.nearestEnemy(pl)
		in := protocol.InputMsg{}

		// Desired movement toward target.
		if target != nil {
			dx := target.x - pl.x
			dy := target.y - pl.y
			dist := math.Hypot(dx, dy)
			if dist > 0 {
				in.Dx = dx / dist
				in.Dy = dy / dist
			}
			// Attack when close.
			if dist < meleeRange+playerRadius && pl.meleeCD <= 0 {
				in.Attack = true
			} else if dist < 360 && pl.throwCD <= 0 && pl.ammo > 0 && m.rng.Float64() < 0.04 {
				in.Throw = true
			}
		} else {
			// Wander toward center.
			cx, cy := m.safeCenter()
			dx, dy := cx-pl.x, cy-pl.y
			if mag := math.Hypot(dx, dy); mag > 0 {
				in.Dx, in.Dy = dx/mag, dy/mag
			}
		}

		// Survival override: steer back toward safety.
		sx, sy, danger := m.dangerVector(pl)
		if danger {
			in.Dx, in.Dy = sx, sy
			in.Attack = false
		}

		// Occasional dash to feel less robotic.
		if pl.dashCD <= 0 && m.rng.Float64() < 0.01 {
			in.Dash = true
		}

		pl.in = in
	}
}

// nearestEnemy returns the closest living non-allied player.
func (m *Match) nearestEnemy(pl *player) *player {
	var best *player
	bestD := math.MaxFloat64
	ownerRoot := forkRoot(pl.id)
	for _, t := range m.players {
		if t == pl || !t.alive {
			continue
		}
		// Forks don't attack their owner (or owner's other forks).
		if forkRoot(t.id) == ownerRoot {
			continue
		}
		d := math.Hypot(t.x-pl.x, t.y-pl.y)
		if d < bestD {
			bestD = d
			best = t
		}
	}
	return best
}

// dangerVector returns a unit steering vector away from danger and whether the
// bot is currently endangered (near void edge in smash, or outside zone in
// royale).
func (m *Match) dangerVector(pl *player) (float64, float64, bool) {
	if m.mode == ModeSmash {
		margin := 70.0
		var sx, sy float64
		danger := false
		if pl.x < platformLeft+margin {
			sx += 1
			danger = true
		}
		if pl.x > platformRight-margin {
			sx -= 1
			danger = true
		}
		if pl.y < platformTop+margin {
			sy += 1
			danger = true
		}
		if pl.y > platformBottom-margin {
			sy -= 1
			danger = true
		}
		if danger {
			if mag := math.Hypot(sx, sy); mag > 0 {
				return sx / mag, sy / mag, true
			}
		}
		return 0, 0, false
	}

	// Royale: head back inside the zone if near/over the edge.
	dx := m.zoneCx - pl.x
	dy := m.zoneCy - pl.y
	dist := math.Hypot(dx, dy)
	if dist > m.zoneR-90 {
		if dist > 0 {
			return dx / dist, dy / dist, true
		}
	}
	return 0, 0, false
}

// safeCenter returns a point bots should gravitate toward when idle.
func (m *Match) safeCenter() (float64, float64) {
	if m.mode == ModeSmash {
		return (platformLeft + platformRight) / 2, (platformTop + platformBottom) / 2
	}
	return m.zoneCx, m.zoneCy
}

// checkWinner determines whether the match has resolved, ignoring fork clones.
func (m *Match) checkWinner() {
	var alive []*player
	for _, pl := range m.players {
		if pl.alive && !pl.isFork {
			alive = append(alive, pl)
		}
	}

	switch len(alive) {
	case 1:
		m.over = true
		m.winnerID = alive[0].id
		m.winnerNick = alive[0].nickname
	case 0:
		m.over = true
		m.winnerID = ""
		m.winnerNick = ""
	}
}

// aliveCount counts living real (non-fork) fighters.
func (m *Match) aliveCount() int {
	n := 0
	for _, pl := range m.players {
		if pl.alive && !pl.isFork {
			n++
		}
	}
	return n
}

// snapshot serializes the current world into the wire protocol form. Players are
// emitted in a stable order so client interpolation stays consistent.
func (m *Match) snapshot() protocol.Snapshot {
	ps := make([]protocol.SnapshotPlayer, 0, len(m.players))
	for _, pl := range m.players {
		// Only positive expiry timestamps are meaningful to the client; the
		// negative sentinel (armed-but-untriggered) is hidden.
		win := pl.windows
		if win < 0 {
			win = 0
		}
		ps = append(ps, protocol.SnapshotPlayer{
			ID:           pl.id,
			Nickname:     pl.nickname,
			Character:    pl.character,
			X:            round1(pl.x),
			Y:            round1(pl.y),
			Hp:           round1(pl.hp),
			Damage:       round1(pl.damage),
			Facing:       pl.facing,
			Alive:        pl.alive,
			Boost:        pl.boostT > 0,
			WindowsUntil: win,
		})
	}
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].ID < ps[j].ID })

	projs := make([]protocol.ProjectileS, 0, len(m.projectiles))
	for _, pr := range m.projectiles {
		projs = append(projs, protocol.ProjectileS{X: round1(pr.x), Y: round1(pr.y), Kind: pr.kind})
	}

	picks := make([]protocol.PickupS, 0, len(m.pickups))
	for _, pk := range m.pickups {
		picks = append(picks, protocol.PickupS{X: round1(pk.x), Y: round1(pk.y), Kind: pk.kind})
	}

	zone := protocol.ZoneS{}
	if m.mode == ModeRoyale {
		zone = protocol.ZoneS{Cx: round1(m.zoneCx), Cy: round1(m.zoneCy), R: round1(m.zoneR)}
	}

	return protocol.Snapshot{
		T:           m.tick,
		Mode:        string(m.mode),
		Players:     ps,
		Projectiles: projs,
		Pickups:     picks,
		Zone:        zone,
		Alive:       m.aliveCount(),
		Winner:      m.winnerID,
	}
}

// ---- small helpers ----

func decay(v, dt float64) float64 {
	v -= dt
	if v < 0 {
		return 0
	}
	return v
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

// forkRoot returns the owning player id of a fork clone (or the id itself).
func forkRoot(id string) string {
	if i := strings.Index(id, "#fork"); i >= 0 {
		return id[:i]
	}
	return id
}

// itoa is a tiny non-allocating-ish integer formatter (avoids strconv import
// churn and keeps ids stable).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// randomBotCharacter builds a varied character for filler bots.
func randomBotCharacter(rng *rand.Rand) protocol.Character {
	bodyType := "tux"
	if rng.Intn(2) == 0 {
		bodyType = "humanoid"
	}
	return protocol.Character{
		Name:      "",
		BodyType:  bodyType,
		Body:      rng.Intn(6),
		Belly:     rng.Intn(6),
		Feet:      rng.Intn(6),
		Hat:       rng.Intn(4),
		Eyes:      rng.Intn(3),
		Accessory: rng.Intn(3),
		Cape:      rng.Intn(3),
	}
}
