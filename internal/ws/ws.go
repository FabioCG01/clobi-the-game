// Package ws is a minimal, dependency-free RFC 6455 WebSocket server
// implementation (stdlib only: net/http for the handshake hijack, crypto/sha1
// + encoding/base64 for Sec-WebSocket-Accept, encoding/binary for frame
// headers).
//
// Scope is deliberately narrow: text messages (with full fragmentation
// support on both read and write), close/ping/pong control frames, and
// mandatory client-to-server masking enforcement. No permessage-deflate or
// any other extension is negotiated — the Sec-WebSocket-Extensions header is
// simply ignored, so peers that offer it fall back to no compression, which
// is what we want (payloads here are small JSON messages; the CPU/complexity
// cost of compression is not worth it).
//
// Typical use:
//
//	conn, err := ws.Accept(w, r)
//	if err != nil { return }
//	defer conn.Close()
//	for {
//	    msg, err := conn.ReadMessage()
//	    if err != nil { break }
//	    _ = conn.WriteMessage(msg) // echo
//	}
package ws

import (
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// websocketGUID is the magic constant from RFC 6455 §1.3 used to compute
// Sec-WebSocket-Accept from the client's Sec-WebSocket-Key.
const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Errors returned by this package. Use errors.Is to test for them; ReadMessage
// / WriteMessage / Accept may also return wrapped net.Error / io.EOF-family
// errors from the underlying connection.
var (
	// ErrHandshake means the incoming request was not a valid WebSocket
	// upgrade request (bad/missing headers). Accept has already written an
	// HTTP error response in this case; the caller should not write again.
	ErrHandshake = errors.New("ws: invalid handshake")
	// ErrProtocol means the peer violated the framing protocol (bad opcode
	// sequence, reserved bits set, invalid continuation, etc).
	ErrProtocol = errors.New("ws: protocol violation")
	// ErrMessageTooBig means a frame or reassembled message exceeded
	// MaxFramePayload / MaxMessageSize.
	ErrMessageTooBig = errors.New("ws: message too big")
	// ErrNotMasked means a client sent an unmasked frame. RFC 6455 §5.1
	// requires servers to close the connection upon receiving one.
	ErrNotMasked = errors.New("ws: client frame not masked")
	// ErrClosed means the connection was closed (locally or by the peer,
	// cleanly or not). Equivalent in spirit to io.EOF for this package's
	// ReadMessage/WriteMessage.
	ErrClosed = errors.New("ws: connection closed")
)

// Accept validates a WebSocket upgrade request, performs the RFC 6455
// handshake, hijacks the underlying TCP connection, and returns a ready-to-use
// *Conn. On any handshake failure it writes an appropriate HTTP error response
// on w (as far as still possible) and returns a non-nil error; the caller must
// not write to w or hijack it themselves in that case.
func Accept(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if err := validateUpgradeRequest(r); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return nil, fmt.Errorf("%w: %v", ErrHandshake, err)
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	accept := computeAccept(key)

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "websocket: server does not support hijacking", http.StatusInternalServerError)
		return nil, fmt.Errorf("%w: ResponseWriter does not support Hijack", ErrHandshake)
	}
	netConn, buf, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("%w: hijack failed: %v", ErrHandshake, err)
	}

	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := netConn.Write([]byte(resp)); err != nil {
		netConn.Close()
		return nil, fmt.Errorf("%w: writing handshake response: %v", ErrHandshake, err)
	}

	return newConn(netConn, buf), nil
}

// validateUpgradeRequest checks the headers RFC 6455 §4.2.1 requires of a
// valid client opening handshake. It intentionally does not check Host or
// Origin — callers that care about same-origin enforcement (this project
// does, per the multiplayer contract) should check r.Header.Get("Origin")
// themselves before calling Accept, since the right policy is
// application-specific.
func validateUpgradeRequest(r *http.Request) error {
	if r.Method != http.MethodGet {
		return errors.New("websocket: method must be GET")
	}
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") {
		return errors.New("websocket: missing Connection: Upgrade")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return errors.New("websocket: missing Upgrade: websocket")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return errors.New("websocket: unsupported Sec-WebSocket-Version (need 13)")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	raw, err := base64.StdEncoding.DecodeString(key)
	if key == "" || err != nil || len(raw) != 16 {
		return errors.New("websocket: invalid Sec-WebSocket-Key")
	}
	return nil
}

// headerContainsToken reports whether comma-separated header value v contains
// token, case-insensitively (RFC 7230 list syntax — used for the Connection
// header, which in practice is often "Upgrade" but may be "keep-alive, Upgrade").
func headerContainsToken(v, token string) bool {
	for _, part := range strings.Split(v, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

// computeAccept derives Sec-WebSocket-Accept from a client's
// Sec-WebSocket-Key per RFC 6455 §1.3: base64(SHA1(key + magic GUID)).
func computeAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key))
	h.Write([]byte(websocketGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
