package rooms

import "encoding/json"

// This file implements the server-touching half of contract §6's new
// commands (`/difficulty`, `/gamerule keepInventory`): a host-only WS
// message per command, mirroring the EXACT host-gating pattern the existing
// 'time' message already uses (handleTime in ws.go), plus the settings
// persistence (via the SAME worlds.settings jsonb object, see instance.go's
// worldSettings/flushSettings) and a broadcast so every connected client
// updates. The client-side `/difficulty`/`/gamerule` command parsing itself
// lives in commands.js (not this package) — this file only handles the
// resulting WS round-trip when hosted.

// ---- difficulty (host only) ----------------------------------------------

type difficultyMsg struct {
	Value string `json:"value"`
}

// handleDifficulty implements `{t:'difficulty',value:'hard'}` (contract §6):
// host/owner-only when hosted, mirroring handleTime's IsHost gate exactly.
// On success: updates the instance's difficulty, broadcasts a dedicated
// 'difficulty' frame (so clients can programmatically react, e.g. updating
// a HUD indicator) plus a human-readable 'sys' chat line, and despawns
// hostiles immediately if the new value is "peaceful" (contract §6/§7).
func handleDifficulty(inst *Instance, p *Player, raw []byte) {
	if !inst.IsHost(hostCheckName(p)) {
		writeErrorTo(p, "only the host can set difficulty")
		return
	}
	var dm difficultyMsg
	if json.Unmarshal(raw, &dm) != nil {
		return
	}
	if !validDifficulty(dm.Value) {
		writeErrorTo(p, "unknown difficulty")
		return
	}

	inst.mu.Lock()
	inst.difficulty = dm.Value
	recipients := inst.connSlice()
	inst.mu.Unlock()

	broadcastRaw(recipients, mustMarshal(wsFrame{"t": "difficulty", "value": dm.Value}))
	broadcastRaw(recipients, mustMarshal(wsFrame{"t": "sys", "text": "Difficulty set to " + dm.Value + " by " + p.Name, "cls": "info"}))

	if dm.Value == "peaceful" {
		inst.despawnAllHostiles()
	}
}

// ---- gamerule keepInventory (host only) ----------------------------------

type gameruleMsg struct {
	Rule  string `json:"rule"`
	Value bool   `json:"value"`
}

// handleGamerule implements `{t:'gamerule',rule:'keepInventory',value:true}`
// (contract §6), the same host-only gate as handleDifficulty/handleTime.
// Only the "keepInventory" rule exists in v1 (per §6's exact command list);
// an unrecognized rule name is rejected the same way an unrecognized
// difficulty value is.
func handleGamerule(inst *Instance, p *Player, raw []byte) {
	if !inst.IsHost(hostCheckName(p)) {
		writeErrorTo(p, "only the host can set gamerules")
		return
	}
	var gm gameruleMsg
	if json.Unmarshal(raw, &gm) != nil {
		return
	}
	if gm.Rule != "keepInventory" {
		writeErrorTo(p, "unknown gamerule")
		return
	}

	inst.mu.Lock()
	inst.keepInventory = gm.Value
	recipients := inst.connSlice()
	inst.mu.Unlock()

	broadcastRaw(recipients, mustMarshal(wsFrame{"t": "gamerule", "rule": gm.Rule, "value": gm.Value}))
	broadcastRaw(recipients, mustMarshal(wsFrame{"t": "sys", "text": "keepInventory set to " + boolWord(gm.Value) + " by " + p.Name, "cls": "info"}))
}

func boolWord(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
