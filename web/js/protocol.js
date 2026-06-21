// protocol.js — wire-protocol message-type constants. Single global: Protocol.
//
// These string constants MUST be byte-for-byte identical to the Go server's
// `package protocol` consts (clobi/internal/protocol). Both ends agree on a
// JSON Envelope of the form {"type": <string>, "payload": <object>}; the values
// below are the legal `type` strings.
//
// No frameworks, no ES modules — this file assigns exactly one global.

var Protocol = {
  // ---- Client -> Server ----
  HELLO: 'HELLO',
  LIST_ROOMS: 'LIST_ROOMS',
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  LEAVE_ROOM: 'LEAVE_ROOM',
  READY: 'READY',
  START_GAME: 'START_GAME',
  INPUT: 'INPUT',

  // ---- Server -> Client ----
  HELLO_OK: 'HELLO_OK',
  ROOM_LIST: 'ROOM_LIST',
  ROOM_JOINED: 'ROOM_JOINED',
  ROOM_UPDATE: 'ROOM_UPDATE',
  JOIN_DENIED: 'JOIN_DENIED',
  GAME_START: 'GAME_START',
  SNAPSHOT: 'SNAPSHOT',
  GAME_OVER: 'GAME_OVER',
  ERRORMSG: 'ERRORMSG'
};

window.Protocol = Protocol;
