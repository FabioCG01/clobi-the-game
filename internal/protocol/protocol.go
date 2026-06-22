// Package protocol defines the wire contract between the Go server and the
// vanilla-JS browser client of TUX SMASH ROYALE.
//
// Every message on the WebSocket is a JSON Envelope of the form
// {"type": <string>, "payload": <object>}. The message-type string constants
// below MUST be byte-for-byte identical to those in web/js/protocol.js so both
// ends agree. All payload structs use lowercase json tag names; the JS client
// reads/writes exactly these field names.
package protocol

import "encoding/json"

// ---- Message types: Client -> Server ----
const (
	HELLO       = "HELLO"
	LIST_ROOMS  = "LIST_ROOMS"
	CREATE_ROOM = "CREATE_ROOM"
	JOIN_ROOM   = "JOIN_ROOM"
	LEAVE_ROOM  = "LEAVE_ROOM"
	READY       = "READY"
	START_GAME  = "START_GAME"
	INPUT       = "INPUT"
)

// ---- Message types: Server -> Client ----
const (
	HELLO_OK    = "HELLO_OK"
	ROOM_LIST   = "ROOM_LIST"
	ROOM_JOINED = "ROOM_JOINED"
	ROOM_UPDATE = "ROOM_UPDATE"
	JOIN_DENIED = "JOIN_DENIED"
	GAME_START  = "GAME_START"
	SNAPSHOT    = "SNAPSHOT"
	GAME_OVER   = "GAME_OVER"
	ERRORMSG    = "ERRORMSG"
)

// Envelope is the outer frame for every message on the wire.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Character is the universal, cross-mode avatar definition. BodyType selects the
// 8-bit renderer ("tux" penguin or "humanoid" person); the remaining indices
// reference entries in the client's Sprites.PARTS tables.
type Character struct {
	Name       string `json:"name"`
	BodyType   string `json:"bodyType"` // "tux" or "humanoid"
	Gender     string `json:"gender"`   // "male" or "female" (humanoid)
	Body       string `json:"body"`     // hex — tux body color
	Belly      string `json:"belly"`    // hex — tux belly / humanoid shirt
	Feet       string `json:"feet"`     // hex — feet / shoes color
	Skin       string `json:"skin"`     // hex — humanoid skin
	HairColor  string `json:"hairColor"`  // hex — humanoid hair
	BeardColor string `json:"beardColor"` // hex — humanoid beard
	Hair       int    `json:"hair"`     // hairstyle index (humanoid)
	Beard      int    `json:"beard"`    // beard index (0 = none)
	Hat        int    `json:"hat"`
	Eyes       int    `json:"eyes"`
	Accessory  int    `json:"accessory"`
	Cape       int    `json:"cape"`
}

// ---- Client -> Server payloads ----

// HelloMsg is sent right after the socket opens to announce identity.
type HelloMsg struct {
	Nickname  string    `json:"nickname"`
	Character Character `json:"character"`
}

// CreateRoomMsg requests a new room. Mode is "smash" or "royale".
type CreateRoomMsg struct {
	Name       string `json:"name"`
	Password   string `json:"password"`
	MaxPlayers int    `json:"maxPlayers"`
	Mode       string `json:"mode"`
}

// JoinRoomMsg requests to join an existing room.
type JoinRoomMsg struct {
	RoomID   string `json:"roomId"`
	Password string `json:"password"`
}

// ReadyMsg toggles the sender's ready state in the lobby.
type ReadyMsg struct {
	Ready bool `json:"ready"`
}

// InputMsg is a per-tick input frame from a client. Seq is a monotonically
// increasing client sequence number. Vim carries an optional vim command line
// (":wq", "dd", "sudo") to trigger a special this tick.
type InputMsg struct {
	Seq    int     `json:"seq"`
	Dx     float64 `json:"dx"`
	Dy     float64 `json:"dy"`
	Attack bool    `json:"attack"`
	Throw  bool    `json:"throw"`
	Dash   bool    `json:"dash"`
	Jump   bool    `json:"jump"` // side-view Smash: rising-edge jump request
	Vim    string  `json:"vim"`
}

// ---- Server -> Client payloads ----

// RoomSummary is one row in the public room list.
type RoomSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	HasPassword bool   `json:"hasPassword"`
	Players     int    `json:"players"`
	MaxPlayers  int    `json:"maxPlayers"`
	Mode        string `json:"mode"`
	State       string `json:"state"`
}

// PlayerLobby describes a player inside a room lobby.
type PlayerLobby struct {
	ID        string    `json:"id"`
	Nickname  string    `json:"nickname"`
	Character Character `json:"character"`
	Ready     bool      `json:"ready"`
}

// RoomInfo is the full description of a single room sent on join/update.
type RoomInfo struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Host       string        `json:"host"`
	Mode       string        `json:"mode"`
	MaxPlayers int           `json:"maxPlayers"`
	State      string        `json:"state"`
	Players    []PlayerLobby `json:"players"`
}

// RoomListMsg wraps the public room list.
type RoomListMsg struct {
	Rooms []RoomSummary `json:"rooms"`
}

// SnapshotPlayer is one player's state in a snapshot. Damage is the smash-style
// accumulated damage percent; Boost flags an active Fisherman's buff;
// WindowsUntil is a unix-millis timestamp until which the Activate Windows gag
// should show on that player's client (0 means inactive).
type SnapshotPlayer struct {
	ID           string    `json:"id"`
	Nickname     string    `json:"nickname"`
	Character    Character `json:"character"`
	X            float64   `json:"x"`
	Y            float64   `json:"y"`
	Hp           float64   `json:"hp"`
	Damage       float64   `json:"damage"`
	Facing       int       `json:"facing"`
	Alive        bool      `json:"alive"`
	Boost        bool      `json:"boost"`
	Stocks       int       `json:"stocks"` // smash lives remaining
	WindowsUntil int64     `json:"windowsUntil"`
}

// ProjectileS is a flying entity (LibreOffice frisbee, etc.). Kind names the art.
type ProjectileS struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Kind string  `json:"kind"`
}

// PickupS is a collectible on the ground. Kind is one of
// "fisherman","fork","libre","windows".
type PickupS struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Kind string  `json:"kind"`
}

// ZoneS is the royale Menthol Zone circle (center + radius). Unused in smash.
type ZoneS struct {
	Cx float64 `json:"cx"`
	Cy float64 `json:"cy"`
	R  float64 `json:"r"`
}

// ObstacleS is a static royale-town feature (building/lake/construction) with
// AABB collision used for cover. Sent on the first snapshots + periodically; the
// client caches it (it never changes during a match).
type ObstacleS struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	W    float64 `json:"w"`
	H    float64 `json:"h"`
	Kind string  `json:"kind"`
}

// Snapshot is the authoritative world state broadcast each tick. T is the tick
// number, Mode is "smash" or "royale", Winner is "" until the match ends.
type Snapshot struct {
	Players     []SnapshotPlayer `json:"players"`
	Projectiles []ProjectileS    `json:"projectiles"`
	Pickups     []PickupS        `json:"pickups"`
	Obstacles   []ObstacleS      `json:"obstacles"` // royale town (cached client-side)
	Zone        ZoneS            `json:"zone"`
	W           float64          `json:"w"` // royale world width (scales with players)
	H           float64          `json:"h"`
	T           int64            `json:"t"`
	Mode        string           `json:"mode"`
	Alive       int              `json:"alive"`
	Winner      string           `json:"winner"`
}

// GameOverMsg announces the match winner.
type GameOverMsg struct {
	WinnerID       string `json:"winnerId"`
	WinnerNickname string `json:"winnerNickname"`
}
