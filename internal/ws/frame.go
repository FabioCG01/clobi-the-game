package ws

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Opcodes as defined by RFC 6455 §5.2.
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// Close codes we actually use (RFC 6455 §7.4.1).
const (
	CloseNormal          uint16 = 1000
	CloseGoingAway       uint16 = 1001
	CloseProtocolError   uint16 = 1002
	CloseUnsupportedData uint16 = 1003
	CloseInvalidPayload  uint16 = 1007
	ClosePolicyViolation uint16 = 1008
	CloseMessageTooBig   uint16 = 1009
	CloseInternalError   uint16 = 1011
)

// MaxFramePayload is the hard cap on a single frame's payload length,
// enforced on every frame this package reads regardless of direction. Frames
// larger than this are rejected (declared length alone is enough to reject —
// we never buffer up to it first) so a hostile or buggy peer cannot OOM the
// server by claiming a huge length.
const MaxFramePayload = 256 * 1024 // 256 KiB

// MaxMessageSize is the hard cap on a reassembled (possibly fragmented)
// INCOMING text message, i.e. what ReadMessage will accept from a peer. Kept
// equal to MaxFramePayload: nothing a client legitimately sends this server
// needs to be bigger than one frame's worth, so capping the reassembled total
// at the same limit closes off "OOM via many small continuation frames"
// alongside the single-frame check.
const MaxMessageSize = MaxFramePayload

// MaxOutgoingMessage is the hard cap on a message passed to WriteMessage.
// It is deliberately more generous than MaxMessageSize/MaxFramePayload:
// outgoing data is server-authored (never attacker-controlled), so the
// OOM concern that motivates the tight incoming caps does not apply, and
// WriteMessage transparently fragments anything over MaxFramePayload into
// multiple frames per RFC 6455 §5.4.
const MaxOutgoingMessage = 1024 * 1024 // 1 MiB

// frameHeader is a fully parsed frame header (everything except the payload
// bytes themselves, which the caller streams/copies separately).
type frameHeader struct {
	fin     bool
	opcode  byte
	masked  bool
	maskKey [4]byte
	length  uint64
}

// readFrameHeader parses one frame header from r per RFC 6455 §5.2.
func readFrameHeader(r io.Reader) (frameHeader, error) {
	var h frameHeader
	var b [2]byte
	if _, err := io.ReadFull(r, b[:]); err != nil {
		return h, err
	}
	h.fin = b[0]&0x80 != 0
	rsv := b[0] & 0x70
	h.opcode = b[0] & 0x0F
	if rsv != 0 {
		// No extensions (permessage-deflate etc.) are negotiated, so any RSV
		// bit set is a protocol violation.
		return h, fmt.Errorf("%w: reserved bits set", ErrProtocol)
	}
	h.masked = b[1]&0x80 != 0
	length := uint64(b[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return h, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return h, err
		}
		length = binary.BigEndian.Uint64(ext[:])
		if length&(1<<63) != 0 {
			// The top bit MUST be 0 per spec; also guards against the int64
			// conversions below going negative.
			return h, fmt.Errorf("%w: invalid extended length", ErrProtocol)
		}
	}
	if length > MaxFramePayload {
		return h, ErrMessageTooBig
	}
	h.length = length
	if h.masked {
		if _, err := io.ReadFull(r, h.maskKey[:]); err != nil {
			return h, err
		}
	}
	if isControlOpcode(h.opcode) {
		if !h.fin {
			return h, fmt.Errorf("%w: fragmented control frame", ErrProtocol)
		}
		if h.length > 125 {
			return h, fmt.Errorf("%w: control frame payload too large", ErrProtocol)
		}
	}
	return h, nil
}

// readFramePayload reads exactly h.length bytes and unmasks them in place if
// the frame was masked.
func readFramePayload(r io.Reader, h frameHeader) ([]byte, error) {
	if h.length == 0 {
		return nil, nil
	}
	buf := make([]byte, h.length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	if h.masked {
		unmask(buf, h.maskKey)
	}
	return buf, nil
}

// unmask XORs data in place with the 4-byte mask key, cycling per RFC 6455
// §5.3 (octet i of the payload is XORed with octet i mod 4 of the mask key).
func unmask(data []byte, key [4]byte) {
	for i := range data {
		data[i] ^= key[i%4]
	}
}

func isControlOpcode(op byte) bool {
	return op == opClose || op == opPing || op == opPong
}

// writeFrame writes a single, complete, unmasked frame (servers never mask
// outgoing frames per RFC 6455 §5.1). Caller already holds any needed lock.
func writeFrame(w io.Writer, fin bool, opcode byte, payload []byte) error {
	if len(payload) > MaxFramePayload {
		return ErrMessageTooBig
	}
	var head [10]byte
	n := 1
	head[0] = opcode & 0x0F
	if fin {
		head[0] |= 0x80
	}
	l := len(payload)
	switch {
	case l < 126:
		head[1] = byte(l)
		n = 2
	case l <= 0xFFFF:
		head[1] = 126
		binary.BigEndian.PutUint16(head[2:4], uint16(l))
		n = 4
	default:
		head[1] = 127
		binary.BigEndian.PutUint64(head[2:10], uint64(l))
		n = 10
	}
	// Mask bit (0x80 on byte 1) is left clear: server->client frames are
	// never masked.
	if _, err := w.Write(head[:n]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

// writeControlFrame writes a small (<=125 byte payload), always-FIN control
// frame (close/ping/pong).
func writeControlFrame(w io.Writer, opcode byte, payload []byte) error {
	if len(payload) > 125 {
		return errors.New("ws: control frame payload exceeds 125 bytes")
	}
	return writeFrame(w, true, opcode, payload)
}

// encodeCloseBody builds a close-frame payload: 2-byte big-endian code
// followed by a UTF-8 reason, clipped so the whole body stays <=125 bytes.
func encodeCloseBody(code uint16, reason string) []byte {
	const maxReason = 123 // 125 - 2 code bytes
	if len(reason) > maxReason {
		reason = reason[:maxReason]
	}
	body := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(body[:2], code)
	copy(body[2:], reason)
	return body
}

// decodeCloseBody parses a close-frame payload into (code, reason). Absent or
// malformed bodies fall back to CloseNormal / empty reason, mirroring common
// browser behavior for terse close frames.
func decodeCloseBody(body []byte) (uint16, string) {
	if len(body) < 2 {
		return CloseNormal, ""
	}
	code := binary.BigEndian.Uint16(body[:2])
	return code, string(body[2:])
}
